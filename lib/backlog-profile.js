'use strict';
/**
 * backlog-profile.js — how many test cases were automated, period by period.
 *
 * WHAT THIS COUNTS, AND WHY IT IS AN EVENT AND NOT A STATE
 *
 * This chart used to count outstanding work at the end of each period. It does
 * not any more, on his correction: the bars are EVENTS — the moments an Epic's
 * Automation Status moved to Automated, read from Jira's own changelog.
 *
 * The distinction matters because the two cannot be derived from each other. A
 * daily count of what is automated does not change when one epic is automated
 * and another slips back to Maintenance on the same day, but two real things
 * happened; only the events see them.
 *
 * THE RULE, AS HE STATES IT
 *
 *   The FIRST move to Automated  → new build.
 *   A move from Maintenance to Automated → maintenance.
 *
 * And the tool decides which column: an epic carrying the TrueTest component
 * is TT, everything else is KSE — the same `coverage.toolOf` the rest of the
 * page uses, so one screen does not answer "which tool" two different ways.
 *
 * WHICH WINS WHEN AN EPIC'S FIRST MOVE TO AUTOMATED CAME FROM MAINTENANCE.
 * The first one is the build. An epic cannot be re-automated before it has
 * been automated once, so a first arrival is always the build event however
 * the field happened to be set beforehand; every LATER Maintenance → Automated
 * on that epic is maintenance. Taking it the other way round would report an
 * epic as maintained without ever reporting it built, and the build column
 * would be permanently short.
 *
 * THE TOOL IS READ FROM THE EPIC NOW, not stamped on the event. Re-tagging an
 * epic's component in Jira therefore corrects every past bar rather than
 * leaving history labelled with something that has since changed. The event is
 * what happened; the epic is what it happened to.
 *
 * WHERE THE DATA COMES FROM: the `automation_transition` table, filled by the
 * Coverage page's backfill from Jira's changelog. Until that has run there are
 * no events to count, and the screen says so rather than drawing an empty
 * chart that looks like a quiet year.
 */

const coverageLib = require('./coverage');

const DAY = 864e5;
const iso = (d) => d.toISOString().slice(0, 10);
/* `new Date(null)` is NOT an invalid date — it is the epoch, 1 Jan 1970. So a
   missing value has to be rejected BEFORE the Date constructor sees it, or an
   absent `asOf` silently becomes "today is 1970" and every bar on the chart is
   an empty period half a century ago. That is precisely what it did the first
   time this ran against the real store, while every test passed, because every
   test supplied `asOf` and none of them exercised the default. */
const at = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const norm = (s) => String(s ?? '').trim().toLowerCase();

/* The status names that mean "automated" and "maintenance".
   Jira's changelog reports the DISPLAY name, so these are matched by name, and
   'Done' is included because the board uses it as an alias for Automated —
   the same alias `coverage.bucketOf` already honours. Matching only the exact
   word "Automated" would drop every epic on a board that renamed it. */
const AUTOMATED = ['automated', 'done'];
const MAINTENANCE = ['maintenance'];
const isAutomated = (v) => AUTOMATED.includes(norm(v));
const isMaintenance = (v) => MAINTENANCE.includes(norm(v));

const GRAINS = ['week', 'month', 'year'];
/** How many periods a grain shows by default — about a year of context either way. */
const DEFAULT_PERIODS = { week: 13, month: 12, year: 3 };
const MAX_PERIODS = { week: 104, month: 36, year: 10 };

/**
 * "ALL" IS A WINDOW, NOT A GRAIN — which is why it is listed separately.
 *
 * Week, month and year say how WIDE a bar is. All says how far BACK the chart
 * goes: to the first automation event there is. Those are different questions,
 * and All still has to answer the first one somehow — so it picks the grain
 * from the span (see `grainForSpan`) rather than making him choose a bar width
 * for a window whose length he does not yet know.
 */
const ALL = 'all';
const WINDOWS = [...GRAINS, ALL];

/**
 * The bar width that keeps a given span readable.
 *
 * The thresholds are the point at which the next grain up starts producing
 * fewer bars than are worth reading, not round numbers for their own sake:
 * six months is 26 weekly bars, three years is 36 monthly ones, and past that
 * only years fit on a screen. A weekly All over his three years of history
 * would be 150-odd bars two pixels wide, which is a texture rather than a chart.
 */
function grainForSpan(from, to) {
  const days = (to - from) / DAY;
  if (days <= 26 * 7) return 'week';
  if (days <= 36 * 31) return 'month';
  return 'year';
}

/**
 * How many periods of `grain` it takes to reach back from `to` to `from`.
 *
 * Counted by walking the same `previousEnd` the chart walks, rather than by
 * dividing the span — a month is not a fixed number of days, and dividing gets
 * February wrong in a way that silently drops the oldest bar.
 */
function periodsBetween(from, to, grain, cap) {
  let end = periodEnd(to, grain);
  let n = 1;
  while (n < cap && periodStart(end, grain).getTime() > from.getTime()) {
    end = previousEnd(end, grain);
    n++;
  }
  return n;
}

/**
 * The last instant of the period containing `d`, for one grain.
 *
 * Weeks end on SUNDAY, so a week bar covers the Monday–Sunday the team works
 * in rather than a rolling seven days that cuts a sprint in half. Months and
 * years end on their own last day.
 */
function periodEnd(d, grain) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  if (grain === 'year') return new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999));
  if (grain === 'month') return new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
  // Monday-based week: Sunday (dow 0) is the seventh day, not the first.
  const dow = new Date(Date.UTC(y, m, day)).getUTCDay();
  const toSunday = dow === 0 ? 0 : 7 - dow;
  return new Date(Date.UTC(y, m, day + toSunday, 23, 59, 59, 999));
}

/** The period before this one — used to walk backwards from today. */
function previousEnd(end, grain) {
  const y = end.getUTCFullYear(), m = end.getUTCMonth();
  if (grain === 'year') return new Date(Date.UTC(y - 1, 11, 31, 23, 59, 59, 999));
  if (grain === 'month') return new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  return new Date(end.getTime() - 7 * DAY);
}

/** The first instant of the period ending at `end`. */
function periodStart(end, grain) {
  const y = end.getUTCFullYear(), m = end.getUTCMonth();
  if (grain === 'year') return new Date(Date.UTC(y, 0, 1));
  if (grain === 'month') return new Date(Date.UTC(y, m, 1));
  return new Date(end.getTime() - 7 * DAY + 1);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * What a bar is called.
 *
 * A month is "Jan", and the year is added only when the window spans more than
 * one — twelve bars reading "Jan… Dec" need no year, and eighteen that silently
 * wrap into a second January would be unreadable without it.
 */
function labelFor(end, grain, spansYears) {
  const y = end.getUTCFullYear();
  if (grain === 'year') return String(y);
  if (grain === 'month') return spansYears ? `${MONTHS[end.getUTCMonth()]} ${String(y).slice(2)}` : MONTHS[end.getUTCMonth()];
  const s = periodStart(end, grain);
  return `${s.getUTCDate()} ${MONTHS[s.getUTCMonth()]}`;
}

const BUCKETS = [
  { key: 'ttBuild', label: 'New TT Build', tool: 'truetest', kind: 'build' },
  { key: 'kseBuild', label: 'New KSE Build', tool: 'kse', kind: 'build' },
  { key: 'ttMaint', label: 'TT Maintenance', tool: 'truetest', kind: 'maintenance' },
  { key: 'kseMaint', label: 'KSE Maintenance', tool: 'kse', kind: 'maintenance' },
];
const keyFor = (tool, kind) =>
  (BUCKETS.find(b => b.tool === tool && b.kind === kind) || BUCKETS[1]).key;

/**
 * THE AUTOMATION EVENTS ON ONE EPIC, in order.
 *
 * Returns `[{ at, kind }]` — `kind` is 'build' for the first arrival at
 * Automated and 'maintenance' for every later Maintenance → Automated. A move
 * to anything else, and a move that was already Automated and stayed there,
 * are not events: nothing was automated.
 *
 * Sorted before it is walked, because "first" is a claim about time and the
 * changelog is not guaranteed to arrive in order.
 */
function eventsFor(transitions) {
  const moves = (transitions || [])
    .map(t => ({ when: at(t && t.at), from: t && (t.from ?? t.from_status), to: t && (t.to ?? t.to_status) }))
    .filter(t => t.when && isAutomated(t.to) && !isAutomated(t.from))
    .sort((a, b) => a.when - b.when);

  return moves.map((m, idx) => ({
    at: m.when,
    // The first arrival is the build, whatever it came from — an epic cannot be
    // re-automated before it has been automated once.
    kind: idx === 0 ? 'build' : (isMaintenance(m.from) ? 'maintenance' : null),
  })).filter(e => e.kind);
}

/**
 * Automation events per period, split four ways.
 *
 * `epics` is `[{ key, components, transitions }]` — the transitions from the
 * changelog, the components from the epic as it stands now.
 *
 * `asOf` exists so a test can pin "today": a chart whose bars depend on the
 * wall clock is one that cannot be checked.
 */
/**
 * EVERY AUTOMATION EVENT ACROSS A SET OF EPICS, flattened and bucketed.
 *
 * Exported because two things need it and they must agree exactly: the chart,
 * which counts these into bars, and the drill-in behind a bar, which lists the
 * epics one bar is made of. A route that re-derived "which epics are in the TT
 * Build column for August" with its own copy of this logic would be one edit
 * away from a drawer that lists seven under a bar that says five — which is
 * the single most corrosive thing a drill-in can do, because the number and
 * the list are each individually plausible.
 *
 * `epic` is the index rather than the key, so "how many epics have events" is
 * exact even if two of them somehow carry the same key.
 */
function eventsOf(epics) {
  const out = [];
  (epics || []).forEach((e, idx) => {
    const tool = coverageLib.toolOf(e || {}) === 'truetest' ? 'truetest' : 'kse';
    for (const ev of eventsFor(e && e.transitions)) {
      out.push({ t: ev.at.getTime(), bucket: keyFor(tool, ev.kind), key: e && e.key, epic: idx });
    }
  });
  return out;
}

function profile(epics, { grain = 'month', periods = null, asOf = null } = {}) {
  const window = grain === ALL ? ALL : (GRAINS.includes(grain) ? grain : 'month');
  const today = at(asOf) || new Date();

  // Flattened once, BEFORE the window is resolved — "all" is defined by the
  // oldest event there is, and nothing else here knows when that was.
  const events = eventsOf(epics);
  const withEvents = new Set(events.map(e => e.epic)).size;

  let g, want, clamped = false;
  if (window === ALL) {
    /* Back to the first event, at a grain the span can carry. With NO events
       there is no span to measure, so it falls back to the default month view
       rather than drawing one bar around the epoch — and the screen is gated on
       `backfilled` anyway, so nobody sees this case as a chart. */
    const earliest = events.length ? new Date(Math.min(...events.map(e => e.t))) : null;
    g = earliest ? grainForSpan(earliest, today) : 'month';
    // Counted one past the cap, so "we hit the ceiling" and "that is all there
    // is" can be told apart — the first hides older events off the left edge
    // and has to say so, the second is the whole history and says nothing.
    const need = earliest ? periodsBetween(earliest, today, g, MAX_PERIODS[g] + 1) : DEFAULT_PERIODS[g];
    clamped = need > MAX_PERIODS[g];
    want = Math.min(need, MAX_PERIODS[g]);
  } else {
    g = window;
    // A nonsense count falls back to the default rather than clamping into it:
    // `-5` clamped to 1 is a chart with a single bar, which looks like an answer.
    // The default looks like the control was ignored, which is what happened.
    const asked = Number(periods);
    want = Number.isFinite(asked) && asked > 0
      ? Math.min(MAX_PERIODS[g], Math.round(asked))
      : DEFAULT_PERIODS[g];
  }

  const ends = [];
  let end = periodEnd(today, g);
  for (let n = 0; n < want; n++) { ends.unshift(end); end = previousEnd(end, g); }
  const spansYears = new Set(ends.map(e => e.getUTCFullYear())).size > 1;

  const out = ends.map((e) => {
    const hi = e.getTime();
    const lo = periodStart(e, g).getTime();
    const counts = Object.fromEntries(BUCKETS.map(b => [b.key, 0]));
    for (const ev of events) if (ev.t >= lo && ev.t <= hi) counts[ev.bucket]++;
    const total = BUCKETS.reduce((n, b) => n + counts[b.key], 0);
    return {
      label: labelFor(e, g, spansYears),
      start: iso(periodStart(e, g)),
      end: iso(e),
      // The period the run happens in is not over yet, so its bar is "so far".
      partial: hi > today.getTime(),
      counts,
      total,
    };
  });

  return {
    // `grain` is the bar width actually used; `window` is the control he
    // pressed. They differ only for "all", which chooses its own grain — and
    // the screen needs both: one to keep the right chip lit, one to say what
    // the bars turned out to be.
    grain: g,
    window,
    clamped,
    periods: out,
    buckets: BUCKETS.map(b => ({ key: b.key, label: b.label })),
    // What the chart is counting, said once here so the screen and any export
    // describe it the same way.
    basis: 'Epics whose Automation Status moved to Automated in the period — the first move counts as new build, a later move from Maintenance counts as maintenance.',
    epics: (epics || []).length,
    withEvents,
    events: events.length,
  };
}

module.exports = {
  profile, eventsFor, eventsOf, keyFor, isAutomated, isMaintenance,
  periodEnd, previousEnd, periodStart, labelFor, grainForSpan, periodsBetween, ALL, WINDOWS,
  BUCKETS, GRAINS, DEFAULT_PERIODS, MAX_PERIODS,
};
