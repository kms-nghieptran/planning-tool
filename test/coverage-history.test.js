'use strict';
/**
 * coverage-history.test.js — movement has to be a fact, not a feeling.
 *
 * WHY THIS SUITE EXISTS
 *
 * "Is coverage going up?" was the one question this tool could not answer, and
 * the reason is worth stating because it shapes every check below: a sync
 * OVERWRITES each epic's automation_status. The previous value is not archived
 * anywhere, and it could not be inferred either — only 107 of his 312 automated
 * epics carry a resolution date, so two thirds of any reconstructed curve would
 * have been invented.
 *
 * So this feature manufactures its own history, from two sources of very
 * different standing:
 *
 *   OBSERVED       — a reading taken at sync time. What coverage WAS.
 *   RECONSTRUCTED  — a replay of Jira's transition history. What it probably was.
 *
 * THE FAILURE THIS SUITE IS AIMED AT is the one where those two become
 * indistinguishable. A chart that presents an inference as a measurement gets
 * pasted into a status report and quoted at a steering meeting, and by then
 * nobody remembers which half was guessed. Hence: an inference never overwrites
 * an observation, a single reading never draws a trend, and the screen always
 * says which it is looking at.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-covh-'));
process.env.STORE_DIR = SCRATCH;
process.env.DB_FILE = path.join(SCRATCH, 'test.db');

const db = require('../lib/db');
const cov = require('../lib/coverage');
const hist = require('../lib/coverage-history');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nCoverage movement\n');

/** Wipe between checks — these share one database on purpose (so does the app). */
const reset = () => db.run('DELETE FROM coverage_reading');

let n = 0;
const epic = (status, components, labels = []) => ({
  key: `AUTOKAT-${++n}`, issueType: 'Epic', summary: `Epic ${n}`,
  automationStatus: status, components, labels,
});
const snapshot = (list) => ({ issues: Object.fromEntries(list.map(i => [i.key, i])) });

/* ── a reading is the same count the screen shows ─────────────────────── */

check('A READING IS THE SCREEN\'S OWN COUNT, not a second implementation', () => {
  // The defect this prevents is the worst kind available here: a movement chart
  // that disagrees with the table beside it. Both would look plausible and only
  // one could be right, so the reading is taken THROUGH coverage.view.
  reset();
  n = 0;
  const snap = snapshot([
    epic('Automated', ['PS_A']), epic('Maintenance', ['PS_A']),
    epic('Ready for Automation', ['PS_A']), epic('Blocked', ['PS_B']),
    epic('N/A for Automation', ['PS_B']), epic(null, ['PS_B'], ['obsolete']),
  ]);
  hist.recordFromSnapshot(snap, { at: '2026-09-01' });

  const live = cov.view(snap, {});
  const stored = hist.series(null)[0];
  assert.strictEqual(stored.coveragePct, live.coveragePct,
    `stored ${stored.coveragePct}% against the screen's ${live.coveragePct}%`);
  assert.strictEqual(stored.automatable, live.automatable);
  assert.strictEqual(stored.covered, live.covered);
  for (const b of cov.BUCKETS) {
    assert.strictEqual(stored[b.key], live.buckets.find(x => x.key === b.key).count, `${b.label} differs`);
  }
});

check('and every component gets its own row, alongside the portfolio one', () => {
  reset();
  n = 0;
  const snap = snapshot([epic('Automated', ['PS_A']), epic('Ready for Automation', ['PS_B'])]);
  hist.recordFromSnapshot(snap, { at: '2026-09-01' });

  assert.strictEqual(hist.series(null).length, 1, 'the portfolio row');
  assert.strictEqual(hist.series('PS_A')[0].automated, 1);
  assert.strictEqual(hist.series('PS_B')[0].ready, 1);
  // Stored rather than summed, because an epic in two components is in two
  // rows: adding the component rows up would double-count it.
  assert.strictEqual(hist.series(null)[0].total, 2,
    'the portfolio row is counted, not added up from the components');
});

check('THREE SYNCS IN A DAY LEAVE ONE POINT, not three stacked on one tick', () => {
  reset();
  n = 0;
  const a = snapshot([epic('Ready for Automation', ['PS_A'])]);
  const b = snapshot([epic('Automated', ['PS_A'])]);
  hist.recordFromSnapshot(a, { at: '2026-09-01T09:00:00Z' });
  hist.recordFromSnapshot(a, { at: '2026-09-01T13:00:00Z' });
  hist.recordFromSnapshot(b, { at: '2026-09-01T17:00:00Z' });

  const s = hist.series(null);
  assert.strictEqual(s.length, 1, 'a day is one point');
  assert.strictEqual(s[0].automated, 1, 'and the last reading of the day is the one that stands');
});

/* ── observation beats inference ──────────────────────────────────────── */

check('A RECONSTRUCTION NEVER OVERWRITES A READING THIS TOOL TOOK ITSELF', () => {
  // Run the backfill twice and the second run would otherwise replace real
  // observations with approximations of themselves — silently, since the shape
  // of the data is identical and the chart would not flicker.
  reset();
  hist.record([{ component: '', automated: 10, ready: 10 }], { at: '2026-09-01', source: 'sync' });
  const out = hist.record([{ component: '', automated: 99, ready: 1 }], { at: '2026-09-01', source: 'changelog' });

  assert.strictEqual(out.written, 0);
  assert.strictEqual(out.kept, 1, 'the observation has to be reported as kept, not silently dropped');
  assert.strictEqual(hist.series(null)[0].automated, 10, 'the observed value stands');
  assert.strictEqual(hist.series(null)[0].source, 'sync');
});

check('but it does fill the days no sync covered', () => {
  // The rule is about precedence, not about refusing to write. A backfill whose
  // whole job is the gaps must be free to fill them.
  reset();
  hist.record([{ component: '', automated: 10, ready: 10 }], { at: '2026-09-10', source: 'sync' });
  const out = hist.record([{ component: '', automated: 4, ready: 16 }], { at: '2026-08-01', source: 'changelog' });

  assert.strictEqual(out.written, 1);
  const s = hist.series(null);
  assert.deepStrictEqual(s.map(p => `${p.at}:${p.source}`), ['2026-08-01:changelog', '2026-09-10:sync'],
    'oldest first, each keeping its own provenance');
});

check('and a later sync replaces its own earlier reading for that day', () => {
  reset();
  hist.record([{ component: '', automated: 1 }], { at: '2026-09-01', source: 'sync' });
  hist.record([{ component: '', automated: 7 }], { at: '2026-09-01', source: 'sync' });
  assert.strictEqual(hist.series(null)[0].automated, 7, 'an observation may correct an observation');
});

/* ── movement ─────────────────────────────────────────────────────────── */

check('THE FLAG IS NOT NAMED AFTER A BUCKET', () => {
  // Found by the coverage screen's own suite, which is the only reason it is
  // pinned here. Every coverage object in this codebase spreads its bucket
  // counts at the top level, and one bucket is Ready for Automation — so a flag
  // called `ready` is truthy on any payload with queued work, and a view
  // branching on it draws a trend from an object that has no trend in it.
  const m = hist.movement();
  assert.ok(!('ready' in m),
    'a movement result must not carry a key that means something else two objects away');
  assert.ok('hasTrend' in m, 'the flag itself still has to be there to branch on');
});

check('ONE READING IS NOT A TREND, and says so rather than drawing a flat line', () => {
  // A chart that looks identical with one point and with thirty lies for the
  // first fortnight of this feature's life, which is exactly when he will be
  // deciding whether to trust it.
  reset();
  hist.record([{ component: '', automated: 5, ready: 5 }], { at: '2026-09-01' });
  const m = hist.movement();
  assert.strictEqual(m.hasTrend, false, 'the flag callers branch on');
  assert.strictEqual(m.from, null, 'and no pair to compare');
  assert.strictEqual(m.deltaPct, null, 'a delta from one reading would be a fabrication');
  assert.strictEqual(m.points.length, 1, 'while the reading itself is still reported');
});

check('MOVEMENT IS IN PERCENTAGE POINTS, never a percentage of a percentage', () => {
  // 50% to 55% is +5 points. Calling it "+10%" is the single easiest way to
  // make a delivery report indefensible in the room it is read in.
  reset();
  hist.record([{ component: '', automated: 5, ready: 5 }], { at: '2026-08-01' });
  hist.record([{ component: '', automated: 6, ready: 4 }], { at: '2026-09-01' });
  const m = hist.movement();
  assert.strictEqual(m.from.coveragePct, 50);
  assert.strictEqual(m.to.coveragePct, 60);
  assert.strictEqual(m.deltaPct, 10, '50 → 60 is ten points; as a ratio it would be 20');
});

check('and each bucket reports its own movement in counts', () => {
  reset();
  hist.record([{ component: '', automated: 5, maintenance: 2, ready: 10, blocked: 3 }], { at: '2026-08-01' });
  hist.record([{ component: '', automated: 12, maintenance: 1, ready: 4, blocked: 3 }], { at: '2026-09-01' });
  const by = Object.fromEntries(hist.movement().buckets.map(b => [b.key, b.delta]));
  assert.strictEqual(by.automated, 7);
  assert.strictEqual(by.maintenance, -1);
  assert.strictEqual(by.ready, -6);
  assert.strictEqual(by.blocked, 0, 'a bucket that did not move reports zero rather than being absent');
});

check('A COMPONENT THAT GREW IS NOT A COMPONENT THAT WENT BACKWARDS', () => {
  // The reading this table exists to make possible. PS_Grew automated three
  // more epics and its coverage still fell, because twenty unautomated ones
  // arrived. "Down 25 points" alone would send him to the wrong conversation.
  reset();
  hist.record([{ component: 'PS_Grew', automated: 5, ready: 5 }], { at: '2026-08-01' });
  hist.record([{ component: 'PS_Grew', automated: 8, ready: 22 }], { at: '2026-09-01' });
  hist.record([{ component: '', automated: 5, ready: 5 }], { at: '2026-08-01' });
  hist.record([{ component: '', automated: 8, ready: 22 }], { at: '2026-09-01' });

  const mover = hist.movement().movers.find(x => x.component === 'PS_Grew');
  assert.ok(mover.delta < 0, 'coverage did fall');
  assert.strictEqual(mover.coveredDelta, 3, 'while three more were automated');
  assert.strictEqual(mover.automatableDelta, 20, 'and the denominator grew by twenty — that is the explanation');
});

check('movers are ranked by how far they moved, in either direction', () => {
  reset();
  const at = (d, rows) => rows.forEach(r => hist.record([r], { at: d }));
  at('2026-08-01', [
    { component: 'PS_Up', automated: 1, ready: 9 },
    { component: 'PS_Down', automated: 9, ready: 1 },
    { component: 'PS_Still', automated: 5, ready: 5 },
  ]);
  at('2026-09-01', [
    { component: 'PS_Up', automated: 5, ready: 5 },
    { component: 'PS_Down', automated: 2, ready: 8 },
    { component: 'PS_Still', automated: 5, ready: 5 },
  ]);
  const names = hist.movers().map(x => x.component);
  assert.deepStrictEqual(names, ['PS_Down', 'PS_Up'],
    'the biggest mover first whichever way it went; a suite that did not move is not a mover');
});

check('and a component with nothing automatable at either end is left out', () => {
  // It would otherwise sit at the top of a table sorted by change, as a row of
  // zeroes, above every suite that actually did something.
  reset();
  hist.record([{ component: 'PS_Empty', na: 4, none: 2 }], { at: '2026-08-01' });
  hist.record([{ component: 'PS_Empty', na: 4, none: 2 }], { at: '2026-09-01' });
  assert.deepStrictEqual(hist.movers().map(x => x.component), []);
});

check('A COMPONENT HE EXCLUDED GETS NO MOVER ROW', () => {
  /* The two halves of one screen. The component table above this section drops
     Technical_Works and KAT_Common_Maintenance on his instruction; a mover row
     for one of them underneath it is the same page answering "which components
     are we tracking" two different ways — and because movers are sorted by how
     far they moved, an excluded suite lands at the TOP of the list it does not
     belong on. */
  reset();
  const at = (d, rows) => rows.forEach(r => hist.record([r], { at: d }));
  at('2026-08-01', [
    { component: 'Technical_Works', automated: 1, ready: 9 },
    { component: 'KAT_Common_Maintenance', automated: 9, ready: 1 },
    { component: 'PS_Real', automated: 4, ready: 6 },
  ]);
  at('2026-09-01', [
    { component: 'Technical_Works', automated: 9, ready: 1 },
    { component: 'KAT_Common_Maintenance', automated: 1, ready: 9 },
    { component: 'PS_Real', automated: 5, ready: 5 },
  ]);

  // Unfiltered, the two excluded suites moved 80 points each and outrank the
  // real one — so this fixture cannot pass by accident.
  assert.deepStrictEqual(hist.movers().map(x => x.component),
    ['KAT_Common_Maintenance', 'Technical_Works', 'PS_Real'],
    'without the exclusion they are the top two movers');

  const kept = hist.movers({ exclude: ['Technical_Works', 'KAT_Common_Maintenance'] });
  assert.deepStrictEqual(kept.map(x => x.component), ['PS_Real'],
    'and with it, only the components he still tracks have rows');

  // Names are matched the way every other component setting matches them.
  assert.deepStrictEqual(hist.movers({ exclude: ['  technical_works  '] }).map(x => x.component),
    ['KAT_Common_Maintenance', 'PS_Real'], 'case and padding are not a way to slip past the setting');
});

check('and movement() carries the exclusion through to its movers', () => {
  // movers() is reachable directly too, so the route's path THROUGH movement()
  // has to be checked rather than assumed to follow.
  reset();
  const at = (d, rows) => rows.forEach(r => hist.record([r], { at: d }));
  at('2026-08-01', [
    { component: 'Technical_Works', automated: 1, ready: 9 },
    { component: 'PS_Real', automated: 4, ready: 6 },
    { component: '', automated: 5, ready: 15 },
  ]);
  at('2026-09-01', [
    { component: 'Technical_Works', automated: 9, ready: 1 },
    { component: 'PS_Real', automated: 5, ready: 5 },
    { component: '', automated: 14, ready: 6 },
  ]);

  const m = hist.movement(null, { exclude: ['Technical_Works'] });
  assert.deepStrictEqual(m.movers.map(x => x.component), ['PS_Real']);
  // The exclusion removes rows from a table; it does not remove the history
  // underneath them. Un-excluding it later has to bring the curve back, not
  // start it again from today.
  assert.ok(hist.series('Technical_Works').length >= 2,
    'the readings themselves are still there — an exclusion is a view, not a delete');
});

check('the window narrows the comparison to readings inside it', () => {
  reset();
  hist.record([{ component: '', automated: 1, ready: 9 }], { at: '2026-01-01' });
  hist.record([{ component: '', automated: 5, ready: 5 }], { at: '2026-08-01' });
  hist.record([{ component: '', automated: 6, ready: 4 }], { at: '2026-09-01' });

  assert.strictEqual(hist.movement(null, { since: '2026-07-01' }).from.at, '2026-08-01',
    'a 90-day view must not silently compare against January');
  assert.strictEqual(hist.movement().from.at, '2026-01-01', 'while the unwindowed view still sees everything');
});

/* ── reconstruction ───────────────────────────────────────────────────── */

check('REPLAYING JIRA\'S TRANSITIONS REBUILDS WHAT THE STATUS WAS', () => {
  // The backfill's whole claim. One epic, automated in July: before that date
  // it must read as Ready, after it as Automated.
  const e = {
    key: 'A-1', issueType: 'Epic', created: '2026-01-10', components: ['PS_A'], labels: [],
    automationStatus: 'Automated',
    transitions: [{ at: '2026-07-15', from: 'Ready for Automation', to: 'Automated' }],
  };
  const out = hist.reconstruct([e], ['2026-06-01', '2026-08-01']);
  const rowOn = (at) => out.find(r => r.at === at).rows.find(r => r.component === '');

  assert.strictEqual(rowOn('2026-06-01').ready, 1, 'before the transition it was Ready');
  assert.strictEqual(rowOn('2026-06-01').automated, 0);
  assert.strictEqual(rowOn('2026-08-01').automated, 1, 'after it, Automated');
});

check('an epic is absent from dates before it existed', () => {
  // Without this the denominator is wrong everywhere in the past and every
  // historic coverage figure is understated — work counted against a month it
  // had not been raised in.
  const e = {
    key: 'A-1', issueType: 'Epic', created: '2026-06-20', components: ['PS_A'], labels: [],
    automationStatus: 'Ready for Automation', transitions: [],
  };
  const out = hist.reconstruct([e], ['2026-05-01', '2026-07-01']);
  assert.strictEqual(out[0].rows.length, 0, 'it did not exist in May');
  assert.strictEqual(out[1].rows.find(r => r.component === '').ready, 1, 'and it does in July');
});

check('and an epic that never transitioned has held its status since it was raised', () => {
  const e = {
    key: 'A-1', issueType: 'Epic', created: '2026-01-01', components: ['PS_A'], labels: [],
    automationStatus: 'Blocked', transitions: [],
  };
  const out = hist.reconstruct([e], ['2026-03-01']);
  assert.strictEqual(out[0].rows.find(r => r.component === '').blocked, 1);
});

check('several transitions unwind in order, not just the most recent one', () => {
  const e = {
    key: 'A-1', issueType: 'Epic', created: '2026-01-01', components: ['PS_A'], labels: [],
    automationStatus: 'Maintenance',
    transitions: [
      { at: '2026-03-01', from: 'Ready for Automation', to: 'Blocked' },
      { at: '2026-05-01', from: 'Blocked', to: 'Automated' },
      { at: '2026-07-01', from: 'Automated', to: 'Maintenance' },
    ],
  };
  const want = { '2026-02-01': 'ready', '2026-04-01': 'blocked', '2026-06-01': 'automated', '2026-08-01': 'maintenance' };
  const out = hist.reconstruct([e], Object.keys(want));
  for (const [at, bucket] of Object.entries(want)) {
    const row = out.find(r => r.at === at).rows.find(r => r.component === '');
    assert.strictEqual(row[bucket], 1, `on ${at} it should have been ${bucket}, got ${JSON.stringify(row)}`);
  }
});

check('a reconstruction buckets by the SAME classifier the live screen uses', () => {
  // A second status map here and the rebuilt past would be measured differently
  // from the present, which is the one comparison this whole feature exists to
  // make. Proved on a value only the shared map knows about.
  const e = {
    key: 'A-1', issueType: 'Epic', created: '2026-01-01', components: ['PS_A'], labels: [],
    automationStatus: 'Done', transitions: [],           // 'Done' is an alias of Automated
  };
  const row = hist.reconstruct([e], ['2026-06-01'])[0].rows.find(r => r.component === '');
  assert.strictEqual(row.automated, 1, '"Done" counts as Automated on the live screen and must here too');
  assert.strictEqual(cov.bucketOf({ automationStatus: 'Done' }), 'automated', 'precondition');
});

check('and an unrecognised historic value falls where the live screen puts it', () => {
  const e = {
    key: 'A-1', issueType: 'Epic', created: '2026-01-01', components: ['PS_A'], labels: [],
    automationStatus: 'Automated',
    transitions: [{ at: '2026-06-01', from: 'Being Looked At', to: 'Automated' }],
  };
  const row = hist.reconstruct([e], ['2026-03-01'])[0].rows.find(r => r.component === '');
  assert.strictEqual(row.none, 1, 'a status this tool does not map is No Status, in the past as in the present');
});

check('weeklyDates walks back in even steps and ends on the last day', () => {
  const d = hist.weeklyDates('2026-08-01', '2026-09-01');
  assert.strictEqual(d[d.length - 1], '2026-09-01', 'the most recent date is the one being compared to');
  assert.ok(d.length >= 4 && d.length <= 6, `expected about five weekly marks, got ${d.length}`);
  assert.deepStrictEqual(d, d.slice().sort(), 'oldest first, the order everything else reads in');
});

/* ── the screen ───────────────────────────────────────────────────────── */

const VIEW = fs.readFileSync(path.join(__dirname, '..', 'public', 'views', 'report-coverage.js'), 'utf8');

/** Render the real view with the real ui.js and charts.js.
    `backlog` defaults to null — the same thing the route's `.catch(() => null)`
    hands the view when it has nothing, so every caller written before the
    Backlog section existed keeps rendering exactly what it used to. */
async function renderCoverage(payload, moved, backlog = null, drill = null) {
  let html = '';
  const el = () => ({
    addEventListener() {}, value: '', hidden: false, dataset: {}, style: {}, disabled: false,
    setAttribute() {}, getAttribute: () => null, select() {}, scrollIntoView() {}, focus() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    textContent: '', offsetWidth: 100,
    set innerHTML(_) {}, get innerHTML() { return ''; },
    querySelector: () => el(), querySelectorAll: () => [], closest: () => null,
  });
  const asked = [];
  const printed = [];
  let rerender = () => {};
  const ctx = {
    console, Promise, setTimeout, clearTimeout, encodeURIComponent, CSS: { escape: String },
    // A real refresh, not a no-op: the window chips work by changing module
    // state and re-rendering, so a stub that does nothing would make them
    // untestable and any of them could be dead.
    App: { refresh() { rerender(); } },
    document: {
      // Writable, because the PDF export sets it: the browser names the saved
      // file after the title, and putting it back afterwards is the half of
      // that which is easy to get wrong.
      title: 'Planning Tool',
      createElement: () => el(), querySelector: () => el(), querySelectorAll: () => [],
    },
    window: {
      _on: {},
      addEventListener(t, fn) { this._on[t] = fn; },
      removeEventListener(t) { delete this._on[t]; },
      // Records the title AT PRINT TIME, which is the only moment it matters.
      print() { printed.push(ctx.document.title); },
    },
  };
  vm.createContext(ctx);
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  vm.runInContext(`${read('ui.js')}\n;globalThis.UI = UI;`, ctx);
  vm.runInContext(`${read('charts.js')}\n;globalThis.Charts = Charts;`, ctx);
  ctx.UI.api = async (p) => {
    asked.push(p);
    if (p.includes('/movement')) return moved;
    // Longest path first: '/backlog/epics' also contains '/backlog'.
    if (p.includes('/backlog/epics')) {
      if (drill instanceof Error) throw drill;
      return drill;
    }
    if (p.includes('/backlog')) return backlog;
    return payload;
  };
  // The drawer renders outside the view's mount, so it is captured here rather
  // than read back out of the page.
  let drawn = '';
  ctx.UI.drawer = (html) => { drawn = html; };
  vm.runInContext(`${VIEW}\n;globalThis.__v = CoverageReport;`, ctx);
  const clicks = [];
  const sent = [];
  ctx.UI.jsonPost = async (p, b) => { sent.push(['POST', p, b]); return { ok: true, epics: 1, withHistory: 1, dates: 4, truncated: 0 }; };
  const mount = {
    style: {}, addEventListener: (t, fn) => { if (t === 'click') clicks.push(fn); },
    querySelector: () => el(), querySelectorAll: () => [],
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
  };
  rerender = () => ctx.__v.render({}, mount);
  await ctx.__v.render({}, mount);
  const click = async (sel, dataset = {}) => {
    const t = { dataset, closest: (s2) => (s2.includes(sel) ? t : null) };
    for (const fn of clicks.slice()) await fn({ target: t, preventDefault() {} });
    await new Promise(r => setTimeout(r, 5));
  };
  return {
    get html() { return html; }, get drawer() { return drawn; },
    click, sent, asked, printed, ctx, toString: () => html,
  };
}

function payloadFor() {
  n = 0;
  const snap = snapshot([
    epic('Automated', ['PS_A', 'TrueTest']), epic('Maintenance', ['PS_A']),
    epic('Ready for Automation', ['PS_A']), epic('Blocked', ['PS_B']),
    epic(null, ['PS_B']),
  ]);
  const v = cov.view(snap, {});
  return { ...v, attention: cov.assess(v), project: 'AUTOKAT' };
}

/** The same payload with his judgement on it, exactly as the route decorates it. */
const priorityLib = require('../lib/priority');
function payloadWithPriority(map = { PS_A: 1, PS_B: 3 }) {
  const v = payloadFor();
  const plan = { componentPriority: map };
  return {
    ...v,
    byComponent: priorityLib.decorate(v.byComponent, plan),
    byTool: priorityLib.decorate(v.byTool, plan),
    priorityLevels: priorityLib.LEVELS,
  };
}

const movedFixture = () => {
  reset();
  hist.record([{ component: '', automated: 2, maintenance: 1, ready: 8, blocked: 3 }], { at: '2026-06-01', source: 'changelog' });
  hist.record([{ component: '', automated: 6, maintenance: 1, ready: 4, blocked: 3 }], { at: '2026-09-01', source: 'sync' });
  hist.record([{ component: 'PS_A', automated: 1, ready: 9 }], { at: '2026-06-01', source: 'changelog' });
  hist.record([{ component: 'PS_A', automated: 6, ready: 4 }], { at: '2026-09-01', source: 'sync' });
  return {
    ...hist.movement(), days: 180,
    sources: db.all('SELECT source, COUNT(DISTINCT at) AS days FROM coverage_reading WHERE scope = ? GROUP BY source', 'Epic'),
  };
};

check('THE SECTION SITS DIRECTLY BELOW OVERALL AUTOMATION STATUS', async () => {
  // Where he asked for it, and where it belongs: the breakdown says where
  // coverage is, so the next question is which way it is going.
  const r_ = await renderCoverage(payloadFor(), movedFixture());
  const html = r_.html;
  /* Anchored to the HEADINGS, not to the words. This searched for the bare
     phrase "Coverage movement" and started failing the moment the print header
     mentioned the movement window in its summary line — the section had not
     moved at all. A position check that any prose on the page can satisfy is
     not checking position. */
  const at = html.indexOf('<h3>Coverage movement</h3>');
  assert.ok(at > 0, 'the section has to render');
  assert.ok(at > html.indexOf('<h3>Overall automation status</h3>'), 'below the breakdown');
  assert.ok(at < html.indexOf('<h2>Coverage by component</h2>'), 'and above the component grid');
});

check('it shows the delta in points, both endpoints, and a chart', async () => {
  const r_ = await renderCoverage(payloadFor(), movedFixture());
  const html = r_.html;
  assert.match(html, /\+28\.6/, 'the movement itself: 21.4% → 50% is 28.6 points');
  assert.match(html, /21\.4%[\s\S]{0,80}2026-06-01/, 'where it started, and when');
  assert.match(html, /50%[\s\S]{0,40}today/, 'and where it is now');
  assert.match(html, /<polyline/, 'and a line to read it off');
  assert.match(html, /Automated\s*<strong>\+4<\/strong>/, 'with the bucket counts that moved');
});

check('A RECONSTRUCTED POINT IS VISIBLY NOT AN OBSERVED ONE', async () => {
  // The distinction the whole feature rests on. If the two draw identically,
  // a guess gets quoted as a measurement the first time this is screenshotted.
  const r_ = await renderCoverage(payloadFor(), movedFixture());
  const html = r_.html;
  assert.match(html, /reconstructed from Jira/i,
    'the chart has to say which points were inferred');
  assert.match(html, /1 day observed by a sync/,
    'and the note has to count each source rather than implying one provenance');
});

check('AND WITH NO HISTORY IT EXPLAINS ITSELF INSTEAD OF DRAWING AN EMPTY CHART', async () => {
  // The state this feature ships in. An empty axis reads as a broken screen;
  // what it actually means is "nothing recorded this until now".
  reset();
  const r_ = await renderCoverage(payloadFor(), { ...hist.movement(), days: 180, sources: [] });
  const html = r_.html;
  assert.match(html, /Coverage movement/);
  assert.ok(!/<polyline/.test(html.slice(html.indexOf('Coverage movement'), html.indexOf('Coverage by component'))),
    'no line through no data');
  assert.match(html, /No history yet/);
  assert.match(html, /data-act="backfill"/, 'and a way to get the past without waiting for it');
});

check('and that button actually reaches the backfill, not just the markup', async () => {
  // Learnt the hard way on the rules editor: a button whose data-act nothing
  // handles renders perfectly and does nothing at all when clicked — no error,
  // no toast. Checking the attribute is in the HTML would have passed then too.
  reset();
  const r = await renderCoverage(payloadFor(), { ...hist.movement(), days: 180, sources: [] });
  await r.click('[data-act="backfill"]', { act: 'backfill' });
  const posts = r.sent.filter(([m, p]) => m === 'POST' && p === '/api/reports/coverage/backfill');
  assert.strictEqual(posts.length, 1, `one click, one request (got ${JSON.stringify(r.sent)})`);
  assert.ok(posts[0][2].weeks > 0, 'and it has to say how far back to go');
});

check('and one reading is still not a chart', async () => {
  reset();
  hist.record([{ component: '', automated: 5, ready: 5 }], { at: '2026-09-01' });
  const r_ = await renderCoverage(payloadFor(), { ...hist.movement(), days: 180, sources: [] });
  const html = r_.html;
  assert.match(html, /One reading so far/, 'said in words rather than shown as a flat line');
  assert.match(html, /2026-09-01/, 'and the reading it does have is named');
});

/* ── the wiring ───────────────────────────────────────────────────────── */

check('THE WINDOW CHIPS CHANGE THE WINDOW, rather than just looking selected', async () => {
  // Four chips that all render an "active" state and none of which re-query is
  // a control that looks like it works. The proof is the request that follows.
  const r = await renderCoverage(payloadFor(), movedFixture());
  assert.ok(r.asked.some(p => p.includes('days=180')), 'precondition: it opens on the default window');
  await r.click('[data-days]', { days: '30' });
  assert.ok(r.asked.some(p => p.includes('days=30')),
    `clicking 30d must re-ask for 30 days: ${JSON.stringify(r.asked)}`);
});

check('EVERY SYNC RECORDS A READING — the only moment it can be taken', () => {
  // Miss it and that day is gone: the next sync overwrites the statuses it
  // would have been counted from. Asserted against the source because the
  // alternative is a fixture that runs a whole Jira sync.
  const sync = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sync.js'), 'utf8');
  assert.match(sync, /function recordCoverage\(/);
  const calls = (sync.match(/recordCoverage\(next, cfg\)/g) || []).length;
  assert.strictEqual(calls, 2, `both the full and the incremental sync must record one, found ${calls}`);
  assert.match(sync, /catch \(err\) \{[\s\S]{0,200}coverage\.history\.failed/,
    'and it must never fail the sync — a sync that pulled 9,000 issues has succeeded');
});

/* ── which epics produced one driver tag ──────────────────────────────
   "Automated +5" on the movers table is a net delta of COUNTS taken from two
   daily readings. Opening it has to answer "which five?" from a different
   source — the transition history — and the two measurements do not always
   agree, which is the thing these checks are really about. */

const wipeMoves = () => db.run('DELETE FROM automation_transition');
const saveMoves = (key, moves, truncated = false) =>
  hist.saveTransitions([{ key, transitions: moves.map(([at, from, to]) => ({ at, from, to })), truncated }]);
const epicIn = (key, components) => ({ key, issueType: 'Epic', components, labels: [], summary: key });

check('OPENING A DRIVER LISTS THE EPICS THAT MOVED INTO THAT BUCKET', () => {
  reset(); wipeMoves();
  saveMoves('E-1', [['2026-06-01T00:00:00Z', 'Ready for Automation', 'Automated']]);
  saveMoves('E-2', [['2026-06-02T00:00:00Z', 'Maintenance', 'Automated']]);
  saveMoves('E-3', [['2026-06-03T00:00:00Z', 'Ready for Automation', 'Blocked']]);

  const lookup = (k) => epicIn(k, ['R&D_Sig_Regression']);
  const r = hist.movedEpics({ bucket: 'automated', component: 'R&D_Sig_Regression', since: '2026-01-01', lookup });
  assert.deepStrictEqual(r.arrived.map(x => x.key).sort(), ['E-1', 'E-2']);
  assert.deepStrictEqual(r.left, [], 'nothing left Automated');
  assert.strictEqual(r.net, 2);
});

check('AND THE ONES THAT MOVED OUT, kept apart from the ones that moved in', () => {
  // A "+5" can be seven in and two out. One list under a heading saying five
  // would be a list that does not match its own number.
  reset(); wipeMoves();
  saveMoves('E-1', [['2026-06-01T00:00:00Z', 'Ready for Automation', 'Automated']]);
  saveMoves('E-2', [['2026-06-02T00:00:00Z', 'Ready for Automation', 'Automated']]);
  saveMoves('E-3', [['2026-06-05T00:00:00Z', 'Automated', 'Maintenance']]);

  const lookup = (k) => epicIn(k, ['R&D_Sig_Regression']);
  const r = hist.movedEpics({ bucket: 'automated', component: 'R&D_Sig_Regression', since: '2026-01-01', lookup });
  assert.deepStrictEqual(r.arrived.map(x => x.key).sort(), ['E-1', 'E-2']);
  assert.deepStrictEqual(r.left.map(x => x.key), ['E-3']);
  assert.strictEqual(r.net, 1, 'and the net is stated rather than implied');
});

check('a move WITHIN one bucket is not a move at all', () => {
  // "Done" is the board's alias for Automated. Automated → Done changes the
  // field and changes nothing about coverage, so it must not appear in either
  // list — it would be an epic that "moved" while the number stood still.
  reset(); wipeMoves();
  saveMoves('E-1', [['2026-06-01T00:00:00Z', 'Automated', 'Done']]);
  const r = hist.movedEpics({ bucket: 'automated', component: 'C', since: '2026-01-01', lookup: (k) => epicIn(k, ['C']) });
  assert.deepStrictEqual([r.arrived.length, r.left.length], [0, 0]);
});

check('the window is respected — a move before it is not in it', () => {
  reset(); wipeMoves();
  saveMoves('E-old', [['2025-01-01T00:00:00Z', 'Ready for Automation', 'Automated']]);
  saveMoves('E-new', [['2026-06-01T00:00:00Z', 'Ready for Automation', 'Automated']]);
  const lookup = (k) => epicIn(k, ['C']);
  const r = hist.movedEpics({ bucket: 'automated', component: 'C', since: '2026-01-01', lookup });
  assert.deepStrictEqual(r.arrived.map(x => x.key), ['E-new']);
  const all = hist.movedEpics({ bucket: 'automated', component: 'C', since: null, lookup });
  assert.strictEqual(all.arrived.length, 2, 'and with no window, both');
});

check('THE COMPONENT COMES FROM THE EPIC NOW, so a re-tag corrects the past', () => {
  reset(); wipeMoves();
  saveMoves('E-1', [['2026-06-01T00:00:00Z', 'Ready for Automation', 'Automated']]);
  const inA = hist.movedEpics({ bucket: 'automated', component: 'A', since: null, lookup: (k) => epicIn(k, ['A']) });
  const inB = hist.movedEpics({ bucket: 'automated', component: 'A', since: null, lookup: (k) => epicIn(k, ['B']) });
  assert.strictEqual(inA.arrived.length, 1);
  assert.strictEqual(inB.arrived.length, 0, 'the same event, under the component the epic carries today');
});

check('an epic this tool has no copy of is left out of a component list', () => {
  // The drawer is always opened FROM a component, so an epic that cannot be
  // placed in one would be listed under a heading it may not belong to.
  reset(); wipeMoves();
  saveMoves('GHOST', [['2026-06-01T00:00:00Z', 'Ready for Automation', 'Automated']]);
  const scoped = hist.movedEpics({ bucket: 'automated', component: 'C', since: null, lookup: () => null });
  assert.strictEqual(scoped.arrived.length, 0);
  // Across every component there is no heading to be wrong about, so it counts.
  const all = hist.movedEpics({ bucket: 'automated', component: null, since: null, lookup: () => null });
  assert.strictEqual(all.arrived.length, 1);
});

check('a truncated history is never stored, so it cannot half-answer', () => {
  reset(); wipeMoves();
  saveMoves('E-cut', [['2026-06-01T00:00:00Z', 'Ready for Automation', 'Automated']], true);
  const r = hist.movedEpics({ bucket: 'automated', component: null, since: null, lookup: () => null });
  assert.strictEqual(r.arrived.length, 0, 'a partial history undercounts, which looks exactly like a quiet month');
});

check('asking for no bucket returns nothing rather than everything', () => {
  reset(); wipeMoves();
  saveMoves('E-1', [['2026-06-01T00:00:00Z', 'Ready for Automation', 'Automated']]);
  assert.deepStrictEqual(hist.movedEpics({ bucket: '', since: null, lookup: () => null }),
    { arrived: [], left: [], net: 0 });
  assert.deepStrictEqual(hist.movedEpics({}), { arrived: [], left: [], net: 0 });
});

check('and the routes are registered', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /p === '\/api\/reports\/coverage\/movement'/);

  /* AND THE MOVEMENT ROUTE HANDS HIS EXCLUSIONS DOWN. The model honours them
     (checked for real above); what the source has to show is that the route
     actually passes them, and passes the ones out of the PLAN rather than an
     empty list that would make the whole setting a no-op. Asserted here for
     the same reason as the block below: a live check needs a populated
     coverage_reading table behind a booted server, which is another suite. */
  const mv = server.slice(server.indexOf("p === '/api/reports/coverage/movement'"));
  const mvBody = mv.slice(0, mv.indexOf('\n  if (p ==='));
  assert.match(mvBody, /covHistory\.movement\([^)]*exclude:\s*plan\.excludedComponents/,
    'the movers table has to be scoped by the same setting the component table obeys');
  assert.match(server, /p === '\/api\/reports\/coverage\/backfill'/);
  assert.match(server, /searchWithHistory/, 'the backfill needs Jira\'s transition history to read');
  assert.match(server, /p === '\/api\/reports\/coverage\/moved'/, 'and the drill-in behind a driver tag');
  assert.match(server, /p === '\/api\/reports\/backlog\/epics'/, 'and the drill-in behind a bar segment');

  /* THE ROUTE MUST NOT DERIVE THE PERIOD ITSELF. It reads the boundaries back
     off the profile the chart drew — which is the only reason the drawer and
     the bar cannot disagree, and the only reason "all" resolves its grain the
     same way on both sides. Asserted on the source because proving it for real
     needs a populated snapshot and transition table, which is another suite. */
  const route = server.slice(server.indexOf("p === '/api/reports/backlog/epics'"));
  const body = route.slice(0, route.indexOf('\n  if (p ==='));
  assert.match(body, /backlogProfile\.profile\(/, 'the route has to run the same profile');
  assert.match(body, /prof\.periods\.find\(/, 'and take the window from it, not recompute one');
  assert.match(body, /backlogProfile\.eventsOf\(/, 'and bucket with the shared classifier');
  assert.match(body, /shown:/, 'and report what the bar says, so a drift is visible');
});

/* ── the backfill control is reachable from every state ────────────────
   THE BUG THESE EXIST FOR. The button used to be rendered in exactly one
   branch: the "no history yet" callout in Coverage movement. That branch
   disappears the moment two syncs have recorded a reading — but the
   transitions it reads live in a different table that ONLY this button
   fills, so the Backlog chart and the "what moved" drawer went on saying
   "run Backfill from Jira history" with no button left anywhere to press.
   An instruction naming a control that is not on the page is not an
   instruction. Each check below pins one state the control must survive. */

/** A backlog payload with bars but no changelog read yet — the empty state. */
const backlogUnread = () => ({
  grain: 'month', scope: 'Epic', backfilled: false, epics: 5, withEvents: 0, events: 0,
  buckets: [{ key: 'ttBuild', label: 'New TT Build' }],
  periods: [{ label: 'Sep', start: '2026-09-01', end: '2026-09-30', partial: true, counts: { ttBuild: 0 }, total: 0 }],
});

check('THE BACKFILL BUTTON SURVIVES THE TREND APPEARING', async () => {
  // movedFixture() has two readings, so hasTrend is true and the callout that
  // used to hold the only button is gone. The button must not go with it.
  const r_ = await renderCoverage(payloadFor(), movedFixture());
  assert.match(r_.html, /data-act="backfill"/,
    'with a trend on screen there was no way left to fill the transition table');
});

check('it is reachable with several components selected too', async () => {
  const r_ = await renderCoverage(payloadFor(), { ...movedFixture(), multi: true, selected: ['PS_A', 'PS_B'] });
  assert.match(r_.html, /data-act="backfill"/, 'the multi-component branch never rendered one at all');
});

check('and it is still there before any history exists', async () => {
  // The state it always worked in — kept honest so the shared helper cannot
  // fix the two broken branches by quietly breaking the one that was fine.
  const r_ = await renderCoverage(payloadFor(), { points: [], hasTrend: false, movers: [], sources: [] });
  assert.match(r_.html, /data-act="backfill"/);
});

check('the Backlog empty state carries its own button, not a pointer to one', async () => {
  const r_ = await renderCoverage(payloadFor(), movedFixture(), backlogUnread());
  const at = r_.html.indexOf('No automation history yet');
  assert.ok(at > 0, 'the empty state has to render');
  // Within the section itself, not somewhere further down the page.
  const section = r_.html.slice(at, at + 900);
  assert.match(section, /data-act="backfill"/,
    'the message that asks for the backfill must be within reach of it');
});

check('EACH SECTION OFFERS ITS OWN, rather than one button somewhere on the page', async () => {
  /* Scoped deliberately. "There is a backfill button in the document" is the
     weaker claim, and it is satisfied by a page that puts one three sections
     away from the message asking for it — which is the scrolling hunt this
     whole fix exists to remove. So the assertion is made INSIDE the Coverage
     movement section, for every branch of it, with the Backlog section already
     rendering one of its own so a stray match cannot stand in. */
  const branches = [
    ['trend', movedFixture()],
    ['no trend', { points: [], hasTrend: false, movers: [], sources: [] }],
    ['multi', { ...movedFixture(), multi: true, selected: ['PS_A', 'PS_B'] }],
  ];
  for (const [name, moved] of branches) {
    const html = (await renderCoverage(payloadFor(), moved, backlogUnread())).html;
    const at = html.indexOf('Coverage movement');
    assert.ok(at > 0, `${name}: the section has to render`);
    // To the end of the card — the component grid is the next thing on screen.
    const cut = html.indexOf('Coverage by component', at);
    const section = html.slice(at, cut > at ? cut : html.length);
    assert.match(section, /data-act="backfill"/,
      `${name}: the movement section leaves you scrolling for the control`);
  }
});

/* ── the Backlog window chips, "All" included ────────────────────────── */

/** A drawn backlog chart, so the chips and the foot note are on screen. */
const backlogDrawn = (over = {}) => ({
  grain: 'month', window: 'month', clamped: false, scope: 'Epic', backfilled: true,
  epics: 5, withEvents: 3, events: 7, components: [],
  basis: 'Epics whose Automation Status moved to Automated in the period.',
  buckets: [{ key: 'ttBuild', label: 'New TT Build' }, { key: 'kseBuild', label: 'New KSE Build' }],
  periods: [
    { label: 'Aug', start: '2026-08-01', end: '2026-08-31', partial: false, counts: { ttBuild: 2, kseBuild: 1 }, total: 3 },
    { label: 'Sep', start: '2026-09-01', end: '2026-09-30', partial: true, counts: { ttBuild: 3, kseBuild: 1 }, total: 4 },
  ],
  ...over,
});

check('ALL IS OFFERED ALONGSIDE WEEK, MONTH AND YEAR', async () => {
  const html = (await renderCoverage(payloadFor(), movedFixture(), backlogDrawn())).html;
  for (const w of ['week', 'month', 'year', 'all']) {
    assert.match(html, new RegExp(`data-grain="${w}"`), `no ${w} chip`);
  }
  assert.match(html, /data-grain="all">All</, 'and it is labelled All');
});

check('pressing All asks for the whole history — and sends NO period count', async () => {
  // "All" is not a number of periods; only the server knows when the first
  // event was. Sending `periods=12` with it would silently cap it at a year.
  const r_ = await renderCoverage(payloadFor(), movedFixture(), backlogDrawn());
  await r_.click('[data-grain]', { grain: 'all' });
  const asked = r_.asked.filter(p => p.includes('/backlog')).pop();
  assert.match(asked, /grain=all/, 'the window never reached the route');
  assert.doesNotMatch(asked, /periods=/, 'a period count would override the whole-history window');
});

check('and a fixed window still sends its count', async () => {
  const r_ = await renderCoverage(payloadFor(), movedFixture(), backlogDrawn());
  await r_.click('[data-grain]', { grain: 'week' });
  const asked = r_.asked.filter(p => p.includes('/backlog')).pop();
  assert.match(asked, /grain=week&periods=13/, 'the fixed windows are still fixed');
});

check('ALL SAYS WHAT IT CHOSE, because the bars change width underneath you', async () => {
  const html = (await renderCoverage(payloadFor(), movedFixture(),
    backlogDrawn({ window: 'all', grain: 'year' }))).html;
  assert.match(html, /All time, in yearly bars from Aug\./, 'the reader cannot see the grain any other way');
});

check('and a truncated history is admitted, not presented as the whole story', async () => {
  const html = (await renderCoverage(payloadFor(), movedFixture(),
    backlogDrawn({ window: 'all', grain: 'year', clamped: true }))).html;
  assert.match(html, /oldest is off the left edge/);
});

check('a fixed window says nothing — the chip is already the answer', async () => {
  const html = (await renderCoverage(payloadFor(), movedFixture(), backlogDrawn())).html;
  assert.doesNotMatch(html, /All time, in/, 'a note on every window is noise on three of them');
  assert.doesNotMatch(html, /off the left edge/);
});

/* ── opening a bar ───────────────────────────────────────────────────── */

const BACKLOG_EPICS = {
  keys: ['AUTOKAT-1', 'AUTOKAT-2', 'AUTOKAT-3'],
  catalogue: {
    'AUTOKAT-1': { key: 'AUTOKAT-1', summary: 'Login suite', status: 'Done', components: ['PS_A'] },
    'AUTOKAT-2': { key: 'AUTOKAT-2', summary: 'Billing suite', status: 'Done', components: ['PS_A'] },
    'AUTOKAT-3': { key: 'AUTOKAT-3', absent: true },
  },
  scope: 'Epic', components: [], bucket: 'ttBuild', label: 'New TT Build',
  period: { label: 'Aug', start: '2026-08-01', end: '2026-08-31', partial: false },
  grain: 'month', window: 'month', shown: 3,
};

check('THE CHART IS RENDERED WITH THE DRILL-IN TURNED ON', async () => {
  /* The click checks below drive a synthetic target, so they pass whether or
     not anything on screen is actually clickable — they prove the HANDLER,
     not the affordance. This proves the markup: drop `drill: true` from the
     Charts.stacked call and every hook disappears while those still pass. */
  const html = (await renderCoverage(payloadFor(), movedFixture(), backlogDrawn())).html;
  const svg = html.slice(html.indexOf('<svg', html.indexOf('Backlog')));
  assert.match(svg, /<g class="drillable"[^>]*data-act="backlog"/, 'no segment is a control');
  assert.match(svg, /data-period="2026-08-01"[^>]*data-bucket="ttBuild"/, 'and none names its bar');
  assert.match(svg, /data-period="2026-09-01" data-bucket=""/, 'nor is the total openable');
  assert.match(svg, /tabindex="0"/, 'and the keyboard cannot reach any of it');
});

check('CLICKING A BAR SEGMENT OPENS THE EPICS BEHIND IT', async () => {
  const r_ = await renderCoverage(payloadFor(), movedFixture(), backlogDrawn(), BACKLOG_EPICS);
  await r_.click('[data-act="backlog"]', { act: 'backlog', period: '2026-08-01', bucket: 'ttBuild' });
  assert.match(r_.drawer, /AUTOKAT-1/, 'the drawer has to list the epics');
  assert.match(r_.drawer, /Login suite/, 'with what they are');
  assert.match(r_.drawer, /Aug — New TT Build/, 'and say which bar it came from');
  assert.match(r_.drawer, /3 items/, 'as many as the bar drew');
});

check('AND IT ASKS FOR THE WINDOW ON SCREEN, not the route\'s default', async () => {
  // A drawer opened from a weekly bar that asked without `grain` would get a
  // month back — a list longer than the number that opened it.
  const r_ = await renderCoverage(payloadFor(), movedFixture(), backlogDrawn(), BACKLOG_EPICS);
  await r_.click('[data-grain]', { grain: 'week' });
  await r_.click('[data-act="backlog"]', { act: 'backlog', period: '2026-08-24', bucket: 'ttBuild' });
  const asked = r_.asked.filter(p => p.includes('/backlog/epics')).pop();
  assert.match(asked, /grain=week/, 'the window never reached the route');
  assert.match(asked, /periods=13/, 'nor did its length');
  assert.match(asked, /period=2026-08-24/, 'and the bar identifies itself by date');
  assert.match(asked, /bucket=ttBuild/);
});

check('the total opens every column, by sending no bucket at all', async () => {
  const r_ = await renderCoverage(payloadFor(), movedFixture(), backlogDrawn(), BACKLOG_EPICS);
  await r_.click('[data-act="backlog"]', { act: 'backlog', period: '2026-08-01', bucket: '' });
  const asked = r_.asked.filter(p => p.includes('/backlog/epics')).pop();
  assert.match(asked, /bucket=$|bucket=&/, 'an empty bucket is what means "all of them"');
});

check('and "all" sends its window with no period count', async () => {
  const r_ = await renderCoverage(payloadFor(), movedFixture(), backlogDrawn(), BACKLOG_EPICS);
  await r_.click('[data-grain]', { grain: 'all' });
  await r_.click('[data-act="backlog"]', { act: 'backlog', period: '2023-01-01', bucket: 'kseBuild' });
  const asked = r_.asked.filter(p => p.includes('/backlog/epics')).pop();
  assert.match(asked, /grain=all/);
  assert.doesNotMatch(asked, /periods=/, 'a count would cap the whole-history window');
});

check('A DISAGREEMENT WITH THE BAR IS SAID OUT LOUD, not silently shown', async () => {
  // Both sides run the same profile, so this should never happen — which is
  // exactly why it must be reported rather than smoothed over if it does.
  const r_ = await renderCoverage(payloadFor(), movedFixture(), backlogDrawn(),
    { ...BACKLOG_EPICS, shown: 7 });
  await r_.click('[data-act="backlog"]', { act: 'backlog', period: '2026-08-01', bucket: 'ttBuild' });
  assert.match(r_.drawer, /The bar says 7/, 'a list of three under a bar of seven has to explain itself');
});

check('and agreement says nothing at all', async () => {
  const r_ = await renderCoverage(payloadFor(), movedFixture(), backlogDrawn(), BACKLOG_EPICS);
  await r_.click('[data-act="backlog"]', { act: 'backlog', period: '2026-08-01', bucket: 'ttBuild' });
  assert.doesNotMatch(r_.drawer, /The bar says/);
});

check('a bar that has scrolled out of the window explains itself', async () => {
  const r_ = await renderCoverage(payloadFor(), movedFixture(), backlogDrawn(), new Error('That bar is not in the current window any more'));
  await r_.click('[data-act="backlog"]', { act: 'backlog', period: '1999-01-01', bucket: 'ttBuild' });
  assert.match(r_.drawer, /Could not read the change history/);
  assert.match(r_.drawer, /not in the current window/);
});

check('a segment with no period is ignored rather than asking for nothing', async () => {
  const r_ = await renderCoverage(payloadFor(), movedFixture(), backlogDrawn(), BACKLOG_EPICS);
  await r_.click('[data-act="backlog"]', { act: 'backlog', bucket: 'ttBuild' });
  assert.strictEqual(r_.asked.filter(p => p.includes('/backlog/epics')).length, 0);
});

check('THE MIXKEY NUMBERS OPEN THE SAME DRAWER as the bars above them', async () => {
  // They are counts for the last period, sitting under the chart. A number
  // that reads like the ones in the bars and does not open is a dead end.
  const html = (await renderCoverage(payloadFor(), movedFixture(), backlogDrawn())).html;
  const at = html.indexOf('mixkey');
  const key = html.slice(at, html.indexOf('</div>', at));
  assert.match(key, /class="numlink"[^>]*data-act="backlog"/, 'the legend counts are inert');
  assert.match(key, /data-period="2026-09-01"/, 'and they answer for the last period drawn');
});

check('pressing it posts the backfill — the control is wired, not just printed', async () => {
  const r_ = await renderCoverage(payloadFor(), movedFixture());
  await r_.click('[data-act="backfill"]', { act: 'backfill' });
  assert.deepStrictEqual(r_.sent.map(s => [s[0], s[1]]), [['POST', '/api/reports/coverage/backfill']],
    'a button that renders but sends nothing is the same dead end in a different shape');
});

/* ── priority in the tool split ──────────────────────────────────────────
   The same components, listed twice on one screen. The grid above decides
   which suites matter; this table decides where their work runs. Showing the
   judgement in only one of them means scrolling back up to answer "is this
   TrueTest gap on something we care about". */

/**
 * The rows of one table, as `component -> priority label` (or '—').
 *
 * `marker` picks the right TABLE, not merely the right section. The tool split
 * renders a status-breakdown table between its heading and its component list,
 * so taking the first `<tbody>` after the heading reads the wrong one — which
 * it did, and the three checks below this one all passed over an empty object
 * until the first one asked whether any rows had been found at all.
 */
const prioIn = (html, heading, marker) => {
  const at = html.indexOf(heading);
  assert.ok(at > 0, `no "${heading}" section`);
  assert.ok(html.indexOf(marker, at) > 0, `no "${marker}" under "${heading}" — wrong table`);
  /* The SECTION, split on rows — not a `<tbody>` slice. An expanded row in the
     tool split holds a whole nested breakdown table, so the first `</tbody>`
     after the opening tag closes the NESTED one and every component after the
     first falls outside the slice. Rows of the inner table carry no
     `data-component`, so scanning the section skips them on their own. */
  const next = html.indexOf('<h2', at + heading.length);
  const section = html.slice(at, next > at ? next : html.length);
  const out = {};
  for (const row of section.split('<tr').slice(1)) {
    const name = (row.match(/data-component="([^"]*)"/) || [])[1];
    if (!name) continue;
    // FIRST mention wins. A component's data row comes before its expanded
    // detail row, and the trailing fragment of a section can name it again
    // with no priority cell in it — last-wins read that as "unset" and
    // reported a bug in rendering that was correct.
    if (name in out) continue;
    const tag = (row.match(/class="tag prio-tag[^"]*"[^>]*>([^<]*)</) || [])[1];
    const sel = /<select class="prio/.test(row);
    out[name] = tag ? tag.trim() : sel ? 'select' : '—';
  }
  return out;
};

check('THE TOOL SPLIT SHOWS EACH COMPONENT\'S PRIORITY', async () => {
  const html = (await renderCoverage(payloadWithPriority(), movedFixture(), backlogDrawn())).html;
  const tool = prioIn(html, '<h2>TrueTest vs KSE</h2>', 'data-expand=');
  assert.ok(Object.keys(tool).length, 'the tool table rendered no component rows at all');
  assert.strictEqual(tool.PS_A, 'P1');
  assert.strictEqual(tool.PS_B, 'P3');
});

check('and it AGREES with the grid above it, component for component', async () => {
  // Two tables on one screen disagreeing about a component is the failure this
  // is really guarding: both read the row's own `priority`, decorated once by
  // the route from the one plan.
  const html = (await renderCoverage(payloadWithPriority(), movedFixture(), backlogDrawn())).html;
  const grid = prioIn(html, '<h2>Coverage by component</h2>', 'data-priority=');
  const tool = prioIn(html, '<h2>TrueTest vs KSE</h2>', 'data-expand=');
  assert.ok(Object.keys(tool).length && Object.keys(grid).length, 'both tables have to have rows');
  for (const [name, level] of Object.entries(tool)) {
    if (!(name in grid)) continue;
    // The grid holds a <select>; compare against what it has selected.
    const at = html.indexOf(`data-priority="${name}"`);
    const sel = html.slice(at, html.indexOf('</select>', at));
    const chosen = (sel.match(/<option value="(\d*)"[^>]*selected/) || [])[1] || '';
    const expected = chosen ? `P${chosen}` : '—';
    assert.strictEqual(level, expected, `${name}: grid says ${expected}, tool split says ${level}`);
  }
});

check('an unset component reads as a dash in both, not P-nothing', async () => {
  const html = (await renderCoverage(payloadWithPriority({}), movedFixture(), backlogDrawn())).html;
  const tool = prioIn(html, '<h2>TrueTest vs KSE</h2>', 'data-expand=');
  assert.ok(Object.keys(tool).length, 'no rows to check');
  for (const [name, level] of Object.entries(tool)) assert.strictEqual(level, '—', name);
});

check('IT IS READ-ONLY THERE — the grid above owns the value', async () => {
  // A value with two editors is a value with two answers the first time both
  // are on screen, and no way to tell which write landed last.
  const html = (await renderCoverage(payloadWithPriority(), movedFixture(), backlogDrawn())).html;
  const at = html.indexOf('<h2>TrueTest vs KSE</h2>');
  const section = html.slice(at, html.indexOf('<h2', at + 10) > 0 ? html.indexOf('<h2', at + 10) : html.length);
  assert.ok(!/data-priority="/.test(section), 'the tool split must not offer to change the priority');
  assert.match(section, /class="tag prio-tag/, 'but it does have to show it');
});

check('the column sorts by RANK, not by the text in the tag', async () => {
  // "P1" and "P10" sort the wrong way as text, and an unset cell has to sit at
  // the bottom whichever way the column points.
  const html = (await renderCoverage(payloadWithPriority({ PS_A: 1 }), movedFixture(), backlogDrawn())).html;
  const at = html.indexOf('<h2>TrueTest vs KSE</h2>');
  const next = html.indexOf('<h2', at + 10);
  const body = html.slice(at, next > at ? next : html.length);
  assert.match(body, /data-sort-value="1"/, 'a set level carries its rank');
  assert.match(body, /data-sort-value="—"/, 'and an unset one carries the blank that pins it last');
});

/* ── export to PDF ───────────────────────────────────────────────────────
   The export IS a print: the browser's own renderer, driven by the print
   stylesheet. Which makes the risk a specific one, and not "does it look
   nice". Print hides every control on this page, and every control was
   carrying a fact — which components, over what window, filtered to which
   family. A report of a filtered subset with nothing saying so is worse than
   no report, because it is quotable and wrong.

   So these checks are mostly about one thing: what a hidden control was
   saying has to survive it being hidden. */

const PRINT_CSS = (() => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  /* Anchored on `@page`, NOT on the first `@media print`. There are several
     one-line print rules earlier in the file — `.tagval-x`, `.tag-btn` — so
     slicing from the first match hands back six hundred lines of screen CSS
     with the print block on the end, and a search for `.numlink` in it finds
     the SCREEN rule and passes on it. Which is what this helper did first. */
  const at = css.indexOf('@media print {\n  @page');
  assert.ok(at > 0, 'the main print block has moved — this helper is anchored to it');
  return { all: css, print: css.slice(at) };
})();

const headOf = (html) => {
  const at = html.indexOf('print-only');
  assert.ok(at > 0, 'there is no print-only title block at all');
  // To the end of that block — everything before the first section.
  const end = html.indexOf('<section', at);
  return html.slice(at, end > at ? end : at + 1200);
};

/**
 * The block of markup that starts at `cls` and ends where it closes.
 *
 * A slice to the first `</div>` stops at the first nested child, so a check
 * asking "is the button inside the card" would answer no for any card with
 * structure. This counts depth.
 */
const blockOf = (html, cls) => {
  // By class, not by the whole attribute: the card is `class="card picker-card"`
  // and an exact-attribute match would report the element as missing.
  const m = new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"`).exec(html);
  assert.ok(m, `there is no .${cls} on the page`);
  const i = m.index;
  const start = html.lastIndexOf('<div', i);
  let depth = 0, k = start;
  for (;;) {
    const open = html.indexOf('<div', k);
    const close = html.indexOf('</div>', k);
    if (close < 0) return html.slice(start);
    if (open >= 0 && open < close) { depth++; k = open + 4; } else {
      depth--; k = close + 6;
      if (depth === 0) return html.slice(start, k);
    }
  }
};

check('THE SCREEN OFFERS AN EXPORT, and the export is a print', async () => {
  const html = (await renderCoverage(payloadFor(), movedFixture(), backlogDrawn())).html;
  assert.match(html, /data-act="export-pdf"/, 'no Export PDF control');
  assert.match(html, /Export PDF/, 'the control is not labelled');

  /* AND IT DOES NOT PRINT. This used to be asserted as "a `section print-hide`
     exists somewhere on the page", which was true whether or not the button
     was inside it — and stayed true when the button moved into the picker
     card. The property is about the BUTTON, so it is checked on the button:
     it sits inside a container, and that container is one the print
     stylesheet hides. Both links, or the chain proves nothing. */
  assert.match(blockOf(html, 'picker-card'), /data-act="export-pdf"/,
    'the export button is not inside the picker card any more — say where it is and that print hides it');
  const at = PRINT_CSS.print.indexOf('.picker-card');
  assert.ok(at > 0, 'and the picker card has to be hidden in print');
  assert.match(PRINT_CSS.print.slice(at, PRINT_CSS.print.indexOf('}', at)), /display: none/,
    'or the button prints as a dead control');
});

check('CLICKING IT PRINTS', async () => {
  const r_ = await renderCoverage(payloadFor(), movedFixture(), backlogDrawn());
  await r_.click('[data-act="export-pdf"]', { act: 'export-pdf' });
  assert.strictEqual(r_.printed.length, 1, 'the browser was never asked to print');
});

check('and the file is named after the REPORT, not after the app', async () => {
  // Left alone, every export in a folder is called "Planning Tool.pdf".
  const r_ = await renderCoverage({ ...payloadFor(), selected: ['PS_A'] }, movedFixture(), backlogDrawn());
  await r_.click('[data-act="export-pdf"]', { act: 'export-pdf' });
  assert.match(r_.printed[0], /Overall Coverage/, `title at print time was "${r_.printed[0]}"`);
  assert.match(r_.printed[0], /PS_A/, 'and which components it covers');
  assert.match(r_.printed[0], /\d{4}-\d{2}-\d{2}/, 'and when — a folder of them sorts by date');
  assert.ok(!/[\\/:*?"<>|]/.test(r_.printed[0]), 'a filename cannot carry path characters');
});

check('the title goes back afterwards', async () => {
  const r_ = await renderCoverage(payloadFor(), movedFixture(), backlogDrawn());
  await r_.click('[data-act="export-pdf"]', { act: 'export-pdf' });
  assert.notStrictEqual(r_.ctx.document.title, 'Planning Tool', 'it was never set');
  r_.ctx.window._on.afterprint();
  assert.strictEqual(r_.ctx.document.title, 'Planning Tool', 'the app is left renamed');
});

check('an unfiltered export still names itself', async () => {
  const r_ = await renderCoverage(payloadFor(), movedFixture(), backlogDrawn());
  await r_.click('[data-act="export-pdf"]', { act: 'export-pdf' });
  assert.match(r_.printed[0], /all components/, 'the scope has to be stated either way');
});

check('THE PDF SAYS WHAT IT COVERS AND HOW OLD IT IS', async () => {
  // Both timestamps, and they answer different questions: how old the FACTS
  // are, and when this page was taken. A PDF mailed Friday from Monday's sync
  // quietly ages into being wrong, and only the pair makes that visible.
  const html = (await renderCoverage(payloadFor(), movedFixture(), backlogDrawn())).html;
  const head = headOf(html);
  assert.match(head, /Overall Coverage/, 'the report does not name itself');
  assert.match(head, /All components/, 'nothing says what it covers');
  assert.match(head, /synced/, 'nothing says how fresh the Jira data is');
  assert.match(head, /report taken/, 'nothing dates the report itself');
});

check('A FILTERED EXPORT SAYS SO — the picker is not on the page any more', async () => {
  // The failure this prevents: a page headed "Coverage 62%" over eleven rows,
  // with nothing saying it was narrowed to two components.
  const html = (await renderCoverage(
    { ...payloadFor(), selected: ['PS_A', 'PS_B'] }, movedFixture(), backlogDrawn())).html;
  const head = headOf(html);
  assert.match(head, /PS_A \+ PS_B/, 'the selection left the page with the picker');
});

check('and so does a family filter, which is a chip nobody can see on paper', async () => {
  const r_ = await renderCoverage(payloadFor(), movedFixture(), backlogDrawn());
  await r_.click('[data-family]', { family: 'PS — client delivery' });
  assert.match(headOf(r_.html), /Family: PS/, 'the grid is filtered and the page does not say so');
});

check('THE WINDOW CHIPS ARE RESTATED IN WORDS, having been hidden', async () => {
  // "180d" and "Month" are the state of a control. On paper the control is
  // gone and the chart is left standing on its own.
  const r_ = await renderCoverage(payloadFor(), movedFixture(), backlogDrawn());
  assert.match(headOf(r_.html), /Coverage movement over 180 days/);
  await r_.click('[data-days]', { days: '30' });
  assert.match(headOf(r_.html), /over 30 days/, 'the header has to follow the control');
});

check('and "all" says what it RESOLVED to, since it chooses its own bar width', async () => {
  const r_ = await renderCoverage(payloadFor(), movedFixture(),
    backlogDrawn({ window: 'all', grain: 'year' }));
  assert.match(headOf(r_.html), /Backlog: all time, yearly bars/);
});

check('a fixed backlog window says its own length', async () => {
  const html = (await renderCoverage(payloadFor(), movedFixture(), backlogDrawn())).html;
  assert.match(headOf(html), /Backlog: 2 months/);
});

check('THE TITLE BLOCK IS PRINT-ONLY, and the button is screen-only', async () => {
  const html = (await renderCoverage(payloadFor(), movedFixture(), backlogDrawn())).html;
  assert.match(PRINT_CSS.all, /^\.print-only \{ display: none; \}/m, 'the title block would show on screen');
  assert.match(PRINT_CSS.print, /\.print-only \{ display: block !important/, 'and never show in print');
  // The mirror of it: `print-hide` still has to mean what it says, for the
  // sections that use it. The export button's own case is checked above, on
  // the button, rather than on the existence of a class somewhere in the page.
  assert.match(PRINT_CSS.print, /\.print-hide \{ display: none !important/);
  assert.ok(!/class="section print-hide"[^>]*>\s*<div class="section-head">\s*<div class="spacer">/.test(html),
    'an empty section-head holding one right-aligned button is a band of whitespace, not a layout');
});

/* ── THE TOP OF THE PAGE ──────────────────────────────────────────────
   Nothing precedes the picker card but the breadcrumb, so every pixel above
   the Component field is the first thing anyone sees on this report and the
   last thing anyone would defend. Two separate faults put a lot of them
   there: a section holding one right-aligned button, and a flex row that
   bottom-aligned a short control against a note that had grown to four lines.
   Both are layout, and both are checked as layout — on the rule, since the
   suite has no browser to measure in. */

check('NOTHING STANDS BETWEEN THE BREADCRUMB AND THE PICKER', async () => {
  const html = (await renderCoverage(payloadFor(), movedFixture(), backlogDrawn())).html;
  // The print-only title block does not render on screen, so the picker card
  // has to be the first thing that does.
  const firstSection = html.indexOf('<section');
  const card = html.indexOf('picker-card');
  assert.ok(card > 0, 'there is no picker card');
  const before = html.slice(firstSection, card);
  assert.ok(!/<button|<a class="btn/.test(before),
    'a control above the picker is a band of whitespace with one thing in it — put it in the card');
});

check('AND THE COMPONENT FIELD IS AT THE TOP OF THE CARD, not floated to its bottom', () => {
  /* The rule, because this is where the pixels came from. The card holds items
     of very different heights — a two-line combo, a four-line note — and
     `align-items: flex-end` banks the whole difference ABOVE the shorter one.
     That was 98px of empty card sitting on top of the Component field. */
  const rule = PRINT_CSS.all.slice(PRINT_CSS.all.indexOf('.picker-card {'));
  const decl = rule.slice(0, rule.indexOf('}'));
  assert.match(decl, /align-items:\s*flex-start/,
    'flex-end puts the height difference above the first control on the page');
  assert.ok(!/align-items:\s*(flex-end|center)/.test(decl));
});

check('and the selection chips line up with the box they describe', () => {
  /* Top-aligning the row fixed the card and left the chips a label's height
     above the input they belong to. The offset is the field's own head — its
     label line box plus the gap under it — taken from a variable rather than
     copied as a number, because a copied number drifts the first time the
     label changes and nothing fails. */
  assert.match(PRINT_CSS.all, /--field-head:\s*calc\(var\(--field-label-line\)\s*\+\s*var\(--field-gap\)\)/,
    'the field head has to be derived from the label metrics, not stated twice');
  assert.match(PRINT_CSS.all, /\.picker-card > \.picked \{[^}]*margin-top:\s*var\(--field-head\)/,
    'the chips must offset by exactly that, so they sit on the input rather than above it');
  // And the metrics it is derived from have to be real rather than inherited,
  // or the calc is built on a number nobody set.
  assert.match(PRINT_CSS.all, /\.field \{[^}]*gap:\s*var\(--field-gap\)/);
  assert.match(PRINT_CSS.all, /\.field > span \{[^}]*line-height:\s*var\(--field-label-line\)/);
});

check('PRINT HIDES EVERY CONTROL ON THIS PAGE', async () => {
  // Each one sets what is shown and shows nothing itself. On paper a chip is a
  // coloured word that looks like data, and the active one looks like an answer.
  for (const sel of ['.chip', '.picker-card', '.comp-filter', '.combo-list']) {
    const at = PRINT_CSS.print.indexOf(sel);
    assert.ok(at > 0, `${sel} is not hidden in print`);
    assert.match(PRINT_CSS.print.slice(at, PRINT_CSS.print.indexOf('}', at)), /display: none/, sel);
  }
});

check('A DROPDOWN DOES NOT PRINT AS A DROPDOWN', async () => {
  // The priority column is the last form control left once the furniture is
  // gone. Unstyled it prints as a sunken box with an arrow — and blank on some
  // engines — where every other cell is its value.
  const at = PRINT_CSS.print.indexOf('select.prio');
  assert.ok(at > 0, 'the priority dropdown prints as a form control');
  const rule = PRINT_CSS.print.slice(at, PRINT_CSS.print.indexOf('}', at));
  assert.match(rule, /appearance: none/, 'the arrow stays');
  assert.match(rule, /border: none/, 'the box stays');
});

check('but a drill-in keeps its NUMBER — it is the value, not the affordance', async () => {
  // `.numlink` and the driver tags are controls whose label is the datum.
  // Hiding them would take counts off the page; they lose the chrome instead.
  const at = PRINT_CSS.print.indexOf('.numlink {');
  assert.ok(at > 0, 'the drill-in numbers have no print rule');
  assert.match(PRINT_CSS.print.slice(at, PRINT_CSS.print.indexOf('}', at)), /border: none/);
  assert.ok(!/\.numlink[^{]*\{[^}]*display:\s*none/.test(PRINT_CSS.print),
    'hiding them would delete the counts from the report');
});

check('a chart is never split across a page break', async () => {
  const at = PRINT_CSS.print.indexOf('svg { break-inside');
  assert.ok(at > 0, 'half a chart on each of two pages is not a chart');
});

check('A SENTENCE IN A REASONS LIST IS ONE INLINE FLOW, not a row of columns', () => {
  /* `.reasons li` was `display: flex`, which makes every `<strong>`, every
     `<code>` and each run of text between them its own flex ITEM. "Obsoleted —
     no Automation Status and labelled `obsolete`. Retired, not waiting on
     anyone." printed with the code box to the right of the clause it belongs
     to, and the sentence read in the wrong order.

     Found by reading the PDF — on a wide screen card the columns are roomy
     enough to pass for a line of text, which is why it survived. Ten lists in
     seven views use this class. */
  const at = PRINT_CSS.all.indexOf('.reasons li {');
  assert.ok(at > 0, 'the rule has gone');
  const rule = PRINT_CSS.all.slice(at, PRINT_CSS.all.indexOf('}', at));
  assert.ok(!/display:\s*flex/.test(rule),
    'a flex item splits the sentence at every <strong> and <code> in it');
  assert.match(rule, /position: relative/, 'the marker needs something to be positioned against');
  const dot = PRINT_CSS.all.indexOf('.reasons li::before {');
  assert.match(PRINT_CSS.all.slice(dot, PRINT_CSS.all.indexOf('}', dot)), /position: absolute/,
    'a marker in the flow is a flex/inline item and takes the first word with it');
});

/* ── run ───────────────────────────────────────────────────────────── */

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  try { db.close(); } catch (_) { /* fine */ }
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
