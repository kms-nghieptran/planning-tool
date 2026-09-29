'use strict';
/**
 * mail-schedule.test.js — the weekly send, and the four ways it goes wrong.
 *
 * WHAT THIS SUITE IS DEFENDING
 *
 * The scheduler mails a CLIENT, unattended, from his address. Nobody is
 * watching when it fires, which means every failure here is discovered by
 * somebody outside the company — and two of them are discovered as an
 * apology. So the checks below are weighted the way the consequences are:
 *
 *   A DUPLICATE SEND is the expensive one. The client gets the same report
 *   twice with his name on it. Most of this file exists for that.
 *
 *   A DRIFTING SLOT is the insidious one, because it works for weeks. A
 *   timer that counts seven days from boot becomes "Thursday afternoon"
 *   after a month of ordinary laptop use, and nothing ever says so.
 *
 *   A MISSED SEND is cheap but must be VISIBLE, or it is indistinguishable
 *   from the tool being broken.
 *
 *   A STALE SEND — last Monday's report arriving on Wednesday — is worse
 *   than nothing, because it is titled as Monday's and the figures moved.
 *
 * Time is injected everywhere, so a year of Mondays costs a millisecond and
 * a laptop asleep for four days is one line.
 *
 * Run: node test/mail-schedule.test.js
 */

const assert = require('node:assert');
const s = require('../lib/mail-schedule');

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};
console.log('\nThe weekly send\n');

/* Local time throughout — "Monday at 8" means 8am where he is sitting, and
   the whole module agrees on that. `new Date(y, m, d, h, mi)` is local. */
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0);
const MON8 = { enabled: true, day: 1, hour: 8, minute: 0 };

/* ── the slot, which everything else is built on ───────────────────────── */

check('THE SLOT IS THE MOST RECENT MONDAY 08:00, from anywhere in the week', () => {
  // 2026-09-28 is a Monday.
  const cases = [
    [at(2026, 9, 28, 8, 0), '2026-09-28T08:00', 'the moment itself'],
    [at(2026, 9, 28, 8, 1), '2026-09-28T08:00', 'a minute after'],
    [at(2026, 9, 30, 14, 23), '2026-09-28T08:00', 'the Wednesday after'],
    [at(2026, 10, 4, 23, 59), '2026-09-28T08:00', 'the Sunday night after'],
    [at(2026, 9, 28, 7, 59), '2026-09-21T08:00', 'a minute BEFORE — still last week'],
    [at(2026, 9, 27, 12, 0), '2026-09-21T08:00', 'the Sunday before'],
  ];
  for (const [now, want, why] of cases) {
    assert.strictEqual(s.slotKey(s.lastSlotAtOrBefore(MON8, now)), want, why);
  }
});

check('AND IT DOES NOT DRIFT — 52 weeks, every one on a Monday at 08:00', () => {
  /* THE FAILURE THIS EXISTS FOR is a scheduler built on "now + 7 days",
     which is correct on week one and wrong by an unbounded amount later.
     Deriving the slot from the wall clock every time makes drift not a bug
     that was fixed but a state that cannot be represented — and a year of
     evidence is cheap when time is a parameter. */
  let now = at(2026, 1, 5, 9, 0); // a Monday, an hour after the slot
  for (let week = 0; week < 52; week++) {
    const slot = s.lastSlotAtOrBefore(MON8, now);
    assert.strictEqual(slot.getDay(), 1, `week ${week} landed on day ${slot.getDay()}, not Monday`);
    assert.strictEqual(slot.getHours(), 8, `week ${week} landed at ${slot.getHours()}:00`);
    assert.strictEqual(slot.getMinutes(), 0, `week ${week} landed at :${slot.getMinutes()}`);
    now = new Date(now.getTime() + 7 * 86400000);
  }
});

check('THE SLOT KEY IS LOCAL TIME, not UTC', () => {
  /* If this were UTC the key would disagree with what the screen and the log
     print, and the first time he compared them at 15:00 local he would have
     to do timezone arithmetic to convince himself a send had not gone out
     twice. The key exists to be recognised, not just to be unique. */
  const d = at(2026, 9, 28, 8, 0);
  assert.strictEqual(s.slotKey(d), '2026-09-28T08:00');
  assert.strictEqual(s.slotKey(at(2026, 1, 5, 9, 5)), '2026-01-05T09:05', 'zero-padding');
});

check('NEXT SEND IS SEVEN DAYS ON, and it is in the future from every angle', () => {
  for (const now of [at(2026, 9, 28, 7, 59), at(2026, 9, 28, 8, 0), at(2026, 9, 30, 14, 0)]) {
    const next = s.nextSlotAfter(MON8, now);
    assert.ok(next.getTime() > now.getTime(), `next (${s.slotKey(next)}) was not after ${s.slotKey(now)}`);
    assert.strictEqual(next.getDay(), 1);
    assert.strictEqual(next.getHours(), 8);
  }
});

/* ── the decision ──────────────────────────────────────────────────────── */

check('A SLOT THAT HAS JUST ARRIVED FIRES', () => {
  const d = s.decide(MON8, at(2026, 9, 28, 8, 0), { claimed: () => false });
  assert.strictEqual(d.fire, true);
  assert.strictEqual(d.reason, 'due');
  assert.strictEqual(d.key, '2026-09-28T08:00');
});

check('A CLAIMED SLOT NEVER FIRES AGAIN — the duplicate-send guard', () => {
  /* THE EXPENSIVE FAILURE. Once a slot is claimed, every subsequent tick for
     the rest of that week has to answer "no" — and there are about ten
     thousand of them. */
  const claimed = new Set(['2026-09-28T08:00']);
  for (const now of [
    at(2026, 9, 28, 8, 0), at(2026, 9, 28, 8, 1), at(2026, 9, 28, 12, 0),
    at(2026, 9, 29, 8, 0), at(2026, 10, 4, 23, 59),
  ]) {
    const d = s.decide(MON8, now, { claimed: k => claimed.has(k) });
    assert.strictEqual(d.fire, false, `it fired again at ${s.slotKey(now)}`);
    assert.strictEqual(d.reason, 'done');
  }
});

check('AND THE NEXT WEEK IS A DIFFERENT SLOT, so the guard does not jam it shut', () => {
  /* The mirror of the check above, and the reason it is written separately:
     a `decide` that simply returned `fire: false` forever would satisfy the
     duplicate-send test perfectly while never sending anything again. */
  const claimed = new Set(['2026-09-28T08:00']);
  const d = s.decide(MON8, at(2026, 10, 5, 8, 0), { claimed: k => claimed.has(k) });
  assert.strictEqual(d.fire, true, 'the following Monday did not fire');
  assert.strictEqual(d.key, '2026-10-05T08:00');
});

check('A LAPTOP ASLEEP OVER THE WEEKEND STILL SENDS ON MONDAY MORNING', () => {
  /* THE ORDINARY CASE, and the whole reason the grace window exists. He shuts
     the lid on Friday evening and opens it at 09:10 on Monday. The 08:00 slot
     passed while nothing was running; the report is still today's. */
  const d = s.decide(MON8, at(2026, 9, 28, 9, 10), { claimed: () => false });
  assert.strictEqual(d.fire, true, 'an hour late and it refused to send');
  assert.strictEqual(d.key, '2026-09-28T08:00');
  assert.ok(d.late > 0);
});

check('BUT A REPORT THAT IS DAYS LATE IS NOT SENT — it is marked missed', () => {
  /* Wednesday afternoon. "Monday's coverage report" arriving now is titled
     as Monday's and the figures have moved underneath it, so sending is
     worse than silence — but it is RECORDED, because "no report on Monday"
     and "the tool is broken" must not look the same from the screen. */
  const d = s.decide(MON8, at(2026, 9, 30, 14, 0), { claimed: () => false });
  assert.strictEqual(d.fire, false);
  assert.strictEqual(d.reason, 'missed');
  assert.strictEqual(d.key, '2026-09-28T08:00', 'the missed slot is still named, so it can be claimed');
});

check('THE GRACE BOUNDARY IS 12 HOURS, and it is checked on both sides', () => {
  const almost = s.decide(MON8, at(2026, 9, 28, 19, 59), { claimed: () => false });
  assert.strictEqual(almost.fire, true, 'eleven hours fifty-nine minutes should still go');
  const past = s.decide(MON8, at(2026, 9, 28, 20, 1), { claimed: () => false });
  assert.strictEqual(past.fire, false, 'twelve hours one minute should not');
  assert.strictEqual(past.reason, 'missed');
});

check('A SWITCHED-OFF SCHEDULE DOES NOTHING AT ALL — and records nothing', () => {
  /* `off` rather than `missed` matters: a disabled schedule that wrote a
     missed-slot row every week would fill the history he reads to find real
     failures with rows about a feature he deliberately turned off. */
  for (const sched of [null, undefined, {}, { enabled: false, day: 1, hour: 8 }]) {
    const d = s.decide(sched, at(2026, 9, 28, 8, 0), { claimed: () => false });
    assert.strictEqual(d.fire, false, `${JSON.stringify(sched)} fired`);
    assert.strictEqual(d.reason, 'off');
    assert.strictEqual(d.key, null, 'an off schedule named a slot to claim');
  }
});

/* ── the shape of the thing, since it is read off a text box ────────────── */

check('NONSENSE IS CLAMPED RATHER THAN THROWN', () => {
  /* This is read on a timer with nobody watching. A schedule that throws at
     08:00 on a Monday because `hour` arrived as a string takes the whole
     feature down silently — the send does not happen and nothing says why.
     Every field lands somewhere sane instead. */
  const n = s.normalise({ enabled: true, day: 99, hour: -4, minute: 1e9 });
  assert.strictEqual(n.day, 6);
  assert.strictEqual(n.hour, 0);
  assert.strictEqual(n.minute, 59);
  const empty = s.normalise({ enabled: true });
  assert.strictEqual(empty.day, 1, 'the default is Monday');
  assert.strictEqual(empty.hour, 8, 'the default is 08:00');
  const str = s.normalise({ enabled: true, day: '3', hour: '17', minute: '30' });
  assert.deepStrictEqual([str.day, str.hour, str.minute], [3, 17, 30], 'a form sends strings');
  const junk = s.normalise({ enabled: true, hour: 'eight' });
  assert.strictEqual(junk.hour, 8, 'unparseable fell back rather than becoming NaN');
});

check('AND A CLAMPED SCHEDULE STILL PRODUCES A REAL SLOT', () => {
  /* The clamp is only worth anything if what comes out the other side is
     usable — a NaN hour would produce an Invalid Date whose key is the string
     "NaN-NaN-NaN", which claims fine and never matches again. */
  const d = s.decide({ enabled: true, day: '1', hour: 'eight', minute: null }, at(2026, 9, 28, 8, 30), { claimed: () => false });
  assert.strictEqual(d.fire, true);
  assert.strictEqual(d.key, '2026-09-28T08:00');
  assert.ok(!/NaN/.test(d.key), 'the key contains NaN');
});

check('EVERY DAY OF THE WEEK IS REACHABLE, not just Monday', () => {
  /* Off-by-one in `(getDay() - day + 7) % 7` is the classic failure here and
     it hides beautifully: it is correct for exactly one day of the week. */
  for (let day = 0; day < 7; day++) {
    const slot = s.lastSlotAtOrBefore({ enabled: true, day, hour: 8, minute: 0 }, at(2026, 9, 30, 12, 0));
    assert.strictEqual(slot.getDay(), day, `day ${day} produced a slot on day ${slot.getDay()}`);
    assert.ok(slot.getTime() <= at(2026, 9, 30, 12, 0).getTime(), `day ${day} produced a slot in the future`);
  }
});

check('THE DESCRIPTION IS THE ONE HE READS ON THE SCREEN', () => {
  assert.strictEqual(s.describe({ enabled: true, day: 1, hour: 8, minute: 0 }), 'Monday at 08:00');
  assert.strictEqual(s.describe({ enabled: true, day: 5, hour: 17, minute: 30 }), 'Friday at 17:30');
  assert.strictEqual(s.describe(null), 'Not scheduled');
});

check('LATENESS IS SAID IN WORDS, because it is the only sign his Mac was shut', () => {
  assert.strictEqual(s.lateness(0), 'on time');
  assert.strictEqual(s.lateness(30 * 60000), '30 minutes late');
  assert.match(s.lateness(4 * 3600000), /^4 hours late$/);
  assert.strictEqual(s.lateness(-5000), 'on time', 'a clock that moved backwards is not negative-late');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
