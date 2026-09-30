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
const componentNote = require('./lib/component-note');
const componentRank = require('./lib/component-rank');
const backlogLib = require('./lib/backlog-item');
const blockersLib = require('./lib/blockers');
const smtp = require('./lib/smtp');
const mimeLib = require('./lib/mime');
const pdfRender = require('./lib/pdf-render');
const reportMail = require('./lib/report-mail');
const mailSchedule = require('./lib/mail-schedule');
const prioritization = require('./lib/prioritization');
const keywords = require('./lib/keywords');
const sprintDates = require('./lib/sprint-dates');
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
/* Overridable for the same reason STORE_DIR and DB_FILE are: a test that
   needs a Jira to talk to must be able to point this at a stub, and the
   alternative is either writing the real config.json or leaving the one
   route that edits live issues without an end-to-end check. */
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, 'config.json');

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
  cfg.mail = Object.assign({ host: '', port: 587, user: '', pass: '', from: '', fromName: '' }, cfg.mail);
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
  for (const section of ['jira', 'testops', 'github', 'server', 'metrics', 'mail']) {
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
    /* THE APP PASSWORD NEVER COMES BACK, only whether one is saved — the same
       rule the Jira token beside it follows. This block is on screen whenever
       he shows somebody the feature and in every screenshot he takes of it. */
    mail: {
      host: (cfg.mail || {}).host || '',
      port: Number((cfg.mail || {}).port || 587),
      user: (cfg.mail || {}).user || '',
      from: (cfg.mail || {}).from || '',
      fromName: (cfg.mail || {}).fromName || '',
      hasPass: Boolean((cfg.mail || {}).pass),
    },
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

/**
 * THE FIGURES A TEMPLATE MAY QUOTE, read from the same view the screen draws.
 *
 * Not from a second computation. A mail telling a client "coverage is 63.3%"
 * over an attachment showing 61.8% is the worst failure this feature has,
 * because both numbers are defensible and nobody here would ever see them
 * side by side.
 */
/* `cfg` IS A PARAMETER, and that is the whole point of this signature.
 *
 * `handleApi` builds a fresh config on every request; the module-level `cfg`
 * near the bottom of this file is read ONCE, at boot. A module-level function
 * that says `cfg` silently gets the boot-time one — so the Settings screen
 * saved the mail block, `/api/mail/config` (inside `handleApi`) reported it
 * correctly, the Test button worked, and Send answered "Mail is not set up",
 * because it alone was reading a config from before the save.
 *
 * Passing it in is not defensive style: it makes the stale-read impossible to
 * write by accident, which a `loadConfig()` call inside the function would
 * not — the next function to be added here would go straight back to `cfg`. */
function coverageFigures(cfg, plan, body = {}) {
  const snap = store.getSnapshot();
  const m = (cfg.metrics || {});
  const view = coverage.view(snap, {
    components: Array.isArray(body.components) ? body.components.filter(Boolean) : [],
    scope: m.coverageScope || 'Epic',
    exclude: plan.excludedComponents || [],
    teams: plan.coverageTeams || [],
  });
  const team = body.team ? (plan.teams || []).find(t => t.id === body.team) : null;
  return reportMail.figuresFrom(view, {
    teamName: team ? team.name : '',
    sprintLabel: body.sprintLabel || '',
    senderName: (cfg.mail || {}).fromName || '',
    today: Date.now(),
  });
}

/**
 * The same, for the Active Sprint report.
 *
 * `insights.activeSprintView` IS THE SCREEN'S OWN CALL, made here with the
 * same team and sprint the page resolves — not a second computation over the
 * same data. The whole point of the placeholders is that a client quoting the
 * mail is quoting the number he is looking at, and two code paths to one
 * figure is how that stops being true.
 */
function sprintFigures(cfg, plan, body = {}) {
  const snap = store.getSnapshot();
  const team = findTeam(plan, body.team || null);
  const sprint = findSprint(plan, body.sprint || null, team.id);
  /* SAID OUT LOUD RATHER THAN DEREFERENCED. `findSprint` answers null for a
     store with no sprints in it, and `activeSprintView` then fails deep
     inside on a property of undefined — which reaches the screen as a 500 and
     the mail log as a stack trace. Both are real states: a fresh install, and
     a team whose sprints have all closed. */
  if (!sprint) {
    throw new Error(`there is no active sprint for ${team.name || 'this team'}. `
      + 'Sync Jira, or pick a sprint on the Active sprint screen first.');
  }
  const view = insights.activeSprintView(plan, snap, team, sprint);
  return reportMail.sprintFiguresFrom(view, {
    teamName: team ? team.name : '',
    sprintLabel: (sprint && (sprint.name || sprint.id)) || '',
    senderName: (cfg.mail || {}).fromName || '',
    today: Date.now(),
  });
}

/**
 * THE FIGURES FOR WHICHEVER REPORT THIS IS.
 *
 * One place that maps a report kind to its numbers, so the preview route, the
 * send route and the scheduler cannot each decide differently — which they
 * would, because each of them already had its own call to `coverageFigures`
 * when there was only one report to get wrong.
 */
/**
 * The same, for Capacity planning.
 *
 * `insights.capacityView` IS THE SCREEN'S OWN CALL, resolved with the same
 * team and sprint the page resolves — the third report to be built this way,
 * and the reason it keeps being worth writing out: a mail quoting a number
 * the attachment does not show is the failure that cannot be caught from
 * inside the tool, because both halves look right on their own.
 */
function capacityFigures(cfg, plan, body = {}) {
  const snap = store.getSnapshot();
  const team = findTeam(plan, body.team || null);
  const sprint = findSprint(plan, body.sprint || null, team.id);
  if (!sprint) {
    throw new Error(`there is no sprint to plan for ${team.name || 'this team'}. `
      + 'Sync Jira, or pick a sprint on the Capacity planning screen first.');
  }
  const view = insights.capacityView(plan, snap, team, sprint);
  return reportMail.capacityFiguresFrom(view, {
    teamName: team ? team.name : '',
    sprintLabel: (sprint && (sprint.name || sprint.id)) || '',
    senderName: (cfg.mail || {}).fromName || '',
    today: Date.now(),
  });
}

/* ONE MAP FROM A REPORT KIND TO ITS FIGURES. Keyed off `REPORTS` rather than
   an if-chain, so adding a fourth report is an entry in the registry and a
   function here — and a kind with no builder fails loudly at the seam instead
   of silently falling through to coverage's numbers, which is what an
   `else` would have done. */
const FIGURES = {
  coverage: coverageFigures,
  sprint: sprintFigures,
  capacity: capacityFigures,
};

function figuresFor(kind, cfg, plan, body = {}) {
  const report = reportMail.reportOf(kind);
  const build = FIGURES[report.key];
  if (!build) throw new Error(`no figures are defined for the ${report.label} report`);
  return build(cfg, plan, body);
}

/**
 * RENDER, COMPOSE, SEND, RECORD — in that order, and the order is the design.
 *
 * The PDF is produced BEFORE the connection is opened, so a Chrome that is
 * missing or a page that did not load costs nothing but an error message. The
 * alternative — authenticate, then discover there is nothing to attach — ends
 * with a half-open SMTP session and a client wondering where the attachment
 * went.
 *
 * EVERY OUTCOME IS LOGGED, success and failure alike. The scheduler sends
 * unattended; without a record, a send that failed at 8am on Monday is
 * invisible until the client asks why they got nothing.
 */
async function sendReport(cfg, body = {}, { trigger = 'manual' } = {}) {
  const plan = store.getPlan();
  const mail = cfg.mail || {};
  const started = new Date().toISOString();

  const record = (ok, detail, extra = {}) => {
    try {
      dbLib.run('INSERT INTO mail_log (at, template, subject, recipients, ok, detail, bytes, trigger) VALUES (?,?,?,?,?,?,?,?)',
        started, extra.template || null, extra.subject || null,
        (extra.recipients || []).join(' '), ok ? 1 : 0, String(detail || '').slice(0, 500),
        extra.bytes || null, trigger);
    } catch { /* a log that cannot write must not fail a send that worked */ }
    return { ok, error: ok ? null : String(detail || ''), ...extra, at: started, trigger };
  };

  /* THE TEMPLATE IS CHECKED FIRST, before the mail setup.
     Both can be wrong at once, and when they are, the address he mistyped is
     the one he can fix on this screen — "mail is not set up" sends him to a
     config file to solve a problem that is not there. Specific before
     general. */
  const v = reportMail.validate(body.template || {});
  if (!v.ok) return record(false, v.errors.join(' '));
  const tpl = v.template;

  /* THE TEMPLATE'S KIND DECIDES THE REPORT, not the caller's, and this is
     checked BEFORE the mail setup for the same reason the template is:
     specific before general. Both can be wrong at once, and when they are,
     "mail is not set up" sends him to a config file to solve a problem that
     is not there.
     The mismatch is not hypothetical — the drawer is the same drawer on both
     screens and a saved template is one dropdown away from the other page.
     Sending one there would compose coverage wording over sprint figures:
     every placeholder unresolved, the attachment a different report, and all
     of it in front of a client. Refused, and the message names both reports
     so he does not have to guess which way round it went. */
  const kind = reportMail.reportOf(tpl.report);
  const asked = reportMail.reportOf(body.report || tpl.report);
  if (asked.key !== kind.key) {
    return record(false,
      `That template is written for the ${kind.label} report, so it cannot be sent as ${asked.label}.`,
      { template: tpl.name, recipients: [...tpl.to, ...tpl.cc] });
  }

  if (!mail.host || !mail.from) {
    return record(false, 'Mail is not set up — add a mail block to config.json (host, user, pass, from).',
      { template: tpl.name, recipients: [...tpl.to, ...tpl.cc] });
  }

  let report;
  try {
    report = figuresFor(kind.key, cfg, plan, body);
  } catch (err) {
    /* A REPORT WITH NOTHING TO REPORT ON. No sprints in the store, a team
       with none of its own — real states, and the figures throw rather than
       inventing zeroes. Caught here so it is a sentence in the log and on
       screen instead of a stack trace and a 500, which is what he would
       otherwise get at 8am on a Monday from the scheduler. */
    return record(false, `The ${kind.label} report could not be built — ${err.message}`,
      { template: tpl.name, recipients: [...tpl.to, ...tpl.cc] });
  }
  const composed = reportMail.compose(tpl, report, { from: mail.from, fromName: mail.fromName });

  let attachment = null;
  let bytes = 0;
  if (tpl.attachPdf) {
    try {
      /* THE PORT THE SERVER IS ACTUALLY ON, asked of the running server
         rather than read from config. Under the test harness the config says
         one thing and `listen(0)` did another, and a render against the
         configured port would quietly fetch somebody else's page — or
         nothing. */
      const port = (server.address() && server.address().port) || cfg.server.port;
      /* THE SAME SCOPE THE FIGURES WERE COMPUTED FROM, a dozen lines above.
         One scope read twice, and it must not become two — that is how the
         words came to describe a subset while the attachment showed
         everything. The report kind decides WHICH scope: coverage narrows by
         component, the sprint report by sprint. */
      const url = pdfRender.reportUrl(`http://127.0.0.1:${port}`, {
        route: kind.route, team: body.team || null, landscape: tpl.landscape !== false,
        sprint: kind.scope === 'sprint' ? (body.sprint || null) : null,
        components: kind.scope === 'components' && Array.isArray(body.components)
          ? body.components.filter(Boolean) : [],
        /* THE LENS IS NOT PART OF THE SCOPE, and travels anyway. Nothing
           above was computed from it — the capacity figures are team-level
           and identical under any chip — so this is not "the same scope read
           twice". It is the framing of the picture, and the picture is what
           the attachment is. */
        view: body.view || {},
      });
      const out = await pdfRender.render(url, { landscape: tpl.landscape !== false });
      attachment = {
        filename: reportMail.pdfName(report, tpl),
        content: fs.readFileSync(out.file),
        contentType: 'application/pdf',
      };
      bytes = out.bytes;
      try { fs.rmSync(path.dirname(out.file), { recursive: true, force: true }); } catch { /* temp */ }
    } catch (err) {
      /* REFUSED RATHER THAN SENT WITHOUT IT. He asked for a report with the
         PDF attached; a mail arriving with the words and no document is not a
         smaller version of that, it is a thing he would have to apologise
         for. */
      return record(false, `The PDF could not be rendered, so nothing was sent — ${err.message}`,
        { template: tpl.name, subject: composed.subject, recipients: [...tpl.to, ...tpl.cc] });
    }
  }

  let msg;
  try {
    msg = mimeLib.build({
      from: composed.from, to: composed.to, cc: composed.cc,
      subject: composed.subject, text: composed.text,
      attachments: attachment ? [attachment] : [],
    });
  } catch (err) {
    return record(false, err.message, { template: tpl.name, subject: composed.subject });
  }

  try {
    const sent = await smtp.send(mail, { ...msg, from: mimeLib.bare(mail.from) });
    store.audit('mail.sent', { template: tpl.name, to: msg.to.length, trigger });
    return record(true, sent.response, {
      template: tpl.name, subject: composed.subject,
      recipients: [...msg.to, ...msg.cc], bytes,
    });
  } catch (err) {
    return record(false, err.message, {
      template: tpl.name, subject: composed.subject,
      recipients: [...msg.to, ...msg.cc], bytes,
    });
  }
}

/* ─────────────────────── THE WEEKLY SEND ────────────────────────────────
 *
 * `lib/mail-schedule.js` decides WHETHER a template is due; this decides what
 * to do about it. The split is not ceremony — the decision is pure arithmetic
 * over a clock and is worth testing across a year of Mondays in a loop, while
 * this half writes to a database and opens an SMTP connection and is worth
 * testing about four times.
 *
 * ── WHY THE CLAIM IS WRITTEN FIRST ───────────────────────────────────────
 *
 * The order below is claim, then send, then record the outcome. Reversed —
 * send, then mark it done — a crash or a quit in the seconds between the two
 * leaves the slot looking unsent, and the next tick, or the next launch,
 * sends the client a second copy of a report they already have.
 *
 * Writing the claim first inverts the failure: a crash in that same window
 * loses the report instead. He sees no mail, looks at the log, finds the slot
 * sitting at `sending`, and presses Send. That is a minute of his time. The
 * other way costs an email to a client explaining why they got two.
 *
 * NOTHING RETRIES. Not on failure, not on an ambiguous outcome. If Gmail
 * refuses the password at 8am the record says so and the schedule waits for
 * next week — because a retry loop against a send that failed for a reason it
 * cannot diagnose is how four copies arrive at 8:03.
 */
const SCHEDULE_TICK_MS = 60 * 1000;
/* THE FIRST TICK WAITS. `sendReport` renders the PDF by pointing Chrome at
   this server's own port, so a schedule that fired during startup would race
   the thing it needs. Twenty seconds is far longer than boot and far shorter
   than the grace window, so a slot that is genuinely due is not lost. */
const SCHEDULE_FIRST_TICK_MS = 20 * 1000;

/* ── TWO GUARDS, AND BOTH ARE LOAD-BEARING ───────────────────────────────
 *
 * A duplicate send is stopped twice over: this SELECT, and the INSERT in
 * `claimSlot` below hitting its primary key. Breaking either one ALONE still
 * sends exactly once — confirmed by mutating each in turn and watching the
 * suite stay green, which is the kind of result that usually means dead code.
 * It is not, and the distinction is worth writing down before somebody
 * simplifies it away:
 *
 *   THE INSERT IS THE LOCK. It is atomic, and it is the only thing that would
 *   hold if two passes ever overlapped.
 *
 *   THE SELECT IS WHAT MAKES THE ANSWER LEGIBLE. Without it every ordinary
 *   tick — ten thousand a week, all of which should do nothing — reaches
 *   `decide` as 'due' and is stopped by a caught constraint violation. That
 *   works, and it means the normal path is an exception, `reason` never says
 *   'done', and the moment something genuinely breaks there is no way to tell
 *   a slot that was already sent from one that failed to claim.
 *
 * Delete either and the tests still pass. Delete both and they do not — which
 * is the honest statement of what is being protected here.
 */
const claimedSlot = (templateId, key) => {
  try {
    return !!dbLib.get('SELECT 1 AS x FROM mail_schedule_run WHERE template = ? AND slot = ?', templateId, key);
  } catch {
    /* A CLAIM TABLE THAT CANNOT BE READ MEANS "ALREADY SENT". The only thing
       this answer is used for is deciding whether to mail a client; if the
       database is in a state where that question cannot be answered, the safe
       reply is the one that sends nothing. */
    return true;
  }
};

/**
 * Take the slot, or report that somebody already has it.
 *
 * The INSERT is the lock. `status` starts at `sending` so that a process
 * killed mid-send leaves a row that says exactly that — distinguishable on
 * the screen from `sent`, from `failed`, and from a slot nobody ever reached.
 */
function claimSlot(templateId, key, status = 'sending') {
  try {
    dbLib.run('INSERT INTO mail_schedule_run (template, slot, claimed, status) VALUES (?,?,?,?)',
      templateId, key, new Date().toISOString(), status);
    return true;
  } catch {
    return false;
  }
}

const settleSlot = (templateId, key, status, detail) => {
  try {
    dbLib.run('UPDATE mail_schedule_run SET status = ?, detail = ? WHERE template = ? AND slot = ?',
      status, String(detail || '').slice(0, 500), templateId, key);
  } catch { /* the send already happened; a lost status line must not undo it */ }
};

/**
 * One pass over every template that has a schedule.
 *
 * @param {Date} now      injected so a test can walk a month in milliseconds
 * @param {object} o      { grace } — injected for the same reason
 * @returns {Array} what happened, one entry per scheduled template
 *
 * `loadConfig()` IS CALLED HERE, ON EVERY TICK, and that is not wasteful
 * caution. The module-level `cfg` in this file is read once at boot; a
 * module-level function that closes over it keeps serving a config from
 * before the Settings screen was last saved. That exact bug shipped in this
 * file — Send answered "mail is not set up" while the Test button on the same
 * screen worked — and a scheduler is where it would be least visible, because
 * the failure arrives at 8am on a Monday with nobody looking.
 */
async function runDueSchedules(now = new Date(), o = {}) {
  const out = [];
  let plan;
  try { plan = store.getPlan(); } catch { return out; }
  const templates = (plan.mailTemplates || []).filter(t => t && t.id && t.schedule && t.schedule.enabled);
  if (!templates.length) return out;

  const cfg = loadConfig();

  for (const tpl of templates) {
    const d = mailSchedule.decide(tpl.schedule, now, {
      grace: o.grace,
      claimed: (key) => claimedSlot(tpl.id, key),
    });
    if (d.reason === 'off' || d.reason === 'done') continue;

    /* A MISSED SLOT IS RECORDED, NOT SKIPPED QUIETLY. Without the row, "there
       was no report last Monday" and "the report failed last Monday" look
       identical from the screen — and the first one has a cause he can act on
       (his laptop was shut) while the second does not. Claiming it also stops
       this branch re-deciding the same dead slot every minute forever. */
    if (d.reason === 'missed') {
      if (claimSlot(tpl.id, d.key, 'missed')) {
        settleSlot(tpl.id, d.key, 'missed',
          `Nothing was running at ${d.key}, and by the time it was this was ${mailSchedule.lateness(d.late)} — too stale to send.`);
        out.push({ template: tpl.id, slot: d.key, status: 'missed' });
      }
      continue;
    }

    /* THE CLAIM IS THE GATE. If the insert loses, another pass has this slot
       and this one does nothing — no send, no log line, no argument. */
    if (!claimSlot(tpl.id, d.key, 'sending')) continue;

    let result;
    try {
      result = await sendReport(cfg, {
        template: tpl,
        report: tpl.report || null,
        team: (tpl.schedule || {}).team || null,
        components: (tpl.schedule || {}).components || [],
        /* NO PINNED SPRINT MEANS "WHICHEVER IS ACTIVE", and for a weekly
           sprint report that is the right default rather than an oversight:
           he wants Monday's mail to be about the sprint that is running on
           Monday, not the one that was running when he armed the schedule.
           `findSprint` resolves a null to the current sprint for that team,
           which is exactly the screen's own behaviour. */
        sprint: (tpl.schedule || {}).sprint || null,
        /* THE LENS PINS, unlike the sprint, because there is no "current
           family" for the server to resolve a null into. A weekly capacity
           plan armed on the PS family is a weekly PS capacity plan, and
           dropping it here would widen every Monday's attachment back to the
           whole portfolio — silently, since the figures would not move. */
        view: (tpl.schedule || {}).view || {},
        sprintLabel: '',
      }, { trigger: 'schedule' });
    } catch (err) {
      /* `sendReport` returns failures rather than throwing, so reaching here
         means something outside it broke. It still has to settle the row —
         a slot left at `sending` reads as a crash, and saying "crash" about a
         handled error would send him looking for the wrong thing. */
      settleSlot(tpl.id, d.key, 'failed', err.message);
      out.push({ template: tpl.id, slot: d.key, status: 'failed', error: err.message });
      continue;
    }

    const status = result.ok ? 'sent' : 'failed';
    settleSlot(tpl.id, d.key, status,
      result.ok ? `${mailSchedule.lateness(d.late)} — ${(result.recipients || []).length} recipients` : result.error);
    out.push({ template: tpl.id, slot: d.key, status, error: result.error || null });
  }
  return out;
}

/** The timer. Started from `listen`, never at require time — see the tick note. */
function startScheduler() {
  let running = false;
  const tick = async () => {
    /* ONE PASS AT A TIME. A send takes fifteen seconds for the PDF alone and
       the tick is sixty; a slow render plus a slow SMTP handshake could
       overlap two passes, and while the claim would stop a double send, the
       second pass would spend the time discovering that. */
    if (running) return;
    running = true;
    try { await runDueSchedules(new Date()); }
    catch (err) { try { store.audit('mail.schedule.error', { error: String(err.message).slice(0, 200) }); } catch { /* best effort */ } }
    finally { running = false; }
  };
  setTimeout(() => { tick(); setInterval(tick, SCHEDULE_TICK_MS).unref(); }, SCHEDULE_FIRST_TICK_MS).unref();
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
      /* ── THE SIDEBAR'S BACKLOG COUNT ──────────────────────────────────
         COUNTED HERE, FROM THE STORED KEY LIST, rather than read off
         `backlogCount`. The index is written at SYNC time, so a correction to
         what counts as a backlog item would otherwise not reach the sidebar
         until the next full sync — and in the meantime the sidebar would say
         1,877 beside a page saying 594. Both numbers on screen at once, neither
         wrong-looking on its own.

         `buildTeamIndex` now computes the same thing, so a synced index and
         this read agree; this is what makes the fix land immediately, and the
         shared `backlogLib` is what keeps the two from drifting. */
      teamIndex: Object.fromEntries(plan.teams.map(t => {
        const i = (snap.byTeam || {})[t.id] || {};
        const b = backlogLib.figuresFor(snap, i);
        return [t.id, {
          members: (t.members || []).filter(m => m.status !== 'Released').length,
          sprints: (i.sprints || []).length,
          backlog: b.count,
          backlogPoints: b.points,
          backlogSource: i.backlogSource || null,
          // What the raw list held, so the setup screen can explain a count
          // that is much smaller than the board's own.
          backlogScanned: b.scanned,
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
    const grid = insights.capacityView(plan, snap, team, sprint);
    /* THE "BY COMPONENT" SHEET IS ATTACHED HERE, not inside `capacityView`.
       `prioritization` already requires `insights` — for the sprint index and
       the epic walk — so building it there would close a require cycle. This
       is the composition point: the route knows both halves and neither
       module has to know the other twice. */
    grid.byComponent = prioritization.sprintComponents(snap, plan, { team, sprint });
    return json(res, 200, grid);
  }

  /* ONE CELL OF THE "BY COMPONENT" SHEET, LISTED.
     It re-runs the sheet and reads the cell's own key list rather than
     rebuilding the filter from this query string — see the note on
     `sprintComponentCell`. So the drawer cannot list a different set from the
     number that opened it, whatever changes about the counting rules later. */
  if (p === '/api/capacity/bycomponent/epics' && req.method === 'GET') {
    const plan = store.getPlan(), snap = store.getSnapshot();
    const team = findTeam(plan, q.get('team'));
    const sprint = findSprint(plan, q.get('sprint'), team.id);
    const out = prioritization.sprintComponentCell(snap, plan, {
      team, sprint,
      component: q.get('row') || null,
      tool: q.get('tool') || null,
      cell: q.get('cell') || null,
    });
    // Refused rather than ignored: an unknown column answering with an empty
    // list is a drawer that says 0 under a number saying 12.
    if (!out.ok) {
      return json(res, 400, {
        error: `No cell "${q.get('tool')}/${q.get('cell')}" on row "${q.get('row')}".`,
        known: out.known,
      });
    }
    return json(res, 200, { ...out, project: cfg.jira.projectKey || null });
  }

  /* ── THE ONE ROUTE THAT WRITES TO JIRA ────────────────────────────────
     Every other route in this file reads Jira and writes locally. This one
     changes a real issue in a real Jira, so it is the most careful thing
     here, and each guard below is for a failure that would otherwise be
     silent:

       · The closed-sprint rule fires for free, because the body names a team
         AND a sprint — see `readJsonBody`. Re-estimating a finished sprint
         rewrites history that velocity is computed from.

       · THE KEY MUST BE IN THAT SPRINT. Without it this is an open endpoint
         for editing any issue in the instance by key, which is not what a
         capacity grid is.

       · IT READS JIRA BEFORE WRITING. The local value came from the last
         sync and someone may have re-estimated since; writing blind would
         silently discard their number. `was` is what the screen showed, and
         a mismatch is refused with both values rather than resolved by
         guessing. This is the same rule as the mtime guard on committing a
         file back to his machine.

       · THE LOCAL COPY IS UPDATED FIELD-BY-FIELD, not by saving the whole
         snapshot — that would upsert 9,543 issues and run a soft-delete
         sweep for one number. */
  if (p === '/api/sprint/points' && req.method === 'PUT') {
    const body = await readJsonBody(req);           // closed-sprint guard runs here
    const plan = store.getPlan(), snap = store.getSnapshot();
    const key = String(body.key || '').trim().toUpperCase();
    if (!key) return json(res, 400, { error: 'Which issue?' });

    const team = (plan.teams || []).find(t => t.id === body.teamId);
    if (!team) return json(res, 404, { error: `No team "${body.teamId}".` });
    const sprint = (plan.sprints || []).find(s => s.id === body.sprintId);
    if (!sprint) return json(res, 404, { error: `No sprint "${body.sprintId}".` });

    const inSprint = new Set(insights.sprintIssueKeys(snap, team, sprint) || []);
    if (!inSprint.has(key)) {
      return json(res, 400, { error: `${key} is not in ${sprint.name || sprint.id} for ${team.name}.` });
    }

    /* A number or nothing. Clearing is a real edit — "nobody has estimated
       this" is not the same as "this is a zero" — so null is allowed and an
       empty string means null. Negative or non-numeric is refused rather
       than coerced into something Jira would accept. */
    const raw = body.points;
    /* A NUMBER, A NUMERIC STRING, OR NOTHING — and nothing else. The type
       check is not pedantry: `String([]).trim()` is the empty string, so an
       array would have read as "clear the estimate" and quietly wiped a
       number. Anything that is not a primitive is refused outright rather
       than coerced into whatever it stringifies to. */
    let points = null;
    const blank = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
    if (!blank) {
      if (typeof raw !== 'number' && typeof raw !== 'string') {
        return json(res, 400, { error: `${JSON.stringify(raw)} is not a points value.` });
      }
      points = Number(raw);
      if (!Number.isFinite(points) || points < 0) {
        return json(res, 400, { error: `"${raw}" is not a points value.` });
      }
    }

    const jira = new Jira(cfg.jira || {});
    if (!jira.configured) return json(res, 400, { error: 'Jira is not configured — add credentials in Settings.' });
    const field = jira.storyPointsField || (snap.fields || {}).storyPointsField;
    if (!field) return json(res, 400, { error: 'No Story Points field is known yet — run a sync first.' });
    jira.storyPointsField = field;

    try {
      const live = await jira.fieldValue(key, field);
      const liveNum = live == null ? null : Number(live);
      const wasNum = body.was == null || String(body.was).trim() === '' ? null : Number(body.was);
      if (liveNum !== wasNum) {
        return json(res, 409, {
          error: `${key} is ${liveNum == null ? 'unestimated' : `${liveNum} pts`} in Jira, not ${wasNum == null ? 'unestimated' : `${wasNum} pts`} as this screen showed. Somebody changed it — refresh and try again.`,
          jira: liveNum, expected: wasNum,
        });
      }
      if (liveNum === points) return json(res, 200, { ok: true, key, points, unchanged: true });

      await jira.setStoryPoints(key, points);
      /* JIRA FIRST, LOCAL SECOND. If the write fails the local copy still
         matches Jira, which is the state a reader can act on; the reverse
         order would leave this tool confidently showing a number Jira never
         accepted. */
      repo.writeField(key, 'points', points);
      /* The snapshot projection is CACHED — without this the grid, the
         capacity totals and the velocity all keep serving the old number
         until something else happens to invalidate it, which is exactly the
         "screen shows a number the database no longer holds" failure the
         cache's own comment warns about. */
      store.invalidate();
      store.audit('jira.points.set', { key, from: liveNum, to: points, team: team.id, sprint: sprint.id });
      return json(res, 200, { ok: true, key, points, from: liveNum });
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  /* THE DUE DATE, the second field this tool writes to Jira.
     Deliberately the same shape as the points write above — the same guards
     in the same order, the same read-before-write, the same 409 — because
     the two are one interaction with two fields and a reader comparing them
     should find no surprises. What differs is only what a value IS. */
  if (p === '/api/sprint/duedate' && req.method === 'PUT') {
    const body = await readJsonBody(req);           // closed-sprint guard runs here
    const plan = store.getPlan(), snap = store.getSnapshot();
    const key = String(body.key || '').trim().toUpperCase();
    if (!key) return json(res, 400, { error: 'Which issue?' });

    const team = (plan.teams || []).find(t => t.id === body.teamId);
    if (!team) return json(res, 404, { error: `No team "${body.teamId}".` });
    const sprint = (plan.sprints || []).find(s => s.id === body.sprintId);
    if (!sprint) return json(res, 404, { error: `No sprint "${body.sprintId}".` });

    const inSprint = new Set(insights.sprintIssueKeys(snap, team, sprint) || []);
    if (!inSprint.has(key)) {
      return json(res, 400, { error: `${key} is not in ${sprint.name || sprint.id} for ${team.name}.` });
    }

    /* A DATE OR NOTHING, and the format is checked rather than parsed. `new
       Date("03/04/2026")` is a real date in two different months depending on
       who typed it, and Jira would store whichever one it read — so anything
       that is not exactly YYYY-MM-DD is refused instead of guessed at. The
       same reasoning as the points guard next door: a non-primitive is
       refused outright rather than coerced into what it stringifies to. */
    const raw = body.dueDate;
    let due = null;
    const blank = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
    if (!blank) {
      if (typeof raw !== 'string') {
        return json(res, 400, { error: `${JSON.stringify(raw)} is not a date.` });
      }
      due = raw.trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(`${due}T00:00:00Z`))) {
        return json(res, 400, { error: `"${raw}" is not a date — it has to be YYYY-MM-DD.` });
      }
    }

    const jira = new Jira(cfg.jira || {});
    if (!jira.configured) return json(res, 400, { error: 'Jira is not configured — add credentials in Settings.' });

    try {
      /* Compared on the DATE, not the string Jira happens to return: the API
         answers `duedate` as a plain date today, but an issue read through a
         different endpoint can carry a time, and "2026-10-14" against
         "2026-10-14T00:00:00.000+0700" is a false conflict that no amount of
         refreshing would clear. */
      const liveRaw = await jira.fieldValue(key, 'duedate');
      const live = liveRaw == null || liveRaw === '' ? null : String(liveRaw).slice(0, 10);
      const wasRaw = body.was;
      const was = wasRaw == null || String(wasRaw).trim() === '' ? null : String(wasRaw).trim().slice(0, 10);
      if (live !== was) {
        return json(res, 409, {
          error: `${key} is ${live == null ? 'undated' : `due ${live}`} in Jira, not ${was == null ? 'undated' : `due ${was}`} as this screen showed. Somebody changed it — refresh and try again.`,
          jira: live, expected: was,
        });
      }
      if (live === due) return json(res, 200, { ok: true, key, dueDate: due, unchanged: true });

      await jira.setDueDate(key, due);
      // Jira first, local second — see the points route for why.
      repo.writeField(key, 'dueDate', due);
      store.invalidate();
      store.audit('jira.duedate.set', { key, from: live, to: due, team: team.id, sprint: sprint.id });
      return json(res, 200, { ok: true, key, dueDate: due, from: live });
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  /* ── MOVING A BACKLOG ITEM INTO A SPRINT ──────────────────────────────
     The third route in this file that writes to a real Jira, and the one that
     is least like the other two: Sprint is not a field PUT. The Agile
     endpoints do the board's bookkeeping as well as the value, and writing
     the sprint custom field directly leaves an issue carrying a sprint it
     does not appear in — see `jira.setSprint`.

     THE GUARDS ARE THE POINTS ROUTE'S, for the same reasons:

       · THE KEY MUST BE IN THIS TEAM'S BACKLOG. Without it this is an open
         endpoint for moving any issue in the instance into any sprint.

       · AN EPIC CANNOT BE MOVED. It is not a backlog item — it is the
         container — and Jira will usually accept the move and produce a
         sprint with an epic sitting in it, which is a mess to undo.

       · IT READS JIRA BEFORE WRITING. `was` is the sprint this screen showed;
         a mismatch is refused with both values rather than resolved by
         guessing, because the local copy is only as fresh as the last sync.

       · THE TARGET SPRINT MUST BE ONE OF THIS TEAM'S, and open. Jira refuses
         a closed sprint itself, with better information than this side has —
         but a sprint belonging to another team is something only the plan
         knows, and moving work into one silently is how a ticket vanishes
         from the board somebody is watching. */
  if (p === '/api/backlog/sprint' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const plan = store.getPlan(), snap = store.getSnapshot();
    const key = String(body.key || '').trim().toUpperCase();
    if (!key) return json(res, 400, { error: 'Which issue?' });

    const team = (plan.teams || []).find(t => t.id === body.teamId);
    if (!team) return json(res, 404, { error: `No team "${body.teamId}".` });

    const idx = (snap.byTeam || {})[team.id] || {};
    if (!(idx.backlog || []).includes(key)) {
      return json(res, 400, { error: `${key} is not in ${team.name}'s backlog.` });
    }
    const issue = (snap.issues || {})[key];
    if (!issue) return json(res, 404, { error: `No local copy of ${key} — run a sync first.` });
    if (!backlogLib.isBacklogItem(issue)) {
      return json(res, 400, { error: `${key} is an ${issue.issueType} — a container, not work you pull into a sprint.` });
    }

    /* THE TARGET, resolved against the PLAN's sprints for this team. `null`
       means the backlog, which is a real destination and the way a mistaken
       move is undone. */
    const toId = body.sprintId == null || body.sprintId === '' ? null : String(body.sprintId);
    let target = null;
    if (toId !== null) {
      target = (plan.sprints || []).find(x => x.id === toId);
      if (!target) return json(res, 404, { error: `No sprint "${toId}".` });
      const mine = target.byTeam && target.byTeam[team.id];
      if (!mine) return json(res, 409, { error: `${target.name || toId} is not one of ${team.name}'s sprints.` });
      if (mine.state === 'closed') {
        return json(res, 409, { error: `${mine.name || target.name} is closed — reopen it in Jira, or pick another sprint.` });
      }
      if (!mine.jiraId) {
        return json(res, 409, { error: `${mine.name || target.name} has no Jira sprint id yet — run a full sync.` });
      }
    }

    const jira = new Jira(cfg.jira || {});
    if (!jira.configured) return json(res, 400, { error: 'Jira is not configured — add credentials in Settings.' });

    try {
      /* WHAT JIRA SAYS IT IS IN NOW. Compared by NAME rather than by id: the
         screen showed a name, the local copy stores names beside ids, and a
         sprint the tool has never synced has no id here to compare against.
         Only OPEN sprints count — an issue carries every sprint it was ever
         in, and the closed ones are history, not where it is. */
      const live = await jira.openSprintsFor(key);
      const liveName = live.length ? live[live.length - 1].name : null;
      const wasName = body.was == null || String(body.was).trim() === '' ? null : String(body.was).trim();
      if (liveName !== wasName) {
        return json(res, 409, {
          error: `${key} is in ${liveName || 'the backlog'} in Jira, not ${wasName || 'the backlog'} as this screen showed. Somebody moved it — refresh and try again.`,
          jira: liveName, expected: wasName,
        });
      }

      const toName = target ? ((target.byTeam[team.id] || {}).name || target.name) : null;
      if (liveName === toName) return json(res, 200, { ok: true, key, sprintId: toId, unchanged: true });

      await jira.setSprint(key, target ? target.byTeam[team.id].jiraId : null);

      /* Jira first, local second — the same order the other two writes use.
         The local copy carries the whole sprint list, so the move REPLACES
         the open ones and keeps the closed history: an issue that was in
         Sprint 38 and is now in 41 was still in 38. */
      const kept = (issue.sprints || []).filter(x => x && x.state === 'closed');
      const next = target
        ? [...kept, {
          id: target.byTeam[team.id].jiraId,
          name: toName,
          state: target.byTeam[team.id].state || 'future',
          start: target.start || null,
          end: target.end || null,
        }]
        : kept;
      repo.writeField(key, 'sprints', next);
      store.invalidate();
      store.audit('jira.sprint.set', { key, from: liveName, to: toName, team: team.id });
      return json(res, 200, { ok: true, key, sprintId: toId, sprint: toName, from: liveName });
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
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
      /* HIS COMPONENT PRIORITIES, on the sprint's own component table.
         The same judgement the Coverage grid owns, attached to the rows this
         screen already renders rather than looked up in the browser from
         another page's payload — one row shape carrying its own priority is
         what stops two screens disagreeing about a component. Read-only here:
         the value is SET in one place, and two editors for one field is two
         places for it to drift. */
      testCases: view.testCases ? {
        ...view.testCases,
        rows: priority.decorate(view.testCases.rows, plan),
      } : view.testCases,
      priorityLevels: priority.LEVELS,
      /* WHETHER THIS SPRINT CAN STILL BE WRITTEN TO. The Points cells on this
         screen edit real Jira issues, and the server refuses a closed sprint
         — so the page needs to know before it renders, or it offers boxes
         that can only fail. The capacity route has carried this for the same
         reason; this screen only needed it once it gained an editable cell. */
      lock: lock.status(sprint, team.id),
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
          /* `??`, not a truthy pick: a team's copy of a sprint can carry no
             dates of its own, and a recorded `null` there means "Jira gave
             this row none" — in which case the traceable original is the
             calendar row's, not nothing. With `t.end ? t.jiraEnd : …` an
             overridden sprint showed his date with no way back to Jira's. */
          jiraEnd: (t.jiraEnd ?? s2.jiraEnd) || undefined,
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

    /* THE DRILL-IN HAS TO BE NARROWED THE SAME WAY THE NUMBER WAS.
       The Prioritization screen can exclude epics already planned into the
       active sprint, and it opens its cells through this route — so the same
       set is computed here, from the same function, rather than this route
       listing epics the count had excluded. `scopeTeam` is that screen's
       team scope, which also decides whose active sprint counts; the
       Coverage screen passes neither and is unaffected. */
    const scopeTeam = q.get('team') ? plan.teams.find(t => t.id === q.get('team')) : null;
    if (q.get('team') && !scopeTeam) return json(res, 404, { error: `No team "${q.get('team')}".` });
    const planned = q.get('excludeActiveSprint') === '1'
      ? prioritization.activeSprintEpics(plan, snap, scopeTeam ? [scopeTeam] : (plan.teams || []))
      : null;

    const opts = {
      components: q.getAll('component').filter(Boolean),
      scope: m.coverageScope || 'Epic',
      exclude: plan.excludedComponents || [],
      /* A team on THIS route means the Prioritization screen's scope, so the
         allow-list narrows to that team's Jira Team values — otherwise a
         drawer opened from a team-scoped page would list another team's
         epics under a number that never counted them. */
      teams: scopeTeam ? (scopeTeam.jiraTeams || []) : (plan.coverageTeams || []),
      omit: planned ? planned.keys : null,
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

  /* One component's note — the Notes column on the Prioritization screen.
     Its own route for the same reason the priority beside it has one, and the
     same two shapes: one row edited, or a whole map replaced. A blank note
     DELETES the key, so "has a note" means one thing however the row got
     there — see lib/component-note.js. */
  /* ── THE ORDER OF ONE PRIORITY LEVEL ──────────────────────────────────
     The body is the components of ONE level, in the order he dragged them
     into. The server numbers them — see lib/component-rank.js for why the
     browser does not send positions.

     THE LEVEL IS CHECKED, NOT TRUSTED. Every component in the list has to
     actually carry the level the request names, or a reordering of the P1s
     could renumber a P3 that happened to be in the payload — which would move
     a row on a screen nobody was looking at. A mismatch is refused with the
     offending component named, rather than partially applied.

     UNRANKED COMPONENTS IN OTHER LEVELS ARE UNTOUCHED, because `reorder`
     rewrites only the keys it is given. That is what lets this route take one
     level at a time instead of the whole sheet. */
  if (p === '/api/component-rank' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const plan = store.getPlan();

    /* THE GUARDS LIVE IN THE MODEL, so they are testable without a server and
       so a second caller cannot apply a reorder that skips them. */
    const checked = componentRank.validateOrder(plan, body.level, body.order);
    if (!checked.ok) return json(res, checked.status, { error: checked.error });
    const { order } = checked;
    const level = Number(body.level);

    const next = componentRank.reorder(plan.componentRank || {}, order);
    const { map, errors } = componentRank.validate(next);
    if (errors.length) return json(res, 400, { error: errors.map(e => e.message).join(' · '), errors });

    plan.componentRank = map;
    store.savePlan(plan);
    store.audit('componentRank.set', { level, components: order.length, total: Object.keys(map).length });
    return json(res, 200, { ok: true, componentRank: map, level, order });
  }

  if (p === '/api/component-note' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    const current = plan.componentNote || {};

    const next = body.component !== undefined
      ? componentNote.set(current, body.component, body.note ?? null)
      : (body.map || {});

    const { map, errors } = componentNote.validate(next);
    if (errors.length) return json(res, 400, { error: errors.map(e => e.message).join(' · '), errors });

    plan.componentNote = map;
    store.savePlan(plan);
    store.audit('componentNote.set', {
      component: body.component ?? null,
      // The text itself stays out of the audit trail: it is his working note,
      // and a log that quietly keeps every draft of it is not what a note is.
      cleared: !map[String(body.component ?? '').trim()],
      total: Object.keys(map).length,
    });
    return json(res, 200, { ok: true, componentNote: map, set: Object.keys(map).length });
  }

  /* THE PRIORITIZATION GRID — the components he has decided about, in each
     tool, with the note he keeps on each.

     Its own route rather than a slice of /api/reports/coverage: that payload
     is the whole 125-component portfolio with movement, attention and family
     rollups attached, and this page needs nine rows. It reads the same
     coverage view underneath, so the two screens cannot disagree — see
     lib/prioritization.js. */
  if (p === '/api/prioritization' && req.method === 'GET') {
    const snap = store.getSnapshot();
    const m = (cfg.metrics || {});
    const plan = store.getPlan();

    /* TEAM IS OPTIONAL AND RESOLVED STRICTLY — not through `findTeam`, which
       falls back to the first team when it does not recognise an id. That
       fallback is right for a capacity screen that must show something; here
       it would answer for Ruby a question asked about Titan, and the page
       would look completely normal while doing it. An unknown id is refused,
       and no id at all means every team. */
    const wanted = q.get('team') || '';
    const team = wanted ? plan.teams.find(t => t.id === wanted) : null;
    if (wanted && !team) return json(res, 404, { error: `No team "${wanted}".` });

    return json(res, 200, {
      ...prioritization.view(snap, plan, {
        scope: m.coverageScope || 'Epic', team,
        /* "What is NOT yet being picked up" — leaves out epics that already
           have Stories or Bucket Stories in the active sprint. */
        excludeActiveSprint: q.get('excludeActiveSprint') === '1',
      }),
      noteMax: componentNote.MAX,
      // So a row can open the epics it counted in Jira, against the same
      // project and issue type the numbers came from.
      project: cfg.jira.projectKey || null,
    });
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
    return json(res, 200, {
      teamId: team.id, teamName: team.jiraName || team.name,
      /* THE BOARD THE BACKLOG CAME FROM. When one is mapped these items are
         the board's own backlog, read from the Agile API — a set no JQL can
         reproduce, because a board is its filter plus sprint state. So the
         only link that opens ALL of it is the board's backlog view, and the
         screen needs the id to build one. */
      boardId: team.boardId || null,
      boardName: team.boardName || null,
      /* ── THE PLANNING BOARD ───────────────────────────────────────────
         The open sprints as SECTIONS, with their items — the comparison the
         page exists for, and the same set the Sprint picker offers, so every
         option has a section and every drag has somewhere to land.

         SENT WITH THE PAGE rather than fetched per row or per section: the
         picker is on every one of 594 rows, and 594 requests for the same six
         sprints is not a feature, it is a stampede. */
      ...insights.backlogBoard(plan, snap, team),
      ...metrics.backlogHealth(plan, snap, team),
    });
  }

  if (p === '/api/risks' && req.method === 'GET') {
    const plan = store.getPlan(), snap = store.getSnapshot();
    return json(res, 200, insights.riskView(plan, snap, { teamId: q.get('team') || null, sprintId: q.get('sprint') || null }));
  }

  /* THE SPRINT IS A FILTER HERE, NOT THE SCOPE — unlike `/api/risks` above.
     A risk is about a commitment and belongs to the sprint that carries it; a
     blocker outlives the sprint it was noticed in, and 496 of his 543 blocked
     items are nowhere near one. Passing no `sprint` is therefore the normal
     case rather than the degenerate one. */
  /* ────────────────────── EMAILING THE COVERAGE REPORT ──────────────────
   *
   * The only thing this tool does that leaves the building. Everything here
   * is arranged so that the mail he approves and the mail that goes out are
   * the same mail, and so that a send nobody watched leaves a record.
   *
   * THE PASSWORD NEVER COMES BACK OUT. `/api/mail/config` says whether mail
   * is set up and which address it would send from, and nothing else — a
   * screen that displayed the app password would put it in every screenshot
   * he ever takes of this page.
   */
  if (p === '/api/mail/config' && req.method === 'GET') {
    const m = cfg.mail || {};
    return json(res, 200, {
      configured: !!(m.host && m.from),
      host: m.host || null,
      port: Number(m.port || 587),
      from: m.from || null,
      fromName: m.fromName || null,
      authenticated: !!m.user,
      hasPass: !!m.pass,
      chrome: !!pdfRender.findChrome(),
      /* THE FIELDS FOR THE REPORT BEING ASKED ABOUT. The drawer is shared
         between screens, so it says which one it is on; an editor listing
         `{{committed}}` beside a coverage template would be offering a
         placeholder that can only ever come out as an em-dash. */
      report: reportMail.reportOf(q.get('report')).key,
      fields: reportMail.fieldsFor(q.get('report')).map(f => ({ key: f.key, label: f.label })),
      /* Every report, so the drawer can name the one it is on and the
         Settings screen could list them without a second route. */
      reports: Object.values(reportMail.REPORTS)
        .map(r => ({ key: r.key, label: r.label, defaultFilename: r.defaultFilename })),
    });
  }

  /**
   * SAVE THE MAIL SETTINGS from the screen.
   *
   * A BLANK PASSWORD MEANS "KEEP THE ONE YOU HAVE", and that is not a
   * convenience — the field cannot be pre-filled (nothing ever sends the
   * password back), so treating blank as "clear it" would wipe his app
   * password every time he corrected a typo in the port. Clearing is its own
   * explicit act.
   */
  if (p === '/api/mail/config' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const current = cfg.mail || {};
    /* AN ABSENT PORT DEFAULTS; A NONSENSE ONE IS AN ERROR. `Number(x) || 587`
       collapses the two, so a typed 0 — or "eighty" — silently became 587 and
       the only sign was a connection to a port he did not choose. Blank means
       "use the usual"; anything else has to be a port. */
    const givenPort = body.port === '' || body.port == null;
    const patch = {
      host: String(body.host || '').trim(),
      port: givenPort ? 587 : Number(body.port),
      user: String(body.user || '').trim(),
      from: String(body.from || '').trim(),
      fromName: String(body.fromName || '').trim(),
    };
    /* `smtp.appPassword` RATHER THAN `.trim()`. A Google app password is
       copied off the page with the spaces that display it in fours, and stored
       that way it fails authentication with a message about the password being
       wrong. Cleaned on the way in so the file holds what actually works; the
       same call sits in front of AUTH, which is what repairs a config that was
       already saved with the spaces in it. */
    if (body.clearPass) patch.pass = '';
    else if (String(body.pass || '').trim()) patch.pass = smtp.appPassword(body.pass);
    else patch.pass = current.pass || '';

    /* CHECKED HERE, not only in the browser. A port of 0 or a From that is not
       an address fails at send time with an SMTP error nobody can read; caught
       on save it is one sentence beside the field. */
    const errors = [];
    if (!patch.host) errors.push('A mail server is needed — smtp.gmail.com for a Google account.');
    if (!(patch.port > 0 && patch.port < 65536)) errors.push('The port must be a number between 1 and 65535.');
    if (!patch.from) errors.push('A From address is needed — the mail has to come from somewhere.');
    else if (!mimeLib.isEmail(patch.from)) errors.push(`"${patch.from}" does not look like an email address.`);
    if (patch.user && !mimeLib.isEmail(patch.user)) errors.push(`"${patch.user}" does not look like an email address.`);
    if (errors.length) return json(res, 400, { error: errors.join(' '), errors });

    const saved = saveConfig({ mail: patch });
    store.audit('mail.config.save', { host: patch.host, hasPass: !!patch.pass });
    return json(res, 200, { ok: true, mail: redact(saved).mail });
  }

  /**
   * SEND ONE TEST MESSAGE — to himself, and only to himself.
   *
   * THE RECIPIENT IS NOT A PARAMETER. It is always the configured From
   * address, so this button cannot be pointed at anybody else: a "test" that
   * took a recipient is a way to mail a stranger from his account with no
   * template, no preview and no record that reads like a real send.
   *
   * It carries no PDF. What is being tested is the password and the route out
   * — Chrome is a separate question, answered on the setup panel by whether
   * it was found at all.
   */
  if (p === '/api/mail/test' && req.method === 'POST') {
    const mail = cfg.mail || {};
    if (!mail.host || !mail.from) return json(res, 400, { error: 'Fill in the mail settings and save them first.' });
    const to = mimeLib.bare(mail.from);
    try {
      const msg = mimeLib.build({
        from: mail.fromName ? `${mail.fromName} <${to}>` : to,
        to: [to],
        subject: 'Planning Tool — test message',
        text: 'This is a test from the Planning Tool.\n\n'
          + 'If you are reading it, the mail settings work and "Email the report" can send.\n\n'
          + `Server: ${mail.host}:${mail.port || 587}\nSent: ${new Date().toISOString()}`,
      });
      const sent = await smtp.send(mail, { ...msg, from: to });
      dbLib.run('INSERT INTO mail_log (at, template, subject, recipients, ok, detail, bytes, trigger) VALUES (?,?,?,?,?,?,?,?)',
        new Date().toISOString(), null, 'Planning Tool — test message', to, 1, sent.response, null, 'test');
      return json(res, 200, { ok: true, to, response: sent.response });
    } catch (err) {
      dbLib.run('INSERT INTO mail_log (at, template, subject, recipients, ok, detail, bytes, trigger) VALUES (?,?,?,?,?,?,?,?)',
        new Date().toISOString(), null, 'Planning Tool — test message', to, 0, String(err.message).slice(0, 500), null, 'test');
      return json(res, 200, { ok: false, to, error: err.message });
    }
  }

  if (p === '/api/mail/templates' && req.method === 'GET') {
    const plan = store.getPlan();
    return json(res, 200, { templates: plan.mailTemplates || [] });
  }

  if (p === '/api/mail/template' && (req.method === 'PUT' || req.method === 'POST' || req.method === 'DELETE')) {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    plan.mailTemplates = plan.mailTemplates || [];
    if (req.method === 'DELETE') {
      if (!plan.mailTemplates.some(t => t.id === body.id)) return json(res, 404, { error: 'No such template.' });
      plan.mailTemplates = plan.mailTemplates.filter(t => t.id !== body.id);
    } else {
      const v = reportMail.validate(body);
      if (!v.ok) return json(res, 400, { error: v.errors.join(' '), errors: v.errors });
      const existing = body.id ? plan.mailTemplates.find(t => t.id === body.id) : null;
      if (body.id && !existing) return json(res, 404, { error: 'No such template.' });
      const row = {
        ...v.template,
        id: existing ? existing.id : reportMail.newId(),
        createdAt: existing ? existing.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      plan.mailTemplates = existing
        ? plan.mailTemplates.map(t => (t.id === row.id ? row : t))
        : [...plan.mailTemplates, row];
    }
    store.savePlan(plan);
    store.audit(`mail.template.${req.method.toLowerCase()}`, { id: body.id || body.name });
    return json(res, 200, { ok: true, templates: plan.mailTemplates });
  }

  /* THE PREVIEW RENDERS NOTHING AND SENDS NOTHING. It answers one question —
     what would the client read — and it goes through `reportMail.compose`,
     the same function the send uses, so the two cannot drift. Chrome is not
     started: a preview that took fifteen seconds is a preview nobody waits
     for, and it is the WORDS that need checking before they leave. */
  if (p === '/api/mail/preview' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    const v = reportMail.validate(body.template || {});
    if (!v.ok) return json(res, 400, { error: v.errors.join(' '), errors: v.errors });
    /* THE TEMPLATE'S OWN KIND, exactly as the send resolves it — the preview
       is only worth anything if it is the same composition. */
    let report;
    try {
      report = figuresFor(v.template.report, cfg, plan, body);
    } catch (err) {
      /* 400 AND A SENTENCE, not a 500 and a stack trace. "There is no active
         sprint" is something he can act on; "Cannot read properties of
         undefined" is something he has to come and ask about. */
      return json(res, 400, { error: `This report could not be built — ${err.message}` });
    }
    const m = reportMail.compose(v.template, report, {
      from: (cfg.mail || {}).from || '', fromName: (cfg.mail || {}).fromName || '',
    });
    return json(res, 200, {
      ...m,
      warnings: v.warnings,
      attachmentName: reportMail.pdfName(report, v.template),
      figures: report,
    });
  }

  /**
   * WHAT THE SCHEDULE HAS ACTUALLY BEEN DOING.
   *
   * An unattended feature needs a screen, or it is a rumour. This is that
   * screen's data: for each armed template, when it next goes out and what
   * happened the last few times it did — including the slots that were
   * `missed` because the machine was asleep, which are the ones he would
   * otherwise mistake for the tool being broken.
   */
  if (p === '/api/mail/schedule' && req.method === 'GET') {
    const plan = store.getPlan();
    const now = new Date();
    const rows = (plan.mailTemplates || []).filter(t => t && t.schedule && t.schedule.enabled);
    return json(res, 200, {
      now: now.toISOString(),
      grace: mailSchedule.GRACE_MS,
      scheduled: rows.map(t => ({
        id: t.id,
        name: t.name,
        schedule: t.schedule,
        describes: mailSchedule.describe(t.schedule),
        nextRun: mailSchedule.nextSlotAfter(t.schedule, now).toISOString(),
        recipients: [...(t.to || []), ...(t.cc || [])].length,
        runs: dbLib.all('SELECT slot, claimed, status, detail FROM mail_schedule_run WHERE template = ? ORDER BY slot DESC LIMIT 8', t.id),
      })),
    });
  }

  /**
   * RENDER THE ATTACHMENT AND HAND IT STRAIGHT BACK — no mail, no recipients.
   *
   * The PDF is the half of this feature he cannot check. The preview shows
   * the words; the document is produced by a headless browser he never sees,
   * and the first version of that renderer hung for sixty seconds and told
   * him nothing useful. Until now the only way to find out whether it worked
   * was to send something to a client.
   *
   * GET RATHER THAN POST, deliberately: it means the button is a link, the
   * PDF opens in a tab, and he is looking at the actual bytes that would have
   * been attached rather than a reassuring green tick. A render failure comes
   * back as text he can read instead of a broken download.
   */
  if (p === '/api/mail/preview-pdf' && req.method === 'GET') {
    const landscape = q.get('landscape') !== '0';
    const port = (server.address() && server.address().port) || cfg.server.port;
    /* THE REPORT DECIDES THE PAGE AND THE SCOPE, the same way the send does.
       A `route` can still be passed for anything that needs one directly, but
       the drawer names the report and lets this resolve it — one mapping, not
       one here and another in the browser. */
    const kind = reportMail.reportOf(q.get('report'));
    const url = pdfRender.reportUrl(`http://127.0.0.1:${port}`, {
      route: q.get('route') || kind.route,
      team: q.get('team') || null,
      landscape,
      sprint: kind.scope === 'sprint' ? (q.get('sprint') || null) : null,
      /* CARRIED THROUGH, or this button would check a different document from
         the one a send produces — which is worse than not having the button,
         because it would report the wrong thing confidently. */
      components: kind.scope === 'components' ? q.getAll('component').filter(Boolean) : [],
      // The lens travels for the same reason, one field on.
      view: { family: q.get('family') || null, showAll: q.get('showall') === '1' },
    });
    try {
      const outFile = await pdfRender.render(url, { landscape });
      const body = fs.readFileSync(outFile.file);
      try { fs.rmSync(path.dirname(outFile.file), { recursive: true, force: true }); } catch { /* temp */ }
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': body.length,
        /* `inline` so it opens rather than lands in Downloads — this is a
           thing to look at, not a file to keep. */
        'Content-Disposition': 'inline; filename="coverage-test.pdf"',
        'Cache-Control': 'no-store',
        'X-Render-Ms': String(outFile.ms || 0),
      });
      return res.end(body);
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`The PDF could not be rendered.\n\n${err.message}\n`);
    }
  }

  if (p === '/api/mail/log' && req.method === 'GET') {
    const rows = dbLib.all('SELECT * FROM mail_log ORDER BY at DESC, id DESC LIMIT 100');
    return json(res, 200, { sends: rows.map(r => ({ ...r, ok: !!r.ok, recipients: String(r.recipients || '').split(' ').filter(Boolean) })) });
  }

  if (p === '/api/mail/send' && req.method === 'POST') {
    const body = await readJsonBody(req);
    return json(res, 200, await sendReport(cfg, body, { trigger: 'manual' }));
  }

  if (p === '/api/blockers' && req.method === 'GET') {
    const plan = store.getPlan(), snap = store.getSnapshot();
    return json(res, 200, blockersLib.blockerView(plan, snap, {
      teamId: q.get('team') || null,
      sprintId: q.get('sprint') || null,
    }));
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

  /* THE ISSUES BEHIND ONE RULE'S WIN COUNT.
     Computed from the SAVED rules, never from a draft in the browser, because
     the number this opens was computed from the saved rules too — a drawer
     answering for a different rule set than the figure beside it is worse than
     no drawer at all. The editor blanks its counts the moment you edit, so
     there is no button to press while the two could disagree.

     CAPPED, AND IT SAYS SO. His `issueType = Story` rule wins 3,369 issues: a
     drawer of three thousand rows helps nobody and the payload is most of a
     megabyte. The first N come back with the TRUE total beside them, so the
     panel can say what it is showing rather than quietly showing less. */
  if (p === '/api/category-rules/winners' && req.method === 'GET') {
    const ruleId = url.searchParams.get('rule') || '';
    const LIMIT = 300;
    const plan = store.getPlan();
    const issues = Object.values(store.getSnapshot().issues || {});
    const found = classify.winnersOf(issues, plan.categoryRules, ruleId, { limit: LIMIT });
    if (!found.known) return json(res, 404, { error: `No rule "${ruleId}" among the saved rules` });
    const rule = (plan.categoryRules || classify.DEFAULT_RULES).find(r => r.id === ruleId) || null;
    const keys = found.keys;
    const byKey = new Map(issues.map(i => [String(i.key).toUpperCase(), i]));
    const catalogue = {};
    for (const k of keys) {
      const i = byKey.get(String(k).toUpperCase());
      if (i) catalogue[String(k).toUpperCase()] = { key: i.key, summary: i.summary || '', status: i.status || '', statusCategory: i.statusCategory || '', type: i.issueType || '', kind: 'item' };
    }
    return json(res, 200, {
      ruleId, rule, keys, catalogue,
      total: found.total, shown: found.shown, truncated: found.truncated,
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

  /* ON THE ROSTER, OUT OF THE CAPACITY ARITHMETIC.
     Their hours stop being counted; their committed work does not — see
     `sprintGrid`, where the same reasoning already governs released members.
     Per sprint, and clearing it deletes the key rather than storing a false. */
  if (p === '/api/calc-exempt' && req.method === 'PUT') {
    const body = await readJsonBody(req);   // { teamId, sprintId, memberId, exempt }
    const plan = store.getPlan();
    const team = findTeam(plan, body.teamId);
    assertSprintOpen(team.id, body.sprintId);
    plan.calcExempt = plan.calcExempt || {};
    const key = `${team.id}|${body.sprintId}|${body.memberId}`;
    if (body.exempt) plan.calcExempt[key] = true; else delete plan.calcExempt[key];
    store.savePlan(plan);
    store.audit('capacity.exempt', { teamId: team.id, sprintId: body.sprintId, memberId: body.memberId, exempt: !!body.exempt });
    return json(res, 200, { ok: true, exempt: !!body.exempt });
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

  /**
   * THE BLOCKER REGISTER — what he knows and Jira does not.
   *
   * Shaped like `/api/risk` above, and validated in ways that one is not,
   * because this record carries ISSUE KEYS. A risk is prose and a bad field
   * is visible the moment anybody reads it; a blocker naming AUTOKAT-9999
   * renders perfectly, is counted in every figure on the page, and is wrong
   * in a way nothing on screen can show.
   *
   * LINKED ITEMS ARE OPTIONAL. "The staging environment is down" is a real
   * blocker before anybody has worked out which tickets it is holding, and a
   * form that refused it would train people to invent a link.
   *
   * A KEY IS NOT CHECKED AGAINST THE BLOCKED LIST, only against the store.
   * The thing he is registering is usually the reason an item is NOT yet in
   * Refinement — an item about to be blocked is exactly what a lead wants to
   * record — so demanding it already be stuck would refuse the most useful
   * moment to write it down. Unknown keys are refused; wrong-status ones are
   * his call.
   */
  if (p === '/api/blocker' && (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE')) {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    plan.blockers = plan.blockers || [];

    if (req.method === 'DELETE') {
      if (!plan.blockers.some(b => b.id === body.id)) return json(res, 404, { error: 'No such blocker.' });
      plan.blockers = plan.blockers.filter(b => b.id !== body.id);
    } else {
      const title = String(body.title == null ? '' : body.title).trim();
      if (!title) return json(res, 400, { error: 'A blocker needs a title — what is holding the work up.' });

      /* KEYS ARE NORMALISED AND DE-DUPLICATED BEFORE THEY ARE CHECKED.
         They arrive from a picker and from a typed box, so the same ticket
         reaches here as `autokat-9831` and `AUTOKAT-9831 ` — stored as two,
         it would be counted as two on every figure this page reports. */
      const snap = store.getSnapshot();
      const seen = new Set();
      const items = (Array.isArray(body.items) ? body.items : [])
        .map(k => String(k == null ? '' : k).trim().toUpperCase())
        .filter(k => k && !seen.has(k) && seen.add(k));
      const missing = items.filter(k => !(snap.issues || {})[k]);
      if (missing.length) {
        return json(res, 404, {
          error: `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''} `
            + `${missing.length === 1 ? 'is' : 'are'} not in the local store — check the key, or run a sync.`,
        });
      }

      const fields = {
        title,
        severity: ['high', 'medium', 'low'].includes(body.severity) ? body.severity : 'medium',
        category: String(body.category || '').trim(),
        owner: String(body.owner || '').trim(),
        detail: String(body.detail || '').trim(),
        action: String(body.action || '').trim(),
        blockerKey: String(body.blockerKey || '').trim().toUpperCase(),
        status: body.status === 'Resolved' ? 'Resolved' : 'Open',
        teamId: String(body.teamId || '').trim(),
        teamName: String(body.teamName || '').trim(),
        items,
      };

      if (req.method === 'PUT') {
        if (!plan.blockers.some(b => b.id === body.id)) return json(res, 404, { error: 'No such blocker.' });
        plan.blockers = plan.blockers.map(b => (b.id === body.id
          ? { ...b, ...fields, updatedAt: new Date().toISOString() }
          : b));
      } else {
        /* NOT `b${Date.now()}` alone, which is what the risk route above
           does. `blocker.id` is a PRIMARY KEY written with INSERT OR REPLACE,
           so two records created inside the same millisecond — one click of
           "Take it on" on two cards, or any scripted batch — collide, and the
           second silently replaces the first. Somebody's typed note vanishing
           with no error is the worst shape a bug can have. */
        const id = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        plan.blockers.push({ ...fields, id, createdAt: new Date().toISOString() });
      }
    }

    store.savePlan(plan);
    store.audit(`blocker.${req.method.toLowerCase()}`, { id: body.id || body.title });
    return json(res, 200, { ok: true, blockers: plan.blockers });
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

  /* A SPRINT'S REAL SPAN, where Jira's is wrong.
     Jira records what someone clicked, not what the team did: "TT Week 14Sep"
     is stored 13–27 Sep and really ran 14–30 Sep. Nothing derivable from the
     timestamps can find that, so it is a decision, and decisions live in the
     plan where no sync can reach them. Sending no dates clears the override
     and Jira's own figures come back. */
  if (p === '/api/sprint/dates' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const plan = store.getPlan();
    const id = String(body.sprintId || '').trim();
    const sprint = plan.sprints.find(x => x.id === id);
    if (!sprint) return json(res, 404, { error: `No sprint with id "${id}".` });

    plan.sprintDates = plan.sprintDates || {};
    const iso = (v) => (v == null || v === '' ? null : String(v).slice(0, 10));
    const start = iso(body.start);
    const end = iso(body.end);

    if (!start && !end) {
      delete plan.sprintDates[id];
      store.savePlan(plan);
      store.audit('sprint.dates.cleared', { sprintId: id, name: sprint.name });
      return json(res, 200, { ok: true, cleared: true, sprintDates: plan.sprintDates });
    }
    // Both or neither: half an override leaves the other end on Jira's value
    // and produces a span nobody chose.
    if (!start || !end) return json(res, 400, { error: 'Give both a start and an end, or neither to clear.' });
    const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
    if (!ok(start) || !ok(end)) return json(res, 400, { error: 'Dates must be YYYY-MM-DD.' });
    if (end < start) return json(res, 400, { error: 'The end date is before the start.' });

    plan.sprintDates[id] = { start, end };
    store.savePlan(plan);
    store.audit('sprint.dates.set', { sprintId: id, name: sprint.name, start, end });

    // What it works out to, so the caller can check the number it came for
    // rather than re-deriving the working-day rule at the other end.
    const span = sprintDates.normalise({ start, end });
    return json(res, 200, {
      ok: true, sprintId: id, name: sprint.name, start, end,
      workingDays: span ? span.workingDays : null,
      sprintDates: plan.sprintDates,
    });
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
    } else if (what === 'prioritization') {
      /* THE SHEET HE ALREADY KEEPS, in the shape he keeps it — one row per
         ranked component, the seven Automation Status columns under each tool,
         and his note last. Built from the same `prioritization.view` the screen
         renders, so the file and the page cannot disagree, and it exports the
         WHOLE list whatever level chip happens to be on: a CSV of the rows that
         survived a filter is the trap the Backlog export already avoids. */
      /* WHAT THE FILE FOLLOWS, AND WHAT IT DELIBERATELY DOES NOT.
         Team and "exclude active sprint items" are SCOPES — they change which
         epics the numbers are counted over, so a file that ignored them would
         carry different figures from the screen that produced it, under the
         same column headings. Both travel.

         The level and family chips are LENSES: they hide rows, they do not
         change a number. The file carries the whole list and a Family column,
         so the reader filters in the spreadsheet — which is what a spreadsheet
         is for, and avoids the trap of a CSV that is silently the shortlist
         somebody happened to be looking at. */
      const pzTeam = q.get('team') ? plan.teams.find(t => t.id === q.get('team')) : null;
      if (q.get('team') && !pzTeam) return json(res, 404, { error: `No team "${q.get('team')}".` });
      const pzExclude = q.get('excludeActiveSprint') === '1';
      const v = prioritization.view(snap, plan, {
        scope: (cfg.metrics || {}).coverageScope || 'Epic', team: pzTeam, excludeActiveSprint: pzExclude,
      });
      name = `prioritization${pzTeam ? `-${pzTeam.id}` : ''}${pzExclude ? '-not-in-sprint' : ''}`;
      const grid = (r) => Object.assign({}, ...v.tools.map(t => Object.fromEntries(
        v.buckets.map(b => [`${t.label} — ${b.label}`, r[t.key][b.key]]))));
      rows = v.rows.map(r => Object.assign(
        {
          Component: r.component,
          Priority: r.priorityLabel || '',
          // The short name, not "PS — client delivery": this is a column to
          // group by in a pivot, and the explanation belongs on the screen.
          Family: coverage.familyShort(coverage.familyOf(r.component)),
        },
        grid(r),
        { Notes: r.note || '' },
      ));
      /* The totals the screen already shows, labelled as a total rather than
         left for the reader to sum — a component can be counted under both
         tools, so the two tool columns are not addable across each other and
         somebody will try. */
      if (rows.length) {
        rows.push(Object.assign(
          { Component: `Total — ${v.rows.length} components`, Priority: '', Family: '' },
          Object.assign({}, ...v.tools.map(t => Object.fromEntries(
            v.buckets.map(b => [`${t.label} — ${b.label}`, v.totals[t.key][b.key]])))),
          { Notes: '' },
        ));
      }
    } else if (what === 'bycomponent') {
      /* THE CAPACITY SHEET, in the shape it is read on screen — one row per
         ranked suite, the backlog trio then the planned pair under each tool,
         and his note last. Built from the same `sprintComponents` the screen
         renders, so the file and the page cannot disagree about a number.

         WHAT THE FILE FOLLOWS AND WHAT IT DOES NOT — the same split the
         Prioritization export makes. Team and sprint are SCOPES: they decide
         which epics were counted at all, so both travel and both are in the
         filename. The family chip and the clear-row fold are LENSES: they
         hide rows without changing a number, so the file carries the WHOLE
         list plus a Family column and a Clear column, and the reader filters
         in the spreadsheet. A CSV that is silently whichever twenty rows
         somebody was looking at is the trap every other export here avoids.

         THE KEYS TRAVEL WITH THE COUNTS, as they do in the test-case export.
         On screen every number opens a drawer listing exactly what it
         counted; a file of the numbers alone is the one copy of this table
         nobody can audit, and the first question asked of a spreadsheet is
         always "which ones". Semicolon-joined so a cell stays one cell. */
      const v = prioritization.sprintComponents(snap, plan, {
        team, sprint, scope: (cfg.metrics || {}).coverageScope || 'Epic',
      });
      name = `by-component-${team.id}-${sprint.id}`;
      /* THE HEADINGS CARRY THEIR OWN SCOPE, because the two halves are
         counted over different populations and a forwarded spreadsheet has no
         scope line to read. "Backlog (all teams)" beside "<Sprint> Planned"
         says it in the only place the file can. */
      const cols = [
        ...v.backlogBuckets.map(b => ({ key: b.key, label: `Backlog (all teams) — ${b.label}` })),
        ...v.plannedCols.map(c => ({ key: c.key, label: `${v.sprint ? v.sprint.label : 'Sprint'} Planned — ${c.label}` })),
      ];
      const grid = (r) => Object.assign({}, ...v.tools.map(t => Object.fromEntries(
        cols.map(c => [`${t.label} — ${c.label}`, r[t.key][c.key]]))));
      const keyCols = (r) => Object.assign({}, ...v.tools.map(t => Object.fromEntries(
        cols.map(c => [`${t.label} — ${c.label} keys`, ((r[t.key].keys || {})[c.key] || []).join('; ')]))));
      rows = v.rows.map(r => Object.assign(
        {
          Component: r.component,
          Priority: r.priorityLabel || '',
          // The short name, not "PS — client delivery": this is a column to
          // group by in a pivot, and the explanation belongs on the screen.
          Family: coverage.familyShort(r.family),
          /* THE FOLD, AS A COLUMN. The screen hides these rows by default and
             the file keeps them — so the column says which ones they are,
             rather than leaving a reader to work out why the sheet has 129
             rows and the screen showed seventeen. */
          Clear: r.empty ? 'yes' : '',
        },
        grid(r),
        { Notes: r.note || '' },
        keyCols(r),
      ));
      /* The totals the screen shows, labelled as a total rather than left for
         the reader to sum — an epic in two components is counted in both
         rows, so the column does not add up to the distinct figure and
         somebody will try. */
      if (rows.length) {
        rows.push(Object.assign(
          { Component: `Total — ${v.rows.length} components`, Priority: '', Family: '', Clear: '' },
          Object.assign({}, ...v.tools.map(t => Object.fromEntries(
            cols.map(c => [`${t.label} — ${c.label}`, v.totals[t.key][c.key]])))),
          { Notes: '' },
        ));
      }
    } else if (what === 'testcases') {
      /* THE TEST-CASE GRID FROM THE ACTIVE SPRINT, built from the same
         `activeSprintView` the screen renders and decorated with the same
         priority, so the file and the page cannot disagree about a number.

         THE KEYS TRAVEL WITH THE COUNTS. On screen every one of these numbers
         opens a drawer listing exactly what it counted; a CSV of the numbers
         alone would be the one copy of this table you cannot audit, and the
         first question asked of a spreadsheet is always "which ones". They are
         semicolon-joined so a cell stays one cell.

         UNCLASSIFIED IS A COLUMN HERE, not a footnote. On screen it is a note
         under the table explaining why Maintained and Maintaining add up to
         less than the links; in a sheet that someone will total, the remainder
         has to be a number in a column or the totals look wrong. */
      const v = insights.activeSprintView(plan, snap, team, sprint);
      const t = v.testCases || { rows: [], totals: {} };
      const rows_ = priority.decorate(t.rows || [], plan);
      name = `test-cases-${team.id}-${sprint.id}`;
      const line = (label, r) => ({
        Component: label,
        Priority: r.priorityLabel || '',
        Automated: r.automated, 'In flight': r.inFlight,
        Maintained: r.maintained, Maintaining: r.maintaining,
        Blocked: r.blocked, 'No automation status': r.unclassified,
        'Automated keys': ((r.keys || {}).automated || []).join('; '),
        'In flight keys': ((r.keys || {}).inFlight || []).join('; '),
        'Maintained keys': ((r.keys || {}).maintained || []).join('; '),
        'Maintaining keys': ((r.keys || {}).maintaining || []).join('; '),
        'Blocked keys': ((r.keys || {}).blocked || []).join('; '),
        'No automation status keys': ((r.keys || {}).unclassified || []).join('; '),
      });
      rows = rows_.map(r => line(r.component, r));
      /* The sprint total as the screen states it — DISTINCT, not the rows added
         up. An item in two components is in two rows, so a reader who sums the
         column gets a bigger number than the page shows and assumes the page is
         wrong. The label says which one this is. */
      if (rows.length) rows.push(line('Sprint total (distinct)', { ...t.totals, priorityLabel: '' }));
    } else if (what === 'blockers') {
      const v = blockersLib.blockerView(plan, snap, { teamId: team.id });
      name = `blockers-${team.id}`;
      /* THE ITEMS TRAVEL WITH EVERY ROW. A CSV saying "CLICMNTIGO-11567 — 15
         items" and not naming them is a number somebody has to come back to
         this screen to use, which defeats exporting it. */
      rows = v.detected.map(g => ({
        Kind: 'Detected', Severity: g.severity, Blocker: g.key,
        Summary: g.summary || (g.local ? '' : '(in a project this tool does not sync)'),
        Status: g.status || '', Items: g.count, Points: g.points,
        'Via epic': g.via.join(' '), Keys: g.items.join(' '), Owner: '', Action: '',
      }));
      if (v.unrecorded.count) {
        rows.push({
          Kind: 'Detected', Severity: 'high', Blocker: '(nothing recorded)',
          Summary: 'In Refinement with no blocker named on the epic',
          Status: '', Items: v.unrecorded.count, Points: v.unrecorded.points,
          'Via epic': '', Keys: v.unrecorded.items.join(' '), Owner: '',
          Action: 'Register a blocker against these, or refine them',
        });
      }
      rows = rows.concat(v.manual.map(b => ({
        Kind: 'Register', Severity: b.severity || 'medium', Blocker: b.blockerKey || '',
        Summary: b.title, Status: b.status || 'Open',
        Items: (b.items || []).length, Points: '',
        'Via epic': b.category || '', Keys: (b.items || []).join(' '),
        Owner: b.owner || '', Action: b.action || '',
      })));
    } else if (what === 'risks') {
      const v = insights.riskView(plan, snap, { teamId: team.id });
      name = `risks-${team.id}`;
      rows = v.signals.map(s => ({ Severity: s.severity, Category: s.category, Team: s.teamName, Title: s.title, Detail: s.detail, Action: s.action }))
        .concat(v.manual.map(s => ({ Severity: s.severity, Category: s.category || 'Manual', Team: s.teamName || '', Title: s.title, Detail: s.detail || '', Action: s.mitigation || '' })));
    }
    /* A BYTE-ORDER MARK, because "CSV" means "opens in Excel" and Excel reads a
       UTF-8 file without one as the local 8-bit codepage: the em dashes this
       app uses in "— no component —" and "In flight" come out as mojibake, on
       the row a reader is most likely to query. Their own parser already
       strips a leading BOM, so a file exported and re-imported round-trips. */
    const body = `\ufeff${csv.stringify(rows)}`;
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
module.exports = { server, handleApi, captureScenario, applyScenario, runDueSchedules };

if (process.env.PORT !== '0') {
  server.listen(cfg.server.port, '127.0.0.1', () => {
    const url = `http://localhost:${cfg.server.port}`;
    console.log(`\n  Automation Planning Tool  →  ${url}`);
    console.log(`  Data: ${store.STORE_DIR}`);
    console.log(cfg.jira.apiToken ? `  Jira: ${cfg.jira.baseUrl} (${cfg.jira.projectKey})` : '  Jira: not configured yet — open Settings in the app.');

    /* THE SCHEDULER STARTS HERE, INSIDE `listen`, AND NOWHERE ELSE.
       A scheduled send renders its PDF by pointing Chrome at this server's own
       address, so it cannot usefully exist before the socket does. Starting it
       at require time would also run it under every test that imports this
       file, and a suite that quietly opens SMTP connections is a bad
       afternoon. `PORT=0` is how the tests get in, and they never take this
       branch.

       WHAT IS SCHEDULED IS PRINTED AT STARTUP, because an unattended feature
       that leaves no trace until it fires is one he has to take on faith. One
       line at boot is where he finds out that the schedule he set last month
       is still armed — or that it quietly is not. */
    try {
      const armed = (store.getPlan().mailTemplates || []).filter(t => t && t.schedule && t.schedule.enabled);
      if (armed.length) {
        console.log(`  Mail: ${armed.length} scheduled report${armed.length > 1 ? 's' : ''} — `
          + armed.map(t => `${t.name}, ${mailSchedule.describe(t.schedule)}`).join('; '));
      }
    } catch { /* a plan that will not load is the app's problem, not this line's */ }

    startScheduler();
    console.log('  Ctrl-C to stop.\n');
  });
}
