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

  /**
   * A progress bar.
   *
   * It carries its own percentage in `data-sort-value` because a bar is a cell
   * with no text in it, and a column of them would otherwise all sort as
   * "nothing here". Putting the number on the bar rather than on each of the
   * nine cells that draw one means the column sorts by what the reader can
   * actually see, everywhere, without every view remembering to say so.
   */
  const bar = (value, max, cls = '') => {
    const w = max ? Math.max(0, Math.min(100, value / max * 100)) : 0;
    return `<div class="bar ${cls}" data-sort-value="${Math.round(w * 10) / 10}"><i style="width:${w}%"></i></div>`;
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
   * How wide, in `ch`, a box has to be to show `v` whole.
   *
   * `ch` is the advance of "0", which in the app's font (Poppins at 13px) is
   * 8.16px against a real average of about 6.6px for a sprint name — so a
   * character count in `ch` over-reserves by roughly a fifth, and the box never
   * clips. Two spare characters cover a value that is unusually wide, such as
   * one in capitals.
   *
   * Deliberately not a pixel measurement: measuring text means a canvas and a
   * webfont that may not have loaded on the first paint, which is a number that
   * is confidently wrong at exactly the moment it is used. The `size` attribute
   * would also do this, but it reserves more than twice what the text needs —
   * the box came out at 317px for 146px of text.
   */
  const fitChars = (v, min = 12) => Math.max(min, String(v == null ? '' : v).length + 2);

  /**
   * @param {object} o
   * @param {boolean} o.autosize whether the box grows to fit its own value,
   *                             rather than sitting at a fixed width and
   *                             truncating anything longer
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
          class="${o.autosize ? 'combo-fit' : ''}" ${o.autosize ? `style="width:${fitChars(o.value)}ch"` : ''}
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
      // Opening a picker puts the cursor on WHAT IS ALREADY CHOSEN, not on the
      // top of the list — and `mark` scrolls it into view, so the current sprint
      // is the row you are looking at even when it is the fortieth. Sitting on
      // the first row also made Enter straight after opening silently switch
      // you to whatever happened to sort first. While typing, the best match
      // leads, which is what a search box should do.
      mark(q ? (shown()[0] || null) : (shown().find(o => o.classList.contains('active')) || shown()[0] || null));
    }

    function mark(el2) {
      for (const o of opts()) o.classList.toggle('on', o === el2);
      if (el2 && el2.scrollIntoView) el2.scrollIntoView({ block: 'nearest' });
    }

    /** Re-fit an autosizing box to whatever it now holds. */
    const fit = () => {
      if (input.classList.contains('combo-fit')) input.style.width = `${fitChars(input.value)}ch`;
    };

    /**
     * Commit a choice.
     *
     * The picker updates ITSELF before calling back, because whether the caller
     * re-renders it is the caller's business: the team picker rebuilds both
     * boxes, the sprint picker only refreshes the page under them. The sprint
     * picker was the one that showed the cost — after choosing, the box still
     * held the query you typed and the highlight still sat on the sprint you
     * had just left, so the control disagreed with the screen it had just
     * changed.
     */
    const choose = (el2) => {
      if (!el2) return;
      for (const o of opts()) o.classList.toggle('active', o === el2);
      input.value = el2.querySelector('strong').textContent.trim();
      fit();
      close();
      onPick(el2.dataset.value);
    };

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
        fit();
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

  /* ── the sprint's items, as a table ────────────────────────────────────
     Shared, because it is on two screens. The Active sprint screen answers "is
     this landing"; Capacity planning answers "who is carrying what" — and both
     questions end at the same place, the actual list of tickets. Two copies of
     an eight-column table with an epic cell in it would have drifted within a
     sprint or two, and the drift would be silent: both would look right.

     `state` supplies the category labels and colours the app already has. */

  const STATUS_ORDER = ['open', 'refinement', 'in dev', 'in testing', 'done'];

  /** Reading order: what has not started, down to what is finished. */
  function byStatusThenPoints(a, b) {
    const ai = STATUS_ORDER.indexOf(String(a.status || '').toLowerCase());
    const bi = STATUS_ORDER.indexOf(String(b.status || '').toLowerCase());
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || (b.points || 0) - (a.points || 0);
  }

  const clip = (s, n = 34) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

  /**
   * The Epic cell.
   *
   * A story has one epic (its parent); a maintenance ticket can relate to
   * several, and a handful of them relate to five or six. Showing all of them
   * inline turns the row into a paragraph, so two are shown and the rest are
   * counted — the full list is in the hover, which is where you go when the
   * count is what caught your eye.
   *
   * The key is always shown even when we have the name, because the key is what
   * you paste into Jira.
   */
  function epicCell(i) {
    const list = i.epics || [];
    if (!list.length) return '<span class="muted">—</span>';
    const label = (e) => `${e.key}${e.name ? ` · ${e.name}` : ''}`;
    const VIA = { relates: 'relates to', 'relates-parent': 'parent of a related issue', parent: 'parent' };
    const title = list.map(e => `${label(e)} (${VIA[e.via] || e.via}${e.unconfirmed ? ', type not confirmed as Epic' : ''})`).join('\n');
    const shown = list.slice(0, 2).map(e => `
      <span class="tag${e.unconfirmed ? '' : ' ok'}" title="${esc(title)}">
        ${issueKey(e.key)}${e.name ? ` ${esc(clip(e.name))}` : ''}
      </span>`).join(' ');
    const more = list.length > 2 ? ` <span class="muted" title="${esc(title)}">+${list.length - 2}</span>` : '';
    return `<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">${shown}${more}</div>`;
  }

  /**
   * @param {Array}  items  the sprint's issues
   * @param {object} state  the app state, for category labels
   * @param {object} o      `title` and `sub` override the heading
   */
  function itemsTable(items, state, o = {}) {
    const list = (items || []).slice().sort(byStatusThenPoints);
    const cats = (state && state.categories) || {};
    // The literal reading: nobody in the Assignee field. Counted here so the
    // caption says it without every caller working it out again — and so it
    // cannot quietly come to mean "not on the roster", which is a different
    // number and was once reported as this one.
    const noAssignee = list.filter(i => !i.assignee).length;
    return `
      <section class="section">
        <div class="section-head">
          <h2>${esc(o.title || 'All sprint items')}</h2>
          <span class="muted">${list.length} items${noAssignee ? ` · ${noAssignee} with no assignee` : ''}${o.sub ? ` · ${esc(o.sub)}` : ''}</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Key</th><th>Summary</th><th>Category</th><th>Assignee</th><th>Status</th><th class="num">Points</th><th>Component</th><th>Epic</th></tr></thead>
            <tbody>${list.map(i => `
              <tr>
                <td>${issueKey(i.key)}</td>
                <td class="wrap">${esc(i.summary)}</td>
                <td><span class="tag"><i class="dot" style="background:${CATEGORY_COLORS[i.category]}"></i>${esc((cats[i.category] || {}).label || i.category)}</span></td>
                <td>${i.assignee ? `<div class="name-cell">${avatar(i.assignee)}${esc(i.assignee)}</div>` : '<span class="tag warn">unassigned</span>'}</td>
                <td>${esc(i.status || '—')}</td>
                <td class="num">${i.points == null ? '<span class="tag risk">—</span>' : num(i.points)}</td>
                <td class="muted">${esc((i.components || [])[0] || '—')}</td>
                <td>${epicCell(i)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>`;
  }

  /* ── sortable grids ────────────────────────────────────────────────────
     Click a column heading to sort the table under it. Every grid in the app
     gets this from one call, because the alternative — each view sorting its
     own data and re-rendering — is fifteen implementations that disagree about
     what "sort by Points" does to a row that has no estimate.

     This sorts the ROWS IN THE DOM rather than the data behind them. That is
     the right trade here: it works on any table without the view knowing, it
     survives a view re-render (the next render simply starts unsorted), and it
     cannot desynchronise a table from the numbers above it, because it never
     touches the numbers. The one thing it cannot do is sort across pages,
     which is exactly why the search grid keeps its own server-side sort — see
     `sortableTable` below.

     Three states per column: ascending, descending, then back to the order the
     view chose. That third state matters more than it looks — a sprint list is
     in sprint order and a backlog is in priority order for a reason, and a
     sort you cannot undo without a page refresh quietly destroys that. */

  /** Values that mean "nothing here". These sort last in BOTH directions. */
  const SORT_BLANK = new Set(['', '—', '–', '-', 'n/a', 'never']);

  const cellsOf = (row) => [...row.children].filter(c => c.tagName === 'TD' || c.tagName === 'TH');

  /**
   * One row's value for one column: an explicit `data-sort-value` beats the
   * rendered text. Cells where the text cannot be ordered — a date shown as
   * "3 Sep", a bar with no text at all — carry the raw value that way.
   */
  function sortKey(row, i) {
    const cell = cellsOf(row)[i];
    if (!cell) return '';
    const own = cell.dataset ? cell.dataset.sortValue : null;
    if (own != null && own !== '') return String(own).trim();
    const text = String(cell.textContent).trim();
    if (text) return text;
    // A cell with no text at all is a graphic — a progress bar, a mix bar.
    // Those carry their own number, so the column sorts by what is drawn
    // rather than collapsing into a column of blanks.
    const inner = cell.querySelector && cell.querySelector('[data-sort-value]');
    return inner ? String(inner.dataset.sortValue).trim() : '';
  }

  /** The number in a cell, or null when it is not one. Tolerates %, commas, +. */
  function sortNumber(s) {
    const t = String(s).replace(/[,\s]/g, '').replace(/%$/, '').replace(/^\+/, '');
    return /^-?(?:\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : null;
  }

  /**
   * Split a tbody into what can move and what cannot.
   *
   * Three kinds of row are not data: a `total` row and the `unassigned-row`
   * summarise what is above them, and a row whose cell spans the table is a
   * note rather than a record. Sorting any of those into the middle turns a
   * summary into a claim about one row. They stay at the bottom, in the order
   * the view put them.
   *
   * A `detail-row` is the expandable panel belonging to the row above it, so it
   * travels WITH that row rather than being sorted away from it.
   */
  function sortGroups(tbody) {
    const groups = [], pinned = [];
    for (const r of [...tbody.children].filter(x => x.tagName === 'TR')) {
      if (r.classList.contains('detail-row') && groups.length) {
        groups[groups.length - 1].rows.push(r);
        continue;
      }
      const isPinned = r.classList.contains('total')
        || r.classList.contains('unassigned-row')
        || cellsOf(r).some(c => c.getAttribute && c.getAttribute('colspan'));
      if (isPinned) pinned.push(r);
      else groups.push({ lead: r, rows: [r] });
    }
    return { groups, pinned };
  }

  /**
   * Can this table be sorted from here?
   *
   * A table opts out with `data-nosort`. A table whose headings already carry
   * `data-sort` sorts ITSELF — the search grid does, server-side, because it is
   * paginated and sorting the fifty rows on screen would silently claim to have
   * sorted the other four thousand.
   */
  function sortableTable(table) {
    if (table.hasAttribute && table.hasAttribute('data-nosort')) return false;
    const head = table.querySelector('thead tr');
    if (!head || !table.querySelector('tbody')) return false;
    if (head.querySelector('[data-sort]')) return false;
    return true;
  }

  /**
   * @param {Element} table
   * @param {number}  i    column index
   * @param {string}  dir  'asc' | 'desc' | 'none'
   */
  function sortTable(table, i, dir) {
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    const { groups, pinned } = sortGroups(tbody);

    // Stamped on the first sort, which is the only moment the DOM still holds
    // the view's own order — after that, "none" would restore a previous sort.
    groups.forEach((g, n) => { if (g.lead.dataset.sortAt == null) g.lead.dataset.sortAt = String(n); });

    let ordered;
    if (dir === 'none') {
      ordered = groups.slice().sort((a, b) => Number(a.lead.dataset.sortAt) - Number(b.lead.dataset.sortAt));
    } else {
      const keys = new Map(groups.map(g => [g, sortKey(g.lead, i)]));
      const real = [...keys.values()].filter(v => !SORT_BLANK.has(v.toLowerCase()));
      // A column counts as numeric only when EVERY value in it is a number. One
      // "n/a" among the points would otherwise drop the whole column back to
      // text, where 10 sorts before 9.
      const numeric = real.length > 0 && real.every(v => sortNumber(v) != null);
      const sign = dir === 'desc' ? -1 : 1;
      ordered = groups.slice().sort((a, b) => {
        const x = keys.get(a), y = keys.get(b);
        const bx = SORT_BLANK.has(x.toLowerCase()), by = SORT_BLANK.has(y.toLowerCase());
        // Missing data is not a small value — it is the absence of one, so it
        // sits at the bottom whichever way the column is pointing.
        if (bx || by) return bx && by ? 0 : bx ? 1 : -1;
        const d = numeric
          ? sortNumber(x) - sortNumber(y)
          : x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });
        // A stable tie-break on the view's own order, so equal rows do not
        // shuffle every time you click.
        return d !== 0 ? d * sign : Number(a.lead.dataset.sortAt) - Number(b.lead.dataset.sortAt);
      });
    }

    for (const g of ordered) for (const r of g.rows) tbody.appendChild(r);
    for (const r of pinned) tbody.appendChild(r);

    for (const th of [...table.querySelector('thead tr').children]) {
      const on = th.dataset && th.dataset.sortCol === String(i) && dir !== 'none';
      th.classList.toggle('sort-asc', on && dir === 'asc');
      th.classList.toggle('sort-desc', on && dir === 'desc');
      th.setAttribute('aria-sort', on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
    }
    table.dataset.sortCol = dir === 'none' ? '' : String(i);
    table.dataset.sortDir = dir;
  }

  /** Ascending, then descending, then back to the view's own order. */
  const nextDir = (table, i) =>
    (table.dataset.sortCol !== String(i) ? 'asc'
      : table.dataset.sortDir === 'asc' ? 'desc'
        : table.dataset.sortDir === 'desc' ? 'none' : 'asc');

  /**
   * Make every grid under `root` sortable.
   *
   * One delegated listener on `root`, not one per heading: views rebuild their
   * own tables between renders, and a listener bound to a heading dies with it
   * while this one keeps working. `root` is the per-render container, so the
   * listener dies with the render — the property ui-wiring.test.js pins.
   */
  function sortable(root) {
    if (!root || !root.querySelectorAll) return;
    for (const table of root.querySelectorAll('table')) {
      if (!sortableTable(table)) continue;
      cellsOf(table.querySelector('thead tr')).forEach((th, i) => {
        if (th.tagName !== 'TH') return;
        if (th.hasAttribute && th.hasAttribute('data-nosort')) return;
        // A heading with no text is an actions or expander column; there is
        // nothing in it to order by.
        if (!String(th.textContent).trim()) return;
        th.classList.add('sortable');
        th.dataset.sortCol = String(i);
        th.setAttribute('aria-sort', 'none');
      });
    }
    root.addEventListener('click', (e) => {
      const th = e.target && e.target.closest && e.target.closest('th.sortable');
      // `data-sort-col` is what marks a heading as OURS. The search grid's
      // headings also carry `.sortable` and are wired to its own server-side
      // sort; without this they would be sorted twice, once wrongly.
      if (!th || !th.dataset || th.dataset.sortCol == null || th.dataset.sortCol === '') return;
      const table = th.closest('table');
      if (!table) return;
      const i = Number(th.dataset.sortCol);
      sortTable(table, i, nextDir(table, i));
    });
  }

  return { esc, el, $, $$, num, pct, int, date, dateTime, ago, initials, avatar, personColor, workloadClass, toast, drawer, closeDrawer, api, jsonPut, jsonPost, jsonDelete, kpi, bar, mixBar, pointsFieldNote, CATEGORY_COLORS, setJiraBase, issueUrl, issueKey, issueKeys, jiraSearch, componentSearchUrl, combo, wireCombo, matchText, fitChars, sortable, sortTable, sortableTable, sortNumber,
    itemsTable, epicCell, byStatusThenPoints };
})();
