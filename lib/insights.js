'use strict';
/**
 * insights.js — turns (snapshot + plan) into the four views.
 *
 * Nothing here touches the network. Everything is derived from snapshot.json and
 * plan.json, which is why the whole app renders instantly.
 */

const cap = require('./capacity');
const cls = require('./classify');
const epicsLib = require('./epics');
const reconcile = require('./reconcile');
const rosterLib = require('./roster');
const lock = require('./lock');
// For `productComponents`: the tool markers (TrueTest, Katalon) are carried on
// issues as components but are not product areas, and the coverage report
// already knows the difference. One definition of "component", not two.
const coverageLib = require('./coverage');
const priorityLib = require('./priority');

/* ─────────────────────────── matching helpers ─────────────────────────── */

/** Does this issue belong to this team's sprint? Matches Jira's namespaced names. */
function sprintMatcher(team, sprint) {
  const keywords = (team.sprintKeywords && team.sprintKeywords.length ? team.sprintKeywords : [team.name])
    .map(k => String(k).toLowerCase());
  const num = sprint.number;
  // A date-named sprint ("TT Week 31Aug") has no number to compare, so the only
  // honest fallback is its exact Jira name. Without this the TrueTest boards
  // match nothing whenever the index is unavailable.
  const jiraName = ((sprint.byTeam && sprint.byTeam[team.id] && sprint.byTeam[team.id].name) || '').toLowerCase();
  const fn = (name) => {
    const n = String(name || '').toLowerCase();
    if (num == null) return jiraName ? n === jiraName : false;
    if (!keywords.some(k => n.includes(k))) return false;
    // "Katalon Ruby Sprint 33" and the older "Katalon Ruby 33" both end in the number
    const m = n.match(/(\d+)\s*$/);
    return m ? Number(m[1]) === num : false;
  };
  // Once the board has been synced we know this team's real Jira sprint id, which
  // survives a rename; the name check stays as the fallback for un-synced data.
  fn.jiraId = (sprint.byTeam && sprint.byTeam[team.id] && sprint.byTeam[team.id].jiraId)
    || sprint.jiraId || null;
  return fn;
}

function issueInSprint(issue, match) {
  if (match.jiraId && (issue.sprints || []).some(s => s && s.id && String(s.id) === match.jiraId)) return true;
  return (issue.sprintNames || []).some(match);
}

/**
 * Resolve a Jira assignee onto a team member.
 *
 * accountId wins, then the exact name or a recorded alias, then a short name
 * against its full one — "Anh" to "Anh Truong". That last rule, and the guards
 * that make it safe, live in roster.js and are shared with the roster
 * derivation, because attribution and derivation have to agree about who is
 * who or the same person gets two rows.
 */
function memberResolver(team) {
  const byId = new Map(), byName = new Map();
  for (const m of team.members || []) {
    if (m.jiraAccountId) byId.set(m.jiraAccountId, m.id);
    byName.set(norm(m.name), m.id);
    for (const alias of m.jiraNames || []) byName.set(norm(alias), m.id);
  }
  const loose = rosterLib.looseIndex(team.members);
  const cache = new Map();

  // Which Jira names were matched this way, per member. An inferred link is
  // shown on the screen rather than applied silently: it is the one thing here
  // the tool worked out instead of being told, so it has to be checkable by the
  // person who would know it was wrong.
  const inferred = new Map();

  const resolve = (issue) => {
    if (issue.assigneeId && byId.has(issue.assigneeId)) return byId.get(issue.assigneeId);
    if (!issue.assignee) return null;
    const n = norm(issue.assignee);
    if (byName.has(n)) return byName.get(n);
    if (!loose.length) return null;
    if (!cache.has(n)) {
      const m = rosterLib.looseMatch(loose, issue.assignee);
      cache.set(n, m ? m.id : null);
    }
    const id = cache.get(n);
    if (id) {
      if (!inferred.has(id)) inferred.set(id, new Set());
      inferred.get(id).add(issue.assignee);
    }
    return id;
  };
  resolve.inferred = inferred;
  return resolve;
}

function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

const isDone = (i) => i.statusCategory === 'done' || /^(done|closed|resolved)$/i.test(i.status || '');
const isInProgress = (i) => i.statusCategory === 'indeterminate' || /in dev|in testing|in progress|review/i.test(i.status || '');

/* ─────────────────────────── work aggregation ─────────────────────────── */


/** This sprint's issue keys from the per-team index, or null when unbuilt. */
function sprintIssueKeys(snap, team, sprint) {
  const t = (snap.byTeam || {})[team.id];
  if (!t || !t.sprintIssues) return null;
  const jiraId = (sprint.byTeam && sprint.byTeam[team.id] && sprint.byTeam[team.id].jiraId) || sprint.jiraId;
  if (!jiraId) return null;
  return t.sprintIssues[String(jiraId)] || [];
}

/**
 * All issues for one team + sprint, and the per-member planned/actual roll-up
 * the capacity grid needs. Manual overrides in plan.json win over Jira, so the
 * tool still works with no connection at all.
 */
/**
 * The raw issues in one team's sprint, before anything is attributed to a
 * person. Separated out because the ROSTER is derived from these — who was
 * assigned work is what says who was on the team — and the roster then decides
 * which members `workForSprint` rolls the same issues up into. Resolving them
 * twice would be wasteful and would risk the two passes disagreeing.
 */
function issuesForSprint(snap, team, sprint) {
  // Fast path: the sync pre-grouped this sprint's issue keys per team, so picking
  // a team is a lookup rather than a scan over every issue in the project.
  const indexed = sprintIssueKeys(snap, team, sprint);
  return indexed
    ? indexed.map(k => (snap.issues || {})[k]).filter(Boolean)
    : Object.values(snap.issues || {}).filter(i => issueInSprint(i, sprintMatcher(team, sprint)));
}

function workForSprint(plan, snap, team, sprint, raw = null) {
  const resolve = memberResolver(team);
  const rules = plan.categoryRules;

  // The epic depends on the category — a Story's epic is its parent, a
  // maintenance ticket's is a "relates to" link — so it is attached here, one
  // step after classification, and every consumer of `work.issues` gets it.
  const lookup = (k) => (snap.issues || {})[k] || null;
  const issues = (raw || issuesForSprint(snap, team, sprint))
    .map(i => {
      const out = { ...i, memberId: resolve(i), category: cls.classify(i, rules) };
      out.epics = epicsLib.epicsFor(out, lookup);
      // How many test cases this item is maintaining — one per "relates to"
      // link. Only a bucket story carries the count, because only a bucket
      // story is a container for maintenance; on anything else a relates-to
      // link means something else entirely and calling it a test case would
      // be a number that looks like data.
      out.bucket = epicsLib.isBucketStory(out);
      out.maintains = out.bucket ? epicsLib.maintainedCount(out) : null;
      return out;
    });

  const byMember = {};
  for (const m of team.members || []) byMember[m.id] = { planned: 0, actual: 0, items: [] };

  /* WORK THAT LANDS ON NOBODY ON THE ROSTER IS NOT ALL THE SAME THING.
   *
   * `unowned` is the whole of it, and it is what the commitment total needs —
   * the sprint contains this work whoever is or is not holding it.
   *
   * But it is two different situations, and calling both of them "unassigned"
   * was simply untrue of one: a ticket with nobody in the Assignee field is
   * unassigned, while a ticket assigned to someone who is not on this sprint's
   * roster has an owner with a name. Reporting the second as the first is how
   * "53 items have no assignee" appeared over a sprint where every single item
   * named a person. They are split here so no screen has to guess.
   */
  const unowned = { planned: 0, actual: 0, items: [] };
  const unassigned = { planned: 0, actual: 0, items: [] };
  const offRoster = { planned: 0, actual: 0, items: [], people: [] };
  const byPerson = new Map();

  for (const i of issues) {
    const pts = Number(i.points) || 0;
    const done = isDone(i);
    const mine = i.memberId && byMember[i.memberId];
    const add = (b) => { b.planned += pts; if (done) b.actual += pts; b.items.push(i); };

    if (mine) { add(byMember[i.memberId]); continue; }

    add(unowned);
    if (!i.assignee && !i.assigneeId) { add(unassigned); continue; }

    add(offRoster);
    // Grouped by person, so a screen can say who rather than how many.
    const key = i.assigneeId || norm(i.assignee);
    if (!byPerson.has(key)) {
      byPerson.set(key, { key, name: i.assignee || i.assigneeId, accountId: i.assigneeId || null, planned: 0, actual: 0, count: 0 });
    }
    const p = byPerson.get(key);
    p.planned += pts;
    if (done) p.actual += pts;
    p.count++;
  }

  offRoster.people = [...byPerson.values()]
    .map(p => ({ ...p, planned: round1(p.planned), actual: round1(p.actual) }))
    .sort((a, b) => b.planned - a.planned || b.count - a.count || String(a.name).localeCompare(String(b.name)));

  // Manual overrides (no Jira, or a correction) replace the computed numbers.
  for (const m of team.members || []) {
    const o = rosterLib.lookup(plan.overrides, team.id, sprint.id, m);
    if (o && (o.planned != null || o.actual != null)) {
      if (o.planned != null) byMember[m.id].planned = Number(o.planned) || 0;
      if (o.actual != null) byMember[m.id].actual = Number(o.actual) || 0;
      byMember[m.id].overridden = true;
    }
  }

  return {
    issues, byMember, unowned, unassigned, offRoster,
    // Names the resolver worked out rather than was told — surfaced so the
    // person who would know it is wrong can see it.
    inferredNames: Object.fromEntries([...resolve.inferred].map(([id, set]) => [id, [...set]])),
  };
}

/**
 * Support/learning load and ceremony hours are per-sprint facts, not permanent
 * member traits — someone mentors a new joiner for two sprints and then stops.
 * plan.support / plan.ceremony hold the per-sprint values; the member-level and
 * team-level values are the fallback.
 */
/**
 * The team AS IT IS FOR ONE SPRINT — the roster, the support percentages and
 * the ceremony hours that sprint actually had.
 *
 * This is the single place the per-sprint roster enters the system. Everything
 * downstream — the availability grid, the work roll-up, the capacity totals —
 * reads `team.members`, so narrowing it here makes all of them per-sprint at
 * once, and makes it impossible for two of them to disagree about who was on
 * the team.
 *
 * `roster` is optional so that callers who have not resolved this sprint's
 * issues yet (the forecast, which models sprints that do not exist) keep the
 * old behaviour of using the whole team list. Those are the cases where "who
 * was assigned work" has no answer.
 */
function teamForSprint(plan, team, sprint, roster = null) {
  const base = roster ? roster.members : (team.members || []);
  const members = base.map(m => {
    // Through rosterLib.lookup, not a direct key: a member's capacity data can
    // be filed under an older id than the one they carry now.
    const override = rosterLib.lookup(plan.support, team.id, sprint.id, m);
    return override == null ? m : { ...m, supportPct: Number(override) || 0 };
  });
  const ceremony = (plan.ceremony || {})[`${team.id}|${sprint.id}`];
  const settings = ceremony == null ? team.settings : { ...(team.settings || {}), ceremonyHours: Number(ceremony) };
  return { ...team, members, settings };
}

function availabilityFor(plan, team, sprint) {
  const out = {};
  for (const m of team.members || []) {
    const row = rosterLib.lookup(plan.availability, team.id, sprint.id, m);
    out[m.id] = row || defaultAvailability(sprint, plan.holidays);
  }
  return out;
}

/** A fresh sprint defaults to: weekends off, public holidays off, everything else a full day. */
function defaultAvailability(sprint, holidays = []) {
  const days = sprintDays(sprint);
  return days.map(d => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) return 'WO';
    if (holidays.includes(d)) return 'H';
    return '1';
  });
}

/** Did `a` run before `b`? Dates first, number as the fallback. */
function before(a, b) {
  if (a.start && b.start) return a.start < b.start;
  if (a.number != null && b.number != null) return a.number < b.number;
  return false;
}

/**
 * The days a sprint actually covers.
 *
 * Length comes from the sprint's own dates, not a hardcoded fortnight. The
 * TrueTest boards run WEEKLY sprints ("TT Week 31Aug"), and giving one of those
 * a 14-day grid puts seven days of the next sprint into this one's capacity —
 * every availability cell after day 7 would be for a sprint that has not
 * started. Falls back to 14 only when Jira gave us no end date.
 */
function sprintDays(sprint, length = null) {
  const out = [];
  let n = length;
  if (n == null) {
    if (sprint.start && sprint.end) {
      const days = Math.round((new Date(`${sprint.end}T00:00:00Z`) - new Date(`${sprint.start}T00:00:00Z`)) / 864e5) + 1;
      n = Math.min(31, Math.max(1, days));   // a sane band: a sprint is not a year
    } else {
      n = 14;
    }
  }
  if (!sprint.start) return new Array(n).fill(null);
  const start = new Date(`${sprint.start}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    const d = new Date(start.getTime() + i * 864e5);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/* ─────────────────────────── view: capacity ─────────────────────────── */

/**
 * The team AS IT WAS FOR ONE SPRINT, with the issues the roster was derived
 * from, so nothing derives it twice and differently.
 *
 * Extracted because `velocityHistory` was NOT doing this: it measured every
 * sprint in the team's past against the member list as it stands TODAY. For a
 * team whose people have changed — which is every team, over 38 sprints — that
 * credits a sprint's whole delivery to whoever happens to be on the team now,
 * and drops everything the people who have since moved on actually shipped.
 */
function sprintRoster(plan, snap, baseTeam, sprint) {
  const rawIssues = issuesForSprint(snap, baseTeam, sprint);
  const roster = rosterLib.forSprint(plan, baseTeam, sprint, rawIssues, lock.stateFor(sprint, baseTeam.id));
  return { rawIssues, roster, team: teamForSprint(plan, baseTeam, sprint, roster) };
}

function capacityView(plan, snap, baseTeam, rawSprint) {
  const sprint = reconcile.forTeam(rawSprint, baseTeam.id);

  // ORDER MATTERS. The issues come first, because the ROSTER is derived from
  // them — who was assigned work in this sprint is what says who was on the
  // team. Only then is the team narrowed to that roster, and the same issues
  // rolled up against it. Resolving the issues after building the team would
  // mean deriving the roster from a member list that had already been filtered
  // by the roster, which is circular.
  const { rawIssues, roster, team } = sprintRoster(plan, snap, baseTeam, sprint);
  const avail = availabilityFor(plan, team, sprint);
  const work = workForSprint(plan, snap, team, sprint, rawIssues);
  const grid = cap.sprintGrid(team, sprint, avail, work.byMember);

  // Who is here and why, so the screen can say "4 assigned, 1 you added"
  // rather than presenting a number with no provenance.
  grid.roster = {
    counts: roster.counts,
    added: roster.added,
    removed: roster.removed,
    members: team.members.map(m => {
      // WORK IN THIS SPRINT BEATS WHAT WE ASSUMED ABOUT THE PERSON.
      //
      // Someone known only from a leave grid is created as a "planned" row and
      // marked historic, on the reasonable guess that a capacity row with no
      // work behind it is a leftover. Once their work is matched to them that
      // guess is simply wrong, and leaving it showed Anh — sixteen points into
      // the active sprint — tagged "planned" and "past member" at once.
      const w = work.byMember[m.id];
      const working = !!w && (w.planned > 0 || w.actual > 0 || w.items.length > 0);
      return {
      id: m.id, name: m.name, onSprint: working ? 'assigned' : (m.onSprint || 'added'),
      notOnTeamList: !!m.notOnTeamList, unresolved: !!m.unresolved,
      historic: !!m.historic && !working,
      // "Anh" on the roster, "Anh Truong" in Jira: the same person, linked by
      // name because the roster record has no account id. Said out loud.
      matchedNames: (work.inferredNames || {})[m.id] || undefined,
      // Where this person's capacity data is actually filed, when that is not
      // under the id they carry now. Shown so a surprising row is explicable.
      aliasIds: m.aliasIds && m.aliasIds.length ? m.aliasIds : undefined,
      };
    }),
  };
  // Read-only is decided here, once, and both the screen and the server read
  // the same answer. A screen that worked it out for itself would eventually
  // work it out differently.
  grid.lock = lock.status(sprint, baseTeam.id);

  grid.days = sprintDays(sprint).map(d => ({
    date: d,
    dow: d ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${d}T00:00:00Z`).getUTCDay()] : '',
    holiday: (plan.holidays || []).includes(d),
  }));
  grid.availability = avail;
  grid.mix = cls.mix(work.issues, plan.categoryRules);
  grid.mixVsTarget = cls.mixVsTarget(grid.mix, (plan.mixTargets || {})[team.id]);
  // Work that landed on nobody on the roster, in the SAME shape as a member row
  // — planned and done — so a screen can show it beside the people instead of
  // only folding it into the totals, and split by WHY it landed nowhere so no
  // screen has to call a named owner "unassigned".
  const pile = (b) => ({
    points: round1(b.planned), done: round1(b.actual),
    count: b.items.length, items: b.items,
  });
  // The sprint's tickets. Capacity planning shows the same list the Active
  // sprint screen does — "who is carrying what" and "is this landing" are two
  // questions that both end at the actual list of work.
  grid.items = work.issues;
  grid.unowned = { ...pile(work.unowned), people: work.offRoster.people };
  grid.unassigned = pile(work.unassigned);
  grid.offRoster = { ...pile(work.offRoster), people: work.offRoster.people };
  // Everything that ran BEFORE this sprint. Compared by date, because a
  // date-named sprint has no number to compare and mixing the two conventions
  // on a number would silently drop the whole history.
  grid.history = velocityHistory(plan, snap, team).filter(h => before(h, sprint));
  grid.calibration = cap.calibrateHoursPerPoint(grid.history);
  grid.note = (plan.notes || {})[`${team.id}|${sprint.id}`] || '';
  return grid;
}

/**
 * The sprint's progress, one row per product component.
 *
 * WHY PRODUCT COMPONENTS AND NOT JUST `components`. Two thirds of his active
 * sprint items carry more than one — but 154 of those tags are "TrueTest",
 * which is a tool marker rather than an area of the product. Grouping on the
 * raw list would have produced a breakdown whose biggest row was the automation
 * tool, which tells a team lead nothing about where the sprint is. Stripping
 * the markers leaves only 11 of 266 items in more than one component.
 *
 * Each of those 11 counts in BOTH of its components — the same rule the
 * coverage report uses, and the honest one: picking a single component per item
 * would under-report every area that shares work. It does mean the column can
 * add up to slightly more than the commitment, so the screen says so when it
 * happens rather than leaving the reader to notice.
 */
/**
 * @param {Array}  items
 * @param {object} [plan]  so each row can carry his own priority for the suite
 */
function componentProgress(items, plan = null) {
  const rows = new Map();
  let shared = 0;
  for (const i of items || []) {
    const comps = coverageLib.productComponents(i);
    if (comps.length > 1) shared++;
    const pts = Number(i.points) || 0;
    const done = isDone(i);
    for (const c of comps) {
      if (!rows.has(c)) rows.set(c, { component: c, count: 0, points: 0, done: 0, unestimated: 0, blocked: 0 });
      const r = rows.get(c);
      r.count++;
      r.points += pts;
      if (done) r.done += pts;
      if (!i.points && !done) r.unestimated++;
      if (!done && (i.blockedBy || []).length) r.blocked++;
    }
  }
  return {
    rows: priorityLib.decorate([...rows.values()]
      .map(r => ({
        ...r,
        points: round1(r.points),
        done: round1(r.done),
        remaining: round1(r.points - r.done),
        donePct: r.points ? Math.round(r.done / r.points * 100) : 0,
      }))
      .sort((a, b) => b.points - a.points || b.count - a.count || a.component.localeCompare(b.component)), plan),
    // How many items are counted twice, so the caption can explain a total
    // that is larger than the commitment instead of looking like an error.
    shared,
  };
}

/**
 * TEST CASES BY COMPONENT — automated, and maintained.
 *
 * The two halves of this table come from opposite ends of the data, because
 * that is how AUTOKAT records them, and neither is the sprint item itself:
 *
 *   MAINTAINED  A Bucket Story is a fortnight's container for maintenance and
 *               each "relates to" link on it is one suite being kept working.
 *               So the count is the LINKS, which is the convention he gave when
 *               the Test cases column was built.
 *
 *   AUTOMATED   A Story is the work of automating a test case, and the test
 *               case is its PARENT EPIC. So the count is the epics — read from
 *               the epic's own Automation Status, not the Story's. His
 *               correction, and the right one: AUTOKAT-9715 is a Story with no
 *               Automation Status of its own under an epic that is Automated,
 *               and it is the epic that says whether the test case exists.
 *
 * DISTINCT EPICS, NOT ITEMS. Two Stories under one epic are one test case, and
 * two Bucket Stories can relate to the same suite. Every column here is the size
 * of a set of epic keys, which is also why the totals row is NOT the sum of the
 * rows above it — see below.
 *
 * ONLY STORIES COUNT AS AUTOMATION. Every Bucket Story in his active sprint
 * hangs off the same parent, AUTOKAT-7789, the maintenance container — counting
 * parents indiscriminately would report that one epic as six automated test
 * cases.
 *
 * GROUPED BY THE SPRINT ITEM'S COMPONENT, not the epic's. The epic often
 * carries a different one (AUTOKAT-9720 sits in PS_iGO_NYL_Annuities under an
 * epic tagged PS_iGO_NYL_IDI), and the rest of this screen groups by the item.
 * One page, one definition of "which component is this work in", or the table
 * directly above this one disagrees with it.
 */
function testCaseSummary(items, lookup = () => null) {
  const rows = new Map();
  // The sprint-wide sets. Kept separately because an item in two components is
  // in two rows, so adding the rows up would report the same test case twice —
  // the same trap the coverage grid documents, and a total is exactly where
  // nobody would notice it.
  const all = { automated: new Set(), inFlight: new Set(), maintained: new Set() };
  let unlinked = 0, shared = 0;

  const row = (c) => {
    if (!rows.has(c)) {
      rows.set(c, {
        component: c, items: 0, done: 0, stories: 0, buckets: 0, unlinked: 0,
        _automated: new Set(), _inFlight: new Set(), _maintained: new Set(),
      });
    }
    return rows.get(c);
  };

  for (const i of items || []) {
    const comps = coverageLib.productComponents(i);
    if (comps.length > 1) shared++;
    const done = isDone(i);
    const bucket = epicsLib.isBucketStory(i);
    const story = /^story$/i.test(String(i.issueType || '').trim());

    // The test cases this item speaks for, resolved once and shared by every
    // component row it lands in.
    const maintained = bucket
      ? [...new Set((i.relatesTo || []).map(l => (l && typeof l === 'object' ? l.key : l)).filter(Boolean).map(k => String(k).trim().toUpperCase()))]
      : [];
    let automated = null, inFlight = null;
    if (story && i.parentKey) {
      const epic = lookup(i.parentKey);
      const key = String(i.parentKey).trim().toUpperCase();
      // The SAME classifier the Coverage report uses, so "automated" means one
      // thing in this tool. It also folds in Jira's "Done" alias, which a
      // hand-written equality check on the string would miss.
      if (epic && coverageLib.bucketOf(epic) === 'automated') automated = key;
      else inFlight = key;
    } else if (story) {
      unlinked++;
    }

    for (const c of comps) {
      const r = row(c);
      r.items++;
      if (done) r.done++;
      if (bucket) r.buckets++;
      if (story) r.stories++;
      if (story && !i.parentKey) r.unlinked++;
      for (const k of maintained) { r._maintained.add(k); all.maintained.add(k); }
      if (automated) { r._automated.add(automated); all.automated.add(automated); }
      if (inFlight) { r._inFlight.add(inFlight); all.inFlight.add(inFlight); }
    }
  }

  const out = [...rows.values()]
    .map(r => ({
      component: r.component, items: r.items, done: r.done,
      stories: r.stories, buckets: r.buckets, unlinked: r.unlinked,
      automated: r._automated.size,
      inFlight: r._inFlight.size,
      maintained: r._maintained.size,
      testCases: r._automated.size + r._inFlight.size + r._maintained.size,
    }))
    .sort((a, b) => (b.automated + b.maintained) - (a.automated + a.maintained)
      || b.items - a.items || a.component.localeCompare(b.component));

  return {
    rows: out,
    totals: {
      automated: all.automated.size,
      inFlight: all.inFlight.size,
      maintained: all.maintained.size,
      items: (items || []).length,
      done: (items || []).filter(isDone).length,
      stories: (items || []).filter(i => /^story$/i.test(String(i.issueType || '').trim())).length,
      buckets: (items || []).filter(i => epicsLib.isBucketStory(i)).length,
    },
    // A Story with no parent has no test case behind it, so it is in no column.
    // Counted rather than dropped: a number that is quietly short is worse than
    // one with a stated gap beside it.
    unlinked,
    shared,
  };
}

/* ─────────────────────────── view: backlog ─────────────────────────── */

/**
 * Everything not yet committed to a sprint, per team, grouped so you can see
 * what kind of work is queued and how many sprints of it there is.
 */
function backlogView(plan, snap, { teamId = null } = {}) {
  const rules = plan.categoryRules;
  const teams = teamId ? plan.teams.filter(t => t.id === teamId) : plan.teams;
  const allIssues = snap.issues || {};
  const hydrate = (k) => { const i = allIssues[k]; return i ? { ...i, category: cls.classify(i, rules) } : null; };

  const perTeam = teams.map(team => {
    const idx = (snap.byTeam || {})[team.id];
    const resolve = memberResolver(team);

    // The board's backlog is the source of truth. Without a board mapped we fall
    // back to ownership heuristics, and the view says which one it used.
    const items = (idx && idx.backlog ? idx.backlog.map(hydrate).filter(Boolean)
      : fallbackBacklog(plan, snap, team, rules)).map(i => ({ ...i, memberId: resolve(i) }));

    const mix = cls.mix(items, rules);
    const history = velocityHistory(plan, snap, team);
    const avgVelocity = cap.averageVelocity(history) || null;

    return {
      teamId: team.id,
      teamName: team.name,
      source: (idx && idx.backlogSource) || 'heuristic',
      items,
      totalPoints: mix.totalPoints,
      count: items.length,
      unestimated: items.filter(i => !i.points).length,
      mix,
      sprintsOfWork: avgVelocity ? Math.round(mix.totalPoints / avgVelocity * 10) / 10 : null,
      avgVelocity,
      byComponent: groupBy(items, i => (i.components || [])[0] || '— none —'),
      byPriority: groupBy(items, i => i.priority || '— none —'),
      byStatus: groupBy(items, i => i.status || '— none —'),
    };
  });

  // Open, sprint-less, and on nobody's board: the work that quietly goes missing.
  const claimed = new Set(perTeam.flatMap(t => t.items.map(i => i.key)));
  const unclaimed = Object.values(allIssues)
    .filter(i => !isDone(i) && !(i.sprints || []).length && !(i.sprintNames || []).length && !claimed.has(i.key))
    .map(i => ({ ...i, category: cls.classify(i, rules) }));

  return {
    teams: perTeam,
    unclaimed: { items: unclaimed, count: unclaimed.length, ...cls.mix(unclaimed, rules) },
    unknownSprints: [],
  };
}

/** Ownership guesswork, used only when a team has no Jira board mapped. */
function fallbackBacklog(plan, snap, team, rules) {
  const resolve = memberResolver(team);
  return Object.values(snap.issues || {})
    .filter(i => !isDone(i) && !(i.sprints || []).length && !(i.sprintNames || []).length)
    .filter(i => (team.jiraTeams || []).some(v => norm(v) === norm(i.team))
      || (team.components || []).some(c => (i.components || []).includes(c))
      || Boolean(resolve(i)))
    .map(i => ({ ...i, category: cls.classify(i, rules) }));
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const i of items) {
    const k = keyFn(i);
    if (!map.has(k)) map.set(k, { key: k, count: 0, points: 0 });
    const g = map.get(k); g.count++; g.points += Number(i.points) || 0;
  }
  return [...map.values()].map(g => ({ ...g, points: round1(g.points) })).sort((a, b) => b.points - a.points || b.count - a.count);
}

/* ─────────────────────────── view: active sprint ─────────────────────────── */

function activeSprintView(plan, snap, team, rawSprint, { today = new Date() } = {}) {
  const sprint = reconcile.forTeam(rawSprint, team.id);
  const grid = capacityView(plan, snap, team, sprint);
  const work = workForSprint(plan, snap, team, sprint);
  const items = work.issues;

  const days = sprintDays(sprint);
  const workingDays = days.filter(d => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    return dow !== 0 && dow !== 6 && !(plan.holidays || []).includes(d);
  });
  const todayISO = toISO(today);
  const elapsed = workingDays.filter(d => d <= todayISO).length;
  const timeElapsedPct = workingDays.length ? Math.round(elapsed / workingDays.length * 100) : 0;

  // Sprint scope includes work nobody has picked up yet — leaving it out would
  // understate the commitment and make the burndown look better than it is.
  // Both halves come from the grid, which was built against the PER-SPRINT
  // roster. Taking `committed` from the grid and `done` from a second roll-up
  // built against the base team is how a KPI ends up disagreeing with the table
  // underneath it whenever the two rosters differ.
  const committed = round1(grid.totals.planned + grid.unowned.points);
  const done = round1(grid.totals.actual + grid.unowned.done);
  const donePct = committed ? Math.round(done / committed * 100) : 0;

  const inProgress = items.filter(i => isInProgress(i));
  const notStarted = items.filter(i => !isDone(i) && !isInProgress(i));
  const blocked = items.filter(i => !isDone(i) && (i.blockedBy || []).length);
  const unestimated = items.filter(i => !i.points && !isDone(i));

  // Ideal burndown vs where we actually are — the honest "are we on track" line.
  const burndown = workingDays.map((d, idx) => ({
    date: d,
    ideal: round1(committed * (1 - (idx + 1) / workingDays.length)),
    actual: d <= todayISO ? round1(committed - pointsDoneBy(items, d, todayISO)) : null,
  }));

  const paceGap = timeElapsedPct - donePct;   // positive = behind
  const projected = elapsed > 0 ? round1(done / elapsed * workingDays.length) : null;

  return {
    ...grid,
    sprint,
    window: { days, workingDays: workingDays.length, elapsed, timeElapsedPct, today: todayISO },
    progress: {
      committed, done, donePct, remaining: round1(committed - done),
      inProgress: { count: inProgress.length, points: sumPoints(inProgress) },
      notStarted: { count: notStarted.length, points: sumPoints(notStarted) },
      blocked: { count: blocked.length, points: sumPoints(blocked), items: blocked },
      unestimated: { count: unestimated.length, items: unestimated },
      projected,
      projectedVsCommitted: projected != null ? round1(projected - committed) : null,
      paceGap,
    },
    burndown,
    byComponent: componentProgress(items, plan),
    priorityLevels: priorityLib.LEVELS,
    testCases: testCaseSummary(items, (k) => (snap.issues || {})[k] || null),
    health: sprintHealth({
      timeElapsedPct, donePct, grid, blocked, unestimated,
      unassignedPoints: grid.unassigned.points,
      offRoster: grid.offRoster,
    }),
    items,
  };
}

function pointsDoneBy(items, isoDate, todayISO) {
  return round1(items.reduce((t, i) => {
    if (!isDone(i)) return t;
    // A resolution date in the future (clock skew, a bulk edit, imported data) would
    // otherwise hide finished work from the burndown while the KPI counts it.
    let when = (i.resolved || i.updated || '').slice(0, 10);
    if (todayISO && when > todayISO) when = todayISO;
    return when && when <= isoDate ? t + (Number(i.points) || 0) : t;
  }, 0));
}

/** One RAG verdict, with the reasons spelled out — never a number without a why. */
function sprintHealth({ timeElapsedPct, donePct, grid, blocked, unestimated, unassignedPoints, offRoster = null }) {
  const reasons = [];
  let score = 100;
  const gap = timeElapsedPct - donePct;
  if (gap > 25) { score -= 35; reasons.push({ level: 'risk', text: `${gap} pts of pace gap — ${timeElapsedPct}% of the sprint gone, ${donePct}% of points done` }); }
  else if (gap > 12) { score -= 15; reasons.push({ level: 'warn', text: `Slightly behind pace (${timeElapsedPct}% time vs ${donePct}% done)` }); }

  const over = grid.rows.filter(r => r.flags.some(f => f.code === 'overloaded'));
  if (over.length) { score -= Math.min(25, over.length * 10); reasons.push({ level: 'risk', text: `${over.length} member${over.length > 1 ? 's' : ''} overcommitted: ${over.map(r => r.name).join(', ')}` }); }

  if (blocked.length) { score -= Math.min(20, blocked.length * 5); reasons.push({ level: 'risk', text: `${blocked.length} blocked item${blocked.length > 1 ? 's' : ''} (${sumPoints(blocked)} pts)` }); }
  if (unestimated.length) { score -= Math.min(15, unestimated.length * 3); reasons.push({ level: 'warn', text: `${unestimated.length} committed item${unestimated.length > 1 ? 's' : ''} with no estimate — the commitment number is not trustworthy` }); }
  if (unassignedPoints > 0) { score -= 10; reasons.push({ level: 'warn', text: `${unassignedPoints} pts in the sprint with no assignee` }); }
  // Named, but on nobody the sprint is planned around — a different problem
  // with a different fix, so it says so in different words and names names.
  if (offRoster && offRoster.points > 0) {
    score -= 10;
    const who = offRoster.people.slice(0, 3).map(p => p.name);
    const rest = offRoster.people.length - who.length;
    reasons.push({
      level: 'warn',
      text: `${offRoster.points} pts assigned to ${offRoster.people.length} ${offRoster.people.length === 1 ? 'person' : 'people'} not on this sprint (${who.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}) — add them to the sprint or move the work`,
    });
  }

  const idle = grid.rows.filter(r => r.flags.some(f => f.code === 'unplanned' || f.code === 'underloaded'));
  if (idle.length) { score -= Math.min(15, idle.length * 5); reasons.push({ level: 'warn', text: `${idle.length} member${idle.length > 1 ? 's' : ''} under-loaded: ${idle.map(r => r.name).join(', ')}` }); }

  score = Math.max(0, Math.min(100, score));
  const rag = score >= 75 ? 'green' : score >= 50 ? 'amber' : 'red';
  if (!reasons.length) reasons.push({ level: 'ok', text: 'On pace, balanced load, nothing blocked' });
  return { score, rag, reasons };
}

/* ─────────────────────────── view: forecast ─────────────────────────── */

/**
 * The next N sprints: how much capacity we will actually have (from real leave,
 * not an average), what the backlog demands, and where the two diverge.
 */
function forecastView(plan, snap, team, { fromSprintId = null, horizon = 4, scenario = {} } = {}) {
  const sprints = plan.sprints.slice().sort(reconcile.compareSprints);
  const startIdx = fromSprintId ? Math.max(0, sprints.findIndex(s => s.id === fromSprintId)) : 0;
  const window = sprints.slice(startIdx, startIdx + horizon);

  const history = velocityHistory(plan, snap, team);
  const avgVelocity = cap.averageVelocity(history);
  const pred = cap.predictability(history);
  const settings = cap.teamSettings(team);
  const calibration = cap.calibrateHoursPerPoint(history);

  const backlog = backlogView(plan, snap, { teamId: team.id }).teams[0];
  let carry = 0;                                 // backlog burn-down across the window

  const rows = window.map(raw => {
    const sprint = reconcile.forTeam(raw, team.id);
    const avail = availabilityFor(plan, team, sprint);
    // Scenario levers: add/remove people, change leave, change support load.
    const teamForScenario = applyScenario(teamForSprint(plan, team, sprint), scenario);
    const grid = cap.sprintGrid(teamForScenario, sprint, scenarioAvailability(avail, scenario, sprint), workForSprint(plan, snap, teamForScenario, sprint).byMember);

    const committed = grid.totals.planned;
    const capacityPts = grid.totals.predicted;
    const free = round1(capacityPts - committed);
    const drawn = Math.max(0, Math.min(free, round1(backlog.totalPoints - carry)));
    carry = round1(carry + drawn);

    return {
      sprintId: sprint.id, number: sprint.number, name: sprint.name || sprint.jiraName || `Sprint ${sprint.number}`,
      start: sprint.start, end: sprint.end,
      headcount: grid.totals.headcount,
      availableDays: grid.totals.availableDays,
      capacityHours: grid.totals.capacityHours,
      capacityPoints: capacityPts,
      committedPoints: committed,
      freePoints: free,
      fillFromBacklog: drawn,
      utilisationPct: capacityPts ? Math.round(committed / capacityPts * 100) : 0,
      leaveDays: round1(grid.rows.reduce((t, r) => t + Math.max(0, 10 - r.availableDays), 0)),
      lowestAvailability: grid.rows.filter(r => r.status !== 'Released').sort((a, b) => a.availableDays - b.availableDays).slice(0, 3)
        .map(r => ({ name: r.name, days: r.availableDays })),
      rows: grid.rows,
    };
  });

  const totalCapacity = round1(rows.reduce((t, r) => t + r.capacityPoints, 0));
  const backlogRemaining = round1(backlog.totalPoints - carry);
  const sprintsToClear = avgVelocity ? Math.ceil(backlog.totalPoints / avgVelocity) : null;

  // Maintenance pressure from TestOps: failing suites become next sprint's work.
  const maintenancePressure = testopsPressure(snap, team, avgVelocity);

  return {
    teamId: team.id, teamName: team.name, settings,
    horizon, rows,
    history, avgVelocity, predictability: pred, calibration,
    backlog: { totalPoints: backlog.totalPoints, count: backlog.count, unestimated: backlog.unestimated, mix: backlog.mix },
    supplyVsDemand: {
      capacityPoints: totalCapacity,
      backlogPoints: backlog.totalPoints,
      absorbed: carry,
      remainingAfterHorizon: backlogRemaining,
      sprintsToClear,
      verdict: backlogRemaining > 0
        ? `${backlogRemaining} pts still queued after ${horizon} sprints`
        : `Backlog clears inside the ${horizon}-sprint window`,
    },
    maintenancePressure,
    scenario,
  };
}

function applyScenario(team, scenario) {
  if (!scenario || (!scenario.addMembers && !scenario.removeMemberIds && !scenario.supportPct)) return team;
  let members = (team.members || []).slice();
  if (scenario.removeMemberIds) members = members.filter(m => !scenario.removeMemberIds.includes(m.id));
  if (scenario.supportPct != null) members = members.map(m => ({ ...m, supportPct: scenario.supportPct }));
  for (let i = 0; i < (scenario.addMembers || 0); i++) {
    members.push({ id: `__scenario-${i}`, name: `New Auto QA ${i + 1}`, role: 'Auto QA', status: 'Active', supportPct: scenario.rampSupportPct != null ? scenario.rampSupportPct : 40 });
  }
  return { ...team, members };
}

function scenarioAvailability(avail, scenario, sprint) {
  const out = { ...avail };
  if (scenario && scenario.addMembers) {
    for (let i = 0; i < scenario.addMembers; i++) {
      out[`__scenario-${i}`] = defaultAvailability(sprint, []);
    }
  }
  return out;
}

/** Failing/flaky suites predict maintenance demand the backlog does not show yet. */
function testopsPressure(snap, team, avgVelocity) {
  const projects = (snap.testops && snap.testops.projects) || [];
  const relevant = team.testopsProjectIds && team.testopsProjectIds.length
    ? projects.filter(p => team.testopsProjectIds.includes(p.id))
    : projects;
  if (!relevant.length) return null;

  const failingTests = relevant.reduce((t, p) => t + ((p.summary && p.summary.failingTests) || 0), 0);
  const passRates = relevant.map(p => p.summary && p.summary.passRate).filter(v => v != null);
  const passRate = passRates.length ? round1(passRates.reduce((a, b) => a + b, 0) / passRates.length) : null;
  const flakyRates = relevant.map(p => p.summary && p.summary.flakyRate).filter(v => v != null);
  const flakyRate = flakyRates.length ? round1(flakyRates.reduce((a, b) => a + b, 0) / flakyRates.length) : null;

  // Deliberately crude and stated as such: ~1 point of maintenance per 4 failing
  // tests. Tune `pointsPerFailingTest` per team once you have a sprint of evidence.
  const pointsPerFailingTest = (team.settings && team.settings.pointsPerFailingTest) || 0.25;
  const predictedPoints = round1(failingTests * pointsPerFailingTest);

  return {
    projects: relevant.map(p => ({ id: p.id, name: p.name, passRate: p.summary && p.summary.passRate, failingTests: p.summary && p.summary.failingTests, worstSuites: (p.summary && p.summary.worstSuites || []).slice(0, 5) })),
    passRate, flakyRate, failingTests, predictedPoints, pointsPerFailingTest,
    shareOfVelocity: avgVelocity ? Math.round(predictedPoints / avgVelocity * 100) : null,
    basis: `${failingTests} failing tests across ${relevant.length} TestOps project${relevant.length > 1 ? 's' : ''} × ${pointsPerFailingTest} pts`,
  };
}

/* ─────────────────────────── velocity history ─────────────────────────── */

/**
 * What every sprint in this team's past committed and delivered.
 *
 * TWO THINGS THIS HAS TO GET RIGHT, both of which it used to get wrong:
 *
 *   1. EACH SPRINT IS MEASURED AGAINST THE TEAM IT HAD. It used to use the
 *      member list as it stands today, so a sprint run by six people two years
 *      ago was scored against the two who are here now, and everything the
 *      other four delivered belonged to nobody and vanished.
 *
 *   2. DELIVERED MEANS DELIVERED. The totals are per-member, so work that
 *      landed on nobody on the roster was left out of the sprint's own history
 *      while the sprint screen counted it in the commitment — the same sprint
 *      reading two different ways depending on which screen you opened. It is
 *      added back here, so `planned` and `actual` are the sprint's, not the
 *      current roster's.
 *
 * Together these were hiding 5,046 of Titan's delivered points across 38 closed
 * sprints — velocity, the forecast and the delivery metrics were all running on
 * about a sixth of what the team had actually shipped.
 */
function velocityHistory(plan, snap, team) {
  return plan.sprints.slice().sort(reconcile.compareSprints).map(raw => {
    const sprint = reconcile.forTeam(raw, team.id);
    const { rawIssues, team: t } = sprintRoster(plan, snap, team, sprint);
    const avail = availabilityFor(plan, t, sprint);
    const work = workForSprint(plan, snap, t, sprint, rawIssues);
    const grid = cap.sprintGrid(t, sprint, avail, work.byMember);
    return {
      sprintId: sprint.id, number: sprint.number, name: sprint.name || sprint.jiraName || `Sprint ${sprint.number}`,
      start: sprint.start, end: sprint.end,
      headcount: grid.totals.headcount,
      capacityHours: grid.totals.capacityHours,
      predicted: grid.totals.predicted,
      planned: round1(grid.totals.planned + work.unowned.planned),
      actual: round1(grid.totals.actual + work.unowned.actual),
      // The per-member figures as well, because the capacity screens compare
      // delivery against the capacity of the people on the roster, and mixing
      // in work by people who are not on it would make that ratio meaningless.
      memberPlanned: grid.totals.planned,
      memberActual: grid.totals.actual,
      unownedPlanned: round1(work.unowned.planned),
      unownedActual: round1(work.unowned.actual),
      goalPct: grid.totals.goalPct,
    };
  });
}

/* ─────────────────────────── risks ─────────────────────────── */

/**
 * Auto-detected risk signals + the manual register. Each signal says what it saw,
 * why it matters and what to do — a risk you cannot act on is just a number.
 */
function riskView(plan, snap, { teamId = null, sprintId = null, today = new Date() } = {}) {
  const teams = teamId ? plan.teams.filter(t => t.id === teamId) : plan.teams;
  const signals = [];

  for (const team of teams) {
    const sprints = plan.sprints.slice().sort(reconcile.compareSprints);
    const current = sprintId ? sprints.find(s => s.id === sprintId) : currentSprint(sprints, today) || sprints[sprints.length - 1];
    if (!current) continue;

    const view = activeSprintView(plan, snap, team, current, { today });
    const history = view.history;

    const add = (o) => signals.push({ teamId: team.id, teamName: team.name, sprintId: current.id, ...o });

    // 1. Overcommitment
    for (const r of view.rows.filter(r => r.flags.some(f => f.code === 'overloaded'))) {
      add({
        id: `over-${team.id}-${r.memberId}`, severity: r.workloadPct > 140 ? 'high' : 'medium', category: 'Capacity',
        title: `${r.name} is loaded to ${r.workloadPct}%`,
        detail: `${r.planned} pts committed against ${r.predicted} pts of capacity (${r.capacityHours}h, ${r.availableDays} days available).`,
        action: `Move ~${Math.max(1, Math.round(r.planned - r.predicted))} pts to someone with slack, or drop scope.`,
      });
    }

    // 2. Slack that nobody has noticed
    const idle = view.rows.filter(r => r.flags.some(f => f.code === 'unplanned'));
    if (idle.length) add({
      id: `idle-${team.id}`, severity: 'medium', category: 'Capacity',
      title: `${idle.length} member${idle.length > 1 ? 's have' : ' has'} nothing assigned`,
      detail: idle.map(r => `${r.name} (${r.predicted} pts of capacity)`).join(', '),
      action: 'Pull from the backlog now, before the sprint is half gone.',
    });

    // 3. Key-person concentration per component (bus factor)
    for (const c of busFactor(view.items)) add({
      id: `bus-${team.id}-${c.component}`, severity: c.share >= 90 ? 'high' : 'medium', category: 'Knowledge',
      title: `${c.component} depends on ${c.owner} alone`,
      detail: `${c.share}% of this sprint's ${c.component} points (${c.points} pts) sit with one person.`,
      action: 'Pair or rotate one item to build a second owner.',
    });

    // 4. Unestimated commitments
    if (view.progress.unestimated.count) add({
      id: `unest-${team.id}`, severity: 'medium', category: 'Planning',
      title: `${view.progress.unestimated.count} committed items have no estimate`,
      detail: view.progress.unestimated.items.slice(0, 6).map(i => i.key).join(', '),
      action: 'Estimate them or the capacity number is fiction.',
    });

    // 5. Blocked work
    if (view.progress.blocked.count) add({
      id: `blocked-${team.id}`, severity: 'high', category: 'Delivery',
      title: `${view.progress.blocked.count} items blocked (${view.progress.blocked.points} pts)`,
      detail: view.progress.blocked.items.slice(0, 6).map(i => `${i.key} ← ${(i.blockedBy || []).join(', ')}`).join('; '),
      action: 'Escalate the blockers today; these will become carryover.',
    });

    // 6. Pace
    if (view.progress.paceGap > 25) add({
      id: `pace-${team.id}`, severity: 'high', category: 'Delivery',
      title: `Behind pace by ${view.progress.paceGap} points of percentage`,
      detail: `${view.window.timeElapsedPct}% of the sprint elapsed, ${view.progress.donePct}% of points done. Projected landing: ${view.progress.projected ?? '—'} of ${view.progress.committed} pts.`,
      action: 'Re-negotiate scope at the next standup rather than at review.',
    });

    // 7. Work-mix drift
    for (const t of view.mixVsTarget.filter(t => t.status !== 'ok' && t.share > 0)) add({
      id: `mix-${team.id}-${t.category}`, severity: t.category === 'maintenance' && t.status === 'over' ? 'medium' : 'low', category: 'Work mix',
      title: `${cls.CATEGORIES[t.category].label} is ${t.share}% of the sprint (target ${t.min}–${t.max}%)`,
      detail: t.status === 'over' ? 'More of the sprint than intended is going here.' : 'Less than intended is going here.',
      action: t.category === 'maintenance' && t.status === 'over' ? 'Check whether framework debt is driving this — it compounds.' : 'Rebalance next sprint’s selection.',
    });

    // 8. Carryover trend
    const carry = carryoverTrend(history);
    if (carry && carry.avgMissPct > 20) add({
      id: `carry-${team.id}`, severity: 'medium', category: 'Predictability',
      title: `Averaging ${carry.avgMissPct}% short of commitment over ${carry.sprints} sprints`,
      detail: `Planned ${carry.planned} pts, delivered ${carry.actual} pts.`,
      action: `Plan to ${Math.round(carry.deliveredRatio * 100)}% of capacity until the gap closes.`,
    });

    // 9. Calibration drift — the 2.9 h/pt constant no longer matching reality
    const calib = cap.calibrateHoursPerPoint(history);
    const s = cap.teamSettings(team);
    if (calib && Math.abs(calib.value - s.hoursPerPoint) / s.hoursPerPoint > 0.15) add({
      id: `calib-${team.id}`, severity: 'low', category: 'Planning',
      title: `Hours-per-point is really ${calib.value}h, not ${s.hoursPerPoint}h`,
      detail: `${calib.basis} over ${calib.sprints} sprints. Every capacity number here is scaled by this constant.`,
      action: `Update the team setting to ${calib.value} so predicted velocity stops lying.`,
    });

    // 10. Execution health feeding maintenance load
    const pressure = testopsPressure(snap, team, cap.averageVelocity(history));
    if (pressure && pressure.passRate != null && pressure.passRate < 80) add({
      id: `exec-${team.id}`, severity: pressure.passRate < 60 ? 'high' : 'medium', category: 'Execution health',
      title: `TestOps pass rate ${pressure.passRate}% — ~${pressure.predictedPoints} pts of maintenance incoming`,
      detail: `${pressure.basis}. Worst: ${(pressure.projects[0] && pressure.projects[0].worstSuites || []).slice(0, 3).map(s => `${s.name} (${s.passRate}%)`).join(', ')}`,
      action: `Reserve ${pressure.shareOfVelocity ?? '~'}% of next sprint for maintenance instead of discovering it mid-sprint.`,
    });

    // 11. Released members still holding work
    for (const r of view.rows.filter(r => r.status === 'Released' && r.planned > 0)) add({
      id: `released-${team.id}-${r.memberId}`, severity: 'high', category: 'Capacity',
      title: `${r.name} has left but still holds ${r.planned} pts`,
      detail: 'Work assigned to a released member will not move.',
      action: 'Reassign before the sprint starts.',
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  signals.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    signals,
    manual: (plan.risks || []).slice().sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3)),
    counts: {
      high: signals.filter(s => s.severity === 'high').length,
      medium: signals.filter(s => s.severity === 'medium').length,
      low: signals.filter(s => s.severity === 'low').length,
    },
  };
}

function busFactor(items) {
  const byComponent = new Map();
  for (const i of items) {
    const c = (i.components || [])[0]; if (!c) continue;
    if (!byComponent.has(c)) byComponent.set(c, new Map());
    const owners = byComponent.get(c);
    const who = i.assignee || 'Unassigned';
    owners.set(who, (owners.get(who) || 0) + (Number(i.points) || 0));
  }
  const out = [];
  for (const [component, owners] of byComponent) {
    const total = [...owners.values()].reduce((a, b) => a + b, 0);
    if (total < 5) continue;                              // too small to matter
    const [owner, points] = [...owners.entries()].sort((a, b) => b[1] - a[1])[0];
    if (owner === 'Unassigned') continue;
    const share = Math.round(points / total * 100);
    if (share >= 80 && owners.size >= 1) out.push({ component, owner, points: round1(points), share });
  }
  return out.sort((a, b) => b.points - a.points).slice(0, 4);
}

function carryoverTrend(history) {
  const done = history.filter(h => h.planned > 0 && h.actual > 0);
  if (done.length < 3) return null;
  const planned = round1(done.reduce((t, h) => t + h.planned, 0));
  const actual = round1(done.reduce((t, h) => t + h.actual, 0));
  return { sprints: done.length, planned, actual, deliveredRatio: actual / planned, avgMissPct: Math.round((1 - actual / planned) * 100) };
}

function currentSprint(sprints, today = new Date(), teamId = null) {
  if (teamId) {
    const active = sprints.find(s => s.byTeam && s.byTeam[teamId] && s.byTeam[teamId].state === 'active');
    if (active) return active;
  }
  const anyActive = sprints.find(s => s.byTeam && Object.values(s.byTeam).some(t => t.state === 'active'));
  if (anyActive) return anyActive;
  const iso = toISO(today);
  return sprints.find(s => {
    const t = teamId && s.byTeam && s.byTeam[teamId];
    const start = (t && t.start) || s.start, end = (t && t.end) || s.end;
    return start && end && start <= iso && iso <= end;
  }) || null;
}

/* ─────────────────────────── misc ─────────────────────────── */

function sumPoints(items) { return round1((items || []).reduce((t, i) => t + (Number(i.points) || 0), 0)); }
function round1(n) { return Math.round(n * 10) / 10; }
function toISO(d) { return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10); }

module.exports = {
  sprintMatcher, memberResolver, workForSprint, issuesForSprint, availabilityFor, defaultAvailability, sprintDays,
  capacityView, backlogView, sprintIssueKeys, activeSprintView, forecastView, riskView, teamForSprint,
  velocityHistory, currentSprint, sprintHealth, testopsPressure, busFactor, isDone, isInProgress,
  componentProgress, testCaseSummary,
};
