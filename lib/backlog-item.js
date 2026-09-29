'use strict';
/**
 * backlog-item.js — what counts as a backlog item. One definition, four readers.
 *
 * A backlog item is a piece of work somebody will pull into a sprint: a Story,
 * a Bucket Story, a Defect, a Test. An EPIC is the container those hang off —
 * it is never pulled in, it is finished when its children are — so counting
 * epics makes the queue read as several times its real size.
 *
 * ── WHY THIS IS ITS OWN FILE ─────────────────────────────────────────────
 *
 * It started as a constant inside `insights.backlogView`, and the same index
 * turned out to have FOUR readers, each with its own copy of the walk:
 *
 *     insights.backlogView      the Backlog view's item list
 *     metrics.backlogHealth     the Backlog page's KPIs and runway
 *     reconcile.buildTeamIndex  backlogCount/backlogPoints — the SIDEBAR
 *     reconcile's own `index`   the setup screen's per-team summary
 *
 * Fixing the first two left the sidebar saying 1,877 beside a page saying
 * 594, which is the worst version of this bug: both numbers are on screen at
 * once, neither looks wrong on its own, and the one a reader trusts is
 * whichever they happened to look at first.
 *
 * It cannot live in `insights` because `insights` requires `reconcile`, so
 * `reconcile` importing it back would close a cycle. A module of its own has
 * no dependencies at all and therefore no direction to get wrong — which is
 * the point: the next reader to appear can import it without thinking about
 * layering, and that is the only way a definition stays single.
 *
 * ── NOT "NOT AN EPIC", BUT "IS WORK YOU PULL IN" ─────────────────────────
 *
 * Expressed as the type that is EXCLUDED rather than a list of the ones
 * allowed, deliberately. AUTOKAT grows issue types — Bucket Story and Test
 * both arrived after this tool did — and an allow-list would silently drop
 * every new one from the queue on the day it was introduced, which is a
 * number falling with nothing to say why. A deny-list of one is wrong in the
 * other direction: a new container type would be counted. That is the better
 * failure, because it is visible — the count goes UP and somebody asks.
 */

/** The type that is a container rather than a thing you pull into a sprint. */
const CONTAINER_TYPE = /^epic$/i;

/**
 * @param {object} i  an issue
 * @returns {boolean} whether it belongs in a backlog count
 */
function isBacklogItem(i) {
  return !!i && !CONTAINER_TYPE.test(String(i.issueType || '').trim());
}

/** The backlog items out of a list, in order. */
const only = (items) => (items || []).filter(isBacklogItem);

/**
 * Split a list into what counts and what did not, so a caller can REPORT the
 * exclusion rather than drop it in silence. A figure that fell by two thirds
 * between releases has to be able to explain itself.
 *
 * @returns {{items: Array, excluded: number, scanned: number}}
 */
function split(items) {
  const all = items || [];
  const kept = all.filter(isBacklogItem);
  return { items: kept, excluded: all.length - kept.length, scanned: all.length };
}

/**
 * ONE TEAM'S BACKLOG FIGURES, counted from the stored key list.
 *
 * WHY AT READ TIME AND NOT JUST IN THE INDEX. The team index is written at
 * SYNC time, so a correction to what counts as a backlog item does not reach
 * anything reading `backlogCount` until the next full sync — and in the
 * meantime the sidebar says 1,877 beside a page saying 594. `buildTeamIndex`
 * computes the same thing for new syncs; this is what makes it true now.
 *
 * Both go through `only` above, which is what stops them drifting.
 *
 * @returns {{count, points, scanned, excluded}}
 */
function figuresFor(snap, teamIndexEntry) {
  const keys = (teamIndexEntry && teamIndexEntry.backlog) || [];
  const all = keys.map(k => (snap.issues || {})[k]).filter(Boolean);
  const { items, excluded, scanned } = split(all);
  return {
    count: items.length,
    points: Math.round(items.reduce((t, i) => t + (Number(i.points) || 0), 0) * 10) / 10,
    scanned,
    excluded,
  };
}

module.exports = { CONTAINER_TYPE, isBacklogItem, only, split, figuresFor };
