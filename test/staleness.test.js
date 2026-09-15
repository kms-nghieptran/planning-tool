'use strict';
/**
 * staleness.test.js — the guard that says "this process is running old code".
 *
 * It exists because a stale instance is invisible: the page renders, every
 * number looks plausible, and the logic producing them was superseded. One left
 * running through an update rewrote a team's roster underneath a cleanup that
 * had just corrected it.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const st = require('../lib/staleness');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
console.log('\nStaleness guard\n');

/** A miniature app tree: server.js, lib/, public/, plus things to ignore. */
function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-stale-'));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.mkdirSync(path.join(root, 'public'));
  fs.mkdirSync(path.join(root, 'public', 'kms'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'server.js'), '// server');
  fs.writeFileSync(path.join(root, 'lib', 'a.js'), '// a');
  fs.writeFileSync(path.join(root, 'public', 'app.js'), '// app');
  fs.writeFileSync(path.join(root, 'public', 'styles.css'), 'body{}');
  return root;
}
const touch = (p, whenMs) => fs.utimesSync(p, whenMs / 1000, whenMs / 1000);

check('a fresh process is not stale', () => {
  const root = tree();
  const t = st.tracker(root);
  assert.strictEqual(t.check().stale, false);
});

check('editing a lib file after load IS stale', () => {
  const root = tree();
  const t = st.tracker(root);
  touch(path.join(root, 'lib', 'a.js'), Date.now() + 60_000);
  const r = t.check();
  assert.strictEqual(r.stale, true, 'the whole reason this module exists');
  assert.ok(r.onDiskAt > r.loadedAt);
});

check('editing a front-end file counts too', () => {
  const root = tree();
  const t = st.tracker(root);
  touch(path.join(root, 'public', 'app.js'), Date.now() + 60_000);
  assert.strictEqual(t.check().stale, true, 'a cached browser bundle is just as misleading');
});

check('a new file appearing counts', () => {
  const root = tree();
  const t = st.tracker(root);
  const f = path.join(root, 'lib', 'brand-new.js');
  fs.writeFileSync(f, '// new');
  touch(f, Date.now() + 60_000);
  assert.strictEqual(t.check().stale, true);
});

check('touching a file without changing it is tolerated', () => {
  const root = tree();
  const t = st.tracker(root);
  // Within the slack window: an editor save-on-focus-loss must not cry wolf.
  touch(path.join(root, 'lib', 'a.js'), t.loaded + 500);
  assert.strictEqual(t.check().stale, false, 'a false alarm here trains you to ignore the real one');
});

check('data and vendored assets are ignored', () => {
  const root = tree();
  const t = st.tracker(root);
  const later = Date.now() + 60_000;
  const dataFile = path.join(root, 'data', 'plan.json');
  fs.writeFileSync(dataFile, '{}'); touch(dataFile, later);
  const font = path.join(root, 'public', 'kms', 'tokens.css');
  fs.writeFileSync(font, ':root{}'); touch(font, later);
  assert.strictEqual(t.check().stale, false,
    'a sync writing plan.json every few minutes must not read as a code change');
});

check('a deleted file does not crash the check', () => {
  const root = tree();
  const t = st.tracker(root);
  fs.rmSync(path.join(root, 'lib', 'a.js'));
  assert.doesNotThrow(() => t.check(), 'the guard must never be the thing that breaks the app');
});

check('compare is pure and reports both timestamps', () => {
  const a = 1_000_000_000_000, b = a + 5000;
  const r = st.compare(a, b);
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.loadedAt, new Date(a).toISOString());
  assert.strictEqual(r.onDiskAt, new Date(b).toISOString());
  assert.strictEqual(st.compare(b, a).stale, false, 'disk older than load is not stale');
  assert.strictEqual(st.compare(0, 0).stale, false, 'unknown stamps are never stale');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
