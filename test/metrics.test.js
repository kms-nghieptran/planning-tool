'use strict';
/**
 * metrics.test.js — the reports.
 *
 * Coverage is asserted against the definition already agreed for iPipeline, using
 * the real bucket counts from the 2026-09-08 sample so a change to the formula
 * shows up as a number the team recognises.
 *
 * Run: node test/metrics.test.js
 */

const assert = require('node:assert');
const m = require('../lib/metrics');
const r = require('../lib/reconcile');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

const epic = (status, components = ['R&D_Sig_Regression']) => ({
  issueType: 'Epic', automationStatus: status, components,
  status: 'Open', statusCategory: 'new', labels: [], sprints: [], sprintNames: [],
});

/** Build a snapshot holding exactly these bucket counts. */
function epics(counts, components) {
  const issues = {};
  let n = 0;
  for (const [status, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i++) issues[`E-${n++}`] = { key: `E-${n}`, ...epic(status === 'null' ? null : status, components) };
  }
  return { issues };
}

console.log('\nReports: coverage, velocity, productivity, quality\n');

/* ── coverage, against the agreed definition ──────────────────────────── */

check("the sample's buckets reproduce the agreed 76.4% / 63.1%", () => {
  // Nghiep's 2026-09-08 sample: the five buckets sum to 2,975 of 3,444 epics —
  // the other 469 carry no Automation Status.
  const snap = epics({
    Automated: 1852, Maintenance: 321, 'N/A for Automation': 132,
    'Ready for Automation': 525, Blocked: 145, null: 469,
  });
  const c = m.coverage({ teams: [] }, snap);
  assert.strictEqual(c.total, 3444);
  assert.strictEqual(c.untriaged, 469, 'the gap must be its own bucket, not silently dropped');
  assert.strictEqual(c.coveragePct, 76.4, 'coverage of everything automatable');
  assert.strictEqual(c.coverageOfAllPct, 63.1, 'coverage of all epics');
});

check('maintenance counts as covered — it is automated, just being fixed', () => {
  const c = m.coverage({ teams: [] }, epics({ Automated: 8, Maintenance: 2, 'Ready for Automation': 10 }));
  assert.strictEqual(c.covered, 10);
  assert.strictEqual(c.coveragePct, 50);
});

check('N/A and untriaged epics stay OUT of the ratio', () => {
  const withNoise = m.coverage({ teams: [] }, epics({ Automated: 5, 'Ready for Automation': 5, 'N/A for Automation': 90, null: 90 }));
  const clean = m.coverage({ teams: [] }, epics({ Automated: 5, 'Ready for Automation': 5 }));
  assert.strictEqual(withNoise.coveragePct, clean.coveragePct, 'noise must not move the headline');
  assert.strictEqual(withNoise.coveragePct, 50);
  assert.ok(withNoise.caveat && /no Automation Status/.test(withNoise.caveat), 'and the exclusion must be stated');
});

check('an unrecognised status value surfaces by name instead of vanishing', () => {
  const c = m.coverage({ teams: [] }, epics({ Automated: 4, 'Partially Automated': 3 }));
  assert.strictEqual(c.untriaged, 3);
  assert.deepStrictEqual(c.unmappedValues, [{ value: 'Partially Automated', count: 3 }]);
});

check('status matching is case-insensitive', () => {
  const c = m.coverage({ teams: [] }, epics({ AUTOMATED: 3, 'ready for automation': 1 }));
  assert.strictEqual(c.coveragePct, 75);
  assert.strictEqual(c.untriaged, 0);
});

check('Katalon and TrueTest leave the GRID but stay in the headline', () => {
  const snap = { issues: {} };
  let n = 0;
  const add = (status, comp) => { snap.issues[`E${n++}`] = { key: `E${n}`, ...epic(status, [comp]) }; };
  for (let i = 0; i < 6; i++) add('Automated', 'R&D_Sig_Regression');
  for (let i = 0; i < 4; i++) add('Ready for Automation', 'Katalon');
  const c = m.coverage({ teams: [] }, snap);
  assert.strictEqual(c.total, 10);
  assert.strictEqual(c.coveragePct, 60, 'tooling still counts in the ratio');
  assert.ok(!c.byComponent.some(x => x.component === 'Katalon'), 'but not in the grid');
  assert.deepStrictEqual(c.hiddenFromGrid, [{ component: 'Katalon', epics: 4 }], 'and it is named, not hidden silently');
});

check('an epic with several components counts in each', () => {
  const snap = { issues: { A: { key: 'A', ...epic('Automated', ['R&D_iGO_E2E', 'PS_iGO_Nationwide']) } } };
  const c = m.coverage({ teams: [] }, snap);
  assert.strictEqual(c.total, 1);
  assert.strictEqual(c.byComponent.length, 2);
  assert.strictEqual(c.byComponent.reduce((t, x) => t + x.total, 0), 2, 'column totals exceed the epic count, by design');
});

check('components roll up into the three families the team reports on', () => {
  const snap = { issues: {} };
  let n = 0;
  for (const comp of ['R&D_Sig_Regression', 'PS_iGO_Nationwide', 'KAT_Common_Maintenance', 'Something_Else']) {
    snap.issues[`E${n++}`] = { key: `E${n}`, ...epic('Automated', [comp]) };
  }
  const fams = m.coverage({ teams: [] }, snap).byFamily.map(f => f.family).sort();
  assert.deepStrictEqual(fams, ['KAT — framework & common', 'Other', 'PS — client delivery', 'R&D — product regression']);
});

check('an epic with no component is bucketed, not dropped', () => {
  const c = m.coverage({ teams: [] }, { issues: { A: { key: 'A', ...epic('Automated', []) } } });
  assert.strictEqual(c.byComponent[0].component, '— no component —');
});

check('coverage is null rather than 0 when nothing is automatable', () => {
  const c = m.coverage({ teams: [] }, epics({ 'N/A for Automation': 5 }));
  assert.strictEqual(c.coveragePct, null, 'a made-up 0% is worse than an honest blank');
});

/* ── delivery metrics ─────────────────────────────────────────────────── */

const TEAM = {
  id: 't1', name: 'Team One', sprintKeywords: ['one'],
  settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 },
  members: [
    { id: 'a', name: 'A', role: 'Auto QA', status: 'Active', supportPct: 0, jiraAccountId: 'acc-a' },
    { id: 'b', name: 'B', role: 'Auto QA', status: 'Active', supportPct: 0, jiraAccountId: 'acc-b' },
  ],
};
const full = new Array(14).fill('1').map((c, i) => ([2, 3, 9, 10].includes(i) ? 'WO' : c));

/** A plan + snapshot with `spec` = [{ number, committed, delivered }]. */
function delivery(spec) {
  const plan = {
    teams: [TEAM], sprints: [], availability: {}, support: {}, ceremony: {},
    overrides: {}, notes: {}, holidays: [], risks: [],
  };
  const snap = { issues: {}, boardSprintsByTeam: { t1: [] } };
  let k = 0;
  for (const s of spec) {
    const start = new Date(Date.UTC(2026, 0, 1)); start.setUTCDate(start.getUTCDate() + (s.number - 1) * 14);
    const end = new Date(start.getTime() + 13 * 864e5);
    snap.boardSprintsByTeam.t1.push({
      id: String(500 + s.number), name: `Team One Sprint ${s.number}`,
      state: s.state || 'closed', start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10),
    });
    plan.sprints.push({ id: `S${s.number}`, number: s.number, name: `Sprint ${s.number}`, start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) });
    for (const mem of TEAM.members) plan.availability[`t1|S${s.number}|${mem.id}`] = full;

    const mk = (pts, done, extra = {}) => {
      const key = `X-${k++}`;
      snap.issues[key] = {
        key, summary: extra.summary || 'work', issueType: extra.issueType || 'Story',
        status: done ? 'Done' : 'Open', statusCategory: done ? 'done' : 'new',
        assignee: 'A', assigneeId: 'acc-a', labels: extra.labels || [], components: ['C1'],
        points: pts, sprints: [{ id: String(500 + s.number), name: `Team One Sprint ${s.number}` }],
        sprintNames: [`Team One Sprint ${s.number}`], blockedBy: [],
        created: extra.created || start.toISOString(), updated: end.toISOString(),
        resolved: done ? end.toISOString() : null, priority: 'Medium',
      };
    };
    if (s.delivered) mk(s.delivered, true, s.extra);
    if (s.committed - (s.delivered || 0) > 0) mk(s.committed - s.delivered, false);
  }
  r.reconcileSprints(plan, snap);
  snap.byTeam = r.buildTeamIndex(plan, snap);
  return { plan, snap };
}

check('velocity averages the last six completed sprints', () => {
  const { plan, snap } = delivery([1, 2, 3, 4, 5, 6, 7].map(n => ({ number: n, committed: 10, delivered: n <= 1 ? 100 : 10 })));
  const v = m.velocity(plan, snap, TEAM);
  assert.strictEqual(v.average, 10, 'the ancient 100-pt outlier is outside the 6-sprint window');
  assert.strictEqual(v.best, 100);
});

check('safe commitment sits below the average when delivery is erratic', () => {
  const steady = delivery([1, 2, 3, 4].map(n => ({ number: n, committed: 20, delivered: 20 })));
  const erratic = delivery([{ number: 1, committed: 20, delivered: 5 }, { number: 2, committed: 20, delivered: 35 },
                            { number: 3, committed: 20, delivered: 6 }, { number: 4, committed: 20, delivered: 34 }]);
  const a = m.velocity(steady.plan, steady.snap, TEAM);
  const b = m.velocity(erratic.plan, erratic.snap, TEAM);
  assert.strictEqual(a.average, b.average, 'same mean');
  assert.ok(b.safeCommitment < a.safeCommitment, 'but the erratic team should be asked for less');
});

check('attainment is delivered ÷ committed, and short sprints are counted', () => {
  const { plan, snap } = delivery([
    { number: 1, committed: 10, delivered: 10 },
    { number: 2, committed: 10, delivered: 5 },
    { number: 3, committed: 10, delivered: 10 },
  ]);
  const q = m.quality(plan, snap, TEAM);
  assert.strictEqual(q.attainment, 83.3);
  assert.strictEqual(q.missedSprints, 1);
});

check('carryover is reported per sprint and never negative', () => {
  const { plan, snap } = delivery([
    { number: 1, committed: 10, delivered: 4 },
    { number: 2, committed: 10, delivered: 10 },
  ]);
  const q = m.quality(plan, snap, TEAM);
  assert.strictEqual(q.carryover.find(c => c.number === 1).carried, 6);
  assert.strictEqual(q.carryover.find(c => c.number === 2).carried, 0);
  assert.ok(q.carryover.every(c => c.carried >= 0));
});

check('rework share is the maintenance slice of delivered work', () => {
  const { plan, snap } = delivery([
    { number: 1, committed: 10, delivered: 10, extra: { labels: ['Maintenance'] } },
    { number: 2, committed: 10, delivered: 10 },
  ]);
  const q = m.quality(plan, snap, TEAM);
  assert.strictEqual(q.reworkShare, 50);
  assert.strictEqual(q.reworkPoints, 10);
});

check('productivity reports per-person output and throughput', () => {
  const { plan, snap } = delivery([1, 2].map(n => ({ number: n, committed: 20, delivered: 20 })));
  const p = m.productivity(plan, snap, TEAM);
  assert.strictEqual(p.perSprint.length, 2);
  assert.strictEqual(p.perSprint[0].headcount, 2);
  assert.strictEqual(p.perSprint[0].perPerson, 10);
  assert.strictEqual(p.avgThroughput, 1, 'one delivered item per sprint in this fixture');
  assert.ok(/not a performance rating/.test(p.caveat), 'the caveat must travel with the number');
});

check('cycle time is the median of created→resolved, ignoring absurd values', () => {
  assert.strictEqual(m.median([1, 2, 3]), 2);
  assert.strictEqual(m.median([1, 2, 3, 4]), 2.5);
  assert.strictEqual(m.cycleTime({ created: '2026-01-01T00:00:00Z', resolved: '2026-01-11T00:00:00Z' }), 10);
  assert.strictEqual(m.cycleTime({ created: null, resolved: '2026-01-11T00:00:00Z' }), null);
});

/* ── backlog health ───────────────────────────────────────────────────── */

check('ready to plan means estimated AND not blocked', () => {
  const { plan, snap } = delivery([{ number: 1, committed: 10, delivered: 10 }]);
  snap.issues['B-1'] = { key: 'B-1', summary: 'ready', issueType: 'Story', status: 'Open', statusCategory: 'new', points: 5, components: [], labels: [], sprints: [], sprintNames: [], blockedBy: [] };
  snap.issues['B-2'] = { key: 'B-2', summary: 'no estimate', issueType: 'Story', status: 'Open', statusCategory: 'new', points: null, components: [], labels: [], sprints: [], sprintNames: [], blockedBy: [] };
  snap.issues['B-3'] = { key: 'B-3', summary: 'blocked', issueType: 'Story', status: 'Open', statusCategory: 'new', points: 8, components: [], labels: [], sprints: [], sprintNames: [], blockedBy: ['X-1'] };
  snap.boardBacklogByTeam = { t1: ['B-1', 'B-2', 'B-3'] };
  snap.byTeam = r.buildTeamIndex(plan, snap);

  const b = m.backlogHealth(plan, snap, TEAM);
  assert.strictEqual(b.total, 3);
  assert.strictEqual(b.ready.count, 1, 'only B-1 is both estimated and unblocked');
  assert.strictEqual(b.ready.points, 5);
  assert.strictEqual(b.unestimated.count, 1);
  assert.strictEqual(b.blocked.count, 1);
});

check('runway is points ÷ velocity, and null without velocity history', () => {
  const { plan, snap } = delivery([{ number: 1, committed: 10, delivered: 10 }]);
  snap.issues['B-1'] = { key: 'B-1', summary: 'x', issueType: 'Story', status: 'Open', statusCategory: 'new', points: 20, components: [], labels: [], sprints: [], sprintNames: [], blockedBy: [] };
  snap.boardBacklogByTeam = { t1: ['B-1'] };
  snap.byTeam = r.buildTeamIndex(plan, snap);
  const b = m.backlogHealth(plan, snap, TEAM);
  assert.strictEqual(b.avgVelocity, 10);
  assert.strictEqual(b.runway, 2);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
