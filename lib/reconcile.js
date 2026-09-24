'use strict';
/**
 * reconcile.js — makes Jira the source of truth for SPRINTS and TEAM ROSTERS,
 * not just issues.
 *
 * The split of responsibility:
 *   snapshot.json — what Jira said (rebuilt by sync, never hand-edited)
 *   plan.json     — the working calendar and rosters the app plans against
 *
 * Reconcile pushes Jira's facts into plan.json so the sprint dropdown shows real
 * sprints with real dates and states, and member rows carry real accountIds.
 *
 * It also builds snapshot.byTeam — a per-team index of sprints, their issue keys,
 * the team's backlog and its people. Views read that index instead of scanning
 * every issue on every request, which is what makes picking a team instant.
 *
 * Two rules keep this safe to run on every sync:
 *  1. It NEVER deletes. A sprint or member that Jira stops mentioning is marked,
 *     not removed — a board reconfigured for one afternoon must not wipe history.
 *  2. A person you removed STAYS removed. New people are added automatically
 *     (they are, demonstrably, on the team — they have tickets in its sprints),
 *     but plan.excluded[teamId] is honoured forever so the roster never fights you.
 */

const keywordsLib = require('./keywords');

const SPRINT_NUMBER = /(\d+)\s*$/;

/**
 * How many recent sprints define "currently on this team".
 *
 * Three is deliberately short. A board holds years of history and everyone who
 * ever touched it; a roster built from all of it is a list of alumni, not a
 * team you can plan capacity for. Someone who has picked up nothing in three
 * sprints is not someone you would plan next sprint around — and if they are,
 * adding them back is one click. Override per team with
 * `team.settings.rosterWindowSprints`.
 */
const ROSTER_WINDOW_SPRINTS = 3;

/* ─────────────────────────── sprints ─────────────────────────── */

/**
 * Upsert each team's Jira board sprints into plan.sprints.
 *
 * plan.sprints stays ONE numbered calendar (both teams run the same fortnightly
 * cadence), but each entry carries `byTeam[teamId]` with that team's own Jira id,
 * dates and state — because Ruby's Sprint 40 and Titan's Sprint 40 are different
 * Jira objects that are only usually aligned.
 */
/**
 * How a Jira sprint lands in the local calendar.
 *
 * Two naming conventions exist in this project and BOTH have to work:
 *
 *   "Katalon Ruby Sprint 39"  → numbered. The teams share a fortnight, so
 *                               number 39 is one calendar entry that several
 *                               teams hang their own dates and state off.
 *   "TT Week 31Aug"           → dated. The TrueTest boards run weekly windows
 *                               with no number at all. There is no shared
 *                               fortnight to line these up with, so each is its
 *                               own entry, identified by its Jira sprint id.
 *
 * The old code required a trailing number and DISCARDED anything else, which
 * silently cost Malphite 10 of its 11 sprints and left the team looking like it
 * had never run one. A sprint Jira returned is a sprint that exists; the naming
 * convention is not our business.
 */
function sprintKeyFor(js) {
  const m = SPRINT_NUMBER.exec(js.name || '');
  if (m) {
    const number = Number(m[1]);
    return { id: `S${number}`, number, name: `Sprint ${number}`, shared: true };
  }
  return { id: `J${js.id}`, number: null, name: js.name || `Sprint ${js.id}`, shared: false };
}

/**
 * Order sprints by WHEN THEY RAN, not by the number in their name.
 *
 * Dates are the real chronology, always present on a Jira sprint, and the only
 * thing that can order a numbered sprint against a dated one. The number is a
 * tie-breaker for entries that have no dates yet (a locally seeded calendar).
 */
function compareSprints(a, b) {
  const ad = a.start || (a.byTeam && firstStart(a.byTeam));
  const bd = b.start || (b.byTeam && firstStart(b.byTeam));
  if (ad && bd && ad !== bd) return ad < bd ? -1 : 1;
  if (a.number != null && b.number != null) return a.number - b.number;
  if (a.number != null) return -1;
  if (b.number != null) return 1;
  return String(a.id).localeCompare(String(b.id));
}
function firstStart(byTeam) {
  return Object.values(byTeam || {}).map(t => t && t.start).filter(Boolean).sort()[0] || null;
}

function reconcileSprints(plan, snapshot) {
  const byTeam = (snapshot && snapshot.boardSprintsByTeam) || {};
  const report = { added: [], updated: [], dated: [], teams: {} };
  if (!Object.keys(byTeam).length) return report;

  // Keyed by the calendar ENTRY id, so numbered and dated sprints coexist.
  const index = new Map(plan.sprints.map(s => [s.id, s]));

  for (const [teamId, sprints] of Object.entries(byTeam)) {
    let count = 0;
    const numbers = [];
    for (const js of sprints || []) {
      const key = sprintKeyFor(js);
      count++;
      if (key.number != null) numbers.push(key.number);
      else report.dated.push({ teamId, name: js.name, jiraId: String(js.id) });

      const jira = {
        jiraId: String(js.id),
        name: js.name,
        state: js.state || null,          // future | active | closed
        start: js.start || null,
        end: js.end || null,
        syncedAt: new Date().toISOString(),
      };

      let entry = index.get(key.id);
      if (!entry) {
        entry = {
          id: key.id, number: key.number, name: key.name,
          start: js.start || null, end: js.end || null,
          source: 'jira', shared: key.shared, byTeam: {},
        };
        plan.sprints.push(entry);
        index.set(key.id, entry);
        report.added.push({ id: key.id, number: key.number, teamId, name: js.name });
      } else {
        const before = JSON.stringify((entry.byTeam || {})[teamId] || null);
        entry.byTeam = entry.byTeam || {};
        if (before !== JSON.stringify({ ...jira, syncedAt: (entry.byTeam[teamId] || {}).syncedAt })) {
          report.updated.push({ id: key.id, number: key.number, teamId, name: js.name, state: js.state });
        }
        // A seeded date is a guess; Jira's is a fact. Adopt it for the shared
        // fallback only when the entry has no Jira-backed dates yet.
        if (entry.source !== 'jira' && js.start && js.end) {
          entry.start = js.start; entry.end = js.end; entry.source = 'jira';
        }
      }
      entry.byTeam = entry.byTeam || {};
      entry.byTeam[teamId] = jira;
    }
    report.teams[teamId] = {
      sprints: count,
      dated: count - numbers.length,
      range: numbers.length ? [Math.min(...numbers), Math.max(...numbers)] : null,
    };
  }

  plan.sprints.sort(compareSprints);
  return report;
}

/** Which sprint is genuinely in flight for this team, per Jira. */
function activeSprint(plan, teamId) {
  return plan.sprints.find(s => s.byTeam && s.byTeam[teamId] && s.byTeam[teamId].state === 'active') || null;
}

/** Sprint fields as they apply to ONE team (its own dates and state). */
function forTeam(sprint, teamId) {
  if (!sprint) return sprint;
  const t = sprint.byTeam && sprint.byTeam[teamId];
  if (!t) return sprint;
  return {
    ...sprint,
    start: t.start || sprint.start,
    end: t.end || sprint.end,
    jiraId: t.jiraId,
    jiraName: t.name,
    state: t.state,
  };
}


/* ─────────────────────────── team discovery ─────────────────────────── */

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/**
 * Teams come from Jira: a scrum board is a team, and the Team field value is its
 * name. An existing plan team is matched (never duplicated) by board id, by a
 * Team-field value it already claims, or by one of its sprint keywords.
 */
function discoverTeams(plan, snapshot) {
  const report = { created: [], matched: [], ignored: [] };
  const boards = snapshot.boards || [];
  const teamValues = snapshot.teamFieldValues || [];
  const ignored = new Set((plan.ignoredBoards || []).map(String));

  const findExisting = ({ boardId, jiraTeam, name }) => plan.teams.find(t =>
    (boardId && String(t.boardId) === String(boardId)) ||
    (jiraTeam && (t.jiraTeams || []).some(v => norm(v) === norm(jiraTeam))) ||
    (t.sprintKeywords || []).some(k => norm(name).includes(norm(k)))
  );

  for (const board of boards) {
    if (board.type && board.type !== 'scrum') continue;      // kanban has no sprints to plan
    if (ignored.has(String(board.id))) { report.ignored.push(board.name); continue; }
    // Prefer the Team field value that matches this board's name as the display name.
    const jiraTeam = teamValues.find(v => norm(board.name).includes(norm(v.replace(/^katalon auto /i, '')))) || null;
    const existing = findExisting({ boardId: board.id, jiraTeam, name: board.name });
    if (existing) {
      if (!existing.boardId) existing.boardId = board.id;
      if (jiraTeam && !(existing.jiraTeams || []).some(v => norm(v) === norm(jiraTeam))) {
        existing.jiraTeams = [...(existing.jiraTeams || []), jiraTeam];
      }
      // What Jira calls this team, kept beside (not over) whatever the user named it.
      existing.jiraName = jiraTeam || board.name;
      existing.boardName = board.name;
      report.matched.push({ teamId: existing.id, boardId: board.id, jiraName: existing.jiraName });
      continue;
    }
    const name = jiraTeam || board.name;
    const team = {
      id: slug(name),
      name,
      jiraName: name,
      boardName: board.name,
      source: 'jira',
      boardId: board.id,
      jiraTeams: jiraTeam ? [jiraTeam] : [],
      sprintKeywords: [String(name).split(/\s+/).pop()],
      components: [],
      testopsProjectIds: [],
      settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9, workloadOverPct: 110, workloadUnderPct: 85, pointsPerFailingTest: 0.25 },
      members: [],
    };
    plan.teams.push(team);
    report.created.push({ teamId: team.id, name, boardId: board.id });
  }
  return report;
}

/** Remove a team and stop its board being rediscovered. Everything it owned goes. */
function removeTeam(plan, teamId) {
  const team = plan.teams.find(t => t.id === teamId);
  if (!team) throw new Error(`No team "${teamId}"`);
  if (team.boardId) {
    plan.ignoredBoards = [...new Set([...(plan.ignoredBoards || []), String(team.boardId)])];
  }
  plan.teams = plan.teams.filter(t => t.id !== teamId);
  // The keyed side-tables would otherwise leak forever.
  for (const key of ['availability', 'support', 'overrides', 'notes']) {
    if (!plan[key]) continue;
    for (const k of Object.keys(plan[key])) if (k.startsWith(`${teamId}|`)) delete plan[key][k];
  }
  if (plan.ceremony) for (const k of Object.keys(plan.ceremony)) if (k.startsWith(`${teamId}|`)) delete plan.ceremony[k];
  for (const s of plan.sprints || []) if (s.byTeam) delete s.byTeam[teamId];
  if (plan.excluded) delete plan.excluded[teamId];
  if (plan.mixTargets) delete plan.mixTargets[teamId];
  return team.name;
}

/** Undo a dismissal — the next sync rediscovers that board as a team. */
function unignoreBoard(plan, boardId) {
  plan.ignoredBoards = (plan.ignoredBoards || []).filter(b => String(b) !== String(boardId));
}

/* ─────────────────────────── the per-team index ─────────────────────────── */

/**
 * snapshot.byTeam[teamId] = everything that team's views need, pre-grouped:
 *
 *   sprints      [{ jiraId, number, name, state, start, end, issueKeys, points, done }]
 *   sprintIssues { <jiraSprintId>: [issueKey, …] }
 *   backlog      [issueKey, …]      ← straight from the board's backlog
 *   people       [{ name, accountId, issues, points }]
 *
 * Issue BODIES stay in snapshot.issues, keyed once. The index holds keys only, so
 * it stays small and there is exactly one copy of every issue on disk.
 */
function buildTeamIndex(plan, snapshot) {
  const issues = snapshot.issues || {};
  const byTeam = {};

  for (const team of plan.teams) {
    const sprints = plan.sprints
      .filter(s => s.byTeam && s.byTeam[team.id])
      .map(s => ({ ...s.byTeam[team.id], number: s.number, sprintId: s.id }))
      // By date, not by number — a board with date-named sprints has no numbers
      // to sort on, and the roster window below takes the LAST few of this list.
      .sort(compareSprints);

    const jiraIds = new Set(sprints.map(s => String(s.jiraId)));
    const keywords = keywordsLib.forTeam(team).map(norm);

    const sprintIssues = {};
    for (const s of sprints) sprintIssues[s.jiraId] = [];
    const nameToId = new Map(sprints.map(s => [norm(s.name), String(s.jiraId)]));

    // WHO IS ON THIS TEAM *NOW*.
    //
    // A board carries years of history — Titan has 44 sprints — and everyone who
    // ever picked up a ticket appears in it. Rolling that up gave a 40-person
    // roster for a team that has had 3 people since Sprint 38, and the only way
    // out was excluding 37 people by hand. So the roster is built from a RECENT
    // WINDOW (the active sprint plus the last few closed ones) and everyone
    // older is reported separately as `peopleHistoric` — visible on the Team
    // tab, addable in one click, never auto-added.
    const windowSize = Math.max(1, ((team.settings || {}).rosterWindowSprints) || ROSTER_WINDOW_SPRINTS);
    const recent = new Set(
      sprints
        .filter(s => s.state !== 'future')          // not yet started: nobody has picked anything up
        .slice(-windowSize)
        .map(s => String(s.jiraId))
    );

    const people = new Map();
    const historic = new Map();
    for (const i of Object.values(issues)) {
      for (const sp of i.sprints || []) {
        let id = sp.id && jiraIds.has(String(sp.id)) ? String(sp.id) : null;
        if (!id && sp.name) id = nameToId.get(norm(sp.name)) || null;
        if (!id) continue;
        sprintIssues[id].push(i.key);
        if (i.assignee) {
          const bucket = recent.has(id) ? people : historic;
          const pk = i.assigneeId || norm(i.assignee);
          if (!bucket.has(pk)) bucket.set(pk, { name: i.assignee, accountId: i.assigneeId || null, issues: 0, points: 0 });
          const p = bucket.get(pk); p.issues++; p.points += Number(i.points) || 0;
        }
      }
    }
    // Someone active recently is current, whatever they did years ago.
    for (const pk of people.keys()) historic.delete(pk);

    // The board's own backlog is definitive. Fall back to the ownership heuristic
    // only when no board is mapped, and say which one was used.
    const boardBacklog = (snapshot.boardBacklogByTeam || {})[team.id];
    let backlog, backlogSource;
    if (Array.isArray(boardBacklog)) {
      backlog = boardBacklog.filter(k => issues[k] && !isDone(issues[k]));
      backlogSource = 'board';
    } else {
      backlogSource = 'heuristic';
      backlog = Object.values(issues)
        .filter(i => !isDone(i) && !(i.sprints || []).length && !(i.sprintNames || []).length)
        .filter(i => (team.jiraTeams || []).some(v => norm(v) === norm(i.team))
          || (team.components || []).some(c => (i.components || []).includes(c))
          || keywords.some(k => norm(i.team || '').includes(k)))
        .map(i => i.key);
    }

    const pts = (keys) => Math.round(keys.reduce((t, k) => t + (Number((issues[k] || {}).points) || 0), 0) * 10) / 10;

    byTeam[team.id] = {
      boardId: team.boardId || null,
      sprints: sprints.map(s => {
        const keys = sprintIssues[s.jiraId] || [];
        const done = keys.filter(k => issues[k] && isDone(issues[k]));
        return { ...s, issueKeys: keys, count: keys.length, points: pts(keys), donePoints: pts(done) };
      }),
      sprintIssues,
      backlog,
      backlogSource,
      backlogPoints: pts(backlog),
      backlogCount: backlog.length,
      people: [...people.values()]
        .map(p => ({ ...p, points: Math.round(p.points * 10) / 10 }))
        .sort((a, b) => b.issues - a.issues),
      // Worked this board before the window and not since. Never auto-added.
      peopleHistoric: [...historic.values()]
        .map(p => ({ ...p, points: Math.round(p.points * 10) / 10 }))
        .sort((a, b) => b.issues - a.issues),
      rosterWindow: { sprints: windowSize, names: sprints.filter(s => recent.has(String(s.jiraId))).map(s => s.name) },
      builtAt: new Date().toISOString(),
    };
  }
  return byTeam;
}

const isDone = (i) => i.statusCategory === 'done' || /^(done|closed|resolved)$/i.test(i.status || '');

/* ─────────────────────────── people ─────────────────────────── */

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Who actually worked in each team's sprints, per Jira.
 * Ownership is decided by the sprint the issue sits in, not by a Team field that
 * is frequently blank.
 */
function peopleByTeam(plan, snapshot) {
  const out = {};
  for (const team of plan.teams) {
    out[team.id] = ((snapshot.byTeam || {})[team.id] || {}).people || [];
  }
  return out;
}

/**
 * Link existing roster members to their Jira accountId (safe — pure improvement,
 * and it makes matching immune to display-name changes), and report people Jira
 * knows who are NOT on the roster. Adding those is a human decision.
 */
/**
 * One name against the whole Jira directory, or nothing.
 *
 * `null` on an ambiguous name is the point of the function. Two people with
 * the same display name is rare and real, and picking either one attaches a
 * roster row — and everything credited to it — to a coin toss.
 */
function globalHit(directory, names) {
  for (const n of names) {
    const all = (directory || []).filter(p => p && p.accountId && norm(p.name) === n);
    if (all.length === 1) return all[0];
  }
  return null;
}

function reconcileMembers(plan, snapshot, { autoAdd = true } = {}) {
  const found = peopleByTeam(plan, snapshot);
  const directory = (snapshot && snapshot.people) || [];
  const report = { linked: [], added: [], discovered: {}, dormant: {} };
  plan.excluded = plan.excluded || {};

  for (const team of plan.teams) {
    const people = found[team.id] || [];
    const byName = new Map(people.map(p => [norm(p.name), p]));
    const excluded = new Set((plan.excluded[team.id] || []).map(norm));

    /* 1. Link what we already have. Pure improvement: an accountId survives a
          display-name change, a name does not.

       THE TEAM'S OWN SPRINT PEOPLE FIRST, THEN THE WHOLE DIRECTORY. This used
       to look only at `people` — whoever worked in THIS team's sprints — which
       means someone on the roster who has never been given work here could
       never be linked, however well Jira knows them.

       That is not a corner case. Diep Tu sits on three of his teams; on two
       they came from a sync, on Titan they were typed in. All 108 of their
       issues are on the TrueTest board, none in Titan's 44 sprints, so Titan's
       sprint people will never contain them and the row stayed unlinked
       forever — reported as someone Jira has never heard of, while two other
       teams held their accountId.

       Matching a roster name against the global directory is the same claim
       the per-team match makes, over a wider set: this row and that Jira
       account are the same human. An ambiguous name links to neither. */
    for (const m of team.members || []) {
      if (m.jiraAccountId) continue;
      const names = [m.name, ...(m.jiraNames || [])].map(norm);
      const hit = names.map(n => byName.get(n)).find(Boolean) || globalHit(directory, names);
      if (hit && hit.accountId) {
        m.jiraAccountId = hit.accountId;
        /* AND THE SOURCE FOLLOWS THE LINK. `addMember` states the rule — 'jira'
           only when they carry an accountId — and this step used to set the
           accountId while leaving `source: 'manual'`, breaking the one
           invariant that makes the column mean anything. A row that Jira has
           now identified is no longer something the user merely typed. */
        if (m.source !== 'jira') m.source = 'jira';
        report.linked.push({ teamId: team.id, name: m.name, accountId: hit.accountId });
      }
    }

    const known = new Set();
    for (const m of team.members || []) {
      if (m.jiraAccountId) known.add(norm(m.jiraAccountId));
      known.add(norm(m.name));
      for (const a of m.jiraNames || []) known.add(norm(a));
    }

    // 2. Populate. Someone assigned work in this team's sprints IS on this team.
    const fresh = people.filter(p => !known.has(norm(p.accountId)) && !known.has(norm(p.name)));
    for (const p of fresh) {
      // A person you took off the roster stays off, however much Jira insists.
      if (excluded.has(norm(p.name)) || (p.accountId && excluded.has(norm(p.accountId)))) continue;
      if (!autoAdd) continue;
      const id = addMember(plan, team.id, p);
      report.added.push({ teamId: team.id, name: p.name, memberId: id, issues: p.issues });
    }
    report.discovered[team.id] = autoAdd
      ? fresh.filter(p => excluded.has(norm(p.name)) || (p.accountId && excluded.has(norm(p.accountId))))
      : fresh;

    /* 3. Active members with no work in THIS team's sprints.
          `linked` splits the two very different reasons, which the screen used
          to collapse into one and always blame on a name mismatch:
            linked   — Jira knows exactly who they are; they simply have no
                       work on this board. Nothing to fix.
            unlinked — Jira has never matched this name at all, here or in the
                       directory, which IS usually a spelling difference.
          Telling someone to add a Jira alias for a person already linked by
          accountId sends them to fix something that is not broken. */
    report.dormant[team.id] = (team.members || [])
      .filter(m => m.status === 'Active')
      .filter(m => !people.some(p => (m.jiraAccountId && p.accountId === m.jiraAccountId) || norm(p.name) === norm(m.name)))
      .map(m => ({ id: m.id, name: m.name, linked: Boolean(m.jiraAccountId) }));
  }
  return report;
}

/** Take someone off a roster and keep them off across every future sync. */
function excludeMember(plan, teamId, memberId) {
  const team = plan.teams.find(t => t.id === teamId);
  if (!team) throw new Error(`No team "${teamId}"`);
  const member = (team.members || []).find(m => m.id === memberId);
  if (!member) throw new Error('Member not found');
  plan.excluded = plan.excluded || {};
  plan.excluded[teamId] = [...new Set([...(plan.excluded[teamId] || []), member.jiraAccountId || member.name])];
  team.members = team.members.filter(m => m.id !== memberId);
  return member.name;
}

/** Undo an exclusion — the next sync will bring them back if Jira still has them. */
function unexcludeMember(plan, teamId, key) {
  plan.excluded = plan.excluded || {};
  plan.excluded[teamId] = (plan.excluded[teamId] || []).filter(v => norm(v) !== norm(key));
}

/** Add a discovered Jira person to a team's roster. */
/**
 * Add someone to a roster.
 *
 * `source` records WHERE THEY CAME FROM and must stay honest: 'jira' only when
 * Jira actually told us about them (they carry an accountId), 'manual'
 * otherwise. The tool shows the user which of their data is synced and which
 * they typed, and that promise is worthless if every row claims to be seed —
 * as every one of the 95 rows did before this.
 */
function addMember(plan, teamId, person, { source, directory = null } = {}) {
  const team = plan.teams.find(t => t.id === teamId);
  if (!team) throw new Error(`No team "${teamId}"`);
  const id = `${teamId}-${norm(person.name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`.slice(0, 60);
  if ((team.members || []).some(m => m.id === id || norm(m.name) === norm(person.name))) {
    throw new Error(`${person.name} is already on ${team.name}`);
  }

  /* A TYPED NAME THE TOOL ALREADY KNOWS IS NOT AN UNKNOWN PERSON.
     Picking someone off the discovered list carries their accountId; typing
     the same name into the box did not, and stored `jiraAccountId: null`
     while `snapshot.people` held that exact name against a real account —
     information the tool already had and threw away.
     It is not cosmetic. Every match to a Jira issue goes through the
     accountId, so an unlinked row can never be credited with any work, and
     the roster reports them as someone Jira has never heard of.
     Exact name match only: a fuzzy one would silently attach a roster row to
     the wrong human, which is far worse than leaving it unlinked. */
  const resolved = person.accountId
    || (directory || []).filter(p => p && p.accountId && norm(p.name) === norm(person.name))
      // Two people sharing a display name is rare and real. Linking to
      // whichever sorted first would be a guess wearing a fact's clothes.
      .reduce((one, p, _i, all) => (all.length === 1 ? p.accountId : null), null)
    || null;

  team.members = team.members || [];
  team.members.push({
    id,
    name: person.name,
    role: person.role || 'Auto QA',
    status: 'Active',
    supportPct: 0,
    jiraAccountId: resolved,
    source: source || (resolved ? 'jira' : 'manual'),
    addedAt: new Date().toISOString(),
  });
  return id;
}

/* ─────────────────────────── boards ─────────────────────────── */

/** Guess which board belongs to which team from the board name. */
function autoAssignBoards(plan, boards) {
  const assigned = [];
  for (const team of plan.teams) {
    if (team.boardId) continue;
    const keywords = keywordsLib.forTeam(team).map(norm);
    const hit = (boards || []).find(b => keywords.some(k => norm(b.name).includes(k)));
    if (hit) { team.boardId = hit.id; assigned.push({ teamId: team.id, boardId: hit.id, boardName: hit.name }); }
  }
  return assigned;
}

/* ─────────────────────────── entry point ─────────────────────────── */

/** Run every reconciliation and return one readable summary. */
function reconcileAll(plan, snapshot) {
  // Order matters: teams first (so a brand-new board gets a team), then sprints
  // (the index is keyed by them), then the index, then members (read from it).
  const teams = discoverTeams(plan, snapshot);
  const boards = autoAssignBoards(plan, snapshot.boards);
  const sprints = reconcileSprints(plan, snapshot);
  snapshot.byTeam = buildTeamIndex(plan, snapshot);
  const members = reconcileMembers(plan, snapshot);

  return {
    teams: { created: teams.created.length, detail: teams.created, ignored: teams.ignored },
    boards,
    sprints: {
      added: sprints.added.length,
      updated: sprints.updated.length,
      unnumbered: sprints.unnumbered,
      byTeam: sprints.teams,
      detail: sprints.added.slice(0, 10),
    },
    members: {
      linked: members.linked.length,
      added: members.added.length,
      addedDetail: members.added,
      linkedDetail: members.linked,
      discovered: members.discovered,
      dormant: members.dormant,
      discoveredCount: Object.values(members.discovered).reduce((t, a) => t + a.length, 0),
    },
    index: Object.fromEntries(Object.entries(snapshot.byTeam).map(([id, t]) => [id, {
      sprints: t.sprints.length,
      backlog: t.backlogCount,
      backlogSource: t.backlogSource,
      people: t.people.length,
    }])),
  };
}

module.exports = {
  reconcileSprints, reconcileMembers, reconcileAll, discoverTeams, buildTeamIndex,
  peopleByTeam, addMember, excludeMember, unexcludeMember, removeTeam, unignoreBoard,
  autoAssignBoards, activeSprint, forTeam, compareSprints, sprintKeyFor,
};
