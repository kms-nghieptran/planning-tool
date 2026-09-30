'use strict';
/**
 * by-component.test.js — the Capacity screen's sprint sheet.
 *
 * WHAT THIS SUITE IS PROTECTING
 *
 * The table puts two different readings of the same project side by side, and
 * each half has an obvious implementation that is wrong in a way the screen
 * cannot show you:
 *
 *   1. BOTH HALVES COUNT EPICS. The planned half starts from Jira ITEMS, and
 *      the tempting shortcut is to count them. A row then reads "4 Ready · 12
 *      planned" where the 12 are twelve tickets against three suites, and the
 *      comparison the table exists for is not available anywhere on it.
 *
 *   2. A BUCKET STORY'S PARENT IS NOT A SUITE. On his data every Bucket Story
 *      in Ruby's sprint parents to ONE container epic (AUTOKAT-7789). Counting
 *      the parent puts a phantom row on the table and inflates whichever
 *      component that epic carries — on every team, every sprint, and the
 *      numbers all look plausible.
 *
 *   3. THE BACKLOG EXCLUDES OPEN SPRINTS, NOT THE ACTIVE ONE. His rule covers
 *      the active sprint, the selected one AND future ones; a `activeSprints`
 *      call is the natural thing to reach for and quietly excludes a third of
 *      what it should.
 *
 *   4. CLOSED SPRINTS ARE HISTORY. Exclude them too and a suite vanishes from
 *      the page forever because somebody once pulled it in — the exact failure
 *      the table exists to prevent.
 *
 *   5. THE ROW SET IS THE DECISION. Same rule as the Prioritization page: a
 *      ranked suite with nothing in either half is the most actionable line on
 *      the sheet — finished, or forgotten — and tallying first drops it.
 *
 * Run: node test/by-component.test.js
 */

const assert = require('node:assert');

const pz = require('../lib/prioritization');
const coverage = require('../lib/coverage');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nCapacity planning — By component\n');

/* ── a project shaped like his ────────────────────────────────────────────
   PS_iGO_NLG runs on both tools and has one epic in each backlog bucket.
   PS_iGO_Lincoln is ranked with one Automated epic — so it is ranked, has
   epics, and has NOTHING in the backlog trio, which is a different empty from
   PS_RES_NLG's (ranked, no epics at all). Both must still get a row. */

const epic = (key, o = {}) => ({
  key, issueType: 'Epic', summary: o.summary || `Epic ${key}`,
  components: o.components || [], automationStatus: o.automationStatus || '',
  labels: o.labels || [],
  /* `'team' in o`, NOT `o.team || default`. An EMPTY Team field is a real and
     important case — it is the PS_iGO_Lafayette defect — and `|| default`
     silently turns `team: ''` back into a tagged epic, so the fixture cannot
     express the thing under test. */
  team: 'team' in o ? o.team : 'Katalon PS Squad', status: 'Open',
});

const BASE = [
  epic('A-1', { components: ['PS_iGO_NLG', 'TrueTest'], automationStatus: 'Automated' }),
  epic('A-2', { components: ['PS_iGO_NLG', 'TrueTest'], automationStatus: 'Maintenance' }),
  epic('A-3', { components: ['PS_iGO_NLG'], automationStatus: 'Ready for Automation' }),
  epic('A-4', { components: ['PS_iGO_NLG'], automationStatus: 'Blocked' }),
  epic('A-5', { components: ['PS_iGO_NLG'], automationStatus: 'N/A for Automation' }),
  epic('A-6', { components: ['PS_iGO_NLG'], automationStatus: '', labels: ['Obsoleted'] }),
  epic('A-7', { components: ['PS_iGO_NLG'], automationStatus: '' }),           // no status
  epic('A-8', { components: ['PS_iGO_Lincoln'], automationStatus: 'Automated' }),
  epic('A-9', { components: ['PS_iGO_Lincoln'], automationStatus: 'Maintenance' }),
  epic('A-10', { components: ['PS_iGO_Columbus'], automationStatus: 'Ready for Automation' }), // no priority
  epic('A-11', { components: ['KAT_Engineering'], automationStatus: 'Ready for Automation' }), // ranked AND excluded
  // Another squad's epic on a ranked component — the team allow-list cut.
  epic('A-12', { components: ['PS_iGO_Lincoln'], automationStatus: 'Blocked', team: 'Katalon RDA (Ruby)' }),
  /* NO JIRA TEAM AT ALL. The defect PS_iGO_Lafayette surfaced: 14 Ready
     epics with an empty Team field vanished from a sheet headed "all
     teams", and 295 did portfolio-wide. Two of them here, in two buckets,
     so the fix cannot be satisfied by a single-bucket special case. */
  epic('A-13', { components: ['PS_iGO_Untagged'], automationStatus: 'Ready for Automation', team: '' }),
  epic('A-14', { components: ['PS_iGO_Untagged'], automationStatus: 'Blocked', team: '' }),
];

const RUBY = { id: 'ruby', name: 'Katalon Ruby', jiraTeams: ['Katalon PS Squad'] };
/* A SECOND TEAM WITH ITS OWN OPEN SPRINT. Without it, "this team's sprints"
   and "everyone's sprints" are the same set and the scope of the exclusion is
   untestable — which is exactly how a widened `openSprintEpics` survived the
   first pass of these checks unnoticed. */
const TITAN = { id: 'titan', name: 'Katalon Titan', jiraTeams: ['Katalon Titan Squad'] };

const PLAN = () => ({
  componentPriority: {
    PS_iGO_NLG: 1,
    PS_RES_NLG: 1,          // ranked, nothing against it anywhere
    PS_iGO_Lincoln: 2,
    PS_iGO_Untagged: 2,   // carries ONLY epics with an empty Team field
    KAT_Engineering: 3,     // ranked AND excluded
  },
  componentNote: { PS_RES_NLG: 'waiting on the migration' },
  excludedComponents: ['KAT_Engineering'],
  /* A REAL ALLOW-LIST, not an empty one. With `coverageTeams: []` every epic
     is in scope by default, `noTeam` can change nothing, and the
     PS_iGO_Lafayette defect — an untagged epic dropped by the allow-list —
     cannot be reproduced at all. Both squads are on it so the per-team
     narrowing still has something to cut. */
  coverageTeams: ['Katalon PS Squad', 'Katalon RDA (Ruby)', 'Katalon Titan Squad'],
  teams: [RUBY, TITAN],
  sprints: [
    { id: 's39', name: 'Sprint 39', byTeam: { ruby: { jiraId: '890', name: 'Ruby Sprint 39', state: 'closed' } } },
    { id: 's40', name: 'Sprint 40', byTeam: { ruby: { jiraId: '900', name: 'Ruby Sprint 40', state: 'active' } } },
    { id: 's41', name: 'Sprint 41', byTeam: { ruby: { jiraId: '910', name: 'Ruby Sprint 41', state: 'future' } } },
    { id: 't10', name: 'Titan 10', byTeam: { titan: { jiraId: '950', name: 'Titan Sprint 10', state: 'active' } } },
  ],
});

const sprintOf = (plan, id) => plan.sprints.find(s => s.id === id);

/**
 * A snapshot whose sprints hold `items`, keyed by sprint id.
 *
 * `epic` is the PARENT — how a Story names the epic it is writing.
 * `relates` are "relates to" LINKS — how a Bucket Story names the suites it
 * is maintaining. Both have to be expressible, because confusing the two is
 * the defect half these checks are about.
 */
const JIRA_ID = { s39: '890', s40: '900', s41: '910', t10: '950' };
const SPRINT_TEAM = { s39: 'ruby', s40: 'ruby', s41: 'ruby', t10: 'titan' };

function withSprints(bySprint) {
  const snap = {
    issues: Object.fromEntries(BASE.map(i => [i.key, i])),
    byTeam: {
      ruby: { sprintIssues: { 890: [], 900: [], 910: [] } },
      titan: { sprintIssues: { 950: [] } },
    },
  };
  for (const [sid, items] of Object.entries(bySprint || {})) {
    for (const it of items) {
      snap.issues[it.key] = {
        key: it.key, summary: it.key, issueType: it.type,
        /* `'status' in it`, not `it.status || 'In Dev'`. A planned item in
           Refinement is the whole point of the warning marker, and a default
           applied with `||` makes that case inexpressible — the same fixture
           defect that hid the PS_iGO_Lafayette bug and the unassigned one. */
        status: 'status' in it ? it.status : 'In Dev',
        automationStatus: 'automationStatus' in it ? it.automationStatus : null,
        /* CARRIED, or "done" is inexpressible here. `isDone` reads this field
           first, so a finished item sitting in a Refinement-named column —
           the exact case the warning must NOT flag — could not be written
           down at all without it. */
        statusCategory: 'statusCategory' in it ? it.statusCategory : null,
        parentKey: it.epic || null, components: [], labels: [], team: it.team || 'Katalon PS Squad',
        relatesTo: (it.relates || []).map(k => ({ key: k, summary: `linked ${k}`, type: 'Epic' })),
      };
      snap.byTeam[SPRINT_TEAM[sid]].sprintIssues[JIRA_ID[sid]].push(it.key);
    }
  }
  return snap;
}

const build = (snap, plan, sprintId = 's40') =>
  pz.sprintComponents(snap, plan, { team: RUBY, sprint: sprintOf(plan, sprintId) });

const rowFor = (v, component) => v.rows.find(r => r.component === component);

/* ── 1. the row set ───────────────────────────────────────────────────── */

check('THE ROW SET IS THE RANKED COMPONENTS, not the ones with numbers', () => {
  const v = build(withSprints({}), PLAN());
  const names = v.rows.map(r => r.component).sort();
  assert.deepStrictEqual(names, ['PS_RES_NLG', 'PS_iGO_Lincoln', 'PS_iGO_NLG', 'PS_iGO_Untagged'],
    'the rows are not the ranked set');
  assert.ok(!names.includes('PS_iGO_Columbus'), 'an unranked component with epics got a row');
  assert.deepStrictEqual(v.excluded, ['KAT_Engineering'],
    'a ranked-and-excluded component was dropped in silence instead of reported');
});

check('THE ORDER IS THE ANSWER — P1 first, then by name', () => {
  /* Not sortable in the browser (the header is three rows deep with
     colspans), so the order the model ships IS the order he reads. A table
     that arrived in Object.keys order would put P4 above P1 depending on
     which suite he happened to rank first. */
  const v = build(withSprints({}), PLAN());
  assert.deepStrictEqual(v.rows.map(r => `${r.priorityLabel} ${r.component}`),
    ['P1 PS_iGO_NLG', 'P1 PS_RES_NLG', 'P2 PS_iGO_Lincoln', 'P2 PS_iGO_Untagged'],
    'the sheet did not come back in priority order');
});

check('A RANKED SUITE WITH NOTHING IN EITHER HALF STILL GETS A ROW, and says so', () => {
  /* Two different kinds of empty, and both have to survive: PS_RES_NLG has no
     epics at all; PS_iGO_Lincoln has epics but none of them in the backlog
     trio and none planned. Tally first and the first one vanishes. */
  const v = build(withSprints({}), PLAN());
  const none = rowFor(v, 'PS_RES_NLG');
  assert.ok(none, 'a ranked component with no epics vanished from the sheet');
  assert.strictEqual(none.backlog, 0);
  assert.strictEqual(none.planned, 0);
  assert.strictEqual(none.empty, true, 'the row cannot say it is clear');
  assert.strictEqual(none.note, 'waiting on the migration', 'his note did not travel with the row');

  const lincoln = rowFor(v, 'PS_iGO_Lincoln');
  assert.strictEqual(lincoln.kse.maintenance, 1, 'fixture check: A-9 is Lincoln/KSE/Maintenance');
  assert.strictEqual(lincoln.empty, false, 'a row with backlog was called clear');
});

check('the row carries the priority chip the view needs, not just a number', () => {
  const v = build(withSprints({}), PLAN());
  const r = rowFor(v, 'PS_iGO_NLG');
  assert.strictEqual(r.priority, 1);
  assert.strictEqual(r.priorityLabel, 'P1');
  assert.strictEqual(r.priorityKey, 'p1', 'the view would rebuild the class from the number');
  assert.strictEqual(r.priorityName, 'Critical');
  assert.strictEqual(r.familyKey, 'ps', 'the family key is not on the row');

  /* A SECOND LEVEL, or the three fields above are satisfied by a constant.
     P1 is the fixture's most common priority and checking it alone is the
     kind of check that passes against `priorityKey: 'p1'` hard-coded. */
  const p2 = rowFor(v, 'PS_iGO_Lincoln');
  assert.strictEqual(p2.priority, 2);
  assert.strictEqual(p2.priorityLabel, 'P2');
  assert.strictEqual(p2.priorityKey, 'p2');
  assert.strictEqual(p2.priorityName, 'High');
});

/* ── 2. the backlog half ──────────────────────────────────────────────── */

check('THE BACKLOG IS MAINTENANCE, READY AND BLOCKED — and nothing else', () => {
  /* Automated, N/A, Obsoleted and No Status are all in the fixture on
     PS_iGO_NLG. None of them is backlog: "what is left to do" does not
     include what is done, what will never be done, or what was retired. */
  const v = build(withSprints({}), PLAN());
  const r = rowFor(v, 'PS_iGO_NLG');
  assert.strictEqual(r.truetest.maintenance, 1, 'A-2');
  assert.strictEqual(r.kse.ready, 1, 'A-3');
  assert.strictEqual(r.kse.blocked, 1, 'A-4');
  assert.strictEqual(r.backlog, 3, `four non-backlog statuses leaked in (got ${r.backlog})`);
  assert.deepStrictEqual(v.backlogBuckets.map(b => b.key), ['maintenance', 'ready', 'blocked']);
});

check('the tool split is the coverage screen\'s, not a second guess at it', () => {
  const v = build(withSprints({}), PLAN());
  const r = rowFor(v, 'PS_iGO_NLG');
  // A-2 carries the TrueTest component; A-3 and A-4 do not.
  assert.strictEqual(r.truetest.backlog, 1);
  assert.strictEqual(r.kse.backlog, 2);
  assert.strictEqual(r.truetest.maintenance + r.kse.maintenance, 1,
    'the same epic was counted under both tools');
});

check('THE BACKLOG IS EVERY TEAM\'S, not the selected one\'s', () => {
  /* "What is left to automate in this suite" is not a per-team fact — the
     suite is the suite. A-12 is Lincoln / Blocked under ANOTHER squad's name,
     and it is still work nobody has picked up, so it belongs in the backlog
     a Ruby lead reads when choosing what to pull in next. Narrowing this by
     team made the sheet lie by omission: a suite with forty Ready epics under
     someone else's Team field read as empty. */
  const v = build(withSprints({}), PLAN());
  assert.strictEqual(rowFor(v, 'PS_iGO_Lincoln').kse.blocked, 1,
    'another squad\'s untouched epic was hidden from this team\'s backlog');

  // And the team's OWN jiraTeams make no difference to it — the check above
  // is about the portfolio scope, not about Ruby's list happening to match.
  const narrow = pz.sprintComponents(withSprints({}), PLAN(), {
    team: { ...RUBY, jiraTeams: ['Katalon PS Squad'] }, sprint: sprintOf(PLAN(), 's40'),
  });
  const wide = pz.sprintComponents(withSprints({}), PLAN(), {
    team: { ...RUBY, jiraTeams: ['Katalon PS Squad', 'Katalon RDA (Ruby)'] },
    sprint: sprintOf(PLAN(), 's40'),
  });
  assert.strictEqual(narrow.totals.backlog, wide.totals.backlog,
    'the team\'s own Jira Team values still narrow the backlog');
  assert.ok(narrow.totals.backlog > 0, 'fixture check: there is a backlog to compare');
});

check('AN EPIC WITH NO JIRA TEAM IS STILL IN THE QUEUE', () => {
  /* THE PS_iGO_Lafayette DEFECT. "All teams" has to include the epics nobody
     assigned a team to: the allow-list drops an empty Team value like any
     other non-match, so a suite showing 8 Blocked was carrying 14 Ready
     epics it never mentioned. A queue that hides a quarter of itself is
     worse than no queue. */
  const v = build(withSprints({}), PLAN());
  const r = rowFor(v, 'PS_iGO_Untagged');
  assert.ok(r, 'the ranked component carrying only untagged epics has no row');
  assert.deepStrictEqual(r.kse.keys.ready, ['A-13'],
    'an untagged Ready epic is missing from a backlog headed "all teams"');
  assert.deepStrictEqual(r.kse.keys.blocked, ['A-14'], 'the fix only reached one bucket');
  assert.strictEqual(r.empty, false, 'the row still reads as clear');
  // Counted out loud, because a number that moved for this reason has to be
  // able to say so — and untriaged epics are themselves a finding.
  assert.strictEqual(v.scopes.backlog.noTeam, 2, 'the untagged epics are not reported');
});

check('AND IT IS AN OPTION, so Coverage and Prioritization keep the stricter read', () => {
  /* A coverage PERCENTAGE should not move for an epic nobody has declared
     either way; a QUEUE that hides them is hiding real work. Two questions,
     two answers — and the option is what keeps them from becoming one. */
  const plan = PLAN();
  /* AN ALLOW-LIST HAS TO BE IN FORCE for the option to mean anything: with
     none, every epic is already in and `noTeam` can change nothing. The
     fixture's own `coverageTeams` is empty, so one is named here. */
  const opts = { scope: 'Epic', exclude: plan.excludedComponents, teams: ['Katalon PS Squad'] };
  const strict = coverage.classify(withSprints({}), opts);
  const loose = coverage.classify(withSprints({}), { ...opts, noTeam: true });
  assert.strictEqual(loose.classified.length - strict.classified.length, 2,
    'the option changed nothing, or changed more than the untagged epics');
  assert.strictEqual(strict.noTeamCount, 0, 'the strict read still reported letting some in');
  assert.strictEqual(loose.noTeamCount, 2);
  // The Prioritization page is on the strict read and must stay there.
  const pv = pz.view(withSprints({}), plan);
  const strictRow = pv.rows.find(x => x.component === 'PS_iGO_Untagged');
  assert.strictEqual(strictRow ? strictRow.total : 0, 0,
    'the Prioritization page picked up the looser reading');
  assert.strictEqual(rowFor(build(withSprints({}), plan), 'PS_iGO_Untagged').backlog, 2,
    'fixture check: the By component sheet does count them');
});

check('THE GLOBAL ALLOW-LIST STILL CUTS IT — "all teams" is not "everything"', () => {
  /* `plan.coverageTeams` is the setting that says which Jira Team values
     count as automation work at all. Portfolio-wide means every team ON that
     list, not every value in the instance, or the setting stops meaning
     anything on this screen while still meaning something on Coverage. */
  const plan = PLAN();
  const all = pz.sprintComponents(withSprints({}), plan, { team: RUBY, sprint: sprintOf(plan, 's40') });
  const cut = pz.sprintComponents(withSprints({}), { ...plan, coverageTeams: ['Katalon PS Squad'] }, {
    team: RUBY, sprint: sprintOf(plan, 's40'),
  });
  assert.ok(all.totals.backlog > cut.totals.backlog,
    'restricting the global allow-list changed nothing');
  assert.strictEqual(rowFor(cut, 'PS_iGO_Lincoln').kse.blocked, 0,
    'an epic outside the global allow-list was still counted');
});

check('THE SCOPES ARE REPORTED SEPARATELY, because they are different answers', () => {
  /* One "team" field on the payload is how a portfolio backlog gets read as
     this team's — the failure the Prioritization screen already learned once,
     and the reason the scope is stated where the figures are. */
  const plan = PLAN();
  const v = build(withSprints({}), plan);
  assert.strictEqual(v.scopes.backlog.allTeams, true);
  assert.match(v.scopes.backlog.label, /all teams/);
  assert.strictEqual(v.scopes.planned.allTeams, false);
  assert.strictEqual(v.scopes.planned.team, 'Katalon Ruby');
  assert.strictEqual(v.scopes.planned.label, 'Katalon Ruby');
});

check('A TEAM THAT CANNOT CLAIM AN EPIC STILL GETS THE WHOLE BACKLOG', () => {
  /* Nothing on this sheet is narrowed by the team's Jira Team values any
     more: the backlog is portfolio-wide and the planned half is read from the
     sprint's own issue list, which belongs to one team by construction. So an
     unmapped team is no longer a reason to show an empty table — it is a
     reason its PLANNED half is empty, and the mapping state is reported
     rather than acted on. */
  const plan = PLAN();
  const noTeams = pz.sprintComponents(withSprints({}), plan, {
    team: { id: 'x', name: 'X', jiraTeams: [] }, sprint: sprintOf(plan, 's40'),
  });
  assert.strictEqual(noTeams.team.mappedEmpty, true, 'the mapping state is not reported');
  assert.strictEqual(noTeams.team.reason, 'no-jira-teams');
  assert.ok(noTeams.totals.backlog > 0,
    'an unmapped team was shown an empty backlog it had no part in scoping');
  assert.strictEqual(noTeams.totals.planned, 0, 'a team with no sprint index planned something');

  const outside = pz.sprintComponents(withSprints({}), { ...plan, coverageTeams: ['Some Other Squad'] }, {
    team: RUBY, sprint: sprintOf(plan, 's40'),
  });
  assert.strictEqual(outside.team.reason, 'outside-allow-list',
    'the two reasons need two different fixes and must be two different answers');
});

/* ── 3. what the backlog leaves out ───────────────────────────────────── */

check('THE BACKLOG EXCLUDES THE ACTIVE SPRINT', () => {
  const plan = PLAN();
  const snap = withSprints({ s40: [{ key: 'S-1', type: 'Story', epic: 'A-3' }] });
  const before = build(withSprints({}), plan);
  const after = build(snap, plan);
  assert.strictEqual(rowFor(before, 'PS_iGO_NLG').kse.ready, 1, 'fixture check');
  assert.strictEqual(rowFor(after, 'PS_iGO_NLG').kse.ready, 0,
    'an epic with a Story in the active sprint is still counted as backlog');
  assert.strictEqual(after.backlogExcludes.epics, 1, 'the page cannot say how many it removed');
});

check('A FUTURE SPRINT IS A PLAN, NOT PROGRESS — it stays in the backlog', () => {
  /* Backlog means "nobody is working on this right now", so the one thing
     that disqualifies an epic is somebody working it right now. Excluding
     future sprints made the backlog shrink every time somebody filled one
     in, which is the opposite of what filling one in means. */
  const plan = PLAN();
  const snap = withSprints({ s41: [{ key: 'S-2', type: 'Story', epic: 'A-3' }] });
  const v = build(snap, plan);                               // viewing the ACTIVE sprint
  assert.strictEqual(rowFor(v, 'PS_iGO_NLG').kse.ready, 1,
    'an epic merely QUEUED for a future sprint was cut from the backlog');
  assert.strictEqual(v.backlogExcludes.epics, 0, 'a future sprint was read for the exclusion set');
  /* The ACTIVE sprints are still listed even though neither held anything —
     the list says which sprints were READ, which is what makes the rule
     checkable. What must not appear is Ruby Sprint 41. */
  assert.ok(!v.backlogExcludes.sprints.some(x => x.label === 'Ruby Sprint 41'),
    'a future sprint was read for the exclusion set');

  // It IS reported as earmarked, though — the difference between "nobody has
  // looked at this" and "this already has a home" is worth a number.
  assert.strictEqual(v.queuedAhead.epics, 1, 'the earmarked epic is not reported anywhere');
  assert.deepStrictEqual(v.queuedAhead.sprints.map(x => x.label), ['Ruby Sprint 41']);
});

check('AN ACTIVE SPRINT IS PROGRESS — that one does come out', () => {
  const plan = PLAN();
  const snap = withSprints({ s40: [{ key: 'S-1', type: 'Story', epic: 'A-3' }] });
  const v = build(snap, plan);
  assert.strictEqual(rowFor(v, 'PS_iGO_NLG').kse.ready, 0,
    'an epic with work in flight right now was counted as backlog');
  assert.strictEqual(v.backlogExcludes.epics, 1);
  assert.deepStrictEqual(v.backlogExcludes.sprints.map(x => x.label).sort(),
    ['Ruby Sprint 40', 'Titan Sprint 10'],
    'the ACTIVE sprints read were not named, so the rule cannot be checked');
  assert.ok(!v.backlogExcludes.sprints.some(x => /41|39/.test(x.label)),
    'a future or closed sprint was read');
  assert.strictEqual(v.queuedAhead.epics, 0,
    'an epic in flight was also counted as merely earmarked');
});

check('EVERY TEAM\'S ACTIVE SPRINT, because the count is every team\'s', () => {
  /* Scope and exclusion move together. With the backlog portfolio-wide, an
     epic Titan is working right now is not "nobody has picked this up"
     because Ruby is the team on screen. */
  const plan = PLAN();
  const snap = withSprints({ t10: [{ key: 'T-1', type: 'Story', epic: 'A-3', team: 'Katalon Titan Squad' }] });
  const v = build(snap, plan);                               // Ruby's sheet
  assert.strictEqual(rowFor(v, 'PS_iGO_NLG').kse.ready, 0,
    'an epic another team has in flight was counted as untouched backlog');
  assert.ok(v.backlogExcludes.sprints.some(x => x.team === 'Katalon Titan'),
    'the other team\'s active sprint was not read, or does not say whose it is');
  // Nothing in Titan's sprint and it comes back — so this measures the
  // exclusion rather than an epic that was never there.
  assert.strictEqual(rowFor(build(withSprints({}), plan), 'PS_iGO_NLG').kse.ready, 1,
    'fixture check: A-3 is PS_iGO_NLG / KSE / Ready when nobody has it');
});

check('AN EPIC IN FLIGHT IS NOT ALSO "EARMARKED"', () => {
  /* A suite can have a Story in the active sprint AND another queued for the
     next one — it is common when work spills. It is out of the backlog
     because of the first, so counting it in the earmarked note as well would
     describe a row that is not there, and the note would exceed the rows it
     is meant to characterise. */
  const plan = PLAN();
  const snap = withSprints({
    s40: [{ key: 'S-1', type: 'Story', epic: 'A-3' }],
    s41: [{ key: 'S-2', type: 'Story', epic: 'A-3' }],   // the same suite
  });
  const v = build(snap, plan);
  assert.strictEqual(rowFor(v, 'PS_iGO_NLG').kse.ready, 0, 'fixture check: A-3 is in flight');
  assert.strictEqual(v.backlogExcludes.epics, 1);
  assert.strictEqual(v.queuedAhead.epics, 0,
    'an epic already in flight was also counted as merely queued ahead');
});

check('QUEUED-AHEAD NEVER EXCEEDS THE BACKLOG IT DESCRIBES', () => {
  /* It is a subset of the rows above it, not a parallel tally — an epic that
     is out of scope, excluded, or in a non-backlog status must not inflate
     it, or the note claims more earmarked suites than there are suites. */
  const plan = PLAN();
  const snap = withSprints({
    s41: [
      { key: 'S-2', type: 'Story', epic: 'A-3' },     // in the backlog
      { key: 'S-3', type: 'Story', epic: 'A-1' },     // Automated — not backlog
      { key: 'S-4', type: 'Story', epic: 'A-11' },    // excluded component
    ],
  });
  const v = build(snap, plan);
  assert.strictEqual(v.queuedAhead.epics, 1,
    'an epic that is not in the backlog was counted as earmarked backlog');
  assert.ok(v.queuedAhead.epics <= v.totals.backlog);
});

check('A CLOSED SPRINT IS HISTORY AND EXCLUDES NOTHING', () => {
  /* Exclude closed sprints as well and a suite disappears from the page
     permanently because somebody pulled it in six sprints ago — while still
     sitting in Maintenance today, which is exactly the row this table is for. */
  const plan = PLAN();
  const snap = withSprints({ s39: [{ key: 'S-3', type: 'Story', epic: 'A-3' }] });
  const v = build(snap, plan);
  assert.strictEqual(rowFor(v, 'PS_iGO_NLG').kse.ready, 1,
    'an epic planned into a CLOSED sprint was treated as still in hand');
  assert.strictEqual(v.backlogExcludes.epics, 0);
  assert.ok(!v.backlogExcludes.sprints.some(s => s.label === 'Ruby Sprint 39'),
    'a closed sprint was read for the exclusion set');
});

check('SELECTED = ACTIVE COLLAPSES TO ONE SET, not a double exclusion', () => {
  /* His clarification, made checkable: with the active sprint selected the
     union is the same set, and the count of excluded epics is the same
     whether you arrive at it as "active" or as "active ∪ selected". */
  const plan = PLAN();
  const snap = withSprints({ s40: [{ key: 'S-1', type: 'Story', epic: 'A-3' }] });
  const v = build(snap, plan, 's40');
  const open = pz.openSprintEpics(plan, snap, [RUBY]);
  assert.strictEqual(v.backlogExcludes.epics, open.keys.size);
  assert.strictEqual(open.keys.size, 1, 'one epic, counted once');
});

check('the excluded set is the same whichever sprint is selected', () => {
  /* The backlog half does not move when the picker does — only the planned
     half does. A backlog that changed with the selection would make two
     readings of the same team disagree about what is left to do. */
  const plan = PLAN();
  const snap = withSprints({
    s40: [{ key: 'S-1', type: 'Story', epic: 'A-3' }],
    s41: [{ key: 'S-2', type: 'Story', epic: 'A-4' }],
  });
  const a = build(snap, plan, 's40');
  const b = build(snap, plan, 's41');
  assert.strictEqual(a.backlogExcludes.epics, b.backlogExcludes.epics);
  assert.strictEqual(rowFor(a, 'PS_iGO_NLG').backlog, rowFor(b, 'PS_iGO_NLG').backlog);
  /* A-2 (Maintenance) and A-4 (Blocked, queued for S41 — a plan, not
     progress). A-3 is out because the ACTIVE sprint holds it. */
  assert.strictEqual(rowFor(a, 'PS_iGO_NLG').backlog, 2, 'the active sprint is not the only cut');
  // The planned half DOES move with the picker — otherwise this check is
  // satisfied by a page that ignores the selection entirely. Compared by the
  // KEYS, not the count: both sprints plan one suite here, so the totals are
  // equal and only the sets differ.
  assert.notDeepStrictEqual(rowFor(a, 'PS_iGO_NLG').kse.keys.build,
    rowFor(b, 'PS_iGO_NLG').kse.keys.build,
    'both selections planned the same suite, so nothing was tested');
});

/* ── 4. the planned half ──────────────────────────────────────────────── */

check('A STORY IS A NEW BUILD, reached by its PARENT', () => {
  const plan = PLAN();
  const snap = withSprints({ s40: [{ key: 'S-1', type: 'Story', epic: 'A-3' }] });
  const r = rowFor(build(snap, plan), 'PS_iGO_NLG');
  assert.strictEqual(r.kse.build, 1, 'a Story did not reach its epic as a new build');
  assert.strictEqual(r.kse.maint, 0, 'a Story was counted as maintenance');
});

check('A STORY\'S "RELATES TO" IS NOT A CLAIM TO MAINTAIN THAT SUITE', () => {
  /* A cross-reference on a Story is an ordinary link. Follow it and every
     ticket that mentions another suite inflates that suite's maintenance. */
  const plan = PLAN();
  const snap = withSprints({ s40: [{ key: 'S-1', type: 'Story', epic: 'A-3', relates: ['A-2'] }] });
  const r = rowFor(build(snap, plan), 'PS_iGO_NLG');
  assert.strictEqual(r.truetest.maint, 0, 'a Story\'s relates-to was read as maintenance');
  assert.strictEqual(r.kse.build, 1);
});

check('A PARENTLESS STORY STILL REACHES ITS SUITE, by the link', () => {
  /* `epicsFor`'s default rule prefers the parent and falls back to the links
     only when there is no parent at all. Filtering the walk on `via ===
     "parent"` would look like a tightening and is a silent drop: the Story
     counts nowhere and the sprint appears to have planned less than it did. */
  const plan = PLAN();
  const snap = withSprints({ s40: [{ key: 'S-7', type: 'Story', epic: null, relates: ['A-3'] }] });
  const v = build(snap, plan);
  assert.strictEqual(rowFor(v, 'PS_iGO_NLG').kse.build, 1,
    'a Story with no parent reached no suite at all');
  assert.strictEqual(v.plannedNotes.build, 1);
});

check('A BUCKET STORY IS MAINTENANCE, reached by its LINKS', () => {
  const plan = PLAN();
  const snap = withSprints({ s40: [{ key: 'B-1', type: 'Bucket Story', relates: ['A-2', 'A-3'] }] });
  const r = rowFor(build(snap, plan), 'PS_iGO_NLG');
  assert.strictEqual(r.truetest.maint, 1, 'A-2');
  assert.strictEqual(r.kse.maint, 1, 'A-3');
  assert.strictEqual(r.truetest.build + r.kse.build, 0, 'a Bucket Story was counted as a new build');
});

check('A BUCKET STORY\'S PARENT IS NOT A SUITE — the container-epic defect', () => {
  /* THE CHECK THIS FILE EXISTS FOR. On his data every Bucket Story in Ruby's
     sprint parents to ONE epic — a maintenance bucket, not a test suite.
     Count the parent and that epic's component gains a row's worth of
     phantom maintenance, on every team and every sprint, and nothing on the
     screen looks wrong. */
  const plan = PLAN();
  const snap = withSprints({
    s40: [
      { key: 'B-1', type: 'Bucket Story', epic: 'A-8', relates: ['A-2'] },
      { key: 'B-2', type: 'Bucket Story', epic: 'A-8', relates: ['A-3'] },
    ],
  });
  const v = build(snap, plan);
  assert.strictEqual(rowFor(v, 'PS_iGO_Lincoln').kse.maint, 0,
    'the bucket container epic (A-8) was counted as maintained work');
  assert.strictEqual(rowFor(v, 'PS_iGO_NLG').truetest.maint, 1, 'A-2, via the link');
  assert.strictEqual(rowFor(v, 'PS_iGO_NLG').kse.maint, 1, 'A-3, via the link');
  assert.strictEqual(v.plannedNotes.maint, 2, 'exactly two suites are being maintained');
});

check('A MAINTENANCE TICKET NAMING NO SUITE IS COUNTED, not dropped', () => {
  /* AUTOKAT-10532 is one of these: a real Bucket Story with a parent and no
     links. It is effort the table cannot attribute, and a reader adding the
     planned column against the sprint's ticket count is owed the difference. */
  const plan = PLAN();
  const snap = withSprints({ s40: [{ key: 'B-9', type: 'Bucket Story', epic: 'A-8' }] });
  const v = build(snap, plan);
  assert.strictEqual(v.plannedNotes.unlinked, 1, 'an unlinked maintenance ticket vanished');
  assert.strictEqual(v.totals.planned, 0, 'and it was attributed to a row anyway');
});

check('ONLY STORIES AND BUCKET STORIES PLAN WORK — a Bug is not a commitment', () => {
  /* A sprint holds Bugs, Sub-tasks and Tasks as well, and most of them carry
     a parent. Count them and a bug fix against an automated suite is reported
     as new automation being built this sprint, which is the opposite of what
     happened. Without a non-planning type in the fixture, dropping the type
     filter entirely changes nothing and the check is vacuous. */
  const plan = PLAN();
  const snap = withSprints({
    s40: [
      { key: 'S-1', type: 'Story', epic: 'A-3' },
      { key: 'BUG-1', type: 'Bug', epic: 'A-4' },
      { key: 'ST-1', type: 'Sub-task', epic: 'A-2' },
    ],
  });
  const v = build(snap, plan);
  const r = rowFor(v, 'PS_iGO_NLG');
  assert.strictEqual(r.kse.build, 1, 'a Bug or a Sub-task was counted as planned work');
  assert.deepStrictEqual(r.kse.keys.build, ['A-3']);
  assert.strictEqual(v.plannedNotes.items, 1, 'the ticket count includes work that plans nothing');
  // And the backlog keeps the epics those tickets point at — they were never
  // planned, so nothing should have been excluded on their account.
  assert.strictEqual(r.kse.blocked, 1, 'A-4 left the backlog because a Bug named it');
  assert.strictEqual(r.truetest.maintenance, 1, 'A-2 left the backlog because a Sub-task named it');
});

check('THE PLANNED HALF FOLLOWS THE PICKER, including a future sprint', () => {
  /* He plans two and three sprints ahead. Answering "what has this sprint
     taken on" only for the active sprint would make the picker change one
     half of the table and not the other. */
  const plan = PLAN();
  const snap = withSprints({
    s40: [{ key: 'S-1', type: 'Story', epic: 'A-3' }],
    s41: [{ key: 'S-2', type: 'Story', epic: 'A-4' }],
  });
  const now = build(snap, plan, 's40');
  const next = build(snap, plan, 's41');
  assert.strictEqual(rowFor(now, 'PS_iGO_NLG').kse.build, 1);
  assert.strictEqual(rowFor(next, 'PS_iGO_NLG').kse.build, 1);
  assert.strictEqual(now.sprint.label, 'Ruby Sprint 40', 'the header would name the wrong sprint');
  assert.strictEqual(next.sprint.label, 'Ruby Sprint 41');
  assert.strictEqual(next.sprint.state, 'future');
  // The two selections reach DIFFERENT epics — otherwise the check above is
  // comparing a table with itself.
  assert.notStrictEqual(
    JSON.stringify(rowFor(now, 'PS_iGO_NLG').kse.keys.build),
    JSON.stringify(rowFor(next, 'PS_iGO_NLG').kse.keys.build),
    'both selections reached the same epic, so nothing was tested');
});

check('BOTH HALVES OBEY THE BACKLOG\'S SCOPE, or the row does not read across', () => {
  /* A-12 carries another squad's Team field, and Ruby's sprint has a Story
     for it — so Ruby is demonstrably working that suite. Scoping the planned
     half by Ruby's own Jira Team values would drop it, and the row would then
     show a backlog that counts the epic beside a planned column that does
     not. Both halves use the portfolio scope, so the row is one population. */
  const plan = PLAN();
  const snap = withSprints({ s40: [{ key: 'S-9', type: 'Story', epic: 'A-12' }] });
  const v = build(snap, plan);
  assert.strictEqual(rowFor(v, 'PS_iGO_Lincoln').kse.build, 1,
    'a suite the team is provably building was dropped for carrying another team\'s name');
  assert.strictEqual(v.plannedNotes.outOfScope, 0);
  // And it left the backlog, because the sprint now holds it.
  assert.strictEqual(rowFor(v, 'PS_iGO_Lincoln').kse.blocked, 0,
    'the epic is counted as planned AND as untouched backlog');
});

check('A SUITE OUTSIDE THE GLOBAL SCOPE IS REPORTED, not counted', () => {
  /* The excluded-components list and the global allow-list still cut both
     halves. An epic the sprint reaches that neither half would count is
     effort in no row, and a reader adding the planned column against the
     sprint's ticket count is owed the difference. */
  const plan = { ...PLAN(), coverageTeams: ['Katalon PS Squad'] };
  const snap = withSprints({ s40: [{ key: 'S-9', type: 'Story', epic: 'A-12' }] });
  const v = build(snap, plan);
  assert.strictEqual(rowFor(v, 'PS_iGO_Lincoln').kse.build, 0,
    'an epic outside the global allow-list was counted into a row');
  assert.strictEqual(v.plannedNotes.outOfScope, 1, 'and it was not reported either');
});

check('an EXCLUDED component cannot be planned into a row', () => {
  const plan = PLAN();
  const snap = withSprints({ s40: [{ key: 'S-9', type: 'Story', epic: 'A-11' }] });
  const v = build(snap, plan);
  assert.ok(!rowFor(v, 'KAT_Engineering'), 'an excluded component got a row');
  assert.strictEqual(v.totals.planned, 0, 'an excluded component was counted into the totals');
});

check('the planned half counts a suite ONCE however many tickets name it', () => {
  /* The unit is the suite, not the ticket — the whole reason the planned half
     resolves to epics. Three maintenance tickets against one suite is one
     suite being maintained. */
  const plan = PLAN();
  const snap = withSprints({
    s40: [
      { key: 'B-1', type: 'Bucket Story', relates: ['A-2'] },
      { key: 'B-2', type: 'Bucket Story', relates: ['A-2'] },
      { key: 'B-3', type: 'Bucket Story', relates: ['A-2'] },
    ],
  });
  const v = build(snap, plan);
  assert.strictEqual(rowFor(v, 'PS_iGO_NLG').truetest.maint, 1,
    'three tickets against one suite were counted as three');
  assert.strictEqual(v.plannedNotes.items, 3, 'the ticket count is still reported');
});

/* ── 5. the numbers hold together ─────────────────────────────────────── */

check('EVERY CELL LISTS EXACTLY AS MANY KEYS AS IT COUNTS', () => {
  /* The rule every drill-in and every link in this app follows: the number
     opens the set it was the size of. A cell whose link lists a different set
     stops being checkable, which was its whole point. */
  const plan = PLAN();
  const snap = withSprints({
    s40: [
      { key: 'S-1', type: 'Story', epic: 'A-3' },
      { key: 'B-1', type: 'Bucket Story', relates: ['A-2'] },
    ],
  });
  const v = build(snap, plan);
  let cells = 0;
  for (const r of v.rows) {
    for (const t of v.tools) {
      const c = r[t.key];
      for (const k of ['maintenance', 'ready', 'blocked', 'build', 'maint']) {
        assert.strictEqual(c[k], c.keys[k].length,
          `${r.component}/${t.key}/${k}: says ${c[k]}, lists ${c.keys[k].length}`);
        assert.strictEqual(new Set(c.keys[k]).size, c.keys[k].length,
          `${r.component}/${t.key}/${k} lists the same key twice`);
        cells++;
      }
    }
  }
  assert.ok(cells >= 30, `only ${cells} cells were checked — the fixture is not reaching the table`);
});

check('the row and column totals are summed FROM THE ROWS ON SCREEN', () => {
  const plan = PLAN();
  const snap = withSprints({
    s40: [{ key: 'S-1', type: 'Story', epic: 'A-3' }, { key: 'B-1', type: 'Bucket Story', relates: ['A-2'] }],
  });
  const v = build(snap, plan);
  const t = v.totals;
  assert.strictEqual(t.components, v.rows.length);
  for (const tool of v.tools) {
    for (const k of ['maintenance', 'ready', 'blocked', 'build', 'maint']) {
      assert.strictEqual(t[tool.key][k], v.rows.reduce((n, r) => n + r[tool.key][k], 0), `${tool.key}.${k}`);
    }
  }
  assert.strictEqual(t.backlog, v.rows.reduce((n, r) => n + r.backlog, 0));
  assert.strictEqual(t.planned, v.rows.reduce((n, r) => n + r.planned, 0));
  assert.ok(t.backlog > 0 && t.planned > 0, 'the fixture totals nothing, so the sums prove nothing');
});

check('a row\'s halves total its own cells, both tools', () => {
  const plan = PLAN();
  const snap = withSprints({ s40: [{ key: 'B-1', type: 'Bucket Story', relates: ['A-2', 'A-3'] }] });
  const r = rowFor(build(snap, plan), 'PS_iGO_NLG');
  assert.strictEqual(r.backlog, r.truetest.backlog + r.kse.backlog);
  assert.strictEqual(r.planned, r.truetest.planned + r.kse.planned);
  assert.strictEqual(r.truetest.planned, r.truetest.build + r.truetest.maint);
  assert.strictEqual(r.kse.backlog, r.kse.maintenance + r.kse.ready + r.kse.blocked);
  assert.ok(r.planned > 0 && r.backlog > 0, 'the fixture is empty on one side');
});

check('THE BACKLOG AGREES WITH THE COVERAGE CLASSIFIER, epic for epic', () => {
  /* The guarantee that keeps this table and the Prioritization page from
     quietly disagreeing about one component. Both run `coverage.classify`
     with the same exclusions, allow-list and `omit`; this check compares the
     table's cells against that classifier directly. */
  const plan = PLAN();
  const snap = withSprints({ s40: [{ key: 'S-1', type: 'Story', epic: 'A-3' }] });
  const v = build(snap, plan);
  const open = pz.openSprintEpics(plan, snap, [RUBY]);
  const opts = { scope: 'Epic', exclude: plan.excludedComponents, teams: RUBY.jiraTeams, omit: open.keys };

  for (const bucket of ['maintenance', 'ready', 'blocked']) {
    for (const tool of ['truetest', 'kse']) {
      const listed = coverage.epicsIn(snap, opts, { component: 'PS_iGO_NLG', buckets: [bucket], tool });
      const counted = rowFor(v, 'PS_iGO_NLG')[tool][bucket];
      assert.strictEqual(listed.length, counted,
        `${tool}/${bucket}: the cell says ${counted}, the classifier lists ${listed.length}`);
    }
  }
});

/* ── 6. the family lens and the cell drill-in ─────────────────────────── */

check('EVERY DECLARED FAMILY SHIPS A CHIP, empty ones included', () => {
  /* A filter whose buttons appear and disappear as the data moves is one you
     cannot learn. `has` says which ones actually have rows, so the chip row
     is stable and an empty family says zero rather than vanishing. */
  const v = build(withSprints({}), PLAN());
  assert.deepStrictEqual(v.families.map(f => f.key), coverage.FAMILIES.map(f => f.key),
    'the chip row is not the declared family list');
  const ps = v.families.find(f => f.key === 'ps');
  assert.strictEqual(ps.count, 4, 'PS_iGO_NLG, PS_RES_NLG, PS_iGO_Lincoln and PS_iGO_Untagged');
  assert.strictEqual(ps.has, true);
  const rnd = v.families.find(f => f.key === 'rnd');
  assert.strictEqual(rnd.count, 0);
  assert.strictEqual(rnd.has, false, 'an empty family did not say so');
  assert.strictEqual(rnd.short, 'R&D', 'the chip has no label to draw');
});

check('THE CHIP SHIPS BOTH COUNTS, because the table folds its clear rows', () => {
  /* `count` is every ranked row in the family; `busy` is the ones with
     something in them. The table draws the second by default, so a chip
     showing the first sits over a table with fewer rows and one of the two
     numbers is wrong. Both ship and the view picks the one it is drawing. */
  const v = build(withSprints({}), PLAN());
  const ps = v.families.find(f => f.key === 'ps');
  assert.strictEqual(ps.count, 4);
  assert.strictEqual(ps.busy, 3, 'PS_RES_NLG is clear and should not be in the folded count');
  assert.notStrictEqual(ps.count, ps.busy, 'the two counts are indistinguishable in this fixture');
  for (const f of v.families) {
    assert.ok(f.busy <= f.count, `${f.key}: busy exceeds the total`);
    assert.strictEqual(f.busy, v.rows.filter(r => r.familyKey === f.key && !r.empty).length);
  }
});

check('A CELL DRILL-IN LISTS THE CELL\'S OWN KEYS, not a rebuilt query', () => {
  /* The cardinal rule of every drill-in here. `sprintComponentCell` re-runs
     the sheet and reads the cell's key list — a route rebuilding the same
     filter from a query string is a second implementation that agrees until
     the day it does not, and then neither side says which one is wrong. */
  const plan = PLAN();
  const snap = withSprints({
    s40: [{ key: 'S-1', type: 'Story', epic: 'A-3' }, { key: 'B-1', type: 'Bucket Story', relates: ['A-2'] }],
  });
  const v = build(snap, plan);
  const row = rowFor(v, 'PS_iGO_NLG');
  let seen = 0;
  for (const tool of ['truetest', 'kse']) {
    for (const cell of ['maintenance', 'ready', 'blocked', 'build', 'maint']) {
      const r = pz.sprintComponentCell(snap, plan, {
        team: RUBY, sprint: sprintOf(plan, 's40'), component: 'PS_iGO_NLG', tool, cell,
      });
      assert.strictEqual(r.ok, true, `${tool}/${cell} was refused`);
      assert.strictEqual(r.count, row[tool][cell], `${tool}/${cell}: count disagrees with the cell`);
      assert.deepStrictEqual(r.epics.map(e => e.key), row[tool].keys[cell],
        `${tool}/${cell}: the drawer would list a different set`);
      if (r.count) seen++;
    }
  }
  assert.ok(seen >= 3, `only ${seen} non-empty cells were reached — the fixture proves little`);
});

check('the drill-in names the tool AND the column, both from the model', () => {
  const plan = PLAN();
  const snap = withSprints({ s40: [{ key: 'S-1', type: 'Story', epic: 'A-3' }] });
  const at = (tool, cell) => pz.sprintComponentCell(snap, plan, {
    team: RUBY, sprint: sprintOf(plan, 's40'), component: 'PS_iGO_NLG', tool, cell,
  });
  assert.strictEqual(at('truetest', 'maintenance').label, 'TrueTest · Maintenance');
  assert.strictEqual(at('kse', 'build').label, 'KSE · New build');
  assert.strictEqual(at('kse', 'maint').label, 'KSE · Maintenance');
  // The two Maintenance columns share a word and are different measurements,
  // so the half has to travel separately from the label.
  assert.strictEqual(at('kse', 'maintenance').half, 'backlog');
  assert.strictEqual(at('kse', 'maint').half, 'planned');
  assert.strictEqual(at('kse', 'build').sprint.label, 'Ruby Sprint 40',
    'the drawer cannot say which sprint the planned half came from');
});

check('AN UNKNOWN CELL IS REFUSED, and says what would have worked', () => {
  const plan = PLAN();
  const snap = withSprints({});
  const at = (o) => pz.sprintComponentCell(snap, plan, {
    team: RUBY, sprint: sprintOf(plan, 's40'),
    component: 'PS_iGO_NLG', tool: 'truetest', cell: 'maintenance', ...o,
  });
  assert.strictEqual(at({}).ok, true, 'fixture check: the good call works');
  // `automated` is a real coverage bucket and NOT a column on this table —
  // the refusal that matters, since answering it would look entirely normal.
  assert.strictEqual(at({ cell: 'automated' }).ok, false, 'a bucket this table does not draw was answered');
  assert.strictEqual(at({ cell: '' }).ok, false);
  assert.strictEqual(at({ tool: 'katalon' }).ok, false);
  assert.strictEqual(at({ component: 'PS_iGO_Columbus' }).ok, false, 'an unranked component got a drawer');
  /* The `flag-*` names are the backlog columns' attention markers: the part of
     each queue that is retired or blocked. They are cells in their own right
     for the same reason `stuck-*` is — one drawer, one population. */
  assert.deepStrictEqual(at({ cell: 'automated' }).known,
    ['maintenance', 'ready', 'blocked', 'build', 'maint', 'stuck-build', 'stuck-maint',
      'flag-maintenance', 'flag-ready', 'flag-blocked']);
  assert.strictEqual(at({ cell: 'automated' }).count, 0, 'a refusal still returned a count');

  /* THE WARNING MARKERS ARE CELLS TOO, and refusable the same way. They list
     the sprint's blocked ITEMS rather than the epics the column counts, so a
     near-miss like `stuck` or `stuck-ready` must be refused rather than
     quietly answered with an empty list. */
  assert.strictEqual(at({ cell: 'stuck-build' }).ok, true, 'the build warning has no drawer');
  assert.strictEqual(at({ cell: 'stuck-maint' }).ok, true, 'the maintenance warning has no drawer');
  assert.strictEqual(at({ cell: 'stuck' }).ok, false, 'a half-named marker was answered');
  assert.strictEqual(at({ cell: 'stuck-ready' }).ok, false, 'a marker for a column that has none was answered');
  assert.strictEqual(at({ cell: 'stuck-build' }).kind, 'item',
    'the drawer would announce Stories as epics');
  assert.strictEqual(at({ cell: 'build' }).kind, 'epic');
});

/* ── 7. the shared walk ───────────────────────────────────────────────── */

check('`activeSprintEpics` STILL ANSWERS ITS OWN QUESTION after the refactor', () => {
  /* The Prioritization page's exclusion set now comes through the same walk
     this table uses. Its `viaParent`/`viaLinks` split is a DIFFERENT split
     from build/maint — a Bucket Story's parent is `viaParent` there and
     nothing here — and folding the two together would change that page's
     numbers without touching that page. */
  const plan = PLAN();
  const snap = withSprints({ s40: [{ key: 'B-1', type: 'Bucket Story', epic: 'A-8', relates: ['A-2'] }] });
  const flight = pz.activeSprintEpics(plan, snap, [RUBY]);
  assert.ok(flight.keys.has('A-8'), 'the bucket container epic left the exclusion set');
  assert.ok(flight.keys.has('A-2'), 'the linked suite left the exclusion set');
  assert.strictEqual(flight.viaParent, 1, 'the parent path stopped being reported');
  assert.strictEqual(flight.viaLinks, 1);
  assert.strictEqual(flight.items, 1);
  assert.deepStrictEqual(flight.sprints, [{ team: 'Katalon Ruby', label: 'Ruby Sprint 40' }]);
});

check('`activeSprintEpics` reads the ACTIVE sprints only — unlike the backlog set', () => {
  /* The two are deliberately different questions, and the refactor must not
     have quietly widened the older one. */
  const plan = PLAN();
  const snap = withSprints({ s41: [{ key: 'S-2', type: 'Story', epic: 'A-3' }] });
  assert.strictEqual(pz.activeSprintEpics(plan, snap, [RUBY]).keys.size, 0,
    'a future sprint reached the active-sprint set');
  assert.strictEqual(pz.openSprintEpics(plan, snap, [RUBY]).keys.size, 1,
    'and the open set missed it');
});

check('EVERY ACTIVE SPRINT, not just the first', () => {
  const plan = PLAN();
  plan.sprints.push({ id: 's40b', name: 'TT Week', byTeam: { ruby: { jiraId: '920', name: 'TT Week', state: 'active' } } });
  const snap = withSprints({ s40: [{ key: 'S-1', type: 'Story', epic: 'A-3' }] });
  snap.byTeam.ruby.sprintIssues['920'] = ['S-5'];
  snap.issues['S-5'] = {
    key: 'S-5', summary: 'S-5', issueType: 'Story', status: 'In Dev',
    parentKey: 'A-4', components: [], labels: [], team: 'Katalon PS Squad', relatesTo: [],
  };
  const flight = pz.activeSprintEpics(plan, snap, [RUBY]);
  assert.strictEqual(flight.keys.size, 2, 'the second active sprint was skipped');
  assert.strictEqual(pz.openSprintEpics(plan, snap, [RUBY]).keys.size, 2);
});

/* ── 7. no sprint, no team ────────────────────────────────────────────── */

check('WITH NO SPRINT SELECTED the backlog still reads and the planned half is empty', () => {
  const plan = PLAN();
  const v = pz.sprintComponents(withSprints({}), plan, { team: RUBY, sprint: null });
  assert.strictEqual(v.sprint, null, 'the header has no sprint to name and must say so');
  assert.strictEqual(v.totals.planned, 0);
  assert.ok(v.totals.backlog > 0, 'the backlog half went with it');
});

check('with no team at all it returns a shape rather than throwing', () => {
  const plan = PLAN();
  const v = pz.sprintComponents(withSprints({}), plan, { team: null, sprint: sprintOf(plan, 's40') });
  assert.strictEqual(v.team, null);
  assert.strictEqual(v.totals.planned, 0, 'a teamless sheet planned work for nobody');
  assert.ok(Array.isArray(v.rows), 'the rows are not a list');
});

check('an empty plan is an empty sheet, not an exception', () => {
  const v = pz.sprintComponents({ issues: {} }, {}, { team: RUBY, sprint: null });
  assert.deepStrictEqual(v.rows, []);
  assert.strictEqual(v.totals.components, 0);
  assert.strictEqual(v.totals.backlog, 0);
});

/* ── run ──────────────────────────────────────────────────────────────── */

/* ── 8. "this is planned, and it cannot be started" ───────────────────────
 *
 * A planned column counts SUITES with work in this sprint. It says nothing
 * about whether that work can begin, and on this board it very often cannot:
 * the item is in Refinement, or its Automation Status reads Blocked. "12
 * planned" and "12 planned, 5 of them stuck" are different sprints, and only
 * the first was ever on screen.
 *
 * The failures these pin are the quiet ones — a marker counting epics instead
 * of items, a count that does not match the list it opens, a warning that
 * leaks from the build column onto the maintenance one.
 */

/** A sprint where some of the planned work cannot be started. */
const stuckSprint = () => withSprints({
  s40: [
    { key: 'S-OK', type: 'Story', epic: 'A-3' },                              // fine
    { key: 'S-REF', type: 'Story', epic: 'A-3', status: 'Refinement' },       // the column
    { key: 'S-AUTO', type: 'Story', epic: 'A-5', automationStatus: 'Blocked' }, // the field
    { key: 'S-DONE', type: 'Story', epic: 'A-7', status: 'Refinement', statusCategory: 'done' },
    { key: 'B-OK', type: 'Bucket Story', epic: 'A-99', relates: ['A-1'] },
    { key: 'B-REF', type: 'Bucket Story', epic: 'A-99', relates: ['A-2'], status: 'Refinement' },
  ],
});

const cellOf = (v, component, tool) => rowFor(v, component)[tool];

check('A BLOCKED PLANNED ITEM IS FLAGGED AGAINST THE SUITE IT IS AGAINST', () => {
  const v = build(stuckSprint(), PLAN());
  /* ACROSS BOTH TOOLS. Which tool a suite lands on is a fact about the
     fixture's component lists, not about the marker — pinning it here would
     make this check a statement about the wrong thing. */
  const flagged = v.tools.flatMap(t2 => cellOf(v, 'PS_iGO_NLG', t2.key).stuck.build);
  assert.deepStrictEqual([...new Set(flagged)].sort(), ['S-AUTO', 'S-REF'],
    'the blocked planned items were not recorded against their suites');
  assert.ok(rowFor(v, 'PS_iGO_NLG').planned > 0, 'fixture check: there is planned work here');
});

check('BOTH SIGNALS COUNT — the Refinement column AND the automation field', () => {
  /* Neither subsumes the other. In his store 226 open items carry the field
     and only 131 are also in Refinement, so a marker reading one of them is
     right about part of the sheet and silently wrong about the rest. */
  const v = build(stuckSprint(), PLAN());
  const stuck = v.tools.flatMap(t2 => cellOf(v, 'PS_iGO_NLG', t2.key).stuck.build);
  assert.ok(stuck.includes('S-REF'), 'an item in Refinement was not flagged');
  assert.ok(stuck.includes('S-AUTO'), 'an item marked Blocked for automation was not flagged');
});

check('AND FINISHED WORK IS NEVER FLAGGED', () => {
  /* A done item in a Refinement-named column is a workflow quirk. Flagging it
     would make the warning rise as the team finished work, which is the one
     behaviour that would teach him to ignore it. */
  const v = build(stuckSprint(), PLAN());
  const all = v.tools.flatMap(t2 => ['build', 'maint'].flatMap(k => cellOf(v, 'PS_iGO_NLG', t2.key).stuck[k]));
  assert.ok(!all.includes('S-DONE'), 'finished work in a Refinement column was flagged as blocked');
});

check('THE WARNING DOES NOT LEAK BETWEEN BUILD AND MAINTENANCE', () => {
  /* One epic can be reached both ways in a sprint — a Story building it and a
     Bucket Story maintaining it are two different cells. A marker keyed only
     by epic would report one blocked item in both columns. */
  const v = build(stuckSprint(), PLAN());
  const nlg = cellOf(v, 'PS_iGO_NLG', 'kse');
  assert.ok(!nlg.stuck.maint.includes('S-REF'),
    'a blocked BUILD item was reported against the maintenance column');
  const tt = cellOf(v, 'PS_iGO_NLG', 'truetest');
  assert.ok(!tt.stuck.maint.includes('S-REF'));
  assert.ok(tt.stuck.maint.includes('B-REF') || tt.stuck.build.length === 0,
    'the blocked maintenance item is not against the maintenance column');
});

check('THE KEYS TRAVEL WITH THE MARKER — the count IS the list', () => {
  /* Every other figure on this sheet already follows this. A marker saying 3
     over a drawer of 2 is the failure mode that makes a warning worse than
     none, because the reader stops believing the numbers beside it too. */
  const snap = stuckSprint(), plan = PLAN();
  const v = build(snap, plan);
  for (const t of v.tools) {
    for (const k of ['build', 'maint']) {
      const keys = cellOf(v, 'PS_iGO_NLG', t.key).stuck[k];
      const drawer = pz.sprintComponentCell(snap, plan, {
        team: RUBY, sprint: sprintOf(plan, 's40'),
        component: 'PS_iGO_NLG', tool: t.key, cell: `stuck-${k}`,
      });
      assert.strictEqual(drawer.count, keys.length,
        `${t.key}/${k}: the marker says ${keys.length} and the drawer lists ${drawer.count}`);
      assert.deepStrictEqual(drawer.epics.map(e => e.key).sort(), keys.slice().sort());
    }
  }
});

check('THE DRAWER CARRIES WHY EACH ONE IS BLOCKED', () => {
  /* The Blocked column opens a panel, and "which ones" is only half of what
     the reader came for — the other half is what to go and chase. The panel
     can only show a reason the route hands it, so the guarantee lives in two
     files: this one pins the payload, links.test.js pins that the panel draws
     it.

     TWO FACTS, DELIBERATELY BOTH. The column comes from the Automation Status
     FIELD; `blockedBy` is Jira's own link, which somebody had to record. An
     epic with the field and no link is blocked with nothing to chase — a
     different and useful answer rather than a missing one. */
  const snap = withSprints({}), plan = PLAN();
  /* REPLACED, NOT MUTATED. `withSprints` maps the shared BASE objects in by
     reference, so setting a field on one would follow every other check in
     this file home. */
  snap.issues['A-4'] = {
    ...snap.issues['A-4'],
    blockedBy: [{ key: 'CLICMNTIGO-11567', summary: 'UWRE Bootstrap passes BirthState as an abbreviation' }],
  };

  const d = pz.sprintComponentCell(snap, plan, {
    team: RUBY, sprint: sprintOf(plan, 's40'),
    component: 'PS_iGO_NLG', tool: 'kse', cell: 'blocked',
  });
  assert.ok(d.ok, 'the blocked cell would not open');
  const linked = d.epics.find(e => e.key === 'A-4');
  assert.ok(linked, `fixture check: A-4 is in the blocked bucket — got ${d.epics.map(e => e.key).join(', ')}`);
  assert.deepStrictEqual(linked.blockedBy.map(b => b.key), ['CLICMNTIGO-11567'],
    'the drawer is not told what is blocking it, so it cannot say');
  assert.match(linked.blockedBy[0].summary, /UWRE Bootstrap/,
    'the blocker arrives as a bare key — the summary is what says whether to chase it');

  /* AND THE FIELD, for the ones with no link at all. Without it the panel
     cannot tell "blocked, nothing recorded" from "not blocked". */
  for (const e of d.epics) {
    assert.match(String(e.automationStatus), /blocked/i,
      `${e.key} sits in the Blocked bucket with automationStatus ${JSON.stringify(e.automationStatus)}`);
  }
});

/* ── PART OF A QUEUE THAT IS NOT REALLY QUEUED ──────────────────────────
   A Maintenance count reads as "suites waiting to be fixed", and some of them
   are not waiting for anything: the epic has been retired with an `obsolete`
   label. On his board two of Titan's 425 Maintenance epics are retired and
   only the label says so.

   The other half of the ask — "Automation Status = Blocked" — is the Blocked
   COLUMN, not a flag: `bucketOf` is exclusive, so that test is false for every
   Maintenance and Ready row by construction and true for every Blocked row.
   `B-1` and `B-OBS` below are the fixture that holds the model to that. */

const FLAG_BASE = [
  epic('M-1', { components: ['PS_iGO_NLG', 'Katalon'], automationStatus: 'Maintenance' }),
  epic('M-OBS', { components: ['PS_iGO_NLG', 'Katalon'], automationStatus: 'Maintenance', labels: ['Phase1', 'obsolete'] }),
  epic('R-1', { components: ['PS_iGO_NLG', 'Katalon'], automationStatus: 'Ready for Automation' }),
  epic('R-OBS', { components: ['PS_iGO_NLG', 'Katalon'], automationStatus: 'Ready for Automation', labels: ['obsoleted'] }),
  epic('B-1', { components: ['PS_iGO_NLG', 'Katalon'], automationStatus: 'Blocked' }),
  epic('B-OBS', { components: ['PS_iGO_NLG', 'Katalon'], automationStatus: 'Blocked', labels: ['obsolete'] }),
];
const flagSnap = () => {
  const snap = withSprints({});
  for (const e of FLAG_BASE) snap.issues[e.key] = e;
  return snap;
};

check('THE MAINTENANCE QUEUE FLAGS THE SUITES THAT ARE RETIRED', () => {
  const snap = flagSnap(), plan = PLAN();
  const v = build(snap, plan);
  const cell = cellOf(v, 'PS_iGO_NLG', 'kse');
  assert.ok(cell.keys.maintenance.includes('M-OBS'), 'fixture check: it is in the Maintenance queue');
  assert.deepStrictEqual(cell.flagged.maintenance, ['M-OBS'],
    'the retired Maintenance suite is not flagged');
  assert.ok(!cell.flagged.maintenance.includes('M-1'), 'an ordinary Maintenance suite was flagged');
});

check('AND THE FLAGGED SET IS A SUBSET OF THE COLUMN IT SITS ON', () => {
  /* The marker qualifies the number beside it. Flagging something the column
     does not count would put "2 of 1" on screen. */
  const snap = flagSnap(), plan = PLAN();
  const v = build(snap, plan);
  for (const r of v.rows) {
    for (const t of v.tools) {
      for (const b of ['maintenance', 'ready', 'blocked']) {
        const flagged = (r[t.key].flagged || {})[b] || [];
        assert.ok(flagged.length <= r[t.key][b], `${r.component}/${t.key}/${b}: ${flagged.length} flagged of ${r[t.key][b]}`);
        for (const k of flagged) {
          assert.ok(r[t.key].keys[b].includes(k), `${k} is flagged under ${b} but the column does not count it`);
        }
      }
    }
  }
});

check('AND A BLOCKED-BUCKET EPIC CANNOT BE IN THE MAINTENANCE COLUMN', () => {
  /* WHY "Automation Status = Blocked" IS NOT ONE OF THE FLAG'S TESTS.
     `bucketOf` is exclusive: an epic whose status reads Blocked is counted in
     the Blocked column, never in Maintenance. The status IS the column, so
     asking it again as a flag can only be false here. */
  const snap = flagSnap(), plan = PLAN();
  const v = build(snap, plan);
  const cell = cellOf(v, 'PS_iGO_NLG', 'kse');
  for (const k of cell.keys.maintenance) {
    assert.notStrictEqual(coverage.bucketOf(snap.issues[k]), 'blocked',
      `${k} is in the Maintenance column with a Blocked status — the buckets are meant to be exclusive`);
  }
  assert.ok(cell.keys.blocked.includes('B-1'), 'the Blocked-status epic is not in the Blocked column');
});

check('AND THE BLOCKED COLUMN FLAGS ONLY THE RETIRED ONES, never all of them', () => {
  /* THE OTHER END OF THE SAME ARGUMENT, and the reason the rule is `isObsolete`
     alone. Testing `bucket === 'blocked'` as well reads as harmless — it is
     unreachable on Maintenance and Ready — but on the Blocked column it is
     true of every single row, so the marker would fire on 193 of 193. A marker
     that never distinguishes anything is not a marker, and this is the check
     that refuses it. The flags are carried for all three buckets, so this
     holds whether or not the view draws the Blocked one today. */
  const snap = flagSnap(), plan = PLAN();
  const cell = cellOf(build(snap, plan), 'PS_iGO_NLG', 'kse');
  assert.ok(cell.keys.blocked.includes('B-OBS'), 'fixture check: the retired blocked suite is not in the column');
  assert.ok(cell.keys.blocked.includes('B-1'), 'fixture check: the ordinary blocked suite is not in the column');
  assert.deepStrictEqual(cell.flagged.blocked, ['B-OBS'],
    'the Blocked column flags every row it counts — the flag is saying nothing');
  assert.ok(cell.flagged.blocked.length < cell.keys.blocked.length,
    'the flagged set is the whole column');
});

check('AND A RETIRED EPIC THAT KEPT A STATUS IS STILL FLAGGED', () => {
  /* The case `bucketOf` alone cannot see, and the only one that fires on this
     column: status wins over the label, so `bucketOf` says "maintenance" and
     never "obsoleted". Asking `isObsolete` as well is what finds it. */
  const snap = flagSnap(), plan = PLAN();
  assert.strictEqual(coverage.bucketOf(snap.issues['M-OBS']), 'maintenance',
    'precondition: the status wins over the label');
  assert.strictEqual(coverage.isObsolete(snap.issues['M-OBS']), true, 'precondition: it is labelled obsolete');
  assert.deepStrictEqual(cellOf(build(snap, plan), 'PS_iGO_NLG', 'kse').flagged.maintenance, ['M-OBS']);
});

check('THE MARKER OPENS ITS OWN SET, with the reason on each row', () => {
  const snap = flagSnap(), plan = PLAN();
  const d = pz.sprintComponentCell(snap, plan, {
    team: RUBY, sprint: sprintOf(plan, 's40'),
    component: 'PS_iGO_NLG', tool: 'kse', cell: 'flag-maintenance',
  });
  assert.ok(d.ok, `the flag cell was refused: ${JSON.stringify(d.known)}`);
  assert.strictEqual(d.count, 1, 'the drawer lists a different number from the marker');
  assert.deepStrictEqual(d.epics.map(e => e.key), ['M-OBS']);
  assert.strictEqual(d.flagged, true, 'the drawer does not know it is listing a subset');
  assert.match(d.label, /Maintenance/, 'the heading does not name the column it came from');
  assert.match(d.label, /retired/i, 'the heading reads as the whole Maintenance queue');

  /* THE REASON HAS TO TRAVEL. The drawer's note that explains a retired suite
     reads the row's own labels — a row without them is listed under "needs
     attention" with nothing saying why. */
  assert.ok((d.epics[0].labels || []).includes('obsolete'),
    'the labels do not travel, so the drawer cannot say the suite is retired');
  assert.strictEqual(d.epics[0].automationStatus, 'Maintenance', 'the status does not travel either');
});

check('AND THE FLAG CELLS ARE REFUSED FOR A COLUMN THAT HAS NONE', () => {
  /* An unrecognised name answering with an empty list is a drawer saying 0
     under a marker saying 2 — the rule this route already follows. */
  const snap = flagSnap(), plan = PLAN();
  const at = (cell) => pz.sprintComponentCell(snap, plan, {
    team: RUBY, sprint: sprintOf(plan, 's40'), component: 'PS_iGO_NLG', tool: 'kse', cell,
  });
  assert.strictEqual(at('flag-automated').ok, false, 'a bucket this table does not draw was answered');
  assert.strictEqual(at('flag-build').ok, false, 'a planned column was answered as a backlog flag');
  /* The ones that DO exist answer, even when empty — an empty flagged set is a
     real answer, not an unknown cell. */
  assert.strictEqual(at('flag-ready').ok, true);
  assert.deepStrictEqual(at('flag-ready').epics.map(e => e.key), ['R-OBS']);
});

check('THE DRAWER LISTS ITEMS, NOT THE EPICS THE COLUMN COUNTS', () => {
  /* The column counts suites; the marker counts the sprint's own Stories. A
     drawer that listed the epics would be answering a question nobody asked,
     under a heading promising the other one. */
  const snap = stuckSprint(), plan = PLAN();
  const d = pz.sprintComponentCell(snap, plan, {
    team: RUBY, sprint: sprintOf(plan, 's40'),
    component: 'PS_iGO_NLG', tool: 'kse', cell: 'stuck-build',
  });
  assert.strictEqual(d.kind, 'item');
  assert.strictEqual(d.stuck, true);
  assert.match(d.label, /blocked/i, 'the drawer heading does not say what it is listing');
  for (const e of d.epics) assert.ok(/^S-/.test(e.key), `${e.key} is an epic, not a planned item`);
});

check('A CLEAN SPRINT CARRIES NO MARKER AT ALL', () => {
  /* Empty arrays, not absent keys — the view reads `.stuck[kind].length` on
     every cell it draws, and an undefined there is a blank column rather than
     a zero. And a marker that is always present is one nobody reads. */
  const v = build(withSprints({ s40: [{ key: 'S-1', type: 'Story', epic: 'A-3' }] }), PLAN());
  for (const t of v.tools) {
    for (const k of ['build', 'maint']) {
      assert.deepStrictEqual(cellOf(v, 'PS_iGO_NLG', t.key).stuck[k], [],
        `${t.key}/${k} has no stuck list on a clean sprint`);
    }
  }
  assert.strictEqual(rowFor(v, 'PS_iGO_NLG').stuck, 0, 'a clean row reported blocked work');
});

check("THE ROW'S OWN COUNT IS DISTINCT ACROSS TOOLS", () => {
  /* One Story blocking a suite that TrueTest and KSE both cover is ONE
     blocked item. Summing the cells would make the row shout louder than the
     truth — and A-2 is on both tools in this fixture, deliberately. */
  const v = build(stuckSprint(), PLAN());
  const row = rowFor(v, 'PS_iGO_NLG');
  const summed = v.tools.reduce((n, t) => n
    + row[t.key].stuck.build.length + row[t.key].stuck.maint.length, 0);
  const distinct = new Set(v.tools.flatMap(t => [...row[t.key].stuck.build, ...row[t.key].stuck.maint])).size;
  assert.strictEqual(row.stuck, distinct, 'the row count is not the distinct set');
  assert.ok(summed >= distinct, 'fixture sanity');
});

for (const [name, fn] of checks) {
  try { fn(); console.log(`  \u001b[32m✓\u001b[0m ${name}`); passed++; }
  catch (e) { console.log(`  \u001b[31m✗\u001b[0m ${name}\n    ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
