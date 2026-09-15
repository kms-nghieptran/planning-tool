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

  /* ── a type-to-search picker ───────────────────────────────────────────
     Built for the Coverage screen's 125 components and then wanted by the team
     and sprint pickers too, so it lives here rather than in one view. A native
     <select> cannot be searched by anything but the FIRST characters of an
     option, which is useless when every component starts "PS_" or every sprint
     starts "Katalon ".

     Two halves: `combo()` renders the markup, `wireCombo()` gives it behaviour.
     They are separate because views build their HTML as one string and attach
     listeners afterwards, which is also what makes the fresh-container render
     loop safe. */

  /**
   * Does this text match what was typed?
   *
   * Tokenised and order-free: "nlg igo" finds PS_iGO_NLG, "44 ruby" finds
   * "Katalon Ruby Sprint 44". Separators in the query count as spaces, so
   * "ps_igo" and "ps igo" behave the same. A plain substring test finds
   * neither, and that is the whole reason the native control was replaced.
   */
  const matchText = (hay, query) => {
    const h = String(hay == null ? '' : hay).toLowerCase();
    return String(query || '').toLowerCase().split(/[\s_\-/]+/).filter(Boolean).every(t => h.includes(t));
  };

  /**
   * @param {object} o
   * @param {string} o.id        input id; the list becomes `${id}List`
   * @param {string} o.label     field label above the box
   * @param {string} o.value     the current selection's display text
   * @param {string} o.placeholder
   * @param {Array}  o.options   {value, label, meta, tag, hidden, active}
   *                             `hidden` keeps an option OUT of the resting
   *                             list but still findable by typing.
   * @param {string} o.note      one line under the list, e.g. what is hidden
   * @param {string} o.cls       extra classes on the wrapping label
   */
  function combo(o) {
    const opt = (c) => `
      <div class="combo-opt${c.active ? ' active' : ''}"
           data-value="${esc(c.value == null ? '' : c.value)}"
           data-search="${esc([c.label, c.meta, c.tag].filter(Boolean).join(' ').toLowerCase())}"
           ${c.hidden ? 'data-rest-hidden="1"' : ''}>
        <strong>${esc(c.label)}</strong>
        ${c.meta ? `<span class="muted">${esc(c.meta)}</span>` : ''}
        ${c.tag ? `<span class="muted combo-fam">${esc(c.tag)}</span>` : ''}
      </div>`;
    return `
      <label class="field combo${o.cls ? ` ${o.cls}` : ''}">
        ${o.label ? `<span>${esc(o.label)}</span>` : ''}
        <input type="text" id="${esc(o.id)}" autocomplete="off" spellcheck="false"
          role="combobox" aria-expanded="false" aria-controls="${esc(o.id)}List" aria-autocomplete="list"
          placeholder="${esc(o.placeholder || 'Type to search')}" value="${esc(o.value || '')}">
        <div class="combo-list" id="${esc(o.id)}List" hidden>
          ${(o.options || []).map(opt).join('')}
          <div class="combo-empty muted" hidden>Nothing matches that</div>
          ${o.note ? `<div class="combo-note muted">${esc(o.note)}</div>` : ''}
        </div>
      </label>`;
  }

  /**
   * @param {Element} root   where to look the combo up
   * @param {string}  id     the input id passed to combo()
   * @param {function} onPick called with the chosen option's value
   */
  function wireCombo(root, id, onPick) {
    const input = $(`#${id}`, root);
    const list = $(`#${id}List`, root);
    if (!input || !list) return;

    const opts = () => $$('.combo-opt', list);
    const shown = () => opts().filter(o => !o.hidden);
    const empty = $('.combo-empty', list);
    const note = $('.combo-note', list);

    const open = () => { list.hidden = false; input.setAttribute('aria-expanded', 'true'); };
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };

    /**
     * @param {string|null} q  the query to filter by; null means "read the box"
     *
     * Focus passes '' rather than letting it read the box, because the box
     * holds the CURRENT SELECTION. Filtering by that shows a list of exactly
     * one item — the thing already chosen — and hides the note explaining what
     * is being left out. Opening a picker has to show you the options.
     */
    function filter(q0) {
      const q = (q0 == null ? input.value : q0).trim();
      for (const o of opts()) {
        // With an empty box, options marked `data-rest-hidden` stay out of the
        // list — that is how the sprint picker shows active and future only.
        // The moment you type, EVERYTHING is searchable, including them, which
        // is the whole point: hidden from the resting list, not from search.
        // The current selection is always visible, or the box would show a
        // value the list does not contain.
        o.hidden = q
          ? !matchText(o.dataset.search, q)
          : (o.dataset.restHidden === '1' && !o.classList.contains('active'));
      }
      const n = shown().length;
      if (empty) empty.hidden = n > 0;
      if (note) note.hidden = Boolean(q);
      mark(shown()[0] || null);
    }

    function mark(el2) {
      for (const o of opts()) o.classList.toggle('on', o === el2);
      if (el2 && el2.scrollIntoView) el2.scrollIntoView({ block: 'nearest' });
    }

    const choose = (el2) => { if (el2) onPick(el2.dataset.value); };

    input.addEventListener('focus', () => { input.select(); open(); filter(''); });
    input.addEventListener('input', () => { open(); filter(); });
    // `blur` fires BEFORE a click on an option would land, so choosing is wired
    // to mousedown below and this only tidies up.
    input.addEventListener('blur', () => setTimeout(close, 130));

    input.addEventListener('keydown', (e) => {
      const rows = shown();
      const at = rows.findIndex(o => o.classList.contains('on'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) { open(); filter(''); return; }
        mark(rows[e.key === 'ArrowDown' ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0)] || rows[0]);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        choose(rows[at] || rows[0]);
      } else if (e.key === 'Escape') {
        // Back to what is selected, not to empty: an empty box would imply a
        // selection the app has not made.
        const active = opts().find(o => o.classList.contains('active'));
        input.value = active ? active.querySelector('strong').textContent.trim() : '';
        close();
      }
    });

    list.addEventListener('mousedown', (e) => {
      const el2 = e.target.closest('.combo-opt');
      if (!el2) return;
      e.preventDefault();       // keep focus, so blur does not race the choice
      choose(el2);
    });
  }

  return { esc, el, $, $$, num, pct, int, date, dateTime, ago, initials, avatar, personColor, workloadClass, toast, drawer, closeDrawer, api, jsonPut, jsonPost, jsonDelete, kpi, bar, mixBar, pointsFieldNote, CATEGORY_COLORS, setJiraBase, issueUrl, issueKey, issueKeys, jiraSearch, componentSearchUrl, combo, wireCombo, matchText };
})();
