'use strict';
/**
 * policy.js — what each role may DO.
 *
 * `auth.js` answers "who is this". This answers "may they". Kept apart because
 * the two fail differently: a bug in auth lets the wrong person in, a bug here
 * lets the right person do the wrong thing, and a module that answers both
 * tends to answer the second by accident while answering the first.
 *
 * ── THE TABLE IS THE POLICY ──────────────────────────────────────────────
 *
 * Every route is a row. Not a decorator on the handler, not a check inside it:
 * a handler that forgets its check looks exactly like a handler that does not
 * need one, and nothing can tell you which routes are unguarded. A table can be
 * read end to end, diffed in review, and — see DEFAULT DENY — enumerated
 * against the server's real route list by a test.
 *
 * ── DEFAULT DENY ─────────────────────────────────────────────────────────
 *
 * A route that is not in this table is REFUSED. This is the single most
 * important line in the file. The usual shape of this bug is a new endpoint
 * shipping wide open because nobody remembered to classify it — fail-open, and
 * invisible until someone finds it. Here the new endpoint returns 403 until
 * somebody adds a row, which is loud, immediate, and happens in development
 * rather than in production.
 *
 * ── SCOPE IS THE WHOLE POINT OF "LEAD" ───────────────────────────────────
 *
 * A lead of Ruby may write Ruby's capacity and may not write Titan's. A rule
 * with `scope: 'team'` names a `teams(ctx)` function that says which teams the
 * request touches, and EVERY team it names must be one the actor leads. Two
 * routes make that harder than it looks and are the reason `teams` is a
 * function rather than a field name:
 *
 *   · `/api/availability` carries the team id inside each ENTRY of a batch, so
 *     a request can touch several teams at once. A check on "the" team id would
 *     read the first and wave the rest through.
 *   · `/api/scenarios/apply` names a scenario id and nothing else; the team is
 *     a property of the STORED scenario. So `teams` is handed the plan.
 *
 * A team-scoped rule whose `teams` comes back EMPTY is refused for a lead. The
 * request did not say what it was touching, so nothing can confirm it is in
 * scope — and "unspecified" must not mean "allowed", or omitting a field
 * becomes the bypass.
 */

const { RANK } = require('./auth');

/* ─────────────────────────── scope helpers ─────────────────────────── */

const clean = (list) => [...new Set((list || []).filter(Boolean).map(String))];

/** The team named by a write body, or by a `?team=` on a read. */
const bodyTeam = (ctx) => clean([ctx.body && ctx.body.teamId, ctx.body && ctx.body.team]);
const queryTeam = (ctx) => clean([ctx.query && ctx.query.get && ctx.query.get('team')]);
const anyTeam = (ctx) => clean([...bodyTeam(ctx), ...queryTeam(ctx)]);

/**
 * EVERY team in a batch, not the first one.
 *
 * `/api/availability` accepts `{entries:[{teamId,...},...]}`. Reading one id
 * out of that is a bypass with no symptom: a lead of Ruby posts a batch whose
 * first entry is Ruby and whose rest are Titan, and the check passes.
 */
const entryTeams = (ctx) => {
  const b = ctx.body || {};
  const rows = Array.isArray(b.entries) ? b.entries : [b];
  return clean(rows.map(e => e && (e.teamId || e.team)));
};

/** The team a stored scenario belongs to — the request only names its id. */
const scenarioTeam = (ctx) => {
  const id = ctx.body && ctx.body.id;
  if (!id) return [];
  const plan = ctx.plan() || {};
  const sc = (plan.scenarios || []).find(x => x && x.id === id);
  return sc ? clean([sc.teamId]) : [];
};

/**
 * Deduping touches a team's whole scenario list, and the request says which
 * team only sometimes. Resolved the same way, and an unresolved one is refused
 * rather than assumed global.
 */
const scenarioScope = (ctx) => {
  const direct = anyTeam(ctx);
  return direct.length ? direct : scenarioTeam(ctx);
};

/* ─────────────────────────── the table ─────────────────────────── */

/**
 * `min`   the lowest role that may call this at all
 * `scope` 'none'  — the role alone decides (a global action, or a global read)
 *         'team'  — a lead additionally has to lead every team it names
 * `teams` which teams the request touches; required when scope is 'team'
 * `why`   the one-line reason, for the 403 the user actually sees
 */
const RULES = [
  /* ── reads: everyone signed in ──────────────────────────────────────
     Reads stay open on purpose. This tool's value is that the whole team can
     see the same numbers, and a planning figure is not a secret from the
     people it describes. The admin-only reads below are the exceptions, and
     every one of them is a read of CREDENTIALS or of the audit trail. */
  r('GET', '/api/state', 'member'),
  r('GET', '/api/capacity', 'member'),
  r('GET', '/api/capacity/bycomponent/epics', 'member'),
  r('GET', '/api/backlog', 'member'),
  r('GET', '/api/backlog/health', 'member'),
  r('GET', '/api/sprint', 'member'),
  r('GET', '/api/sprints', 'member'),
  r('GET', '/api/sprint/roster', 'member'),
  r('GET', '/api/forecast', 'member'),
  r('GET', '/api/prioritization', 'member'),
  r('GET', '/api/risks', 'member'),
  r('GET', '/api/blockers', 'member'),
  r('GET', '/api/scenarios', 'member'),
  r('GET', '/api/adjustments', 'member'),
  r('GET', '/api/team', 'member'),
  r('GET', '/api/search', 'member'),
  r('GET', '/api/coverage/scope', 'member'),
  r('GET', '/api/category-rules/winners', 'member'),
  r('GET', '/api/reports/delivery', 'member'),
  r('GET', '/api/reports/automation', 'member'),
  r('GET', '/api/reports/coverage', 'member'),
  r('GET', '/api/reports/coverage/epics', 'member'),
  r('GET', '/api/reports/coverage/movement', 'member'),
  r('GET', '/api/reports/coverage/moved', 'member'),
  r('GET', '/api/reports/backlog', 'member'),
  r('GET', '/api/reports/backlog/epics', 'member'),
  /* A PDF of a report they can already read on screen. Refusing it would mean
     "you may see this number but not print it", which is not a policy. */
  r('GET', '/api/mail/preview-pdf', 'member'),
  /* Saved searches are shared state, so this is a member WRITE — deliberately.
     The worst case is a cluttered list; the cost of refusing is that the one
     feature a member uses most is the one they cannot use. */
  r('POST', '/api/search/saved', 'member'),
  r('DELETE', '/api/search/saved', 'member'),

  /* ── team-scoped writes: a lead, for their own teams ────────────────
     Everything here is a planning decision about one team's fortnight. */
  r('PUT', '/api/availability', 'lead', 'team', entryTeams, 'edit that team\'s availability'),
  r('PUT', '/api/calc-exempt', 'lead', 'team', bodyTeam, 'change who counts in that team\'s capacity'),
  r('PUT', '/api/support', 'lead', 'team', bodyTeam, 'set support time for that team'),
  r('PUT', '/api/ceremony', 'lead', 'team', bodyTeam, 'set ceremony hours for that team'),
  r('PUT', '/api/override', 'lead', 'team', bodyTeam, 'override that team\'s figures'),
  r('PUT', '/api/note', 'lead', 'team', bodyTeam, 'write notes on that team\'s sprint'),
  r('PUT', '/api/sprint-note', 'lead', 'team', bodyTeam, 'write notes on that team\'s sprint'),
  r('PUT', '/api/sprint/roster', 'lead', 'team', bodyTeam, 'change that team\'s sprint roster'),
  r('PUT', '/api/team', 'lead', 'team', bodyTeam, 'edit that team'),
  r('DELETE', '/api/team/member', 'lead', 'team', bodyTeam, 'remove a member of that team'),
  r('POST', '/api/team/unexclude', 'lead', 'team', bodyTeam, 'restore a member of that team'),
  r('POST', '/api/scenarios', 'lead', 'team', anyTeam, 'save a scenario for that team'),
  r('POST', '/api/scenarios/apply', 'lead', 'team', scenarioScope, 'apply a scenario to that team'),
  r('POST', '/api/scenarios/dedupe', 'lead', 'team', scenarioScope, 'tidy that team\'s scenarios'),
  r('DELETE', '/api/scenarios', 'lead', 'team', scenarioScope, 'delete that team\'s scenario'),
  r('POST', '/api/mail/send', 'lead', 'team', anyTeam, 'email that team\'s report'),

  /* ── Jira write-through ─────────────────────────────────────────────
     These three leave the tool and change a real ticket. The ROLE check is
     here; WHOSE CREDENTIALS go out is a separate question answered by the
     per-user token work — Jira's own permissions are the real backstop, and
     this row only decides who may attempt it. */
  r('PUT', '/api/sprint/points', 'lead', 'team', bodyTeam, 'change story points in Jira'),
  r('PUT', '/api/sprint/duedate', 'lead', 'team', bodyTeam, 'change a due date in Jira'),
  r('PUT', '/api/backlog/sprint', 'lead', 'team', bodyTeam, 'move an item between sprints in Jira'),

  /* ── lead, but not scoped ───────────────────────────────────────────
     Cross-team by nature. A component ranking or a coverage adjustment is one
     shared list; there is no per-team copy to scope to, so the tier is the
     only control. Called out rather than quietly filed with the scoped rows,
     because "a lead of Ruby can change this" is a real consequence. */
  r('PUT', '/api/component-rank', 'lead', 'none', null, 'reorder components'),
  r('PUT', '/api/component-priority', 'lead', 'none', null, 'set component priority'),
  r('PUT', '/api/component-note', 'lead', 'none', null, 'write a component note'),
  r('PUT', '/api/adjustments', 'lead', 'none', null, 'adjust an issue\'s figures'),
  r('DELETE', '/api/adjustments', 'lead', 'none', null, 'remove an adjustment'),
  r('POST', '/api/sync', 'lead', 'none', null, 'sync from Jira'),
  r('GET', '/api/mail/templates', 'lead'),
  r('GET', '/api/mail/schedule', 'lead'),
  r('GET', '/api/mail/log', 'lead'),
  r('POST', '/api/mail/preview', 'lead', 'none', null, 'preview a report email'),
  r('GET', '/api/export', 'lead', 'none', null, 'export the planning data'),

  /* ── project admin ──────────────────────────────────────────────────
     Three kinds, and it is worth seeing them as three.

     CREDENTIALS. /api/sources, /api/mail/config and /api/jira/fields return
     the Jira token, the GitHub token and the SMTP password's neighbourhood.
     The moment this tool is reachable from more than loopback, these are the
     routes that matter most — which is why they are admin-only BEFORE the bind
     is widened, not after.

     DESTRUCTION. reset, restore and import rewrite the store wholesale;
     reconcile retracts sprint claims. Recoverable from backup, which is not
     the same as harmless.

     SHARED STRUCTURE. The sprint calendar, holidays, category rules and
     coverage scope are one set of rows that every team reads. A lead changing
     them changes everyone's numbers, which is the definition of out of scope. */
  r('GET', '/api/sources', 'project-admin', 'none', null, 'see the configured data sources'),
  r('PUT', '/api/config', 'project-admin', 'none', null, 'change the configuration'),
  r('GET', '/api/mail/config', 'project-admin', 'none', null, 'see the mail settings'),
  r('PUT', '/api/mail/config', 'project-admin', 'none', null, 'change the mail settings'),
  r('POST', '/api/mail/test', 'project-admin', 'none', null, 'send a test email'),
  r('GET', '/api/jira/fields', 'project-admin', 'none', null, 'see the Jira field mapping'),
  r('PUT', '/api/jira/fields', 'project-admin', 'none', null, 'change the Jira field mapping'),
  r('POST', '/api/jira/fields/probe', 'project-admin', 'none', null, 'probe Jira for fields'),
  r('POST', '/api/test-connection', 'project-admin', 'none', null, 'test a connection'),
  r('GET', '/api/audit', 'project-admin', 'none', null, 'read the audit log'),
  r('GET', '/api/backup', 'project-admin', 'none', null, 'download a backup'),
  r('POST', '/api/reset', 'project-admin', 'none', null, 'reset the store'),
  r('POST', '/api/restore', 'project-admin', 'none', null, 'restore from a backup'),
  r('POST', '/api/import/issues', 'project-admin', 'none', null, 'import issues'),
  r('POST', '/api/reconcile', 'project-admin', 'none', null, 'reconcile sprints with Jira'),
  r('PUT', '/api/plan', 'project-admin', 'none', null, 'write the plan directly'),
  r('PUT', '/api/holidays', 'project-admin', 'none', null, 'change the public holidays'),
  r('PUT', '/api/category-rules', 'project-admin', 'none', null, 'change the category rules'),
  r('POST', '/api/category-rules/preview', 'project-admin', 'none', null, 'preview category rules'),
  r('PUT', '/api/coverage-teams', 'project-admin', 'none', null, 'change the coverage teams'),
  r('PUT', '/api/excluded-components', 'project-admin', 'none', null, 'change excluded components'),
  r('POST', '/api/board/unignore', 'project-admin', 'none', null, 'restore an ignored board'),
  r('POST', '/api/reports/coverage/backfill', 'project-admin', 'none', null, 'backfill coverage history'),
  /* The sprint CALENDAR is shared: `plan.sprints` is one list every team reads
     through its own `byTeam` entry. Generating sprints or moving their dates
     moves them for everybody, so neither is a team-scoped action however much
     it looks like one. */
  r('POST', '/api/sprints', 'project-admin', 'none', null, 'generate new sprints'),
  r('PUT', '/api/sprint/dates', 'project-admin', 'none', null, 'change sprint dates'),
  r('DELETE', '/api/team', 'project-admin', 'none', null, 'delete a team'),

  /* ── accounts ───────────────────────────────────────────────────────
     Self-service rows first: anybody signed in may look at themselves and
     change their own password. Everything that touches SOMEBODY ELSE is admin.
     `/api/auth/login` and `/api/auth/setup` are absent on purpose — they are
     reached before there is an actor, and the server exempts them by name
     rather than this table granting anonymous access to anything. */
  r('GET', '/api/auth/me', 'member'),
  r('POST', '/api/auth/logout', 'member'),
  r('POST', '/api/auth/password', 'member'),
  /* Personal credentials, self-service. Not admin-managed: a token an admin
     typed in on somebody's behalf defeats the point of the write being
     attributable to the person who made it. */
  r('GET', '/api/auth/jira', 'member'),
  r('PUT', '/api/auth/jira', 'member'),
  r('DELETE', '/api/auth/jira', 'member'),
  r('GET', '/api/auth/sessions', 'member'),
  r('DELETE', '/api/auth/sessions', 'member'),
  r('GET', '/api/users', 'project-admin', 'none', null, 'manage accounts'),
  r('POST', '/api/users', 'project-admin', 'none', null, 'create an account'),
  r('PUT', '/api/users', 'project-admin', 'none', null, 'change an account'),
  r('DELETE', '/api/users', 'project-admin', 'none', null, 'disable an account'),
  r('PUT', '/api/users/roles', 'project-admin', 'none', null, 'change someone\'s role'),
  r('PUT', '/api/users/password', 'project-admin', 'none', null, 'reset someone\'s password'),
  r('DELETE', '/api/users/sessions', 'project-admin', 'none', null, 'sign someone out'),
];

function r(method, path, min, scope = 'none', teams = null, why = null) {
  return { method, path, min, scope, teams, why };
}

/** Indexed once. `METHOD /path` is unique across the table by construction. */
const INDEX = new Map();
for (const rule of RULES) {
  const key = `${rule.method} ${rule.path}`;
  if (INDEX.has(key)) throw new Error(`policy.js lists ${key} twice`);
  if (rule.scope === 'team' && typeof rule.teams !== 'function') {
    throw new Error(`policy.js: ${key} is team-scoped but has no way to say which team`);
  }
  if (rule.scope !== 'team' && rule.teams) {
    throw new Error(`policy.js: ${key} has a team resolver but is not team-scoped`);
  }
  INDEX.set(key, rule);
}

const ruleFor = (method, path) => INDEX.get(`${String(method).toUpperCase()} ${path}`) || null;

/* ─────────────────────────── the decision ─────────────────────────── */

const DENY = (status, reason, code) => ({ ok: false, status, reason, code });

/**
 * May this actor make this request?
 *
 * @param method  the HTTP method
 * @param path    the pathname, no query string
 * @param actor   from `auth.sessionActor`, or null when nobody is signed in
 * @param body    the parsed request body, when there is one
 * @param query   a URLSearchParams
 * @param plan    a FUNCTION returning the plan — called only by the handful of
 *                rules that need it, so a read of the store is not the price of
 *                every authorization check
 */
function allow({ method, path, actor = null, body = null, query = null, plan = () => ({}) }) {
  const rule = ruleFor(method, path);

  /* DEFAULT DENY — and it says so plainly rather than returning the 404 the
     router would have returned anyway. A route that exists but is unclassified
     is a mistake somebody has to see; disguising it as "no such route" is how
     it survives to production. */
  if (!rule) {
    return DENY(403, `${method} ${path} has no entry in the authorization policy, so it is refused.`, 'unclassified');
  }

  if (!actor) return DENY(401, 'Sign in to use this.', 'anonymous');
  if (actor.status && actor.status !== 'active') return DENY(403, 'That account is disabled.', 'disabled');

  const have = RANK[actor.role];
  const need = RANK[rule.min];
  if (have == null) return DENY(403, 'That account has no usable role.', 'no-role');
  if (have < need) {
    return DENY(403, rule.why
      ? `You need to be ${article(rule.min)} to ${rule.why}.`
      : `You need to be ${article(rule.min)} to do that.`, 'role');
  }

  if (rule.scope !== 'team') return { ok: true, rule };

  /* A PROJECT ADMIN IS NOT SCOPED. Deliberately decided here rather than by
     giving admins every team in `leadTeams` — that would make the audit log
     say "lead of Titan" about somebody who was never a lead of anything. */
  if (actor.role === 'project-admin') return { ok: true, rule };

  const teams = rule.teams({ body, query, plan });
  if (!teams.length) {
    /* UNSPECIFIED IS NOT ALLOWED. If the request did not say which team it
       touches, nothing can confirm it is in scope — and treating that as a
       pass turns "omit the field" into the bypass. */
    return DENY(400, 'That request does not say which team it is for, so it cannot be checked against your teams.', 'no-team');
  }

  const mine = new Set(actor.leadTeams || []);
  const outside = teams.filter(t => !mine.has(t));
  if (outside.length) {
    return DENY(403,
      `You lead ${list(actor.leadTeams)}, so you cannot ${rule.why || 'do that'} for ${list(outside)}.`,
      'wrong-team');
  }
  return { ok: true, rule, teams };
}

const article = (role) => (role === 'project-admin' ? 'a project admin' : role === 'lead' ? 'a team lead' : 'signed in');
const list = (xs) => (!xs || !xs.length ? 'no teams' : xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Every route this table knows, for the test that compares it to the server. */
const classified = () => RULES.map(x => `${x.method} ${x.path}`).sort();

module.exports = { RULES, allow, ruleFor, classified, DENY };
