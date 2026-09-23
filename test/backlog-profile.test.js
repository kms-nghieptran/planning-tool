'use strict';
/**
 * backlog-profile.test.js — how many test cases were automated, period by period?
 *
 * THESE BARS ARE EVENTS, NOT A STATE. They count the moments an Epic's
 * Automation Status moved to Automated, read from Jira's changelog. His rule:
 *
 *   the FIRST move to Automated          → new build
 *   a later move from Maintenance        → maintenance
 *
 * and the epic's tool component decides which column.
 *
 * THE FAILURE MODE IS A PLAUSIBLE CHART. Every mistake available here —
 * counting every arrival at Automated as a build, counting a slip BACK to
 * Maintenance as an event, reading the tool off the event instead of the epic,
 * taking the changelog in the order it arrived rather than in time order —
 * draws a chart that renders perfectly and credits the wrong column. So the
 * checks below pin exact counts against a fixture worked out by hand.
 */

const assert = require('node:assert');
const bp = require('../lib/backlog-profile');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nBacklog profile\n');

/** An epic with its changelog. `tt` adds the TrueTest tool component. */
const epic = (key, transitions, { tt = false } = {}) => ({
  key, components: tt ? ['TrueTest', 'R&D_Sig_Regression'] : ['R&D_Sig_Regression'], transitions,
});
const move = (at, from, to) => ({ at, from, to });

/* ── his rule, exactly ───────────────────────────────────────────────── */

check('THE FIRST MOVE TO AUTOMATED IS A NEW BUILD', () => {
  const p = bp.profile([epic('E1', [move('2026-02-10', 'Ready for Automation', 'Automated')], { tt: true })],
    { grain: 'month', periods: 3, asOf: '2026-03-20' });
  const by = Object.fromEntries(p.periods.map(x => [x.label, x.counts]));
  assert.strictEqual(by.Feb.ttBuild, 1, 'TrueTest component, so it is New TT Build');
  assert.strictEqual(by.Feb.ttMaint, 0);
  assert.strictEqual(by.Jan.ttBuild, 0, 'and it lands in the month it happened, not before');
  assert.strictEqual(by.Mar.ttBuild, 0, 'nor after — an event is one period, not every period since');
});

check('AND A LATER MOVE FROM MAINTENANCE IS MAINTENANCE', () => {
  const p = bp.profile([epic('E2', [
    move('2026-01-15', 'Ready for Automation', 'Automated'),
    move('2026-02-20', 'Automated', 'Maintenance'),
    move('2026-03-05', 'Maintenance', 'Automated'),
  ])], { grain: 'month', periods: 3, asOf: '2026-03-20' });
  const by = Object.fromEntries(p.periods.map(x => [x.label, x.counts]));
  assert.strictEqual(by.Jan.kseBuild, 1, 'built in January');
  assert.strictEqual(by.Feb.total, undefined);
  assert.strictEqual(p.periods[1].total, 0, 'the slip BACK to Maintenance is not an event — nothing was automated');
  assert.strictEqual(by.Mar.kseMaint, 1, 're-automated in March, as maintenance');
  assert.strictEqual(by.Mar.kseBuild, 0, 'and not counted as a second build');
});

check('an epic whose FIRST arrival came from Maintenance is still a build', () => {
  // An epic cannot be re-automated before it has been automated once. Taking
  // this the other way round reports an epic as maintained without ever
  // reporting it built, and the build column is permanently short.
  const p = bp.profile([epic('E3', [
    move('2026-03-12', 'Maintenance', 'Automated'),
    move('2026-04-02', 'Automated', 'Maintenance'),
    move('2026-04-20', 'Maintenance', 'Automated'),
  ], { tt: true })], { grain: 'month', periods: 2, asOf: '2026-04-25' });
  const by = Object.fromEntries(p.periods.map(x => [x.label, x.counts]));
  assert.strictEqual(by.Mar.ttBuild, 1, 'the first arrival is the build');
  assert.strictEqual(by.Mar.ttMaint, 0);
  assert.strictEqual(by.Apr.ttMaint, 1, 'and the second is maintenance');
  assert.strictEqual(by.Apr.ttBuild, 0);
});

check('THE CHANGELOG IS SORTED BEFORE "FIRST" IS DECIDED', () => {
  // "First" is a claim about time, and Jira does not promise history order.
  const jumbled = bp.profile([epic('E', [
    move('2026-03-05', 'Maintenance', 'Automated'),
    move('2026-01-15', 'Ready for Automation', 'Automated'),
  ])], { grain: 'month', periods: 3, asOf: '2026-03-20' });
  const by = Object.fromEntries(jumbled.periods.map(x => [x.label, x.counts]));
  assert.strictEqual(by.Jan.kseBuild, 1, 'January is the build whichever order the entries arrived in');
  assert.strictEqual(by.Mar.kseMaint, 1);
});

check('a move to anything else is not an event', () => {
  const p = bp.profile([epic('E4', [
    move('2026-02-01', 'Ready for Automation', 'Blocked'),
    move('2026-02-15', 'Blocked', 'Ready for Automation'),
  ])], { grain: 'month', periods: 2, asOf: '2026-02-25' });
  assert.deepStrictEqual(p.periods.map(x => x.total), [0, 0], 'nothing was automated, so nothing is counted');
  assert.strictEqual(p.withEvents, 0);
  assert.strictEqual(p.epics, 1, 'the epic is still counted as looked at');
});

check('"Done" counts as Automated — the board uses it as an alias', () => {
  // The same alias coverage.bucketOf already honours. Matching only the exact
  // word would drop every epic on a board that renamed the value.
  assert.strictEqual(bp.isAutomated('Done'), true);
  assert.strictEqual(bp.isAutomated('automated'), true);
  assert.strictEqual(bp.isAutomated('Ready for Automation'), false);
  const p = bp.profile([epic('E', [move('2026-02-10', 'Maintenance', 'Done')])],
    { grain: 'month', periods: 1, asOf: '2026-02-20' });
  assert.strictEqual(p.periods[0].total, 1);
});

check('an epic already Automated that stays Automated raises no event', () => {
  // A field edit that does not change the answer is not a thing that happened.
  const p = bp.profile([epic('E', [
    move('2026-02-01', 'Automated', 'Done'),
  ])], { grain: 'month', periods: 1, asOf: '2026-02-20' });
  assert.strictEqual(p.periods[0].total, 0, 'Automated to its own alias is not an automation');
});

/* ── the four columns ────────────────────────────────────────────────── */

check('THE TOOL IS READ FROM THE EPIC, NOT STAMPED ON THE EVENT', () => {
  // Re-tagging an epic's component in Jira has to correct every past bar. The
  // alternative leaves history labelled with something that has since changed.
  const tr = [move('2026-02-10', 'Ready for Automation', 'Automated')];
  const asKse = bp.profile([epic('E', tr)], { grain: 'month', periods: 1, asOf: '2026-02-20' });
  const asTt = bp.profile([epic('E', tr, { tt: true })], { grain: 'month', periods: 1, asOf: '2026-02-20' });
  assert.strictEqual(asKse.periods[0].counts.kseBuild, 1);
  assert.strictEqual(asTt.periods[0].counts.ttBuild, 1, 'same event, same date, different column');
});

check('the four columns add up to the total, and are named as he named them', () => {
  const p = bp.profile([
    epic('A', [move('2026-02-01', 'Ready for Automation', 'Automated')], { tt: true }),
    epic('B', [move('2026-02-02', 'Ready for Automation', 'Automated')]),
    epic('C', [move('2026-01-01', 'Ready for Automation', 'Automated'), move('2026-02-03', 'Maintenance', 'Automated')], { tt: true }),
    epic('D', [move('2026-01-02', 'Ready for Automation', 'Automated'), move('2026-02-04', 'Maintenance', 'Automated')]),
    epic('E', [move('2026-01-03', 'Ready for Automation', 'Automated'), move('2026-02-05', 'Maintenance', 'Automated')]),
  ], { grain: 'month', periods: 2, asOf: '2026-02-20' });
  assert.deepStrictEqual(p.periods[1].counts, { ttBuild: 1, kseBuild: 1, ttMaint: 1, kseMaint: 2 });
  assert.strictEqual(p.periods[1].total, 5);
  assert.deepStrictEqual(p.buckets.map(b => b.label),
    ['New TT Build', 'New KSE Build', 'TT Maintenance', 'KSE Maintenance']);
});

check('an epic with no changelog at all contributes nothing and is not an error', () => {
  const p = bp.profile([epic('E', []), epic('F', null), { key: 'G' }],
    { grain: 'month', periods: 1, asOf: '2026-02-20' });
  assert.strictEqual(p.periods[0].total, 0);
  assert.strictEqual(p.epics, 3);
  assert.strictEqual(p.withEvents, 0);
});

check('a transition with no date is skipped rather than landing in 1970', () => {
  const p = bp.profile([epic('E', [move(null, 'Maintenance', 'Automated'), move('bad', 'Maintenance', 'Automated')])],
    { grain: 'month', periods: 1, asOf: '2026-02-20' });
  assert.strictEqual(p.events, 0);
});

/* ── the three windows ───────────────────────────────────────────────── */

check('A WEEK RUNS MONDAY TO SUNDAY', () => {
  // Not a rolling seven days: the team works Monday to Friday, and a window
  // that cut across the weekend would split every sprint week in half.
  const p = bp.profile([epic('E', [move('2026-09-10', 'Maintenance', 'Automated')])], { grain: 'week', periods: 2, asOf: '2026-09-16' });
  for (const wk of p.periods) {
    assert.strictEqual(new Date(`${wk.start}T00:00:00Z`).getUTCDay(), 1, `${wk.start} is a Monday`);
    assert.strictEqual(new Date(`${wk.end}T00:00:00Z`).getUTCDay(), 0, `${wk.end} is a Sunday`);
  }
});

check('a month is the calendar month and a year is the calendar year', () => {
  const m = bp.profile([], { grain: 'month', periods: 2, asOf: '2026-03-15' });
  assert.deepStrictEqual(m.periods.map(x => [x.start, x.end]),
    [['2026-02-01', '2026-02-28'], ['2026-03-01', '2026-03-31']], 'February has 28 days in 2026');
  const y = bp.profile([], { grain: 'year', periods: 2, asOf: '2026-03-15' });
  assert.deepStrictEqual(y.periods.map(x => [x.start, x.end]),
    [['2025-01-01', '2025-12-31'], ['2026-01-01', '2026-12-31']]);
});

check('a leap February is 29 days, not 28', () => {
  const m = bp.profile([], { grain: 'month', periods: 1, asOf: '2028-02-10' });
  assert.strictEqual(m.periods[0].end, '2028-02-29');
});

check('the period still running is marked, so its bar is not read as a drop', () => {
  const y = bp.profile([], { grain: 'year', periods: 2, asOf: '2026-03-15' });
  assert.strictEqual(y.periods[0].partial, false, '2025 is over');
  assert.strictEqual(y.periods[1].partial, true, '2026 is not');
});

check('the window ends on TODAY\'S period, and runs backwards from it', () => {
  const p = bp.profile([], { grain: 'month', periods: 3, asOf: '2026-09-16' });
  assert.deepStrictEqual(p.periods.map(x => x.label), ['Jul', 'Aug', 'Sep']);
});

check('a window spanning two years says which year each bar is', () => {
  // Twelve bars reading Jan…Dec need no year; eighteen that silently wrap into
  // a second January would be unreadable without one.
  const one = bp.profile([], { grain: 'month', periods: 3, asOf: '2026-09-16' });
  assert.deepStrictEqual(one.periods.map(x => x.label), ['Jul', 'Aug', 'Sep']);
  const two = bp.profile([], { grain: 'month', periods: 14, asOf: '2026-09-16' });
  assert.ok(two.periods.every(x => /\d{2}$/.test(x.label)), `got ${JSON.stringify(two.periods.map(x => x.label))}`);
});

/* ── what it refuses ─────────────────────────────────────────────────── */

check('WITH NO `asOf`, TODAY IS TODAY — not the epoch', () => {
  // `new Date(null)` is the epoch, not an invalid date, so a missing `asOf`
  // once made the whole chart twelve empty months of 1969. Every test above
  // supplies `asOf` and none of them caught it; the real store did, instantly.
  const p = bp.profile([], { grain: 'year', periods: 1 });
  assert.strictEqual(p.periods[0].label, String(new Date().getUTCFullYear()),
    `the last bar is the current year, got ${p.periods[0].label}`);
  const m = bp.profile([], { grain: 'month', periods: 1 });
  assert.strictEqual(m.periods[0].end.slice(0, 4), String(new Date().getUTCFullYear()));
  // And an empty string is as missing as null.
  assert.strictEqual(bp.profile([], { grain: 'year', periods: 1, asOf: '' }).periods[0].label,
    String(new Date().getUTCFullYear()));
});

check('an unknown grain falls back to months rather than returning nothing', () => {
  assert.strictEqual(bp.profile([], { grain: 'fortnight', asOf: '2026-09-16' }).grain, 'month');
  assert.strictEqual(bp.profile([], { asOf: '2026-09-16' }).grain, 'month');
});

check('a silly period count is clamped, not honoured', () => {
  assert.strictEqual(bp.profile([], { grain: 'week', periods: 9999, asOf: '2026-09-16' }).periods.length, bp.MAX_PERIODS.week);
  assert.strictEqual(bp.profile([], { grain: 'month', periods: 0, asOf: '2026-09-16' }).periods.length, bp.DEFAULT_PERIODS.month);
  assert.strictEqual(bp.profile([], { grain: 'month', periods: -5, asOf: '2026-09-16' }).periods.length, bp.DEFAULT_PERIODS.month);
});

check('an empty store profiles to a row of zeroes, not to an error', () => {
  const p = bp.profile([], { grain: 'month', periods: 3, asOf: '2026-09-16' });
  assert.strictEqual(p.periods.length, 3);
  assert.deepStrictEqual(p.periods.map(x => x.total), [0, 0, 0]);
  assert.strictEqual(bp.profile(null, { asOf: '2026-09-16' }).periods.length, bp.DEFAULT_PERIODS.month);
});

/* ── run ───────────────────────────────────────────────────────────── */

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
