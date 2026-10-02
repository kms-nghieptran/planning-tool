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
const insights = require('../lib/insights');
const backlogLib = require('../lib/backlog-item');

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

check('carryover separates what was HANDED ON from what merely was not delivered', () => {
  /* These used to be one number, and the one number was the proxy: committed
     minus delivered, which assumes every undelivered point moved to the next
     sprint. In this fixture nothing moves — sprint 1 simply fails to finish 6
     points and they leave the plan. The proxy calls that 6 points of
     carryover; it is 6 points of shortfall and zero points of carryover, and
     the gap between the two is work that disappeared without being delivered.

     Both are reported. `shortfall` is what every report written from this
     number has meant until now; `carried` is what it claimed to mean. */
  const { plan, snap } = delivery([
    { number: 1, committed: 10, delivered: 4 },
    { number: 2, committed: 10, delivered: 10 },
  ]);
  const q = m.quality(plan, snap, TEAM);
  const one = q.carryover.find(c => c.number === 1);
  assert.strictEqual(one.shortfall, 6, 'the undelivered points are still reported');
  assert.strictEqual(one.carried, 0, 'nothing moved to a later sprint, so nothing was carried');
  assert.strictEqual(one.measured, true, 'a dated sprint must say its carryover was measured');
  assert.strictEqual(q.carryover.find(c => c.number === 2).carried, 0);
  assert.ok(q.carryover.every(c => c.carried >= 0 && c.shortfall >= 0));
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
  /* WHAT "BLOCKED" IS HERE CHANGED, and this fixture was encoding the old
     answer. It used to be `(i.blockedBy || []).length` — Jira's own link on
     the item — and seven of the 5,418 non-epic issues in his store have one.
     So this KPI read "0 blocked" for every team while 32 of Ruby's queue and
     195 of Titan's sat in Refinement, and every estimated item was counted as
     ready to plan, which is the figure the runway forecast is built on.

     Now it is `insights.isBlocked`: in Refinement, or marked Blocked for
     automation. B-3 keeps its link and is NOT blocked by it, which is the
     point — that link is read on the EPIC by `epics.blockersFor`, and
     counting it here too would represent one fact twice. */
  const { plan, snap } = delivery([{ number: 1, committed: 10, delivered: 10 }]);
  const row = (key, o) => ({
    key, summary: key, issueType: 'Story', status: 'Open', statusCategory: 'new',
    points: 5, components: [], labels: [], sprints: [], sprintNames: [], blockedBy: [], ...o,
  });
  snap.issues['B-1'] = row('B-1', {});                                        // ready
  snap.issues['B-2'] = row('B-2', { points: null });                          // no estimate
  snap.issues['B-3'] = row('B-3', { points: 8, blockedBy: ['X-1'] });         // a link, and NOT blocked
  snap.issues['B-4'] = row('B-4', { points: 3, status: 'Refinement' });       // blocked: the column
  snap.issues['B-5'] = row('B-5', { points: 2, automationStatus: 'Blocked' }); // blocked: the field
  snap.issues['B-6'] = row('B-6', { points: 2, automationStatus: 'Ready for Automation' }); // ready
  snap.boardBacklogByTeam = { t1: ['B-1', 'B-2', 'B-3', 'B-4', 'B-5', 'B-6'] };
  snap.byTeam = r.buildTeamIndex(plan, snap);

  const b = m.backlogHealth(plan, snap, TEAM);
  assert.strictEqual(b.total, 6);
  assert.strictEqual(b.blocked.count, 2, 'the Blocked KPI does not count both signals');
  const blocked = b.blocked.items.map(i => i.key).sort();
  assert.deepStrictEqual(blocked, ['B-4', 'B-5'],
    `the Blocked KPI counted ${JSON.stringify(blocked)} — a bare "is blocked by" link is not the signal here`);
  assert.strictEqual(b.ready.count, 3, 'B-1, B-3 and B-6 are estimated and unblocked');
  assert.strictEqual(b.ready.points, 15);
  assert.strictEqual(b.unestimated.count, 1);
});

check('THE BLOCKED LIST IS THE WHOLE SET, not the first 50', () => {
  /* It was capped when nothing read it. The Blocked KPI now opens a drawer
     built from exactly these keys, and Titan's queue holds 195 of them — a
     cap puts "195" over a list of 50 with nothing on screen to say why, which
     is the failure every drill-in on this tool exists to prevent.

     Sixty rows, because fifty would pass against the cap itself. */
  const { plan, snap } = delivery([{ number: 1, committed: 10, delivered: 10 }]);
  const keys = [];
  for (let n = 0; n < 60; n++) {
    const key = `BLK-${String(n).padStart(3, '0')}`;
    keys.push(key);
    snap.issues[key] = {
      key, summary: key, issueType: 'Story', status: 'Refinement', statusCategory: 'new',
      points: 1, components: [], labels: [], sprints: [], sprintNames: [], blockedBy: [],
    };
  }
  snap.boardBacklogByTeam = { t1: keys };
  snap.byTeam = r.buildTeamIndex(plan, snap);

  const b = m.backlogHealth(plan, snap, TEAM);
  assert.strictEqual(b.blocked.count, 60, 'fixture check: all sixty are blocked');
  assert.strictEqual(b.blocked.items.length, b.blocked.count,
    `the KPI counts ${b.blocked.count} and ships ${b.blocked.items.length} keys — the drawer cannot list what it was not sent`);
});

check('EVERY SPRINT SECTION ROW CARRIES A CATEGORY', () => {
  /* THE BLANK-COLUMN BUG. The queue gets its category from `backlogHealth`,
     which maps each item through `cls.classify` on the way out; the sprint
     sections were reading the snapshot straight and arrived with no
     `category` at all. On screen that is an empty cell in the column the
     reader uses to tell new build from maintenance — which looks like
     "uncategorised work", a real state, and the wrong answer.

     Checked against the QUEUE's own classification rather than a hard-coded
     label, because the point is not which category each row gets; it is that
     the two halves of one screen are classified by the same rule. */
  const { plan, snap } = delivery([{ number: 1, committed: 10, delivered: 10, state: 'active' }]);
  const row = (key, o) => ({
    key, summary: key, issueType: 'Story', status: 'Open', statusCategory: 'new',
    points: 5, components: [], labels: [], sprints: [], sprintNames: [], blockedBy: [], ...o,
  });
  /* A SECTION NEEDS AN OPEN SPRINT WITH A JIRA ID — the same two conditions
     the board applies, stated here rather than hoped for, so a fixture that
     stops meeting them fails on the line above rather than as a silent zero. */
  const sp = plan.sprints[0];
  const jiraId = '501';
  sp.byTeam = { [TEAM.id]: { jiraId, name: sp.name, state: 'active' } };
  snap.issues['P-1'] = row('P-1', { sprints: [{ id: jiraId, name: sp.name, state: 'active' }] });
  snap.issues['P-2'] = row('P-2', { issueType: 'Bucket Story', sprints: [{ id: jiraId, name: sp.name, state: 'active' }] });
  snap.boardBacklogByTeam = { t1: [] };
  snap.byTeam = r.buildTeamIndex(plan, snap);

  const board = insights.backlogBoard(plan, snap, TEAM);
  const rows = board.sections.flatMap(s => s.items);
  assert.ok(rows.length >= 2, `fixture check: the sprint sections hold ${rows.length} rows`);
  for (const i of rows) {
    assert.ok(i.category, `${i.key} reached the sprint section with no category, so its cell draws blank`);
  }

  /* AND THE SAME RULE AS THE QUEUE. Classifying with a second copy of the
     rules is how one screen comes to call a Bucket Story maintenance and the
     other call it new. */
  const cls = require('../lib/classify');
  for (const i of rows) {
    assert.strictEqual(i.category, cls.classify(snap.issues[i.key], plan.categoryRules),
      `${i.key} is classified differently in the sprint section than everywhere else`);
  }
});

check('AN EPIC IS NOT A BACKLOG ITEM, on this page either', () => {
  /* THE 1,857 DEFECT. The Backlog screen and the Backlog view read the same
     index through two different pieces of code, and an epic filter added to
     one of them leaves the other reporting the old number — which is exactly
     how Titan's page claimed 1,857 items and seven sprints of runway when
     574 items and two sprints was the truth. */
  const { plan, snap } = delivery([{ number: 1, committed: 10, delivered: 10 }]);
  const item = (key, o) => ({
    key, summary: key, issueType: 'Story', status: 'Open', statusCategory: 'new',
    points: 5, components: [], labels: [], sprints: [], sprintNames: [], blockedBy: [], ...o,
  });
  snap.issues['B-1'] = item('B-1');
  // Estimated epics, so a leak shows in the points and the runway too, not
  // only in the count.
  snap.issues['E-1'] = item('E-1', { issueType: 'Epic', points: 21 });
  snap.issues['E-2'] = item('E-2', { issueType: 'Epic', points: 13 });
  snap.boardBacklogByTeam = { t1: ['B-1', 'E-1', 'E-2'] };
  snap.byTeam = r.buildTeamIndex(plan, snap);

  const b = m.backlogHealth(plan, snap, TEAM);
  assert.strictEqual(b.total, 1, 'the page still counts epics as backlog items');
  assert.strictEqual(b.points, 5, 'and still adds their points into the runway');
  assert.strictEqual(b.ready.count, 1);
  // Counted rather than dropped in silence — a figure that falls by two
  // thirds has to explain itself.
  assert.strictEqual(b.epicsExcluded, 2, 'the page cannot say how many it removed');
  assert.strictEqual(b.scanned, 3, 'nor what it started from');
  assert.strictEqual(b.scanned, b.total + b.epicsExcluded, 'the two numbers do not reconcile');
});

check('EVERY READER OF THE BACKLOG AGREES ON WHAT IT COUNTS', () => {
  /* THE 1,877-vs-594 DEFECT, and the check that would have caught it.
     The same index has four readers — the Backlog view's list, this page's
     KPIs, the team index the SIDEBAR shows, and reconcile's own setup
     summary. Fixing two of them left the sidebar 1,283 ahead of the page,
     which is the worst version: both numbers on screen at once, neither
     wrong-looking alone, and the one a reader trusts is whichever they saw
     first. They now share `lib/backlog-item.js`, and this compares them. */
  const { plan, snap } = delivery([{ number: 1, committed: 10, delivered: 10 }]);
  const item = (key, o) => ({
    key, summary: key, issueType: 'Story', status: 'Open', statusCategory: 'new',
    points: 5, components: [], labels: [], sprints: [], sprintNames: [], blockedBy: [], ...o,
  });
  snap.issues['B-1'] = item('B-1');
  snap.issues['B-2'] = item('B-2', { points: 3 });
  snap.issues['E-1'] = item('E-1', { issueType: 'Epic', points: 21 });
  snap.issues['E-2'] = item('E-2', { issueType: 'Epic', points: 13 });
  snap.boardBacklogByTeam = { t1: ['B-1', 'B-2', 'E-1', 'E-2'] };
  snap.byTeam = r.buildTeamIndex(plan, snap);

  const page = m.backlogHealth(plan, snap, TEAM);
  const view = insights.backlogView(plan, snap, { teamId: TEAM.id }).teams[0];
  const idx = snap.byTeam[TEAM.id];

  assert.strictEqual(page.total, 2, 'the page counts epics');
  assert.strictEqual(view.count, 2, 'the view counts epics');
  assert.strictEqual(idx.backlogCount, 2, 'the SIDEBAR counts epics');
  assert.strictEqual(idx.backlogPoints, 8, 'and adds their points into the sidebar total');
  // The three agree — which is the property, not the individual numbers.
  assert.strictEqual(page.total, view.count, 'the page and the view disagree');
  assert.strictEqual(page.total, idx.backlogCount, 'the page and the sidebar disagree');
  assert.strictEqual(page.points, idx.backlogPoints, 'their points disagree');

  // And each says what it left out, so a count that fell can explain itself.
  assert.strictEqual(idx.backlogEpics, 2);
  assert.strictEqual(idx.backlogScanned, 4);
  assert.strictEqual(page.epicsExcluded, 2);
  assert.strictEqual(view.epicsExcluded, 2);
  // The RAW list stays raw: `backlogSource: 'board'` is a claim about it.
  assert.strictEqual((idx.backlog || []).length, 4, 'the board\'s own list was rewritten');

  /* AND THE SIDEBAR'S OWN READ AGREES — the figures the bootstrap route
     computes at READ time, which is what makes a correction land before the
     next full sync rather than after it. */
  const side = backlogLib.figuresFor(snap, idx);
  assert.strictEqual(side.count, page.total, 'the sidebar read disagrees with the page');
  assert.strictEqual(side.points, page.points);
  assert.strictEqual(side.scanned, 4);
  assert.strictEqual(side.excluded, 2);
});

check('AND IT IS RIGHT BEFORE A RE-SYNC, off a STALE index', () => {
  /* The whole reason the count is computed at read time. An index written by
     an older build carries the old `backlogCount`; the sidebar must not show
     it. Simulated by writing the pre-fix numbers back onto the index. */
  const { plan, snap } = delivery([{ number: 1, committed: 10, delivered: 10 }]);
  const item = (key, o) => ({
    key, summary: key, issueType: 'Story', status: 'Open', statusCategory: 'new',
    points: 5, components: [], labels: [], sprints: [], sprintNames: [], blockedBy: [], ...o,
  });
  snap.issues['B-1'] = item('B-1');
  snap.issues['E-1'] = item('E-1', { issueType: 'Epic', points: 21 });
  snap.boardBacklogByTeam = { t1: ['B-1', 'E-1'] };
  snap.byTeam = r.buildTeamIndex(plan, snap);
  // What a pre-fix sync would have stored.
  snap.byTeam[TEAM.id].backlogCount = 2;
  snap.byTeam[TEAM.id].backlogPoints = 26;

  const side = backlogLib.figuresFor(snap, snap.byTeam[TEAM.id]);
  assert.strictEqual(side.count, 1, 'the sidebar read the stale stored count');
  assert.strictEqual(side.points, 5, 'and the stale stored points');
});

check('THE BOARD FILTER REACHES THE BACKLOG PAYLOAD, index and all', () => {
  /* The Backlog screen opens the whole queue as a Jira search on the board's
     saved filter, because a key list runs out of URL — 892 keys opened 393.
     That link exists only if the filter id survives two hops nobody watches:
     the sync writes `boardFilterByTeam` onto the snapshot, `buildTeamIndex`
     copies it to the team, and `backlogHealth` passes it out. Break either
     hop and the screen falls back to a board view or a truncated key list,
     which is a downgrade with nothing on screen to show for it. */
  const { plan, snap } = delivery([{ number: 1, committed: 10, delivered: 10 }]);
  snap.issues['B-1'] = { key: 'B-1', summary: 'x', issueType: 'Story', status: 'Open', statusCategory: 'new', points: 3, components: [], labels: [], sprints: [], sprintNames: [], blockedBy: [] };
  snap.boardBacklogByTeam = { t1: ['B-1'] };
  snap.boardFilterByTeam = { t1: { filterId: 12345, type: 'scrum', boardId: 1961 } };
  snap.byTeam = r.buildTeamIndex(plan, snap);

  assert.deepStrictEqual(snap.byTeam.t1.boardFilter, { filterId: 12345, type: 'scrum', boardId: 1961 },
    'buildTeamIndex dropped the board filter');
  const b = m.backlogHealth(plan, snap, TEAM);
  assert.ok(b.boardFilter, 'backlogHealth did not pass the board filter out');
  assert.strictEqual(b.boardFilter.filterId, 12345);
});

check('and a team with no filter read yet reports null, not a broken one', () => {
  /* The state before the next full sync. It has to be a clean absence so the
     screen falls back, rather than something that builds `filter = undefined`
     and returns a Jira error page. */
  const { plan, snap } = delivery([{ number: 1, committed: 10, delivered: 10 }]);
  snap.issues['B-1'] = { key: 'B-1', summary: 'x', issueType: 'Story', status: 'Open', statusCategory: 'new', points: 3, components: [], labels: [], sprints: [], sprintNames: [], blockedBy: [] };
  snap.boardBacklogByTeam = { t1: ['B-1'] };
  snap.byTeam = r.buildTeamIndex(plan, snap);
  assert.strictEqual(snap.byTeam.t1.boardFilter, null, 'a missing filter should be null, not undefined');
  assert.strictEqual(m.backlogHealth(plan, snap, TEAM).boardFilter, null);
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

/* ═══════════ the reporting window: active + N-1 most recently closed ═══════ */

/**
 * WHAT "4 SPRINTS" MEANS.
 *
 * Nghiep's definition: the sprint you are IN, plus the 3 most recently closed.
 * It counts backwards from the active sprint and stops there.
 *
 * What it did before took the last N by date order out of every sprint the plan
 * knew — so on his real data a 4-sprint window was Sprint 38 (closed), 39
 * (active), 40 and 41 (PLANNED). Half the window was work that had not
 * happened, and because a planned sprint carries a commitment and no delivery,
 * it dragged every average towards zero while looking perfectly reasonable.
 */

/** Three closed, one active, two planned — the shape his teams are always in. */
const WINDOWED = [
  { number: 1, committed: 10, delivered: 10, state: 'closed' },
  { number: 2, committed: 10, delivered: 20, state: 'closed' },
  { number: 3, committed: 10, delivered: 30, state: 'closed' },
  { number: 4, committed: 10, delivered: 40, state: 'closed' },
  { number: 5, committed: 40, delivered: 10, state: 'active' },   // half done
  { number: 6, committed: 10, delivered: 0, state: 'future' },
  { number: 7, committed: 10, delivered: 0, state: 'future' },
];

const names = (plan, ids) => ids.map(id => (plan.sprints.find(s => s.id === id) || {}).number);

check('A 4-SPRINT WINDOW IS THE ACTIVE SPRINT PLUS THE 3 MOST RECENTLY CLOSED', () => {
  const { plan } = delivery(WINDOWED);
  const w = m.windowSprints(plan, TEAM, 4);
  assert.deepStrictEqual(names(plan, w.ids), [2, 3, 4, 5], `got sprints ${names(plan, w.ids)}`);
  assert.strictEqual(w.active, 'S5');
  assert.strictEqual(w.closed, 3, 'three closed plus the active one');
});

check('A PLANNED SPRINT IS NEVER IN THE WINDOW', () => {
  // The defect this replaced. Sprints 6 and 7 have commitments and no delivery;
  // including them reports on work nobody has done.
  const { plan } = delivery(WINDOWED);
  for (const n of [2, 4, 6, 12]) {
    const ids = names(plan, m.windowSprints(plan, TEAM, n).ids);
    assert.ok(!ids.includes(6) && !ids.includes(7), `window ${n} reached a future sprint: ${ids}`);
  }
});

check('NOR A PLANNED SPRINT THAT SORTS BEFORE THE ACTIVE ONE', () => {
  // Real boards carry these: a sprint created and dated, never started, sitting
  // between closed ones. "Everything before the active sprint" would sweep it
  // in, and it has a commitment and no delivery — the exact shape that drags an
  // average down while looking like history.
  const { plan } = delivery([
    { number: 1, committed: 10, delivered: 10, state: 'closed' },
    { number: 2, committed: 10, delivered: 0, state: 'future' },   // never ran
    { number: 3, committed: 10, delivered: 30, state: 'closed' },
    { number: 4, committed: 10, delivered: 5, state: 'active' },
  ]);
  const ids = names(plan, m.windowSprints(plan, TEAM, 3).ids);
  assert.deepStrictEqual(ids, [1, 3, 4], `the stalled sprint 2 must be skipped, got ${ids}`);
});

check('the window grows backwards through closed sprints, never forwards', () => {
  const { plan } = delivery(WINDOWED);
  assert.deepStrictEqual(names(plan, m.windowSprints(plan, TEAM, 2).ids), [4, 5]);
  assert.deepStrictEqual(names(plan, m.windowSprints(plan, TEAM, 3).ids), [3, 4, 5]);
  assert.deepStrictEqual(names(plan, m.windowSprints(plan, TEAM, 5).ids), [1, 2, 3, 4, 5]);
});

check('asking for more sprints than exist returns what there is, not an error', () => {
  const { plan } = delivery(WINDOWED);
  const w = m.windowSprints(plan, TEAM, 50);
  assert.deepStrictEqual(names(plan, w.ids), [1, 2, 3, 4, 5]);
  assert.strictEqual(w.requested, 50, 'and it remembers what was asked, so the screen can say so');
});

check('WITH NO ACTIVE SPRINT THE WINDOW IS THE N MOST RECENTLY CLOSED', () => {
  // Between sprints, or a team whose board has no active one. The count must
  // not silently become N-1.
  const { plan } = delivery(WINDOWED.filter(s => s.state === 'closed'));
  const w = m.windowSprints(plan, TEAM, 3);
  assert.strictEqual(w.active, null);
  assert.deepStrictEqual(names(plan, w.ids), [2, 3, 4], 'three closed, not two');
});

check('THE ACTIVE SPRINT IS MARKED, SO A CHART CAN SAY IT IS HALF DONE', () => {
  const { plan, snap } = delivery(WINDOWED);
  const v = m.velocity(plan, snap, TEAM, { sprints: 4 });
  const flags = v.history.map(h => Boolean(h.inProgress));
  assert.deepStrictEqual(flags, [false, false, false, true]);
});

check('THE SPRINT IN PROGRESS IS EXCLUDED FROM THE PLANNING NUMBERS', () => {
  // It is half delivered by definition. Folding it into the average makes
  // velocity sink every Monday and recover every other Friday — a number that
  // moves for a reason that has nothing to do with the team.
  const { plan, snap } = delivery(WINDOWED);
  const v = m.velocity(plan, snap, TEAM, { sprints: 4 });
  assert.strictEqual(v.average, 30, 'mean of 20, 30, 40 — the active sprint\'s 10 is out');
  const withActive = Math.round(((20 + 30 + 40 + 10) / 4) * 10) / 10;
  assert.notStrictEqual(v.average, withActive, 'including it would report 25');
  assert.ok(v.history.some(h => h.inProgress), 'but it is still IN the history, for the chart');
});

check('and out of attainment, which would otherwise read as a missed commitment', () => {
  // Sprint 5 is 10 delivered against 40 committed because it is three days old.
  const { plan, snap } = delivery(WINDOWED);
  const q = m.quality(plan, snap, TEAM, { sprints: 4 });
  assert.strictEqual(q.missedSprints, 0, 'a sprint still running has not missed anything');
  assert.strictEqual(q.attainment, 100);
});

check('ALL THREE REPORTS MEASURE THE SAME SPRINTS', () => {
  // Velocity, productivity and quality sit on one screen under one control. If
  // they resolved the window differently, the page would quietly describe three
  // different time ranges.
  //
  // Sprint 3 delivered NOTHING, which is what makes this check bite: the old
  // productivity code filtered to `actual > 0` before slicing, so it silently
  // reached one sprint further back than velocity did. With every sprint
  // delivering, the two agreed by coincidence and the check proved nothing.
  const { plan, snap } = delivery([
    { number: 1, committed: 10, delivered: 10, state: 'closed' },
    { number: 2, committed: 10, delivered: 20, state: 'closed' },
    { number: 3, committed: 10, delivered: 0, state: 'closed' },   // a wipeout
    { number: 4, committed: 10, delivered: 40, state: 'closed' },
    { number: 5, committed: 40, delivered: 10, state: 'active' },
  ]);
  const ids = (h) => h.map(x => x.sprintId).sort();
  const v = m.velocity(plan, snap, TEAM, { sprints: 3 });
  const p = m.productivity(plan, snap, TEAM, { sprints: 3 });
  assert.deepStrictEqual(ids(v.history), ['S3', 'S4', 'S5']);
  assert.deepStrictEqual(ids(p.perSprint), ids(v.history),
    'productivity must not reach past a zero-delivery sprint to find three with output');
});

check("QUALITY'S DEFECT AND REWORK COUNTS RESPECT THE WINDOW TOO", () => {
  // They were counted over every sprint the team ever had, whatever the window
  // said — so changing the control moved the velocity chart and left these two
  // numbers sitting still.
  const withBug = (n, state) => ({
    number: n, committed: 10, delivered: 10, state,
    extra: { issueType: 'Bug', summary: `bug ${n}` },
  });
  const { plan, snap } = delivery([
    withBug(1, 'closed'), withBug(2, 'closed'), withBug(3, 'closed'),
    { number: 4, committed: 10, delivered: 10, state: 'active' },
  ]);
  const wide = m.quality(plan, snap, TEAM, { sprints: 4 });
  const narrow = m.quality(plan, snap, TEAM, { sprints: 2 });
  assert.ok(narrow.defects.total < wide.defects.total,
    `narrowing the window must drop defects: ${narrow.defects.total} vs ${wide.defects.total}`);
});

/* ── PER-PERSON VELOCITY ──────────────────────────────────────────────────
 *
 * A row per person, a column per sprint, delivered points in the cells. The
 * two things worth protecting: a blank must not read as a zero, and the column
 * total must be the sprint's own delivered figure rather than the sum of the
 * rows — they differ by work nobody is holding, and a table that disagreed
 * with the velocity chart above it would be the first thing anyone noticed.
 */

/** `spec` = [{ number, state?, work: [{ acc, name?, pts, done }] }]. */
function peopleFixture(spec, members = TEAM.members) {
  const team = { ...TEAM, members };
  const plan = {
    teams: [team], sprints: [], availability: {}, support: {}, ceremony: {},
    overrides: {}, notes: {}, holidays: [], risks: [],
  };
  const snap = { issues: {}, boardSprintsByTeam: { t1: [] } };
  let k = 0;
  for (const s of spec) {
    const start = new Date(Date.UTC(2026, 0, 1)); start.setUTCDate(start.getUTCDate() + (s.number - 1) * 14);
    const end = new Date(start.getTime() + 13 * 864e5);
    const jiraId = String(500 + s.number);
    snap.boardSprintsByTeam.t1.push({
      id: jiraId, name: `Team One Sprint ${s.number}`, state: s.state || 'closed',
      start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10),
    });
    plan.sprints.push({
      id: `S${s.number}`, number: s.number, name: `Sprint ${s.number}`,
      start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10),
    });
    for (const mem of members) plan.availability[`t1|S${s.number}|${mem.id}`] = full;
    for (const w of s.work || []) {
      const key = `P-${k++}`;
      snap.issues[key] = {
        key, summary: 'work', issueType: 'Story',
        status: w.done ? 'Done' : 'Open', statusCategory: w.done ? 'done' : 'new',
        assignee: w.name || null, assigneeId: w.acc || null,
        labels: [], components: ['C1'], points: w.pts,
        sprints: [{ id: jiraId, name: `Team One Sprint ${s.number}` }],
        sprintNames: [`Team One Sprint ${s.number}`], blockedBy: [],
        created: start.toISOString(), updated: end.toISOString(),
        resolved: w.done ? end.toISOString() : null, priority: 'Medium',
      };
    }
  }
  /* RECONCILED, like the other fixture and like the app. `windowSprints` reads
     each sprint's state out of `byTeam[teamId]`, which only reconcile fills —
     without this every sprint has no state, nothing counts as closed, and the
     window comes back empty while the fixture looks complete. */
  r.reconcileSprints(plan, snap);
  snap.byTeam = r.buildTeamIndex(plan, snap);
  return { plan, snap, team };
}

const A = { acc: 'acc-a', name: 'A' };
const B = { acc: 'acc-b', name: 'B' };

check('PER-PERSON VELOCITY IS A ROW PER PERSON AND A COLUMN PER SPRINT', () => {
  const { plan, snap, team } = peopleFixture([
    { number: 1, work: [{ ...A, pts: 8, done: true }, { ...B, pts: 3, done: true }] },
    { number: 2, work: [{ ...A, pts: 5, done: true }, { ...B, pts: 9, done: true }] },
  ]);
  const pp = m.perPerson(plan, snap, team, { sprints: 12 });
  assert.strictEqual(pp.columns.length, 2, 'one column per sprint in the window');
  assert.strictEqual(pp.people.length, 2);
  const a = pp.people.find(x => x.name === 'A');
  assert.strictEqual(a.bySprint.S1.delivered, 8);
  assert.strictEqual(a.bySprint.S2.delivered, 5);
  assert.strictEqual(a.delivered, 13, 'the row total is the row');
  assert.strictEqual(pp.grandTotal, 25);
});

check('AND IT IS SORTED BY WHAT WAS DELIVERED, most first', () => {
  const { plan, snap, team } = peopleFixture([
    { number: 1, work: [{ ...A, pts: 2, done: true }, { ...B, pts: 11, done: true }] },
  ]);
  const pp = m.perPerson(plan, snap, team, { sprints: 12 });
  assert.deepStrictEqual(pp.people.map(x => x.name), ['B', 'A']);
});

check('DELIVERED, NOT COMMITTED — and the commitment rides along for the tooltip', () => {
  /* The distinction the whole section rests on. A grid of commitments would
     repeat the capacity sheet while looking like it said something new. */
  const { plan, snap, team } = peopleFixture([
    { number: 1, work: [{ ...A, pts: 8, done: true }, { ...A, pts: 6, done: false }] },
  ]);
  const a = m.perPerson(plan, snap, team, { sprints: 12 }).people[0];
  assert.strictEqual(a.bySprint.S1.delivered, 8, 'unfinished work was counted as delivered');
  assert.strictEqual(a.bySprint.S1.committed, 14, 'the commitment is not carried alongside it');
});

check('A BLANK AND A ZERO ARE DIFFERENT THINGS', () => {
  /* "Delivered nothing that sprint" is a conversation. "Was not on the team
     that sprint" is not, and a table that rendered them identically would
     start the wrong one. */
  const { plan, snap, team } = peopleFixture([
    // B has work in sprint 1 and NONE AT ALL in sprint 2 — not even unfinished.
    { number: 1, work: [{ ...A, pts: 5, done: true }, { ...B, pts: 4, done: true }] },
    { number: 2, work: [{ ...A, pts: 5, done: true }, { ...B, pts: 3, done: false }] },
  ]);
  const pp = m.perPerson(plan, snap, team, { sprints: 12 });
  const b = pp.people.find(x => x.name === 'B');
  assert.strictEqual(b.bySprint.S2.delivered, 0, 'committed and delivered nothing must be a zero');
  assert.strictEqual(b.bySprint.S2.committed, 3);

  const { plan: p2, snap: s2, team: t2 } = peopleFixture([
    { number: 1, work: [{ ...A, pts: 5, done: true }] },
    { number: 2, work: [{ ...A, pts: 5, done: true }, { ...B, pts: 4, done: true }] },
  ]);
  const b2 = m.perPerson(p2, s2, t2, { sprints: 12 }).people.find(x => x.name === 'B');
  assert.strictEqual(b2.bySprint.S1, undefined, 'a sprint someone had no part in must have no cell at all');
});

check('THE COLUMN TOTAL IS THE SPRINT\'S OWN FIGURE, not the sum of the rows', () => {
  /* Work with no assignee still delivered points. Adding the column up would
     drop it and leave this table disagreeing with the velocity chart directly
     above it — which is exactly the kind of difference nobody can explain in a
     review. */
  const { plan, snap, team } = peopleFixture([
    { number: 1, work: [
      { ...A, pts: 6, done: true },
      { acc: null, name: null, pts: 4, done: true },     // nobody holding it
    ] },
  ]);
  const pp = m.perPerson(plan, snap, team, { sprints: 12 });
  const t = pp.totals.S1;
  assert.strictEqual(t.attributed, 6, 'the rows add up to 6');
  assert.strictEqual(t.delivered, 10, 'but the sprint delivered 10');
  assert.strictEqual(t.unattributed, 4);
  assert.strictEqual(pp.unattributed, 4, 'and the window says so once, for the footnote');
  assert.match(pp.basis, /delivered by nobody on the roster/);
});

check('SOMEONE WHOSE ONLY TICKET IS UNESTIMATED STILL GETS A ROW', () => {
  /* Found on the live board: Phuong Uyen Le held one unestimated ticket in
     Katalon Squad Sprint 2 — committed 0, delivered 0 — and was the only member
     of her squad missing from the table. Filtering on points alone makes the
     person carrying work nobody has sized invisible, which is the opposite of
     what you want to see. The row exists; the cells are honest zeros. */
  const { plan, snap, team } = peopleFixture([
    { number: 1, work: [{ ...A, pts: 5, done: true }, { ...B, pts: null, done: false }] },
  ]);
  const pp = m.perPerson(plan, snap, team, { sprints: 12 });
  const b = pp.people.find(x => x.name === 'B');
  assert.ok(b, 'the person holding an unestimated ticket is missing from the table');
  assert.strictEqual(b.delivered, 0);
  assert.strictEqual(b.committed, 0);
  assert.strictEqual(b.items, 1, 'and the row has to carry the item count, or nothing explains the zeros');
  assert.strictEqual(b.bySprint.S1.items, 1);
});

check('BUT SOMEONE WITH NOTHING AT ALL GETS NO ROW', () => {
  /* The other side of it. A roster of fourteen where four never appeared in a
     sprint is a table of em dashes, and the filter has to still mean something. */
  const { plan, snap, team } = peopleFixture([
    { number: 1, work: [{ ...A, pts: 5, done: true }] },
  ]);
  const pp = m.perPerson(plan, snap, team, { sprints: 12 });
  assert.deepStrictEqual(pp.people.map(x => x.name), ['A'], 'B had no work at all and should not be listed');
});

check('SOMEONE WHO DID THE WORK BUT IS NOT ON THE TEAM LIST STILL GETS A ROW', () => {
  /* They delivered it. Leaving them out would hide the points AND the fact
     that the roster is wrong. */
  const { plan, snap, team } = peopleFixture([
    { number: 1, work: [{ ...A, pts: 5, done: true }, { acc: 'acc-z', name: 'Zed', pts: 7, done: true }] },
  ]);
  const pp = m.perPerson(plan, snap, team, { sprints: 12 });
  const z = pp.people.find(x => x.name === 'Zed');
  assert.ok(z, 'the person who delivered 7 pts is missing from the table');
  assert.strictEqual(z.onRoster, false, 'and the row has to say so, or the screen cannot mark it');
  assert.strictEqual(z.delivered, 7);
  assert.strictEqual(pp.totals.S1.unattributed, 0, 'their points are attributed — to them');
});

check('AN EXCLUDED PERSON\'S DELIVERY IS STILL COUNTED, and marked as off the list', () => {
  /* The case the off-roster branch exists for, and the only way to reach it: a
     CLOSED sprint absorbs everyone who did work into its own roster, so the
     branch is unreachable there. On an OPEN sprint `plan.excluded` is honoured
     — someone you took off the team keeps their tickets, and those points are
     still in the sprint's delivered figure.

     Dropping them would hide real delivery AND hide that the roster is wrong,
     while leaving the sprint total disagreeing with the rows for no visible
     reason. */
  const onlyA = [TEAM.members[0]];
  const { plan, snap, team } = peopleFixture([
    { number: 1, state: 'active', work: [{ ...A, pts: 5, done: true }, { acc: 'acc-z', name: 'Zed', pts: 7, done: true }] },
  ], onlyA);
  // Zed did the work and was taken off the team. The exclusion keeps him out of
  // the roster; it does not take his tickets out of the sprint.
  plan.excluded = { t1: ['acc-z'] };
  const pp = m.perPerson(plan, snap, team, { sprints: 12 });
  const z = pp.people.find(x => x.name === 'Zed');
  assert.ok(z, 'an excluded person\'s 7 delivered pts vanished from the table');
  assert.strictEqual(z.delivered, 7);
  assert.strictEqual(z.onRoster, false, 'and the row has to say they are off the list');
  assert.strictEqual(pp.totals.S1.unattributed, 0, 'their points are attributed — to them');
  assert.strictEqual(pp.totals.S1.delivered, 12, 'the sprint total has to include work off the roster');
});

check('THE SPRINT IN PROGRESS IS INCLUDED AND MARKED', () => {
  /* Unlike the team average, which excludes it. "What has X landed so far" is
     a real question; an average that dips every Monday is not a usable number.
     Both behaviours are right, in different places. */
  const { plan, snap, team } = peopleFixture([
    { number: 1, work: [{ ...A, pts: 8, done: true }] },
    { number: 2, state: 'active', work: [{ ...A, pts: 2, done: true }, { ...A, pts: 9, done: false }] },
  ]);
  const pp = m.perPerson(plan, snap, team, { sprints: 12 });
  const live = pp.columns.find(c => c.sprintId === 'S2');
  assert.ok(live, 'the active sprint is missing from the columns');
  assert.strictEqual(live.inProgress, true, 'the active sprint is not marked, so the screen cannot');
  assert.strictEqual(pp.columns.filter(c => c.inProgress).length, 1);
  assert.strictEqual(pp.people[0].bySprint.S2.delivered, 2, 'only what has actually landed counts');
});

check('AND AN EMPTY WINDOW SAYS SO RATHER THAN DRAWING AN EMPTY GRID', () => {
  const { plan, snap, team } = peopleFixture([{ number: 1, work: [] }]);
  const pp = m.perPerson(plan, snap, team, { sprints: 12 });
  assert.deepStrictEqual(pp.people, []);
  assert.match(pp.basis, /Nobody delivered/);
});

check('THE TABLE CARRIES ITS OWN CAVEAT', () => {
  /* A grid of names against numbers invites being read as a productivity
     ranking, which story points cannot support — they are sized for planning,
     they are not comparable between people, and whoever takes the unestimated
     work scores zero for a fortnight of it. The screen says so because the
     table alone will not. */
  const { plan, snap, team } = peopleFixture([{ number: 1, work: [{ ...A, pts: 3, done: true }] }]);
  const pp = m.perPerson(plan, snap, team, { sprints: 12 });
  assert.match(pp.caveat, /not for comparing people/i);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
