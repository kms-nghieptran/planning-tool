'use strict';
/**
 * lock.js — a closed sprint is read-only.
 *
 * WHY THIS IS A MODULE AND NOT A FEW `disabled` ATTRIBUTES.
 *
 * Read-only enforced in the browser is decoration. A tab left open since last
 * week still has live buttons, `fetch` from the console still writes, and a
 * capacity grid that autosaves still autosaves. The rule has to hold at the
 * only place every write passes through, which is the server.
 *
 * WHY IT IS PER TEAM AND PER SPRINT, NOT PER SPRINT.
 *
 * A numbered calendar entry like S39 is SHARED: each team hangs its own Jira
 * sprint off `sprint.byTeam[teamId]`, with its own state. Ruby's Sprint 39 can
 * be closed while Malphite's is still active. Asking "is S39 closed" has no
 * single answer, so the question is always asked about a pair.
 *
 * WHAT COUNTS AS CLOSED. Jira's own state for that team's sprint, and nothing
 * else. Not the end date — a sprint runs late, and locking the grid at
 * midnight on the planned end date would take the tool away exactly when the
 * team is still working in it. A sprint with no mapping to Jira at all has
 * never been closed by anyone, so it stays editable.
 */

/** Jira's state for one team's copy of a calendar sprint. */
function stateFor(sprint, teamId) {
  if (!sprint) return null;
  const mine = (sprint.byTeam || {})[teamId];
  if (mine && mine.state) return String(mine.state).toLowerCase();
  // A sprint the team has no Jira mapping for — one you created here, or one
  // that has not been reconciled yet. It is yours to plan.
  return null;
}

const isClosed = (sprint, teamId) => stateFor(sprint, teamId) === 'closed';

/**
 * Why a sprint is or is not writable, in the shape the UI renders and the
 * server enforces. Returned on every sprint-scoped read so a screen never has
 * to work it out for itself and reach a different answer.
 */
function status(sprint, teamId) {
  const state = stateFor(sprint, teamId);
  const closed = state === 'closed';
  return {
    state: state || 'unmapped',
    readOnly: closed,
    // Written for a person, because it is shown to one.
    reason: closed
      ? 'This sprint is closed. Its numbers are history — reports read them, so nothing here can change.'
      : null,
  };
}

/**
 * Throw unless this team's copy of the sprint can be written to.
 *
 * The error carries `status = 409`, which is the honest code: the request is
 * well formed and would be allowed against a different sprint. A 403 would
 * suggest permissions, and there are none here.
 */
function assertWritable(sprint, team, what = 'this') {
  if (!isClosed(sprint, team.id)) return;
  const err = new Error(
    `${sprint.name || sprint.id} is closed for ${team.name || team.id}, so ${what} cannot be changed. `
    + 'Closed sprints are read-only — their numbers are what the delivery report is built from.',
  );
  err.status = 409;
  err.code = 'SPRINT_CLOSED';
  throw err;
}

module.exports = { stateFor, isClosed, status, assertWritable };
