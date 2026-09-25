'use strict';
/**
 * db.test.js — the local database and the adjustment overlay.
 *
 * The promise being tested is the whole reason the database exists: this store
 * is the primary source, your edits are first-class, and a sync can never
 * silently undo one. If that guarantee slips, every number in the tool becomes
 * untrustworthy again — which is where this project started.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-db-'));
process.env.STORE_DIR = SCRATCH;
process.env.DB_FILE = path.join(SCRATCH, 'test.db');

const db = require('../lib/db');
const repo = require('../lib/repo');
// Required HERE, not inside a check. One test below clears lib/db from the
// require cache to install a fake, so a later `require('../lib/integrity')`
// would pull in a SECOND db module instance with its own connection — and read
// an empty database while the test wrote to the real one.
const integrity = require('../lib/integrity');

/** The database the app itself uses, which this suite must never be pointed at. */
const REAL_DB = path.join(__dirname, '..', 'data', 'store', 'planning.db');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fresh(); fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
console.log('\nLocal database and the adjustment overlay\n');

/** A clean database per check, so one test's writes cannot explain another's pass. */
function fresh() {
  db.close();
  for (const f of fs.readdirSync(SCRATCH)) fs.rmSync(path.join(SCRATCH, f), { force: true, recursive: true });
  db.openAt(path.join(SCRATCH, 'test.db'));
}

const ISSUE = (over = {}) => ({
  key: 'AUTOKAT-1', project: 'AUTOKAT', summary: 'Login flow regression',
  issueType: 'Story', status: 'In Dev', statusCategory: 'indeterminate',
  assignee: 'Hien Phan', assigneeId: 'acc-hien', priority: 'High',
  points: 5, team: 'Katalon Auto Ruby', automationStatus: 'Automated',
  created: '2026-08-01T00:00:00Z', updated: '2026-09-10T00:00:00Z',
  components: ['R&D_iGO_E2E', 'TrueTest'], labels: ['TestPak'],
  sprints: [{ id: '900', name: 'Katalon Ruby Sprint 39', state: 'active' }],
  blockedBy: ['AUTOKAT-2'],
  ...over,
});

/* ── storage basics ───────────────────────────────────────────────────── */

check('an issue round-trips with every relation intact', () => {
  repo.upsertIssues([ISSUE()]);
  const i = repo.getIssue('AUTOKAT-1');
  assert.strictEqual(i.summary, 'Login flow regression');
  assert.strictEqual(i.points, 5);
  assert.deepStrictEqual(i.components.sort(), ['R&D_iGO_E2E', 'TrueTest']);
  assert.deepStrictEqual(i.labels, ['TestPak']);
  assert.deepStrictEqual(i.sprintNames, ['Katalon Ruby Sprint 39']);
  assert.deepStrictEqual(i.blockedBy.map(l => l.key), ['AUTOKAT-2']);
});

check('NULL POINTS SURVIVE AS NULL, and zero survives as zero', () => {
  repo.upsertIssues([ISSUE({ key: 'A', points: null }), ISSUE({ key: 'B', points: 0 })]);
  assert.strictEqual(repo.getIssue('A').points, null, 'no estimate must not become an estimate of zero');
  assert.strictEqual(repo.getIssue('B').points, 0);
  assert.strictEqual(db.get('SELECT count(*) c FROM issue WHERE points IS NULL').c, 1,
    'and SQL must agree, or every aggregate disagrees with every screen');
});

check('re-syncing an issue updates it rather than duplicating it', () => {
  repo.upsertIssues([ISSUE()]);
  repo.upsertIssues([ISSUE({ status: 'Done', statusCategory: 'done', points: 8 })]);
  assert.strictEqual(db.get('SELECT count(*) c FROM issue').c, 1);
  assert.strictEqual(repo.getIssue('AUTOKAT-1').status, 'Done');
  assert.strictEqual(repo.getIssue('AUTOKAT-1').points, 8);
});

check('a relation that shrinks in Jira shrinks locally', () => {
  repo.upsertIssues([ISSUE()]);
  repo.upsertIssues([ISSUE({ components: ['R&D_iGO_E2E'] })]);
  assert.deepStrictEqual(repo.getIssue('AUTOKAT-1').components, ['R&D_iGO_E2E'],
    'a stale component would quietly inflate every coverage figure');
});

check('allIssues returns the map the rest of the app expects', () => {
  repo.upsertIssues([ISSUE({ key: 'A' }), ISSUE({ key: 'B' })]);
  const all = repo.allIssues();
  assert.deepStrictEqual(Object.keys(all).sort(), ['A', 'B']);
  assert.strictEqual(all.A.sprintNames.length, 1);
});

/* ── the overlay ──────────────────────────────────────────────────────── */

check('ADJUSTING A FIELD CHANGES WHAT EVERY QUERY SEES', () => {
  repo.upsertIssues([ISSUE({ points: 5 })]);
  repo.adjust('issue', 'AUTOKAT-1', 'points', 13, { reason: 'Re-estimated in refinement' });

  assert.strictEqual(repo.getIssue('AUTOKAT-1').points, 13);
  // The point of storing the effective value in the row: SQL agrees with the UI.
  assert.strictEqual(db.get('SELECT points FROM issue WHERE key = ?', 'AUTOKAT-1').points, 13);
  assert.strictEqual(db.get('SELECT sum(points) s FROM issue').s, 13,
    'an aggregate that still saw 5 would contradict the screen showing 13');
});

check('the original Jira value is kept, with the reason', () => {
  repo.upsertIssues([ISSUE({ points: 5 })]);
  repo.adjust('issue', 'AUTOKAT-1', 'points', 13, { reason: 'Re-estimated in refinement' });
  const [a] = repo.adjustments();
  assert.strictEqual(a.value, 13);
  assert.strictEqual(a.jiraValue, 5, 'without the original there is nothing to revert to');
  assert.strictEqual(a.reason, 'Re-estimated in refinement');
  assert.strictEqual(a.field, 'points');
});

check('A SYNC MUST NOT OVERWRITE AN ADJUSTED FIELD', () => {
  repo.upsertIssues([ISSUE({ points: 5 })]);
  repo.adjust('issue', 'AUTOKAT-1', 'points', 13);
  // Jira comes back with something different. Your value has to hold.
  const r = repo.upsertIssues([ISSUE({ points: 3, status: 'Done', statusCategory: 'done' })]);
  assert.strictEqual(repo.getIssue('AUTOKAT-1').points, 13,
    'this is the whole promise of "my primary data source"');
  assert.strictEqual(r.protectedFields, 1);
  assert.strictEqual(repo.getIssue('AUTOKAT-1').status, 'Done',
    'everything you did NOT adjust must still sync normally');
});

check('the sync refreshes what Jira now says, so drift is visible', () => {
  repo.upsertIssues([ISSUE({ points: 5 })]);
  repo.adjust('issue', 'AUTOKAT-1', 'points', 13);
  repo.upsertIssues([ISSUE({ points: 3 })]);
  const [a] = repo.adjustments();
  assert.strictEqual(a.value, 13, 'yours still wins');
  assert.strictEqual(a.jiraValue, 3, 'and you can see the source has moved');
  assert.strictEqual(a.stillDiffers, true);
});

check('an override Jira has caught up with is flagged as no longer needed', () => {
  repo.upsertIssues([ISSUE({ points: 5 })]);
  repo.adjust('issue', 'AUTOKAT-1', 'points', 13, 'Re-estimated in planning');
  // someone fixed the estimate in Jira to match
  repo.upsertIssues([ISSUE({ points: 13 })]);
  const [a] = repo.adjustments();
  assert.strictEqual(a.stillDiffers, false,
    'an override that now agrees with Jira is doing nothing and should say so');
});

check('reverting restores JIRA\'s value, not the previous edit', () => {
  repo.upsertIssues([ISSUE({ points: 5 })]);
  repo.adjust('issue', 'AUTOKAT-1', 'points', 13);
  repo.adjust('issue', 'AUTOKAT-1', 'points', 21);     // changed your mind
  assert.strictEqual(repo.adjustments()[0].jiraValue, 5, 'the original must not drift with each edit');
  repo.revert('issue', 'AUTOKAT-1', 'points');
  assert.strictEqual(repo.getIssue('AUTOKAT-1').points, 5);
  assert.strictEqual(repo.adjustments().length, 0, 'and the adjustment is gone, not merely hidden');
});

check('an adjusted RELATION is protected too', () => {
  repo.upsertIssues([ISSUE({ components: ['A'] })]);
  repo.adjust('issue', 'AUTOKAT-1', 'components', ['A', 'B']);
  repo.upsertIssues([ISSUE({ components: ['A'] })]);
  assert.deepStrictEqual(repo.getIssue('AUTOKAT-1').components.sort(), ['A', 'B'],
    'components drive coverage, so an overwritten one silently changes a report');
});

check('moving an item to another sprint survives a sync', () => {
  repo.upsertIssues([ISSUE()]);
  repo.adjust('issue', 'AUTOKAT-1', 'sprints', [{ id: '901', name: 'Katalon Ruby Sprint 40', state: 'future' }],
    { reason: 'Pulled into next sprint during planning' });
  repo.upsertIssues([ISSUE()]);                          // Jira still says 39
  assert.deepStrictEqual(repo.getIssue('AUTOKAT-1').sprintNames, ['Katalon Ruby Sprint 40'],
    'sprint planning is exactly the adjustment this tool exists to make');
});

check('an unadjusted field on an adjusted issue still syncs', () => {
  repo.upsertIssues([ISSUE({ points: 5, assignee: 'Hien Phan' })]);
  repo.adjust('issue', 'AUTOKAT-1', 'points', 13);
  repo.upsertIssues([ISSUE({ points: 3, assignee: 'Thao Dang', assigneeId: 'acc-thao' })]);
  const i = repo.getIssue('AUTOKAT-1');
  assert.strictEqual(i.points, 13);
  assert.strictEqual(i.assignee, 'Thao Dang', 'protection is per FIELD, not per issue');
});

check('an issue reports which of its fields are adjusted', () => {
  repo.upsertIssues([ISSUE()]);
  repo.adjust('issue', 'AUTOKAT-1', 'points', 13);
  repo.adjust('issue', 'AUTOKAT-1', 'priority', 'Highest');
  assert.deepStrictEqual(repo.getIssue('AUTOKAT-1').adjusted.sort(), ['points', 'priority'],
    'a screen has to be able to mark what is locally changed');
  assert.deepStrictEqual(repo.allIssues()['AUTOKAT-1'].adjusted.sort(), ['points', 'priority']);
});

check('a field that is not adjustable is refused by name', () => {
  repo.upsertIssues([ISSUE()]);
  assert.throws(() => repo.adjust('issue', 'AUTOKAT-1', 'nonsense', 1), /not an adjustable field/);
  assert.throws(() => repo.adjust('issue', 'AUTOKAT-1', 'key', 'X'), /not an adjustable field/,
    'renaming the primary key is not an adjustment, it is corruption');
});

check('adjusting an issue that does not exist fails loudly', () => {
  assert.throws(() => repo.adjust('issue', 'NOPE-1', 'points', 3), /No issue/);
});

/* ── deletion is soft ─────────────────────────────────────────────────── */

check('an issue the sync stops seeing is hidden, not destroyed', () => {
  repo.upsertIssues([ISSUE()]);
  repo.adjust('issue', 'AUTOKAT-1', 'points', 13);
  repo.softDeleteIssues(['AUTOKAT-1']);
  assert.strictEqual(Object.keys(repo.allIssues()).length, 0, 'it leaves every view');
  assert.strictEqual(db.get('SELECT count(*) c FROM issue').c, 1, 'but the row and your edit survive');
  assert.strictEqual(repo.adjustments().length, 1);
});

check('seeing an issue again brings it back', () => {
  repo.upsertIssues([ISSUE()]);
  repo.softDeleteIssues(['AUTOKAT-1']);
  repo.upsertIssues([ISSUE()]);
  assert.strictEqual(Object.keys(repo.allIssues()).length, 1);
});

/* ── local-only work ──────────────────────────────────────────────────── */

check('an item that exists only here can be created and planned', () => {
  const i = repo.createLocalIssue({ summary: 'Support rota', points: 3, team: 'Katalon Auto Ruby' });
  assert.strictEqual(i.source, 'local');
  assert.strictEqual(i.points, 3);
  assert.ok(i.key.startsWith('LOCAL-'));
  assert.strictEqual(repo.allIssues()[i.key].summary, 'Support rota');
});

check('a local item is never clobbered by a sync of Jira items', () => {
  const i = repo.createLocalIssue({ summary: 'Support rota', points: 3 });
  repo.upsertIssues([ISSUE()]);
  assert.strictEqual(repo.getIssue(i.key).summary, 'Support rota');
  assert.strictEqual(Object.keys(repo.allIssues()).length, 2);
});

/* ── transactions ─────────────────────────────────────────────────────── */

check('a failed write leaves nothing behind', () => {
  repo.upsertIssues([ISSUE()]);
  assert.throws(() => db.tx(() => {
    db.run('UPDATE issue SET points = 99 WHERE key = ?', 'AUTOKAT-1');
    throw new Error('boom');
  }), /boom/);
  assert.strictEqual(repo.getIssue('AUTOKAT-1').points, 5, 'a half-applied sync is not a state anything can reason about');
});

check('the schema upgrades an existing database rather than rebuilding it', () => {
  repo.upsertIssues([ISSUE()]);
  db.close();
  db.openAt(path.join(SCRATCH, 'test.db'));      // reopen: migrations run again
  assert.strictEqual(Object.keys(repo.allIssues()).length, 1, 'data must survive a reopen');
  assert.strictEqual(db.get('SELECT count(*) c FROM schema_version').c, db.MIGRATIONS.length,
    'and migrations must not be applied twice');
});

/* ── scale ────────────────────────────────────────────────────────────── */

check('7,000 issues write and query at a sensible speed', () => {
  const many = Array.from({ length: 7000 }, (_, n) => ISSUE({
    key: `AUTOKAT-${n}`, points: n % 13, components: [`C${n % 40}`], labels: [],
    sprints: [{ id: String(900 + (n % 50)), name: `Sprint ${n % 50}`, state: 'closed' }],
    blockedBy: [],
  }));
  const t0 = Date.now();
  repo.upsertIssues(many);
  const writeMs = Date.now() - t0;

  const t1 = Date.now();
  const row = db.get(`SELECT count(*) c, sum(points) p FROM issue WHERE issue_type = 'Story' AND deleted_at IS NULL`);
  const queryMs = Date.now() - t1;

  assert.strictEqual(row.c, 7000);
  assert.ok(writeMs < 15000, `writing 7,000 issues took ${writeMs}ms`);
  assert.ok(queryMs < 100, `an indexed aggregate took ${queryMs}ms — the old blob took 369ms just to parse`);
});

/**
 * This one is about the test suite itself. `openAt()` used to set an
 * environment variable that nothing read back, so every check above ran
 * against the project's own data/store/planning.db — passing happily while
 * writing 7,000 fixture issues next to real data. A green suite proved
 * nothing about the file it claimed to be using.
 */
check('openAt actually moves the database, so tests cannot write into the real store', () => {
  const elsewhere = path.join(SCRATCH, 'nested', 'moved.db');
  db.openAt(elsewhere);
  repo.upsertIssues([ISSUE()]);

  assert.strictEqual(db.stats().file, elsewhere, 'stats reports a file the connection is not using');
  assert.strictEqual(db.DB_FILE, elsewhere, 'the exported DB_FILE is a stale snapshot');
  assert.ok(fs.existsSync(elsewhere), 'openAt did not create the file it was given');

  // Checked by where the connection POINTS, not by watching the real file.
  // Two earlier versions of this assertion were both wrong: "the real database
  // does not exist" fails for anyone who has used the tool, and "its size is
  // unchanged" fails whenever the app is running, because the app is writing
  // to it while the suite runs. Neither failure meant a test had written there.
  // The connection's own target is the thing that decides it, and it is not
  // racy.
  assert.notStrictEqual(path.resolve(db.stats().file), path.resolve(REAL_DB),
    'the suite is pointed at the database the app uses');
});

/**
 * A folder that cannot do WAL must not stop the tool opening.
 *
 * Found the hard way: the first deploy died on startup with "disk I/O error"
 * naming a pragma, because the folder was a virtualised mount with no support
 * for the shared-memory file WAL needs. A project folder on a network share or
 * a synced folder behaves the same way.
 */
check('a filesystem that cannot do WAL gets a working database anyway', () => {
  const sqlite = require('node:sqlite');
  const real = sqlite.DatabaseSync;
  // A connection that refuses WAL exactly the way such a filesystem does.
  sqlite.DatabaseSync = class extends real {
    exec(sql) {
      if (/journal_mode\s*=\s*WAL/i.test(sql)) { const e = new Error('disk I/O error'); e.code = 'ERR_SQLITE_ERROR'; throw e; }
      return super.exec(sql);
    }
  };
  try {
    delete require.cache[require.resolve('../lib/db')];
    const fresh = require('../lib/db');
    fresh.openAt(path.join(SCRATCH, 'nowal.db'));
    fresh.run(`INSERT INTO issue (key, summary, points) VALUES ('W-1', 'works', 3)`);
    assert.strictEqual(fresh.get(`SELECT points FROM issue WHERE key = 'W-1'`).points, 3,
      'the database must still read and write without WAL');
    assert.notStrictEqual(fresh.stats().journalMode, 'wal', 'and must report the mode it actually got');
    fresh.close();
  } finally {
    sqlite.DatabaseSync = real;
    delete require.cache[require.resolve('../lib/db')];
    delete require.cache[require.resolve('../lib/repo')];
  }
});

/* ── the integrity self-check ──────────────────────────────────────────
   Added because "are my 9,296 issues duplicated?" was a fair question that
   took a person asking and a long dig to answer. The tool should say this
   about itself. */

check('the integrity check passes on a clean store', () => {
  repo.upsertIssues([ISSUE({ key: 'A' }), ISSUE({ key: 'B' })]);
  const r = integrity.run();
  assert.ok(r.ok, `expected a clean store to pass: ${JSON.stringify(r.failing)}`);
  assert.ok(r.rows.some(x => /No duplicate/.test(x.name)));
});

check('IT CATCHES AN ITEM CLAIMING TO BE IN TWO MUTUALLY EXCLUSIVE DATASETS', () => {
  // sprintWork is "sprint IS NOT EMPTY", backlog is "sprint IS EMPTY".
  // Nothing can match both; 78 of his issues did, from a sync that added the
  // new tag without dropping the old one.
  repo.upsertIssues([ISSUE({ key: 'A', datasets: ['sprintWork', 'backlog'] })]);
  const r = integrity.run();
  assert.ok(!r.ok);
  const row = r.failing.find(x => /sprintWork/.test(x.name));
  assert.ok(row, 'the contradictory pair must be what fails');
  assert.strictEqual(row.count, 1);
});

check('an orphaned relation cannot even be created — the foreign key refuses it', () => {
  repo.upsertIssues([ISSUE({ key: 'A' })]);
  // The integrity check reports this one, but it is guaranteed rather than
  // merely observed: `foreign_keys = ON` plus ON DELETE CASCADE means a link
  // to a missing item cannot be written in the first place. Worth showing to
  // someone asking whether their data hangs together, and worth pinning here
  // so that turning the pragma off would be noticed.
  assert.throws(
    () => db.run(`INSERT INTO issue_component (issue_key, component) VALUES ('GHOST-1', 'X')`),
    /FOREIGN KEY/,
  );
  assert.ok(integrity.run().rows.some(x => /No orphaned component links/.test(x.name)));
});

check('a soft-deleted item is reported but is NOT a failure', () => {
  repo.upsertIssues([ISSUE({ key: 'A' }), ISSUE({ key: 'B' })]);
  repo.softDeleteIssues(['B']);
  const r = integrity.run();
  assert.ok(r.ok, 'hiding an item the sync stopped seeing is the design, not a defect');
  const row = r.rows.find(x => /stopped seeing/.test(x.name));
  assert.strictEqual(row.count, 1);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
db.close();
fs.rmSync(SCRATCH, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
