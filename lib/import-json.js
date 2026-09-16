'use strict';
/**
 * import-json.js — move snapshot.json and plan.json into the database, once.
 *
 * This runs against data that cannot be recreated. The 19 rows of leave grid,
 * the support percentages, the ceremony hours and the exclusion lists took real
 * work and no sync can rebuild any of them. So this module is written to be
 * paranoid in one specific direction: it never transforms what it cannot verify,
 * it reports a count for everything it moves, and it refuses to run over a
 * database that already holds data unless told to.
 *
 * It is deliberately one-way and non-destructive. The JSON files are left
 * exactly where they are — if anything here is wrong, the old files are still
 * the truth and the database can be deleted and rebuilt.
 */

const fs = require('node:fs');
const path = require('node:path');

const db = require('./db');
const repo = require('./repo');

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
};

/**
 * Import a snapshot + plan pair into the open database.
 *
 * @returns a count for every entity moved, for comparison against the source
 */
function importAll({ snapshot, plan, force = false } = {}) {
  const existing = db.get('SELECT count(*) c FROM issue').c
    + db.get('SELECT count(*) c FROM team').c;
  if (existing && !force) {
    throw new Error(`The database already holds ${existing} rows. Pass force to import over it.`);
  }

  const counted = {};
  db.tx(() => {
    if (force) clearImportedTables();
    Object.assign(counted, importSnapshot(snapshot || {}));
    Object.assign(counted, importPlan(plan || {}));
    // Last, because each row references both a sprint and a team and the
    // foreign keys are on: it can only be written once both sides exist.
    Object.assign(counted, linkSprintTeams(snapshot || {}));
  });
  return counted;
}

/** Everything an import owns. Adjustments are NOT here — they are never derived. */
function clearImportedTables() {
  for (const t of [
    'issue_component', 'issue_label', 'issue_sprint', 'issue_link', 'issue',
    'sprint_team', 'sprint', 'board', 'person',
    'calendar_sprint_team', 'calendar_sprint',
    'team_member', 'team_excluded', 'team',
    'availability', 'support_pct', 'ceremony', 'plan_override', 'plan_note',
    'holiday', 'risk', 'saved_search', 'sprint_roster', 'scenario',
  ]) db.run(`DELETE FROM ${t}`);
}

/* ─────────────────────────── snapshot ─────────────────────────── */

function importSnapshot(snap) {
  const out = {};

  const issues = Object.values(snap.issues || {});
  if (issues.length) {
    // protectAdjusted:false — an import runs into an empty database, and there
    // is nothing to protect yet.
    repo.upsertIssues(issues, { protectAdjusted: false, syncedAt: snap.syncedAt || null });
  }
  out.issues = issues.length;

  const boards = snap.boards || [];
  boards.forEach((b, i) => {
    db.run('INSERT OR REPLACE INTO board (id, name, type, position) VALUES (?, ?, ?, ?)',
      String(b.id), b.name || null, b.type || null, i);
  });
  out.boards = boards.length;

  // Board sprints live per team in the snapshot; the same Jira sprint can appear
  // under two teams (J18498 is on both Katalon Automation and Malphite), so the
  // table is keyed by Jira id and the duplicate simply collapses.
  const seen = new Set();
  for (const [, list] of Object.entries(snap.boardSprintsByTeam || {})) {
    for (const s of list || []) {
      if (!s || s.id == null || seen.has(String(s.id))) continue;
      seen.add(String(s.id));
      db.run('INSERT OR REPLACE INTO sprint (jira_id, name, state, start, end, board_id, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        String(s.id), s.name || null, s.state || null, s.start || null, s.end || null, s.boardId || null, snap.syncedAt || null);
    }
  }
  out.sprints = seen.size;

  // NOTE: which team each sprint came from is recorded separately, by
  // linkSprintTeams below, once the teams exist.

  const people = snap.people || [];
  for (const p of people) {
    if (!p) continue;
    const id = p.accountId || p.name;
    if (!id) continue;
    db.run('INSERT OR REPLACE INTO person (account_id, name) VALUES (?, ?)', String(id), p.name || null);
  }
  out.people = people.length;

  // The bits of the snapshot that are settings rather than entities.
  //
  // `byTeam` is in this list and must stay in it. It is the reconcile index —
  // derived, but expensive, and rebuilt only when a sync or an explicit
  // reconcile runs. An import that dropped it produced a database where every
  // team screen showed zero sprints, zero backlog and no metrics, against
  // 7,269 issues that were all present. That exact failure has already happened
  // once in this project, from the same cause.
  for (const key of ['syncedAt', 'watermark', 'source', 'verification', 'fields',
    'testops', 'github', 'extraFields', 'boardSprintErrors', 'components',
    'byTeam', 'clearedAt']) {
    if (snap[key] !== undefined) db.setting.set(`snapshot.${key}`, snap[key]);
  }
  return out;
}

/* ─────────────────────────── plan ─────────────────────────── */

function importPlan(plan) {
  const out = {};

  const teams = plan.teams || [];
  teams.forEach((t, i) => {
    db.run(`INSERT OR REPLACE INTO team
      (id, name, jira_name, board_id, board_name, settings, components, sprint_keywords, jira_teams, source, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id, t.name || t.id, t.jiraName || null, t.boardId ? String(t.boardId) : null, t.boardName || null,
      db.toJson(t.settings || null), db.toJson(t.components || []),
      db.toJson(t.sprintKeywords || []), db.toJson(t.jiraTeams || []),
      t.source || 'jira', i);

    // `position` preserves the order members were added in, which is the order
    // every capacity grid shows them in. Sorting by name reorders his rows.
    (t.members || []).forEach((m, mi) => {
      db.run(`INSERT OR REPLACE INTO team_member
        (id, team_id, name, role, status, support_pct, jira_account_id, jira_names, source, added_at, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.id, t.id, m.name, m.role || null, m.status || 'Active',
        Number(m.supportPct) || 0, m.jiraAccountId || null, db.toJson(m.jiraNames || []),
        m.source || m.addedFrom || 'jira', m.addedAt || null, mi);
    });
  });
  out.teams = teams.length;
  out.members = teams.reduce((n, t) => n + (t.members || []).length, 0);

  // Exclusions encode a decision ("Titan has had 3 people since Sprint 38").
  let excluded = 0;
  for (const [teamId, keys] of Object.entries(plan.excluded || {})) {
    (keys || []).forEach((k, i) => {
      db.run('INSERT OR IGNORE INTO team_excluded (team_id, key, position) VALUES (?, ?, ?)', teamId, String(k), i);
      excluded++;
    });
  }
  out.excluded = excluded;

  const sprints = plan.sprints || [];
  sprints.forEach((s, i) => {
    db.run(`INSERT OR REPLACE INTO calendar_sprint (id, number, name, start, end, source, shared, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      s.id, s.number == null ? null : Number(s.number), s.name || null,
      s.start || null, s.end || null, s.source || null, s.shared === false ? 0 : 1, i);
    for (const [teamId, t] of Object.entries(s.byTeam || {})) {
      if (!t) continue;
      db.run(`INSERT OR REPLACE INTO calendar_sprint_team
        (sprint_id, team_id, jira_id, name, state, start, end, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        s.id, teamId, t.jiraId ? String(t.jiraId) : null, t.name || null,
        t.state || null, t.start || null, t.end || null, t.syncedAt || null);
    }
  });
  out.calendarSprints = sprints.length;

  // ── the irreplaceable half ──────────────────────────────────────────────
  out.availability = keyed(plan.availability, (team, sprint, member, v) =>
    db.run('INSERT OR REPLACE INTO availability VALUES (?, ?, ?, ?)', team, sprint, member, db.toJson(v)));

  out.support = keyed(plan.support, (team, sprint, member, v) =>
    db.run('INSERT OR REPLACE INTO support_pct VALUES (?, ?, ?, ?)', team, sprint, member, Number(v) || 0));

  let ceremony = 0;
  for (const [key, v] of Object.entries(plan.ceremony || {})) {
    const [team, sprint] = String(key).split('|');
    if (!team || !sprint) continue;
    db.run('INSERT OR REPLACE INTO ceremony VALUES (?, ?, ?)', team, sprint, Number(v) || 0);
    ceremony++;
  }
  out.ceremony = ceremony;

  out.overrides = keyed(plan.overrides, (team, sprint, member, v) =>
    db.run('INSERT OR REPLACE INTO plan_override VALUES (?, ?, ?, ?, ?)',
      team, sprint, member, v && v.planned != null ? Number(v.planned) : null,
      v && v.actual != null ? Number(v.actual) : null));

  let notes = 0;
  for (const [key, v] of Object.entries(plan.notes || {})) {
    const [team, sprint] = String(key).split('|');
    if (!team || !sprint) continue;
    db.run('INSERT OR REPLACE INTO plan_note VALUES (?, ?, ?)', team, sprint, String(v));
    notes++;
  }
  out.notes = notes;

  for (const d of plan.holidays || []) db.run('INSERT OR IGNORE INTO holiday VALUES (?)', d);
  out.holidays = (plan.holidays || []).length;

  (plan.risks || []).forEach((r, i) => {
    db.run('INSERT OR REPLACE INTO risk (id, data, created) VALUES (?, ?, ?)',
      r.id || `risk-${i}`, db.toJson(r), r.created || null);
  });
  out.risks = (plan.risks || []).length;

  for (const s of plan.savedSearches || []) {
    db.run(`INSERT OR REPLACE INTO saved_search (id, name, query, columns, sort, dir, matched_when_saved, saved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      s.id, s.name, s.query || '', db.toJson(s.columns || null), s.sort || null, s.dir || null,
      s.matchedWhenSaved == null ? null : Number(s.matchedWhenSaved), s.savedAt || null);
  }
  out.savedSearches = (plan.savedSearches || []).length;

  // Per-sprint roster decisions: who you put on a sprint and who you took off.
  let rosterRows = 0;
  for (const [key, entry] of Object.entries(plan.sprintRoster || {})) {
    const [teamId, sprintId] = String(key).split('|');
    if (!teamId || !sprintId || !entry) continue;
    for (const state of ['added', 'removed']) {
      for (const memberId of entry[state] || []) {
        const who = (entry.people || {})[memberId] || {};
        db.run(`INSERT OR REPLACE INTO sprint_roster (team_id, sprint_id, member_id, state, name, account_id, reason, at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          teamId, sprintId, String(memberId), state,
          who.name || null, who.jiraAccountId || null,
          (entry.reasons || {})[memberId] || null, entry.at || null);
        rosterRows++;
      }
    }
  }
  out.sprintRoster = rosterRows;

  const scenarios = plan.scenarios || [];
  for (const sc of scenarios) {
    if (!sc || !sc.id) continue;
    db.run(`INSERT OR REPLACE INTO scenario (id, team_id, sprint_id, name, note, data, totals, created_at, applied_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sc.id, sc.teamId, sc.sprintId, sc.name || 'Untitled', sc.note || null,
      db.toJson(sc.data || {}), db.toJson(sc.totals || null), sc.createdAt || null, sc.appliedAt || null);
  }
  out.scenarios = scenarios.length;

  // Plan-level settings that are one blob each.
  for (const key of ['categoryRules', 'mixTargets', 'componentPriority', 'ignoredBoards', 'version', 'updatedAt']) {
    if (plan[key] !== undefined) db.setting.set(`plan.${key}`, plan[key]);
  }
  return out;
}

/** The `team|sprint|member` key shape used by every planning map. */
function keyed(map, write) {
  let n = 0;
  for (const [key, v] of Object.entries(map || {})) {
    const [team, sprint, member] = String(key).split('|');
    if (!team || !sprint || !member) continue;
    write(team, sprint, member, v);
    n++;
  }
  return n;
}

/* ──────────────────────── sprints ↔ teams ──────────────────────── */

/**
 * Record which team's board each Jira sprint was read from.
 *
 * `snapshot.boardSprintsByTeam` is the only place that mapping exists, and it
 * is what fills the sprint picker on every team screen. It is a separate pass
 * rather than part of the sprint insert above because the foreign keys are on
 * and the teams do not exist yet at that point.
 *
 * A team in the snapshot with no matching team row is skipped rather than
 * failing the import — that happens when a team was deleted from the plan and
 * its board sprints are still sitting in an old snapshot.
 */
function linkSprintTeams(snap) {
  const teams = new Set(db.all('SELECT id FROM team').map(r => r.id));
  const sprints = new Set(db.all('SELECT jira_id FROM sprint').map(r => r.jira_id));
  let n = 0;
  for (const [teamId, list] of Object.entries(snap.boardSprintsByTeam || {})) {
    if (!teams.has(teamId)) continue;
    (list || []).forEach((s, i) => {
      if (!s || s.id == null || !sprints.has(String(s.id))) return;
      db.run('INSERT OR REPLACE INTO sprint_team (jira_id, team_id, position) VALUES (?, ?, ?)',
        String(s.id), teamId, i);
      n++;
    });
  }
  return { sprintTeamLinks: n };
}

/* ─────────────────────────── verification ─────────────────────────── */

/**
 * Compare what is in the database against the JSON it came from.
 *
 * Not a formality. The planning rows are the ones that cannot be rebuilt, so
 * the import is not "done" until a count-for-count comparison says so, and the
 * caller can refuse to switch over if anything is short.
 */
function verify({ snapshot, plan }) {
  const rows = [];
  const add = (what, expected, actual) => rows.push({ what, expected, actual, ok: expected === actual });

  add('issues', Object.keys((snapshot || {}).issues || {}).length, db.get('SELECT count(*) c FROM issue').c);
  add('teams', ((plan || {}).teams || []).length, db.get('SELECT count(*) c FROM team').c);
  add('members', ((plan || {}).teams || []).reduce((n, t) => n + (t.members || []).length, 0),
    db.get('SELECT count(*) c FROM team_member').c);
  add('calendar sprints', ((plan || {}).sprints || []).length, db.get('SELECT count(*) c FROM calendar_sprint').c);
  add('availability (the leave grid)', Object.keys((plan || {}).availability || {}).length,
    db.get('SELECT count(*) c FROM availability').c);
  add('support %', Object.keys((plan || {}).support || {}).length, db.get('SELECT count(*) c FROM support_pct').c);
  add('ceremony hours', Object.keys((plan || {}).ceremony || {}).length, db.get('SELECT count(*) c FROM ceremony').c);
  add('holidays', ((plan || {}).holidays || []).length, db.get('SELECT count(*) c FROM holiday').c);
  add('exclusions', Object.values((plan || {}).excluded || {}).reduce((n, v) => n + (v || []).length, 0),
    db.get('SELECT count(*) c FROM team_excluded').c);
  // Every board sprint that belongs to a team the plan still has. Snapshots
  // outlive teams, so entries for a deleted team are not expected back.
  const liveTeams = new Set(((plan || {}).teams || []).map(t => t.id));
  add('team sprint links', Object.entries((snapshot || {}).boardSprintsByTeam || {})
    .filter(([id]) => liveTeams.has(id))
    .reduce((n, [, v]) => n + (v || []).length, 0),
  db.get('SELECT count(*) c FROM sprint_team').c);
  add('sprint roster decisions', Object.values((plan || {}).sprintRoster || {})
    .reduce((n, e) => n + ((e || {}).added || []).length + ((e || {}).removed || []).length, 0),
  db.get('SELECT count(*) c FROM sprint_roster').c);
  add('saved scenarios', ((plan || {}).scenarios || []).length, db.get('SELECT count(*) c FROM scenario').c);
  add('risks', ((plan || {}).risks || []).length, db.get('SELECT count(*) c FROM risk').c);
  add('saved searches', ((plan || {}).savedSearches || []).length, db.get('SELECT count(*) c FROM saved_search').c);

  return { rows, ok: rows.every(r => r.ok), short: rows.filter(r => !r.ok) };
}

/** Import straight from the store directory's JSON files, if they are there. */
function importFromFiles(dir = db.STORE_DIR, opts = {}) {
  const snapshot = readJson(path.join(dir, 'snapshot.json'));
  const plan = readJson(path.join(dir, 'plan.json'));
  if (!snapshot && !plan) return { imported: false, reason: 'No snapshot.json or plan.json to import.' };
  const counts = importAll({ snapshot, plan, ...opts });
  const check = verify({ snapshot, plan });
  return { imported: true, counts, verification: check };
}

module.exports = { importAll, importFromFiles, verify, importSnapshot, importPlan, linkSprintTeams };
