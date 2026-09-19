'use strict';
/**
 * sprint-dates.test.js — the start is the start, the end is the last working day.
 *
 * HIS RULE, AND WHY THE DATA DID NOT FOLLOW IT
 *
 * Jira's sprint end is a timestamp, and the sync keeps its first ten characters.
 * Whether that lands on the sprint's last day or on the NEXT sprint's first day
 * depends on the board's configured time and the timezone it is read in. In the
 * live store it split his boards down the middle: 66 sprints came back Thu → Thu
 * and 51 came back Thu → Wed, for the identical fortnight on the identical
 * cadence. Titan Sprint 33 "ends" 25 Jun and Titan Sprint 34 "starts" 25 Jun —
 * consecutive sprints cannot share a day, which is the proof that end date is
 * exclusive.
 *
 * THE FAILURE MODE is a date that looks completely normal. Nothing renders
 * oddly, nothing throws; one board simply shows a sprint a day longer than the
 * board beside it, and every capacity figure derived from it is a day generous.
 */

const assert = require('node:assert');
const sd = require('../lib/sprint-dates');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nSprint dates\n');

const dow = (iso) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${iso}T00:00:00Z`).getUTCDay()];

/* ── FROM JIRA'S OWN TIMESTAMPS ───────────────────────────────────────────
   Every timestamp below is real, copied out of his Jira. Two things were wrong
   with keeping the first ten characters of each:

   THE TIMEZONE. His boards are Asia/Bangkok, so a boundary set at local
   midnight is stored as 17:00:00.000Z the day before. Sprint 41 starts Thu
   1 Oct; sliced in UTC it read Wed 30 Sep — the START was wrong, not only
   the end.

   A STARTED SPRINT DOES NOT BEGIN AT MIDNIGHT. Click "start sprint" at 09:22
   and Jira writes that instant plus fourteen days. The duration is a clean
   fortnight; the calendar span reads as fifteen days. */

check('THE START DATE IS THE DAY IT IS IN THE BOARD\'S TIMEZONE', () => {
  // Titan Sprint 41, exactly as Jira holds it. 17:00Z is local midnight.
  const d = sd.fromJira('2026-09-30T17:00:00.000Z', '2026-10-14T17:00:00.000Z', 'Asia/Bangkok');
  assert.strictEqual(d.start, '2026-10-01', `Thu 1 Oct, got ${d.start}`);
  assert.strictEqual(d.end, '2026-10-14', `Wed 14 Oct, got ${d.end}`);
  assert.strictEqual(dow(d.start), 'Thu');
  assert.strictEqual(dow(d.end), 'Wed');
  // And read in UTC — what the sync used to do — the start is a day early.
  assert.strictEqual(sd.fromJira('2026-09-30T17:00:00.000Z', '2026-10-14T17:00:00.000Z', null).start, '2026-09-30',
    'this is the bug being fixed, pinned so the timezone cannot quietly stop being applied');
});

check('A SPRINT STARTED MID-MORNING STILL ENDS TEN WORKING DAYS LATER', () => {
  // Titan Sprint 39: someone clicked start at 09:22 local, so Jira's end is
  // 09:22 a fortnight later. Truncating both makes it look like fifteen days.
  const d = sd.fromJira('2026-09-03T02:22:05.312Z', '2026-09-17T02:22:19.000Z', 'Asia/Bangkok');
  assert.strictEqual(d.start, '2026-09-03', 'Thu 3 Sep');
  assert.strictEqual(d.end, '2026-09-16', `Wed 16 Sep, got ${d.end}`);
});

check('and the other board\'s copy of that sprint lands on the SAME two days', () => {
  // Ruby Sprint 39 — same sprint, completed at a different time of day, which
  // is exactly what used to split the two boards a day apart.
  const titan = sd.fromJira('2026-09-03T02:22:05.312Z', '2026-09-17T02:22:19.000Z', 'Asia/Bangkok');
  const ruby = sd.fromJira('2026-09-03T02:22:43.935Z', '2026-09-16T14:27:27.000Z', 'Asia/Bangkok');
  assert.deepStrictEqual(ruby, titan, 'two boards on one cadence get one answer');
});

check('the length comes from the DURATION, not from subtracting two truncated dates', () => {
  // Titan Sprint 40: start 15:56 local, end 15:56 a fortnight later. The naive
  // reading spans 17 Sep to 1 Oct — fifteen days, and it overlaps Sprint 41.
  const d = sd.fromJira('2026-09-17T08:56:05.000Z', '2026-10-01T08:56:00.000Z', 'Asia/Bangkok');
  assert.strictEqual(d.start, '2026-09-17');
  assert.strictEqual(d.end, '2026-09-30', `Wed 30 Sep, got ${d.end} — Sprint 41 starts 1 Oct`);
});

check('the length is the DURATION Jira recorded, not two truncated dates subtracted', () => {
  // On a clean fortnight either reading lands in the same place once the
  // week-snap has had its say, so this pins the case where they genuinely part:
  // an eighteen-day sprint, too far from any whole week to be snapped. Measured
  // as a duration it is 18 days and ends Thu 22 Jan; measured by subtracting the
  // truncated start date from the end timestamp it is 19, and ends a day later.
  const d = sd.fromJira('2026-01-04T17:00:00.000Z', '2026-01-22T17:00:00.000Z', 'Asia/Bangkok');
  assert.strictEqual(d.start, '2026-01-05', 'Mon 5 Jan');
  assert.strictEqual(d.end, '2026-01-22', `Thu 22 Jan — 18 days, not 19 (got ${d.end})`);
  assert.strictEqual(dow(d.end), 'Thu');
});

check('hand-started sprints drift by a few hours, and the week-snap absorbs it', () => {
  // Each sprint started a little earlier or later than the last, so the measured
  // duration comes out 13.6 or 14.3 days rather than exactly 14. Without the
  // snap those land on 9 and 11 working days — 28 of his 119 sprints did.
  const short = sd.fromJira('2026-09-03T02:00:00.000Z', '2026-09-16T10:00:00.000Z', 'Asia/Bangkok');  // 13.3 days
  const long = sd.fromJira('2026-09-03T02:00:00.000Z', '2026-09-17T20:00:00.000Z', 'Asia/Bangkok');   // 14.75 days
  assert.strictEqual(short.end, '2026-09-16', `got ${short.end}`);
  assert.strictEqual(long.end, '2026-09-16', `got ${long.end}`);
});

check('a weekly sprint is not rounded up to a fortnight', () => {
  const d = sd.fromJira('2026-05-17T17:00:00.000Z', '2026-05-24T17:00:00.000Z', 'Asia/Bangkok');
  assert.strictEqual(d.start, '2026-05-18', 'Mon 18 May');
  assert.strictEqual(d.end, '2026-05-22', `Fri 22 May, got ${d.end}`);
});

check('a future sprint with no dates is given none', () => {
  // Five of his sprints are unscheduled. Inventing a fortnight for them would
  // put a confident date on a sprint nobody has planned.
  assert.deepStrictEqual(sd.fromJira(null, null, 'Asia/Bangkok'), { start: null, end: null });
  assert.deepStrictEqual(sd.fromJira('2026-09-30T17:00:00.000Z', null, 'Asia/Bangkok'),
    { start: '2026-10-01', end: null }, 'a start with no end keeps the start');
});

check('an unusable timezone falls back to UTC rather than stopping the sync', () => {
  // A sync that dies because someone mistyped a zone is worse than one that
  // keeps the old behaviour and is visibly a day out.
  const d = sd.fromJira('2026-09-30T17:00:00.000Z', '2026-10-14T17:00:00.000Z', 'Not/AZone');
  assert.strictEqual(d.start, '2026-09-30', 'UTC, as before');
  assert.strictEqual(sd.dateIn('2026-09-30T17:00:00.000Z', 'Asia/Bangkok'), '2026-10-01');
  assert.strictEqual(sd.dateIn('nonsense', 'Asia/Bangkok'), null, 'and an unparseable timestamp is honestly nothing');
});

check('the zone is read as a ZONE, not as a fixed offset', () => {
  // A hardcoded +07:00 would be right for Bangkok and wrong the first time a
  // board moved to a zone that observes daylight saving.
  assert.strictEqual(sd.dateIn('2026-06-15T23:30:00.000Z', 'America/New_York'), '2026-06-15', 'summer, UTC-4');
  assert.strictEqual(sd.dateIn('2026-12-15T23:30:00.000Z', 'America/New_York'), '2026-12-15', 'winter, UTC-5');
  assert.strictEqual(sd.dateIn('2026-06-15T03:30:00.000Z', 'America/New_York'), '2026-06-14', 'and the day before, locally');
});

/* ── the two boards, made to agree ────────────────────────────────────── */

check('A FORTNIGHT ENDS ON ITS LAST WORKING DAY, whichever way Jira wrote it', () => {
  // Titan Sprint 33 and Ruby Sprint 33 exactly as the live store holds them:
  // the same fortnight, one day of difference in a timestamp.
  const titan = sd.normalise({ start: '2026-06-11', end: '2026-06-25' });   // Thu → Thu
  const ruby = sd.normalise({ start: '2026-06-11', end: '2026-06-24' });    // Thu → Wed

  assert.strictEqual(titan.end, '2026-06-24', `Titan ends Wed 24 Jun, got ${titan.end}`);
  assert.strictEqual(ruby.end, '2026-06-24', `Ruby ends Wed 24 Jun, got ${ruby.end}`);
  assert.deepStrictEqual(titan, ruby, 'two boards on one cadence get one answer');
  assert.strictEqual(titan.workingDays, 10);
  assert.strictEqual(dow(titan.end), 'Wed', 'and it is a weekday');
});

check('the start date is left exactly alone', () => {
  // He was explicit: the start is the start. It is the one date Jira records
  // unambiguously, and moving it would be inventing a sprint that never ran.
  for (const start of ['2026-06-11', '2026-05-24', '2026-09-30']) {
    assert.strictEqual(sd.normalise({ start, end: '2026-07-01' }).start, start);
  }
});

check('a weekly sprint ends on ITS last working day, five days in', () => {
  // "TT Week 18May-24May" as stored: Mon → Mon, eight calendar days.
  const w = sd.normalise({ start: '2026-05-18', end: '2026-05-25' });
  assert.strictEqual(w.end, '2026-05-22', `Fri 22 May, got ${w.end}`);
  assert.strictEqual(w.workingDays, 5, 'a week is five working days, never rounded up to ten');
});

check('a sprint that starts on a weekend still ends on a weekday', () => {
  // "TT Week 25May" really is stored starting Sunday. The start is his to
  // state; the end must still be a day someone could work.
  const s = sd.normalise({ start: '2026-05-24', end: '2026-05-31' });
  assert.strictEqual(s.start, '2026-05-24', 'the Sunday start is preserved');
  assert.strictEqual(dow(s.end), 'Fri', `ends on a Friday, got ${dow(s.end)}`);
  assert.strictEqual(s.workingDays, 5);
});

check('A SPRINT THAT REALLY IS LONGER IS LEFT LONGER', () => {
  // Titan Sprint 16: 16 Oct → 1 Nov 2025, seventeen calendar days. Three off a
  // fortnight is too far to be timestamp noise, so it is not quietly rounded —
  // it is the one sprint on the board worth asking about, and rounding it would
  // hide exactly that.
  const s = sd.normalise({ start: '2025-10-16', end: '2025-11-01' });
  assert.strictEqual(s.days, 17, 'the span is kept as measured');
  assert.strictEqual(s.workingDays, 12);
  assert.strictEqual(s.end, '2025-10-31', 'and still ends on a working day');
});

/* ── applying it to a sprint, and taking it back off ──────────────────── */

check('applying it keeps Jira\'s own date, so a wrong one can still be traced', () => {
  const out = sd.applied({ id: 'S33', start: '2026-06-11', end: '2026-06-25' });
  assert.strictEqual(out.end, '2026-06-24', 'the screen gets the real last day');
  assert.strictEqual(out.jiraEnd, '2026-06-25', 'and what Jira said is still there');
  assert.strictEqual(out.id, 'S33', 'everything else is untouched');
});

check('and a sprint that was already right gains nothing at all', () => {
  const already = { id: 'S33', start: '2026-06-11', end: '2026-06-24' };
  const out = sd.applied(already);
  assert.strictEqual(out.jiraEnd, undefined, 'no jiraEnd noise on the boards that were fine');
  assert.strictEqual(out, already, 'the object is returned as-is');
});

check('APPLYING IT AND UNDOING IT IS THE IDENTITY', () => {
  // This pair is what makes the normalisation a way of READING his data rather
  // than an edit to it. Every route reads the plan, changes one field and saves
  // the whole object back — if these two were not exact inverses, the first
  // saved holiday would write derived dates into the database as Jira's own.
  for (const s of [
    { id: 'a', start: '2026-06-11', end: '2026-06-25' },
    { id: 'b', start: '2026-06-11', end: '2026-06-24' },
    { id: 'c', start: '2026-05-18', end: '2026-05-25' },
    { id: 'd', start: null, end: null },
    { id: 'e', start: '2026-06-11', end: null },
  ]) {
    assert.deepStrictEqual(sd.restored(sd.applied(s)), s, `round trip changed ${s.id}`);
  }
});

check('undoing it on a sprint nobody normalised leaves it alone', () => {
  const s = { id: 'x', start: '2026-06-11', end: '2026-06-24' };
  assert.strictEqual(sd.restored(s), s, 'safe to run over a whole plan whatever its provenance');
});

/* ── what it refuses to invent ────────────────────────────────────────── */

check('a sprint with no dates is given none', () => {
  // Five of his sprints are future rows with no dates at all. An empty sprint
  // should look empty, not be handed a fortnight this tool made up.
  assert.strictEqual(sd.normalise({ start: null, end: null }), null);
  assert.strictEqual(sd.normalise({ start: '2026-06-11', end: null }), null, 'no end means no cadence to read');
  assert.strictEqual(sd.normalise(null), null);
  assert.deepStrictEqual(sd.applied({ id: 'z' }), { id: 'z' });
});

check('a nonsense range is clamped rather than building a year of days', () => {
  const s = sd.normalise({ start: '2026-01-01', end: '2026-12-31' });
  assert.ok(s.days <= 31, `a sprint is not a year — got ${s.days} days`);
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
