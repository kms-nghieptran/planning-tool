/* Sprints list — future and closed, from the team's Jira board.

   Future is a planning surface: open one and you land on its capacity grid.
   Closed is a record: what was committed, what landed, what carried over. */

const SprintsView = (() => {
  async function render(state, mount, route) {
    const which = route.id.split('/')[1];          // 'future' | 'closed'
    const d = await UI.api(`/api/sprints?team=${encodeURIComponent(state.teamId)}`);
    const rows = d[which] || [];
    const future = which === 'future';

    if (!rows.length && !d.local.length) {
      mount.innerHTML = `<div class="card"><div class="empty">
        No ${which} sprints on this team's board.${d.active.length ? '' : ' Run a Jira sync to pull them.'}
      </div></div>`;
      return;
    }

    const totalPts = rows.reduce((t, s) => t + (s.points || 0), 0);
    const delivered = rows.reduce((t, s) => t + (s.donePoints || 0), 0);

    mount.innerHTML = `
      <section class="section">
        <div class="kpis">
          ${UI.kpi({ label: future ? 'Sprints planned' : 'Sprints closed', value: UI.int(rows.length), foot: future ? 'Ahead on the board' : 'History on the board', tone: 'brand', featured: true })}
          ${UI.kpi({ label: future ? 'Already committed' : 'Committed', value: UI.int(totalPts), unit: 'pts', foot: `${rows.reduce((t, s) => t + s.count, 0)} items` })}
          ${future
            ? UI.kpi({ label: 'Empty sprints', value: UI.int(rows.filter(s => !s.count).length), foot: 'Nothing pulled in yet' })
            : UI.kpi({ label: 'Delivered', value: UI.int(delivered), unit: 'pts', foot: `${UI.pct(totalPts ? delivered / totalPts * 100 : null)} of commitment` })}
          ${!future && rows.length
            ? UI.kpi({ label: 'Average landed', value: UI.int(delivered / rows.length), unit: 'pts', foot: 'Per closed sprint' })
            : UI.kpi({ label: 'Next up', value: rows.length ? UI.esc(rows[rows.length - 1].name) : '—', variant: 'text', foot: rows.length ? `${UI.date(rows[rows.length - 1].start)} – ${UI.date(rows[rows.length - 1].end)}` : '' })}
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <h2>${future ? 'Future sprints' : 'Closed sprints'}</h2>
          <span class="muted">${future ? 'Open one to plan its capacity' : 'Open one to review how it went'}</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Sprint</th><th>Jira name</th><th>Dates</th>
              <th class="num">Items</th><th class="num">Committed</th>
              ${future ? '' : '<th class="num">Delivered</th><th class="num">Carried</th><th style="min-width:110px">Attainment</th>'}
              <th></th>
            </tr></thead>
            <tbody>
              ${rows.map(s => {
                const carried = Math.max(0, (s.points || 0) - (s.donePoints || 0));
                const att = s.points ? Math.round(s.donePoints / s.points * 100) : null;
                return `
                <tr>
                  <td><strong>${UI.esc(s.calendarName || (s.number != null ? `Sprint ${s.number}` : s.name))}</strong></td>
                  <td class="muted">${UI.esc(s.name)}</td>
                  <td class="muted" data-sort-value="${UI.esc(s.start || '')}">${UI.date(s.start)} – ${UI.date(s.end)}</td>
                  <td class="num">${s.count}</td>
                  <td class="num">${UI.num(s.points)}</td>
                  ${future ? '' : `
                    <td class="num">${UI.num(s.donePoints)}</td>
                    <td class="num ${carried > 0 ? 'pct over' : ''}">${UI.num(carried)}</td>
                    <td>${UI.bar(s.donePoints, s.points || 1, att != null && att < 80 ? 'under' : '')} <span class="muted" style="font-size:11px">${att == null ? '—' : att + '%'}</span></td>`}
                  <td><button class="btn ghost sm" data-open="${s.id}">${future ? 'Plan' : 'Review'}</button></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </section>

      ${future && rows.some(s => !s.count) ? `
      <section class="section">
        <div class="card">
          <div class="eyebrow"><i></i>Worth doing now</div>
          <p style="margin:8px 0 0;font-size:13px">
            ${rows.filter(s => !s.count).length} future sprint${rows.filter(s => !s.count).length > 1 ? 's have' : ' has'} nothing in ${rows.filter(s => !s.count).length > 1 ? 'them' : 'it'} yet.
            Filling in leave on the capacity grid early is what makes the forecast worth reading — the sprint where
            three people are away should be visible before you commit to it, not after.
          </p>
        </div>
      </section>` : ''}

      ${d.local.length ? `
      <section class="section">
        <div class="card">
          <div class="eyebrow"><i></i>Local only</div>
          <p style="margin:8px 0 0;font-size:13px">
            ${d.local.length} sprint${d.local.length > 1 ? 's exist' : ' exists'} in the local calendar but not on this team's Jira board.
            They stay until you delete them, and they are never mixed into the sprint picker.
          </p>
        </div>
      </section>` : ''}
    `;

    mount.addEventListener('click', e => {
      const btn = e.target.closest('[data-open]');
      if (!btn) return;
      state.sprintId = btn.dataset.open;
      localStorage.setItem('pt-sprint', state.sprintId);
      App.go(future ? 'sprints/capacity' : 'sprints/active');
    });
  }

  return { render };
})();
