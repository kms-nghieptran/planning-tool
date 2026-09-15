'use strict';
/**
 * persist.js — write a whole snapshot or plan object back into the database.
 *
 * The inverse of project.js, and deliberately the ONLY writer of whole objects.
 * The app has always saved by handing over a complete snapshot or plan, and
 * changing all 31 of those call sites at the same time as changing the storage
 * engine would mean two migrations at once with nothing to bisect.
 *
 * So the semantics here match what overwriting a JSON file used to do: what you
 * pass in becomes what is stored. With two differences that matter, both in the
 * direction of losing less:
 *
 *   ISSUES ARE NEVER DELETED. An issue absent from the snapshot you save is
 *   marked deleted, not removed. A board reconfigured for an afternoon used to
 *   take your adjustments with it.
 *
 *   ADJUSTED FIELDS ARE NEVER OVERWRITTEN. `upsertIssues` protects them and
 *   records what Jira now says alongside, so the drift stays visible.
 *
 * The plan has no such overlay: it is yours already, and saving it means
 * exactly what it says.
 */

const db = require('./db');
const repo = require('./repo');
const importJson = require('./import-json');

/* ─────────────────────────── snapshot ─────────────────────────── */

/**
 * Store a complete snapshot.
 *
 * @param snap the whole snapshot object, as the app has always passed it
 */
function saveSnapshot(snap = {}) {
  return db.tx(() => {
    const syncedAt = snap.syncedAt || new Date().toISOString();

    // Issues: upsert the ones present, soft-delete the ones that are not.
    //
    // `issues` being absent and `issues` being empty are DIFFERENT. A caller
    // that passes `{ issues: {} }` is clearing the store on purpose (the reset
    // does exactly this); a caller that passes an object with no `issues` key
    // is updating something else — TestOps, GitHub — and must not wipe 7,269
    // rows as a side effect.
    if (snap.issues) {
      const list = Object.values(snap.issues);
      if (list.length) repo.upsertIssues(list, { protectAdjusted: true, syncedAt });
      const keep = new Set(Object.keys(snap.issues));
      const gone = db.all('SELECT key FROM issue WHERE deleted_at IS NULL')
        .map(r => r.key).filter(k => !keep.has(k));
      if (gone.length) repo.softDeleteIssues(gone);
      // An issue that is back is no longer deleted.
      if (keep.size) {
        const marks = [...keep].map(() => '?').join(',');
        db.run(`UPDATE issue SET deleted_at = NULL WHERE deleted_at IS NOT NULL AND key IN (${marks})`, ...keep);
      }
    }

    if (snap.boards) {
      db.run('DELETE FROM board');
      snap.boards.forEach((b, i) => db.run(
        'INSERT OR REPLACE INTO board (id, name, type, position) VALUES (?, ?, ?, ?)',
        String(b.id), b.name || null, b.type || null, i));
    }

    if (snap.boardSprintsByTeam) {
      // sprint_team cascades from sprint, so the links go first and are then
      // rebuilt from the object being saved.
      db.run('DELETE FROM sprint_team');
      db.run('DELETE FROM sprint');
      const seen = new Set();
      for (const list of Object.values(snap.boardSprintsByTeam)) {
        for (const s of list || []) {
          if (!s || s.id == null || seen.has(String(s.id))) continue;
          seen.add(String(s.id));
          db.run(`INSERT OR REPLACE INTO sprint (jira_id, name, state, start, end, board_id, synced_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            String(s.id), s.name || null, s.state || null, s.start || null, s.end || null,
            s.boardId || null, syncedAt);
        }
      }
      importJson.linkSprintTeams(snap);
    }

    if (snap.people) {
      db.run('DELETE FROM person');
      for (const p of snap.people) {
        const id = p && (p.accountId || p.name);
        if (!id) continue;
        db.run('INSERT OR REPLACE INTO person (account_id, name) VALUES (?, ?)', String(id), p.name || null);
      }
    }

    // The parts of a snapshot that are one blob each, including `byTeam` — the
    // reconcile index. It is derived, but it is derived expensively and the
    // server rebuilds it explicitly and then saves it; dropping it here is what
    // made every team screen show zero sprints once before.
    for (const key of ['syncedAt', 'watermark', 'source', 'verification', 'fields', 'testops',
      'github', 'extraFields', 'boardSprintErrors', 'components', 'byTeam', 'clearedAt']) {
      if (snap[key] !== undefined) db.setting.set(`snapshot.${key}`, snap[key]);
    }
    return snap;
  });
}

/* ─────────────────────────── plan ─────────────────────────── */

/** Tables that hold the plan and nothing else. */
const PLAN_TABLES = [
  'calendar_sprint_team', 'calendar_sprint',
  'team_member', 'team_excluded', 'team',
  'availability', 'support_pct', 'ceremony', 'plan_override', 'plan_note',
  'holiday', 'risk', 'saved_search',
  'sprint_roster', 'scenario',
];

/**
 * Store a complete plan.
 *
 * Replace-in-a-transaction rather than diff-and-patch. A plan is 83KB and the
 * whole thing arrives on every save, so working out which of 19 leave-grid
 * cells changed would be more code, slower to read, and would fail in the one
 * direction that matters — a removal it failed to notice would be a row that
 * silently came back.
 *
 * `sprint_team` has a foreign key to `team`, so it is cleared alongside and
 * rebuilt from the board sprints already in the snapshot tables; without that
 * a plan save would either fail on the constraint or drop the per-team sprint
 * lists on the floor.
 */
function savePlan(plan = {}) {
  return db.tx(() => {
    const links = db.all('SELECT jira_id, team_id, position FROM sprint_team');
    db.run('DELETE FROM sprint_team');
    for (const t of PLAN_TABLES) db.run(`DELETE FROM ${t}`);

    importJson.importPlan({ ...plan, updatedAt: plan.updatedAt || new Date().toISOString() });

    const teams = new Set(db.all('SELECT id FROM team').map(r => r.id));
    for (const l of links) {
      if (!teams.has(l.team_id)) continue;   // the team was just removed
      db.run('INSERT OR REPLACE INTO sprint_team (jira_id, team_id, position) VALUES (?, ?, ?)',
        l.jira_id, l.team_id, l.position);
    }
    return plan;
  });
}

module.exports = { saveSnapshot, savePlan, PLAN_TABLES };
