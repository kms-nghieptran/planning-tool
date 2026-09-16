'use strict';
/**
 * priority.js — how much each component matters, as a decision rather than a guess.
 *
 * Everything else the Coverage screen says about a component is derived from
 * Jira: how many epics it has, how many are automated, how fast it is moving.
 * None of that says which suites the team actually cares about. PS_iGO_NLG at
 * 48% and a retired internal suite at 48% are the same number and not remotely
 * the same problem, and nothing in the data can tell them apart — the judgement
 * is his, so it is stored as his.
 *
 * WHICH MAKES THIS PLAN DATA, NOT SNAPSHOT DATA. It lives in the plan, beside
 * team rosters and availability, and a sync never touches it. That is the same
 * rule the rest of this tool runs on: a decision beats a discovered value.
 *
 * A LEVEL, NOT A RANK. With 125 components a strict total order is unusable —
 * it cannot be edited one row at a time and every insertion renumbers the rest.
 * Four levels can be set on any row, in any order, without looking at the others.
 *
 * UNSET IS A REAL STATE and is not the same as "low". Most components will
 * never be given a priority, and rendering those as the bottom of a scale would
 * claim a judgement nobody made.
 */

/**
 * The four levels, with the colour each is shown in.
 *
 * The colour is part of the level, not a lookup table in a stylesheet, because
 * three screens render this and a second list is how P2 ends up amber on one of
 * them and grey on another. `tone` names a role the app already has; `key` is
 * what the CSS class is built from.
 *
 * It descends deliberately — pink, amber, blue, grey — so the four read as a
 * scale at a glance rather than as four unrelated tags, and every one of them
 * is a token, so dark mode follows without a second set of values.
 */
const LEVELS = [
  { value: 1, key: 'p1', label: 'P1', name: 'Critical', tone: 'risk', note: 'Client-facing or release-blocking' },
  { value: 2, key: 'p2', label: 'P2', name: 'High', tone: 'warn', note: 'Actively invested in' },
  { value: 3, key: 'p3', label: 'P3', name: 'Medium', tone: 'info', note: 'Kept working' },
  { value: 4, key: 'p4', label: 'P4', name: 'Low', tone: 'muted', note: 'Background, or winding down' },
];

const BY_VALUE = new Map(LEVELS.map(l => [l.value, l]));

/** Sorts below every set level, whichever way the column points. */
const UNSET = null;

/**
 * Read one component's priority.
 *
 * @returns {number|null} 1–4, or null when nobody has set one
 */
function of(plan, component) {
  const map = (plan && plan.componentPriority) || {};
  const v = map[String(component)];
  return BY_VALUE.has(Number(v)) ? Number(v) : UNSET;
}

/** The label a screen shows, or null. */
const levelOf = (value) => BY_VALUE.get(Number(value)) || null;

/**
 * Check and normalise a whole priority map.
 *
 * Validated rather than trusted for the same reason the categorisation rules
 * are: a priority this tool cannot read is not an error anywhere, it is simply
 * a component that quietly has no priority, and the only place that shows is a
 * column that looks fine.
 *
 * @returns {{map: object, errors: Array<{component, message}>}}
 */
function validate(input) {
  const errors = [];
  const map = {};
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) {
    return { map: {}, errors: [{ component: null, message: 'Priorities must be an object of component → level' }] };
  }
  for (const [component, raw] of Object.entries(input || {})) {
    const name = String(component).trim();
    if (!name) { errors.push({ component, message: 'A priority needs a component name' }); continue; }
    // Clearing is a first-class edit, not a failure: it is how a row goes back
    // to having no judgement on it, which is different from having a low one.
    if (raw === null || raw === '' || raw === undefined) continue;
    const v = Number(raw);
    if (!BY_VALUE.has(v)) {
      errors.push({ component: name, message: `"${raw}" is not a priority — use ${LEVELS.map(l => l.value).join(', ')} or clear it` });
      continue;
    }
    map[name] = v;
  }
  return { map, errors };
}

/**
 * Apply one edit to the stored map, returning a new one.
 *
 * A null level DELETES the key rather than storing a null. A map that
 * accumulates nulls for every component ever touched grows without bound and
 * makes "has a priority" mean two different things depending on how the row got
 * there.
 */
function set(map, component, level) {
  const next = { ...(map || {}) };
  const name = String(component).trim();
  if (level === null || level === '' || level === undefined) delete next[name];
  else next[name] = Number(level);
  return next;
}

/** Decorate rows that carry a `component`, for any table that lists them. */
function decorate(rows, plan) {
  return (rows || []).map(r => {
    const value = of(plan, r.component);
    return { ...r, priority: value, priorityLabel: value ? levelOf(value).label : null };
  });
}

/**
 * Sort key for a component row: set levels first in order, unset last.
 *
 * Exported because more than one screen ranks by this, and "unset sorts last"
 * is the kind of rule that gets written three different ways in three files.
 */
const sortKey = (value) => (BY_VALUE.has(Number(value)) ? Number(value) : Number.MAX_SAFE_INTEGER);

module.exports = { LEVELS, of, levelOf, validate, set, decorate, sortKey };
