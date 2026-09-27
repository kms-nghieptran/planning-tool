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
  const up = (k) => String(k == null ? '' : k).trim().toUpperCase();
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
      const inSprint = (insights.sprintIssueKeys(snap, team, sprint) || []).map(lookup).filter(Boolean);
      const planned = inSprint.filter(i => PLANNED_TYPES.test(String(i.issueType || '').trim()));
      items += planned.length;

      for (const issue of planned) {
      /* BOTH PATHS for a Bucket Story, because it carries a parent AND links
         to the suites it is maintaining, and `epicsFor`'s default rule stops
         at the parent. A Story keeps the default: its "relates to" is an
         ordinary cross-reference, not a claim to be maintaining that suite.

         `epicsFor` rather than the raw links, because it resolves what the
         links actually point AT — in AUTOKAT a maintenance ticket usually
         links the test case it maintains, and `epicsFor` climbs to that
         case's parent epic. Reading the links directly would collect test
         case keys, which match no epic and would exclude nothing. */
        const bucket = epicsLib.isBucketStory(issue);
        for (const e of epicsLib.epicsFor(issue, lookup, { both: bucket })) {
          if (!e.key) continue;
          keys.add(up(e.key));
          // `via` is the path that found it — 'parent', or one of the relates
          // rules. Taken from the walk rather than guessed at out here.
          if (e.via === 'parent') viaParent.add(up(e.key));
          else viaLinks.add(up(e.key));
        }
      }

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
      // Said explicitly rather than inferred from `total === 0` by three
      // different readers. It is also not the same statement: with a team
      // allow-list on, a component can have epics and still count none here.
      tracked: found.has(component),
    });
  }

  rows.sort(byPriorityThenName);

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

/** P1 first, then by name — the order the sheet is already in. */
function byPriorityThenName(a, b) {
  return priority.sortKey(a.priority) - priority.sortKey(b.priority)
    || String(a.component).localeCompare(String(b.component));
}

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

module.exports = { view, byPriorityThenName, totalsOf, activeSprintEpics, PLANNED_TYPES };
