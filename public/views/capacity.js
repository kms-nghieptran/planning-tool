/* Capacity view — the sheet's grid, made editable.
   Click a day cell to cycle it; every number above recomputes immediately.

   THREE THINGS THIS SCREEN NOW HAS TO GET RIGHT.

   The roster is PER SPRINT. The rows are the people on this sprint, which is
   not the same set as the team — a closed sprint shows who was assigned the
   work, an open one adds everyone currently on the team, and either can be
   edited. The header says which, because a headcount with no provenance
   invites the question "why is Chau missing" and answers nothing.

   A CLOSED SPRINT IS READ-ONLY. Editing is removed rather than disabled-
   looking: no cycling day cells, no number inputs, no add button. The server
   refuses these writes anyway — this is so nobody tries.

   SCENARIOS sit above the grid, because choosing between plans is the outer
   loop and editing one is the inner loop. */

const CapacityView = (() => {
  const CYCLE = { '1': '0.5', '0.5': '0', '0': 'H', 'H': '1' };
  let data = null, roster = null, ro = false;
  // Guards the one non-idempotent action on this screen — see 'save-scenario'.
  let busy = false;

  async function render(state, mount) {
    // Before the first draw, so the By component grid is built through the
    // lens the sender was looking at rather than redrawn into it afterwards.
    seedPrintLens();
    data = await UI.api(`/api/capacity?team=${encodeURIComponent(state.teamId)}&sprint=${encodeURIComponent(state.sprintId)}`);
    // Recorded from the SAME state the payload was fetched with — see bcState.
    bcState = { teamId: state.teamId, sprintId: state.sprintId };
    const t = data.totals, s = data.settings;
    const raw = state.sprints.find(x => x.id === state.sprintId) || {};
    const sprint = { ...raw, ...((raw.byTeam || {})[state.teamId] || {}) };

    const overCount = data.rows.filter(r => r.flags.some(f => f.code === 'overloaded')).length;
    /* OVER ON WHAT THEY TOOK ON, as against over on what they are holding.
       Counted apart because they have different answers: the first is a
       planning decision to undo before the sprint starts, the second is last
       sprint's tail and moving new work off it will not help. */
    const carryCount = data.rows.filter(r => r.flags.some(f => f.code === 'carry-loaded')).length;
    const carriedPts = data.totals && data.totals.carriedIn;
    const slackCount = data.rows.filter(r => r.flags.some(f => f.code === 'underloaded' || f.code === 'unplanned')).length;

    ro = !!(data.lock && data.lock.readOnly);
    // Fetched together so the screen paints once. Both are small.
    const [rosterInfo, scenarioInfo] = await Promise.all([
      UI.api(`/api/sprint/roster?team=${encodeURIComponent(state.teamId)}&sprint=${encodeURIComponent(state.sprintId)}`).catch(() => null),
      UI.api(`/api/scenarios?team=${encodeURIComponent(state.teamId)}&sprint=${encodeURIComponent(state.sprintId)}`).catch(() => null),
    ]);
    roster = rosterInfo;

    mount.innerHTML = `
      ${ro ? `
      <section class="section">
        <div class="card" style="border-left:3px solid var(--app-fg-3)">
          <div class="eyebrow"><i></i>Closed sprint · read only</div>
          <p style="margin:8px 0 0;font-size:13.5px">${UI.esc(data.lock.reason)}</p>
          <p class="muted" style="font-size:12.5px;margin-top:6px">
            The roster below is who was actually on this sprint — ${UI.esc(rosterWords(data.roster))} — not the
            whole team list. Anyone you entered a leave grid or support percentage for counts, whether or not a
            ticket ended up in their name. That is what the delivery metrics are built from.
          </p>
        </div>
      </section>` : ''}

      ${scenarioBar(scenarioInfo)}

      <section class="section print-hide">
        <div class="section-head">
          <div class="spacer"></div>
          ${/* THE WHOLE PAGE, not one table. The By component sheet below keeps
                its own Export because that sheet is often the only thing he
                wants to send; this is the capacity conversation entire — the
                KPIs, what is out of balance, and who is carrying what — which
                is what goes into a planning meeting.

                Placed at the top beside nothing, the way Active Sprint and
                Overall Coverage place theirs, so the control is in the same
                corner on every screen that has one. */''}
          <button class="btn ghost sm" data-act="cap-export-pdf"
            title="Opens your browser's print dialogue — choose &quot;Save as PDF&quot;">Export PDF</button>
          ${/* TWO ENDINGS FOR THE SAME PAGE: one saves it, the other sends
                it — the same pair, in the same order, as Active Sprint and
                Overall Coverage. */''}
          <button class="btn sm" data-act="email-report"
            title="Render this capacity plan to a PDF and email it with a template you choose">Email the report</button>
        </div>
      </section>

      <section class="section">
        <div class="kpis">
          ${UI.kpi({ label: 'Capacity', value: UI.int(t.predicted), unit: 'pts', foot: `${UI.num(t.capacityHours)} h across ${t.headcount} people`, tone: 'brand', featured: true })}
          ${UI.kpi({ label: 'Committed', value: UI.int(t.planned), unit: 'pts',
    foot: `${t.overBy > 0 ? `<span style="color:var(--risk)">${UI.num(t.overBy)} pts over capacity</span>` : `${UI.num(Math.abs(t.overBy))} pts of headroom`}`
      + (carriedPts > 0 ? ` · ${UI.num(carriedPts)} carried in` : '') })}
          ${UI.kpi({ label: 'Team load', value: UI.pct(t.workloadPct), foot: `Target ${s.workloadUnderPct}–${s.workloadOverPct}%`, tone: t.workloadPct == null ? '' : t.workloadPct > s.workloadOverPct ? 'risk' : t.workloadPct < s.workloadUnderPct ? 'warn' : 'ok' })}
          ${UI.kpi({ label: 'Delivered', value: UI.int(t.actual), unit: 'pts', foot: `${UI.pct(t.goalPct)} of commitment` })}
          ${UI.kpi({ label: 'Available days', value: UI.num(t.availableDays), foot: `${sprint.start ? UI.date(sprint.start) : '—'} → ${sprint.end ? UI.date(sprint.end) : '—'}` })}
        </div>
      </section>

      ${(overCount || slackCount || data.unowned.points) ? `
      <section class="section">
        <div class="card">
          <div class="eyebrow"><i></i>Balance</div>
          <ul class="reasons">
            ${overCount ? `<li class="risk">${overCount} ${overCount > 1 ? 'people are' : 'person is'} over ${s.workloadOverPct}% — move work before the sprint starts, not at the review</li>` : ''}
            ${carryCount ? `<li class="risk">${carryCount} ${carryCount > 1 ? 'people are' : 'person is'} over only because of work carried in — their new scope fits; the tail from last sprint does not</li>` : ''}
            ${slackCount ? `<li class="warn">${slackCount} ${slackCount > 1 ? 'people have' : 'person has'} unused capacity</li>` : ''}
            ${data.unassigned.points ? `<li class="warn">${UI.num(data.unassigned.points)} pts in this sprint have no assignee <button class="btn ghost sm" data-act="show-unassigned">Show ${data.unassigned.count}</button></li>` : ''}
            ${offRosterLine(data)}
          </ul>
        </div>
      </section>` : ''}

      <section class="section">
        <div class="section-head">
          <h2>Member capacity</h2>
          <span class="muted">${UI.esc(data.teamName)} · ${UI.esc(sprint.name || state.sprintId)} · ${rosterWords(data.roster)}</span>
          <div class="spacer"></div>
          <span class="muted">${s.hoursPerDay} h/day · ${s.hoursPerPoint} h/pt · ${s.ceremonyHours} h ceremonies</span>
          ${ro ? '' : '<button class="btn ghost sm" data-act="add-member">Add person</button>'}
          <a class="btn ghost sm" href="/api/export?what=capacity&team=${encodeURIComponent(state.teamId)}&sprint=${encodeURIComponent(state.sprintId)}">Export CSV</a>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Role</th><th>Name</th>
              <th class="num" title="Their hours are not counted toward the team's capacity this sprint. Work already committed to them still counts — see the note under the table">Calc exempt</th>
              <th class="num">Support %</th><th class="num">Days</th><th class="num">Capacity h</th>
              <th class="num">Capacity pts</th><th class="num">Committed</th><th class="num">Done</th>
              <th class="num">Load</th><th style="min-width:120px">Load bar</th><th class="num">Goal</th>
              ${ro ? '' : '<th style="width:1%"></th>'}
            </tr></thead>
            <tbody>
              ${data.rows.map(r => row(r, s, state)).join('')}
              ${removedRow(state)}
              <tr class="total">
                <td colspan="2">Team total</td>
                <td class="num">${t.exempt ? `<span class="muted" title="Not counted in the figures on this row">${UI.int(t.exempt)} exempt</span>` : '—'}</td>
                <td class="num">—</td>
                <td class="num">${UI.num(t.availableDays)}</td>
                <td class="num">${UI.num(t.capacityHours)}</td>
                <td class="num">${UI.int(t.predicted)}</td>
                <td class="num">${UI.num(t.planned)}${carriedMark(t)}</td>
                <td class="num">${UI.num(t.actual)}</td>
                <td class="num pct ${UI.workloadClass(t.workloadPct, s.workloadOverPct, s.workloadUnderPct)}">${UI.pct(t.workloadPct)}</td>
                <td>${UI.bar(t.planned, Math.max(t.predicted, t.planned), UI.workloadClass(t.workloadPct, s.workloadOverPct, s.workloadUnderPct))}</td>
                <td class="num">${UI.pct(t.goalPct)}</td>
                ${ro ? '' : '<td></td>'}
              </tr>
            </tbody>
          </table>
        </div>
        ${t.exempt ? `
          <p class="muted" style="font-size:11.5px;margin:10px 0 0">
            <strong>${UI.int(t.exempt)} ${t.exempt === 1 ? 'person is' : 'people are'} exempt from this sprint's capacity.</strong>
            ${t.autoExempt ? `${t.autoExempt === t.exempt ? 'All of them were' : `${UI.int(t.autoExempt)} of them ${t.autoExempt === 1 ? 'was' : 'were'}`} left out automatically:
              this sprint is closed, and ${t.autoExempt === 1 ? 'that person is' : 'those people are'} not on the team list
              and ${t.autoExempt === 1 ? 'has' : 'have'} no availability recorded here, so there are no real hours to count —
              only the default grid nobody entered. ` : ''}Their hours are out of Capacity h and Capacity pts above. Work already committed to them
            is still counted — it is real work in the sprint, and the burndown would end above zero without it —
            so the team can read as more loaded than its capacity covers. That is the point of the toggle,
            not a side effect of it.
            ${t.coveragePct != null && t.coveragePct < 90 ? `
              <br><strong>Read Workload % with that in mind:</strong> only ${UI.pct(t.coveragePct)} of this sprint's
              committed points sit on someone whose hours are counted, so the percentage is the load against the
              capacity that was actually recorded — not against everyone who worked the sprint.` : ''}
          </p>` : ''}
      </section>

      <section class="section">
        <div class="card">
          <div class="section-head" style="margin-bottom:6px">
            <h3>Availability</h3>
            <span class="muted">Click a day to cycle: full → half → off → holiday</span>
            <div class="spacer"></div>
            <label class="field"><span>Ceremony hours</span><input type="number" step="0.5" id="ceremonyInput" value="${s.ceremonyHours}" style="width:90px"></label>
          </div>
          <div style="overflow-x:auto">
            <table style="width:auto">
              <tbody>
                <tr><td style="border:none;padding-bottom:2px"></td><td style="border:none;padding-bottom:2px">${dayHead(data.days)}</td><td style="border:none"></td></tr>
                ${data.rows.map(r => `
                  <tr>
                    <td style="border:none;padding-right:14px"><div class="name-cell">${UI.avatar(r.name)}<span>${UI.esc(r.name)}</span></div></td>
                    <td style="border:none">${dayRow(r, data.availability[r.memberId] || [], data.days)}</td>
                    <td style="border:none;padding-left:12px" class="muted">${UI.num(r.availableDays)} d · ${UI.num(r.capacityHours)} h</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <div class="legend">
            <span><i style="background:transparent"></i>Working day</span>
            <span><i style="background:var(--day-half)"></i>Half day</span>
            <span><i style="background:var(--day-off)"></i>Off</span>
            <span><i style="background:var(--day-hol)"></i>Holiday</span>
            <span><i style="background:var(--day-we)"></i>Weekend</span>
          </div>
        </div>
      </section>

      <section class="section grid-2">
        <div class="card">
          <h3>Work mix this sprint</h3>
          <div class="sub">What the committed points are actually going on</div>
          ${UI.mixBar(data.mix, state.categories)}
          ${data.mixVsTarget.filter(m => m.status !== 'ok' && m.share > 0).length ? `
            <ul class="reasons">
              ${data.mixVsTarget.filter(m => m.status !== 'ok' && m.share > 0).map(m => `<li class="${m.status === 'over' ? 'warn' : ''}">${UI.esc((state.categories[m.category] || {}).label || m.category)} at ${m.share}% vs target ${m.min}–${m.max}%</li>`).join('')}
            </ul>` : ''}
        </div>
        <div class="card">
          <h3>Load balance</h3>
          <div class="sub">Committed points against each person's capacity</div>
          ${Charts.load(data.rows, { over: s.workloadOverPct })}
        </div>
      </section>

      ${data.calibration ? `
      <section class="section">
        <div class="card">
          <div class="eyebrow"><i></i>Calibration</div>
          <p style="margin:8px 0 0;font-size:13px">
            History says this team spends <strong>${data.calibration.value} h per delivered point</strong>, against the
            <strong>${s.hoursPerPoint} h</strong> currently configured — ${UI.esc(data.calibration.basis)} over ${data.calibration.sprints} sprints.
            ${Math.abs(data.calibration.value - s.hoursPerPoint) / s.hoursPerPoint > 0.15
              ? `<button class="btn sm" data-act="apply-calibration" style="margin-left:8px">Use ${data.calibration.value}</button>`
              : '<span class="muted">Close enough — no change needed.</span>'}
          </p>
        </div>
      </section>` : ''}

      <section class="section">
        <div class="card">
          <h3>Sprint goal / notes</h3>
          <div class="sub">Kept with the plan, not in a chat thread</div>
          <textarea id="sprintNote" rows="3" placeholder="What this sprint is for…">${UI.esc(data.note)}</textarea>
          <div style="margin-top:8px"><button class="btn sm" data-act="save-note">Save note</button></div>
        </div>
      </section>

      ${byComponentSection(data.byComponent, sprint)}

      ${/* The same table the Active sprint screen shows, from the same helper.
           Balancing a sprint ends in the tickets — you move work between people
           by picking specific items — and having to change screens to see them
           meant holding the grid in your head while you looked. Last on the
           page, because you come to it after the numbers, and sortable like
           every other grid, so "who has the big ones" is one click. */ ''}
      ${/* POINTS ARE EDITABLE HERE, and an edit goes to real Jira. This is
           the screen where you balance a sprint against people's capacity,
           which is exactly when a wrong estimate gets noticed — and having to
           leave for Jira to fix it is how it stays wrong.

           Never on a closed sprint: the server refuses those writes, and a
           box that always fails is worse than no box. `editPoints` is opt-in
           per caller, so the Active sprint screen keeps its read-only
           table rather than silently becoming writable too. */ ''}
      ${UI.itemsTable(data.items, state, {
        sub: UI.esc(sprint.name || state.sprintId),
        editPoints: !ro,
        editDue: !ro,
        /* The same two anchors the Active sprint screen uses, both off the
           payload: "late" is against the sprint the work was committed to,
           "overdue" is against a today the server sent — never the browser's
           own clock, which no test can pin and which changes overnight with
           nothing else changing. */
        sprintEnd: data.sprintEnd || sprint.end,
        today: data.today,
      })}
    `;

    wire(state, mount);
  }

  /* ── "BY COMPONENT": THE SHEET HE KEEPS BY HAND ───────────────────────
     Per ranked suite, what is still to do in each tool and what this sprint
     has taken on. The two halves are one table because neither is worth much
     alone: "11 in Maintenance" is a fact, "11 in Maintenance and 2 planned"
     is a decision.

     BOTH HALVES COUNT EPICS (test cases). A row has to read left to right in
     one unit or the comparison it exists for is not available — see the long
     note in lib/prioritization.js for why the planned half resolves Jira
     items to the suites behind them rather than counting the tickets.

     THE PLANNED COLUMNS ARE NAMED AFTER THE SELECTED SPRINT, from the
     payload rather than the picker: the header must name the sprint the
     numbers actually came from, and those are two different facts the moment
     a request is in flight. */
  const BACKLOG_SHORT = { maintenance: 'Maint', ready: 'Ready', blocked: 'Blocked' };
  /* THE PLANNED PAIR COMES OFF THE PAYLOAD, not a constant in this file. The
     drawer that opens from one of these cells titles itself with the same
     label, and it gets it from the model — a second list here is how the
     header reads "New build" over a drawer headed something else. */
  const plannedCols = (d) => (d && d.plannedCols) || [];

  /* THE RANKED LIST IS PORTFOLIO-WIDE AND MOST TEAMS TOUCH A SLICE OF IT.
     Ruby's sheet has 129 ranked rows and something in about twenty of them;
     drawing all 129 by default buries the twenty that need reading under a
     hundred rows of dashes. So the clear rows are folded away and COUNTED —
     the count is the point, because "83 of your priorities have nothing
     against them this sprint" is itself a finding — and one click brings
     them back. Folded, never dropped: a ranked suite with nothing against it
     is finished or forgotten, and that is a question only he can answer. */
  let bcShowAll = false;
  /* THE FAMILY LENS. null is "All" and is not a family key, so a family that
     ever gets named `null` cannot silently mean "no filter". The chips are a
     LENS, not a scope: they narrow what is drawn out of a payload that was
     already counted, so switching one is a redraw of this section and never a
     refetch — the same distinction the Prioritization page draws between its
     chips and its team picker. */
  let bcFamily = null;
  /* THE SCOPES THIS SHEET WAS BUILT FOR, kept beside the payload. The export
     link is rendered from inside the section, which is also redrawn from a
     click handler — so the team and sprint have to be reachable without a
     `state` argument threaded through every one of these helpers. Set once
     per render, from the same state the payload was fetched with, so the file
     a reader downloads is the table they are looking at. */
  let bcState = { teamId: '', sprintId: '' };

  /**
   * THE LENS TRAVELS INTO THE PRINTED PAGE.
   *
   * The two exports beside this table are deliberately opposite: the CSV
   * carries every row and lets the reader filter in the spreadsheet, and the
   * PDF is a picture of the table AS IT STANDS — chips, fold and all — because
   * that is what "print what I am looking at" means.
   *
   * The on-screen Export PDF honoured that, because it prints the live page.
   * THE EMAILED PDF NEVER COULD: headless Chrome opens this route in a fresh
   * browser where `bcFamily` is null and `bcShowAll` is false, so a plan
   * filtered to the PS family arrived showing all 98 components. The reader
   * gets a document that is not the one that was sent — and, as with the
   * coverage selection before it, the only person placed to notice is the
   * client.
   *
   * SEEDED ONLY IN PRINT MODE, and only once. A `?family=` left in the address
   * bar of the normal app would otherwise re-win on every redraw and fight the
   * chips, which reads as the page refusing to change.
   */
  let bcSeeded = false;
  function seedPrintLens() {
    if (bcSeeded) return;
    bcSeeded = true;
    try {
      const q = new URLSearchParams(location.search || '');
      if (q.get('print') !== '1') return;
      /* AN ABSENT PARAMETER IS NOT "ALL". `family=` empty means the sender was
         on All and the picture should show all; no `family` key at all means
         the same. Both land on null, which is what null means here. */
      const fam = (q.get('family') || '').trim();
      bcFamily = fam || null;
      bcShowAll = q.get('showall') === '1';
    } catch { /* the sheet still prints, just unfiltered */ }
  }

  function byComponentSection(d, sprint) {
    if (!d) return '';
    const name = (d.sprint && d.sprint.label) || sprint.name || '';
    const tools = d.tools || [];
    const buckets = d.backlogBuckets || [];
    const planned = plannedCols(d);
    const all = (d.rows || []).filter(r => bcFamily == null || r.familyKey === bcFamily);
    const rows = bcShowAll ? all : all.filter(r => !r.empty);
    const hidden = all.length - rows.length;

    return `
      <section class="section" data-bycomp>
        <div class="card">
          <h3>By component</h3>
          <div class="sub">The whole backlog against what ${UI.esc(name || 'this sprint')} picked up · one row per ranked suite</div>
          ${byComponentFamilies(d)}
          ${byComponentScope(d, name, hidden)}
          <div class="table-wrap">
            <!-- NOT SORTABLE, for the same reason the Prioritization grid is
                 not: UI.sortable maps header cells to body columns by index
                 and this header's first row is four cells wide because of the
                 colspans, so every column it offered would sort by the wrong
                 one. The order here is the answer — P1 first, then by name. -->
            <table class="pz bycomp" data-nosort>
              <thead>
                <tr>
                  <th rowspan="3">Component</th>
                  <th rowspan="3">Priority</th>
                  ${tools.map((t, ti) => `
                    <th class="num tool-start tool-head band-${ti % 2 ? 'b' : 'a'}" colspan="${buckets.length + planned.length}"
                      ><i class="pz-chip" style="background:${t.color}"></i>${UI.esc(t.label)}</th>`).join('')}
                  <th rowspan="3" class="tool-start note-col">Notes</th>
                </tr>
                <tr>
                  ${tools.map((t, ti) => `
                    <th class="num tool-start sub band-${ti % 2 ? 'b' : 'a'}" colspan="${buckets.length}"
                    ${/* JUST "BACKLOG". The "· all teams" qualifier was there
                          because this column counts across every team while
                          the rest of the screen is about one — but it is the
                          third place that is said on this grid: the footnote
                          under the table says it in a sentence, and the
                          column's own tooltip says it in full. Three
                          statements of one caveat read as three different
                          caveats, and the header is the one with no room to
                          explain itself. The tooltip stays. */''}
                        title="${UI.esc(backlogTitle(d))}">Backlog</th>
                    <th class="num tool-start sub band-${ti % 2 ? 'b' : 'a'}" colspan="${planned.length}"
                        title="Suites this sprint has work against">${UI.esc(name || 'Sprint')} Planned</th>`).join('')}
                </tr>
                <tr>
                  ${tools.map((t, ti) => `
                    ${buckets.map((b, i) => `
                      <th class="${cellCls(b.key, i, ti)} sub" title="${UI.esc(b.label)}"
                        ><i class="pz-chip" style="background:${b.color}"></i>${UI.esc(BACKLOG_SHORT[b.key] || b.label)}</th>`).join('')}
                    ${planned.map((c, i) => `
                      <th class="${cellCls(`plan-${c.key}`, i, ti)} sub" title="${UI.esc(c.title)}">${UI.esc(c.label)}</th>`).join('')}`).join('')}
                </tr>
              </thead>
              <tbody>
                ${rows.length
    ? rows.map(r => byComponentRow(r, tools, buckets, planned)).join('')
    : `<tr><td colspan="${2 + tools.length * (buckets.length + planned.length) + 1}" class="muted" style="padding:14px">
                        ${all.length
      ? `All ${all.length} ranked components are clear this sprint — nothing in either backlog and nothing planned.`
      : 'No components have a priority yet — set them on the Prioritization screen and they appear here.'}</td></tr>`}
              </tbody>
              ${rows.length > 1 ? byComponentFoot(rows, tools, buckets, planned) : ''}
            </table>
          </div>
          ${byComponentNotes(d)}
        </div>
      </section>`;
  }

  /** One cell's classes — the band and the colour both travel with the column. */
  function cellCls(key, i, toolIndex) {
    return [
      'num',
      key.startsWith('plan-') ? `plan ${key}` : `cov-${key}`,
      `band-${toolIndex % 2 ? 'b' : 'a'}`,
      i === 0 ? 'tool-start' : '',
    ].filter(Boolean).join(' ');
  }

  /* A NUMBER THAT OPENS THE SET IT COUNTED — IN A DRAWER, not straight to
     Jira. The link was an anchor and it was the wrong door: you click a 16 to
     find out WHICH sixteen, and getting the answer meant a tab switch, a Jira
     page load and a trip back. The drawer answers in place — key, summary,
     status, what is blocking it — and carries its own "Open in Jira" for when
     that is actually what you wanted. Same reasoning, and the same
     `UI.drillNumber` control, as every other number on the Coverage and
     Prioritization screens; this table was the odd one out.

     A REAL <button>, not a styled span: this is an action, so it has to be
     reachable by keyboard and announce itself as one. `UI.drillNumber`
     handles that.

     ZERO STAYS A DASH and does not open. An empty drawer under a zero is a
     round trip to learn nothing. */
  function drillNum(n, r, tool, cell) {
    return UI.drillNumber(n, { act: 'bc-epics', row: r.component, tool, cell }, { zero: '—' });
  }

  /* ── THE WARNING BESIDE A PLANNED NUMBER ──────────────────────────────
     A planned column counts SUITES with work in this sprint. It says nothing
     about whether that work can start — and on this board it very often
     cannot: an item sits in Refinement, or its Automation Status reads
     Blocked. "12 planned" and "12 planned, 5 of them stuck" are different
     sprints, and only the first was on screen.

     A BUTTON, NOT AN ICON. It opens the list, so it has to be reachable by
     keyboard and announced as one — the same rule `UI.drillNumber` follows
     for the numbers it sits beside.

     NOTHING BLOCKED, NOTHING DRAWN. A marker that is always there is one
     nobody reads; the whole value of this is that it is unusual. */
  function stuckMark(r, tool, kind) {
    const keys = ((r[tool] || {}).stuck || {})[kind] || [];
    if (!keys.length) return '';
    const n = keys.length;
    return `<button type="button" class="stuck-mark" data-act="bc-epics" data-n="${n}"
      data-row="${UI.esc(r.component)}" data-tool="${UI.esc(tool)}" data-cell="stuck-${UI.esc(kind)}"
      title="${UI.esc(`${n} of the ${kind === 'build' ? 'new build' : 'maintenance'} work planned here cannot be started — in Refinement, or marked Blocked for automation`)}"
      aria-label="${UI.esc(`Show the ${n} blocked ${n === 1 ? 'item' : 'items'} planned against ${r.component}`)}">!</button>`;
  }

  /**
   * PART OF THIS QUEUE IS NOT REALLY QUEUED.
   *
   * A Maintenance count is read as "suites waiting to be fixed", and some of
   * them are not waiting for anything: the epic has been retired with an
   * `obsolete` label. On his board two of the 425 Maintenance epics are retired
   * and only the label says so — nothing in the number, and nothing in the
   * drawer behind it, distinguished them.
   *
   * THE OTHER HALF OF THE ASK IS THE BLOCKED COLUMN ITSELF. "Automation Status
   * = Blocked" is what puts an epic in that column, so it can never be true of
   * a Maintenance row and is true of every Blocked row — see the note in
   * `prioritization.js` at the point the flag is decided.
   *
   * The same `!` as the Active sprint's In flight marker and the planned
   * columns' stuck marker, sitting beside its number rather than becoming a
   * column of its own — it qualifies that count, it is not more work.
   *
   * ON ALL THREE BACKLOG COLUMNS, THOUGH ONLY MAINTENANCE WAS ASKED FOR.
   * Measured against his store before choosing, and on Maintenance this marker
   * draws NOTHING: an epic labelled obsolete either kept a real Automation
   * Status — and every one of his reads Blocked — or has no status at all, in
   * which case `bucketOf` answers "obsoleted" and it is not in the backlog to
   * begin with. Today that is 0 retired in Maintenance, 0 in Ready, 8 in
   * Blocked. Maintenance-only would have shipped an indicator nobody could
   * ever see, on the one column where the thing it looks for cannot land. The
   * condition is the same in all three, so it is asked in all three;
   * restricting it back to what was asked for is this one list.
   *
   * NOTHING FLAGGED, NOTHING DRAWN — so the empty columns stay clean.
   */
  const FLAG_COLS = ['maintenance', 'ready', 'blocked'];
  function flagMark(r, tool, bucketKey) {
    if (!FLAG_COLS.includes(bucketKey)) return '';
    const keys = ((r[tool] || {}).flagged || {})[bucketKey] || [];
    if (!keys.length) return '';
    const n = keys.length;
    const label = (BACKLOG_SHORT[bucketKey] || bucketKey);
    /* `data-n`, FOR THE SAME REASON THE PLANNED MARKER CARRIES IT. This
       control's text is "!", and the click handler falls back to scraping
       digits off a control's own text — which yields 0 here and quietly
       disables the check that tells him the cell was redrawn while the drawer
       was opening. */
    return `<button type="button" class="stuck-mark" data-act="bc-epics" data-n="${n}"
      data-row="${UI.esc(r.component)}" data-tool="${UI.esc(tool)}" data-cell="flag-${UI.esc(bucketKey)}"
      title="${UI.esc(`${n} of the ${label} suites here ${n === 1 ? 'has' : 'have'} been retired — labelled obsolete in Jira, so ${n === 1 ? 'it is' : 'they are'} queued but not intended to be worked`)}"
      aria-label="${UI.esc(`Show the ${n} retired ${label} ${n === 1 ? 'suite' : 'suites'} in ${r.component}`)}">!</button>`;
  }

  /**
   * WHAT THE THREE COLUMNS DO NOT COUNT — NOT DRAWN ON THE ROW.
   *
   * `coverage.BUCKETS` has seven buckets; this table draws three, plus the
   * planned pair. Automated is the fourth and nobody misses it — this is a
   * backlog table. The other three go missing silently: an epic that is N/A for
   * automation, retired with an `obsolete` label, or with no Automation Status
   * set at all is indistinguishable from backlog in Jira and appears in no
   * column here. PS_Evolve_RN is the case that found it: 94 epics, 40 of them
   * retired, and the row read "27 in backlog" with nothing saying where the
   * rest went.
   *
   * IT WAS A TAG ON THE ROW NAME AND HE ASKED FOR IT OFF. On his board 28 of
   * 128 components carry leftovers, so the column of names grew a second pill
   * on a quarter of its rows — and the thing that column is for is reading
   * component names down the page.
   *
   * THE FIGURE STAYS ON THE SCOPE LINE, where one number qualifies the backlog
   * total beside it rather than 28 of them interrupting the names. That is
   * where the original complaint is actually answered: a backlog figure with
   * 549 epics missing from behind it, and nothing anywhere saying so, is the
   * number somebody checks against Jira once and then stops believing.
   *
   * The model still counts them and `out-all` still lists them, so turning the
   * per-row tag back on is this function and one call below.
   */
  function outsideTag() { return ''; }

  function byComponentRow(r, tools, buckets, planned) {
    // Every key the row counted, both halves, for the component name itself.
    // The NAME still goes to Jira: it is the whole suite, which is a search
    // rather than one cell's answer, and it is what you would search for.
    const all = [];
    for (const t of tools) {
      for (const k of Object.keys(r[t.key].keys || {})) all.push(...r[t.key].keys[k]);
    }
    return `
      <tr${r.empty ? ' class="untracked"' : ''}>
        <td>
          ${UI.componentLink(r.component, all, { what: `${r.component} epics` })}
          ${r.empty ? ' <span class="tag" title="No backlog in either tool and nothing planned this sprint">clear</span>' : ''}
          ${/* THE ROW'S OWN COUNT, distinct across both tools and both kinds —
                one Story blocking a suite that TrueTest and KSE both cover is
                one blocked item. Read-only: the cell markers are where you
                open the list, and a third way in would be a third chance for
                the number and the list to disagree. */''}
          ${r.stuck ? `<span class="tag risk" title="${UI.esc(`${r.stuck} ${r.stuck === 1 ? 'item' : 'items'} planned against this component cannot be started — in Refinement, or marked Blocked for automation`)}">${r.stuck} blocked</span>` : ''}
          ${outsideTag(r)}
        </td>
        <td class="prio-cell"><span class="tag prio-tag prio-${UI.esc(r.priorityKey)}"
          title="${UI.esc(`${r.priorityLabel} — ${r.priorityName}`)}">${UI.esc(r.priorityLabel)}</span></td>
        ${tools.map((t, ti) => `
          ${buckets.map((b, i) => `
            <td class="${cellCls(b.key, i, ti)}">${drillNum(r[t.key][b.key], r, t.key, b.key)}${flagMark(r, t.key, b.key)}</td>`).join('')}
          ${planned.map((col, i) => `
            <td class="${cellCls(`plan-${col.key}`, i, ti)}">${drillNum(r[t.key][col.key], r, t.key, col.key)}${stuckMark(r, t.key, col.key)}</td>`).join('')}`).join('')}
        ${byComponentNote(r)}
      </tr>`;
  }

  /* THIS NOTE IS THE SPRINT'S, and it is NOT the one the Prioritization screen
     edits. That was the arrangement until now and the reasoning was sound as
     far as it went: "waiting on the migration" is a fact about the suite, not
     about this sprint, and two boxes holding two versions of it is how the one
     you are not looking at goes stale.

     WHAT IT MISSED IS WHAT ACTUALLY GETS TYPED HERE. Fourteen notes had been
     written into the global field from this sheet, and they read: "2 cases
     remaining; both will be picked up for implementation in the sprint", "plan
     to build 3 new TT cases based on the current available capacity". Those are
     not facts about a suite. They are this sprint's plan, sitting in a field
     that will still be showing them in March.

     So there are two boxes now, and they are different questions rather than
     two versions of one. The column beside a row of THIS SPRINT's numbers gets
     this sprint's note.

     A CLOSED SPRINT DOES NOT MAKE IT READ-ONLY, unlike the points and due date
     above. Those write to Jira and rewrite a finished sprint's history; this is
     plan data, and noticing something about PS_iGO_NLG while reading a closed
     sprint is a perfectly good reason to write it down.

     NO SPRINT, NO BOX. Without one there is nothing to key a note to, and a box
     that accepted text it could not file would lose it on blur. */
  function byComponentNote(r) {
    const v = r.sprintNote || '';
    const key = (data.byComponent || {}).sprintNoteKey || '';
    if (!key) {
      return `<td class="note-col tool-start"><span class="muted" style="font-size:11.5px"
        title="A note here belongs to a sprint, and none is selected">—</span></td>`;
    }
    /* THE GLOBAL NOTE IS STILL REACHABLE, as the box's tooltip rather than a
       second column. It is the context you want while writing this sprint's
       note — "no longer supported", "client asked us to hold" — and having to
       open another screen to remember it is how the two end up contradicting
       each other. Read-only here; the Prioritization screen owns it. */
    const global = r.note ? `Prioritization note: ${r.note}` : 'Add a note for this sprint…';
    return `
      <td class="note-col tool-start">
        <textarea class="note" rows="1" maxlength="${Number((data.byComponent || {}).noteMax) || 600}"
          data-bc-note="${UI.esc(r.component)}" data-was="${UI.esc(v)}"
          title="${UI.esc(global)}"
          placeholder="${r.note ? 'This sprint…' : 'Add a note…'}">${UI.esc(v)}</textarea>
      </td>`;
  }

  /* SAVED ON BLUR, and only when it actually changed — clicking into a box
     and out again is not an edit, and treating it as one writes an audit
     entry per glance. The row object is updated in place as well as the
     dataset, so the redraw a chip click causes does not resurrect the old
     text. */
  async function saveByComponentNote(box) {
    const name = box.dataset.bcNote;
    const was = box.dataset.was == null ? '' : box.dataset.was;
    const value = String(box.value || '').trim();
    if (value === was.trim()) return;
    box.disabled = true;
    try {
      /* THE TEAM AND SPRINT GO WITH IT, and the server turns them into the
         storage key. The browser is not trusted to name the key itself: it is
         the Jira sprint behind the selected row, and a client free to invent
         one could write a note nothing will ever read back. */
      await UI.jsonPut('/api/sprint-note', {
        team: bcState.teamId, sprint: bcState.sprintId, component: name, note: value,
      });
      box.dataset.was = value;
      box.value = value;
      const r = ((data.byComponent || {}).rows || []).find(x => x.component === name);
      if (r) r.sprintNote = value || null;
      UI.toast(value ? `${name} — note saved for this sprint` : `${name} — note cleared`);
    } catch (err) {
      // Put the old text back rather than leaving the box showing something
      // that was refused: a box that keeps what you typed reads as saved.
      box.value = was;
      UI.toast(err.message, true);
    } finally {
      box.disabled = false;
    }
  }

  /* SUMMED FROM THE ROWS ON SCREEN, never from the payload's own totals.
     The clear rows are folded away by default, so `d.totals.components` says
     129 under a table showing twenty — every individual figure on the page
     correct, and the one line a reader actually quotes in a status update
     wrong. The same rule, for the same reason, as the Prioritization foot.

     THE COLUMN SUMS ARE THE ONE PART THAT CANNOT DIFFER TODAY — a folded row
     is zero in every cell by definition, so summing the shown rows and
     summing the payload give the same figures, and no test can tell the two
     apart. The COUNT can and does differ, which is why it is checked. Summing
     from the rows anyway, because the day the fold criterion becomes anything
     other than "all zero" — say, "below a threshold" — the payload version
     starts lying and nothing here would say so. */
  function byComponentFoot(rows, tools, buckets, planned) {
    const sum = (tool, k) => rows.reduce((n, r) => n + r[tool][k], 0);
    return `
      <tfoot><tr>
        <td><strong>${rows.length} component${rows.length === 1 ? '' : 's'}</strong></td>
        <td class="muted">all levels</td>
        ${tools.map((tool, ti) => `
          ${buckets.map((b, i) => `<td class="${cellCls(b.key, i, ti)}"><strong>${sum(tool.key, b.key) || '<span class="muted">—</span>'}</strong></td>`).join('')}
          ${planned.map((c, i) => `<td class="${cellCls(`plan-${c.key}`, i, ti)}"><strong>${sum(tool.key, c.key) || '<span class="muted">—</span>'}</strong></td>`).join('')}`).join('')}
        <td class="tool-start"></td>
      </tr></tfoot>`;
  }

  /* ── THE FAMILY CHIPS ─────────────────────────────────────────────────
     PS is client delivery, R&D is product regression, KAT is the shared
     framework — three genuinely different conversations that happen to share
     a table. "All" is first and is the default, because the unfiltered sheet
     is the one you arrive at.

     EVERY DECLARED FAMILY GETS A CHIP, including one with no rows this
     sprint: a filter whose buttons appear and disappear as the data moves is
     one you cannot learn. An empty family is drawn disabled and says zero
     rather than vanishing, which is itself the answer to "what is R&D doing
     this sprint".

     THE CHIP COUNTS WHAT THE TABLE WILL DRAW. The clear rows fold away by
     default, so the chip reads the `busy` count while they are folded and the
     full count once they are shown — otherwise "R&D 41" sits above a table
     with three rows in it and one of the two numbers is a lie. */
  function byComponentFamilies(d) {
    const fams = d.families || [];
    if (!fams.length) return '';
    /* THE SAME `.chip` / `.active` markup the Prioritization page uses, on
       purpose. These two screens sit next to each other in the same head and
       a filter that looks different on one of them reads as a different
       control. */
    const n = (f) => (bcShowAll ? f.count : f.busy);
    const total = fams.reduce((t, f) => t + n(f), 0);
    return `
      <div class="field" style="margin:6px 0 2px"><span>Family</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="chip${bcFamily == null ? ' active' : ''}" data-bc-family=""
            title="Every ranked suite on this sheet">All <strong>${UI.int(total)}</strong></button>
          ${fams.map(f => `<button class="chip${bcFamily === f.key ? ' active' : ''}${n(f) ? '' : ' muted'}"
            data-bc-family="${UI.esc(f.key)}" title="${UI.esc(f.label)}"${n(f) || bcFamily === f.key ? '' : ' disabled'}
            >${UI.esc(f.short)} <strong>${UI.int(n(f))}</strong></button>`).join('')}
        </div>
      </div>`;
  }

  /* ONE SECTION, REDRAWN IN PLACE. `App.refresh()` would refetch the capacity
     payload, rebuild the grid and lose the item table's filters — for a lens
     that changes nothing but which rows of one table are drawn. Both the
     family chips and the fold are lenses over a payload that is already in
     hand, so neither costs a request. */
  function redrawByComponent(state, mount) {
    const host = mount.querySelector('[data-bycomp]');
    if (!host) return;
    const raw = state.sprints.find(x => x.id === state.sprintId) || {};
    host.outerHTML = byComponentSection(data.byComponent, { ...raw, ...((raw.byTeam || {})[state.teamId] || {}) });
  }

  /* ONE CELL, LISTED.
     The server re-runs the sheet and reads that cell's own key list, so the
     drawer cannot list a set the number did not count — see the note on
     `sprintComponentCell`. The count is sent back and compared against what
     the button still says: they can differ if the table was redrawn while the
     drawer was opening, and saying so is better than showing a heading that
     quietly disagrees with the page behind it. */
  /* THE THREE REASONS, IN WORDS, and only the ones that are actually there —
     "0 N/A" in a sentence is noise, and the reader has to count it before
     discarding it. The labels are the Coverage screen's own, so a pile called
     Obsoleted there is not called something else here. */
  const OUTSIDE_WORDS = {
    obsoleted: 'retired (labelled obsolete)',
    none: 'no Automation Status set',
    na: 'N/A for automation',
  };
  function outsideSplit(by) {
    const parts = Object.keys(OUTSIDE_WORDS)
      .filter(k => Number((by || {})[k]) > 0)
      .map(k => `${UI.int(by[k])} ${OUTSIDE_WORDS[k]}`);
    if (!parts.length) return 'none';
    if (parts.length === 1) return parts[0];
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  }

  async function openByComponentCell(state, ds, shown) {
    const qs = [
      `team=${encodeURIComponent(state.teamId)}`,
      `sprint=${encodeURIComponent(state.sprintId)}`,
      `row=${encodeURIComponent(ds.row)}`,
      `tool=${encodeURIComponent(ds.tool)}`,
      `cell=${encodeURIComponent(ds.cell)}`,
    ].join('&');
    UI.drawer('<div class="empty">Reading…</div>');
    try {
      const r = await UI.api(`/api/capacity/bycomponent/epics?${qs}`);
      const off = shown && shown !== r.count;
      /* THE DRAWER SAYS WHICH POPULATION IT IS LISTING. The two halves are
         counted over different scopes, and a drawer that explained them the
         same way would make the backlog's extra rows look like a bug. */
      const what = r.outside
        /* IT SAYS WHY THE COLUMNS DO NOT ADD UP, and gives the split, because
           "retired" and "nobody set the field" are two different jobs for two
           different people and a single total hides which one this is. */
        ? `Epics on this component that none of the three backlog columns counts, across`
          + ` ${UI.esc(((r.scopes || {}).backlog || {}).label || 'all teams')}: ${outsideSplit(r.outsideBy)}.`
          + ' They look like backlog in Jira, which is why they are called out here rather than dropped.'
          + ' The reason is on each row.'
        : r.flagged
        /* A SUBSET, AND IT SAYS SO. Two rows under a column reading 425 has to
           explain itself immediately or it reads as the column being wrong. */
        ? `Of the ${UI.esc(String(r.label).split('·').pop().replace(/ — retired$/, '').trim())} queue`
          + ` across ${UI.esc(((r.scopes || {}).backlog || {}).label || 'all teams')}, the suites that have been`
          + ' retired — labelled obsolete in Jira, so they are sitting in the queue but nobody intends to work'
          + ' them again. The label is on each row.'
        : r.half === 'backlog'
          ? `Across ${UI.esc(((r.scopes || {}).backlog || {}).label || 'all teams')}, with no work in an active sprint.`
          + ' Excluded components and the coverage allow-list are already applied.'
          : r.stuck
            ? `Planned in ${UI.esc((r.sprint && r.sprint.label) || 'this sprint')} and not startable —`
            + ' each one is in Refinement, or its Automation Status reads Blocked.'
            : `Reached from the work ${UI.esc(((r.scopes || {}).planned || {}).label || 'this team')}`
            + ` planned in ${UI.esc((r.sprint && r.sprint.label) || 'this sprint')}.`;
      UI.drawer(UI.drillDrawer({
        title: `${ds.row} — ${r.label}`,
        meaning: `${UI.int(r.count)} ${UI.esc(r.kind === 'item' ? 'item' : String(r.scope || 'epic').toLowerCase())}${r.count === 1 ? '' : 's'}. ${what}`
          + (off ? ` The cell says ${UI.int(shown)} — it has been redrawn since this was opened.` : ''),
        keys: r.epics.map(e => e.key),
        catalogue: Object.fromEntries(r.epics.map(e => [String(e.key).toUpperCase(), e])),
        state,
      }));
    } catch (err) {
      UI.drawer(`<div class="empty">Could not read the ${UI.esc(ds.cell)} epics — ${UI.esc(err.message)}</div>`);
    }
  }

  /* THE SCOPE SITS ON THE LINE THE NUMBERS ARE ON. A team-scoped backlog read
     as a portfolio one once already on the Prioritization screen; the fix
     there was to put the scope beside the figures rather than in a picker at
     the top of the page, and this table inherits it. */
  /** The payload's own statement of who each half was counted over. */
  const s = (d) => (d && d.scopes) || {};

  function byComponentScope(d, name, hidden) {
    const x = d.backlogExcludes || {};
    const t = d.totals || {};
    return `
      <div class="muted" style="display:flex;align-items:center;gap:10px;margin:2px 0 8px;font-size:12px;flex-wrap:wrap">
        <!-- EACH FIGURE CARRIES ITS OWN SCOPE. One team name at the front of
             this line, with two numbers after it, reads as though both were
             that team's — and the backlog is the whole portfolio. So the
             scope is attached to the number it belongs to, which is the same
             fix the Prioritization screen made when a team-scoped 9 was read
             as a portfolio 25. -->
        <span>${UI.int(t.backlog || 0)} in backlog
          <strong>${UI.esc((s(d).backlog || {}).label || 'all teams')}</strong></span>
        <!-- AND WHAT THE THREE COLUMNS DO NOT COUNT, on the same line as the
             number it qualifies. A backlog figure with 589 epics missing from
             behind it is the kind of number somebody checks once against Jira
             and then stops believing. The per-component breakdown is the tag on
             each row; this is so the size of the pile is visible without
             hunting for it. -->
        ${(t.out || 0) ? `<span title="${UI.esc(`Epics on ranked components that none of the three backlog columns counts — ${outsideSplit(t.outside)}. Each row's own share is the tag beside its name.`)}">· ${UI.int(t.out)} outside it</span>` : ''}
        <span>· ${UI.int(t.planned || 0)} planned by
          <strong>${UI.esc((s(d).planned || {}).label || 'this team')}</strong>
          in ${UI.esc(name || 'this sprint')}</span>
        ${hidden ? `<button class="btn ghost sm" data-act="bc-show-all"
          title="A ranked suite with no backlog and nothing planned. Folded away, not dropped — it is either finished or forgotten."
          >${UI.int(hidden)} clear ${hidden === 1 ? 'suite' : 'suites'} hidden — show</button>` : ''}
        ${bcShowAll && (d.rows || []).some(r => r.empty)
    ? '<button class="btn ghost sm" data-act="bc-show-busy">hide the clear ones</button>' : ''}
        <span class="spacer"></span>
        <span title="${UI.esc(scopeTitle(x))}">backlog excludes ${UI.int(x.epics || 0)} ${(x.epics === 1 ? 'suite' : 'suites')} in flight
          in ${UI.int((x.sprints || []).length)} active sprint${(x.sprints || []).length === 1 ? '' : 's'}</span>
        <!-- EARMARKED, AND STILL COUNTED ABOVE. Reported rather than
             subtracted: taking these out would make the backlog shrink every
             time somebody fills in a future sprint, which is the opposite of
             what filling one in means. -->
        ${(d.queuedAhead || {}).epics ? `<span title="${UI.esc(queuedTitle(d.queuedAhead))}"
          >· ${UI.int(d.queuedAhead.epics)} of them already queued for a later sprint</span>` : ''}
        <!-- EPICS WITH NO JIRA TEAM AT ALL. "All teams" has to include the
             ones nobody assigned a team to, or the queue hides part of
             itself — it hid 295 across 16 ranked suites. Counted out loud,
             because it is also the one number on this line a reader can act
             on: an untriaged epic is a triage job. -->
        ${((d.scopes || {}).backlog || {}).noTeam ? `<span title="${UI.esc(noTeamTitle(d))}"
          >· ${UI.int(d.scopes.backlog.noTeam)} carry no Jira Team</span>` : ''}
        ${byComponentExports(d)}
      </div>`;
  }

  /* ── THE TWO EXPORTS ──────────────────────────────────────────────────
     BOTH CARRY THE SCOPES AND NEITHER CARRIES THE LENSES. Team and sprint
     decide which epics were counted at all, so both travel; the family chip
     and the clear-row fold only hide rows, so the CSV carries the whole list
     with Family and Clear as columns and the reader filters in the
     spreadsheet. That is what a spreadsheet is for, and it avoids shipping a
     file that is silently whichever twenty rows somebody was looking at.

     THE PDF IS THE OPPOSITE, deliberately. It is a picture of this table as
     it stands — chips, fold and all — because that is what "print what I am
     looking at" means, and a PDF nobody can filter is no use as raw data
     anyway. The CSV is the data; the PDF is the page.

     A LINK FOR THE CSV, A BUTTON FOR THE PDF. The CSV is a URL the browser
     can fetch, which means it works on a middle click and can be copied; the
     PDF is an action on this document and has no address. */
  function byComponentExports(d) {
    const href = `/api/export?what=bycomponent&team=${encodeURIComponent(bcState.teamId)}`
      + `&sprint=${encodeURIComponent(bcState.sprintId)}`;
    return `
      <span class="print-hide" style="display:inline-flex;gap:6px">
        <a class="btn ghost sm" href="${UI.esc(href)}"
          title="Every ranked suite, both halves, with the keys behind each number — whatever the chips are set to">Export CSV</a>
        <button class="btn ghost sm" data-act="bc-export-pdf"
          title="This table as it stands, on its own page">Export PDF</button>
      </span>`;
  }

  /* THE HEADER SAYS "ALL TEAMS" IN WORDS, not only in a tooltip. The two
     halves of this table are counted over different populations, and a reader
     who assumes both are the selected team's reads the backlog as a fifth of
     what it is. Colour and a hover cannot carry that; the column heading can. */
  function backlogTitle(d) {
    const s = (d.scopes || {}).backlog || {};
    return `Epics in these statuses across ${s.label || 'all teams'}, with no work in an ACTIVE sprint. `
      + 'The whole queue for the suite — not only the part carrying this team\'s Jira Team field, '
      + 'because what is left to automate in a suite is not a per-team fact. '
      + 'A future sprint is a plan, not progress, so an epic earmarked for one is still in this column.';
  }

  /** Which sprints the backlog left out, named — so the rule can be checked. */
  function scopeTitle(x) {
    /* EVERY TEAM'S ACTIVE SPRINT, named with whose it is. The backlog counts
       the whole portfolio, so its exclusion does too — an epic Titan is
       working right now is not "nobody has picked this up" because Ruby is
       the team on screen — and a list of bare sprint names would leave a
       reader unable to tell why a sprint they have never heard of is in it. */
    const list = (x.sprints || []).map(v => `${v.label}${v.team ? ` — ${v.team}` : ''}`);
    if (!list.length) return 'No active sprints anywhere, so nothing is excluded from the backlog.';
    return 'Backlog counts epics with no work in an ACTIVE sprint, on any team. '
      + `Read: ${list.join(', ')}. `
      + 'A FUTURE sprint is a plan, not progress — an epic earmarked for Sprint 43 is still work not being done, '
      + 'so it stays in the backlog and is counted separately. Closed sprints are history and are not excluded either.';
  }

  /* WHY THIS NUMBER DIFFERS FROM THE PRIORITIZATION PAGE, said where the
     difference shows. The two screens get read side by side and agreed
     exactly until this: the backlog counts epics with an empty Team field
     and that page does not, because a coverage PERCENTAGE should not move
     for an epic nobody has declared either way, while a QUEUE that hides
     them is hiding real work. Two different questions, one stated
     difference — far better than two numbers and no explanation. */
  function noTeamTitle(d) {
    const n = ((d.scopes || {}).backlog || {}).noTeam || 0;
    return `${n} of the epics counted above have an empty Jira Team field. `
      + 'They are counted here because "all teams" has to include the ones nobody assigned a team to — '
      + 'an epic sitting in Ready for Automation is work in the queue however it is tagged. '
      + 'The Coverage and Prioritization screens leave them out, so their totals are lower by this amount; '
      + 'setting the Team field on these would bring the three screens back into line.';
  }

  /** Which later sprints the earmarked suites are sitting in. */
  function queuedTitle(q) {
    const list = (q.sprints || []).map(v => `${v.label}${v.team ? ` — ${v.team}` : ''}`);
    return `${q.epics} of the suites counted above already have work queued in a later sprint. `
      + 'They are still backlog — nobody is working them yet — but they are not the ones nobody has looked at. '
      + (list.length ? `Queued in: ${list.join(', ')}.` : '');
  }

  /* WHAT THE TABLE COULD NOT PLACE, said out loud rather than absorbed into
     the totals. Both numbers are real effort that appears in no row, and a
     reader adding the planned column up against the sprint's ticket count is
     owed the difference. */
  function byComponentNotes(d) {
    const n = d.plannedNotes || {};
    const bits = [];
    if (n.unlinked) {
      bits.push(`${UI.int(n.unlinked)} maintenance ticket${n.unlinked === 1 ? '' : 's'} in this sprint name no suite, so ${n.unlinked === 1 ? 'it is' : 'they are'} in no row`);
    }
    if (n.outOfScope) {
      bits.push(`${UI.int(n.outOfScope)} suite${n.outOfScope === 1 ? '' : 's'} the sprint reaches ${n.outOfScope === 1 ? 'is' : 'are'} outside this team's coverage scope`);
    }
    if ((d.excluded || []).length) {
      bits.push(`${d.excluded.length} ranked component${d.excluded.length === 1 ? ' is' : 's are'} on the excluded list and not shown`);
    }
    if (!bits.length) return '';
    return `<p class="muted" style="font-size:12px;margin:8px 0 0">${bits.map(UI.esc).join(' · ')}.</p>`;
  }

  /**
   * HOW MUCH OF THIS COMMITMENT CAME FROM AN EARLIER SPRINT.
   *
   * A suffix in the number's own cell, not a column and not a tag on the name.
   * The table is already twelve columns wide, and the last tag that went next
   * to a row name had to be taken off again for making the sheet unreadable.
   * Nothing when there is none, so the quiet case stays quiet.
   */
  function carriedMark(r) {
    const n = r && r.carriedIn;
    if (!n || n <= 0) return '';
    const left = r.newScope == null ? null : r.newScope;
    return `<span class="muted" style="font-size:11px;margin-left:4px;white-space:nowrap"
      title="${UI.esc(`${n} of these points came from an earlier sprint — work already in flight, not new scope${left == null ? '' : `. New scope this sprint: ${left} pts`}`)}">↩${UI.num(n)}</span>`;
  }

  function row(r, s, state) {
    const cls = UI.workloadClass(r.workloadPct, s.workloadOverPct, s.workloadUnderPct);
    // How this person came to be on the sprint. Only the non-obvious cases get
    // a tag: someone assigned work needs no explanation, someone you put here
    // by hand does.
    const on = ((data.roster && data.roster.members) || []).find(m => m.id === r.memberId) || {};
    const why = on.onSprint === 'added' ? '<span class="tag" title="You put this person on the sprint">added</span>'
      : on.onSprint === 'team' ? '<span class="tag" title="On the team, but nothing assigned in this sprint yet">no items yet</span>'
        : on.onSprint === 'planned' ? '<span class="tag" title="No work assigned, but you entered capacity for them in this sprint">planned</span>'
          : '';
    const guest = on.historic ? '<span class="tag" title="Was on this sprint, but is not on the team any more">past member</span>'
      : on.notOnTeamList ? '<span class="tag warn" title="Did work in this sprint but is not on the team list">not on the team</span>'
        : '';
    /* WHY THIS ROW'S HOURS ARE ZERO. Without it the row reads as a bug: a
       name, some delivered points, and a capacity of nothing. It has to be a
       tag rather than the checkbox, because on a closed sprint the checkbox is
       disabled — so the one control that would explain the zero is greyed out
       and unticked. */
    const auto = on.autoExempt
      ? '<span class="tag" title="Not on the team list, and no availability was entered for them in this sprint — so their hours are left out of the capacity total. Their committed and delivered points still count.">capacity not counted</span>'
      : '';
    // This row's name came from you; the work came from Jira under a different
    // one, and they were matched. Shown because it is the one link the tool
    // worked out rather than was told, and you are the one who would know.
    const matched = (on.matchedNames || []).length
      ? `<span class="tag" title="Work assigned in Jira to ${UI.esc(on.matchedNames.join(', '))} is counted here — matched by name, because this row has no Jira account on it">= ${UI.esc(on.matchedNames.join(', '))}</span>`
      : '';
    return `
      <tr class="${r.status === 'Released' ? 'released' : ''}${r.calcExempt ? ' exempt' : ''}" data-member="${r.memberId}">
        <td class="muted">${UI.esc(r.role)}</td>
        <td><div class="name-cell">${UI.avatar(r.name)}<span>${UI.esc(r.name)}${r.status === 'Released' ? ' <span class="tag">Released</span>' : ''}${why}${guest}${auto}${matched}</span></div></td>
        <td class="num">
          <input type="checkbox" class="exempt-box" data-exempt="${r.memberId}" ${r.calcExempt ? 'checked' : ''} ${ro ? 'disabled' : ''}
            title="${on.autoExempt ? `${UI.esc(r.name)} is not on the team list and has no availability entered for this sprint, so their hours are not counted` : r.calcExempt ? `${UI.esc(r.name)} is not counted in this sprint's capacity` : `Stop counting ${UI.esc(r.name)}'s hours in this sprint's capacity`}"
            aria-label="Exempt ${UI.esc(r.name)} from this sprint's capacity">
        </td>
        <td class="num"><input type="number" min="0" max="100" step="5" value="${r.supportPct}" data-support="${r.memberId}" ${ro ? 'disabled' : ''} style="width:64px;text-align:right"></td>
        <td class="num">${UI.num(r.availableDays)}</td>
        <td class="num">${UI.num(r.capacityHours)}</td>
        <td class="num">${UI.int(r.predicted)}</td>
        <td class="num"><a href="#" data-act="member-items" data-member="${r.memberId}">${UI.num(r.planned)}</a>${carriedMark(r)}</td>
        <td class="num">${UI.num(r.actual)}</td>
        <td class="num pct ${cls}">${UI.pct(r.workloadPct)}</td>
        <td>${UI.bar(r.planned, Math.max(r.predicted, r.planned), cls)}</td>
        <td class="num">${UI.pct(r.goalPct)}</td>
        ${ro ? '' : `<td style="text-align:right;white-space:nowrap">
          <button class="btn ghost sm" data-act="drop-member" data-member="${r.memberId}" data-name="${UI.esc(r.name)}"
            title="Take ${UI.esc(r.name)} off this sprint — only this sprint, and you can put them back">Remove</button>
        </td>`}
      </tr>`;
  }

  /**
   * The people you took OFF this sprint, with one click to put them back.
   *
   * A removal that leaves no trace is the worst kind: capacity drops, nothing
   * says why, and a week later nobody remembers whether it was deliberate.
   */
  function removedRow(state) {
    const ids = (data.roster && data.roster.removed) || [];
    if (!ids.length) return '';
    return `
      <tr>
        <td colspan="12" class="muted" style="font-size:12px;padding:10px 12px">
          <strong style="font-weight:600">Taken off this sprint:</strong>
          ${ids.map(id => `<span class="tag">${UI.esc(nameFor(id))}${ro ? '' :
            ` <button class="btn ghost sm" data-act="restore-member" data-member="${UI.esc(id)}" style="margin-left:6px" title="Put ${UI.esc(nameFor(id))} back on this sprint">Put back</button>`}</span>`).join(' ')}
        </td>
      </tr>`;
  }

  /** A removed person is not in `rows` any more, so their name comes from the team. */
  function nameFor(id) {
    const cand = ((roster && roster.candidates) || []).find(c => c.id === id);
    return (cand && cand.name) || String(id).replace(/^jira:/, '');
  }

  function dayHead(days) {
    return `<div class="dayhead">${days.map(d => `<div class="${['Sat', 'Sun'].includes(d.dow) ? 'we' : ''}">${d.dow ? d.dow[0] : ''}<br>${d.date ? d.date.slice(8, 10) : ''}</div>`).join('')}</div>`;
  }

  function dayRow(r, row, days) {
    return `<div class="daygrid" data-member="${r.memberId}">${days.map((d, i) => {
      const v = row[i] === undefined ? '1' : row[i];
      const label = v === 'WO' ? '' : v === 'H' ? 'H' : v === '0' ? '✕' : v === '0.5' ? '½' : '';
      return `<div class="day" data-v="${v}" data-i="${i}" title="${d.date || ''}${d.holiday ? ' · public holiday' : ''}">${label}</div>`;
    }).join('')}</div>`;
  }

  /**
   * Work assigned to someone who is not on this sprint's roster.
   *
   * This used to be folded into the "no assignee" line, which was simply untrue
   * of it — every one of these tickets names a person. It is also a different
   * problem with a different fix: unassigned work needs an owner, while this
   * work HAS one the sprint is not being planned around. So the line names them
   * and points at the two ways out.
   */
  function offRosterLine(d) {
    const o = d.offRoster;
    if (!o || !o.points) return '';
    const who = o.people.slice(0, 3).map(p => `${UI.esc(p.name)} (${UI.num(p.planned)})`);
    const rest = o.people.length - who.length;
    return `<li class="warn">
      ${UI.num(o.points)} pts assigned to ${o.people.length} ${o.people.length === 1 ? 'person' : 'people'} not on this sprint —
      ${who.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}.
      Add them to the sprint to count their capacity, or move the work.
      <button class="btn ghost sm" data-act="show-off-roster">Show ${o.count}</button>
    </li>`;
  }

  /**
   * Where this sprint's headcount came from, in words.
   *
   * "4 people" alone invites "why four?" and answers nothing. Saying how many
   * were assigned work, how many came from the team list and how many you put
   * there yourself makes the number checkable at a glance — and makes an
   * accidental removal visible instead of silently lowering capacity.
   */
  function rosterWords(r) {
    if (!r || !r.counts) return '';
    const c = r.counts, bits = [];
    if (c.assigned) bits.push(`${c.assigned} assigned work`);
    if (c.planned) bits.push(`${c.planned} you planned capacity for`);
    if (c.fromTeam) bits.push(`${c.fromTeam} on the team`);
    if (c.added) bits.push(`${c.added} you added`);
    if (c.removed) bits.push(`${c.removed} you removed`);
    return `${c.total} ${c.total === 1 ? 'person' : 'people'}${bits.length ? ` (${bits.join(', ')})` : ''}`;
  }

  /**
   * Saved plans for this sprint, with the live one first.
   *
   * The comparison is the feature. A scenario on its own is a note; a scenario
   * beside the current plan, with both totals on the same row, is a decision
   * you can actually make.
   */
  function scenarioBar(info) {
    if (!info) return '';
    const list = info.scenarios || [];
    // Identical saves, which is what the double-firing click produced. Same
    // name AND same numbers — a re-save under a name you have used before,
    // with a different plan, is legitimate and is not counted here.
    const seen = new Map();
    for (const sc of list) {
      const k = `${sc.name}\u0000${JSON.stringify(sc.totals || {})}`;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    const dupes = [...seen.values()].reduce((n, c) => n + (c > 1 ? c - 1 : 0), 0);
    const row = (name, totals, extra = '', id = null) => `
      <tr${id ? ` data-scenario="${UI.esc(id)}"` : ' class="total"'}>
        <td><strong>${UI.esc(name)}</strong> ${extra}</td>
        <td class="num">${totals ? UI.int(totals.headcount) : '—'}</td>
        <td class="num">${totals ? UI.num(totals.capacityHours) : '—'}</td>
        <td class="num">${totals ? UI.int(totals.predicted) : '—'}</td>
        <td class="num">${totals ? UI.num(totals.planned) : '—'}</td>
        <td style="text-align:right">${id && !ro ? `
          <button class="btn ghost sm" data-act="apply-scenario" data-id="${UI.esc(id)}">Apply</button>
          <button class="btn ghost sm" data-act="delete-scenario" data-id="${UI.esc(id)}">Delete</button>` : ''}</td>
      </tr>`;

    return `
      <section class="section">
        <div class="card">
          <div class="section-head" style="margin-bottom:6px">
            <h3>Capacity scenarios</h3>
            <span class="muted">${list.length ? `${list.length} saved for this sprint` : 'Save a plan before you change it, and you can always get it back'}</span>
            <div class="spacer"></div>
            ${dupes && !ro ? `<button class="btn ghost sm" data-act="dedupe-scenarios">Clean up ${dupes} duplicate${dupes === 1 ? '' : 's'}</button>` : ''}
            ${ro ? '<span class="tag">read only</span>' : '<button class="btn sm" data-act="save-scenario">Save current plan</button>'}
          </div>
          ${dupes ? `<p class="muted" style="font-size:12px;margin:0 0 8px">
            ${dupes} of these are identical copies — a fixed bug made one click save the plan several times.
            Cleaning up keeps the earliest of each and removes the rest.
          </p>` : ''}
          ${list.length ? `
          <div class="table-wrap">
            <table>
              <thead><tr><th>Plan</th><th class="num">People</th><th class="num">Capacity h</th><th class="num">Capacity pts</th><th class="num">Committed</th><th></th></tr></thead>
              <tbody>
                ${row('Current plan', info.live && info.live.totals, '<span class="tag ok">live</span>')}
                ${list.map(sc => row(sc.name, sc.totals,
                  `${sc.note ? `<span class="muted" style="font-weight:400"> — ${UI.esc(sc.note)}</span>` : ''}`
                  + `${sc.appliedAt ? ' <span class="tag">applied</span>' : ''}`, sc.id)).join('')}
              </tbody>
            </table>
          </div>` : ''}
        </div>
      </section>`;
  }

  /** The add-person drawer: the team's own people, then everyone Jira knows. */
  function addDrawer() {
    const list = (roster && roster.candidates) || [];
    const group = (from, title, note) => {
      const rows = list.filter(c => c.from === from);
      if (!rows.length) return '';
      return `
        <div style="margin-top:18px">
          <div class="eyebrow"><i></i>${title}</div>
          <div class="muted" style="font-size:12px;margin:4px 0 8px">${note}</div>
          ${rows.map(c => `
            <div style="display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--app-line-soft)">
              <div class="name-cell">${UI.avatar(c.name)}<span>${UI.esc(c.name)}</span></div>
              ${c.role ? `<span class="tag">${UI.esc(c.role)}</span>` : ''}
              <span class="spacer"></span>
              <button class="btn ghost sm" data-act="add-person"
                data-id="${UI.esc(c.id)}" data-name="${UI.esc(c.name)}"
                data-account="${UI.esc(c.jiraAccountId || '')}">Add to sprint</button>
            </div>`).join('')}
        </div>`;
    };

    return `
      <div class="eyebrow"><i></i>Add someone to this sprint</div>
      <h2 style="margin:6px 0 2px">${UI.esc(data.teamName)}</h2>
      <div class="muted" style="margin-bottom:6px">
        They join this sprint only. Every other sprint keeps the roster it already has.
      </div>
      ${list.length
        ? group('team', 'Already on this team', 'Not on this sprint yet')
          + group('jira', 'From Jira', 'Everyone Jira has seen on this project — a new joiner appears here the first sync after they exist')
        : '<div class="empty">Everyone is already on this sprint</div>'}`;
  }

  function wire(state, mount) {
    // A closed sprint gets no editing wiring at all. Not disabled-looking —
    // absent. The server refuses these writes anyway; leaving live handlers
    // that always fail is how a screen ends up telling you it saved.
    if (ro) {
      UI.$$('input', mount).forEach(i => { i.disabled = true; });
      UI.$$('#sprintNote', mount).forEach(i => { i.readOnly = true; });
    }

    /* POINTS → JIRA, through the shared wiring — the Active sprint screen
       offers the same edit and the two must behave identically. `onSaved`
       reloads the page because the numbers ABOVE this table are derived from
       these points: capacity used, per-person load, the over/under warnings.
       Leaving those stale beside an edited row is a screen disagreeing with
       itself. */
    UI.wireItemEdits(mount, {
      teamId: state.teamId, sprintId: state.sprintId, readOnly: ro,
      onSaved: () => App.refresh(),
    });

    /* THE ITEM TABLE'S OWN FILTERS — the same call the Active sprint makes,
       because it is the same table. */
    UI.wireItemsFilter(mount);

    // Day cells cycle; weekends are fixed so a stray click cannot invent a working Saturday.
    UI.$$('.daygrid .day', mount).forEach(cell => {
      cell.addEventListener('click', async () => {
        if (ro || cell.dataset.v === 'WO') return;
        const next = CYCLE[cell.dataset.v] || '1';
        cell.dataset.v = next;
        cell.textContent = next === 'H' ? 'H' : next === '0' ? '✕' : next === '0.5' ? '½' : '';
        const grid = cell.closest('.daygrid');
        const row = UI.$$('.day', grid).map(c => c.dataset.v);
        await UI.jsonPut('/api/availability', { teamId: state.teamId, sprintId: state.sprintId, memberId: grid.dataset.member, row });
        App.refresh();
      });
    });

    UI.$$('[data-exempt]', mount).forEach(box => {
      box.addEventListener('change', async () => {
        try {
          await UI.jsonPut('/api/calc-exempt', {
            teamId: state.teamId, sprintId: state.sprintId,
            memberId: box.dataset.exempt, exempt: box.checked,
          });
          App.refresh();
        } catch (err) {
          // Put the box back: a tick that stayed on after a refused write says
          // the person is exempt when the plan still counts them.
          box.checked = !box.checked;
          UI.toast(err.message, true);
        }
      });
    });

    UI.$$('[data-support]', mount).forEach(input => {
      input.addEventListener('change', async () => {
        await UI.jsonPut('/api/support', { teamId: state.teamId, sprintId: state.sprintId, memberId: input.dataset.support, pct: Number(input.value) });
        App.refresh();
      });
    });

    const ceremony = UI.$('#ceremonyInput', mount);
    if (ceremony) ceremony.addEventListener('change', async () => {
      await UI.jsonPut('/api/ceremony', { teamId: state.teamId, sprintId: state.sprintId, hours: Number(ceremony.value) });
      App.refresh();
    });

    /* THE NOTE SAVES ON BLUR, wired on the MOUNT for the same reason the
       chips are: the section replaces itself on every chip click and the fold
       toggle, so a handler attached to the textarea would go with the markup
       that replaced it. `focusout` rather than `blur`, because blur does not
       bubble and a delegated listener would never hear it. */
    mount.addEventListener('focusout', (e) => {
      const box = e.target.closest && e.target.closest('[data-bc-note]');
      // RETURNED, not fired and forgotten. The browser ignores the promise
      // either way, but a caller that can await it — a test — then observes
      // the save rather than the moment before it, which is the difference
      // between checking the refusal path and checking nothing.
      return box ? saveByComponentNote(box) : undefined;
    });

    /* THE FAMILY CHIPS, wired on the MOUNT rather than on the buttons. The
       section redraws itself on every chip click, so handlers attached to the
       buttons would go with the markup that replaced them and the second
       click would do nothing. */
    mount.addEventListener('click', (e) => {
      const fam = e.target.closest && e.target.closest('[data-bc-family]');
      if (!fam || fam.disabled) return;
      const want = fam.dataset.bcFamily || null;
      // Clicking the chip you are on clears it, which is how every other chip
      // row in this app behaves; "All" is already the cleared state.
      bcFamily = bcFamily === want ? null : want;
      redrawByComponent(state, mount);
    });

    mount.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const kind = act.dataset.act;
      /* HANDLED FIRST, and it redraws ONE SECTION rather than the page.
         `App.refresh()` would refetch the capacity payload, rebuild the grid
         and lose the item table's filters — for a fold that changes nothing
         but which rows of one table are drawn. The payload already holds
         every row, so the toggle is a local redraw. */
      if (kind === 'bc-show-all' || kind === 'bc-show-busy') {
        e.preventDefault();
        bcShowAll = kind === 'bc-show-all';
        return redrawByComponent(state, mount);
      }
      /* HANDLED BEFORE ANYTHING THAT REDRAWS. `UI.exportPdf` marks the
         section, prints, and unmarks it on `afterprint` — a redraw in between
         would replace the marked node with an unmarked one and leave the page
         hidden with nothing to put back. */
      /* THE WHOLE PAGE. Handled beside the By component export for the same
         reason that one is handled early: `UI.exportPdf` marks the document,
         prints, and unmarks it on `afterprint`, so anything that redraws in
         between would swap the marked node for an unmarked one.

         NO `only`, deliberately — this export IS the page, and the print
         stylesheet already takes the buttons, chips and scenario bar out.
         LANDSCAPE, for the same reason the By component sheet is: Member
         capacity is thirteen columns wide, and on portrait A4 the right-hand
         end of it — Load, the load bar, Goal, the numbers the meeting is
         actually about — either shrinks to unreadable or falls onto a second
         sheet that has lost its names. */
      if (kind === 'email-report') {
        e.preventDefault();
        /* THE SPRINT THIS SCREEN IS SHOWING, pinned — resolved here rather
           than closed over, for the same reason the export beside it does:
           this handler lives in `wire` and the sprint is a local of
           `render`. */
        const raw = (state.sprints || []).find(x => x.id === state.sprintId) || {};
        const sp = { ...raw, ...((raw.byTeam || {})[state.teamId] || {}) };
        MailDrawer.open({
          report: 'capacity',
          title: 'Send Capacity planning',
          team: state.teamId,
          scope: { sprint: sp.id || state.sprintId || null },
          /* THE LENS THE SHEET IS UNDER, so the attachment is the table he is
             looking at. Kept apart from `scope`: the scope decides what was
             COUNTED and so changes the figures quoted in the mail, while the
             family chip and the clear-row fold only decide what is DRAWN. The
             KPI strip is team-level and identical either way — treating these
             as scope would imply the numbers move with them, which they do
             not. */
          view: { family: bcFamily, showAll: bcShowAll },
          scopeNarrow: true,
          scopeLabel: `${data.teamName || state.teamId} · ${sp.name || state.sprintId || 'current sprint'}`
            + (bcFamily ? ` · ${bcFamily} family` : ''),
        });
        return;
      }
      if (kind === 'cap-export-pdf') {
        e.preventDefault();
        /* THE SPRINT IS LOOKED UP HERE, not closed over. `data` is module
           state and reachable; `sprint` is a local of `render` and this
           handler lives in `wire`, so referring to it would be a
           ReferenceError the moment somebody clicked — and only then, because
           nothing but a click reaches this line. The By component export
           beside it reads `bc.sprint` off the payload for the same reason. */
        const raw = (state.sprints || []).find(x => x.id === state.sprintId) || {};
        const sp = { ...raw, ...((raw.byTeam || {})[state.teamId] || {}) };
        UI.exportPdf(
          [data.teamName || state.teamId, sp.name || state.sprintId, 'capacity planning'],
          { landscape: true },
        );
        return;
      }
      if (kind === 'bc-export-pdf') {
        e.preventDefault();
        const bc = data.byComponent || {};
        /* LANDSCAPE. This sheet is sixteen columns wide — two tools times
           three backlog buckets, two planned columns each, plus priority and
           the note — and on portrait A4 the right-hand half of it either
           shrinks to unreadable or falls onto a second sheet that has lost
           its row labels. It is the one export here wide enough to need the
           long edge. */
        UI.exportPdf(
          [(bc.team && bc.team.name) || '', (bc.sprint && bc.sprint.label) || '', 'by component'],
          { only: '[data-bycomp]', landscape: true },
        );
        return;
      }
      if (kind === 'bc-epics') {
        e.preventDefault();
        /* `data-n` WHEN THE CONTROL HAS ONE. The number cells carry their
           count as their own text, but the warning marker's text is "!" —
           scraping digits off that yields 0, and the drawer would announce
           that the cell had been redrawn on every single open. */
        const shown = act.dataset.n != null
          ? Number(act.dataset.n) || 0
          : Number(String(act.textContent).replace(/[^0-9]/g, '')) || 0;
        await openByComponentCell(state, act.dataset, shown);
        return;
      }
      if (kind === 'member-items') {
        e.preventDefault();
        const r = data.rows.find(x => x.memberId === act.dataset.member);
        UI.drawer(itemsDrawer(r.name, r.items, state));
      } else if (kind === 'item-testcases') {
        e.preventDefault();
        const item = (data.items || []).find(i => i.key === act.dataset.key);
        if (item) UI.drawer(UI.testCasesDrawer(item, data.items || [], {}, state));
      } else if (kind === 'epic-blockers') {
        e.preventDefault();
        const item = (data.items || []).find(i => i.key === act.dataset.key);
        if (item) UI.drawer(UI.epicBlockersDrawer(item, data.items || [], {}, state));
      } else if (kind === 'show-unassigned') {
        UI.drawer(itemsDrawer('No assignee in this sprint', data.unassigned.items, state));
      } else if (kind === 'show-off-roster') {
        UI.drawer(itemsDrawer('Assigned to people not on this sprint', data.offRoster.items, state));
      } else if (kind === 'save-note') {
        await UI.jsonPut('/api/note', { teamId: state.teamId, sprintId: state.sprintId, text: UI.$('#sprintNote', mount).value });
        UI.toast('Note saved');
      } else if (kind === 'add-member') {
        UI.drawer(addDrawer());
      } else if (kind === 'add-person') {
        act.disabled = true; act.textContent = 'Adding…';
        try {
          await UI.jsonPut('/api/sprint/roster', {
            teamId: state.teamId, sprintId: state.sprintId,
            memberId: act.dataset.id, state: 'added',
            member: { name: act.dataset.name, jiraAccountId: act.dataset.account || null },
          });
          UI.closeDrawer();
          UI.toast(`${act.dataset.name} added to this sprint`);
          App.refresh();
        } catch (err) {
          UI.toast(err.message);
          act.disabled = false; act.textContent = 'Add to sprint';
        }
      } else if (kind === 'drop-member') {
        const name = act.dataset.name;
        // Removing someone changes the capacity figure, so it asks. The
        // decision itself is reversible — it is a roster note, not a deletion.
        if (!confirm(`Take ${name} off this sprint?\n\nTheir capacity stops counting and any work assigned to them moves to Unassigned. Only this sprint is affected, and you can put them back.`)) return;
        await UI.jsonPut('/api/sprint/roster', {
          teamId: state.teamId, sprintId: state.sprintId, memberId: act.dataset.member, state: 'removed',
        });
        UI.toast(`${name} removed from this sprint`);
        App.refresh();
      } else if (kind === 'restore-member') {
        await UI.jsonPut('/api/sprint/roster', {
          teamId: state.teamId, sprintId: state.sprintId, memberId: act.dataset.member, state: 'clear',
        });
        App.refresh();
      } else if (kind === 'save-scenario') {
        const name = prompt('Name this plan — something you will recognise next week:', suggestName());
        if (name == null) return;
        // Saving is the one action here that is NOT idempotent: a second call
        // makes a second row rather than re-doing the same thing. The
        // structural fix in App.refresh() stops a single click firing twice;
        // this stops a genuinely impatient double-click doing the same.
        if (busy) return;
        busy = true;
        try {
          await UI.jsonPost('/api/scenarios', {
            teamId: state.teamId, sprintId: state.sprintId, name,
          });
          UI.toast('Plan saved — change anything you like, it is safe now');
          App.refresh();
        } catch (err) { UI.toast(err.message); }
        finally { busy = false; }
      } else if (kind === 'apply-scenario') {
        if (!confirm('Apply this plan?\n\nIt replaces the current leave grid, support percentages, ceremony hours and roster for this sprint. Save the current plan first if you want it back.')) return;
        try {
          await UI.jsonPost('/api/scenarios/apply', { id: act.dataset.id });
          UI.toast('Applied');
          App.refresh();
        } catch (err) { UI.toast(err.message); }
      } else if (kind === 'dedupe-scenarios') {
        // Dry run first, always: the confirm text names the real number, and
        // nothing is removed until he answers it.
        const preview = await UI.jsonPost('/api/scenarios/dedupe', {});
        if (!preview.duplicates) { UI.toast('No duplicates to clean up'); return; }
        const names = preview.removing.slice(0, 5).map(r => `· ${r.name}`).join('\n');
        if (!confirm(`Remove ${preview.duplicates} duplicate plan${preview.duplicates === 1 ? '' : 's'}?\n\n${names}${preview.removing.length > 5 ? `\n… and ${preview.removing.length - 5} more` : ''}\n\nThe earliest copy of each is kept. ${preview.keeping} plan${preview.keeping === 1 ? '' : 's'} will remain. This cannot be undone.`)) return;
        const r = await UI.jsonPost('/api/scenarios/dedupe', { confirm: true });
        UI.toast(`Removed ${r.removed} duplicate${r.removed === 1 ? '' : 's'}`);
        App.refresh();
      } else if (kind === 'delete-scenario') {
        if (!confirm('Delete this saved plan? This cannot be undone.')) return;
        await UI.jsonDelete('/api/scenarios', { id: act.dataset.id });
        UI.toast('Deleted');
        App.refresh();
      } else if (kind === 'apply-calibration') {
        const plan = await UI.api('/api/state');
        const teams = plan.plan.teams.map(t => t.id === state.teamId ? { ...t, settings: { ...t.settings, hoursPerPoint: data.calibration.value } } : t);
        await UI.jsonPut('/api/plan', { teams });
        UI.toast(`Hours per point set to ${data.calibration.value}`);
        App.refresh();
      }
    });
  }

  /** A name that says what the plan IS, so a list of five is still readable. */
  function suggestName() {
    const t = data.totals;
    return `${t.headcount} people · ${UI.int(t.predicted)} pts`;
  }

  function itemsDrawer(title, items, state) {
    const sorted = (items || []).slice().sort((a, b) => (b.points || 0) - (a.points || 0));
    const total = sorted.reduce((t, i) => t + (i.points || 0), 0);
    return `
      <div class="eyebrow"><i></i>Sprint items</div>
      <div style="display:flex;align-items:center;gap:10px;margin:6px 0 2px">
        <h2 style="margin:0">${UI.esc(title)}</h2>
        <span class="spacer"></span>
        ${UI.openInJira(sorted.map(i => i.key))}
      </div>
      <div class="muted" style="margin-bottom:16px">${sorted.length} items · ${UI.num(total)} pts</div>
      ${sorted.length ? sorted.map(i => `
        <div style="padding:11px 0;border-bottom:1px solid var(--app-line-soft)">
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
            ${UI.issueKey(i.key)}
            <span class="tag"><i class="dot" style="background:${UI.CATEGORY_COLORS[i.category]}"></i>${UI.esc((state.categories[i.category] || {}).label || i.category)}</span>
            ${UI.statusText(i)}
            <span class="spacer"></span>
            <strong>${i.points == null ? '<span class="tag risk">no estimate</span>' : `${i.points} pts`}</strong>
          </div>
          <div style="font-size:13px">${UI.esc(i.summary)}</div>
          ${(i.components || []).length ? `<div class="muted" style="font-size:11.5px;margin-top:3px">${UI.esc(i.components.join(', '))}</div>` : ''}
        </div>`).join('') : '<div class="empty">Nothing here</div>'}`;
  }

  return { render };
})();
