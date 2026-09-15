/* ui.js — tiny DOM + formatting helpers. No framework; the app is small enough
   that a render-the-whole-view-on-change loop is simpler and fast enough. */

const UI = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const num = (v, dp = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : (Math.round(v * 10 ** dp) / 10 ** dp).toLocaleString());
  const pct = (v) => (v === null || v === undefined ? '—' : `${num(v, 1)}%`);
  const int = (v) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString());

  const date = (iso) => {
    if (!iso) return '—';
    const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  };
  const dateTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const ago = (iso) => {
    if (!iso) return 'never';
    const mins = Math.round((Date.now() - new Date(iso)) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
    return `${Math.round(mins / 1440)}d ago`;
  };

  const initials = (name) => String(name || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

  /* Stable per-person colour, taken only from brand hues so the palette never drifts. */
  const PERSON_HUES = ['var(--brand-blue)', 'var(--brand-pink)', 'var(--brand-teal)', 'var(--brand-purple)', 'var(--color-blue-700, #0047B3)'];
  const personColor = (name) => {
    let h = 0; for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return PERSON_HUES[h % PERSON_HUES.length];
  };

  const avatar = (name) => `<span class="avatar" style="background:${personColor(name)}">${esc(initials(name))}</span>`;

  const workloadClass = (v, over = 110, under = 85) => (v == null ? '' : v > over ? 'over' : v < under ? 'under' : 'good');

  const toast = (msg, isError = false) => {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast${isError ? ' err' : ''}`;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, isError ? 7000 : 3000);
  };

  const drawer = (html) => {
    $('#drawerBody').innerHTML = html;
    $('#drawer').hidden = false;
  };
  const closeDrawer = () => { $('#drawer').hidden = true; };

  /* fetch wrapper that surfaces server errors as readable toasts */
  const api = async (path, options = {}) => {
    const res = await fetch(path, {
      ...options,
      headers: options.body && typeof options.body === 'string' && options.raw
        ? { 'Content-Type': 'text/plain' }
        : options.body ? { 'Content-Type': 'application/json' } : {},
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  };

  const jsonPut = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body) });
  const jsonPost = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
  const jsonDelete = (path, body) => api(path, { method: 'DELETE', body: JSON.stringify(body) });

  // variant 'text' is for names and labels: the 800-weight stat style is reserved
  // for figures, per the KMS house rules.
  const kpi = ({ label, value, unit, foot, tone = '', featured = false, variant = '' }) => `
    <div class="kpi ${tone ? `t-${tone}` : ''}${featured ? ' featured card' : ''}">
      <div class="label">${esc(label)}</div>
      <div class="value${variant === 'text' ? ' text' : ''}">${value}${unit ? `<small>${esc(unit)}</small>` : ''}</div>
      ${foot ? `<div class="foot">${foot}</div>` : ''}
    </div>`;

  const bar = (value, max, cls = '') => {
    const w = max ? Math.max(0, Math.min(100, value / max * 100)) : 0;
    return `<div class="bar ${cls}"><i style="width:${w}%"></i></div>`;
  };

  const CATEGORY_COLORS = { new: 'var(--cat-new)', maintenance: 'var(--cat-maint)', technical: 'var(--cat-tech)', support: 'var(--cat-supp)', other: 'var(--cat-other)' };

  const mixBar = (mix, categories) => {
    const cats = Object.keys(CATEGORY_COLORS).filter(c => mix.byCategory[c] && mix.byCategory[c].points > 0);
    if (!cats.length) return '<div class="muted" style="font-size:12px">No estimated work yet</div>';
    return `
      <div class="mixbar">${cats.map(c => `<i style="width:${mix.byCategory[c].share}%;background:${CATEGORY_COLORS[c]}" title="${esc((categories[c] || {}).label || c)}: ${mix.byCategory[c].points} pts"></i>`).join('')}</div>
      <div class="mixkey">${cats.map(c => `<span><i style="background:${CATEGORY_COLORS[c]}"></i>${esc((categories[c] || {}).label || c)} <strong>${mix.byCategory[c].share}%</strong> <span class="muted">${mix.byCategory[c].points} pts</span></span>`).join('')}</div>`;
  };

  /**
   * The one explanation every points-driven screen owes the reader when the
   * story-points field is not landing.
   *
   * An empty velocity chart telling you to "run a Jira sync" is worse than
   * useless here: the sync ran, it worked, and running it again produces the
   * same nothing. The real cause is that every issue came back at zero points,
   * so say it where the missing numbers are, not only in Settings.
   */
  const pointsFieldNote = (state) => {
    const e = state && state.estimation;
    if (!e || !e.fieldLooksWrong) return '';
    return `<div style="margin-top:14px;padding:11px 13px;border-radius:var(--radius-sm);background:var(--app-subtle);border-left:3px solid var(--risk);text-align:left">
      <strong style="font-size:13px">Story points are not arriving from Jira.</strong>
      <p class="muted" style="font-size:12px;margin:6px 0 0">
        All ${int(e.total)} issues came back with no estimate, so anything measured in points reads as empty —
        not because the team delivered nothing, but because <code>${esc(e.field || 'the configured field')}</code>
        is almost certainly the wrong custom field. Fix it under <strong>Integrations &amp; setup</strong> and re-sync.
      </p>
    </div>`;
  };

  /* ── linking an issue key back to Jira ──────────────────────────────────
     Every screen shows issue keys, and a key you cannot click is a key you
     retype into a Jira search. The base URL is configured in exactly one
     place, so it is set ONCE here at boot rather than threaded through every
     endpoint's payload — `/api/search` did it per-response, which is why the
     Search page was the only screen where keys were clickable.

     `issueKey()` is a total function: with no base configured it returns the
     same plain text as before, so a tool set up without a Jira URL keeps
     working and simply has no links. */
  let jiraBase = '';
  const setJiraBase = (url) => { jiraBase = String(url || '').replace(/\/+$/, ''); };
  const issueUrl = (key) => (jiraBase && key ? `${jiraBase}/browse/${encodeURIComponent(key)}` : null);

  /**
   * An issue key as it should appear anywhere in the app.
   * @param {string} key
   * @param {{cls?: string, title?: string}} opts extra classes / hover text
   */
  const issueKey = (key, opts = {}) => {
    if (!key) return '<span class="muted">—</span>';
    const cls = `mono issue-key${opts.cls ? ` ${opts.cls}` : ''}`;
    const title = opts.title ? ` title="${esc(opts.title)}"` : '';
    const href = issueUrl(key);
    // rel="noopener" is not optional: target="_blank" hands the opened page a
    // live `window.opener` reference back to this one without it.
    return href
      ? `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener"${title}>${esc(key)}</a>`
      : `<span class="${cls}"${title}>${esc(key)}</span>`;
  };

  /** A comma-separated run of keys — blocked-by lists, related issues. */
  const issueKeys = (keys, opts = {}) =>
    (keys || []).filter(Boolean).map(k => issueKey(k, opts)).join(', ');

  /**
   * A Jira issue-navigator search for a JQL string.
   *
   * One builder, so the app cannot end up with two spellings of the same URL —
   * the Search page had its own, which is exactly how the base URL came to be
   * handled in two places and the keys stayed dead everywhere else.
   */
  const jiraSearch = (jql) => (jiraBase && jql ? `${jiraBase}/issues/?jql=${encodeURIComponent(jql)}` : null);

  /** A JQL value: quoted, with quotes and backslashes escaped. */
  const jql = (v) => `"${String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  /**
   * The Jira search behind a component on a coverage screen.
   *
   * It reproduces the SCOPE of the number it sits next to — same project, same
   * issue type. A link that opens a different set from the count beside it is
   * worse than no link: you cannot tell which of the two is wrong.
   *
   * `component` may be null, meaning the "no component" bucket, which in JQL is
   * `component IS EMPTY` rather than a name.
   */
  function componentSearchUrl({ component, project, scope }) {
    const parts = [];
    if (project) parts.push(`project = ${jql(project)}`);
    if (scope) parts.push(`issuetype = ${jql(scope)}`);
    parts.push(component ? `component = ${jql(component)}` : 'component IS EMPTY');
    return jiraSearch(`${parts.join(' AND ')} ORDER BY created DESC`);
  }

  return { esc, el, $, $$, num, pct, int, date, dateTime, ago, initials, avatar, personColor, workloadClass, toast, drawer, closeDrawer, api, jsonPut, jsonPost, jsonDelete, kpi, bar, mixBar, pointsFieldNote, CATEGORY_COLORS, setJiraBase, issueUrl, issueKey, issueKeys, jiraSearch, componentSearchUrl };
})();
