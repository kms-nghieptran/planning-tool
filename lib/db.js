'use strict';
/**
 * db.js — the local database. This is the system of record, not a cache of Jira.
 *
 * WHY THIS EXISTS. The tool used to keep everything in one snapshot.json: an
 * 8.9 MB blob parsed on every request (369 ms of his real data), rewritten whole
 * on every sync, with no transactions and no indexes beyond one hand-built map.
 * That is a cache. What the work actually needs is a database you plan against:
 * structured, queryable, and — crucially — one where YOUR edits are first-class
 * rather than a side table of string keys.
 *
 * WHY node:sqlite. Real SQL, real indexes, real transactions, one portable file,
 * and still ZERO dependencies because it ships inside Node. It is marked
 * experimental in Node 22, which is a real caveat and stated in the README: it
 * prints a warning and the API could change. Everything SQLite-specific is
 * confined to this file so that, if it ever has to move, one file moves.
 *
 * THE CENTRAL DESIGN DECISION — how a local adjustment is stored:
 *
 *   The entity row holds the EFFECTIVE value. The `adjustment` table holds the
 *   provenance: the original Jira value, when it was changed, and why.
 *
 * The obvious alternative — keep Jira's value in the row and overlay edits when
 * reading — breaks the moment anything aggregates in SQL, because SUM() would
 * quietly total the un-adjusted numbers while the screen showed adjusted ones.
 * Two different answers to the same question is worse than either. So the row is
 * always what the tool believes, every query and every aggregate agrees, and
 * `adjustment` answers "what did Jira say, and who overrode it?" — which is a
 * different question, asked far less often.
 *
 * The rule that makes it safe: A SYNC MAY NEVER OVERWRITE AN ADJUSTED FIELD.
 */

const fs = require('node:fs');
const path = require('node:path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  throw new Error(
    'This build of Node has no node:sqlite. The planning tool needs Node 22.5 or newer '
    + `(this is ${process.version}). Original error: ${err.message}`,
  );
}

const ROOT = process.env.STORE_DIR || path.join(__dirname, '..', 'data');
const STORE_DIR = path.join(ROOT, 'store');
/**
 * Where the database lives. Deliberately a `let`, not a `const`: `openAt()`
 * changes it at runtime. The first version of this line was a const read from
 * the environment once at require time, so `openAt()` silently did nothing —
 * the tests and the JSON migration both wrote into the real store file sitting
 * next to live data. Anything that needs the path reads `dbFile()`; nothing
 * captures it into a local at module load.
 */
let DB_FILE = process.env.DB_FILE || path.join(STORE_DIR, 'planning.db');
const dbFile = () => DB_FILE;

/* ─────────────────────────── schema ─────────────────────────── */

/**
 * Migrations, applied in order and recorded, so an existing database upgrades
 * itself rather than needing to be rebuilt. Never edit a migration that has
 * shipped — append a new one.
 */
const MIGRATIONS = [
  {
    version: 1,
    name: 'core',
    sql: `
    /* ── what Jira told us, as the tool now believes it ──────────────────
       points is REAL and NULLABLE on purpose: null means "no estimate",
       0 means "estimated at zero", and conflating them is the bug that made
       every velocity figure in this tool read wrong for a week. */
    CREATE TABLE issue (
      key               TEXT PRIMARY KEY,
      project           TEXT,
      summary           TEXT,
      issue_type        TEXT,
      status            TEXT,
      status_category   TEXT,
      resolution        TEXT,
      priority          TEXT,
      assignee          TEXT,
      assignee_id       TEXT,
      reporter          TEXT,
      points            REAL,
      parent_key        TEXT,
      parent_status     TEXT,
      team              TEXT,
      automation_status TEXT,
      created           TEXT,
      updated           TEXT,
      resolved          TEXT,
      due_date          TEXT,
      original_estimate REAL,
      time_spent        REAL,
      extra             TEXT,          -- JSON: the extra fields you chose to sync
      raw               TEXT,          -- JSON: everything else, when syncing all fields
      datasets          TEXT,          -- JSON: which sync queries matched it
      source            TEXT NOT NULL DEFAULT 'jira',   -- 'jira' | 'local'
      synced_at         TEXT,
      deleted_at        TEXT           -- soft delete: a sync that loses sight of an issue never destroys your edits
    );
    CREATE INDEX idx_issue_type     ON issue(issue_type);
    CREATE INDEX idx_issue_status   ON issue(status_category);
    CREATE INDEX idx_issue_assignee ON issue(assignee_id);
    CREATE INDEX idx_issue_team     ON issue(team);
    CREATE INDEX idx_issue_updated  ON issue(updated);
    CREATE INDEX idx_issue_parent   ON issue(parent_key);
    CREATE INDEX idx_issue_live     ON issue(deleted_at);

    /* Many-to-many, because an issue really does carry several of each and
       a LIKE over a joined string is how you get PS_iGO matching PS_iGO_NLG. */
    CREATE TABLE issue_component (
      issue_key TEXT NOT NULL REFERENCES issue(key) ON DELETE CASCADE,
      component TEXT NOT NULL,
      PRIMARY KEY (issue_key, component)
    );
    CREATE INDEX idx_component ON issue_component(component);

    CREATE TABLE issue_label (
      issue_key TEXT NOT NULL REFERENCES issue(key) ON DELETE CASCADE,
      label     TEXT NOT NULL,
      PRIMARY KEY (issue_key, label)
    );
    CREATE INDEX idx_label ON issue_label(label);

    /* An issue can sit in several sprints over its life; sprint_jira_id may be
       null because this Jira returns sprint NAMES with no ids on the issue. */
    CREATE TABLE issue_sprint (
      issue_key      TEXT NOT NULL REFERENCES issue(key) ON DELETE CASCADE,
      sprint_jira_id TEXT,
      sprint_name    TEXT NOT NULL,
      sprint_state   TEXT,
      PRIMARY KEY (issue_key, sprint_name)
    );
    CREATE INDEX idx_issue_sprint_id   ON issue_sprint(sprint_jira_id);
    CREATE INDEX idx_issue_sprint_name ON issue_sprint(sprint_name);

    CREATE TABLE issue_link (
      issue_key TEXT NOT NULL REFERENCES issue(key) ON DELETE CASCADE,
      other_key TEXT NOT NULL,
      kind      TEXT NOT NULL DEFAULT 'blockedBy',
      PRIMARY KEY (issue_key, other_key, kind)
    );

    /* ── Jira's own objects ─────────────────────────────────────────────── */
    CREATE TABLE board (
      id   TEXT PRIMARY KEY,
      name TEXT,
      type TEXT
    );

    CREATE TABLE sprint (
      jira_id   TEXT PRIMARY KEY,
      name      TEXT,
      state     TEXT,
      start     TEXT,
      end       TEXT,
      board_id  TEXT,
      synced_at TEXT
    );
    CREATE INDEX idx_sprint_board ON sprint(board_id);
    CREATE INDEX idx_sprint_state ON sprint(state);

    CREATE TABLE person (
      account_id TEXT PRIMARY KEY,
      name       TEXT
    );

    /* ── the local domain: teams and the sprint calendar ────────────────── */
    CREATE TABLE team (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      jira_name       TEXT,
      board_id        TEXT,
      settings        TEXT,      -- JSON: hoursPerDay, hoursPerPoint, ceremonyHours…
      components      TEXT,      -- JSON
      sprint_keywords TEXT,      -- JSON
      jira_teams      TEXT,      -- JSON
      source          TEXT DEFAULT 'jira',
      position        INTEGER DEFAULT 0
    );

    CREATE TABLE team_member (
      id               TEXT PRIMARY KEY,
      team_id          TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
      name             TEXT NOT NULL,
      role             TEXT,
      status           TEXT DEFAULT 'Active',
      support_pct      REAL DEFAULT 0,
      jira_account_id  TEXT,
      jira_names       TEXT,     -- JSON aliases
      source           TEXT DEFAULT 'jira',
      added_at         TEXT
    );
    CREATE INDEX idx_member_team ON team_member(team_id);

    /* A person you removed on purpose. Survives every sync and every cleanup. */
    CREATE TABLE team_excluded (
      team_id TEXT NOT NULL,
      key     TEXT NOT NULL,     -- accountId (preferred) or name
      PRIMARY KEY (team_id, key)
    );

    /* The shared calendar: S39 for numbered sprints, J<jiraId> for the
       date-named TrueTest weeks that have no number to share. */
    CREATE TABLE calendar_sprint (
      id       TEXT PRIMARY KEY,
      number   INTEGER,
      name     TEXT,
      start    TEXT,
      end      TEXT,
      source   TEXT,
      shared   INTEGER DEFAULT 1,
      position INTEGER DEFAULT 0
    );
    CREATE INDEX idx_cal_start ON calendar_sprint(start);

    /* Each team's own dates and state for that calendar entry — Ruby's Sprint 40
       and Titan's Sprint 40 are different Jira sprints that merely line up. */
    CREATE TABLE calendar_sprint_team (
      sprint_id TEXT NOT NULL REFERENCES calendar_sprint(id) ON DELETE CASCADE,
      team_id   TEXT NOT NULL,
      jira_id   TEXT,
      name      TEXT,
      state     TEXT,
      start     TEXT,
      end       TEXT,
      synced_at TEXT,
      PRIMARY KEY (sprint_id, team_id)
    );
    CREATE INDEX idx_cst_team ON calendar_sprint_team(team_id);

    /* ── planning data: yours, and nothing else can supply it ───────────── */
    CREATE TABLE availability (
      team_id   TEXT NOT NULL,
      sprint_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      days      TEXT NOT NULL,    -- JSON array of day codes
      PRIMARY KEY (team_id, sprint_id, member_id)
    );

    CREATE TABLE support_pct (
      team_id   TEXT NOT NULL,
      sprint_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      pct       REAL NOT NULL,
      PRIMARY KEY (team_id, sprint_id, member_id)
    );

    CREATE TABLE ceremony (
      team_id   TEXT NOT NULL,
      sprint_id TEXT NOT NULL,
      hours     REAL NOT NULL,
      PRIMARY KEY (team_id, sprint_id)
    );

    CREATE TABLE plan_override (
      team_id   TEXT NOT NULL,
      sprint_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      planned   REAL,
      actual    REAL,
      PRIMARY KEY (team_id, sprint_id, member_id)
    );

    CREATE TABLE plan_note (
      team_id   TEXT NOT NULL,
      sprint_id TEXT NOT NULL,
      text      TEXT,
      PRIMARY KEY (team_id, sprint_id)
    );

    CREATE TABLE holiday (date TEXT PRIMARY KEY);

    CREATE TABLE risk (
      id      TEXT PRIMARY KEY,
      data    TEXT NOT NULL,      -- JSON: the register is free-form by design
      created TEXT
    );

    CREATE TABLE saved_search (
      id      TEXT PRIMARY KEY,
      name    TEXT NOT NULL,
      query   TEXT,
      columns TEXT,
      sort    TEXT,
      dir     TEXT,
      matched_when_saved INTEGER,
      saved_at TEXT
    );

    /* Everything else that is one small blob: categoryRules, mixTargets,
       ignoredBoards, the field map, sync watermarks. Key/value beats a column
       per setting when the settings keep changing shape. */
    CREATE TABLE setting (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL          -- JSON
    );

    /* ── THE OVERLAY ────────────────────────────────────────────────────── */
    CREATE TABLE adjustment (
      entity     TEXT NOT NULL,     -- 'issue' | 'calendar_sprint' | 'team' …
      entity_id  TEXT NOT NULL,
      field      TEXT NOT NULL,
      value      TEXT,              -- JSON: what you set it to
      jira_value TEXT,              -- JSON: what the source said when you changed it
      reason     TEXT,
      adjusted_at TEXT NOT NULL,
      PRIMARY KEY (entity, entity_id, field)
    );
    CREATE INDEX idx_adj_entity ON adjustment(entity, entity_id);

    /* ── history ────────────────────────────────────────────────────────── */
    CREATE TABLE sync_run (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      mode        TEXT,
      started_at  TEXT,
      finished_at TEXT,
      issues      INTEGER,
      removed     INTEGER,
      detail      TEXT,             -- JSON: verification, field calibration, errors
      error       TEXT
    );
    `,
  },
  {
    version: 2,
    name: 'sprint-team',
    sql: `
    /*
     * Which team's board a Jira sprint was read from.
     *
     * The sprint table is keyed by Jira id because the SAME sprint appears on
     * two teams' boards (J18498 is on both Katalon Automation and Malphite), so
     * a board_id column on sprint could only ever record one of them. Without
     * this table the per-team sprint lists cannot be rebuilt, and the sprint
     * pickers on every team screen go empty.
     */
    CREATE TABLE sprint_team (
      jira_id  TEXT NOT NULL,
      team_id  TEXT NOT NULL,
      position INTEGER,             -- board order, which is not date order
      PRIMARY KEY (jira_id, team_id),
      FOREIGN KEY (jira_id) REFERENCES sprint(jira_id) ON DELETE CASCADE,
      FOREIGN KEY (team_id) REFERENCES team(id)        ON DELETE CASCADE
    );
    CREATE INDEX idx_sprint_team_team ON sprint_team(team_id);
    `,
  },
  {
    version: 3,
    name: 'round-trip gaps',
    sql: `
    /*
     * Three things the first schema dropped, each found by round-tripping the
     * real snapshot and plan through the database and comparing field by
     * field. Counts had all matched; none of these showed up in a count.
     */

    /*
     * A sprint on an issue carries its own dates, and they are NOT the board
     * sprint's dates: the board says 2025-03-06, the issue says
     * 2025-03-06T17:13:20.835Z. The flat sprint list the whole app reads comes
     * from the issues, so without these the list loses its timings.
     */
    ALTER TABLE issue_sprint ADD COLUMN sprint_start TEXT;
    ALTER TABLE issue_sprint ADD COLUMN sprint_end   TEXT;

    /*
     * Team members are shown in the order they were added, not alphabetically.
     * Sorting them by name looked harmless and silently reordered every
     * capacity grid row.
     */
    ALTER TABLE team_member ADD COLUMN position INTEGER DEFAULT 0;

    /* The board's display name, shown in the team header next to its id. */
    ALTER TABLE team ADD COLUMN board_name TEXT;

    /*
     * Exclusions are listed in the order they were excluded. Primary-key order
     * sorts them by account id, which is meaningless to read.
     */
    ALTER TABLE team_excluded ADD COLUMN position INTEGER DEFAULT 0;

    /*
     * Boards keep the order Jira returned them in. Sorting them by name is a
     * defensible choice but it is a DIFFERENT list from the one the board
     * picker has always shown, and quietly reordering a picker is how someone
     * selects the wrong board.
     */
    ALTER TABLE board ADD COLUMN position INTEGER DEFAULT 0;
    `,
  },
  {
    version: 4,
    name: 'per-sprint roster and scenarios',
    sql: `
    /*
     * WHO IS ON A TEAM FOR ONE SPRINT.
     *
     * A team's roster is not a constant. Titan has had three people since
     * Sprint 38 and four before it, and planning Sprint 39 against a fixed
     * list of everyone who has ever been on the team produces a capacity
     * figure for a team that does not exist.
     *
     * This table does NOT store the roster. It stores the DIFFERENCE between
     * the roster and what the data already implies — the people actually
     * assigned work in that sprint. That choice matters:
     *
     *   Storing the roster outright would freeze it. A person Jira assigns to
     *   the sprint tomorrow would never appear, because the stored list was
     *   written today and nothing would revisit it.
     *
     *   Storing only the difference means the derived base keeps updating with
     *   every sync, while the two things you actually decided — "also count
     *   Chau, she is helping" and "not Hy, he moved teams" — survive it.
     *
     * The same shape as the adjustment table, for the same reason.
     */
    CREATE TABLE sprint_roster (
      team_id   TEXT NOT NULL,
      sprint_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      state     TEXT NOT NULL,        -- 'added' | 'removed'
      -- Who they are, carried on the row itself. Someone added from the Jira
      -- list is NOT made a member of the team: doing that put them on every
      -- other open sprint too, which flatly contradicts what adding them to
      -- one sprint means. The sprint therefore has to be able to name them
      -- without help from the team list.
      name       TEXT,
      account_id TEXT,
      reason    TEXT,
      at        TEXT,
      PRIMARY KEY (team_id, sprint_id, member_id)
    );
    CREATE INDEX idx_sprint_roster ON sprint_roster(team_id, sprint_id);

    /*
     * A SAVED CAPACITY SCENARIO for one team and sprint.
     *
     * Deliberately one JSON blob rather than a parallel set of availability /
     * support / ceremony tables. A scenario is a SNAPSHOT — "what if Chau is
     * on leave and we borrow a contractor" — and nothing ever queries across
     * scenarios or joins one to anything. Five shadow tables would buy a
     * relational shape that nothing would use, and would have to be kept in
     * step with the live tables forever.
     *
     * applied_at records the last time this scenario was made live. It is
     * history, not state: applying a scenario writes its contents into the
     * real tables, so the live plan never points at a scenario row.
     */
    CREATE TABLE scenario (
      id         TEXT PRIMARY KEY,
      team_id    TEXT NOT NULL,
      sprint_id  TEXT NOT NULL,
      name       TEXT NOT NULL,
      note       TEXT,
      data       TEXT NOT NULL,       -- JSON: roster, availability, support, ceremony, overrides
      totals     TEXT,                -- JSON: the headline figures at save time, for the comparison row
      created_at TEXT,
      applied_at TEXT
    );
    CREATE INDEX idx_scenario_sprint ON scenario(team_id, sprint_id);
    `,
  },
  {
    version: 5,
    name: 'epic links',
    sql: `
    /*
     * WHICH EPIC IS THIS WORK AGAINST?
     *
     * Two different questions wearing one word, because AUTOKAT answers them
     * two different ways:
     *
     *   New implementation is a Story under an Epic. The epic is the PARENT.
     *   Maintenance is not under anything — it is linked "relates to" the epic
     *   whose coverage it maintains. The epic is a LINK.
     *
     * Both were already in the Jira payload and both were being thrown away.
     * \`parent\` was read for its key and status and its summary discarded;
     * \`issuelinks\` was filtered down to blocked-by and the rest dropped.
     *
     * The summaries are stored on the link rather than looked up, because an
     * epic is very often NOT one of the issues we sync — the sync queries
     * select this team's sprint work, and the epic can live anywhere in the
     * project. Storing the name Jira already handed us alongside the key is
     * the difference between a column that reads "AUTOKAT-4412" and one that
     * reads "Renewals regression suite".
     */
    ALTER TABLE issue ADD COLUMN parent_summary TEXT;
    ALTER TABLE issue ADD COLUMN parent_type    TEXT;

    ALTER TABLE issue_link ADD COLUMN other_summary TEXT;
    ALTER TABLE issue_link ADD COLUMN other_type    TEXT;

    /*
     * Every read of this table filters by kind, and until now there was only
     * one kind, so the primary key's leading issue_key column was enough. With
     * a second kind, "all the relates-to links" becomes a full scan.
     */
    CREATE INDEX idx_issue_link_kind ON issue_link(kind, issue_key);
    `,
  },

  {
    version: 6,
    name: 'coverage-history',
    sql: `
    /* ── coverage, as it was on a given day ──────────────────────────────
     *
     * Every other table here holds what is true NOW: a sync overwrites each
     * epic's automation_status and the previous value is gone. That is the
     * right shape for every screen except one — "is coverage going up?" cannot
     * be answered by a store that only remembers today, and it could not be
     * reconstructed either: only 107 of 312 automated epics carry a resolution
     * date, so there was nothing to infer a date of automation from.
     *
     * So this table remembers on purpose. One row per day per component, with
     * the seven bucket counts, written by every sync.
     *
     * DAY GRANULARITY, not timestamp. A day is the finest unit anyone reads a
     * trend at, and the primary key means three syncs on a Tuesday leave one
     * Tuesday rather than three points stacked on the same tick.
     *
     * The scope column is the issue type the reading counted ('Epic'). Changing
     * metrics.coverageScope later starts a new series instead of silently
     * continuing the old one with a different population underneath it.
     *
     * The source column is what makes the two histories safe to mix: 'sync' is a reading
     * this tool took itself and 'changelog' is one reconstructed from Jira's
     * transition history. A reconstruction is an inference and never overwrites
     * an observation — see coverage-history.js, which enforces that on write.
     */
    CREATE TABLE coverage_reading (
      at          TEXT    NOT NULL,          -- YYYY-MM-DD
      scope       TEXT    NOT NULL,
      component   TEXT    NOT NULL,          -- '' is the portfolio row
      automated   INTEGER NOT NULL DEFAULT 0,
      maintenance INTEGER NOT NULL DEFAULT 0,
      ready       INTEGER NOT NULL DEFAULT 0,
      blocked     INTEGER NOT NULL DEFAULT 0,
      na          INTEGER NOT NULL DEFAULT 0,
      obsoleted   INTEGER NOT NULL DEFAULT 0,
      none        INTEGER NOT NULL DEFAULT 0,
      source      TEXT    NOT NULL DEFAULT 'sync',
      PRIMARY KEY (at, scope, component)
    );
    CREATE INDEX idx_coverage_reading_at ON coverage_reading(scope, at);
    `,
  },
  {
    version: 7,
    name: 'automation-transitions',
    sql: `
    /* ── every change of an epic's Automation Status, with its date ──────
     *
     * The table above remembers the SHAPE of coverage on a given day. This one
     * remembers the EVENTS that changed it: one row per recorded move of the
     * Automation Status field, as Jira's own changelog reports it.
     *
     * Why both. A reading answers "how much was automated in March"; only an
     * event answers "how many test cases were automated IN March, and was that
     * new build or re-automation after maintenance" — and those are different
     * questions with different shapes. You cannot derive the second from the
     * first, because two epics moving in opposite directions leave the daily
     * reading unchanged.
     *
     * WHAT IS DELIBERATELY NOT HERE: the tool (TrueTest or KSE) and the
     * component. Those live on the epic and are read from the snapshot at query
     * time, so re-tagging an epic's component in Jira corrects every past bar
     * rather than leaving history stamped with a label that has since changed.
     * The event is what happened; the epic is what it happened to.
     *
     * The to_status column is part of the key because one changelog entry can
     * carry more than one change to the same field on the same timestamp, and
     * losing one of those would silently undercount.
     */
    CREATE TABLE automation_transition (
      issue_key   TEXT NOT NULL,
      at          TEXT NOT NULL,          -- ISO timestamp, as Jira recorded it
      from_status TEXT,                   -- null when the field was first set
      to_status   TEXT,
      PRIMARY KEY (issue_key, at, to_status)
    );
    CREATE INDEX idx_automation_transition_at ON automation_transition(at);
    `,
  },
];

/* ─────────────────────────── connection ─────────────────────────── */

let handle = null;
let openedAt = null;

function ensureDirs() {
  // The directory of the file actually being opened, not STORE_DIR — `openAt()`
  // points somewhere else entirely and that directory may not exist yet.
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
}

let journalMode = null;   // what we actually got, which is not always what we asked for

/**
 * The one connection, opened lazily and kept.
 *
 * WAL is worth asking for: the tool reads on every page load and writes during
 * a sync, and the rollback journal blocks readers while a sync commits.
 *
 * WAL IS ALSO NOT ALWAYS AVAILABLE, and this is not a rare edge. It needs a
 * shared-memory file beside the database, which means a filesystem that
 * supports mmap'd shared locks — and a project folder living on a network
 * share, a synced folder, or a virtualised mount often does not. On those,
 * `PRAGMA journal_mode = WAL` throws "disk I/O error" and the tool would fail
 * to start at all, with a message naming a pragma rather than the folder.
 *
 * So: ask, and accept the answer. The rollback journal is slower under
 * concurrent reads and completely correct, which is the right trade for a
 * single-user local tool that would otherwise not open. `stats()` reports which
 * one is in force, so a slow tool on a network drive is explicable rather than
 * mysterious.
 *
 * `foreign_keys` is off by default in SQLite and the cascades above are load
 * bearing, so it is turned on explicitly. That one is not optional — if it
 * cannot be set, the schema's guarantees do not hold and failing is correct.
 */
function db() {
  if (handle) return handle;
  ensureDirs();
  try {
    handle = new DatabaseSync(DB_FILE);
    handle.exec('SELECT 1');
  } catch (err) {
    // Almost always the FOLDER, not the file. SQLite needs POSIX file locking,
    // and some filesystems do not provide it — a network share, some synced
    // folders, a virtualised mount. The raw error says "disk I/O error", which
    // sends you looking at your disk rather than at where the tool is living.
    throw new Error(
      `Could not open the database at ${DB_FILE} (${err.message}). `
      + 'This usually means the folder is on a filesystem that does not support file locking — '
      + 'a network drive, or a synced folder. Move the tool to a local folder, or point STORE_DIR at one.',
    );
  }

  try {
    handle.exec('PRAGMA journal_mode = WAL');
    handle.exec('PRAGMA synchronous = NORMAL');   // safe under WAL, and faster
  } catch (_) {
    // The filesystem cannot do WAL. Fall back rather than refuse to open.
    try { handle.exec('PRAGMA journal_mode = DELETE'); } catch (_) { /* whatever it defaults to */ }
    handle.exec('PRAGMA synchronous = FULL');     // no WAL to recover from, so don't relax this
  }
  journalMode = String((handle.prepare('PRAGMA journal_mode').get() || {}).journal_mode || 'unknown');

  handle.exec('PRAGMA foreign_keys = ON');
  migrate(handle);
  openedAt = new Date().toISOString();
  return handle;
}

function close() {
  if (handle) { try { handle.close(); } catch (_) { /* already gone */ } }
  handle = null;
  journalMode = null;
}

/**
 * Point the module at a different file — used by the tests and by migration.
 * It must reassign DB_FILE itself; setting process.env here would be read by
 * nothing, since the environment is consulted exactly once at require time.
 */
function openAt(file) {
  close();
  DB_FILE = file;
  process.env.DB_FILE = file; // so a child process started later agrees
  return db();
}

function migrate(h) {
  h.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
  const done = new Set(h.prepare('SELECT version FROM schema_version').all().map(r => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    // Each migration is one transaction: a half-applied schema is not a state
    // anything downstream could reason about.
    h.exec('BEGIN');
    try {
      h.exec(m.sql);
      h.prepare('INSERT INTO schema_version VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
      h.exec('COMMIT');
    } catch (err) {
      h.exec('ROLLBACK');
      throw new Error(`Migration ${m.version} (${m.name}) failed: ${err.message}`);
    }
  }
}

/* ─────────────────────────── helpers ─────────────────────────── */

const all = (sql, ...params) => db().prepare(sql).all(...params);
const get = (sql, ...params) => db().prepare(sql).get(...params);
const run = (sql, ...params) => db().prepare(sql).run(...params);
const exec = (sql) => db().exec(sql);

/**
 * Run a function inside one transaction.
 *
 * A sync touches thousands of rows; committing per row is both slow and a way
 * to leave the store half-updated when something throws in the middle.
 * Re-entrant by design — a caller inside an open transaction just joins it.
 */
let depth = 0;
function tx(fn) {
  const h = db();
  if (depth > 0) { depth++; try { return fn(); } finally { depth--; } }
  h.exec('BEGIN');
  depth = 1;
  try {
    const out = fn();
    h.exec('COMMIT');
    return out;
  } catch (err) {
    try { h.exec('ROLLBACK'); } catch (_) { /* the original error is the interesting one */ }
    throw err;
  } finally {
    depth = 0;
  }
}

/** JSON in and out, so callers never think about serialisation. */
const toJson = (v) => (v === undefined ? null : JSON.stringify(v));
const fromJson = (v, fallback = null) => {
  if (v === null || v === undefined || v === '') return fallback;
  try { return JSON.parse(v); } catch (_) { return fallback; }
};

/** A small settings bag for everything that is one blob rather than a table. */
const setting = {
  get(key, fallback = null) {
    const row = get('SELECT value FROM setting WHERE key = ?', key);
    return row ? fromJson(row.value, fallback) : fallback;
  },
  set(key, value) {
    run('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key, toJson(value));
    return value;
  },
  all() {
    return Object.fromEntries(all('SELECT key, value FROM setting').map(r => [r.key, fromJson(r.value)]));
  },
  remove(key) { run('DELETE FROM setting WHERE key = ?', key); },
};

/** Size and shape, for the Data sources screen and for sanity checks. */
function stats() {
  const tables = all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .map(r => r.name);
  const counts = {};
  for (const t of tables) counts[t] = get(`SELECT count(*) c FROM "${t}"`).c;
  let bytes = 0;
  try { bytes = fs.statSync(DB_FILE).size; } catch (_) { /* not written yet */ }
  return {
    file: DB_FILE, bytes, openedAt, counts,
    version: MIGRATIONS[MIGRATIONS.length - 1].version,
    // Reported because it explains performance. "wal" is the fast path; "delete"
    // means the folder cannot do WAL (a network share, a synced folder) and
    // reads will block during a sync.
    journalMode,
  };
}

module.exports = {
  db, close, openAt, tx, all, get, run, exec, setting, stats,
  toJson, fromJson, MIGRATIONS, dbFile, STORE_DIR, ROOT,
};

// DB_FILE stays available to callers, but as a getter — exporting the value
// would hand out a snapshot taken before `openAt()` ever ran, which is the
// exact bug this file already had once.
Object.defineProperty(module.exports, 'DB_FILE', { enumerable: true, get: dbFile });
