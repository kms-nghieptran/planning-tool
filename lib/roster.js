'use strict';
/**
 * roster.js — who is on a team FOR ONE SPRINT.
 *
 * The tool used to answer this with one list per team, the same for every
 * sprint it ever planned. That is wrong in a way that quietly corrupts the
 * headline number: Titan has had three people since Sprint 38 and four before
 * it, so planning Sprint 39 against the historic four produces a capacity
 * figure for a team that does not exist, and a workload percentage measured
 * against it is meaningless.
 *
 * So the roster is derived per sprint, from the thing that actually says who
 * was on the team that fortnight: WHO WAS ASSIGNED THE WORK.
 *
 *   base     the assignees of the issues in that team's sprint — plus, for a
 *            sprint that has not closed yet, the team's current members, since
 *            planning capacity comes before assigning work (see baseFor)
 *   + added  people you put on the sprint by hand (a new joiner with nothing
 *            assigned yet, someone helping out, a planned hire)
 *   − removed people you took off it
 *
 * WHY A DIFFERENCE AND NOT A STORED LIST. Storing the roster outright would
 * freeze it: a person Jira assigns to the sprint tomorrow would never appear,
 * because the list was written today and nothing revisits it. Storing only
 * what you DECIDED means the derived base keeps updating with every sync while
 * your two decisions survive it. Same shape as the adjustment overlay, for the
 * same reason.
 */

/** Normalise a name the same way insights.memberResolver does, so they agree. */
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * A stable member id for someone Jira knows but the team list does not.
 *
 * Keyed on the Jira account id, so the leave grid entered against them stays
 * attached across syncs and across sprints. Falls back to the name only when
 * there is no account id, which is rare and already lossy everywhere else.
 */
function syntheticId(person) {
  const key = person.accountId || person.jiraAccountId || person.name;
  return `jira:${String(key)}`;
}

/** Index a team's members for matching, by account id and by every known name. */
function memberIndex(team) {
  const byAccount = new Map(), byName = new Map();
  for (const m of team.members || []) {
    if (m.jiraAccountId) byAccount.set(m.jiraAccountId, m);
    byName.set(norm(m.name), m);
    for (const alias of m.jiraNames || []) byName.set(norm(alias), m);
  }
  return { byAccount, byName, loose: looseIndex(team.members) };
}

const nameTokens = (s) => norm(s).split(' ').filter(t => t.length > 1);

/**
 * A SHORT NAME AND ITS FULL ONE ARE ONE PERSON — "Anh" and "Anh Truong".
 *
 * A member can reach the roster from the leave grid rather than from Jira: you
 * enter their availability under whatever you call them, so that record has a
 * short name and no account id, because you typed it. Their work arrives from
 * Jira under their full name. With nothing linking the two, Titan's Sprint 39
 * showed "Anh" holding ten available days and zero points while sixteen points
 * of Anh Truong's work sat in a bucket for people not on the sprint — one
 * person, split into a row with no work and work with no row.
 *
 * This lives here, and `insights.memberResolver` uses it, because attribution
 * and roster derivation have to agree about who is who. Two implementations of
 * "is this the same person" is two answers, and the difference shows up as a
 * duplicate row for someone who is on the sprint once.
 *
 * TWO GUARDS, since this is the one rule that infers rather than reads:
 *
 *   · Only a member with NO account id. One who has an account id and did not
 *     match on it is a different person, whatever the names look like.
 *   · It must be UNAMBIGUOUS. Two candidates is not a match, it is a coin toss,
 *     and a wrong name on a row is worse than a visible gap — the gap is on the
 *     screen where you can see it, the wrong name is not.
 *
 * Whole tokens only, so "An" never matches "Anh Truong"; single letters are
 * dropped, so an initial cannot stand in for a name.
 */
function looseIndex(members) {
  return (members || [])
    .filter(m => !m.jiraAccountId)
    .map(m => ({ member: m, tokens: nameTokens(m.name) }))
    .filter(m => m.tokens.length);
}

/** The one person in `found` whose name loosely matches, or nobody. */
function looseMatchIn(found, name) {
  return looseMatch(looseIndex([...found.values()]), name);
}

function looseMatch(index, name) {
  const tokens = nameTokens(name);
  if (!tokens.length || !index || !index.length) return null;
  const hits = index.filter(m =>
    m.tokens.every(t => tokens.includes(t)) || tokens.every(t => m.tokens.includes(t)));
  return hits.length === 1 ? hits[0].member : null;
}

/**
 * The people assigned work in this team's sprint.
 *
 * Someone with work in the sprint who is NOT on the team's member list still
 * counts — they did the work, so they were on the team. They become a member
 * record derived from the assignee on the issue, with the same shape as a real
 * one so nothing downstream has to know the difference.
 */
function assigneesInSprint(issues, team, excluded = null) {
  const { byAccount, byName, loose } = memberIndex(team);
  const found = new Map();      // memberId -> member

  for (const issue of issues || []) {
    if (!issue || (!issue.assignee && !issue.assigneeId)) continue;

    // A PERSON YOU REMOVED FROM THE TEAM STAYS REMOVED, even though Jira shows
    // their work. This is the rule the whole tool is built on — a decision
    // beats a derivation — and it is load-bearing here: Titan has 38 people
    // excluded, and without this the roster quietly put ten of them back on
    // Sprint 44 and inflated its capacity from three people to eleven.
    //
    // It is not the last word. `sprintRoster.added` can still put a specific
    // person on a specific sprint, because that is a narrower decision than
    // "not on this team" and a later one.
    if (isExcluded(excluded, issue)) continue;

    // The loose match comes last, after the account id and the exact name, and
    // it is what stops a second row appearing for someone already on the roster
    // under a short name.
    const known = (issue.assigneeId && byAccount.get(issue.assigneeId))
      || (issue.assignee && byName.get(norm(issue.assignee)))
      || (issue.assignee && looseMatch(loose, issue.assignee));

    if (known) {
      if (!found.has(known.id)) found.set(known.id, { ...known, onSprint: 'assigned' });
      continue;
    }

    // Not on the team list — someone who has since moved on, or a person the
    // roster window never picked up. Their work still happened.
    const derived = {
      id: syntheticId({ accountId: issue.assigneeId, name: issue.assignee }),
      name: issue.assignee || issue.assigneeId,
      role: null,
      status: 'Active',
      supportPct: 0,
      jiraAccountId: issue.assigneeId || null,
      source: 'jira',
      notOnTeamList: true,
      onSprint: 'assigned',
    };
    if (!found.has(derived.id)) found.set(derived.id, derived);
  }
  return found;
}

/**
 * Exclusions are stored by account id where there is one and by name where
 * there is not, so both have to be checked. Matching on name is
 * case-insensitive for the same reason it is everywhere else in this file:
 * Jira returns "An Nguyen" and "an nguyen" from different endpoints.
 */
function isExcluded(excluded, issue) {
  if (!excluded || !excluded.size) return false;
  if (issue.assigneeId && excluded.has(issue.assigneeId)) return true;
  if (issue.assignee && excluded.has(issue.assignee)) return true;
  if (issue.assignee && excluded.has(norm(issue.assignee))) return true;
  return false;
}

/** The people this team has removed, as a set that matches ids AND names. */
function excludedSet(plan, teamId) {
  const keys = (plan.excluded || {})[teamId] || [];
  const out = new Set();
  for (const k of keys) { out.add(k); out.add(norm(k)); }
  return out;
}

/**
 * The roster overlay you authored for one team and sprint.
 * @returns { added: Set<memberId>, removed: Set<memberId> }
 */
function overlayFor(plan, teamId, sprintId) {
  const entry = (plan.sprintRoster || {})[`${teamId}|${sprintId}`] || {};
  return {
    added: new Set(entry.added || []),
    removed: new Set(entry.removed || []),
    // Who the added people are. Carried here so that adding someone to ONE
    // sprint does not require making them a member of the team — which would
    // put them on every other open sprint as a side effect.
    people: entry.people || {},
  };
}

/**
 * THE BASE ROSTER DEPENDS ON WHETHER THE SPRINT HAS HAPPENED.
 *
 * A CLOSED sprint's roster is who was assigned the work. That is the honest
 * historical record, and it is what makes Sprint 38 show three people and
 * Sprint 34 show four without anyone maintaining a list.
 *
 * An ACTIVE or FUTURE sprint's roster is the assignees PLUS the team's current
 * members, because planning capacity comes BEFORE assigning work. Deriving a
 * future sprint purely from assignees gives an empty grid — and deriving an
 * active one that way silently drops the person who has not picked anything up
 * yet, which is exactly the person whose free capacity you are trying to see.
 *
 * Both are the same rule stated once: the roster is everyone this sprint could
 * reasonably be planned around. For a sprint that is over, that set is closed
 * and known. For one that is not, it is still open.
 */
function baseFor(plan, team, sprint, issues, state, excluded) {
  const found = assigneesInSprint(issues, team, excluded);

  // ANYONE YOU PLANNED CAPACITY FOR was on the sprint, whether or not a ticket
  // ended up with their name on it. A leave grid entered for someone is the
  // clearest possible statement that they were part of that fortnight — and a
  // roster built from assignees alone silently orphans it, so the historical
  // capacity total comes out lower than the plan it is supposed to record.
  //
  // Found on his real data: 34 of 35 rows he had entered were invisible.
  for (const { id, member, aliasIds } of plannedFor(plan, team, sprint)) {
    // The same person under two names: "Anh" in the leave grid you typed, "Anh
    // Truong" on the tickets Jira returned. They arrive here as two records —
    // one with capacity and no work, one with work and no capacity — and
    // merging them is the whole reason the loose match exists. Matching by id
    // alone gave that person two rows: a row with ten available days and zero
    // points, beside their sixteen points filed under a different name.
    const existing = found.get(id)
      || (member && looseMatchIn(found, member.name));
    if (existing) {
      // A MERGE, not a second row. Appending one instead doubled his Ruby S33
      // from 4 people and 231 hours to 8 and 462 — a worse failure than the one
      // this fixes. The leave grid's own id comes along as an alias, so
      // `lookup` still finds the availability, support and override rows filed
      // under it.
      existing.aliasIds = [...new Set([
        ...(existing.aliasIds || []),
        ...(id === existing.id ? [] : [id]),
        ...aliasIds,
      ])];
      continue;
    }
    found.set(id, { ...member, aliasIds, onSprint: 'planned' });
  }

  if (state === 'closed') return found;

  for (const m of team.members || []) {
    if (!found.has(m.id)) found.set(m.id, { ...m, onSprint: 'team' });
  }
  return found;
}

/** The keys of the plan that record capacity for one person in one sprint. */
const PLANNED_IN = ['availability', 'support', 'overrides'];

/**
 * Everyone with capacity data recorded against this team and sprint.
 *
 * Returns the id the data is FILED UNDER together with the person it belongs
 * to, because those are not always the same: the member ids were regenerated
 * at some point and his grid is filed under an older, shorter scheme
 * ("ruby-thao" for what is now "ruby-thao-dang"). `resolveMemberId` reunites
 * them where it can do so unambiguously.
 *
 * The id is deliberately NOT rewritten in the stored data. Resolution happens
 * on read, every time, so that a wrong guess shows on screen and is fixed by
 * changing this function — rather than having already overwritten a leave grid
 * that nothing can rebuild.
 */
function plannedFor(plan, team, sprint) {
  const prefix = `${team.id}|${sprint.id}|`;
  const byMemberId = new Map((team.members || []).map(m => [m.id, m]));
  const out = new Map();

  for (const key of PLANNED_IN) {
    for (const k of Object.keys(plan[key] || {})) {
      if (!k.startsWith(prefix)) continue;
      const storedId = k.slice(prefix.length);
      if (out.has(resolveMemberId(storedId, byMemberId))) continue;

      const resolved = resolveMemberId(storedId, byMemberId);
      const member = byMemberId.get(resolved);
      // The row is keyed by the PERSON (the resolved id), and carries the id
      // its data is filed under as an alias. Keying by the stored id instead
      // gives the same human two rows whenever they are also an assignee.
      const aliasIds = resolved === storedId ? [] : [storedId];
      out.set(resolved, {
        id: resolved,
        aliasIds,
        member: member
          ? { ...member, aliasIds }
          : {
            id: resolved,
            name: nameFromId(resolved, team.id),
            role: null, status: 'Active', supportPct: 0,
            jiraAccountId: null, source: 'manual',
            aliasIds,
            notOnTeamList: true, historic: true,
          },
      });
    }
  }
  return [...out.values()];
}

/**
 * Match an id the data is filed under to a member who exists now.
 *
 * Exactly two rules, both conservative:
 *   an EXACT id match, and
 *   an UNAMBIGUOUS prefix match — "ruby-thao" resolves to "ruby-thao-dang"
 *   only when exactly one current member id begins with it.
 *
 * Deliberately no fuzzy name matching. "ruby-chau" and "ruby-tran-thi-minh-chau"
 * are the same person and this will NOT join them, which is the right failure:
 * that row stays visible as its own historical entry, and a human decides. A
 * matcher confident enough to merge those is confident enough to merge two
 * different people, and the thing being merged is a leave grid no sync can
 * rebuild.
 */
function resolveMemberId(storedId, byMemberId) {
  if (byMemberId.has(storedId)) return storedId;
  const starts = [...byMemberId.keys()].filter(id => id.startsWith(`${storedId}-`));
  return starts.length === 1 ? starts[0] : storedId;
}

/**
 * Read one of the plan's per-member buckets for a roster member, trying the
 * ids their data might be filed under.
 *
 * The member's own id first — that is where anything written today goes — then
 * any alias, which is where an older id scheme left it. Without this the row
 * appears with the right name and a blank leave grid, which looks exactly like
 * "nothing was ever entered".
 */
function lookup(bucket, teamId, sprintId, member) {
  if (!bucket || !member) return undefined;
  for (const id of [member.id, ...(member.aliasIds || [])]) {
    const v = bucket[`${teamId}|${sprintId}|${id}`];
    if (v !== undefined) return v;
  }
  return undefined;
}

/** "titan-thuan" → "Thuan", for a person no longer on the team list. */
function nameFromId(id, teamId) {
  const bare = String(id).replace(new RegExp(`^${teamId}-`), '').replace(/^jira:/, '');
  return bare.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * The effective roster for one team and sprint.
 *
 * @param issues the issues already resolved for this team + sprint
 * @param state  Jira's state for this team's copy of the sprint
 * @returns { members, base, added, removed, counts }
 */
function forSprint(plan, team, sprint, issues, state = null) {
  /* AN EXCLUSION SHAPES A PLAN, IT DOES NOT REWRITE A RECORD.
   *
   * "Not on this team" is a statement about who you are planning around now,
   * and on a sprint you can still change it is exactly right — it is what stops
   * ten people who left years ago reappearing on Sprint 44 and tripling its
   * capacity.
   *
   * On a CLOSED sprint it is the wrong question. Whoever was assigned the work
   * did the work; the sprint is over and nobody is planning it. Applying the
   * exclusion there took 53 of Titan's 61 items in Sprint 30 away from the
   * people who delivered them and filed them under nobody — and across 38
   * closed sprints it hid 5,046 delivered points, so the team's own velocity
   * read as a sixth of what it had actually shipped.
   */
  const excluded = norm(state) === 'closed' ? null : excludedSet(plan, team.id);
  const base = baseFor(plan, team, sprint, issues, state, excluded);
  const { added, removed, people } = overlayFor(plan, team.id, sprint.id);

  // Anyone you added by hand. Resolved from the team list first, so a real
  // member keeps their real id and their history; then from the record stored
  // on the roster entry itself, which is how someone from the Jira list gets a
  // name without being made a permanent member of the team.
  const byMemberId = new Map((team.members || []).map(m => [m.id, m]));
  for (const id of added) {
    if (base.has(id)) { base.get(id).onSprint = 'added'; continue; }
    const m = byMemberId.get(id) || people[id];
    base.set(id, m
      ? {
        id, name: m.name || String(id).replace(/^jira:/, ''), role: m.role || null,
        status: m.status || 'Active', supportPct: m.supportPct || 0,
        jiraAccountId: m.jiraAccountId || m.accountId || null,
        source: m.source || 'jira', onSprint: 'added',
        notOnTeamList: !byMemberId.has(id),
      }
      // An id we cannot resolve at all: keep the row rather than silently
      // dropping a person you deliberately put on the sprint. The name is the
      // id, which is ugly and visible, which is the point.
      : { id, name: String(id).replace(/^jira:/, ''), role: null, status: 'Active', supportPct: 0, source: 'manual', onSprint: 'added', unresolved: true });
  }

  for (const id of removed) base.delete(id);

  const members = [...base.values()];
  return {
    members,
    base: [...assigneesInSprint(issues, team, excluded).keys()],
    added: [...added],
    removed: [...removed],
    counts: {
      assigned: members.filter(m => m.onSprint === 'assigned').length,
      planned: members.filter(m => m.onSprint === 'planned').length,
      fromTeam: members.filter(m => m.onSprint === 'team').length,
      added: members.filter(m => m.onSprint === 'added').length,
      removed: removed.size,
      total: members.length,
    },
  };
}

/**
 * Everyone who could be added to a sprint: the team's own members plus every
 * person Jira has seen, minus whoever is already on the roster.
 *
 * The Jira half is what makes "the list member will get from Jira" true — a
 * new joiner shows up here the first sync after they exist, without anyone
 * having to type their name.
 */
function candidates(plan, snap, team, current = []) {
  const on = new Set(current.map(m => m.id));
  const { byAccount, byName } = memberIndex(team);
  const out = [];
  const seen = new Set();

  const push = (entry) => {
    if (!entry.id || on.has(entry.id) || seen.has(entry.id)) return;
    seen.add(entry.id);
    out.push(entry);
  };

  for (const m of team.members || []) {
    push({ id: m.id, name: m.name, role: m.role || null, jiraAccountId: m.jiraAccountId || null, from: 'team' });
  }

  for (const p of (snap.people || [])) {
    if (!p || !p.name) continue;
    const known = (p.accountId && byAccount.get(p.accountId)) || byName.get(norm(p.name));
    push(known
      ? { id: known.id, name: known.name, role: known.role || null, jiraAccountId: known.jiraAccountId || null, from: 'team' }
      : { id: syntheticId(p), name: p.name, role: null, jiraAccountId: p.accountId || null, from: 'jira' });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

module.exports = {
  forSprint, baseFor, candidates, assigneesInSprint, excludedSet, isExcluded,
  looseIndex, looseMatch,
  overlayFor, syntheticId, memberIndex, norm,
  plannedFor, resolveMemberId, nameFromId, lookup, PLANNED_IN,
};
