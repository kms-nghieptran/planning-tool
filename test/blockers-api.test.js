'use strict';
/**
 * blockers-api.test.js — the blocker register, over HTTP.
 *
 * WHY THIS SUITE EXISTS
 *
 * A risk is prose: a bad field in one is visible the moment anybody reads it.
 * A registered BLOCKER carries issue keys, and a record naming AUTOKAT-9999
 * renders perfectly, is counted in every figure on the page, and is wrong in
 * a way nothing on screen can show. The same goes for `autokat-9831` stored
 * beside `AUTOKAT-9831` — two rows for one ticket, counted twice everywhere.
 *
 * So these drive the real routes over a real socket and check what gets
 * STORED, not what gets rendered.
 *
 * Run: node test/blockers-api.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-blkapi-'));
fs.mkdirSync(path.join(SCRATCH, 'store'), { recursive: true });
process.env.STORE_DIR = SCRATCH;
process.env.DB_FILE = path.join(SCRATCH, 'store', 'test.db');
process.env.PORT = '0';

/* ── a board with one ticket holding several ─────────────────────────── */

const issue = (key, o = {}) => ({
  key, project: 'AUTOKAT', summary: o.summary || `Work ${key}`,
  issueType: o.issueType || 'Story',
  status: 'status' in o ? o.status : 'Refinement',
  statusCategory: o.statusCategory || 'indeterminate',
  points: 'points' in o ? o.points : 3,
  parentKey: o.parentKey || null, blockedBy: o.blockedBy || [],
  components: [], labels: [], sprints: o.sprints || [], relatesTo: [],
});

const S = [{ id: '900', name: 'Sprint 40', state: 'active' }];
const ISSUES = [
  issue('E-1', { issueType: 'Epic', status: 'Open', points: null, blockedBy: [{ key: 'EXT-1', summary: 'Client sign-off' }] }),
  issue('A-1', { parentKey: 'E-1', sprints: S }),
  issue('A-2', { parentKey: 'E-1' }),
  issue('E-2', { issueType: 'Epic', status: 'Open', points: null }),
  issue('C-1', { parentKey: 'E-2' }),
  issue('C-2', { parentKey: 'E-2' }),
  issue('D-1', { parentKey: 'E-2', status: 'In Dev' }),
];

fs.writeFileSync(path.join(SCRATCH, 'store', 'plan.json'), JSON.stringify({
  version: 1,
  teams: [{ id: 'ruby', name: 'Katalon Ruby' }],
  sprints: [{ id: 's40', name: 'Sprint 40', byTeam: { ruby: { jiraId: '900', name: 'Sprint 40', state: 'active' } } }],
  holidays: [], availability: {}, support: {}, ceremony: {}, overrides: {},
  risks: [], blockers: [], notes: {}, excluded: {}, ignoredBoards: [],
  savedSearches: [], categoryRules: null, mixTargets: null, sprintRoster: {},
  scenarios: [], componentPriority: {},
}));

fs.writeFileSync(path.join(SCRATCH, 'store', 'snapshot.json'), JSON.stringify({
  syncedAt: '2026-09-14T00:00:00Z', watermark: null, source: 'jira',
  issues: Object.fromEntries(ISSUES.map(i => [i.key, i])),
  sprints: [], components: [], testops: {}, github: {}, verification: [], fields: {},
  boards: [], boardSprintsByTeam: {}, boardSprintErrors: [], people: [],
  byTeam: {
    ruby: {
      sprintIssues: { 900: ISSUES.filter(i => i.sprints.length).map(i => i.key) },
      backlog: ISSUES.filter(i => !i.sprints.length).map(i => i.key),
    },
  },
}));

const { server } = require('../server.js');

let base = '';
const send = (method, p, body) => new Promise((resolve, reject) => {
  const payload = body === undefined ? null : JSON.stringify(body);
  const u = new URL(base + p);
  const req = http.request({
    hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
    headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
  }, (res) => {
    let out = '';
    res.on('data', c => { out += c; });
    res.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch (_) { parsed = out; }
      resolve({ status: res.statusCode, body: parsed });
    });
  });
  req.on('error', reject);
  req.end(payload);
});

const get = (p) => send('GET', p);
const post = (b) => send('POST', '/api/blocker', b);
const put = (b) => send('PUT', '/api/blocker', b);
const del = (b) => send('DELETE', '/api/blocker', b);
const board = (qs = '') => get(`/api/blockers?team=ruby${qs}`);

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

console.log('\nThe blocker register, over HTTP\n');

/* ── the detected half ────────────────────────────────────────────────── */

check('THE BOARD COMES BACK GROUPED BY WHAT IS HOLDING THINGS', async () => {
  const r = await board();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.counts.items, 4, 'the blocked set is not the four in Refinement');
  assert.strictEqual(r.body.counts.explained, 2);
  assert.strictEqual(r.body.counts.unrecorded, 2);
  const g = r.body.detected.find(x => x.key === 'EXT-1');
  assert.ok(g, 'EXT-1 holds two items and is not in the response');
  assert.deepStrictEqual(g.items.slice().sort(), ['A-1', 'A-2']);
  assert.strictEqual(g.local, false, 'a ticket this tool does not sync was reported as local');
});

check('AND THE SPRINT IS A FILTER, not the scope', async () => {
  const whole = await board();
  const one = await board('&sprint=s40');
  assert.strictEqual(whole.body.counts.items, 4);
  assert.strictEqual(one.body.counts.items, 1, 'the sprint filter did not narrow the board');
  assert.strictEqual(one.body.scope.teamTotal, 4, 'a filtered page must still say how big the board is');
});

/* ── the register ─────────────────────────────────────────────────────── */

check('A BLOCKER IS STORED WITH THE ITEMS IT NAMES', async () => {
  const r = await post({ title: 'Staging is down', severity: 'high', category: 'Environment', items: ['C-1', 'C-2'], teamId: 'ruby' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const b = r.body.blockers.find(x => x.title === 'Staging is down');
  assert.ok(b && b.id, 'nothing was stored');
  assert.deepStrictEqual(b.items, ['C-1', 'C-2']);
  assert.strictEqual(b.status, 'Open', 'a new blocker should start open');
  assert.ok(b.createdAt, 'no created timestamp');
});

check('A TITLE IS REQUIRED — a blocker with no name is a blank card', async () => {
  for (const bad of [undefined, '', '   ']) {
    const r = await post({ title: bad, items: [] });
    assert.strictEqual(r.status, 400, `"${String(bad)}" was accepted as a title`);
    assert.match(r.body.error, /title/i);
  }
});

check('AN UNKNOWN KEY IS REFUSED, and the message names it', async () => {
  /* The failure this route exists to stop. A blocker naming AUTOKAT-9999
     renders perfectly and is counted in every figure on the page. */
  const r = await post({ title: 'Typo', items: ['C-1', 'AUTOKAT-9999'] });
  assert.strictEqual(r.status, 404, 'a key that is not in the store was stored');
  assert.match(r.body.error, /AUTOKAT-9999/, 'the message does not say which key was wrong');
  assert.match(r.body.error, /sync/, 'and does not say what to do about it');

  const after = await board();
  assert.ok(!after.body.manual.some(b => b.title === 'Typo'), 'the refused blocker was stored anyway');
});

check('KEYS ARE NORMALISED AND DE-DUPLICATED BEFORE THEY ARE STORED', async () => {
  /* They arrive from a picker AND from a typed box, so the same ticket
     reaches here as `c-1` and `C-1 `. Stored as two, it is counted as two
     on every figure this page reports. */
  const r = await post({ title: 'Mixed case', items: [' c-1 ', 'C-1', 'c-2'] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const b = r.body.blockers.find(x => x.title === 'Mixed case');
  assert.deepStrictEqual(b.items, ['C-1', 'C-2'], 'the same ticket was stored twice under two spellings');
});

check('LINKED ITEMS ARE OPTIONAL — a blocker is real before anybody maps it', async () => {
  /* "The staging environment is down" is worth recording before anybody has
     worked out which tickets it holds. A form that refused it would train
     people to invent a link. */
  const r = await post({ title: 'Client has not replied', items: [] });
  assert.strictEqual(r.status, 200);
  const b = r.body.blockers.find(x => x.title === 'Client has not replied');
  assert.deepStrictEqual(b.items, []);

  const r2 = await post({ title: 'No items field at all' });
  assert.strictEqual(r2.status, 200, 'a blocker with no items field was refused');
});

check('A KEY THAT IS NOT YET BLOCKED IS ALLOWED — that is the useful moment', async () => {
  /* The thing he is registering is often the reason an item is ABOUT to be
     blocked. Demanding it already sit in Refinement would refuse the most
     valuable moment to write it down. D-1 is In Dev. */
  const r = await post({ title: 'About to bite', items: ['D-1'] });
  assert.strictEqual(r.status, 200, 'an item not yet in Refinement was refused');
  assert.deepStrictEqual(r.body.blockers.find(x => x.title === 'About to bite').items, ['D-1']);
});

check('A BAD SEVERITY FALLS BACK rather than being stored as typed', async () => {
  const r = await post({ title: 'Odd severity', severity: 'catastrophic' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.blockers.find(x => x.title === 'Odd severity').severity, 'medium',
    'an unknown severity was stored, and every card that colours by it now has no rule');
});

check('EDITING KEEPS THE ID AND THE CREATION TIME', async () => {
  const made = await post({ title: 'To edit', items: ['C-1'] });
  const b = made.body.blockers.find(x => x.title === 'To edit');

  const r = await put({ ...b, title: 'Edited', items: ['C-2'] });
  assert.strictEqual(r.status, 200);
  const after = r.body.blockers.find(x => x.id === b.id);
  assert.strictEqual(after.title, 'Edited');
  assert.deepStrictEqual(after.items, ['C-2'], 'the linked items did not change');
  assert.strictEqual(after.createdAt, b.createdAt, 'editing rewrote when it was first recorded');
  assert.ok(after.updatedAt, 'nothing records that it was edited');
});

check('AND AN EDIT IS VALIDATED THE SAME WAY AS A CREATE', async () => {
  /* The asymmetry that bites: a route that checks keys on POST and trusts
     them on PUT lets exactly the same bad record in by a second door. */
  const made = await post({ title: 'To break', items: ['C-1'] });
  const b = made.body.blockers.find(x => x.title === 'To break');

  const bad = await put({ ...b, items: ['NOPE-1'] });
  assert.strictEqual(bad.status, 404, 'an unknown key was accepted on edit');
  const blank = await put({ ...b, title: '  ' });
  assert.strictEqual(blank.status, 400, 'a blocker was edited into having no title');

  const after = await board();
  const still = after.body.manual.find(x => x.id === b.id);
  assert.deepStrictEqual(still.items, ['C-1'], 'the refused edit was partly applied');
  assert.strictEqual(still.title, 'To break');
});

check('EDITING OR DELETING SOMETHING THAT IS NOT THERE IS A 404, not a silent create', async () => {
  const r = await put({ id: 'b-nope', title: 'Ghost' });
  assert.strictEqual(r.status, 404);
  const d = await del({ id: 'b-nope' });
  assert.strictEqual(d.status, 404, 'deleting a missing blocker reported success');
});

check('RESOLVING IS AN EDIT, and the record stays', async () => {
  /* Kept rather than deleted, because "what did we get unstuck" is a
     question worth answering at a retro. */
  const made = await post({ title: 'To resolve', items: ['C-1'] });
  const b = made.body.blockers.find(x => x.title === 'To resolve');
  const r = await put({ ...b, status: 'Resolved' });
  assert.strictEqual(r.body.blockers.find(x => x.id === b.id).status, 'Resolved');

  const v = await board();
  assert.ok(v.body.manual.some(x => x.id === b.id), 'a resolved blocker disappeared from the register');
  assert.ok(!v.body.manual.filter(x => x.status !== 'Resolved').some(x => x.id === b.id));
});

check('A RESOLVED BLOCKER IS NOT COUNTED AS OPEN', async () => {
  const v = await board();
  const open = v.body.manual.filter(x => String(x.status).toLowerCase() !== 'resolved').length;
  assert.strictEqual(v.body.counts.registered, open,
    'the Register KPI counts resolved blockers, so it never goes down');
});

check('DELETING REMOVES IT AND NOTHING ELSE', async () => {
  const before = (await board()).body.manual;
  const victim = before.find(x => x.title === 'Mixed case');
  const r = await del({ id: victim.id });
  assert.strictEqual(r.status, 200);
  const after = (await board()).body.manual;
  assert.strictEqual(after.length, before.length - 1, 'more than one record went');
  assert.ok(!after.some(x => x.id === victim.id));
});

check('THE REGISTER CLAIMS ITEMS OUT OF THE UNEXPLAINED PILE', async () => {
  /* Over HTTP, because this is the join between the two halves of the page
     and the whole reason they live on one screen. */
  const v = await board();
  assert.strictEqual(v.body.unrecorded.count, 2, 'C-1 and C-2 are the unexplained pair');
  assert.ok(v.body.unrecorded.claimed >= 1,
    'items named by a registered blocker are not reported as accounted for');
});

check('THE CSV CARRIES THE KEYS, not just the counts', async () => {
  /* A CSV saying "EXT-1 — 2 items" and not naming them is a number somebody
     has to come back to this screen to use, which defeats exporting it. */
  const r = await get('/api/export?what=blockers&team=ruby');
  assert.strictEqual(r.status, 200);
  const csv = String(r.body);
  assert.match(csv, /EXT-1/, 'the detected blocker is missing from the export');
  assert.match(csv, /A-1 A-2|A-2 A-1/, 'the items behind it are not named');
  assert.match(csv, /nothing recorded/, 'the unexplained pile is not in the export');
  assert.match(csv, /Register/, 'the manual register is not in the export');
});

/* ── run ──────────────────────────────────────────────────────────────── */

server.listen(0, '127.0.0.1', async () => {
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  server.close();
  process.exit(failed ? 1 : 0);
});
