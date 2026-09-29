'use strict';
/**
 * epics.js — which epic is a sprint item against?
 *
 * AUTOKAT answers that question two different ways depending on the kind of
 * work, and neither of them is Jira's "Epic Link" field:
 *
 *   NEW IMPLEMENTATION is a Story, and the Story sits UNDER the epic. The epic
 *   is the parent — `issue.parentKey`.
 *
 *   MAINTENANCE is not under anything. It is a standalone ticket LINKED to the
 *   epic whose coverage it maintains, with link type "Relates to". The epic is
 *   `relatesTo[].key`.
 *
 * Those two rules are the whole of what this module knows, and they came from
 * the team, not from inspection. Everything else here exists to stop the two
 * rules producing a blank or a lie:
 *
 *   A NAME, NOT JUST A KEY. "AUTOKAT-4412" tells a planner nothing. The name
 *   comes from the link or the parent payload where Jira gave us one, and from
 *   the store when the epic happens to be an issue we sync. It is usually the
 *   former: the sync queries select this team's sprint work, and an epic is
 *   normally not in that set.
 *
 *   REAL EPICS FIRST. A maintenance ticket can "relate to" a duplicate, a
 *   support ticket, anything. Where we know the issue type of the linked
 *   issues, and at least one of them IS an Epic, the non-epics are dropped —
 *   they are relations, not epics, and this column says Epic. Where we know
 *   nothing (older data, a Jira that did not return the type) everything is
 *   listed rather than guessed away, tagged `unconfirmed` so the UI can say so.
 *
 *   NO INVENTED PARENTS. A category's own rule is tried first and always wins.
 *   The other rule is only consulted when the first produced nothing at all,
 *   which is how a maintenance ticket that really does have an epic parent, or
 *   a story linked to its epic rather than filed under it, still reports one.
 *   `via` records which rule produced each entry, so nothing here is silent.
 */

/** Jira's own epic type, plus the names teams rename it to. */
const EPIC_TYPE = /^(epic|feature|initiative)$/i;

const isEpicType = (t) => EPIC_TYPE.test(String(t || '').trim());

/** A relates-to entry is an object now, but old snapshots hold bare strings. */
function asLink(v) {
  if (v && typeof v === 'object') return { key: v.key, summary: v.summary || null, type: v.type || null };
  return { key: v, summary: null, type: null };
}

/**
 * @param {object} issue    an issue with `category` already assigned
 * @param {function} lookup key -> stored issue, for names we did not get inline
 * @param {boolean} opts.both  run BOTH paths instead of falling back.
 *
 *   The default answers "which epic is this item against", so one path wins
 *   and the other is a fallback — an Epic column shows one thing.
 *
 *   `both` answers a different question: "every epic this item touches".
 *   A Bucket Story carries a parent AND relates-to links to the suites it is
 *   maintaining, and with the fallback rule the links are never read once a
 *   parent exists — which silently loses the whole maintenance half of a
 *   sprint. Callers that are collecting rather than labelling pass this.
 *
 * @returns {Array<{key, name, via, type, unconfirmed}>}
 */
function epicsFor(issue, lookup = () => null, { both = false } = {}) {
  if (!issue) return [];
  const seen = new Set();
  const out = [];

  const known = (key) => lookup(key) || null;

  const push = (link, via) => {
    if (!link || !link.key || seen.has(link.key)) return;
    seen.add(link.key);
    const stored = known(link.key);
    const type = link.type || (stored && stored.issueType) || null;
    out.push({
      key: link.key,
      name: link.summary || (stored && stored.summary) || null,
      via,
      type,
      // Only `false` when we positively know it is an Epic. Unknown stays true,
      // so the UI never claims a confirmation it does not have.
      unconfirmed: !isEpicType(type),
    });
  };

  const fromParent = () => {
    if (!issue.parentKey) return;
    push({ key: issue.parentKey, summary: issue.parentSummary || null, type: issue.parentType || null }, 'parent');
  };

  const fromRelates = () => {
    const links = (issue.relatesTo || []).map(asLink).filter(l => l.key);
    if (!links.length) return;

    // Where the types are known and any of them is an epic, the others are not
    // epics — they are just related work, and this column would be lying.
    const direct = links.filter(l => isEpicType(l.type || (known(l.key) || {}).issueType));
    if (direct.length) { for (const l of direct) push(l, 'relates'); return; }

    // NOTHING LINKED IS AN EPIC. In AUTOKAT a maintenance ticket's "relates to"
    // link often points at the TEST CASE it maintains, not at an epic — that is
    // exactly how the maintenance-ratio metric reads these links, and 953 of
    // 1,013 of those test cases turned out to be the parent of a "TCn: …" story
    // rather than an epic themselves. So climb one level: if a linked issue we
    // hold sits under an epic, THAT is the epic this work is against, and a
    // column headed Epic should say so instead of printing a test-case key.
    let climbed = 0;
    for (const l of links) {
      const stored = known(l.key);
      const parent = stored && stored.parentKey ? known(stored.parentKey) : null;
      if (!stored || !stored.parentKey) continue;
      const type = (parent && parent.issueType) || stored.parentType;
      if (!isEpicType(type)) continue;
      push({ key: stored.parentKey, summary: (parent && parent.summary) || stored.parentSummary || null, type }, 'relates-parent');
      climbed++;
    }
    if (climbed) return;

    // Still nothing identifiable. List what the links actually say rather than
    // guessing them away — `unconfirmed` tells the UI not to claim otherwise.
    for (const l of links) push(l, 'relates');
  };

  if (both) {
    // Collecting, not labelling — see the note on `opts.both`. `push` already
    // dedupes, so an epic reached twice appears once, tagged by whichever
    // path found it first.
    fromParent();
    fromRelates();
  } else if (issue.category === 'maintenance') {
    fromRelates();
    if (!out.length) fromParent();
  } else {
    fromParent();
    if (!out.length) fromRelates();
  }
  return out;
}

/**
 * WHAT IS HOLDING THIS ITEM UP — read off its EPIC, not off the item.
 *
 * On his data not one Story in Refinement carries an "is blocked by" link of
 * its own; their parent epics do. Read the Story and the sprint looks merely
 * slow; read its epic and there is a single ticket to chase — across the whole
 * store `CLICMNTIGO-11567` alone holds fifteen items.
 *
 * ── WHY THIS IS ITS OWN FUNCTION ─────────────────────────────────────────
 *
 * It lived inside `workForSprint`, which meant it existed only for items IN a
 * sprint. The Blockers screen asks the same question of a team's whole board —
 * 543 items in Refinement, most of them nowhere near a sprint — and answering
 * it there with a second walk is how two screens come to disagree about what a
 * ticket is waiting for. Same lesson as `backlog-item.js`: the moment a second
 * reader appears, the definition moves somewhere neither of them owns.
 *
 * THE WHOLE LINK IS KEPT, not just its key. Every blocker in his store lives in
 * a project this tool does not sync, so the summary Jira sent inside the link
 * is the only description of it that will ever exist locally.
 *
 * AN EMPTY ARRAY MEANS "NOTHING RECORDED", never "not looked up" — only epics
 * that actually name something are kept. On this data that distinction is the
 * main finding rather than an edge case: 496 of the 543 are empty.
 *
 * @param {Array} epics  already-resolved epics, when the caller has them —
 *   `epicsFor` is not cheap and `workForSprint` has just run it.
 * @returns {Array<{epic, name, via, blockers: Array<{key, summary, type}>}>}
 */
function blockersFor(issue, lookup = () => null, epics = null) {
  return (epics || epicsFor(issue, lookup))
    .map((e) => {
      const epic = lookup(e.key);
      const seen = new Set();
      const blockers = ((epic && epic.blockedBy) || [])
        .map(b => asLink(b))
        .filter(l => l.key)
        .map(l => ({ ...l, key: String(l.key).trim().toUpperCase() }))
        .filter(l => !seen.has(l.key) && seen.add(l.key));
      return blockers.length ? { epic: e.key, name: e.name || null, via: e.via, blockers } : null;
    })
    .filter(Boolean);
}

/** Every distinct key holding an item up, across all the epics behind it. */
const blockerKeys = (item) => [...new Set(((item && item.epicBlockers) || [])
  .flatMap(g => (g.blockers || []).map(b => asLink(b).key))
  .filter(Boolean))];

/**
 * Epics across a set of items, biggest first — "what did this sprint actually
 * go on". Points are counted whole against every epic an item names, so the
 * column totals can exceed the sprint's; `count` is the honest denominator.
 */
function rollup(issues) {
  const m = new Map();
  let unmapped = 0;
  for (const i of issues || []) {
    const list = i.epics && i.epics.length ? i.epics : epicsFor(i);
    if (!list.length) { unmapped++; continue; }
    for (const e of list) {
      if (!m.has(e.key)) m.set(e.key, { key: e.key, name: e.name, points: 0, count: 0 });
      const g = m.get(e.key);
      if (!g.name && e.name) g.name = e.name;
      g.points += Number(i.points) || 0;
      g.count++;
    }
  }
  const rows = [...m.values()]
    .map(g => ({ ...g, points: Math.round(g.points * 10) / 10 }))
    .sort((a, b) => b.points - a.points || b.count - a.count);
  return { rows, unmapped };
}

/** A bucket story: the container AUTOKAT files maintenance work under. */
const BUCKET_TYPE = /^bucket\s*story$/i;
const isBucketStory = (issue) => BUCKET_TYPE.test(String((issue && issue.issueType) || '').trim());

/**
 * HOW MANY TEST CASES A BUCKET STORY IS MAINTAINING.
 *
 * One "relates to" link, one test case. That is the team's own convention and
 * the reason the link exists: a bucket story is a container for a fortnight of
 * maintenance, and each thing it relates to is a suite being kept working.
 *
 * COUNTED FROM THE LINKS THEMSELVES, not from `epicsFor`. Those two numbers
 * are close but not the same, and the difference is the point: `epicsFor` is
 * trying to name the EPIC behind the work, so it drops links that are not
 * epics, climbs to a parent when nothing linked is one, and folds duplicates
 * together. Every one of those steps is right for a column headed Epic and
 * wrong for a count of what is being maintained — two test cases under one
 * epic are two test cases, and would arrive here as one.
 *
 * Deduplicated by key all the same: Jira will happily hold the same link twice,
 * once from each side, and that is one test case, not two.
 *
 * THE SET, NOT JUST ITS SIZE. The number on the grid opens a drawer listing
 * what it counted, and a list built by a second walk of the same links is a
 * list that can disagree with the figure above it — the exact failure the
 * drill-ins on this screen are built to avoid. So the set is the function and
 * the count is its length; there is one definition and two readers.
 */
function maintainedLinks(issue) {
  if (!issue) return [];
  const seen = new Set();
  const out = [];
  for (const l of issue.relatesTo || []) {
    const link = asLink(l);
    const key = link.key ? String(link.key).trim().toUpperCase() : null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // The link's own summary and type come along: a maintained suite is
    // usually outside what we sync, so this is the only description of it we
    // will ever have.
    out.push({ ...link, key });
  }
  return out;
}

const maintainedCount = (issue) => maintainedLinks(issue).length;

module.exports = { epicsFor, blockersFor, blockerKeys, rollup, isEpicType, EPIC_TYPE, isBucketStory, maintainedCount, maintainedLinks, BUCKET_TYPE, asLink };
