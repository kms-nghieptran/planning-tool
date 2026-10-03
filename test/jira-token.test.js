'use strict';
/**
 * jira-token.test.js — credentials at rest, and whose credentials go out.
 *
 * Two properties, and they fail in opposite ways.
 *
 * AT REST: the token must not be readable in a copy of the database. That one
 * is easy to get wrong invisibly — a "simplification" to base64 looks
 * identical from every screen and from every other test in this repository.
 * So the checks read the DATABASE FILE'S BYTES, not the column.
 *
 * ON THE WIRE: a write must go out as the actor, and somebody with no token
 * must be REFUSED rather than quietly upgraded to the shared admin one. A
 * silent fallback rebuilds the exact problem this feature exists to solve
 * while looking like it solved it — and it is invisible, because the write
 * succeeds.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-jt-'));
fs.mkdirSync(path.join(SCRATCH, 'store'), { recursive: true });
process.env.STORE_DIR = SCRATCH;
process.env.AUTH_DB_FILE = path.join(SCRATCH, 'store', 'auth.db');

const secrets = require('../lib/secrets');
const auth = require('../lib/auth');

let passed = 0, failed = 0;
const pending = [];
const check = (name, fn) => pending.push({ name, fn });

const PW = 'a-long-enough-passphrase-42';
const TOKEN = 'ATATT3xFfGF0-pretend-jira-api-token-9f8e7d6c5b4a';

/* ── at rest ──────────────────────────────────────────────────────────── */

check('A VALUE SURVIVES A ROUND TRIP', () => {
  const blob = secrets.encrypt(TOKEN);
  assert.notStrictEqual(blob, TOKEN);
  assert.strictEqual(secrets.decrypt(blob), TOKEN);
});

check('THE SAME VALUE ENCRYPTS DIFFERENTLY EVERY TIME', () => {
  /* A fresh nonce per call. Without it, equal ciphertexts in the table
     advertise which people share a token — and GCM with a reused nonce leaks
     far more than that. */
  const a = secrets.encrypt(TOKEN);
  const b = secrets.encrypt(TOKEN);
  assert.notStrictEqual(a, b, 'two encryptions of the same value came out identical');
  assert.strictEqual(secrets.decrypt(a), TOKEN);
  assert.strictEqual(secrets.decrypt(b), TOKEN);
});

check('THE CIPHERTEXT CONTAINS NO RECOGNISABLE PIECE OF THE TOKEN', () => {
  /* The check that catches the "simplification to base64" rewrite, which
     passes every behavioural test in this file. */
  const blob = secrets.encrypt(TOKEN);
  assert.ok(!blob.includes(TOKEN));
  assert.ok(!blob.includes(Buffer.from(TOKEN).toString('base64')));
  assert.ok(!blob.includes(Buffer.from(TOKEN).toString('base64url')));
  assert.ok(!blob.includes('ATATT'), 'the token prefix is readable in the ciphertext');
});

check('TAMPERING IS DETECTED — GCM authenticates, it does not merely scramble', () => {
  /* The reason this is GCM and not CBC. A ciphertext altered in the file must
     FAIL, not decrypt to rubbish that then gets sent to Jira as a credential. */
  const blob = secrets.encrypt(TOKEN);
  const parts = blob.split('.');
  const body = Buffer.from(parts[3], 'base64url');
  body[0] ^= 0xff;
  parts[3] = body.toString('base64url');
  assert.strictEqual(secrets.decrypt(parts.join('.')), null, 'an altered ciphertext decrypted anyway');
});

check('a value encrypted under ANOTHER key reads as nothing, rather than throwing', () => {
  /* A restored backup without its key file. Every caller treats null as "no
     usable token"; a throw would surface as a crash on an unrelated screen. */
  const blob = secrets.encrypt(TOKEN);
  const realKey = process.env.SECRET_KEY;
  process.env.SECRET_KEY = crypto.randomBytes(32).toString('base64');
  secrets.reset();
  try {
    assert.strictEqual(secrets.decrypt(blob), null);
  } finally {
    if (realKey === undefined) delete process.env.SECRET_KEY; else process.env.SECRET_KEY = realKey;
    secrets.reset();
  }
});

check('garbage in is null out, never a throw', () => {
  for (const bad of [null, undefined, '', 'x', 'v1.a.b', 'v2.a.b.c', 'v1...', 'v1.!!.!!.!!']) {
    assert.doesNotThrow(() => secrets.decrypt(bad), `threw on ${JSON.stringify(bad)}`);
    assert.strictEqual(secrets.decrypt(bad), null, `${JSON.stringify(bad)} decrypted to something`);
  }
});

check('THE KEY FILE IS 0600, and is created rather than shipped', () => {
  secrets.reset();
  const file = secrets.KEY_FILE();
  try { fs.unlinkSync(file); } catch (_) { /* fine */ }
  secrets.encrypt('x');
  const st = fs.statSync(file);
  if (process.platform !== 'win32') {
    assert.strictEqual(st.mode & 0o777, 0o600, `the key file is mode ${(st.mode & 0o777).toString(8)}`);
  }
  assert.strictEqual(Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64').length, 32);
});

check('the blob is versioned, so the algorithm can change without orphaning data', () => {
  assert.match(secrets.encrypt(TOKEN), /^v1\./);
});

/* ── stored against a person ──────────────────────────────────────────── */

async function user() {
  const u = await auth.createUser({ email: `u${Math.random().toString(36).slice(2)}@kms-technology.com`, password: PW });
  return u;
}

check('A TOKEN IS SAVED AND COMES BACK FOR AN OUTBOUND CALL', async () => {
  const u = await user();
  auth.setJiraToken(u.id, { email: 'n@kms-technology.com', token: TOKEN });
  const creds = auth.jiraCredsFor(u.id);
  assert.strictEqual(creds.token, TOKEN);
  assert.strictEqual(creds.email, 'n@kms-technology.com');
});

check('AND IS NOT IN THE DATABASE FILE', async () => {
  /* Read as BYTES. A check against the column would pass while the value sat
     in a WAL page, a freelist page, or some other table. */
  const u = await user();
  auth.setJiraToken(u.id, { email: 'n@kms-technology.com', token: TOKEN });
  for (const f of [auth.dbFile(), `${auth.dbFile()}-wal`]) {
    if (!fs.existsSync(f)) continue;
    assert.ok(!fs.readFileSync(f).includes(Buffer.from(TOKEN)),
      `the Jira token is readable in ${path.basename(f)}`);
  }
});

check('THE SCREEN NEVER SEES THE TOKEN — only that one exists, and its last four', async () => {
  const u = await user();
  auth.setJiraToken(u.id, { email: 'n@kms-technology.com', token: TOKEN });
  const h = auth.jiraHint(u.id);
  assert.strictEqual(h.has, true);
  assert.strictEqual(h.email, 'n@kms-technology.com');
  assert.strictEqual(h.hint, `…${TOKEN.slice(-4)}`);
  assert.ok(!JSON.stringify(h).includes(TOKEN), 'the hint payload carries the whole token');
  assert.ok(!('token' in h), 'the hint has a token field at all');
});

check('an account with no token has none, and that is not an error', async () => {
  const u = await user();
  assert.strictEqual(auth.jiraCredsFor(u.id), null);
  assert.deepStrictEqual(auth.jiraHint(u.id).has, false);
});

check('REMOVING A TOKEN REALLY REMOVES IT', async () => {
  const u = await user();
  auth.setJiraToken(u.id, { email: 'n@kms-technology.com', token: TOKEN });
  auth.clearJiraToken(u.id);
  assert.strictEqual(auth.jiraCredsFor(u.id), null);
  assert.strictEqual(auth.jiraHint(u.id).has, false);
  assert.strictEqual(auth.findUser(u.id).jira_token_enc, null, 'the ciphertext was left behind');
});

check('ONE PERSON\'S TOKEN IS NOT ANOTHER\'S', async () => {
  const a = await user();
  const b = await user();
  auth.setJiraToken(a.id, { email: 'a@kms-technology.com', token: `${TOKEN}-A` });
  auth.setJiraToken(b.id, { email: 'b@kms-technology.com', token: `${TOKEN}-B` });
  assert.strictEqual(auth.jiraCredsFor(a.id).token, `${TOKEN}-A`);
  assert.strictEqual(auth.jiraCredsFor(b.id).token, `${TOKEN}-B`);
  auth.clearJiraToken(a.id);
  assert.strictEqual(auth.jiraCredsFor(b.id).token, `${TOKEN}-B`, 'clearing one cleared the other');
});

check('AN UNREADABLE TOKEN IS DISTINGUISHED FROM NO TOKEN', async () => {
  /* "Add your token" is confusing advice for somebody who can see they
     already did. The two states need different sentences, so they need to be
     different states. */
  const u = await user();
  auth.setJiraToken(u.id, { email: 'n@kms-technology.com', token: TOKEN });
  auth.db().prepare('UPDATE user SET jira_token_enc = ? WHERE id = ?').run('v1.aa.bb.cc', u.id);
  const h = auth.jiraHint(u.id);
  assert.strictEqual(h.has, false);
  assert.strictEqual(h.unreadable, true, 'a corrupt token looks identical to no token');
  assert.strictEqual(auth.jiraCredsFor(u.id), null, 'and it must not be handed out');
});

check('a blank token is refused rather than stored as emptiness', async () => {
  const u = await user();
  for (const bad of ['', '   ', null, undefined]) {
    assert.throws(() => auth.setJiraToken(u.id, { email: 'n@kms-technology.com', token: bad }), /token is needed/);
  }
  assert.strictEqual(auth.jiraHint(u.id).has, false);
});

check('and a malformed Jira email too', async () => {
  const u = await user();
  assert.throws(() => auth.setJiraToken(u.id, { email: 'not an email', token: TOKEN }), /does not look like/);
});

check('DELETING A USER TAKES THEIR TOKEN WITH THEM', async () => {
  const u = await user();
  auth.setJiraToken(u.id, { email: 'n@kms-technology.com', token: TOKEN });
  auth.db().prepare('DELETE FROM user WHERE id = ?').run(u.id);
  assert.strictEqual(auth.jiraCredsFor(u.id), null);
  const rows = auth.db().prepare('SELECT COUNT(*) AS n FROM user WHERE jira_token_enc IS NOT NULL AND id = ?').get(u.id);
  assert.strictEqual(rows.n, 0);
});

check('saving a token CLEARS the last-checked stamp', async () => {
  // A new token has not been verified, whatever was true of the old one.
  const u = await user();
  auth.setJiraToken(u.id, { email: 'n@kms-technology.com', token: TOKEN });
  auth.markJiraChecked(u.id);
  assert.ok(auth.jiraHint(u.id).checkedAt, 'fixture check: it should be stamped');
  auth.setJiraToken(u.id, { email: 'n@kms-technology.com', token: `${TOKEN}-new` });
  assert.strictEqual(auth.jiraHint(u.id).checkedAt, null, 'a replaced token kept the old verification');
});

/* ── the migration ───────────────────────────────────────────────────── */

check('AN EXISTING auth.db UPGRADES IN PLACE, keeping its accounts', async () => {
  /* The columns arrived in migration 2. Somebody who switched authentication
     on last week has a v1 database with real accounts in it, and the upgrade
     must not be "delete it and start again". */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-mig-'));
  const file = path.join(dir, 'auth.db');
  const { DatabaseSync } = require('node:sqlite');

  // A v1 database, built by hand the way migration 1 leaves it.
  const h = new DatabaseSync(file);
  h.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);
    CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, password_hash TEXT,
      google_sub TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'active', must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, created_by TEXT, last_seen_at TEXT);
    CREATE TABLE user_role (user_id TEXT NOT NULL, role TEXT NOT NULL, team_id TEXT);
    CREATE UNIQUE INDEX idx_role_once ON user_role(user_id, role, COALESCE(team_id, ''));
    CREATE INDEX idx_role_user ON user_role(user_id);
    CREATE TABLE session (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, last_seen_at TEXT, ip TEXT, user_agent TEXT, revoked_at TEXT);
    CREATE TABLE login_attempt (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, ip TEXT, at TEXT NOT NULL, ok INTEGER NOT NULL);
    CREATE TABLE setup_token (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
    INSERT INTO schema_version VALUES (1, 'identity', '2026-10-01T00:00:00.000Z');
    INSERT INTO user (id, email, name, created_at) VALUES ('old-1', 'already@kms-technology.com', 'Already Here', '2026-10-01T00:00:00.000Z');
    INSERT INTO user_role (user_id, role, team_id) VALUES ('old-1', 'lead', 'ruby');`);
  h.close();

  auth.openAt(file);     // runs migration 2
  const u = auth.findByEmail('already@kms-technology.com');
  assert.ok(u, 'the upgrade lost an existing account');
  assert.deepStrictEqual(auth.actorFor(u.id).leadTeams, ['ruby'], 'it lost their team scope');
  assert.strictEqual(auth.jiraHint(u.id).has, false, 'an upgraded row should have no token yet');
  auth.setJiraToken(u.id, { email: 'n@kms-technology.com', token: TOKEN });
  assert.strictEqual(auth.jiraCredsFor(u.id).token, TOKEN, 'the new columns do not work after an upgrade');

  auth.close();
  fs.rmSync(dir, { recursive: true, force: true });
  auth.openAt(path.join(SCRATCH, 'store', 'auth.db'));   // back to this file's own
});

/* ── run ──────────────────────────────────────────────────────────────── */

(async () => {
  for (const { name, fn } of pending) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (err) {
      failed++; console.log(`FAIL  ${name}\n      ${err.message}`);
    }
  }
  auth.close();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log(`\njira-token.test.js: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
