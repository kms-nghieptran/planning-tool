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

/* ── CALC EXEMPT ──────────────────────────────────────────────────────
   On the roster, out of the capacity arithmetic. Not "released" (they have
   not left), not "excluded" (they are this team's), not off the sprint roster
   (they are on this sprint, often carrying work) — their HOURS are simply not
   what the team is planning against. */

const twoPeople = (over = {}) => ({
  id: 't', name: 'T', settings: { ceremonyHours: 9, hoursPerDay: 7, hoursPerPoint: 2.9 },
  members: [
    { id: 'a', name: 'A', role: 'Auto QA', status: 'Active', supportPct: 0, ...(over.a || {}) },
    { id: 'b', name: 'B', role: 'QA Lead', status: 'Active', supportPct: 0, ...(over.b || {}) },
  ],
});
const full = () => new Array(14).fill('1');
const bothDays = { a: full(), b: full() };

check('AN EXEMPT MEMBER CONTRIBUTES NO CAPACITY, exactly as a released one does', () => {
  const base = cap.sprintGrid(twoPeople(), { id: 'S1' }, bothDays, {});
  const grid = cap.sprintGrid(twoPeople({ b: { calcExempt: true } }), { id: 'S1' }, bothDays, {});

  assert.ok(base.totals.capacityHours > 0, 'the fixture has to have capacity to remove');
  assert.strictEqual(grid.totals.headcount, base.totals.headcount - 1);
  // Both have identical availability and support, so exempting one leaves
  // exactly one person's hours — asserted against that row, not against a
  // halving this fixture merely happens to satisfy.
  const a = grid.rows.find(r => r.memberId === 'a');
  assert.strictEqual(grid.totals.capacityHours, a.capacityHours,
    'the remaining capacity is the remaining person');
  assert.ok(grid.totals.predicted < base.totals.predicted, 'and fewer predicted points');
  assert.strictEqual(grid.totals.exempt, 1, 'and the total says how many, so the headcount is explainable');
});

check('and their ROW is still there, with their own days and hours at zero', () => {
  // They are on the sprint. Hiding them would make this the roster screen
  // again, and there is already one of those.
  const grid = cap.sprintGrid(twoPeople({ b: { calcExempt: true } }), { id: 'S1' }, bothDays, {});
  const b = grid.rows.find(r => r.memberId === 'b');
  assert.ok(b, 'the exempt member vanished from the grid');
  assert.strictEqual(b.calcExempt, true, 'and the row has to say so, or the screen cannot mark it');
  assert.strictEqual(b.capacityHours, 0);
  assert.ok(b.availableDays > 0, 'their availability is still their availability');
});

check('THEIR COMMITTED WORK STILL COUNTS — the burndown depends on it', () => {
  /* `totals.planned` is what the sprint screen reports as Committed and draws
     the burndown from. Dropping an exempt member's points would make the
     sprint report less work than was taken on, and the burndown would end
     above zero with everything delivered. */
  const work = { b: { planned: 12, actual: 5, items: [] } };
  const grid = cap.sprintGrid(twoPeople({ b: { calcExempt: true } }), { id: 'S1' }, bothDays, work);
  assert.strictEqual(grid.totals.planned, 12, 'work committed to an exempt member left the sprint');
  assert.strictEqual(grid.totals.actual, 5, 'and so did work they delivered');
  // Which is exactly the rule a released member already follows.
  const rel = cap.sprintGrid(twoPeople({ b: { status: 'Released' } }), { id: 'S1' }, bothDays, work);
  assert.strictEqual(rel.totals.planned, 12, 'the two have to agree, or one of them is wrong');
});

check('so the team reads as MORE loaded, which is the point of the toggle', () => {
  // Commit work to someone whose hours are not counted and the capacity being
  // planned against no longer covers it. That has to show.
  const work = { b: { planned: 12, actual: 0, items: [] } };
  const base = cap.sprintGrid(twoPeople(), { id: 'S1' }, bothDays, work);
  const grid = cap.sprintGrid(twoPeople({ b: { calcExempt: true } }), { id: 'S1' }, bothDays, work);
  assert.ok(grid.totals.workloadPct > base.totals.workloadPct,
    `exempting the person holding the work has to raise the load, got ${grid.totals.workloadPct} vs ${base.totals.workloadPct}`);
});

check('exempting EVERYONE leaves no capacity and no headcount, and does not divide by zero', () => {
  const grid = cap.sprintGrid(twoPeople({ a: { calcExempt: true }, b: { calcExempt: true } }),
    { id: 'S1' }, bothDays, { a: { planned: 3, actual: 0, items: [] } });
  assert.strictEqual(grid.totals.capacityHours, 0);
  assert.strictEqual(grid.totals.headcount, 0);
  assert.strictEqual(grid.totals.predicted, 0);
  assert.strictEqual(grid.totals.workloadPct, null, 'workload over zero hours is null, not Infinity');
  assert.strictEqual(grid.totals.planned, 3, 'the work is still committed');
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

/* ── CARRIED-IN WORK AND WHAT IT MEANS TO BE OVER ─────────────────────────
 *
 * The case: someone commits to their capacity, delivers 80% of it, and carries
 * the rest into the next sprint. The carried points are charged at full value
 * — the work still has to be done — so they start the sprint already loaded,
 * and the old flag called them overcommitted for having finished most of what
 * they took on.
 *
 * The points do not change. The sentence does.
 */

/* One person, full availability: 14 days x 7h - 9h ceremony = 89h, which at
   2.9 h/pt is 30 predicted points. The 110% line is therefore about 33.8 pts. */
const onePerson = () => ({
  id: 't', name: 'T', settings: { ceremonyHours: 9, hoursPerDay: 7, hoursPerPoint: 2.9 },
  members: [{ id: 'a', name: 'A', role: 'Auto QA', status: 'Active', supportPct: 0 }],
});
const load = (planned, carriedIn) => cap.sprintGrid(
  onePerson(), { id: 'S1' }, { a: new Array(14).fill('1') },
  { a: { planned, actual: 0, carriedIn, items: [], carriedInItems: [] } },
).rows[0];

check('THE COMMITTED NUMBER DOES NOT MOVE because work was carried in', () => {
  /* The one number everyone plans against, and the one that has to reconcile
     against Jira. Discounting carryover here would make it a number nobody
     could check. */
  const row = load(36, 10);
  assert.strictEqual(row.planned, 36, 'the commitment was quietly discounted');
  assert.strictEqual(row.carriedIn, 10);
  assert.strictEqual(row.newScope, 26, 'new scope is committed minus carried');
  assert.ok(row.workloadPct > 110, 'fixture check: this row has to be over the line');
});

check('AND BEING OVER BECAUSE OF CARRYOVER SAYS SO, instead of "overcommitted"', () => {
  const row = load(36, 10);                     // 36 over 30 predicted, 10 of it carried
  const flag = row.flags.find(f => f.code === 'carry-loaded');
  assert.ok(flag, `expected a carry-loaded flag, got ${row.flags.map(f => f.code).join(', ') || 'none'}`);
  assert.strictEqual(flag.level, 'risk', 'the hours really are over — it stays red');
  assert.match(flag.text, /10 pts carried in/, 'the flag does not say how much was carried');
  assert.ok(!row.flags.some(f => f.code === 'overloaded'),
    'it was flagged as overcommitted as well, so the screen says both things');
});

check('NEW SCOPE LANDING EXACTLY ON THE LINE IS WITHIN CAPACITY, not over it', () => {
  /* The boundary, which is where this kind of bug lives. `workloadOverPct` is
     the threshold work must EXCEED to be overcommitted — 110% is not over 110%
     — so new scope sitting exactly on it has not over-committed either, and
     the carry explanation applies. An off-by-one here is invisible except to
     the one person a fortnight who lands on the number.

     Arranged so the boundary is a whole number rather than 33.7586 pts: one
     hour a day, one hour a point, no ceremonies, and the line at 100%. */
  const team = {
    id: 't', name: 'T',
    settings: { hoursPerDay: 1, hoursPerPoint: 1, ceremonyHours: 0, workloadOverPct: 100, workloadUnderPct: 50 },
    members: [{ id: 'a', name: 'A', role: 'Auto QA', status: 'Active', supportPct: 0 }],
  };
  const at = cap.sprintGrid(team, { id: 'S1' }, { a: new Array(14).fill('1') },
    { a: { planned: 20, actual: 0, carriedIn: 6, items: [], carriedInItems: [] } }).rows[0];
  assert.strictEqual(at.capacityHours, 14, 'fixture check: capacity should be 14 h');
  assert.strictEqual(at.newScope, 14, 'fixture check: new scope has to land exactly on the line');
  assert.ok(at.workloadPct > 100, 'fixture check: the row must be over overall');
  assert.ok(at.flags.some(f => f.code === 'carry-loaded'),
    `new scope exactly at the threshold is not over it: ${at.flags.map(f => f.code).join(', ')}`);

  // And one point past the line is over it, carryover or not.
  const past = cap.sprintGrid(team, { id: 'S1' }, { a: new Array(14).fill('1') },
    { a: { planned: 21, actual: 0, carriedIn: 6, items: [], carriedInItems: [] } }).rows[0];
  assert.ok(past.flags.some(f => f.code === 'overloaded'),
    'new scope a point past the line must still be overcommitted');
});

check('BUT SOMEONE OVER ON NEW SCOPE ALONE IS STILL OVERCOMMITTED', () => {
  /* The guard that keeps this honest. Carryover explains being over; it does
     not excuse it. Someone who carries work AND takes on a full new load has
     over-committed, and hiding that behind the gentler sentence is how a
     chronic problem stops being visible. */
  const row = load(40, 4);                      // 36 pts of NEW scope, still over on its own
  assert.ok(row.flags.some(f => f.code === 'overloaded'),
    `new scope alone is over capacity and must still say so: ${row.flags.map(f => f.code).join(', ')}`);
  assert.ok(!row.flags.some(f => f.code === 'carry-loaded'));
  assert.match(row.flags.find(f => f.code === 'overloaded').text, /4 of it carried in/,
    'even then the carried share is worth naming');
});

check('AND WITH NO CARRYOVER THE OLD SENTENCE IS UNCHANGED', () => {
  const row = load(40, 0);
  const flag = row.flags.find(f => f.code === 'overloaded');
  assert.ok(flag, 'a plainly overcommitted row stopped being flagged');
  assert.match(flag.text, /Overcommitted at/);
  assert.ok(!/carried in/.test(flag.text), 'it mentions carryover where there is none');
});

check('CARRYOVER DOES NOT INVENT A FLAG ON A ROW THAT IS WITHIN CAPACITY', () => {
  const row = load(28, 10);                     // under the line, carried or not
  assert.ok(!row.flags.some(f => f.code === 'carry-loaded' || f.code === 'overloaded'),
    `a row inside capacity was flagged: ${row.flags.map(f => f.code).join(', ')}`);
});

check('THE GRID TOTALS CARRY IT TOO, with a new-scope workload beside the real one', () => {
  const grid = cap.sprintGrid(
    onePerson(), { id: 'S1' }, { a: new Array(14).fill('1') },
    { a: { planned: 36, actual: 0, carriedIn: 10, items: [], carriedInItems: [] } },
  );
  assert.strictEqual(grid.totals.planned, 36, 'the team commitment moved');
  assert.strictEqual(grid.totals.carriedIn, 10);
  assert.strictEqual(grid.totals.newScope, 26);
  assert.ok(grid.totals.workloadPct > grid.totals.newScopeWorkloadPct,
    'the two workload figures are the same, so one of them is not what it claims');
  assert.ok(grid.totals.newScopeWorkloadPct > 0, 'new-scope workload came out empty');
});

check('A MEMBER WITH NO CARRYOVER DATA AT ALL STILL WORKS', () => {
  /* Every caller that has not been taught about carryover yet — the forecast,
     the scenario grid — passes `work` without it. Those must read as zero
     rather than NaN, which would propagate into the workload percentage and
     paint the row grey. */
  const row = cap.sprintGrid(onePerson(), { id: 'S1' }, { a: new Array(14).fill('1') },
    { a: { planned: 20, actual: 5 } }).rows[0];
  assert.strictEqual(row.carriedIn, 0);
  assert.strictEqual(row.newScope, 20);
  assert.deepStrictEqual(row.carriedInItems, []);
  assert.ok(Number.isFinite(row.workloadPct));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
