'use strict';
/**
 * carryover.js — work that arrived in this sprint from an earlier one.
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────────
 *
 * `planned` is the sum of story points on every item in a sprint, at full
 * value, with nothing distinguishing a fresh commitment from a story that has
 * been in flight for three sprints. Workload is `planned × hoursPerPoint /
 * capacity`, so a person who committed to their capacity, delivered 80% of it,
 * and carried the rest forward arrives in the next sprint already loaded — and
 * the tool calls them overcommitted for having finished most of what they took
 * on.
 *
 * Nothing here changes what a point is worth. The commitment number stays
 * gross, because a carried story really is work that still has to get done and
 * quietly discounting it would make the one number people plan against a
 * number nobody can reconcile against Jira. What this adds is the ability to
 * SAY where the load came from, so "over capacity" and "took on too much" stop
 * being the same sentence.
 *
 * ── WHAT COUNTS AS CARRIED IN ────────────────────────────────────────────
 *
 * The item is in this sprint and in an earlier sprint ON THIS TEAM'S BOARD.
 *
 * "On this team's board" is doing real work in that sentence. Issues travel:
 * an epic can sit in Ruby's Sprint 39 and Titan's TT Week 14Sep at the same
 * time, and counting another team's sprint as "earlier" would report a fresh
 * commitment as carryover because somebody else had looked at it first.
 *
 * "Earlier" is by DATE, not by the number in the name. Katalon Squad numbers
 * its sprints from 0 while Ruby is at 42, so sprint numbers are not a
 * chronology and never were — see reconcile.js for what that collision already
 * cost.
 *
 * ON "AND NOT DONE": an item that finished in the earlier sprint is not in
 * this one, so not-finishing-there is what put it here and the two rules
 * coincide. An item carried in and finished SINCE is still carryover — it
 * arrived as carryover, and a count that dropped it the moment it closed would
 * shrink as the sprint went on, which is not a property a commitment figure
 * can have. `doneItems` is reported separately so a screen can say "4 pts
 * carried in, 2 since finished" without redefining the first number.
 */

/**
 * Index this team's board: which Jira sprints are its own, and when they ran.
 *
 * Built from `plan.sprints[].byTeam[teamId]`, which reconcile fills from the
 * board itself — so a sprint only appears here if that board actually returned
 * it. Names are indexed alongside ids because an issue can carry a sprint with
 * no id at all (an older Jira custom-field format), and a team whose data
 * predates the id would otherwise report zero carryover forever rather than
 * reporting that it cannot tell.
 *
 * @returns {{byId: Map, byName: Map, size: number}}
 */
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

function teamSprintIndex(plan, team) {
  const byId = new Map();
  const byName = new Map();
  const teamId = team && team.id;
  if (!teamId) return { byId, byName, size: 0 };

  for (const row of (plan && plan.sprints) || []) {
    const mine = row && row.byTeam && row.byTeam[teamId];
    if (!mine) continue;
    /* THE TEAM'S OWN DATES, falling back to the calendar row's. A shared row
       carries one set of dates for every team on it while each team's real
       sprint ran when it ran, and ordering by the shared pair would call a
       sprint "earlier" for one team and not for another. */
    const entry = {
      rowId: row.id,
      jiraId: mine.jiraId == null ? null : String(mine.jiraId),
      name: mine.name || row.name || null,
      start: mine.start || row.start || null,
    };
    if (entry.jiraId) byId.set(entry.jiraId, entry);
    if (entry.name) byName.set(norm(entry.name), entry);
  }
  return { byId, byName, size: byId.size + byName.size };
}

/** Where this team's sprint actually started, which is what orders it. */
function startOf(sprint, teamId) {
  const mine = sprint && sprint.byTeam && teamId ? sprint.byTeam[teamId] : null;
  return (mine && mine.start) || (sprint && sprint.start) || null;
}

/**
 * Match one of an issue's sprint stamps to this team's board.
 * @returns {object|null} the indexed entry, or null when it is not this team's
 */
function teamEntryFor(stamp, index) {
  if (!stamp) return null;
  if (stamp.id != null) {
    const hit = index.byId.get(String(stamp.id));
    /* AN ID THAT IS NOT THIS BOARD'S IS AN ANSWER, not a reason to try the
       name. Ruby's "Sprint 40" and Titan's "Sprint 40" are different sprints
       with similar names, and falling through to a name match here is exactly
       how one team's work would be read as the other's carryover. */
    return hit || null;
  }
  return stamp.name ? index.byName.get(norm(stamp.name)) || null : null;
}

/**
 * Every earlier sprint of this team that this issue also sat in.
 *
 * @param {object} issue        an issue with `sprints: [{id?, name, start?}]`
 * @param {object} index        from `teamSprintIndex`
 * @param {string} currentStart the current sprint's start, for this team
 * @returns {Array<{rowId, jiraId, name, start}>} oldest first
 */
function priorSprints(issue, index, currentStart) {
  /* NO START DATE, NO CHRONOLOGY. A sprint the board has not dated cannot be
     placed before or after anything, and guessing would put real work in the
     wrong bucket silently. Callers surface this as "cannot tell" rather than
     as zero — see `split`. */
  if (!currentStart) return [];
  const seen = new Map();
  for (const stamp of (issue && issue.sprints) || []) {
    const entry = teamEntryFor(stamp, index);
    if (!entry || !entry.start) continue;
    if (entry.start >= currentStart) continue;      // this sprint, or a later one
    seen.set(entry.jiraId || entry.name, entry);
  }
  return [...seen.values()].sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

/** Did this issue arrive from an earlier sprint of this team's board? */
function isCarriedIn(issue, index, currentStart) {
  return priorSprints(issue, index, currentStart).length > 0;
}

/**
 * Split a set of items into what was carried in and what is new.
 *
 * `undated` counts items this cannot judge — the sprint has no start date, so
 * nothing can be ordered against it. Reported rather than folded into `fresh`,
 * because "no carryover" and "cannot tell" are different claims and a screen
 * that renders them the same is making one of them up.
 */
function split(items, index, currentStart, isDone = () => false) {
  const out = {
    carried: [], fresh: [],
    carriedPoints: 0, freshPoints: 0,
    carriedDone: 0, carriedDoneItems: [],
    oldest: null, undated: 0,
  };
  for (const i of items || []) {
    const pts = Number(i && i.points) || 0;
    if (!currentStart) { out.undated++; out.fresh.push(i); out.freshPoints += pts; continue; }
    const prior = priorSprints(i, index, currentStart);
    if (!prior.length) { out.fresh.push(i); out.freshPoints += pts; continue; }
    out.carried.push(i);
    out.carriedPoints += pts;
    if (isDone(i)) { out.carriedDone += pts; out.carriedDoneItems.push(i); }
    const first = prior[0];
    if (!out.oldest || String(first.start) < String(out.oldest.start)) out.oldest = first;
  }
  out.carriedPoints = round1(out.carriedPoints);
  out.freshPoints = round1(out.freshPoints);
  out.carriedDone = round1(out.carriedDone);
  return out;
}

/**
 * Work this sprint handed on: in it, not finished, and in a LATER sprint of
 * this team's board.
 *
 * The other half of the double count. A story that did not finish is charged
 * in full to the sprint that failed to finish it AND to the one that picks it
 * up, so two sprints of commitment buy one sprint of work. Knowing both ends
 * is what lets a history screen report that honestly instead of reporting a
 * team that over-commits every fortnight.
 */
function carriedOut(items, index, currentStart, isDone = () => false) {
  const out = { items: [], points: 0 };
  if (!currentStart) return out;
  for (const i of items || []) {
    if (isDone(i)) continue;
    const later = ((i && i.sprints) || []).some(stamp => {
      const entry = teamEntryFor(stamp, index);
      return entry && entry.start && entry.start > currentStart;
    });
    if (!later) continue;
    out.items.push(i);
    out.points += Number(i.points) || 0;
  }
  out.points = round1(out.points);
  return out;
}

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

module.exports = { teamSprintIndex, startOf, priorSprints, isCarriedIn, split, carriedOut };
