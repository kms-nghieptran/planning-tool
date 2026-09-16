/* Forecast view — the next N sprints, built from real leave rather than an
   average headcount, plus a what-if panel so a staffing question gets an answer
   in the meeting instead of after it. */

const ForecastView = (() => {
  let scenario = { addMembers: 0, removeMemberIds: [], rampSupportPct: 40 };
  let horizon = 6;

  async function render(state, mount) {
    const qs = new URLSearchParams({ team: state.teamId, horizon, from: state.sprintId, scenario: JSON.stringify(scenario) });
    const d = await UI.api(`/api/forecast?${qs}`);
    const sd = d.supplyVsDemand;
    const hasScenario = scenario.addMembers > 0 || scenario.removeMemberIds.length > 0;

    mount.innerHTML = `
      <section class="section">
        <div class="kpis">
          ${UI.kpi({ label: `Capacity, next ${horizon}`, value: UI.int(sd.capacityPoints), unit: 'pts', foot: 'From actual availability, not an average', tone: 'brand', featured: true })}
          ${UI.kpi({ label: 'Backlog waiting', value: UI.int(sd.backlogPoints), unit: 'pts', foot: `${d.backlog.count} items · ${d.backlog.unestimated} unestimated` })}
          ${UI.kpi({ label: 'Clears in', value: sd.sprintsToClear == null ? '—' : UI.int(sd.sprintsToClear), unit: 'sprints', foot: d.avgVelocity ? `At ${d.avgVelocity} pts/sprint` : 'No velocity history yet', tone: sd.sprintsToClear > horizon ? 'warn' : 'ok' })}
          ${UI.kpi({ label: 'Predictability', value: d.predictability ? `${Math.round(d.predictability.mean * 100)}` : '—', unit: '%', foot: d.predictability ? `Delivered vs committed, ±${Math.round(d.predictability.stdev * 100)} pts over ${d.predictability.sprints} sprints` : 'Needs 3 completed sprints' })}
          ${d.maintenancePressure ? UI.kpi({
            label: 'Maintenance incoming',
            value: UI.int(d.maintenancePressure.predictedPoints), unit: 'pts',
            foot: `${UI.esc(d.maintenancePressure.basis)}${d.maintenancePressure.shareOfVelocity ? ` · ${d.maintenancePressure.shareOfVelocity}% of a sprint` : ''}`,
            tone: d.maintenancePressure.shareOfVelocity > 25 ? 'risk' : 'warn',
          }) : ''}
        </div>
      </section>

      <section class="section">
        <div class="card">
          <div class="section-head" style="margin-bottom:10px">
            <h3>Capacity vs commitment</h3>
            <div class="spacer"></div>
            <label class="field"><span>Horizon</span><select id="fcHorizon">${[3, 4, 6, 8, 10].map(n => `<option value="${n}"${n === horizon ? ' selected' : ''}>${n} sprints</option>`).join('')}</select></label>
            <a class="btn ghost sm" href="/api/export?what=forecast&team=${encodeURIComponent(state.teamId)}&horizon=${horizon}">Export CSV</a>
          </div>
          <div class="sub">${UI.esc(sd.verdict)}${hasScenario ? ' <strong>· scenario applied</strong>' : ''}</div>
          ${Charts.supplyDemand(d.rows)}
        </div>
      </section>

      <section class="section grid-2">
        <div class="card">
          <h3>What if…</h3>
          <div class="sub">Change the team, see the same forecast. Nothing is saved.</div>
          <div class="setting-row">
            <label>Add people</label>
            <div style="display:flex;gap:8px;align-items:center">
              <input type="number" min="0" max="6" id="scAdd" value="${scenario.addMembers}" style="width:70px">
              <span class="muted" style="font-size:12px">at</span>
              <input type="number" min="0" max="100" step="10" id="scRamp" value="${scenario.rampSupportPct}" style="width:70px">
              <span class="muted" style="font-size:12px">% ramp-up load</span>
            </div>
          </div>
          <div class="setting-row">
            <label>Remove people</label>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${(state.teams.find(t => t.id === state.teamId).members || []).filter(m => m.status !== 'Released').map(m =>
                `<button class="chip${scenario.removeMemberIds.includes(m.id) ? ' active' : ''}" data-remove="${m.id}">${UI.esc(m.name)}</button>`).join('')}
            </div>
          </div>
          <div class="btn-row">
            <button class="btn sm" id="scApply">Run scenario</button>
            <button class="btn ghost sm" id="scReset">Reset</button>
          </div>
          ${hasScenario ? `<p class="muted" style="font-size:12px;margin:12px 0 0">Scenario capacity: <strong>${UI.int(sd.capacityPoints)} pts</strong> over ${horizon} sprints.</p>` : ''}
        </div>

        <div class="card">
          <h3>Velocity history</h3>
          <div class="sub">Capacity, committed and delivered per sprint</div>
          ${Charts.velocity(d.history)}
          ${d.calibration ? `<p class="muted" style="font-size:12px;margin:10px 0 0">Actual cost: <strong>${d.calibration.value} h/pt</strong> (configured: ${d.settings.hoursPerPoint}) — ${UI.esc(d.calibration.basis)}.</p>` : ''}
        </div>
      </section>

      <section class="section">
        <div class="section-head"><h2>Sprint by sprint</h2><span class="muted">Availability is read from the capacity grid — fill leave in early and this gets accurate</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Sprint</th><th>Dates</th><th class="num">People</th><th class="num">Days</th>
              <th class="num">Capacity h</th><th class="num">Capacity pts</th><th class="num">Committed</th>
              <th class="num">Free</th><th class="num">Utilisation</th><th>Thin cover</th>
            </tr></thead>
            <tbody>
              ${d.rows.map(r => `
                <tr>
                  <td><strong>${UI.esc(r.name)}</strong></td>
                  <td class="muted" data-sort-value="${UI.esc(r.start || '')}">${UI.date(r.start)} – ${UI.date(r.end)}</td>
                  <td class="num">${r.headcount}</td>
                  <td class="num">${UI.num(r.availableDays)}</td>
                  <td class="num">${UI.num(r.capacityHours)}</td>
                  <td class="num">${UI.int(r.capacityPoints)}</td>
                  <td class="num">${UI.num(r.committedPoints)}</td>
                  <td class="num ${r.freePoints < 0 ? 'pct over' : ''}">${UI.num(r.freePoints)}</td>
                  <td class="num pct ${r.utilisationPct > 110 ? 'over' : r.utilisationPct < 60 ? 'under' : 'good'}">${r.utilisationPct}%</td>
                  <td class="muted" style="font-size:12px">${r.lowestAvailability.filter(x => x.days < 9).map(x => `${UI.esc(x.name)} ${x.days}d`).join(', ') || '—'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>

      ${d.maintenancePressure ? `
      <section class="section">
        <div class="card">
          <div class="eyebrow"><i></i>Execution health → maintenance demand</div>
          <h3 style="margin-top:6px">Failing suites are next sprint's work</h3>
          <div class="sub">Pass rate ${UI.pct(d.maintenancePressure.passRate)}${d.maintenancePressure.flakyRate != null ? ` · flaky ${UI.pct(d.maintenancePressure.flakyRate)}` : ''} — reserve capacity now rather than discovering it mid-sprint</div>
          ${Charts.ranked((d.maintenancePressure.projects[0] || {}).worstSuites || [], { labelKey: 'name', valueKey: 'failingTests', unit: 'failing', color: 'var(--brand-pink)' })}
          <p class="muted" style="font-size:12px;margin-top:10px">Rate of ${d.maintenancePressure.pointsPerFailingTest} pts per failing test is a starting guess — set <code>pointsPerFailingTest</code> per team in Settings once you have a sprint of evidence.</p>
        </div>
      </section>` : ''}
    `;

    wire(state, mount);
  }

  function wire(state, mount) {
    UI.$('#fcHorizon', mount).addEventListener('change', (e) => { horizon = Number(e.target.value); App.refresh(); });
    UI.$$('[data-remove]', mount).forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.remove;
      scenario.removeMemberIds = scenario.removeMemberIds.includes(id)
        ? scenario.removeMemberIds.filter(x => x !== id)
        : scenario.removeMemberIds.concat(id);
      b.classList.toggle('active');
    }));
    UI.$('#scApply', mount).addEventListener('click', () => {
      scenario.addMembers = Number(UI.$('#scAdd', mount).value) || 0;
      scenario.rampSupportPct = Number(UI.$('#scRamp', mount).value) || 0;
      App.refresh();
    });
    UI.$('#scReset', mount).addEventListener('click', () => {
      scenario = { addMembers: 0, removeMemberIds: [], rampSupportPct: 40 };
      App.refresh();
    });
  }

  return { render };
})();
