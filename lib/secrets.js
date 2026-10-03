'use strict';
/**
 * secrets.js — encrypt a small value at rest.
 *
 * ── WHAT THIS PROTECTS AGAINST, AND WHAT IT DOES NOT ─────────────────────
 *
 * It protects against a COPY OF THE DATABASE. `auth.db` gets backed up, synced
 * to a cloud folder, attached to a support message, copied to a laptop to look
 * at something — and this tool has its own `/api/backup` route that will
 * cheerfully hand one over. A file that has travelled should not contain a
 * working Jira token.
 *
 * It does NOT protect against someone who can read the server's disk. The key
 * is a file on that disk; root reads both. There is no way around that without
 * a hardware module or asking every person to re-enter a passphrase each
 * session, and both are the wrong trade for an internal planning tool.
 *
 * SAID OUT LOUD because "encrypted" is a word people hear as a guarantee. The
 * Settings screen repeats it in the one place it matters — next to the box
 * where the token is typed.
 *
 * ── AES-256-GCM, NOT CBC ─────────────────────────────────────────────────
 *
 * GCM authenticates as well as encrypts, so a ciphertext altered in the file
 * fails to decrypt rather than decrypting to rubbish that then gets sent to
 * Jira as a credential. Zero dependencies: all of this is `node:crypto`.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.STORE_DIR || path.join(__dirname, '..', 'data');
const STORE_DIR = path.join(ROOT, 'store');
const KEY_FILE = () => process.env.SECRET_KEY_FILE || path.join(STORE_DIR, '.secret.key');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;      // GCM's standard nonce length
const TAG_LEN = 16;

let cached = null;

/**
 * The key, read from an environment variable or a file beside the store.
 *
 * ENV WINS, so the key can be kept off the disk the database lives on — which
 * is the only version of this that is meaningfully better than the file, and
 * costs nothing to support.
 *
 * CREATED ON FIRST USE, at mode 0600. Not generated at install time: a key
 * that exists before anything needs it is a key nobody notices is missing from
 * their backups until the day they restore one.
 */
function key() {
  if (cached) return cached;

  const fromEnv = process.env.SECRET_KEY;
  if (fromEnv) {
    const buf = Buffer.from(String(fromEnv), 'base64');
    if (buf.length !== 32) {
      throw new Error('SECRET_KEY must be 32 bytes, base64 encoded. Generate one with: openssl rand -base64 32');
    }
    cached = buf;
    return cached;
  }

  const file = KEY_FILE();
  try {
    const buf = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (buf.length === 32) { cached = buf; return cached; }
    throw new Error(`The key in ${file} is ${buf.length} bytes, not 32.`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  fs.mkdirSync(STORE_DIR, { recursive: true });
  const fresh = crypto.randomBytes(32);
  fs.writeFileSync(file, `${fresh.toString('base64')}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* windows */ }
  cached = fresh;
  return cached;
}

/** Forget the cached key — tests, and a key rotated under a running process. */
const reset = () => { cached = null; };

/**
 * `v1.<iv>.<tag>.<ciphertext>`, all base64url.
 *
 * VERSIONED, because the day this needs a different algorithm the stored
 * values still have to be readable — the alternative is every token in the
 * database becoming undecryptable at the moment the change ships.
 */
function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv(ALGO, key(), iv);
  const out = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), out.toString('base64url')].join('.');
}

/**
 * Decrypt, or null.
 *
 * NULL RATHER THAN A THROW on anything malformed, tampered with, or encrypted
 * under a key this process does not have. All three mean the same thing to
 * every caller — there is no usable token here — and a throw would turn a
 * rotated key into a crash on an unrelated screen.
 */
function decrypt(blob) {
  if (!blob) return null;
  const parts = String(blob).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const body = Buffer.from(parts[3], 'base64url');
    if (iv.length !== IV_LEN || tag.length !== TAG_LEN) return null;
    const d = crypto.createDecipheriv(ALGO, key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  } catch (_) {
    return null;     // wrong key, or the bytes were changed
  }
}

/**
 * The last four characters, for a screen that has to show SOMETHING.
 *
 * A token is unreadable by design, so "is the right one saved?" is otherwise
 * unanswerable without replacing it. Four characters identify it to the person
 * who created it and are useless to anybody else.
 */
const hint = (plain) => (plain && plain.length > 4 ? `…${String(plain).slice(-4)}` : null);

module.exports = { encrypt, decrypt, hint, key, reset, KEY_FILE };
