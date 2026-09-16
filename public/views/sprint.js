/* Active sprint view — is this sprint going to land, and what is in the way. */

const SprintView = (() => {
  async function render(state, mount) {
    const d = await UI.api(`/api/sprint?team=${encodeURIComponent(state.teamId)}&sprint=${encodeURIComponent(state.sprintId)}`);
    const p = d.progress, w = d.window, h = d.health, t = d.totals || {};

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
        <div class="kpis">
          ${UI.kpi({ label: 'Capacity', value: UI.int(t.predicted), unit: 'pts', foot: `${UI.num(t.capacityHours)} h across ${t.headcount} ${t.headcount === 1 ? 'person' : 'people'}`, tone: 'brand' })}
          ${UI.kpi({ label: 'Committed', value: UI.int(p.committed), unit: 'pts', foot: `${d.items.length} items · ${headroom(t, p)}`, tone: t.predicted && p.committed > t.predicted ? 'risk' : '' })}
          ${UI.kpi({ label: 'Done', value: UI.int(p.done), unit: 'pts', foot: `${p.donePct}% of commitment`, tone: p.donePct >= w.timeElapsedPct ? 'ok' : '' })}
          ${UI.kpi({ label: 'Sprint elapsed', value: `${w.timeElapsedPct}`, unit: '%', foot: `Day ${w.elapsed} of ${w.workingDays} working days` })}
          ${UI.kpi({ label: 'Projected landing', value: p.projected == null ? '—' : UI.int(p.projected), unit: 'pts', foot: p.projectedVsCommitted == null ? 'Not enough of the sprint elapsed' : (p.projectedVsCommitted >= 0 ? `${UI.num(p.projectedVsCommitted)} pts above commitment` : `${UI.num(Math.abs(p.projectedVsCommitted))} pts short`), tone: p.projectedVsCommitted == null ? '' : p.projectedVsCommitted < -2 ? 'risk' : 'ok' })}
          ${UI.kpi({ label: 'Blocked', value: UI.int(p.blocked.count), unit: 'items', foot: `${UI.num(p.blocked.points)} pts held up`, tone: p.blocked.count ? 'risk' : 'ok' })}
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
        ${p.blocked.count ? card('Blocked items', 'These will become carryover unless the blockers move', p.blocked.items, state) : ''}
        ${p.unestimated.count ? card('Committed without an estimate', 'The commitment number is only as good as these', p.unestimated.items, state) : ''}
      </section>` : ''}

      ${componentProgress(d, w)}

      ${UI.itemsTable(d.items, state)}
    `;

    /* One delegated listener on the render container — the property
       ui-wiring.test.js pins. `window.print()` is the whole export: the
       browser's own renderer produces exactly what is on screen, and its
       dialogue offers "Save as PDF" on every platform this runs on. */
    mount.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('[data-act="export-pdf"]');
      if (!btn) return;
      e.preventDefault();
      exportPdf(d, state);
    });
  }

  /**
   * The browser names the file after the document title, so the title is set
   * for the duration of the print and put back afterwards — otherwise every
   * sprint report saves as "Planning Tool.pdf" and a folder of them is
   * unreadable.
   */
  function exportPdf(d, state) {
    const sp = d.sprint || {};
    const team = (state.teams || []).find(t => t.id === state.teamId) || {};
    const was = document.title;
    const slug = (v) => String(v || '').trim().replace(/[\\/:*?"<>|]+/g, '-');
    document.title = `${slug(team.jiraName || team.name || state.teamId)} — ${slug(sp.name || state.sprintId)} — sprint report`;
    // Restoring on the `afterprint` event rather than straight after the call:
    // in some browsers `print()` returns before the dialogue is done with the
    // title, and the file ends up named after the app instead of the sprint.
    const restore = () => { document.title = was; window.removeEventListener('afterprint', restore); };
    window.addEventListener('afterprint', restore);
    window.print();
    setTimeout(restore, 60000);   // a dialogue left open all day still ends tidy
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
              <th>Component</th><th class="num">Items</th><th class="num">Committed</th>
              <th class="num">Done</th><th style="min-width:110px">Progress</th>
              <th class="num">Left</th><th>Attention</th>
            </tr></thead>
            <tbody>${c.rows.map(r => `
              <tr>
                <td>${UI.esc(r.component)}</td>
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
