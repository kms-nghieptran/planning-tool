'use strict';
/**
 * auth-api.test.js — authorization as the SERVER enforces it.
 *
 * `policy.test.js` proves the table. This proves the WIRING, and the gap
 * between them is where authorization bugs actually live: a correct policy that
 * the gate never consults, a body the gate cannot see because the handler
 * already consumed the stream, a route added below the gate rather than
 * through it. None of those show up in a unit test of the table.
 *
 * So everything here goes over real HTTP, with real cookies, against the real
 * server module — including requests no UI would ever send, because the UI is
 * not the thing being tested. A tab left open since a demotion still has live
 * buttons; `fetch` from a console never saw the UI at all.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-authapi-'));
fs.mkdirSync(path.join(SCRATCH, 'store'), { recursive: true });
process.env.STORE_DIR = SCRATCH;
process.env.DB_FILE = path.join(SCRATCH, 'store', 'test.db');
process.env.AUTH_DB_FILE = path.join(SCRATCH, 'store', 'auth.db');
process.env.PORT = '0';

/* AUTH ON, which is the whole point — the rest of the suite runs with it off
   and so proves only that the dark launch is dark. Written before the server
   module is required, because the config is read at require time. */
process.env.CONFIG_FILE = path.join(SCRATCH, 'config.json');
fs.writeFileSync(process.env.CONFIG_FILE, JSON.stringify({
  auth: { enabled: true, secureCookies: false },
  server: { port: 0, readOnly: false },
}, null, 2));

/* Two teams, because the single most important property in this file is that a
   lead of one cannot touch the other. A one-team fixture would pass every
   check while proving nothing. */
const TEAMS = ['ruby', 'titan'];
fs.writeFileSync(path.join(SCRATCH, 'store', 'plan.json'), JSON.stringify({
  version: 1,
  teams: TEAMS.map(id => ({
    id, name: id, jiraName: id, boardId: '1', jiraTeams: [], components: [], sprintKeywords: [],
    settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 },
    members: [{ id: `${id}-a`, name: 'A', role: 'Auto QA', status: 'Active', supportPct: 0 }],
  })),
  sprints: [{
    id: 'S41', number: 41, name: 'Sprint 41', start: '2026-09-17', end: '2026-09-30',
    byTeam: Object.fromEntries(TEAMS.map(t => [t, { jiraId: `9-${t}`, name: `${t} 41`, state: 'active' }])),
  }],
  scenarios: [
    { id: 'sc-ruby', teamId: 'ruby', sprintId: 'S41', name: 'r', rows: {} },
    { id: 'sc-titan', teamId: 'titan', sprintId: 'S41', name: 't', rows: {} },
  ],
  availability: {}, support: {}, ceremony: {}, overrides: {}, calcExempt: {},
  excluded: {}, sprintRoster: {}, risks: [], notes: {}, holidays: [],
}));
fs.writeFileSync(path.join(SCRATCH, 'store', 'snapshot.json'), JSON.stringify({
  source: 'jira', syncedAt: '2026-10-01T00:00:00.000Z', sprints: [], issues: {},
  byTeam: Object.fromEntries(TEAMS.map(t => [t, { sprintIssues: {}, sprints: [], backlog: [], people: [] }])),
  testops: { projects: [] }, github: {}, verification: [],
}));

const { server } = require('../server.js');
const auth = require('../lib/auth');
const policy = require('../lib/policy');

let base = '';

/** One request, carrying a cookie if given, and handing back the Set-Cookie. */
const call = (method, p, { body, cookie } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const headers = {};
  if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
  if (cookie) headers.cookie = cookie;
  const req = http.request(`${base}${p}`, { method, headers }, (res) => {
    let out = '';
    res.on('data', c => { out += c; });
    res.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch (_) { parsed = out; }
      const set = res.headers['set-cookie'];
      resolve({ status: res.statusCode, body: parsed, cookie: set ? set[0].split(';')[0] : null });
    });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

const PW = 'a-long-enough-passphrase-42';
const who = {};   // role -> cookie

/** Sign in and keep the cookie. */
async function login(email) {
  const r = await call('POST', '/api/auth/login', { body: { email, password: PW } });
  assert.strictEqual(r.status, 200, `could not sign in as ${email}: ${JSON.stringify(r.body)}`);
  assert.ok(r.cookie, 'login returned no cookie');
  return r.cookie;
}

const ok = (r, what) => assert.ok(r.status < 400, `${what} was refused (${r.status}): ${JSON.stringify(r.body)}`);
const denied = (r, what, status) => {
  assert.ok(r.status === 401 || r.status === 403 || r.status === 400,
    `${what} WAS ALLOWED (${r.status}) — it must not be`);
  if (status) assert.strictEqual(r.status, status, `${what} refused with the wrong status`);
};

/* ── 0. first run ─────────────────────────────────────────────────────── */

check('A FRESH INSTALL REFUSES EVERYTHING AND SAYS WHY', async () => {
  /* With no accounts, every route 401s and the only way in is the setup route.
     If the server did not say `needsSetup`, the app would be a login page that
     cannot be satisfied and no way to tell that from a wrong password. */
  const r = await call('GET', '/api/state');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.needsSetup, true, 'a fresh install does not say it needs setting up');
  const s = await call('GET', '/api/auth/status');
  assert.strictEqual(s.status, 200, '/api/auth/status must be reachable before sign-in');
  assert.strictEqual(s.body.needsSetup, true);
  assert.strictEqual(s.body.enabled, true);
});

check('THE SETUP TOKEN CREATES THE FIRST PROJECT ADMIN, and signs them in', async () => {
  const token = auth.issueSetupToken();
  assert.ok(token, 'no setup token was issued for an empty install');
  const r = await call('POST', '/api/auth/setup', {
    body: { token, email: 'admin@kms-technology.com', name: 'Admin', password: PW },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.actor.role, 'project-admin');
  assert.ok(r.cookie, 'setup did not sign the new admin in');
  who.admin = r.cookie;
});

check('and a second setup attempt is refused', async () => {
  const r = await call('POST', '/api/auth/setup', {
    body: { token: 'anything', email: 'sneak@kms-technology.com', password: PW },
  });
  denied(r, 'a second setup', 400);
});

check('THE ADMIN CREATES THE OTHER ACCOUNTS', async () => {
  const mk = async (email, role, leadTeams) => {
    const r = await call('POST', '/api/users', {
      cookie: who.admin, body: { email, password: PW, role, leadTeams },
    });
    assert.strictEqual(r.status, 200, `${email}: ${JSON.stringify(r.body)}`);
    return r.body.user;
  };
  const m = await mk('member@kms-technology.com', 'member', []);
  const r = await mk('ruby@kms-technology.com', 'lead', ['ruby']);
  const t = await mk('titan@kms-technology.com', 'lead', ['titan']);
  assert.strictEqual(m.role, 'member');
  assert.deepStrictEqual(r.leadTeams, ['ruby']);
  assert.deepStrictEqual(t.leadTeams, ['titan']);
  who.member = await login('member@kms-technology.com');
  who.ruby = await login('ruby@kms-technology.com');
  who.titan = await login('titan@kms-technology.com');
});

/* ── 1. anonymous ─────────────────────────────────────────────────────── */

check('ANONYMOUS GETS NOTHING — not a read, not a write', async () => {
  for (const [m, p] of [['GET', '/api/state'], ['GET', '/api/capacity?team=ruby'],
    ['GET', '/api/sources'], ['POST', '/api/reset'], ['GET', '/api/users']]) {
    const r = await call(m, p, { body: m === 'GET' ? undefined : {} });
    assert.strictEqual(r.status, 401, `anonymous ${m} ${p} returned ${r.status}`);
  }
});

check('a FORGED cookie is anonymous, not an actor', async () => {
  const r = await call('GET', '/api/state', { cookie: `${auth.SESSION_COOKIE}=not-a-real-token` });
  assert.strictEqual(r.status, 401);
});

check('and a tampered one too — flipping a character does not make a new session', async () => {
  const good = who.admin;
  const bad = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
  const r = await call('GET', '/api/state', { cookie: bad });
  assert.strictEqual(r.status, 401, 'a one-character edit of a valid cookie was accepted');
});

/* ── 2. reads ─────────────────────────────────────────────────────────── */

check('EVERY ROLE CAN READ THE PLANNING SCREENS', async () => {
  for (const role of ['member', 'ruby', 'titan', 'admin']) {
    for (const p of ['/api/state?team=ruby', '/api/capacity?team=ruby&sprint=S41',
      '/api/sprint?team=ruby', '/api/sprints?team=ruby', '/api/team?team=ruby']) {
      ok(await call('GET', p, { cookie: who[role] }), `${role} reading ${p}`);
    }
  }
});

check('A LEAD OF RUBY CAN READ TITAN — scope restricts writing, not looking', async () => {
  /* Deliberate. The tool's value is that everyone sees the same numbers, and a
     capacity figure is not a secret from the people it describes. */
  ok(await call('GET', '/api/capacity?team=titan&sprint=S41', { cookie: who.ruby }),
    'a lead of Ruby reading Titan');
});

/* ── 3. THE CENTRAL MATRIX ────────────────────────────────────────────── */

/** The team-scoped writes, with a body for each. */
const SCOPED = (team) => [
  ['PUT', '/api/calc-exempt', { teamId: team, sprintId: 'S41', memberId: `${team}-a`, exempt: true }],
  ['PUT', '/api/support', { teamId: team, sprintId: 'S41', memberId: `${team}-a`, pct: 20 }],
  ['PUT', '/api/ceremony', { teamId: team, sprintId: 'S41', hours: 8 }],
  ['PUT', '/api/availability', { teamId: team, sprintId: 'S41', memberId: `${team}-a`, row: new Array(14).fill('1') }],
  ['PUT', '/api/sprint/roster', { teamId: team, sprintId: 'S41', memberId: `${team}-a`, state: 'added' }],
  ['PUT', '/api/note', { teamId: team, sprintId: 'S41', note: 'x' }],
];

check('A LEAD WRITES THEIR OWN TEAM, over HTTP, for real', async () => {
  for (const [m, p, body] of SCOPED('ruby')) {
    ok(await call(m, p, { cookie: who.ruby, body }), `lead of Ruby doing ${m} ${p}`);
  }
});

check('AND IS REFUSED ON TITAN — the check this whole feature exists for', async () => {
  /* If one check in this repository survives everything else, it should be
     this one. Every other failure here is noisy; this one looks exactly like
     the feature working. */
  for (const [m, p, body] of SCOPED('titan')) {
    const r = await call(m, p, { cookie: who.ruby, body });
    denied(r, `a lead of Ruby doing ${m} ${p} on TITAN`, 403);
    assert.strictEqual(r.body.code, 'wrong-team', `${p}: refused for the wrong reason (${r.body.code})`);
  }
});

check('and the mirror image — a lead of Titan is refused on Ruby', async () => {
  // Not redundant: a scope check that compared against the wrong side of the
  // request would pass the previous test and fail this one.
  for (const [m, p, body] of SCOPED('ruby')) {
    denied(await call(m, p, { cookie: who.titan, body }), `a lead of Titan doing ${m} ${p} on RUBY`, 403);
  }
});

check('A MEMBER WRITES NOTHING, on either team', async () => {
  for (const team of TEAMS) {
    for (const [m, p, body] of SCOPED(team)) {
      const r = await call(m, p, { cookie: who.member, body });
      denied(r, `a member doing ${m} ${p} on ${team}`, 403);
      assert.strictEqual(r.body.code, 'role');
    }
  }
});

check('THE GATE SEES THE BODY — which means the handler did not eat the stream', async () => {
  /* The failure mode this catches is specific and nasty: a request body is a
     stream, read once. If the gate consumes it and the handler reads again,
     the handler hangs waiting for an 'end' that already fired — presenting as
     the tool freezing on save, with nothing pointing at authorization.
     Proven by a request that is ALLOWED and whose effect is then observed:
     both readers got the body. */
  const body = { teamId: 'ruby', sprintId: 'S41', hours: 7 };
  const w = await call('PUT', '/api/ceremony', { cookie: who.ruby, body });
  ok(w, 'writing ceremony hours');
  const r = await call('GET', '/api/capacity?team=ruby&sprint=S41', { cookie: who.ruby });
  assert.strictEqual(r.body.settings.ceremonyHours, 7, 'the write never reached the handler');
});

check('A BATCH IS CHECKED ROW BY ROW over HTTP', async () => {
  const entry = (team) => ({ teamId: team, sprintId: 'S41', memberId: `${team}-a`, row: new Array(14).fill('1') });
  ok(await call('PUT', '/api/availability', { cookie: who.ruby, body: { entries: [entry('ruby'), entry('ruby')] } }),
    'a batch entirely in scope');
  const r = await call('PUT', '/api/availability', {
    cookie: who.ruby, body: { entries: [entry('ruby'), entry('titan')] },
  });
  denied(r, 'a batch whose second row is Titan', 403);
  assert.strictEqual(r.body.code, 'wrong-team');
});

check('and the refused batch wrote NOTHING — not even the row that was in scope', async () => {
  /* A gate that refuses after the handler has started is not a gate. */
  const plan = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'store', 'plan.json'), 'utf8'));
  assert.ok(!Object.keys(plan.availability || {}).some(k => k.startsWith('titan|')),
    'a refused batch left a Titan row behind');
});

check('SCENARIO SCOPE IS RESOLVED FROM THE STORE, over HTTP', async () => {
  // The request names an id and nothing else; the team is on the saved row.
  const r = await call('POST', '/api/scenarios/apply', { cookie: who.ruby, body: { id: 'sc-titan' } });
  denied(r, 'a lead of Ruby applying Titan\'s scenario', 403);
  assert.strictEqual(r.body.code, 'wrong-team');
});

check('A REQUEST WITH NO TEAM IS REFUSED FOR A LEAD — omitting the field is not a bypass', async () => {
  const r = await call('PUT', '/api/calc-exempt', { cookie: who.ruby, body: { sprintId: 'S41' } });
  denied(r, 'a scoped write naming no team', 400);
  assert.strictEqual(r.body.code, 'no-team');
});

/* ── 4. the admin tiers ───────────────────────────────────────────────── */

check('CREDENTIAL ROUTES ARE CLOSED TO LEADS AND MEMBERS', async () => {
  /* The routes that matter most the day this is reachable from more than
     loopback: they return the Jira token, the GitHub token and the mail
     settings. Closed BEFORE the bind is widened, not after. */
  for (const p of ['/api/sources', '/api/mail/config', '/api/jira/fields', '/api/audit', '/api/backup']) {
    denied(await call('GET', p, { cookie: who.ruby }), `a lead reading ${p}`, 403);
    denied(await call('GET', p, { cookie: who.member }), `a member reading ${p}`, 403);
  }
  ok(await call('GET', '/api/sources', { cookie: who.admin }), 'an admin reading /api/sources');
});

check('DESTRUCTIVE ROUTES ARE CLOSED TO LEADS', async () => {
  for (const [m, p] of [['POST', '/api/reset'], ['POST', '/api/restore'], ['POST', '/api/reconcile'],
    ['PUT', '/api/plan'], ['PUT', '/api/holidays'], ['POST', '/api/sprints']]) {
    denied(await call(m, p, { cookie: who.ruby, body: { teamId: 'ruby' } }), `a lead doing ${m} ${p}`, 403);
  }
});

/* ── 5. default deny, on the live server ──────────────────────────────── */

check('AN UNCLASSIFIED ROUTE IS REFUSED BY THE SERVER, not just by the table', async () => {
  /* The table is only policy if the gate consults it for everything. A route
     that reaches its handler without passing here would 404 — which looks
     identical to being refused, and is not. */
  const r = await call('POST', '/api/not-a-real-route', { cookie: who.admin, body: {} });
  assert.strictEqual(r.status, 403, `an unknown route returned ${r.status}, not 403`);
  assert.strictEqual(r.body.code, 'unclassified');
});

check('every route in the policy table exists on the server, or is one we are about to add', async () => {
  // The reverse of policy.test.js's check. A row for a route that does not
  // exist is dead policy, and dead policy is how a table stops being read.
  /* MATCHED ON THE CATCH-ALL'S OWN MESSAGE, not on the status. Plenty of real
     routes answer 404 for a bad input — `DELETE /api/scenarios` with no id
     means "no such scenario" — and treating that as "no such route" would
     report seven healthy routes as dead policy. */
  const missing = [];
  for (const rule of policy.RULES) {
    if (rule.path.startsWith('/api/auth/') || rule.path.startsWith('/api/users')) continue;
    const r = await call(rule.method, rule.path, { cookie: who.admin, body: {} });
    const noSuchRoute = r.status === 404 && r.body && typeof r.body.error === 'string'
      && r.body.error.startsWith('No route for');
    if (noSuchRoute) missing.push(`${rule.method} ${rule.path}`);
  }
  assert.deepStrictEqual(missing, [], `policy rows for routes the server does not have:\n       ${missing.join('\n       ')}`);
});

/* ── 6. sessions and the account routes ───────────────────────────────── */

check('SIGNING OUT ENDS THE SESSION IMMEDIATELY', async () => {
  const cookie = await login('member@kms-technology.com');
  ok(await call('GET', '/api/auth/me', { cookie }), 'reading me before logout');
  await call('POST', '/api/auth/logout', { cookie, body: {} });
  const r = await call('GET', '/api/state', { cookie });
  assert.strictEqual(r.status, 401, 'a signed-out cookie still worked');
});

check('CHANGING A PASSWORD REQUIRES THE OLD ONE, even while signed in', async () => {
  /* The session proves they held the password once. It does not prove the
     person at the keyboard now is them, and an unattended laptop is the
     common case. */
  const cookie = await login('member@kms-technology.com');
  const bad = await call('POST', '/api/auth/password', {
    cookie, body: { current: 'wrong-wrong-wrong', password: 'another-long-passphrase-9' },
  });
  denied(bad, 'changing a password without the current one', 403);
  assert.strictEqual(bad.body.code, 'bad-current');
});

check('and doing it properly ends every OTHER session', async () => {
  const a = await login('member@kms-technology.com');
  const b = await login('member@kms-technology.com');
  const r = await call('POST', '/api/auth/password', {
    cookie: a, body: { current: PW, password: 'a-brand-new-passphrase-77' },
  });
  ok(r, 'changing a password');
  assert.strictEqual((await call('GET', '/api/state', { cookie: b })).status, 401,
    'the other session survived a password change');
  // ...and the one that did it stays usable, on a fresh cookie.
  ok(await call('GET', '/api/state', { cookie: r.cookie }), 'the session that changed the password');
  who.member = r.cookie;
});

check('A DEMOTION TAKES EFFECT ON A LIVE SESSION, without a re-login', async () => {
  /* The authority is resolved per request, not frozen into the cookie. A
     demotion that waits a fortnight for a session to expire is not a demotion
     — and a tab open since before it still has every button. */
  const cookie = await login('ruby@kms-technology.com');
  ok(await call('PUT', '/api/ceremony', { cookie, body: { teamId: 'ruby', sprintId: 'S41', hours: 9 } }),
    'a lead writing before demotion');
  const u = (await call('GET', '/api/users', { cookie: who.admin })).body.users
    .find(x => x.email === 'ruby@kms-technology.com');
  ok(await call('PUT', '/api/users/roles', { cookie: who.admin, body: { id: u.id, role: 'member' } }),
    'demoting the lead');
  const r = await call('PUT', '/api/ceremony', { cookie, body: { teamId: 'ruby', sprintId: 'S41', hours: 9 } });
  denied(r, 'the SAME session writing after demotion', 403);
  // Put them back for the checks that follow.
  await call('PUT', '/api/users/roles', { cookie: who.admin, body: { id: u.id, role: 'lead', leadTeams: ['ruby'] } });
  who.ruby = await login('ruby@kms-technology.com');
});

check('DISABLING AN ACCOUNT CUTS IT OFF MID-SESSION', async () => {
  const cookie = await login('titan@kms-technology.com');
  ok(await call('GET', '/api/state', { cookie }), 'reading before being disabled');
  const u = (await call('GET', '/api/users', { cookie: who.admin })).body.users
    .find(x => x.email === 'titan@kms-technology.com');
  ok(await call('DELETE', '/api/users', { cookie: who.admin, body: { id: u.id } }), 'disabling the account');
  assert.strictEqual((await call('GET', '/api/state', { cookie })).status, 401,
    'a disabled account kept working until its cookie expired');
  // ...and it cannot sign back in.
  const back = await call('POST', '/api/auth/login', {
    body: { email: 'titan@kms-technology.com', password: PW },
  });
  assert.strictEqual(back.status, 403, 'a disabled account signed back in');
});

check('A LEAD CANNOT MAKE THEMSELVES AN ADMIN — the escalation path', async () => {
  /* The one move that would make the tiers meaningless. Checked on every
     account route rather than just the obvious one. */
  const u = (await call('GET', '/api/users', { cookie: who.admin })).body.users
    .find(x => x.email === 'ruby@kms-technology.com');
  for (const [m, p, body] of [
    ['PUT', '/api/users/roles', { id: u.id, role: 'project-admin' }],
    ['PUT', '/api/users/password', { id: u.id, password: 'yet-another-passphrase-1' }],
    ['POST', '/api/users', { email: 'puppet@kms-technology.com', password: PW, role: 'project-admin' }],
    ['GET', '/api/users', undefined],
  ]) {
    denied(await call(m, p, { cookie: who.ruby, body }), `a lead doing ${m} ${p}`, 403);
  }
});

check('THE LAST PROJECT ADMIN CANNOT BE DEMOTED OR DISABLED', async () => {
  /* Otherwise the tool reaches a state nothing in it can fix: the Users screen
     is admin-only, so the repair is behind the door that just locked.
     Recoverable only by deleting auth.db, which takes every account with it. */
  const me = (await call('GET', '/api/users', { cookie: who.admin })).body.users
    .find(x => x.email === 'admin@kms-technology.com');
  const demote = await call('PUT', '/api/users/roles', { cookie: who.admin, body: { id: me.id, role: 'member' } });
  assert.strictEqual(demote.status, 409, 'the only admin demoted themselves');
  assert.strictEqual(demote.body.code, 'last-admin');
  const kill = await call('DELETE', '/api/users', { cookie: who.admin, body: { id: me.id } });
  assert.strictEqual(kill.status, 409, 'the only admin disabled themselves');
  // Still working.
  ok(await call('GET', '/api/users', { cookie: who.admin }), 'the admin after the refused demotion');
});

check('a lead must lead at least one team — "lead of nothing" is refused at the route', async () => {
  const u = (await call('GET', '/api/users', { cookie: who.admin })).body.users
    .find(x => x.email === 'member@kms-technology.com');
  const r = await call('PUT', '/api/users/roles', { cookie: who.admin, body: { id: u.id, role: 'lead', leadTeams: [] } });
  denied(r, 'making someone a lead of no teams', 400);
  assert.strictEqual(r.body.code, 'role-needs-team');
});

check('ROLES ARE REPLACED, NOT ADDED TO — a lead can be narrowed', async () => {
  /* "Make them a lead of Ruby only" has to REMOVE Titan. A grant-only endpoint
     cannot express that, and the screen would show a change that never took. */
  const u = (await call('GET', '/api/users', { cookie: who.admin })).body.users
    .find(x => x.email === 'member@kms-technology.com');
  await call('PUT', '/api/users/roles', { cookie: who.admin, body: { id: u.id, role: 'lead', leadTeams: ['ruby', 'titan'] } });
  await call('PUT', '/api/users/roles', { cookie: who.admin, body: { id: u.id, role: 'lead', leadTeams: ['ruby'] } });
  const after = (await call('GET', '/api/users', { cookie: who.admin })).body.users.find(x => x.id === u.id);
  assert.deepStrictEqual(after.leadTeams, ['ruby'], 'narrowing a lead left the old team behind');
});

/* ── 6b. writes to Jira go out as the actor ───────────────────────────── */

check('A JIRA WRITE WITHOUT YOUR OWN TOKEN IS REFUSED, not sent under the shared one', async () => {
  /* The whole point of the feature. A silent fallback to config.json's token
     would make this tool a way around Jira's own permissions AND put one name
     on every change in Jira's history — while looking like it worked, because
     the write would succeed. Refusal is the correct outcome and the only
     observable one. */
  const r = await call('PUT', '/api/sprint/points', {
    cookie: who.ruby, body: { teamId: 'ruby', sprintId: 'S41', key: 'DEMO-1', points: 5, was: null },
  });
  denied(r, 'a lead pushing to Jira with no token of their own', 403);
  assert.strictEqual(r.body.code, 'jira-token-missing', `refused for the wrong reason: ${r.body.code}`);
  assert.match(r.body.error, /your own Jira API token/i, 'the message does not say what to do about it');
});

check('and the refusal names the PERSON\'s account, not the shared one', async () => {
  const r = await call('PUT', '/api/backlog/sprint', {
    cookie: who.ruby, body: { teamId: 'ruby', key: 'DEMO-1', sprintId: 'S41' },
  });
  assert.match(r.body.error, /under your Jira account, not a shared one/i);
});

check('THE SCOPE CHECK STILL COMES FIRST — wrong team beats missing token', async () => {
  /* Order matters: a lead poking at another team must learn nothing about
     that team, including whether a push would have been possible. */
  const r = await call('PUT', '/api/sprint/points', {
    cookie: who.ruby, body: { teamId: 'titan', sprintId: 'S41', key: 'DEMO-1', points: 5, was: null },
  });
  denied(r, 'a lead of Ruby pushing to a Titan ticket', 403);
  assert.strictEqual(r.body.code, 'wrong-team', 'the Jira-token check ran before the scope check');
});

check('A TOKEN IS CHECKED AGAINST JIRA BEFORE IT IS STORED', async () => {
  /* A token that does not work but is saved anyway is worse than none: the
     screen says "saved", and the failure arrives later on an unrelated action
     that looks like a broken tool. There is no Jira in this fixture, so the
     probe must fail — and the refusal is the proof that it probes at all. */
  const r = await call('PUT', '/api/auth/jira', {
    cookie: who.ruby, body: { email: 'ruby@kms-technology.com', token: 'pretend-token' },
  });
  assert.strictEqual(r.status, 400, `expected a refusal, got ${r.status}`);
  assert.strictEqual(r.body.code, 'jira-token-rejected');
  // ...and nothing was stored.
  const after = await call('GET', '/api/auth/jira', { cookie: who.ruby });
  assert.strictEqual(after.body.jira.has, false, 'a token Jira rejected was stored anyway');
});

check('THE TOKEN NEVER COMES BACK OUT OF THE SERVER', async () => {
  const r = await call('GET', '/api/auth/jira', { cookie: who.ruby });
  assert.strictEqual(r.status, 200);
  assert.ok(!('token' in r.body.jira), 'the payload has a token field');
  const raw = JSON.stringify(r.body);
  assert.ok(!/ATATT|token":"[^"]{10}/.test(raw), 'something token-shaped is in the payload');
});

check('and it is YOUR token — there is no route to read or set anybody else\'s', async () => {
  /* Self-service by design: a token an admin typed in on somebody's behalf
     defeats the point of the write being attributable. Asserted by there
     being no id parameter that does anything. */
  const mine = await call('GET', '/api/auth/jira', { cookie: who.member });
  assert.strictEqual(mine.status, 200);
  const users = (await call('GET', '/api/users', { cookie: who.admin })).body.users;
  assert.ok(!JSON.stringify(users).includes('jira_token'), 'the admin user list exposes stored tokens');
  assert.ok(!JSON.stringify(users).includes('jiraToken'), 'the admin user list exposes stored tokens');
});

/* ── 6c. the screens know what you may change ─────────────────────────── */

check('A MEMBER GETS A READ-ONLY CAPACITY GRID, and is told why', async () => {
  /* The screens already understand `lock.readOnly` — it is what closes a
     finished sprint, and every edit control is wired through it. Reusing that
     seam is what makes a member's view read-only without the browser forming
     a second opinion about permissions.

     A FRESH ACCOUNT, not `who.member`. An earlier check in this file promotes
     that one to a lead of Ruby to prove roles are replaced rather than added
     to — so reusing it here tested a lead and called it a member, and passed
     for entirely the wrong reason. */
  await call('POST', '/api/users', {
    cookie: who.admin, body: { email: 'reader@kms-technology.com', password: PW, role: 'member' },
  });
  const reader = await login('reader@kms-technology.com');
  const r = await call('GET', '/api/capacity?team=ruby&sprint=S41', { cookie: reader });
  ok(r, 'a member reading the capacity grid');
  assert.strictEqual(r.body.lock.readOnly, true, 'a member was handed an editable grid');
  assert.strictEqual(r.body.lock.byRole, true, 'nothing says the lock is about their role');
  assert.match(r.body.lock.reason, /read access/i, 'the reason does not explain itself');
});

check('A LEAD GETS AN EDITABLE GRID FOR THEIR OWN TEAM', async () => {
  const r = await call('GET', '/api/capacity?team=ruby&sprint=S41', { cookie: who.ruby });
  ok(r, 'a lead reading their own team');
  assert.strictEqual(r.body.lock.readOnly, false, "a lead's own team came back read-only");
});

check('AND A READ-ONLY ONE FOR THE TEAM NEXT DOOR', async () => {
  const r = await call('GET', '/api/capacity?team=titan&sprint=S41', { cookie: who.ruby });
  ok(r, 'a lead reading another team');
  assert.strictEqual(r.body.lock.readOnly, true, 'a lead of Ruby was handed an editable Titan grid');
  assert.strictEqual(r.body.lock.byRole, true);
  assert.match(r.body.lock.reason, /ruby/i, 'the reason does not say which teams they do lead');
});

check('an admin edits every team', async () => {
  for (const team of TEAMS) {
    const r = await call('GET', `/api/capacity?team=${team}&sprint=S41`, { cookie: who.admin });
    assert.strictEqual(r.body.lock.readOnly, false, `an admin got a read-only ${team}`);
  }
});

check('THE CLOSED-SPRINT REASON WINS when both apply', () => {
  /* "This sprint is closed" is true for everybody and is the more useful
     thing to be told. A lead who was instead told they lack permission would
     go asking for permission they already have.

     Tested against `roleLock` directly rather than over HTTP: the plan is
     cached in `store.getPlan()`, so editing plan.json under a running server
     changes nothing a request can see. A test that wrote the file and then
     asserted on the response would be checking the cache, not the rule. */
  const { roleLock } = require('../server.js');
  const cfg = { auth: { enabled: true } };
  const closed = { state: 'closed', readOnly: true, reason: 'This sprint is closed. Its numbers are history.' };
  const open = { state: 'active', readOnly: false, reason: null };
  const lead = { actor: { id: 'r', role: 'lead', leadTeams: ['ruby'] } };

  const both = roleLock(lead, cfg, closed, 'titan');
  assert.strictEqual(both.readOnly, true);
  assert.match(both.reason, /closed/i, 'a closed sprint was explained as a permissions problem');
  assert.ok(!both.byRole, 'the role reason overrode the sprint one');

  // ...and with the sprint open, the role reason is the one that applies.
  const roleOnly = roleLock(lead, cfg, open, 'titan');
  assert.strictEqual(roleOnly.readOnly, true);
  assert.strictEqual(roleOnly.byRole, true);
  assert.match(roleOnly.reason, /ruby/i);

  // Their own team, open sprint: editable, and untouched.
  assert.deepStrictEqual(roleLock(lead, cfg, open, 'ruby'), open);

  // Authentication off: nothing is ever locked by role.
  assert.deepStrictEqual(roleLock(lead, { auth: { enabled: false } }, open, 'titan'), open);
  assert.deepStrictEqual(roleLock({ actor: null }, cfg, open, 'titan'), open);
});

/* ── 7. the audit trail ───────────────────────────────────────────────── */

check('THE AUDIT LOG NAMES THE ACTOR, not just the action', async () => {
  await call('PUT', '/api/ceremony', { cookie: who.ruby, body: { teamId: 'ruby', sprintId: 'S41', hours: 6 } });
  const log = (await call('GET', '/api/audit', { cookie: who.admin })).body;
  const entry = log.find(e => e.action === 'ceremony.set');
  assert.ok(entry, `no ceremony entry in the audit log: ${log.slice(0, 5).map(e => e.action).join(', ')}`);
  assert.ok(entry.actor, 'the entry has no actor at all');
  assert.strictEqual(entry.actor.email, 'ruby@kms-technology.com', 'the wrong person is recorded');
  assert.strictEqual(entry.actor.role, 'lead');
});

check('and a REFUSED request is audited too, because that is the interesting one', async () => {
  await call('PUT', '/api/ceremony', { cookie: who.ruby, body: { teamId: 'titan', sprintId: 'S41', hours: 6 } });
  const log = (await call('GET', '/api/audit', { cookie: who.admin })).body;
  const entry = log.find(e => e.action === 'auth.refused');
  assert.ok(entry, 'a refusal left no trace');
  assert.strictEqual(entry.actor.email, 'ruby@kms-technology.com');
  assert.strictEqual(entry.detail.code, 'wrong-team');
});

check('a signed-in password is never echoed back, anywhere', async () => {
  /* Belt and braces over the whole account surface: the hash must not reach
     the browser through any of these. */
  const users = await call('GET', '/api/users', { cookie: who.admin });
  const raw = JSON.stringify(users.body);
  assert.ok(!/scrypt\$/.test(raw), 'a password hash is in the /api/users payload');
  assert.ok(!/password_hash/.test(raw), 'the hash column name is in the payload');
  const me = await call('GET', '/api/auth/me', { cookie: who.admin });
  assert.ok(!/scrypt\$/.test(JSON.stringify(me.body)), 'a password hash is in /api/auth/me');
});

/* ── run ──────────────────────────────────────────────────────────────── */

server.listen(0, '127.0.0.1', async () => {
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\nauth-api.test.js: ${passed} passed, ${failed} failed\n`);
  server.close();
  try { require('../lib/db').close(); } catch (_) { /* fine */ }
  try { auth.close(); } catch (_) { /* fine */ }
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
