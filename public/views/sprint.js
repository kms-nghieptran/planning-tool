/* Active sprint view — is this sprint going to land, and what is in the way. */

const SprintView = (() => {
  async function render(state, mount) {
    const d = await UI.api(`/api/sprint?team=${encodeURIComponent(state.teamId)}&sprint=${encodeURIComponent(state.sprintId)}`);
    const p = d.progress, w = d.window, h = d.health;

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

    mount.innerHTML = `
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
          ${UI.kpi({ label: 'Committed', value: UI.int(p.committed), unit: 'pts', foot: `${d.items.length} items` })}
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
