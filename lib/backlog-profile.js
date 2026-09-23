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
function profile(epics, { grain = 'month', periods = null, asOf = null } = {}) {
  const g = GRAINS.includes(grain) ? grain : 'month';
  // A nonsense count falls back to the default rather than clamping into it:
  // `-5` clamped to 1 is a chart with a single bar, which looks like an answer.
  // The default looks like the control was ignored, which is what happened.
  const asked = Number(periods);
  const want = Number.isFinite(asked) && asked > 0
    ? Math.min(MAX_PERIODS[g], Math.round(asked))
    : DEFAULT_PERIODS[g];
  const today = at(asOf) || new Date();

  // Flattened once: every event with the bucket it lands in, so the period
  // walk below is a single pass rather than a re-classification per bar.
  const events = [];
  let withEvents = 0;
  for (const e of epics || []) {
    const mine = eventsFor(e && e.transitions);
    if (mine.length) withEvents++;
    const tool = coverageLib.toolOf(e || {}) === 'truetest' ? 'truetest' : 'kse';
    for (const ev of mine) events.push({ t: ev.at.getTime(), bucket: keyFor(tool, ev.kind), key: e.key });
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
    grain: g,
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
  profile, eventsFor, keyFor, isAutomated, isMaintenance,
  periodEnd, previousEnd, periodStart, labelFor,
  BUCKETS, GRAINS, DEFAULT_PERIODS, MAX_PERIODS,
};
