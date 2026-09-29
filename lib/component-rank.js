'use strict';
const priority = require('./priority');
/**
 * component-rank.js — the order he wants his suites worked, WITHIN a priority.
 *
 * The Prioritization screen already stores a LEVEL per component: P1 to P4,
 * four buckets. That answers "how much does this matter" and stops there. It
 * does not answer the question he actually asks when planning a sprint: of the
 * nine P1 suites, which one do we pick up first?
 *
 * Alphabetical order was standing in for that answer and saying nothing.
 * `PS_AFFIRM_MorganStanley` sorts above `PS_iGO_John Hancock` because of the
 * letter A, which is not a judgement anybody made.
 *
 * ── RANK ORDERS WITHIN A LEVEL. IT NEVER CROSSES ONE. ────────────────────
 *
 * The level stays the primary sort and the rank breaks ties inside it. This is
 * the whole design, and the alternative — one flat ordering where dragging a
 * row far enough silently turns a P3 into a P1 — is worse in a way that is
 * hard to see: the Priority column would still read P3 while the row sat among
 * the P1s, and the export, the Capacity sheet and every other reader would
 * disagree with the screen. Dragging reorders; changing a priority is what the
 * Priority column is for, and it stays the only thing that does it.
 *
 * ── SPARSE, AND UNRANKED SORTS LAST ──────────────────────────────────────
 *
 * Most components will never be dragged. A map with an entry for every one of
 * his 129 would have to be maintained by every code path that adds a component
 * — so the map holds only the ones he has actually placed, and everything else
 * keeps the old behaviour: after the ranked ones, alphabetically. Adding a new
 * component to the project therefore changes nothing about the order of the
 * ones he has ranked, which is the property that makes this safe to leave
 * alone for a quarter.
 *
 * ── RANKS ARE DENSE 1..N PER LEVEL, ASSIGNED ON WRITE ────────────────────
 *
 * The caller sends the order it wants; this module numbers it. Accepting
 * arbitrary numbers from the browser would mean two components could claim
 * rank 3 (an order that has no answer), or the numbers could drift into the
 * thousands after enough drags. Renumbering on every write costs nothing at
 * this size and means the stored value is always readable by a human looking
 * at the plan file.
 */

/* A SANITY CEILING, not a product limit. The rank is an index into his own
   shortlist; a value past this means something upstream is generating them
   rather than a person dragging rows, and storing it would make the map grow
   without bound. */
const MAX = 9999;

/** Read one component's rank. @returns {number|null} when he has not placed it */
function of(plan, component) {
  const map = (plan && plan.componentRank) || {};
  const v = map[String(component)];
  return Number.isInteger(v) && v >= 1 && v <= MAX ? v : null;
}

/**
 * THE SORT KEY FOR AN UNRANKED COMPONENT.
 *
 * `Infinity` rather than a big number, so it cannot collide with a real rank
 * however many components he ranks, and so the comparison below stays a plain
 * subtraction with no special case. Unranked therefore sorts AFTER every
 * ranked component in its level, and ties among the unranked fall through to
 * the name — exactly the order the page had before this existed.
 */
const UNRANKED = Infinity;
const sortKey = (plan, component) => {
  const v = of(plan, component);
  return v == null ? UNRANKED : v;
};

/**
 * Check and normalise a whole rank map.
 *
 * Validated rather than trusted for the same reason the priorities and notes
 * are: a rank this tool cannot store is not an error anywhere on screen — the
 * component simply falls back to alphabetical, in a column that looks
 * perfectly fine.
 *
 * @returns {{map: object, errors: Array<{component, message}>}}
 */
function validate(input) {
  const errors = [];
  const map = {};
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) {
    return { map: {}, errors: [{ component: null, message: 'Ranks must be an object of component → position' }] };
  }
  for (const [component, raw] of Object.entries(input || {})) {
    const name = String(component).trim();
    if (!name) { errors.push({ component, message: 'A rank needs a component name' }); continue; }
    // Clearing is a first-class edit, not a failure — the component goes back
    // to sorting alphabetically, which is a real state and not an absence.
    if (raw === null || raw === undefined) continue;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX) {
      errors.push({ component: name, message: `"${raw}" is not a position for ${name} — use a whole number from 1 to ${MAX}, or clear it` });
      continue;
    }
    map[name] = n;
  }
  return { map, errors };
}

/**
 * Place an ordered list of components at ranks 1..N, leaving every other
 * entry in the map alone.
 *
 * THE CALLER SENDS AN ORDER, NOT NUMBERS — see the file note. `order` is the
 * components of ONE level, in the sequence he dragged them into; this assigns
 * the positions. Anything already ranked that is not in the list keeps its
 * value, because the list is one level and the map holds all of them.
 *
 * A DUPLICATE IN `order` IS DROPPED, not counted twice. The browser sends a
 * list read out of the DOM, and a row that appeared twice would otherwise
 * renumber everything after it and quietly shift a component the user never
 * touched.
 */
function reorder(map, order) {
  const next = { ...(map || {}) };
  const seen = new Set();
  let n = 0;
  for (const raw of order || []) {
    const name = String(raw == null ? '' : raw).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    next[name] = ++n;
  }
  return next;
}

/** Drop one component's rank — it goes back to sorting by name. */
function clear(map, component) {
  const next = { ...(map || {}) };
  delete next[String(component).trim()];
  return next;
}

/**
 * Drop every component NOT in `keep` — the ones that have left the project.
 *
 * Called when the ranked set is rewritten, so a component he has excluded or
 * un-prioritised does not sit in the map forever holding a position that
 * nothing renders. Never called on its own initiative anywhere that a missing
 * component might simply be out of scope for one screen.
 */
function prune(map, keep) {
  const allowed = new Set([...(keep || [])].map(c => String(c).trim()));
  const next = {};
  for (const [name, v] of Object.entries(map || {})) {
    if (allowed.has(name)) next[name] = v;
  }
  return next;
}

/**
 * CHECK AN ORDER BEFORE IT IS APPLIED — one level's components, his sequence.
 *
 * IN THE MODEL RATHER THAN THE ROUTE, so the rules are testable without an
 * HTTP server and so a second caller cannot apply a reorder that skips them.
 * Each guard is for a failure that would otherwise be silent:
 *
 *   AN UNKNOWN COMPONENT would gain a rank that nothing renders — the sort
 *   reads it only for components that have a priority, so the entry would sit
 *   in the plan file forever doing nothing.
 *
 *   A COMPONENT FROM ANOTHER LEVEL is the one that matters. `reorder`
 *   renumbers every name it is handed, so a P3 that found its way into a
 *   reordering of the P1s would be renumbered too — moving a row on a screen
 *   nobody was looking at. Refused whole rather than partially applied,
 *   because a half-applied order is not an order.
 *
 * @returns {{ok: boolean, status: number, error: string|null, order: string[]}}
 */
function validateOrder(plan, level, order) {
  const at = (c) => priority.of(plan, c);
  const lv = level == null ? null : Number(level);
  if (!Number.isInteger(lv) || !priority.LEVELS.some(l => l.value === lv)) {
    return { ok: false, status: 400, error: `"${level}" is not a priority level.`, order: [] };
  }
  const list = Array.isArray(order)
    ? order.map(c => String(c == null ? '' : c).trim()).filter(Boolean)
    : null;
  if (!list || !list.length) {
    return { ok: false, status: 400, error: 'Which components, and in what order?', order: [] };
  }
  for (const c of list) {
    const has = at(c);
    if (has == null) {
      return { ok: false, status: 404, error: `"${c}" has no priority, so it has no place in the order.`, order: [] };
    }
    if (has !== lv) {
      return { ok: false, status: 409, error: `"${c}" is P${has}, not P${lv} — reorder each level on its own.`, order: [] };
    }
  }
  return { ok: true, status: 200, error: null, order: list };
}

/** Decorate rows that carry a `component`, for any table that lists them. */
function decorate(rows, plan) {
  return (rows || []).map(r => ({ ...r, rank: of(plan, r.component) }));
}

module.exports = { MAX, UNRANKED, of, sortKey, validate, validateOrder, reorder, clear, prune, decorate };
