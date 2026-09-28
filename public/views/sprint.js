/* Active sprint view — is this sprint going to land, and what is in the way. */

const SprintView = (() => {
  /* An unset priority sorts as "nothing here", which `UI.sortable` pins to the
     bottom in BOTH directions — not as 99, which is the largest number in the
     column and floated every unjudged component above the P1s on a descending
     sort. Same constant, same reason, as the Coverage grid that owns the value. */
  const UNSET_SORT = '—';

  async function render(state, mount) {
    const d = await UI.api(`/api/sprint?team=${encodeURIComponent(state.teamId)}&sprint=${encodeURIComponent(state.sprintId)}`);
    const p = d.progress, w = d.window, h = d.health, t = d.totals || {};
    /* A closed sprint is read-only: the Points cells below edit real Jira
       issues and the server refuses a sprint that has finished, so the boxes
       are simply not offered rather than offered and always failing. */
    const ro = !!(d.lock && d.lock.readOnly);

    const byStatus = groupBy(d.items, i => i.status || '—');
    const byMember = d.rows.filter(r => r.status !== 'Released' && (r.planned || r.actual));
    /* Work that landed on nobody ON THE ROSTER is part of the sprint — it is
       already in Committed and in the item table below. Leaving it out of THIS
       table made the per-person column add up to less than the commitment with
       no visible reason why.

       It comes in two kinds and they are NOT the same thing:
         · `offRoster` has an owner with a name who is simply not on this
           sprint's roster. Each of those people gets their own row, named,
           because calling their work "unassigned" was plainly false — it is
           what made a sprint where every item named someone report 53 items
           with no assignee.
         · `unassigned` really has nobody in the Assignee field, and gets the
           one anonymous row it deserves. */
    const off = (d.offRoster && d.offRoster.people) || [];
    const un = d.unassigned || { count: 0, points: 0, done: 0 };
    const left = (p, done) => Math.round((p - done) * 10) / 10;

    /**
     * Capacity against what this sprint actually took on.
     *
     * Measured against `progress.committed`, NOT the grid's `totals.planned`:
     * the commitment on this screen includes work that landed on nobody on the
     * roster, and a Capacity card sitting next to a Committed card has to be
     * arithmetic the reader can do in their head. Taking the grid's own
     * over/under figure would have printed "7 pts of headroom" beside two
     * numbers that differ by more than seven.
     */
    const headroom = (t, p) => {
      if (!t.predicted) return 'no capacity entered';
      const gap = Math.round((t.predicted - p.committed) * 10) / 10;
      return gap < 0
        ? `<span style="color:var(--risk)">${UI.num(Math.abs(gap))} pts over capacity</span>`
        : `${UI.num(gap)} pts of headroom`;
    };

    mount.innerHTML = `
      ${printHeader(d, state)}

      <section class="section print-hide">
        <div class="section-head">
          <div class="spacer"></div>
          <button class="btn ghost sm" data-act="export-pdf"
            title="Opens your browser's print dialogue — choose &quot;Save as PDF&quot;">Export PDF</button>
        </div>
      </section>

      <section class="section">
        <div class="card featured" style="display:flex;gap:26px;align-items:center;flex-wrap:wrap">
          <div>
            <div class="eyebrow"><i></i>Sprint health</div>
            <div style="display:flex;align-items:baseline;gap:12px;margin-top:6px">
              <span style="font-size:44px;font-weight:800;line-height:1">${h.score}</span>
              <span class="rag ${h.rag}"><span class="dot"></span>${h.rag === 'green' ? 'On track' : h.rag === 'amber' ? 'At risk' : 'Off track'}</span>
            </div>
          </div>
          <div style="flex:1;min-width:280px">
            <ul class="reasons">${h.reasons.map(r => `<li class="${r.level}">${UI.esc(r.text)}</li>`).join('')}</ul>
          </div>
        </div>
      </section>

      <section class="section">
        ${/* ACCENTED: one hue per measure, status on the card's edge. Six cards
             whose colour meant only "good or bad" came out as four cards in
             two colours — Committed and Projected landing both pink, Done and
             Sprint elapsed both black — so the strip said nothing about WHICH
             number you were looking at. `styles.css` carries the palette and
             the argument; the tones below are unchanged and now draw the
             edge rather than the number. */ ''}
        <div class="kpis accented">
          ${UI.kpi({ label: 'Capacity', accent: 'capacity', value: UI.int(t.predicted), unit: 'pts', foot: `${UI.num(t.capacityHours)} h across ${t.headcount} ${t.headcount === 1 ? 'person' : 'people'}` })}
          ${UI.kpi({ label: 'Committed', accent: 'committed', value: UI.drillNumber(p.committed, { act: 'drill', scope: '__sprint', col: 'committed' }, { zero: UI.int(p.committed) }), unit: 'pts', foot: `${UI.drillNumber(d.items.length, { act: 'drill', scope: '__sprint', col: 'items' })} items · ${headroom(t, p)}`, tone: t.predicted && p.committed > t.predicted ? 'risk' : '' })}
          ${UI.kpi({ label: 'Done', accent: 'done', value: UI.int(p.done), unit: 'pts', foot: `${p.donePct}% of commitment`, tone: p.donePct >= w.timeElapsedPct ? 'ok' : '' })}
          ${UI.kpi({ label: 'Sprint elapsed', accent: 'elapsed', value: `${w.timeElapsedPct}`, unit: '%', foot: `Day ${w.elapsed} of ${w.workingDays} working days` })}
          ${UI.kpi({ label: 'Projected landing', accent: 'projected', value: p.projected == null ? '—' : UI.int(p.projected), unit: 'pts', foot: p.projectedVsCommitted == null ? 'Not enough of the sprint elapsed' : (p.projectedVsCommitted >= 0 ? `${UI.num(p.projectedVsCommitted)} pts above commitment` : `${UI.num(Math.abs(p.projectedVsCommitted))} pts short`), tone: p.projectedVsCommitted == null ? '' : p.projectedVsCommitted < -2 ? 'risk' : 'ok' })}
          ${UI.kpi({ label: 'Blocked', accent: 'blocked', value: UI.drillNumber(p.blocked.count, { act: 'blocked' }, { zero: '0' }), unit: 'items', foot: `${UI.num(p.blocked.points)} pts in Refinement`, tone: p.blocked.count ? 'risk' : 'ok' })}
        </div>
      </section>

      <section class="section grid-2">
        <div class="card">
          <h3>Burndown</h3>
          <div class="sub">Remaining points against the ideal line</div>
          ${Charts.burndown(d.burndown, { committed: p.committed })}
        </div>
        <div class="card">
          <h3>Where the work sits</h3>
          <div class="sub">Committed points by status</div>
          ${Charts.ranked(byStatus, { labelKey: 'key', valueKey: 'points' })}
          ${refinementNote(d)}
        </div>
      </section>

      <section class="section grid-2">
        <div class="card">
          <h3>Per-person progress</h3>
          <div class="sub">Delivered against committed</div>
          <div class="table-wrap" style="border:none">
            <table>
              <thead><tr><th>Name</th><th class="num">Committed</th><th class="num">Done</th><th style="min-width:110px">Progress</th><th class="num">Left</th></tr></thead>
              <tbody>${byMember.map(r => `
                <tr>
                  <td><div class="name-cell">${UI.avatar(r.name)}${UI.esc(r.name)}</div></td>
                  <td class="num">${UI.num(r.planned)}</td>
                  <td class="num">${UI.num(r.actual)}</td>
                  <td>${UI.bar(r.actual, r.planned || 1, r.goalPct != null && r.goalPct < w.timeElapsedPct - 20 ? 'under' : '')}</td>
                  <td class="num">${UI.num(r.remainingPoints)}</td>
                </tr>`).join('')}
                ${off.map(o => `
                <tr class="unassigned-row">
                  <td title="Assigned to ${UI.esc(o.name)}, who is not on this sprint's roster — their capacity is not being planned for.">
                    <div class="name-cell">${UI.avatar(o.name)}${UI.esc(o.name)} <span class="tag warn">not on sprint</span></div>
                  </td>
                  <td class="num">${UI.num(o.planned)}</td>
                  <td class="num">${UI.num(o.actual)}</td>
                  <td>${UI.bar(o.actual, o.planned || 1)}</td>
                  <td class="num">${UI.num(left(o.planned, o.actual))}</td>
                </tr>`).join('')}
                ${un.count ? `
                <tr class="unassigned-row">
                  <td title="Nobody is in the Assignee field on these items."><span class="tag warn">No assignee</span> <span class="muted">${un.count} item${un.count === 1 ? '' : 's'}</span></td>
                  <td class="num">${UI.num(un.points)}</td>
                  <td class="num">${UI.num(un.done)}</td>
                  <td>${UI.bar(un.done, un.points || 1)}</td>
                  <td class="num">${UI.num(left(un.points, un.done))}</td>
                </tr>` : ''}
              </tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <h3>Work mix delivered</h3>
          <div class="sub">What this sprint actually went on</div>
          ${UI.mixBar(d.mix, state.categories)}
        </div>
      </section>

      ${p.blocked.count || p.unestimated.count ? `
      <section class="section grid-2">
        ${p.blocked.count ? card('Blocked in Refinement', 'Not ready to work yet — these become carryover unless they move', p.blocked.items, state) : ''}
        ${p.unestimated.count ? card('Committed without an estimate', 'The commitment number is only as good as these', p.unestimated.items, state) : ''}
      </section>` : ''}

      ${componentProgress(d, w)}

      ${testCaseSection(d, state)}

      ${/* POINTS ARE EDITABLE HERE TOO, and an edit goes to real Jira. This
           is where you sit during standup with the estimates in front of you,
           which is exactly when a wrong one gets spotted — the same argument
           as on Capacity planning, and the same shared wiring below. */ ''}
      ${UI.itemsTable(d.items, state, { editPoints: !ro, editDue: !ro, sprintEnd: (d.sprint || {}).end, today: (d.window || {}).today })}

      ${riskSection(d, state)}
    `;

    /* POINTS → JIRA, the same shared wiring the Capacity screen uses, so the
       two behave identically down to the wording of the failures. `onSaved`
       reloads because the figures above this table — committed points,
       progress, the per-person split — are all derived from these numbers. */
    UI.wireItemEdits(mount, {
      teamId: state.teamId, sprintId: state.sprintId, readOnly: ro,
      onSaved: () => App.refresh(),
    });

    /* THE ITEM TABLE'S OWN FILTERS. Delegated on the same mount, so it keeps
       working after a sort reorders the rows. */
    UI.wireItemsFilter(mount);

    /* One delegated listener on the render container — the property
       ui-wiring.test.js pins. `window.print()` is the whole export: the
       browser's own renderer produces exactly what is on screen, and its
       dialogue offers "Save as PDF" on every platform this runs on. */
    mount.addEventListener('click', (e) => {
      if (!e.target.closest) return;

      const pdf = e.target.closest('[data-act="export-pdf"]');
      if (pdf) { e.preventDefault(); exportPdf(d, state); return; }

      /* The blockers on the epic behind a Story in Refinement. The item is
         found in the payload the table was drawn from, so the drawer cannot
         show a different row from the one that was clicked. */
      /* The suites a bucket story is maintaining. The item comes from the
         payload the grid was drawn from, so the drawer cannot open a row other
         than the one that was clicked. */
      const tc = e.target.closest('[data-act="item-testcases"]');
      if (tc) {
        e.preventDefault();
        const item = (d.items || []).find(i => i.key === tc.dataset.key);
        if (item) UI.drawer(UI.testCasesDrawer(item, d.items || [], (d.testCases || {}).catalogue || {}, state));
        return;
      }

      const rb = e.target.closest('[data-act="refinement-blockers"]');
      if (rb) { e.preventDefault(); openRefinementDrawer(d, state); return; }

      const bk = e.target.closest('[data-act="blocked"]');
      if (bk) { e.preventDefault(); openBlockedDrawer(d, state); return; }

      const eb = e.target.closest('[data-act="epic-blockers"]');
      if (eb) {
        e.preventDefault();
        const item = (d.items || []).find(i => i.key === eb.dataset.key);
        if (item) UI.drawer(UI.epicBlockersDrawer(item, d.items || [], (d.testCases || {}).catalogue || {}, state));
        return;
      }

      const n = e.target.closest('[data-act="drill"]');
      if (n) { e.preventDefault(); openDrill(d, state, n.dataset.scope, n.dataset.col); }
    });
  }

  /**
   * Open the set behind one number.
   *
   * The keys come from the payload, never from a second count done here — the
   * whole point of a drill-in is that it shows what the number is made of, and
   * a list assembled by different code is a list that can disagree with the
   * figure that opened it.
   *
   * `committed` is the exception that proves it: the KPI counts POINTS over the
   * sprint's items, so its set is the item list, and the drawer adds the points
   * up again from the same items. One source, two readings of it.
   */
  function openDrill(d, state, scope, col) {
    const t = d.testCases || {};
    const source = scope === '__sprint'
      ? { items: (d.items || []).map(i => i.key) }
      : scope === '__total'
        ? ((t.totals || {}).keys || {})
        : (((t.rows || []).find(r => r.component === scope) || {}).keys || {});
    const keys = col === 'committed' ? (source.items || []) : (source[col] || []);
    const where = scope === '__sprint' || scope === '__total' ? 'this sprint' : scope;

    UI.drawer(UI.drillDrawer({
      title: `${TITLE[col] || col} — ${where}`,
      meaning: MEANING[col] || '',
      keys,
      items: d.items || [],
      catalogue: t.catalogue || {},
      state,
      /* ONLY THIS COLUMN. "Automated" needs no reason — the epic's status is
         the reason, and it is already on the row. Blocked is the one number
         here whose explanation lives on a different issue: the sprint item
         stuck in Refinement, and whatever THAT is waiting on. */
      reasons: col === 'blocked' ? (t.blockedReasons || {}) : null,
    }));
  }

  /* ── WHAT THE REFINEMENT BAR IS WAITING ON ───────────────────────────────
     The bar says how many points sit in Refinement. It cannot say why, and on
     his data the why is both knowable and startling: in TT Week 14Sep ten of
     the sixteen Stories in Refinement are held up, and all ten by the SAME
     ticket. That is one conversation, not ten.

     THE CONTROL IS A BUTTON UNDER THE CHART, NOT A MARKER INSIDE IT. The chart
     is an SVG, and an SVG has no button: a clickable <g> answers the mouse and
     is invisible to the keyboard, which this app treats as half a control (see
     `drillNumber`). A real button on its own line is reachable, announces
     itself, and has room to say what it found. */
  function refinementItems(d) {
    return (d.items || []).filter(i => UI.inRefinement(i) && ((i.epicBlockers || []).length));
  }

  function refinementNote(d) {
    const held = refinementItems(d);
    if (!held.length) return '';
    const inRefinement = (d.items || []).filter(UI.inRefinement).length;
    const blockers = new Set(held.flatMap(i => (i.epicBlockers || []).flatMap(g => g.blockers || [])).map(UI.linkKey).filter(Boolean));
    const n = blockers.size;
    return `
      <div class="muted" style="display:flex;align-items:center;gap:7px;margin-top:10px;font-size:12px">
        <button type="button" class="blockicon" data-act="refinement-blockers"
          title="What the ${UI.int(held.length)} blocked Refinement ${held.length === 1 ? 'item is' : 'items are'} waiting on — from Jira's &quot;is blocked by&quot; links on their epics"
          aria-label="Show what is blocking the items in Refinement">!</button>
        <span><strong>${UI.int(held.length)}</strong> of ${UI.int(inRefinement)} in Refinement
          ${held.length === 1 ? 'is' : 'are'} waiting on ${UI.int(n)} ${n === 1 ? 'blocker' : 'blockers'}</span>
      </div>`;
  }

  /**
   * THE SET BEHIND THE BLOCKED NUMBER.
   *
   * `p.blocked.items` is the list the KPI counted, handed over whole — the one
   * rule every drill-in in this app follows, because a drawer that re-derives
   * its own list is a drawer that can disagree with the figure that opened it.
   * Nothing here filters, sorts by a different key, or looks at `d.items`.
   *
   * BY ITEM, NOT BY BLOCKER. The panel under the status chart already groups
   * the other way round — one blocker, the items it holds — which answers
   * "what is the one conversation to have today". This one answers "what is in
   * my Blocked number", so it lists the items, in the order the board shows
   * them, and puts what each is waiting on underneath.
   *
   * AN ITEM WITH NO RECORDED BLOCKER STILL APPEARS, labelled. Dropping it
   * would make the list shorter than the number above it; and on this data the
   * unexplained ones are the interesting half — an item in Refinement with
   * nothing linked is not blocked so much as unrefined, which is a different
   * conversation with a different person.
   */
  function openBlockedDrawer(d, state) {
    const items = (d.progress.blocked || {}).items || [];
    const cats = state.categories || {};
    const waiting = (i) => {
      const seen = new Map();
      for (const g of i.epicBlockers || []) {
        for (const b of g.blockers || []) {
          const k = UI.linkKey(b);
          if (k && !seen.has(k)) seen.set(k, { key: k, summary: (b && b.summary) || null, epic: g.epic });
        }
      }
      return [...seen.values()];
    };
    const held = items.filter(i => waiting(i).length);
    const blockers = new Set(items.flatMap(i => waiting(i).map(b => b.key)));

    UI.drawer(`
      <div class="drawer-head">
        <div style="display:flex;align-items:center;gap:10px">
          <h3 style="margin:0">Blocked — ${UI.int(items.length)} ${items.length === 1 ? 'item' : 'items'}</h3>
          <span class="spacer"></span>
          ${UI.openInJira(items.map(i => i.key))}
        </div>
        <div class="muted" style="font-size:12px;margin-top:4px">
          ${UI.num(d.progress.blocked.points)} pts sitting in <strong>Refinement</strong> —
          committed to this sprint but not ready to work.
        </div>
        <div class="muted" style="font-size:11.5px;margin-top:6px">
          ${held.length
            ? `${UI.int(held.length)} of them name what they are waiting on, across
               ${UI.int(blockers.size)} ${blockers.size === 1 ? 'blocker' : 'blockers'}. The block is
               recorded on the <strong>epic</strong>, not on the item, which is why the board shows nothing.`
            : 'None of them names a blocker on its epic — these are waiting on refinement, not on another ticket.'}
        </div>
      </div>
      ${items.map((i) => {
        const on = waiting(i);
        return `
        <div style="padding:11px 0;border-bottom:1px solid var(--app-line-soft)">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px">
            ${UI.issueKey(i.key)}
            ${i.category ? `<span class="tag">${UI.esc((cats[i.category] || {}).label || i.category)}</span>` : ''}
            ${UI.statusText(i)}
            <span class="spacer"></span>
            ${i.assignee ? `<span class="muted" style="font-size:11.5px">${UI.esc(i.assignee)}</span>` : ''}
            ${i.points == null ? '<span class="tag risk">no estimate</span>' : `<strong>${UI.num(i.points)} pts</strong>`}
          </div>
          ${i.summary ? `<div style="font-size:13px">${UI.esc(i.summary)}</div>` : ''}
          ${on.length
            ? `<div class="muted" style="font-size:11.5px;margin-top:4px">Waiting on ${on.map(b =>
                `${UI.issueKey(b.key)}${b.summary ? ` <span>${UI.esc(b.summary)}</span>` : ''}`).join(', ')}
                <span style="opacity:.7">— via ${UI.issueKeys([...new Set(on.map(b => b.epic))])}</span></div>`
            : '<div class="muted" style="font-size:11.5px;margin-top:4px">No blocker recorded on its epic — waiting on refinement</div>'}
        </div>`;
      }).join('')}`);
  }

  /**
   * Grouped by the BLOCKER, because that is the unit of action.
   *
   * Listing ten stories each naming the same ticket is ten rows of one fact.
   * Turned around, it is one row with ten stories under it — and the thing to
   * chase is at the top of it. The same shape the Coverage blockers panel uses.
   */
  function openRefinementDrawer(d, state) {
    const held = refinementItems(d);
    const byBlocker = new Map();
    const detail = new Map();
    for (const i of held) {
      for (const g of i.epicBlockers || []) {
        for (const b of g.blockers || []) {
          const k = UI.linkKey(b);
          if (!k) continue;
          if (!byBlocker.has(k)) byBlocker.set(k, []);
          byBlocker.get(k).push({ item: i, epic: g.epic });
          if (b && typeof b === 'object' && (b.summary || b.type) && !detail.has(k)) detail.set(k, b);
        }
      }
    }
    const groups = [...byBlocker.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

    UI.drawer(`
      <div class="drawer-head">
        <div style="display:flex;align-items:center;gap:10px">
          <h3 style="margin:0">Blocking Refinement</h3>
          <span class="spacer"></span>
          ${UI.openInJira([...byBlocker.keys()])}
        </div>
        <div class="muted" style="font-size:12px;margin-top:4px">
          ${UI.int(held.length)} ${held.length === 1 ? 'item' : 'items'} in Refinement,
          held by ${UI.int(groups.length)} ${groups.length === 1 ? 'blocker' : 'blockers'}.
        </div>
        <div class="muted" style="font-size:11.5px;margin-top:6px">
          The block is recorded on each item's <strong>epic</strong>, not on the item — which is why the
          board shows nothing. These are Jira's <strong>is blocked by</strong> links.
        </div>
      </div>
      ${groups.map(([key, rows]) => {
        const d2 = detail.get(key);
        return `
        <div style="margin-top:14px">
          <div class="eyebrow"><i></i>${UI.issueKey(key)} — blocks ${UI.int(rows.length)} ${rows.length === 1 ? 'item' : 'items'}</div>
          ${d2 && d2.summary ? `<div style="font-size:13px;margin:4px 0 2px">${UI.esc(d2.summary)}</div>` : ''}
          ${rows.map(r => `
            <div style="padding:9px 0;border-bottom:1px solid var(--app-line-soft)">
              <div style="display:flex;gap:8px;align-items:center">
                ${UI.issueKey(r.item.key)}
                <span class="muted" style="font-size:11.5px">via ${UI.issueKey(r.epic)}</span>
                <span class="spacer"></span>
                ${r.item.assignee ? `<span class="muted" style="font-size:11.5px">${UI.esc(r.item.assignee)}</span>` : ''}
              </div>
              <div style="font-size:13px;margin-top:3px">${UI.esc(r.item.summary || '')}</div>
            </div>`).join('')}
        </div>`;
      }).join('')}`);
  }

  /** The filename this report saves as. `UI.exportPdf` does the rest. */
  function exportPdf(d, state) {
    const sp = d.sprint || {};
    const team = (state.teams || []).find(t => t.id === state.teamId) || {};
    UI.exportPdf([team.jiraName || team.name || state.teamId, sp.name || state.sprintId, 'sprint report']);
  }


  /**
   * WHAT IS IN THE WAY — this sprint's risks, on the page that is about this
   * sprint.
   *
   * The Risks screen already holds all of this, sprint-scoped, with filters
   * and the register's editing controls. This is not that screen shrunk down;
   * it answers a narrower question. Sprint health above says "at risk" and
   * gives reasons; the reasons say what is true. A risk says what to DO about
   * it, and that is the thing a lead came to this page for.
   *
   * WHAT IS LEFT OUT, and why:
   *   · LOW signals. "Keep an eye on it" is not a thing to do today, and eight
   *     of them under a sprint that is on track is how a section teaches you
   *     to scroll past it. They are counted, and the count is a link.
   *   · CLOSED register entries — history, and the Risks page has them.
   *   · The add / edit / promote controls. Two places to edit one register is
   *     two places for it to disagree; this section reads, and links.
   *
   * The cap is on the section, not on each list: six cards is roughly one
   * screen, and past that the Risks page is the better tool and is one click
   * away. High always outranks medium for those six, and the register is shown
   * first — a risk somebody typed is one no detector could have found.
   */
  const RISK_CARDS = 6;

  function riskSection(d, state) {
    const r = d.risks || { signals: [], manual: [] };
    const signals = r.signals || [];
    const manual = r.manual || [];
    const acting = signals.filter(s => s.severity === 'high' || s.severity === 'medium');
    const low = signals.length - acting.length;
    // The app routes on a bare hash (`#risks`) and picks the change up through
    // its own `hashchange` listener, so this needs no handler of its own.
    const href = '#risks';

    // The register first, then the highest signals, into one budget.
    const shown = [...manual.map(m => ({ ...m, kind: 'register' })), ...acting.map(s => ({ ...s, kind: 'signal' }))]
      .slice(0, RISK_CARDS);
    const more = (manual.length + acting.length) - shown.length;

    /* The strip counts EVERYTHING the section is about — register entries as
       well as detected signals. Counting only the signals put "1 high" beside
       two cards with a high tag on them, because his own register entry is one
       of them, and a header that disagrees with the cards under it is worse
       than no header. "From the register" stays as provenance, not as a
       separate population. */
    const all = [...manual, ...signals];
    const n = (sev) => all.filter(x => (x.severity || 'low') === sev).length;
    const counts = [
      n('high') && `<span class="tag risk">${n('high')} high</span>`,
      n('medium') && `<span class="tag warn">${n('medium')} medium</span>`,
      n('low') && `<span class="tag">${n('low')} low</span>`,
      manual.length && `<span class="tag">${manual.length} from the register</span>`,
    ].filter(Boolean).join(' ');

    return `
      <section class="section">
        <div class="section-head">
          <h2>Risks</h2>
          <span class="muted">What is in the way, and what to do about it</span>
          <div class="spacer"></div>
          ${counts}
          <a class="btn ghost sm print-hide" href="${href}">All risks</a>
        </div>
        ${shown.length ? `<div class="grid-2">${shown.map(riskCard).join('')}</div>` : `
          <div class="card"><div class="empty">
            Nothing to act on in this sprint.
            ${low ? `${low} low signal${low === 1 ? '' : 's'} on the Risks page.` : 'All eleven checks ran and found nothing.'}
          </div></div>`}
        ${more > 0 ? `<div class="muted" style="font-size:11.5px;margin-top:9px">
          ${more} more — see <a href="${href}">Risks</a>.
        </div>` : ''}
      </section>`;
  }

  function riskCard(x) {
    const sev = x.severity || 'low';
    const detail = x.detail || '';
    // A register entry calls its response a mitigation; a signal calls it an
    // action. Same line on the card, because to the reader they are one thing.
    const action = x.kind === 'register' ? x.mitigation : x.action;
    return `
      <div class="risk-card ${UI.esc(sev)}">
        <div class="meta">
          <span class="tag ${sev === 'high' ? 'risk' : sev === 'medium' ? 'warn' : ''}">${UI.esc(sev)}</span>
          ${x.category ? `<span class="tag">${UI.esc(x.category)}</span>` : ''}
          ${x.kind === 'register'
            ? `<span class="muted" style="font-size:11.5px">register${x.owner ? ` · ${UI.esc(x.owner)}` : ''}</span>`
            : ''}
        </div>
        <div class="title">${UI.esc(x.title || '')}</div>
        ${detail ? `<div class="detail">${UI.esc(detail)}</div>` : ''}
        ${action ? `<div class="action">${UI.esc(action)}</div>` : ''}
      </div>`;
  }

  function card(title, sub, items, state) {
    return `
      <div class="card">
        <h3>${UI.esc(title)}</h3>
        <div class="sub">${UI.esc(sub)}</div>
        ${items.map(i => `
          <div style="padding:9px 0;border-bottom:1px solid var(--app-line-soft)">
            <div style="display:flex;gap:8px;align-items:center">
              ${UI.issueKey(i.key)}
              <span class="spacer"></span>
              <span class="muted" style="font-size:12px">${UI.esc(i.assignee || 'unassigned')}</span>
              ${(i.blockedBy || []).length ? `<span class="tag risk">blocked by ${UI.issueKeys(i.blockedBy)}</span>` : ''}
            </div>
            <div style="font-size:13px;margin-top:3px">${UI.esc(i.summary)}</div>
          </div>`).join('')}
      </div>`;
  }

  /**
   * The title block the PDF needs and the screen does not.
   *
   * On screen every one of these facts is in the furniture — the team in the
   * sidebar, the sprint in the topbar, the freshness in the sync line — and
   * print hides all of it. A PDF that does not say which team, which sprint,
   * over what dates and when it was taken is a page of numbers nobody can
   * file, and worse, one that quietly ages into being wrong.
   */
  function printHeader(d, state) {
    const sp = d.sprint || {};
    const team = (state.teams || []).find(t => t.id === state.teamId) || {};
    const span = sp.start && sp.end ? `${UI.date(sp.start)} – ${UI.date(sp.end)}` : '';
    return `
      <div class="print-only" style="margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--app-line)">
        <div class="eyebrow"><i></i>KMS · Automation · Active sprint</div>
        <h2 style="margin-top:6px">${UI.esc(team.jiraName || team.name || state.teamId)} — ${UI.esc(sp.name || state.sprintId)}</h2>
        <div class="muted" style="font-size:11.5px;margin-top:4px">
          ${span ? `${span} · ` : ''}day ${d.window.elapsed} of ${d.window.workingDays} working days ·
          Jira data synced ${UI.esc(UI.dateTime(state.syncedAt))} ·
          report taken ${UI.esc(UI.dateTime(new Date().toISOString()))}
        </div>
      </div>`;
  }

  /**
   * Where the sprint stands, one row per product component.
   *
   * The per-person table answers "who is carrying what"; this answers "which
   * area of the product is moving", which is the question you actually take
   * into a sprint review. Grouping is by PRODUCT component — the tool markers
   * (TrueTest, Katalon) ride along on two thirds of the items and would
   * otherwise be the biggest row on the screen while meaning nothing.
   *
   * A component behind the sprint's own elapsed time is marked, on the same
   * rule the per-person table uses, so "we are on day eight of ten and this
   * area is at 30%" is visible rather than arithmetic.
   */
  /**
   * A component's priority, read-only here.
   *
   * Editable in exactly one place — the Coverage grid — because a value with two
   * editors is a value with two answers the first time both screens are open.
   * Shown here because this is the table he plans the sprint from, and "the
   * suite that is behind is also the P1" is the whole point of having set it.
   */
  function prio(d, r) {
    if (r.priority == null) return '<span class="muted">—</span>';
    const l = (d.priorityLevels || []).find(x => x.value === r.priority) || { label: `P${r.priority}`, name: '', key: `p${r.priority}` };
    // Coloured from the level's own key, the same one the editable control on
    // Coverage uses, so P2 cannot be amber on one screen and grey on the other.
    return `<span class="tag prio-tag prio-${UI.esc(l.key || `p${r.priority}`)}" title="${UI.esc(l.name)}">${UI.esc(l.label)}</span>`;
  }

  function componentProgress(d, w) {
    const c = d.byComponent || { rows: [], shared: 0 };
    if (!c.rows.length) return '';
    const behind = (r) => r.points > 0 && r.donePct < w.timeElapsedPct - 20;
    return `
      <section class="section">
        <div class="section-head">
          <h2>Per-component progress</h2>
          <span class="muted">
            ${c.rows.length} component${c.rows.length === 1 ? '' : 's'} · delivered against committed
            ${c.shared ? ` · ${c.shared} item${c.shared === 1 ? '' : 's'} in more than one component, counted in each — so the column totals more than the commitment` : ''}
          </span>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Component</th>
              <th title="Set on the Coverage screen — this is your judgement of the suite, not a Jira field">Priority</th>
              <th class="num">Items</th><th class="num">Committed</th>
              <th class="num">Done</th><th style="min-width:110px">Progress</th>
              <th class="num">Left</th><th>Attention</th>
            </tr></thead>
            <tbody>${c.rows.map(r => `
              <tr>
                <td>${UI.componentLink(r.component, r.keys, { what: 'sprint items' })}</td>
                <td data-sort-value="${r.priority == null ? UNSET_SORT : r.priority}">${prio(d, r)}</td>
                <td class="num">${r.count}</td>
                <td class="num">${UI.num(r.points)}</td>
                <td class="num">${UI.num(r.done)}</td>
                <td>${UI.bar(r.done, r.points || 1, behind(r) ? 'under' : '')}</td>
                <td class="num">${UI.num(r.remaining)}</td>
                <td>
                  ${behind(r) ? `<span class="tag warn" title="${r.donePct}% delivered on day ${w.elapsed} of ${w.workingDays}">behind the sprint</span>` : ''}
                  ${r.blocked ? `<span class="tag risk">${r.blocked} blocked</span>` : ''}
                  ${r.unestimated ? `<span class="tag">${r.unestimated} unestimated</span>` : ''}
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>`;
  }

  /**
   * TEST CASES BY COMPONENT — what this sprint automated, and what it kept alive.
   *
   * The two numbers are counted from opposite ends of the data because that is
   * where AUTOKAT records them, and the caption says so: a test case being
   * automated is the PARENT EPIC of a Story, read from the epic's own Automation
   * Status; a test case being maintained is one "relates to" link on a Bucket
   * Story. Neither is the sprint item, which is why this table cannot be derived
   * from the item counts in the table above it.
   *
   * THE TOTALS ROW IS NOT THE COLUMN ADDED UP. An item in two components is in
   * two rows, so the rows above can name the same test case twice; the total is
   * the distinct count across the sprint. Stated in the caption, because a
   * column that visibly does not sum reads as a bug until you know why.
   */
  /* Every count in this table opens the set behind it.
     The scope is the component name, or `__total` for the footer — one attribute
     pair naming exactly which set, so the click handler looks the keys up in the
     payload rather than working them out a second time and differently. A
     component name with a quote in it would break the attribute, which is why it
     goes through `drillNumber`'s escaping rather than into a template by hand. */
  function drill(r, col) {
    return UI.drillNumber(r[col], { act: 'drill', scope: r.component == null ? '__total' : r.component, col });
  }

  /* What each column counts, in one place — the drawer repeats the sentence it
     was opened by, because a list of eleven epic keys means nothing without it. */
  const MEANING = {
    automated: 'Distinct parent epics of this component’s Stories whose Automation Status reads Automated.',
    inFlight: 'Parent epics of this component’s Stories that are not Automated yet.',
    maintained: 'Test cases linked from this component’s Bucket Stories whose own Automation Status reads Automated — the suite is working again.',
    maintaining: 'Test cases linked from this component’s Bucket Stories whose own Automation Status reads Maintenance — still being fixed.',
    unclassified: 'Test cases linked from this component’s Bucket Stories whose Automation Status is neither Automated nor Maintenance — Ready for Automation, Blocked, N/A, or not set at all.',
    blocked: 'Test cases — a Story’s parent epic, a Bucket Story’s linked suites — whose sprint item is still in Refinement, so nobody can move them yet.',
    stories: 'Sprint items of type Story.',
    buckets: 'Sprint items that are Bucket Stories — the maintenance containers.',
    items: 'Every sprint item in this component.',
    done: 'Sprint items here that are finished.',
    committed: 'Every item committed to this sprint. The number above is their points.',
  };
  const TITLE = {
    automated: 'Automated', inFlight: 'In flight',
    maintained: 'Maintained', maintaining: 'Maintaining', unclassified: 'No automation status',
    blocked: 'Blocked — waiting on Refinement',
    stories: 'Stories', buckets: 'Bucket stories', items: 'Items', done: 'Done',
    committed: 'Committed',
  };

  /* `state` is here for ONE thing — the export link's team and sprint. It is
     passed rather than read off a closure because this function is called from
     `render`, and a closure that happens to be in scope is how a section comes
     to depend on the last screen's ids. */
  function testCaseSection(d, state) {
    const t = d.testCases;
    if (!t || !t.rows.length) return '';
    const T = t.totals;
    /* "No links at all" is a sync problem; "links, but none finished" is a real
       fortnight. Reading only `maintained` would confuse the two and tell him to
       run a full sync when what he is looking at is a team mid-repair. */
    const links = T.maintained + T.maintaining + T.unclassified;
    const pendingLinks = T.buckets > 0 && links === 0;

    return `
      <section class="section">
        <div class="section-head">
          <h2>Test cases by component</h2>
          <span class="muted">
            <strong>${UI.int(T.automated)}</strong> automated ·
            ${UI.int(T.inFlight)} still in flight ·
            <strong>${UI.int(T.maintained)}</strong> maintained ·
            ${UI.int(T.maintaining)} maintaining
          </span>
          <div class="spacer"></div>
          ${/* CSV rather than a real .xlsx: this app has no dependencies and
               hand-rolling the zip container to save a double-click would be
               the most code in the file for the least of anything. The route
               writes a byte-order mark so Excel opens it as UTF-8. */ ''}
          <a class="btn ghost sm print-hide"
             href="/api/export?what=testcases&team=${encodeURIComponent(state.teamId)}&sprint=${encodeURIComponent(state.sprintId)}"
             title="One row per component with the keys behind every number — opens in Excel">Export CSV</a>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Component</th>
              <th title="Set on the Coverage screen's component grid — this column shows it, it does not own it">Priority</th>
              <th class="num" title="Distinct parent epics of this component's Stories whose Automation Status is Automated">Automated</th>
              <th class="num" title="Parent epics of this component's Stories not yet Automated">In flight</th>
              <th class="num" title="Test cases linked from this component's Bucket Stories whose own Automation Status is Automated — working again">Maintained</th>
              <th class="num" title="Test cases linked from this component's Bucket Stories whose own Automation Status is Maintenance — still being fixed">Maintaining</th>
              <th class="num" title="Test cases whose Story or Bucket Story is still in Refinement — nobody can move them yet">Blocked</th>
            </tr></thead>
            <tbody>${t.rows.map(r => `
              <tr>
                ${/* The same link as the progress table above, over the same
                     set: the sprint items in this component. `keys.items` is
                     what this row's own Items count was the size of, before
                     that column was taken off the screen — so the two tables
                     open the identical list and cannot disagree. */ ''}
                <td>${UI.componentLink(r.component, (r.keys || {}).items, { what: 'sprint items' })}</td>
                <td data-sort-value="${UI.prioritySort(r.priority)}">${UI.priorityTag(r.priority, d.priorityLevels)}</td>
                <td class="num ${r.automated ? 'pct good' : ''}">${drill(r, 'automated')}</td>
                <td class="num">${drill(r, 'inFlight')}</td>
                <td class="num ${r.maintained ? 'pct good' : ''}">${drill(r, 'maintained')}</td>
                <td class="num">${drill(r, 'maintaining')}</td>
                <td class="num ${r.blocked ? 'pct over' : ''}">${drill(r, 'blocked')}</td>
              </tr>`).join('')}
            </tbody>
            <tfoot><tr>
              <td><strong>Sprint total</strong> <span class="muted" style="font-weight:400">distinct</span></td>
              <td></td>
              <td class="num"><strong>${drill(T, 'automated')}</strong></td>
              <td class="num"><strong>${drill(T, 'inFlight')}</strong></td>
              <td class="num"><strong>${drill(T, 'maintained')}</strong></td>
              <td class="num"><strong>${drill(T, 'maintaining')}</strong></td>
              <td class="num"><strong>${drill(T, 'blocked')}</strong></td>
            </tr></tfoot>
          </table>
        </div>
        <ul class="reasons" style="margin-top:12px">
          <li><strong>Automated</strong> counts the <em>parent epic</em> of each Story, using the epic's own
            Automation Status — a Story is the work, the epic is the test case. Two Stories under one epic are one
            test case.</li>
          <li><strong>Maintained</strong> and <strong>Maintaining</strong> both count the "relates to" links on
            Bucket Stories, one link per suite touched, split by the <em>linked</em> epic's own Automation Status:
            <strong>Automated</strong> means the suite is working again, <strong>Maintenance</strong> means it is
            still being fixed. Bucket Stories are excluded from Automated: every one of them hangs off the same
            maintenance container epic, which would report one epic as several automated test cases.</li>
          ${T.blocked ? `<li class="warn"><strong>Blocked</strong> counts the same test cases as the columns beside it —
            a Story's parent epic, a Bucket Story's linked suites — but only where that item is still in
            <strong>Refinement</strong>. ${drill(T, 'blocked')} of them cannot move until the work in front of them is
            refined, so they are already counted in Automated, In flight, Maintained or Maintaining as well.</li>`
            : '<li><strong>Blocked</strong> counts test cases whose Story or Bucket Story is still in Refinement. Nothing is, this sprint.</li>'}
          ${T.unclassified ? `<li class="warn">${drill(T, 'unclassified')} linked test case${T.unclassified === 1 ? '' : 's'}
            ${T.unclassified === 1 ? 'is' : 'are'} in neither Maintained nor Maintaining — ${T.unclassified === 1 ? 'its' : 'their'}
            Automation Status is Ready for Automation, Blocked, N/A, or not set. That is a missing field in Jira, not a
            gap in the count, so the two columns add up to less than the links on the Bucket Stories.</li>` : ''}
          ${t.shared ? `<li>${t.shared} item${t.shared === 1 ? '' : 's'} sit${t.shared === 1 ? 's' : ''} in more than one
            component and count in each, so the rows add up to more than the sprint total — the total row is the
            distinct count.</li>` : ''}
          ${t.unlinked ? `<li class="warn">${t.unlinked} Stor${t.unlinked === 1 ? 'y has' : 'ies have'} no parent epic,
            so ${t.unlinked === 1 ? 'it is' : 'they are'} in neither column. That is a missing link in Jira, not a
            gap in the count.</li>` : ''}
          ${pendingLinks ? `<li class="warn">${UI.int(T.buckets)} Bucket Stories carry no "relates to" links in the
            local store, so Maintained and Maintaining read zero everywhere. The links arrive with a
            <strong>full sync</strong> — an incremental one does not backfill them.</li>` : ''}
        </ul>
      </section>`;
  }

  function groupBy(items, fn) {
    const m = new Map();
    for (const i of items) {
      const k = fn(i);
      if (!m.has(k)) m.set(k, { key: k, points: 0, count: 0 });
      const g = m.get(k); g.points += Number(i.points) || 0; g.count++;
    }
    return [...m.values()].map(g => ({ ...g, points: Math.round(g.points * 10) / 10 })).sort((a, b) => b.points - a.points);
  }

  return { render };
})();
