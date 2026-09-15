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
 * @returns {Array<{key, name, via, type, unconfirmed}>}
 */
function epicsFor(issue, lookup = () => null) {
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

  if (issue.category === 'maintenance') {
    fromRelates();
    if (!out.length) fromParent();
  } else {
    fromParent();
    if (!out.length) fromRelates();
  }
  return out;
}

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

module.exports = { epicsFor, rollup, isEpicType, EPIC_TYPE };
