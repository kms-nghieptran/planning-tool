/* Prioritization — the suites he has decided about, and where each one stands.

   This is the sheet he has been keeping by hand, computed. Every number on it
   comes from the same coverage read the Overall Coverage screen uses, so the
   two pages cannot disagree about a component; the two things that are HIS —
   the priority and the note — are the two things on the page you can edit.

   THE ROW SET IS THE DECISION, NOT THE DATA. A component appears because it
   has a priority, full stop. So a P1 suite with no epics at all still gets a
   row, with zeros across it — that row is the whole reason to look at this
   page — and a busy component nobody has ranked does not, because that is what
   the Coverage screen is for. See lib/prioritization.js. */

const PrioritizationView = (() => {
  let level = null;          // the level chip, if one is on
  let family = null;         // the family chip, if one is on
  /* WHOSE LIST. Defaults to the team in the header picker, because "which of
     my ranked suites is my team carrying" is the question this page is for.
     `allTeams` lifts it to the portfolio — the reading where an epic-less P1
     is visible, since a component nobody has written an epic for belongs to
     no team and would otherwise be on nobody's page. */
  let allTeams = false;
  /* WHAT HAS NOT BEEN PICKED UP YET. An epic already planned into the
     active sprint — as a Story's parent, or as a suite a Bucket Story is
     maintaining — is somebody's job this fortnight, so leaving those out
     turns the page into "what should we pull in next".

     Work in a FUTURE sprint or in the backlog is a plan, not progress, and
     still counts normally.

     A SCOPE, NOT A LENS: it changes what the server counts, because the
     answer depends on sprint membership the browser does not hold. */
  let excludeActiveSprint = false;
  let data = null;

  async function render(state, mount) {
    loadCols();
    const team = allTeams ? '' : (state.teamId || '');
    const qs = [team ? `team=${encodeURIComponent(team)}` : '',
      excludeActiveSprint ? 'excludeActiveSprint=1' : ''].filter(Boolean).join('&');
    data = await UI.api(`/api/prioritization${qs ? `?${qs}` : ''}`);
    const d = data;
    /* WHAT WAS STORED IS NOT NECESSARILY WHAT EXISTS. The remembered column
       list outlives the model: a bucket renamed or dropped in lib/coverage.js
       leaves a key here that hides nothing, and a stored list covering every
       bucket — from an older build, or a hand-edited value — would render two
       empty groups and a `colspan="0"`. Checked against the payload once,
       here, rather than defended against at every read. */
    const known = new Set((d.buckets || []).map(b => b.key));
    hiddenCols = new Set([...hiddenCols].filter(k => known.has(k)));
    if (hiddenCols.size >= known.size) hiddenCols = new Set();

    if (!d.rows.length) {
      mount.innerHTML = `<div class="card">
        ${teamBar(d, state)}
        <div class="empty">${emptyWhy(d)}</div>
      </div>`;
      wireTeamBar(state, mount);
      return;
    }

    mount.innerHTML = `
      <section class="section">
        <div class="kpis">
          ${UI.kpi({ label: 'On the list', value: UI.int(d.rows.length), unit: 'components', foot: d.byLevel.filter(l => l.count).map(l => `${l.count} ${l.label}`).join(' · ') || 'no levels set', tone: 'brand', featured: true })}
          ${UI.kpi({ label: 'Epics counted', value: UI.int(d.totals.total), foot: `${UI.int(d.totals.truetest.total)} TrueTest · ${UI.int(d.totals.kse.total)} KSE` })}
          ${UI.kpi({ label: 'Automated', value: UI.int(d.totals.truetest.automated + d.totals.kse.automated), foot: 'Across both tools, on these components only' })}
          ${UI.kpi({ label: 'Nothing tracked', value: UI.int(d.untracked.length), unit: 'components', foot: d.untracked.length ? 'Ranked, with no epic against them' : 'Every ranked component has epics', tone: d.untracked.length ? 'warn' : 'ok' })}
        </div>
      </section>

      ${scopeLine(d)}

      <section class="section">
        <div class="section-head">
          <h2>By component</h2>
          <div class="spacer"></div>
          <a class="btn ghost sm" href="/api/export?what=prioritization${d.team ? `&team=${encodeURIComponent(d.team.id)}` : ''}">Export CSV</a>
        </div>
        <div class="filters">
          ${teamBar(d, state)}
          <div id="pzChips" style="display:contents"></div>
        </div>
        ${legend(d)}
        <div id="pzTable"></div>
      </section>
    `;

    renderChips(mount);
    renderTable(state, mount);
    wire(state, mount);
  }

  /* ── the two lenses ────────────────────────────────────────────────────
     Family and Priority both cut the rows already fetched, and each chip
     counts what it WOULD leave given the other one. That is the whole reason
     they are redrawn rather than printed once from the payload: pick R&D and
     a P1 chip still reading 11 is a number for a set that is not on screen,
     and you cannot tell by looking that it has gone stale.

     The team scope is different in kind — it changes what the SERVER counts,
     because it is a cut against the Team field on every epic — so it stays
     up in `teamBar` and triggers a refetch. */

  /** Rows surviving every lens except the named one. */
  function pool(except) {
    return data.rows.filter(r =>
      (except === 'level' || level == null || r.priority === level)
      && (except === 'family' || family == null || r.familyKey === family));
  }

  function renderChips(mount) {
    const host = UI.$('#pzChips', mount);
    if (!host) return;
    const forFamily = pool('family');
    const forLevel = pool('level');
    /* A family with no rows AT ALL on this page still shows, disabled — so
       the row of chips is stable as priorities and teams change, and "R&D:
       none of yours" is said rather than left as an absence you have to
       notice. */
    host.innerHTML = `
      <div class="field"><span>Family</span><div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="chip${family == null ? ' active' : ''}" data-family="">All <strong>${forFamily.length}</strong></button>
        ${data.families.map(f => {
          const n = forFamily.filter(r => r.familyKey === f.key).length;
          return `<button class="chip${family === f.key ? ' active' : ''}${f.has ? '' : ' muted'}"
            data-family="${UI.esc(f.key)}" title="${UI.esc(f.label)}"${f.has ? '' : ' disabled'}>${UI.esc(f.short)} <strong>${n}</strong></button>`;
        }).join('')}
      </div></div>
      <div class="field"><span>Priority</span><div style="display:flex;gap:6px;flex-wrap:wrap">
        ${data.byLevel.map(l => {
          const n = forLevel.filter(r => r.priority === l.value).length;
          return `<button class="chip${level === l.value ? ' active' : ''}${n ? '' : ' muted'}"
            data-level="${l.value}" title="${UI.esc(l.name)}">${UI.esc(l.label)} <strong>${n}</strong></button>`;
        }).join('')}
      </div></div>
      ${columnChips()}`;
  }

  /**
   * The column switches.
   *
   * A chip per status, showing in BOTH tool groups at once — see the note on
   * `hiddenCols`. On rather than off is the active state, so the row reads as
   * "these are the columns you are looking at" rather than as a list of
   * things you have suppressed.
   *
   * The last visible column's chip is disabled: a grid with no status columns
   * is two empty tool groups and a `colspan="0"`, which is broken markup for
   * a view nobody wants. Turning one off is a lens; turning them all off is a
   * mistake the control should not let you make.
   */
  function columnChips() {
    const visible = visibleBuckets();
    const last = visible.length === 1 ? visible[0].key : null;
    return `
      <div class="field"><span>Status columns</span><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        ${data.buckets.map(b => {
          const on = !hiddenCols.has(b.key);
          const stuck = b.key === last;
          return `<button class="chip col-chip${on ? ' active' : ''}${b.inRatio ? '' : ' outside'}"
            data-col="${UI.esc(b.key)}"${stuck ? ' disabled' : ''}
            title="${UI.esc(stuck ? `${b.label} — the last column showing` : `${on ? 'Hide' : 'Show'} ${b.label} in both groups`)}"
            ><i class="pz-chip" style="background:${on ? b.color : 'transparent'};border:1px solid ${b.color}"></i>${UI.esc(shortLabel(b))}</button>`;
        }).join('')}
        ${hiddenCols.size
          ? `<button class="chip" data-col="__all" title="Show every status column again">Show all</button>
             <span class="muted" style="font-size:11px">${hiddenCols.size} hidden · totals and the CSV are unaffected</span>`
          : ''}
      </div></div>`;
  }

  /* ── whose list ────────────────────────────────────────────────────── */

  /**
   * The scope control, and the page's own statement of what it is showing.
   *
   * The header picker already names the team, but this page can be looking at
   * either that team or the whole portfolio, and the header cannot say which.
   * A filtered grid that does not name its own filter is one you can read for
   * ten minutes before noticing it answered a narrower question.
   */
  function teamBar(d, state) {
    const name = d.team ? d.team.name : 'every team';
    return `
      <div class="field"><span>Scope</span><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        <button class="chip${allTeams ? '' : ' active'}" data-scope="team"
          title="Only components with ${UI.esc(d.scope.toLowerCase())}s carrying this team's Jira Team field">
          ${UI.esc(teamName(state))}
        </button>
        <button class="chip${allTeams ? ' active' : ''}" data-scope="all"
          title="Every ranked component, whoever owns the work">All teams</button>
        ${d.team && d.team.jiraTeams.length
          ? `<span class="muted" style="font-size:11px">Team field: ${d.team.jiraTeams.map(UI.esc).join(', ')}</span>`
          : ''}
      </div></div>
      <div class="field"><span>Show</span><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        <!-- "All epics", NOT "Everything". This chip sits one control away
             from "This team", and "Everything" beside it reads as the whole
             portfolio — which it is not: it means every epic WITHIN the
             current scope. That wording cost a real misreading, a Titan-
             scoped 9 taken for a portfolio 25. -->
        <button class="chip${excludeActiveSprint ? '' : ' active'}" data-sprint="all"
          title="Every ${UI.esc(d.scope.toLowerCase())} in scope, whether or not it is in a sprint">All ${UI.esc(d.scope.toLowerCase())}s</button>
        <button class="chip${excludeActiveSprint ? ' active' : ''}" data-sprint="exclude"
          title="Leave out ${UI.esc(d.scope.toLowerCase())}s already planned into the active sprint — a Story's parent, or a suite a Bucket Story is maintaining. Future sprints and the backlog still count.">Exclude active sprint items</button>
      </div></div>`;
  }

  const teamName = (state) =>
    ((state.teams || []).find(t => t.id === state.teamId) || {}).name || 'This team';

  /** Why the grid is empty — four different reasons, four different fixes. */
  function emptyWhy(d) {
    if (d.team && d.team.empty) {
      return d.team.reason === 'no-jira-teams'
        ? `<strong>${UI.esc(d.team.name)}</strong> has no Jira <em>Team</em> field values mapped, so no ${UI.esc(d.scope.toLowerCase())} can be matched to it.<br><br>
           Add them under Teams in <a href="#settings">Integrations &amp; setup</a>, or switch to All teams above.`
        : `<strong>${UI.esc(d.team.name)}</strong>'s Team field values are all outside the coverage allow-list, so nothing counts towards it.<br><br>
           Widen the allow-list in <a href="#settings">Integrations &amp; setup</a>, or switch to All teams above.`;
    }
    if (d.elsewhere.length) {
      return `Nothing on the priority list has any ${UI.esc(d.scope.toLowerCase())} owned by
        <strong>${UI.esc(d.team ? d.team.name : 'this team')}</strong>.<br><br>
        ${d.elsewhere.length} ranked component${d.elsewhere.length === 1 ? ' is' : 's are'} carried by other teams —
        switch to All teams above to see ${d.elsewhere.length === 1 ? 'it' : 'them'}.`;
    }
    return `No component has a priority yet.<br><br>
      This page lists the suites you have ranked — set a priority here or on the
      <a href="#reports/coverage">Overall Coverage</a> screen and it appears, even if it has no epics.`;
  }

  /* ── the legend ────────────────────────────────────────────────────────
     Seventeen columns is a lot to hold in your head, and the grid leans on
     colour to tell the statuses apart. The legend is where the colour is
     named — and it is built from the payload's buckets, in payload order,
     with the payload's own colours, so it cannot describe a scheme the grid
     does not use. The two groups are split because that split IS the
     coverage ratio: the four on the left are its denominator. */
  function legend(d) {
    // A hidden column is dimmed rather than dropped: the legend describes the
    // scheme, and a key that vanished would read as a bucket that no longer
    // exists rather than one you turned off.
    const swatch = (b) => `<span class="pz-key${hiddenCols.has(b.key) ? ' off' : ''}"><i style="background:${b.color}"></i>${UI.esc(b.label)}</span>`;
    const inRatio = d.buckets.filter(b => b.inRatio);
    const outside = d.buckets.filter(b => !b.inRatio);
    return `
      <div class="pz-legend">
        <div><span class="pz-key-head">In the coverage ratio</span>${inRatio.map(swatch).join('')}</div>
        <div class="outside"><span class="pz-key-head">Outside it</span>${outside.map(swatch).join('')}</div>
      </div>`;
  }

  /** A few names, then a count — see the note on the gap warning below. */
  function nameList(names, max) {
    const shownNames = names.slice(0, max).map(UI.esc).join(', ');
    const rest = names.length - max;
    return rest > 0 ? `${shownNames} and ${rest} more` : shownNames;
  }

  /** What the numbers are a count of — stated, not assumed. */
  function scopeLine(d) {
    const bits = [];
    if (d.scopeNote.excludedComponents) bits.push(`${d.scopeNote.excludedComponents} excluded components are left out`);
    if (d.scopeNote.teams) bits.push(`only the ${d.scopeNote.teams.length === 1 ? 'team' : 'teams'} ${d.scopeNote.teams.map(UI.esc).join(', ')}`);
    /* A ranked component sitting in the exclusion list is a contradiction, and
       the only way he can resolve it is by being able to see it. The exclusion
       wins — it is the more specific statement — so the row is gone from the
       grid and named here instead of vanishing. */
    const clash = d.excluded.length
      ? `<li class="warn">${nameList(d.excluded, 6)} ${d.excluded.length === 1 ? 'has' : 'have'} a priority but ${d.excluded.length === 1 ? 'is' : 'are'} in the excluded-components list, so ${d.excluded.length === 1 ? 'it is' : 'they are'} not counted here. Clear the priority or the exclusion.</li>`
      : '';
    /* NAMED, THEN COUNTED. A handful of names is the useful form — you can go
       and look at them. Thirty-one is a paragraph nobody reads, and on his
       data this is thirty-one, so past a few the rest becomes a number and
       the row tags in the grid carry the detail. */
    const gap = d.untracked.length
      ? `<li class="warn">${nameList(d.untracked, 6)} — ranked, with no ${UI.esc(d.scope.toLowerCase())} against ${d.untracked.length === 1 ? 'it' : 'them'} at all. ${d.untracked.length > 1 ? 'Each is tagged in the grid below.' : ''}</li>`
      : '';
    /* Dropped by the team filter, not lost. Named as a count rather than a
       list because on his data this is most of the priority list the moment
       a team is picked, and a hundred component names in a warning is a
       paragraph nobody reads. */
    const other = d.elsewhere.length
      ? `<li>${d.elsewhere.length} ranked component${d.elsewhere.length === 1 ? '' : 's'} ${d.elsewhere.length === 1 ? 'has no' : 'have no'} ${UI.esc(d.scope.toLowerCase())} owned by ${UI.esc(d.team ? d.team.name : 'this team')} — switch to All teams to see ${d.elsewhere.length === 1 ? 'it' : 'them'}.</li>`
      : '';
    /* THE ONE LINE THAT EXPLAINS A DISAGREEMENT WITH ANOTHER SCREEN.
       Every other number here is the Coverage screen's own reading. This
       option removes epics, so the two pages will differ — and a reader who
       cannot see why will conclude one of them is broken. It names the
       count, the sprints it read, and what it looked for. */
    const a = d.activeSprint || {};
    /* NAMES BOTH PATHS, because they are not the same kind of work and the
       difference is the whole reason the number is what it is: `viaParent`
       is new automation a Story is writing, `viaLinks` is maintenance a
       Bucket Story is carrying. Following only the first is the mistake this
       line exists to make impossible to miss. */
    const sprintNames = (a.sprints || []).length
      ? a.sprints.map(s => `${UI.esc(s.label)} <span class="muted">(${UI.esc(s.team)})</span>`).join(', ')
      : 'the active sprint';
    const flight = a.excluded && a.epics
      ? `<li class="warn">${UI.int(a.epics)} ${UI.esc(d.scope.toLowerCase())}${a.epics === 1 ? '' : 's'}
          left out — already planned into ${sprintNames}
          <span class="muted">(${UI.int(a.viaParent)} as a story's parent, ${UI.int(a.viaLinks)} linked from a bucket story;
          ${UI.int(a.items)} sprint item${a.items === 1 ? '' : 's'} read)</span>.
          Future sprints and the backlog still count.
          These totals will not match the Overall Coverage screen while this is on.</li>`
      : '';
    /* Asked for and nothing to exclude is worth saying too — otherwise the
       option looks broken when every ranked suite is untouched. */
    const noFlight = a.excluded && !a.epics
      ? `<li>Nothing on this list is in ${(a.sprints || []).length ? sprintNames : 'an active sprint'} yet${(a.sprints || []).length ? '' : ' — no team in scope has one running'}.</li>`
      : '';
    if (!bits.length && !clash && !gap && !other && !flight && !noFlight) return '';
    return `<section class="section"><div class="card">
      <h3>What this counts</h3>
      <div class="sub">Every ${UI.esc(d.scope.toLowerCase())} ${d.team ? `whose Team field is ${d.team.jiraTeams.map(UI.esc).join(' or ')}` : 'in the project'}, by Automation Status, split by tool — the same reading the Overall Coverage screen uses.</div>
      <ul class="reasons" style="margin-top:12px">
        ${flight}${noFlight}
        ${bits.map(b => `<li>${b}</li>`).join('')}
        ${clash}${gap}${other}
      </ul>
    </div></section>`;
  }

  /** What is actually on screen — every lens applied. */
  const shown = () => pool(null);

  /* The seven columns, abbreviated so seventeen of them fit on a screen. The
     full label stays in the `title`, and it comes from the payload — the
     buckets, their order and their labels travel with the data, so a bucket
     added in lib/coverage.js arrives here without a second list to update. */
  const SHORT = {
    automated: 'Auto', maintenance: 'Maint', ready: 'Ready', blocked: 'Blocked',
    na: 'N/A', obsoleted: 'Obs', none: 'None',
  };
  const shortLabel = (b) => SHORT[b.key] || b.label;

  /* ── which status columns are showing ──────────────────────────────────
     Fourteen number columns is a lot when the question is narrower than the
     grid — "where is the maintenance load" needs two of them. So each status
     can be hidden, and the choice persists, because a column you turned off
     should still be off tomorrow.

     HIDDEN IN BOTH GROUPS AT ONCE, never one tool at a time. The entire point
     of the side-by-side is that TrueTest Automated sits beside KSE Automated;
     letting the two groups hold different columns would leave them aligned by
     position but not by meaning, which is worse than either arrangement on
     its own.

     THIS IS A LENS, NOT A SCOPE. Hiding a column changes what is drawn, never
     what is counted: the row totals, the footer and the Export CSV all stay
     whole. A hidden column is a column you are not looking at, not one whose
     epics have stopped existing. */
  const COLS_KEY = 'pt-pz-cols';
  let hiddenCols = new Set();

  /* localStorage throws in a few browser contexts and can come back empty,
     and a remembered column layout is a convenience rather than data — so a
     failure here shows every column rather than breaking the page. */
  function loadCols() {
    try {
      const raw = localStorage.getItem(COLS_KEY);
      hiddenCols = new Set(raw ? JSON.parse(raw) : []);
    } catch { hiddenCols = new Set(); }
  }
  function saveCols() {
    try { localStorage.setItem(COLS_KEY, JSON.stringify([...hiddenCols])); } catch { /* not worth a message */ }
  }

  /** The buckets actually drawn, in the model's own order. */
  const visibleBuckets = () => (data.buckets || []).filter(b => !hiddenCols.has(b.key));

  /**
   * TWO MEANINGS, TWO CHANNELS — the rule the whole grid is coloured by.
   *
   * There are fourteen number columns and a reader has to answer two
   * questions about any one of them: which tool, and which status. Putting
   * both in hue means seven statuses fighting two tools for the same channel
   * and neither coming through. So:
   *
   *   HUE is the STATUS.      `cov-<bucket>` colours the number.
   *   VALUE is the TOOL.      `band-a` / `band-b` tint the whole group, and
   *                           `tool-start` draws the seam between them.
   *
   * `outside` dims the three columns that sit outside the coverage ratio, as
   * a group — which is the most useful thing the grid can say before you read
   * a single number, because the four that remain are the ratio's denominator.
   *
   * Never colour alone: every column keeps its text heading and its `title`,
   * so the grid reads the same to someone who cannot tell the hues apart.
   */
  function cellClass(tool, bucket, i, toolIndex) {
    return [
      'num',
      `cov-${bucket.key}`,
      `band-${toolIndex % 2 ? 'b' : 'a'}`,
      bucket.inRatio ? '' : 'outside',
      i === 0 ? 'tool-start' : '',
    ].filter(Boolean).join(' ');
  }

  function renderTable(state, mount) {
    const d = data;
    const rows = shown();
    const tools = d.tools;
    const buckets = visibleBuckets();

    /* THE LINK SITS ON THE COUNT LINE, NOT IN THE SECTION HEAD — the same
       call the Backlog Items table makes, for the same reason. This line is
       redrawn on every chip change, so it always opens the set the number
       beside it describes. Export CSV stays in the head because it exports the
       whole list whatever the chip says, and a filtered link up there would
       read as the same scope and quietly be a different one. */
    UI.$('#pzTable', mount).innerHTML = !rows.length
      // Two lenses now, so the message names the one that emptied the grid
      // rather than always blaming the level — and both, when both are on.
      ? `<div class="card"><div class="empty">No component matches ${
        [family ? `the ${UI.esc((d.families.find(f => f.key === family) || {}).short || family)} family` : '',
          level != null ? `${UI.esc((d.byLevel.find(l => l.value === level) || {}).label || '')}` : '']
          .filter(Boolean).join(' at ') || 'these filters'}.</div></div>`
      : `
      <div class="muted" style="display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:12px">
        <!-- THE NUMBERS SAY WHOSE THEY ARE. The team scope lives in a chip
             row above and in the header picker, and neither is beside the
             figures — so a team-scoped 9 was read as a portfolio 25. The
             scope belongs on the line the numbers are on. -->
        <span>${rows.length} component${rows.length === 1 ? '' : 's'} · ${UI.int(rows.reduce((n, r) => n + r.total, 0))} ${UI.esc(d.scope.toLowerCase())}s
          · <strong>${d.team ? UI.esc(d.team.name) : 'all teams'}</strong>${excludeActiveSprint ? ' · active sprint excluded' : ''}</span>
        <span class="spacer"></span>
        ${jiraAll(d) ? `<a class="btn ghost sm" href="${jiraAll(d)}" target="_blank" rel="noopener">Open in Jira</a>` : ''}
      </div>
      <div class="table-wrap">
        <!-- NOT SORTABLE, deliberately: UI.sortable reads the FIRST header row
             and maps each cell to a body column by index, and this header has
             two rows whose first one is five cells wide because of the
             colspans — so every column it offered would sort by the wrong one.
             The order here is also the answer (P1 first, then by name), which
             is the thing a sort would destroy. -->
        <table class="pz" data-nosort>
          <thead>
            <tr>
              <th rowspan="2">Component</th>
              <th rowspan="2">Priority</th>
              ${tools.map((t, ti) => `<th class="num tool-start tool-head band-${ti % 2 ? 'b' : 'a'}" colspan="${buckets.length}"><i class="pz-chip" style="background:${t.color}"></i>${UI.esc(t.label)}</th>`).join('')}
              <th rowspan="2" class="tool-start note-col">Notes</th>
            </tr>
            <tr>
              ${tools.map((t, ti) => buckets.map((b, i) => `<th class="${cellClass(t, b, i, ti)} sub" title="${UI.esc(b.label)}"><i class="pz-chip" style="background:${b.color}"></i>${UI.esc(shortLabel(b))}</th>`).join('')).join('')}
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => row(d, r, tools, buckets)).join('')}
          </tbody>
          ${rows.length > 1 ? foot(d, rows, tools, buckets) : ''}
        </table>
      </div>`;
  }

  function row(d, r, tools, buckets) {
    return `
      <tr${r.tracked ? '' : ' class="untracked"'}>
        <td>
          ${componentLink(d, r)}
          ${r.tracked ? '' : ' <span class="tag warn" title="Nothing in the project carries this component">no epics</span>'}
        </td>
        ${priorityCell(d, r)}
        ${tools.map((t, ti) => buckets.map((b, i) => `
          <td class="${cellClass(t, b, i, ti)}">${drill(r[t.key][b.key], { row: r.component, tool: t.key, bucket: b.key })}</td>`).join('')).join('')}
        ${noteCell(d, r)}
      </tr>`;
  }

  /** The totals under the grid — summed from the rows ON SCREEN. */
  function foot(d, rows, tools, buckets) {
    const t = (tool, bucket) => rows.reduce((n, r) => n + r[tool][bucket], 0);
    return `
      <tfoot><tr>
        <td><strong>${rows.length} component${rows.length === 1 ? '' : 's'}</strong></td>
        <td class="muted">${level == null ? 'all levels' : UI.esc((d.byLevel.find(l => l.value === level) || {}).label || '')}</td>
        ${tools.map((tool, ti) => buckets.map((b, i) => `
          <td class="${cellClass(tool, b, i, ti)}"><strong>${t(tool.key, b.key) || '<span class="muted">—</span>'}</strong></td>`).join('')).join('')}
        <td class="tool-start"></td>
      </tr></tfoot>`;
  }

  /**
   * The component name, linked to the same set in Jira the row counts.
   *
   * `— no component —` IS NOT A COMPONENT NAME. It labels the epics nobody
   * tagged, so its link has to search `component IS EMPTY` — searching for a
   * component by that name matches nothing, and an empty Jira result reads
   * as "this suite has no epics" rather than "that was the wrong question".
   * The row says which it is (`noComponent`, from the model) rather than
   * this file comparing against the literal.
   */
  function componentLink(d, r) {
    const href = UI.componentSearchUrl({
      component: r.noComponent ? null : r.component,
      project: d.project, scope: d.scope,
    });
    const label = UI.esc(r.component);
    if (!href) return label;
    const what = r.noComponent
      ? `${UI.esc(d.scope.toLowerCase())}s with no component at all`
      : `the ${UI.esc(d.scope.toLowerCase())}s in ${label}`;
    return `<a href="${UI.esc(href)}" target="_blank" rel="noopener" title="Open ${what} in Jira">${label}</a>`;
  }

  /* EVERY ROW ON SCREEN, in Jira — which means the level chip too. The button
     sits beside a grid that a chip can cut to three rows, and a link that
     opened all nine regardless would be a different set from the one being
     read, with nothing on the page to say which was meant. */
  const jiraAll = (d) => {
    const rows = shown();
    // Same rule as a single row: the untagged bucket is a clause, not a name.
    return UI.componentsSearchUrl({
      components: rows.filter(r => !r.noComponent).map(r => r.component),
      includeEmpty: rows.some(r => r.noComponent),
      project: d.project, scope: d.scope,
    });
  };

  /**
   * Priority, editable here as well as on the Coverage screen.
   *
   * The SAME plan key, written through the same route — this is not a copy of
   * the judgement, it is the judgement. Changing a level here and finding the
   * Coverage screen still showing the old one would mean the tool held two
   * answers to a question that has one.
   */
  function priorityCell(d, r) {
    const levels = d.priorityLevels || [];
    const cur = r.priority == null ? '' : String(r.priority);
    const lvl = levels.find(l => l.value === r.priority) || {};
    return `
      <td class="prio-cell">
        <select class="prio prio-${UI.esc(lvl.key || `p${r.priority}`)}" data-priority="${UI.esc(r.component)}" data-was="${cur}"
          title="${UI.esc(lvl.label ? `${lvl.label} — ${lvl.name}` : 'No priority set')}">
          <option value=""${cur === '' ? ' selected' : ''}>—</option>
          ${levels.map(l => `<option value="${l.value}"${cur === String(l.value) ? ' selected' : ''}>${UI.esc(l.label)} ${UI.esc(l.name)}</option>`).join('')}
        </select>
      </td>`;
  }

  /**
   * The note — his column, and the one thing here that exists nowhere else.
   *
   * A textarea rather than a click-to-edit cell: the text is the point, it can
   * run to a few sentences, and a control you have to discover before you can
   * type in it is a column people stop using. It saves on blur, like the
   * priority beside it, so there is no Save button to forget.
   */
  function noteCell(d, r) {
    const v = r.note || '';
    return `
      <td class="note-col tool-start">
        <textarea class="note" rows="1" maxlength="${Number(d.noteMax) || 600}"
          data-note="${UI.esc(r.component)}" data-was="${UI.esc(v)}"
          placeholder="Add a note…">${UI.esc(v)}</textarea>
      </td>`;
  }

  /** A count that opens the epics it counted. */
  function drill(n, { row: component, tool, bucket }) {
    return UI.drillNumber(n, { act: 'pz-epics', row: component, tool, bucket });
  }

  /* ── behaviour ─────────────────────────────────────────────────────── */

  /* Changing the scope changes what the SERVER counts, not what the browser
     filters — the team cut happens against the Team field on every epic, so
     it cannot be done from a payload that was already narrowed. A full
     re-render is the honest way to say that. */
  function wireTeamBar(state, mount) {
    UI.$$('[data-sprint]', mount).forEach(b => b.addEventListener('click', () => {
      const want = b.dataset.sprint === 'exclude';
      if (want === excludeActiveSprint) return;
      excludeActiveSprint = want;
      // Both lenses counted the old population; neither survives it changing.
      level = null;
      family = null;
      App.refresh();
    }));
    UI.$$('[data-scope]', mount).forEach(b => b.addEventListener('click', () => {
      const wantAll = b.dataset.scope === 'all';
      if (wantAll === allTeams) return;
      allTeams = wantAll;
      // Both lenses counted the OLD scope's rows, so neither survives the
      // change — a P1 chip carried across from Titan means nothing on Ruby.
      level = null;
      family = null;
      App.refresh();
    }));
  }

  function wire(state, mount) {
    wireTeamBar(state, mount);

    /* THE CHIPS ARE DELEGATED, because `renderChips` replaces them on every
       click — each chip's count depends on the other lens, so they cannot be
       wired individually the way a control that outlives the render can. */
    mount.addEventListener('click', async (e) => {
      const close = e.target.closest && e.target.closest.bind(e.target);
      if (!close) return;

      const lv = close('[data-level]');
      if (lv) {
        const v = Number(lv.dataset.level);
        level = level === v ? null : v;
        return redraw(state, mount);
      }

      const fam = close('[data-family]');
      if (fam) {
        if (fam.disabled) return;
        const v = fam.dataset.family || null;
        family = family === v ? null : v;
        return redraw(state, mount);
      }

      const col = close('[data-col]');
      if (col) {
        if (col.disabled) return;      // the last visible column — see columnChips
        const key = col.dataset.col;
        if (key === '__all') hiddenCols.clear();
        else if (hiddenCols.has(key)) hiddenCols.delete(key);
        else if (visibleBuckets().length > 1) hiddenCols.add(key);
        else return;                   // belt and braces: never empty the grid
        saveCols();
        return redraw(state, mount);
      }

      const n = close('[data-act="pz-epics"]');
      if (n) {
        e.preventDefault();
        await openEpics(n.dataset, Number(String(n.textContent).replace(/[^0-9]/g, '')) || 0);
      }
    });

    /* The edit handlers go on the MOUNT, not on the controls, so they survive
       renderTable() replacing the tbody under them when a chip is clicked. */
    wireCells(state, mount);
  }

  /** Both lenses changed together, so both chip rows and the grid redraw. */
  function redraw(state, mount) {
    renderChips(mount);
    renderTable(state, mount);
  }

  /* WIRED ONCE PER MOUNT, NOT ONCE PER SESSION.
     `renderTable` replaces the tbody under these handlers on every chip
     click, so they are delegated to the mount and must not be re-attached
     each time — but App builds a BRAND NEW mount node on every render, so a
     plain `wired = true` flag would attach them to the first mount and leave
     every later visit to this page with dead Priority and Notes controls. The
     node itself is the identity that matters. */
  let wiredTo = null;
  function wireCells(state, mount) {
    if (wiredTo === mount) return;
    wiredTo = mount;

    mount.addEventListener('change', async (e) => {
      const sel = e.target.closest && e.target.closest('[data-priority]');
      if (sel) return savePriority(sel);
      const note = e.target.closest && e.target.closest('[data-note]');
      if (note) return saveNote(note);
    });
  }

  /**
   * Save, then put the control back if the server refused.
   *
   * The screen must never be left showing a value the server did not accept:
   * it looks identical to a saved one, and the next full render silently
   * replaces it with the real value without anything having said so.
   */
  async function savePriority(sel) {
    const name = sel.dataset.priority;
    const was = sel.dataset.was == null ? '' : sel.dataset.was;
    const value = sel.value === '' ? null : Number(sel.value);
    sel.disabled = true;
    try {
      await UI.jsonPut('/api/component-priority', { component: name, level: value });
      sel.dataset.was = sel.value;
      const lvl = (data.priorityLevels || []).find(l => l.value === value) || {};
      sel.className = `prio ${value == null ? 'prio-none' : `prio-${lvl.key || `p${value}`}`}`;
      // The row in hand, so a redraw from a chip click does not resurrect the
      // old level from a payload fetched before the edit.
      const r = data.rows.find(x => x.component === name);
      if (r) { r.priority = value; r.priorityLabel = lvl.label || null; }
      UI.toast(value == null ? `${name} — priority cleared` : `${name} — ${lvl.label || `P${value}`}`);
    } catch (err) {
      sel.value = was;
      UI.toast(err.message, true);
    } finally {
      sel.disabled = false;
    }
  }

  async function saveNote(box) {
    const name = box.dataset.note;
    const was = box.dataset.was == null ? '' : box.dataset.was;
    const value = String(box.value || '').trim();
    if (value === was.trim()) return;      // blur with nothing changed is not an edit
    box.disabled = true;
    try {
      await UI.jsonPut('/api/component-note', { component: name, note: value });
      box.dataset.was = value;
      box.value = value;
      const r = data.rows.find(x => x.component === name);
      if (r) r.note = value || null;
      UI.toast(value ? `${name} — note saved` : `${name} — note cleared`);
    } catch (err) {
      box.value = was;
      UI.toast(err.message, true);
    } finally {
      box.disabled = false;
    }
  }

  /**
   * The epics behind one cell.
   *
   * The SAME route the Coverage screen's grid uses, with the same scope
   * parameters, so the list cannot be a different set from the number that
   * opened it. `shown` is what the cell actually says, compared rather than
   * trusted: they always should agree, so a mismatch means the data moved
   * under the page and saying so beats quietly showing the other figure.
   */
  async function openEpics(ds, shownCount) {
    /* THE DRAWER IS NARROWED EXACTLY AS THE NUMBER WAS. The team scope and
       the in-flight option both change which epics were counted, so both
       travel with the request — a drawer that listed epics the cell had
       excluded would make the number uncheckable, which was its whole
       point. The server recomputes the same set from the same function. */
    const qs = [
      `row=${encodeURIComponent(ds.row)}`,
      `tool=${encodeURIComponent(ds.tool)}`,
      `bucket=${encodeURIComponent(ds.bucket)}`,
      data.team ? `team=${encodeURIComponent(data.team.id)}` : '',
      excludeActiveSprint ? 'excludeActiveSprint=1' : '',
    ].filter(Boolean).join('&');
    UI.drawer('<div class="empty">Reading…</div>');
    try {
      const r = await UI.api(`/api/reports/coverage/epics?${qs}`);
      const off = shownCount && shownCount !== r.count;
      UI.drawer(UI.drillDrawer({
        title: `${ds.row} — ${r.label}`,
        meaning: `${UI.int(r.count)} ${UI.esc(r.scope.toLowerCase())}${r.count === 1 ? '' : 's'}`
          + '. Excluded components and the team allow-list are already applied.'
          + (off ? ` The cell says ${UI.int(shownCount)} — it has been redrawn since this was opened.` : ''),
        keys: r.epics.map(e => e.key),
        catalogue: Object.fromEntries(r.epics.map(e => [String(e.key).toUpperCase(), e])),
      }));
    } catch (err) {
      UI.drawer(`<div class="empty">Could not read the epics — ${UI.esc(err.message)}</div>`);
    }
  }

  return { render };
})();
