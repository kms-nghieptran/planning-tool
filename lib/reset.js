'use strict';
/**
 * reset.js — put Jira back in charge.
 *
 * The tool ships with a seed (hand-entered Ruby and Titan rosters, a sample
 * sprint calendar) so it opens with something in it on day one. Once Jira is
 * connected that seed stops being a convenience and becomes a liability: you can
 * no longer tell which rows came from your tracker and which were typed, and
 * every report quietly mixes the two.
 *
 * This drops everything a sync can rebuild and keeps everything a sync cannot.
 * That split is the whole module, so it is stated once, here:
 *
 *   JIRA CAN REBUILD IT  → delete
 *     teams, boards, members, sprints and their dates/state, backlog, issues,
 *     points, components, statuses, assignees
 *
 *   NOTHING CAN REBUILD IT  → keep
 *     availability (the leave grid), support %, ceremony hours, holidays,
 *     capacity constants, category rules, work-mix targets, the risk register,
 *     planning notes and overrides, and the exclusion lists — a person removed
 *     on purpose must not come back because of a cleanup
 *
 * `mode: 'settings-only'` additionally drops the per-sprint planning inputs
 * (availability, support, ceremony, overrides, notes) for someone who wants to
 * re-enter the grid from scratch. It never touches the constants, because those
 * came off the spreadsheet and re-deriving them is a day's work.
 *
 * Nothing here talks to the network: it rewrites the plan, and the next sync
 * repopulates. A backup is written first and named in the result.
 */

const store = require('./store');

/** Keys on a team that describe the TEAM, not its Jira-derived contents. */
const TEAM_KEEP = ['id', 'name', 'jiraName', 'jiraTeams', 'boardId', 'components', 'sprintKeywords', 'settings', 'color'];

/**
 * Strip the plan back to what Jira owns, without touching what it does not.
 *
 * @param {object} plan   mutated in place
 * @param {object} opts   { mode: 'keep-capacity' | 'settings-only' }
 * @returns {object}      a report of exactly what was removed
 */
function resetToJira(plan, { mode = 'keep-capacity' } = {}) {
  const report = { mode, removed: {}, kept: {} };

  // ── teams: keep the mapping, drop the roster ────────────────────────────
  // A team's identity (its board, its Team-field values, its capacity
  // constants) is configuration. Its members are Jira's to supply.
  // Count every roster row that disappears, including those on teams that are
  // themselves being dropped — a report that undercounts is a report you stop
  // trusting.
  const members = plan.teams.reduce((t, x) => t + (x.members || []).length, 0);
  const teamsBefore = plan.teams.length;
  plan.teams = plan.teams
    .filter(t => t.boardId)            // a team with no board cannot be rebuilt — it was invented locally
    .map(t => {
      const kept = {};
      for (const k of TEAM_KEEP) if (t[k] !== undefined) kept[k] = t[k];
      kept.members = [];
      kept.source = 'jira';
      return kept;
    });
  report.removed.teamsWithoutBoard = teamsBefore - plan.teams.length;
  report.removed.members = members;

  // ── sprints: keep only what a board actually confirmed ──────────────────
  // A locally generated sprint is a guess about a cadence. Once Jira is the
  // calendar, a guess sitting alongside real sprints is just a way to plan
  // against a fortnight that does not exist.
  const before = plan.sprints.length;
  plan.sprints = plan.sprints.filter(s =>
    Object.values(s.byTeam || {}).some(b => b && b.jiraId));
  report.removed.localSprints = before - plan.sprints.length;

  // Planning data keyed to a sprint that no longer exists would otherwise sit
  // in the file forever, invisible and counted by nothing.
  const liveSprints = new Set(plan.sprints.map(s => s.id));
  const liveTeams = new Set(plan.teams.map(t => t.id));
  const stillValid = (key) => {
    const [teamId, sprintId] = String(key).split('|');
    return liveTeams.has(teamId) && liveSprints.has(sprintId);
  };

  if (mode === 'settings-only') {
    report.removed.availability = Object.keys(plan.availability || {}).length;
    report.removed.support = Object.keys(plan.support || {}).length;
    report.removed.ceremony = Object.keys(plan.ceremony || {}).length;
    report.removed.overrides = Object.keys(plan.overrides || {}).length;
    report.removed.notes = Object.keys(plan.notes || {}).length;
    plan.availability = {}; plan.support = {}; plan.ceremony = {};
    plan.overrides = {}; plan.notes = {};
  } else {
    // Keep the grid, but drop entries pointing at sprints or teams that are gone.
    let orphans = 0;
    for (const field of ['availability', 'support', 'ceremony', 'overrides', 'notes']) {
      const src = plan[field] || {};
      const next = {};
      for (const [k, v] of Object.entries(src)) {
        if (stillValid(k)) next[k] = v; else orphans++;
      }
      plan[field] = next;
    }
    report.removed.orphanedPlanningEntries = orphans;
    report.kept.availability = Object.keys(plan.availability).length;
    report.kept.support = Object.keys(plan.support).length;
    report.kept.ceremony = Object.keys(plan.ceremony).length;
  }

  // ── never touched ───────────────────────────────────────────────────────
  // Exclusions above all: they encode a decision ("Titan has had 3 people since
  // Sprint 38"), and a cleanup that silently re-added 38 people would be the
  // opposite of cleaning up.
  plan.excluded = plan.excluded || {};
  plan.ignoredBoards = plan.ignoredBoards || [];
  report.kept.excluded = Object.fromEntries(
    Object.entries(plan.excluded).map(([k, v]) => [k, (v || []).length]));
  report.kept.holidays = (plan.holidays || []).length;
  report.kept.risks = (plan.risks || []).length;
  report.kept.constants = plan.teams.filter(t => t.settings).length;

  plan.updatedAt = new Date().toISOString();
  return report;
}

/**
 * The snapshot is a pure mirror of Jira, so a reset simply discards it. It costs
 * one sync to rebuild and guarantees no issue from a previous field mapping —
 * every one of them estimated at zero, say — survives into the new numbers.
 */
function clearSnapshot() {
  store.saveSnapshot({ issues: {}, sprints: [], people: [], boards: [], clearedAt: new Date().toISOString() });
}

module.exports = { resetToJira, clearSnapshot, TEAM_KEEP };
