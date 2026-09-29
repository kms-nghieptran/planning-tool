/* Blockers — what is already stuck, and who has to be chased about it.

   The Risks page asks "what might go wrong". This asks a harder, more useful
   question: what is stuck RIGHT NOW, and on whom. Two halves, because the
   data comes in two kinds — what Jira records, and what only he knows. */

const BlockersView = (() => {
  /* SPRINT IS A FILTER, NOT THE SCOPE. Risks is sprint-scoped because a risk
     is about a commitment; a blocker outlives the sprint it was noticed in,
     and 496 of the 543 blocked items on this board are nowhere near one. So
     the page opens on the whole board and narrows on request. */
  let thisSprint = false;
  let showResolved = false;
  let data = null;

  async function render(state, mount) {
    const sprint = thisSprint ? `&sprint=${encodeURIComponent(state.sprintId)}` : '';
    data = await UI.api(`/api/blockers?team=${encodeURIComponent(state.teamId)}${sprint}`);
    const d = data;
    const c = d.counts;

    mount.innerHTML = `
      <section class="section">
        <div class="kpis">
          ${UI.kpi({
    label: 'Blocked items', value: UI.int(c.items), unit: 'items',
    foot: `${UI.num(c.points)} pts held up in ${d.scope.label}`,
    tone: c.items ? 'risk' : 'ok', featured: true,
  })}
          ${UI.kpi({
    label: 'Tickets to chase', value: UI.int(c.tickets),
    foot: c.tickets ? `holding ${c.explained} of them between them` : 'Nothing is named as a blocker',
    tone: c.tickets ? 'warn' : '',
  })}
          ${UI.kpi({
    label: 'No reason recorded', value: UI.int(c.unrecorded),
    /* THE HEADLINE NUMBER ON HIS DATA — 496 of 543. A page that only
       showed the tickets would report this board as nearly healthy. */
    foot: c.unrecorded ? `${UI.pct(c.items ? c.unrecorded / c.items * 100 : 0)} of blocked work · ${d.unrecorded.claimed} explained by hand` : 'Every blocked item names something',
    tone: c.unrecorded ? 'warn' : 'ok',
  })}
          ${UI.kpi({ label: 'Register', value: UI.int(c.registered), foot: 'Open blockers you recorded' })}
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <h2>Detected blockers</h2>
          <span class="muted">From Jira's "is blocked by" links, read off the epic behind each item</span>
          <div class="spacer"></div>
          <button class="chip${thisSprint ? ' active' : ''}" id="blkSprint"
            title="${thisSprint ? `Showing this sprint only — the whole board has ${d.scope.teamTotal} blocked items` : 'Narrow to the selected sprint'}">This sprint only</button>
          <a class="btn ghost sm" href="/api/export?what=blockers&team=${encodeURIComponent(state.teamId)}">Export CSV</a>
        </div>
        ${d.detected.length || d.unrecorded.count
    ? `<div class="grid-2">${d.detected.map(ticketCard).join('')}${d.unrecorded.count ? unrecordedCard(d) : ''}</div>`
    : `<div class="card"><div class="empty">Nothing is in Refinement ${d.scope.label === 'this sprint' ? 'in this sprint' : 'on this board'}. That is a real result, not an empty state — the check ran over ${UI.int(d.scope.teamTotal)} items.</div></div>`}
      </section>

      <section class="section">
        <div class="section-head">
          <h2>Blocker register</h2>
          <span class="muted">What Jira cannot see: an environment down, a client decision, somebody on leave</span>
          <div class="spacer"></div>
          ${d.manual.some(b => b.status === 'Resolved') ? `<button class="chip${showResolved ? ' active' : ''}" id="blkResolved">Show resolved</button>` : ''}
          <button class="btn sm" id="addBlocker">Register a blocker</button>
        </div>
        ${manualList(d)}
      </section>
    `;

    wire(state, mount);
  }

  /* ── ONE TICKET, AND EVERYTHING WAITING BEHIND IT ─────────────────────
     Grouped by the blocker rather than by the blocked, which is the whole
     point of the page: 543 rows of stuck work is a list nobody reads twice,
     while "CLICMNTIGO-11567 is holding 15 items" is one phone call. */
  function ticketCard(g) {
    return `
      <div class="risk-card ${g.severity} blk">
        <div class="meta">
          <span class="tag ${g.severity === 'high' ? 'risk' : g.severity === 'medium' ? 'warn' : ''}">${g.severity}</span>
          ${g.status ? `<span class="tag">${UI.esc(g.status)}</span>` : ''}
          ${/* SAY WHEN WE CANNOT SEE IT. Every blocker in his store lives in a
                project this tool does not sync; a blank status beside the key
                would read as "no status set", which is a different fact. */''}
          ${g.local ? '' : '<span class="tag warn" title="This project is not synced by this tool, so only what Jira sent inside the link is known about it">not synced</span>'}
          <span class="spacer"></span>
          <span class="muted" style="font-size:11.5px">via ${UI.esc(g.via.join(', '))}</span>
        </div>
        <div class="title">${UI.issueKey(g.key)} ${g.summary ? UI.esc(g.summary) : '<span class="muted">no summary available</span>'}</div>
        <div class="detail">
          Holding ${UI.drillNumber(g.count, { act: 'blk-items', key: g.key })} ${g.count === 1 ? 'item' : 'items'}${g.points ? ` · ${UI.num(g.points)} pts` : ''},
          all of them sitting in Refinement until it moves.
        </div>
        <div style="margin-top:10px;display:flex;gap:8px">
          <button class="btn ghost sm" data-register='${UI.esc(JSON.stringify({
    title: `${g.key}${g.summary ? ` — ${g.summary}` : ''}`,
    blockerKey: g.key,
    severity: g.severity,
    category: 'Dependency',
    detail: `Blocking ${g.count} ${g.count === 1 ? 'item' : 'items'} via ${g.via.join(', ')}.`,
    items: g.items,
  }))}'>Take it on</button>
        </div>
      </div>`;
  }

  /* THE PILE WITH NO EXPLANATION — the biggest card on his board, and the
     one the register exists to shrink. It is not an error state: an item can
     be in Refinement for a reason nobody has written down anywhere, which is
     exactly the thing a lead knows and Jira does not. */
  function unrecordedCard(d) {
    const u = d.unrecorded;
    const left = u.count - u.claimed;
    return `
      <div class="risk-card ${left ? 'high' : 'low'} blk">
        <div class="meta">
          <span class="tag ${left ? 'risk' : 'ok'}">${left ? 'unexplained' : 'all explained'}</span>
          <span class="spacer"></span>
          <span class="muted" style="font-size:11.5px">nothing on the epic</span>
        </div>
        <div class="title">In Refinement with no blocker named</div>
        <div class="detail">
          ${UI.drillNumber(u.count, { act: 'blk-unrecorded' })} ${u.count === 1 ? 'item is' : 'items are'} waiting${u.points ? ` (${UI.num(u.points)} pts)` : ''}
          and neither they nor their epics say what for.
          ${u.claimed ? `${u.claimed} of them ${u.claimed === 1 ? 'has' : 'have'} a blocker you registered by hand.` : ''}
        </div>
        <div class="action">${left
    ? `Register what is holding ${left === u.count ? 'them' : `the other ${left}`} — or refine them, if nothing is.`
    : 'Every one of them is accounted for in the register below.'}</div>
        <div style="margin-top:10px;display:flex;gap:8px">
          <button class="btn ghost sm" data-register='${UI.esc(JSON.stringify({ category: 'Refinement', severity: 'medium' }))}'>Register a blocker</button>
        </div>
      </div>`;
  }

  function manualList(d) {
    const rows = showResolved ? d.manual : d.manual.filter(b => b.status !== 'Resolved');
    if (!rows.length) {
      return `<div class="card"><div class="empty">${d.manual.length
        ? 'Every registered blocker is resolved.'
        : 'Nothing registered yet. This is where a blocker that Jira has no field for goes — and where the items waiting on it get linked to it.'}</div></div>`;
    }
    return `<div class="grid-2">${rows.map(manualCard).join('')}</div>`;
  }

  function manualCard(b) {
    const n = (b.items || []).length;
    const done = b.status === 'Resolved';
    return `
      <div class="risk-card ${done ? 'low' : (b.severity || 'medium')} blk${done ? ' done' : ''}">
        <div class="meta">
          <span class="tag ${done ? 'ok' : b.severity === 'high' ? 'risk' : b.severity === 'medium' ? 'warn' : ''}">${done ? 'resolved' : UI.esc(b.severity || 'medium')}</span>
          ${b.category ? `<span class="tag">${UI.esc(b.category)}</span>` : ''}
          ${b.blockerKey ? UI.issueKey(b.blockerKey) : ''}
          <span class="spacer"></span>
          ${b.owner ? `<span class="muted" style="font-size:11.5px">${UI.esc(b.owner)}</span>` : ''}
        </div>
        <div class="title">${UI.esc(b.title)}</div>
        ${b.detail ? `<div class="detail">${UI.esc(b.detail)}</div>` : ''}
        ${/* THE LINKED ITEMS ARE A NUMBER YOU CAN OPEN, like every other count
              in this tool — the keys travel with it, so the drawer lists
              exactly what was counted rather than walking anything again. */''}
        ${n ? `<div class="detail">Linked to ${UI.drillNumber(n, { act: 'blk-manual', key: b.id })} ${n === 1 ? 'item' : 'items'}</div>`
    : '<div class="detail muted">Not linked to any item yet</div>'}
        ${b.action ? `<div class="action">${UI.esc(b.action)}</div>` : ''}
        <div style="margin-top:10px;display:flex;gap:8px">
          <button class="btn ghost sm" data-edit="${UI.esc(b.id)}">Edit</button>
          <button class="btn ghost sm" data-resolve="${UI.esc(b.id)}">${done ? 'Reopen' : 'Resolve'}</button>
          <button class="btn ghost sm" data-delete="${UI.esc(b.id)}">Delete</button>
        </div>
      </div>`;
  }

  /* ── THE FORM ─────────────────────────────────────────────────────────
     The item picker is the reason this page is not just Risks with a new
     heading: a blocker that names the work waiting on it can be counted, and
     one that does not is a sticky note.

     THE LIST IS THE BLOCKED ITEMS, UNRECORDED ONES FIRST — those are what
     the register exists to explain. A key can also be typed, because the
     most useful moment to record a blocker is BEFORE the item reaches
     Refinement, and a picker that only offered stuck work would refuse it. */
  function form(existing = {}) {
    const chosen = new Set((existing.items || []).map(k => String(k).toUpperCase()));
    const list = data.linkable || [];
    return `
      <div class="eyebrow"><i></i>Blocker register</div>
      <h2 style="margin:6px 0 16px">${existing.id ? 'Edit blocker' : 'Register a blocker'}</h2>
      <div class="setting-row"><label>What is blocking</label><input type="text" id="bTitle" value="${UI.esc(existing.title || '')}" placeholder="Staging is down; waiting on the client's schema"></div>
      <div class="setting-row"><label>Severity</label><select id="bSeverity">${['high', 'medium', 'low'].map(s => `<option value="${s}"${(existing.severity || 'medium') === s ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
      <div class="setting-row"><label>Category</label><input type="text" id="bCategory" value="${UI.esc(existing.category || '')}" placeholder="Dependency, Environment, People, Client…"></div>
      <div class="setting-row"><label>Owner</label><input type="text" id="bOwner" value="${UI.esc(existing.owner || '')}" placeholder="Who is chasing it"></div>
      <div class="setting-row"><label>Jira key <span class="muted">(optional)</span></label><input type="text" id="bKey" value="${UI.esc(existing.blockerKey || '')}" placeholder="CLICMNTIGO-11567"></div>
      <div class="setting-row"><label>Detail</label><textarea id="bDetail" rows="3">${UI.esc(existing.detail || '')}</textarea></div>
      <div class="setting-row"><label>What happens next</label><textarea id="bAction" rows="2" placeholder="Raised with the platform team, expected Thursday">${UI.esc(existing.action || '')}</textarea></div>

      <div class="eyebrow" style="margin-top:20px"><i></i>Items waiting on it</div>
      <div class="muted" style="font-size:12px;margin:4px 0 10px">Optional — a blocker is worth recording before anybody has worked out what it holds.</div>
      <input type="text" id="bSearch" placeholder="Filter by key or summary" style="width:100%;margin-bottom:8px">
      <div id="bPicked" class="blk-picked"></div>
      <div class="setting-row" style="align-items:flex-start">
        <label>Or type a key</label>
        <div style="display:flex;gap:6px;flex:1">
          <input type="text" id="bAddKey" placeholder="AUTOKAT-1234" style="flex:1">
          <button class="btn ghost sm" id="bAdd">Add</button>
        </div>
      </div>
      <div class="blk-pick" id="bList">${pickList(list, chosen, '')}</div>

      <div class="btn-row">
        <button class="btn" id="bSave">Save</button>
        <button class="btn ghost" id="bCancel">Cancel</button>
      </div>`;
  }

  function pickList(list, chosen, q) {
    const term = String(q || '').toLowerCase();
    const rows = list.filter(i => !term || `${i.key} ${i.summary}`.toLowerCase().includes(term));
    if (!rows.length) return `<div class="empty" style="padding:14px">${list.length ? 'Nothing matches that.' : 'Nothing on this board is in Refinement.'}</div>`;
    /* CAPPED, AND IT SAYS SO. 543 checkboxes in a drawer is a scroll nobody
       finishes; the filter above is the way through, and a list that silently
       stopped at 200 would make a key somebody searched for look absent. */
    const cap = 200;
    return `
      ${/* NOT ONE BIG <label>. The key has to be a real link — you check the
            ticket before you claim it is blocking fifteen things — and a link
            inside a label both opens Jira and toggles the box. So the
            checkbox and the key are siblings, and the SUMMARY carries the
            `for=`, which keeps the whole row clickable to tick. */''}
      ${rows.slice(0, cap).map(i => `
        <div class="blk-opt">
          <input type="checkbox" id="pick-${UI.esc(i.key)}" data-pick="${UI.esc(i.key)}"${chosen.has(i.key.toUpperCase()) ? ' checked' : ''}>
          <span class="blk-key">${UI.issueKey(i.key)}</span>
          <label class="blk-sum" for="pick-${UI.esc(i.key)}">${UI.esc(i.summary || '')}</label>
          ${i.recorded ? '<span class="tag" title="Its epic already names a blocker">recorded</span>' : ''}
        </div>`).join('')}
      ${rows.length > cap ? `<div class="muted" style="padding:8px 4px;font-size:11.5px">Showing ${cap} of ${rows.length} — narrow the filter to reach the rest.</div>` : ''}`;
  }

  function wire(state, mount) {
    const sprintBtn = UI.$('#blkSprint', mount);
    if (sprintBtn) sprintBtn.addEventListener('click', () => { thisSprint = !thisSprint; App.refresh(); });
    const res = UI.$('#blkResolved', mount);
    if (res) res.addEventListener('click', () => { showResolved = !showResolved; App.refresh(); });

    /* ── THE DRILL-INS ────────────────────────────────────────────────
       Every count on this page is the size of a set, and "which ones?" is
       the next question every single time. The keys travel with the count,
       so each drawer lists exactly what its number counted. */
    mount.addEventListener('click', (e) => {
      const n = e.target.closest && e.target.closest('[data-act]');
      if (!n) return;
      const act = n.dataset.act;
      if (act === 'blk-items') {
        const g = (data.detected || []).find(x => x.key === n.dataset.key);
        if (g) openItems(state, `Waiting on ${g.key}`,
          `${g.key}${g.summary ? ` — ${g.summary}` : ''} is named as a blocker on ${g.via.length === 1 ? 'the epic' : 'the epics'} ${g.via.join(', ')}. `
          + `${g.count === 1 ? 'This item is' : `These ${g.count} items are`} in Refinement behind it.`, g.items);
      } else if (act === 'blk-unrecorded') {
        openItems(state, 'In Refinement, nothing recorded',
          'These are in Refinement and neither they nor the epics behind them name anything as a blocker. '
          + 'Either something is holding them that nobody has written down, or they are simply waiting to be refined.',
          data.unrecorded.items);
      } else if (act === 'blk-manual') {
        const b = (data.manual || []).find(x => x.id === n.dataset.key);
        if (b) openItems(state, b.title, b.detail || 'Items you linked to this blocker.', b.items || []);
      }
    });

    const openForm = (existing) => {
      UI.drawer(form(existing));
      const chosen = new Set((existing.items || []).map(k => String(k).toUpperCase()));
      const picked = () => [...chosen];

      const paint = () => {
        UI.$('#bPicked').innerHTML = chosen.size
          ? `<div class="muted" style="font-size:11.5px;margin-bottom:6px">${chosen.size} linked</div>`
            + [...chosen].map(k => `<span class="blk-chip">${UI.esc(k)}<button type="button" data-drop="${UI.esc(k)}" aria-label="Unlink ${UI.esc(k)}">×</button></span>`).join('')
          : '<div class="muted" style="font-size:11.5px">Nothing linked yet</div>';
      };
      paint();

      const relist = () => {
        UI.$('#bList').innerHTML = pickList(data.linkable || [], chosen, UI.$('#bSearch').value);
      };

      /* DELEGATED ON THE DRAWER, because the list is rebuilt on every
         keystroke in the filter box — a handler on a checkbox would go with
         the markup that replaced it, and the second pick would do nothing. */
      const root = UI.$('#bList').parentNode;
      root.addEventListener('change', (e) => {
        const box = e.target.closest && e.target.closest('[data-pick]');
        if (!box) return;
        const k = String(box.dataset.pick).toUpperCase();
        if (box.checked) chosen.add(k); else chosen.delete(k);
        paint();
      });
      root.addEventListener('click', (e) => {
        const drop = e.target.closest && e.target.closest('[data-drop]');
        if (!drop) return;
        chosen.delete(String(drop.dataset.drop).toUpperCase());
        paint(); relist();
      });

      UI.$('#bSearch').addEventListener('input', relist);
      UI.$('#bAdd').addEventListener('click', () => {
        const box = UI.$('#bAddKey');
        const k = String(box.value || '').trim().toUpperCase();
        if (!k) return;
        chosen.add(k);
        box.value = '';
        paint(); relist();
      });

      UI.$('#bCancel').addEventListener('click', UI.closeDrawer);
      UI.$('#bSave').addEventListener('click', async () => {
        const body = {
          id: existing && existing.id,
          title: UI.$('#bTitle').value.trim(),
          severity: UI.$('#bSeverity').value,
          category: UI.$('#bCategory').value.trim(),
          owner: UI.$('#bOwner').value.trim(),
          blockerKey: UI.$('#bKey').value.trim(),
          detail: UI.$('#bDetail').value.trim(),
          action: UI.$('#bAction').value.trim(),
          items: picked(),
          status: (existing && existing.status) || 'Open',
          teamId: state.teamId,
          teamName: (state.teams.find(t => t.id === state.teamId) || {}).name || '',
        };
        if (!body.title) return UI.toast('A blocker needs a title — what is holding the work up', true);
        try {
          await UI.api('/api/blocker', { method: existing && existing.id ? 'PUT' : 'POST', body: JSON.stringify(body) });
        } catch (err) {
          // The drawer STAYS OPEN on a refusal — closing it would throw away
          // everything typed over a key with a typo in it.
          return UI.toast(err.message, true);
        }
        UI.closeDrawer(); UI.toast('Blocker registered'); return App.refresh();
      });
    };

    UI.$('#addBlocker', mount).addEventListener('click', () => openForm({}));
    UI.$$('[data-register]', mount).forEach(b => b.addEventListener('click', () => openForm(JSON.parse(b.dataset.register))));
    UI.$$('[data-edit]', mount).forEach(b => b.addEventListener('click', () => openForm(data.manual.find(x => x.id === b.dataset.edit))));
    UI.$$('[data-resolve]', mount).forEach(b => b.addEventListener('click', async () => {
      const x = data.manual.find(y => y.id === b.dataset.resolve);
      await UI.api('/api/blocker', { method: 'PUT', body: JSON.stringify({ ...x, status: x.status === 'Resolved' ? 'Open' : 'Resolved' }) });
      App.refresh();
    }));
    UI.$$('[data-delete]', mount).forEach(b => b.addEventListener('click', async () => {
      const x = data.manual.find(y => y.id === b.dataset.delete);
      if (!confirm(`Delete "${x.title}" from the register? This cannot be undone.`)) return;
      await UI.api('/api/blocker', { method: 'DELETE', body: JSON.stringify({ id: x.id }) });
      UI.toast('Blocker deleted'); App.refresh();
    }));
  }

  /** One drawer shape for all three counts — `drillDrawer` already knows how
      to list a key that is not in the local store, which several of these are. */
  function openItems(state, title, meaning, keys) {
    UI.drawer(UI.drillDrawer({
      title, meaning, keys: keys || [],
      items: [], catalogue: (data.catalogue || {}), state,
    }));
  }

  return { render };
})();
