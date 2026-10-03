'use strict';
/**
 * auth.test.js — the identity core.
 *
 * Every check here is about a failure that is SILENT in production: a password
 * that verifies when it should not, a session that outlives the account, a
 * "lead" with no team who turns out to lead everything, a disabled user who
 * stays signed in because the control only wrote a column. None of these show
 * up on screen. They show up as somebody seeing something they should not, and
 * nobody ever finds out.
 *
 * Runs against a real sqlite file in a temp directory, not a mock. The whole
 * module is a thin layer over SQL semantics — NULLs in unique indexes, cascade
 * deletes, string date comparison — and a mock would be a second, politer
 * implementation of exactly the things most likely to be wrong.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const auth = require('../lib/auth');

let passed = 0, failed = 0;
const pending = [];
function check(name, fn) { pending.push({ name, fn }); }

/** A fresh database per check — state leaking between them hides order bugs. */
let dir = null;
function fresh() {
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* windows */ } }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-auth-'));
  auth.openAt(path.join(dir, 'auth.db'));
}

const PW = 'correct-horse-battery-staple';
const ADMIN = { email: 'nghieptran@kms-technology.com', name: 'Nghiep Tran', password: PW };

/* ── passwords ────────────────────────────────────────────────────────── */

check('A PASSWORD VERIFIES, AND A WRONG ONE DOES NOT', async () => {
  const h = await auth.hashPassword(PW);
  assert.strictEqual(await auth.verifyPassword(PW, h), true);
  assert.strictEqual(await auth.verifyPassword(`${PW}x`, h), false);
  assert.strictEqual(await auth.verifyPassword('', h), false);
});

check('the stored hash contains NO TRACE of the password', async () => {
  // The one property the whole scheme rests on, and the one a "simplification"
  // to base64 or a plain sha256 would quietly destroy.
  const h = await auth.hashPassword(PW);
  assert.ok(!h.includes(PW), 'the password is sitting in its own hash');
  assert.ok(!Buffer.from(h).toString('base64').includes(Buffer.from(PW).toString('base64')));
  assert.ok(h.startsWith('scrypt$'), 'the hash does not name its algorithm');
});

check('TWO ACCOUNTS WITH THE SAME PASSWORD GET DIFFERENT HASHES', async () => {
  /* Per-user salt. Without it, one cracked hash cracks everyone who chose the
     same password, and equal hashes in the table advertise who those are. */
  const a = await auth.hashPassword(PW);
  const b = await auth.hashPassword(PW);
  assert.notStrictEqual(a, b);
  assert.strictEqual(await auth.verifyPassword(PW, a), true);
  assert.strictEqual(await auth.verifyPassword(PW, b), true);
});

check('THE PARAMETERS TRAVEL WITH THE HASH, so raising the cost cannot lock anyone out', async () => {
  /* The failure this prevents: cost constants live in the source, somebody
     raises them, and every existing password becomes unverifiable at once —
     at the exact moment the change was meant to make things safer. */
  const weak = await auth.hashPassword(PW, { N: 1024, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 });
  assert.match(weak, /N=1024/);
  assert.strictEqual(await auth.verifyPassword(PW, weak), true, 'an old hash stopped verifying');
  assert.strictEqual(auth.needsRehash(weak), true, 'nothing marks it for upgrade');
  assert.strictEqual(auth.needsRehash(await auth.hashPassword(PW)), false);
});

check('THE COMPARISON IS TIMING-SAFE, and that is asserted rather than assumed', async () => {
  /* Replacing timingSafeEqual with === passes every behavioural check in this
     file — the function returns the same answers, just in data-dependent time,
     leaking the hash a byte at a time to anyone patient. There is no way to
     observe that from the outside reliably, so the call itself is the thing
     pinned. Testing the mechanism is the right call precisely when the property
     is invisible in the result. */
  const real = crypto.timingSafeEqual;
  let calls = 0;
  crypto.timingSafeEqual = (...a) => { calls++; return real(...a); };
  try {
    const h = await auth.hashPassword(PW);
    assert.strictEqual(await auth.verifyPassword(PW, h), true);
    assert.ok(calls > 0, 'the password comparison does not go through timingSafeEqual');
  } finally {
    crypto.timingSafeEqual = real;
  }
});

check('a corrupt or empty stored hash is a FAILED LOGIN, not a crash', async () => {
  for (const bad of [null, undefined, '', 'nonsense', 'scrypt$$$', 'scrypt$N=0,r=8,p=1$aaaa$bbbb',
    'scrypt$N=x,r=8,p=1$aaaa$bbbb', 'bcrypt$N=1$a$b']) {
    assert.strictEqual(await auth.verifyPassword(PW, bad), false, `${JSON.stringify(bad)} did not fail cleanly`);
  }
});

check('VERIFYING AGAINST A MISSING ACCOUNT STILL DOES THE WORK', async () => {
  /* Account enumeration by stopwatch. If a null hash returns instantly while a
     real one takes ~100ms, the login form tells anyone who asks which addresses
     are registered. Measured as an order of magnitude, not a tight bound —
     a CI box under load would fail a strict one for no real reason. */
  const h = await auth.hashPassword(PW);
  const t0 = process.hrtime.bigint();
  await auth.verifyPassword(PW, h);
  const real = Number(process.hrtime.bigint() - t0);
  const t1 = process.hrtime.bigint();
  await auth.verifyPassword(PW, null);
  const missing = Number(process.hrtime.bigint() - t1);
  assert.ok(missing > real / 10,
    `a missing account answered ~${Math.round(real / missing)}x faster than a real one — that is an enumeration oracle`);
});

check('a short password is REFUSED at the point of hashing', async () => {
  await assert.rejects(() => auth.hashPassword('short'), /at least 12/);
  await assert.rejects(() => auth.hashPassword(''), /at least 12/);
  /* And the family a composition rule reliably produces: twelve characters,
     a capital, a digit, a symbol — and near the top of every cracking list.
     The bare stem is what gets compared, so the decoration does not launder it. */
  for (const bad of ['Password123!', 'Qwerty123456', 'Changeme2026', 'Welcome12345', 'Katalon1234!']) {
    await assert.rejects(() => auth.hashPassword(bad), /too easy to guess/, `accepted "${bad}"`);
  }
  // ...while a real passphrase of the same shape is fine.
  for (const good of ['correct-horse-battery-staple-2026', 'ruby-sprint-41-capacity!', PW]) {
    assert.ok(await auth.hashPassword(good), `refused a reasonable passphrase: "${good}"`);
  }
});

check('an absurdly long password is refused rather than made into work', async () => {
  // scrypt is memory-hard on purpose; a 5 MB "password" is a free DoS.
  await assert.rejects(() => auth.hashPassword('a'.repeat(5000)), /too long/);
});

check('the same passphrase typed two ways is the SAME password', async () => {
  /* "café" composed vs decomposed. Set it on a Mac, fail to log in on Windows,
     with nothing on screen to explain it. NFKC on both sides. */
  const composed = 'mot-de-passe-café-long';
  const decomposed = 'mot-de-passe-café-long';
  assert.notStrictEqual(composed, decomposed, 'fixture check: these are different strings');
  const h = await auth.hashPassword(composed);
  assert.strictEqual(await auth.verifyPassword(decomposed, h), true);
});

/* ── accounts ─────────────────────────────────────────────────────────── */

check('AN ACCOUNT IS CREATED AND FOUND BY EMAIL', async () => {
  fresh();
  const u = await auth.createUser(ADMIN);
  assert.ok(u.id);
  assert.strictEqual(u.email, ADMIN.email);
  assert.strictEqual(auth.findByEmail(ADMIN.email).id, u.id);
});

check('EMAIL IS THE IDENTITY, so case and spacing cannot fork an account', async () => {
  /* Matters most when Google lands: the ID token's email is capitalised however
     Google feels, and a second account for the same human is the worst possible
     outcome — two sets of roles, one person, no error. */
  fresh();
  const u = await auth.createUser(ADMIN);
  assert.strictEqual(auth.findByEmail('  NghiepTran@KMS-Technology.com  ').id, u.id);
  await assert.rejects(() => auth.createUser({ email: 'NGHIEPTRAN@KMS-TECHNOLOGY.COM', password: PW }),
    /already has an account/);
});

check('a malformed address is refused', async () => {
  fresh();
  for (const bad of ['', 'nobody', 'no body@x.com', 'a@b', '@kms.com']) {
    await assert.rejects(() => auth.createUser({ email: bad, password: PW }), /does not look like/, `accepted "${bad}"`);
  }
});

check('A REJECTED PASSWORD LEAVES NO HALF-MADE ACCOUNT', async () => {
  /* Hash first, insert second. The other order creates the row, throws on the
     password, and leaves an account that exists and can never be signed into. */
  fresh();
  await assert.rejects(() => auth.createUser({ email: 'x@kms-technology.com', password: 'short' }));
  assert.strictEqual(auth.countUsers(), 0, 'an account survived a refused password');
});

check('an account may exist with NO password — the Google path needs it', async () => {
  fresh();
  const u = await auth.createUser({ email: 'sso@kms-technology.com' });
  assert.strictEqual(u.password_hash, null);
  // ...but it cannot be signed into until one is set.
  await assert.rejects(() => auth.signIn({ email: 'sso@kms-technology.com', password: PW }), /do not match/);
});

/* ── roles ────────────────────────────────────────────────────────────── */

check('A USER WITH NO ROLE ROW IS A MEMBER', async () => {
  /* The floor is computed, not stored. "We forgot to assign a role" has to fail
     to read-only, not to an actor with no role at all that every downstream
     check then has to special-case. */
  fresh();
  const u = await auth.createUser({ email: 'new@kms-technology.com', password: PW });
  const a = auth.actorFor(u.id);
  assert.strictEqual(a.role, 'member');
  assert.deepStrictEqual(a.leadTeams, []);
});

check('A LEAD MUST BE A LEAD OF SOMETHING', async () => {
  /* The silent promotion this file exists to prevent. An unscoped lead row
     reads either as a lead of nothing or — to a careless leadTeams — a lead of
     everything, and the second is one typo away. Refused at the source. */
  fresh();
  const u = await auth.createUser({ email: 'lead@kms-technology.com', password: PW });
  assert.throws(() => auth.grant(u.id, 'lead'), /lead of a specific team/);
  assert.throws(() => auth.grant(u.id, 'lead', null), /lead of a specific team/);
  assert.throws(() => auth.grant(u.id, 'lead', ''), /lead of a specific team/);
  assert.deepStrictEqual(auth.rolesFor(u.id), [], 'a refused grant still wrote a row');
});

check('and a GLOBAL role may not be scoped to a team', async () => {
  // 'project-admin of ruby' is not a thing, and storing it would make every
  // "is this user an admin" query depend on which team you asked about.
  fresh();
  const u = await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  assert.throws(() => auth.grant(u.id, 'project-admin', 'ruby'), /cannot be scoped/);
  assert.throws(() => auth.grant(u.id, 'member', 'ruby'), /cannot be scoped/);
});

check('an unknown role is refused', async () => {
  fresh();
  const u = await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  for (const bad of ['admin', 'owner', 'Lead', 'PROJECT-ADMIN', '']) {
    assert.throws(() => auth.grant(u.id, bad, 'ruby'), /Unknown role/, `accepted "${bad}"`);
  }
});

check('LEAD SCOPE IS PER TEAM — Ruby does not imply Titan', async () => {
  fresh();
  const u = await auth.createUser({ email: 'lead@kms-technology.com', password: PW });
  auth.grant(u.id, 'lead', 'ruby');
  const a = auth.actorFor(u.id);
  assert.strictEqual(a.role, 'lead');
  assert.deepStrictEqual(a.leadTeams, ['ruby']);
  assert.strictEqual(auth.leads(a, 'ruby'), true);
  assert.strictEqual(auth.leads(a, 'titan'), false, 'a lead of Ruby came out a lead of Titan');
  assert.strictEqual(auth.leads(a, null), false, 'a missing team id read as permitted');
  assert.strictEqual(auth.leads(a, undefined), false);
  assert.strictEqual(auth.leads(a, ''), false);
});

check('a lead of two teams leads exactly those two', async () => {
  fresh();
  const u = await auth.createUser({ email: 'lead@kms-technology.com', password: PW });
  auth.grant(u.id, 'lead', 'ruby');
  auth.grant(u.id, 'lead', 'titan');
  const a = auth.actorFor(u.id);
  assert.deepStrictEqual(a.leadTeams.slice().sort(), ['ruby', 'titan']);
  assert.strictEqual(auth.leads(a, 'katalon-auto-mex'), false);
});

check('GRANTING TWICE DOES NOT MAKE TWO ROWS — including for a global role', async () => {
  /* SQLite allows NULLs in a PRIMARY KEY, so (user, 'project-admin', NULL)
     inserts twice under a plain PK and the admin quietly has two role rows.
     The COALESCE unique index is the only thing that stops it, and this is the
     check that proves the index is doing it. */
  fresh();
  const u = await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  auth.grant(u.id, 'project-admin');
  auth.grant(u.id, 'project-admin');
  auth.grant(u.id, 'lead', 'ruby');
  auth.grant(u.id, 'lead', 'ruby');
  assert.strictEqual(auth.rolesFor(u.id).length, 2, `got ${JSON.stringify(auth.rolesFor(u.id))}`);
});

check('THE HIGHEST ROLE WINS, and revoking it falls back rather than to nothing', async () => {
  fresh();
  const u = await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  auth.grant(u.id, 'lead', 'ruby');
  auth.grant(u.id, 'project-admin');
  assert.strictEqual(auth.actorFor(u.id).role, 'project-admin');
  auth.revoke(u.id, 'project-admin');
  const a = auth.actorFor(u.id);
  assert.strictEqual(a.role, 'lead', 'demoting an admin dropped them past lead');
  assert.deepStrictEqual(a.leadTeams, ['ruby']);
  auth.revoke(u.id, 'lead', 'ruby');
  assert.strictEqual(auth.actorFor(u.id).role, 'member');
});

check('AN ADMIN IS NOT SILENTLY A LEAD OF EVERY TEAM', async () => {
  /* It is tempting to fill leadTeams with every team for an admin. It would
     make policy.js read nicer and it would make the audit log lie: "lead of
     Titan" against someone who was never a lead of anything. Admin authority
     is policy's business; this field reports only what was granted. */
  fresh();
  const u = await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  auth.grant(u.id, 'project-admin');
  const a = auth.actorFor(u.id);
  assert.deepStrictEqual(a.leadTeams, []);
  assert.strictEqual(auth.leads(a, 'ruby'), false);
});

check('revoking a team lead does not touch the same person on another team', async () => {
  fresh();
  const u = await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  auth.grant(u.id, 'lead', 'ruby');
  auth.grant(u.id, 'lead', 'titan');
  auth.revoke(u.id, 'lead', 'ruby');
  assert.deepStrictEqual(auth.actorFor(u.id).leadTeams, ['titan']);
});

check('DELETING A USER TAKES THEIR ROLES AND SESSIONS WITH THEM', async () => {
  /* The cascade is load bearing. Orphaned role rows plus a recycled id is a
     user inheriting someone else's authority — which is why foreign_keys is
     turned on explicitly rather than left at SQLite's default of off. */
  fresh();
  const u = await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  auth.grant(u.id, 'lead', 'ruby');
  const { token } = auth.startSession(u.id);
  auth.db().prepare('DELETE FROM user WHERE id = ?').run(u.id);
  assert.strictEqual(auth.rolesFor(u.id).length, 0, 'role rows outlived the account');
  assert.strictEqual(auth.sessionActor(token), null, 'the session outlived the account');
});

/* ── sessions ─────────────────────────────────────────────────────────── */

check('A SESSION RESOLVES TO ITS ACTOR', async () => {
  fresh();
  const u = await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  auth.grant(u.id, 'lead', 'ruby');
  const { token } = auth.startSession(u.id, { ip: '10.0.0.9', userAgent: 'test' });
  const a = auth.sessionActor(token);
  assert.strictEqual(a.id, u.id);
  assert.strictEqual(a.role, 'lead');
  assert.deepStrictEqual(a.leadTeams, ['ruby']);
});

check('THE TOKEN IS NOT STORED — only its hash', async () => {
  /* A backup of auth.db, a support dump, or this tool's own /api/backup route
     must not hand anybody a live session. Asserted against the raw file bytes,
     because a check against the column could pass while the value sits in some
     other table. */
  fresh();
  const u = await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  const { token } = auth.startSession(u.id);
  assert.strictEqual(auth.sessionActor(token).id, u.id, 'fixture check: the token should work');
  const raw = fs.readFileSync(auth.dbFile());
  assert.ok(!raw.includes(Buffer.from(token)), 'the session token is sitting in the database file');
  const rows = auth.db().prepare('SELECT id FROM session').all();
  assert.strictEqual(rows.length, 1);
  assert.notStrictEqual(rows[0].id, token);
  assert.strictEqual(rows[0].id, crypto.createHash('sha256').update(token).digest('hex'));
});

check('a token nobody issued resolves to nobody', async () => {
  fresh();
  await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  for (const bad of [null, undefined, '', 'x', crypto.randomBytes(32).toString('base64url')]) {
    assert.strictEqual(auth.sessionActor(bad), null, `${JSON.stringify(bad)} resolved to an actor`);
  }
});

check('AN EXPIRED SESSION IS DEAD', async () => {
  fresh();
  const u = await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  const { token } = auth.startSession(u.id, { days: -1 });
  assert.strictEqual(auth.sessionActor(token), null, 'an expired session still resolved');
});

check('a revoked session is dead, and revoking is idempotent', async () => {
  fresh();
  const u = await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  const { token } = auth.startSession(u.id);
  assert.strictEqual(auth.endSession(token), true);
  assert.strictEqual(auth.sessionActor(token), null);
  assert.strictEqual(auth.endSession(token), false, 'a second revoke reported that it did something');
});

check('DISABLING AN ACCOUNT SIGNS IT OUT, rather than writing a column and hoping', async () => {
  /* The control exists to remove access. A status flag alone leaves the person
     working normally until their cookie expires a fortnight later — which is to
     say it does not do the one thing it is for. */
  fresh();
  const u = await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  const a = auth.startSession(u.id);
  const b = auth.startSession(u.id);
  auth.setStatus(u.id, 'disabled');
  assert.strictEqual(auth.sessionActor(a.token), null, 'session A survived');
  assert.strictEqual(auth.sessionActor(b.token), null, 'session B survived');
  // And it cannot start a new one.
  assert.throws(() => auth.startSession(u.id), /disabled/);
});

check('A DISABLED ACCOUNT CANNOT RESOLVE A SESSION, even one nothing revoked', async () => {
  /* setStatus revokes sessions, which MASKS this guard — every ordinary path
     leaves no live session to test it with. So the status is flipped in raw SQL
     here, standing in for any other way it could change: a direct edit, a
     restore from backup, an admin route added later that forgets the revoke.
     Two independent defences are only two if each works without the other. */
  fresh();
  const u = await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  const { token } = auth.startSession(u.id);
  assert.ok(auth.sessionActor(token), 'fixture check: the session should start out live');
  auth.db().prepare("UPDATE user SET status = 'disabled' WHERE id = ?").run(u.id);
  assert.strictEqual(auth.sessionActor(token), null,
    'a disabled account resolved a session that was never revoked');
});

check('re-enabling does NOT resurrect the old sessions', async () => {
  // Revocation is a one-way door. Bringing sessions back would mean a token
  // that was out of an attacker's reach for a week becomes live again.
  fresh();
  const u = await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  const { token } = auth.startSession(u.id);
  auth.setStatus(u.id, 'disabled');
  auth.setStatus(u.id, 'active');
  assert.strictEqual(auth.sessionActor(token), null, 'a revoked session came back to life');
  assert.ok(auth.startSession(u.id).token, 'but a fresh sign-in has to work');
});

check('endAllSessions clears every live session and reports how many', async () => {
  fresh();
  const u = await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  const t = [auth.startSession(u.id), auth.startSession(u.id), auth.startSession(u.id)];
  assert.strictEqual(auth.endAllSessions(u.id), 3);
  for (const s of t) assert.strictEqual(auth.sessionActor(s.token), null);
  assert.strictEqual(auth.endAllSessions(u.id), 0, 'it counted already-revoked sessions');
});

check('one person\'s sessions are not another\'s', async () => {
  fresh();
  const a = await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  const b = await auth.createUser({ email: 'b@kms-technology.com', password: PW });
  const sa = auth.startSession(a.id);
  const sb = auth.startSession(b.id);
  auth.endAllSessions(a.id);
  assert.strictEqual(auth.sessionActor(sa.token), null);
  assert.strictEqual(auth.sessionActor(sb.token).id, b.id, 'revoking A signed B out');
});

check('ROLE CHANGES REACH A LIVE SESSION without a re-login', async () => {
  /* The actor is resolved per request, not frozen into the session. Demoting
     somebody has to take effect now — a demotion that waits a fortnight for a
     cookie to expire is not a demotion. */
  fresh();
  const u = await auth.createUser({ email: 'a@kms-technology.com', password: PW });
  auth.grant(u.id, 'project-admin');
  const { token } = auth.startSession(u.id);
  assert.strictEqual(auth.sessionActor(token).role, 'project-admin');
  auth.revoke(u.id, 'project-admin');
  assert.strictEqual(auth.sessionActor(token).role, 'member', 'a demoted admin kept their session authority');
});

/* ── sign-in ──────────────────────────────────────────────────────────── */

check('SIGN IN RETURNS A WORKING SESSION', async () => {
  fresh();
  const u = await auth.createUser(ADMIN);
  auth.grant(u.id, 'project-admin');
  const out = await auth.signIn({ email: ADMIN.email, password: PW, ip: '127.0.0.1' });
  assert.ok(out.token);
  assert.strictEqual(out.actor.role, 'project-admin');
  assert.strictEqual(auth.sessionActor(out.token).id, u.id);
});

check('WRONG PASSWORD AND UNKNOWN ACCOUNT GIVE THE SAME ANSWER', async () => {
  /* Different messages are an enumeration oracle in plain text — far easier to
     read than the timing one. Compared as strings AND as codes, since a helpful
     refactor usually adds the distinction back in the `code`. */
  fresh();
  await auth.createUser(ADMIN);
  const wrong = await auth.signIn({ email: ADMIN.email, password: 'not-the-password-x' }).catch(e => e);
  const nobody = await auth.signIn({ email: 'ghost@kms-technology.com', password: PW }).catch(e => e);
  assert.strictEqual(wrong.message, nobody.message, 'the two refusals read differently');
  assert.strictEqual(wrong.code, nobody.code);
  assert.strictEqual(wrong.status, 401);
});

check('and so does an account that has no password set', async () => {
  fresh();
  await auth.createUser({ email: 'sso@kms-technology.com' });
  const noPw = await auth.signIn({ email: 'sso@kms-technology.com', password: PW }).catch(e => e);
  const nobody = await auth.signIn({ email: 'ghost@kms-technology.com', password: PW }).catch(e => e);
  assert.strictEqual(noPw.message, nobody.message);
});

check('a DISABLED account is told so — that one is not a secret', async () => {
  // The person already knows the account exists; refusing to say why just
  // generates a support question.
  fresh();
  const u = await auth.createUser(ADMIN);
  auth.setStatus(u.id, 'disabled');
  const e = await auth.signIn({ email: ADMIN.email, password: PW }).catch(x => x);
  assert.strictEqual(e.code, 'disabled');
  assert.strictEqual(e.status, 403);
});

check('SIGNING IN UPGRADES A WEAK STORED HASH, while the password is in hand', async () => {
  /* The only moment a rehash is possible. Without it, raising the cost protects
     new accounts and leaves every existing one at the old setting forever. */
  fresh();
  const u = await auth.createUser(ADMIN);
  const weak = await auth.hashPassword(PW, { N: 1024, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 });
  auth.db().prepare('UPDATE user SET password_hash = ? WHERE id = ?').run(weak, u.id);
  await auth.signIn({ email: ADMIN.email, password: PW });
  const after = auth.findUser(u.id).password_hash;
  assert.notStrictEqual(after, weak, 'the weak hash was left in place');
  assert.strictEqual(auth.needsRehash(after), false);
  assert.strictEqual(await auth.verifyPassword(PW, after), true, 'the upgrade broke the password');
});

/* ── throttling ───────────────────────────────────────────────────────── */

check('FIVE BAD GUESSES ARE FREE, THE SIXTH IS NOT', async () => {
  fresh();
  await auth.createUser(ADMIN);
  for (let i = 0; i < 5; i++) {
    const e = await auth.signIn({ email: ADMIN.email, password: 'wrong-wrong-wrong' }).catch(x => x);
    assert.strictEqual(e.code, 'bad-credentials', `attempt ${i + 1} was throttled too early`);
  }
  const e = await auth.signIn({ email: ADMIN.email, password: 'wrong-wrong-wrong' }).catch(x => x);
  assert.strictEqual(e.code, 'throttled');
  assert.strictEqual(e.status, 429);
  assert.ok(e.retryAfterSec > 0, 'throttled without saying for how long');
});

check('the throttle holds against the RIGHT password too', async () => {
  /* Otherwise it is not a throttle, it is a hint: the attacker learns they have
     found the password by the response changing. */
  fresh();
  await auth.createUser(ADMIN);
  for (let i = 0; i < 6; i++) await auth.signIn({ email: ADMIN.email, password: 'wrong-wrong-wrong' }).catch(() => {});
  const e = await auth.signIn({ email: ADMIN.email, password: PW }).catch(x => x);
  assert.strictEqual(e.code, 'throttled', 'the correct password walked straight past the lockout');
});

check('A SUCCESSFUL SIGN-IN CLEARS THE SLATE', async () => {
  fresh();
  await auth.createUser(ADMIN);
  for (let i = 0; i < 3; i++) await auth.signIn({ email: ADMIN.email, password: 'wrong-wrong-wrong' }).catch(() => {});
  await auth.signIn({ email: ADMIN.email, password: PW });
  assert.strictEqual(auth.throttle(ADMIN.email, null).failures, 0,
    'someone who mistyped twice is still being punished after getting in');
});

check('ONE ACCOUNT\'S LOCKOUT IS NOT ANOTHER\'S', async () => {
  /* Otherwise anybody can lock a colleague out of the tool by guessing at
     their address — a denial of service with no credentials required. */
  fresh();
  await auth.createUser(ADMIN);
  await auth.createUser({ email: 'other@kms-technology.com', password: PW });
  for (let i = 0; i < 6; i++) await auth.signIn({ email: ADMIN.email, password: 'wrong-wrong-wrong' }).catch(() => {});
  const out = await auth.signIn({ email: 'other@kms-technology.com', password: PW });
  assert.ok(out.token, 'one account being attacked locked out a different one');
});

check('PASSWORD SPRAYING TRIPS THE ADDRESS LIMIT, which no per-account counter would catch', async () => {
  /* One common password against many accounts never reaches 5 failures on any
     single one. This is the only limit that sees it. */
  fresh();
  for (let i = 0; i < 12; i++) await auth.createUser({ email: `u${i}@kms-technology.com`, password: PW });
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 3; j++) {
      await auth.signIn({ email: `u${i}@kms-technology.com`, password: 'Password1!x', ip: '10.1.2.3' }).catch(() => {});
    }
  }
  const e = await auth.signIn({ email: 'u0@kms-technology.com', password: PW, ip: '10.1.2.3' }).catch(x => x);
  assert.strictEqual(e.code, 'throttled');
  assert.strictEqual(auth.throttle('u0@kms-technology.com', '10.1.2.3').reason, 'address');
  // ...and someone else on a different address is unaffected.
  assert.strictEqual(auth.throttle('u1@kms-technology.com', '10.9.9.9').ok, true);
});

/* ── first run ────────────────────────────────────────────────────────── */

check('A FRESH INSTALL NEEDS SETUP, AND ISSUES ONE TOKEN', async () => {
  fresh();
  assert.strictEqual(auth.needsSetup(), true);
  const token = auth.issueSetupToken();
  assert.ok(token && token.length > 20);
  const u = await auth.claimSetupToken(token, { email: ADMIN.email, name: ADMIN.name, password: PW });
  assert.strictEqual(auth.actorFor(u.id).role, 'project-admin', 'the first account is not an admin');
  assert.strictEqual(auth.needsSetup(), false);
});

check('THE SETUP TOKEN IS SINGLE USE', async () => {
  fresh();
  const token = auth.issueSetupToken();
  await auth.claimSetupToken(token, { email: ADMIN.email, password: PW });
  await assert.rejects(() => auth.claimSetupToken(token, { email: 'second@kms-technology.com', password: PW }),
    /not valid/, 'the token minted a second admin');
});

check('and a restart cannot reopen the door', async () => {
  /* issueSetupToken runs on every boot. Once an account exists it must return
     null, or every restart hands out a fresh route to project admin. */
  fresh();
  const token = auth.issueSetupToken();
  await auth.claimSetupToken(token, { email: ADMIN.email, password: PW });
  assert.strictEqual(auth.issueSetupToken(), null, 'a restart issued a new setup token');
});

check('A TOKEN ISSUED BEFORE SOMEONE ELSE CLAIMED IT IS WORTHLESS', async () => {
  /* Two tokens can exist across a restart, or an admin can be created by
     another path between printing and claiming. The count is checked AGAIN at
     claim time, which is the only check that closes the window. */
  fresh();
  const first = auth.issueSetupToken();
  await auth.createUser({ ...ADMIN, roles: [{ role: 'project-admin' }] });
  await assert.rejects(() => auth.claimSetupToken(first, { email: 'sneak@kms-technology.com', password: PW }),
    /not valid/, 'a stale token created a second admin');
});

check('an expired setup token is refused', async () => {
  fresh();
  const token = auth.issueSetupToken();
  auth.db().prepare('UPDATE setup_token SET expires_at = ?')
    .run(new Date(Date.now() - 1000).toISOString());
  await assert.rejects(() => auth.claimSetupToken(token, { email: ADMIN.email, password: PW }), /not valid/);
});

check('a made-up setup token is refused, and the real one is not in the file', async () => {
  fresh();
  const token = auth.issueSetupToken();
  await assert.rejects(() => auth.claimSetupToken('nonsense', { email: ADMIN.email, password: PW }), /not valid/);
  const raw = fs.readFileSync(auth.dbFile());
  assert.ok(!raw.includes(Buffer.from(token)), 'the setup token is readable in the database file');
});

check('a FAILED claim does not burn the token', async () => {
  // A typo in the email must not force a server restart to get a new token.
  fresh();
  const token = auth.issueSetupToken();
  await assert.rejects(() => auth.claimSetupToken(token, { email: 'not an email', password: PW }));
  const u = await auth.claimSetupToken(token, { email: ADMIN.email, password: PW });
  assert.ok(u.id, 'a typo cost the token');
});

/* ── cookies ──────────────────────────────────────────────────────────── */

check('THE COOKIE IS HttpOnly AND SameSite', async () => {
  const c = auth.sessionCookie('abc', { expiresAt: new Date(Date.now() + 864e5).toISOString() });
  assert.match(c, /HttpOnly/, 'a script can read the session cookie');
  assert.match(c, /SameSite=Lax/, 'another site can ride the session');
  assert.match(c, /Path=\//);
});

check('SECURE IS OPT-IN, because setting it on plain HTTP silently discards the cookie', async () => {
  /* The failure is maddening to debug: the login returns 200, the browser drops
     the cookie, and the next request is anonymous. So it is passed in by
     whoever knows whether there is TLS in front, never assumed here. */
  const exp = new Date(Date.now() + 864e5).toISOString();
  assert.ok(!/Secure/.test(auth.sessionCookie('abc', { expiresAt: exp })));
  assert.match(auth.sessionCookie('abc', { expiresAt: exp, secure: true }), /Secure/);
  assert.match(auth.clearCookie({ secure: true }), /Secure/);
});

check('clearing the cookie actually expires it', async () => {
  assert.match(auth.clearCookie(), /Max-Age=0/);
});

check('the cookie reader finds its own cookie among others', async () => {
  const token = 'tok+en/with=chars';
  const mine = auth.sessionCookie(token, { expiresAt: new Date(Date.now() + 864e5).toISOString() });
  const value = mine.split(';')[0].split('=').slice(1).join('=');
  const header = `theme=dark; ${auth.SESSION_COOKIE}=${value}; other=1`;
  assert.strictEqual(auth.readCookie(header), token, 'the round trip through a Cookie header lost the token');
  assert.strictEqual(auth.readCookie('theme=dark; other=1'), null);
  assert.strictEqual(auth.readCookie(''), null);
  assert.strictEqual(auth.readCookie(null), null);
});

check('a cookie whose NAME merely contains ours is not ours', async () => {
  // `pt_session_backup=...` must not be read as `pt_session`.
  assert.strictEqual(auth.readCookie(`x${auth.SESSION_COOKIE}=nope`), null);
  assert.strictEqual(auth.readCookie(`${auth.SESSION_COOKIE}_old=nope`), null);
});

/* ── run ──────────────────────────────────────────────────────────────── */

(async () => {
  for (const { name, fn } of pending) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (err) {
      failed++; console.log(`FAIL  ${name}\n      ${err.message}`);
    }
  }
  auth.close();
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* windows */ } }
  console.log(`\nauth.test.js: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
