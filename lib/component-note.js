'use strict';
/**
 * component-note.js — what he wants remembered about a component.
 *
 * The Prioritization screen has a Notes column, and everything in it is
 * something no system can derive. "Client asked us to hold off until the Q3
 * release", "waiting on the NLG migration", "owner left, nobody has picked
 * this up" — Jira has no field that says any of that, and the judgement is his,
 * so it is stored as his.
 *
 * WHICH MAKES THIS PLAN DATA, exactly like the priority it sits beside: it
 * lives in the plan, and a sync never touches it. Same rule as everywhere else
 * in this tool — a decision beats a discovered value.
 *
 * ONE NOTE PER COMPONENT, not one per team. A component's priority is global,
 * and a note that explained a P1 differently depending on which team happened
 * to be selected would be two answers to one question with nothing on screen
 * to say which was meant.
 *
 * BLANK DELETES. A note cleared to an empty string and a component that never
 * had one are the same state — "has a note" has to mean one thing however the
 * row got there, or the map grows a key for every component ever clicked and
 * every count built from it is wrong.
 */

/* Long enough for the kind of thing that actually goes in this column — a
   sentence or three — and short enough that the map stays a settings blob
   rather than a document store. Enforced rather than truncated: silently
   keeping the first 600 characters of what he typed would lose the end of a
   sentence and look, on screen, exactly like a note that was always short. */
const MAX = 600;

/** Read one component's note. @returns {string|null} */
function of(plan, component) {
  const map = (plan && plan.componentNote) || {};
  const v = map[String(component)];
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * Check and normalise a whole note map.
 *
 * Validated rather than trusted for the same reason the priorities are: a note
 * this tool cannot store is not an error anywhere — the component simply has
 * no note, and the only place that shows is a column that looks perfectly fine.
 *
 * @returns {{map: object, errors: Array<{component, message}>}}
 */
function validate(input) {
  const errors = [];
  const map = {};
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) {
    return { map: {}, errors: [{ component: null, message: 'Notes must be an object of component → text' }] };
  }
  for (const [component, raw] of Object.entries(input || {})) {
    const name = String(component).trim();
    if (!name) { errors.push({ component, message: 'A note needs a component name' }); continue; }
    // Clearing is a first-class edit, not a failure — see the file note.
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== 'string') {
      errors.push({ component: name, message: `The note on ${name} must be text` });
      continue;
    }
    const text = raw.trim();
    if (!text) continue;
    if (text.length > MAX) {
      errors.push({ component: name, message: `The note on ${name} is ${text.length} characters — keep it under ${MAX}` });
      continue;
    }
    map[name] = text;
  }
  return { map, errors };
}

/**
 * Apply one edit to the stored map, returning a new one.
 *
 * Blank DELETES the key rather than storing an empty string — the same rule
 * `priority.set` follows next door, and for the same reason.
 */
function set(map, component, text) {
  const next = { ...(map || {}) };
  const name = String(component).trim();
  const value = text == null ? '' : String(text).trim();
  if (!value) delete next[name];
  else next[name] = value;
  return next;
}

/** Decorate rows that carry a `component`, for any table that lists them. */
function decorate(rows, plan) {
  return (rows || []).map(r => ({ ...r, note: of(plan, r.component) }));
}

module.exports = { MAX, of, validate, set, decorate };
