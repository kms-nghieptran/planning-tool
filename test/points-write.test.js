'use strict';
/**
 * points-write.test.js — the one route that changes real Jira.
 *
 * WHY THIS SUITE EXISTS SEPARATELY
 *
 * Every other route in this app reads Jira and writes locally. This one
 * reaches out and edits somebody's issue, which puts it in a different class
 * of wrong: a bad local write is a refresh away from being fixed, and a bad
 * Jira write is an estimate silently replaced in a system the whole team
 * plans from.
 *
 * So the guards are the subject here, not the happy path. Each one below
 * stands between a plausible mistake and a real edit:
 *
 *   · a closed sprint          — re-estimating finished work rewrites the
 *                                history velocity is computed from
 *   · a key not in that sprint — otherwise this is an endpoint for editing
 *                                any issue in the instance, by key
 *   · a value that is not a number
 *   · an estimate somebody else changed since the last sync
 *
 * The first four run entirely locally, BEFORE any network call, so they are
 * checked over real HTTP with no Jira configured — which is also the honest
 * state of this fixture. The Jira-facing half is unit-checked against a
 * stubbed transport at the bottom, because the alternative is editing a real
 * issue to watch it work.
 *
 * Run: node test/points-write.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-points-'));
fs.mkdirSync(path.join(SCRATCH, 'store'), { recursive: true });
process.env.STORE_DIR = SCRATCH;
process.env.DB_FILE = path.join(SCRATCH, 'store', 'test.db');
process.env.PORT = '0';

/* ── a Jira to talk to ────────────────────────────────────────────────
   A stub, started before the app loads, so the route can be driven all the
   way through: the read-before-write, the 409 when somebody else has
   re-estimated, and the local update that follows a successful PUT. Those
   are the guards that matter most and the only alternative way to exercise
   them is to edit a real issue in a real instance. */
const JIRA_FIELD = 'customfield_10016';
const jiraState = { 'T-1': 3, 'T-2': null };
const jiraCalls = [];
const jiraStub = http.createServer((req, res) => {
  const key = decodeURIComponent((req.url.match(/\/issue\/([^?]+)/) || [])[1] || '');
  jiraCalls.push({ method: req.method, key });
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ key, fields: { [JIRA_FIELD]: jiraState[key] ?? null } }));
  }
  if (req.method === 'PUT') {
    let body = '';
    req.on('data', c => { body += c; });
    return req.on('end', () => {
      if (jiraState.__refuse) { res.writeHead(403); return res.end('no'); }
      jiraState[key] = JSON.parse(body).fields[JIRA_FIELD];
      res.writeHead(204); res.end();
    });
  }
  res.writeHead(405); res.end();
});

/* ── the fixture ──────────────────────────────────────────────────────
   One team, one open sprint and one closed one, with issues in both — the
   minimum needed to ask "may I edit this" from both sides. */

const sprint = (id, jiraId, state) => ({
  id, number: Number(jiraId), name: `Sprint ${id}`,
  start: '2026-09-14', end: '2026-09-27', source: 'jira',
  byTeam: { titan: { jiraId: String(jiraId), name: `Titan ${id}`, state } },
});

const issue = (key, points) => ({
  key, project: 'T', summary: key, issueType: 'Story', status: 'In Dev', statusCategory: 'indeterminate',
  assignee: 'Hien Phan', assigneeId: 'acc-hien', points, components: [], labels: [],
  sprints: [], blockedBy: [], datasets: ['sprintWork'],
});

const ISSUES = [issue('T-1', 3), issue('T-2', null), issue('T-9', 8)];

fs.writeFileSync(path.join(SCRATCH, 'store', 'plan.json'), JSON.stringify({
  version: 1,
  teams: [{
    id: 'titan', name: 'Katalon Titan', jiraName: 'Katalon Titan', boardId: 1,
    jiraTeams: [], components: [], sprintKeywords: [],
    settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 },
    source: 'jira',
    members: [{ id: 'm1', name: 'Hien Phan', role: 'Auto QA', status: 'Active', supportPct: 0, jiraAccountId: 'acc-hien', source: 'jira' }],
  }],
  sprints: [sprint('OPEN', 940, 'active'), sprint('SHUT', 939, 'closed')],
  holidays: [], availability: {}, support: {}, ceremony: {}, overrides: {},
  risks: [], notes: {}, excluded: {}, ignoredBoards: [], savedSearches: [],
}));

fs.writeFileSync(path.join(SCRATCH, 'store', 'snapshot.json'), JSON.stringify({
  syncedAt: '2026-09-25T09:00:00.000Z',
  fields: { storyPointsField: 'customfield_10016' },
  issues: Object.fromEntries(ISSUES.map(i => [i.key, i])),
  sprints: [], people: [], boards: [],
  byTeam: { titan: { sprintIssues: { 940: ['T-1', 'T-2'], 939: ['T-9'] }, sprints: [], backlog: [], people: [] } },
}));

const store = require('../lib/store');
let server;

let base = '';
const call = (method, p, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request(`${base}${p}`, {
    method,
    headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
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
  if (data) req.write(data);
  req.end();
});

const put = (body) => call('PUT', '/api/sprint/points', body);
/* READS THE DATABASE, NOT THE CACHE. `getSnapshot` memoises, and the route
   only invalidates on a SUCCESSFUL write — so a check that read through the
   cache would see the old value after a failed write whether or not anything
   was actually corrupted, and could not tell the two apart. Invalidating
   first is what makes "nothing was written" a real assertion. */
const pointsOf = (key) => { store.invalidate(); return (store.getSnapshot().issues[key] || {}).points; };

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nEditing points, which writes to Jira\n');

/* ── the guards that run before any network call ──────────────────── */

check('A CLOSED SPRINT REFUSES THE EDIT, with 409', async () => {
  /* Re-estimating finished work rewrites the history velocity is computed
     from. The body names a team and a sprint, so `readJsonBody`'s own guard
     fires — the rule is not repeated here, which is the point of it living
     there. */
  const r = await put({ teamId: 'titan', sprintId: 'SHUT', key: 'T-9', points: 5, was: 8 });
  assert.strictEqual(r.status, 409, 'a closed sprint must refuse a points edit like every other write');
  assert.strictEqual(r.body.code, 'SPRINT_CLOSED');
  assert.strictEqual(pointsOf('T-9'), 8, 'and nothing may have changed locally');
});

check('AN ISSUE OUTSIDE THAT SPRINT IS REFUSED — this is not a general editor', async () => {
  /* Without this the route edits any issue in the instance by key. A capacity
     grid has no business doing that, and an endpoint that does is one stray
     request away from changing something nobody was looking at. */
  const r = await put({ teamId: 'titan', sprintId: 'OPEN', key: 'T-9', points: 5, was: 8 });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /not in/i, 'the refusal should say why');
  assert.strictEqual(pointsOf('T-9'), 8);

  const unknown = await put({ teamId: 'titan', sprintId: 'OPEN', key: 'NOPE-1', points: 5, was: null });
  assert.strictEqual(unknown.status, 400, 'a key that exists nowhere is refused the same way');
});

check('an unknown team or sprint is refused, not silently defaulted', async () => {
  /* `findTeam` elsewhere falls back to the first team, which is right for a
     screen that must render something. Here it would edit Titan's issue on a
     request that named another team. */
  assert.strictEqual((await put({ teamId: 'ghost', sprintId: 'OPEN', key: 'T-1', points: 5, was: 3 })).status, 404);
  assert.strictEqual((await put({ teamId: 'titan', sprintId: 'ghost', key: 'T-1', points: 5, was: 3 })).status, 404);
  assert.strictEqual(pointsOf('T-1'), 3);
});

check('A VALUE THAT IS NOT A POINTS VALUE IS REFUSED, not coerced', async () => {
  for (const bad of ['abc', -1, {}, [], 'NaN']) {
    const r = await put({ teamId: 'titan', sprintId: 'OPEN', key: 'T-1', points: bad, was: 3 });
    assert.strictEqual(r.status, 400, `${JSON.stringify(bad)} should be refused`);
  }
  assert.strictEqual(pointsOf('T-1'), 3, 'and none of them may have written anything');
});

check('and a missing key is refused before anything else happens', async () => {
  const r = await put({ teamId: 'titan', sprintId: 'OPEN', points: 5, was: 3 });
  assert.strictEqual(r.status, 400);
});



/* ── the round trip, against the stub Jira ───────────────────────────── */

check('A SUCCESSFUL EDIT REACHES JIRA AND THEN THE LOCAL COPY', async () => {
  const r = await put({ teamId: 'titan', sprintId: 'OPEN', key: 'T-1', points: 5, was: 3 });
  assert.strictEqual(r.status, 200, r.body && r.body.error);
  assert.strictEqual(r.body.points, 5);
  assert.strictEqual(jiraState['T-1'], 5, 'Jira must have the new value');
  assert.strictEqual(pointsOf('T-1'), 5,
    'and the local copy must follow — otherwise the screen keeps showing the old number until the next sync');
});

check('JIRA IS READ BEFORE IT IS WRITTEN', async () => {
  /* The staleness check is the reason for the read. Without it a stale tab
     silently replaces an estimate somebody changed after the last sync. */
  jiraCalls.length = 0;
  await put({ teamId: 'titan', sprintId: 'OPEN', key: 'T-1', points: 6, was: 5 });
  assert.deepStrictEqual(jiraCalls.map(c => c.method), ['GET', 'PUT'],
    'it must read the current value before overwriting it');
  assert.ok(jiraCalls.every(c => c.key === 'T-1'), 'and only touch the issue it was asked about');
});

check('AN ESTIMATE CHANGED BY SOMEBODY ELSE IS REFUSED, with both numbers', async () => {
  /* The failure this guard exists for: the screen was drawn from a sync,
     somebody re-estimated in Jira since, and saving would discard their work
     without either of you knowing. Same rule as the mtime guard on writing a
     file back to his machine. */
  jiraState['T-1'] = 13;                      // changed in Jira behind our back
  const r = await put({ teamId: 'titan', sprintId: 'OPEN', key: 'T-1', points: 2, was: 6 });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(jiraState['T-1'], 13, 'the other person\'s number must survive');
  assert.strictEqual(r.body.jira, 13, 'the refusal should carry what Jira actually holds');
  assert.strictEqual(r.body.expected, 6, 'and what this screen believed');
  assert.match(r.body.error, /13|somebody/i, 'and say so in words');
});

check('CLEARING AN ESTIMATE WORKS END TO END', async () => {
  jiraState['T-1'] = 13;
  const r = await put({ teamId: 'titan', sprintId: 'OPEN', key: 'T-1', points: null, was: 13 });
  assert.strictEqual(r.status, 200, r.body && r.body.error);
  assert.strictEqual(jiraState['T-1'], null, 'Jira should hold null, not zero');
  assert.strictEqual(pointsOf('T-1'), null, 'and so should the local copy');
});

check('setting the value it already has writes NOTHING', async () => {
  // An unchanged blur should not cost a Jira write, or an audit entry that
  // says an edit happened.
  jiraState['T-2'] = 4;
  jiraCalls.length = 0;
  const r = await put({ teamId: 'titan', sprintId: 'OPEN', key: 'T-2', points: 4, was: 4 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.unchanged, true, 'it should say it did nothing');
  assert.deepStrictEqual(jiraCalls.map(c => c.method), ['GET'], 'and make no PUT at all');
});

check('A JIRA REFUSAL LEAVES THE LOCAL COPY ALONE', async () => {
  /* Jira first, local second. The other order leaves this tool confidently
     showing a number Jira never accepted. */
  jiraState['T-2'] = 4;
  const before = pointsOf('T-2');
  jiraState.__refuse = true;
  const r = await put({ teamId: 'titan', sprintId: 'OPEN', key: 'T-2', points: 9, was: 4 });
  delete jiraState.__refuse;
  assert.strictEqual(r.status, 502, 'a rejected write must be reported as a failure');
  assert.strictEqual(pointsOf('T-2'), before, 'and must not have changed anything locally');
  assert.strictEqual(jiraState['T-2'], 4);
});

/* ── the Jira half, against a stubbed transport ───────────────────────
   Checked here rather than over HTTP because the alternative is editing a
   real issue in a real instance to watch it work. What matters is the shape
   of the request and how failures are reported. */

const { Jira } = require('../lib/jira');

const stub = (handler) => {
  const j = new Jira({ baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', storyPointsField: 'customfield_10016' });
  j.request = async (pathname, options = {}) => handler(pathname, options);
  return j;
};

check('THE WRITE SENDS ONE FIELD ON ONE ISSUE — nothing else', async () => {
  /* A helper that could set arbitrary fields is one typo from clearing a
     summary. The request shape is the guarantee. */
  const seen = [];
  const j = stub((pathname, options) => { seen.push({ pathname, options }); return null; });
  await j.setStoryPoints('T-1', 5);

  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].options.method, 'PUT');
  assert.strictEqual(seen[0].pathname, '/rest/api/3/issue/T-1');
  assert.deepStrictEqual(JSON.parse(seen[0].options.body), { fields: { customfield_10016: 5 } },
    'the body must carry the points field and nothing besides');
});

check('CLEARING IS A REAL EDIT — null, not zero', async () => {
  /* "Nobody has estimated this" and "this is a zero" are different facts and
     the forecast treats them differently. Sending 0 for a cleared estimate
     would quietly turn every unestimated item into a free one. */
  let body = null;
  const j = stub((_, options) => { body = JSON.parse(options.body); return null; });
  await j.setStoryPoints('T-1', null);
  assert.strictEqual(body.fields.customfield_10016, null, 'clearing must send null');

  await j.setStoryPoints('T-1', 0);
  assert.strictEqual(body.fields.customfield_10016, 0, 'and an explicit zero must still send zero');
});

check('a key with a space or slash is escaped into the path', async () => {
  let seen = '';
  const j = stub((pathname) => { seen = pathname; return null; });
  await j.setStoryPoints('T 1/2', 1);
  assert.ok(!seen.includes(' '), 'an unescaped key would build a broken URL');
  assert.strictEqual(seen, `/rest/api/3/issue/${encodeURIComponent('T 1/2')}`);
});

check('NO POINTS FIELD MEANS NO WRITE', async () => {
  const j = stub(() => null);
  j.storyPointsField = null;
  await assert.rejects(() => j.setStoryPoints('T-1', 5), /Story Points field/i,
    'without a field id this would PUT an empty fields object and report success');
});

check('A 403 ON THE WRITE IS NOT REPORTED AS BAD CREDENTIALS', async () => {
  /* `request` says "check the email and API token" for any 401/403 — right
     for a read, wrong here: the credentials just worked for the read that
     preceded this. It means this account cannot edit the issue, or the field
     is not on its edit screen. Two different fixes, neither of them the one
     that message sends you to. */
  const j = stub(() => { throw new Error('Jira rejected the credentials (401/403). Check the email and API token.'); });
  await assert.rejects(() => j.setStoryPoints('T-7', 5), (err) => {
    assert.ok(!/API token/i.test(err.message), 'it still blames the token');
    assert.match(err.message, /T-7/, 'the message should name the issue');
    assert.match(err.message, /edit screen|cannot edit/i, 'and point at the two real causes');
    return true;
  });
});

check('any other Jira error is passed through, not swallowed', async () => {
  const j = stub(() => { throw new Error('Jira 400 on /rest/api/3/issue/T-1: field cannot be set'); });
  await assert.rejects(() => j.setStoryPoints('T-1', 5), /cannot be set/,
    'the real reason has to reach the person, not a generic failure');
});

check('reading one field asks for ONLY that field', async () => {
  // The staleness check runs before every write; pulling whole issues for it
  // would make a routine edit an expensive one.
  let seen = '';
  const j = stub((pathname) => { seen = pathname; return { fields: { customfield_10016: 8 } }; });
  assert.strictEqual(await j.fieldValue('T-1', 'customfield_10016'), 8);
  assert.match(seen, /fields=customfield_10016/, 'it should request the one field it needs');

  const missing = stub(() => ({ fields: {} }));
  assert.strictEqual(await missing.fieldValue('T-1', 'customfield_10016'), null,
    'an absent value is null — unestimated, not undefined');
});

jiraStub.listen(0, '127.0.0.1', () => {
  // The config has to exist before server.js is required — it reads it once.
  process.env.CONFIG_FILE = path.join(SCRATCH, 'config.json');
  fs.writeFileSync(process.env.CONFIG_FILE, JSON.stringify({
    jira: {
      baseUrl: `http://127.0.0.1:${jiraStub.address().port}`,
      email: 'a@b.c', apiToken: 't', projectKey: 'T', storyPointsField: JIRA_FIELD,
    },
  }));
  server = require('../server.js').server;
  run();
});

function run() {
server.listen(0, '127.0.0.1', async () => {
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  server.close();
  jiraStub.close();
  try { require('../lib/db').close(); } catch (_) { /* fine */ }
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
}
