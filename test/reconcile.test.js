'use strict';
/**
 * reconcile.test.js — Jira as the source of truth for sprints and rosters.
 *
 * The two guarantees worth protecting here are the destructive ones: reconcile
 * must never delete a sprint and must never add a person to a roster on its own.
 * Both are mutation-tested — remove the guard and a check below goes red.
 *
 * Run: node test/reconcile.test.js
 */

const assert = require('node:assert');
const r = require('../lib/reconcile');
const insights = require('../lib/insights');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

const team = (id, name, keyword) => ({
  id, name, sprintKeywords: [keyword], jiraTeams: [`Katalon Auto ${name.split(' ')[1]}`],
  settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 },
  members: [
    { id: `${id}-a`, name: 'Thao Dang', role: 'QA Lead', status: 'Active', supportPct: 0 },
    { id: `${id}-b`, name: 'Hy Nguyen', role: 'Auto QA', status: 'Active', supportPct: 0 },
  ],
});

const basePlan = () => ({
  version: 1,
  teams: [team('ruby', 'Katalon Ruby', 'ruby'), team('titan', 'Katalon Titan', 'titan')],
  sprints: [
    { id: 'S39', number: 39, name: 'Sprint 39', start: '2026-09-03', end: '2026-09-16', source: 'seed' },
    { id: 'S40', number: 40, name: 'Sprint 40', start: '2026-09-17', end: '2026-09-30', source: 'seed' },
  ],
  availability: {}, support: {}, ceremony: {}, overrides: {}, risks: [], notes: {}, holidays: [],
});

const snapshot = (over = {}) => ({
  boards: [
    { id: '10', name: 'AUTOKAT Ruby board', type: 'scrum' },
    { id: '11', name: 'AUTOKAT Titan board', type: 'scrum' },
  ],
  boardSprintsByTeam: {
    ruby: [
      { id: '501', name: 'Katalon Ruby Sprint 39', state: 'closed', start: '2026-09-03', end: '2026-09-16' },
      { id: '502', name: 'Katalon Ruby Sprint 40', state: 'active', start: '2026-09-17', end: '2026-09-30' },
      { id: '503', name: 'Katalon Ruby Sprint 41', state: 'future', start: '2026-10-01', end: '2026-10-14' },
    ],
    titan: [
      // deliberately NOT aligned with Ruby — Titan started a day late
      { id: '601', name: 'Katalon Titan Sprint 40', state: 'active', start: '2026-09-18', end: '2026-10-01' },
    ],
  },
  issues: {},
  ...over,
});

console.log('\nJira → plan reconciliation\n');

/* ── boards ───────────────────────────────────────────────────────────── */

check('a board is auto-mapped to the team whose keyword appears in its name', () => {
  const plan = basePlan();
  const assigned = r.autoAssignBoards(plan, snapshot().boards);
  assert.strictEqual(plan.teams.find(t => t.id === 'ruby').boardId, '10');
  assert.strictEqual(plan.teams.find(t => t.id === 'titan').boardId, '11');
  assert.strictEqual(assigned.length, 2);
});

check('an existing board mapping is never overwritten by the guess', () => {
  const plan = basePlan();
  plan.teams[0].boardId = '99';
  r.autoAssignBoards(plan, snapshot().boards);
  assert.strictEqual(plan.teams[0].boardId, '99');
});

/* ── sprints ──────────────────────────────────────────────────────────── */

check('a Jira sprint the calendar does not have is added', () => {
  const plan = basePlan();
  const rep = r.reconcileSprints(plan, snapshot());
  assert.ok(plan.sprints.some(s => s.number === 41), 'Sprint 41 should have been added');
  assert.strictEqual(rep.added.length, 1);
});

check("each team's own Jira id, dates and state are stored separately", () => {
  const plan = basePlan();
  r.reconcileSprints(plan, snapshot());
  const s40 = plan.sprints.find(s => s.number === 40);
  assert.strictEqual(s40.byTeam.ruby.jiraId, '502');
  assert.strictEqual(s40.byTeam.titan.jiraId, '601');
  assert.strictEqual(s40.byTeam.ruby.start, '2026-09-17');
  assert.strictEqual(s40.byTeam.titan.start, '2026-09-18');   // genuinely different
});

check('forTeam returns that team\'s dates, not the shared fallback', () => {
  const plan = basePlan();
  r.reconcileSprints(plan, snapshot());
  const s40 = plan.sprints.find(s => s.number === 40);
  assert.strictEqual(r.forTeam(s40, 'titan').start, '2026-09-18');
  assert.strictEqual(r.forTeam(s40, 'ruby').start, '2026-09-17');
  assert.strictEqual(r.forTeam(s40, 'unknown-team').start, s40.start);
});

check('a seeded date guess is replaced by Jira\'s real dates', () => {
  const plan = basePlan();
  plan.sprints[1].start = '2026-09-15';            // a wrong guess
  plan.sprints[1].end = '2026-09-28';
  r.reconcileSprints(plan, snapshot());
  const s40 = plan.sprints.find(s => s.number === 40);
  assert.strictEqual(s40.start, '2026-09-17');
  assert.strictEqual(s40.source, 'jira');
});

check('RECONCILE NEVER DELETES: a sprint Jira stopped listing survives', () => {
  const plan = basePlan();
  plan.sprints.push({ id: 'S99', number: 99, name: 'Sprint 99', start: '2027-01-01', end: '2027-01-14', source: 'manual' });
  r.reconcileSprints(plan, snapshot());
  assert.ok(plan.sprints.some(s => s.number === 99), 'a board reconfigured for an afternoon must not wipe the calendar');
  assert.strictEqual(plan.sprints.find(s => s.number === 99).source, 'manual');
});

check('running reconcile twice changes nothing the second time', () => {
  const plan = basePlan();
  r.reconcileSprints(plan, snapshot());
  const first = JSON.stringify(plan.sprints.map(s => ({ ...s, byTeam: Object.fromEntries(Object.entries(s.byTeam || {}).map(([k, v]) => [k, { ...v, syncedAt: null }])) })));
  const rep = r.reconcileSprints(plan, snapshot());
  const second = JSON.stringify(plan.sprints.map(s => ({ ...s, byTeam: Object.fromEntries(Object.entries(s.byTeam || {}).map(([k, v]) => [k, { ...v, syncedAt: null }])) })));
  assert.strictEqual(first, second, 'reconcile must be idempotent');
  assert.strictEqual(rep.added.length, 0);
});

/* ── date-named sprints: the TrueTest boards ──────────────────────────────
   Found on Katalon Auto Malphite, where Jira returned 11 sprints and 10 were
   thrown away for not ending in a digit. A team that runs weekly windows named
   "TT Week 31Aug" looked like a team that had never run a sprint. */

check('A SPRINT WITH NO NUMBER IS KEPT — a naming convention is not our business', () => {
  const plan = basePlan();
  const snap = snapshot();
  snap.boardSprintsByTeam.ruby.push({ id: '777', name: 'TT Week 31Aug', state: 'active', start: '2026-08-31', end: '2026-09-06' });
  const rep = r.reconcileSprints(plan, snap);
  assert.strictEqual(rep.dated.length, 1, 'it should be reported as dated');
  assert.strictEqual(rep.dated[0].name, 'TT Week 31Aug');
  const kept = plan.sprints.find(s => (s.byTeam.ruby || {}).jiraId === '777');
  assert.ok(kept, 'and it must be in the calendar, not discarded');
  assert.strictEqual(kept.number, null, 'with no invented number');
  assert.strictEqual(kept.name, 'TT Week 31Aug', 'and its real Jira name');
});

check('a whole board of date-named sprints survives intact', () => {
  const plan = basePlan();
  const snap = snapshot();
  // Malphite's real shape: one stray numbered sprint plus ten weekly windows.
  snap.boardSprintsByTeam.ruby = [
    { id: '15073', name: 'Katalon Titan Sprint 30', state: 'closed', start: '2026-04-01', end: '2026-04-14' },
    ...['18May', '25May', '08Jun', '22Jun', '06Jul', '20Jul', '03Aug', '17Aug', '31Aug', '14Sep']
      .map((w, n) => ({ id: String(16178 + n), name: `TT Week ${w}`, state: n === 8 ? 'active' : n === 9 ? 'future' : 'closed',
        start: `2026-0${n < 4 ? 5 + Math.floor(n / 2) : 7 + Math.floor((n - 4) / 3)}-0${(n % 3) + 1}`, end: null })),
  ];
  const rep = r.reconcileSprints(plan, snap);
  const mine = plan.sprints.filter(s => s.byTeam && s.byTeam.ruby);
  assert.strictEqual(mine.length, 11, 'all 11 of Jira\'s sprints must land, not just the one that ends in a digit');
  assert.strictEqual(rep.teams.ruby.sprints, 11);
  assert.strictEqual(rep.teams.ruby.dated, 10);
});

check('a dated sprint is its own entry, never merged onto a number', () => {
  const plan = basePlan();
  const snap = snapshot();
  snap.boardSprintsByTeam.ruby.push({ id: '801', name: 'TT Week 06Jul', state: 'closed', start: '2026-07-06', end: '2026-07-12' });
  snap.boardSprintsByTeam.ruby.push({ id: '802', name: 'TT Week 20Jul', state: 'closed', start: '2026-07-20', end: '2026-07-26' });
  r.reconcileSprints(plan, snap);
  const ids = plan.sprints.filter(s => s.number == null).map(s => s.id);
  assert.strictEqual(new Set(ids).size, 2, 'two different weeks must not collapse into one entry');
  assert.ok(ids.every(id => id.startsWith('J')), 'a dated sprint is identified by its Jira sprint id');
});

check('numbered sprints still share one calendar entry across teams', () => {
  const plan = basePlan();
  const snap = snapshot();
  const rep = r.reconcileSprints(plan, snap);
  const s40 = plan.sprints.find(s => s.number === 40);
  assert.ok(s40.byTeam.ruby && s40.byTeam.titan, 'the shared fortnight must keep working');
  assert.notStrictEqual(s40.byTeam.ruby.jiraId, s40.byTeam.titan.jiraId, 'each team keeps its own Jira sprint');
  assert.ok(rep.added.length >= 1);
});

check('sprints order by when they ran, not by the digits in their name', () => {
  const a = { id: 'S40', number: 40, start: '2026-09-17' };
  const b = { id: 'J18498', number: null, start: '2026-08-31' };
  const c = { id: 'S39', number: 39, start: '2026-09-03' };
  const sorted = [a, b, c].sort(r.compareSprints).map(s => s.id);
  assert.deepStrictEqual(sorted, ['J18498', 'S39', 'S40'],
    'a date-named sprint must sort into the timeline, not to one end of it');
});

check('sprints with no dates at all still order by number', () => {
  const sorted = [{ id: 'S41', number: 41 }, { id: 'S39', number: 39 }, { id: 'S40', number: 40 }]
    .sort(r.compareSprints).map(s => s.number);
  assert.deepStrictEqual(sorted, [39, 40, 41], 'a locally seeded calendar has no dates yet');
});

check('every dated sprint keeps its OWN calendar id', () => {
  const plan = basePlan();
  const snap = snapshot();
  snap.boardSprintsByTeam.ruby.push({ id: '901', name: 'TT Week 17Aug', state: 'closed', start: '2026-08-17', end: '2026-08-30' });
  snap.boardSprintsByTeam.ruby.push({ id: '902', name: 'TT Week 31Aug', state: 'active', start: '2026-08-31', end: '2026-09-13' });
  r.reconcileSprints(plan, snap);
  const idx = r.buildTeamIndex(plan, snap);
  const rows = idx.ruby.sprints.filter(s => s.number == null);
  assert.strictEqual(rows.length, 2);
  // The server matches an index row back to its calendar entry. Matching on
  // `number` made null === null true for every dated sprint, collapsing them all
  // onto one id so the active sprint could never be found again.
  assert.strictEqual(new Set(rows.map(s => s.sprintId)).size, 2,
    'two dated sprints must not share a calendar id');
  const active = idx.ruby.sprints.find(s => s.state === 'active' && s.jiraId === '902');
  assert.ok(active && active.sprintId === 'J902', 'the active dated sprint must be addressable by its own id');
});

check('each dated sprint reports its OWN item count, not the last one\'s', () => {
  const plan = basePlan();
  plan.sprints = [];
  const snap = snapshot();
  snap.boardSprintsByTeam = {
    ruby: [
      { id: '801', name: 'TT Week 17Aug', state: 'closed', start: '2026-08-17', end: '2026-08-30' },
      { id: '802', name: 'TT Week 31Aug', state: 'active', start: '2026-08-31', end: '2026-09-13' },
    ],
  };
  snap.issues = {
    'A-1': { key: 'A-1', points: 3, sprints: [{ id: '801', name: 'TT Week 17Aug' }] },
    'A-2': { key: 'A-2', points: 5, sprints: [{ id: '801', name: 'TT Week 17Aug' }] },
    'B-1': { key: 'B-1', points: 8, sprints: [{ id: '802', name: 'TT Week 31Aug' }] },
  };
  r.reconcileSprints(plan, snap);
  const idx = r.buildTeamIndex(plan, snap);
  const rows = Object.fromEntries(idx.ruby.sprints.map(s => [s.name, s]));
  assert.strictEqual(rows['TT Week 17Aug'].count, 2);
  assert.strictEqual(rows['TT Week 31Aug'].count, 1, 'a shared null key made every dated sprint report the same count');
  // Each row must be addressable by a DISTINCT calendar id — that is what the
  // API joins on when it puts these counts on screen.
  assert.strictEqual(new Set(idx.ruby.sprints.map(s => s.sprintId)).size, 2);
});

check('the active sprint is found on a board with no numbered sprints at all', () => {
  const plan = basePlan();
  plan.sprints = [];
  const snap = snapshot();
  snap.boardSprintsByTeam = {
    ruby: [
      { id: '801', name: 'TT Week 17Aug', state: 'closed', start: '2026-08-17', end: '2026-08-30' },
      { id: '802', name: 'TT Week 31Aug', state: 'active', start: '2026-08-31', end: '2026-09-13' },
      { id: '803', name: 'TT Week 14Sep', state: 'future', start: '2026-09-14', end: '2026-09-27' },
    ],
  };
  r.reconcileSprints(plan, snap);
  const active = r.activeSprint(plan, 'ruby');
  assert.ok(active, 'a team that names no sprint with a number still has an active sprint');
  assert.strictEqual(active.byTeam.ruby.name, 'TT Week 31Aug');
});

check('the per-team index carries every dated sprint', () => {
  const plan = basePlan();
  const snap = snapshot();
  snap.boardSprintsByTeam.ruby.push({ id: '901', name: 'TT Week 31Aug', state: 'active', start: '2026-08-31', end: '2026-09-06' });
  snap.issues = { 'M-1': { key: 'M-1', assignee: 'Nam Hoang', assigneeId: 'acc-nam', points: 5, sprints: [{ id: '901', name: 'TT Week 31Aug' }] } };
  r.reconcileSprints(plan, snap);
  const idx = r.buildTeamIndex(plan, snap);
  const week = idx.ruby.sprints.find(s => s.jiraId === '901');
  assert.ok(week, 'the index must include it');
  assert.deepStrictEqual(week.issueKeys, ['M-1'], 'and its issues must resolve by Jira sprint id');
});

check('the active sprint comes from Jira state, per team', () => {
  const plan = basePlan();
  r.reconcileSprints(plan, snapshot());
  assert.strictEqual(r.activeSprint(plan, 'ruby').number, 40);
  assert.strictEqual(r.activeSprint(plan, 'titan').number, 40);
});

check('currentSprint prefers Jira\'s active sprint over a date match', () => {
  const plan = basePlan();
  r.reconcileSprints(plan, snapshot());
  // A date deep inside sprint 41, but Jira says 40 is still the active one.
  const got = insights.currentSprint(plan.sprints, new Date('2026-10-07T00:00:00Z'), 'ruby');
  assert.strictEqual(got.number, 40, 'a sprint started late must not point the app at the wrong one');
});

check('with no Jira state at all it falls back to the date range', () => {
  const plan = basePlan();
  const got = insights.currentSprint(plan.sprints, new Date('2026-09-20T00:00:00Z'), 'ruby');
  assert.strictEqual(got.number, 40);
});

/* ── people ───────────────────────────────────────────────────────────── */

const withIssues = () => snapshot({
  issues: {
    'K-1': { key: 'K-1', assignee: 'Thao Dang', assigneeId: 'acc-thao', points: 3, sprints: [{ id: '502', name: 'Katalon Ruby Sprint 40' }], sprintNames: ['Katalon Ruby Sprint 40'], components: [], labels: [] },
    'K-2': { key: 'K-2', assignee: 'Hy Nguyen', assigneeId: 'acc-hy', points: 5, sprints: [{ id: '502', name: 'Katalon Ruby Sprint 40' }], sprintNames: ['Katalon Ruby Sprint 40'], components: [], labels: [] },
    'K-3': { key: 'K-3', assignee: 'Nam Hoang', assigneeId: 'acc-nam', points: 2, sprints: [{ id: '502', name: 'Katalon Ruby Sprint 40' }], sprintNames: ['Katalon Ruby Sprint 40'], components: [], labels: [] },
    'K-4': { key: 'K-4', assignee: 'Luis Romero', assigneeId: 'acc-luis', points: 8, sprints: [{ id: '601', name: 'Katalon Titan Sprint 40' }], sprintNames: ['Katalon Titan Sprint 40'], components: [], labels: [] },
  },
});

check('people are attributed to a team by the sprint they worked in', () => {
  const plan = basePlan();
  const snap = withIssues();
  r.reconcileSprints(plan, snap);
  snap.byTeam = r.buildTeamIndex(plan, snap);
  const found = r.peopleByTeam(plan, snap);
  assert.deepStrictEqual(found.ruby.map(p => p.name).sort(), ['Hy Nguyen', 'Nam Hoang', 'Thao Dang']);
  assert.deepStrictEqual(found.titan.map(p => p.name), ['Luis Romero']);
});

check('the index groups each sprint\'s issue keys under that team', () => {
  const plan = basePlan();
  const snap = withIssues();
  r.reconcileSprints(plan, snap);
  const idx = r.buildTeamIndex(plan, snap);
  assert.deepStrictEqual(idx.ruby.sprintIssues['502'].sort(), ['K-1', 'K-2', 'K-3']);
  assert.deepStrictEqual(idx.titan.sprintIssues['601'], ['K-4']);
  assert.strictEqual(idx.ruby.sprints.find(s => s.number === 40).points, 10);
});

check('the index takes the backlog from the board when one was pulled', () => {
  const plan = basePlan();
  const snap = withIssues();
  snap.issues['BL-1'] = { key: 'BL-1', summary: 'queued', status: 'Open', statusCategory: 'new', points: 5, sprints: [], sprintNames: [], components: [], labels: [] };
  snap.boardBacklogByTeam = { ruby: ['BL-1'] };
  r.reconcileSprints(plan, snap);
  const idx = r.buildTeamIndex(plan, snap);
  assert.deepStrictEqual(idx.ruby.backlog, ['BL-1']);
  assert.strictEqual(idx.ruby.backlogSource, 'board');
  assert.strictEqual(idx.ruby.backlogPoints, 5);
});

check('a done issue never sits in the backlog, even if the board still lists it', () => {
  const plan = basePlan();
  const snap = withIssues();
  snap.issues['BL-2'] = { key: 'BL-2', summary: 'shipped', status: 'Done', statusCategory: 'done', points: 3, sprints: [], sprintNames: [], components: [], labels: [] };
  snap.boardBacklogByTeam = { ruby: ['BL-2'] };
  r.reconcileSprints(plan, snap);
  assert.deepStrictEqual(r.buildTeamIndex(plan, snap).ruby.backlog, []);
});

check('with no board mapped the index falls back and says so', () => {
  const plan = basePlan();
  const snap = withIssues();
  snap.issues['BL-3'] = { key: 'BL-3', summary: 'queued', status: 'Open', statusCategory: 'new', points: 2, sprints: [], sprintNames: [], components: [], labels: [], team: 'Katalon Auto Ruby' };
  r.reconcileSprints(plan, snap);
  const idx = r.buildTeamIndex(plan, snap);
  assert.strictEqual(idx.ruby.backlogSource, 'heuristic');
  assert.ok(idx.ruby.backlog.includes('BL-3'));
});

check('an existing member is linked to their Jira accountId automatically', () => {
  const plan = basePlan();
  const snap = withIssues();
  r.reconcileSprints(plan, snap);
  snap.byTeam = r.buildTeamIndex(plan, snap);
  const rep = r.reconcileMembers(plan, snap, { autoAdd: false });
  assert.strictEqual(plan.teams[0].members.find(m => m.name === 'Thao Dang').jiraAccountId, 'acc-thao');
  assert.strictEqual(rep.linked.length, 2);
});

check('linking matches on an alias when the Jira display name differs', () => {
  const plan = basePlan();
  plan.teams[0].members[0] = { id: 'ruby-a', name: 'Thao D.', jiraNames: ['Thao Dang'], role: 'QA Lead', status: 'Active', supportPct: 0 };
  const snap = withIssues();
  r.reconcileSprints(plan, snap);
  snap.byTeam = r.buildTeamIndex(plan, snap);
  r.reconcileMembers(plan, snap, { autoAdd: false });
  assert.strictEqual(plan.teams[0].members[0].jiraAccountId, 'acc-thao');
});

check('a person with tickets in the team\'s sprints is added to the roster', () => {
  const plan = basePlan();
  const snap = withIssues();
  r.reconcileSprints(plan, snap);
  snap.byTeam = r.buildTeamIndex(plan, snap);
  const rep = r.reconcileMembers(plan, snap);
  assert.ok(plan.teams[0].members.some(m => m.name === 'Nam Hoang'), 'Nam Hoang works in Ruby sprints — he is on the team');
  assert.strictEqual(rep.added.filter(a => a.teamId === 'ruby').length, 1);
  const added = plan.teams[0].members.find(m => m.name === 'Nam Hoang');
  assert.strictEqual(added.jiraAccountId, 'acc-nam');
  assert.strictEqual(added.source, 'jira', 'a row Jira supplied must say so — the UI promises synced/manual honestly');
});

check('a person typed in by hand is labelled manual, not jira', () => {
  const plan = basePlan();
  r.addMember(plan, 'ruby', { name: 'Contractor With No Jira Account' });
  const m = plan.teams[0].members.find(x => x.name === 'Contractor With No Jira Account');
  assert.strictEqual(m.source, 'manual', 'no accountId means Jira never mentioned them');
  assert.strictEqual(m.jiraAccountId, null);
});

check('A REMOVED PERSON STAYS REMOVED across every future sync', () => {
  const plan = basePlan();
  const snap = withIssues();
  r.reconcileSprints(plan, snap);
  snap.byTeam = r.buildTeamIndex(plan, snap);
  r.reconcileMembers(plan, snap);

  const nam = plan.teams[0].members.find(m => m.name === 'Nam Hoang');
  r.excludeMember(plan, 'ruby', nam.id);
  assert.ok(!plan.teams[0].members.some(m => m.name === 'Nam Hoang'), 'removed now');

  r.reconcileMembers(plan, snap);           // sync again
  r.reconcileMembers(plan, snap);           // and again
  assert.ok(!plan.teams[0].members.some(m => m.name === 'Nam Hoang'), 'the roster must not fight you');
});

check('un-excluding lets the next sync bring the person back', () => {
  const plan = basePlan();
  const snap = withIssues();
  r.reconcileSprints(plan, snap);
  snap.byTeam = r.buildTeamIndex(plan, snap);
  r.reconcileMembers(plan, snap);
  const nam = plan.teams[0].members.find(m => m.name === 'Nam Hoang');
  r.excludeMember(plan, 'ruby', nam.id);
  r.unexcludeMember(plan, 'ruby', 'acc-nam');
  r.reconcileMembers(plan, snap);
  assert.ok(plan.teams[0].members.some(m => m.name === 'Nam Hoang'));
});

check('adding members is idempotent — a second sync creates no duplicates', () => {
  const plan = basePlan();
  const snap = withIssues();
  r.reconcileSprints(plan, snap);
  snap.byTeam = r.buildTeamIndex(plan, snap);
  r.reconcileMembers(plan, snap);
  const after = plan.teams[0].members.length;
  r.reconcileMembers(plan, snap);
  assert.strictEqual(plan.teams[0].members.length, after);
});

check('a member with no Jira activity is flagged as dormant, not removed', () => {
  const plan = basePlan();
  const snap = withIssues();
  r.reconcileSprints(plan, snap);
  snap.byTeam = r.buildTeamIndex(plan, snap);
  const rep = r.reconcileMembers(plan, snap, { autoAdd: false });
  assert.deepStrictEqual(rep.dormant.titan.map(d => d.name).sort(), ['Hy Nguyen', 'Thao Dang']);
  assert.strictEqual(plan.teams[1].members.length, 2);
});

check('addMember puts the person on the roster with their accountId', () => {
  const plan = basePlan();
  const id = r.addMember(plan, 'ruby', { name: 'Nam Hoang', accountId: 'acc-nam' });
  const m = plan.teams[0].members.find(x => x.id === id);
  assert.strictEqual(m.name, 'Nam Hoang');
  assert.strictEqual(m.jiraAccountId, 'acc-nam');
  assert.strictEqual(m.status, 'Active');
  assert.strictEqual(m.supportPct, 0);
});

check('addMember refuses a duplicate rather than creating a second row', () => {
  const plan = basePlan();
  assert.throws(() => r.addMember(plan, 'ruby', { name: 'Thao Dang' }), /already on/);
});

/* ── team discovery ───────────────────────────────────────────────────── */

check('a scrum board with no matching team creates one', () => {
  const plan = { ...basePlan(), teams: [] };
  const snap = snapshot({ teamFieldValues: ['Katalon Auto Ruby', 'Katalon Auto Titan'] });
  const rep = r.discoverTeams(plan, snap);
  assert.strictEqual(rep.created.length, 2);
  assert.deepStrictEqual(plan.teams.map(t => t.name).sort(), ['Katalon Auto Ruby', 'Katalon Auto Titan']);
  assert.strictEqual(plan.teams[0].boardId, '10');
});

check('discovery matches an existing team instead of duplicating it', () => {
  const plan = basePlan();                 // already has ruby + titan by keyword
  const snap = snapshot({ teamFieldValues: ['Katalon Auto Ruby', 'Katalon Auto Titan'] });
  const rep = r.discoverTeams(plan, snap);
  assert.strictEqual(rep.created.length, 0);
  assert.strictEqual(plan.teams.length, 2);
  assert.strictEqual(plan.teams[0].boardId, '10');
});

check('a dismissed board is never rediscovered as a team', () => {
  const plan = { ...basePlan(), teams: [], ignoredBoards: ['10'] };
  const snap = snapshot();
  const rep = r.discoverTeams(plan, snap);
  assert.strictEqual(rep.created.length, 1, 'only the un-dismissed board becomes a team');
  assert.deepStrictEqual(rep.ignored, ['AUTOKAT Ruby board']);
});

check('removing a team dismisses its board and clears everything keyed to it', () => {
  const plan = basePlan();
  r.autoAssignBoards(plan, snapshot().boards);
  plan.availability['ruby|S39|ruby-a'] = ['1'];
  plan.support['ruby|S39|ruby-a'] = 20;
  plan.ceremony['ruby|S39'] = 8;
  plan.notes['ruby|S39'] = 'keep an eye on this';
  r.reconcileSprints(plan, snapshot());

  const name = r.removeTeam(plan, 'ruby');
  assert.strictEqual(name, 'Katalon Ruby');
  assert.ok(!plan.teams.some(t => t.id === 'ruby'));
  assert.ok(plan.ignoredBoards.includes('10'));
  assert.strictEqual(Object.keys(plan.availability).filter(k => k.startsWith('ruby|')).length, 0);
  assert.strictEqual(Object.keys(plan.support).filter(k => k.startsWith('ruby|')).length, 0);
  assert.strictEqual(Object.keys(plan.ceremony).filter(k => k.startsWith('ruby|')).length, 0);
  assert.strictEqual(Object.keys(plan.notes).filter(k => k.startsWith('ruby|')).length, 0);
  assert.ok(plan.sprints.every(x => !(x.byTeam || {}).ruby), "the team's sprint entries go too");
  // Titan is untouched.
  assert.ok(plan.teams.some(t => t.id === 'titan'));
  assert.ok(plan.sprints.some(x => (x.byTeam || {}).titan));
});

check('a removed team stays removed across syncs, until un-dismissed', () => {
  const plan = basePlan();
  r.autoAssignBoards(plan, snapshot().boards);
  r.removeTeam(plan, 'ruby');
  r.discoverTeams(plan, snapshot());
  assert.ok(!plan.teams.some(t => t.boardId === '10'), 'a sync must not undo the delete');
  r.unignoreBoard(plan, '10');
  r.discoverTeams(plan, snapshot());
  assert.ok(plan.teams.some(t => String(t.boardId) === '10'), 'un-dismissing brings it back');
});

check('a kanban board is not made into a team — there are no sprints to plan', () => {
  const plan = { ...basePlan(), teams: [] };
  const snap = snapshot({ boards: [{ id: '20', name: 'Support kanban', type: 'kanban' }] });
  r.discoverTeams(plan, snap);
  assert.strictEqual(plan.teams.length, 0);
});

/* ── end to end ───────────────────────────────────────────────────────── */

check('issues match their sprint by Jira id even when the sprint is renamed', () => {
  const plan = basePlan();
  const snap = withIssues();
  r.reconcileSprints(plan, snap);
  // Someone renames the sprint in Jira; the issue still carries id 502.
  snap.issues['K-1'].sprintNames = ['Ruby — hardening push'];
  snap.issues['K-1'].sprints = [{ id: '502', name: 'Ruby — hardening push' }];
  const s40 = plan.sprints.find(s => s.number === 40);
  const work = insights.workForSprint(plan, snap, plan.teams[0], s40);
  assert.ok(work.issues.some(i => i.key === 'K-1'), 'a renamed sprint must not drop its issues');
});

check('name matching still works when the board has never been synced', () => {
  const plan = basePlan();                       // no byTeam, no jiraIds
  const snap = withIssues();
  const s40 = plan.sprints.find(s => s.number === 40);
  const work = insights.workForSprint(plan, snap, plan.teams[0], s40);
  assert.strictEqual(work.issues.length, 3);
});

check('reconcileAll returns one summary covering boards, sprints and people', () => {
  const plan = basePlan();
  const snap = withIssues();
  const rep = r.reconcileAll(plan, snap);
  assert.strictEqual(rep.sprints.added, 1);
  assert.strictEqual(rep.members.linked, 2);
  // Nam Hoang joins Ruby and Luis Romero joins Titan — both had tickets in those
  // teams' sprints, which is what being on the team means.
  assert.strictEqual(rep.members.added, 2);
  assert.strictEqual(rep.index.ruby.sprints, 3);
  assert.ok(rep.index.ruby.backlogSource);
});

/* ── someone Jira knows, on a team they have no work in ──────────────────
   HIS CASE, EXACTLY. Diep Tu is on three of his teams. On two they arrived
   from a sync and carry an accountId; on Titan they were typed into the box
   and carried none — so the row read "manual" and Jira had, as far as the tool
   was concerned, never heard of them.

   Why it could never heal is the interesting part. All 108 of Diep Tu's issues
   sit on the TrueTest board; none are in any of Titan's 44 sprints. The
   linking step only ever looked at people who had worked in THIS team's
   sprints, so Titan's list would never contain them, however many syncs ran.

   `Luis Romero` is the fixture's equivalent: he works only in Titan's sprints,
   so adding him to Ruby reproduces the situation precisely. */

const withDirectory = () => {
  const snap = withIssues();
  // What `snapshot.people` is: the whole Jira directory, not one team's.
  snap.people = [
    { name: 'Thao Dang', accountId: 'acc-thao' },
    { name: 'Hy Nguyen', accountId: 'acc-hy' },
    { name: 'Nam Hoang', accountId: 'acc-nam' },
    { name: 'Luis Romero', accountId: 'acc-luis' },
  ];
  return snap;
};
const synced = (plan, snap) => {
  r.reconcileSprints(plan, snap);
  snap.byTeam = r.buildTeamIndex(plan, snap);
  return snap;
};

check('A TYPED NAME THE TOOL ALREADY KNOWS IS LINKED, not stored as a stranger', () => {
  const plan = basePlan();
  const snap = withDirectory();
  r.addMember(plan, 'ruby', { name: 'Luis Romero' }, { directory: snap.people });
  const m = plan.teams[0].members.find(x => x.name === 'Luis Romero');
  assert.strictEqual(m.jiraAccountId, 'acc-luis', 'the directory had this name against a real account');
  assert.strictEqual(m.source, 'jira', 'and a row Jira identified is not something the user invented');
});

check('the match is on the WHOLE directory, not this team\'s sprint people', () => {
  // Luis has never worked in a Ruby sprint. That is the case that could not
  // heal before, and the one his report is about.
  const plan = basePlan();
  const snap = synced(basePlan(), withDirectory());
  assert.ok(!(r.peopleByTeam(plan, snap).ruby || []).some(p => p.name === 'Luis Romero'),
    'the fixture must not accidentally give Luis Ruby work');
  r.addMember(plan, 'ruby', { name: 'Luis Romero' }, { directory: snap.people });
  assert.strictEqual(plan.teams[0].members.find(x => x.name === 'Luis Romero').jiraAccountId, 'acc-luis');
});

check('AND AN ALREADY-TYPED ROW HEALS ON THE NEXT SYNC', () => {
  // His existing data: the row is already there, unlinked. The fix has to
  // repair it without anyone deleting and re-adding the person.
  const plan = basePlan();
  r.addMember(plan, 'ruby', { name: 'Luis Romero' });            // no directory — the old path
  const before = plan.teams[0].members.find(x => x.name === 'Luis Romero');
  assert.strictEqual(before.jiraAccountId, null, 'this is the state on disk today');
  assert.strictEqual(before.source, 'manual');

  const snap = synced(plan, withDirectory());
  const rep = r.reconcileMembers(plan, snap, { autoAdd: false });
  const after = plan.teams[0].members.find(x => x.name === 'Luis Romero');
  assert.strictEqual(after.jiraAccountId, 'acc-luis', 'a sync must repair it');
  assert.strictEqual(after.source, 'jira', 'and the source has to follow the link');
  assert.ok(rep.linked.some(l => l.name === 'Luis Romero'), 'and the sync report should say so');
});

check('THE SOURCE FOLLOWS THE LINK — an accountId and "manual" cannot coexist', () => {
  // The invariant `addMember` states in its own comment, which the linking
  // step used to break: it set the accountId and left the label alone.
  const plan = basePlan();
  const snap = synced(plan, withDirectory());
  r.reconcileMembers(plan, snap);
  for (const team of plan.teams) {
    for (const m of team.members || []) {
      if (m.jiraAccountId) assert.strictEqual(m.source, 'jira', `${m.name} carries an accountId but reads as ${m.source}`);
      if (m.source === 'jira') assert.ok(m.jiraAccountId, `${m.name} claims Jira supplied them but has no account`);
    }
  }
});

check('a genuinely unknown name is still manual, and still unlinked', () => {
  // The fix must not make every typed name claim to be from Jira.
  const plan = basePlan();
  const snap = withDirectory();
  r.addMember(plan, 'ruby', { name: 'Contractor With No Jira Account' }, { directory: snap.people });
  const m = plan.teams[0].members.find(x => x.name === 'Contractor With No Jira Account');
  assert.strictEqual(m.jiraAccountId, null);
  assert.strictEqual(m.source, 'manual');
});

check('AN AMBIGUOUS NAME LINKS TO NEITHER of them', () => {
  // Two humans sharing a display name is rare and real. Picking either attaches
  // this row — and everything ever credited to it — to a coin toss.
  const plan = basePlan();
  const directory = [
    { name: 'Minh Nguyen', accountId: 'acc-minh-1' },
    { name: 'Minh Nguyen', accountId: 'acc-minh-2' },
  ];
  r.addMember(plan, 'ruby', { name: 'Minh Nguyen' }, { directory });
  const m = plan.teams[0].members.find(x => x.name === 'Minh Nguyen');
  assert.strictEqual(m.jiraAccountId, null, 'a guess here is worse than no link');
  assert.strictEqual(m.source, 'manual');
});

check('and neither does an ambiguous name link during a sync', () => {
  const plan = basePlan();
  r.addMember(plan, 'ruby', { name: 'Minh Nguyen' });
  const snap = synced(plan, withDirectory());
  snap.people = [...snap.people, { name: 'Minh Nguyen', accountId: 'a1' }, { name: 'Minh Nguyen', accountId: 'a2' }];
  r.reconcileMembers(plan, snap, { autoAdd: false });
  assert.strictEqual(plan.teams[0].members.find(x => x.name === 'Minh Nguyen').jiraAccountId, null);
});

check('an explicit accountId still wins over the directory', () => {
  // Picking someone off the discovered list is the strongest signal there is.
  const plan = basePlan();
  r.addMember(plan, 'ruby', { name: 'Luis Romero', accountId: 'acc-explicit' }, {
    directory: [{ name: 'Luis Romero', accountId: 'acc-luis' }],
  });
  assert.strictEqual(plan.teams[0].members.find(x => x.name === 'Luis Romero').jiraAccountId, 'acc-explicit');
});

check('a missing directory is harmless — the old behaviour, unchanged', () => {
  const plan = basePlan();
  assert.doesNotThrow(() => r.addMember(plan, 'ruby', { name: 'Someone New' }));
  assert.doesNotThrow(() => r.addMember(plan, 'ruby', { name: 'Someone Else' }, { directory: null }));
  const snap = withIssues();                 // no `people` key at all
  assert.doesNotThrow(() => r.reconcileMembers(plan, synced(plan, snap), { autoAdd: false }));
});

check('LINKED-BUT-IDLE IS REPORTED DIFFERENTLY FROM NOT-MATCHED-AT-ALL', () => {
  /* After the fix Luis is linked on Ruby and still has no Ruby work — which is
     true and fine. The screen used to call every such person a display-name
     mismatch and tell the reader to add a Jira alias; for someone already
     linked by accountId that is advice to fix something that is not broken. */
  const plan = basePlan();
  const snap = withDirectory();
  r.addMember(plan, 'ruby', { name: 'Luis Romero' }, { directory: snap.people });
  r.addMember(plan, 'ruby', { name: 'Ghost Person' });
  synced(plan, snap);
  const rep = r.reconcileMembers(plan, snap, { autoAdd: false });
  const by = Object.fromEntries((rep.dormant.ruby || []).map(d => [d.name, d]));
  assert.ok(by['Luis Romero'], 'Luis has no Ruby work, so he is dormant here');
  assert.strictEqual(by['Luis Romero'].linked, true, 'but Jira knows exactly who he is');
  assert.ok(by['Ghost Person'], 'and someone Jira has never seen is dormant too');
  assert.strictEqual(by['Ghost Person'].linked, false, 'for an entirely different reason');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
