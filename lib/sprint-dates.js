'use strict';
/**
 * sprint-dates.js — what a sprint's dates MEAN, in one place.
 *
 * THE PROBLEM THIS EXISTS FOR
 *
 * Jira's sprint dates are TIMESTAMPS, and the sync used to keep the first ten
 * characters of each. Two things go wrong with that, and they were both real.
 *
 * ONE: THE TIMEZONE. His boards are on Asia/Bangkok, so a sprint boundary set
 * at local midnight is stored as `17:00:00.000Z` the previous day. Sprint 41
 * really starts Thu 1 Oct; sliced in UTC it read Wed 30 Sep. The START date was
 * wrong, not only the end.
 *
 * TWO: A STARTED SPRINT DOES NOT BEGIN AT MIDNIGHT. When someone clicks "start
 * sprint" at 09:22, Jira writes that instant as the start and start + 14 days
 * as the end. The DURATION is a clean fortnight, but the calendar span reads as
 * fifteen days, because it begins mid-morning on day one and ends mid-morning
 * on day fifteen. Titan Sprint 39: 3 Sep 09:22 → 17 Sep 09:22 local. The sprint
 * the team actually worked is Thu 3 Sep → Wed 16 Sep.
 *
 * So the dates come FROM JIRA — both of them — read in the board's own
 * timezone, and the length comes from the sprint's DURATION rather than from
 * subtracting two truncated calendar dates.
 *
 * THE RULE, AS HE STATES IT
 *
 *   The start date is the start date.
 *   The end date is ten working days later, for a two-week sprint.
 *
 * Which is: the local day the sprint starts, plus its duration in whole days.
 * Across his 119 dated sprints this gives 118 at exactly ten working days and
 * one genuine weekly sprint at five — with no exceptions left over.
 *
 * PUBLIC HOLIDAYS DO NOT MOVE THE END DATE, deliberately. A holiday inside the
 * sprint does not make the team work an extra day at the end — it makes them
 * available for nine days instead of ten. The calendar is one question ("when
 * does this sprint run"), availability is another ("how much of it can this
 * person work"), and the leave grid already answers the second. Folding them
 * together here would give two teams with different holidays different sprint
 * end dates for the same sprint.
 */

const DAY = 864e5;
const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
const isWeekend = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
const addDays = (isoDate, n) => iso(new Date(parse(isoDate).getTime() + n * DAY));

/**
 * The calendar date a timestamp falls on, in a given timezone.
 *
 * `en-CA` because it formats as YYYY-MM-DD, which is the shape the rest of the
 * app stores dates in; `Intl` because it knows the offset on that date, which
 * a fixed `+07:00` would get wrong the first time a board moved to a zone that
 * observes daylight saving.
 *
 * An unknown zone falls back to UTC rather than throwing: a sync that stops
 * because someone mistyped a timezone is worse than one that keeps the old
 * behaviour and stays visibly a day out.
 */
function dateIn(timestamp, timeZone) {
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return null;
  if (!timeZone) return at.toISOString().slice(0, 10);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at);
  } catch (_) {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * ONE SPRINT'S DATES, FROM JIRA'S OWN TIMESTAMPS.
 *
 * `start` is the local day the sprint began. `end` is that day plus the
 * sprint's DURATION in whole days, minus one — the last day it covers.
 *
 * Duration rather than the gap between two truncated dates, because a sprint
 * started at 09:22 ends at 09:22 a fortnight later, and truncating both ends
 * makes that look like fifteen days. Duration is what Jira actually recorded.
 *
 * The duration is then snapped to whole weeks, which absorbs the hour or two
 * of drift that accumulates when each sprint is started by hand a little
 * earlier or later than the last — that drift is what turns 14 days into a
 * measured 13.6 or 14.3, and it is the only reason the raw numbers wobble.
 *
 * Returns null when Jira gave no dates. A future sprint nobody has scheduled
 * has no dates, and inventing some would be worse than showing none.
 */
function fromJira(startDate, endDate, timeZone = null) {
  if (!startDate) return { start: null, end: null };
  const start = dateIn(startDate, timeZone);
  if (!start) return { start: null, end: null };
  if (!endDate) return { start, end: null };

  const ms = new Date(endDate) - new Date(startDate);
  if (!Number.isFinite(ms)) return { start, end: null };
  const raw = Math.min(31, Math.max(1, Math.round(ms / DAY)));

  // The calendar window, then the last day in it anyone works. For a fortnight
  // those are the same day — Thu + 13 is a Wednesday — but a week that starts
  // on Monday ends on the Sunday, and "the sprint ends Sunday" is not an answer
  // anyone wants. Five working days, ending Friday, is.
  const days = gridDays(start, snapToWeeks(raw));
  const working = days.filter(d => !isWeekend(parse(d)));
  return { start, end: working.length ? working[working.length - 1] : days[days.length - 1] };
}

/**
 * A raw calendar span, snapped to the whole number of weeks it was meant to be.
 *
 * Only a span within two days of a whole week is snapped: that covers the
 * timestamp wobble either side of a real cadence (13–16 → 14, 6–9 → 7) without
 * quietly rewriting a span that is genuinely something else. A 17-day sprint
 * stays 17 days and stays visible — Titan Sprint 16 really did run that long,
 * and a tool that silently rounded it to a fortnight would be hiding the one
 * sprint worth asking about.
 */
function snapToWeeks(days) {
  const weeks = Math.round(days / 7);
  if (weeks < 1) return days;
  const snapped = weeks * 7;
  return Math.abs(days - snapped) <= 2 ? snapped : days;
}

/** The inclusive calendar span between two ISO dates, or null. */
function rawSpan(start, end) {
  if (!start || !end) return null;
  const n = Math.round((parse(end) - parse(start)) / DAY) + 1;
  return Number.isFinite(n) ? Math.min(31, Math.max(1, n)) : null;   // a sprint is not a year
}

/** Every calendar day the sprint covers, ISO, from its start. */
function gridDays(start, length) {
  const out = [];
  if (!start) return out;
  const from = parse(start);
  for (let i = 0; i < length; i++) out.push(iso(new Date(from.getTime() + i * DAY)));
  return out;
}

/**
 * The dates one sprint actually runs, derived from its start and its cadence.
 *
 * Returns `null` when there is nothing to derive from — a sprint with no start,
 * or no end to take a cadence from, keeps whatever it has rather than being
 * given dates this tool invented. An empty future sprint should look empty.
 */
function normalise(sprint) {
  if (!sprint || !sprint.start || !sprint.end) return null;
  const span = rawSpan(sprint.start, sprint.end);
  if (span == null) return null;

  const days = gridDays(sprint.start, snapToWeeks(span));
  const working = days.filter(d => !isWeekend(parse(d)));
  // A whole sprint of weekends is not a real sprint, but it must not produce an
  // end date of `undefined` — the raw end is a better answer than nothing.
  const end = working.length ? working[working.length - 1] : sprint.end;

  return { start: sprint.start, end, days: days.length, workingDays: working.length };
}

/**
 * `sprint` with its end date normalised, and the raw one kept as `jiraEnd`.
 *
 * The raw value is KEPT rather than replaced-and-forgotten: it is what Jira
 * says, the Sources screen exists to show where a number came from, and a
 * derived date that cannot be traced back to its input is a date nobody can
 * check. `jiraEnd` appears only when it actually differs, so it never shows up
 * as noise on the boards that were already consistent.
 */
function applied(sprint) {
  const n = normalise(sprint);
  if (!n || n.end === sprint.end) return sprint;
  /* `jiraEnd` means WHAT JIRA SAID, and once recorded it is never rewritten.
     Without the `||` this overwrote it with whatever it was handed — which,
     once `overridden` runs first, is his own end date. `restored` then put the
     override back as though Jira had said it, and a save wrote it into the
     per-team table for good: clearing the override afterwards changed nothing,
     because there was no longer anything to go back to. */
  return { ...sprint, end: n.end, jiraEnd: 'jiraEnd' in sprint ? sprint.jiraEnd : sprint.end };
}

/**
 * The exact inverse of `applied` — Jira's own end date, back where it was.
 *
 * This is what keeps the normalisation a READ-time decision rather than an
 * edit to his data. Every route reads the plan, changes one field in it and
 * saves the whole thing back; without this, the first time anyone saved a
 * holiday the derived end dates would be written into the database as though
 * Jira had said them, `jiraEnd` would follow them in as a stray column, and
 * the raw value — the only thing that lets a wrong date be traced — would be
 * gone for good.
 *
 * A sprint that was never normalised passes through untouched, so this is safe
 * to run over a whole plan whatever its provenance.
 */
function restored(sprint) {
  if (!sprint || !('jiraEnd' in sprint || 'jiraStart' in sprint)) return sprint;
  const { jiraEnd, jiraStart, ...rest } = sprint;
  /* BY KEY PRESENCE, not by truthiness. A team's copy of a sprint can have no
     dates of its own at all, and `jiraStart || rest.start` then falls through
     to the override — which is how his correction got written into the
     per-team table as though Jira had said it, permanently, so that clearing
     the override afterwards changed nothing. A recorded `null` means "Jira had
     none", and restoring it to none is the whole point. */
  return {
    ...rest,
    ...('jiraStart' in sprint ? { start: jiraStart } : {}),
    ...('jiraEnd' in sprint ? { end: jiraEnd } : {}),
  };
}

/**
 * HIS DATES, WHERE JIRA'S ARE WRONG.
 *
 * Jira is the source for when a sprint ran, and it is usually right — that is
 * what the whole of this file is for. But it is a record of what someone
 * clicked, not of what the team did. "TT Week 14Sep" is stored as 13–27 Sep
 * and really ran 14–30 Sep: a sprint extended in the world and never extended
 * in the tool. Nothing derivable from the timestamps can find that, because
 * there is nothing wrong with them to find.
 *
 * So it is a DECISION, and this codebase has one rule about those: a decision
 * beats a guess, and lives in the plan where no sync can reach it. Sprint
 * dates were the last place that rule was missing.
 *
 * BOTH RAW VALUES ARE KEPT, as `jiraStart` and `jiraEnd`, for the same reason
 * `applied` keeps one: the Sources screen exists to show where a number came
 * from, and an overridden date that cannot be traced to the value it replaced
 * is a date nobody can check. `restored` above puts them back before anything
 * is written, so the override stays a READ-time decision and never leaks into
 * the database as though Jira had said it.
 */
function overridden(sprint, o) {
  if (!sprint || !o || (!o.start && !o.end)) return sprint;
  const start = o.start || sprint.start;
  const end = o.end || sprint.end;
  if (start === sprint.start && end === sprint.end) return sprint;
  return {
    ...sprint,
    start,
    end,
    /* Recorded whenever something moved — INCLUDING when what it moved from
       was nothing. A team's copy of a sprint may carry no dates of its own,
       and `jiraStart: undefined` is what tells `restored` to put it back to
       having none rather than keeping his value. An override that matches
       Jira exactly moves nothing and leaves no trace to explain. */
    ...(start !== sprint.start ? { jiraStart: sprint.start ?? null } : {}),
    ...(end !== sprint.end ? { jiraEnd: sprint.end ?? null } : {}),
  };
}

module.exports = { snapToWeeks, rawSpan, gridDays, normalise, applied, restored, overridden, dateIn, fromJira };
