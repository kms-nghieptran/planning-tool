'use strict';
/**
 * insights.test.js — the views, the store, and the sync integrity guarantees.
 *
 * Runs entirely offline against a fake Jira. Every integrity guarantee here has
 * been mutation-tested: break the line it protects and a check below goes red.
 *
 * Run: node test/insights.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-test-'));
process.env.STORE_DIR = SCRATCH;

const store = require('../lib/store');
const insights = require('../lib/insights');
const sync = require('../lib/sync');
const csv = require('../lib/csv');
const capacity = require('../lib/capacity');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

/* ── fixture ──────────────────────────────────────────────────────────── */

const SPRINT = { id: 'S40', number: 40, name: 'Sprint 40', start: '2026-09-17', end: '2026-09-30' };
const PREV = { id: 'S39', number: 39, name: 'Sprint 39', start: '2026-09-03', end: '2026-09-16' };

const TEAM = {
  id: 'titan', name: 'Katalon Titan',
  sprintKeywords: ['titan'],
  jiraTeams: ['Katalon Auto Titan'],
  components: ['R&D_iGO_E2E'],
  settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9, workloadOverPct: 110, workloadUnderPct: 85 },
  members: [
    { id: 'm1', name: 'Thuan Dinh Cong Ngoc', role: 'QA Lead', status: 'Active', supportPct: 40 },
    { id: 'm2', name: 'Hien Phan', role: 'Auto QA', status: 'Active', supportPct: 0 },
    { id: 'm3', name: 'Anh Truong', role: 'Auto QA', status: 'Active', supportPct: 0 },
    { id: 'm4', name: 'Huynh Nguyen', role: 'Auto QA', status: 'Released', supportPct: 0 },
  ],
};

const full = new Array(14).fill('1').map((c, i) => ([2, 3, 9, 10].includes(i) ? 'WO' : c));  // 10 working days

const PLAN = {
  version: 1, teams: [TEAM], sprints: [PREV, SPRINT], holidays: [],
  availability: {
    'titan|S40|m1': full, 'titan|S40|m2': full, 'titan|S40|m3': full,
    'titan|S39|m1': full, 'titan|S39|m2': full, 'titan|S39|m3': full,
  },
  support: {}, ceremony: {}, overrides: {}, risks: [], notes: {}, categoryRules: null, mixTargets: null,
};

const issue = (o) => ({
  key: o.key, summary: o.summary || 'x', issueType: o.issueType || 'Story',
  status: o.status || 'Open', statusCategory: o.status === 'Done' ? 'done' : (o.inProgress ? 'indeterminate' : 'new'),
  assignee: o.assignee || null, labels: o.labels || [], components: o.components || [],
  points: 'points' in o ? o.points : 3, sprintNames: o.sprint ? [o.sprint] : [], sprints: o.sprint ? [{ name: o.sprint }] : [],
  blockedBy: o.blockedBy || [], updated: o.updated || '2026-09-20T00:00:00.000Z',
  resolved: o.status === 'Done' ? (o.resolved || '2026-09-21T00:00:00.000Z') : null,
  team: o.team || 'Katalon Auto Titan', priority: o.priority || 'Medium',
});

const SNAP = {
  source: 'jira', syncedAt: '2026-09-24T00:00:00.000Z', watermark: '2026-09-24T00:00:00.000Z',
  sprints: [{ name: 'Katalon Titan Sprint 39' }, { name: 'Katalon Titan Sprint 40' }],
  issues: Object.fromEntries([
    // Sprint 40 — the sprint under test
    issue({ key: 'A-1', assignee: 'Thuan Dinh Cong Ngoc', points: 11, sprint: 'Katalon Titan Sprint 40', status: 'Done', components: ['R&D_iGO_E2E'] }),
    issue({ key: 'A-2', assignee: 'Hien Phan', points: 30, sprint: 'Katalon Titan Sprint 40', components: ['R&D_iGO_E2E'] }),
    issue({ key: 'A-3', assignee: 'Anh Truong', points: 5, sprint: 'Katalon Titan Sprint 40', labels: ['Maintenance'] }),
    issue({ key: 'A-4', assignee: null, points: 4, sprint: 'Katalon Titan Sprint 40' }),
    issue({ key: 'A-5', assignee: 'Anh Truong', points: null, sprint: 'Katalon Titan Sprint 40' }),
    issue({ key: 'A-6', assignee: 'Hien Phan', points: 3, sprint: 'Katalon Titan Sprint 40', blockedBy: ['A-9'] }),
    // Sprint 39 — history
    issue({ key: 'B-1', assignee: 'Thuan Dinh Cong Ngoc', points: 10, sprint: 'Katalon Titan Sprint 39', status: 'Done' }),
    issue({ key: 'B-2', assignee: 'Hien Phan', points: 18, sprint: 'Katalon Titan Sprint 39', status: 'Done' }),
    issue({ key: 'B-3', assignee: 'Anh Truong', points: 12, sprint: 'Katalon Titan Sprint 39', status: 'Done' }),
    // Another team's sprint — must not leak in
    issue({ key: 'C-1', assignee: 'Hy Nguyen', points: 20, sprint: 'Katalon Ruby Sprint 40', team: 'Katalon Auto Ruby' }),
    // Backlog
    issue({ key: 'D-1', assignee: 'Hien Phan', points: 8, components: ['R&D_iGO_E2E'] }),
    issue({ key: 'D-2', points: 5, components: ['R&D_iGO_E2E'], team: 'Katalon Auto Titan' }),
    issue({ key: 'D-3', points: null, components: ['R&D_iGO_E2E'], team: 'Katalon Auto Titan' }),
  ].map(i => [i.key, i])),
  testops: { projects: [] }, github: {}, verification: [],
};

const MID_SPRINT = new Date('2026-09-24T00:00:00Z');   // 6 of 10 working days elapsed

(async () => {
console.log('\nViews, store and sync integrity\n');

/* ── sprint matching ──────────────────────────────────────────────────── */
await check('a sprint matcher only claims its own team\'s namespaced sprint', () => {
  const m = insights.sprintMatcher(TEAM, SPRINT);
  assert.ok(m('Katalon Titan Sprint 40'));
  assert.ok(!m('Katalon Ruby Sprint 40'), 'Ruby sprint 40 must not match Titan');
  assert.ok(!m('Katalon Titan Sprint 4'), 'sprint 4 must not match sprint 40');
});

await check('the legacy "Katalon Titan 40" naming still matches', () => {
  assert.ok(insights.sprintMatcher(TEAM, SPRINT)('Katalon Titan 40'));
});

await check("another team's sprint work never reaches this team's grid", () => {
  const w = insights.workForSprint(PLAN, SNAP, TEAM, SPRINT);
  assert.ok(!w.issues.some(i => i.key === 'C-1'));
});

/* ── capacity view ────────────────────────────────────────────────────── */
await check('capacity view reproduces the per-member sheet maths end to end', () => {
  const v = insights.capacityView(PLAN, SNAP, TEAM, SPRINT);
  const thuan = v.rows.find(r => r.memberId === 'm1');
  assert.strictEqual(thuan.availableDays, 10);
  assert.strictEqual(thuan.capacityHours, 33);        // 10*7*0.6 - 9
  assert.strictEqual(thuan.predicted, 11);
  assert.strictEqual(thuan.planned, 11);
  assert.strictEqual(thuan.actual, 11);
});

await check('unassigned sprint points are surfaced, not silently dropped', () => {
  const v = insights.capacityView(PLAN, SNAP, TEAM, SPRINT);
  assert.strictEqual(v.unassigned.points, 4);
  assert.strictEqual(v.unassigned.count, 1);
});

/* ── work with nobody on it ───────────────────────────────────────────────
   A-4 is open, A-7 is finished, and neither is owned. Separating them is the
   point: a per-person table that shows the unowned pile has to say how much of
   it has LANDED, or the row is a planned number with a blank next to it. */
const UNOWNED = {
  ...SNAP,
  issues: {
    ...SNAP.issues,
    'A-7': issue({ key: 'A-7', assignee: null, points: 6, sprint: 'Katalon Titan Sprint 40', status: 'Done' }),
  },
};
const r1 = (n) => Math.round(n * 10) / 10;

await check('THE UNOWNED PILE REPORTS WHAT IT FINISHED, not only what it planned', () => {
  const v = insights.capacityView(PLAN, UNOWNED, TEAM, SPRINT);
  assert.strictEqual(v.unassigned.count, 2);
  assert.strictEqual(v.unassigned.points, 10, 'A-4 (4) + A-7 (6)');
  // Counting every unowned item would give 10 and counting none would give 0,
  // so this number is only right if the done filter is really applied.
  assert.strictEqual(v.unassigned.done, 6, 'only A-7 is finished');
});

await check('and the sprint KPI counts that finished unowned work as done', () => {
  const withIt = insights.activeSprintView(PLAN, UNOWNED, TEAM, SPRINT, { today: MID_SPRINT });
  const without = insights.activeSprintView(PLAN, SNAP, TEAM, SPRINT, { today: MID_SPRINT });
  assert.strictEqual(r1(withIt.progress.committed - without.progress.committed), 6, 'it is in the commitment');
  assert.strictEqual(r1(withIt.progress.done - without.progress.done), 6, 'and in what has landed');
});

/* ── work owned by someone who is not on the roster ───────────────────────
   The defect he reported: Katalon Titan Sprint 30 said 53 items had no
   assignee when every one of them named a person. The cause was an exclusion —
   a decision about who is on the team NOW — being applied to a sprint that had
   already closed, which erased the people who did the work and left their
   tickets attributed to nobody. */

const GONE = { ...SNAP, issues: { ...SNAP.issues,
  'A-8': issue({ key: 'A-8', assignee: 'Luong Trinh', points: 7, sprint: 'Katalon Titan Sprint 40', status: 'Done' }),
} };
const EXCLUDED = { ...PLAN, excluded: { titan: ['Luong Trinh'] } };

await check('NAMED WORK IS NEVER REPORTED AS UNASSIGNED', () => {
  const v = insights.capacityView(EXCLUDED, GONE, TEAM, SPRINT);
  assert.strictEqual(v.unassigned.count, 1, 'only A-4, which really has nobody on it');
  assert.strictEqual(v.offRoster.count, 1, 'A-8 has an owner, so it is not unassigned');
  assert.strictEqual(v.offRoster.points, 7);
  assert.deepStrictEqual(v.offRoster.people.map(p => p.name), ['Luong Trinh'], 'and the owner is named');
  assert.strictEqual(v.unowned.count, 2, 'both are still outside the roster, and both are still in the sprint');
});

await check('AN EXCLUSION KEEPS SHAPING A SPRINT YOU CAN STILL PLAN', () => {
  // The rule it exists for: ten people who left must not reappear on a future
  // sprint and triple its capacity.
  const v = insights.capacityView(EXCLUDED, GONE, TEAM, SPRINT);
  assert.ok(!v.roster.members.some(m => m.name === 'Luong Trinh'));
});

await check('BUT A CLOSED SPRINT KEEPS WHOEVER DID THE WORK', () => {
  const closed = { ...SPRINT, byTeam: { titan: { jiraId: '900', name: 'Katalon Titan Sprint 40', state: 'closed' } } };
  const v = insights.capacityView(EXCLUDED, GONE, TEAM, closed);
  assert.ok(v.roster.members.some(m => m.name === 'Luong Trinh'),
    'a closed sprint is a record, not a plan — the exclusion must not rewrite it');
  assert.strictEqual(v.offRoster.count, 0, 'so their work is attributed to them, not to nobody');
});

await check("HISTORY IS MEASURED AGAINST THE TEAM THE SPRINT HAD, not today's", () => {
  // It used to score every past sprint against the current member list, so
  // everything delivered by people who have since moved on simply vanished.
  // On his data that hid 5,046 of Titan's delivered points across 38 sprints.
  const past = { ...SNAP, issues: { ...SNAP.issues,
    'B-9': issue({ key: 'B-9', assignee: 'Someone Who Left', points: 21, sprint: 'Katalon Titan Sprint 39', status: 'Done' }),
  } };
  const h = insights.velocityHistory(PLAN, past, TEAM).find(x => x.sprintId === 'S39');
  assert.strictEqual(h.actual, 61, 'the 40 pts the current team delivered plus the 21 theirs did');
  assert.ok(h.headcount >= 4, 'and they are counted as a person who was there');
});

await check('a sprint\'s history and its own screen agree about what it delivered', () => {
  const v = insights.activeSprintView(EXCLUDED, GONE, TEAM, SPRINT, { today: MID_SPRINT });
  const h = insights.velocityHistory(EXCLUDED, GONE, TEAM).find(x => x.sprintId === SPRINT.id);
  assert.strictEqual(h.planned, v.progress.committed, 'the same sprint read two different ways');
  assert.strictEqual(h.actual, v.progress.done);
});

/* ── a short name and its full one are one person ─────────────────────────
   He reported it on Katalon Titan Sprint 39: "Anh" sat on the roster with ten
   available days and zero points, while sixteen points of "Anh Truong"'s work
   sat in a bucket for people not on the sprint. One person, split into a row
   with no work and work with no row, because the roster record came from the
   leave grid he typed and the work came from Jira. */

const SHORT_TEAM = {
  ...TEAM,
  members: [
    ...TEAM.members.filter(m => m.name !== 'Anh Truong'),
    { id: 'm-anh', name: 'Anh', role: 'Auto QA', status: 'Active', supportPct: 0 },
    { id: 'm-an', name: 'An', role: 'Auto QA', status: 'Active', supportPct: 0 },
  ],
};

await check('A SHORT NAME ON THE ROSTER IS MATCHED TO ITS FULL ONE IN JIRA', () => {
  const r = insights.memberResolver(SHORT_TEAM);
  assert.strictEqual(r({ assignee: 'Anh Truong' }), 'm-anh');
});

await check('so their work lands on their row instead of on nobody', () => {
  const v = insights.capacityView({ ...PLAN, teams: [SHORT_TEAM] }, SNAP, SHORT_TEAM, SPRINT);
  const anh = v.rows.find(x => x.memberId === 'm-anh');
  assert.strictEqual(anh.planned, 5, "Anh Truong's A-3 and the unestimated A-5");
  assert.strictEqual(v.offRoster.count, 0, 'nothing is left over for a person not on the sprint');
});

await check('"An" IS NOT "Anh Truong" — whole words only', () => {
  // The guard that makes this safe to do at all: a prefix match would have
  // handed An Thien Nguyen's row somebody else's work.
  //
  // "An" is the ONLY loose candidate here on purpose. With "Anh" also on the
  // team a prefix match would hit both and be rejected as ambiguous, so the
  // ambiguity guard would hide the prefix bug instead of the token rule
  // catching it — this check would pass while being about nothing.
  const only = { ...TEAM, members: [{ id: 'm-an', name: 'An', status: 'Active', supportPct: 0 }] };
  const r = insights.memberResolver(only);
  assert.strictEqual(r({ assignee: 'Anh Truong' }), null, '"An" is not a word in "Anh Truong"');
  assert.strictEqual(r({ assignee: 'An Thien Nguyen' }), 'm-an', 'but it is a word in "An Thien Nguyen"');
});

await check('a single initial is not a name', () => {
  const only = { ...TEAM, members: [{ id: 'm-a', name: 'A', status: 'Active', supportPct: 0 }] };
  assert.strictEqual(insights.memberResolver(only)({ assignee: 'Anh Truong' }), null);
});

await check('AN AMBIGUOUS SHORT NAME MATCHES NOBODY', () => {
  // Two people it could be is not a match, it is a coin toss — and a wrong
  // name on a row is worse than a visible gap, because the gap is on screen.
  const two = { ...SHORT_TEAM, members: [...SHORT_TEAM.members, { id: 'm-anh2', name: 'Anh', role: 'Auto QA', status: 'Active', supportPct: 0 }] };
  assert.strictEqual(insights.memberResolver(two)({ assignee: 'Anh Truong' }), null);
});

await check('a member WITH a Jira account is never matched by name overlap', () => {
  // They have an account id and it did not match, so this is a different
  // person however similar the name looks.
  const withAcct = { ...SHORT_TEAM, members: [{ id: 'm-x', name: 'Anh', jiraAccountId: 'acc-someone-else', status: 'Active', supportPct: 0 }] };
  assert.strictEqual(insights.memberResolver(withAcct)({ assignee: 'Anh Truong', assigneeId: 'acc-anh' }), null);
});

await check('an exact name still wins over a loose one', () => {
  const both = { ...SHORT_TEAM, members: [...SHORT_TEAM.members, { id: 'm-full', name: 'Anh Truong', status: 'Active', supportPct: 0 }] };
  assert.strictEqual(insights.memberResolver(both)({ assignee: 'Anh Truong' }), 'm-full');
});

await check('AND THE MATCH IS SAID OUT LOUD, not applied silently', () => {
  const v = insights.capacityView({ ...PLAN, teams: [SHORT_TEAM] }, SNAP, SHORT_TEAM, SPRINT);
  const anh = v.roster.members.find(m => m.id === 'm-anh');
  assert.deepStrictEqual(anh.matchedNames, ['Anh Truong'],
    'an inferred link has to be checkable by the person who would know it is wrong');
  const hien = v.roster.members.find(m => m.name === 'Hien Phan');
  assert.strictEqual(hien.matchedNames, undefined, 'an exact match is not an inference and says nothing');
});

await check('WORK IN THE SPRINT BEATS WHAT WE ASSUMED ABOUT THE PERSON', () => {
  // Someone known only from a leave grid is created as a "planned" row and
  // marked historic, on the guess that a capacity row with no work behind it
  // is a leftover. Once their work is matched to them the guess is wrong, and
  // leaving it showed Anh — sixteen points into the active sprint — tagged
  // "planned" and "past member" at the same time.
  const leaveOnly = {
    ...PLAN,
    teams: [{ ...TEAM, members: TEAM.members.filter(m => m.name !== 'Anh Truong') }],
    availability: { ...PLAN.availability, 'titan|S40|titan-anh': full },
  };
  const base = leaveOnly.teams[0];
  const v = insights.capacityView(leaveOnly, SNAP, base, SPRINT);
  const anh = v.roster.members.filter(m => /anh/i.test(m.name));
  assert.strictEqual(anh.length, 1, 'one person, one row — not a capacity row beside a work row');
  assert.strictEqual(anh[0].name, 'Anh Truong', 'the merged row keeps the full name Jira knows them by');
  assert.strictEqual(anh[0].onSprint, 'assigned', 'they have work, so they are not merely planned for');
  assert.strictEqual(anh[0].historic, false, 'and someone delivering this sprint is not a past member');
  assert.ok((anh[0].aliasIds || []).includes('titan-anh'),
    'the leave grid id comes along, or the availability entered under it is lost');
  // The capacity row itself proves the merge: the days come from the grid filed
  // under "titan-anh", the points from tickets assigned to "Anh Truong".
  const row = v.rows.find(r => r.name === 'Anh Truong');
  assert.ok(row.availableDays > 0, 'the leave grid reached the merged row');
  assert.strictEqual(row.planned, 5, 'and so did the work');
});

await check('but someone with only a leave grid and no work stays "planned"', () => {
  const leaveOnly = {
    ...PLAN,
    teams: [{ ...TEAM, members: TEAM.members.filter(m => m.name !== 'Anh Truong') }],
    availability: { ...PLAN.availability, 'titan|S40|titan-nobody': full },
  };
  const base = leaveOnly.teams[0];
  const v = insights.capacityView(leaveOnly, SNAP, base, SPRINT);
  const row = v.roster.members.find(m => m.id === 'titan-nobody');
  assert.strictEqual(row.onSprint, 'planned', 'no work means the original reading still stands');
});

/* ── progress by component ────────────────────────────────────────────── */

const comp = (o) => ({ points: o.points, components: o.components || [], blockedBy: o.blockedBy || [],
  status: o.done ? 'Done' : 'Open', statusCategory: o.done ? 'done' : 'new' });

await check('COMPONENT PROGRESS COUNTS DELIVERED AGAINST COMMITTED', () => {
  const r = insights.componentProgress([
    comp({ points: 5, components: ['PS_iGO_NLG'], done: true }),
    comp({ points: 3, components: ['PS_iGO_NLG'] }),
    comp({ points: 2, components: ['KAT_Common'] }),
  ]);
  const nlg = r.rows.find(x => x.component === 'PS_iGO_NLG');
  assert.strictEqual(nlg.count, 2);
  assert.strictEqual(nlg.points, 8);
  assert.strictEqual(nlg.done, 5);
  assert.strictEqual(nlg.remaining, 3);
  assert.strictEqual(nlg.donePct, 63);
  assert.strictEqual(r.rows[0].component, 'PS_iGO_NLG', 'the biggest commitment leads');
});

await check('A TOOL MARKER IS NOT A COMPONENT', () => {
  // Two thirds of his active sprint items carry "TrueTest" as a component. It
  // is where the suite runs, not an area of the product, and grouping on it
  // would have made the automation tool the biggest row on the screen.
  const r = insights.componentProgress([
    comp({ points: 5, components: ['TrueTest', 'PS_iGO_NLG'] }),
    comp({ points: 4, components: ['Katalon', 'PS_iGO_NLG'] }),
  ]);
  assert.deepStrictEqual(r.rows.map(x => x.component), ['PS_iGO_NLG']);
  assert.strictEqual(r.rows[0].points, 9);
  assert.strictEqual(r.shared, 0, 'a tool marker alongside one component is not shared work');
});

await check('an item in two components counts in BOTH, and says so', () => {
  // The same rule the coverage report uses. Picking one component per item
  // would under-report every area that shares work; counting both means the
  // column can exceed the commitment, which is why `shared` exists.
  const r = insights.componentProgress([comp({ points: 6, components: ['A_One', 'B_Two'] })]);
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.rows[0].points, 6);
  assert.strictEqual(r.rows[1].points, 6);
  assert.strictEqual(r.shared, 1, 'the screen needs to know before it prints a total over the commitment');
});

await check('an item with no component gets a row rather than vanishing', () => {
  const r = insights.componentProgress([comp({ points: 3, components: [] })]);
  assert.strictEqual(r.rows.length, 1);
  assert.match(r.rows[0].component, /no component/i);
});

await check('and the rows flag what needs attention', () => {
  const r = insights.componentProgress([
    comp({ points: 5, components: ['A_One'], blockedBy: ['X-1'] }),
    comp({ points: null, components: ['A_One'] }),
    comp({ points: 4, components: ['A_One'], blockedBy: ['X-2'], done: true }),
  ]);
  const row = r.rows[0];
  assert.strictEqual(row.blocked, 1, 'a finished item is not still blocked');
  assert.strictEqual(row.unestimated, 1);
});

await check("THE SPRINT'S OWN SCREEN CARRIES THE BREAKDOWN", () => {
  const v = insights.activeSprintView(PLAN, SNAP, TEAM, SPRINT, { today: MID_SPRINT });
  assert.ok(v.byComponent && Array.isArray(v.byComponent.rows), 'the view can only show what the model returns');
  const total = v.byComponent.rows.reduce((t, r) => t + r.points, 0);
  assert.ok(total > 0, 'the fixture has componentless items too, so this is the estimated ones');
});

await check('EVERY SPRINT ITEM REACHES THE ITEM LIST, assignee or not', () => {
  const v = insights.activeSprintView(PLAN, UNOWNED, TEAM, SPRINT, { today: MID_SPRINT });
  const keys = v.items.map(i => i.key);
  for (const k of ['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7']) {
    assert.ok(keys.includes(k), `${k} missing from the item list`);
  }
  assert.strictEqual(v.items.filter(i => !i.assignee).length, 2, 'both unowned items are in the list');
});

await check('a released member is excluded from headcount and capacity', () => {
  const v = insights.capacityView(PLAN, SNAP, TEAM, SPRINT);
  assert.strictEqual(v.totals.headcount, 3);
  assert.ok(v.rows.some(r => r.status === 'Released'), 'but still shown in the grid');
});

await check('a 30-point commitment on 21 points of capacity is flagged overloaded', () => {
  const v = insights.capacityView(PLAN, SNAP, TEAM, SPRINT);
  const hien = v.rows.find(r => r.memberId === 'm2');
  assert.ok(hien.workloadPct > 110, `expected >110%, got ${hien.workloadPct}`);
  assert.ok(hien.flags.some(f => f.code === 'overloaded'));
});

await check('per-sprint support override beats the member default', () => {
  const plan = { ...PLAN, support: { 'titan|S40|m2': 50 } };
  const v = insights.capacityView(plan, SNAP, TEAM, SPRINT);
  assert.strictEqual(v.rows.find(r => r.memberId === 'm2').capacityHours, 26);  // 10*7*0.5 - 9
});

await check('per-sprint ceremony override beats the team default', () => {
  const plan = { ...PLAN, ceremony: { 'titan|S40': 0 } };
  const v = insights.capacityView(plan, SNAP, TEAM, SPRINT);
  assert.strictEqual(v.rows.find(r => r.memberId === 'm2').capacityHours, 70);
});

await check('a manual override replaces the Jira-derived numbers (no-connection mode)', () => {
  const plan = { ...PLAN, overrides: { 'titan|S40|m2': { planned: 12, actual: 6 } } };
  const v = insights.capacityView(plan, SNAP, TEAM, SPRINT);
  const hien = v.rows.find(r => r.memberId === 'm2');
  assert.strictEqual(hien.planned, 12);
  assert.strictEqual(hien.actual, 6);
});

/* ── active sprint ────────────────────────────────────────────────────── */
await check('sprint progress counts only Done points as delivered', () => {
  const v = insights.activeSprintView(PLAN, SNAP, TEAM, SPRINT, { today: MID_SPRINT });
  assert.strictEqual(v.progress.done, 11);
  assert.strictEqual(v.progress.committed, 53);   // 11+30+5+4+3, A-5 has no estimate
});

await check('blocked and unestimated items are both called out', () => {
  const v = insights.activeSprintView(PLAN, SNAP, TEAM, SPRINT, { today: MID_SPRINT });
  assert.strictEqual(v.progress.blocked.count, 1);
  assert.strictEqual(v.progress.unestimated.count, 1);
});

await check('health is red with reasons, never a bare number', () => {
  const v = insights.activeSprintView(PLAN, SNAP, TEAM, SPRINT, { today: MID_SPRINT });
  assert.ok(v.health.reasons.length >= 3);
  assert.ok(['amber', 'red'].includes(v.health.rag), `expected amber/red, got ${v.health.rag}`);
  assert.ok(v.health.reasons.some(r => /overcommitted/i.test(r.text)));
});

await check('a clean sprint reports green with an explicit all-clear reason', () => {
  const clean = {
    ...PLAN,
    overrides: { 'titan|S40|m1': { planned: 11, actual: 11 }, 'titan|S40|m2': { planned: 20, actual: 20 }, 'titan|S40|m3': { planned: 20, actual: 20 } },
  };
  const snap = { ...SNAP, issues: { 'B-1': SNAP.issues['B-1'] } };   // no sprint-40 items to flag
  const v = insights.activeSprintView(clean, snap, TEAM, SPRINT, { today: new Date('2026-09-30T00:00:00Z') });
  assert.strictEqual(v.health.rag, 'green');
  assert.ok(v.health.reasons.some(r => r.level === 'ok'));
});

await check('burndown has one point per working day and starts from the commitment', () => {
  const v = insights.activeSprintView(PLAN, SNAP, TEAM, SPRINT, { today: MID_SPRINT });
  assert.strictEqual(v.burndown.length, 10);
  assert.strictEqual(v.window.workingDays, 10);
  assert.ok(v.burndown[v.burndown.length - 1].ideal === 0);
});

await check('future days have no actual value, so the line stops at today', () => {
  const v = insights.activeSprintView(PLAN, SNAP, TEAM, SPRINT, { today: MID_SPRINT });
  assert.ok(v.burndown.some(b => b.actual === null), 'expected unfilled future days');
  assert.ok(v.burndown[0].actual !== null, 'expected past days filled');
});

/* ── backlog ──────────────────────────────────────────────────────────── */
await check('backlog excludes anything already committed to a sprint', () => {
  const v = insights.backlogView(PLAN, SNAP, { teamId: 'titan' }).teams[0];
  assert.ok(!v.items.some(i => i.key.startsWith('A-')), 'sprint items must not appear in the backlog');
  assert.strictEqual(v.count, 3);
  assert.strictEqual(v.totalPoints, 13);
});

await check('backlog reports how many sprints of work it holds', () => {
  const v = insights.backlogView(PLAN, SNAP, { teamId: 'titan' }).teams[0];
  assert.ok(v.avgVelocity > 0, 'needs velocity from history');
  assert.ok(v.sprintsOfWork != null);
});

await check('unestimated backlog items are counted separately', () => {
  const v = insights.backlogView(PLAN, SNAP, { teamId: 'titan' }).teams[0];
  assert.strictEqual(v.unestimated, 1);
});

/* ── forecast ─────────────────────────────────────────────────────────── */
await check('forecast projects capacity from real availability, per sprint', () => {
  const v = insights.forecastView(PLAN, SNAP, TEAM, { fromSprintId: 'S40', horizon: 2 });
  assert.strictEqual(v.rows.length, 1);           // only S40 remains in the calendar
  assert.strictEqual(v.rows[0].capacityPoints, 53);  // 33 + 61 + 61 hours = 155h / 2.9
});

await check('adding a person to the scenario raises capacity without touching the plan', () => {
  const base = insights.forecastView(PLAN, SNAP, TEAM, { fromSprintId: 'S40', horizon: 1 });
  const scen = insights.forecastView(PLAN, SNAP, TEAM, { fromSprintId: 'S40', horizon: 1, scenario: { addMembers: 1, rampSupportPct: 40 } });
  assert.ok(scen.rows[0].capacityPoints > base.rows[0].capacityPoints);
  assert.strictEqual(PLAN.teams[0].members.length, 4, 'the scenario must not mutate the plan');
});

await check('removing a person lowers capacity', () => {
  const base = insights.forecastView(PLAN, SNAP, TEAM, { fromSprintId: 'S40', horizon: 1 });
  const scen = insights.forecastView(PLAN, SNAP, TEAM, { fromSprintId: 'S40', horizon: 1, scenario: { removeMemberIds: ['m2'] } });
  assert.ok(scen.rows[0].capacityPoints < base.rows[0].capacityPoints);
});

await check('supply vs demand says how long the backlog takes to clear', () => {
  const v = insights.forecastView(PLAN, SNAP, TEAM, { fromSprintId: 'S40', horizon: 2 });
  assert.ok(v.supplyVsDemand.sprintsToClear >= 1);
  assert.ok(typeof v.supplyVsDemand.verdict === 'string' && v.supplyVsDemand.verdict.length);
});

/* ── risks ────────────────────────────────────────────────────────────── */
await check('risk signals cover overload, blocked work and unestimated commitments', () => {
  const v = insights.riskView(PLAN, SNAP, { teamId: 'titan', sprintId: 'S40', today: MID_SPRINT });
  const titles = v.signals.map(s => s.title).join(' | ');
  assert.ok(/loaded to/.test(titles), `missing overload signal: ${titles}`);
  assert.ok(/blocked/i.test(titles), `missing blocked signal: ${titles}`);
  assert.ok(/no estimate/i.test(titles), `missing estimate signal: ${titles}`);
});

await check('every risk signal carries a concrete action', () => {
  const v = insights.riskView(PLAN, SNAP, { teamId: 'titan', sprintId: 'S40', today: MID_SPRINT });
  assert.ok(v.signals.length > 0);
  for (const s of v.signals) assert.ok(s.action && s.action.length > 5, `signal "${s.title}" has no action`);
});

await check('high-severity signals sort to the top', () => {
  const v = insights.riskView(PLAN, SNAP, { teamId: 'titan', sprintId: 'S40', today: MID_SPRINT });
  const order = v.signals.map(s => s.severity);
  const rank = { high: 0, medium: 1, low: 2 };
  assert.deepStrictEqual(order.slice(), order.slice().sort((a, b) => rank[a] - rank[b]));
});

await check('TestOps failures become a stated maintenance forecast, with its basis', () => {
  const snap = { ...SNAP, testops: { projects: [{ id: '1', name: 'iGO', summary: { passRate: 55, failingTests: 40, flakyRate: 12, worstSuites: [] } }] } };
  const p = insights.testopsPressure(snap, TEAM, 40);
  assert.strictEqual(p.predictedPoints, 10);        // 40 failing × 0.25
  assert.match(p.basis, /40 failing tests/);
  const v = insights.riskView(PLAN, snap, { teamId: 'titan', sprintId: 'S40', today: MID_SPRINT });
  assert.ok(v.signals.some(s => /pass rate/i.test(s.title)));
});

await check('bus factor spots a component carried by one person', () => {
  const items = [
    { components: ['R&D_iGO_E2E'], assignee: 'Hien Phan', points: 18 },
    { components: ['R&D_iGO_E2E'], assignee: 'Hien Phan', points: 6 },
    { components: ['R&D_iGO_E2E'], assignee: 'Anh Truong', points: 2 },
  ];
  const out = insights.busFactor(items);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].owner, 'Hien Phan');
  assert.ok(out[0].share >= 80);
});

/* ── store ────────────────────────────────────────────────────────────── */
await check('plan writes are atomic and survive a reread', () => {
  store.savePlan(JSON.parse(JSON.stringify(PLAN)));
  const back = store.getPlan();
  assert.strictEqual(back.teams[0].members.length, 4);
  assert.ok(back.updatedAt);
});

await check('a backup is kept on every write, so a bad save is recoverable', () => {
  store.savePlan({ ...store.getPlan(), holidays: ['2026-12-25'] });
  store.savePlan({ ...store.getPlan(), holidays: [] });
  assert.ok(fs.existsSync(path.join(SCRATCH, 'store', 'plan.json.bak1')));
});

await check('a corrupt plan file falls back to the backup instead of dying', () => {
  const file = path.join(SCRATCH, 'store', 'plan.json');
  fs.writeFileSync(file, '{ this is not json');
  const back = store.getPlan();
  assert.ok(Array.isArray(back.teams), 'expected the backup to be used');
});

/* ── sync integrity, against a fake Jira ──────────────────────────────── */
const fakeJira = (state) => {
  const { Jira } = require('../lib/jira');
  return class extends Jira {
    constructor() { super({ baseUrl: 'https://fake.local', email: 'a@b.c', apiToken: 'x', projectKey: 'T' }); }
    async discoverFields() { return { storyPointsField: 'customfield_1', sprintField: 'customfield_2' }; }
    async search(jql) {
      state.queries.push(jql);
      const since = /updated >= "([^"]+)"/.exec(jql);
      let rows = state.issues.slice();
      if (/sprint IS NOT EMPTY/.test(jql)) rows = rows.filter(i => i.sprintNames.length);
      if (/sprint IS EMPTY/.test(jql)) rows = rows.filter(i => !i.sprintNames.length);
      if (/statusCategory != Done/.test(jql)) rows = rows.filter(i => i.statusCategory !== 'done');
      if (/issuetype = Epic/i.test(jql)) rows = rows.filter(i => i.issueType === 'Epic');
      if (/key in/.test(jql)) { const keys = /key in \(([^)]+)\)/.exec(jql)[1].split(','); rows = rows.filter(i => keys.includes(i.key)); }
      if (since) rows = rows.filter(i => new Date(i.updated) >= new Date(since[1].replace(' ', 'T') + ':00Z'));
      return rows.concat(state.duplicate ? [rows[0]].filter(Boolean) : []);   // simulate a repeated page
    }
    async count(jql) { return { value: (await this.search(jql)).length, exact: true }; }
    async boards() { return []; }
  };
};

await check('a full sync stores every issue and verifies the count against Jira', async () => {
  const state = { issues: Object.values(SNAP.issues), queries: [] };
  const mod = require('../lib/jira');
  const real = mod.Jira; mod.Jira = fakeJira(state);
  try {
    const r = await sync.fullSync({ jira: { projectKey: 'T', baseUrl: 'https://fake.local', email: 'a@b.c', apiToken: 'x' } });
    assert.strictEqual(r.issues, Object.keys(SNAP.issues).length);
    assert.ok(r.allVerified, 'every dataset should verify');
  } finally { mod.Jira = real; }
});

await check('duplicate pages are deduped by issue key', async () => {
  const state = { issues: Object.values(SNAP.issues), queries: [], duplicate: true };
  const mod = require('../lib/jira');
  const real = mod.Jira; mod.Jira = fakeJira(state);
  try {
    const r = await sync.fullSync({ jira: { projectKey: 'T', baseUrl: 'https://fake.local', email: 'a@b.c', apiToken: 'x' } });
    assert.strictEqual(r.issues, Object.keys(SNAP.issues).length, 'a repeated page must not inflate the count');
  } finally { mod.Jira = real; }
});

await check('the watermark is the sync START, so edits during a long sync are not lost', async () => {
  const state = { issues: Object.values(SNAP.issues), queries: [] };
  const mod = require('../lib/jira');
  const real = mod.Jira; mod.Jira = fakeJira(state);
  try {
    const before = new Date().toISOString();
    const r = await sync.fullSync({ jira: { projectKey: 'T', baseUrl: 'https://fake.local', email: 'a@b.c', apiToken: 'x' } });
    assert.ok(r.watermark >= before, 'watermark must not precede the start');
    assert.ok(r.watermark <= r.syncedAt, 'watermark must be the START, not the finish');
  } finally { mod.Jira = real; }
});

await check('an incremental sync DROPS an issue that no longer matches any dataset', async () => {
  const issues = Object.values(SNAP.issues).map(i => ({ ...i }));
  const state = { issues, queries: [] };
  const mod = require('../lib/jira');
  const real = mod.Jira; mod.Jira = fakeJira(state);
  try {
    const cfg = { jira: { projectKey: 'T', baseUrl: 'https://fake.local', email: 'a@b.c', apiToken: 'x' } };
    await sync.fullSync(cfg);
    assert.ok(store.getSnapshot().issues['D-1'], 'D-1 should be in the backlog dataset');

    // D-1 gets closed: still "touched", but no longer in any dataset.
    const d1 = issues.find(i => i.key === 'D-1');
    d1.statusCategory = 'done'; d1.status = 'Done';
    d1.updated = new Date(Date.now() + 60000).toISOString();

    await sync.incrementalSync(cfg);
    assert.ok(!store.getSnapshot().issues['D-1'], 'a closed backlog item must be removed, not left to linger');
  } finally { mod.Jira = real; }
});

await check('an incremental sync leaves untouched issues alone', async () => {
  const snap = store.getSnapshot();
  assert.ok(snap.issues['A-1'], 'sprint work should still be there after the incremental run');
});

/* ── board sprints: one bad board must not sink the rest ──────────────────
   Both of these are regressions found against the real AUTOKAT project, where
   a kanban board answered /board/{id}/sprint with a 400. */

/** A fake Jira whose boards mostly work — board 2356 is kanban and 400s. */
const boardJira = (state) => {
  const { Jira } = require('../lib/jira');
  return class extends Jira {
    constructor() { super({ baseUrl: 'https://fake.local', email: 'a@b.c', apiToken: 'x', projectKey: 'T' }); }
    async discoverFields() { return { storyPointsField: 'customfield_1', sprintField: 'customfield_2' }; }
    async search() { return []; }
    async count() { return { value: 0, exact: true }; }
    async boards() { return [{ id: '2092', name: 'Katalon Auto Titan', type: 'scrum' }, { id: '2356', name: 'Support', type: 'kanban' }]; }
    async boardBacklog() { return []; }
    async teamFieldValues() { return []; }
    async boardSprints(id) {
      state.asked.push(id);
      if (String(id) === '2356') throw new Error('Jira 400 on /rest/agile/1.0/board/2356/sprint: {"errorMessages":["The board does not support sprints"]}');
      return [{ id: '900', name: 'Sprint 40', state: 'active', startDate: '2026-09-03', endDate: '2026-09-16' }];
    }
  };
};

/** Two teams: one on a good board, one pointed at the kanban board. */
function twoBoardPlan() {
  const plan = store.getPlan();
  plan.teams = [
    { id: 'titan', name: 'Titan', boardId: '2092', members: [] },
    { id: 'support', name: 'Support', boardId: '2356', members: [] },
  ];
  store.savePlan(plan);
}

await check('a board that does not support sprints does not sink the other teams', async () => {
  twoBoardPlan();
  const state = { asked: [] };
  const mod = require('../lib/jira');
  const real = mod.Jira; mod.Jira = boardJira(state);
  try {
    await sync.fullSync({ jira: { projectKey: 'T', baseUrl: 'https://fake.local', email: 'a@b.c', apiToken: 'x' } });
    const snap = store.getSnapshot();
    assert.ok(snap.boardSprintsByTeam.titan && snap.boardSprintsByTeam.titan.length,
      'the good board\'s sprints must survive a sibling board 400');
    assert.deepStrictEqual(snap.boardSprintsByTeam.support, [], 'the failing board gets an empty list, not a missing key');
  } finally { mod.Jira = real; }
});

await check('a kanban board is reported as a mapping problem, naming the team', async () => {
  twoBoardPlan();
  const state = { asked: [] };
  const mod = require('../lib/jira');
  const real = mod.Jira; mod.Jira = boardJira(state);
  try {
    await sync.fullSync({ jira: { projectKey: 'T', baseUrl: 'https://fake.local', email: 'a@b.c', apiToken: 'x' } });
    const errs = store.getSnapshot().boardSprintErrors || [];
    const e = errs.find(x => x.team === 'Support');
    assert.ok(e, 'the failing team must be named');
    assert.strictEqual(e.kind, 'kanban', 'a 400 "does not support sprints" is a mapping problem, not a sync failure');
    assert.ok(!errs.some(x => x.team === 'Titan'), 'a working team must not be listed as an error');
  } finally { mod.Jira = real; }
});

await check('a team with no board mapped is never handed another team\'s board', async () => {
  const plan = store.getPlan();
  plan.teams = [
    { id: 'titan', name: 'Titan', boardId: '2092', members: [] },
    { id: 'orphan', name: 'Orphan', boardId: null, members: [] },
  ];
  store.savePlan(plan);
  const state = { asked: [] };
  const mod = require('../lib/jira');
  const real = mod.Jira; mod.Jira = boardJira(state);
  try {
    await sync.fullSync({ jira: { projectKey: 'T', baseUrl: 'https://fake.local', email: 'a@b.c', apiToken: 'x' } });
    const snap = store.getSnapshot();
    assert.ok(!snap.boardSprintsByTeam.orphan, 'an unmapped team must get no sprints at all');
    const e = (snap.boardSprintErrors || []).find(x => x.team === 'Orphan');
    assert.ok(e && e.kind === 'unmapped', 'and must be told it has no board, rather than silently borrowing one');
  } finally { mod.Jira = real; }
});

await check('an incremental sync survives the same bad board', async () => {
  twoBoardPlan();
  const state = { asked: [] };
  const mod = require('../lib/jira');
  const real = mod.Jira; mod.Jira = boardJira(state);
  try {
    const cfg = { jira: { projectKey: 'T', baseUrl: 'https://fake.local', email: 'a@b.c', apiToken: 'x' } };
    await sync.fullSync(cfg);
    await sync.incrementalSync(cfg);
    const snap = store.getSnapshot();
    assert.ok(snap.boardSprintsByTeam.titan && snap.boardSprintsByTeam.titan.length,
      'the incremental path lost every team\'s sprints when one board 400d');
  } finally { mod.Jira = real; }
});

await check('AN ITEM THAT LEAVES THE BACKLOG FOR A SPRINT STOPS BEING TAGGED backlog', async () => {
  // Found on his real data: 78 issues were tagged BOTH `sprintWork` and
  // `backlog`, whose JQLs are `sprint IS NOT EMPTY` and `sprint IS EMPTY` —
  // a pairing that cannot be true. Every one had moved into a sprint, and the
  // incremental sync had added the new tag while keeping the old one.
  const state = { issues: JSON.parse(JSON.stringify(Object.values(SNAP.issues))), queries: [] };
  const mod = require('../lib/jira');
  const real = mod.Jira; mod.Jira = fakeJira(state);
  try {
    const cfg = { jira: { projectKey: 'T', baseUrl: 'https://fake.local', email: 'a@b.c', apiToken: 'x' } };

    // Start with an item in the backlog: no sprint, not done.
    const item = state.issues.find(i => !i.sprintNames.length && i.statusCategory !== 'done');
    assert.ok(item, 'fixture needs a backlog item');
    await sync.fullSync(cfg);
    store.invalidate();
    assert.ok((store.getSnapshot().issues[item.key].datasets || []).includes('backlog'),
      'setting the scene: it starts life tagged backlog');

    // It gets pulled into a sprint, and is therefore touched.
    item.sprintNames = ['Sprint 40'];
    item.sprints = [{ id: '940', name: 'Sprint 40', state: 'active' }];
    item.updated = new Date(Date.now() + 60000).toISOString();

    await sync.incrementalSync(cfg);
    store.invalidate();
    const after = store.getSnapshot().issues[item.key].datasets || [];
    assert.ok(after.includes('sprintWork'), 'it is in a sprint now');
    assert.ok(!after.includes('backlog'),
      `a tag that has stopped being true must be dropped, not kept: ${JSON.stringify(after)}`);
  } finally { mod.Jira = real; }
});

await check('a sync PERSISTS the per-team index, it does not just compute it', async () => {
  const state = { issues: Object.values(SNAP.issues), queries: [] };
  const mod = require('../lib/jira');
  const real = mod.Jira; mod.Jira = fakeJira(state);
  try {
    const cfg = { jira: { projectKey: 'T', baseUrl: 'https://fake.local', email: 'a@b.c', apiToken: 'x' } };
    await sync.fullSync(cfg);
    // Re-read from STORAGE, past the cache. Holding the index in memory is
    // exactly the bug: every team-scoped screen then reads a snapshot with no
    // byTeam at all. `store.invalidate()` drops the cached projection, so what
    // comes back is rebuilt from the database rather than handed back from the
    // object the sync just saved.
    store.invalidate();
    const stored = store.getSnapshot();
    assert.ok(stored.byTeam, 'the index must be persisted, not just computed');
    assert.ok(Object.keys(stored.byTeam).length, 'and must cover at least one team');

    await sync.incrementalSync(cfg);
    store.invalidate();
    const after = store.getSnapshot();
    assert.ok(after.byTeam && Object.keys(after.byTeam).length, 'an incremental sync must not drop the index either');
  } finally { mod.Jira = real; }
});

/* ── story points: null is not zero ───────────────────────────────────────
   Found against the real AUTOKAT project, where all 7,140 issues came back
   estimated at 0 because the name-matched custom field was empty. */

await check('an issue with no story points is UNESTIMATED, not estimated at zero', () => {
  const { Jira } = require('../lib/jira');
  const j = new Jira({ baseUrl: 'https://fake.local', email: 'a@b.c', apiToken: 'x', projectKey: 'T' });
  j.storyPointsField = 'customfield_1';
  const none = j.normalise({ key: 'X-1', fields: { summary: 's', customfield_1: null } });
  assert.strictEqual(none.points, null, 'Number(null) is 0 — that must not become an estimate');
  const empty = j.normalise({ key: 'X-2', fields: { summary: 's', customfield_1: '' } });
  assert.strictEqual(empty.points, null, 'Number("") is 0 too');
  const absent = j.normalise({ key: 'X-3', fields: { summary: 's' } });
  assert.strictEqual(absent.points, null);
});

await check('a real zero estimate is kept as zero', () => {
  const { Jira } = require('../lib/jira');
  const j = new Jira({ baseUrl: 'https://fake.local', email: 'a@b.c', apiToken: 'x', projectKey: 'T' });
  j.storyPointsField = 'customfield_1';
  assert.strictEqual(j.normalise({ key: 'X-4', fields: { customfield_1: 0 } }).points, 0);
  assert.strictEqual(j.normalise({ key: 'X-5', fields: { customfield_1: 5 } }).points, 5);
});

await check('the story-points field is chosen by which one Jira says is populated', async () => {
  const { Jira } = require('../lib/jira');
  class Probe extends Jira {
    constructor() { super({ baseUrl: 'https://fake.local', email: 'a@b.c', apiToken: 'x', projectKey: 'T' }); }
    async request() { return [
      { id: 'customfield_16012', name: 'Story Points' },      // the legacy one, empty
      { id: 'customfield_10016', name: 'Story point estimate' }, // the one in use
    ]; }
    async count(jql) { return { value: /customfield_10016/.test(jql) ? 6900 : 0, exact: true }; }
  }
  const j = new Probe();
  const f = await j.discoverFields();
  assert.strictEqual(f.storyPointsField, 'customfield_16012', 'name matching alone picks the first');
  const cal = await j.calibrateStoryPointsField('T');
  assert.strictEqual(cal.field, 'customfield_10016', 'the populated field must win over the name match');
  assert.strictEqual(j.storyPointsField, 'customfield_10016');
});

await check('a configured story-points field is never second-guessed', async () => {
  const { Jira } = require('../lib/jira');
  const j = new Jira({ baseUrl: 'https://fake.local', email: 'a@b.c', apiToken: 'x', projectKey: 'T' });
  j.storyPointsCandidates = ['a', 'b'];
  j.storyPointsField = 'a';
  const cal = await j.calibrateStoryPointsField('T', { configured: 'customfield_999' });
  assert.strictEqual(cal.reason, 'configured');
  assert.strictEqual(cal.field, 'customfield_999');
});

await check('a project where every issue reads as zero points is flagged, not believed', () => {
  const zeros = {};
  for (let n = 1; n <= 20; n++) zeros[`Z-${n}`] = { key: `Z-${n}`, points: 0, sprintNames: [] };
  const health = sync.summary({ issues: zeros, fields: { storyPointsField: 'customfield_16012' } }).estimation;
  assert.strictEqual(health.fieldLooksWrong, true, 'an entire project estimated at zero is a wrong field, not a fact');
  assert.strictEqual(health.field, 'customfield_16012', 'and the suspect field must be named');

  const real = { ...zeros, 'Z-21': { key: 'Z-21', points: 5, sprintNames: [] } };
  assert.strictEqual(sync.summary({ issues: real, fields: {} }).estimation.fieldLooksWrong, false,
    'one real estimate is enough to show the field works');
});

/* ── sprint length: not every team runs a fortnight ───────────────────────
   The TrueTest boards (Malphite, Katalon Automation) run WEEKLY sprints. A
   hardcoded 14-day grid put seven days of the NEXT sprint into this one's
   capacity, so every availability cell past day 7 was for a sprint that had not
   started. */

check('a weekly sprint gets seven days, not a fortnight', () => {
  const days = insights.sprintDays({ start: '2026-08-31', end: '2026-09-06' });
  assert.strictEqual(days.length, 7, 'the length comes from the sprint\'s own dates');
  assert.strictEqual(days[0], '2026-08-31');
  assert.strictEqual(days[6], '2026-09-06');
});

check('a fortnightly sprint still gets fourteen', () => {
  const days = insights.sprintDays({ start: '2026-09-03', end: '2026-09-16' });
  assert.strictEqual(days.length, 14);
  assert.strictEqual(days[13], '2026-09-16');
});

check('with no end date it falls back to a fortnight rather than guessing wildly', () => {
  assert.strictEqual(insights.sprintDays({ start: '2026-09-03' }).length, 14);
});

check('a nonsense date range is clamped instead of building a year of cells', () => {
  const days = insights.sprintDays({ start: '2026-01-01', end: '2026-12-31' });
  assert.ok(days.length <= 31, `a sprint is not a year — got ${days.length} days`);
});

check('availability defaults follow the real sprint length', () => {
  const week = insights.defaultAvailability({ start: '2026-08-31', end: '2026-09-06' }, []);
  assert.strictEqual(week.length, 7);
  assert.strictEqual(week[5], 'WO', 'Saturday 5 Sep is a weekend');
  assert.strictEqual(week[6], 'WO', 'Sunday 6 Sep too');
});

/* ── a fortnight is TEN working days, whichever way the timestamp fell ────
   Jira's endDate is a timestamp and `.slice(0, 10)` lands on either the last
   day of the sprint or the first day of the next one, depending on the time of
   day and the board's timezone. In the real store that split the boards clean
   down the middle: 66 sprints came out Thu → Thu (15 cells, 11 working days)
   and 51 came out Thu → Wed (14 cells, 10). Same cadence, same fortnight, one
   day of difference in a timestamp — and that day became a whole extra day of
   capacity on half the boards. */

check('A FORTNIGHT IS TEN WORKING DAYS, even when Jira ends it on the next sprint\'s first day', () => {
  // Titan Sprint 33 exactly as the store holds it: Thu → Thu, 15 calendar days.
  const days = insights.sprintDays({ start: '2026-06-11', end: '2026-06-25' });
  assert.strictEqual(days.length, 14, `the grid is a fortnight, not ${days.length} days`);
  assert.strictEqual(days[0], '2026-06-11');
  assert.strictEqual(days[13], '2026-06-24', 'the last cell is the day before the next sprint starts');

  const working = days.filter(d => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()));
  assert.strictEqual(working.length, 10, `ten working days, got ${working.length}`);
});

check('and the board that ends it on Wednesday counts the SAME ten', () => {
  // Ruby Sprint 33: the same fortnight, one day shorter in Jira.
  const ruby = insights.sprintDays({ start: '2026-06-11', end: '2026-06-24' });
  const titan = insights.sprintDays({ start: '2026-06-11', end: '2026-06-25' });
  assert.deepStrictEqual(ruby, titan, 'two boards on the same cadence get the same grid');
});

check('a weekly sprint is still five working days, not rounded up to a fortnight', () => {
  // "TT Week 18May-24May" as stored: Mon → Mon, 8 calendar days.
  const days = insights.sprintDays({ start: '2026-05-18', end: '2026-05-25' });
  assert.strictEqual(days.length, 7, 'a week snaps to a week, never to a fortnight');
  const working = days.filter(d => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()));
  assert.strictEqual(working.length, 5);
});

check('a span that is NOT near a whole week is left exactly as measured', () => {
  // 11 calendar days is 4 off a week and 3 off a fortnight: nobody meant this,
  // so it stays visible rather than being quietly rewritten into a fortnight.
  assert.strictEqual(insights.snapToWeeks(11), 11);
  assert.strictEqual(insights.snapToWeeks(4), 4);
  // ...while the timestamp wobble either side of a real cadence is absorbed.
  for (const n of [12, 13, 14, 15, 16]) assert.strictEqual(insights.snapToWeeks(n), 14, `${n} → 14`);
  for (const n of [5, 6, 7, 8, 9]) assert.strictEqual(insights.snapToWeeks(n), 7, `${n} → 7`);
  for (const n of [19, 20, 21, 22, 23]) assert.strictEqual(insights.snapToWeeks(n), 21, `${n} → 21`);
});

check('a row saved against the OLD longer grid does not smuggle an eleventh day back in', () => {
  const sprint = { start: '2026-06-11', end: '2026-06-25' };
  // What was on disk before the snap: fifteen cells, every working day a full day.
  const stale = ['1', '1', 'WO', 'WO', '1', '1', '1', '1', '1', 'WO', 'WO', '1', '1', '1', '1'];
  const fitted = insights.fitRow(stale, sprint, []);
  assert.strictEqual(fitted.length, 14, 'the row is cut to the grid');
  assert.strictEqual(capacity.availableDays(fitted), 10, `summing it gives ten, got ${capacity.availableDays(fitted)}`);
  assert.strictEqual(capacity.availableDays(stale), 11, 'and the unfitted row is exactly the bug being fixed');
});

check('a row saved SHORT takes the default for the days it never had', () => {
  const sprint = { start: '2026-06-11', end: '2026-06-25' };
  const short = ['0.5', '1', 'WO', 'WO', '1'];
  const fitted = insights.fitRow(short, sprint, []);
  assert.strictEqual(fitted.length, 14);
  assert.strictEqual(fitted[0], '0.5', 'what the person actually entered is untouched');
  assert.strictEqual(fitted[13], '1', 'the unentered tail is a normal working day');
  assert.strictEqual(fitted[9], 'WO', 'and its weekends are still weekends');
});

/* ── CSV ──────────────────────────────────────────────────────────────── */
await check('a Jira CSV export maps onto the same shape as the API', () => {
  const text = [
    'Issue key,Summary,Issue Type,Status,Assignee,Sprint,Story Points,Components,Labels',
    'AUTOKAT-1,"Open Help, Screen Groups",Story,Done,Hien Phan,Katalon Titan Sprint 40,3,R&D_iGO_E2E,',
    'AUTOKAT-2,"Tech: framework tidy",Bucket Story,Open,Anh Truong,Katalon Titan Sprint 40,2,KAT_Framework_Optimization,Maintenance',
  ].join('\n');
  const rows = csv.issuesFromJiraCsv(text);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].summary, 'Open Help, Screen Groups');   // quoted comma survives
  assert.strictEqual(rows[0].points, 3);
  assert.deepStrictEqual(rows[0].sprintNames, ['Katalon Titan Sprint 40']);
  assert.strictEqual(rows[0].statusCategory, 'done');
  assert.deepStrictEqual(rows[1].labels, ['Maintenance']);
});

await check('CSV import feeds the same views as a Jira sync', () => {
  store.saveSnapshot({ ...SNAP, issues: {} });
  const rows = csv.issuesFromJiraCsv([
    'Issue key,Summary,Issue Type,Status,Assignee,Sprint,Story Points',
    'X-1,Thing,Story,Open,Hien Phan,Katalon Titan Sprint 40,8',
  ].join('\n'));
  sync.importIssues(rows);
  const v = insights.capacityView(PLAN, store.getSnapshot(), TEAM, SPRINT);
  assert.strictEqual(v.rows.find(r => r.memberId === 'm2').planned, 8);
});

await check('CSV export quotes fields containing commas', () => {
  const out = csv.stringify([{ a: 'x,y', b: 'plain' }]);
  assert.strictEqual(out, 'a,b\n"x,y",plain');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
})();
