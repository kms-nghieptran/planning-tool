#!/usr/bin/env node
'use strict';
/**
 * server.js — local-only HTTP server for the Automation Planning Tool.
 *
 * Binds 127.0.0.1 and refuses non-local sockets. The Jira/TestOps/GitHub
 * credentials live in config.json (chmod 600, git-ignored) and never reach the
 * browser — which is also why this is a small server rather than a static page:
 * a browser cannot call Jira directly (CORS), and a token in a page is a token
 * you can accidentally share.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const store = require('./lib/store');
const sync = require('./lib/sync');
const insights = require('./lib/insights');
const capacity = require('./lib/capacity');
const classify = require('./lib/classify');
const csv = require('./lib/csv');
const { Jira } = require('./lib/jira');
const reconcile = require('./lib/reconcile');
const metrics = require('./lib/metrics');
const coverage = require('./lib/coverage');
const backlogProfile = require('./lib/backlog-profile');
const covHistory = require('./lib/coverage-history');
const priority = require('./lib/priority');
const keywords = require('./lib/keywords');
const reset = require('./lib/reset');
const provenance = require('./lib/provenance');
const query = require('./lib/query');
const search = require('./lib/search');
const fieldsLib = require('./lib/fields');
const lock = require('./lib/lock');
const integrity = require('./lib/integrity');
const rosterLib = require('./lib/roster');
const repo = require('./lib/repo');
const dbLib = require('./lib/db');

const PUBLIC = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(__dirname, 'config.json');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
};

/* ──────────────────────── staleness guard ────────────────────────
 * Node caches modules at require time, so a server left running through an
 * update keeps applying the OLD code while the files say otherwise. The tracker
 * records what this process loaded; /api/state reports any drift so the app can
 * say it out loud instead of quietly producing superseded results.
 */
const staleness = require('./lib/staleness').tracker(__dirname);

/* ───────────────────────────── config ───────────────────────────── */

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { /* first run */ }
  cfg.jira = Object.assign({ baseUrl: '', email: '', apiToken: '', projectKey: 'AUTOKAT' }, cfg.jira);
  cfg.testops = Object.assign({ baseUrl: 'https://testops.katalon.io', apiKey: '', projectIds: [] }, cfg.testops);
  cfg.github = Object.assign({ baseUrl: 'https://api.github.com', token: '', repos: [], loginMap: {} }, cfg.github);
  cfg.server = Object.assign({ port: 4322, readOnly: false }, cfg.server);
  cfg.metrics = Object.assign({ excludeComponentsFromGrid: ['Katalon', 'TrueTest'], coverageScope: 'Epic' }, cfg.metrics);
  // env wins, so you can run without writing secrets to disk at all
  if (process.env.JIRA_BASE_URL) cfg.jira.baseUrl = process.env.JIRA_BASE_URL;
  if (process.env.JIRA_EMAIL) cfg.jira.email = process.env.JIRA_EMAIL;
  if (process.env.JIRA_API_TOKEN) cfg.jira.apiToken = process.env.JIRA_API_TOKEN;
  if (process.env.JIRA_PROJECT_KEY) cfg.jira.projectKey = process.env.JIRA_PROJECT_KEY;
  if (process.env.TESTOPS_API_KEY) cfg.testops.apiKey = process.env.TESTOPS_API_KEY;
  if (process.env.GITHUB_TOKEN) cfg.github.token = process.env.GITHUB_TOKEN;
  if (process.env.PORT) cfg.server.port = Number(process.env.PORT);
  return cfg;
}

function saveConfig(patch) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { /* new file */ }
  for (const section of ['jira', 'testops', 'github', 'server', 'metrics']) {
    if (patch[section]) cfg[section] = Object.assign({}, cfg[section], patch[section]);
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) { /* windows */ }
  store.audit('config.save', { sections: Object.keys(patch) });
  return loadConfig();
}

/** Never send secrets to the browser — only whether they are present. */
function redact(cfg) {
  return {
    jira: { baseUrl: cfg.jira.baseUrl, email: cfg.jira.email, projectKey: cfg.jira.projectKey, boardId: cfg.jira.boardId || null, hasToken: Boolean(cfg.jira.apiToken), datasets: cfg.jira.datasets || null },
    testops: { baseUrl: cfg.testops.baseUrl, projectIds: cfg.testops.projectIds, hasKey: Boolean(cfg.testops.apiKey) },
    github: { repos: cfg.github.repos, loginMap: cfg.github.loginMap, hasToken: Boolean(cfg.github.token) },
    server: cfg.server,
    metrics: cfg.metrics,
  };
}

/* ───────────────────────────── helpers ───────────────────────────── */

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' });
  res.end(payload);
};

/**
 * Turn an exclusion key back into a person's name.
 *
 * Exclusions are stored by Jira accountId so they survive a display-name change,
 * which is right — but it means the stored value is an opaque
 * "712020:77426806-525c-…". Look through everyone Jira has mentioned for this
 * team (current, historic, and the project-wide people list) to find the name.
 * An unresolvable key is shown as-is rather than hidden: it still means someone.
 */
function nameForKey(key, idx, snap) {
  if (!key) return null;
  const k = String(key).toLowerCase();
  const pools = [idx.people || [], idx.peopleHistoric || [], snap.people || []];
  for (const pool of pools) {
    const hit = pool.find(p => String(p.accountId || '').toLowerCase() === k
      || String(p.name || '').toLowerCase() === k);
    if (hit && hit.name) return hit.name;
  }
  // A key that is already a name (older exclusions stored names) resolves to itself.
  return /^[0-9a-f]{8,}|:/i.test(key) ? null : key;
}

/**
 * The name a custom field answers to in a search query.
 *
 * "Test Type" becomes `test-type`, so you write `test-type = E2E` rather than
 * `customfield_16410 = E2E`. Slugged rather than raw because the tokenizer
 * splits on spaces and nobody should have to quote a field name.
 */
function slugField(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
    || 'field';
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > limit) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Read a JSON body — AND REFUSE IT IF IT TARGETS A CLOSED SPRINT.
 *
 * The check lives here, in the one function every mutating route already calls,
 * rather than as a line repeated at the top of each of them. Five copies of a
 * guard is five chances to get it right and a certainty that the sixth route
 * someone adds will not have it. Here, a new sprint-scoped route is protected
 * by the act of reading its own body.
 *
 * It fires only on a body that names BOTH a team and a sprint, because that is
 * exactly the shape of a sprint-scoped write. A route that legitimately needs
 * to write to a closed sprint can pass `{ allowClosed: true }` — nothing does
 * today, and anything that starts to should have to say so out loud.
 */
const readJsonBody = async (req, { allowClosed = false } = {}) => {
  const b = await readBody(req);
  const body = b ? JSON.parse(b) : {};
  if (!allowClosed && body && body.teamId && body.sprintId) assertSprintOpen(body.teamId, body.sprintId);
  // `entries` is the bulk form the capacity grid autosaves with; every entry
  // carries its own pair and each one is checked, so a batch cannot smuggle a
  // closed sprint in behind an open one.
  if (!allowClosed && Array.isArray(body && body.entries)) {
    for (const e of body.entries) if (e && e.teamId && e.sprintId) assertSprintOpen(e.teamId, e.sprintId);
  }
  return body;
};

/** Throw 409 unless this team's copy of the sprint is still open. */
function assertSprintOpen(teamId, sprintId) {
  const plan = store.getPlan();
  const team = (plan.teams || []).find(t => t.id === teamId);
  if (!team) return;                                   // unknown team: let the route report it
  const sprint = (plan.sprints || []).find(sp => sp.id === sprintId);
  if (!sprint) return;                                 // unknown sprint: likewise
  lock.assertWritable(sprint, team, 'it');
}

/* ───────────────────── capacity scenarios ─────────────────────
   captureScenario and applyScenario are INVERSES and must stay that way. A
   scenario that cannot be applied back to exactly what it captured is worse
   than no scenario at all, because it looks like it worked. The pair is
   deliberately written next to each other, reading the same key list, so a
   field added to one without the other is visible in the diff. */

/** The keys of the plan that belong to one team + sprint. */
const SCENARIO_KEYS = ['availability', 'support', 'overrides'];

/**
 * Freeze everything that moves the capacity number for this team and sprint.
 *
 * Member ids are stored BARE, not as "team|sprint|member" keys. A scenario is
 * about one sprint, so repeating the pair on every row would be noise — and it
 * would let a scenario silently carry rows belonging to a different sprint.
 */
function captureScenario(plan, view, team, sprint) {
  const prefix = `${team.id}|${sprint.id}|`;
  const slice = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
    }
    return out;
  };

  const data = { roster: (view.roster && view.roster.members || []).map(m => m.id) };
  for (const key of SCENARIO_KEYS) data[key] = slice(plan[key]);
  // The grid shows a DEFAULT leave row for anyone with nothing entered. That
  // default depends on the sprint's dates and the holiday list, so capturing
  // only what was explicitly typed would let a scenario drift when either
  // changes. Capture what the grid actually showed.
  for (const m of (view.rows || [])) {
    if (data.availability[m.memberId] === undefined && view.availability) {
      data.availability[m.memberId] = view.availability[m.memberId];
    }
  }
  data.ceremony = (plan.ceremony || {})[`${team.id}|${sprint.id}`] ?? null;
  data.rosterOverlay = (plan.sprintRoster || {})[`${team.id}|${sprint.id}`] || null;
  return data;
}

/**
 * Write a scenario back into the live plan.
 *
 * REPLACES this sprint's rows rather than merging into them. Merging would
 * leave a person you had removed in the scenario still sitting in the live
 * grid, so applying "the three-person plan" would quietly give you four.
 */
function applyScenario(plan, sc) {
  const prefix = `${sc.teamId}|${sc.sprintId}|`;
  const data = sc.data || {};

  for (const key of SCENARIO_KEYS) {
    plan[key] = plan[key] || {};
    for (const k of Object.keys(plan[key])) if (k.startsWith(prefix)) delete plan[key][k];
    for (const [memberId, v] of Object.entries(data[key] || {})) plan[key][prefix + memberId] = v;
  }

  plan.ceremony = plan.ceremony || {};
  const cKey = `${sc.teamId}|${sc.sprintId}`;
  if (data.ceremony == null) delete plan.ceremony[cKey];
  else plan.ceremony[cKey] = data.ceremony;

  plan.sprintRoster = plan.sprintRoster || {};
  if (data.rosterOverlay) plan.sprintRoster[cKey] = data.rosterOverlay;
  else delete plan.sprintRoster[cKey];
}

function findTeam(plan, id) {
  const team = plan.teams.find(t => t.id === id) || plan.teams[0];
  if (!team) throw new Error('No teams configured yet — add one in Settings.');
  return team;
}
function findSprint(plan, id, teamId = null) {
  const sprints = plan.sprints.slice().sort(reconcile.compareSprints);
  if (id) { const s = sprints.find(x => x.id === id); if (s) return s; }
  return insights.currentSprint(sprints, new Date(), teamId) || sprints[sprints.length - 1];
}

/* THE EPICS THE BACKLOG CHART IS ABOUT.
   The chart sits under the coverage headline on one screen, so it must count
   the same epics that headline counts: his excluded components and his team
   allow-list come out of the plan and apply here exactly as they apply there.
   Before this, they did not — the headline read 4,141 while the bars below it
   drew 4,144, and the drawer could list an epic the chart above it had
   dropped. `coverage.scoped` is now the single definition of the population,
   and the component SELECTION (the picker both sections share) narrows it
   afterwards, the way a selection should. */
function backlogEpics(snap, plan, scope, picked, byKey) {
  const want = new Set(picked);
  const { all, comps } = coverage.scoped(snap, {
    scope,
    exclude: plan.excludedComponents || [],
    teams: plan.coverageTeams || [],
  });
  return all
    .filter(i => !want.size || comps(i).some(c => want.has(c)))
    .map(i => ({ key: i.key, components: i.components || [], transitions: byKey.get(i.key) || [] }));
}

/* ───────────────────────────── routes ───────────────────────────── */

async function handleApi(req, res, url) {
  const cfg = loadConfig();
  const p = url.pathname;
  const q = url.searchParams;
  const writeBlocked = cfg.server.readOnly && req.method !== 'GET';
  if (writeBlocked) return json(res, 403, { error: 'This instance is running read-only (server.readOnly in config.json).' });

  /* ---- bootstrap ---- */
  if (p === '/api/state' && req.method === 'GET') {
    const plan = store.getPlan();
    const snap = store.getSnapshot();
    const sprints = plan.sprints.slice().sort(reconcile.compareSprints);
    const teamId = q.get('team') || (plan.teams[0] || {}).id;
    const roster = reconcile.reconcileMembers(JSON.parse(JSON.stringify(plan)), snap);
    return json(res, 200, {
      plan: { ...plan, teams: plan.teams },
      sprints,
      boards: snap.boards || [],
      ignoredBoards: plan.ignoredBoards || [],
      jiraSprints: Object.fromEntries(plan.teams.map(t => [t.id, sprints.filter(x => x.byTeam && x.byTeam[t.id]).length])),
      teamIndex: Object.fromEntries(plan.teams.map(t => {
        const i = (snap.byTeam || {})[t.id] || {};
        return [t.id, {
          members: (t.members || []).filter(m => m.status !== 'Released').length,
          sprints: (i.sprints || []).length,
          backlog: i.backlogCount || 0,
          backlogPoints: i.backlogPoints || 0,
          backlogSource: i.backlogSource || null,
          excluded: ((plan.excluded || {})[t.id] || []).length,
        }];
      })),
      discovered: roster.discovered,
      dormant: roster.dormant,
      currentSprintByTeam: Object.fromEntries(plan.teams.map(t => [t.id, (insights.currentSprint(sprints, new Date(), t.id) || {}).id || null])),
      currentSprintId: (insights.currentSprint(sprints, new Date(), teamId) || sprints[sprints.length - 1] || {}).id || null,
      sync: sync.summary(snap, cfg),
      server: staleness.check(),
      testops: { syncedAt: (snap.testops || {}).syncedAt || null, projects: ((snap.testops || {}).projects || []).map(x => ({ id: x.id, name: x.name, summary: x.summary, error: x.error })) },
      github: { syncedAt: (snap.github || {}).syncedAt || null, repos: (snap.github || {}).repos || [], prs: ((snap.github || {}).prs || []).length },
      config: redact(cfg),
      // The one place the UI learns where Jira lives. Normalised here (trailing
      // slashes stripped) so every issue link in the app is built the same way
      // from the same string, rather than each screen re-deriving it.
      jiraBase: (cfg.jira.baseUrl || '').replace(/\/+$/, ''),
      categories: classify.CATEGORIES,
      defaultRules: classify.DEFAULT_RULES,
      // The vocabulary the rule editor may offer, sent from the matcher's own
      // tables rather than re-listed in the browser: a dropdown holding a field
      // the matcher does not know is a rule you can save that never matches,
      // and nothing on screen looks broken when that happens.
      fields: classify.FIELDS.map(f => ({ key: f.key, label: f.label, note: f.note, list: !!f.list })),
      ops: classify.OPS,
      ruleHits: classify.ruleHits(Object.values(snap.issues || {}), plan.categoryRules),
      capacityDefaults: capacity.DEFAULTS,
      today: new Date().toISOString().slice(0, 10),
    });
  }

  /* ---- views ---- */
  if (p === '/api/capacity' && req.method === 'GET') {
    const plan = store.getPlan(), snap = store.getSnapshot();
    const team = findTeam(plan, q.get('team'));
    const sprint = findSprint(plan, q.get('sprint'), team.id);
    return json(res, 200, insights.capacityView(plan, snap, team, sprint));
  }

  if (p === '/api/backlog' && req.method === 'GET') {
    const plan = store.getPlan(), snap = store.getSnapshot();
    return json(res, 200, insights.backlogView(plan, snap, { teamId: q.get('team') || null }));
  }

  if (p === '/api/sprint' && req.method === 'GET') {
    const plan = store.getPlan(), snap = store.getSnapshot();
    const team = findTeam(plan, q.get('team'));
    const sprint = findSprint(plan, q.get('sprint'), team.id);
    const view = insights.activeSprintView(plan, snap, team, sprint);
    /* THE RISKS FOR THIS SPRINT, off the view that was just built rather than
       from a second call to `riskView` — which would have recomputed the same
       view and given the screen two independent answers to blend. The register
       travels with them because a risk the tool cannot see is still a risk to
       this sprint; the OPEN ones only, since a closed entry is history and
       belongs on the Risks page with the rest of the register. */
    return json(res, 200, {
      ...view,
      risks: {
        signals: insights.signalsFor(team, sprint, view, snap),
        manual: (plan.risks || []).filter(r => String(r.status || '').toLowerCase() !== 'closed'),
      },
    });
  }

  if (p === '/api/forecast' && req.method === 'GET') {
    const plan = store.getPlan(), snap = store.getSnapshot();
    const team = findTeam(plan, q.get('team'));
    const scenario = q.get('scenario') ? JSON.parse(q.get('scenario')) : {};
    return json(res, 200, insights.forecastView(plan, snap, team, {
      fromSprintId: q.get('from') || (insights.currentSprint(plan.sprints.slice().sort(reconcile.compareSprints)) || {}).id || null,
      horizon: Number(q.get('horizon')) || 4,
      scenario,
    }));
  }

  if (p === '/api/sprints' && req.method === 'GET') {
    // The sprint list, grouped the way the sidebar presents it.
    const plan = store.getPlan(), snap = store.getSnapshot();
    const team = findTeam(plan, q.get('team'));
    const idx = (snap.byTeam || {})[team.id] || {};
    // By calendar id, not by number: every date-named sprint has `number: null`,
    // so a number-keyed Map collapses them all onto one row and each TT Week
    // reported the LAST sprint's item count instead of its own.
    const byId = new Map((idx.sprints || []).map(s2 => [s2.sprintId, s2]));
    const rows = plan.sprints
      .filter(s2 => s2.byTeam && s2.byTeam[team.id])
      .map(s2 => {
        const t = s2.byTeam[team.id];
        const stat = byId.get(s2.id) || {};
        return {
          id: s2.id, number: s2.number, name: t.name || s2.name, calendarName: s2.name,
          state: t.state || 'unknown', start: t.start || s2.start, end: t.end || s2.end,
          // What Jira actually said, where the derived last-working-day differs
          // from it. Carried from whichever of the two rows the dates came from,
          // so the hover on the screen explains the date the screen is showing.
          jiraEnd: (t.end ? t.jiraEnd : s2.jiraEnd) || undefined,
          jiraId: t.jiraId,
          count: stat.count || 0, points: stat.points || 0, donePoints: stat.donePoints || 0,
        };
      })
      .sort((a, b) => reconcile.compareSprints(b, a));
    /* SPRINTS YOU CREATED HERE — not "every sprint this team's board lacks".
       `source` is absent only on a sprint authored in this tool; the sync sets
       it to 'jira' on everything it brought in. Without that test, a sprint
       from ANOTHER team's board counts as this team's local one, and the
       screen says so: it told Malphite that 44 sprints "exist in the local
       calendar but not on this team's Jira board" when all 44 came from Jira,
       on the Titan and Ruby boards, on a cadence Malphite does not run.

       It hit Malphite hardest precisely because it is the team least like the
       others — a TrueTest board on weekly and fortnightly "TT Week" sprints,
       so almost the whole numbered calendar looked foreign to it and got
       listed. Titan and Ruby own most of that calendar, so they showed 12 and
       13 strays and it read as a quirk rather than a bug. */
    const local = plan.sprints.filter(s2 => s2.source == null && !(s2.byTeam && s2.byTeam[team.id]))
      .map(s2 => ({ id: s2.id, number: s2.number, name: s2.name, state: 'local', start: s2.start, end: s2.end, count: 0, points: 0, donePoints: 0 }))
      .sort((a, b) => reconcile.compareSprints(b, a));
    return json(res, 200, {
      teamId: team.id, teamName: team.jiraName || team.name,
      active: rows.filter(x => x.state === 'active'),
      future: rows.filter(x => x.state === 'future'),
      closed: rows.filter(x => x.state === 'closed'),
      unknown: rows.filter(x => !['active', 'future', 'closed'].includes(x.state)),
      local,
    });
  }

  if (p === '/api/reports/delivery' && req.method === 'GET') {
    const plan = store.getPlan(), snap = store.getSnapshot();
    const team = findTeam(plan, q.get('team'));
    const window = Number(q.get('sprints')) || 12;
    // Which sprints that window actually resolved to — the active one plus the
    // most recent closed ones. Named here so the screen can say it out loud
    // rather than leaving the reader to assume "the last N by date".
    const picked = metrics.windowSprints(plan, team, window);
    const named = picked.ids.map(id => {
      const sp = plan.sprints.find(x => x.id === id) || {};
      const t = (sp.byTeam || {})[team.id] || {};
      return { id, name: t.name || sp.name || id, state: t.state || null, active: id === picked.active };
    });
    return json(res, 200, {
      teamId: team.id, teamName: team.jiraName || team.name, window,
      windowSprints: named,
      activeSprint: named.find(x => x.active) || null,
      velocity: metrics.velocity(plan, snap, team, { sprints: window }),
      productivity: metrics.productivity(plan, snap, team, { sprints: window }),
      quality: metrics.quality(plan, snap, team, { sprints: window }),
      settings: capacity.teamSettings(team),
    });
  }

  if (p === '/api/reports/automation' && req.method === 'GET') {
    const plan = store.getPlan(), snap = store.getSnapshot();
    const m = (cfg.metrics || {});
    return json(res, 200, {
      ...metrics.coverage(plan, snap, {
        excludeFromGrid: m.excludeComponentsFromGrid || ['Katalon', 'TrueTest'],
        scope: m.coverageScope || 'Epic',
      }),
      project: cfg.jira.projectKey || null,
    });
  }

  if (p === '/api/reports/coverage' && req.method === 'GET') {
    // Same source field and the same ratio as /api/reports/automation — this
    // one adds the component filter, the Obsoleted bucket and the tool split.
    const snap = store.getSnapshot();
    const m = (cfg.metrics || {});
    const plan = store.getPlan();
    const view = coverage.view(snap, {
      // getAll, so `?component=A&component=B` is a selection rather than a
      // last-one-wins. A comma-joined parameter would have been shorter and
      // wrong: component names are free text and may contain one.
      components: q.getAll('component').filter(Boolean),
      scope: m.coverageScope || 'Epic',
      // His decision, out of the plan — so a sync never puts them back.
      exclude: plan.excludedComponents || [],
      teams: plan.coverageTeams || [],
    });
    return json(res, 200, {
      ...view,
      // His judgement, attached to the rows the screen already renders. Read
      // from the plan, so a sync never touches it.
      byComponent: priority.decorate(view.byComponent, plan),
      // The tool split lists the SAME components as the grid above it, so it
      // gets the same judgement. Decorated here rather than looked up in the
      // browser from the other table: one row shape carrying its own priority
      // is what stops two tables on one screen disagreeing about a component.
      byTool: priority.decorate(view.byTool, plan),
      components: priority.decorate(view.components.map(c => ({ ...c, component: c.name })), plan)
        .map(({ component, ...c }) => c),
      priorityLevels: priority.LEVELS,
      // Fired against the assembled view, not against the issues again, so the
      // findings can never disagree with the tables they sit above. `view` is
      // already narrowed to the selected component, so this is too.
      attention: coverage.assess(view, { thresholds: m.coverageThresholds || null }),
      // So a component can link to the SAME set in Jira that the row counts:
      // same project, same issue type. The key lives in config, not the model.
      project: cfg.jira.projectKey || null,
    });
  }

  /* THE EPICS BEHIND ONE NUMBER on the coverage screen.
     Its own route rather than keys on every cell of the payload: that grid is
     97 components wide by nine buckets and is re-fetched on every keystroke of
     the picker, so shipping the key list for every cell would make the common
     case pay for the rare one — the same reason the backlog drill-in is
     separate. `epicsIn` runs the classification `view` ran, so the list cannot
     be a different set from the number that opened it. */
  if (p === '/api/reports/coverage/epics' && req.method === 'GET') {
    const snap = store.getSnapshot();
    const m = (cfg.metrics || {});
    const plan = store.getPlan();
    /* SEVERAL BUCKETS, OR'D — because one number on the screen is the sum of
       two of them: "Still to automate" is Ready plus Blocked, and a drill-in
       that could only answer for one column would have to leave that KPI
       unclickable or lie about half of it. */
    const buckets = q.getAll('bucket').filter(Boolean);
    const tool = q.get('tool') || null;

    // Refused rather than ignored: an unknown column silently listing
    // everything is a drawer that says 4,146 under a number saying 12.
    const bad = buckets.find(b => !coverage.BUCKETS.some(x => x.key === b));
    if (bad) return json(res, 400, { error: `Unknown column "${bad}".` });
    if (tool && !coverage.TOOLS.some(t => t.key === tool)) {
      return json(res, 400, { error: `Unknown tool "${tool}".` });
    }

    const opts = {
      components: q.getAll('component').filter(Boolean),
      scope: m.coverageScope || 'Epic',
      exclude: plan.excludedComponents || [],
      teams: plan.coverageTeams || [],
    };
    const epics = coverage.epicsIn(snap, opts, { component: q.get('row') || null, buckets, tool });

    const names = buckets.map(b => (coverage.BUCKETS.find(x => x.key === b) || {}).label).filter(Boolean);
    const toolLabel = coverage.TOOLS.find(t => t.key === tool);
    return json(res, 200, {
      scope: opts.scope,
      row: q.get('row') || null,
      buckets, tool,
      label: [toolLabel && toolLabel.label, names.join(' + ')].filter(Boolean).join(' · ')
        || `All ${opts.scope.toLowerCase()}s`,
      count: epics.length,
      project: cfg.jira.projectKey || null,
      epics: epics.map(i => ({
        key: i.key, summary: i.summary || '', status: i.status || '',
        statusCategory: i.statusCategory || '', automationStatus: i.automationStatus || '',
        team: i.team || '', bucket: i.bucket, tool: i.tool,
        components: coverage.productComponents(i, coverage.excludeSet(opts.exclude)),
        /* WHAT IS ACTUALLY BLOCKING IT — the Jira "is blocked by" links, which
           are NOT the same thing as the Blocked bucket. The bucket comes from
           the Automation Status FIELD; this comes from a link somebody made.
           On his data 166 epics are marked Blocked and only 26 of them say by
           what, so the gap between the two is the point rather than a detail:
           it is the difference between "blocked" and "blocked by something we
           can go and chase". */
        blockedBy: i.blockedBy || [],
      })),
    });
  }

  /* COMPONENTS THAT ARE NOT AUTOMATION SUITES.
     Plan data, like the priorities below it: a decision, never touched by a
     sync. Parsed through the same keyword rules, which matters for the same
     reason — an empty entry here would exclude a component named '' and, worse,
     read as a configured exclusion that does nothing. */
  /* THE VALUES THAT ARE ACTUALLY IN THE DATA, for the two scope settings.
     Its own small route rather than making the settings page load the whole
     coverage report. It exists so nobody has to type a Jira team name from
     memory — which is precisely how a setting meant to drop 835 epics ends up
     dropping 2,993. Counts included, because "Katalon Automation — 0" is the
     fastest way to see that a name is not the one the data uses. */
  if (p === '/api/coverage/scope' && req.method === 'GET') {
    const snap = store.getSnapshot();
    const m = (cfg.metrics || {});
    const plan = store.getPlan();
    // Unfiltered on purpose — this is the menu, not the meal. It has to show
    // the values a current setting is EXCLUDING, or they can never be undone.
    const v = coverage.view(snap, { scope: m.coverageScope || 'Epic' });
    return json(res, 200, {
      scope: m.coverageScope || 'Epic',
      components: v.components.map(c => ({ name: c.name, count: c.count })),
      teamValues: v.teamValues,
      excludedComponents: plan.excludedComponents || [],
      coverageTeams: plan.coverageTeams || [],
    });
  }

  /* WHOSE WORK COUNTS — an allow-list of Jira Team field values.
     Same shape and same parser as the component exclusions beside it. */
  if (p === '/api/coverage-teams' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    const { list, errors } = keywords.validate(body.teams);
    plan.coverageTeams = list;
    store.savePlan(plan);
    store.audit('coverageTeams.set', { teams: list });
    return json(res, 200, { ok: true, coverageTeams: list, notes: errors });
  }

  if (p === '/api/excluded-components' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    const { list, errors } = keywords.validate(body.components);
    plan.excludedComponents = list;
    store.savePlan(plan);
    store.audit('excludedComponents.set', { components: list });
    return json(res, 200, { ok: true, excludedComponents: list, notes: errors });
  }

  /* One component's priority. Its own route rather than PUT /api/plan, which
     merges whatever it is handed: a level this tool cannot read is not an error
     anywhere — the component simply has no priority, and the only place that
     shows is a column that looks perfectly fine. */
  if (p === '/api/component-priority' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    const current = plan.componentPriority || {};

    // Two shapes: one row edited, or a whole map replaced (used by a reset).
    const next = body.component !== undefined
      ? priority.set(current, body.component, body.level ?? null)
      : (body.map || {});

    const { map, errors } = priority.validate(next);
    if (errors.length) return json(res, 400, { error: errors.map(e => e.message).join(' · '), errors });

    plan.componentPriority = map;
    store.savePlan(plan);
    store.audit('componentPriority.set', {
      component: body.component ?? null, level: body.level ?? null, total: Object.keys(map).length,
    });
    return json(res, 200, { ok: true, componentPriority: map, set: Object.keys(map).length });
  }

  /* How coverage MOVED. Its own route rather than more payload on
     /api/reports/coverage: that one is read on every keystroke of the component
     picker, and the movement query walks a table with a row per component per
     day. Separate means the picker stays instant and this can be windowed. */
  /* THE BACKLOG PROFILE — how much work was outstanding, period by period.
     Component filter is shared with the Coverage report above it, so selecting
     a component narrows both and the two sections keep answering the same
     question about the same slice. */
  if (p === '/api/reports/backlog' && req.method === 'GET') {
    const snap = store.getSnapshot();
    const scope = (cfg.metrics || {}).coverageScope || 'Epic';
    const picked = q.getAll('component').filter(Boolean);

    /* The events come from the changelog table; the tool and the component
       come from the epic AS IT STANDS NOW. That is deliberate — re-tagging an
       epic in Jira should correct every past bar, not leave history stamped
       with a label that has since changed. */
    const byKey = covHistory.transitionsByKey();
    const epics = backlogEpics(snap, store.getPlan(), scope, picked, byKey);

    return json(res, 200, {
      ...backlogProfile.profile(epics, {
        grain: q.get('grain') || 'month',
        periods: q.get('periods'),
      }),
      scope,
      components: picked,
      grains: backlogProfile.GRAINS,
      // "All" is a window rather than a bar width, so it travels in its own
      // list — a screen that built its chips from `grains` would never offer it.
      windows: backlogProfile.WINDOWS,
      // Nothing to count until the changelog has been read once. The screen
      // needs to tell the difference between "a quiet year" and "never asked".
      backfilled: byKey.size > 0,
    });
  }

  /* THE EPICS BEHIND ONE BAR SEGMENT.
     Its own route rather than keys on every period of the chart payload: the
     chart is redrawn on every component keystroke and every window change, and
     shipping the key list for four buckets across up to 104 periods would make
     the common case pay for the rare one. */
  if (p === '/api/reports/backlog/epics' && req.method === 'GET') {
    const snap = store.getSnapshot();
    const scope = (cfg.metrics || {}).coverageScope || 'Epic';
    const picked = q.getAll('component').filter(Boolean);
    const byKey = covHistory.transitionsByKey();

    // Built by the same function /api/reports/backlog calls, rather than by the
    // same code written twice — so the set being counted and the set being
    // listed cannot drift apart one edit at a time.
    const epics = backlogEpics(snap, store.getPlan(), scope, picked, byKey);
    const issues = snap.issues || {};

    /* The SAME profile call the chart made. The period boundaries therefore
       come from the chart's own arithmetic rather than being recomputed here,
       which is what guarantees the drawer cannot show a different window than
       the bar that opened it — particularly for "all", whose grain depends on
       the data and could otherwise be resolved two different ways. */
    const prof = backlogProfile.profile(epics, {
      grain: q.get('grain') || 'month',
      periods: q.get('periods'),
    });
    const period = prof.periods.find(x => x.start === q.get('period'));
    if (!period) {
      return json(res, 409, { error: 'That bar is not in the current window any more — the chart has moved on. Reopen it.' });
    }

    // Compared as calendar DATES, not reconstructed timestamps: the periods are
    // whole days, so this is exactly the window the profile counted, without a
    // millisecond of boundary arithmetic to get wrong.
    const bucket = q.get('bucket') || '';
    const buckets = new Set(backlogProfile.BUCKETS.map(b => b.key));
    if (bucket && !buckets.has(bucket)) return json(res, 400, { error: `Unknown column "${bucket}".` });
    const day = (t) => new Date(t).toISOString().slice(0, 10);
    const keys = backlogProfile.eventsOf(epics)
      .filter(e => (!bucket || e.bucket === bucket))
      .filter(e => day(e.t) >= period.start && day(e.t) <= period.end)
      .map(e => e.key);

    const catalogue = {};
    for (const k of new Set(keys)) {
      const i = issues[k];
      catalogue[String(k).toUpperCase()] = i
        ? { key: k, summary: i.summary || '', status: i.status || '', statusCategory: i.statusCategory || '',
            automationStatus: i.automationStatus || '', components: coverage.productComponents(i) }
        : { key: k, absent: true };
    }

    return json(res, 200, {
      keys, catalogue, scope, components: picked,
      period: { label: period.label, start: period.start, end: period.end, partial: period.partial },
      bucket,
      label: bucket ? (backlogProfile.BUCKETS.find(b => b.key === bucket) || {}).label : 'All columns',
      grain: prof.grain,
      window: prof.window,
      // What the bar SAYS, so the screen can flag a disagreement rather than
      // quietly showing a list of a different length.
      shown: bucket ? (period.counts || {})[bucket] || 0 : period.total,
    });
  }

  if (p === '/api/reports/coverage/movement' && req.method === 'GET') {
    const plan = store.getPlan();
    const m = (cfg.metrics || {});
    const scope = m.coverageScope || 'Epic';
    const days = Math.min(730, Math.max(7, Number(q.get('days')) || 180));
    const since = new Date(Date.now() - days * 86400000);
    // Movement is recorded per component, so a combination has no series of its
    // own — and summing two would double-count every epic they share. With more
    // than one selected the caller gets the movers for those components and no
    // headline trend, which is the honest shape rather than a plausible sum.
    const picked = q.getAll('component').filter(Boolean);
    const component = picked.length === 1 ? picked[0] : null;
    // The same exclusions the component table above this section obeys, out of
    // the plan — so a component he took off that table cannot reappear here as
    // the biggest mover on the page.
    const moved = covHistory.movement(component, { scope, since, exclude: plan.excludedComponents || [] });
    return json(res, 200, {
      ...moved,
      // The movers carry the priority he set on each component, from the same
      // plan the component table reads. Without it the two tables on one page
      // would answer "how important is this" differently — one with a level,
      // one with nothing — and the mover list is exactly where the question
      // gets asked, because it is the list of what to do something about.
      movers: priority.decorate(moved.movers || [], plan),
      priorityLevels: priority.LEVELS,
      selected: picked,
      multi: picked.length > 1,
      days,
      // What the history is MADE of, so the screen can say whether a curve is
      // observed or inferred instead of presenting both as the same fact.
      sources: dbLib.all(
        'SELECT source, COUNT(DISTINCT at) AS days FROM coverage_reading WHERE scope = ? GROUP BY source', scope,
      ),
      first: dbLib.get('SELECT MIN(at) AS at FROM coverage_reading WHERE scope = ?', scope),
    });
  }

  /* Backfill the past from Jira's own transition history. Explicitly invoked:
     it is a heavy read and an inference, and neither belongs on a schedule the
     user did not ask for. */
  /* WHICH EPICS PRODUCED ONE DRIVER TAG — "Automated +5" opened up.
     The tags on the movers table are net deltas of counts; this answers "which
     ones" from the transition history, with arrivals and departures kept apart
     so the drawer never shows a list of seven under a heading saying five. */
  if (p === '/api/reports/coverage/moved' && req.method === 'GET') {
    const snap = store.getSnapshot();
    const m = (cfg.metrics || {});
    const scope = m.coverageScope || 'Epic';
    const days = Math.min(730, Math.max(7, Number(q.get('days')) || 180));
    const since = new Date(Date.now() - days * 86400000);
    const bucket = q.get('bucket') || '';
    const component = q.get('component') || null;

    const issues = snap.issues || {};
    const moved = covHistory.movedEpics({
      bucket, component, since, lookup: (k) => issues[k] || null,
    });

    // Each key resolved to something displayable, once, so the screen renders a
    // list rather than re-reading the snapshot per row.
    const seen = new Map();
    for (const e of [...moved.arrived, ...moved.left]) {
      if (seen.has(e.key)) continue;
      const i = issues[e.key];
      seen.set(e.key, i
        ? { key: e.key, summary: i.summary || '', status: i.status || '', statusCategory: i.statusCategory || '',
            automationStatus: i.automationStatus || '', components: coverage.productComponents(i) }
        : { key: e.key, absent: true });
    }

    return json(res, 200, {
      ...moved,
      bucket, component, days, scope,
      catalogue: Object.fromEntries(seen),
      label: (coverage.BUCKETS.find(b => b.key === bucket) || {}).label || bucket,
      backfilled: covHistory.transitionsByKey().size > 0,
    });
  }

  if (p === '/api/reports/coverage/backfill' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const m = (cfg.metrics || {});
    const scope = m.coverageScope || 'Epic';
    const jira = new Jira(cfg.jira);
    await jira.discoverFields().catch(() => {});
    const project = cfg.jira.projectKey;
    if (!project) return json(res, 400, { error: 'Set the Jira project key first — the backfill needs to know what to read.' });

    const epics = await jira.searchWithHistory(`project = ${project} AND issuetype = "${scope}" ORDER BY created ASC`);
    const weeks = Math.min(104, Math.max(2, Number(body.weeks) || 26));
    const dates = covHistory.weeklyDates(new Date(Date.now() - weeks * 7 * 86400000), new Date());
    const readings = covHistory.reconstruct(epics, dates, { scope });

    let written = 0, kept = 0;
    for (const r of readings) {
      const out = covHistory.record(r.rows, { at: r.at, scope, source: 'changelog' });
      written += out.written; kept += out.kept;
    }
    // The same fetch feeds two things: daily readings (above) and the raw
    // events (here). Splitting them into two backfills would mean two passes
    // over the whole changelog for one user action.
    const saved = covHistory.saveTransitions(epics);
    store.invalidate();

    const truncated = epics.filter(e => e.truncated).length;
    const withHistory = epics.filter(e => e.transitions.length).length;
    store.audit('coverage.history.backfill', { epics: epics.length, dates: dates.length, written, kept, truncated, transitions: saved.written });
    return json(res, 200, {
      ok: true, epics: epics.length, withHistory, truncated,
      dates: dates.length, written, keptObservations: kept,
    });
  }

  if (p === '/api/backlog/health' && req.method === 'GET') {
    const plan = store.getPlan(), snap = store.getSnapshot();
    const team = findTeam(plan, q.get('team'));
    return json(res, 200, { teamId: team.id, teamName: team.jiraName || team.name, ...metrics.backlogHealth(plan, snap, team) });
  }

  if (p === '/api/risks' && req.method === 'GET') {
    const plan = store.getPlan(), snap = store.getSnapshot();
    return json(res, 200, insights.riskView(plan, snap, { teamId: q.get('team') || null, sprintId: q.get('sprint') || null }));
  }

  /* ---- plan edits ---- */
  if (p === '/api/plan' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    const next = { ...plan, ...body, version: plan.version };
    store.savePlan(next);
    store.audit('plan.replace', { keys: Object.keys(body) });
    return json(res, 200, { ok: true });
  }

  /* Work-categorisation rules get their own route rather than riding on
     PUT /api/plan, which merges whatever it is handed. A malformed rule does
     not throw anywhere — it simply never matches, the work falls through to
     Other, and the work-mix split on Backlog, Forecast, Sprint and Search all
     move together with nothing on screen looking wrong. Validating at the door
     is the only place that failure is visible. */
  if (p === '/api/category-rules' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    const issues = () => Object.values(store.getSnapshot().issues || {});
    if (body.rules === null) {                       // back to the shipped defaults
      plan.categoryRules = null;
      store.savePlan(plan);
      store.audit('categoryRules.reset', { count: classify.DEFAULT_RULES.length });
      return json(res, 200, { ok: true, reset: true, rules: classify.DEFAULT_RULES, hits: classify.ruleHits(issues(), null) });
    }
    const { rules, errors } = classify.validateRules(body.rules);
    if (errors.length) return json(res, 400, { error: errors.map(e => e.message).join(' · '), errors });
    // An empty list is valid JSON and catastrophic semantics: every issue in
    // the tool would classify as Other.
    if (!rules.length) return json(res, 400, { error: 'Keep at least one rule — an empty list files every issue under Other', errors: [] });
    plan.categoryRules = rules;
    store.savePlan(plan);
    store.audit('categoryRules.save', { count: rules.length });
    return json(res, 200, { ok: true, rules, hits: classify.ruleHits(issues(), rules) });
  }

  /* What these rules WOULD do, without saving them. First match wins, so a new
     rule in position 1 can quietly swallow the work three other rules used to
     claim; this is how you see that before it is the live split. */
  if (p === '/api/category-rules/preview' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const { rules, errors } = classify.validateRules(body.rules);
    const issues = Object.values(store.getSnapshot().issues || {});
    return json(res, 200, {
      errors,
      hits: errors.length ? null : classify.ruleHits(issues, rules),
      mix: errors.length ? null : classify.mix(issues, rules),
    });
  }

  if (p === '/api/availability' && req.method === 'PUT') {
    // { teamId, sprintId, memberId, row:[14] }  or  { entries: [ {...}, ... ] }
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    plan.availability = plan.availability || {};
    const entries = body.entries || [body];
    for (const e of entries) plan.availability[`${e.teamId}|${e.sprintId}|${e.memberId}`] = e.row;
    store.savePlan(plan);
    store.audit('availability.set', { count: entries.length, sprintId: entries[0] && entries[0].sprintId });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/support' && req.method === 'PUT') {
    const body = await readJsonBody(req);   // { teamId, sprintId, memberId, pct }
    const plan = store.getPlan();
    plan.support = plan.support || {};
    plan.support[`${body.teamId}|${body.sprintId}|${body.memberId}`] = Number(body.pct) || 0;
    store.savePlan(plan);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/ceremony' && req.method === 'PUT') {
    const body = await readJsonBody(req);   // { teamId, sprintId, hours }
    const plan = store.getPlan();
    plan.ceremony = plan.ceremony || {};
    plan.ceremony[`${body.teamId}|${body.sprintId}`] = Number(body.hours) || 0;
    store.savePlan(plan);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/override' && req.method === 'PUT') {
    const body = await readJsonBody(req);   // { teamId, sprintId, memberId, planned, actual }
    const plan = store.getPlan();
    plan.overrides = plan.overrides || {};
    const key = `${body.teamId}|${body.sprintId}|${body.memberId}`;
    if (body.planned == null && body.actual == null) delete plan.overrides[key];
    else plan.overrides[key] = { planned: body.planned, actual: body.actual };
    store.savePlan(plan);
    store.audit('override.set', { key, planned: body.planned, actual: body.actual });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/note' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    plan.notes = plan.notes || {};
    plan.notes[`${body.teamId}|${body.sprintId}`] = body.text || '';
    store.savePlan(plan);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/risk' && (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE')) {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    plan.risks = plan.risks || [];
    if (req.method === 'DELETE') plan.risks = plan.risks.filter(r => r.id !== body.id);
    else if (req.method === 'PUT') plan.risks = plan.risks.map(r => (r.id === body.id ? { ...r, ...body, updatedAt: new Date().toISOString() } : r));
    else plan.risks.push({ ...body, id: `r${Date.now().toString(36)}`, createdAt: new Date().toISOString() });
    store.savePlan(plan);
    store.audit(`risk.${req.method.toLowerCase()}`, { id: body.id || body.title });
    return json(res, 200, { ok: true, risks: plan.risks });
  }

  if (p === '/api/team' && req.method === 'GET') {
    // ONE call returns everything a team needs: members, its sprints, its backlog.
    // Served straight off the per-team index the sync built, so it is a lookup.
    const plan = store.getPlan(), snap = store.getSnapshot();
    const team = findTeam(plan, q.get('id') || q.get('team'));
    const idx = (snap.byTeam || {})[team.id] || {};
    const sprints = plan.sprints.filter(x => x.byTeam && x.byTeam[team.id])
      .map(x => reconcile.forTeam(x, team.id))
      .sort(reconcile.compareSprints);
    const hydrate = (k) => (snap.issues || {})[k];
    const roster = reconcile.reconcileMembers(JSON.parse(JSON.stringify(plan)), snap, { autoAdd: false });

    return json(res, 200, {
      team: {
        id: team.id, name: team.jiraName || team.name, localName: team.name,
        jiraName: team.jiraName || null, boardName: team.boardName || null,
        boardId: team.boardId || null,
        jiraTeams: team.jiraTeams || [], sprintKeywords: team.sprintKeywords || [],
        settings: team.settings, source: team.source || 'manual',
      },
      members: (team.members || []).map(m => ({
        ...m,
        jiraActivity: (idx.people || []).find(pp => (m.jiraAccountId && pp.accountId === m.jiraAccountId)
          || pp.name.toLowerCase() === String(m.name).toLowerCase()) || null,
      })),
      // Look the calendar entry up by ID, never by number. A date-named sprint
      // has `number: null`, so matching on number made `null === null` true for
      // every one of them: all eleven of Malphite's sprints collapsed onto one
      // id, and the active sprint could never be found again by id.
      sprints: (idx.sprints || []).map(sp => {
        const cal = sprints.find(x => x.id === sp.sprintId) || {};
        return { ...sp, id: cal.id || sp.sprintId, calendarName: cal.number != null ? cal.name : null };
      }),
      activeSprintId: (insights.currentSprint(plan.sprints, new Date(), team.id) || {}).id || null,
      backlog: {
        source: idx.backlogSource || 'heuristic',
        count: idx.backlogCount || 0,
        points: idx.backlogPoints || 0,
        items: (idx.backlog || []).map(hydrate).filter(Boolean),
      },
      // An exclusion is stored by accountId, because that survives a rename.
      // Showing the raw "712020:77426806-525c-…" is useless: nobody can tell who
      // they would be putting back. Resolve it to a name wherever Jira knows one.
      excluded: ((plan.excluded || {})[team.id] || []).map(key => ({
        key,
        name: nameForKey(key, idx, snap) || key,
        resolved: !!nameForKey(key, idx, snap),
      })),
      dormant: roster.dormant[team.id] || [],
      // People from before the roster window, and the window itself — so the
      // Team tab can explain why a 44-sprint board yields a 3-person roster.
      peopleHistoric: idx.peopleHistoric || [],
      rosterWindow: idx.rosterWindow || null,
      syncedAt: snap.syncedAt || null,
      builtAt: idx.builtAt || null,
    });
  }

  if (p === '/api/team' && req.method === 'PUT') {
    // { teamId, boardId?, name?, sprintKeywords?, components?, jiraTeams?, testopsProjectIds? }
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    const team = plan.teams.find(t => t.id === body.teamId);
    if (!team) return json(res, 404, { error: `No team "${body.teamId}"` });
    /* THE KEYWORD LISTS ARE PARSED, NOT COPIED. They used to be assigned
       straight through, which meant one stray comma in the box stored an empty
       keyword — and an empty keyword makes `name.includes(k)` true for every
       sprint in the instance. The field still reads "ruby", and the team
       quietly claims the whole Jira estate. Parsing here rather than in the
       browser because the browser is not the contract. */
    const notes = [];
    for (const k of ['sprintKeywords', 'jiraTeams']) {
      if (body[k] === undefined) continue;
      const { list, errors } = keywords.validate(body[k]);
      team[k] = list;
      notes.push(...errors);
    }
    for (const k of ['boardId', 'name', 'components', 'testopsProjectIds']) {
      if (body[k] !== undefined) team[k] = body[k];
    }
    store.savePlan(plan);
    store.audit('team.update', { teamId: team.id, keys: Object.keys(body).filter(k => k !== 'teamId') });
    return json(res, 200, { ok: true, team, notes });
  }

  if (p === '/api/team/member' && (req.method === 'POST' || req.method === 'PUT')) {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    if (req.method === 'POST') {
      // Adding someone brings default availability with them, so this is always
      // a deliberate act — never something a sync does on its own.
      try {
        /* Someone picked off the discovered list carries their accountId. A
           name TYPED into the box does not — but the tool may already know it,
           so the Jira directory goes in and an exact match is linked on the
           spot. Without it, typing the name of someone Jira knows perfectly
           well stored an unlinked row that no sync could later repair unless
           they happened to have work in this team's own sprints. */
        const directory = store.getSnapshot().people || [];
        const added = reconcile.addMember(plan,
          body.teamId, { name: body.name, accountId: body.accountId, role: body.role }, { directory });
        store.savePlan(plan);
        const member = (plan.teams.find(t => t.id === body.teamId).members || []).find(m => m.id === added);
        store.audit('member.add', {
          teamId: body.teamId, name: body.name,
          from: member && member.jiraAccountId ? (body.accountId ? 'jira' : 'jira-by-name') : 'manual',
        });
        return json(res, 200, { ok: true, memberId: added, member });
      } catch (err) { return json(res, 400, { error: err.message }); }
    }
    const team = plan.teams.find(t => t.id === body.teamId);
    const member = team && (team.members || []).find(m => m.id === body.memberId);
    if (!member) return json(res, 404, { error: 'Member not found' });
    for (const k of ['name', 'role', 'status', 'supportPct', 'jiraAccountId', 'jiraNames']) {
      if (body[k] !== undefined) member[k] = body[k];
    }
    store.savePlan(plan);
    store.audit('member.update', { teamId: body.teamId, memberId: body.memberId });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/team/member' && req.method === 'DELETE') {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    try {
      const name = reconcile.excludeMember(plan, body.teamId, body.memberId);
      store.savePlan(plan);
      store.audit('member.exclude', { teamId: body.teamId, name });
      return json(res, 200, { ok: true, name });
    } catch (err) { return json(res, 400, { error: err.message }); }
  }

  if (p === '/api/team/unexclude' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    reconcile.unexcludeMember(plan, body.teamId, body.key);
    // Bring them straight back rather than making the user run a sync for it.
    reconcile.reconcileMembers(plan, store.getSnapshot());
    store.savePlan(plan);
    store.audit('member.unexclude', { teamId: body.teamId, key: body.key });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/team' && req.method === 'DELETE') {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    try {
      const name = reconcile.removeTeam(plan, body.teamId);
      store.savePlan(plan);
      store.audit('team.remove', { teamId: body.teamId, name });
      return json(res, 200, { ok: true, name, teams: plan.teams.map(t => ({ id: t.id, name: t.name })) });
    } catch (err) { return json(res, 400, { error: err.message }); }
  }

  if (p === '/api/board/unignore' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    reconcile.unignoreBoard(plan, body.boardId);
    const rec = reconcile.reconcileAll(plan, store.getSnapshot());
    store.savePlan(plan);
    store.audit('board.unignore', { boardId: body.boardId });
    return json(res, 200, { ok: true, reconcile: rec });
  }

  if (p === '/api/reconcile' && req.method === 'POST') {
    // Re-run the Jira→plan reconciliation against the snapshot already on disk,
    // without touching the network. Useful after remapping a board to a team.
    const plan = store.getPlan();
    const snap = store.getSnapshot();
    const rec = reconcile.reconcileAll(plan, snap);
    store.saveSnapshot(snap);   // reconcileAll builds snap.byTeam — persist it, or the rebuild is lost
    store.savePlan(plan);
    store.audit('reconcile.manual', rec);
    return json(res, 200, rec);
  }

  if (p === '/api/sprints' && req.method === 'POST') {
    // Generate the next N sprints from the last one, so planning never runs out of runway.
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    // The cadence is anchored on the last NUMBERED sprint. A date-named sprint
    // has no number, so `last.number + i` would quietly start counting from
    // "Sprint 1" on a board that names its sprints "TT Week 31Aug".
    const sprints = plan.sprints.slice().sort(reconcile.compareSprints);
    const last = sprints.filter(s => s.number != null).pop();
    if (!last) {
      return json(res, 400, {
        error: sprints.length
          ? 'These sprints are named by date rather than numbered, so there is no number to count on from. Jira already has this team\'s calendar — sync instead of generating.'
          : 'Add one sprint first so I know where the cadence starts.',
      });
    }
    const count = Math.max(1, Math.min(24, Number(body.count) || 4));
    for (let i = 1; i <= count; i++) {
      const start = new Date(`${last.start}T00:00:00Z`); start.setUTCDate(start.getUTCDate() + 14 * i);
      const end = new Date(start.getTime() + 13 * 864e5);
      const number = last.number + i;
      if (plan.sprints.some(s => s.number === number)) continue;
      plan.sprints.push({ id: `S${number}`, number, name: `Sprint ${number}`, start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) });
    }
    store.savePlan(plan);
    return json(res, 200, { ok: true, sprints: plan.sprints });
  }

  /* ---- sync ---- */
  if (p === '/api/sync' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const mode = body.mode || 'incremental';
    try {
      if (mode === 'full') return json(res, 200, await sync.fullSync(cfg));
      if (mode === 'testops') return json(res, 200, await sync.syncTestOps(cfg));
      if (mode === 'github') return json(res, 200, await sync.syncGitHub(cfg));
      return json(res, 200, await sync.incrementalSync(cfg));
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  if (p === '/api/test-connection' && req.method === 'POST') {
    const body = await readJsonBody(req);
    try {
      if (body.target === 'jira') {
        const jira = new Jira(cfg.jira);
        const me = await jira.request('/rest/api/3/myself');
        const fields = await jira.discoverFields();
        return json(res, 200, { ok: true, as: me.displayName, fields });
      }
      if (body.target === 'testops') {
        const { TestOps } = require('./lib/testops');
        const projects = await new TestOps(cfg.testops).projects();
        return json(res, 200, { ok: true, projects });
      }
      if (body.target === 'github') {
        const { GitHub } = require('./lib/github');
        const me = await new GitHub(cfg.github).request('/user');
        return json(res, 200, { ok: true, as: me.login });
      }
      return json(res, 400, { error: 'Unknown target' });
    } catch (err) { return json(res, 502, { error: err.message }); }
  }

  /* ---- import / export ---- */
  if (p === '/api/import/issues' && req.method === 'POST') {
    const text = await readBody(req);
    const rows = csv.issuesFromJiraCsv(text);
    if (!rows.length) return json(res, 400, { error: 'No issues found. Expected a Jira CSV export with an "Issue key" column.' });
    return json(res, 200, sync.importIssues(rows));
  }

  if (p === '/api/export' && req.method === 'GET') {
    const plan = store.getPlan(), snap = store.getSnapshot();
    const what = q.get('what') || 'capacity';
    const team = findTeam(plan, q.get('team'));
    const sprint = findSprint(plan, q.get('sprint'), team.id);
    let rows = [], name = 'export';
    if (what === 'capacity') {
      const v = insights.capacityView(plan, snap, team, sprint);
      name = `capacity-${team.id}-${sprint.id}`;
      rows = v.rows.map(r => ({
        Status: r.status, Role: r.role, Name: r.name,
        'Workload (%)': r.workloadPct, 'Support/Learning effort (%)': r.supportPct,
        'Available days': r.availableDays, 'Capacity (hrs)': r.capacityHours,
        'Predicted Velocity (pts)': r.predicted, 'Planned Velocity (pts)': r.planned,
        'Actual Velocity (pts)': r.actual, 'Goal Completed (%)': r.goalPct,
      }));
    } else if (what === 'backlog') {
      const v = insights.backlogView(plan, snap, { teamId: team.id }).teams[0];
      name = `backlog-${team.id}`;
      rows = v.items.map(i => ({ Key: i.key, Summary: i.summary, Type: i.issueType, Category: i.category, Points: i.points, Status: i.status, Priority: i.priority, Components: (i.components || []).join('; '), Assignee: i.assignee || '' }));
    } else if (what === 'search') {
      // Export the WHOLE result set with the columns currently on screen — a CSV
      // of page one would be a trap.
      const cols = (q.get('columns') || '').split(',').filter(Boolean);
      const columns = cols.length ? cols : search.COLUMNS.filter(c => c.def).map(c => c.key);
      const r = search.searchAll(snap, plan, q.get('q') || '', { sort: q.get('sort') || null, dir: q.get('dir') || 'asc' });
      if (r.error) return json(res, 400, { error: r.error });
      const ctx = { now: Date.now(), categoryOf: (i) => i.category };
      const all = search.columnsFor(snap);
      name = 'search';
      rows = r.rows.map(i => search.toRow(i, columns, ctx, all));
    } else if (what === 'forecast') {
      const v = insights.forecastView(plan, snap, team, { horizon: Number(q.get('horizon')) || 6 });
      name = `forecast-${team.id}`;
      rows = v.rows.map(r => ({ Sprint: r.name, Start: r.start, End: r.end, Headcount: r.headcount, 'Available days': r.availableDays, 'Capacity (hrs)': r.capacityHours, 'Capacity (pts)': r.capacityPoints, 'Committed (pts)': r.committedPoints, 'Free (pts)': r.freePoints, 'Utilisation %': r.utilisationPct }));
    } else if (what === 'risks') {
      const v = insights.riskView(plan, snap, { teamId: team.id });
      name = `risks-${team.id}`;
      rows = v.signals.map(s => ({ Severity: s.severity, Category: s.category, Team: s.teamName, Title: s.title, Detail: s.detail, Action: s.action }))
        .concat(v.manual.map(s => ({ Severity: s.severity, Category: s.category || 'Manual', Team: s.teamName || '', Title: s.title, Detail: s.detail || '', Action: s.mitigation || '' })));
    }
    const body = csv.stringify(rows);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"` });
    return res.end(body);
  }

  if (p === '/api/backup' && req.method === 'GET') {
    const plan = store.getPlan();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="plan-${new Date().toISOString().slice(0, 10)}.json"` });
    return res.end(JSON.stringify(plan, null, 2));
  }

  /* ---- Jira field mapping ---- */
  if (p === '/api/jira/fields' && req.method === 'GET') {
    // Reads the CURRENT mapping without touching the network, so the screen
    // renders instantly and only probes when asked.
    const snap = store.getSnapshot();
    return json(res, 200, {
      configured: {
        storyPoints: cfg.jira.storyPointsField || (snap.fields || {}).storyPointsField || null,
        sprint: cfg.jira.sprintField || (snap.fields || {}).sprintField || null,
        automationStatus: cfg.jira.automationStatusField || (snap.fields || {}).automationStatusField || null,
        team: cfg.jira.teamField || (snap.fields || {}).teamField || null,
      },
      pinned: {
        storyPoints: Boolean(cfg.jira.storyPointsField),
        sprint: Boolean(cfg.jira.sprintField),
        automationStatus: Boolean(cfg.jira.automationStatusField),
        team: Boolean(cfg.jira.teamField),
      },
      roles: fieldsLib.ROLES,
      extraFields: cfg.jira.extraFields || [],
      syncAllFields: Boolean(cfg.jira.syncAllFields),
      estimation: sync.summary(snap, cfg).estimation,
      syncedExtras: snap.extraFields || [],
      lastProbe: (snap.fields || {}).probedAt || null,
    });
  }

  if (p === '/api/jira/fields/probe' && req.method === 'POST') {
    // The one call that settles which field is which: ask Jira for the whole
    // catalogue and a sample of real issues, then measure what is populated.
    if (!cfg.jira.baseUrl || !cfg.jira.apiToken) {
      return json(res, 400, { error: 'Connect Jira first — base URL, email and API token in Integrations & setup.' });
    }
    const body = await readJsonBody(req);
    const jira = new Jira(cfg.jira);
    try {
      const { catalogue, sample } = await jira.probeFields({
        sampleSize: Math.min(300, Math.max(20, Number(body.sampleSize) || 120)),
        projectKey: cfg.jira.projectKey,
      });
      const profiled = fieldsLib.profile(catalogue, sample);
      const configured = {
        storyPoints: cfg.jira.storyPointsField || (store.getSnapshot().fields || {}).storyPointsField || null,
        sprint: cfg.jira.sprintField || (store.getSnapshot().fields || {}).sprintField || null,
        automationStatus: cfg.jira.automationStatusField || (store.getSnapshot().fields || {}).automationStatusField || null,
        team: cfg.jira.teamField || (store.getSnapshot().fields || {}).teamField || null,
      };
      // Record WHEN, so the screen can say how stale its advice is. Without this
      // it reads "Never detected" immediately after a detection, which makes the
      // whole panel look broken.
      const probedAt = new Date().toISOString();
      const snap = store.getSnapshot();
      snap.fields = { ...(snap.fields || {}), probedAt };
      store.saveSnapshot(snap);

      store.audit('jira.fields.probe', { sampled: sample.length, fields: profiled.length });
      return json(res, 200, {
        sampled: sample.length,
        probedAt,
        recommendations: fieldsLib.recommend(profiled, configured),
        // Everything populated, so an extra field can be picked from evidence
        // rather than from a list of 200 names most of which are always empty.
        fields: profiled.filter(f => f.filled > 0 || f.custom).slice(0, 400),
      });
    } catch (err) {
      return json(res, 502, { error: `Jira did not answer: ${err.message}` });
    }
  }

  if (p === '/api/jira/fields' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const patch = {};
    // An empty string means "stop pinning this and go back to auto-detection",
    // which has to be expressible or a wrong pin can never be undone.
    const set = (key, cfgKey) => {
      if (!(key in body)) return;
      patch[cfgKey] = body[key] ? String(body[key]).trim() : null;
    };
    set('storyPoints', 'storyPointsField');
    set('sprint', 'sprintField');
    set('automationStatus', 'automationStatusField');
    set('team', 'teamField');

    if ('extraFields' in body) {
      patch.extraFields = (Array.isArray(body.extraFields) ? body.extraFields : [])
        .map(f => (typeof f === 'string' ? { id: f, name: f } : f))
        .filter(f => f && f.id)
        .map(f => ({ id: String(f.id), name: String(f.name || f.id), key: slugField(f.key || f.name || f.id), numeric: Boolean(f.numeric) }))
        .slice(0, 40);
    }
    if ('syncAllFields' in body) patch.syncAllFields = Boolean(body.syncAllFields);

    const saved = saveConfig({ jira: patch });
    store.audit('jira.fields.save', {
      storyPoints: patch.storyPointsField, extras: (patch.extraFields || []).length, all: patch.syncAllFields,
    });
    return json(res, 200, {
      ok: true,
      // Changing a field mapping changes nothing until the data is pulled again.
      needsFullSync: true,
      jira: {
        storyPointsField: saved.jira.storyPointsField || null,
        sprintField: saved.jira.sprintField || null,
        automationStatusField: saved.jira.automationStatusField || null,
        teamField: saved.jira.teamField || null,
        extraFields: saved.jira.extraFields || [],
        syncAllFields: Boolean(saved.jira.syncAllFields),
      },
    });
  }

  /* ---- search ---- */
  if (p === '/api/search' && req.method === 'GET') {
    const plan = store.getPlan(), snap = store.getSnapshot();
    const result = search.search(snap, plan, q.get('q') || '', {
      page: q.get('page'), pageSize: q.get('pageSize'),
      sort: q.get('sort') || null, dir: q.get('dir') || 'asc',
      withFacets: q.get('facets') !== '0',
    });
    // A bad query is a 200 with an `error` — the page keeps its chips and shows
    // what is wrong, rather than a network failure it cannot explain.
    return json(res, 200, {
      ...result,
      fields: search.FACET_FIELDS.map(f => ({ name: f, label: (query.FIELDS[f] || {}).label || f })),
      columns: search.columnsFor(snap),
      jiraBase: (cfg.jira.baseUrl || '').replace(/\/+$/, ''),
      savedSearches: plan.savedSearches || [],
    });
  }

  if (p === '/api/search/saved' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const name = String(body.name || '').trim();
    if (!name) return json(res, 400, { error: 'A saved search needs a name.' });
    // Refuse to save something that does not run — a saved search that errors
    // when you click it a month from now is worse than not saving it.
    const probe = search.search(store.getSnapshot(), store.getPlan(), body.query || '', { withFacets: false, pageSize: 1 });
    if (probe.error) return json(res, 400, { error: `That query does not run: ${probe.error}` });

    const plan = store.getPlan();
    plan.savedSearches = plan.savedSearches || [];
    const id = `s-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
    const entry = {
      id, name, query: body.query || '',
      columns: Array.isArray(body.columns) ? body.columns : null,
      sort: body.sort || null, dir: body.dir || null,
      matchedWhenSaved: probe.total,
      savedAt: new Date().toISOString(),
    };
    const at = plan.savedSearches.findIndex(s => s.id === id);
    if (at >= 0) plan.savedSearches[at] = entry; else plan.savedSearches.push(entry);
    store.savePlan(plan);
    store.audit('search.save', { id, name, query: entry.query });
    return json(res, 200, { ok: true, saved: entry, savedSearches: plan.savedSearches });
  }

  if (p === '/api/search/saved' && req.method === 'DELETE') {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    const before = (plan.savedSearches || []).length;
    plan.savedSearches = (plan.savedSearches || []).filter(s => s.id !== body.id);
    if (plan.savedSearches.length === before) return json(res, 404, { error: 'No such saved search.' });
    store.savePlan(plan);
    store.audit('search.delete', { id: body.id });
    return json(res, 200, { ok: true, savedSearches: plan.savedSearches });
  }

  if (p === '/api/sources' && req.method === 'GET') {
    return json(res, 200, {
      ...provenance.status(store.getPlan(), store.getSnapshot()),
      // The local database, so this screen can answer "where does this number
      // live" with the store as well as the source.
      store: { ...dbLib.stats(), migration: store.migrationStatus() },
      // Structural self-checks. No network, so this works off VPN and is safe
      // to compute on every load of the screen.
      integrity: integrity.run(),
    });
  }

  /* ---- the per-sprint roster ---- */

  if (p === '/api/sprint/roster' && req.method === 'GET') {
    // Who is on this sprint, and who could be added. The candidate list is the
    // team's own people plus everyone Jira has seen, which is what makes
    // "the list of members comes from Jira" true without anyone typing a name.
    const plan = store.getPlan(), snap = store.getSnapshot();
    const team = findTeam(plan, q.get('team'));
    const sprint = findSprint(plan, q.get('sprint'), team.id);
    const raw = insights.issuesForSprint(snap, team, sprint);
    const roster = rosterLib.forSprint(plan, team, sprint, raw, lock.stateFor(sprint, team.id));
    return json(res, 200, {
      teamId: team.id, sprintId: sprint.id, sprintName: sprint.name,
      lock: lock.status(sprint, team.id),
      counts: roster.counts,
      members: roster.members.map(m => ({
        id: m.id, name: m.name, role: m.role || null, status: m.status || 'Active',
        onSprint: m.onSprint || 'added',
        notOnTeamList: !!m.notOnTeamList, unresolved: !!m.unresolved,
        jiraAccountId: m.jiraAccountId || null,
      })),
      candidates: rosterLib.candidates(plan, snap, team, roster.members),
    });
  }

  if (p === '/api/sprint/roster' && req.method === 'PUT') {
    // { teamId, sprintId, memberId, state: 'added'|'removed'|'clear', reason? }
    // The closed-sprint guard already ran, inside readJsonBody.
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    const team = (plan.teams || []).find(t => t.id === body.teamId);
    if (!team) return json(res, 404, { error: `No team "${body.teamId}"` });

    const key = `${body.teamId}|${body.sprintId}`;
    plan.sprintRoster = plan.sprintRoster || {};
    const entry = plan.sprintRoster[key] || { added: [], removed: [] };
    const id = String(body.memberId);

    // A person is in at most ONE of the two lists. Adding someone you had
    // removed is a retraction of the removal, not a second, contradictory
    // decision — and a row in both lists would make the result depend on which
    // was applied last.
    entry.added = (entry.added || []).filter(x => x !== id);
    entry.removed = (entry.removed || []).filter(x => x !== id);
    if (body.state === 'added' || body.state === 'removed') entry[body.state].push(id);
    if (body.reason) (entry.reasons = entry.reasons || {})[id] = body.reason;
    // Remember WHO, on the sprint's own row. Not as a team member — see below.
    if (body.state === 'added' && body.member) {
      entry.people = entry.people || {};
      entry.people[id] = { name: body.member.name || id, jiraAccountId: body.member.jiraAccountId || null };
    }
    if (body.state !== 'added' && entry.people) delete entry.people[id];
    entry.at = new Date().toISOString();

    // Drop the key entirely once it says nothing, so "no decision here" and
    // "a decision that cancels out" are not two different stored states.
    if (!entry.added.length && !entry.removed.length) delete plan.sprintRoster[key];
    else plan.sprintRoster[key] = entry;

    // DELIBERATELY NOT added to team.members.
    //
    // The first version did that, so their leave grid would have a member
    // record to hang off. It also silently put them on every other open sprint
    // — because an open sprint's roster includes the whole team — which is the
    // exact opposite of what "add to this sprint" says on the button, and what
    // the drawer promises in so many words.
    //
    // Nothing needs the team row: availability and support are keyed by
    // "team|sprint|member", not by a foreign key, and the roster entry above
    // carries the name. Putting someone on the team is a separate, deliberate
    // act on the Team screen.

    store.savePlan(plan);
    store.audit('roster.set', { key, memberId: id, state: body.state });
    return json(res, 200, { ok: true });
  }

  /* ---- capacity scenarios ---- */

  if (p === '/api/scenarios' && req.method === 'GET') {
    const plan = store.getPlan(), snap = store.getSnapshot();
    const team = findTeam(plan, q.get('team'));
    const sprint = findSprint(plan, q.get('sprint'), team.id);
    const live = insights.capacityView(plan, snap, team, sprint);
    return json(res, 200, {
      teamId: team.id, sprintId: sprint.id,
      lock: live.lock,
      // The current plan, presented alongside the saved ones so the comparison
      // has something to compare against.
      live: { name: 'Current plan', totals: live.totals, live: true },
      scenarios: (plan.scenarios || [])
        .filter(sc => sc.teamId === team.id && sc.sprintId === sprint.id)
        .map(sc => ({ id: sc.id, name: sc.name, note: sc.note, totals: sc.totals, createdAt: sc.createdAt, appliedAt: sc.appliedAt })),
    });
  }

  if (p === '/api/scenarios' && req.method === 'POST') {
    // Save the CURRENT plan inputs under a name. Saving is a read of the live
    // plan and a write of a scenario row, so a closed sprint refuses it — a
    // scenario for a sprint you can never apply it to is a trap.
    const body = await readJsonBody(req);
    const plan = store.getPlan(), snap = store.getSnapshot();
    const team = findTeam(plan, body.teamId);
    const sprint = findSprint(plan, body.sprintId, team.id);
    const view = insights.capacityView(plan, snap, team, sprint);

    const sc = {
      id: `sc${Date.now().toString(36)}`,
      teamId: team.id, sprintId: sprint.id,
      name: (body.name || '').trim() || `Scenario ${new Date().toISOString().slice(0, 10)}`,
      note: body.note || null,
      data: captureScenario(plan, view, team, sprint),
      totals: view.totals,
      createdAt: new Date().toISOString(),
      appliedAt: null,
    };
    plan.scenarios = plan.scenarios || [];
    plan.scenarios.push(sc);
    store.savePlan(plan);
    store.audit('scenario.save', { id: sc.id, team: team.id, sprint: sprint.id, name: sc.name });
    return json(res, 200, sc);
  }

  if (p === '/api/scenarios/apply' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    const sc = (plan.scenarios || []).find(x => x.id === body.id);
    if (!sc) return json(res, 404, { error: 'No such scenario.' });

    const team = (plan.teams || []).find(t => t.id === sc.teamId);
    const sprint = (plan.sprints || []).find(x => x.id === sc.sprintId);
    // Guarded explicitly: the body names an id, not a team+sprint pair, so the
    // check inside readJsonBody had nothing to match on.
    if (team && sprint) lock.assertWritable(sprint, team, 'a scenario');

    applyScenario(plan, sc);
    sc.appliedAt = new Date().toISOString();
    store.savePlan(plan);
    store.audit('scenario.apply', { id: sc.id, team: sc.teamId, sprint: sc.sprintId });
    return json(res, 200, { ok: true, applied: sc.id });
  }

  if (p === '/api/scenarios/dedupe' && req.method === 'POST') {
    // Clean up the copies the double-firing click left behind.
    //
    // DRY RUN BY DEFAULT, like the reset: it reports what it would remove and
    // removes nothing until `confirm: true`. Deleting a saved plan is not
    // recoverable, so the decision stays with the person even when the copies
    // are provably identical.
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    const all = plan.scenarios || [];

    // "Identical" means same team, sprint, name AND same captured inputs — not
    // merely the same name. Re-saving under a name you have used before, with
    // a different plan, is a legitimate thing to do and must survive this.
    const groups = new Map();
    for (const sc of all) {
      const key = [sc.teamId, sc.sprintId, sc.name, JSON.stringify(sc.data || {})].join('\u0000');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(sc);
    }

    const removing = [];
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      // Keep the OLDEST: the first save is the one he meant, the rest are the
      // same click arriving again.
      const sorted = list.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      for (const dup of sorted.slice(1)) {
        removing.push({ id: dup.id, teamId: dup.teamId, sprintId: dup.sprintId, name: dup.name, createdAt: dup.createdAt });
      }
    }

    if (!body.confirm) {
      return json(res, 200, { dryRun: true, total: all.length, duplicates: removing.length, keeping: all.length - removing.length, removing });
    }

    const drop = new Set(removing.map(r => r.id));
    plan.scenarios = all.filter(sc => !drop.has(sc.id));
    store.savePlan(plan);
    store.audit('scenario.dedupe', { removed: removing.length, ids: [...drop] });
    return json(res, 200, { removed: removing.length, remaining: plan.scenarios.length });
  }

  if (p === '/api/scenarios' && req.method === 'DELETE') {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    const before = (plan.scenarios || []).length;
    plan.scenarios = (plan.scenarios || []).filter(x => x.id !== body.id);
    if (plan.scenarios.length === before) return json(res, 404, { error: 'No such scenario.' });
    store.savePlan(plan);
    store.audit('scenario.delete', { id: body.id });
    return json(res, 200, { ok: true });
  }

  /* ---- adjustments: what you have overridden locally ---- */

  if (p === '/api/adjustments' && req.method === 'GET') {
    // Each row joined to the issue it belongs to, so the screen can say
    // "AUTOKAT-1042 Login flow regression" rather than a bare key.
    const rows = repo.adjustments({ entity: q.get('entity') || null, id: q.get('id') || null });
    const snap = store.getSnapshot();
    return json(res, 200, {
      rows: rows.map(r => {
        const issue = r.entity === 'issue' ? (snap.issues || {})[r.id] : null;
        return { ...r, summary: issue ? issue.summary : null, status: issue ? issue.status : null,
          team: issue ? issue.team : null };
      }),
      fields: [...repo.ADJUSTABLE].sort(),
    });
  }

  if (p === '/api/adjustments' && req.method === 'PUT') {
    // { entity, id, field, value, reason }
    const body = await readJsonBody(req);
    try {
      const out = repo.adjust(body.entity || 'issue', body.id, body.field, body.value, { reason: body.reason || null });
      store.invalidate();   // the projection is cached; an override must show at once
      store.audit('adjustment.set', { id: body.id, field: body.field, reason: body.reason || null });
      return json(res, 200, out);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (p === '/api/adjustments' && req.method === 'DELETE') {
    // Reverting is not a delete of YOUR data — it puts the field back to what
    // Jira says and drops the override, which is why it needs no confirmation
    // step: nothing you typed anywhere else is affected and the value it
    // restores is the one the source is holding right now.
    const body = await readJsonBody(req);
    try {
      const out = repo.revert(body.entity || 'issue', body.id, body.field);
      store.invalidate();
      store.audit('adjustment.revert', { id: body.id, field: body.field });
      return json(res, 200, out);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (p === '/api/reset' && req.method === 'POST') {
    // Hand the data back to Jira. Destructive, so: a dry run is the default and
    // the caller must pass confirm:true to actually write, and a timestamped
    // backup of the whole plan is on disk before a single key is removed.
    const body = await readJsonBody(req);
    const mode = body.mode === 'settings-only' ? 'settings-only' : 'keep-capacity';
    const plan = store.getPlan();

    if (!body.confirm) {
      const preview = reset.resetToJira(JSON.parse(JSON.stringify(plan)), { mode });
      return json(res, 200, { dryRun: true, ...preview });
    }

    const backup = store.backupPlan ? store.backupPlan('pre-reset') : null;
    const report = reset.resetToJira(plan, { mode });
    store.savePlan(plan);
    if (body.clearSnapshot) reset.clearSnapshot();
    store.audit('plan.reset', { mode, backup, ...report.removed });
    return json(res, 200, { ok: true, backup, clearedSnapshot: !!body.clearSnapshot, ...report });
  }

  if (p === '/api/restore' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body.teams || !body.sprints) return json(res, 400, { error: 'That does not look like a plan backup (no teams/sprints).' });
    store.savePlan(body);
    store.audit('plan.restore', { teams: body.teams.length });
    return json(res, 200, { ok: true });
  }

  /* ---- config + audit ---- */
  if (p === '/api/config' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    return json(res, 200, { ok: true, config: redact(saveConfig(body)) });
  }
  if (p === '/api/audit' && req.method === 'GET') return json(res, 200, store.readAudit(Number(q.get('limit')) || 150));

  return json(res, 404, { error: `No route for ${req.method} ${p}` });
}

/* ───────────────────────────── static ───────────────────────────── */

/**
 * Files the browser gets from OUTSIDE public/.
 *
 * The query language has to run in both places: the server executes it, and the
 * page compiles chips into it and reads it back out. Two implementations of a
 * parser drift — so the browser is served the same lib/query.js the server
 * requires, rather than a copy that will disagree with it one day.
 */
const SHARED_TO_BROWSER = { '/shared/query.js': path.join(__dirname, 'lib', 'query.js') };

function serveStatic(req, res, url) {
  const shared = SHARED_TO_BROWSER[url.pathname];
  if (shared) {
    return fs.readFile(shared, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.woff2' ? 'public, max-age=604800' : 'no-cache',
    });
    res.end(data);
  });
}

/* ───────────────────────────── boot ───────────────────────────── */

const cfg = loadConfig();
const server = http.createServer(async (req, res) => {
  const remote = req.socket.remoteAddress || '';
  if (!/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(remote)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('This tool only accepts connections from this computer.');
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    // A thrown error may carry its own status. The closed-sprint guard throws
    // 409, and reporting that as a 500 would tell the user the tool broke when
    // in fact it refused on purpose.
    if (err && err.status) return json(res, err.status, { error: err.message, code: err.code || null });
    console.error(err);
    return json(res, 500, { error: err.message });
  }
});

store.ensureDirs();

/**
 * Requiring this file used to START the server, which made it impossible to
 * test a route without also binding a port and printing a banner — so the
 * routes were the one layer with no tests at all, and the closed-sprint rule
 * is precisely the kind of thing that has to be proven at the route.
 *
 * `PORT=0` means "I am the test harness": the module exports the server and
 * lets the caller listen. Anything else behaves exactly as before.
 */
module.exports = { server, handleApi, captureScenario, applyScenario };

if (process.env.PORT !== '0') {
  server.listen(cfg.server.port, '127.0.0.1', () => {
    const url = `http://localhost:${cfg.server.port}`;
    console.log(`\n  Automation Planning Tool  →  ${url}`);
    console.log(`  Data: ${store.STORE_DIR}`);
    console.log(cfg.jira.apiToken ? `  Jira: ${cfg.jira.baseUrl} (${cfg.jira.projectKey})` : '  Jira: not configured yet — open Settings in the app.');
    console.log('  Ctrl-C to stop.\n');
  });
}
