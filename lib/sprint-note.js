'use strict';
/**
 * sprint-note.js — what he wants remembered about a component IN ONE SPRINT.
 *
 * ── WHY THIS IS NOT `component-note.js` ──────────────────────────────────
 *
 * That file stores one note per component and says so in capital letters: "a
 * component's priority is global, and a note that explained a P1 differently
 * depending on which team happened to be selected would be two answers to one
 * question". That is still true of the Prioritization screen's column, and
 * nothing here changes it.
 *
 * The Capacity sheet asks a different question. Its note column sits on a row
 * of numbers that are this sprint's — planned, blocked, committed — and what
 * gets written there is about this sprint: "2 cases remaining; both will be
 * picked up this sprint", "plan to build 3 new TT cases with the capacity we
 * have". Fourteen of those had already been typed into the GLOBAL note,
 * because it was the only box on the row, and they will read as wrong the
 * moment the sprint rolls over.
 *
 * So there are two notes, deliberately, and they are stored apart: what is
 * true of the suite, and what is true of the suite this sprint.
 *
 * ── THE KEY IS THE REAL SPRINT, NOT THE ROW HE PICKED ────────────────────
 *
 * This is the whole of the difficulty, and getting it wrong is silent.
 *
 * A sprint in the plan is a CALENDAR ROW, not a Jira sprint. `S40` means
 * "Sprint 40" — and on his board that is Jira sprint 18532 for Ruby and 18305
 * for Titan. Two different sprints, two different sets of work, one id. Keying
 * a note on `S40` would show Ruby's note on Titan's sheet.
 *
 * It cuts the other way too. `TT Week 14Sep` is Jira sprint 18499 for Titan,
 * Malphite AND Automation — genuinely one sprint that three teams look at.
 * Keying on team+sprint would make him type that note three times and leave
 * three copies to drift.
 *
 * So the key is the JIRA sprint the selected row actually resolves to, which
 * is the only identifier that means "this sprint" in the sense he means it.
 *
 * WITH A FALLBACK, because not every sprint has one. A sprint added by hand,
 * or one whose board sync has not run, has no `jiraId` — and a key of
 * `undefined` would collapse every such sprint onto one shared note, which is
 * the exact failure this design exists to avoid. Those fall back to
 * `team:sprint`, which is narrower than the truth and never wrong.
 */

/* THE SAME CAP AS THE GLOBAL NOTE, and the same reason: long enough for a
   sentence or three, short enough that the plan stays a settings blob. Not
   imported from `component-note` — the two are allowed to diverge, and a
   shared constant would make a change to one silently change the other. */
const MAX = 600;

/**
 * WHICH SPRINT A NOTE BELONGS TO.
 *
 * @param {object} plan    the stored plan
 * @param {object} team    the selected team ({ id })
 * @param {object} sprint  the selected sprint row ({ id })
 * @returns {string|null}  the storage key, or null when there is nothing to key on
 */
function keyOf(plan, team, sprint) {
  const sprintId = sprint && sprint.id != null ? String(sprint.id) : '';
  if (!sprintId) return null;
  const teamId = team && team.id != null ? String(team.id) : '';

  /* THE ROW IS LOOKED UP IN THE PLAN rather than read off the argument. The
     caller passes the sprint it is rendering, which on some paths is a trimmed
     copy with no `byTeam` — and a key built from that would quietly take the
     fallback for a sprint that has a perfectly good Jira id. */
  const row = ((plan && plan.sprints) || []).find(s => s && String(s.id) === sprintId)
    || (sprint && sprint.byTeam ? sprint : null);
  const jira = row && row.byTeam && teamId ? (row.byTeam[teamId] || {}).jiraId : null;

  if (jira != null && String(jira).trim()) return `jira:${String(jira).trim()}`;
  /* NO JIRA SPRINT BEHIND THIS ROW. Narrower than the truth — two teams on one
     hand-made sprint keep separate notes — and never wrong, which is the right
     way round for a fallback. */
  return teamId ? `plan:${teamId}:${sprintId}` : `plan::${sprintId}`;
}

/** Read one component's note for one sprint. @returns {string|null} */
function of(plan, key, component) {
  if (!key) return null;
  const all = (plan && plan.sprintComponentNote) || {};
  const map = all[String(key)] || {};
  const v = map[String(component)];
  return typeof v === 'string' && v.trim() ? v : null;
}

/** Every note stored against one sprint. @returns {object} */
function forSprint(plan, key) {
  if (!key) return {};
  const all = (plan && plan.sprintComponentNote) || {};
  const map = all[String(key)];
  return (map && typeof map === 'object' && !Array.isArray(map)) ? { ...map } : {};
}

/**
 * Check and normalise the whole two-level map.
 *
 * Validated rather than trusted for the same reason the global notes are: a
 * note this tool cannot store is not an error anywhere on screen — the row
 * simply has no note, and that looks exactly like a row nobody has written one
 * for.
 *
 * AN EMPTY SPRINT IS DROPPED, not kept as an empty object. "Has notes" has to
 * mean one thing however the key got there, or the map grows a key for every
 * sprint ever opened and every count built from it is wrong. Same rule as
 * blank-deletes one level down.
 *
 * @returns {{map: object, errors: Array<{sprint, component, message}>}}
 */
function validate(input) {
  const errors = [];
  const map = {};
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) {
    return { map: {}, errors: [{ sprint: null, component: null, message: 'Sprint notes must be an object of sprint → component → text' }] };
  }
  for (const [sprint, notes] of Object.entries(input || {})) {
    const key = String(sprint).trim();
    if (!key) { errors.push({ sprint, component: null, message: 'A sprint note needs a sprint' }); continue; }
    if (notes == null) continue;
    if (typeof notes !== 'object' || Array.isArray(notes)) {
      errors.push({ sprint: key, component: null, message: `The notes for ${key} must be an object of component → text` });
      continue;
    }
    const inner = {};
    for (const [component, raw] of Object.entries(notes)) {
      const name = String(component).trim();
      if (!name) { errors.push({ sprint: key, component, message: 'A note needs a component name' }); continue; }
      // Clearing is a first-class edit, not a failure.
      if (raw === null || raw === undefined) continue;
      if (typeof raw !== 'string') {
        errors.push({ sprint: key, component: name, message: `The note on ${name} must be text` });
        continue;
      }
      const text = raw.trim();
      if (!text) continue;
      if (text.length > MAX) {
        errors.push({ sprint: key, component: name, message: `The note on ${name} is ${text.length} characters — keep it under ${MAX}` });
        continue;
      }
      inner[name] = text;
    }
    if (Object.keys(inner).length) map[key] = inner;
  }
  return { map, errors };
}

/**
 * Apply one edit, returning a new map.
 *
 * Blank DELETES the component, and emptying the last note on a sprint deletes
 * the sprint — the same rule `component-note.set` follows one level down, and
 * for the same reason.
 */
function set(all, key, component, text) {
  const next = { ...(all || {}) };
  const sprint = String(key || '').trim();
  if (!sprint) return next;
  const inner = { ...(next[sprint] || {}) };
  const name = String(component).trim();
  const value = text == null ? '' : String(text).trim();
  if (!value) delete inner[name];
  else inner[name] = value;
  if (Object.keys(inner).length) next[sprint] = inner;
  else delete next[sprint];
  return next;
}

/** Decorate rows that carry a `component`, for the sheet that lists them. */
function decorate(rows, plan, key) {
  return (rows || []).map(r => ({ ...r, sprintNote: of(plan, key, r.component) }));
}

module.exports = { MAX, keyOf, of, forSprint, validate, set, decorate };
