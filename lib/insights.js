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
const carryLib = require('./carryover');
const lock = require('./lock');
// For `productComponents`: the tool markers (TrueTest, Katalon) are carried on
// issues as components but are not product areas, and the coverage report
// already knows the difference. One definition of "component", not two.
const coverageLib = require('./coverage');
const priorityLib = require('./priority');
// The week-snap and the derived end date live in one module, shared with the
// projection that normalises every sprint's dates — the grid here and the dates
// on the screen have to come from the same rule or they will disagree.
const sprintDates = require('./sprint-dates');
const keywordsLib = require('./keywords');
const backlogLib = require('./backlog-item');
const snapToWeeks = sprintDates.snapToWeeks;

/* ─────────────────────────── matching helpers ─────────────────────────── */

/** Does this issue belong to this team's sprint? Matches Jira's namespaced names. */
function sprintMatcher(team, sprint) {
  const keywords = keywordsLib.forTeam(team).map(k => k.toLowerCase());
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

/* WHAT "BLOCKED" MEANS ON THIS BOARD.
 *
 * TWO SIGNALS, EITHER OF WHICH IS ENOUGH — because the board records the same
 * fact in two places depending on who noticed it:
 *
 *   THE REFINEMENT COLUMN. Where work waits on somebody else. This was the
 *   whole definition for a long time, for a good reason: Jira's "is blocked
 *   by" link is empty on every Story in this project — the block is recorded
 *   one level up, on the EPIC — so counting those links counted almost
 *   nothing, and TT Week 14Sep read "0 blocked" while sixteen Stories sat in
 *   Refinement, ten of them held by the same ticket.
 *
 *   AUTOMATION STATUS = BLOCKED. The field the automation team sets when a
 *   suite cannot be automated yet. It is not redundant with the column: 226
 *   open items carry it and only 131 of those are also in Refinement, so
 *   counting the column alone missed 95 pieces of work that somebody had
 *   explicitly marked as stuck. An item can be in any workflow column — Open,
 *   In Dev — and still be blocked for automation, which is precisely the
 *   thing this tool is for.
 *
 * NEITHER SUBSUMES THE OTHER, which is why it is a union rather than a
 * choice. The column is the process saying "waiting"; the field is a person
 * saying "cannot". A screen that reported only one of them would be right
 * about part of the board and quietly wrong about the rest.
 *
 * ── AND NOT JIRA'S OWN "IS BLOCKED BY" LINK, deliberately ────────────────
 *
 * Two reasons, and the second is the one that settled it.
 *
 * It is nearly always empty: SEVEN of the 5,418 non-epic issues in this store
 * carry one. That emptiness is why the Refinement rule exists at all — and it
 * is why the Backlog page, which counted ONLY this link, reported "0 blocked"
 * for every team while 32 of Ruby's queue and 195 of Titan's sat in
 * Refinement, with `ready to plan` inflated by the same gap and the runway
 * forecast built on top of it.
 *
 * But where it IS set, it is set on the EPIC, and `epics.blockersFor` already
 * reads it — that is how each blocked Story learns which ticket is holding
 * it. Counting the epic here as well would represent one fact twice: the epic
 * would appear as a blocked item ALONGSIDE the five stories whose block it is
 * the explanation of. So the link is used, once, at the level it is recorded,
 * and this predicate answers the different question of whether a given piece
 * of work can be picked up.
 *
 * WHAT EACH ITEM IS WAITING FOR is still a separate question, answered by
 * `epics.blockersFor` and the drawer behind the number — and often the answer
 * is "nothing recorded", which is itself worth seeing rather than filtering
 * away.
 *
 * ONE DEFINITION, FIVE READERS. The Backlog KPI, the Active Sprint progress
 * figure, the health score, the risk signal, the per-component "n blocked"
 * tag and the Blockers screen all read this predicate, because the moment two
 * of them compute it separately is the moment the screen contradicts itself.
 * Widening it here moves all of them together, which is the point: the
 * alternative — widening it on the two screens that asked — is how a Backlog
 * page comes to say 195 beside a Blockers page saying 193.
 *
 * DONE WORK IS NEVER BLOCKED, whichever signal fired. A finished item in a
 * Refinement-named column is a workflow quirk, and an Automated suite whose
 * automation status was never moved off Blocked is stale data, not work being
 * held up — twelve of those are in the store right now.
 */
const REFINEMENT = /^refinement$/i;
const AUTOMATION_BLOCKED = /^blocked$/i;
const isBlocked = (i) => !isDone(i) && (
  REFINEMENT.test(String((i && i.status) || '').trim())
  || AUTOMATION_BLOCKED.test(String((i && i.automationStatus) || '').trim()));

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
      // The set travels with the count, so the drawer behind the number lists
      // exactly what the number counted rather than walking the links again.
      out.maintainsLinks = out.bucket ? epicsLib.maintainedLinks(out) : null;
      out.maintains = out.bucket ? out.maintainsLinks.length : null;
      /* WHAT IS HOLDING THIS UP IS RECORDED ON THE EPIC, NOT ON THE STORY.
         In TT Week 14Sep every one of the sixteen Stories sitting in
         Refinement has an empty "is blocked by" of its own, while ten of their
         parent epics name a blocker — and all ten name the SAME one. Read the
         Story and the sprint looks merely slow; read its epic and there is a
         single ticket to chase.

         THE WALK ITSELF LIVES IN `epics.blockersFor`, because the Blockers
         screen asks the same question of a team's whole board and a second
         walk is a second definition. `out.epics` is handed in rather than
         resolved again — `epicsFor` has just run, and asking it twice is how
         two screens come to disagree about which epic a row belongs to. */
      out.epicBlockers = epicsLib.blockersFor(out, lookup, out.epics);
      return out;
    });

  /* WHERE THE LOAD CAME FROM, not just how much of it there is.
     A story carried in from an earlier sprint is charged at full points like
     any other — it is work that still has to be done — but a person who
     committed to their capacity, delivered most of it and carried the rest is
     not the same as a person who took on too much, and `planned` alone cannot
     tell those apart. The index is built ONCE here rather than per item: it
     walks the whole plan, and doing that inside the loop is the difference
     between a lookup and a scan on every ticket. */
  const carryIndex = carryLib.teamSprintIndex(plan, team);
  const sprintStart = carryLib.startOf(sprint, team.id);

  const byMember = {};
  for (const m of team.members || []) byMember[m.id] = { planned: 0, actual: 0, carriedIn: 0, carriedInItems: [], items: [] };

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
  const unowned = { planned: 0, actual: 0, carriedIn: 0, carriedInItems: [], items: [] };
  const unassigned = { planned: 0, actual: 0, carriedIn: 0, carriedInItems: [], items: [] };
  const offRoster = { planned: 0, actual: 0, carriedIn: 0, carriedInItems: [], items: [], people: [] };
  const byPerson = new Map();

  for (const i of issues) {
    const pts = Number(i.points) || 0;
    const done = isDone(i);
    const mine = i.memberId && byMember[i.memberId];
    /* MARKED ON THE ITEM, so every screen downstream reads one answer. The
       drawer behind the number lists these, and a second walk to decide what
       to list is how a count and its list come to disagree. */
    i.carriedIn = sprintStart ? carryLib.isCarriedIn(i, carryIndex, sprintStart) : false;
    i.carriedFrom = i.carriedIn ? (carryLib.priorSprints(i, carryIndex, sprintStart)[0] || null) : null;
    const add = (b) => {
      b.planned += pts; if (done) b.actual += pts; b.items.push(i);
      if (i.carriedIn) { b.carriedIn += pts; b.carriedInItems.push(i); }
    };

    if (mine) { add(byMember[i.memberId]); continue; }

    add(unowned);
    if (!i.assignee && !i.assigneeId) { add(unassigned); continue; }

    add(offRoster);
    // Grouped by person, so a screen can say who rather than how many.
    const key = i.assigneeId || norm(i.assignee);
    if (!byPerson.has(key)) {
      byPerson.set(key, { key, name: i.assignee || i.assigneeId, accountId: i.assigneeId || null, planned: 0, actual: 0, count: 0, keys: [] });
    }
    const p = byPerson.get(key);
    p.planned += pts;
    if (done) p.actual += pts;
    p.count++;
    // The keys travel with the count so a drawer can list exactly what it counted.
    p.keys.push(i.key);
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
function teamForSprint(plan, team, sprint, roster = null, state = null) {
  const base = roster ? roster.members : (team.members || []);
  const closed = String(state || '').toLowerCase() === 'closed';
  const members = base.map(m => {
    // Through rosterLib.lookup, not a direct key: a member's capacity data can
    // be filed under an older id than the one they carry now.
    const override = rosterLib.lookup(plan.support, team.id, sprint.id, m);
    const out = override == null ? m : { ...m, supportPct: Number(override) || 0 };
    /* CALC EXEMPT — on the roster, out of the capacity arithmetic.
       Per sprint, like every other per-person planning decision on this
       screen: someone lent to another project this fortnight is exempt this
       fortnight, and a lead who never counts is better expressed by leaving
       the roster than by a flag that has to be reset every sprint. */
    const exempt = rosterLib.lookup(plan.calcExempt, team.id, sprint.id, m);
    if (exempt) return { ...out, calcExempt: true };

    /* A CLOSED SPRINT'S OFF-TEAM ROW CARRIES NO CAPACITY — unless somebody
       typed one.
     *
     * `roster.forSprint` deliberately keeps everyone Jira assigned work to in a
     * closed sprint, and that is right: they did the work, so their points are
     * the team's points. But a row is two different claims at once, and only
     * one of them is evidenced. The POINTS are a fact — a ticket with their
     * name on it. The CAPACITY is not: nobody entered a leave grid for a
     * contractor who touched one ticket, so `availabilityFor` hands them the
     * DEFAULT — ten working days, 61 hours, 21 predicted points — and the
     * sprint is measured against a fortnight they never gave it.
     *
     * Measured on his store: 412 such rows across 110 closed sprints,
     * contributing 24,258 capacity hours and 8,353 predicted points. 406 of
     * the 412 had no leave grid at all. The median closed sprint drew 62.6% of
     * its capacity from them; Titan Sprints 1-7 drew 100%, so their workload
     * percentages were computed entirely against people who were not there.
     *
     * The exemption is the capacity half ONLY. `sprintGrid` already draws that
     * line for released and hand-exempted members — hours out, tickets in —
     * and it has to hold here, because taking the points too is the 5,046-point
     * bug documented in `roster.forSprint`, re-opened from the other end.
     *
     * AND ONLY WHERE NOBODY DECIDED OTHERWISE. A leave grid, a support
     * percentage or an override entered against this person in this sprint is
     * someone saying they were on it — a decision, which beats a derivation
     * everywhere else in this tool and beats one here. Six of his 412 rows are
     * exactly that, and they keep their hours.
     *
     * Closed only. On a sprint still being planned, an off-team assignee is a
     * person whose capacity you are actively deciding about, and the
     * hand-exempt checkbox is enabled to decide it. On a closed one that
     * checkbox is locked, so this rule is the only thing that can be right. */
    if (closed && (m.notOnTeamList || m.historic)
      && !rosterLib.hasCapacityData(plan, team.id, sprint.id, m)) {
      return { ...out, calcExempt: true, autoExempt: true };
    }
    return out;
  });
  const ceremony = (plan.ceremony || {})[`${team.id}|${sprint.id}`];
  const settings = ceremony == null ? team.settings : { ...(team.settings || {}), ceremonyHours: Number(ceremony) };
  return { ...team, members, settings };
}

function availabilityFor(plan, team, sprint) {
  const out = {};
  for (const m of team.members || []) {
    const row = rosterLib.lookup(plan.availability, team.id, sprint.id, m);
    out[m.id] = row ? fitRow(row, sprint, plan.holidays) : defaultAvailability(sprint, plan.holidays);
  }
  return out;
}

/**
 * A stored row, made the same length as the day grid.
 *
 * Rows were saved against whatever length the sprint's raw Jira span gave at
 * the time. Once `snapToWeeks` settles that span, a row saved earlier can be a
 * cell longer or shorter than the grid — and a row longer than the grid is a
 * fifteenth day of availability being summed into a fourteen-day sprint, which
 * is the 11-vs-10 bug wearing a different hat. Cells are positional from the
 * start date, which does not move, so the tail is the only part in question:
 * extra cells are dropped, missing ones take that day's default.
 */
function fitRow(row, sprint, holidays = []) {
  const want = defaultAvailability(sprint, holidays);
  if (!Array.isArray(row) || row.length === want.length) return row;
  return want.map((fallback, i) => (i < row.length ? row[i] : fallback));
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
      n = snapToWeeks(Math.min(31, Math.max(1, days)));   // a sane band: a sprint is not a year
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
  // ONE state, read once and handed to both. `forSprint` uses it to decide
  // whether exclusions apply; `teamForSprint` uses it to decide whether an
  // off-team row carries capacity. Reading it twice is two chances to disagree
  // about whether this sprint is over.
  const state = lock.stateFor(sprint, baseTeam.id);
  const rawIssues = issuesForSprint(snap, baseTeam, sprint);
  const roster = rosterLib.forSprint(plan, baseTeam, sprint, rawIssues, state);
  return { rawIssues, roster, state, team: teamForSprint(plan, baseTeam, sprint, roster, state) };
}

function capacityView(plan, snap, baseTeam, rawSprint, { today = null } = {}) {
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
      // Exempted by the rule above rather than by a checkbox somebody ticked.
      // Said out loud, because a row whose hours read 0 with nothing explaining
      // it is indistinguishable from a bug — and on a closed sprint the
      // checkbox is disabled, so there is no tick for the user to recognise.
      autoExempt: !!m.autoExempt,
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
    carriedIn: round1(b.carriedIn || 0),
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
  /* TODAY, FROM THE PAYLOAD RATHER THAN THE BROWSER'S CLOCK. The item table
     marks a due date that has passed, and "passed" needs a date: read from
     `new Date()` in the view it would change overnight with nothing else
     changing, and could not be checked without freezing time. The Active
     sprint screen already sends its own as `window.today`; this is the same
     fact for the screen that shares that table. `today` is injectable for the
     same reason it is on `activeSprintView` — a test cannot pin the wall
     clock. */
  grid.today = toISO(today ? new Date(today) : new Date());
  grid.sprintEnd = sprint.end || null;
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
      if (!rows.has(c)) rows.set(c, { component: c, count: 0, points: 0, done: 0, unestimated: 0, blocked: 0, keys: [], doneKeys: [] });
      const r = rows.get(c);
      r.count++;
      /* THE KEYS TRAVEL WITH THE COUNT, the same rule every other number in
         this app follows. The component name on screen is a link to these
         issues in Jira, and the only honest way to open "the eleven items this
         row counted" is to hand Jira the eleven keys — a JQL written from the
         component and the sprint is a SECOND query, and the day it returns ten
         nobody can tell which of the two is wrong. It also sidesteps the "— no
         component —" row, which has no name to put in a JQL at all. */
      r.keys.push(i.key);
      r.points += pts;
      /* AND THE DONE COLUMN GETS ITS OWN LIST, by the same rule. It is a
         POINTS figure, so its set is not `keys` — it is the finished subset of
         them, and working that out in the browser would be the second count
         the comment above exists to forbid: the day `isDone` changes, the
         number and the list it opens would disagree and nothing would say
         which was right. */
      if (done) { r.done += pts; r.doneKeys.push(i.key); }
      if (!i.points && !done) r.unestimated++;
      if (isBlocked(i)) r.blocked++;
    }
  }
  return {
    /* ORDERED AS HE READS THE SCREEN: P1 → P4, then the components he has not
       prioritised. The sort below still runs — biggest commitment first — and
       `byPriority` is stable, so that becomes the tie-break INSIDE each level
       rather than being replaced by it.

       THE SAME HELPER THE TEST-CASE TABLES USE. Three tables on this page rank
       this way now, and a comparator written out three times is three chances
       for one of them to put the unprioritised rows first. */
    rows: priorityLib.byPriority(priorityLib.decorate([...rows.values()]
      .map(r => ({
        ...r,
        points: round1(r.points),
        done: round1(r.done),
        remaining: round1(r.points - r.done),
        donePct: r.points ? Math.round(r.done / r.points * 100) : 0,
      }))
      .sort((a, b) => b.points - a.points || b.count - a.count || a.component.localeCompare(b.component)), plan)),
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
 *   MAINTAINING each "relates to" link on it is one suite being kept working.
 *               So the count is the LINKS, which is the convention he gave when
 *               the Test cases column was built.
 *
 *               Those links are SPLIT by the state of the thing linked, because
 *               "we touched 40 suites this fortnight" does not say how many are
 *               back to green. The linked epic's own Automation Status decides:
 *               Automated is MAINTAINED, the suite is working again; Maintenance
 *               is MAINTAINING, still being fixed. Same classifier as the
 *               Automated column and as the Coverage report, so "automated"
 *               means one thing in this tool and Jira's "Done" alias folds in.
 *
 *               THE TWO DO NOT ADD UP TO THE LINKS, and must not be made to. A
 *               link can point at an epic that is Ready for Automation, Blocked,
 *               N/A, or carries no status at all — 118 of them across his store
 *               when this was built. Those are in neither column and are counted
 *               separately as `unclassified`, so the screen can say so. Folding
 *               them into either side would report a suite as fixed, or as being
 *               fixed, on the strength of a field nobody set.
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
  /* WHAT EACH NUMBER IS MADE OF, carried alongside the number.
     Every count on this table is the size of a set, and the set is the only
     honest answer to "which ones?" — recomputing it on the screen would mean a
     second implementation of "distinct parent epics of Stories whose epic reads
     automated", and the two would part company the first time either changed.
     So the sets travel, and the screen only has to list them.

     `catalogue` is what makes them displayable: a row's keys point at epics and
     at linked test cases, and NEITHER is in the sprint's item list. A key with
     nothing behind it is still listed — as itself, linked to Jira — because a
     test case this tool cannot see locally is a real answer, and quietly
     dropping it would make the list shorter than the number above it. */
  const catalogue = new Map();
  /* WHY EACH BLOCKED TEST CASE IS BLOCKED, keyed by the test case.
     The Blocked number is the size of this map's key set, so the reason and
     the count cannot disagree: a test case with no entry here is not counted,
     and one that is counted always has something to show. Several items can
     hold the same suite — two people refining two halves of one test case —
     so the value is a list rather than a single holder. */
  const blockedReasons = new Map();
  const because = (key, item) => {
    const k = String(key).trim().toUpperCase();
    if (!k) return;
    if (!blockedReasons.has(k)) blockedReasons.set(k, []);
    const list = blockedReasons.get(k);
    if (list.some(h => h.item === item.key)) return;
    /* WHAT THE HOLDING ITEM IS ITSELF WAITING ON, taken from the epic — the
       same `epicBlockers` the Blocked KPI's drawer reads, resolved once in
       `activeSprintView` and passed through rather than walked again here.
       Often it is empty, and that is the finding: an item in Refinement with
       nothing linked is unrefined, not blocked by another ticket, and those
       are two different conversations with two different people. */
    const seen = new Set();
    const waitingOn = [];
    for (const g of item.epicBlockers || []) {
      for (const b of g.blockers || []) {
        const bk = String((b && typeof b === 'object' ? b.key : b) || '').trim().toUpperCase();
        if (!bk || seen.has(bk)) continue;
        seen.add(bk);
        waitingOn.push({ key: bk, summary: (b && b.summary) || null, epic: g.epic || null });
      }
    }
    list.push({
      item: item.key,
      summary: item.summary || '',
      status: item.status || '',
      type: item.issueType || '',
      assignee: item.assignee || null,
      waitingOn,
    });
  };
  const note = (key, issue, kind) => {
    const k = String(key).trim().toUpperCase();
    if (!k || catalogue.has(k)) return;
    /* THE AUTOMATION STATUS, THE LABELS AND THE BLOCKERS TRAVEL WITH THE
       ENTRY. All three are facts about the issue that a drawer listing it may
       need to explain itself — "in flight but Blocked", "in flight but
       retired", "blocked by this defect" — and a catalogue carrying only the
       Jira workflow status left every drawer able to name the epic and unable
       to say anything about it.

       `blockedBy` IS NOT OPTIONAL HERE, and leaving it out was not a missing
       feature but a FALSE STATEMENT. The drawer's note reads "nothing is
       linked in Jira, so there is no ticket to chase" when the row carries no
       blockers — and a row that was never given any looks exactly like a row
       that has none. AUTOKAT-10663 is blocked by CLICMNTIGO-11567 in Jira and
       the panel said there was nothing to chase. A field a reader's conclusion
       depends on has to travel with the row, or the row states the absence of
       what it was simply not told. */
    catalogue.set(k, issue
      ? {
        key: k, summary: issue.summary || '', status: issue.status || '',
        statusCategory: issue.statusCategory || '', type: issue.issueType || '', kind,
        automationStatus: issue.automationStatus || '',
        labels: (issue.labels || []).filter(Boolean),
        blockedBy: (issue.blockedBy || []).filter(Boolean),
      }
      : {
        key: k, summary: '', status: '', statusCategory: '', type: '', kind,
        automationStatus: '', labels: [], blockedBy: [], absent: true,
      });
  };
  // The sprint-wide sets. Kept separately because an item in two components is
  // in two rows, so adding the rows up would report the same test case twice —
  // the same trap the coverage grid documents, and a total is exactly where
  // nobody would notice it.
  const all = {
    automated: new Set(), inFlight: new Set(),
    maintained: new Set(), maintaining: new Set(), unclassified: new Set(),
    blocked: new Set(), attention: new Set(),
  };
  let unlinked = 0, shared = 0;
  /* WHY EACH FLAGGED EPIC IS FLAGGED, keyed by epic. Collected once here
     rather than per row, because an epic in two components is the same epic
     with the same reason — and a per-row copy is two places for the answer to
     drift. Same arrangement as `blockedReasons` below. */
  const attentionWhy = new Map();

  const row = (c) => {
    if (!rows.has(c)) {
      rows.set(c, {
        component: c, items: 0, done: 0, stories: 0, buckets: 0, unlinked: 0,
        _automated: new Set(), _inFlight: new Set(),
        _maintained: new Set(), _maintaining: new Set(), _unclassified: new Set(),
        _blocked: new Set(), _attention: new Set(),
        _items: [], _done: [], _stories: [], _buckets: [],
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
    // component row it lands in, then split by the state of the thing linked.
    const links = bucket
      ? [...new Set((i.relatesTo || []).map(l => (l && typeof l === 'object' ? l.key : l)).filter(Boolean).map(k => String(k).trim().toUpperCase()))]
      : [];
    const maintained = [], maintaining = [], unclassified = [];
    for (const k of links) {
      const linked = lookup(k);
      note(k, linked, 'test case');
      /* The link target is the test case. Its OWN Automation Status says
         whether the suite is working again or still being fixed — the bucket
         story is the fortnight's container and says nothing about either.
         A target this tool cannot see locally has no status to read, so it
         lands in `unclassified` with the genuinely untriaged ones rather than
         being guessed into a column. */
      const state = linked ? coverageLib.bucketOf(linked) : null;
      if (state === 'automated') maintained.push(k);
      else if (state === 'maintenance') maintaining.push(k);
      else unclassified.push(k);
    }
    let automated = null, inFlight = null, attention = null;
    if (story && i.parentKey) {
      const epic = lookup(i.parentKey);
      const key = String(i.parentKey).trim().toUpperCase();
      // The SAME classifier the Coverage report uses, so "automated" means one
      // thing in this tool. It also folds in Jira's "Done" alias, which a
      // hand-written equality check on the string would miss.
      note(key, epic, 'epic');
      if (epic && coverageLib.bucketOf(epic) === 'automated') automated = key;
      else inFlight = key;

      /* IN FLIGHT, BUT NOT ACTUALLY GOING ANYWHERE.
         "In flight" means only "not Automated yet", which quietly lumps three
         different situations together: work genuinely in progress, work whose
         Automation Status reads Blocked, and suites somebody retired with an
         `obsolete` label. The last two are not in flight in any useful sense —
         on his board one component's four in-flight epics include two that are
         both Blocked and obsolete — and a count that treats them as ordinary
         progress overstates what the sprint is moving.

         BOTH TESTS, NOT `bucketOf` ALONE. An epic labelled obsolete that kept
         a real Automation Status comes back in THAT status by design, so
         `bucketOf` says "blocked" for an epic that is also retired and never
         says "obsoleted" for it at all. Asking both questions is the only way
         to get both answers, and the drawer shows both. */
      if (inFlight && epic) {
        const why = [];
        if (coverageLib.bucketOf(epic) === 'blocked') why.push('blocked');
        if (coverageLib.isObsolete(epic)) why.push('obsolete');
        if (why.length) {
          attention = { key, why };
          /* The epic's OWN words, so the drawer quotes Jira rather than
             paraphrasing it: "Automation Status is Blocked" is checkable
             against the ticket, "this is blocked" is not. */
          attentionWhy.set(key, {
            why,
            automationStatus: epic.automationStatus || '',
            labels: (epic.labels || []).filter(Boolean),
          });
        }
      }
    } else if (story) {
      unlinked++;
    }

    /* HELD UP BY THE ITEM THAT WOULD MOVE THEM.
       A peer of the columns beside it, not a new idea: every number on this
       table is a count of TEST CASES, resolved the same way — a Story speaks
       for its parent epic, a Bucket Story for the suites it relates to — and
       this one counts that same set, restricted to the items still sitting in
       Refinement. So "3 blocked" means three test cases nobody can move,
       directly comparable with the automated and maintained counts next to it.

       Resolved from the keys ALREADY worked out above rather than by walking
       the links a second time: a second walk is a second definition of "the
       epics behind this item", and the day the two disagree is the day this
       row's Blocked count stops being a subset of the columns it sits with. */
    const blockedKeys = isBlocked(i)
      ? (bucket ? links : [automated, inFlight].filter(Boolean))
      : [];

    for (const k of blockedKeys) because(k, i);

    for (const c of comps) {
      const r = row(c);
      r.items++;      r._items.push(i.key);
      if (done)   { r.done++;    r._done.push(i.key); }
      if (bucket) { r.buckets++; r._buckets.push(i.key); }
      if (story)  { r.stories++; r._stories.push(i.key); }
      if (story && !i.parentKey) r.unlinked++;   // counted per row; see `unlinked`
      for (const k of maintained) { r._maintained.add(k); all.maintained.add(k); }
      for (const k of maintaining) { r._maintaining.add(k); all.maintaining.add(k); }
      for (const k of unclassified) { r._unclassified.add(k); all.unclassified.add(k); }
      if (automated) { r._automated.add(automated); all.automated.add(automated); }
      if (inFlight) { r._inFlight.add(inFlight); all.inFlight.add(inFlight); }
      if (attention) { r._attention.add(attention.key); all.attention.add(attention.key); }
      for (const k of blockedKeys) { r._blocked.add(k); all.blocked.add(k); }
    }
  }

  /**
   * THE SAME COUNTS, SPLIT BY THE TOOL THE SUITE RUNS ON.
   *
   * DERIVED FROM THE SET THE COLUMN ALREADY COUNTED, never from a second walk
   * over the sprint's items. That is what makes "TrueTest + KSE equals the
   * number in the unsplit table" true by construction instead of by
   * coincidence — and this table exists precisely to be read against that one,
   * so the day the two disagree is the day both stop being believed.
   *
   * UNTAGGED FOLLOWS `toolOf`, AND IS ALSO COUNTED. An epic carrying neither
   * tool component comes back as KSE, because that is what `toolOf` says and
   * the Coverage screen has split this way for as long as it has existed; a
   * second rule here would put the same epic under different tools on two
   * screens. But a silent default is worth stating, so the count travels
   * beside the split exactly as `untagged` does on Coverage. An absent test
   * case — a link this tool has no local copy of — has no components to read
   * and lands the same way rather than throwing.
   */
  const TOOL_KEYS = coverageLib.TOOLS.map(t => t.key);
  const splitByTool = (keys) => {
    const out = Object.fromEntries(TOOL_KEYS.map(k => [k, []]));
    let untagged = 0;
    for (const k of keys) {
      const issue = lookup(k) || {};
      if (!coverageLib.hasTool(issue)) untagged++;
      const tool = coverageLib.toolOf(issue);
      (out[tool] || out[TOOL_KEYS[TOOL_KEYS.length - 1]]).push(k);
    }
    return { keys: out, untagged };
  };
  /** Every column this table draws, split the same way. */
  const SPLIT_COLS = ['automated', 'inFlight', 'attention', 'maintained', 'maintaining', 'unclassified', 'blocked'];
  const byToolOf = (sets) => {
    const per = Object.fromEntries(TOOL_KEYS.map(k => [k, { keys: {} }]));
    let untagged = 0;
    for (const col of SPLIT_COLS) {
      const s = splitByTool([...(sets[col] || [])]);
      /* COUNTED ON ONE COLUMN, NOT SUMMED ACROSS THEM. A suite can be in two
         columns — blocked and in flight, say — and adding the per-column
         untagged counts would report it twice. `automated` and `inFlight`
         partition the Story half, so one of them is the honest sample. */
      if (col === 'automated' || col === 'inFlight') untagged += s.untagged;
      for (const t of TOOL_KEYS) { per[t][col] = s.keys[t].length; per[t].keys[col] = s.keys[t]; }
    }
    return { ...per, untagged };
  };

  const out = [...rows.values()]
    .map(r => ({
      component: r.component, items: r.items, done: r.done,
      stories: r.stories, buckets: r.buckets, unlinked: r.unlinked,
      automated: r._automated.size,
      inFlight: r._inFlight.size,
      /* A SUBSET OF `inFlight`, never a column of its own. It is drawn as a
         marker beside that number because it qualifies it — "4 in flight, 2 of
         them going nowhere" — and a separate column would read as more work
         rather than less. */
      attention: r._attention.size,
      maintained: r._maintained.size,
      maintaining: r._maintaining.size,
      unclassified: r._unclassified.size,
      blocked: r._blocked.size,
      testCases: r._automated.size + r._inFlight.size
        + r._maintained.size + r._maintaining.size + r._unclassified.size,
      keys: {
        automated: [...r._automated], inFlight: [...r._inFlight],
        attention: [...r._attention],
        maintained: [...r._maintained], maintaining: [...r._maintaining],
        unclassified: [...r._unclassified], blocked: [...r._blocked],
        items: r._items, done: r._done, stories: r._stories, buckets: r._buckets,
      },
      /* The same row again, split by tool. Built from the very sets above. */
      byTool: byToolOf({
        automated: r._automated, inFlight: r._inFlight, attention: r._attention,
        maintained: r._maintained, maintaining: r._maintaining,
        unclassified: r._unclassified, blocked: r._blocked,
      }),
    }))
    /* Busiest first, by the work this table is about: suites automated and
       suites touched. `maintaining` joins `maintained` here — a component that
       spent the fortnight fixing ten suites and finished none of them did the
       work, and sorting it to the bottom would hide exactly the row worth
       looking at. */
    .sort((a, b) => (b.automated + b.maintained + b.maintaining) - (a.automated + a.maintained + a.maintaining)
      || b.items - a.items || a.component.localeCompare(b.component));

  const list = items || [];
  const isStory = (i) => /^story$/i.test(String(i.issueType || '').trim());
  // The totals' own key lists, built from the whole sprint rather than from the
  // rows — for the same reason the totals themselves are: an item in two
  // components is in two rows, so concatenating the rows would list it twice
  // and make the list longer than the number at the top of it.
  const totalKeys = {
    automated: [...all.automated], inFlight: [...all.inFlight],
    attention: [...all.attention],
    maintained: [...all.maintained], maintaining: [...all.maintaining],
    unclassified: [...all.unclassified], blocked: [...all.blocked],
    items: list.map(i => i.key),
    done: list.filter(isDone).map(i => i.key),
    stories: list.filter(isStory).map(i => i.key),
    buckets: list.filter(i => epicsLib.isBucketStory(i)).map(i => i.key),
  };

  return {
    rows: out,
    totals: {
      automated: all.automated.size,
      inFlight: all.inFlight.size,
      attention: all.attention.size,
      maintained: all.maintained.size,
      maintaining: all.maintaining.size,
      unclassified: all.unclassified.size,
      blocked: all.blocked.size,
      items: list.length,
      done: totalKeys.done.length,
      stories: totalKeys.stories.length,
      buckets: totalKeys.buckets.length,
      keys: totalKeys,
      /* THE TOTAL'S OWN SPLIT, from the sprint-wide sets rather than by adding
         the rows up — an epic in two components is in two rows, so summing
         them would report it twice. Same rule the unsplit totals already
         follow, one level down. */
      byTool: byToolOf({
        automated: all.automated, inFlight: all.inFlight, attention: all.attention,
        maintained: all.maintained, maintaining: all.maintaining,
        unclassified: all.unclassified, blocked: all.blocked,
      }),
    },
    /* The reason behind each blocked key, so the drawer can say WHY rather
       than just listing keys. Keyed by test case, shared by every component
       row that test case appears in — the reason does not change with the
       column it is read from. */
    blockedReasons: Object.fromEntries(blockedReasons),
    /* Why each flagged in-flight epic is flagged. Keyed by epic and shared by
       every component row it appears in, for the same reason as
       `blockedReasons` above: the reason is a fact about the epic, not about
       the column it was read from. */
    attentionReasons: Object.fromEntries(attentionWhy),
    // Everything a key in `keys` can point at that is NOT a sprint item: the
    // parent epics behind Automated and In flight, and the test cases behind
    // Maintained, Maintaining and the unclassified remainder. `absent` marks
    // one this tool has no local copy of.
    catalogue: Object.fromEntries(catalogue),
    // A Story with no parent has no test case behind it, so it is in no column.
    // Counted rather than dropped: a number that is quietly short is worse than
    // one with a stated gap beside it.
    unlinked,
    shared,
  };
}

/* ─────────────────────── view: the planning board ─────────────────────── */

/**
 * THE BACKLOG AS A PLANNING BOARD — open sprints above, the queue below.
 *
 * The same shape Jira's backlog screen has, and for the same reason: choosing
 * what goes into a sprint is a comparison between what is already committed
 * and what is waiting, and a page that shows only the waiting half makes you
 * hold the other one in your head.
 *
 * ── WHICH SPRINTS ARE SECTIONS ───────────────────────────────────────────
 *
 * The OPEN ones — active and future — in date order, oldest first, exactly
 * the set a row can be moved into. A closed sprint is history and would be a
 * section nothing can be dragged to; leaving it out keeps "every section is a
 * destination" true, which is what makes the drag learnable.
 *
 * ── THE COUNTS ARE OF BACKLOG ITEMS, in every section ────────────────────
 *
 * The same `isBacklogItem` the queue below uses. A sprint section counting
 * epics while the backlog section does not would put two different units on
 * one screen — and it is the exact mistake that had the sidebar 1,283 ahead
 * of this page.
 *
 * ── DONE WORK STAYS IN ITS SPRINT SECTION ────────────────────────────────
 *
 * A finished ticket is still committed to that sprint, so it is counted and
 * shown there. `done` is reported separately so the header can say "17 of 33
 * done" the way Jira's pills do, rather than a reader assuming the whole
 * section is outstanding.
 */
function backlogBoard(plan, snap, team) {
  const issues = snap.issues || {};
  const pts = (list) => Math.round(list.reduce((t, i) => t + (Number(i.points) || 0), 0) * 10) / 10;

  const open = (plan.sprints || [])
    .map(sp => ({ sp, mine: (sp.byTeam || {})[team.id] }))
    .filter(x => x.mine && x.mine.state !== 'closed' && x.mine.jiraId)
    .sort((a, b) => String(a.sp.start || '').localeCompare(String(b.sp.start || ''))
      || String(a.sp.id).localeCompare(String(b.sp.id)));

  const sections = open.map(({ sp, mine }) => {
    const keys = sprintIssueKeys(snap, team, sp) || [];
    /* CLASSIFIED HERE, or the Category column is blank in every sprint row.
   
       The queue below gets its category from `metrics.backlogHealth`, which
       maps each item through `cls.classify` on the way out. These sections
       were reading the snapshot straight, so the rows arrived with no
       `category` at all — and a blank cell in a column the reader is using to
       tell new build from maintenance looks like "uncategorised work",
       which is a real state and was the wrong answer.
   
       THE SAME RULES, from the same place. Classifying with a second copy of
       the rule set is how one screen comes to call a Bucket Story
       maintenance and another call it new. */
    const all = keys.map(k => issues[k]).filter(Boolean)
      .map(i => ({ ...i, category: cls.classify(i, plan.categoryRules) }));
    const items = backlogLib.only(all);
    const done = items.filter(isDone);
    return {
      id: sp.id,
      kind: 'sprint',
      name: mine.name || sp.name || sp.id,
      state: mine.state || 'future',
      start: sp.start || null,
      end: sp.end || null,
      count: items.length,
      points: pts(items),
      done: done.length,
      donePoints: pts(done),
      /* What the sprint holds that this board does not count — epics. Said
         per section for the same reason the queue says it: a count that is
         smaller than Jira's own has to be able to explain itself. */
      epicsExcluded: all.length - items.length,
      items,
    };
  });

  return {
    sections,
    /* THE SPRINTS A ROW CAN BE MOVED INTO, which is the same list the
       sections are built from — so a section always exists for every option
       in the picker, and a drag always has somewhere to land. */
    sprints: sections.map(s => ({ id: s.id, name: s.name, state: s.state, start: s.start, end: s.end })),
  };
}

/* ─────────────────────────── view: backlog ─────────────────────────── */

/* ── AN EPIC IS NOT A BACKLOG ITEM ────────────────────────────────────────
 * A backlog item is a piece of work somebody will pull into a sprint: a
 * Story, a Bucket Story, a Defect, a Test. An EPIC is the container those
 * hang off — it is never pulled in, it is finished when its children are —
 * so counting epics makes the queue read as several times its real size.
 *
 * On his data this was not a rounding error. Titan's backlog said 1,857
 * items; 1,283 of them were epics and the actual queue was 574. "Two
 * sprints of work" and "seven sprints of work" are different conversations,
 * and the page was confidently having the wrong one.
 *
 * FILTERED HERE RATHER THAN IN EACH SOURCE, because both produce it: the
 * heuristic fallback has no type filter at all, and a Jira board's backlog
 * endpoint returns epics alongside the stories. One definition, applied to
 * whichever source answered.
 *
 * COUNTED, NOT DROPPED IN SILENCE. `epicsExcluded` is on the view so the
 * page can say why its number moved — a figure that falls by two thirds
 * between releases needs to explain itself.
 */
/* THE DEFINITION MOVED OUT, to lib/backlog-item.js. It had four readers and
   two of them were in `reconcile`, which this module requires — so it could
   not live here without closing a cycle, and it not living in one place is
   exactly how the sidebar ended up 1,283 ahead of the page. Re-exported
   because callers already have the name. */
const { isBacklogItem } = backlogLib;

/**
 * Everything not yet committed to a sprint, per team, grouped so you can see
 * what kind of work is queued and how many sprints of it there is.
 *
 * "Not yet committed" means NO sprint at all — not "no open sprint". An item
 * whose only sprints are closed was pulled in and not finished, which is a
 * different thing and belongs to that sprint's history; both sources already
 * read it that way and this note is here so the next reader does not have to
 * re-derive it.
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
    const raw = (idx && idx.backlog ? idx.backlog.map(hydrate).filter(Boolean)
      : fallbackBacklog(plan, snap, team, rules));
    const items = raw.filter(isBacklogItem).map(i => ({ ...i, memberId: resolve(i) }));
    const epicsExcluded = raw.length - items.length;

    const mix = cls.mix(items, rules);
    const history = velocityHistory(plan, snap, team);
    const avgVelocity = cap.averageVelocity(history) || null;

    return {
      teamId: team.id,
      teamName: team.name,
      source: (idx && idx.backlogSource) || 'heuristic',
      items,
      /* The epics this queue is NOT counting, and what it started from. Said
         out loud because the number they were hiding was three times the
         real one, and a page that silently changed its mind about what it
         counts is the hardest kind of report to trust again. */
      epicsExcluded,
      scanned: raw.length,
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
  /* THE SAME DEFINITION HERE. This bucket is "backlog work on nobody's
     board", so it has to mean the same thing by "backlog work" — otherwise
     the unclaimed pile counts epics the per-team lists above deliberately
     do not, and the two numbers on one screen answer different questions. */
  const unclaimed = Object.values(allIssues)
    .filter(i => isBacklogItem(i) && !isDone(i) && !(i.sprints || []).length
      && !(i.sprintNames || []).length && !claimed.has(i.key))
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
  /* HOW MUCH OF THE COMMITMENT WAS ALREADY IN FLIGHT.
     The committed figure is unchanged — the work is real and still has to be
     delivered. This says how much of it the sprint inherited, which is the
     difference between a team that took on too much and one still finishing
     what it took on last time. */
  const carriedIn = round1(grid.totals.carriedIn + (grid.unowned.carriedIn || 0));

  const inProgress = items.filter(i => isInProgress(i));
  const notStarted = items.filter(i => !isDone(i) && !isInProgress(i));
  const blocked = items.filter(isBlocked);
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
      carriedIn, newScope: round1(committed - carriedIn),
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

  if (blocked.length) { score -= Math.min(20, blocked.length * 5); reasons.push({ level: 'risk', text: `${blocked.length} item${blocked.length > 1 ? 's' : ''} blocked (${sumPoints(blocked)} pts) — in Refinement, or marked Blocked for automation` }); }
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
/**
 * @param {object} opts.withItems  also return a COMPACT item list per sprint.
 *   Off by default: the forecast and the velocity chart want numbers, and
 *   shipping every ticket of thirty-eight sprints to draw a line is a payload
 *   nobody reads. The per-person table turns it on, because the whole point of
 *   its numbers is that you can click through to what they counted.
 */
function velocityHistory(plan, snap, team, { withItems = false } = {}) {
  // The team list as it stands — see `byPerson` below for why this is not `t`.
  const onTeamList = new Set((team.members || []).map(m => m.id));
  return plan.sprints.slice().sort(reconcile.compareForTeam(team.id)).map(raw => {
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
      /* HOW MUCH OF THIS SPRINT'S CAPACITY WAS EVER RECORDED. Carried up from
         the grid because every figure derived from `capacityHours` — the
         utilisation column, `calibrateHoursPerPoint`, the forecast — is only
         as good as this, and a history row that reports hours without it
         invites all three to be read as measurements of the whole team when
         they are measurements of whoever had a leave grid. On his oldest
         Titan sprints that is one person in twelve. */
      coveragePct: grid.totals.coveragePct,
      planned: round1(grid.totals.planned + work.unowned.planned),
      actual: round1(grid.totals.actual + work.unowned.actual),
      /* BOTH ENDS OF THE CARRY, measured rather than inferred.
         `planned - actual` was the only carryover figure this tool had, and it
         is a proxy that assumes everything undelivered moved forward — when
         some of it was dropped, de-scoped or simply removed from the sprint.
         These two are counted from the sprints the items are actually in, so
         "handed on" and "received" are the same event seen from either side
         and a history screen can show them meeting. */
      carriedIn: round1(grid.totals.carriedIn + (work.unowned.carriedIn || 0)),
      /* NULL, NOT ZERO, when the sprint cannot be ordered. An undated sprint
         has no before or after, so "nothing was handed on" is a claim this
         cannot make — and reporting it as 0 would quietly replace a proxy that
         at least meant something with a measurement that means nothing. */
      carriedOut: carryLib.startOf(sprint, t.id)
        ? carryLib.carriedOut(work.issues, carryLib.teamSprintIndex(plan, t), carryLib.startOf(sprint, t.id), isDone).points
        : null,
      newScope: round1(grid.totals.planned + work.unowned.planned - grid.totals.carriedIn - (work.unowned.carriedIn || 0)),
      // The per-member figures as well, because the capacity screens compare
      // delivery against the capacity of the people on the roster, and mixing
      // in work by people who are not on it would make that ratio meaningless.
      memberPlanned: grid.totals.planned,
      memberActual: grid.totals.actual,
      unownedPlanned: round1(work.unowned.planned),
      unownedActual: round1(work.unowned.actual),
      goalPct: grid.totals.goalPct,
      items: withItems ? work.issues.map(i => ({
        key: i.key, summary: i.summary, points: i.points == null ? null : i.points,
        status: i.status, statusCategory: i.statusCategory, category: i.category,
        components: i.components || [], assignee: i.assignee || null,
      })) : undefined,
      /* WHO DELIVERED IT, sprint by sprint.
         Built here rather than by a second pass over the same sprints, because
         this is the one place that already resolves THE ROSTER THAT SPRINT
         HAD — people who have since left, people who had not joined, and work
         assigned to someone who was never on the team list. A per-person
         roll-up built from today's roster would credit a departed engineer's
         sprints to nobody, which is the same bug this function's header exists
         to describe.

         Keyed on the member id where there is one and on the Jira person
         otherwise, so the same human lands in the same row across sprints
         whether or not they were ever on the roster. */
      /* ITEMS AS WELL AS POINTS, because the filter below is a filter on
         EXISTENCE and points are not the same question. Phuong Uyen Le held one
         unestimated ticket in Katalon Squad Sprint 2 — committed 0, delivered
         0 — and vanished from a table listing everyone else on her squad. The
         person carrying work nobody has sized is exactly the person a velocity
         table must not make invisible. */
      byPerson: [
        ...(t.members || []).map(m => ({
          /* ON THE TEAM LIST, not on this sprint's derived roster.
             `t` is the team AS THIS SPRINT HAD IT, which deliberately includes
             anyone who did work in it — so measuring `onRoster` against `t`
             would make the flag always true and the "not on the team" tag
             unreachable. The question the screen is asking is whether this
             person is on the team today, which only the original list answers. */
          key: m.id, name: m.name, onRoster: onTeamList.has(m.id),
          committed: round1((work.byMember[m.id] || {}).planned || 0),
          delivered: round1((work.byMember[m.id] || {}).actual || 0),
          items: ((work.byMember[m.id] || {}).items || []).length,
          /* THE KEYS BEHIND THE NUMBER, so the drawer lists what the cell
             counted rather than re-deciding it from a second walk. Keys only —
             the issues themselves are carried once per sprint on `items`
             below, because the same ticket would otherwise be serialised into
             every row that touches it. */
          keys: ((work.byMember[m.id] || {}).items || []).map(i => i.key),
        })),
        ...work.offRoster.people.map(p => ({
          key: `jira:${p.key}`, name: p.name, onRoster: false,
          committed: round1(p.planned), delivered: round1(p.actual), items: p.count || 0,
          keys: (p.keys || []).slice(),
        })),
      ].filter(r => r.items > 0 || r.committed > 0 || r.delivered > 0),
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
    signals.push(...signalsFor(team, current, activeSprintView(plan, snap, team, current, { today }), snap));
  }

  return {
    signals: bySeverity(signals),
    manual: bySeverity((plan.risks || []).slice()),
    counts: severityCounts(signals),
  };
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
/** Highest first, and anything unlabelled last rather than first. */
const bySeverity = (list) => list.sort((a, b) =>
  (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
const severityCounts = (list) => ({
  high: list.filter(s => s.severity === 'high').length,
  medium: list.filter(s => s.severity === 'medium').length,
  low: list.filter(s => s.severity === 'low').length,
});

/**
 * THE ELEVEN DETECTORS, over a sprint view that has ALREADY BEEN BUILT.
 *
 * Split out of `riskView` so the Active Sprint screen can carry its own risks.
 * That screen computes exactly this view in order to render itself; having it
 * call `riskView` instead would have built the same view a second time, and
 * the page's numbers and the page's risks would then come from two separate
 * computations of the same thing. They agree today. They would agree until the
 * first time one of them was handed a different `today`, or a filter, and then
 * the screen would be reporting a blocked-item count of 4 above a risk card
 * saying 5 with nothing to explain it.
 *
 * So: two readers, one definition, and the definition takes the view rather
 * than making it.
 */
function signalsFor(team, current, view, snap) {
  const signals = [];
  const history = view.history;
  const add = (o) => signals.push({ teamId: team.id, teamName: team.name, sprintId: current.id, ...o });
  {

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
      /* NAME WHAT IS HOLDING EACH ONE, and say so when nothing is. The block
         lives on the epic, so the item's own `blockedBy` is the wrong place to
         look — reading it produced "AUTOKAT-1 ← " for every row, an arrow
         pointing at nothing. */
      detail: view.progress.blocked.items.slice(0, 6)
        .map((i) => {
          const keys = [...new Set((i.epicBlockers || [])
            .flatMap(g => (g.blockers || []).map(b => epicsLib.asLink(b).key))
            .filter(Boolean))];
          return keys.length ? `${i.key} ← ${keys.join(', ')}` : `${i.key} (no blocker recorded)`;
        }).join('; '),
      action: 'Chase the blockers today, or refine what has none — these become carryover.',
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
  return bySeverity(signals);
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
  snapToWeeks, fitRow,
  capacityView, backlogView, backlogBoard, isBacklogItem, sprintIssueKeys, activeSprintView, forecastView, riskView, signalsFor, teamForSprint,
  velocityHistory, currentSprint, sprintHealth, testopsPressure, busFactor, isDone, isInProgress, isBlocked,
  componentProgress, testCaseSummary,
};
