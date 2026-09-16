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

/** Render the real view with the real ui.js and charts.js. */
async function renderCoverage(payload, moved) {
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
  let rerender = () => {};
  const ctx = {
    console, Promise, setTimeout, clearTimeout, encodeURIComponent, CSS: { escape: String },
    // A real refresh, not a no-op: the window chips work by changing module
    // state and re-rendering, so a stub that does nothing would make them
    // untestable and any of them could be dead.
    App: { refresh() { rerender(); } },
    document: { createElement: () => el(), querySelector: () => el(), querySelectorAll: () => [] },
  };
  vm.createContext(ctx);
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  vm.runInContext(`${read('ui.js')}\n;globalThis.UI = UI;`, ctx);
  vm.runInContext(`${read('charts.js')}\n;globalThis.Charts = Charts;`, ctx);
  ctx.UI.api = async (p) => { asked.push(p); return p.includes('/movement') ? moved : payload; };
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
  return { get html() { return html; }, click, sent, asked, toString: () => html };
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
  const at = html.indexOf('Coverage movement');
  assert.ok(at > 0, 'the section has to render');
  assert.ok(at > html.indexOf('Overall automation status'), 'below the breakdown');
  assert.ok(at < html.indexOf('Coverage by component'), 'and above the component grid');
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

check('and the routes are registered', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /p === '\/api\/reports\/coverage\/movement'/);
  assert.match(server, /p === '\/api\/reports\/coverage\/backfill'/);
  assert.match(server, /searchWithHistory/, 'the backfill needs Jira\'s transition history to read');
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
