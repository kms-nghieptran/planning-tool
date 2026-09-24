'use strict';
/**
 * project.js — rebuild the snapshot and plan OBJECTS from the database.
 *
 * The database is now the system of record, but eighteen modules and every
 * screen were written against two big JSON objects. Rewriting all of them at
 * once would mean changing the storage engine and every consumer in the same
 * step, with nothing to compare against when a number came out wrong.
 *
 * So this module sits in between: it reads the tables and returns exactly the
 * shapes `store.getSnapshot()` and `store.getPlan()` used to return. Those
 * consumers keep working untouched, and the proof that the migration lost
 * nothing is a strong one — project(import(json)) is compared field by field
 * against the original json, not merely counted.
 *
 * This is scaffolding with a purpose, not a permanent layer. As screens move
 * to querying the database directly, the projection they used stops being
 * called and can go. Two things make that migration safe to do gradually:
 * the projection is READ-ONLY (nothing writes through it), and it is the only
 * place that knows the old shapes.
 *
 * One thing here is not really a projection: `byTeam`, the reconcile index. It
 * is DERIVED — reconcile.buildTeamIndex builds it from the plan and the
 * snapshot together — but it is expensive enough that the server builds it
 * explicitly and saves the result, so it is stored as a blob and handed back
 * as-is. This module never recomputes it. Deriving it in a second place is
 * exactly how it went stale before.
 */

const db = require('./db');
const repo = require('./repo');

/* ─────────────────────────── snapshot ─────────────────────────── */

/**
 * The snapshot shape, rebuilt from the tables.
 *
 * `issues` is the expensive part and the reason this is worth caching by the
 * caller: it is 7,269 rows plus four relation queries. Everything else here is
 * small.
 */
function snapshot({ includeDeleted = false } = {}) {
  const s = db.setting.all();

  const out = {
    syncedAt: s['snapshot.syncedAt'] ?? null,
    watermark: s['snapshot.watermark'] ?? null,
    source: s['snapshot.source'] ?? 'none',
    issues: repo.allIssues({ includeDeleted }),
    sprints: sprintNames(),
    people: people(),
    components: s['snapshot.components'] ?? [],
    testops: s['snapshot.testops'] ?? { syncedAt: null, projects: [], suites: [] },
    github: s['snapshot.github'] ?? { syncedAt: null, repos: [], activity: [] },
    verification: s['snapshot.verification'] ?? [],
    fields: s['snapshot.fields'] ?? {},
    boards: boards(),
    boardSprintsByTeam: boardSprintsByTeam(),
    boardSprintErrors: s['snapshot.boardSprintErrors'] ?? [],
  };
  // Present only when it has been built. `byTeam: {}` and "no index yet" read
  // the same to a screen that iterates it, but they are not the same to the
  // staleness banner that asks whether a reconcile has ever run.
  if (s['snapshot.byTeam'] !== undefined) out.byTeam = s['snapshot.byTeam'];
  if (s['snapshot.extraFields'] !== undefined) out.extraFields = s['snapshot.extraFields'];
  if (s['snapshot.clearedAt'] !== undefined) out.clearedAt = s['snapshot.clearedAt'];
  return out;
}

/**
 * The flat list of sprints, as the old snapshot carried it.
 *
 * Read from the ISSUES, not from the sprint table, and the difference is not
 * cosmetic. The sprint table holds every sprint on every team's board — 136 of
 * them, four of which are future sprints no issue has been put in yet. This
 * list is "sprints work has actually been done in", 132, and it carries the
 * issue's own timings (2025-03-06T17:13:20.835Z) rather than the board's day
 * (2025-03-06). Projecting it from the sprint table produced a list that was
 * both four entries too long and silently re-dated.
 *
 * Ordered by start date, not by name: sprint names sort lexically into
 * nonsense ("Sprint 10" before "Sprint 2") and screens take the first entry as
 * the earliest. Undated sprints go last.
 */
function sprintNames() {
  return db.all(`
    SELECT sprint_name AS name,
           max(sprint_state) AS state,
           max(sprint_start) AS start,
           max(sprint_end)   AS end
      FROM issue_sprint
     WHERE issue_key IN (SELECT key FROM issue WHERE deleted_at IS NULL)
     GROUP BY sprint_name
     ORDER BY (start IS NULL), start, name
  `).map(r => {
    // Same rule as repo.sprintRow: a date key exists only when there is a date.
    const out = { name: r.name, state: r.state };
    if (r.start != null) out.start = r.start;
    if (r.end != null) out.end = r.end;
    return out;
  });
}

/**
 * COLLATE NOCASE, because the list this replaces was sorted case-insensitively
 * and two of his accounts are lowercase ("quyennguyen", "skantamaneni").
 * SQLite's default collation is byte order, which drops both to the bottom.
 */
function people() {
  return db.all('SELECT account_id, name FROM person ORDER BY name COLLATE NOCASE')
    .map(r => ({ name: r.name, accountId: r.account_id }));
}

/** In Jira's own order — see the board `position` column and why it exists. */
function boards() {
  return db.all('SELECT id, name, type FROM board ORDER BY position, id')
    .map(r => ({ id: r.id, name: r.name, type: r.type }));
}

/**
 * Per-team board sprints, in board order.
 *
 * Board order is not date order and is not id order — Jira returns a board's
 * sprints in its own sequence and the team screens show them that way, so the
 * position recorded at sync time is what orders this.
 */
function boardSprintsByTeam() {
  // Seeded for teams that HAVE a board, and only those. Three states, and the
  // team screen tells them apart:
  //
  //   no key at all  — the team is not mapped to a board. Raises the banner.
  //   an empty array — mapped, but the board returned nothing (a Kanban board,
  //                    or one that failed). Reported as a board error, not as
  //                    a missing mapping.
  //   entries        — mapped and read.
  //
  // Seeding every team with [] collapsed the first two, and quietly told an
  // unmapped team it was fine.
  const out = {};
  for (const t of db.all('SELECT id FROM team WHERE board_id IS NOT NULL ORDER BY position, id')) out[t.id] = [];
  for (const r of db.all(`
    SELECT st.team_id, st.position, s.jira_id, s.name, s.state, s.start, s.end
      FROM sprint_team st JOIN sprint s ON s.jira_id = st.jira_id
     ORDER BY st.team_id, st.position
  `)) {
    if (!out[r.team_id]) out[r.team_id] = [];
    out[r.team_id].push({ id: r.jira_id, name: r.name, state: r.state, start: r.start, end: r.end });
  }
  return out;
}

/* ─────────────────────────── plan ─────────────────────────── */

/**
 * The plan shape, rebuilt from the tables.
 *
 * Every key here is something a person authored. If one of them came back
 * empty the tool would quietly lose work that no sync can recreate, which is
 * why the round-trip test compares this against the original plan.json in
 * full rather than checking that the counts agree.
 */
function plan() {
  const s = db.setting.all();

  return {
    version: s['plan.version'] ?? 1,
    updatedAt: s['plan.updatedAt'] ?? null,
    teams: teams(),
    sprints: calendarSprints(),
    holidays: db.all('SELECT date FROM holiday ORDER BY date').map(r => r.date),
    availability: keyed('SELECT team_id, sprint_id, member_id, days FROM availability',
      r => db.fromJson(r.days, [])),
    support: keyed('SELECT team_id, sprint_id, member_id, pct FROM support_pct', r => r.pct),
    ceremony: pairKeyed('SELECT team_id, sprint_id, hours FROM ceremony', r => r.hours),
    overrides: keyed('SELECT team_id, sprint_id, member_id, planned, actual FROM plan_override',
      r => ({ planned: r.planned, actual: r.actual })),
    risks: db.all('SELECT data FROM risk ORDER BY created, id').map(r => db.fromJson(r.data, {})),
    categoryRules: s['plan.categoryRules'] ?? null,
    mixTargets: s['plan.mixTargets'] ?? null,
    componentPriority: s['plan.componentPriority'] ?? {},
    // Components that are not automation suites — engineering buckets that
    // would otherwise sit in the coverage picker looking like untriaged work.
    excludedComponents: s['plan.excludedComponents'] ?? [],
    // An allow-list of Jira Team field values; empty counts every team.
    coverageTeams: s['plan.coverageTeams'] ?? [],
    notes: pairKeyed('SELECT team_id, sprint_id, text FROM plan_note', r => r.text),
    excluded: excluded(),
    sprintRoster: sprintRoster(),
    scenarios: scenarios(),
    ignoredBoards: s['plan.ignoredBoards'] ?? [],
    savedSearches: savedSearches(),
  };
}

/** "teamId|sprintId|memberId" -> value, the shape the capacity grid indexes by. */
function keyed(sql, value) {
  const out = {};
  for (const r of db.all(sql)) out[`${r.team_id}|${r.sprint_id}|${r.member_id}`] = value(r);
  return out;
}

/** "teamId|sprintId" -> value, for the per-sprint things that are not per-person. */
function pairKeyed(sql, value) {
  const out = {};
  for (const r of db.all(sql)) out[`${r.team_id}|${r.sprint_id}`] = value(r);
  return out;
}

function teams() {
  const members = new Map();
  // ORDER BY position: the order they were added, which is the order the
  // capacity grid lists them in. Ordering by name reshuffles every grid.
  for (const m of db.all('SELECT * FROM team_member ORDER BY team_id, position, id')) {
    if (!members.has(m.team_id)) members.set(m.team_id, []);
    const entry = {
      id: m.id,
      name: m.name,
      role: m.role,
      status: m.status,
      supportPct: m.support_pct,
      jiraAccountId: m.jira_account_id,
      source: m.source,
      addedAt: m.added_at,
    };
    const aliases = db.fromJson(m.jira_names, []);
    if (aliases && aliases.length) entry.jiraNames = aliases;
    members.get(m.team_id).push(entry);
  }

  return db.all('SELECT * FROM team ORDER BY position, id').map(t => {
    const out = {
      id: t.id,
      name: t.name,
      jiraName: t.jira_name,
      jiraTeams: db.fromJson(t.jira_teams, []) || [],
      boardId: t.board_id,
      components: db.fromJson(t.components, []) || [],
      sprintKeywords: db.fromJson(t.sprint_keywords, []) || [],
      settings: db.fromJson(t.settings, null),
      source: t.source,
      members: members.get(t.id) || [],
    };
    // Only when set — a team that has never been matched to a board should not
    // grow a `boardName: null` key that the header would then render as empty.
    if (t.board_name != null) out.boardName = t.board_name;
    return out;
  });
}

/**
 * The planning calendar: your sprint numbering, and what each team's real Jira
 * sprint is underneath it.
 *
 * `byTeam` here is a different animal from snapshot.byTeam — this one is the
 * stored mapping from a calendar entry to each team's Jira sprint, authored
 * and synced, not a derived index.
 */
function calendarSprints() {
  const byTeam = new Map();
  for (const r of db.all('SELECT * FROM calendar_sprint_team ORDER BY sprint_id, team_id')) {
    if (!byTeam.has(r.sprint_id)) byTeam.set(r.sprint_id, {});
    byTeam.get(r.sprint_id)[r.team_id] = {
      jiraId: r.jira_id, name: r.name, state: r.state,
      start: r.start, end: r.end, syncedAt: r.synced_at,
    };
  }

  return db.all('SELECT * FROM calendar_sprint ORDER BY position, id').map(s => {
    const out = { id: s.id, number: s.number, name: s.name, start: s.start, end: s.end };
    // `source` and `shared` are present only when they mean something, which is
    // how they were written: `source` is absent on a sprint you created here,
    // and `shared` appears only as false, on the dated TT Week entries that get
    // their own calendar row instead of sharing a numbered one. Emitting
    // `shared: true` on all 45 of the others would make "is this one shared"
    // read differently on every sprint in the calendar.
    if (s.source != null) out.source = s.source;
    if (!s.shared) out.shared = false;
    // A sprint with no team mapping keeps an empty object rather than dropping
    // the key: the capacity screen reads sprint.byTeam[teamId] directly.
    out.byTeam = byTeam.get(s.id) || {};
    return out;
  });
}

function excluded() {
  const out = {};
  for (const r of db.all('SELECT team_id, key FROM team_excluded ORDER BY team_id, position, key')) {
    (out[r.team_id] = out[r.team_id] || []).push(r.key);
  }
  return out;
}

/**
 * "teamId|sprintId" -> { added: [], removed: [] } — the roster decisions.
 *
 * Absent keys are the norm: most sprints need no decision at all, because the
 * derived roster is already right. A key exists only where you changed it.
 */
function sprintRoster() {
  const out = {};
  for (const r of db.all('SELECT * FROM sprint_roster ORDER BY team_id, sprint_id, member_id')) {
    const key = `${r.team_id}|${r.sprint_id}`;
    const entry = out[key] || (out[key] = { added: [], removed: [] });
    if (r.state === 'added' || r.state === 'removed') entry[r.state].push(r.member_id);
    // Only for people you ADDED: a removal needs no name, because whoever it
    // names is already resolvable from the team or from their own work.
    if (r.state === 'added' && (r.name || r.account_id)) {
      (entry.people = entry.people || {})[r.member_id] = { name: r.name, jiraAccountId: r.account_id };
    }
    if (r.reason) (entry.reasons = entry.reasons || {})[r.member_id] = r.reason;
    if (r.at && !entry.at) entry.at = r.at;
  }
  return out;
}

function scenarios() {
  return db.all('SELECT * FROM scenario ORDER BY created_at, id').map(r => ({
    id: r.id, teamId: r.team_id, sprintId: r.sprint_id,
    name: r.name, note: r.note,
    data: db.fromJson(r.data, {}) || {},
    totals: db.fromJson(r.totals, null),
    createdAt: r.created_at, appliedAt: r.applied_at,
  }));
}

function savedSearches() {
  return db.all('SELECT * FROM saved_search ORDER BY saved_at, id').map(r => ({
    id: r.id, name: r.name, query: r.query,
    columns: db.fromJson(r.columns, null),
    sort: r.sort, dir: r.dir,
    matchedWhenSaved: r.matched_when_saved,
    savedAt: r.saved_at,
  }));
}

module.exports = {
  snapshot, plan,
  sprintNames, people, boards, boardSprintsByTeam,
  teams, calendarSprints, excluded, savedSearches, sprintRoster, scenarios,
};
