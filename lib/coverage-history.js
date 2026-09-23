'use strict';
/**
 * coverage-history.js — coverage as it WAS, so movement can be a fact.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE
 *
 * Every other number in this tool is answerable from today's store. "Is
 * coverage going up?" is not, and it was not reconstructable either: a sync
 * overwrites each epic's automation_status and the previous value is simply
 * gone. The obvious fallback — date each automated epic by its resolution —
 * fails on his data, where only 107 of 312 automated epics carry one. Two
 * thirds of the curve would have been invented.
 *
 * So the history is kept, from two sources that are honest about what they are:
 *
 *   OBSERVED ('sync')       — a reading this tool took of its own store, at the
 *                             moment of a sync. It is what coverage was, because
 *                             we were there and counted.
 *
 *   RECONSTRUCTED ('changelog') — a reading rebuilt by replaying Jira's own
 *                             transition history backwards from today. It is
 *                             what coverage almost certainly was, with the
 *                             caveats named in `reconstruct` below.
 *
 * THE ONE RULE THAT KEEPS THEM SAFE TO MIX: an inference never overwrites an
 * observation. `record` enforces it on write rather than leaving it to callers,
 * because a backfill run twice would otherwise quietly replace real readings
 * with approximations of themselves and nothing on screen would change.
 *
 * WHAT A READING IS. The seven bucket counts for one component on one day —
 * the same seven `coverage.js` uses, counted the same way, because a movement
 * chart that disagrees with the table beside it is worse than no chart. The
 * portfolio row is stored under the empty component name so that "all
 * components" is a row you read rather than a sum you re-derive (and a sum
 * would be wrong anyway: an epic in two components is in two rows).
 */

const db = require('./db');
const cov = require('./coverage');

const BUCKETS = cov.BUCKETS.map(b => b.key);
const IN_RATIO = cov.BUCKETS.filter(b => b.inRatio).map(b => b.key);
const COVERED = cov.BUCKETS.filter(b => b.covered).map(b => b.key);

/** The portfolio row's component name. Empty, not a label, so it cannot collide. */
const ALL = '';

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const day = (d) => new Date(d).toISOString().slice(0, 10);
const sum = (row, keys) => keys.reduce((t, k) => t + (row[k] || 0), 0);

/** A stored row, plus the figures every caller derives from it anyway. */
function withRatio(row) {
  const automatable = sum(row, IN_RATIO);
  const covered = sum(row, COVERED);
  return { ...row, total: sum(row, BUCKETS), automatable, covered, coveragePct: pct(covered, automatable) };
}

/* ── writing ──────────────────────────────────────────────────────────── */

/**
 * Store one day's readings.
 *
 * @param {Array}  rows    [{ component, automated, maintenance, … }]
 * @param {object} opts    `at` (defaults to today), `scope`, `source`
 * @returns {{written: number, kept: number}}  kept = observations left alone
 */
function record(rows, { at = new Date(), scope = 'Epic', source = 'sync' } = {}) {
  const on = day(at);
  let written = 0, kept = 0;

  db.tx(() => {
    for (const row of rows || []) {
      const component = row.component == null ? ALL : String(row.component);
      // An inference never overwrites an observation. Checked per row rather
      // than per run, because a backfill legitimately fills the gaps BETWEEN
      // observed days and must be free to write those.
      if (source !== 'sync') {
        const existing = db.get(
          'SELECT source FROM coverage_reading WHERE at = ? AND scope = ? AND component = ?',
          on, scope, component,
        );
        if (existing && existing.source === 'sync') { kept++; continue; }
      }
      db.run(
        `INSERT INTO coverage_reading (at, scope, component, automated, maintenance, ready, blocked, na, obsoleted, none, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(at, scope, component) DO UPDATE SET
           automated = excluded.automated, maintenance = excluded.maintenance,
           ready = excluded.ready, blocked = excluded.blocked, na = excluded.na,
           obsoleted = excluded.obsoleted, none = excluded.none, source = excluded.source`,
        on, scope, component,
        row.automated || 0, row.maintenance || 0, row.ready || 0, row.blocked || 0,
        row.na || 0, row.obsoleted || 0, row.none || 0, source,
      );
      written++;
    }
  });
  return { written, kept };
}

/**
 * Take today's reading straight off the snapshot.
 *
 * Deliberately routed through `coverage.view` rather than counting the issues
 * here: one classifier, one set of buckets, one definition of a product
 * component. A second implementation would drift, and the first day it drifted
 * the movement chart would show a step change that never happened.
 */
function recordFromSnapshot(snap, { at = new Date(), scope = 'Epic', source = 'sync' } = {}) {
  const view = cov.view(snap, { scope });
  const rows = [
    { component: ALL, ...pick(view) },
    ...view.byComponent.map(r => ({ component: r.component, ...pick(r) })),
  ];
  return record(rows, { at, scope, source });
}

const pick = (r) => Object.fromEntries(BUCKETS.map(k => [k, r[k] || 0]));

/* ── reading ──────────────────────────────────────────────────────────── */

/** Every stored reading for one component, oldest first. */
function series(component = null, { scope = 'Epic', since = null, limit = 400 } = {}) {
  const name = component == null ? ALL : String(component);
  const rows = since
    ? db.all('SELECT * FROM coverage_reading WHERE scope = ? AND component = ? AND at >= ? ORDER BY at LIMIT ?', scope, name, day(since), limit)
    : db.all('SELECT * FROM coverage_reading WHERE scope = ? AND component = ? ORDER BY at LIMIT ?', scope, name, limit);
  return rows.map(withRatio);
}

/** The days that have any reading at all, oldest first. */
function days({ scope = 'Epic' } = {}) {
  return db.all('SELECT DISTINCT at FROM coverage_reading WHERE scope = ? ORDER BY at', scope).map(r => r.at);
}

/* ── movement ─────────────────────────────────────────────────────────── */

/**
 * What moved, between the first and last reading in the window.
 *
 * ONE READING IS NOT A TREND, and the shape of this return says so rather than
 * drawing a flat line through a single point: `points` is the series, `from`
 * and `to` are null until there are two of them, and `hasTrend` is the flag
 * every caller should branch on. A chart that looks the same whether it has one
 * reading or thirty is a chart that lies for the first fortnight.
 *
 * NOT CALLED `ready`. Every coverage object in this codebase spreads its bucket
 * counts at the top level, and one of the buckets is Ready for Automation — so
 * a flag of that name is truthy on any coverage payload that happens to have
 * 733 epics queued, and a view branching on it renders a trend from an object
 * that has none. That is not hypothetical: it is what this was called first,
 * and the coverage screen's own tests caught it reaching for a span that was
 * never there.
 *
 * @returns {{hasTrend, points, from, to, deltaPct, buckets, movers, span}}
 */
function movement(component = null, { scope = 'Epic', since = null, limit = 400 } = {}) {
  const points = series(component, { scope, since, limit });
  const from = points.length > 1 ? points[0] : null;
  const to = points.length ? points[points.length - 1] : null;

  const buckets = from && to
    ? cov.BUCKETS.map(b => ({
      key: b.key, label: b.label, inRatio: b.inRatio, covered: b.covered,
      from: from[b.key], to: to[b.key], delta: to[b.key] - from[b.key],
    }))
    : [];

  return {
    hasTrend: Boolean(from && to),
    scope,
    component: component == null ? null : component,
    points,
    from, to,
    // Percentage POINTS, not a percentage of a percentage: coverage going from
    // 50% to 55% is "+5 points", and calling that "+10%" is the single easiest
    // way to make a delivery report indefensible in a room.
    deltaPct: from && to ? Math.round((to.coveragePct - from.coveragePct) * 10) / 10 : null,
    buckets,
    span: from && to ? { from: from.at, to: to.at, readings: points.length } : null,
    movers: component == null ? movers({ scope, since, limit }) : [],
  };
}

/**
 * Which components moved, best and worst.
 *
 * Ranked by coverage POINTS gained or lost over the window, and reported with
 * the bucket change behind it, because "PS_X fell 12 points" and "PS_X fell 12
 * points because 30 new epics arrived unautomated" are different situations
 * with different responses. A component whose denominator grew is not a
 * component that went backwards.
 */
function movers({ scope = 'Epic', since = null, limit = 400, min = 1 } = {}) {
  const names = db.all(
    'SELECT DISTINCT component FROM coverage_reading WHERE scope = ? AND component != ?', scope, ALL,
  ).map(r => r.component);

  const out = [];
  for (const name of names) {
    const points = series(name, { scope, since, limit });
    if (points.length < 2) continue;
    const from = points[0], to = points[points.length - 1];
    // A component with nothing automatable at either end has no coverage to
    // move; including it would put a row of zeroes at the top of a table
    // sorted by change.
    if (!from.automatable && !to.automatable) continue;

    const delta = Math.round((to.coveragePct - from.coveragePct) * 10) / 10;
    const grew = to.automatable - from.automatable;
    if (Math.abs(delta) < min && !grew) continue;

    out.push({
      component: name,
      family: cov.familyOf(name),
      from: from.coveragePct, to: to.coveragePct, delta,
      automatableFrom: from.automatable, automatableTo: to.automatable, automatableDelta: grew,
      coveredDelta: to.covered - from.covered,
      buckets: Object.fromEntries(BUCKETS.map(k => [k, to[k] - from[k]])),
    });
  }
  out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.component.localeCompare(b.component));
  return out;
}

/* ── the raw transitions, kept as events ──────────────────────────────
   The reconstruction above turns the changelog into daily READINGS. These two
   keep the changelog itself, because "how many were automated IN March, and
   was it new build or re-automation" cannot be derived from a reading: two
   epics moving in opposite directions on the same day leave the reading
   unchanged, and both events are real. */

/**
 * Store every automation-status move these epics recorded.
 *
 * INSERT OR REPLACE, so a backfill run twice is idempotent rather than
 * doubling every bar — the primary key is the epic, the timestamp and the
 * destination, which is what makes one recorded move one row.
 *
 * An epic whose history Jira TRUNCATED is skipped entirely rather than stored
 * in part. A partial history silently undercounts, and undercounting is
 * indistinguishable from a quiet month on the chart it feeds.
 */
function saveTransitions(epics) {
  let written = 0, skipped = 0;
  for (const e of epics || []) {
    if (e && e.truncated) { skipped++; continue; }
    for (const t of (e && e.transitions) || []) {
      if (!t || !t.at) continue;
      db.run('INSERT OR REPLACE INTO automation_transition (issue_key, at, from_status, to_status) VALUES (?, ?, ?, ?)',
        e.key, t.at, t.from ?? null, t.to ?? null);
      written++;
    }
  }
  return { written, skipped };
}

/**
 * WHICH EPICS PRODUCED ONE BUCKET'S CHANGE, over one window.
 *
 * The movers table shows net deltas of COUNTS — "Automated +5" — taken from two
 * daily readings. This answers the next question, "which five?", from the
 * transition table: the epics whose Automation Status moved INTO that bucket in
 * the window, and the ones that moved OUT of it.
 *
 * ARRIVED AND LEFT ARE KEPT APART, and the net is stated rather than implied.
 * A +5 can be seven arrivals and two departures, and a drawer that listed only
 * the arrivals under a heading saying "+5" would be a list of seven claiming to
 * be five. Both lists, and the arithmetic between them, is the honest shape.
 *
 * THE NET WILL SOMETIMES NOT EQUAL THE READING DELTA, and that is real rather
 * than a fault: a reading counts epics, a transition counts field changes. An
 * epic created already Automated never transitioned into anything, and an epic
 * re-tagged from one component to another moves between two readings without a
 * single status change. The caller is given both numbers so the screen can say
 * so instead of quietly showing the smaller one.
 *
 * The component is read from the epic AS IT STANDS NOW — `lookup` supplies it —
 * for the same reason the backlog chart does: a re-tagged epic should correct
 * the past rather than leave it labelled with something since changed.
 */
function movedEpics({ bucket, component = null, since = null, lookup = () => null } = {}) {
  const want = String(bucket || '').trim();
  if (!want) return { arrived: [], left: [], net: 0 };
  const from = since ? new Date(since).getTime() : null;

  const bucketOfStatus = (name) => cov.bucketOf({ automationStatus: name, labels: [] });
  const arrived = [], left = [];

  for (const [key, moves] of transitionsByKey()) {
    const issue = lookup(key);
    // An epic this tool has no copy of cannot be placed in a component, and the
    // drawer is always opened FROM a component — so it would be listed under a
    // heading it may not belong to. Skipped, and counted by the caller.
    if (component != null) {
      if (!issue) continue;
      if (!cov.productComponents(issue).includes(component)) continue;
    }
    for (const m of moves) {
      const at = new Date(m.at).getTime();
      if (!Number.isFinite(at)) continue;
      if (from != null && at < from) continue;
      const to = bucketOfStatus(m.to), was = bucketOfStatus(m.from);
      if (to === was) continue;                       // not a move between buckets
      if (to === want) arrived.push({ key, at: m.at, from: m.from, to: m.to });
      else if (was === want) left.push({ key, at: m.at, from: m.from, to: m.to });
    }
  }

  const byDate = (a, b) => String(b.at).localeCompare(String(a.at));
  arrived.sort(byDate); left.sort(byDate);
  return { arrived, left, net: arrived.length - left.length };
}

/** Every stored transition, grouped by issue key. */
function transitionsByKey() {
  const out = new Map();
  for (const r of db.all('SELECT issue_key, at, from_status, to_status FROM automation_transition ORDER BY issue_key, at')) {
    if (!out.has(r.issue_key)) out.set(r.issue_key, []);
    out.get(r.issue_key).push({ at: r.at, from: r.from_status, to: r.to_status });
  }
  return out;
}

/* ── reconstruction from Jira's changelog ─────────────────────────────── */

/**
 * Rebuild past readings by replaying Automation Status transitions backwards.
 *
 * HOW IT WORKS. Each epic's current status is known. Walking its transitions
 * from newest to oldest undoes them one at a time, giving the status it held
 * before each change — and therefore its status on any past date. An epic with
 * no transitions has held its current status since it was created.
 *
 * THREE THINGS IT CANNOT KNOW, all of them stated on screen rather than buried:
 *
 *   1. COMPONENTS ARE TODAY'S. Component membership has its own history and
 *      this does not read it, so an epic moved between suites last month is
 *      counted in its current suite for every past date. Portfolio totals are
 *      unaffected; a single component's past can be wrong.
 *
 *   2. DELETED EPICS ARE INVISIBLE. Anything removed from Jira is not in the
 *      population at all, so a past date counts only work that still exists.
 *      This makes old readings slightly smaller than they really were.
 *
 *   3. THE OBSOLETE LABEL IS TODAY'S. Labels are not in the transition data
 *      being read, so an epic retired last week reads as retired all along.
 *
 * Epics created after a given date are correctly excluded — `created` is on
 * every epic, which is what makes the population honest even when the statuses
 * are inferred.
 *
 * @param {Array} epics  [{ key, created, components, labels, automationStatus,
 *                          transitions: [{ at, from, to }] }]
 * @param {Array} dates  the days to rebuild, any order
 */
function reconstruct(epics, dates, { scope = 'Epic' } = {}) {
  const wanted = [...new Set((dates || []).map(day))].sort();
  if (!wanted.length) return [];

  // Each epic's status timeline, oldest first, as {from: <day>, status}.
  const timelines = (epics || []).map(e => {
    const moves = (e.transitions || [])
      .filter(t => t && t.at)
      .slice()
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    // Backwards from today's status: the value BEFORE a transition is its
    // `from`, which is what Jira recorded at the time — more reliable than
    // chaining our own guesses through a list that may have gaps.
    const spans = [];
    let status = e.automationStatus == null ? '' : e.automationStatus;
    for (let i = moves.length - 1; i >= 0; i--) {
      spans.unshift({ from: day(moves[i].at), status });
      status = moves[i].from == null ? '' : moves[i].from;
    }
    spans.unshift({ from: e.created ? day(e.created) : '0000-01-01', status });
    return { epic: e, spans, created: e.created ? day(e.created) : '0000-01-01' };
  });

  const statusOn = (t, on) => {
    if (on < t.created) return null;                 // did not exist yet
    let held = t.spans[0].status;
    for (const s of t.spans) { if (s.from <= on) held = s.status; else break; }
    return held;
  };

  const out = [];
  for (const on of wanted) {
    const rows = new Map();
    const bump = (name, bucket) => {
      if (!rows.has(name)) rows.set(name, { component: name, ...Object.fromEntries(BUCKETS.map(k => [k, 0])) });
      rows.get(name)[bucket]++;
    };
    for (const t of timelines) {
      const status = statusOn(t, on);
      if (status === null) continue;
      // The same classifier the live screen uses, handed a synthetic issue that
      // differs from the real one only in its Automation Status.
      const bucket = cov.bucketOf({ ...t.epic, automationStatus: status });
      bump(ALL, bucket);
      for (const c of cov.productComponents(t.epic)) bump(c, bucket);
    }
    out.push({ at: on, scope, rows: [...rows.values()] });
  }
  return out;
}

/** Weekly marks back from `to`, for a reconstruction to aim at. */
function weeklyDates(from, to = new Date(), { step = 7, max = 60 } = {}) {
  const end = new Date(day(to)), start = new Date(day(from));
  const out = [];
  for (let d = new Date(end); d >= start && out.length < max; d.setDate(d.getDate() - step)) out.push(day(d));
  return out.reverse();
}

module.exports = {
  ALL, BUCKETS,
  record, recordFromSnapshot, series, days, movement, movers,
  reconstruct, weeklyDates, withRatio, saveTransitions, transitionsByKey, movedEpics,
};
