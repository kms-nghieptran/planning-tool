'use strict';
/**
 * reset.test.js — the cleanup must delete exactly what a sync can rebuild, and
 * nothing else.
 *
 * The dangerous failure here is not deleting too little; it is deleting the
 * leave grid, the exclusion lists or the capacity constants, none of which can
 * be recovered from Jira or from anywhere else. Each of those has its own check.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-reset-'));
process.env.STORE_DIR = SCRATCH;

const reset = require('../lib/reset');
const reconcile = require('../lib/reconcile');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
console.log('\nReset to Jira\n');

/** A plan shaped like Nghiep's: seeded rosters, real boards, hand-entered grid. */
function samplePlan() {
  return {
    version: 1,
    teams: [
      {
        id: 'ruby', name: 'Ruby', jiraName: 'Katalon Auto Ruby', boardId: '2093',
        settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 8.5 },
        components: ['R&D_Evolve'], sprintKeywords: ['ruby'],
        members: [
          { id: 'ruby-thao', name: 'Thao', status: 'Active', jiraAccountId: 'acc-1' },
          { id: 'ruby-hy', name: 'Hy', status: 'Active', jiraAccountId: 'acc-2' },
        ],
      },
      {
        id: 'titan', name: 'Titan', jiraName: 'Katalon Auto Titan', boardId: '2092',
        settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 },
        members: [{ id: 'titan-hien', name: 'Hien', status: 'Active', jiraAccountId: 'acc-3' }],
      },
      // Invented locally — no board, so nothing can rebuild it.
      { id: 'ghost', name: 'Ghost team', boardId: null, members: [{ id: 'g-1', name: 'Nobody' }] },
    ],
    sprints: [
      { id: 'S38', number: 38, byTeam: { ruby: { jiraId: '900', name: 'Ruby S38' } } },
      { id: 'S39', number: 39, byTeam: { ruby: { jiraId: '901', name: 'Ruby S39' } } },
      { id: 'S45', number: 45, byTeam: {} },                       // generated ahead of the board
      { id: 'S46', number: 46, byTeam: { ruby: {} } },              // present but never confirmed by Jira
    ],
    holidays: ['2026-09-02', '2027-01-01'],
    availability: { 'ruby|S38|ruby-thao': ['1', '1', '0.5'], 'ruby|S39|ruby-hy': ['1'], 'ruby|S45|ruby-thao': ['1'] },
    support: { 'ruby|S39|ruby-thao': 40, 'ghost|S39|g-1': 10 },
    ceremony: { 'ruby|S38': 8.5, 'ruby|S45': 9 },
    overrides: {}, notes: {}, risks: [{ id: 'r1', title: 'Key person on Evolve' }],
    mixTargets: { ruby: { maintenance: [0, 35] } },
    excluded: { titan: ['acc-9', 'acc-10', 'An Nguyen'] },
  };
}

check('the seeded rosters go — Jira supplies people', () => {
  const plan = samplePlan();
  const r = reset.resetToJira(plan);
  assert.strictEqual(r.removed.members, 4, 'every seeded member row should be counted as removed');
  for (const t of plan.teams) assert.deepStrictEqual(t.members, [], `${t.id} should have an empty roster`);
});

check('a team with no Jira board is dropped, a mapped team is kept', () => {
  const plan = samplePlan();
  const r = reset.resetToJira(plan);
  assert.strictEqual(r.removed.teamsWithoutBoard, 1);
  assert.deepStrictEqual(plan.teams.map(t => t.id), ['ruby', 'titan']);
});

check('capacity constants survive — they came off the spreadsheet, not Jira', () => {
  const plan = samplePlan();
  reset.resetToJira(plan);
  const ruby = plan.teams.find(t => t.id === 'ruby');
  assert.strictEqual(ruby.settings.hoursPerPoint, 2.9);
  assert.strictEqual(ruby.settings.ceremonyHours, 8.5);
  assert.deepStrictEqual(ruby.components, ['R&D_Evolve'], 'component mapping is configuration too');
  assert.strictEqual(ruby.boardId, '2093', 'the board mapping must survive or the next sync rebuilds nothing');
});

check('local-only sprints go, Jira-backed sprints stay', () => {
  const plan = samplePlan();
  const r = reset.resetToJira(plan);
  assert.strictEqual(r.removed.localSprints, 2, 'S45 and S46 were never confirmed by a board');
  assert.deepStrictEqual(plan.sprints.map(s => s.id), ['S38', 'S39']);
});

check('THE LEAVE GRID SURVIVES — nothing can regenerate it', () => {
  const plan = samplePlan();
  reset.resetToJira(plan);
  assert.deepStrictEqual(plan.availability['ruby|S38|ruby-thao'], ['1', '1', '0.5'],
    'a hand-entered availability row must never be dropped by a cleanup');
  assert.strictEqual(plan.support['ruby|S39|ruby-thao'], 40);
  assert.strictEqual(plan.ceremony['ruby|S38'], 8.5);
});

check('planning entries pointing at deleted sprints or teams are swept up', () => {
  const plan = samplePlan();
  const r = reset.resetToJira(plan);
  assert.ok(!('ruby|S45|ruby-thao' in plan.availability), 'S45 is gone, so its availability is unreachable');
  assert.ok(!('ghost|S39|g-1' in plan.support), 'the ghost team is gone, so its support % is unreachable');
  assert.ok(!('ruby|S45' in plan.ceremony));
  assert.strictEqual(r.removed.orphanedPlanningEntries, 3);
});

check('EXCLUSIONS SURVIVE — a cleanup must not re-add people you removed', () => {
  const plan = samplePlan();
  reset.resetToJira(plan);
  assert.deepStrictEqual(plan.excluded.titan, ['acc-9', 'acc-10', 'An Nguyen'],
    'these encode a decision about who is on the team, not stale data');
});

check('holidays, risks and mix targets survive', () => {
  const plan = samplePlan();
  reset.resetToJira(plan);
  assert.strictEqual(plan.holidays.length, 2);
  assert.strictEqual(plan.risks.length, 1, 'the risk register is written by hand');
  assert.deepStrictEqual(plan.mixTargets.ruby.maintenance, [0, 35]);
});

check('settings-only mode clears the grid but never the constants', () => {
  const plan = samplePlan();
  const r = reset.resetToJira(plan, { mode: 'settings-only' });
  assert.deepStrictEqual(plan.availability, {});
  assert.deepStrictEqual(plan.support, {});
  assert.deepStrictEqual(plan.ceremony, {});
  assert.strictEqual(r.removed.availability, 3);
  assert.strictEqual(plan.teams.find(t => t.id === 'ruby').settings.hoursPerPoint, 2.9,
    're-deriving the constants from the spreadsheet is a day of work — never wipe them');
  assert.deepStrictEqual(plan.excluded.titan.length, 3, 'exclusions survive every mode');
  assert.strictEqual(plan.holidays.length, 2);
});

check('the report says what was removed, so a dry run is readable', () => {
  const plan = samplePlan();
  const r = reset.resetToJira(plan);
  assert.strictEqual(r.mode, 'keep-capacity');
  assert.ok(r.removed.members > 0 && r.removed.localSprints > 0);
  assert.strictEqual(r.kept.availability, 2, 'and what survived');
  assert.deepStrictEqual(r.kept.excluded, { titan: 3 });
});

check('a reset leaves a plan a sync can actually repopulate', () => {
  const plan = samplePlan();
  reset.resetToJira(plan);
  // The snapshot still knows who is on Ruby; reconcile must be able to put them back.
  const snap = {
    byTeam: { ruby: { people: [{ name: 'Thao', accountId: 'acc-1', issues: 5, points: 8 }] } },
    issues: {},
  };
  const rep = reconcile.reconcileMembers(plan, snap);
  assert.strictEqual(rep.added.length, 1, 'the next sync must refill the roster it just emptied');
  assert.strictEqual(plan.teams.find(t => t.id === 'ruby').members[0].source, 'jira',
    'and the refilled row must be honestly labelled as coming from Jira');
});

/* ── the roster window ─────────────────────────────────────────────────── */

/** Six sprints of history; only the last two have anyone still active. */
function windowSnapshot() {
  const issues = {};
  const add = (key, sprintId, name, acc) => {
    issues[key] = { key, assignee: name, assigneeId: acc, points: 3, status: 'Done', statusCategory: 'done', sprints: [{ id: sprintId, name: `S${sprintId}` }] };
  };
  add('A-1', '801', 'Old Timer', 'acc-old');       // long gone
  add('A-2', '802', 'Also Gone', 'acc-gone');
  add('A-3', '803', 'Left Recently', 'acc-left');
  add('A-4', '804', 'Hien Phan', 'acc-hien');      // inside a 3-sprint window
  add('A-5', '805', 'Hien Phan', 'acc-hien');
  add('A-6', '806', 'Anh Truong', 'acc-anh');
  return issues;
}

function windowPlan() {
  return {
    teams: [{ id: 'titan', name: 'Titan', boardId: '2092', members: [] }],
    sprints: ['801', '802', '803', '804', '805', '806'].map((jiraId, n) => ({
      id: `S${n + 1}`, number: n + 1,
      byTeam: { titan: { jiraId, name: `S${jiraId}`, state: n === 5 ? 'active' : 'closed' } },
    })),
  };
}

check('the roster is who is here NOW, not everyone the board ever saw', () => {
  const plan = windowPlan();
  const idx = reconcile.buildTeamIndex(plan, { issues: windowSnapshot() });
  const names = idx.titan.people.map(p => p.name).sort();
  assert.deepStrictEqual(names, ['Anh Truong', 'Hien Phan'],
    'a 44-sprint board should not produce a 40-person roster for a 3-person team');
});

check('people from before the window are reported, never dropped', () => {
  const plan = windowPlan();
  const idx = reconcile.buildTeamIndex(plan, { issues: windowSnapshot() });
  const historic = idx.titan.peopleHistoric.map(p => p.name).sort();
  assert.deepStrictEqual(historic, ['Also Gone', 'Left Recently', 'Old Timer'],
    'they must stay visible so someone returning can be added in one click');
});

check('someone active recently counts as current, whatever their history', () => {
  const issues = windowSnapshot();
  issues['A-0'] = { key: 'A-0', assignee: 'Hien Phan', assigneeId: 'acc-hien', points: 1, sprints: [{ id: '801', name: 'S801' }] };
  const idx = reconcile.buildTeamIndex(windowPlan(), { issues });
  assert.ok(idx.titan.people.some(p => p.name === 'Hien Phan'));
  assert.ok(!idx.titan.peopleHistoric.some(p => p.name === 'Hien Phan'),
    'a long-serving person must not appear in both lists');
});

check('the window is per-team configurable', () => {
  const plan = windowPlan();
  plan.teams[0].settings = { rosterWindowSprints: 6 };
  const idx = reconcile.buildTeamIndex(plan, { issues: windowSnapshot() });
  assert.strictEqual(idx.titan.people.length, 5, 'a wider window should take in the whole history');
  assert.strictEqual(idx.titan.peopleHistoric.length, 0);
});

check('a future sprint never contributes to the roster', () => {
  const plan = windowPlan();
  plan.sprints.push({ id: 'S7', number: 7, byTeam: { titan: { jiraId: '807', name: 'S807', state: 'future' } } });
  plan.sprints.push({ id: 'S8', number: 8, byTeam: { titan: { jiraId: '808', name: 'S808', state: 'future' } } });
  const idx = reconcile.buildTeamIndex(plan, { issues: windowSnapshot() });
  assert.ok(idx.titan.people.some(p => p.name === 'Hien Phan'),
    'two empty future sprints must not push the real team out of the window');
});

check('the window names the sprints it used, so the roster is explainable', () => {
  const idx = reconcile.buildTeamIndex(windowPlan(), { issues: windowSnapshot() });
  assert.strictEqual(idx.titan.rosterWindow.sprints, 3);
  assert.deepStrictEqual(idx.titan.rosterWindow.names, ['S804', 'S805', 'S806']);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
