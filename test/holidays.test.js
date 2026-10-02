'use strict';
/**
 * holidays.test.js — the public-holiday list and the calendar built from it.
 *
 * Two things here can be wrong in ways nobody notices: a date that silently
 * becomes a different date, and a calendar grid that puts a day under the
 * wrong weekday. Both produce a screen that looks completely normal.
 *
 * Run: node test/holidays.test.js
 */

const assert = require('node:assert');
const h = require('../lib/holidays');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

console.log('\nPublic holidays\n');

/* ── PARSING ──────────────────────────────────────────────────────────── */

check('A REAL DATE PARSES, and anything else does not', () => {
  assert.strictEqual(h.parse('2026-09-02'), '2026-09-02');
  assert.strictEqual(h.parse('  2026-09-02 '), '2026-09-02', 'surrounding space is not a reason to refuse');
  assert.strictEqual(h.parse(''), null);
  assert.strictEqual(h.parse('2026-9-2'), null, 'the format is fixed-width on purpose');
  assert.strictEqual(h.parse('02/09/2026'), null);
  assert.strictEqual(h.parse('next Tuesday'), null);
  assert.strictEqual(h.parse(null), null);
});

check('A DATE THAT DOES NOT EXIST IS REFUSED, not rolled over', () => {
  /* The whole reason `parse` round-trips. `new Date('2026-02-30T00:00:00Z')`
     does not throw — it quietly becomes 2 March. A list holding a date that
     turned into a different date is worse than one that rejected it, because
     the wrong day then reads as a holiday on every availability grid. */
  assert.strictEqual(h.parse('2026-02-30'), null, 'February 30th was accepted');
  assert.strictEqual(h.parse('2026-13-01'), null, 'there is no thirteenth month');
  assert.strictEqual(h.parse('2026-04-31'), null, 'April has thirty days');
  // And a leap day that DOES exist is kept.
  assert.strictEqual(h.parse('2028-02-29'), '2028-02-29');
  assert.strictEqual(h.parse('2026-02-29'), null, '2026 is not a leap year');
});

/* ── THE LIST ─────────────────────────────────────────────────────────── */

check('A LIST IS DEDUPED AND SORTED', () => {
  const r = h.normalise(['2026-09-02', '2026-01-01', '2026-09-02']);
  assert.deepStrictEqual(r.dates, ['2026-01-01', '2026-09-02']);
  assert.deepStrictEqual(r.errors, []);
});

check('AND A BAD DATE IS REPORTED, not silently dropped', () => {
  /* The paste box has to be able to say which line it could not read. A list
     that quietly came back shorter teaches people to re-paste and hope. */
  const r = h.normalise(['2026-01-01', 'Tet', '2026-02-30']);
  assert.deepStrictEqual(r.dates, ['2026-01-01']);
  assert.strictEqual(r.errors.length, 2);
  assert.match(r.errors[0].message, /Tet is not a date/);
  assert.strictEqual(r.dropped, 2);
});

check('A PASTED STRING IS A LIST TOO — commas, newlines or semicolons', () => {
  /* Whatever HR sent. Splitting on one separator and not the others makes the
     paste box work for one person's spreadsheet and not the next one's. */
  assert.deepStrictEqual(h.normalise('2026-01-01, 2026-04-30\n2026-05-01;2026-09-02').dates,
    ['2026-01-01', '2026-04-30', '2026-05-01', '2026-09-02']);
  assert.deepStrictEqual(h.normalise('2026-01-01,').errors, [], 'a trailing comma is not a mistake');
});

check('AND AN EMPTY LIST IS AN EMPTY LIST, not an error', () => {
  assert.deepStrictEqual(h.normalise([]).dates, []);
  assert.deepStrictEqual(h.normalise('').dates, []);
  assert.deepStrictEqual(h.normalise(null).dates, []);
});

/* ── TOGGLING ─────────────────────────────────────────────────────────── */

check('A CLICK ADDS A DAY, and a second click takes it away', () => {
  const on = h.toggle(['2026-01-01'], '2026-09-02');
  assert.deepStrictEqual(on.dates, ['2026-01-01', '2026-09-02']);
  assert.strictEqual(on.on, true);

  const off = h.toggle(on.dates, '2026-09-02');
  assert.deepStrictEqual(off.dates, ['2026-01-01']);
  assert.strictEqual(off.on, false);
});

check('AND THE WHOLE LIST COMES BACK, so the screen never keeps its own copy', () => {
  /* A calendar tracking its own state drifts from the stored list the first
     time a save fails — and the drift is invisible: the day stays coloured and
     the plan does not have it. */
  const r = h.toggle(['2026-09-02', '2026-01-01'], '2026-04-30');
  assert.deepStrictEqual(r.dates, ['2026-01-01', '2026-04-30', '2026-09-02'],
    'the answer has to be the full, sorted list');
});

check('TOGGLING SOMETHING THAT IS NOT A DATE CHANGES NOTHING', () => {
  const r = h.toggle(['2026-01-01'], '2026-02-30');
  assert.deepStrictEqual(r.dates, ['2026-01-01']);
  assert.strictEqual(r.changed, false);
  assert.match(r.error, /not a date/);
});

check('AND IT CLEANS THE LIST IT WAS HANDED ON THE WAY PAST', () => {
  const r = h.toggle(['2026-09-02', 'rubbish', '2026-09-02'], '2026-01-01');
  assert.deepStrictEqual(r.dates, ['2026-01-01', '2026-09-02']);
});

/* ── YEARS ────────────────────────────────────────────────────────────── */

check('THE YEAR PICKER REACHES BACKWARDS AND FORWARDS', () => {
  /* Planning crosses a year boundary. A calendar that could not reach next
     January would be useless every December. */
  const ys = h.years([], new Date('2026-10-01T00:00:00Z'));
  assert.deepStrictEqual(ys, [2025, 2026, 2027]);
});

check('AND IT REACHES ANY YEAR THE PLAN ALREADY HAS HOLIDAYS IN', () => {
  /* A list you cannot see is a list you cannot correct. */
  const ys = h.years(['2019-01-01', '2031-12-25'], new Date('2026-10-01T00:00:00Z'));
  assert.deepStrictEqual(ys, [2019, 2025, 2026, 2027, 2031]);
});

check('BY-YEAR GROUPS THE LIST', () => {
  const g = h.byYear(['2026-01-01', '2027-01-01', '2026-09-02']);
  assert.deepStrictEqual(g['2026'], ['2026-01-01', '2026-09-02']);
  assert.deepStrictEqual(g['2027'], ['2027-01-01']);
});

/* ── THE GRID ─────────────────────────────────────────────────────────── */

check('A YEAR IS TWELVE MONTHS', () => {
  const cal = h.calendar(2026);
  assert.strictEqual(cal.length, 12);
  assert.strictEqual(cal[0].name, 'January');
  assert.strictEqual(cal[11].name, 'December');
});

check('EVERY WEEK IS SEVEN CELLS, and every day appears exactly once', () => {
  /* The failure this catches is a grid that looks fine and puts the 1st under
     the wrong weekday — which nobody checks, and which makes every holiday
     someone clicks the wrong day. */
  for (const y of [2024, 2026, 2027, 2028]) {       // includes a leap year
    const cal = h.calendar(y);
    const seen = [];
    for (const m of cal) {
      for (const w of m.weeks) {
        assert.strictEqual(w.length, 7, `${y} ${m.name} has a week of ${w.length}`);
        for (const d of w) if (d) seen.push(d);
      }
    }
    const expected = (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 366 : 365;
    assert.strictEqual(seen.length, expected, `${y} should have ${expected} days, got ${seen.length}`);
    assert.strictEqual(new Set(seen).size, expected, `${y} repeats a day`);
  }
});

check('THE WEEK STARTS ON MONDAY, like every other grid in this tool', () => {
  /* 1 January 2026 is a Thursday, so it sits in the fourth column with three
     blanks before it. A Sunday-first grid would put it in the fifth and every
     day of the year under the wrong heading. */
  const jan = h.calendar(2026)[0];
  assert.deepStrictEqual(jan.weeks[0], [null, null, null, '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
});

check('AND THE BLANKS ARE BLANK, not days from the month either side', () => {
  /* A greyed-out 30th of the previous month is a day you can click, and
     clicking it marks a holiday in a month you are not looking at. */
  const cal = h.calendar(2026);
  for (const m of cal) {
    for (const d of m.weeks.flat()) {
      if (d === null) continue;
      assert.strictEqual(Number(d.slice(5, 7)), m.month + 1,
        `${m.name} contains ${d}, which is not in it`);
    }
  }
});

check('A NONSENSE YEAR DRAWS NOTHING rather than throwing', () => {
  assert.deepStrictEqual(h.calendar('not a year'), []);
  assert.deepStrictEqual(h.calendar(null), []);
  /* `Number(null)` and `Number([])` are both 0, so a NaN check alone happily
     draws the twelve months of year zero — a grid that renders perfectly and
     means nothing. A literal 0 reaches past the null guard and needs the range. */
  assert.deepStrictEqual(h.calendar(0), [], 'year zero drew a calendar');
  assert.deepStrictEqual(h.calendar(99999), []);
  assert.deepStrictEqual(h.calendar([]), []);
});

check('THE DATES ARE UTC WHEREVER THE MACHINE IS', () => {
  /* THE BUG THIS CATCHES ONLY APPEARS WEST OF GREENWICH, and the machine that
     runs these checks is on UTC — so reading `getDate()` instead of
     `getUTCDate()` passes here and shifts every date by one day for anyone in
     the Americas. Run in a child process with TZ set, because a timezone
     cannot be changed inside a running Node process.

     New York is UTC-5: midnight UTC on 2 September is 19:00 on 1 September
     there, so a local-time formatter reports the wrong day. */
  const { execFileSync } = require('node:child_process');
  const script = `
    const h = require(${JSON.stringify(require('node:path').join(__dirname, '..', 'lib', 'holidays.js'))});
    const out = {
      iso: h.iso(new Date('2026-09-02T00:00:00Z')),
      parse: h.parse('2026-09-02'),
      jan1: h.calendar(2026)[0].weeks[0][3],
      weekend: h.isWeekend('2026-01-03'),
    };
    process.stdout.write(JSON.stringify(out));
  `;
  for (const tz of ['America/New_York', 'Pacific/Kiritimati', 'Asia/Ho_Chi_Minh']) {
    const out = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8', env: { ...process.env, TZ: tz },
    }));
    assert.strictEqual(out.iso, '2026-09-02', `iso() shifted a day in ${tz}`);
    assert.strictEqual(out.parse, '2026-09-02', `parse() refused a real date in ${tz}`);
    assert.strictEqual(out.jan1, '2026-01-01', `the calendar grid shifted in ${tz}`);
    assert.strictEqual(out.weekend, true, `a Saturday stopped being a weekend in ${tz}`);
  }
});

/* ── WEEKENDS ─────────────────────────────────────────────────────────── */

check('A WEEKEND IS RECOGNISED, so the screen can say marking one changes nothing', () => {
  assert.strictEqual(h.isWeekend('2026-01-03'), true, '3 Jan 2026 is a Saturday');
  assert.strictEqual(h.isWeekend('2026-01-04'), true, 'and the 4th a Sunday');
  assert.strictEqual(h.isWeekend('2026-01-05'), false, 'the 5th is a Monday');
  assert.strictEqual(h.isWeekend('rubbish'), false);
});

/* ── THE BROWSER'S ONE SCRIPT SCOPE ───────────────────────────────────────
 *
 * This shipped broken, and the reason is worth keeping a check for.
 *
 * The page loads this file as a classic <script> alongside /shared/query.js.
 * Classic scripts share ONE top-level scope, so a `const API` here and a
 * `const API` there is not shadowing — it is `SyntaxError: Identifier 'API'
 * has already been declared`, which aborts the whole file before a line of it
 * runs. The calendar fell back to the paste box, the page otherwise worked,
 * and the only evidence was one line in a console nobody had open.
 *
 * Node never sees it: `require` gives every module its own wrapper, so the
 * unit checks above all passed against a file the browser refused to execute.
 *
 * So this runs them the way the BROWSER does — every shared script, in the
 * order index.html lists them, in one shared context.
 */

const { readFileSync } = require('node:fs');
const nodePath = require('node:path');
const vm = require('node:vm');
const ROOT = nodePath.join(__dirname, '..');

/** The /shared/ scripts, in the order the page loads them. */
function sharedScripts() {
  const html = readFileSync(nodePath.join(ROOT, 'public', 'index.html'), 'utf8');
  return [...html.matchAll(/<script src="\/shared\/([^"]+)"><\/script>/g)].map(m => m[1]);
}

check('EVERY SHARED SCRIPT LOADS IN ONE SCOPE, as the browser loads them', () => {
  const files = sharedScripts();
  assert.ok(files.length >= 2, `fixture check: expected several shared scripts, found ${files.length}`);

  const win = {};
  const ctx = vm.createContext({ window: win, globalThis: win, console });
  for (const f of files) {
    const src = readFileSync(nodePath.join(ROOT, 'lib', f), 'utf8');
    try {
      vm.runInContext(src, ctx, { filename: `/shared/${f}` });
    } catch (err) {
      assert.fail(`/shared/${f} will not load in the browser: ${err.message}`);
    }
  }
  /* AND EACH ONE ACTUALLY PUBLISHED ITSELF. A file that loads without throwing
     but sets no global is the same failure one step later — the calendar still
     falls back and still says nothing useful. */
  assert.strictEqual(typeof win.Holidays, 'object', 'holidays.js did not set window.Holidays');
  assert.strictEqual(typeof win.Holidays.calendar, 'function');
  assert.strictEqual(typeof win.QueryChips, 'object', 'query.js did not set window.QueryChips');
});

/* QUERY.JS PREDATES THE RULE and leaks thirteen function declarations into the
   page's scope. It is grandfathered HERE, by name, rather than by weakening the
   check — so the debt is recorded where somebody will read it, and wrapping
   that file shortens this list instead of being invisible work.

   It is not currently breaking anything: nothing else declares those names.
   It came within one script of doing so — `parse` is both a query parser and a
   date parser, and whichever file loaded second was going to win the name for
   both of them. */
const GRANDFATHERED = {
  'query.js': ['indexAliases', 'registerExtraFields', 'tokenize', 'queryError', 'parse',
    'parseOrderBy', 'coerce', 'quote', 'stringify', 'render', 'fromChips', 'castChip', 'toChips'],
};

check('A SHARED SCRIPT DECLARES NOTHING IN THE PAGE\'S SCOPE', () => {
  /* The check above catches a collision between the files that exist TODAY.
     This one catches the next one before it is written: a shared script that
     declares anything in the shared scope is one rename away from colliding
     with a file it has never heard of. Wrapping is the rule, and this is the
     rule written down somewhere that enforces it. */
  for (const f of sharedScripts()) {
    const win = {};
    const ctx = vm.createContext({ window: win, globalThis: win, console });
    const before = new Set(Object.getOwnPropertyNames(ctx));
    vm.runInContext(readFileSync(nodePath.join(ROOT, 'lib', f), 'utf8'), ctx, { filename: `/shared/${f}` });
    const allowed = new Set(GRANDFATHERED[f] || []);
    const leaked = Object.getOwnPropertyNames(ctx)
      .filter(n => !before.has(n) && n !== 'Holidays' && n !== 'QueryChips' && !allowed.has(n));
    assert.deepStrictEqual(leaked, [],
      `/shared/${f} leaked ${leaked.join(', ')} into the page's global scope — wrap the module in an IIFE`);
  }
});

check('THE BROWSER AND NODE GET THE SAME ANSWERS', () => {
  /* Two export paths, one file. A wrapper that published a different object to
     the browser than it returns to `require` would make the calendar and the
     server disagree about a date, which is the exact failure serving one file
     to both exists to prevent. */
  const win = {};
  const ctx = vm.createContext({ window: win, globalThis: win, console });
  vm.runInContext(readFileSync(nodePath.join(ROOT, 'lib', 'holidays.js'), 'utf8'), ctx);
  assert.deepStrictEqual(Object.keys(win.Holidays).sort(), Object.keys(h).sort(),
    'the browser build exposes a different surface from the Node one');
  assert.strictEqual(win.Holidays.parse('2026-02-30'), h.parse('2026-02-30'));
  /* COMPARED AS JSON. The vm context is a separate realm, so its arrays carry a
     different `Array.prototype` and are never deepStrictEqual to ours however
     identical their contents — a realm difference, not a difference in the
     answer. */
  const json = (v) => JSON.stringify(v);
  assert.strictEqual(json(win.Holidays.calendar(2026)[0].weeks[0]), json(h.calendar(2026)[0].weeks[0]));
  assert.strictEqual(json(win.Holidays.normalise(['2026-09-02', 'x']).dates), json(h.normalise(['2026-09-02', 'x']).dates));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
