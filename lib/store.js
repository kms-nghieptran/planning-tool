'use strict';
/**
 * store.js — the one door to stored state.
 *
 * WHAT CHANGED, AND WHY THIS FILE STILL LOOKS FAMILIAR
 *
 * This used to be two JSON files. It is now a SQLite database, and this module
 * is the seam: `getSnapshot`, `getPlan`, `saveSnapshot` and `savePlan` still
 * take and return the same objects, so the 89 call sites above did not have to
 * change on the same day the storage engine did.
 *
 * Still deliberately separate, now as sets of tables rather than files:
 *   the SNAPSHOT — mirror of external systems (Jira/TestOps/GitHub). Rebuilt by sync.
 *   the PLAN     — what YOU author (teams, members, sprints, availability, risks,
 *                  settings, overrides). Never overwritten by a sync.
 *
 * Three things the database gives this seam that files could not:
 *
 *   Reads are cheap. Parsing 8.9MB of JSON on every request cost 369ms; the
 *   projection is cached here and invalidated on write, and the queries behind
 *   it are indexed.
 *
 *   Writes are transactional. A save that fails partway leaves nothing behind,
 *   rather than a half-written file and three rolling backups to pick through.
 *
 *   Your edits are first-class. An adjusted field survives a sync, and the
 *   database remembers what Jira said so the drift stays visible.
 *
 * THE JSON FILES ARE STILL THERE and are still read — once. The first time this
 * runs against an empty database it imports them and says so. Nothing deletes
 * them. If any of this is wrong, they are still the truth.
 */

const fs = require('fs');
const path = require('path');

const db = require('./db');
const project = require('./project');
const persist = require('./persist');
const importJson = require('./import-json');

const ROOT = process.env.STORE_DIR || path.join(__dirname, '..', 'data');
const STORE_DIR = path.join(ROOT, 'store');
const SNAPSHOT = path.join(STORE_DIR, 'snapshot.json');
const PLAN = path.join(STORE_DIR, 'plan.json');
const AUDIT = path.join(ROOT, 'audit.log');

function ensureDirs() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // Corrupt file: try the newest backup rather than losing everything.
    for (let i = 1; i <= 3; i++) {
      try { return JSON.parse(fs.readFileSync(`${file}.bak${i}`, 'utf8')); } catch (_) { /* next */ }
    }
    throw new Error(`${path.basename(file)} is unreadable and no backup survived: ${err.message}`);
  }
}

function writeJson(file, data) {
  ensureDirs();
  // rotate backups 2->3, 1->2, current->1
  for (let i = 3; i > 1; i--) {
    try { fs.copyFileSync(`${file}.bak${i - 1}`, `${file}.bak${i}`); } catch (_) { /* none yet */ }
  }
  try { fs.copyFileSync(file, `${file}.bak1`); } catch (_) { /* first write */ }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  return data;
}

// The empty-snapshot shape now lives in project.snapshot(), which produces it
// from an empty database with the same defaults — one definition rather than a
// constant here that has to be kept in step with the projection.

function emptyPlan() {
  return {
    version: 1,
    updatedAt: null,
    teams: [],
    sprints: [],
    availability: {},        // "teamId|sprintId|memberId" -> [14 cells]
    holidays: [],            // ISO dates, applied to every team
    overrides: {},           // "teamId|sprintId|memberId" -> { planned, actual }  (manual mode)
    risks: [],
    categoryRules: null,     // null = use classify.DEFAULT_RULES
    mixTargets: null,
    componentPriority: {},   // component -> 1..4, his judgement, never touched by a sync
    notes: {},               // "teamId|sprintId" -> free text sprint goal / commentary
  };
}

/* ──────────────────── first run: bring the JSON across ──────────────────── */

let migrated = null;   // { imported, counts, verification } once we have looked

/**
 * Move the JSON files into the database, once, the first time the app opens on
 * an empty one.
 *
 * Automatic on purpose. The alternative is a button, and a button means the
 * tool opens once showing nothing, which reads as "it lost my data" — the exact
 * feeling this whole change exists to remove.
 *
 * Safe to be automatic because of what it will not do: it refuses to run over a
 * database that already holds rows, it never writes to the JSON files, and it
 * verifies itself count-for-count. If the verification comes up short the
 * result is kept and reported rather than swallowed.
 */
function ensureMigrated() {
  if (migrated) return migrated;

  const hasRows = db.get('SELECT count(*) c FROM issue').c + db.get('SELECT count(*) c FROM team').c;
  if (hasRows) return (migrated = { imported: false, reason: 'already migrated' });

  const snapshot = readJson(SNAPSHOT, null);
  const plan = readJson(PLAN, null) || seedPlan();
  if (!snapshot && !plan) return (migrated = { imported: false, reason: 'nothing to import' });

  const counts = importJson.importAll({ snapshot, plan });
  migrated = { imported: true, counts, verification: importJson.verify({ snapshot, plan }), at: new Date().toISOString() };
  audit('store.migrated', migrated);
  return migrated;
}

/** The bundled starting setup, for a genuinely first run with no plan at all. */
function seedPlan() {
  // The seed ships WITH THE APP, so look beside the code as well as under
  // STORE_DIR — pointing STORE_DIR elsewhere used to produce a plan with zero
  // teams.
  const seedFile = [
    path.join(ROOT, 'seed', 'plan.seed.json'),
    path.join(__dirname, '..', 'data', 'seed', 'plan.seed.json'),
  ].find(f => fs.existsSync(f));
  try {
    const seeded = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    seeded.updatedAt = new Date().toISOString();
    return seeded;
  } catch (_) {
    return emptyPlan();
  }
}

/* ─────────────────────────── read and write ─────────────────────────── */

/**
 * The projection is cached because a page load asks for it several times and
 * rebuilding 7,269 issues per call would trade one slow read for four.
 *
 * Invalidation is blunt — any write drops both — which is right here: the
 * writes are whole-object saves, they are rare compared to reads, and a subtle
 * cache is how a screen ends up showing a number the database no longer holds.
 */
let cache = { snapshot: null, plan: null };
const invalidate = () => { cache = { snapshot: null, plan: null }; };

function getSnapshot() {
  ensureMigrated();
  if (!cache.snapshot) cache.snapshot = project.snapshot();
  return cache.snapshot;
}

function saveSnapshot(s) {
  ensureMigrated();
  persist.saveSnapshot(s);
  invalidate();
  return s;
}

function getPlan() {
  ensureMigrated();
  if (!cache.plan) cache.plan = project.plan();
  return cache.plan;
}

/**
 * Save the plan — to the database, and to plan.json as well.
 *
 * The file is no longer what the app reads. It is kept current as an escape
 * hatch, with the same rolling backups it always had, and the asymmetry with
 * the snapshot is deliberate:
 *
 *   THE PLAN is 83KB and irreplaceable. Nineteen rows of leave grid, the
 *   support percentages, the exclusion lists — no sync can rebuild any of it.
 *   Mirroring it costs nothing measurable and means a database that is somehow
 *   lost or unreadable costs a re-import, not the work.
 *
 *   THE SNAPSHOT is 8.9MB and entirely rebuildable from Jira. Writing it on
 *   every sync is most of the cost this change exists to remove, so it is not
 *   mirrored at all.
 *
 * A failure to write the mirror never fails the save: the database is the
 * record, and a full disk should not lose you a plan it already committed.
 */
function savePlan(p) {
  ensureMigrated();
  p.updatedAt = new Date().toISOString();
  persist.savePlan(p);
  invalidate();
  try { writeJson(PLAN, p); } catch (err) { audit('store.mirror.failed', { error: err.message }); }
  return p;
}

/** Migration status, for the Data sources screen. */
function migrationStatus() { return migrated; }

/**
 * A permanent, named copy of the plan — for operations you cannot undo.
 *
 * The rolling `.bak1..3` files are the wrong safety net here: they exist to
 * survive a corrupt write, and three ordinary saves after a destructive
 * operation rotate the good copy out. This one is timestamped, never rotated,
 * and returns its path so the caller can tell the user where it is.
 */
function backupPlan(label = 'manual') {
  ensureDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(STORE_DIR, `plan.${label}.${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(getPlan(), null, 2));
  return file;
}

function audit(action, detail) {
  ensureDirs();
  const line = JSON.stringify({ at: new Date().toISOString(), action, detail }) + '\n';
  try { fs.appendFileSync(AUDIT, line); } catch (_) { /* audit must never break the app */ }
}

function readAudit(limit = 200) {
  try {
    return fs.readFileSync(AUDIT, 'utf8').trim().split('\n').slice(-limit).reverse()
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

module.exports = {
  ROOT, STORE_DIR, SNAPSHOT, PLAN,
  ensureDirs, getSnapshot, saveSnapshot, getPlan, savePlan, backupPlan, emptyPlan,
  audit, readAudit, writeJson, readJson,
  ensureMigrated, migrationStatus, invalidate,
};
