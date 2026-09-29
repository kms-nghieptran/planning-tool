/* Backlog — a queue to manage, not a list to scroll.

   The questions it answers: what is ready to pull into a sprint, what is stuck
   behind a missing estimate, and how many sprints of runway is actually here. */

const BacklogView = (() => {
  let filters = { category: null, component: null, state: null, assignee: null, q: '' };
  /* THE SENTINEL for "nobody". An empty string is the All option, so the
     unassigned pile needs a value of its own — the same rule and the same
     shape the item table's own filter uses. */
  const UNASSIGNED = '— none —';
  /* EVERY ITEM IS REACHABLE. This table used to draw the first 400 rows and
     tell you to narrow the filters to see the rest — which on the Katalon
     Automation backlog of 892 items meant 492 you could not get to at all,
     and "narrow the filters" is no answer when what you want is to read the
     queue rather than search it. Paged instead, through `UI.paginate`, which
     is also what the Search screen uses. */
  let page = 1;
  let pageSize = 100;
  let data = null;

  /* ── COLLAPSE, REMEMBERED PER TEAM ────────────────────────────────────
     Which sections are shut is a reading position, not data: it belongs to
     the person and the screen, so it is kept in the browser and never sent
     anywhere. PER TEAM because a sprint id is global in the plan while the
     work under it is not — folding Titan's sprint 41 away should not fold
     Ruby's, and the two are the same id.

     localStorage throws in a few browser contexts and can come back empty;
     a fold that fails to save is not worth a message, so every access is
     wrapped and the default — everything open — is the safe one. */
  const FOLD_KEY = 'pt-backlog-fold';
  let folded = new Set();

  function loadFold(teamId) {
    folded = new Set();
    try {
      const all = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}');
      if (Array.isArray(all[teamId])) folded = new Set(all[teamId].map(String));
    } catch { /* everything open */ }
  }

  function saveFold(teamId) {
    try {
      const all = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}');
      all[teamId] = [...folded];
      localStorage.setItem(FOLD_KEY, JSON.stringify(all));
    } catch { /* not worth a message */ }
  }

  async function render(state, mount) {
    data = await UI.api(`/api/backlog/health?team=${encodeURIComponent(state.teamId)}`);
    const d = data;
    // A fresh payload is a fresh queue — page 7 of Titan's backlog means
    // nothing once the team picker has moved to Ruby's 77 items.
    page = 1;
    loadFold(state.teamId);

    /* NOTHING AT ALL means nothing queued AND no sprint holding anything.
       Malphite's queue is empty and its sprints are not, and a board that
       said "nothing here" over two full sprints would be simply wrong. */
    if (!d.total && !(d.sections || []).some(s => s.count)) {
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
            <!-- WHAT A BACKLOG ITEM IS, said once, where the number is. An
                 epic is the container work hangs off and is never pulled
                 into a sprint — counting them made this queue read 1,857
                 when it held 574, and the runway with it. The line only
                 appears when there were some, and it names the figure the
                 page would otherwise be quietly disagreeing with. -->
            ${d.epicsExcluded ? `<li class="muted">${UI.int(d.epicsExcluded)} epics on this board are not counted — an epic is
              the container its stories hang off, never a thing you pull into a sprint. The board holds
              ${UI.int(d.scanned)} records in all.</li>` : ''}
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
          <h2>Sprints and backlog</h2>
          <div class="spacer"></div>
          <a class="btn ghost sm" href="/api/export?what=backlog&team=${encodeURIComponent(state.teamId)}">Export CSV</a>
        </div>
        <div class="filters">
          <label class="field"><span>Search</span><input type="text" id="blSearch" placeholder="key or summary" value="${UI.esc(filters.q)}" style="width:220px"></label>
          <label class="field"><span>Component</span><select id="blComponent"><option value="">All</option>${d.byComponent.map(c => `<option${filters.component === c.key ? ' selected' : ''}>${UI.esc(c.key)}</option>`).join('')}</select></label>
          <!-- WHO IT IS ON. Built from the items actually in this backlog, not
               from the team roster: a queue routinely carries work assigned to
               somebody who left, and a filter that cannot select them cannot
               find it. The unassigned pile gets its own option because it is
               the one most people are looking for. -->
          <label class="field"><span>Assignee</span><select id="blAssignee">
            <option value="">All</option>
            ${assigneeOptions(d).map(a => `<option value="${UI.esc(a.value)}"${filters.assignee === a.value ? ' selected' : ''}>${UI.esc(a.label)}</option>`).join('')}
          </select></label>
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

  /* EVERY ASSIGNEE ON THE BOARD, with a count, most work first. Counted so
     the picker says how much each person is carrying before you choose — the
     question you are usually asking when you open it.

     THE WHOLE BOARD, not just the queue, because the filter now applies to
     the whole board: an option that could select nothing in the sprints
     would make a person appear to have no committed work. */
  function assigneeOptions(d) {
    const by = new Map();
    for (const i of everyRow(d)) {
      const who = i.assignee || UNASSIGNED;
      by.set(who, (by.get(who) || 0) + 1);
    }
    return [...by.entries()]
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .map(([who, n]) => ({ value: who, label: `${who} (${n})` }));
  }

  /* ── THE SPRINT CELL ──────────────────────────────────────────────────
     A select rather than a drag target, for now. Moving one row is what this
     page is for and a select does it in one click from the keyboard as well
     as the mouse; the Jira-style drag between sprint sections is the bigger
     change and it will write through exactly this route.

     THE OPTIONS ARE THE TEAM'S OPEN SPRINTS, sent with the page — 594 rows
     asking for the same six sprints would be a stampede, not a feature.
     Backlog is the first option and a real destination: it is how a mistaken
     move is undone.

     `data-was` CARRIES THE SPRINT NAME the screen showed, which the server
     compares against Jira before writing. The local copy is only as fresh as
     the last sync, and a blind write would silently discard somebody else's
     move. */
  function sprintCell(d, i, ro) {
    const open = (d.sprints || []);
    const now = currentSprintName(i);
    if (ro || !open.length) return `<td class="muted">${UI.esc(now || '—')}</td>`;
    const at = open.find(sp => sp.name === now);
    return `
      <td class="sprint-cell">
        <select class="sprint-pick" data-sprint-key="${UI.esc(i.key)}" data-was="${UI.esc(now || '')}">
          <option value=""${at ? '' : ' selected'}>Backlog</option>
          ${open.map(sp => `<option value="${UI.esc(sp.id)}"${at && at.id === sp.id ? ' selected' : ''}>${UI.esc(sp.name)}${sp.state === 'active' ? ' (active)' : ''}</option>`).join('')}
        </select>
        ${now && !at ? `<span class="tag warn" title="This sprint is closed, or is not one of this team's — it cannot be picked here">${UI.esc(now)}</span>` : ''}
      </td>`;
  }

  /* WHERE IT IS NOW: the last OPEN sprint. An issue carries every sprint it
     has ever been in, so a ticket that slipped twice lists three — the closed
     ones are history, not where it is. */
  function currentSprintName(i) {
    const all = (i.sprints || []).filter(Boolean);
    const open = all.filter(s => String(s.state || '').toLowerCase() !== 'closed');
    if (open.length) return open[open.length - 1].name || null;
    /* NO FALLBACK ONCE STATES ARE KNOWN. An item whose only sprints are
       CLOSED is in none — that is history, not where it is — and the server
       agrees: its read of Jira filters out closed sprints too, so a `was` of
       "Ruby Sprint 39" here would be compared against null there and refuse
       every move on any ticket that has ever slipped.

       The name fallback below is only for a snapshot old enough to carry
       sprint names with no states at all, where "closed" is unknowable and
       the last name is the best available answer. */
    if (all.length) return null;
    const names = i.sprintNames || [];
    return names.length ? names[names.length - 1] : null;
  }

  /** Every row on the board, sprints and queue alike, in no particular order. */
  function everyRow(d) {
    const out = [...(d.items || [])];
    for (const sec of d.sections || []) out.push(...(sec.items || []));
    return out;
  }

  /** The queue's blocked keys, as a set. Recomputed — the list shrinks on a move. */
  const blockedSet = () => new Set(((data.blocked && data.blocked.items) || []).map(i => i.key));

  /* ── ONE PREDICATE, EVERY SECTION ─────────────────────────────────────
     The filters used to narrow a single table and could be part of it; now
     there are as many tables as there are open sprints, and a filter that
     applied to only one of them would be a trap — typing a name in the
     search box and seeing the sprints unchanged reads as "this person has
     nothing queued", which is the opposite of what it would mean.

     So: the filter bar narrows the whole board, and every head says how
     many of its own rows survived. Written once here for the same reason
     `isBacklogItem` is its own module — three readers, one definition.

     BLOCKED IS A QUEUE PROPERTY. The blocked list the server sends is of
     backlog items, so the Blocked chip empties the sprint sections. That is
     honest rather than wrong: nothing has been computed about a committed
     item's blockers, and showing rows there would imply it had. */
  function matches(i, blockedKeys) {
    const q = filters.q.toLowerCase();
    if (filters.category && i.category !== filters.category) return false;
    if (filters.component && !(i.components || []).includes(filters.component)) return false;
    if (filters.assignee) {
      const who = i.assignee || UNASSIGNED;
      if (who !== filters.assignee) return false;
    }
    if (q && !`${i.key} ${i.summary}`.toLowerCase().includes(q)) return false;
    switch (filters.state) {
      case 'ready': return i.points != null && !blockedKeys.has(i.key);
      case 'unestimated': return i.points == null;
      case 'blocked': return blockedKeys.has(i.key);
      case 'unassigned': return !i.assignee;
      default: return true;
    }
  }

  /* BIGGEST FIRST, then by key. Points descending is the order you read a
     queue in when you are choosing what fits; the key is only a tie-break so
     that two draws of the same set cannot differ. */
  const byWeight = (a, b) => (b.points || 0) - (a.points || 0) || String(a.key).localeCompare(b.key);

  function filtered() {
    const bk = blockedSet();
    return (data.items || []).filter(i => matches(i, bk)).sort(byWeight);
  }

  /** The rows of one sprint section that survive the filters. */
  function secRows(sec) {
    const bk = blockedSet();
    return (sec.items || []).filter(i => matches(i, bk)).sort(byWeight);
  }

  /** Nothing typed, nothing chipped — the board is showing everything. */
  const unfiltered = () => !filters.q && !filters.component && !filters.state && !filters.category && !filters.assignee;
  const filtersOn = () => !unfiltered();

  const sumPoints = (rows) => rows.reduce((t, i) => t + (i.points || 0), 0);

  /* HOW MANY, AND OF HOW MANY. A head that silently reported only the
     filtered number would make the page disagree with the sidebar the moment
     anybody typed in the search box — so the whole is always there too. */
  const countMeta = (shown, all) => (shown.length < all.length
    ? `${shown.length} of ${all.length} items · ${UI.num(sumPoints(shown))} pts`
    : `${all.length} items · ${UI.num(sumPoints(shown))} pts`);

  /**
   * THE WAY OUT TO JIRA, and which of two it should be.
   *
   * A key list is exact but finite: it runs out of URL, and his 892-item
   * backlog opened 393 of them. Two things name the set instead of listing
   * it, and both can only mean the WHOLE backlog — neither a saved filter
   * nor a board view can be narrowed by a search box or a category chip
   * that exists only in this app.
   *
   * So the choice follows the filters, and each link means exactly what the
   * count beside it says:
   *
   *   unfiltered, filter known → a JQL SEARCH on the board's saved filter.
   *                              Opens all of them in the issue navigator,
   *                              which is where you can sort, export and
   *                              bulk-edit — the reason to prefer it.
   *   unfiltered, no filter yet → the board's own backlog view. Same set,
   *                              read-only-ish, and available before the
   *                              next sync has read a filter id.
   *   filtered, or neither      → the keys, the only exact answer for a
   *                              subset, truncation notice and all.
   *
   * The one thing that must not happen is a link that silently means a
   * different set from the number it sits next to.
   */
  function jiraLink(items) {
    if (!unfiltered()) return UI.openInJira(items.map(i => i.key));
    const search = UI.backlogSearchUrl(data.boardFilter);
    const href = search || UI.boardBacklogUrl(data.boardId);
    if (!href) return UI.openInJira(items.map(i => i.key));
    const where = search ? 'as a Jira filter' : "on the team's Jira board";
    return `<a class="btn ghost sm" href="${UI.esc(href)}" target="_blank" rel="noopener"
      title="Open the whole backlog — all ${UI.int(items.length)} items — ${where}">Open in Jira</a>`;
  }

  /* ── THE SECTION SHELL ────────────────────────────────────────────────
     One shape for a sprint and for the queue, because they are the same
     thing at different stages and the page is a comparison between them:
     a head that says what it holds, and rows you can drag out of.

     THE WRAPPER STAYS IN THE DOM WHEN IT IS SHUT — only the body goes. That
     is what makes a collapsed sprint a drop target, which it has to be: the
     reason you fold sprint 44 away is that you are filling 41, and the
     reason you fold ALL of them is that you are filling one from the queue.
     A fold that also removed the target would make the tidy view the one you
     cannot work in. */
  function section({ id, kind, title, tag = '', meta = '', right = '', body }) {
    const shut = folded.has(String(id));
    return `
      <section class="bl-sec${shut ? ' shut' : ''}" data-sec="${UI.esc(id)}" data-kind="${kind}">
        <div class="bl-sec-head">
          <button class="bl-fold" data-fold="${UI.esc(id)}" aria-expanded="${shut ? 'false' : 'true'}"
            title="${shut ? 'Show these rows' : 'Hide these rows'}">${shut ? '▸' : '▾'}</button>
          <h3>${UI.esc(title)}</h3>
          ${tag}
          <span class="bl-meta">${meta}</span>
          <span class="spacer"></span>
          ${right}
        </div>
        ${shut ? '' : `<div class="bl-sec-body">${body}</div>`}
      </section>`;
  }

  /* ONE OPEN SPRINT. Rendered WHOLE — no pager. A sprint holds tens of items
     and a pager on it would be furniture; the queue holds 594 and a pager on
     it is the only way to read the far end. */
  function sprintSection(state, sec) {
    const rows = secRows(sec);
    const all = sec.items || [];
    const when = [sec.start, sec.end].filter(Boolean).map(UI.date).join(' → ');
    return section({
      id: sec.id,
      kind: 'sprint',
      title: sec.name,
      tag: `${sec.state === 'active' ? '<span class="tag ok">active</span>' : '<span class="tag">future</span>'}${when ? `<span class="muted" style="font-size:11px">${UI.esc(when)}</span>` : ''}`,
      /* DONE IS PART OF THE HEAD, not a separate column. "18 items · 34 pts ·
         6 done" is the sentence you need to decide whether one more fits. */
      meta: `${countMeta(rows, all)}${sec.done ? ` · ${sec.done} done` : ''}${sec.epicsExcluded ? ` · <span class="muted" title="Epics are containers, never pulled into a sprint">${sec.epicsExcluded} epics not counted</span>` : ''}`,
      right: rows.length ? UI.openInJira(rows.map(i => i.key)) : '',
      body: rows.length
        ? rowsTable(state, data, rows, blockedSet())
        : `<div class="empty">${all.length ? 'Nothing here matches these filters.' : 'Nothing planned yet — drag rows from the backlog.'}</div>`,
    });
  }

  /* THE ROWS. Extracted so a sprint section and the queue cannot drift into
     showing different columns for the same item — the whole point of putting
     them on one screen is that they are comparable.

     EVERY ROW IS DRAGGABLE and every row still has its Sprint select. The
     drag is the shortcut and the select is the keyboard path; they write
     through the same route, so neither can do something the other cannot
     undo. */
  function rowsTable(state, d, rows, blockedKeys) {
    return `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Key</th><th>Summary</th><th>Sprint</th><th>Category</th><th>State</th><th>Component</th><th>Priority</th><th class="num">Points</th><th>Assignee</th></tr></thead>
          <tbody>
            ${rows.map(i => `
              <tr draggable="true" data-row-key="${UI.esc(i.key)}">
                <td>${UI.issueKey(i.key)}</td>
                <td class="wrap">${UI.esc(i.summary)}</td>
                ${sprintCell(d, i, false)}
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
      </div>`;
  }

  function renderTable(state, mount) {
    const d = data;
    const items = filtered();
    const blockedKeys = blockedSet();
    /* The page is CLAMPED rather than trusted — see `UI.paginate`. Filters
       can shrink the set under a page number that was valid a keystroke ago,
       and `p.page` is the one actually used, so the pager and the rows below
       it cannot disagree. */
    const p = UI.paginate(items, page, pageSize);
    page = p.page;
    /* ── THE BOARD ────────────────────────────────────────────────────
       Open sprints above, the queue below — the shape Jira's backlog screen
       has, and for the same reason: choosing what goes into a sprint is a
       comparison between what is committed and what is waiting, and a page
       showing only the waiting half makes you hold the other in your head.

       OPEN SPRINTS ONLY, oldest first. A closed sprint is history and a
       section you cannot drag into is furniture; the picker in every row
       offers exactly these same sprints, so a section always exists for
       every destination and a drag always has somewhere to land.

       OPEN IN JIRA SITS ON THE COUNT LINE, NOT IN THE PAGE HEAD. Each head
       is redrawn on every filter change, so its link always opens the set
       the number beside it describes; the page head holds Export CSV, which
       exports the WHOLE backlog whatever the filters say — a filtered link
       up there would read as the same scope and quietly be a different one.

       It opens what the COUNT says, not the rows on THIS PAGE: paging is
       about what a screen can usefully show, and Jira has no such problem —
       a link that opened only the hundred rows you happened to be looking at
       would change meaning every time you pressed Next. */
    UI.$('#blTable', mount).innerHTML = `
      ${(d.sections || []).map(sec => sprintSection(state, sec)).join('')}
      ${section({
    id: 'backlog',
    kind: 'backlog',
    title: 'Backlog',
    meta: countMeta(items, data.items || []),
    right: jiraLink(items),
    body: items.length
      ? `${rowsTable(state, d, p.rows, blockedKeys)}${UI.pager({ ...p, pageSize, sizeId: 'blPageSize', unit: 'items' })}`
      : `<div class="empty">${(data.items || []).length ? 'Nothing in the queue matches these filters.' : 'The queue is empty — everything is in a sprint.'}</div>`,
  })}`;

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
  /**
   * Move one item to a sprint, and put the control back if Jira refuses.
   *
   * THE ROW LEAVES THE BACKLOG when the move succeeds. That is not a
   * cosmetic choice: this page is "what is not yet committed to a sprint", so
   * an item that now has one does not belong on it, and leaving it there
   * would make the count on this screen disagree with the sidebar and with
   * Jira. It is removed locally rather than by refetching, so the position in
   * a long filtered list survives.
   *
   * THE SELECT IS DISABLED WHILE IT SAVES. A second change mid-flight would
   * send a `was` that the first request is in the middle of invalidating, and
   * the conflict message would blame whoever moved it last.
   */
  async function saveSprint(state, mount, pick) {
    const key = pick.dataset.sprintKey;
    const was = pick.dataset.was == null ? '' : pick.dataset.was;
    pick.disabled = true;
    try {
      await move(state, mount, {
        key,
        to: pick.value || null,
        was,
        // Back to what it was showing: a select left on the value the server
        // refused looks exactly like one that saved.
        restore: () => {
          const at = (data.sprints || []).find(sp => sp.name === was);
          pick.value = at ? at.id : '';
        },
      });
    } finally {
      pick.disabled = false;
    }
  }

  /**
   * WHERE A ROW IS NOW — the queue, or one of the sprint sections.
   *
   * Asked rather than remembered. The row that was dragged is identified by
   * its key alone, and a key is the only thing on the board that cannot go
   * stale: a section index would be wrong the moment a filter redrew, and
   * the node itself is gone by the time the request comes back.
   */
  function locate(key) {
    const inQueue = (data.items || []).find(i => i.key === key);
    if (inQueue) return { id: 'backlog', list: data.items, item: inQueue };
    for (const sec of data.sections || []) {
      const hit = (sec.items || []).find(i => i.key === key);
      if (hit) return { id: String(sec.id), list: sec.items, sec, item: hit };
    }
    return null;
  }

  /**
   * MOVE THE ROW LOCALLY, once Jira has agreed.
   *
   * Moved rather than refetched: the board is up to 600 rows and a refetch
   * would cost a round trip, lose the page you were on and throw away the
   * fold state — for a change this screen already knows the whole of.
   *
   * THE ITEM'S OWN SPRINT LIST IS REWRITTEN, not just its position in the
   * lists. The Sprint select and every `data-was` on the next draw are
   * computed from `i.sprints`, so leaving the old value there would make the
   * very next move send a `was` this one has just superseded — and the
   * server, comparing it against Jira, would refuse it. Closed sprints are
   * kept: where it has been is still true.
   */
  function apply(key, to) {
    const at = locate(key);
    if (!at) return;
    at.list.splice(at.list.indexOf(at.item), 1);
    const i = at.item;
    const history = (i.sprints || []).filter(s => String(s.state || '').toLowerCase() === 'closed');
    const sec = to ? (data.sections || []).find(s => String(s.id) === String(to)) : null;
    /* NO `id` ON THE ENTRY WE ADD. Everywhere else `i.sprints[].id` is
       Jira's own sprint id; the section carries the plan's. Only `name` and
       `state` are ever read here, so writing a plan id under a Jira field
       name would be a lie with no reader — and the next one to appear would
       inherit it. */
    i.sprints = sec ? [...history, { name: sec.name, state: sec.state }] : history;
    if (sec) (sec.items = sec.items || []).push(i);
    else (data.items = data.items || []).push(i);

    // The blocked list is the QUEUE's, so a row that left the queue leaves
    // it too, or the "blocked" tag outlives the row it described.
    if (data.blocked) data.blocked.items = (data.blocked.items || []).filter(x => x.key !== key);
    data.total = (data.items || []).length;
  }

  /**
   * Move one item, and put the screen back if Jira refuses.
   *
   * ONE FUNCTION FOR THE SELECT AND THE DRAG, because they are the same
   * edit: the drag is a shortcut for choosing an option, not a second way of
   * writing to Jira. A second path would be a second place for the
   * read-before-write `was` to be got wrong, and that failure is silent —
   * it does not look like an error, it looks like somebody else's move
   * vanishing.
   */
  async function move(state, mount, { key, to, was, restore = null }) {
    try {
      const r = await UI.jsonPut('/api/backlog/sprint', {
        key, teamId: state.teamId, sprintId: to, was: was || null,
      });
      if (r && r.unchanged) { UI.toast(`${key} — already there`); return; }
      apply(key, to);
      renderTable(state, mount);
      UI.toast(to ? `${key} — moved to ${r.sprint || 'the sprint'}` : `${key} — back to the backlog`);
    } catch (err) {
      if (restore) restore();
      UI.toast(err.message, true);
    }
  }

  /* ── DRAGGING A ROW INTO A SECTION ────────────────────────────────────
     The KEY is held, not the node: the table is rebuilt on every filter
     keystroke and every page turn, so by the time a drop is handled the
     element that started the drag may not be on the page.

     THE DROP TARGET IS THE SECTION, not a position within it. Order inside
     a sprint is Jira's rank, which this tool does not store and cannot
     write — offering an insertion point would be a gesture that appears to
     do something and does not. The rows sort by points, as they do
     everywhere on this screen.

     A DROP BACK WHERE IT STARTED IS NOTHING. Not an error and not a request:
     the server would answer `unchanged` and the toast would report a move
     that nobody made. */
  let dragKey = null;

  function clearDrag(mount) {
    UI.$$('.bl-dragging', mount).forEach(n => n.classList.remove('bl-dragging'));
    UI.$$('.bl-over', mount).forEach(n => n.classList.remove('bl-over'));
  }

  function wireDrag(state, mount) {
    mount.addEventListener('dragstart', (e) => {
      const tr = e.target.closest && e.target.closest('[data-row-key]');
      if (!tr) return;
      dragKey = tr.dataset.rowKey;
      tr.classList.add('bl-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', dragKey); } catch { /* some browsers refuse; the key is held above */ }
      }
    });

    mount.addEventListener('dragend', () => { dragKey = null; clearDrag(mount); });

    mount.addEventListener('dragover', (e) => {
      const sec = dragKey && e.target.closest && e.target.closest('[data-sec]');
      if (!sec) return;
      // WITHOUT THIS THERE IS NO DROP. preventDefault on dragover is what
      // marks an element as a destination; the default is to refuse.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      UI.$$('.bl-over', mount).forEach(n => { if (n !== sec) n.classList.remove('bl-over'); });
      sec.classList.add('bl-over');
    });

    mount.addEventListener('drop', (e) => {
      const sec = dragKey && e.target.closest && e.target.closest('[data-sec]');
      if (!sec) return;
      e.preventDefault();
      const key = dragKey;
      dragKey = null;
      clearDrag(mount);
      const to = sec.dataset.sec;
      const at = locate(key);
      if (!at || at.id === to) return undefined;
      return move(state, mount, {
        key,
        to: to === 'backlog' ? null : to,
        was: currentSprintName(at.item),
      });
    });
  }

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
    /* ── MOVING A ROW INTO A SPRINT ───────────────────────────────────
       DELEGATED to the mount, not attached to the selects: the table is
       rebuilt on every filter keystroke and every page turn, so a handler on
       the control would go with the markup that replaced it and the second
       move on a page would do nothing.

       The change is returned so a caller that can await it observes the save
       rather than the moment before it — the same reason the note box on the
       Capacity sheet returns its promise. */
    mount.addEventListener('change', (e) => {
      const pick = e.target.closest && e.target.closest('[data-sprint-key]');
      return pick ? saveSprint(state, mount, pick) : undefined;
    });

    /* ── FOLDING A SECTION ────────────────────────────────────────────
       Delegated for the same reason, and SAVED on every toggle rather than
       on leaving the page: there is no leaving event worth trusting, and
       the cost of writing four ids to localStorage is nothing. */
    mount.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('[data-fold]');
      if (!btn) return;
      const id = String(btn.dataset.fold);
      if (folded.has(id)) folded.delete(id); else folded.add(id);
      saveFold(state.teamId);
      renderTable(state, mount);
    });

    wireDrag(state, mount);

    UI.$('#blSearch', mount).addEventListener('input', e => { filters.q = e.target.value; refilter(state, mount); });
    UI.$('#blComponent', mount).addEventListener('change', e => { filters.component = e.target.value || null; refilter(state, mount); });
    UI.$('#blAssignee', mount).addEventListener('change', e => { filters.assignee = e.target.value || null; refilter(state, mount); });
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
