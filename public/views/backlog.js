/* Backlog — a queue to manage, not a list to scroll.

   The questions it answers: what is ready to pull into a sprint, what is stuck
   behind a missing estimate, and how many sprints of runway is actually here. */

const BacklogView = (() => {
  let filters = { category: null, component: null, state: null, q: '' };
  /* EVERY ITEM IS REACHABLE. This table used to draw the first 400 rows and
     tell you to narrow the filters to see the rest — which on the Katalon
     Automation backlog of 892 items meant 492 you could not get to at all,
     and "narrow the filters" is no answer when what you want is to read the
     queue rather than search it. Paged instead, through `UI.paginate`, which
     is also what the Search screen uses. */
  let page = 1;
  let pageSize = 100;
  let data = null;

  async function render(state, mount) {
    data = await UI.api(`/api/backlog/health?team=${encodeURIComponent(state.teamId)}`);
    const d = data;
    // A fresh payload is a fresh queue — page 7 of Titan's backlog means
    // nothing once the team picker has moved to Ruby's 77 items.
    page = 1;

    if (!d.total) {
      mount.innerHTML = `<div class="card"><div class="empty">
        Nothing in ${UI.esc(d.teamName)}'s backlog.<br><br>
        ${d.source === 'board'
          ? "That is what the team's Jira board backlog contains."
          : 'This is a guess from ownership rules rather than the board\'s own backlog — run a full sync, or map a board in Integrations &amp; setup.'}
        ${UI.pointsFieldNote(state)}
      </div></div>`;
      return;
    }

    mount.innerHTML = `
      <section class="section">
        <div class="kpis">
          ${UI.kpi({ label: 'Ready to plan', value: UI.int(d.ready.points), unit: 'pts', foot: `${d.ready.count} items · ${d.ready.sprints != null ? `${d.ready.sprints} sprints of work` : 'no velocity yet'}`, tone: 'brand', featured: true })}
          ${UI.kpi({ label: 'Total queued', value: UI.int(d.points), unit: 'pts', foot: `${d.total} items · ${d.runway != null ? `${d.runway} sprints at ${d.avgVelocity} pts` : 'no velocity yet'}` })}
          ${UI.kpi({ label: 'Unestimated', value: UI.int(d.unestimated.count), unit: 'items', foot: `${UI.pct(d.unestimated.pct)} of the backlog — invisible to every forecast`, tone: d.unestimated.count ? 'warn' : 'ok' })}
          ${UI.kpi({ label: 'Blocked', value: UI.int(d.blocked.count), unit: 'items', foot: 'Cannot be pulled in as things stand', tone: d.blocked.count ? 'risk' : 'ok' })}
          ${UI.kpi({ label: 'Pre-assigned', value: UI.pct(d.assigned.pct), foot: `${d.assigned.count} items already have an owner` })}
        </div>
      </section>

      <section class="section grid-2">
        <div class="card">
          <h3>Readiness</h3>
          <div class="sub">${UI.esc(d.basis)}</div>
          ${readinessBar(d)}
          <ul class="reasons" style="margin-top:14px">
            ${d.unestimated.count ? `<li class="warn">${d.unestimated.count} items have no estimate — until they do, the runway figure above is only about ${UI.pct(d.estimated.pct)} of the real queue</li>` : '<li class="ok">Everything queued is estimated</li>'}
            ${d.blocked.count ? `<li class="risk">${d.blocked.count} items are blocked by other work</li>` : ''}
            ${d.highPriority.count ? `<li>${d.highPriority.count} High/Highest items (${UI.num(d.highPriority.points)} pts) are waiting</li>` : ''}
          </ul>
          ${UI.pointsFieldNote(state)}
        </div>
        <div class="card">
          <h3>Work mix queued</h3>
          <div class="sub">What the backlog will turn into if it is pulled in as-is</div>
          ${UI.mixBar(d.mix, state.categories)}
          <h3 style="margin-top:22px;font-size:13px">By component</h3>
          ${Charts.ranked(d.byComponent.slice(0, 8), { labelKey: 'key', valueKey: 'points' })}
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <h2>Items</h2>
          <div class="spacer"></div>
          <a class="btn ghost sm" href="/api/export?what=backlog&team=${encodeURIComponent(state.teamId)}">Export CSV</a>
        </div>
        <div class="filters">
          <label class="field"><span>Search</span><input type="text" id="blSearch" placeholder="key or summary" value="${UI.esc(filters.q)}" style="width:220px"></label>
          <label class="field"><span>Component</span><select id="blComponent"><option value="">All</option>${d.byComponent.map(c => `<option${filters.component === c.key ? ' selected' : ''}>${UI.esc(c.key)}</option>`).join('')}</select></label>
          <div class="field"><span>State</span><div style="display:flex;gap:6px;flex-wrap:wrap">
            ${[['ready', 'Ready to plan'], ['unestimated', 'No estimate'], ['blocked', 'Blocked'], ['unassigned', 'No owner']]
              .map(([k, label]) => `<button class="chip${filters.state === k ? ' active' : ''}" data-state="${k}">${label}</button>`).join('')}
          </div></div>
          <div class="field"><span>Category</span><div style="display:flex;gap:6px;flex-wrap:wrap">
            ${Object.entries(state.categories).map(([k, v]) => `<button class="chip${filters.category === k ? ' active' : ''}" data-cat="${k}">${UI.esc(v.label)}</button>`).join('')}
          </div></div>
        </div>
        <div id="blTable"></div>
      </section>
    `;

    renderTable(state, mount);
    wire(state, mount);
  }

  /** One bar showing the backlog split by how ready each part is. */
  function readinessBar(d) {
    const blocked = d.blocked.count;
    const unest = d.unestimated.count;
    const ready = Math.max(0, d.total - blocked - unest);
    const parts = [
      { n: ready, label: 'Ready to plan', color: 'var(--ok)' },
      { n: unest, label: 'Needs an estimate', color: 'var(--warn)' },
      { n: blocked, label: 'Blocked', color: 'var(--risk)' },
    ].filter(p => p.n > 0);
    return `
      <div class="mixbar">${parts.map(p => `<i style="width:${p.n / d.total * 100}%;background:${p.color}" title="${p.label}: ${p.n}"></i>`).join('')}</div>
      <div class="mixkey">${parts.map(p => `<span><i style="background:${p.color}"></i>${p.label} <strong>${p.n}</strong></span>`).join('')}</div>`;
  }

  function filtered() {
    const blockedKeys = new Set(data.blocked.items.map(i => i.key));
    const q = filters.q.toLowerCase();
    return data.items.filter(i => {
      if (filters.category && i.category !== filters.category) return false;
      if (filters.component && !(i.components || []).includes(filters.component)) return false;
      if (q && !`${i.key} ${i.summary}`.toLowerCase().includes(q)) return false;
      switch (filters.state) {
        case 'ready': return i.points != null && !blockedKeys.has(i.key);
        case 'unestimated': return i.points == null;
        case 'blocked': return blockedKeys.has(i.key);
        case 'unassigned': return !i.assignee;
        default: return true;
      }
    }).sort((a, b) => (b.points || 0) - (a.points || 0) || String(a.key).localeCompare(b.key));
  }

  /** Nothing typed, nothing chipped — the table is showing the whole queue. */
  const unfiltered = () => !filters.q && !filters.component && !filters.state && !filters.category;

  /**
   * THE WAY OUT TO JIRA, and which of two it should be.
   *
   * A key list is exact but finite: it runs out of URL, and his 892-item
   * backlog opened 393 of them. The board's backlog view has no such limit —
   * it names the set instead of listing it — but it can only ever mean the
   * WHOLE backlog, because a board view cannot be narrowed by a search box
   * or a category chip that only exists in this app.
   *
   * So the choice follows the filters, and each link means exactly what the
   * count beside it says:
   *
   *   unfiltered, board mapped → the board's backlog. Opens all of them.
   *   filtered, or no board    → the keys, which are the only exact answer
   *                              for a subset, truncation notice and all.
   *
   * The one thing that must not happen is a link that silently means a
   * different set from the number it sits next to.
   */
  function jiraLink(items) {
    const board = unfiltered() ? UI.boardBacklogUrl(data.boardId) : null;
    if (!board) return UI.openInJira(items.map(i => i.key));
    return `<a class="btn ghost sm" href="${UI.esc(board)}" target="_blank" rel="noopener"
      title="Open the whole backlog — all ${UI.int(items.length)} items — on the team's Jira board">Open in Jira</a>`;
  }

  function renderTable(state, mount) {
    const items = filtered();
    const blockedKeys = new Set(data.blocked.items.map(i => i.key));
    const pts = items.reduce((t, i) => t + (i.points || 0), 0);
    /* The page is CLAMPED rather than trusted — see `UI.paginate`. Filters
       can shrink the set under a page number that was valid a keystroke ago,
       and `p.page` is the one actually used, so the pager and the rows below
       it cannot disagree. */
    const p = UI.paginate(items, page, pageSize);
    page = p.page;
    /* OPEN IN JIRA SITS ON THE COUNT LINE, NOT IN THE SECTION HEAD.
       This line is redrawn on every filter change, so the link always opens the
       set the number beside it describes. The head holds Export CSV, which
       exports the WHOLE backlog whatever the filters say — a filtered link up
       there would read as the same scope and quietly be a different one.

       It opens what the COUNT says, not the rows on THIS PAGE: paging is
       about what a screen can usefully show, and Jira has no such problem —
       a link that opened only the hundred rows you happened to be looking at
       would change meaning every time you pressed Next. */
    UI.$('#blTable', mount).innerHTML = items.length ? `
      <div class="muted" style="display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:12px">
        <span>${items.length} items · ${UI.num(pts)} pts</span>
        <span class="spacer"></span>
        ${jiraLink(items)}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Key</th><th>Summary</th><th>Category</th><th>State</th><th>Component</th><th>Priority</th><th class="num">Points</th><th>Assignee</th></tr></thead>
          <tbody>
            ${p.rows.map(i => `
              <tr>
                <td>${UI.issueKey(i.key)}</td>
                <td class="wrap">${UI.esc(i.summary)}</td>
                <td><span class="tag"><i class="dot" style="background:${UI.CATEGORY_COLORS[i.category]}"></i>${UI.esc((state.categories[i.category] || {}).label || i.category)}</span></td>
                <td>${blockedKeys.has(i.key) ? '<span class="tag risk">blocked</span>'
                  : i.points == null ? '<span class="tag warn">no estimate</span>'
                  : '<span class="tag ok">ready</span>'}</td>
                <td class="muted">${UI.esc((i.components || [])[0] || '—')}</td>
                <td class="muted">${UI.esc(i.priority || '—')}</td>
                <td class="num">${i.points == null ? '—' : UI.num(i.points)}</td>
                <td class="muted">${UI.esc(i.assignee || '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${UI.pager({ ...p, pageSize, sizeId: 'blPageSize', unit: 'items' })}
    ` : '<div class="card"><div class="empty">Nothing matches these filters.</div></div>';

    wirePager(state, mount);
  }

  /**
   * The pager, rewired on every draw.
   *
   * It is inside `#blTable`, so `renderTable` replaces these controls every
   * time — a listener attached to the previous set of buttons is attached to
   * nodes that are no longer on the page. Cheap to redo and impossible to
   * get subtly wrong, which a delegated listener on a container that is
   * itself replaced is not.
   */
  function wirePager(state, mount) {
    UI.$$('[data-page]', mount).forEach(b => b.addEventListener('click', () => {
      if (b.disabled) return;
      page = Number(b.dataset.page);
      renderTable(state, mount);
    }));
    const size = UI.$('#blPageSize', mount);
    if (size) size.addEventListener('change', e => {
      pageSize = Number(e.target.value) || 100;
      // Row 250 is on a different page once the page holds 25 instead of 100,
      // and there is no honest way to keep your place — so go back to the top
      // rather than land somewhere arbitrary.
      page = 1;
      renderTable(state, mount);
    });
  }

  /* EVERY FILTER RESETS THE PAGE. Without this, typing in the search box
     while on page 7 leaves you on page 7 of a two-row result — the clamp in
     `UI.paginate` saves it from rendering nothing, but landing on the last
     page of a set you just narrowed is still not where anyone meant to be. */
  const refilter = (state, mount) => { page = 1; renderTable(state, mount); };

  function wire(state, mount) {
    UI.$('#blSearch', mount).addEventListener('input', e => { filters.q = e.target.value; refilter(state, mount); });
    UI.$('#blComponent', mount).addEventListener('change', e => { filters.component = e.target.value || null; refilter(state, mount); });
    UI.$$('[data-state]', mount).forEach(b => b.addEventListener('click', () => {
      filters.state = filters.state === b.dataset.state ? null : b.dataset.state;
      UI.$$('[data-state]', mount).forEach(x => x.classList.toggle('active', x.dataset.state === filters.state));
      refilter(state, mount);
    }));
    UI.$$('[data-cat]', mount).forEach(b => b.addEventListener('click', () => {
      filters.category = filters.category === b.dataset.cat ? null : b.dataset.cat;
      UI.$$('[data-cat]', mount).forEach(x => x.classList.toggle('active', x.dataset.cat === filters.category));
      refilter(state, mount);
    }));
  }

  return { render };
})();
