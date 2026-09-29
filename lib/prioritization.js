'use strict';
/**
 * prioritization.js — the components he has actually decided about.
 *
 * The Coverage screen answers "what does the whole portfolio look like". This
 * one answers a narrower and more useful question: of the suites I have put a
 * priority on, where does each one stand in each tool, and what do I need to
 * remember about it. It is the sheet he has been keeping by hand, computed.
 *
 * ── WHAT DECIDES WHICH ROWS APPEAR ───────────────────────────────────────
 *
 * A PRIORITY, and nothing else. Not "has epics", not "appeared in the last
 * sync" — the row set is the set of judgements he has made. Two consequences,
 * both deliberate:
 *
 *   A prioritised component with NO epics still gets a row, with zeros across
 *   it. That row is the most interesting one on the page — a P1 suite nobody
 *   has written an epic for — and the obvious implementation, tallying epics
 *   and reading priorities off the result, is precisely the one that drops it.
 *
 *   A component with epics and no priority does NOT get a row. It is on the
 *   Coverage screen, which is the page for the whole portfolio. This page is
 *   the shortlist, and a shortlist that quietly includes everything is a list.
 *
 * ── THE NUMBERS COME FROM THE COVERAGE VIEW, NOT A SECOND WALK ───────────
 *
 * Same `coverage.view`, same exclusions, same team allow-list, same buckets.
 * The two screens will be read side by side and a component that says 12
 * Automated on one and 11 on the other is not a small bug — it makes both
 * numbers unusable, and neither page looks wrong while doing it.
 *
 * ── WHAT WAS CUT IS SAID OUT LOUD ────────────────────────────────────────
 *
 * A prioritised component can be in `excludedComponents`, which is a
 * contradiction he can only resolve if he can see it. The exclusion wins — it
 * is the more specific statement, "this is not an automation suite at all" —
 * and the component is reported in `excluded` rather than silently dropped.
 */

const coverage = require('./coverage');
const priority = require('./priority');
const notes = require('./component-note');
const ranks = require('./component-rank');
const epicsLib = require('./epics');
const reconcile = require('./reconcile');
const insights = require('./insights');

/* ── EPICS ALREADY PLANNED INTO THE ACTIVE SPRINT ─────────────────────────
 * An epic somebody is working on this sprint is not a candidate for
 * prioritising. Excluding those turns the page from "where does every ranked
 * suite stand" into "what have we NOT picked up yet", which is the question
 * you ask when choosing what to pull in next.
 *
 * TWO WAYS A SPRINT ITEM REACHES ITS EPIC, and the second is the one that
 * matters most here:
 *
 *   A STORY names its epic as its PARENT. New automation work.
 *
 *   A BUCKET STORY names its epics through "relates to" LINKS. A Bucket
 *   Story is a fortnight's container for maintenance, and the suites it is
 *   maintaining are exactly those links — which is how the Active sprint
 *   screen counts Maintained (linked epic is Automated) and Maintaining
 *   (linked epic is in Maintenance).
 *
 * Following only the parent misses the whole maintenance half: on his data
 * Ruby's active sprint reaches 18 epics by parent and 35 by both, and
 * Katalon Automation 9 against 49, because most of its sprint is Bucket
 * Stories. Both paths use the same helpers the sprint screen uses, so the
 * two pages cannot disagree about which epics are in hand.
 *
 * ONLY THE ACTIVE SPRINT. Work in a future sprint or sitting in the backlog
 * is a plan, not progress — those epics count here exactly as they always
 * did, which is the whole difference between "not started" and "not yet
 * picked up".
 */
const PLANNED_TYPES = /^(story|bucket story)$/i;

/**
 * @param {Array} teams  whose active sprints count. Several, because the
 *                       portfolio view has no single active sprint and
 *                       "planned by anyone" is the only honest reading there.
 * @returns {{keys, sprints, items, viaParent, viaLinks}}
 */
function activeSprintEpics(plan, snap, teams) {
  const lookup = (k) => (snap.issues || {})[String(k).trim().toUpperCase()] || null;
  const keys = new Set();
  const viaParent = new Set();
  const viaLinks = new Set();
  const sprints = [];
  const seenSprint = new Set();
  let items = 0;

  /* EVERY ACTIVE SPRINT, not just the first. A team can be running several
     at once and his are: Titan is in both "TT Week 14Sep" and "Katalon Titan
     Sprint 40", and Katalon Automation in three. `activeSprint` (singular)
     answers "which sprint should this screen show" and returns the first —
     using it here silently skipped whole sprints, so an epic with a Story in
     Titan's second sprint kept being counted as untouched. */
  for (const team of teams || []) {
    for (const sprint of reconcile.activeSprints(plan, team.id)) {
      /* ONE WALK, shared with the Capacity sheet's "By component" table.
         BOTH PATHS for a Bucket Story, because it carries a parent AND links
         to the suites it is maintaining, and `epicsFor`'s default rule stops
         at the parent. A Story keeps the default: its "relates to" is an
         ordinary cross-reference, not a claim to be maintaining that suite.

         `epicsFor` rather than the raw links, because it resolves what the
         links actually point AT — in AUTOKAT a maintenance ticket usually
         links the test case it maintains, and `epicsFor` climbs to that
         case's parent epic. Reading the links directly would collect test
         case keys, which match no epic and would exclude nothing. */
      const w = walkSprint(snap, team, sprint, lookup);
      items += w.items;
      for (const k of w.keys) keys.add(k);
      // `via` is the path that found it — 'parent', or one of the relates
      // rules. Taken from the walk rather than guessed at out here.
      for (const k of w.viaParent) viaParent.add(k);
      for (const k of w.viaLinks) viaLinks.add(k);

      /* Named, so the page can say WHICH sprints it read rather than asking
         to be trusted that "active" meant what the reader assumed. Deduped
         by team and label: two teams sharing one Jira sprint is normal. */
      const label = (sprint.byTeam && sprint.byTeam[team.id] && sprint.byTeam[team.id].name) || sprint.name || sprint.id;
      const id = `${team.id}|${label}`;
      if (!seenSprint.has(id)) {
        seenSprint.add(id);
        sprints.push({ team: team.name || team.id, label });
      }
    }
  }
  return { keys, sprints, items, viaParent: viaParent.size, viaLinks: viaLinks.size };
}

/* ── WHOSE EPICS COUNT ────────────────────────────────────────────────────
 * Two different things both narrow by team and they are not the same thing:
 *
 *   `plan.coverageTeams` is the GLOBAL allow-list — the Jira Team values that
 *   count as automation work at all. Empty means every team.
 *
 *   A selected team narrows further, to that team's own `jiraTeams` values.
 *
 * So the allow-list is their INTERSECTION, and the empty intersection is the
 * case that has to be handled rather than fallen through: `coverage.scoped`
 * reads an empty list as "no allow-list, count everyone", so a team whose
 * values are all outside the global list would silently widen to the whole
 * portfolio — the exact opposite of what picking that team asked for. It
 * returns nothing instead, and says why.
 */
function teamFilter(plan, team) {
  const global = (plan.coverageTeams || []).map(norm).filter(Boolean);
  if (!team) return { values: plan.coverageTeams || [], empty: false, team: null };

  const mine = (team.jiraTeams || []).map(String).filter(Boolean);
  if (!mine.length) {
    // A team with no Jira Team values mapped cannot claim an epic. Saying so
    // beats showing it the whole portfolio and letting it read as its own.
    return { values: [], empty: true, team, reason: 'no-jira-teams' };
  }
  const values = global.length ? mine.filter(v => global.includes(norm(v))) : mine;
  return { values, empty: !values.length, team, reason: values.length ? null : 'outside-allow-list' };
}

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * @param {object} snap  the store snapshot
 * @param {object} plan  the plan — priorities, notes, exclusions, team allow-list
 * @param {object} opts  `scope` (issue type, default Epic) and `team` (one of
 *                       plan.teams, or null for every team)
 */
function view(snap, plan, { scope = 'Epic', team = null, excludeActiveSprint = false } = {}) {
  const p = plan || {};
  const exclude = p.excludedComponents || [];
  const filter = teamFilter(p, team);

  /* The epics already planned into the active sprint. With a team selected
     that is its own sprint; on the portfolio view it is every team's,
     because there "planned" can only mean "planned by anyone". */
  const planned = excludeActiveSprint
    ? activeSprintEpics(p, snap, team ? [team] : (p.teams || []))
    : { keys: new Set(), sprints: [], items: 0, viaParent: 0, viaLinks: 0 };

  /* An empty allow-list with a team selected means nothing can match, and
     `coverage.view` would read it as "count everyone". Counting nothing is
     the honest answer, and the page says which of the two reasons it was. */
  const cov = filter.empty
    ? { byTool: [], omitted: 0 }
    : coverage.view(snap, { scope, exclude, teams: filter.values, omit: planned.keys });

  // Everything the coverage read found, by component, so a prioritised
  // component can be looked up rather than searched for per row.
  const found = new Map((cov.byTool || []).map(r => [r.component, r]));

  const excludedSet = coverage.excludeSet(exclude);
  const wanted = Object.keys(p.componentPriority || {})
    .map(c => String(c).trim())
    .filter(Boolean);

  const excluded = [];
  const elsewhere = [];
  const rows = [];
  for (const component of new Set(wanted)) {
    const level = priority.of(p, component);
    // A key whose value this tool cannot read is not a row — `priority.of`
    // already says so, and inventing a row for it would put a component on
    // the page with an empty Priority cell, which is the one thing that
    // cannot happen here: the priority IS the reason the row exists.
    if (level == null) continue;
    if (excludedSet.has(String(component).toLowerCase())) { excluded.push(component); continue; }

    /* WITH A TEAM SELECTED, THE LIST IS THAT TEAM'S WORK. A ranked component
       with no epic carrying this team's Team field is not this team's row —
       showing it under every team would put the same 31 empty rows on seven
       different pages and none of them would mean anything.

       It is not dropped in silence either: it is counted in `elsewhere`, so
       the page can say how many of his priorities this team has nothing
       against. With NO team selected the rule is the opposite and equally
       deliberate — an epic-less P1 is the most interesting row on the
       portfolio view, so it stays. */
    if (team && !found.has(component)) { elsewhere.push(component); continue; }

    rows.push({
      ...(found.get(component) || coverage.emptyToolRow(component)),
      priority: level,
      priorityLabel: priority.levelOf(level).label,
      /* The row already carries `family` (the long label, from the coverage
         read). The KEY is what a filter compares against, and it is put here
         rather than derived in the browser so the chip and the row agree by
         construction — a view re-deriving the family from the component name
         is a second implementation of the prefix rules. */
      familyKey: coverage.familyKeyOf(component),
      /* THE UNTAGGED BUCKET IS NOT A COMPONENT. `— no component —` is a
         label for the epics nobody tagged, so a link built from it as a name
         searches for a suite that does not exist and returns nothing. Said
         here rather than left for each view to compare against the literal —
         which is how the string ended up hard-coded in a second file, and
         how this link was wrong to begin with. */
      noComponent: component === coverage.NO_COMPONENT,
      note: notes.of(p, component),
      /* HIS OWN ORDER within this level, or null when he has never placed
         this one. On the row rather than looked up in the comparator, so the
         sort and the screen are reading the same value. */
      rank: ranks.of(p, component),
      // Said explicitly rather than inferred from `total === 0` by three
      // different readers. It is also not the same statement: with a team
      // allow-list on, a component can have epics and still count none here.
      tracked: found.has(component),
    });
  }

  rows.sort(byPriorityThenRank);

  return {
    scope,
    rows,
    tools: coverage.TOOLS,
    buckets: coverage.BUCKETS,
    priorityLevels: priority.LEVELS,
    totals: totalsOf(rows),
    /* The shape of the shortlist itself: how many of each level, so the page
       can say "9 components, 3 of them P1" without counting rows in the
       browser and getting a different answer from the one that built them. */
    byLevel: priority.LEVELS.map(l => ({
      ...l, count: rows.filter(r => r.priority === l.value).length,
    })),
    /* The families present, in the model's own order, with what each holds.
       EVERY declared family ships, `has` saying which ones actually have
       rows — so the filter is a stable row of chips rather than one that
       reshuffles as priorities change, and a family that is empty today says
       so instead of disappearing. */
    families: coverage.FAMILIES.map(f => {
      const count = rows.filter(r => r.familyKey === f.key).length;
      return { key: f.key, short: f.short, label: f.label, count, has: count > 0 };
    }),
    untracked: rows.filter(r => !r.tracked).map(r => r.component),
    excluded,
    /* Ranked, but nothing in it belongs to the selected team. Always [] when
       no team is selected, because then there is no "elsewhere" to be in. */
    elsewhere: elsewhere.sort((a, b) => String(a).localeCompare(String(b))),
    /* WHOSE WORK THIS IS, in the shape the page needs to say it out loud. A
       filtered page that does not name its own filter is a page you can read
       for ten minutes before realising it answered a narrower question. */
    team: team ? {
      id: team.id,
      name: team.name || team.id,
      jiraTeams: filter.values,
      /* Why it is empty, when it is: 'no-jira-teams' means this team has no
         Jira Team values mapped at all (fix it in Integrations & setup);
         'outside-allow-list' means it has some and the global coverage
         allow-list excludes every one of them. Two different fixes, so they
         are two different answers rather than one blank page. */
      empty: filter.empty,
      reason: filter.reason || null,
    } : null,
    /* THE ONE OPTION THAT MAKES THIS PAGE DISAGREE WITH COVERAGE ON PURPOSE.
       Everything else here is the same reading of the same epics; this drops
       some of them. So it reports what it did — whether it is on, how many
       epics it removed, how many sprint items that was and which sprints
       were read — and the screen says so where the numbers are, rather than
       leaving a reader to wonder why two pages differ. */
    activeSprint: {
      excluded: !!excludeActiveSprint,
      epics: cov.omitted || 0,
      matched: planned.keys.size,
      items: planned.items,
      sprints: planned.sprints,
      /* The two paths, separately, because they answer different questions:
         `viaParent` is new automation being written, `viaLinks` is the
         maintenance a Bucket Story is carrying. Following only the first is
         the bug this field exists to make visible. */
      viaParent: planned.viaParent,
      viaLinks: planned.viaLinks,
    },
    /* What the numbers are a count OF, so the page can state its own scope
       instead of a reader assuming it covers everything. */
    scopeNote: {
      excludedComponents: exclude.length,
      teams: filter.values.length ? filter.values : null,
      epics: (cov.byTool || []).reduce((t, r) => t + r.total, 0),
    },
  };
}

/* ── THE SPRINT SHEET: BACKLOG BESIDE WHAT THE SPRINT PICKED UP ───────────
 *
 * The Capacity screen's "By component" table is the sheet he keeps by hand:
 * for each ranked suite, what is left to do in each tool, and what this
 * sprint has actually taken on. Two halves that only mean something together,
 * which is the whole reason they are one table and not two.
 *
 * BOTH HALVES COUNT THE SAME THING — EPICS (test cases). The backlog trio is
 * the Prioritization page's own numbers, unchanged. The planned pair had a
 * choice: Jira items, or the suites behind them. Items would have made the
 * row unreadable across — "4 Ready" against "12 planned" where the 12 are
 * twelve tickets against three suites. So the planned half resolves to epics
 * too, and a row reads left to right in one unit.
 *
 * ── WHAT "BACKLOG" EXCLUDES ──────────────────────────────────────────────
 *
 * Epics planned into ANY OPEN SPRINT — the active one, the one selected, and
 * any future sprint. His rule, in his words: "Exclude the planned ones in
 * active sprint, this sprint and other sprints. If selected sprint = active
 * sprint the backlog should exclude the active sprint only" — the second
 * sentence being the case where that union collapses to one set, not a
 * different rule for it.
 *
 * CLOSED SPRINTS ARE HISTORY AND ARE NOT EXCLUDED. An epic that sat in
 * Sprint 38 and is still in Maintenance today is backlog — it is work not
 * done, and the sprint it was once planned into says nothing about that. The
 * opposite reading would let a suite disappear from the page permanently
 * because somebody once pulled it in, which is the failure this table exists
 * to prevent.
 */

/** Sprints not yet finished for one team — active AND future. */
function openSprints(plan, teamId) {
  return (plan.sprints || []).filter(s => {
    const t = s.byTeam && s.byTeam[teamId];
    return !!t && t.state !== 'closed';
  });
}

/**
 * ONE SPRINT, walked once, classified two ways.
 *
 * `build` and `maint` are the two kinds of work, which is NOT the same split
 * as `viaParent`/`viaLinks` and must not be confused with it:
 *
 *   A STORY is new automation. Its epic is its PARENT, and that is the only
 *   path taken — a Story's "relates to" is an ordinary cross-reference, not a
 *   claim to be maintaining that suite.
 *
 *   A BUCKET STORY is a fortnight's maintenance container, and the suites it
 *   maintains are its LINKS. Its parent is not one of them: on his data every
 *   Bucket Story in Ruby's sprint parents to AUTOKAT-7789, one bucket epic
 *   holding the lot. Counting that parent would put a phantom row on the
 *   table and inflate whichever component that epic happens to carry, on
 *   every team, every sprint. So the parent is read for `viaParent` — where
 *   it only ever feeds a set of keys to exclude — and ignored for `maint`.
 *
 * A Bucket Story naming no suite at all is real (AUTOKAT-10532 is one) and is
 * counted in `unlinked` rather than dropped in silence: it is maintenance
 * effort the table cannot attribute, and a reader is owed that number.
 */
function walkSprint(snap, team, sprint, lookup) {
  const up = (k) => String(k == null ? '' : k).trim().toUpperCase();
  const out = {
    keys: new Set(), viaParent: new Set(), viaLinks: new Set(),
    build: new Set(), maint: new Set(), items: 0, unlinked: 0,
  };
  const inSprint = (insights.sprintIssueKeys(snap, team, sprint) || []).map(lookup).filter(Boolean);
  const planned = inSprint.filter(i => PLANNED_TYPES.test(String(i.issueType || '').trim()));
  out.items = planned.length;

  for (const issue of planned) {
    const bucket = epicsLib.isBucketStory(issue);
    let named = 0;
    for (const e of epicsLib.epicsFor(issue, lookup, { both: bucket })) {
      if (!e.key) continue;
      const key = up(e.key);
      out.keys.add(key);
      if (e.via === 'parent') out.viaParent.add(key);
      else out.viaLinks.add(key);

      /* A BUCKET STORY TAKES ITS LINKS AND NOT ITS PARENT — the container
         epic above. A STORY TAKES WHATEVER `epicsFor` GIVES IT: its default
         rule already prefers the parent and only falls back to the links when
         there is no parent at all, so filtering on `via === 'parent'` here
         would silently drop the parentless Story rather than narrow it. */
      if (bucket) { if (e.via !== 'parent') { out.maint.add(key); named++; } }
      else { out.build.add(key); named++; }
    }
    if (bucket && !named) out.unlinked++;
  }
  return out;
}

/** The label this sprint goes by for this team — its own name wins. */
function sprintLabel(sprint, teamId) {
  if (!sprint) return '';
  return (sprint.byTeam && sprint.byTeam[teamId] && sprint.byTeam[teamId].name)
    || sprint.name || sprint.id || '';
}

/**
 * Epics with work planned in any OPEN sprint for these teams — the set the
 * backlog half leaves out. Separate from `activeSprintEpics` because that one
 * answers a narrower question (what is in flight RIGHT NOW) that the
 * Prioritization page asks and must keep asking.
 */
function openSprintEpics(plan, snap, teams) {
  const lookup = (k) => (snap.issues || {})[String(k).trim().toUpperCase()] || null;
  const keys = new Set();
  const sprints = [];
  const seen = new Set();
  let items = 0;
  for (const team of teams || []) {
    for (const sprint of openSprints(plan, team.id)) {
      const w = walkSprint(snap, team, sprint, lookup);
      for (const k of w.keys) keys.add(k);
      items += w.items;
      const label = sprintLabel(sprint, team.id);
      const id = `${team.id}|${label}`;
      if (seen.has(id)) continue;
      seen.add(id);
      sprints.push({
        team: team.name || team.id, label,
        state: (sprint.byTeam && sprint.byTeam[team.id] && sprint.byTeam[team.id].state) || 'future',
      });
    }
  }
  return { keys, sprints, items };
}

/** A component's cell pair for one tool, before anything is counted into it. */
const blankCell = () => ({
  maintenance: 0, ready: 0, blocked: 0, backlog: 0,
  build: 0, maint: 0, planned: 0,
  keys: { maintenance: [], ready: [], blocked: [], build: [], maint: [] },
});

const BACKLOG_BUCKETS = ['maintenance', 'ready', 'blocked'];

/* THE PLANNED PAIR, DECLARED ONCE. The table's column headings, the drawer's
   title and the export's column names all need these two words, and a second
   list in the view is how the header says "New build" while the drawer that
   opens from it says "build". The backlog trio already comes from
   `coverage.BUCKETS` for exactly this reason; this is its other half. */
const PLANNED_COLS = [
  { key: 'build', label: 'New build', title: 'Suites with a Story planned in this sprint — new automation' },
  { key: 'maint', label: 'Maintenance', title: 'Suites a Bucket Story in this sprint is maintaining' },
];
const PLANNED_KINDS = PLANNED_COLS.map(c => c.key);

/**
 * THE "BY COMPONENT" TABLE for one team and one selected sprint.
 *
 * Rows are the ranked components — the same rule as `view` above, and for the
 * same reason: a P1 suite with nothing against it in either half is the row
 * worth looking at, and any implementation that tallies first and reads
 * priorities off the result is precisely the one that drops it.
 *
 * @param {object} opts  `team` (required — this is a team's sprint sheet) and
 *                       `sprint`, the one the picker is showing.
 */
function sprintComponents(snap, plan, { team = null, sprint = null, scope = 'Epic' } = {}) {
  const p = plan || {};
  const exclude = p.excludedComponents || [];
  const filter = teamFilter(p, team);
  const lookup = (k) => (snap.issues || {})[String(k).trim().toUpperCase()] || null;

  /* ── THE TWO HALVES ARE SCOPED DIFFERENTLY, ON PURPOSE ────────────────
   *
   * THE BACKLOG IS THE WHOLE PORTFOLIO — every team. "What is left to
   * automate in this suite" is not a per-team fact: the suite is the suite,
   * and a Ruby lead deciding what Ruby should pull in next needs to see the
   * whole queue, not the slice of it that happens to carry Ruby's Team field.
   * Narrowing it by team also made the sheet lie by omission — a suite with
   * forty Ready epics under another squad's name read as empty, which is the
   * opposite of "nobody has picked this up".
   *
   * THE PLANNED HALF IS THIS TEAM'S SPRINT, necessarily: it is read from the
   * sprint's own issue list, which belongs to one team by construction. The
   * header names the sprint and the scope line names the team, so the row
   * reads "here is the whole queue, and here is our share of it this
   * fortnight" — which is the comparison the table exists for.
   *
   * WHAT IS EXCLUDED IS THE ACTIVE SPRINT, AND ONLY THE ACTIVE SPRINT.
   * Backlog means "nobody is working on this right now", so the one thing
   * that disqualifies an epic is somebody working it right now. A FUTURE
   * sprint is a plan, not progress — the same distinction `activeSprintEpics`
   * has always drawn for the Prioritization page — and an epic earmarked for
   * Sprint 43 is still, today, work not being done. Excluding those made the
   * backlog shrink every time somebody filled in a future sprint, which is
   * the opposite of what filling one in means.
   *
   * IT IS EVERY TEAM'S ACTIVE SPRINT, because the count is every team's.
   * Scope and exclusion have to move together: widen one without the other
   * and the backlog either hides work nobody has (too narrow an exclusion is
   * safe; too wide is not) or fills up with work that is demonstrably being
   * done. With both portfolio-wide, this half is exactly the Prioritization
   * page's numbers with "exclude active sprint items" on and no team
   * selected — a property worth having, because the two screens get read
   * side by side.
   *
   * The only other scope is the GLOBAL allow-list (`plan.coverageTeams`) and
   * the excluded components — the same two settings the Coverage screen
   * uses.
   */
  const backlogTeams = p.coverageTeams || [];
  const inFlight = activeSprintEpics(p, snap, p.teams || []);
  /* QUEUED BUT NOT STARTED, kept separately and NOT excluded. These epics
     are in the backlog above — correctly, nobody is working them — and some
     of them already have a home in a future sprint. That is worth saying on
     a capacity screen ("41 of these are already earmarked") rather than
     leaving a reader to wonder why a suite they queued last week is still
     in the queue. Reported, never subtracted. */
  const queued = openSprintEpics(p, snap, p.teams || []);

  /* ── THE BACKLOG HALF ──────────────────────────────────────────────
     `coverage.classify`, not a second walk. Same exclusions, same allow-list,
     same buckets, same `omit` mechanism the Prioritization page uses — so a
     component reading 4 Ready there and 4 Ready here is a guarantee rather
     than a coincidence that survived until the next edit. */
  /* `noTeam: true` — AN EPIC WITH AN EMPTY TEAM FIELD IS STILL IN THE QUEUE.
     "All teams" has to mean all of them, including the epics nobody has
     assigned one to. Without this, PS_iGO_Lafayette showed 8 Blocked and no
     Ready at all while carrying 14 untagged Ready epics, and 295 epics across
     16 ranked suites were invisible on this sheet — a queue hiding a quarter
     of itself. The option is this module's alone: the Coverage ratio and the
     Prioritization page keep the stricter reading, because a percentage
     should not move for an epic nobody has declared either way. */
  const cls = coverage.classify(snap, {
    scope, exclude, teams: backlogTeams, omit: inFlight.keys, noTeam: true,
  });

  const cells = new Map();  // component -> { truetest, kse }
  const cell = (component, tool) => {
    if (!cells.has(component)) {
      cells.set(component, Object.fromEntries(coverage.TOOLS.map(t => [t.key, blankCell()])));
    }
    return cells.get(component)[tool];
  };

  for (const { issue, bucket, tool } of cls.classified) {
    if (!BACKLOG_BUCKETS.includes(bucket)) continue;
    for (const c of cls.comps(issue)) {
      const x = cell(c, tool);
      x[bucket]++;
      x.backlog++;
      x.keys[bucket].push(issue.key);
    }
  }

  /* ── THE PLANNED HALF ──────────────────────────────────────────────
     The selected sprint alone, whatever its state. He may be planning three
     sprints ahead; "what has this sprint taken on" is the question either
     way, and answering it only for the active sprint would make the picker
     change one half of the table and not the other. */
  const walk = (team && sprint) ? walkSprint(snap, team, sprint, lookup)
    : { build: new Set(), maint: new Set(), items: 0, unlinked: 0 };

  /* An epic reached from the sprint still has to be IN SCOPE to be counted
     into a row, and it is the BACKLOG's scope that decides — the same
     allow-list and the same exclusions — because the two halves sit in one
     row and a row whose halves were counted over different populations does
     not read across. Scoping this half by the team's own Jira Team values
     would drop a suite the team is demonstrably working on, purely because
     somebody else's name is on the epic.

     `classify` is re-run with no `omit`, because the planned epics are
     exactly the ones the backlog read left out; reusing that pass would find
     none of them. */
  const full = coverage.classify(snap, { scope, exclude, teams: backlogTeams, noTeam: true });
  const inScope = new Map(full.classified.map(c => [c.issue.key, c]));

  const plannedOut = { build: 0, maint: 0, outOfScope: 0 };
  for (const kind of PLANNED_KINDS) {
    const field = kind === 'build' ? 'build' : 'maint';
    for (const key of walk[field]) {
      const hit = inScope.get(key);
      if (!hit) { plannedOut.outOfScope++; continue; }
      plannedOut[kind]++;
      for (const c of full.comps(hit.issue)) {
        const x = cell(c, hit.tool);
        x[kind]++;
        x.planned++;
        x.keys[kind].push(key);
      }
    }
  }

  const excludedSet = coverage.excludeSet(exclude);
  const wanted = Object.keys(p.componentPriority || {}).map(c => String(c).trim()).filter(Boolean);

  const excluded = [];
  const rows = [];
  for (const component of new Set(wanted)) {
    const level = priority.of(p, component);
    if (level == null) continue;
    if (excludedSet.has(String(component).toLowerCase())) { excluded.push(component); continue; }

    const found = cells.get(component);
    /* UNLIKE THE PRIORITIZATION PAGE, A ROW WITH NOTHING IN IT STAYS. There
       the empty row meant "this team has no epics for your priority" and was
       moved to `elsewhere` to keep six teams from each showing the same 31
       blanks. Here every number is already this team's AND this sprint's, and
       a ranked suite with no backlog and nothing planned is the sheet's most
       actionable line: finished, or forgotten. Hiding it would answer a
       question nobody asked. */
    const row = {
      component,
      priority: level,
      priorityLabel: priority.levelOf(level).label,
      /* The chip's class and its tooltip, both from the level model. The
         Prioritization page derives `prio-${key}` the same way for its
         select; a view rebuilding it from the number is how one screen ends
         up styling P4 and the other not. */
      priorityKey: priority.levelOf(level).key,
      priorityName: priority.levelOf(level).name,
      family: coverage.familyOf(component),
      familyKey: coverage.familyKeyOf(component),
      noComponent: component === coverage.NO_COMPONENT,
      note: notes.of(p, component),
      /* HIS OWN ORDER within this level, or null when he has never placed
         this one. On the row rather than looked up in the comparator, so the
         sort and the screen are reading the same value. */
      rank: ranks.of(p, component),
      ...(found || Object.fromEntries(coverage.TOOLS.map(t => [t.key, blankCell()]))),
    };
    row.backlog = coverage.TOOLS.reduce((t, x) => t + row[x.key].backlog, 0);
    row.planned = coverage.TOOLS.reduce((t, x) => t + row[x.key].planned, 0);
    row.empty = row.backlog === 0 && row.planned === 0;
    rows.push(row);
  }

  rows.sort(byPriorityThenRank);

  return {
    scope,
    rows,
    tools: coverage.TOOLS,
    backlogBuckets: BACKLOG_BUCKETS.map(k => coverage.BUCKETS.find(b => b.key === k)).filter(Boolean),
    plannedCols: PLANNED_COLS,
    /* The note box's cap, from the model that enforces it. The Prioritization
       payload already carries this; both screens edit the SAME note through
       the same route, so a `maxlength` either of them invented would let one
       screen offer a length the server then refuses. */
    noteMax: notes.MAX,
    totals: sprintTotalsOf(rows),
    /* THE FAMILY CHIPS, in the model's own order, with what each holds.
       EVERY declared family ships, `has` saying which ones actually have rows
       — so the filter is a stable row of chips rather than one that reshuffles
       as the sprint changes, and a family that is empty this sprint says so
       instead of disappearing. Same rule, same shape, as the Prioritization
       page's chips: a second derivation in the browser is how the two screens
       end up disagreeing about what counts as R&D. */
    families: coverage.FAMILIES.map(f => {
      const count = rows.filter(r => r.familyKey === f.key).length;
      /* COUNTED ON THE ROWS THAT HAVE SOMETHING, separately. The table folds
         its clear rows away by default, so a chip reading "R&D 41" over a
         table showing three is the chip counting a different population from
         the one it filters. Both numbers ship and the view picks the one that
         matches what it is drawing. */
      const busy = rows.filter(r => r.familyKey === f.key && !r.empty).length;
      return { key: f.key, short: f.short, label: f.label, count, busy, has: count > 0 };
    }),
    excluded,
    /* WHOSE NUMBERS EACH HALF IS, stated separately, because they are not the
       same answer and the screen has to say so where the figures are. A
       single "team" field here is how a portfolio backlog gets read as this
       team's — the failure the Prioritization screen already learned once. */
    scopes: {
      backlog: {
        allTeams: true,
        /* The global coverage allow-list, named. Empty means every Jira Team
           value counts, which is a different statement from "these four do"
           and the screen should be able to make either one. */
        teams: backlogTeams,
        label: backlogTeams.length ? `all teams (${backlogTeams.length} in scope)` : 'all teams',
        /* HOW MANY GOT IN FOR HAVING NO TEAM AT ALL. A number that moved
           because of this rule has to be able to say so — and 295 epics
           nobody has assigned a Team to is itself a finding worth a line on
           the screen, not a silent adjustment. */
        noTeam: cls.noTeamCount || 0,
      },
      planned: {
        allTeams: false,
        team: team ? (team.name || team.id) : null,
        label: team ? (team.name || team.id) : 'no team selected',
      },
    },
    team: team ? {
      id: team.id, name: team.name || team.id,
      /* KEPT FOR REFERENCE, NOT FOR SCOPING. Nothing in this view is narrowed
         by the team's Jira Team values any more — the backlog is portfolio-
         wide and the planned half is read from the sprint's own issue list,
         which belongs to one team by construction. So `empty` no longer means
         "this sheet counts nothing"; it means this team cannot claim an epic
         by its Team field, which is worth saying on the settings screen and
         changes not one number here. */
      jiraTeams: filter.values, mappedEmpty: filter.empty, reason: filter.reason || null,
    } : null,
    /* THE SPRINT THE PLANNED COLUMNS BELONG TO, by name, because the header
       says "{Sprint} Planned" and a header naming a sprint the numbers did
       not come from is worse than no header at all. */
    sprint: sprint ? {
      id: sprint.id,
      label: sprintLabel(sprint, team ? team.id : null),
      state: (team && sprint.byTeam && sprint.byTeam[team.id] && sprint.byTeam[team.id].state) || null,
    } : null,
    /* WHAT THE BACKLOG HALF LEFT OUT, said out loud — the count, and the
       sprints that were read, so the reader can check the rule rather than
       trust it. ACTIVE SPRINTS ONLY: work in flight right now. */
    backlogExcludes: {
      epics: inFlight.keys.size,
      items: inFlight.items,
      sprints: inFlight.sprints,
    },
    /* ALREADY EARMARKED, AND STILL IN THE BACKLOG ABOVE. An epic with work
       queued in a FUTURE sprint is counted in the backlog — nobody is doing
       it yet, which is what backlog means — and it is not quite the same as
       one nobody has looked at. The difference is the number, not a second
       column: subtracting these would make the backlog shrink every time
       somebody fills in a future sprint, which is the opposite of what
       filling one in means. `epics` counts only those that ARE in the
       backlog, so it can never exceed it. */
    queuedAhead: (() => {
      /* In-flight epics are dropped twice over: once here, and again by
         `counted` below, which is built from a classification that already
         omitted them. The second is what does the work; this one states the
         intent, so a later change to how `counted` is built cannot quietly
         start counting a suite as "merely queued" while it is being worked. */
      const ahead = new Set();
      for (const k of queued.keys) if (!inFlight.keys.has(k)) ahead.add(k);
      /* THE BACKLOG TRIO, not everything `classify` returned. An Automated
         epic queued for a future sprint is in scope and is NOT in the
         backlog, so counting it here would claim more earmarked suites than
         the table has rows for. */
      const counted = new Set(cls.classified
        .filter(c => BACKLOG_BUCKETS.includes(c.bucket))
        .map(c => c.issue.key));
      let epics = 0;
      for (const k of ahead) if (counted.has(k)) epics++;
      return {
        epics,
        sprints: queued.sprints.filter(s => s.state !== 'active'),
      };
    })(),
    /* WHAT THE PLANNED HALF COULD NOT PLACE. `unlinked` is Bucket Stories
       naming no suite; `outOfScope` is epics the sprint reached that this
       team's allow-list or the component exclusions keep off the page. Both
       are effort that is real and not in any row. */
    plannedNotes: {
      items: walk.items,
      unlinked: walk.unlinked,
      outOfScope: plannedOut.outOfScope,
      build: plannedOut.build,
      maint: plannedOut.maint,
    },
  };
}

/* ── ONE CELL'S EPICS ─────────────────────────────────────────────────────
 * The drill-in behind a number on the "By component" sheet.
 *
 * IT RUNS `sprintComponents` AND READS THE CELL'S OWN KEY LIST. Not a second
 * query shaped like the first: the cardinal rule of every drill-in here is
 * that the drawer lists exactly the set the number was the size of, and the
 * only way to guarantee that is to take the keys FROM the number. A route
 * rebuilding the same filter from its query string is a second implementation
 * that agrees until the day it does not, and when it stops agreeing neither
 * side says which one is wrong.
 *
 * The cost is recomputing the sheet per drawer, which is one pass over the
 * epics — the same pass the screen already does on every load.
 */
function sprintComponentCell(snap, plan, { team, sprint, component, tool, cell, scope = 'Epic' } = {}) {
  const view = sprintComponents(snap, plan, { team, sprint, scope });
  const row = view.rows.find(r => r.component === component) || null;
  const toolDef = coverage.TOOLS.find(t => t.key === tool) || null;
  const known = [...BACKLOG_BUCKETS, ...PLANNED_KINDS];
  if (!row || !toolDef || !known.includes(cell)) {
    return { ok: false, row: component, tool, cell, known, epics: [], count: 0 };
  }

  const keys = (row[tool].keys[cell] || []);
  const bucket = coverage.BUCKETS.find(b => b.key === cell);
  const planned = PLANNED_COLS.find(c => c.key === cell);

  return {
    ok: true,
    scope: view.scope,
    row: component,
    tool,
    cell,
    /* WHAT THE NUMBER MEANT, in the drawer's own words. Built here rather
       than in the browser so the heading and the count come from one place —
       a drawer titled "Maintenance" over a list of planned work is the kind
       of wrong that reads as correct. */
    label: [toolDef.label, bucket ? bucket.label : planned.label].join(' · '),
    half: bucket ? 'backlog' : 'planned',
    sprint: view.sprint,
    team: view.team,
    /* BOTH SCOPES TRAVEL WITH THE DRAWER. The half it is listing decides
       which one the heading quotes, and a drawer that explained a portfolio
       backlog as this team's would make its own extra rows look like a bug. */
    scopes: view.scopes,
    count: keys.length,
    epics: keys.map((k) => {
      const i = (snap.issues || {})[k] || null;
      if (!i) return { key: k, absent: true };
      return {
        key: i.key,
        summary: i.summary || '',
        status: i.status || '',
        statusCategory: i.statusCategory || '',
        automationStatus: i.automationStatus || '',
        team: i.team || '',
        components: coverage.productComponents(i, coverage.excludeSet(plan.excludedComponents || [])),
        /* WHAT IS ACTUALLY BLOCKING IT — the Jira "is blocked by" links, which
           are NOT the same thing as the Blocked column. That column comes from
           the Automation Status FIELD; this comes from a link somebody made,
           and the gap between the two is the difference between "blocked" and
           "blocked by something we can go and chase". */
        blockedBy: i.blockedBy || [],
      };
    }),
  };
}

/** The footer, summed from the rows on screen — same rule as `totalsOf`. */
function sprintTotalsOf(rows) {
  const out = { components: rows.length, backlog: 0, planned: 0 };
  for (const t of coverage.TOOLS) {
    const row = { key: t.key, label: t.label, backlog: 0, planned: 0 };
    for (const k of BACKLOG_BUCKETS) row[k] = 0;
    for (const k of PLANNED_KINDS) row[k] = 0;
    for (const r of rows) {
      for (const k of BACKLOG_BUCKETS) row[k] += r[t.key][k];
      for (const k of PLANNED_KINDS) row[k] += r[t.key][k];
      row.backlog += r[t.key].backlog;
      row.planned += r[t.key].planned;
    }
    out[t.key] = row;
    out.backlog += row.backlog;
    out.planned += row.planned;
  }
  return out;
}

/**
 * THE ORDER OF THE SHEET: level, then his own order within it, then name.
 *
 * LEVEL IS STILL THE PRIMARY KEY and rank only breaks ties inside it. The
 * alternative — one flat ordering where dragging a row far enough turns a P3
 * into a P1 — is wrong in a way that is hard to see: the Priority column would
 * still read P3 while the row sat among the P1s, and the export, the Capacity
 * sheet and every other reader would disagree with the screen.
 *
 * NAME IS STILL THE LAST WORD, because rank is sparse. A component he has
 * never dragged has `rank: null`, sorts as Infinity, and therefore lands after
 * every ranked component in its level in exactly the alphabetical order it
 * used to be in. That is what keeps adding a component to the project from
 * disturbing an order he set last quarter.
 *
 * ONE COMPARATOR, both readers. The Prioritization screen and the Capacity
 * sheet's "By component" table share it, so the order he drags on one is the
 * order the other draws — which is the whole reason the rank lives in the plan
 * rather than in that screen's memory.
 */
function byPriorityThenRank(a, b) {
  return priority.sortKey(a.priority) - priority.sortKey(b.priority)
    || rankOf(a) - rankOf(b)
    || String(a.component).localeCompare(String(b.component));
}
/* Off the ROW, not looked up again from the plan: both callers already
   decorated it, and a comparator that reached for the plan would be sorting by
   something other than what the row says it is. */
const rankOf = (r) => (Number.isInteger(r && r.rank) ? r.rank : ranks.UNRANKED);

/* The old name, kept because it is exported and describes what the sort still
   does when nothing has been ranked. */
const byPriorityThenName = byPriorityThenRank;

/**
 * The column totals under the grid.
 *
 * Summed from the ROWS ON SCREEN, not from the coverage view's own tool
 * totals: those count the whole portfolio, and a footer that silently totalled
 * 125 components under a table showing nine would be wrong in the way that is
 * hardest to catch — every individual figure on the page correct, and the one
 * line a reader actually quotes in a status update not.
 */
function totalsOf(rows) {
  const out = { total: 0, components: rows.length };
  for (const t of coverage.TOOLS) {
    const row = { key: t.key, label: t.label, total: 0 };
    for (const b of coverage.BUCKETS) row[b.key] = 0;
    for (const r of rows) {
      for (const b of coverage.BUCKETS) row[b.key] += r[t.key][b.key];
      row.total += r[t.key].total;
    }
    out[t.key] = row;
    out.total += row.total;
  }
  return out;
}

module.exports = {
  view, byPriorityThenRank, byPriorityThenName, totalsOf, activeSprintEpics, PLANNED_TYPES,
  sprintComponents, sprintComponentCell, sprintTotalsOf,
  openSprintEpics, openSprints, walkSprint, sprintLabel,
  BACKLOG_BUCKETS, PLANNED_COLS,
};
