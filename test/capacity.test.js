'use strict';
/**
 * capacity.test.js — asserts the app reproduces the capacity spreadsheet exactly.
 *
 * These are not "does the function run" tests. Every expected value below was read
 * out of the team's own sheet, so if one of these goes red the app and the sheet
 * now disagree — which is the only bug that really matters here.
 *
 * Run: node test/capacity.test.js
 */

const assert = require('node:assert');
const path = require('node:path');
const cap = require('../lib/capacity');
const cls = require('../lib/classify');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

const seed = require(path.join(__dirname, '..', 'data', 'seed', 'plan.seed.json'));
const settingsFor = (teamId, sprintId) => {
  const team = seed.teams.find(t => t.id === teamId);
  const ceremony = seed.ceremony[`${teamId}|${sprintId}`];
  return { ...cap.teamSettings(team), ...(ceremony != null ? { ceremonyHours: ceremony } : {}) };
};

console.log('\nCapacity model — against the spreadsheet\n');

/* ── 1. Day-cell vocabulary ───────────────────────────────────────────── */
check('day codes: 1 = full, 0.5 = half, 0 / WO / H = nothing', () => {
  assert.strictEqual(cap.dayValue('1'), 1);
  assert.strictEqual(cap.dayValue('0.5'), 0.5);
  assert.strictEqual(cap.dayValue('0'), 0);
  assert.strictEqual(cap.dayValue('WO'), 0);
  assert.strictEqual(cap.dayValue('H'), 0);
  assert.strictEqual(cap.dayValue(''), 0);
});

check('availableDays sums a 14-cell row', () => {
  assert.strictEqual(cap.availableDays(['1', '0', 'WO', 'WO', '1', '1', '1', '1', '1', 'WO', 'WO', '1', '1', '1']), 9);
  assert.strictEqual(cap.availableDays(['1', '0.5', 'WO', 'WO', '1', 'H', '1', '1', '1', 'WO', 'WO', '1', '1', '1']), 8.5);
});

/* ── 2. The exact capacity numbers from the sheet ─────────────────────── */
const SHEET_ROWS = [
  // team, sprint, member,               days, support%, expected hours, expected predicted pts
  ['ruby',  'S33', 'Thao Dang',            9,   25,  38.75, 13],
  ['ruby',  'S33', 'Hy Nguyen',           10,    0,  61.5,  21],
  ['ruby',  'S33', 'Tran Thi Minh Chau',   9,    0,  54.5,  19],
  ['ruby',  'S33', 'Abiran Lopez',        10,    0,  61.5,  21],
  ['ruby',  'S38', 'Thao Dang',            7.5, 30,  28.75, 10],
  ['titan', 'S33', 'Thuan Dinh Cong Ngoc', 9.5, 30,  37.55, 13],
  ['titan', 'S34', 'Bao Luong Gia Nguyen', 8.5, 50,  20.75,  7],
  ['titan', 'S37', 'Thuan Dinh Cong Ngoc',10,   40,  33,     11],
  ['titan', 'S37', 'Hien Phan',           10,    0,  61,     21],
  ['titan', 'S37', 'Luis Romero',          7,    0,  40,     14],
  ['titan', 'S37', 'Anh Truong',          10,   40,  33,     11],
  ['titan', 'S38', 'Thuan Dinh Cong Ngoc', 7,   40,  20.4,    7],
  ['titan', 'S38', 'Anh Truong',           7,   30,  25.3,    9],
  ['titan', 'S39', 'Thuan Dinh Cong Ngoc',10,   40,  33,     11],
  ['titan', 'S39', 'Hien Phan',            9,    0,  54,     19],
  ['titan', 'S39', 'Anh Truong',          10,   30,  40,     14],
];

for (const [teamId, sprintId, name, days, support, hours, pts] of SHEET_ROWS) {
  check(`${name} · ${sprintId} · ${days}d @ ${support}% support → ${hours}h / ${pts} pts`, () => {
    const s = settingsFor(teamId, sprintId);
    assert.strictEqual(cap.capacityHours(days, support, s), hours);
    assert.strictEqual(cap.predictedPoints(hours, s), pts);
  });
}

/* ── 3. The order of operations, which is the easiest thing to get wrong ─ */
check('support is deducted BEFORE ceremony hours, not after', () => {
  const s = settingsFor('titan', 'S37');
  // 10 days, 40% support, 9h ceremony
  assert.strictEqual(cap.capacityHours(10, 40, s), 33);        // 10*7*0.6 - 9
  assert.notStrictEqual(cap.capacityHours(10, 40, s), 30.6);   // (10*7 - 9) * 0.6
});

check('capacity floors at zero, never negative', () => {
  const s = settingsFor('titan', 'S35');
  assert.strictEqual(cap.capacityHours(10, 100, s), 0);        // 10*7*0 - 9 = -9 → 0
  assert.strictEqual(cap.capacityHours(0.5, 0, s), 0);         // 3.5 - 9 = -5.5 → 0
});

/* ── 4. The #DIV/0! cases the sheet shows ─────────────────────────────── */
check('workload is null (not Infinity) when capacity is zero', () => {
  assert.strictEqual(cap.workloadPct(10, 0, cap.DEFAULTS), null);
});
check('goal is null when nothing was planned', () => {
  assert.strictEqual(cap.goalPct(5, 0), null);
});
check('workload matches the sheet: 23 pts on 61.5 h at 2.9 h/pt = 108.5%', () => {
  assert.strictEqual(cap.workloadPct(23, 61.5, cap.DEFAULTS), 108.5);
});
check('workload matches the sheet: 14 pts on 38.75 h = 104.8%', () => {
  assert.strictEqual(cap.workloadPct(14, 38.75, cap.DEFAULTS), 104.8);
});

/* ── 5. Team roll-up ──────────────────────────────────────────────────── */
check('Ruby S33 team capacity rolls up to 216.25 h → 75 pts, as the sheet says', () => {
  const s = settingsFor('ruby', 'S33');
  const hours = [38.75, 61.5, 54.5, 61.5].reduce((a, b) => a + b, 0);
  assert.strictEqual(hours, 216.25);
  assert.strictEqual(Math.round(hours / s.hoursPerPoint), 75);
});

check('Titan S33 Thuan-inclusive roll-up reaches the sheet figure of 83 pts', () => {
  const s = settingsFor('titan', 'S33');
  assert.strictEqual(Math.round(239.55 / s.hoursPerPoint), 83);
});

check('sprintGrid produces the same totals as the per-row maths', () => {
  const team = seed.teams.find(t => t.id === 'ruby');
  const sprint = seed.sprints.find(x => x.id === 'S33');
  const teamWithCeremony = { ...team, settings: { ...team.settings, ceremonyHours: 8.5 } };
  const members = teamWithCeremony.members.map(m => ({ ...m, supportPct: seed.support[`ruby|S33|${m.id}`] ?? m.supportPct }));
  const avail = Object.fromEntries(members.map(m => [m.id, seed.availability[`ruby|S33|${m.id}`]]));
  const grid = cap.sprintGrid({ ...teamWithCeremony, members }, sprint, avail, {});
  assert.strictEqual(grid.totals.capacityHours, 216.25);
  assert.strictEqual(grid.totals.predicted, 75);
  assert.strictEqual(grid.totals.headcount, 4);
});

check('a Released member contributes no capacity', () => {
  const team = { id: 't', name: 'T', settings: { ceremonyHours: 9 }, members: [{ id: 'a', name: 'A', role: 'Auto QA', status: 'Released', supportPct: 0 }] };
  const grid = cap.sprintGrid(team, { id: 'S1' }, { a: new Array(14).fill('1') }, {});
  assert.strictEqual(grid.totals.capacityHours, 0);
  assert.strictEqual(grid.totals.headcount, 0);
});

/* ── 6. Calibration + velocity helpers ───────────────────────────────── */
check('calibration needs three sprints of evidence before it speaks', () => {
  assert.strictEqual(cap.calibrateHoursPerPoint([{ actual: 10, capacityHours: 29 }, { actual: 10, capacityHours: 29 }]), null);
});
check('calibration reports hours actually spent per delivered point', () => {
  const r = cap.calibrateHoursPerPoint([
    { actual: 10, capacityHours: 30 }, { actual: 20, capacityHours: 60 }, { actual: 10, capacityHours: 30 },
  ]);
  assert.strictEqual(r.value, 3);
  assert.strictEqual(r.sprints, 3);
});
check('average velocity uses the last N completed sprints only', () => {
  const h = [{ actual: 0 }, { actual: 60 }, { actual: 80 }, { actual: 70 }];
  assert.strictEqual(cap.averageVelocity(h, 3), 70);
});
check('predictability reports mean and spread of delivered/committed', () => {
  const p = cap.predictability([
    { planned: 100, actual: 100 }, { planned: 100, actual: 80 }, { planned: 100, actual: 120 },
  ]);
  assert.strictEqual(p.mean, 1);
  assert.ok(p.stdev > 0);
});

/* ── 7. Flags ─────────────────────────────────────────────────────────── */
check('a member at 167% is flagged overloaded with the points to move', () => {
  const s = cap.teamSettings({ settings: { ceremonyHours: 9 } });
  const row = cap.memberRow({ id: 'm', name: 'M', role: 'Auto QA', status: 'Active', supportPct: 0 },
    new Array(14).fill('1').map((c, i) => ([0, 1, 7, 8].includes(i) ? 'WO' : c)),
    { planned: 35, actual: 0 }, s);
  const flag = row.flags.find(f => f.code === 'overloaded');
  assert.ok(flag, 'expected an overloaded flag');
  assert.match(flag.text, /pts above capacity/);
});

check('a member with nothing assigned is flagged, not silently ignored', () => {
  const s = cap.teamSettings({ settings: { ceremonyHours: 9 } });
  const row = cap.memberRow({ id: 'm', name: 'M', role: 'Auto QA', status: 'Active', supportPct: 0 },
    new Array(14).fill('1'), { planned: 0, actual: 0 }, s);
  assert.ok(row.flags.some(f => f.code === 'unplanned'));
});

/* ── 8. Work classification ───────────────────────────────────────────── */
check('a "Tech:" Bucket Story is technical work, not new implementation', () => {
  assert.strictEqual(cls.classify({ issueType: 'Bucket Story', summary: 'Tech: Add A03 R&D Docfast Inflight schedule workflow', labels: [], components: [] }), 'technical');
});
check('a Maintenance-labelled Story is maintenance, not new implementation', () => {
  assert.strictEqual(cls.classify({ issueType: 'Story', summary: 'Fix locator', labels: ['Maintenance'], components: [] }), 'maintenance');
});
check('KAT_Common_Maintenance component means maintenance', () => {
  assert.strictEqual(cls.classify({ issueType: 'Story', summary: 'x', labels: [], components: ['KAT_Common_Maintenance'] }), 'maintenance');
});
check('a plain Story is new implementation', () => {
  assert.strictEqual(cls.classify({ issueType: 'Story', summary: 'SHRTEC-5884 Open Help Screen Groups page', labels: [], components: ['R&D_Sig_Regression'] }), 'new');
});
check('a manual override beats every rule', () => {
  assert.strictEqual(cls.classify({ issueType: 'Story', summary: 'x', labels: [], components: [], categoryOverride: 'support' }), 'support');
});
check('mix computes shares that add up', () => {
  const m = cls.mix([
    { issueType: 'Story', summary: 'a', points: 6, labels: [], components: [] },
    { issueType: 'Story', summary: 'b', points: 2, labels: ['Maintenance'], components: [] },
    { issueType: 'Bucket Story', summary: 'Tech: c', points: 2, labels: [], components: [] },
  ]);
  assert.strictEqual(m.totalPoints, 10);
  assert.strictEqual(m.byCategory.new.share, 60);
  assert.strictEqual(m.byCategory.maintenance.share, 20);
  assert.strictEqual(m.byCategory.technical.share, 20);
});
check('mix vs target flags maintenance running hot', () => {
  const m = cls.mix([
    { issueType: 'Story', summary: 'a', points: 4, labels: [], components: [] },
    { issueType: 'Story', summary: 'b', points: 6, labels: ['Maintenance'], components: [] },
  ]);
  const maint = cls.mixVsTarget(m).find(t => t.category === 'maintenance');
  assert.strictEqual(maint.share, 60);
  assert.strictEqual(maint.status, 'over');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
