/* Search work items — Jira's issue search, against the local snapshot.

   Two ways in, one representation. The chips compile to a query string that is
   shown and editable; edit the string and the chips follow. Neither is a
   second-class citizen, and neither can drift from what is actually filtered —
   if a typed query is too complex for chips, the page says so rather than
   showing chips that quietly disagree with the results.

   Every facet count is computed under the OTHER filters, so the dropdowns tell
   you what is there before you click. That is the difference between filtering
   and guessing. */

const SearchView = (() => {
  const DEFAULT_COLS = ['key', 'summary', 'type', 'status', 'assignee', 'points', 'sprint'];

  let state = {
    q: '', chips: {}, text: '',
    page: 1, pageSize: 50, sort: null, dir: 'asc',
    columns: DEFAULT_COLS.slice(),
    openFacet: null, showColumns: false, raw: false,
    unrepresentable: [],
  };
  let data = null;
  let seq = 0;

  async function render(appState, mount) {
    // Restore whatever was on screen last time — coming back to a search you
    // just ran and finding it blank is its own small betrayal.
    if (!data) restore();
    mount.innerHTML = '<div class="loading">Searching…</div>';
    await run(mount, appState);
  }

  async function run(mount, appState) {
    const mine = ++seq;
    const params = new URLSearchParams({ q: state.q, page: state.page, pageSize: state.pageSize });
    if (state.sort) { params.set('sort', state.sort); params.set('dir', state.dir); }
    const d = await UI.api(`/api/search?${params}`);
    if (mine !== seq) return;                 // a later keystroke already won
    data = d;
    persist();
    paint(mount, appState);
  }

  /* ─────────────────────────── painting ─────────────────────────── */

  function paint(mount, appState) {
    const d = data;
    mount.innerHTML = `
      <section class="section">
        <div class="searchbar">
          <div class="searchbar-row">
            <label class="field" style="flex:1;min-width:220px">
              <span>Contains</span>
              <input type="text" id="sText" placeholder="key or summary — e.g. login, AUTOKAT-1234" value="${UI.esc(state.text)}">
            </label>
            <div class="spacer"></div>
            <button class="btn ghost sm" data-act="toggle-raw">${state.raw ? 'Hide query' : 'Edit as query'}</button>
            <button class="btn ghost sm" data-act="toggle-cols">Columns</button>
            <button class="btn ghost sm" data-act="save">Save search</button>
          </div>

          <div class="chips-row">
            ${(d.fields || []).map(f => chipButton(f, d)).join('')}
            ${activeCount() ? `<button class="chip clear" data-act="clear">Clear all (${activeCount()})</button>` : ''}
          </div>

          ${state.raw ? `
            <div class="raw-row">
              <textarea id="sRaw" spellcheck="false" rows="2"
                placeholder='status = Done AND assignee = "Hien Phan" ORDER BY updated DESC'>${UI.esc(state.q)}</textarea>
              <div class="raw-actions">
                <button class="btn sm" data-act="run-raw">Run</button>
                <span class="muted" style="font-size:11.5px">
                  Fields: ${(d.fields || []).map(f => f.name).join(', ')}, points, created, updated, resolved, blocked, estimated.
                  Operators: = != &gt; &lt; ~ IN, IS EMPTY, AND/OR, ORDER BY. Dates: 2026-09-01 or -14d.
                </span>
              </div>
            </div>` : ''}

          ${state.showColumns ? columnPicker(d) : ''}
        </div>
      </section>

      ${d.error ? `
        <section class="section">
          <div class="card"><div class="eyebrow"><i></i>That query did not run</div>
            <p style="margin:8px 0 0;font-size:13px"><strong>${UI.esc(d.error)}</strong></p>
            <p class="muted" style="font-size:12px;margin-top:6px">
              Nothing is being filtered right now — this is an error, not an empty result.
            </p>
          </div>
        </section>` : ''}

      ${state.unrepresentable.length ? `
        <section class="section">
          <div class="card"><div class="eyebrow"><i></i>The chips show part of this query</div>
            <p class="muted" style="margin:8px 0 0;font-size:12.5px">
              ${state.unrepresentable.map(u => `<code>${UI.esc(u)}</code>`).join(', ')}
              ${state.unrepresentable.length > 1 ? 'have' : 'has'} no chip equivalent, so the query string above is the one in charge.
            </p>
          </div>
        </section>` : ''}

      ${d.error ? '' : `
      <section class="section">
        <div class="result-head">
          <div>
            <strong style="font-size:15px">${UI.int(d.total)}</strong>
            <span class="muted">of ${UI.int(d.totalAll)} work items${d.total ? ` · ${UI.num(d.points)} pts · ${UI.int(d.unestimated)} unestimated` : ''}</span>
            <span class="muted" style="font-size:11px"> · ${d.tookMs}ms</span>
          </div>
          <div class="spacer"></div>
          ${d.jiraBase && d.total ? `<a class="btn ghost sm" href="${jiraSearchUrl(d)}" target="_blank" rel="noopener">Open in Jira</a>` : ''}
          <a class="btn ghost sm" href="/api/export?what=search&q=${encodeURIComponent(state.q)}&columns=${state.columns.join(',')}${state.sort ? `&sort=${state.sort}&dir=${state.dir}` : ''}">Export CSV</a>
        </div>

        ${d.total ? `
        <div class="table-wrap">
          <table class="result-table">
            <thead><tr>${state.columns.map(c => headerCell(c, d)).join('')}</tr></thead>
            <tbody>${d.rows.map(r => `<tr>${state.columns.map(c => cell(r, c, d)).join('')}</tr>`).join('')}</tbody>
          </table>
        </div>
        ${pager(d)}
        ` : `<div class="card"><div class="empty">
              Nothing matches.${activeCount() ? ' Try removing a filter — the counts in each dropdown show what is there.' : ''}
            </div></div>`}
      </section>`}

      ${(d.savedSearches || []).length ? `
      <section class="section">
        <div class="section-head"><h2>Saved searches</h2><span class="muted">Stored locally, never overwritten by a sync</span></div>
        <div class="saved-row">
          ${d.savedSearches.map(s => `
            <span class="saved-chip">
              <button data-saved="${UI.esc(s.id)}" title="${UI.esc(s.query || 'everything')}">${UI.esc(s.name)}</button>
              <button class="x" data-unsave="${UI.esc(s.id)}" title="Delete this saved search">×</button>
            </span>`).join('')}
        </div>
      </section>` : ''}
    `;
    wire(mount, appState);
  }

  function chipButton(f, d) {
    const active = (state.chips[f.name] || []).length;
    const open = state.openFacet === f.name;
    const values = (d.facets[f.name] || []);
    return `<div class="chip-wrap">
      <button class="chip${active ? ' active' : ''}" data-facet="${f.name}">
        ${UI.esc(f.label)}${active ? `: ${active === 1 ? UI.esc(label(state.chips[f.name][0])) : `${active} selected`}` : ''}
        <i class="caret">▾</i>
      </button>
      ${open ? `<div class="facet-menu">
        ${values.length > 12 ? `<input type="text" class="facet-search" data-facet-search="${f.name}" placeholder="Filter ${values.length} values…">` : ''}
        <div class="facet-list" data-facet-list="${f.name}">
          ${values.length ? values.map(v => `
            <label class="facet-opt" data-value="${UI.esc(v.value)}">
              <input type="checkbox" data-pick="${f.name}" value="${UI.esc(v.value)}"${(state.chips[f.name] || []).includes(v.value) ? ' checked' : ''}>
              <span>${UI.esc(label(v.value))}</span>
              <b>${UI.int(v.count)}</b>
            </label>`).join('') : '<div class="muted" style="padding:8px 10px;font-size:12px">No values under the other filters</div>'}
        </div>
        ${active ? `<button class="facet-clear" data-clear-facet="${f.name}">Clear ${UI.esc(f.label)}</button>` : ''}
      </div>` : ''}
    </div>`;
  }

  const label = (v) => (v === '__EMPTY__' ? '(none)' : v);

  function columnPicker(d) {
    return `<div class="col-picker">
      ${d.columns.map(c => `
        <label class="col-opt">
          <input type="checkbox" data-col="${c.key}"${state.columns.includes(c.key) ? ' checked' : ''}>
          <span>${UI.esc(c.label)}</span>
        </label>`).join('')}
      <button class="btn ghost sm" data-act="cols-reset">Reset</button>
    </div>`;
  }

  /**
   * This grid sorts on the SERVER, because it is paginated — sorting the fifty
   * rows on screen would quietly claim to have sorted the thousands behind
   * them. The `data-sort` attribute is also what tells the shared browser-side
   * sorter to keep its hands off this table; the caret comes from the same
   * stylesheet rule as every other grid, so one gesture looks like one gesture.
   */
  function headerCell(key, d) {
    const col = d.columns.find(c => c.key === key) || { label: key };
    const on = state.sort === key;
    const dir = state.dir === 'desc' ? 'desc' : 'asc';
    return `<th class="${col.num ? 'num ' : ''}sortable${on ? ` sort-${dir}` : ''}"
      aria-sort="${on ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'}"
      data-sort="${key}">${UI.esc(col.label)}</th>`;
  }

  function cell(row, key, d) {
    const col = d.columns.find(c => c.key === key) || {};
    let v = row[key];
    if (key === 'type') v = row.issueType;
    if (key === 'component') v = (row.components || []).join(', ');
    if (key === 'label') v = (row.labels || []).join(', ');
    if (key === 'sprint') v = (row.sprintNames || []).join(', ');
    if (key === 'epic') return `<td>${UI.issueKeys((row.epics || []).map(e => e.key))}</td>`;
    if (key === 'relates') return `<td>${UI.issueKeys((row.relatesTo || []).map(l => (l && l.key) || l))}</td>`;
    if (key === 'parent') return `<td>${UI.issueKey(row.parentKey)}</td>`;
    if (key === 'due') v = row.dueDate;
    if (key === 'blocked') v = (row.blockedBy || []).length ? 'blocked' : '';
    if (col.date && v) v = UI.date(v);

    if (key === 'key') {
      return `<td>${UI.issueKey(row.key)}</td>`;
    }
    if (key === 'status') {
      const tone = row.statusCategory === 'done' ? 'ok' : row.statusCategory === 'indeterminate' ? 'warn' : '';
      return `<td><span class="tag ${tone}">${UI.esc(v || '—')}</span></td>`;
    }
    if (key === 'category' && v) {
      return `<td><span class="tag"><i class="dot" style="background:${UI.CATEGORY_COLORS[v] || 'var(--app-fg-3)'}"></i>${UI.esc(v)}</span></td>`;
    }
    if (key === 'points') return `<td class="num">${row.points == null ? '—' : UI.num(row.points)}</td>`;
    if (key === 'blocked') return `<td>${v ? '<span class="tag risk">blocked</span>' : ''}</td>`;
    return `<td class="${col.wrap ? 'wrap' : ''} ${col.mono ? 'mono' : ''} ${v ? '' : 'muted'}">${UI.esc(v == null || v === '' ? '—' : String(v))}</td>`;
  }

  /**
   * The control under the results, now `UI.pager` — the same one the Backlog
   * table uses, so the two screens page identically rather than drifting.
   *
   * THIS ONE PAGES ON THE SERVER, so the rows are already the page and only
   * the range has to be worked out here; the Backlog has the whole payload
   * and slices it with `UI.paginate`. Different halves of the same job, one
   * control either way.
   */
  function pager(d) {
    const from = d.total ? (d.page - 1) * d.pageSize + 1 : 0;
    return UI.pager({
      page: d.page, pages: d.pages, total: d.total, pageSize: d.pageSize,
      from, to: d.total ? from + (d.rows || []).length - 1 : 0,
      sizeId: 'sPageSize', unit: 'work items',
    });
  }

  /** The same query, handed to Jira as JQL. Close enough to be useful, and it
      opens in a new tab where you can see exactly what Jira made of it. */
  function jiraSearchUrl(d) {
    const jql = state.q || 'ORDER BY updated DESC';
    return `${d.jiraBase}/issues/?jql=${encodeURIComponent(jql)}`;
  }

  /* ─────────────────────────── interaction ─────────────────────────── */

  function recompile(mount, appState) {
    state.q = QueryChips.fromChips(state.chips, state.text);
    state.unrepresentable = [];
    state.page = 1;
    run(mount, appState);
  }

  function wire(mount, appState) {
    const $ = (sel) => UI.$(sel, mount);

    const text = $('#sText');
    if (text) {
      let t;
      text.addEventListener('input', e => {
        state.text = e.target.value;
        clearTimeout(t);
        // Debounced: 7,000 issues filter in milliseconds, but re-rendering the
        // table on every keystroke makes the caret stutter.
        t = setTimeout(() => recompile(mount, appState), 180);
      });
    }

    UI.$$('[data-facet]', mount).forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      state.openFacet = state.openFacet === b.dataset.facet ? null : b.dataset.facet;
      paint(mount, appState);
    }));

    UI.$$('[data-pick]', mount).forEach(cb => cb.addEventListener('change', () => {
      const f = cb.dataset.pick;
      const cur = new Set(state.chips[f] || []);
      if (cb.checked) cur.add(cb.value); else cur.delete(cb.value);
      state.chips[f] = [...cur];
      if (!state.chips[f].length) delete state.chips[f];
      recompile(mount, appState);
    }));

    UI.$$('[data-clear-facet]', mount).forEach(b => b.addEventListener('click', () => {
      delete state.chips[b.dataset.clearFacet];
      recompile(mount, appState);
    }));

    UI.$$('[data-facet-search]', mount).forEach(inp => inp.addEventListener('input', e => {
      const needle = e.target.value.toLowerCase();
      const list = UI.$(`[data-facet-list="${e.target.dataset.facetSearch}"]`, mount);
      UI.$$('.facet-opt', list).forEach(o => {
        o.hidden = !String(o.dataset.value).toLowerCase().includes(needle);
      });
    }));

    const act = (name, fn) => { const el = $(`[data-act="${name}"]`); if (el) el.addEventListener('click', fn); };

    act('clear', () => { state.chips = {}; state.text = ''; recompile(mount, appState); });
    act('toggle-raw', () => { state.raw = !state.raw; paint(mount, appState); });
    act('toggle-cols', () => { state.showColumns = !state.showColumns; paint(mount, appState); });
    act('cols-reset', () => { state.columns = DEFAULT_COLS.slice(); paint(mount, appState); });

    act('run-raw', () => {
      const raw = $('#sRaw').value;
      state.q = raw;
      // Pull the chips back out so the filter bar keeps telling the truth about
      // what is filtered — and say plainly which parts it cannot show.
      try {
        const back = QueryChips.toChips(raw);
        state.chips = back.chips;
        state.text = back.text;
        state.unrepresentable = back.unrepresentable;
      } catch (_) {
        state.chips = {}; state.text = ''; state.unrepresentable = [];
      }
      state.page = 1;
      run(mount, appState);
    });

    act('save', async () => {
      const name = prompt('Name this search:', suggestName());
      if (!name) return;
      try {
        await UI.jsonPost('/api/search/saved', {
          name, query: state.q, columns: state.columns, sort: state.sort, dir: state.dir,
        });
        UI.toast(`Saved "${name}"`);
        run(mount, appState);
      } catch (e) { UI.toast(e.message); }
    });

    UI.$$('[data-saved]', mount).forEach(b => b.addEventListener('click', () => {
      const s = (data.savedSearches || []).find(x => x.id === b.dataset.saved);
      if (!s) return;
      state.q = s.query || '';
      if (s.columns && s.columns.length) state.columns = s.columns.slice();
      state.sort = s.sort || null; state.dir = s.dir || 'asc';
      try {
        const back = QueryChips.toChips(state.q);
        state.chips = back.chips; state.text = back.text; state.unrepresentable = back.unrepresentable;
      } catch (_) { state.chips = {}; state.text = ''; }
      state.page = 1;
      run(mount, appState);
    }));

    UI.$$('[data-unsave]', mount).forEach(b => b.addEventListener('click', async () => {
      const s = (data.savedSearches || []).find(x => x.id === b.dataset.unsave);
      if (!confirm(`Delete the saved search "${s ? s.name : b.dataset.unsave}"?`)) return;
      await UI.jsonDelete('/api/search/saved', { id: b.dataset.unsave });
      run(mount, appState);
    }));

    UI.$$('[data-col]', mount).forEach(cb => cb.addEventListener('change', () => {
      const k = cb.dataset.col;
      if (cb.checked && !state.columns.includes(k)) state.columns.push(k);
      if (!cb.checked) state.columns = state.columns.filter(c => c !== k);
      if (!state.columns.length) state.columns = ['key'];
      paint(mount, appState);
    }));

    UI.$$('[data-sort]', mount).forEach(th => th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (state.sort === k) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
      else { state.sort = k; state.dir = 'asc'; }
      run(mount, appState);
    }));

    UI.$$('[data-page]', mount).forEach(b => b.addEventListener('click', () => {
      state.page = Number(b.dataset.page);
      run(mount, appState);
    }));

    const ps = $('#sPageSize');
    if (ps) ps.addEventListener('change', e => { state.pageSize = Number(e.target.value); state.page = 1; run(mount, appState); });

    // A dropdown left open over the results is just in the way.
    if (state.openFacet) {
      const close = (e) => {
        if (e.target.closest('.chip-wrap')) return;
        state.openFacet = null;
        document.removeEventListener('click', close);
        paint(mount, appState);
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    }
  }

  const activeCount = () => Object.values(state.chips).reduce((t, v) => t + v.length, 0) + (state.text ? 1 : 0);

  function suggestName() {
    const bits = Object.entries(state.chips).map(([f, v]) => `${f}: ${v.map(label).join('/')}`);
    if (state.text) bits.push(`"${state.text}"`);
    return bits.join(', ').slice(0, 60) || 'All work items';
  }

  /* Per-browser convenience only — the saved searches above are the real thing. */
  function persist() {
    try {
      localStorage.setItem('pt-search', JSON.stringify({
        q: state.q, chips: state.chips, text: state.text,
        columns: state.columns, sort: state.sort, dir: state.dir, pageSize: state.pageSize,
      }));
    } catch (_) { /* private window, blocked storage — never load-bearing */ }
  }
  function restore() {
    try {
      const s = JSON.parse(localStorage.getItem('pt-search') || '{}');
      if (s && typeof s === 'object') {
        state.q = s.q || ''; state.chips = s.chips || {}; state.text = s.text || '';
        state.columns = Array.isArray(s.columns) && s.columns.length ? s.columns : DEFAULT_COLS.slice();
        state.sort = s.sort || null; state.dir = s.dir || 'asc';
        state.pageSize = Number(s.pageSize) || 50;
      }
    } catch (_) { /* fall back to defaults */ }
  }

  return { render };
})();
