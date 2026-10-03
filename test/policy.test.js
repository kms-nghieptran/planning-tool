'use strict';
/**
 * policy.test.js — who may do what.
 *
 * The defect this file exists to catch has no symptom. An authorization hole
 * does not throw, does not log, and does not look wrong on screen: the person
 * simply succeeds at something they should not have been able to do, and
 * nobody finds out unless they mention it. So every check here is written as
 * "X must be REFUSED", and the ones that matter most are the near misses — a
 * lead acting on the team next door, a batch whose first row is in scope and
 * whose second is not, a request that omits the field the check reads.
 *
 * THE FIRST CHECK IS THE IMPORTANT ONE. It walks server.js, collects every
 * route that actually exists, and fails if any of them is missing from the
 * table. Default-deny makes an unclassified route safe; this makes it VISIBLE,
 * which is what stops the policy quietly falling behind the server.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const policy = require('../lib/policy');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); } catch (err) {
    failed++; console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

/* ── actors ───────────────────────────────────────────────────────────── */

const anon = null;
const member = { id: 'm', email: 'm@kms-technology.com', role: 'member', status: 'active', leadTeams: [] };
const ruby = { id: 'r', email: 'r@kms-technology.com', role: 'lead', status: 'active', leadTeams: ['ruby'] };
const titan = { id: 't', email: 't@kms-technology.com', role: 'lead', status: 'active', leadTeams: ['titan'] };
const both = { id: 'b', email: 'b@kms-technology.com', role: 'lead', status: 'active', leadTeams: ['ruby', 'titan'] };
const admin = { id: 'a', email: 'a@kms-technology.com', role: 'project-admin', status: 'active', leadTeams: [] };

const ask = (method, pathname, actor, { body = null, query = null, plan = {} } = {}) =>
  policy.allow({
    method, path: pathname, actor, body,
    query: query ? new URLSearchParams(query) : new URLSearchParams(),
    plan: () => plan,
  });

const allowed = (res, what) => assert.strictEqual(res.ok, true, `${what} was refused: ${res.reason}`);
const refused = (res, what, code) => {
  assert.strictEqual(res.ok, false, `${what} WAS ALLOWED — it must not be`);
  if (code) assert.strictEqual(res.code, code, `${what} refused for the wrong reason: ${res.code}`);
};

/* ── 1. the table and the server agree ───────────────────────────────── */

/** Every `if (p === '/api/x' && req.method === 'Y')` in server.js. */
function liveRoutes() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').split('\n');
  const re = /if \(p === '(\/api\/[^']+)' && req\.method === '([A-Z]+)'\)/;
  const out = new Set();
  for (const line of src) {
    const m = re.exec(line);
    if (m) out.add(`${m[2]} ${m[1]}`);
  }
  return out;
}

/* The three routes reached BEFORE there is an actor. They are exempted by name
   in `server.js` (PUBLIC_ROUTES) rather than by a policy row, so the table not
   listing them is correct — and this list is written out here so that
   "unclassified" and "deliberately public" stay two different things. */
const PUBLIC = new Set(['POST /api/auth/login', 'POST /api/auth/setup', 'GET /api/auth/status']);

check('EVERY ROUTE THE SERVER HAS IS IN THE POLICY TABLE', () => {
  /* Default deny already makes an unclassified route SAFE. This makes it
     VISIBLE — the difference between "the new endpoint 403s and somebody files
     a bug next week" and "the suite fails the moment it is added". */
  const live = liveRoutes();
  assert.ok(live.size > 50, `only found ${live.size} routes — the scraper and server.js have parted company`);
  const table = new Set(policy.classified());
  const missing = [...live].filter(x => !table.has(x) && !PUBLIC.has(x)).sort();
  assert.deepStrictEqual(missing, [], `unclassified routes:\n       ${missing.join('\n       ')}`);
});

check('and the public list in this file matches the server\'s own', () => {
  /* Two lists of "reachable without signing in" is one list too many. If
     server.js grows a fourth public route, the exemption above would hide it
     from the check that is supposed to catch exactly that. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = /const PUBLIC_ROUTES = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  assert.ok(block, 'server.js has no PUBLIC_ROUTES list any more');
  const theirs = new Set([...block[1].matchAll(/'([A-Z]+ [^']+)'/g)].map(m => m[1]));
  assert.deepStrictEqual([...theirs].sort(), [...PUBLIC].sort(),
    'the server exempts a different set of routes than this file expects');
});

check('and the table lists nothing twice', () => {
  // Enforced at require time, so this is really a check that the check exists.
  const seen = new Set();
  for (const k of policy.classified()) {
    assert.ok(!seen.has(k), `${k} appears twice in the table`);
    seen.add(k);
  }
});

check('a team-scoped rule always knows how to find its team', () => {
  for (const rule of policy.RULES) {
    if (rule.scope === 'team') {
      assert.strictEqual(typeof rule.teams, 'function', `${rule.method} ${rule.path} is scoped but has no resolver`);
    } else {
      assert.strictEqual(rule.teams, null, `${rule.method} ${rule.path} has a resolver but is not scoped`);
    }
  }
});

/* ── 2. default deny ─────────────────────────────────────────────────── */

check('AN UNCLASSIFIED ROUTE IS REFUSED — even to a project admin', () => {
  /* The fail-open bug, caught at its source. A new endpoint added next month
     is locked until somebody writes a row for it, and it is locked for
     everybody so the person who notices is the one who can fix it. */
  for (const actor of [anon, member, ruby, admin]) {
    refused(ask('POST', '/api/brand-new-thing', actor), 'an unclassified route', 'unclassified');
  }
});

check('and so is a route that exists under a method it does not have', () => {
  // GET /api/reset is not a route; it must not inherit POST /api/reset's rule.
  refused(ask('GET', '/api/reset', admin), 'GET on a POST-only route', 'unclassified');
  refused(ask('DELETE', '/api/capacity', admin), 'DELETE on a GET-only route', 'unclassified');
});

check('the refusal names the route, so the fix is obvious', () => {
  const res = ask('POST', '/api/brand-new-thing', admin);
  assert.match(res.reason, /POST \/api\/brand-new-thing/);
  assert.match(res.reason, /authorization policy/);
});

/* ── 3. anonymous ────────────────────────────────────────────────────── */

check('NOBODY SIGNED IN GETS NOTHING, not even a read', () => {
  for (const [m, p] of [['GET', '/api/state'], ['GET', '/api/capacity'], ['PUT', '/api/availability'],
    ['GET', '/api/sources'], ['POST', '/api/reset']]) {
    const res = ask(m, p, anon);
    refused(res, `anonymous ${m} ${p}`, 'anonymous');
    assert.strictEqual(res.status, 401, 'anonymous should be 401 (sign in), not 403 (not allowed)');
  }
});

check('401 and 403 are kept apart, because they mean different things to the UI', () => {
  // 401 → show the login page. 403 → tell them they lack the role. Collapsing
  // the two sends a signed-in member to a login screen they are already past.
  assert.strictEqual(ask('GET', '/api/sources', anon).status, 401);
  assert.strictEqual(ask('GET', '/api/sources', member).status, 403);
});

/* ── 4. members read, members do not write ───────────────────────────── */

check('A MEMBER CAN READ THE PLANNING SCREENS', () => {
  for (const p of ['/api/state', '/api/capacity', '/api/sprint', '/api/backlog', '/api/reports/delivery',
    '/api/reports/coverage', '/api/prioritization', '/api/risks', '/api/blockers', '/api/team',
    '/api/search', '/api/scenarios', '/api/adjustments', '/api/sprint/roster']) {
    allowed(ask('GET', p, member, { query: { team: 'ruby' } }), `member reading ${p}`);
  }
});

check('A MEMBER CANNOT WRITE ANYTHING ON A TEAM', () => {
  for (const [m, p] of [['PUT', '/api/availability'], ['PUT', '/api/calc-exempt'], ['PUT', '/api/support'],
    ['PUT', '/api/ceremony'], ['PUT', '/api/override'], ['PUT', '/api/note'], ['PUT', '/api/sprint-note'],
    ['PUT', '/api/sprint/roster'], ['PUT', '/api/team'], ['DELETE', '/api/team/member'],
    ['PUT', '/api/sprint/points'], ['PUT', '/api/backlog/sprint'], ['POST', '/api/scenarios']]) {
    refused(ask(m, p, member, { body: { teamId: 'ruby' } }), `member ${m} ${p}`, 'role');
  }
});

check('and the refusal says what role it would take, in words', () => {
  const res = ask('PUT', '/api/availability', member, { body: { teamId: 'ruby' } });
  assert.match(res.reason, /team lead/);
  assert.match(res.reason, /availability/, 'the message does not say what was being attempted');
});

check('a member may still save a search — a deliberate exception', () => {
  // Shared state, written by a member, on purpose: the cost of a cluttered
  // list is nothing beside refusing the one feature members use most.
  allowed(ask('POST', '/api/search/saved', member), 'member saving a search');
  allowed(ask('DELETE', '/api/search/saved', member), 'member deleting a saved search');
});

check('a member may print a report they can already read', () => {
  allowed(ask('GET', '/api/mail/preview-pdf', member, { query: { team: 'ruby' } }), 'member previewing a PDF');
  // ...but not send it to anybody.
  refused(ask('POST', '/api/mail/send', member, { body: { teamId: 'ruby' } }), 'member sending mail', 'role');
});

/* ── 5. THE CENTRAL CHECK: a lead is scoped ──────────────────────────── */

check('A LEAD WRITES THEIR OWN TEAM', () => {
  for (const [m, p] of [['PUT', '/api/availability'], ['PUT', '/api/calc-exempt'], ['PUT', '/api/support'],
    ['PUT', '/api/ceremony'], ['PUT', '/api/override'], ['PUT', '/api/note'], ['PUT', '/api/sprint-note'],
    ['PUT', '/api/sprint/roster'], ['PUT', '/api/team'], ['DELETE', '/api/team/member'],
    ['POST', '/api/team/unexclude'], ['PUT', '/api/sprint/points'], ['PUT', '/api/sprint/duedate'],
    ['PUT', '/api/backlog/sprint']]) {
    const body = p === '/api/availability' ? { entries: [{ teamId: 'ruby' }] } : { teamId: 'ruby' };
    allowed(ask(m, p, ruby, { body }), `lead of Ruby doing ${m} ${p} on Ruby`);
  }
});

check('AND IS REFUSED ON THE TEAM NEXT DOOR — the single most important row', () => {
  /* If one check in this file survives a refactor, it should be this one.
     Every other failure mode is noisy; this one looks like the feature working. */
  for (const [m, p] of [['PUT', '/api/availability'], ['PUT', '/api/calc-exempt'], ['PUT', '/api/support'],
    ['PUT', '/api/ceremony'], ['PUT', '/api/override'], ['PUT', '/api/note'], ['PUT', '/api/sprint-note'],
    ['PUT', '/api/sprint/roster'], ['PUT', '/api/team'], ['DELETE', '/api/team/member'],
    ['POST', '/api/team/unexclude'], ['PUT', '/api/sprint/points'], ['PUT', '/api/sprint/duedate'],
    ['PUT', '/api/backlog/sprint'], ['POST', '/api/scenarios'], ['POST', '/api/mail/send']]) {
    const body = p === '/api/availability' ? { entries: [{ teamId: 'titan' }] } : { teamId: 'titan' };
    refused(ask(m, p, ruby, { body }), `lead of Ruby doing ${m} ${p} on TITAN`, 'wrong-team');
  }
});

check('the wrong-team refusal names both sides, so it is actionable', () => {
  const res = ask('PUT', '/api/calc-exempt', ruby, { body: { teamId: 'titan' } });
  assert.match(res.reason, /ruby/, 'it does not say which teams they do lead');
  assert.match(res.reason, /titan/, 'it does not say which team they reached for');
});

check('a lead of two teams writes both and still not a third', () => {
  allowed(ask('PUT', '/api/calc-exempt', both, { body: { teamId: 'ruby' } }), 'lead of both on Ruby');
  allowed(ask('PUT', '/api/calc-exempt', both, { body: { teamId: 'titan' } }), 'lead of both on Titan');
  refused(ask('PUT', '/api/calc-exempt', both, { body: { teamId: 'katalon-auto-mex' } }), 'lead of both on a third', 'wrong-team');
});

check('scope is exact — a team id that merely starts the same is a different team', () => {
  // 'ruby' must not match 'ruby-legacy'. A `startsWith` here would be a quiet
  // grant across every team whose id shares a prefix.
  const rubyLead = { ...ruby, leadTeams: ['ruby'] };
  refused(ask('PUT', '/api/calc-exempt', rubyLead, { body: { teamId: 'ruby-legacy' } }), 'ruby-legacy', 'wrong-team');
  refused(ask('PUT', '/api/calc-exempt', rubyLead, { body: { teamId: 'rub' } }), 'rub', 'wrong-team');
  refused(ask('PUT', '/api/calc-exempt', rubyLead, { body: { teamId: 'RUBY' } }), 'RUBY (different case)', 'wrong-team');
});

/* ── 6. the two routes whose scope is not simply `body.teamId` ───────── */

check('A BATCH IS CHECKED ROW BY ROW, not by its first entry', () => {
  /* /api/availability takes {entries:[{teamId,...}]}. Reading one id out of
     that is a bypass with no symptom: the first row is in scope, the rest are
     not, and the check passes. */
  allowed(ask('PUT', '/api/availability', ruby, { body: { entries: [{ teamId: 'ruby' }, { teamId: 'ruby' }] } }),
    'a batch entirely within scope');
  refused(ask('PUT', '/api/availability', ruby, {
    body: { entries: [{ teamId: 'ruby' }, { teamId: 'titan' }] },
  }), 'a batch whose FIRST row is in scope and whose second is not', 'wrong-team');
  refused(ask('PUT', '/api/availability', ruby, {
    body: { entries: [{ teamId: 'titan' }, { teamId: 'ruby' }] },
  }), 'a batch whose LAST row is in scope', 'wrong-team');
});

check('a single-entry body still works — the batch shape is optional', () => {
  allowed(ask('PUT', '/api/availability', ruby, { body: { teamId: 'ruby', sprintId: 'S41' } }),
    'the un-batched form');
});

check('SCENARIO SCOPE COMES FROM THE STORED SCENARIO, which the request never names', () => {
  /* /api/scenarios/apply posts `{id}`. The team is a property of the saved
     row, so a resolver reading the body alone would find nothing and — if
     "nothing" meant "fine" — let a lead apply any team's scenario. */
  const plan = {
    scenarios: [
      { id: 'sc-ruby', teamId: 'ruby', sprintId: 'S41' },
      { id: 'sc-titan', teamId: 'titan', sprintId: 'S41' },
    ],
  };
  allowed(ask('POST', '/api/scenarios/apply', ruby, { body: { id: 'sc-ruby' }, plan }), 'applying own scenario');
  refused(ask('POST', '/api/scenarios/apply', ruby, { body: { id: 'sc-titan' }, plan }),
    'a lead of Ruby applying TITAN\'s scenario', 'wrong-team');
  refused(ask('DELETE', '/api/scenarios', ruby, { body: { id: 'sc-titan' }, plan }),
    'a lead of Ruby deleting Titan\'s scenario', 'wrong-team');
});

check('a scenario id that does not exist is refused, not waved through', () => {
  // The resolver finds no team. That has to read as "cannot be checked",
  // never as "no team involved, carry on".
  refused(ask('POST', '/api/scenarios/apply', ruby, { body: { id: 'ghost' }, plan: { scenarios: [] } }),
    'applying a scenario that does not exist', 'no-team');
});

check('the plan is only read by the rules that need it', () => {
  /* An authorization check runs on every request; making all of them load the
     store would be a real cost for the two that use it. */
  let reads = 0;
  const plan = () => { reads++; return {}; };
  policy.allow({ method: 'GET', path: '/api/capacity', actor: member, query: new URLSearchParams(), plan });
  policy.allow({ method: 'PUT', path: '/api/calc-exempt', actor: ruby, body: { teamId: 'ruby' }, query: new URLSearchParams(), plan });
  assert.strictEqual(reads, 0, 'an ordinary request read the plan just to check permissions');
});

/* ── 7. unspecified is not allowed ───────────────────────────────────── */

check('A REQUEST THAT DOES NOT SAY WHICH TEAM IS REFUSED FOR A LEAD', () => {
  /* Otherwise "omit the field" is the bypass — and it is the FIRST thing
     anyone tries, because it is what a buggy client does by accident. */
  for (const body of [{}, { teamId: null }, { teamId: '' }, { sprintId: 'S41' }, { entries: [] }]) {
    refused(ask('PUT', '/api/calc-exempt', ruby, { body }), `a body with no team: ${JSON.stringify(body)}`, 'no-team');
  }
});

check('but a project admin is not scoped, so it goes through', () => {
  allowed(ask('PUT', '/api/calc-exempt', admin, { body: {} }), 'admin with no team named');
  allowed(ask('PUT', '/api/calc-exempt', admin, { body: { teamId: 'titan' } }), 'admin on any team');
  allowed(ask('PUT', '/api/availability', admin, { body: { entries: [{ teamId: 'titan' }] } }), 'admin batching');
});

check('AN ADMIN IS NOT SCOPED BY HAVING NO TEAMS', () => {
  /* The bug this prevents is a one-liner: treat `leadTeams` as the check for
     everybody, and a project admin — whose list is empty by design — is
     refused on every team-scoped route in the app. */
  assert.deepStrictEqual(admin.leadTeams, [], 'fixture check: an admin leads no teams');
  allowed(ask('PUT', '/api/sprint/roster', admin, { body: { teamId: 'ruby' } }), 'admin on a scoped route');
});

/* ── 8. the admin-only tiers ─────────────────────────────────────────── */

check('CREDENTIAL ROUTES ARE ADMIN ONLY — these are the ones that matter once it is reachable', () => {
  for (const [m, p] of [['GET', '/api/sources'], ['PUT', '/api/config'], ['GET', '/api/mail/config'],
    ['PUT', '/api/mail/config'], ['GET', '/api/jira/fields'], ['PUT', '/api/jira/fields'],
    ['POST', '/api/test-connection'], ['GET', '/api/backup'], ['GET', '/api/audit']]) {
    refused(ask(m, p, ruby), `a LEAD reaching ${m} ${p}`, 'role');
    refused(ask(m, p, member), `a member reaching ${m} ${p}`, 'role');
    allowed(ask(m, p, admin), `an admin reaching ${m} ${p}`);
  }
});

check('DESTRUCTIVE ROUTES ARE ADMIN ONLY', () => {
  for (const [m, p] of [['POST', '/api/reset'], ['POST', '/api/restore'], ['POST', '/api/import/issues'],
    ['POST', '/api/reconcile'], ['PUT', '/api/plan'], ['DELETE', '/api/team']]) {
    refused(ask(m, p, ruby, { body: { teamId: 'ruby' } }), `a lead reaching ${m} ${p}`, 'role');
    allowed(ask(m, p, admin, { body: { teamId: 'ruby' } }), `an admin reaching ${m} ${p}`);
  }
});

check('THE SHARED SPRINT CALENDAR IS ADMIN ONLY, however team-shaped it looks', () => {
  /* `plan.sprints` is ONE list that every team reads through its own `byTeam`
     entry. Generating sprints or moving their dates moves them for everybody,
     so a lead doing it is out of scope even though the screen is their own. */
  refused(ask('POST', '/api/sprints', ruby, { body: { teamId: 'ruby', count: 4 } }), 'a lead generating sprints', 'role');
  refused(ask('PUT', '/api/sprint/dates', ruby, { body: { teamId: 'ruby', sprintId: 'S41' } }), 'a lead moving sprint dates', 'role');
  refused(ask('PUT', '/api/holidays', ruby, {}), 'a lead changing holidays', 'role');
  allowed(ask('POST', '/api/sprints', admin, {}), 'an admin generating sprints');
});

check('an admin can do everything a lead can', () => {
  // Not a tautology: `allow` returns early for admins on scoped rules, and an
  // early return is exactly where a missing branch hides.
  for (const rule of policy.RULES) {
    const body = rule.path === '/api/availability' ? { entries: [{ teamId: 'ruby' }] } : { teamId: 'ruby' };
    const plan = { scenarios: [{ id: 'x', teamId: 'ruby' }] };
    const res = ask(rule.method, rule.path, admin, { body: { ...body, id: 'x' }, query: { team: 'ruby' }, plan });
    allowed(res, `admin on ${rule.method} ${rule.path}`);
  }
});

/* ── 9. the account routes ───────────────────────────────────────────── */

check('ANYONE SIGNED IN MAY MANAGE THEMSELVES', () => {
  for (const [m, p] of [['GET', '/api/auth/me'], ['POST', '/api/auth/logout'], ['POST', '/api/auth/password'],
    ['GET', '/api/auth/sessions'], ['DELETE', '/api/auth/sessions']]) {
    allowed(ask(m, p, member), `member doing ${m} ${p}`);
  }
});

check('BUT NOBODY BELOW ADMIN TOUCHES SOMEBODY ELSE\'S ACCOUNT', () => {
  /* The escalation path: a lead who can change roles makes themselves an
     admin, and the tiers stop meaning anything. */
  for (const [m, p] of [['GET', '/api/users'], ['POST', '/api/users'], ['PUT', '/api/users'],
    ['DELETE', '/api/users'], ['PUT', '/api/users/roles'], ['PUT', '/api/users/password'],
    ['DELETE', '/api/users/sessions']]) {
    refused(ask(m, p, member), `member doing ${m} ${p}`, 'role');
    refused(ask(m, p, ruby), `a LEAD doing ${m} ${p}`, 'role');
    allowed(ask(m, p, admin), `admin doing ${m} ${p}`);
  }
});

check('the login and setup routes are NOT in the table — the server exempts them by name', () => {
  /* They are reached before there is an actor. Granting them through this
     table would mean the table has a row that anonymous callers satisfy, and
     that row is one copy-paste away from being the shape of a second one. */
  for (const p of ['/api/auth/login', '/api/auth/setup', '/api/auth/status']) {
    assert.strictEqual(policy.ruleFor('POST', p), null, `${p} is in the policy table and should not be`);
    assert.strictEqual(policy.ruleFor('GET', p), null, `${p} is in the policy table and should not be`);
  }
});

/* ── 10. disabled ────────────────────────────────────────────────────── */

check('A DISABLED ACTOR IS REFUSED EVEN HOLDING AN ADMIN ROLE', () => {
  // Belt and braces: auth.sessionActor already refuses to resolve a disabled
  // account, so this branch should be unreachable. "Should be" is why it is
  // tested — the day some other path builds an actor, this is what catches it.
  const dead = { ...admin, status: 'disabled' };
  refused(ask('GET', '/api/state', dead), 'a disabled admin reading', 'disabled');
  refused(ask('POST', '/api/reset', dead), 'a disabled admin resetting', 'disabled');
});

check('an actor with a role nobody recognises gets nothing', () => {
  const weird = { ...member, role: 'superuser' };
  refused(ask('GET', '/api/state', weird), 'an unknown role', 'no-role');
});

/* ── summary ──────────────────────────────────────────────────────────── */
console.log(`\n${path.basename(__filename)}: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
