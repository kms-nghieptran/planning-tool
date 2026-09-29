'use strict';

/**
 * mail-schedule.js — when the weekly report goes out, and when it must not.
 *
 * ── THE PROBLEM THIS IS ACTUALLY SOLVING ─────────────────────────────────
 *
 * "Send it every Monday at 8" sounds like a one-line `setInterval`. It is
 * not, because the machine this runs on is a laptop. It sleeps. It gets
 * closed on Friday and opened on Tuesday. The app gets restarted in the
 * middle of a send. Every one of those is normal, and every one of them
 * produces a wrong answer from the naive version:
 *
 *   A TIMER THAT COUNTS SEVEN DAYS drifts with every restart, so "Monday 8am"
 *   becomes "whenever the app happened to start, plus a week", and after a
 *   month of ordinary laptop use it fires on Thursday afternoon.
 *
 *   A CHECK THAT ONLY LOOKS AT "IS IT 8AM NOW" misses the slot entirely if
 *   the machine was asleep at 8am — which, for an 8am send, is most weeks.
 *
 *   A CATCH-UP THAT SENDS EVERYTHING IT MISSED mails the client three
 *   identical reports when he comes back from leave.
 *
 *   AND A RESTART DURING A SEND sends it twice, because nothing recorded
 *   that the first attempt had begun.
 *
 * So the schedule is not a timer at all. It is a QUESTION ASKED REPEATEDLY:
 * "what is the most recent moment this should have gone out, and has it?"
 * The answer is derived from the wall clock every time, so it cannot drift;
 * the "has it" is a durable claim in the database, so a restart cannot
 * unlearn it.
 *
 * ── THE ASYMMETRY THAT DECIDES EVERY EDGE CASE ───────────────────────────
 *
 * A missed send costs him a click — he notices no report arrived and presses
 * Send. A duplicate send goes to a CLIENT, twice, with his name on it, and
 * cannot be taken back. Those are not remotely the same price, so every
 * ambiguous case here resolves the same way: DO NOT SEND. That is why the
 * claim is written before the attempt rather than after it, and why a slot
 * whose outcome is unknown is never retried.
 *
 * This module holds no timer and touches no database. It answers the
 * question; `server.js` asks it once a minute and owns the consequences.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * HOW LATE IS STILL WORTH SENDING.
 *
 * Twelve hours: a Monday 8am report that goes out at 6pm Monday is late but
 * still true — the figures are today's and the client reads it with Monday's
 * date on it. The same report arriving Wednesday is worse than silence,
 * because it is titled as Monday's and the numbers have moved underneath it.
 *
 * The window also has to be long enough to cover the ordinary case it exists
 * for: a laptop shut at 6pm Friday and opened at 9am Monday misses an 8am
 * slot by an hour and should absolutely still send.
 */
const GRACE_MS = 12 * 60 * 60 * 1000;

/**
 * Read a schedule off a template, or `null` if it has none.
 *
 * EVERY FIELD IS CLAMPED rather than validated-and-rejected. This is read on
 * a timer with nobody watching; a schedule that throws at 8am on a Monday
 * because `hour` arrived as a string is a silent failure of the whole
 * feature. A nonsense value becomes a sane one and the send happens.
 */
function normalise(input) {
  if (!input || typeof input !== 'object') return null;
  const int = (v, lo, hi, dflt) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  return {
    enabled: !!input.enabled,
    day: int(input.day, 0, 6, 1),
    hour: int(input.hour, 0, 23, 8),
    minute: int(input.minute, 0, 59, 0),
    /* WHICH TEAM'S REPORT. Held on the schedule rather than taken from
       whatever the screen last had selected — an unattended send has no
       screen, and a report that silently changed teams because he was
       looking at a different one on Friday is the kind of error a client
       spots before he does. */
    team: input.team ? String(input.team) : null,
    components: Array.isArray(input.components) ? input.components.filter(Boolean).map(String) : [],
  };
}

/** `Monday at 08:00` — for the screen, and for the log line. */
function describe(s) {
  const sched = normalise(s);
  if (!sched) return 'Not scheduled';
  const hh = String(sched.hour).padStart(2, '0');
  const mm = String(sched.minute).padStart(2, '0');
  return `${DAYS[sched.day]} at ${hh}:${mm}`;
}

/**
 * THE MOST RECENT MOMENT THIS SHOULD HAVE GONE OUT, at or before `now`.
 *
 * LOCAL TIME, deliberately. "Monday at 8" means 8am where he is sitting. The
 * database keys are built from this same local value, so the whole feature
 * is consistent in the only timezone he thinks in.
 *
 * `setHours` IS REPEATED AFTER `setDate`, which looks redundant and is not.
 * Stepping the date across a daylight-saving boundary shifts the clock time
 * by an hour; re-setting it pins the wall clock, so the slot stays at 08:00
 * through a transition instead of wandering to 07:00 and firing twice in one
 * week. His machine is on a timezone with no DST, so this would never have
 * shown up here — which is exactly why it is written down rather than left
 * to be discovered by whoever runs this somewhere else.
 */
function lastSlotAtOrBefore(sched, now) {
  const s = normalise(sched);
  const at = new Date(now);
  const d = new Date(at);
  d.setHours(s.hour, s.minute, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - s.day + 7) % 7));
  d.setHours(s.hour, s.minute, 0, 0);
  if (d.getTime() > at.getTime()) {
    d.setDate(d.getDate() - 7);
    d.setHours(s.hour, s.minute, 0, 0);
  }
  return d;
}

/** The next one after `now` — what the screen shows as "next send". */
function nextSlotAfter(sched, now) {
  const s = normalise(sched);
  const d = lastSlotAtOrBefore(s, now);
  const n = new Date(d);
  n.setDate(n.getDate() + 7);
  n.setHours(s.hour, s.minute, 0, 0);
  return n;
}

/**
 * THE KEY A SLOT IS CLAIMED UNDER — `2026-09-29T08:00`, in local time.
 *
 * Not a timestamp, and not UTC. The point of this string is that the same
 * scheduled moment produces the same key every time it is computed, on every
 * tick, before and after a restart. A UTC key would be correct too, but it
 * would not match what the log and the screen say, and the first time he
 * compares them at 15:00 local he would have to do timezone arithmetic to
 * satisfy himself that a send had not gone out twice.
 */
function slotKey(date) {
  const d = new Date(date);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Should this template send right now?
 *
 * @param {object} sched     the template's schedule
 * @param {Date}   now       injected, so a whole week is one line in a test
 * @param {object} o         { claimed(key) -> bool, grace }
 * @returns {{fire, reason, slot, key, late}}
 *
 * The four reasons are the whole state machine:
 *
 *   `off`     — no schedule, or switched off. Nothing is recorded.
 *   `done`    — this slot is already claimed. The ordinary answer: it is
 *               returned about ten thousand times a week and once, briefly,
 *               it is not.
 *   `missed`  — the slot passed while nothing was running and it is now too
 *               stale to be worth sending. RECORDED rather than ignored, so
 *               "no report last Monday" has an answer on the screen instead
 *               of being indistinguishable from a send that failed silently.
 *   `due`     — send it.
 */
function decide(sched, now = new Date(), o = {}) {
  const s = normalise(sched);
  if (!s || !s.enabled) return { fire: false, reason: 'off', slot: null, key: null, late: 0 };

  const slot = lastSlotAtOrBefore(s, now);
  const key = slotKey(slot);
  const late = new Date(now).getTime() - slot.getTime();
  const claimed = o.claimed || (() => false);

  if (claimed(key)) return { fire: false, reason: 'done', slot, key, late };
  const grace = o.grace == null ? GRACE_MS : o.grace;
  if (late > grace) return { fire: false, reason: 'missed', slot, key, late };
  return { fire: true, reason: 'due', slot, key, late };
}

/**
 * How late, in words, for the log.
 *
 * A send that went out four hours after its slot is not the same event as one
 * that went out on time, and the difference is the only sign he will ever get
 * that his laptop was closed. Written into the record rather than computed
 * later, because by the time anybody looks the clock has moved on.
 */
function lateness(ms) {
  const m = Math.round(Math.max(0, ms) / 60000);
  if (m < 2) return 'on time';
  if (m < 60) return `${m} minutes late`;
  const h = Math.round(m / 6) / 10;
  return `${h} hours late`;
}

module.exports = {
  DAYS, GRACE_MS, normalise, describe,
  lastSlotAtOrBefore, nextSlotAfter, slotKey, decide, lateness,
};
