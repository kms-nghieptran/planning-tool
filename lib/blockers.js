'use strict';
const epicsLib = require('./epics');
const insights = require('./insights');

/**
 * blockers.js — what is holding this team up, and who is chasing it.
 *
 * ── WHY THIS SCREEN EXISTS, AND WHY IT IS NOT THE RISKS SCREEN ───────────
 *
 * Risks answers "what might go wrong". This answers "what is already stuck,
 * and on whom" — a different question with a different shape. A risk is a
 * sentence; a blocker is a TICKET with a list of things waiting behind it.
 *
 * The numbers are what settled the design. Across his store:
 *
 *     543  items sitting in Refinement
 *      47  of them have a blocker recorded on their epic
 *     496  have NOTHING recorded at all
 *
 * So the detected half is thin and the register half is where the work is.
 * Both halves are on one page because they are two answers to one question,
 * and a screen that showed only the 47 would report the queue as healthy.
 *
 * ── GROUPED BY WHAT IS HOLDING THEM, NOT BY WHAT IS HELD ─────────────────
 *
 * The obvious rendering is a row per blocked item — 543 rows, one per thing
 * that is stuck, which is a list nobody reads twice. Grouped the other way
 * round, `CLICMNTIGO-11567 is holding 15 items` is ONE PHONE CALL. That is
 * the whole value of the page: it converts a backlog of stuck work into a
 * short list of people to go and talk to.
 *
 * An item held by two tickets appears under both, deliberately — chasing
 * either one is a real action — so the group counts sum to more than the
 * item count. `items` is the honest denominator, and the payload says so.
 *
 * ── WHAT "BLOCKED" MEANS HERE ────────────────────────────────────────────
 *
 * `insights.isBlocked` — status is Refinement — and nothing else. That
 * predicate is documented at its definition and already has four readers;
 * this is the fifth, not a sixth opinion. A page called Blockers that
 * counted something different from the Blocked KPI two screens away would
 * be the worst possible place to introduce a second definition.
 */

/**
 * EVERY ISSUE THIS TEAM'S BOARD KNOWS ABOUT — its sprints plus its backlog.
 *
 * There is no "all of this team's issues" list in the index, and building one
 * by ownership heuristics would answer a different question on every team
 * depending on whether a board is mapped. Sprints ∪ backlog is what the board
 * itself claims, which is the same set every other screen in this tool counts.
 *
 * De-duplicated by key: an item can sit in several sprints, and counting a
 * twice-slipped ticket twice would inflate exactly the figures this page
 * exists to report.
 */
function teamIssues(snap, teamId) {
  const idx = (snap.byTeam || {})[teamId];
  const issues = snap.issues || {};
  const keys = new Set();
  if (idx) {
    for (const list of Object.values(idx.sprintIssues || {})) for (const k of list || []) keys.add(k);
    for (const k of idx.backlog || []) keys.add(k);
  }
  return [...keys].map(k => issues[k]).filter(Boolean);
}

/** The Jira sprint ids one plan sprint maps to for a team. */
function sprintJiraIds(plan, teamId, sprintId) {
  const sp = (plan.sprints || []).find(s => s.id === sprintId);
  if (!sp) return null;
  const mine = (sp.byTeam || {})[teamId];
  const id = (mine && mine.jiraId) || sp.jiraId;
  return id == null ? null : new Set([String(id)]);
}

/** Is this item in that sprint? Read off the item, so it needs no index. */
const inSprint = (i, ids) => (i.sprints || []).some(s => s && s.id != null && ids.has(String(s.id)));

const pts = (list) => Math.round(list.reduce((t, i) => t + (Number(i.points) || 0), 0) * 10) / 10;

/**
 * A blocker's severity, from how much it is holding.
 *
 * DERIVED, NOT STORED. Nobody grades a Jira link, and asking them to would
 * produce a field that is empty on every row. How many items are waiting IS
 * the severity — one ticket holding fifteen is not the same problem as one
 * holding one, and that is the only thing here anybody can act on.
 */
const severityFor = (n) => (n >= 5 ? 'high' : n >= 2 ? 'medium' : 'low');

/**
 * The whole view: detected groups, the unrecorded pile, and the register.
 *
 * TEAM-WIDE, WITH THE SPRINT AS A FILTER. Risks is sprint-scoped because a
 * risk is about a commitment; a blocker outlives the sprint it was noticed
 * in, and most of his 496 unexplained items are nowhere near one. So the
 * scope is the team and `sprintId` narrows it — the payload carries both, so
 * a reader can always tell which of the two a number describes.
 */
function blockerView(plan, snap, { teamId = null, sprintId = null } = {}) {
  const team = (plan.teams || []).find(t => t.id === teamId) || null;
  const issues = {};
  for (const [k, v] of Object.entries(snap.issues || {})) issues[k] = v;
  const lookup = (k) => issues[k] || null;

  const all = team ? teamIssues(snap, team.id) : [];
  const blockedAll = all.filter(insights.isBlocked);

  /* ASKED FOR A SPRINT, AND ABLE TO APPLY IT, ARE TWO DIFFERENT THINGS.
     A sprint with no Jira id yet — not synced, or newly created — resolves to
     no ids, and the tempting `ids ? filter : everything` quietly drops the
     filter: the whole team's 543 items under a heading naming one sprint,
     which is the kind of wrong that looks exactly like being right. Asked
     but unmappable filters to NOTHING, and the empty state says so. */
  const asked = !!(sprintId && team);
  const ids = asked ? sprintJiraIds(plan, team.id, sprintId) : null;
  const blocked = asked ? (ids ? blockedAll.filter(i => inSprint(i, ids)) : []) : blockedAll;

  const byKey = new Map();
  const unrecorded = [];
  for (const i of blocked) {
    const groups = epicsLib.blockersFor(i, lookup);
    const keys = [...new Set(groups.flatMap(g => (g.blockers || []).map(b => b.key)).filter(Boolean))];
    if (!keys.length) { unrecorded.push(i); continue; }
    for (const k of keys) {
      if (!byKey.has(k)) {
        /* The link's own summary, because every blocker in his store is in a
           project this tool does not sync — it is the only description of the
           thing that will ever exist locally. A local issue wins when there
           is one, since that is the fuller record. */
        const fromLink = groups.flatMap(g => g.blockers || []).find(b => b.key === k) || {};
        const local = lookup(k);
        byKey.set(k, {
          key: k,
          summary: (local && local.summary) || fromLink.summary || null,
          status: (local && local.status) || null,
          issueType: (local && local.issueType) || fromLink.type || null,
          /* WHETHER WE CAN SEE IT AT ALL. Fifteen of his items are held by a
             ticket in a project this tool does not sync — the page has to say
             so rather than render a blank status that reads as "no status". */
          local: !!local,
          via: [],
          items: [],
        });
      }
      const g = byKey.get(k);
      g.items.push(i.key);
      for (const grp of groups) {
        if ((grp.blockers || []).some(b => b.key === k) && !g.via.includes(grp.epic)) g.via.push(grp.epic);
      }
    }
  }

  const detected = [...byKey.values()]
    .map(g => {
      const items = g.items.map(k => issues[k]).filter(Boolean);
      return { ...g, count: g.items.length, points: pts(items), severity: severityFor(g.items.length) };
    })
    .sort((a, b) => b.count - a.count || b.points - a.points || a.key.localeCompare(b.key));

  const linked = new Set((plan.blockers || []).flatMap(b => b.items || []));

  return {
    scope: {
      teamId: team ? team.id : null,
      teamName: team ? team.name : null,
      sprintId: asked ? sprintId : null,
      /* SAID SEPARATELY, so an empty sprint and an unmappable one do not read
         as the same result — one means "nothing is stuck", the other means
         "this tool cannot tell yet". */
      sprintMapped: asked ? !!ids : null,
      /* SAID OUT LOUD, because the two numbers differ by an order of
         magnitude and a reader who cannot tell which one they are looking at
         will act on the wrong one. */
      label: asked ? 'this sprint' : 'the whole board',
      teamTotal: blockedAll.length,
    },
    detected,
    unrecorded: {
      count: unrecorded.length,
      points: pts(unrecorded),
      items: unrecorded.map(i => i.key),
      /* ALREADY SPOKEN FOR. An item somebody has registered a blocker against
         is not unexplained any more — leaving it in this pile would mean the
         number never falls however much work he does, which is the fastest
         way to make a screen ignorable. */
      claimed: unrecorded.filter(i => linked.has(i.key)).length,
    },
    manual: (plan.blockers || []).slice().sort((a, b) =>
      (a.status === 'Resolved' ? 1 : 0) - (b.status === 'Resolved' ? 1 : 0)
      || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
    counts: {
      items: blocked.length,
      points: pts(blocked),
      explained: blocked.length - unrecorded.length,
      unrecorded: unrecorded.length,
      tickets: detected.length,
      registered: (plan.blockers || []).filter(b => String(b.status || '').toLowerCase() !== 'resolved').length,
    },
    /* WHAT THE DRAWERS NEED TO NAME A KEY.
       Every count on this page opens into a list, and a list of bare keys is
       a list somebody has to go to Jira to read. The blocking TICKETS are in
       here too, with whatever the link carried — they live in projects this
       tool does not sync, so that summary is the only description of them
       that will ever exist locally, and without it the drawer prints a bare
       key under "not in the local store" on exactly the rows it exists for. */
    catalogue: Object.fromEntries([
      ...blocked.map(i => [i.key, {
        key: i.key, summary: i.summary || '', status: i.status || '',
        statusCategory: i.statusCategory || '', points: i.points == null ? null : i.points,
        type: i.issueType || '', kind: 'item',
      }]),
      ...[...byKey.values()].map(g => [g.key, {
        key: g.key, summary: g.summary || '', status: g.status || '',
        statusCategory: '', type: g.issueType || '', kind: 'blocker',
      }]),
    ]),
    /* THE ITEMS A REGISTERED BLOCKER CAN BE LINKED TO, sent with the page:
       the picker needs names and statuses, and 543 rows asking for them one
       at a time is a stampede. Unrecorded first — those are the ones the
       register exists to explain. */
    linkable: [...unrecorded, ...blocked.filter(i => !unrecorded.includes(i))]
      .map(i => ({
        key: i.key,
        summary: i.summary || '',
        status: i.status || '',
        recorded: !unrecorded.includes(i),
      })),
  };
}

module.exports = { blockerView, teamIssues, severityFor, sprintJiraIds, inSprint };
