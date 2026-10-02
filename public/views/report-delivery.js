/* Delivery metrics — velocity, productivity and quality for one team.

   Each number shows its basis, because a metric nobody can explain in a review
   is a metric nobody acts on. */

const DeliveryReport = (() => {
  let window = 12;

  /* WHAT THE PER-PERSON NUMBERS OPEN.
     `ppItems` is the window's ticket catalogue, keyed by issue; `ppDrills` is
     what each clickable number registered. Both are rebuilt on every render —
     the window selector redraws the whole table, and a stale index would open
     last window's tickets from this window's numbers. */
  let ppItems = {};
  let ppDrills = [];

  /* THE WINDOW THE SENDER WAS LOOKING AT.
     Seeded once, and only in print mode: a `?sprints=` left in the address bar
     of the normal app would re-win on every redraw and fight the selector,
     which reads as the page refusing to change. Same rule, and the same
     reason, as the capacity sheet's family lens. */
  let windowSeeded = false;
  function seedPrintWindow() {
    if (windowSeeded) return;
    windowSeeded = true;
    try {
      const q = new URLSearchParams(location.search || '');
      if (q.get('print') !== '1') return;
      const n = Number(q.get('sprints'));
      if (Number.isFinite(n) && n > 0) window = n;
    } catch { /* the page still prints, just at the default window */ }
  }

  async function render(state, mount) {
    seedPrintWindow();
    const d = await UI.api(`/api/reports/delivery?team=${encodeURIComponent(state.teamId)}&sprints=${window}`);
    const v = d.velocity, p = d.productivity, q = d.quality, pp = d.perPerson;

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
          <label class="field inline print-hide"><span>Window</span>
            <select id="dmWindow">${[4, 6, 8, 12, 20].map(n => `<option value="${n}"${n === window ? ' selected' : ''}>${n} sprints</option>`).join('')}</select>
          </label>
          ${/* THE SAME PAIR AS COVERAGE AND ACTIVE SPRINT, in the same order and
                beside each other: one ending saves the report, the other sends
                it. A third arrangement of the same two controls would make the
                reports feel like three different tools. */''}
          <button class="btn ghost sm print-hide" data-act="export-pdf"
            title="Opens your browser's print dialogue — choose &quot;Save as PDF&quot;">Export PDF</button>
          <button class="btn sm print-hide" data-act="email-report"
            title="Render this report to a PDF and email it with a template you choose">Email the report</button>
        </div>
        ${windowNote(d)}
        <div class="kpis">
          ${UI.kpi({ label: 'Average velocity', value: UI.int(v.average), unit: 'pts', foot: 'Completed sprints only — the one in progress is excluded', tone: 'brand', featured: true })}
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

      ${perPersonSection(pp)}

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

    /* DELEGATED ON THE MOUNT, because the table is rebuilt whenever the window
       changes and a listener bound to the old cells is bound to nodes that are
       no longer on the page. */
    mount.addEventListener('click', async (e) => {
      const a = e.target.closest && e.target.closest('[data-pp]');
      if (a) {
        e.preventDefault();
        const hit = ppDrills[Number(a.dataset.pp)];
        if (hit) UI.drawer(ppDrawer(hit.label, hit.keys, ppItems));
        return;
      }

      if (e.target.closest('[data-act="export-pdf"]')) {
        e.preventDefault();
        UI.exportPdf(['Delivery metrics', d.teamName, `${window} sprints`,
          new Date().toISOString().slice(0, 10)]);
        return;
      }

      if (e.target.closest('[data-act="email-report"]')) {
        e.preventDefault();
        /* THE WINDOW IS SCOPE, NOT VIEW. The drawer's two bags mean different
           things — scope moves the numbers, view moves only the framing — and
           the window moves both: it chose every figure on this page and it has
           to choose the attachment too, or the mail quotes a twelve-sprint
           average over a six-sprint chart. Sent once, as scope; the send route
           is what carries it on into the print URL. */
        await MailDrawer.open({
          report: 'delivery',
          title: 'Send Delivery metrics',
          team: state.teamId,
          scope: { sprints: window },
          scopeLabel: `${d.teamName} · last ${window} sprints`,
        });
      }
    });
  }

  /**
   * WHAT THE WINDOW ACTUALLY RESOLVED TO.
   *
   * "12 sprints" is ambiguous until you say which twelve. It counts back from
   * the sprint you are in: the active one plus the most recent closed ones,
   * never a planned one. Saying so is the difference between a reader trusting
   * the chart and a reader guessing at it.
   */
  function windowNote(d) {
    const list = d.windowSprints || [];
    if (!list.length) {
      return `<div class="muted" style="font-size:12px;margin-top:-4px">
        No closed sprints for this team yet — nothing to measure.
      </div>`;
    }
    const closed = list.filter(s => !s.active);
    const active = d.activeSprint;
    const names = list.map(s => `${UI.esc(s.name)}${s.active ? ' (in progress)' : ''}`).join(' · ');
    return `
      <div class="muted" style="font-size:12px;margin-top:-4px">
        ${active
          ? `Counting back from <strong>${UI.esc(active.name)}</strong> — the sprint in progress plus the ${closed.length} most recently closed.`
          : `No active sprint right now, so this is the ${closed.length} most recently closed.`}
        ${list.length < d.window ? `<span class="tag warn" style="margin-left:6px">only ${list.length} of ${d.window} available</span>` : ''}
        <div style="margin-top:3px">${names}</div>
      </div>`;
  }

  /**
   * PER-PERSON VELOCITY — a row per person, a column per sprint, delivered points.
   *
   * DELIVERED, not committed. "Velocity" means what landed, and a grid of
   * commitments would repeat the capacity sheet while looking like it said
   * something new. The committed figure is in each cell's tooltip, where it
   * answers "did they land what they took on" without competing for the eye.
   *
   * A ZERO AND A BLANK ARE DIFFERENT THINGS. A person who delivered nothing
   * that sprint gets 0; a person who was not on the team gets an em dash. The
   * old roll-up had no way to tell those apart, and "delivered nothing" is a
   * conversation while "was not here" is not.
   *
   * THE COLUMN TOTAL IS THE SPRINT'S OWN FIGURE, not the sum of the rows above
   * it — they differ by work nobody is holding, and a table whose total
   * disagreed with the velocity chart directly above would be the first thing
   * anyone noticed about this screen.
   */
  function perPersonSection(pp) {
    ppItems = (pp && pp.items) || {};
    ppDrills = [];
    if (!pp || !pp.columns.length) return '';
    if (!pp.people.length) {
      return `<section class="section"><div class="card">
        <div class="section-head" style="margin-bottom:6px"><h3>Per-person velocity</h3></div>
        <div class="empty">Nobody on this team delivered points in this window.</div>
      </div></section>`;
    }

    /* EVERY NUMBER OPENS WHAT IT COUNTED.
       A velocity cell is the start of a question — "why was that sprint thin",
       "what did they actually land" — and a number you cannot open is a number
       you have to go to Jira to understand. The drawer lists the tickets the
       cell counted, not a second query that might disagree with it. A zero
       still opens, because "committed four tickets, finished none" is exactly
       the case worth looking at; only an em dash is inert, since there is
       nothing behind it. */
    /* REGISTERED BY INDEX, not by label. Two people can share a display name
       and a label is a sentence, not an identifier — keying the lookup on it
       would open one person's drawer from the other's row. */
    ppDrills = [];
    const drill = (keys, label, html) => {
      if (!keys || !keys.length) return html;
      const at = ppDrills.push({ label, keys }) - 1;
      return `<a href="#" data-pp="${at}" title="${UI.esc(`${label} — open the ${keys.length} item${keys.length === 1 ? '' : 's'}`)}">${html}</a>`;
    };

    const cell = (row, col) => {
      const v = row.bySprint[col.sprintId];
      // Not on the team that sprint — an em dash, not a nought, and nothing to open.
      if (!v) return '<td class="num muted" title="Not on this sprint">—</td>';
      const label = `${row.name} · ${col.name}`;
      const title = `${label}: ${UI.num(v.delivered)} of ${UI.num(v.committed)} pts committed`;
      return `<td class="num" title="${UI.esc(title)}">${drill(v.keys, label, UI.num(v.delivered))}</td>`;
    };

    return `
      <section class="section">
        <div class="card">
          <div class="section-head" style="margin-bottom:6px">
            <h3>Per-person velocity</h3>
            <div class="spacer"></div>
            <span class="muted">${UI.esc(pp.basis)}</span>
          </div>
          <div class="sub">Delivered story points per sprint. Where the team's velocity actually comes from — and whether it comes from everybody</div>
          <div class="table-wrap" style="margin-top:12px">
            <table>
              <thead><tr>
                <th>Tester</th>
                ${pp.columns.map(c => `<th class="num" title="${UI.esc(c.name)}${c.inProgress ? ' — in progress' : ''}">
                  ${UI.esc(c.number != null ? `Sprint ${c.number}` : c.name)}${c.inProgress ? ' <span class="tag">now</span>' : ''}
                </th>`).join('')}
                <th class="num">Total SP</th>
              </tr></thead>
              <tbody>
                ${pp.people.map(r => `
                  <tr>
                    <td><div class="name-cell">${UI.avatar(r.name)}<span>${UI.esc(r.name)}${r.onRoster ? '' : ' <span class="tag warn" title="Delivered work in these sprints but is not on the team list">not on the team</span>'}</span></div></td>
                    ${pp.columns.map(c => cell(r, c)).join('')}
                    <td class="num"><strong>${drill(r.keys, `${r.name} · all ${pp.columns.length} sprints`, UI.num(r.delivered))}</strong></td>
                  </tr>`).join('')}
                <tr class="total">
                  <td>Sprint total</td>
                  ${pp.columns.map(c => {
    const t = pp.totals[c.sprintId] || {};
    const un = t.unattributed || 0;
    return `<td class="num" title="${UI.esc(un > 0 ? `${UI.num(un)} pts of this was delivered by nobody on the roster` : 'All of this sprint\'s delivery is attributed')}">${drill(t.keys, c.name, UI.num(t.delivered))}${un > 0 ? '<span class="muted" style="font-size:10px">*</span>' : ''}</td>`;
  }).join('')}
                  <td class="num">${UI.num(pp.grandTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          ${pp.unattributed > 0 ? `<p class="muted" style="font-size:11.5px;margin-top:10px">
            * ${UI.num(pp.unattributed)} pts across this window were delivered with no assignee, or by someone not on the team list, so the sprint totals are higher than the rows add up to.
          </p>` : ''}
          <p class="muted" style="font-size:11.5px;margin-top:10px">${UI.esc(pp.caveat)}</p>
        </div>
      </section>`;
  }

  /**
   * The drawer behind one of those numbers.
   *
   * Sorted by points, like every other item drawer in this app, and headed by
   * the two figures the cell was carrying — delivered of committed — so the
   * list explains the number rather than merely accompanying it.
   */
  function ppDrawer(label, keys, items) {
    const list = (keys || []).map(k => items[k]).filter(Boolean)
      .sort((a, b) => (b.points || 0) - (a.points || 0));
    const done = list.filter(i => i.statusCategory === 'done');
    const pts = (a) => a.reduce((t, i) => t + (i.points || 0), 0);
    return `
      <div class="eyebrow"><i></i>Per-person velocity</div>
      <div style="display:flex;align-items:center;gap:10px;margin:6px 0 2px">
        <h2 style="margin:0">${UI.esc(label)}</h2>
        <span class="spacer"></span>
        ${UI.openInJira(list.map(i => i.key))}
      </div>
      <div class="muted" style="margin-bottom:16px">
        ${UI.num(pts(done))} of ${UI.num(pts(list))} pts delivered · ${done.length} of ${list.length} items
      </div>
      ${list.length ? list.map(i => `
        <div style="padding:11px 0;border-bottom:1px solid var(--app-line-soft)">
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
            ${UI.issueKey(i.key)}
            ${UI.statusText(i)}
            <span class="spacer"></span>
            <strong>${i.points == null ? '<span class="tag risk">no estimate</span>' : `${i.points} pts`}</strong>
          </div>
          <div style="font-size:13px">${UI.esc(i.summary || '')}</div>
          ${(i.components || []).length ? `<div class="muted" style="font-size:11.5px;margin-top:3px">${UI.esc(i.components.join(', '))}</div>` : ''}
        </div>`).join('') : '<div class="empty">Nothing here</div>'}`;
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
