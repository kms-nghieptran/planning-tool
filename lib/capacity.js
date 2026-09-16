'use strict';
/**
 * capacity.js — the capacity + velocity model.
 *
 * Ported verbatim from the team's "Katalon Capacity Planning" Google Sheet so the
 * app reproduces the numbers people already trust. Verified against 52 member rows
 * across Ruby S33/S38/S39 and Titan S33–S40 (see test/capacity.test.js).
 *
 *   AvailableDays = sum of the 14 day cells   (1 = full, 0.5 = half, 0 / WO / H = none)
 *   Capacity(hrs) = max(0, AvailableDays * hoursPerDay * (1 - supportPct) - ceremonyHours)
 *   Predicted(pts)= round(Capacity / hoursPerPoint)
 *   Planned(pts)  = sum of story points assigned to the member in that sprint
 *   Actual(pts)   = sum of story points where the issue is Done
 *   Workload(%)   = (Planned * hoursPerPoint) / Capacity
 *   Goal(%)       = Actual / Planned
 *
 * ORDER MATTERS: the support/learning deduction is applied to the raw day-hours
 * BEFORE ceremony hours are subtracted. (Thuan S37: 10d, 40% support, 9h ceremony
 * -> 10*7*0.6 - 9 = 33, which is what the sheet shows. The other order gives 30.6.)
 */

const DAY_CODES = {
  '1': 1,      // full working day
  '0.5': 0.5,  // half day off -> half day available
  '0': 0,      // full day off
  'WO': 0,     // weekend / week-off
  'H': 0,      // public holiday
};

const DEFAULTS = {
  hoursPerDay: 7,
  hoursPerPoint: 2.9,
  ceremonyHours: 9,
  sprintLengthDays: 14,
  workloadOverPct: 110,   // above this = overcommitted (red)
  workloadUnderPct: 85,   // below this = slack (amber)
};

function teamSettings(team) {
  return Object.assign({}, DEFAULTS, (team && team.settings) || {});
}

/** Normalise a raw day cell into available-day fraction. */
function dayValue(cell) {
  if (cell === null || cell === undefined || cell === '') return 0;
  const key = String(cell).trim().toUpperCase();
  if (key in DAY_CODES) return DAY_CODES[key];
  const n = Number(key);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/** Sum a 14-cell availability row into available days. */
function availableDays(row) {
  if (!Array.isArray(row)) return 0;
  return round2(row.reduce((sum, cell) => sum + dayValue(cell), 0));
}

/**
 * Capacity in hours for one member in one sprint.
 * @param {number} days      available days (already summed)
 * @param {number} supportPct  0-100, share of time absorbed by support/learning
 * @param {object} s         resolved team settings
 */
function capacityHours(days, supportPct, s) {
  const support = clampPct(supportPct) / 100;
  const raw = days * s.hoursPerDay * (1 - support) - s.ceremonyHours;
  return round2(Math.max(0, raw));
}

function predictedPoints(hours, s) {
  return Math.round(hours / s.hoursPerPoint);
}

/** Planned points expressed back as hours, over capacity. null when capacity is 0. */
function workloadPct(plannedPoints, hours, s) {
  if (!hours) return null;                      // the sheet's #DIV/0!
  return round1((plannedPoints * s.hoursPerPoint) / hours * 100);
}

function goalPct(actualPoints, plannedPoints) {
  if (!plannedPoints) return null;              // the sheet's #DIV/0!
  return round1(actualPoints / plannedPoints * 100);
}

/**
 * Compute one member's row.
 * @param {object} member   { id, name, role, status, supportPct }
 * @param {array}  row      14 day cells
 * @param {object} work     { planned, actual, items } already aggregated from Jira/manual
 * @param {object} s        resolved team settings
 */
function memberRow(member, row, work, s) {
  const days = availableDays(row);
  const hours = member.status === 'Released' ? 0 : capacityHours(days, member.supportPct, s);
  const predicted = predictedPoints(hours, s);
  const planned = round1(work.planned || 0);
  const actual = round1(work.actual || 0);
  return {
    memberId: member.id,
    name: member.name,
    role: member.role,
    status: member.status,
    supportPct: clampPct(member.supportPct),
    availableDays: days,
    capacityHours: hours,
    predicted,
    planned,
    actual,
    workloadPct: workloadPct(planned, hours, s),
    goalPct: goalPct(actual, planned),
    remainingPoints: round1(planned - actual),
    items: work.items || [],
    flags: memberFlags({ hours, predicted, planned, actual, days, member, s }),
  };
}

function memberFlags({ hours, predicted, planned, days, member, s }) {
  const flags = [];
  if (member.status === 'Released') { flags.push({ level: 'info', code: 'released', text: 'Released from team' }); return flags; }
  if (hours === 0 && clampPct(member.supportPct) >= 100) flags.push({ level: 'warn', code: 'fully-absorbed', text: 'Fully absorbed by support/learning — no delivery capacity' });
  else if (hours === 0) flags.push({ level: 'warn', code: 'no-capacity', text: 'No capacity this sprint' });
  if (hours > 0) {
    const wl = (planned * s.hoursPerPoint) / hours * 100;
    if (wl > s.workloadOverPct) flags.push({ level: 'risk', code: 'overloaded', text: `Overcommitted at ${round1(wl)}% — ${round1(planned - predicted)} pts above capacity` });
    else if (wl > 0 && wl < s.workloadUnderPct) flags.push({ level: 'warn', code: 'underloaded', text: `Only ${round1(wl)}% loaded — ${round1(predicted - planned)} pts of slack` });
    else if (wl === 0) flags.push({ level: 'warn', code: 'unplanned', text: 'Nothing assigned yet' });
  }
  if (days > 0 && days < 5) flags.push({ level: 'info', code: 'low-availability', text: `Only ${days} days available` });
  return flags;
}

/**
 * Compute the whole team grid for a sprint.
 * @param {object} team     { id, name, members[], settings }
 * @param {object} sprint   { id, number, start, end }
 * @param {object} avail    { [memberId]: [14 cells] }
 * @param {object} workBy   { [memberId]: { planned, actual, items } }
 */
function sprintGrid(team, sprint, avail, workBy) {
  const s = teamSettings(team);
  const rows = (team.members || [])
    .map(m => memberRow(m, (avail && avail[m.id]) || [], (workBy && workBy[m.id]) || {}, s))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  const active = rows.filter(r => r.status !== 'Released');
  const totalHours = round2(active.reduce((t, r) => t + r.capacityHours, 0));
  const planned = round1(rows.reduce((t, r) => t + r.planned, 0));
  const actual = round1(rows.reduce((t, r) => t + r.actual, 0));
  const predicted = Math.round(totalHours / s.hoursPerPoint);

  return {
    teamId: team.id,
    teamName: team.name,
    sprintId: sprint && sprint.id,
    settings: s,
    rows,
    totals: {
      headcount: active.length,
      availableDays: round2(active.reduce((t, r) => t + r.availableDays, 0)),
      capacityHours: totalHours,
      predicted,
      planned,
      actual,
      workloadPct: workloadPct(planned, totalHours, s),
      goalPct: goalPct(actual, planned),
      overBy: round1(planned - predicted),
    },
  };
}

function rank(r) { return r.status === 'Released' ? 2 : (r.role === 'QA Lead' ? 0 : 1); }

/**
 * Calibrate hoursPerPoint from delivery history: how many capacity-hours the team
 * actually spent per delivered point. Lets a team replace the inherited 2.9 with
 * its own evidence instead of a constant copied between spreadsheets.
 */
function calibrateHoursPerPoint(history) {
  // Hours and points have to come from the SAME people. `capacityHours` is the
  // roster's hours, so the points must be the roster's points too: counting
  // work delivered by someone who was never on the roster — and whose hours are
  // therefore not in that total — divides real hours by inflated points and
  // quietly reports the team as faster than it is.
  const pts = (h) => (h.memberActual == null ? h.actual : h.memberActual);
  const usable = (history || []).filter(h => pts(h) > 0 && h.capacityHours > 0);
  if (usable.length < 3) return null;
  const hours = usable.reduce((t, h) => t + h.capacityHours, 0);
  const points = usable.reduce((t, h) => t + pts(h), 0);
  return { value: round2(hours / points), sprints: usable.length, basis: `${round1(points)} pts delivered on ${round1(hours)} capacity hours` };
}

/** Rolling average of delivered points, most recent `n` completed sprints. */
function averageVelocity(history, n = 6) {
  const done = (history || []).filter(h => h.actual > 0).slice(-n);
  if (!done.length) return null;
  return round1(done.reduce((t, h) => t + h.actual, 0) / done.length);
}

/** Delivery predictability: stdev of (actual / planned) across completed sprints. */
function predictability(history) {
  const ratios = (history || []).filter(h => h.planned > 0 && h.actual > 0).map(h => h.actual / h.planned);
  if (ratios.length < 3) return null;
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const variance = ratios.reduce((t, r) => t + (r - mean) ** 2, 0) / ratios.length;
  return { mean: round2(mean), stdev: round2(Math.sqrt(variance)), sprints: ratios.length };
}

function clampPct(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0; }
function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

module.exports = {
  DAY_CODES, DEFAULTS,
  teamSettings, dayValue, availableDays, capacityHours, predictedPoints,
  workloadPct, goalPct, memberRow, sprintGrid,
  calibrateHoursPerPoint, averageVelocity, predictability,
  round1, round2,
};
