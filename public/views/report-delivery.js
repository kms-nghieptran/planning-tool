/* Delivery metrics — velocity, productivity and quality for one team.

   Each number shows its basis, because a metric nobody can explain in a review
   is a metric nobody acts on. */

const DeliveryReport = (() => {
  let window = 12;

  async function render(state, mount) {
    const d = await UI.api(`/api/reports/delivery?team=${encodeURIComponent(state.teamId)}&sprints=${window}`);
    const v = d.velocity, p = d.productivity, q = d.quality;

    if (!v.sprintsCounted) {
      mount.innerHTML = `<div class="card"><div class="empty">
        No completed sprints for ${UI.esc(d.teamName)} yet — these metrics need delivery history.<br><br>
        ${state.estimation && state.estimation.fieldLooksWrong
          ? 'The sprints are here; what is missing is their points.'
          : "Run a Jira sync; closed sprints on the team's board are what fills this in."}
        ${UI.pointsFieldNote(state)}
      </div></div>`;
      return;
    }

    mount.innerHTML = `
      <section class="section">
        <div class="section-head">
          <h2>Delivery metrics</h2>
          <span class="muted">${UI.esc(d.teamName)} · ${UI.esc(v.basis)}</span>
          <div class="spacer"></div>
          <label class="field inline"><span>Window</span>
            <select id="dmWindow">${[6, 8, 12, 20].map(n => `<option value="${n}"${n === window ? ' selected' : ''}>${n} sprints</option>`).join('')}</select>
          </label>
        </div>
        <div class="kpis">
          ${UI.kpi({ label: 'Average velocity', value: UI.int(v.average), unit: 'pts', foot: `Last 6 completed sprints`, tone: 'brand', featured: true })}
          ${UI.kpi({ label: 'Safe commitment', value: UI.int(v.safeCommitment), unit: 'pts', foot: 'Average discounted by delivery spread', tone: 'ok' })}
          ${UI.kpi({ label: 'Attainment', value: UI.pct(q.attainment), foot: `Delivered ÷ committed · ${q.missedSprints} sprint${q.missedSprints === 1 ? '' : 's'} landed short`, tone: q.attainment >= 90 ? 'ok' : q.attainment >= 75 ? 'warn' : 'risk' })}
          ${UI.kpi({ label: 'Rework', value: UI.pct(q.reworkShare), foot: `${UI.num(q.reworkPoints)} pts on maintaining existing tests`, tone: q.reworkShare > 35 ? 'warn' : '' })}
          ${UI.kpi({ label: 'Cycle time', value: p.cycleTime ? UI.num(p.cycleTime.median) : '—', unit: 'days', foot: p.cycleTime ? `Median · 85th pct ${UI.num(p.cycleTime.p85)} d` : 'Needs resolution dates' })}
        </div>
      </section>

      <section class="section">
        <div class="card">
          <div class="section-head" style="margin-bottom:6px"><h3>Velocity</h3></div>
          <div class="sub">Capacity, committed and delivered per sprint — the gap between the first two is planning, between the last two is delivery</div>
          ${Charts.velocity(v.history)}
          <div class="grid-3" style="margin-top:16px">
            ${statBlock('Best sprint', UI.int(v.best) + ' pts', 'Highest delivered in the window')}
            ${statBlock('Worst sprint', UI.int(v.worst) + ' pts', 'Lowest delivered in the window')}
            ${statBlock('Predictability', v.predictability ? `±${Math.round(v.predictability.stdev * 100)}%` : '—',
              v.predictability ? `Delivered ÷ committed averages ${Math.round(v.predictability.mean * 100)}% over ${v.predictability.sprints} sprints` : 'Needs 3 completed sprints')}
          </div>
          ${v.calibration ? `<p class="muted" style="font-size:12px;margin-top:14px">
            Real cost: <strong>${v.calibration.value} h per delivered point</strong> against the ${d.settings.hoursPerPoint} h configured — ${UI.esc(v.calibration.basis)}.
          </p>` : ''}
        </div>
      </section>

      <section class="section grid-2">
        <div class="card">
          <h3>Productivity</h3>
          <div class="sub">${UI.esc(p.basis)}</div>
          <div class="grid-3">
            ${statBlock('Points per person', UI.num(p.avgPerPerson), 'Per sprint, averaged')}
            ${statBlock('Throughput', UI.num(p.avgThroughput), 'Items completed per sprint')}
            ${statBlock('Capacity used', UI.pct(p.avgUtilisation), 'Delivered ÷ capacity')}
          </div>
          <div class="table-wrap" style="border:none;margin-top:14px">
            <table>
              <thead><tr><th>Sprint</th><th class="num">People</th><th class="num">Delivered</th><th class="num">Per person</th><th class="num">Capacity used</th></tr></thead>
              <tbody>${p.perSprint.slice().reverse().slice(0, 8).map(s => `
                <tr>
                  <td>${UI.esc(s.name)}</td>
                  <td class="num">${s.headcount}</td>
                  <td class="num">${UI.num(s.actual)}</td>
                  <td class="num">${UI.num(s.perPerson)}</td>
                  <td class="num pct ${s.utilisation > 110 ? 'over' : s.utilisation < 60 ? 'under' : 'good'}">${UI.pct(s.utilisation)}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <p class="muted" style="font-size:11.5px;margin-top:12px">${UI.esc(p.caveat)}</p>
        </div>

        <div class="card">
          <h3>Work mix delivered</h3>
          <div class="sub">Where the delivered points actually went over the window</div>
          ${UI.mixBar(p.mix, state.categories)}
          <h3 style="margin-top:22px">Carryover</h3>
          <div class="sub">Committed points that did not finish, sprint by sprint</div>
          ${Charts.ranked(q.carryover.slice().reverse().slice(0, 8).map(c => ({ key: c.name, points: c.carried })),
            { labelKey: 'key', valueKey: 'points', color: 'var(--brand-pink)' })}
          <p class="muted" style="font-size:12px;margin-top:8px">Averaging ${UI.pct(q.avgCarryoverPct)} of each sprint's commitment.</p>
        </div>
      </section>

      <section class="section">
        <div class="card">
          <div class="section-head" style="margin-bottom:6px"><h3>Quality</h3></div>
          <div class="sub">For an automation team this is not "how many bugs did we write" — it is whether the suite holds up, how much of the sprint goes on rework, and whether the team lands what it said it would</div>
          <div class="grid-3" style="margin-top:12px">
            ${statBlock('Commitment attainment', UI.pct(q.attainment), `${q.missedSprints} of ${q.carryover.length} sprints landed under 90%`)}
            ${statBlock('Rework share', UI.pct(q.reworkShare), 'Delivered effort spent maintaining existing automation')}
            ${statBlock('Unestimated', UI.pct(q.estimation.pct), `${q.estimation.unestimated} of ${q.estimation.total} committed items had no estimate`)}
            ${statBlock('Open defects', UI.int(q.defects.open), `${q.defects.total} raised in the window`)}
            ${q.suite ? statBlock('Suite pass rate', UI.pct(q.suite.passRate), `${q.suite.failingTests} failing tests in TestOps`) : statBlock('Suite pass rate', '—', 'Connect Katalon TestOps to fill this in')}
            ${q.suite ? statBlock('Flakiness', UI.pct(q.suite.flakyRate), 'Suites flipping pass/fail between runs') : statBlock('Flakiness', '—', 'Connect Katalon TestOps')}
          </div>
          ${q.suite && q.suite.worstSuites.length ? `
            <h3 style="margin-top:22px;font-size:13px">Worst suites</h3>
            <div class="sub">These are where next sprint's maintenance will come from</div>
            ${Charts.ranked(q.suite.worstSuites, { labelKey: 'name', valueKey: 'failingTests', unit: 'failing', color: 'var(--brand-pink)' })}` : ''}
          <p class="muted" style="font-size:11.5px;margin-top:14px">${UI.esc(q.basis)}</p>
        </div>
      </section>
    `;

    UI.$('#dmWindow', mount).addEventListener('change', e => { window = Number(e.target.value); App.refresh(); });
  }

  function statBlock(label, value, foot) {
    return `<div style="min-width:0">
      <div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--app-fg-3);font-weight:600;margin-bottom:5px">${UI.esc(label)}</div>
      <div style="font-size:22px;font-weight:800;line-height:1;letter-spacing:-.02em">${value}</div>
      <div class="muted" style="font-size:11px;margin-top:5px">${foot}</div>
    </div>`;
  }

  return { render };
})();
