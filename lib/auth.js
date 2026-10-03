'use strict';
/**
 * auth.js — who is using this tool, and what they are allowed to be.
 *
 * This file answers IDENTITY only: accounts, passwords, sessions, roles. What
 * each role may DO is `lib/policy.js`, and the two are deliberately apart —
 * "is this Nghiep" and "may Nghiep edit Titan's capacity" are different
 * questions with different failure modes, and a module that answers both tends
 * to answer the second by accident while answering the first.
 *
 * ── WHY A SEPARATE DATABASE ──────────────────────────────────────────────
 *
 * `auth.db`, not `planning.db`. `/api/reset` rewrites the planning store from
 * Jira and `/api/import` replaces it wholesale; both are routine, and both
 * would take every account with them. Worse, the account that would be
 * destroyed is the one you need in order to log in and fix it. Two files means
 * the planning store stays as disposable as it has always been.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────
 *
 * No Google. The OAuth path lands later and attaches to these same rows —
 * `google_sub` is already in the schema so that arriving does not need a
 * migration of live accounts. Identity is the EMAIL; password and Google are
 * two ways of proving it, and an account must be able to hold both.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const secrets = require('./secrets');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  throw new Error(
    'This build of Node has no node:sqlite. The planning tool needs Node 22.5 or newer '
    + `(this is ${process.version}). Original error: ${err.message}`,
  );
}

const scrypt = promisify(crypto.scrypt);

/* Resolved exactly as db.js resolves its own, rather than by importing it:
   auth must be able to open before the planning store exists, and on a machine
   where the planning store is broken. */
const ROOT = process.env.STORE_DIR || path.join(__dirname, '..', 'data');
const STORE_DIR = path.join(ROOT, 'store');
let DB_FILE = process.env.AUTH_DB_FILE || path.join(STORE_DIR, 'auth.db');
const dbFile = () => DB_FILE;

/* ─────────────────────────── roles ─────────────────────────── */

/**
 * Three roles, in order of authority.
 *
 * MEMBER IS THE FLOOR, not a stored fact: a signed-in account with no role row
 * is a member. That way "we forgot to assign a role" fails to read-only rather
 * than to no access at all — and, more importantly, there is no state in which
 * a user exists with no answer to "what are they".
 *
 * LEAD IS SCOPED. A lead row carries the team it is a lead OF, and a lead of
 * Ruby is a plain member everywhere else. An unscoped lead would be an admin
 * without the settings screen, which is not a tier worth having.
 *
 * PROJECT ADMIN is global by construction — `team_id` must be null on it.
 */
const ROLES = ['member', 'lead', 'project-admin'];
const RANK = { member: 0, lead: 1, 'project-admin': 2 };
const SCOPED = new Set(['lead']);

const PASSWORD_MIN = 12;

/* ─────────────────────────── schema ─────────────────────────── */

const MIGRATIONS = [
  {
    version: 1,
    name: 'identity',
    sql: `
    /* password_hash and google_sub are BOTH nullable, and an account needs at
       least one of them to be usable. A password-only account today, a Google
       login attached to it tomorrow, and the row never moves. */
    CREATE TABLE user (
      id                   TEXT PRIMARY KEY,
      email                TEXT NOT NULL UNIQUE,   -- always lowercased on the way in
      name                 TEXT,
      password_hash        TEXT,
      google_sub           TEXT UNIQUE,
      status               TEXT NOT NULL DEFAULT 'active',   -- active | disabled
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT NOT NULL,
      created_by           TEXT,
      last_seen_at         TEXT
    );

    CREATE TABLE user_role (
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      role    TEXT NOT NULL,
      team_id TEXT                                  -- null except on 'lead'
    );
    /* NOT a PRIMARY KEY over (user_id, role, team_id).
       SQLite permits NULLs in a PRIMARY KEY — a documented departure from the
       standard, kept for backwards compatibility — so ('u','project-admin',NULL)
       inserts twice without complaint and the admin ends up with two role rows.
       COALESCE in a unique index is what actually makes it unique. */
    CREATE UNIQUE INDEX idx_role_once ON user_role(user_id, role, COALESCE(team_id, ''));
    CREATE INDEX idx_role_user ON user_role(user_id);

    /* THE ID HERE IS A HASH OF THE COOKIE, never the cookie itself — see
       startSession(). */
    CREATE TABLE session (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      issued_at    TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      last_seen_at TEXT,
      ip           TEXT,
      user_agent   TEXT,
      revoked_at   TEXT
    );
    CREATE INDEX idx_session_user ON session(user_id);
    CREATE INDEX idx_session_exp  ON session(expires_at);

    CREATE TABLE login_attempt (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      ip    TEXT,
      at    TEXT NOT NULL,
      ok    INTEGER NOT NULL
    );
    CREATE INDEX idx_attempt_email ON login_attempt(email, at);
    CREATE INDEX idx_attempt_ip    ON login_attempt(ip, at);

    /* Hashed like a session, for the same reason: the console prints it once
       and nothing afterwards can read it back out of the file. */
    CREATE TABLE setup_token (
      id         TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at    TEXT
    );
  `,
  },
  {
    version: 2,
    name: 'jira-credentials',
    sql: `
    /* PER-USER JIRA CREDENTIALS.
       The three write-through routes (points, due date, sprint move) change a
       REAL ticket. Sending them under one shared admin token makes this tool a
       way around Jira's own permissions and puts one name on every change in
       Jira's history. Under the actor's own token, Jira decides — and its
       audit trail names the person.

       The token is stored ENCRYPTED (see lib/secrets.js), which protects a
       copy of this file, not the machine it sits on. Nullable throughout: an
       account without one simply cannot push to Jira, which is the correct
       default. */
    ALTER TABLE user ADD COLUMN jira_email TEXT;
    ALTER TABLE user ADD COLUMN jira_token_enc TEXT;
    ALTER TABLE user ADD COLUMN jira_checked_at TEXT;
  `,
  },
];

/* ─────────────────────────── open ─────────────────────────── */

let handle = null;

function db() {
  if (handle) return handle;
  fs.mkdirSync(STORE_DIR, { recursive: true });
  try {
    handle = new DatabaseSync(DB_FILE);
    handle.exec('SELECT 1');
  } catch (err) {
    throw new Error(
      `Could not open the accounts database at ${DB_FILE} (${err.message}). `
      + 'This usually means the folder is on a filesystem that does not support file locking — '
      + 'a network drive, or a synced folder. Move the tool to a local folder, or point STORE_DIR at one.',
    );
  }
  try {
    handle.exec('PRAGMA journal_mode = WAL');
    handle.exec('PRAGMA synchronous = NORMAL');
  } catch (_) {
    try { handle.exec('PRAGMA journal_mode = DELETE'); } catch (_) { /* whatever it defaults to */ }
    handle.exec('PRAGMA synchronous = FULL');
  }
  // The role cascade is load bearing: deleting a user must take their roles and
  // sessions with them, or a recycled id inherits someone else's authority.
  handle.exec('PRAGMA foreign_keys = ON');
  migrate(handle);
  return handle;
}

function migrate(h) {
  h.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
  const done = new Set(h.prepare('SELECT version FROM schema_version').all().map(r => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    h.exec('BEGIN');
    try {
      h.exec(m.sql);
      h.prepare('INSERT INTO schema_version VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
      h.exec('COMMIT');
    } catch (err) {
      h.exec('ROLLBACK');
      throw new Error(`Auth migration ${m.version} (${m.name}) failed: ${err.message}`);
    }
  }
}

function close() {
  if (handle) { try { handle.close(); } catch (_) { /* already gone */ } }
  handle = null;
}

/** Point the module at another file — the tests, and nothing else. */
function openAt(file) {
  close();
  DB_FILE = file;
  process.env.AUTH_DB_FILE = file;
  return db();
}

const all = (sql, ...p) => db().prepare(sql).all(...p);
const get = (sql, ...p) => db().prepare(sql).get(...p);
const run = (sql, ...p) => db().prepare(sql).run(...p);

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

/* ─────────────────────────── passwords ─────────────────────────── */

/**
 * scrypt, with the parameters stored beside the hash.
 *
 * THE PARAMETERS ARE IN THE STRING, not a constant in this file. The cost of a
 * password hash has to rise with hardware, and a bare hash cannot be verified
 * once the constant moves — every stored password would be unverifiable at the
 * moment you hardened the setting. Written as `scrypt$N=...$salt$hash`, old
 * hashes keep verifying under their own parameters and `needsRehash` says which
 * ones to upgrade next time their owner signs in and the password is in hand.
 *
 * N=2^15 r=8 p=1 needs 128·N·r = 32 MiB, which is EXACTLY Node's default
 * `maxmem`, and scrypt throws when it reaches the limit rather than when it
 * exceeds it. The explicit 64 MiB is not a tuning choice, it is the difference
 * between this working and throwing "memory limit exceeded" on every login.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

async function hashPassword(password, params = SCRYPT) {
  assertPasswordAllowed(password);
  const salt = crypto.randomBytes(16);
  const key = await scrypt(normalisePassword(password), salt, params.keylen, params);
  return `scrypt$N=${params.N},r=${params.r},p=${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function parseHash(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return null;
  const params = {};
  for (const bit of parts[1].split(',')) {
    const [k, v] = bit.split('=');
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return null;
    params[k] = n;
  }
  if (!params.N || !params.r || !params.p) return null;
  let salt, key;
  try { salt = Buffer.from(parts[2], 'base64'); key = Buffer.from(parts[3], 'base64'); } catch (_) { return null; }
  if (!salt.length || !key.length) return null;
  return { params, salt, key };
}

/**
 * Verify, in constant time, and in the SAME time whether or not the account
 * exists.
 *
 * A missing account that returns instantly while a wrong password takes 100 ms
 * is an account-enumeration oracle: anyone can discover which addresses are
 * registered by timing the login form. So a null hash still does the work, on a
 * throwaway salt, and discards it.
 */
async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  const use = parsed || { params: SCRYPT, salt: crypto.randomBytes(16), key: Buffer.alloc(SCRYPT.keylen) };
  let key;
  try {
    key = await scrypt(normalisePassword(password), use.salt, use.key.length, { ...use.params, maxmem: SCRYPT.maxmem });
  } catch (_) {
    return false;   // absurd stored parameters; treat as a failed login, not a crash
  }
  if (!parsed) return false;
  if (key.length !== use.key.length) return false;
  return crypto.timingSafeEqual(key, use.key);
}

/** True when this hash was made with weaker parameters than we now use. */
function needsRehash(stored) {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return parsed.params.N < SCRYPT.N || parsed.params.r < SCRYPT.r || parsed.params.p < SCRYPT.p
    || parsed.key.length < SCRYPT.keylen;
}

/* NFKC, so a password typed with a composed accent and the same password typed
   with a combining one are the same password. Without it, a user whose
   passphrase contains "é" can set it on one keyboard and be locked out on
   another, with nothing on screen to explain it. */
const normalisePassword = (p) => String(p == null ? '' : p).normalize('NFKC');

/**
 * LENGTH, AND A BLOCKLIST OF THE OBVIOUS — not a composition rule.
 *
 * "One upper, one digit, one symbol" reliably produces `Password1!`, which is
 * in every cracking dictionary. Length is what actually costs an attacker, so
 * the floor is 12 characters and the only other rule refuses the handful of
 * passwords that a list would try first.
 */
function assertPasswordAllowed(password) {
  const p = normalisePassword(password);
  if (p.length < PASSWORD_MIN) {
    const e = new Error(`A password needs at least ${PASSWORD_MIN} characters.`);
    e.code = 'weak-password'; e.status = 400; throw e;
  }
  if (p.length > 1024) {
    // Not a security rule — a guard on the memory-hard function. A multi-megabyte
    // "password" is a cheap way to make the server do expensive work.
    const e = new Error('That password is too long.');
    e.code = 'weak-password'; e.status = 400; throw e;
  }
  /* CHECKED WITH THE DECORATION STRIPPED, because the decoration is the whole
     problem. "At least 12 characters, one capital, one digit, one symbol"
     produces `Password123!` with remarkable reliability — it satisfies every
     rule, it is twelve characters, and it is near the top of every cracking
     list. Comparing the bare letters catches that family (Qwerty2026!,
     Admin1234, Changeme99) without rejecting a real passphrase, whose stem is
     not a dictionary word in the first place. */
  const lower = p.toLowerCase();
  const bare = lower.replace(/[^a-z]+$/, '');
  if (COMMON.has(lower) || COMMON.has(bare)) {
    const e = new Error('That password is too easy to guess. Pick something else.');
    e.code = 'weak-password'; e.status = 400; throw e;
  }
}

const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', '123456', '12345678',
  '123456789', '1234567890', 'qwerty', 'qwertyuiop', 'letmein', 'welcome',
  'welcome1', 'admin', 'administrator', 'iloveyou', 'abc123', 'monkey',
  'dragon', 'football', 'baseball', 'sunshine', 'princess', 'changeme',
  'planningtool', 'kmstechnology', 'katalon',
]);

/* ─────────────────────────── users ─────────────────────────── */

/**
 * Email IS the identity.
 *
 * Lowercased and trimmed on the way in so that `Nghiep@` and `nghiep@` cannot
 * become two accounts — which matters most at the moment Google arrives, since
 * the ID token's email is whatever Google feels like capitalising.
 */
const normaliseEmail = (e) => String(e == null ? '' : e).trim().toLowerCase();

/* Deliberately permissive. This is not the place to re-litigate RFC 5322; it
   exists to catch a blank box and an obvious typo, and an address that gets
   past it simply never receives mail. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertEmail(email) {
  if (!EMAIL_RE.test(email)) {
    const e = new Error(`"${email}" does not look like an email address.`);
    e.code = 'bad-email'; e.status = 400; throw e;
  }
}

async function createUser({ email, name = null, password = null, roles = [], createdBy = null }) {
  const addr = normaliseEmail(email);
  assertEmail(addr);
  // Hashed BEFORE the insert: a weak password must not leave a half-made
  // account behind, and assertPasswordAllowed throws from in here.
  const hash = password == null ? null : await hashPassword(password);
  const uid = id();
  const h = db();
  h.exec('BEGIN');
  try {
    h.prepare(`INSERT INTO user (id, email, name, password_hash, status, created_at, created_by)
               VALUES (?, ?, ?, ?, 'active', ?, ?)`)
      .run(uid, addr, name, hash, now(), createdBy);
    for (const r of roles) addRoleRow(h, uid, r.role, r.teamId || null);
    h.exec('COMMIT');
  } catch (err) {
    h.exec('ROLLBACK');
    if (/UNIQUE/.test(err.message)) {
      const e = new Error(`${addr} already has an account.`);
      e.code = 'email-taken'; e.status = 409; throw e;
    }
    throw err;
  }
  return findUser(uid);
}

const findUser = (uid) => get('SELECT * FROM user WHERE id = ?', uid) || null;
const findByEmail = (email) => get('SELECT * FROM user WHERE email = ?', normaliseEmail(email)) || null;
const listUsers = () => all('SELECT * FROM user ORDER BY email');
const countUsers = () => (get('SELECT COUNT(*) AS n FROM user') || {}).n || 0;

async function setPassword(uid, password, { mustChange = false } = {}) {
  const hash = await hashPassword(password);
  const r = run('UPDATE user SET password_hash = ?, must_change_password = ? WHERE id = ?',
    hash, mustChange ? 1 : 0, uid);
  if (!r.changes) throw notFound(uid);
  return true;
}

/**
 * Disabling revokes every session in the same breath.
 *
 * Flipping a status column alone leaves the person signed in until their cookie
 * expires — which is to say, the control that exists to remove someone's access
 * does not remove their access.
 */
function setStatus(uid, status) {
  if (status !== 'active' && status !== 'disabled') throw new Error(`Unknown status "${status}"`);
  const h = db();
  h.exec('BEGIN');
  try {
    const r = h.prepare('UPDATE user SET status = ? WHERE id = ?').run(status, uid);
    if (!r.changes) throw notFound(uid);
    if (status === 'disabled') {
      h.prepare('UPDATE session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now(), uid);
    }
    h.exec('COMMIT');
  } catch (err) { h.exec('ROLLBACK'); throw err; }
  return findUser(uid);
}

function notFound(uid) {
  const e = new Error(`No account ${uid}`);
  e.code = 'no-such-user'; e.status = 404;
  return e;
}

/* ─────────────────────────── roles ─────────────────────────── */

function addRoleRow(h, uid, role, teamId) {
  if (!ROLES.includes(role)) {
    const e = new Error(`Unknown role "${role}". Roles are: ${ROLES.join(', ')}.`);
    e.code = 'bad-role'; e.status = 400; throw e;
  }
  /* A SCOPED ROLE WITHOUT A SCOPE IS A SILENT PROMOTION. A 'lead' row with a
     null team would read, to any sane `leadTeams` implementation, as a lead of
     nothing — or, to a careless one, as a lead of everything. Refused outright,
     because the second reading is one typo away. */
  if (SCOPED.has(role) && !teamId) {
    const e = new Error('A lead has to be a lead of a specific team.');
    e.code = 'role-needs-team'; e.status = 400; throw e;
  }
  if (!SCOPED.has(role) && teamId) {
    const e = new Error(`The ${role} role is global — it cannot be scoped to a team.`);
    e.code = 'role-not-scoped'; e.status = 400; throw e;
  }
  h.prepare('INSERT OR IGNORE INTO user_role (user_id, role, team_id) VALUES (?, ?, ?)')
    .run(uid, role, SCOPED.has(role) ? String(teamId) : null);
}

function grant(uid, role, teamId = null) {
  if (!findUser(uid)) throw notFound(uid);
  addRoleRow(db(), uid, role, teamId);
  return rolesFor(uid);
}

function revoke(uid, role, teamId = null) {
  run('DELETE FROM user_role WHERE user_id = ? AND role = ? AND COALESCE(team_id, \'\') = ?',
    uid, role, teamId == null ? '' : String(teamId));
  return rolesFor(uid);
}

const rolesFor = (uid) =>
  all('SELECT role, team_id AS teamId FROM user_role WHERE user_id = ? ORDER BY role, team_id', uid);

/**
 * The shape every other module should ask for: one user, resolved.
 *
 * `role` is the HIGHEST held, and `leadTeams` carries the scope that makes the
 * lead tier mean anything. Both are computed here, once, so that no caller has
 * to decide what a user with both a lead row and an admin row is.
 */
function actorFor(uid) {
  const u = findUser(uid);
  if (!u) return null;
  const rows = rolesFor(uid);
  let role = 'member';
  for (const r of rows) if (RANK[r.role] > RANK[role]) role = r.role;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    status: u.status,
    role,
    // A project admin is not "a lead of everything" — policy.js decides that.
    // Overloading this list would hide the distinction from the audit log.
    leadTeams: rows.filter(r => r.role === 'lead' && r.teamId).map(r => r.teamId),
    mustChangePassword: !!u.must_change_password,
  };
}

/** Is this actor a lead of this specific team? Never true for a missing team. */
const leads = (actor, teamId) =>
  !!(actor && teamId && actor.leadTeams && actor.leadTeams.includes(String(teamId)));

/* ─────────────────────────── sessions ─────────────────────────── */

const SESSION_DAYS = 14;
const SESSION_COOKIE = 'pt_session';

/* The cookie's value, hashed, is the row id. */
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * A session token is 32 bytes of CSPRNG and the DATABASE STORES ITS HASH.
 *
 * WHY NO HMAC SIGNATURE. The earlier sketch had one. It buys nothing here: the
 * token is already 256 bits of randomness, so forging a valid-looking cookie is
 * not a thing an attacker does — they steal one instead. What an HMAC WOULD add
 * is a server secret to generate, store, rotate and lose, whose loss signs
 * everybody out.
 *
 * Hashing at rest, on the other hand, buys something real and specific: a copy
 * of `auth.db` — a backup, a support dump, this very tool's own `/api/backup`
 * route — contains no usable session tokens. The cookie is the only place the
 * live value ever exists.
 */
function startSession(uid, { ip = null, userAgent = null, days = SESSION_DAYS } = {}) {
  const u = findUser(uid);
  if (!u) throw notFound(uid);
  if (u.status !== 'active') {
    const e = new Error('That account is disabled.');
    e.code = 'disabled'; e.status = 403; throw e;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + days * 864e5).toISOString();
  run(`INSERT INTO session (id, user_id, issued_at, expires_at, last_seen_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  hashToken(token), uid, now(), expires, now(), ip, userAgent);
  run('UPDATE user SET last_seen_at = ? WHERE id = ?', now(), uid);
  return { token, expiresAt: expires };
}

/**
 * Resolve a cookie to an actor, or null.
 *
 * EVERY REASON TO REFUSE RETURNS THE SAME null — expired, revoked, unknown
 * token, deleted user, disabled account. The caller has nothing to branch on
 * and so cannot accidentally leak which it was.
 */
function sessionActor(token) {
  if (!token) return null;
  const row = get('SELECT * FROM session WHERE id = ?', hashToken(token));
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at <= now()) return null;
  const actor = actorFor(row.user_id);
  if (!actor || actor.status !== 'active') return null;
  return { ...actor, sessionId: row.id, sessionExpiresAt: row.expires_at };
}

/** Touch last-seen. Separate from `sessionActor` so a read stays a read. */
function touchSession(token) {
  const at = now();
  const r = run('UPDATE session SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL', at, hashToken(token));
  if (r.changes) {
    const row = get('SELECT user_id FROM session WHERE id = ?', hashToken(token));
    if (row) run('UPDATE user SET last_seen_at = ? WHERE id = ?', at, row.user_id);
  }
  return !!r.changes;
}

const endSession = (token) =>
  !!run('UPDATE session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now(), hashToken(token)).changes;

const endAllSessions = (uid) =>
  run('UPDATE session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now(), uid).changes;

const sessionsFor = (uid) =>
  all(`SELECT id, issued_at AS issuedAt, expires_at AS expiresAt, last_seen_at AS lastSeenAt,
              ip, user_agent AS userAgent, revoked_at AS revokedAt
       FROM session WHERE user_id = ? ORDER BY issued_at DESC`, uid);

/** Drop sessions that expired a while ago. Housekeeping, never load bearing. */
const pruneSessions = (keepDays = 30) =>
  run('DELETE FROM session WHERE expires_at < ?', new Date(Date.now() - keepDays * 864e5).toISOString()).changes;

/* ─────────────────────────── throttling ─────────────────────────── */

/**
 * Two limits, because they catch two different attacks.
 *
 *   per ACCOUNT  — someone guessing one person's password
 *   per ADDRESS  — someone trying one common password against many accounts,
 *                  which never trips a per-account counter at all
 *
 * Exponential after the fifth failure, capped, and the window is rolling rather
 * than fixed: a fixed window resets on the hour, and an attacker who knows that
 * simply waits for it.
 */
const WINDOW_MS = 15 * 60 * 1000;
const FREE_TRIES = 5;
const MAX_DELAY_MS = 15 * 60 * 1000;
const IP_CEILING = 30;

function recordAttempt(email, ip, ok) {
  run('INSERT INTO login_attempt (email, ip, at, ok) VALUES (?, ?, ?, ?)',
    email == null ? null : normaliseEmail(email), ip || null, now(), ok ? 1 : 0);
  // A success clears that account's slate, so a person who mistypes twice and
  // then gets in is not still being punished an hour later.
  if (ok && email) run('DELETE FROM login_attempt WHERE email = ? AND ok = 0', normaliseEmail(email));
}

function throttle(email, ip) {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const addr = email == null ? null : normaliseEmail(email);

  const byIp = ip
    ? ((get('SELECT COUNT(*) AS n FROM login_attempt WHERE ip = ? AND ok = 0 AND at > ?', ip, since) || {}).n || 0)
    : 0;
  if (byIp >= IP_CEILING) {
    return { ok: false, retryAfterSec: Math.ceil(MAX_DELAY_MS / 1000), reason: 'address' };
  }

  const fails = addr
    ? ((get('SELECT COUNT(*) AS n FROM login_attempt WHERE email = ? AND ok = 0 AND at > ?', addr, since) || {}).n || 0)
    : 0;
  if (fails < FREE_TRIES) return { ok: true, failures: fails };

  const delay = Math.min(MAX_DELAY_MS, 1000 * 2 ** (fails - FREE_TRIES));
  const last = get('SELECT at FROM login_attempt WHERE email = ? AND ok = 0 ORDER BY at DESC LIMIT 1', addr);
  const waited = Date.now() - new Date(last.at).getTime();
  if (waited >= delay) return { ok: true, failures: fails };
  return { ok: false, retryAfterSec: Math.ceil((delay - waited) / 1000), reason: 'account', failures: fails };
}

/**
 * The whole sign-in, in one call.
 *
 * ONE ERROR FOR EVERY FAILURE a stranger could cause — wrong password, unknown
 * address, no password set on the account. Telling them apart tells an attacker
 * which addresses are real. 'disabled' and 'throttled' ARE distinguished,
 * because both are states a legitimate user needs to understand and neither
 * reveals anything they could not already determine.
 */
async function signIn({ email, password, ip = null, userAgent = null }) {
  const addr = normaliseEmail(email);
  const gate = throttle(addr, ip);
  if (!gate.ok) {
    const e = new Error(`Too many attempts. Try again in ${gate.retryAfterSec} seconds.`);
    e.code = 'throttled'; e.status = 429; e.retryAfterSec = gate.retryAfterSec; throw e;
  }

  const u = findByEmail(addr);
  // Still hashes when there is no user — see verifyPassword.
  const good = await verifyPassword(password, u ? u.password_hash : null);

  if (!u || !u.password_hash || !good) {
    recordAttempt(addr, ip, false);
    const e = new Error('That email and password do not match.');
    e.code = 'bad-credentials'; e.status = 401; throw e;
  }
  if (u.status !== 'active') {
    recordAttempt(addr, ip, false);
    const e = new Error('That account is disabled.');
    e.code = 'disabled'; e.status = 403; throw e;
  }

  recordAttempt(addr, ip, true);
  // Upgrade the stored hash while the password is in hand — the only moment it
  // is possible.
  if (needsRehash(u.password_hash)) {
    try { await setPassword(u.id, password, { mustChange: !!u.must_change_password }); } catch (_) { /* never block a good login */ }
  }
  const session = startSession(u.id, { ip, userAgent });
  return { ...session, actor: actorFor(u.id) };
}

/* ─────────────────────────── first run ─────────────────────────── */

const SETUP_TTL_MS = 30 * 60 * 1000;

/**
 * THE FIRST ADMIN, without a password in a config file.
 *
 * The alternative everyone reaches for is a bootstrap account with a known
 * password in `config.json`, and it is always still there a year later. This
 * prints a one-time token to the console instead — which only the person
 * running the process can read — and the token dies on first use or in half an
 * hour, whichever comes first.
 *
 * Returns null when accounts already exist, so a restart cannot reopen the door.
 */
function issueSetupToken() {
  if (countUsers() > 0) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  run('DELETE FROM setup_token WHERE used_at IS NULL');   // only ever one live
  run('INSERT INTO setup_token (id, created_at, expires_at) VALUES (?, ?, ?)',
    hashToken(token), now(), new Date(Date.now() + SETUP_TTL_MS).toISOString());
  return token;
}

async function claimSetupToken(token, { email, name = null, password }) {
  const row = get('SELECT * FROM setup_token WHERE id = ?', hashToken(token));
  const bad = () => {
    const e = new Error('That setup link is not valid. Restart the server to get a new one.');
    e.code = 'bad-setup-token'; e.status = 400; return e;
  };
  if (!row || row.used_at || row.expires_at <= now()) throw bad();
  /* Checked AGAIN here, not only in issueSetupToken. Between printing the token
     and claiming it, somebody else may have claimed it — and a second
     project-admin created from a token that was meant to make the first is
     exactly the hole this is supposed to close. */
  if (countUsers() > 0) throw bad();

  const u = await createUser({ email, name, password, roles: [{ role: 'project-admin' }], createdBy: 'setup' });
  run('UPDATE setup_token SET used_at = ? WHERE id = ?', now(), hashToken(token));
  return u;
}

/** True when this install has no accounts and is waiting to be set up. */
const needsSetup = () => countUsers() === 0;

/* ─────────────────────── per-user Jira credentials ─────────────────────── */

/**
 * Store one person's Jira email and API token.
 *
 * THE TOKEN IS ENCRYPTED ON THE WAY IN and never comes back out through any
 * route — `jiraHint` is what a screen gets. The only consumer of the plaintext
 * is `jiraCredsFor`, called server-side at the moment a write goes to Jira.
 */
function setJiraToken(uid, { email, token }) {
  if (!findUser(uid)) throw notFound(uid);
  const addr = normaliseEmail(email);
  assertEmail(addr);
  const t = String(token == null ? '' : token).trim();
  if (!t) {
    const e = new Error('A Jira API token is needed.');
    e.code = 'no-token'; e.status = 400; throw e;
  }
  run('UPDATE user SET jira_email = ?, jira_token_enc = ?, jira_checked_at = NULL WHERE id = ?',
    addr, secrets.encrypt(t), uid);
  return jiraHint(uid);
}

const clearJiraToken = (uid) =>
  !!run('UPDATE user SET jira_email = NULL, jira_token_enc = NULL, jira_checked_at = NULL WHERE id = ?', uid).changes;

/**
 * The plaintext credentials, for one outbound call. Server-side only.
 *
 * Returns null when there is nothing stored OR when the stored value cannot be
 * decrypted — a rotated key, a restored backup without its key file. Both mean
 * the same thing to the caller: this person cannot push to Jira, tell them to
 * re-enter it. A throw here would surface as a crash on the capacity screen.
 */
function jiraCredsFor(uid) {
  const u = findUser(uid);
  if (!u || !u.jira_token_enc || !u.jira_email) return null;
  const token = secrets.decrypt(u.jira_token_enc);
  if (!token) return null;
  return { email: u.jira_email, token };
}

/** What a SCREEN may know: that one is saved, whose it is, and its last four. */
function jiraHint(uid) {
  const u = findUser(uid);
  if (!u) return { has: false };
  const token = u.jira_token_enc ? secrets.decrypt(u.jira_token_enc) : null;
  return {
    has: !!token,
    email: u.jira_email || null,
    hint: secrets.hint(token),
    checkedAt: u.jira_checked_at || null,
    /* A token that is stored but will not decrypt is NOT the same as no token,
       and the screen has to say which — "add your token" is confusing advice
       for somebody who can see they already did. */
    unreadable: !!u.jira_token_enc && !token,
  };
}

const markJiraChecked = (uid) => run('UPDATE user SET jira_checked_at = ? WHERE id = ?', now(), uid).changes;

/* ─────────────────────────── cookies ─────────────────────────── */

/**
 * Parse a Cookie header. Deliberately tiny — the only cookie this app sets is
 * its own, and a general-purpose parser here would be more code than the thing
 * it parses.
 */
function readCookie(header, name = SESSION_COOKIE) {
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(at + 1).trim()); } catch (_) { return part.slice(at + 1).trim(); }
  }
  return null;
}

/**
 * HttpOnly so a cross-site script cannot read it; SameSite=Lax so another site
 * cannot ride it; Secure once there is TLS in front — passed in rather than
 * assumed, because setting Secure on a plain-HTTP install means the browser
 * silently discards the cookie and the login "succeeds" and does nothing.
 */
function sessionCookie(token, { expiresAt, secure = false } = {}) {
  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

const clearCookie = ({ secure = false } = {}) => {
  const bits = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
};

module.exports = {
  ROLES, RANK, SCOPED, PASSWORD_MIN, SESSION_COOKIE, SESSION_DAYS, SCRYPT,
  db, close, openAt, dbFile,
  hashPassword, verifyPassword, needsRehash, parseHash, assertPasswordAllowed, normalisePassword,
  normaliseEmail, assertEmail,
  createUser, findUser, findByEmail, listUsers, countUsers, setPassword, setStatus,
  grant, revoke, rolesFor, actorFor, leads,
  startSession, sessionActor, touchSession, endSession, endAllSessions, sessionsFor, pruneSessions,
  recordAttempt, throttle, signIn,
  setJiraToken, clearJiraToken, jiraCredsFor, jiraHint, markJiraChecked,
  issueSetupToken, claimSetupToken, needsSetup,
  readCookie, sessionCookie, clearCookie,
};
