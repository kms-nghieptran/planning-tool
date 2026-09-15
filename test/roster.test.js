'use strict';
/**
 * roster.test.js — the per-sprint roster, and the closed-sprint lock.
 *
 * Two guarantees, both of which are about a number being honest:
 *
 *   A TEAM'S SIZE IS A PROPERTY OF THE SPRINT, not of the team. Titan has had
 *   three people since Sprint 38 and four before it. Planning Sprint 39 against
 *   the historic four gives a capacity figure for a team that does not exist,
 *   and every workload percentage measured against it is wrong.
 *
 *   A CLOSED SPRINT DOES NOT MOVE. The delivery report reads closed sprints;
 *   if their inputs can still be edited, last month's velocity changes under a
 *   report someone has already acted on.
 */

const assert = require('node:assert');
const roster = require('../lib/roster');
const lock = require('../lib/lock');
const insights = require('../lib/insights');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
console.log('\nThe per-sprint roster, and the closed-sprint lock\n');

/* ── fixtures: a team of four, a sprint only three of them worked ── */

const TEAM = () => ({
  id: 'titan', name: 'Katalon Titan',
  settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 },
  members: [
    { id: 'm1', name: 'Hien Phan', role: 'QA Lead', status: 'Active', supportPct: 0, jiraAccountId: 'acc-hien' },
    { id: 'm2', name: 'Thao Dang', role: 'Auto QA', status: 'Active', supportPct: 0, jiraAccountId: 'acc-thao' },
    { id: 'm3', name: 'Hy Nguyen', role: 'Auto QA', status: 'Active', supportPct: 0, jiraAccountId: 'acc-hy' },
    { id: 'm4', name: 'Chau Tran', role: 'Auto QA', status: 'Active', supportPct: 0, jiraAccountId: 'acc-chau' },
  ],
});

const issue = (key, accountId, name) => ({
  key, assignee: name, assigneeId: accountId, points: 3,
  status: 'Done', statusCategory: 'done', issueType: 'Story',
});

/** Sprint 38: only three of the four were assigned anything. */
const WORKED = [
  issue('T-1', 'acc-hien', 'Hien Phan'),
  issue('T-2', 'acc-thao', 'Thao Dang'),
  issue('T-3', 'acc-thao', 'Thao Dang'),
  issue('T-4', 'acc-hy', 'Hy Nguyen'),
];

const sprint = (id, state) => ({
  id, number: Number(String(id).replace(/\D/g, '')) || null, name: `Sprint ${id}`,
  start: '2026-08-20', end: '2026-09-02',
  byTeam: state ? { titan: { jiraId: '900', name: `Katalon Titan ${id}`, state } } : {},
});

const PLAN = (over = {}) => ({
  teams: [TEAM()], sprints: [sprint('S38', 'closed'), sprint('S39', 'active'), sprint('S40', 'future')],
  availability: {}, support: {}, ceremony: {}, overrides: {}, holidays: [], sprintRoster: {}, ...over,
});

/* ── the roster differs sprint by sprint ───────────────────────────── */

check('A CLOSED SPRINT\'S ROSTER IS WHO WAS ASSIGNED THE WORK', () => {
  const r = roster.forSprint(PLAN(), TEAM(), sprint('S38', 'closed'), WORKED, 'closed');
  assert.deepStrictEqual(r.members.map(m => m.id).sort(), ['m1', 'm2', 'm3'],
    'Chau was on the team but did nothing in this sprint, so she was not on this sprint');
  assert.strictEqual(r.counts.total, 3,
    'this is the whole point: three people, not the four on the team list');
});

check('the same team, a different closed sprint, a different size', () => {
  const alsoChau = WORKED.concat([issue('T-5', 'acc-chau', 'Chau Tran')]);
  const a = roster.forSprint(PLAN(), TEAM(), sprint('S34', 'closed'), alsoChau, 'closed');
  const b = roster.forSprint(PLAN(), TEAM(), sprint('S38', 'closed'), WORKED, 'closed');
  assert.strictEqual(a.counts.total, 4);
  assert.strictEqual(b.counts.total, 3);
});

check('AN ACTIVE SPRINT ALSO INCLUDES PEOPLE WITH NOTHING ASSIGNED YET', () => {
  // The opposite failure, and just as bad: planning capacity happens BEFORE
  // work is assigned, so the person with a free fortnight is exactly the one
  // you need to see. Deriving an active sprint purely from assignees hides them.
  const r = roster.forSprint(PLAN(), TEAM(), sprint('S39', 'active'), WORKED, 'active');
  assert.deepStrictEqual(r.members.map(m => m.id).sort(), ['m1', 'm2', 'm3', 'm4']);
  assert.strictEqual(r.counts.assigned, 3);
  assert.strictEqual(r.counts.fromTeam, 1, 'and it says which is which');
});

check('a future sprint with no work at all still has a roster to plan with', () => {
  const r = roster.forSprint(PLAN(), TEAM(), sprint('S40', 'future'), [], 'future');
  assert.strictEqual(r.counts.total, 4, 'an empty grid is not a plan');
});

check('someone who did the work but is not on the team list still counts', () => {
  const withGuest = WORKED.concat([issue('T-9', 'acc-guest', 'Visiting Contractor')]);
  const r = roster.forSprint(PLAN(), TEAM(), sprint('S38', 'closed'), withGuest, 'closed');
  const guest = r.members.find(m => m.name === 'Visiting Contractor');
  assert.ok(guest, 'they did the work, so they were on the team that sprint');
  assert.strictEqual(guest.id, 'jira:acc-guest', 'with a stable id, so their leave grid survives');
  assert.ok(guest.notOnTeamList, 'and flagged, so the screen can say why they look different');
});

check('the same person assigned twice appears once', () => {
  const r = roster.forSprint(PLAN(), TEAM(), sprint('S38', 'closed'), WORKED, 'closed');
  assert.strictEqual(r.members.filter(m => m.id === 'm2').length, 1,
    'Thao has two items; counting her twice would double the team');
});

/* ── your decisions survive ────────────────────────────────────────── */

check('ADDING SOMEONE TO A SPRINT SURVIVES, and a sync cannot undo it', () => {
  const plan = PLAN({ sprintRoster: { 'titan|S38': { added: ['m4'], removed: [] } } });
  const r = roster.forSprint(plan, TEAM(), sprint('S38', 'closed'), WORKED, 'closed');
  assert.ok(r.members.some(m => m.id === 'm4'), 'Chau was helping out; that is a decision, not data');
  assert.strictEqual(r.counts.added, 1);
});

check('removing someone holds even though Jira still shows their work', () => {
  const plan = PLAN({ sprintRoster: { 'titan|S38': { added: [], removed: ['m3'] } } });
  const r = roster.forSprint(plan, TEAM(), sprint('S38', 'closed'), WORKED, 'closed');
  assert.ok(!r.members.some(m => m.id === 'm3'));
  assert.strictEqual(r.counts.total, 2);
});

check('A NEW ASSIGNEE STILL APPEARS, even on a sprint you have edited', () => {
  // The reason the overlay stores a difference rather than a roster. If the
  // roster were frozen when he first edited it, this person would never show up.
  const plan = PLAN({ sprintRoster: { 'titan|S38': { added: ['m4'], removed: [] } } });
  const later = WORKED.concat([issue('T-9', 'acc-guest', 'Late Joiner')]);
  const r = roster.forSprint(plan, TEAM(), sprint('S38', 'closed'), later, 'closed');
  assert.ok(r.members.some(m => m.name === 'Late Joiner'),
    'a frozen roster would never show work that arrived after you edited it');
  assert.ok(r.members.some(m => m.id === 'm4'), 'and your edit is still there');
});

check('adding someone you had removed is a retraction, not a contradiction', () => {
  const plan = PLAN({ sprintRoster: { 'titan|S38': { added: ['m3'], removed: ['m3'] } } });
  const r = roster.forSprint(plan, TEAM(), sprint('S38', 'closed'), WORKED, 'closed');
  // `removed` is applied last, deliberately: a person in both lists is a state
  // the API refuses to create, and if one ever appears the safe reading is the
  // more conservative one.
  assert.ok(!r.members.some(m => m.id === 'm3'), 'and the result must not depend on Map ordering');
});

/* ── an exclusion is a decision, and beats the derivation ──────────── */

check('A PERSON YOU REMOVED FROM THE TEAM STAYS OFF, even with work in the sprint', () => {
  // Found against his real data: Titan has 38 people excluded, and without
  // this rule the derived roster put ten of them back on Sprint 44 — eleven
  // people on a three-person team, and a capacity figure to match.
  const withExcluded = WORKED.concat([issue('T-9', 'acc-gone', 'An Thien Nguyen')]);
  const plan = PLAN({ excluded: { titan: ['acc-gone'] } });
  const r = roster.forSprint(plan, TEAM(), sprint('S38', 'closed'), withExcluded, 'closed');
  assert.ok(!r.members.some(m => m.name === 'An Thien Nguyen'),
    'removing someone from a team is a decision; Jira showing their work does not undo it');
  assert.strictEqual(r.counts.total, 3);
});

check('exclusions match by NAME as well as account id', () => {
  const withExcluded = WORKED.concat([issue('T-9', null, 'An Thien Nguyen')]);
  const plan = PLAN({ excluded: { titan: ['An Thien Nguyen'] } });
  const r = roster.forSprint(plan, TEAM(), sprint('S38', 'closed'), withExcluded, 'closed');
  assert.strictEqual(r.counts.total, 3, 'older exclusions were stored by name, and still have to work');
});

check('but adding them to ONE sprint still works — a narrower, later decision', () => {
  const withExcluded = WORKED.concat([issue('T-9', 'acc-gone', 'An Thien Nguyen')]);
  const plan = PLAN({
    excluded: { titan: ['acc-gone'] },
    sprintRoster: { 'titan|S38': { added: ['jira:acc-gone'], removed: [] } },
  });
  const r = roster.forSprint(plan, TEAM(), sprint('S38', 'closed'), withExcluded, 'closed');
  assert.ok(r.members.some(m => m.id === 'jira:acc-gone'),
    '"not on this team" must not become a rule you can never make an exception to');
});

/* ── historical capacity data is part of a closed sprint's roster ──── */

check('ANYONE YOU PLANNED CAPACITY FOR IS ON THE SPRINT, even with no work assigned', () => {
  // Found on his real data: 34 of the 35 leave-grid and support rows he had
  // entered were invisible, because a roster built from assignees alone
  // orphans the row for anyone who ended up with no ticket in their name.
  const plan = PLAN({ availability: { 'titan|S38|m4': ['1', '1', 'WO'] } });
  const r = roster.forSprint(plan, TEAM(), sprint('S38', 'closed'), WORKED, 'closed');
  assert.ok(r.members.some(m => m.id === 'm4'),
    'a leave grid entered for someone is a statement that they were on that sprint');
  assert.strictEqual(r.counts.planned, 1, 'and it says that is why they are here');
});

check('support % alone is enough, and so is an override', () => {
  for (const [bucket, value] of [['support', 25], ['overrides', { planned: 5 }]]) {
    const plan = PLAN({ [bucket]: { 'titan|S38|m4': value } });
    const r = roster.forSprint(plan, TEAM(), sprint('S38', 'closed'), WORKED, 'closed');
    assert.ok(r.members.some(m => m.id === 'm4'), `${bucket} did not bring them onto the sprint`);
  }
});

check('capacity data for ANOTHER sprint does not leak into this one', () => {
  const plan = PLAN({ availability: { 'titan|S39|m4': ['1'] } });
  const r = roster.forSprint(plan, TEAM(), sprint('S38', 'closed'), WORKED, 'closed');
  assert.ok(!r.members.some(m => m.id === 'm4'), 'the whole point is that sprints differ');
});

/* ── ids that changed under him ────────────────────────────────────── */

check('AN OLD MEMBER ID IS REUNITED WITH THE PERSON, not shown as a second one', () => {
  // His leave grid is filed under an older, shorter id scheme: "ruby-thao" for
  // what is now "ruby-thao-dang". Keying the row by the STORED id gave the
  // same human two rows whenever they were also an assignee — Ruby S33 read
  // 8 people and 462 hours instead of 4 and 231. Worse than the bug it fixed.
  const team = { ...TEAM(), members: [{ id: 'titan-thuan-dinh-cong-ngoc', name: 'Thuan', status: 'Active', supportPct: 0, jiraAccountId: 'acc-thuan' }] };
  const worked = [issue('T-1', 'acc-thuan', 'Thuan')];
  const plan = { ...PLAN(), teams: [team], availability: { 'titan|S38|titan-thuan': ['1', '1', '0.5'] } };

  const r = roster.forSprint(plan, team, sprint('S38', 'closed'), worked, 'closed');
  assert.strictEqual(r.members.length, 1, 'one person must not become two');
  assert.strictEqual(r.members[0].id, 'titan-thuan-dinh-cong-ngoc', 'keyed by the person, not by the filing');
  assert.deepStrictEqual(r.members[0].aliasIds, ['titan-thuan'], 'and remembers where the data lives');
  // MERGED, not overwritten. They were assigned work; the old leave grid adds
  // to what is known about them rather than replacing why they are here.
  assert.strictEqual(r.members[0].onSprint, 'assigned',
    'overwriting the assignee row relabels a person who did work as one who merely had a plan');
  assert.strictEqual(r.members[0].name, 'Thuan');
  assert.strictEqual(r.counts.assigned, 1);
  assert.strictEqual(r.counts.planned, 0, 'and they are not counted in both buckets');
});

check('and their real leave grid is what the sprint shows', () => {
  const team = { ...TEAM(), members: [{ id: 'titan-thuan-dinh-cong-ngoc', name: 'Thuan', status: 'Active', supportPct: 0, jiraAccountId: 'acc-thuan' }] };
  const worked = [issue('T-1', 'acc-thuan', 'Thuan')];
  const plan = { ...PLAN(), teams: [team], availability: { 'titan|S38|titan-thuan': ['1', '1', '0.5', 'WO'] } };
  const snap = { issues: Object.fromEntries(worked.map(i => [i.key, i])), byTeam: { titan: { sprintIssues: { 900: worked.map(i => i.key) } } }, people: [] };

  const v = insights.capacityView(plan, snap, team, sprint('S38', 'closed'));
  assert.deepStrictEqual(v.availability['titan-thuan-dinh-cong-ngoc'], ['1', '1', '0.5', 'WO'],
    'the right name with a blank grid looks exactly like "nothing was ever entered"');
});

check('an AMBIGUOUS old id is left alone rather than guessed', () => {
  const team = {
    ...TEAM(),
    members: [
      { id: 'titan-an-nguyen', name: 'An Nguyen', status: 'Active', supportPct: 0 },
      { id: 'titan-an-tran', name: 'An Tran', status: 'Active', supportPct: 0 },
    ],
  };
  const by = new Map(team.members.map(m => [m.id, m]));
  assert.strictEqual(roster.resolveMemberId('titan-an', by), 'titan-an',
    'two candidates means guessing, and the thing being merged is a leave grid nothing can rebuild');
});

check('an old id with no current member stays visible as a historical row', () => {
  const plan = PLAN({ availability: { 'titan|S38|titan-someone-who-left': ['1'] } });
  const r = roster.forSprint(plan, TEAM(), sprint('S38', 'closed'), WORKED, 'closed');
  const gone = r.members.find(m => m.id === 'titan-someone-who-left');
  assert.ok(gone, 'dropping the row would hide capacity he entered');
  assert.strictEqual(gone.name, 'Someone Who Left', 'named from the id rather than shown as one');
  assert.ok(gone.historic);
});

check('resolution never rewrites what is stored', () => {
  const team = { ...TEAM(), members: [{ id: 'titan-thuan-dinh-cong-ngoc', name: 'Thuan', status: 'Active', supportPct: 0 }] };
  const plan = { ...PLAN(), teams: [team], availability: { 'titan|S38|titan-thuan': ['1'] } };
  const before = JSON.stringify(plan.availability);
  roster.forSprint(plan, team, sprint('S38', 'closed'), [], 'closed');
  assert.strictEqual(JSON.stringify(plan.availability), before,
    'a wrong guess must be fixable by changing code, not by restoring a backup');
});

/* ── who can be added ──────────────────────────────────────────────── */

check('the add list comes from Jira, not from a list anyone maintains', () => {
  const snap = { people: [
    { name: 'Hien Phan', accountId: 'acc-hien' },
    { name: 'Brand New Person', accountId: 'acc-new' },
  ] };
  const current = [{ id: 'm1' }];
  const list = roster.candidates(PLAN(), snap, TEAM(), current);
  assert.ok(list.some(c => c.name === 'Brand New Person' && c.from === 'jira'),
    'a new joiner has to appear the first sync after they exist');
  assert.ok(!list.some(c => c.id === 'm1'), 'someone already on the sprint is not offered again');
});

check('a Jira person who IS a team member is offered once, with their real id', () => {
  const snap = { people: [{ name: 'Chau Tran', accountId: 'acc-chau' }] };
  const list = roster.candidates(PLAN(), snap, TEAM(), []);
  const chau = list.filter(c => /Chau/.test(c.name));
  assert.strictEqual(chau.length, 1, 'offering the same person twice under two ids splits their history');
  assert.strictEqual(chau[0].id, 'm4');
});

/* ── the closed-sprint lock ────────────────────────────────────────── */

check('A CLOSED SPRINT IS READ-ONLY', () => {
  assert.strictEqual(lock.status(sprint('S38', 'closed'), 'titan').readOnly, true);
  assert.throws(() => lock.assertWritable(sprint('S38', 'closed'), TEAM()), /closed/);
});

check('active and future sprints are writable', () => {
  assert.strictEqual(lock.status(sprint('S39', 'active'), 'titan').readOnly, false);
  assert.strictEqual(lock.status(sprint('S40', 'future'), 'titan').readOnly, false);
  lock.assertWritable(sprint('S39', 'active'), TEAM());
  lock.assertWritable(sprint('S40', 'future'), TEAM());
});

check('CLOSED IS PER TEAM — a shared sprint can be closed for one and open for another', () => {
  // S39 is one calendar entry that several teams hang their own Jira sprint
  // off. Ruby can have finished it while Malphite is still running it, so
  // "is S39 closed" has no single answer and must never be asked.
  const shared = {
    id: 'S39', name: 'Sprint 39',
    byTeam: { titan: { state: 'closed' }, malphite: { state: 'active' } },
  };
  assert.strictEqual(lock.isClosed(shared, 'titan'), true);
  assert.strictEqual(lock.isClosed(shared, 'malphite'), false);
});

check('a sprint with no Jira mapping is yours to plan', () => {
  const mine = { id: 'S41', name: 'Sprint 41', byTeam: {} };
  assert.strictEqual(lock.isClosed(mine, 'titan'), false);
  assert.strictEqual(lock.status(mine, 'titan').state, 'unmapped');
});

check('the refusal says 409, not 500 — it is a decision, not a fault', () => {
  try {
    lock.assertWritable(sprint('S38', 'closed'), TEAM(), 'the leave grid');
    assert.fail('should have thrown');
  } catch (e) {
    assert.strictEqual(e.status, 409);
    assert.strictEqual(e.code, 'SPRINT_CLOSED');
    assert.match(e.message, /leave grid/, 'and names what was refused');
    assert.match(e.message, /Katalon Titan/, 'and for which team');
  }
});

/* ── the whole view agrees ─────────────────────────────────────────── */

const SNAP = (issues) => ({
  issues: Object.fromEntries(issues.map(i => [i.key, i])),
  byTeam: { titan: { sprintIssues: { 900: issues.map(i => i.key) } } },
  people: [],
});

check('THE CAPACITY GRID USES THE SPRINT ROSTER, not the team list', () => {
  const v = insights.capacityView(PLAN(), SNAP(WORKED), TEAM(), sprint('S38', 'closed'));
  assert.strictEqual(v.rows.length, 3, 'the grid is the roster, or the two disagree');
  assert.strictEqual(v.totals.headcount, 3);
  assert.strictEqual(v.roster.counts.assigned, 3);
});

check('the capacity view carries the lock, so the screen never decides for itself', () => {
  const closed = insights.capacityView(PLAN(), SNAP(WORKED), TEAM(), sprint('S38', 'closed'));
  const open = insights.capacityView(PLAN(), SNAP(WORKED), TEAM(), sprint('S39', 'active'));
  assert.strictEqual(closed.lock.readOnly, true);
  assert.ok(closed.lock.reason, 'and says why, in words a person reads');
  assert.strictEqual(open.lock.readOnly, false);
});

check('capacity hours fall when the roster is smaller', () => {
  // The number that actually matters. Four people's capacity planned against a
  // three-person sprint is the bug this whole change exists to remove.
  const three = insights.capacityView(PLAN(), SNAP(WORKED), TEAM(), sprint('S38', 'closed'));
  const four = insights.capacityView(PLAN(), SNAP(WORKED), TEAM(), sprint('S39', 'active'));
  assert.ok(three.totals.capacityHours < four.totals.capacityHours,
    `three people must not have four people's capacity (${three.totals.capacityHours} vs ${four.totals.capacityHours})`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
