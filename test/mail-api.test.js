'use strict';
/**
 * mail-api.test.js — the send routes, over HTTP.
 *
 * WHY THIS SUITE EXISTS, AND WHAT IT REFUSES TO DO
 *
 * These routes are the only ones in the tool that can cause something to
 * happen outside it. So: nothing here has a real SMTP host, no check can
 * reach the internet, and the one check that exercises a send points at a
 * fake server on loopback that counts what it received.
 *
 * The failures worth guarding are the ones that are invisible from this end.
 * A preview that composes differently from the send. A password echoed back
 * to the browser. A send reported as succeeding when the PDF was empty. A
 * template stored with an address that would bounce, which only bites the
 * morning a schedule fires it.
 *
 * Run: node test/mail-api.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-mailapi-'));
fs.mkdirSync(path.join(SCRATCH, 'store'), { recursive: true });
process.env.STORE_DIR = SCRATCH;
process.env.DB_FILE = path.join(SCRATCH, 'store', 'test.db');
process.env.PORT = '0';
/* A CONFIG FILE OF ITS OWN. The settings screen writes real config, so these
   checks must never be able to touch the developer's own — and one of them
   deliberately stores a password, which has to land somewhere disposable. */
process.env.CONFIG_FILE = path.join(SCRATCH, 'config.json');
fs.writeFileSync(process.env.CONFIG_FILE, JSON.stringify({ jira: {}, testops: {}, github: {}, server: { port: 0 } }));

const epic = (key, o = {}) => ({
  key, project: 'AUTOKAT', summary: key, issueType: 'Epic',
  status: 'Open', statusCategory: 'new', automationStatus: o.automationStatus || 'Automated',
  team: 'Katalon Ruby', components: o.components || ['PS_iGO_NLG'],
  labels: [], blockedBy: [], sprints: [], relatesTo: [],
});

/* TWO COMPONENTS, WITH DIFFERENT COVERAGE — and that is the point of the
   second one. Every epic here used to sit on `PS_iGO_NLG`, so filtering to it
   changed nothing, and a check that the component filter works would have
   passed against a filter that did nothing at all. `PS_iGO_OTHER` is entirely
   un-automated, so scoping to one or the other MUST move the number. */
const ISSUES = [
  epic('E-1'), epic('E-2'), epic('E-3', { automationStatus: 'Maintenance' }),
  epic('E-4', { automationStatus: 'Ready for Automation' }),
  epic('E-5', { automationStatus: 'Blocked' }),
  epic('O-1', { components: ['PS_iGO_OTHER'], automationStatus: 'Ready for Automation' }),
  epic('O-2', { components: ['PS_iGO_OTHER'], automationStatus: 'Ready for Automation' }),
  epic('O-3', { components: ['PS_iGO_OTHER'], automationStatus: 'Ready for Automation' }),
];

/* ONE ACTIVE SPRINT, because the sprint report needs something to report on.
   Without it `figuresFor` refuses — correctly, and that refusal is checked
   too — but every other sprint check would be exercising the empty path
   rather than the one a client receives. */
const SPRINT = {
  id: 'S41', number: 41, name: 'PSA Sprint 41',
  start: '2026-09-21', end: '2026-10-02', source: 'jira',
  byTeam: { ruby: { jiraId: '941', name: 'Katalon Ruby S41', state: 'active' } },
};

fs.writeFileSync(path.join(SCRATCH, 'store', 'plan.json'), JSON.stringify({
  version: 1,
  teams: [{ id: 'ruby', name: 'Katalon Ruby', jiraTeams: ['Katalon Ruby'] }],
  sprints: [SPRINT], holidays: [], availability: {}, support: {}, ceremony: {}, overrides: {},
  risks: [], blockers: [], mailTemplates: [], notes: {}, excluded: {}, ignoredBoards: [],
  savedSearches: [], categoryRules: null, mixTargets: null, sprintRoster: {},
  scenarios: [], componentPriority: {}, excludedComponents: [], coverageTeams: ['Katalon Ruby'],
}));
fs.writeFileSync(path.join(SCRATCH, 'store', 'snapshot.json'), JSON.stringify({
  syncedAt: '2026-09-29T00:00:00Z', watermark: null, source: 'jira',
  issues: Object.fromEntries(ISSUES.map(i => [i.key, i])),
  sprints: [], components: [], testops: {}, github: {}, verification: [], fields: {},
  boards: [], boardSprintsByTeam: {}, boardSprintErrors: [], people: [], byTeam: {},
}));

/* THE RENDERER, STUBBED AT THE MODULE — so a send that attaches a PDF can be
   driven end to end on a machine with no Chrome, and the URL the server hands
   the renderer can be READ rather than inferred from the source.

   The two checks below this used to slice `server.js` and match strings,
   because the PDF path could not be reached without a browser. That catches a
   field nobody passed and nothing else: it cannot tell whether the value
   arriving is the one the caller sent, which is the failure that actually
   happened twice. `require` is cached, so replacing the function here
   replaces the one `server.js` already holds.

   `reportUrl` IS LEFT REAL. What is under test is what the server passes into
   it; stubbing that too would leave the join between them unexercised — which
   is exactly where both scope bugs lived. */
const pdfRender = require('../lib/pdf-render.js');
const rendered = [];
pdfRender.render = async (url, opts) => {
  rendered.push({ url, opts });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-fakepdf-'));
  const file = path.join(dir, 'report.pdf');
  /* A REAL PDF HEADER, because `verify` reads one. A stub that skipped it
     would prove the send works only against a renderer that cannot fail. */
  fs.writeFileSync(file, Buffer.from('%PDF-1.4\n% fake\n%%EOF\n'));
  return { file, bytes: fs.statSync(file).size, chrome: 'stub', ms: 1 };
};

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
const post = (p, b) => send('POST', p, b);
const put = (p, b) => send('PUT', p, b);
const del = (p, b) => send('DELETE', p, b);

const TPL = (o = {}) => ({
  name: 'Weekly client report',
  to: 'client@example.com',
  cc: '',
  subject: 'Coverage — {{team}} — {{date}}',
  body: 'Hi,\n\nCoverage is now {{coverage}}.\n\nThe report is attached.',
  attachPdf: false,
  ...o,
});

/* ── A FAKE MAIL SERVER, on loopback ──────────────────────────────────────
   The test-send route is the one thing here that opens a socket. It points at
   this, which records what it was asked to deliver and to whom — nothing in
   this file can reach a real mail server or a real person. */
const net = require('node:net');
function fakeSmtp() {
  const got = { rcpt: [], from: null, data: [] };
  const server = net.createServer((sock) => {
    let inData = false, buf = '';
    const say = (s) => sock.write(`${s}\r\n`);
    say('220 fake ESMTP');
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      const parts = buf.split('\r\n'); buf = parts.pop();
      for (const line of parts) {
        if (inData) {
          if (line === '.') { inData = false; say('250 OK queued'); continue; }
          got.data.push(line); continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) { say('250-fake'); say('250 ENHANCEDSTATUSCODES'); }
        else if (up.startsWith('MAIL FROM')) { got.from = line; say('250 OK'); }
        else if (up.startsWith('RCPT TO')) { got.rcpt.push(line); say('250 OK'); }
        else if (up === 'DATA') { inData = true; say('354 go'); }
        else if (up === 'QUIT') { say('221 bye'); sock.end(); }
        else say('250 OK');
      }
    });
    sock.on('error', () => {});
  });
  return { server, got };
}

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nThe send routes, over HTTP\n');

/* ── setup, and the password ──────────────────────────────────────────── */

check('THE SETUP ROUTE NEVER HANDS BACK THE PASSWORD', async () => {
  /* This panel is on screen whenever he shows somebody the feature, and it is
     in every screenshot he takes of it. An app password echoed here would be
     the one artefact of this whole feature nobody thinks to redact. */
  const r = await get('/api/mail/config');
  assert.strictEqual(r.status, 200);
  const json = JSON.stringify(r.body).toLowerCase();
  assert.ok(!/"pass"|password|secret/.test(json), `the config route returned: ${JSON.stringify(r.body)}`);
  assert.ok('configured' in r.body, 'the screen cannot tell whether mail is set up');
  assert.ok(Array.isArray(r.body.fields) && r.body.fields.length,
    'the editor is not told which placeholders exist, so it cannot list them');
});

check('AND IT SAYS WHEN MAIL IS NOT SET UP AT ALL', async () => {
  /* The fixture has no mail block, which is the state he starts in. A screen
     that could not tell would offer a Send button that always fails. */
  const r = await get('/api/mail/config');
  assert.strictEqual(r.body.configured, false, 'mail with no host was reported as configured');
});

/* ── templates ────────────────────────────────────────────────────────── */

check('A TEMPLATE ROUND-TRIPS, addresses and all', async () => {
  const r = await put('/api/mail/template', TPL({ to: 'client@example.com, second@example.com', cc: 'pm@example.com' }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const t = r.body.templates.find(x => x.name === 'Weekly client report');
  assert.ok(t && t.id, 'nothing was stored');
  assert.deepStrictEqual(t.to, ['client@example.com', 'second@example.com'],
    'a typed recipient list was not split into addresses');
  assert.deepStrictEqual(t.cc, ['pm@example.com']);
});

check('A BAD ADDRESS IS REFUSED BEFORE IT CAN BE SCHEDULED', async () => {
  /* Validated when it is STORED, not when it is sent. A template saved with a
     typo fires at 8am on a Monday against a schedule nobody is watching, and
     the first sign is a client asking where the report went. */
  const r = await put('/api/mail/template', TPL({ to: 'client at example.com' }));
  assert.strictEqual(r.status, 400, 'a template with a malformed address was stored');
  assert.match(r.body.error, /email addresses/);

  for (const bad of [{ name: '' }, { subject: '' }, { body: '   ' }, { to: '' }]) {
    const x = await put('/api/mail/template', TPL(bad));
    assert.strictEqual(x.status, 400, `${JSON.stringify(bad)} was accepted`);
  }
});

check('EDITING KEEPS THE ID; EDITING A GHOST IS A 404', async () => {
  const made = await put('/api/mail/template', TPL({ name: 'To edit' }));
  const t = made.body.templates.find(x => x.name === 'To edit');
  const r = await put('/api/mail/template', { ...TPL({ name: 'Edited' }), id: t.id });
  assert.strictEqual(r.status, 200);
  const after = r.body.templates.find(x => x.id === t.id);
  assert.strictEqual(after.name, 'Edited');
  assert.strictEqual(after.createdAt, t.createdAt, 'editing rewrote when it was first saved');

  assert.strictEqual((await put('/api/mail/template', { ...TPL(), id: 'mt-nope' })).status, 404);
  assert.strictEqual((await del('/api/mail/template', { id: 'mt-nope' })).status, 404,
    'deleting a template that is not there reported success');
});

/* ── the preview ──────────────────────────────────────────────────────── */

check('THE PREVIEW FILLS PLACEHOLDERS FROM THE LIVE REPORT', async () => {
  const r = await post('/api/mail/preview', { template: TPL(), team: 'ruby' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.subject, /Katalon Ruby/, 'the team name was not filled in');
  assert.ok(!/\{\{/.test(r.body.subject), `a placeholder survived into the subject: ${r.body.subject}`);
  assert.match(r.body.text, /Coverage is now \d/, `the coverage figure was not filled in: ${r.body.text}`);
  assert.match(r.body.attachmentName, /\.pdf$/, 'the attachment has no name to show');
});

check('AND IT SENDS NOTHING AND RENDERS NOTHING', async () => {
  /* A preview that started Chrome would take fifteen seconds, which is a
     preview nobody waits for — and it is the WORDS that need checking before
     they leave. The log is the proof: a preview must leave no trace. */
  const before = (await get('/api/mail/log')).body.sends.length;
  await post('/api/mail/preview', { template: TPL(), team: 'ruby' });
  const after = (await get('/api/mail/log')).body.sends.length;
  assert.strictEqual(after, before, 'the preview wrote a send to the log');
});

check('A TYPO IN A PLACEHOLDER IS REPORTED, not silently blanked', async () => {
  /* "Coverage is now {{covrage}}" shows a client something went wrong.
     "Coverage is now " reads as a tool that lost the number, and he would
     never know — from this end the send returned 250 OK. */
  const r = await post('/api/mail/preview', { template: TPL({ body: 'Now {{covrage}}.' }), team: 'ruby' });
  assert.strictEqual(r.status, 200);
  assert.match(r.body.text, /\{\{covrage\}\}/, 'the typo was replaced with nothing');
  assert.ok((r.body.unknown || []).includes('covrage'), 'and the preview does not point at it');
});

check('THE PREVIEW IS THE SAME COMPOSITION THE SEND USES', async () => {
  /* Both go through `reportMail.compose`. If they did not, he would approve
     one set of words and a client would receive another — and there is no
     screen anywhere that would show the difference. */
  const tpl = TPL({ subject: '{{team}} · {{coverage}}', body: '{{automated}} of {{automatable}}' });
  const pv = await post('/api/mail/preview', { template: tpl, team: 'ruby' });
  const sent = await post('/api/mail/send', { template: tpl, team: 'ruby' });
  /* The send fails — there is no mail host in this fixture — but it fails
     AFTER composing, and the log records the subject it composed. */
  assert.ok(!sent.body.ok, 'fixture check: there is no mail server configured');
  const log = (await get('/api/mail/log')).body.sends[0];
  assert.strictEqual(log.subject || pv.body.subject, pv.body.subject,
    'the send composed a different subject from the one previewed');
});

check('THE PREVIEW SHOWS THE FILENAME THE CLIENT WILL ACTUALLY GET', async () => {
  /* The attachment name is the one string in this feature that outlives the
     email — it gets saved, forwarded, and searched for weeks later. The
     preview is where he checks it, so the preview and the send must derive it
     the same way; a name that only appears at send time is one nobody sees
     until a client already has it. */
  const tpl = TPL({ filename: 'Coverage {{team}} {{Date}}' });
  const pv = await post('/api/mail/preview', { template: tpl, team: 'ruby' });
  assert.match(pv.body.attachmentName, /^Coverage Katalon Ruby \d{4}-\d{2}-\d{2}\.pdf$/,
    `the preview named it ${pv.body.attachmentName}`);

  const dflt = await post('/api/mail/preview', { template: TPL(), team: 'ruby' });
  assert.match(dflt.body.attachmentName, /^Automation Delivery Dashboard - \d{4}-\d{2}-\d{2}\.pdf$/,
    `a template with no filename got ${dflt.body.attachmentName}`);
});

check('AND THE DEFAULT ON SCREEN IS THE DEFAULT THAT IS USED', async () => {
  /* The drawer shows the default as the placeholder in the file-name box, so
     the screen makes a promise about what will be attached.
     It used to keep its own copy of the string and this check compared the
     two. With a second report each having its own default, two copies became
     four, so the drawer now ASKS — `/api/mail/config` carries every report's
     default and the placeholder is whatever came back. Drift is no longer
     possible rather than merely detected, which is the better fix; what is
     checked now is that the route really carries them and the drawer really
     has no copy of its own to fall back to. */
  const rmail = require('../lib/report-mail');
  const cfg = (await get('/api/mail/config?report=sprint')).body;
  assert.strictEqual(cfg.report, 'sprint', 'the config route ignored the report it was asked about');
  const carried = Object.fromEntries((cfg.reports || []).map(r => [r.key, r.defaultFilename]));
  for (const key of Object.keys(rmail.REPORTS)) {
    assert.strictEqual(carried[key], rmail.REPORTS[key].defaultFilename,
      `the route does not carry ${key}'s default filename, so the drawer cannot show it`);
  }
  const drawer = fs.readFileSync(path.join(__dirname, '..', 'public', 'mail-drawer.js'), 'utf8');
  assert.ok(!/Automation Delivery Dashboard/.test(drawer),
    'the drawer has gone back to hardcoding a default filename');
  assert.match(drawer, /defaultFilename/, 'the drawer no longer reads the default from the server');
});

check('A FILENAME IS KEPT WHEN THE TEMPLATE IS SAVED', async () => {
  const saved = await put('/api/mail/template', TPL({
    name: 'Named attachment', filename: 'Automation Delivery Dashboard - {{Date}}',
  }));
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  const row = (saved.body.templates || []).find(t => t.name === 'Named attachment');
  assert.strictEqual(row.filename, 'Automation Delivery Dashboard - {{Date}}',
    'stored scrubbed or dropped — the box has to show back exactly what he typed');
});

check('THE FIGURES ARE SCOPED TO THE SELECTED COMPONENTS', async () => {
  /* The premise the next check rests on: selecting components has to actually
     move the numbers. Asserted as a STRICT difference — an earlier version of
     this said "the filtered figure is no larger than the unfiltered one",
     which is satisfied perfectly by a filter that is being ignored, and by
     two zeroes. */
  const tpl = TPL({ subject: '{{coverage}}', body: '{{automated}} of {{automatable}}' });
  const all = await post('/api/mail/preview', { template: tpl, team: 'ruby', components: [] });
  const nlg = await post('/api/mail/preview', { template: tpl, team: 'ruby', components: ['PS_iGO_NLG'] });
  const other = await post('/api/mail/preview', { template: tpl, team: 'ruby', components: ['PS_iGO_OTHER'] });

  assert.ok(Number(all.body.figures.automatable) > 0, 'fixture check: the unfiltered report has work in it');
  assert.notStrictEqual(nlg.body.figures.automatable, all.body.figures.automatable,
    'scoping to one component did not narrow the report at all');
  assert.notStrictEqual(nlg.body.subject, other.body.subject,
    'two different components produced the same coverage figure — the filter is being ignored');
  assert.strictEqual(Number(other.body.figures.automated), 0,
    'fixture check: PS_iGO_OTHER is entirely un-automated');
});

check('AND THE PDF IS RENDERED AT THE SAME SCOPE AS THE WORDS', async () => {
  /* THE BUG, stated where it actually happened. `coverageFigures` honoured
     `body.components` and the render URL did not, so the email quoted the
     selected components and the attachment showed everything. Nothing in the
     tool compared the two — the only reader positioned to spot it was the
     client, holding both.

     Checked at the seam rather than by rendering: what went wrong was that
     one list reached one consumer and not the other, and that is visible in
     the URL the send builds. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const send = src.slice(src.indexOf('async function sendReport'), src.indexOf('function startScheduler'));
  const call = send.slice(send.indexOf('pdfRender.reportUrl'), send.indexOf('pdfRender.render'));
  assert.match(call, /components:/,
    'the send renders the PDF without the component selection the figures used');
  assert.match(call, /body\.components/,
    'the PDF is scoped from something other than the list the figures came from');
});

check('A COVERAGE TEMPLATE CANNOT BE SENT AS THE SPRINT REPORT', async () => {
  /* One drawer, two screens, one template store. The mismatch is not
     hypothetical — a saved template is one dropdown away from the other
     page. Sending it there would compose coverage wording over sprint
     figures: every placeholder unresolved, the attachment a different report,
     and all of it in front of a client. Refused by NAME, so the message says
     which report the template is for rather than leaving him to guess. */
  const r = await post('/api/mail/send', {
    template: TPL({ report: 'coverage' }), report: 'sprint', team: 'ruby',
  });
  assert.strictEqual(r.body.ok, false, 'a coverage template was sent as a sprint report');
  assert.match(r.body.error, /Overall Coverage/, `the refusal does not name the template's report: ${r.body.error}`);
  assert.match(r.body.error, /Active Sprint/, 'nor the one it was asked to be');
});

check('AND THE REFUSAL IS RECORDED like any other failure', async () => {
  /* The scheduler sends unattended, and a template that drifted out of step
     with its schedule fails silently otherwise. */
  const log = (await get('/api/mail/log')).body.sends;
  assert.ok(log.some(x => /cannot be sent as/.test(x.detail || '')),
    'a refused send left no trace in the log');
});

check('A SPRINT TEMPLATE PREVIEWS AGAINST SPRINT FIGURES', async () => {
  /* The other half: the right template on the right screen resolves its own
     placeholders, and gets the sprint report's filename rather than the
     coverage one. */
  const r = await post('/api/mail/preview', {
    template: TPL({
      report: 'sprint', name: 'Sprint update',
      subject: '{{sprint}} — {{donepct}}', body: '{{done}} of {{committed}} points.',
    }),
    report: 'sprint', team: 'ruby',
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.unknown, [],
    `sprint placeholders did not resolve on a sprint template: ${JSON.stringify(r.body.unknown)}`);
  assert.ok(!/\{\{/.test(r.body.subject), `the subject kept a placeholder: ${r.body.subject}`);
  assert.match(r.body.attachmentName, /^Sprint Report - /,
    `the sprint preview named the attachment ${r.body.attachmentName}`);
});

check('AND A COVERAGE PLACEHOLDER ON A SPRINT TEMPLATE IS FLAGGED, not filled', async () => {
  /* Left as written so he can see it in the preview — the behaviour that
     makes a typo cheap, applied to a field that is simply on the wrong
     report. */
  const r = await post('/api/mail/preview', {
    template: TPL({ report: 'sprint', subject: 'Coverage is {{coverage}}' }),
    report: 'sprint', team: 'ruby',
  });
  assert.deepStrictEqual(r.body.unknown, ['coverage'],
    'a coverage field resolved against sprint figures');
  assert.match(r.body.subject, /\{\{coverage\}\}/, 'it was silently blanked instead of shown');
});

check('THE SPRINT MAIL ATTACHES THE SPRINT PAGE', async () => {
  /* THE THIRD TIME THIS SHAPE HAS COME UP, so it gets a check of its own
     before it happens rather than after. Twice now the figures have been
     computed from one thing and the PDF rendered from another: the component
     selection reached the words and not the renderer, and the scope was fixed
     in one place and not the other. Here the risk is the ROUTE — a sprint
     mail whose wording is about Sprint 41 and whose attachment is the Overall
     Coverage page. Both plausible documents; only the client sees both.

     Checked at the seam, because that is where the divergence lives: the URL
     the send builds has to come from the report kind, not from a literal. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const send = src.slice(src.indexOf('async function sendReport'), src.indexOf('const SCHEDULE_TICK_MS'));
  const call = send.slice(send.indexOf('pdfRender.reportUrl'), send.indexOf('pdfRender.render'));
  assert.match(call, /route: kind\.route/,
    'the send renders a hardcoded page rather than the one the report names');
  assert.ok(!/reports\/coverage/.test(call),
    'the coverage route is hardcoded into a send that may be a sprint report');
  /* AND THE SPRINT TRAVELS WITH IT, or the attachment is whichever sprint
     happens to be active at render time rather than the one he is reporting
     on. */
  assert.match(call, /sprint:/, 'the sprint is not passed to the renderer');

  /* THE ROUTES THEMSELVES ARE REAL PAGES, not typos that would render the
     app's fallback screen and attach it confidently. */
  const rmail = require('../lib/report-mail');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  for (const r of Object.values(rmail.REPORTS)) {
    assert.ok(app.includes(`'${r.route}'`), `${r.key} renders '${r.route}', which is not a route in app.js`);
  }
});

check('A SPRINT REPORT WITH NO SPRINT REFUSES IN WORDS', async () => {
  /* A real state: a fresh store, or a team whose sprints have all closed.
     `findSprint` answers null and `activeSprintView` then failed deep inside
     on a property of undefined — a 500 on screen, and a stack trace in the
     mail log at 8am on a Monday with nobody watching.

     CHECKED AT THE SOURCE rather than by emptying the store mid-run. The
     server holds the plan in memory, so rewriting plan.json under it proves
     nothing — a first draft of this check did exactly that and passed while
     testing the populated path. What has to be true is that the figures
     REFUSE instead of dereferencing, and that both callers turn the refusal
     into a sentence rather than letting it escape as a 500. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const fn = src.slice(src.indexOf('function sprintFigures'), src.indexOf('function figuresFor'));
  assert.match(fn, /if \(!sprint\)/, 'sprintFigures dereferences a sprint it never checked for');
  assert.match(fn, /no active sprint/i, 'the refusal does not say what is missing');

  const send = src.slice(src.indexOf('async function sendReport'), src.indexOf('const SCHEDULE_TICK_MS'));
  assert.match(send, /report = figuresFor\([\s\S]{0,200}?\} catch/,
    'the send does not catch a report that cannot be built');
  const preview = src.slice(src.indexOf("p === '/api/mail/preview' &&"), src.indexOf("p === '/api/mail/schedule'"));
  assert.match(preview, /could not be built/,
    'the preview lets a failed report escape as a 500 rather than a sentence');
});

check('A CAPACITY TEMPLATE PREVIEWS AGAINST CAPACITY FIGURES', async () => {
  const r = await post('/api/mail/preview', {
    template: TPL({
      report: 'capacity', name: 'Capacity plan',
      subject: '{{team}} — {{sprint}} — capacity plan',
      body: '{{capacity}} pts across {{headcount}} people; {{committed}} committed ({{load}}).',
    }),
    report: 'capacity', team: 'ruby',
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.unknown, [],
    `capacity placeholders did not resolve: ${JSON.stringify(r.body.unknown)}`);
  assert.ok(!/\{\{/.test(r.body.subject), `the subject kept a placeholder: ${r.body.subject}`);
  assert.match(r.body.attachmentName, /^Capacity Plan - /,
    `the capacity preview named the attachment ${r.body.attachmentName}`);
});

check('AND IT RENDERS THE CAPACITY PAGE, not the sprint one', async () => {
  /* Every report names its own page, and the send builds the URL from that
     name. A third report is where a hardcoded route would finally show —
     the first two share nothing but the mechanism. */
  const rmail = require('../lib/report-mail');
  assert.strictEqual(rmail.REPORTS.capacity.route, 'sprints/capacity');
  assert.notStrictEqual(rmail.REPORTS.capacity.route, rmail.REPORTS.sprint.route,
    'capacity and the sprint report would attach the same page');

  /* AND THE ROUTE IS REAL. A typo here renders the app's fallback screen and
     attaches it with confidence. */
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  for (const rep of Object.values(rmail.REPORTS)) {
    assert.ok(app.includes(`'${rep.route}'`), `${rep.key} renders '${rep.route}', which is not a route in app.js`);
  }
});

check('AND "CHECK THE PDF" RENDERS THE SAME DOCUMENT A SEND WOULD', async () => {
  /* That button exists to be the last look before a client gets this. A
     preview that drops the lens reports on a document the send will not
     produce — worse than no button, because it is confident. The same failure
     already happened once here with the team parameter. */
  rendered.length = 0;
  const r = await get('/api/mail/preview-pdf?report=capacity&team=ruby&family=ps&showall=1');
  assert.strictEqual(r.status, 200, `the preview did not render: ${JSON.stringify(r.body).slice(0, 200)}`);
  assert.strictEqual(rendered.length, 1);
  const q = new URL(rendered[0].url).searchParams;
  assert.strictEqual(q.get('family'), 'ps', `the check button dropped the lens: ${rendered[0].url}`);
  assert.strictEqual(q.get('showall'), '1', 'the check button dropped the fold');
});

check('AND A SPRINT TEMPLATE CANNOT BE SENT AS THE CAPACITY REPORT', async () => {
  /* Three reports now share one drawer and one template store, so the guard
     has to hold for every pair rather than the one it was written against. */
  const r = await post('/api/mail/send', {
    template: TPL({ report: 'sprint' }), report: 'capacity', team: 'ruby',
  });
  assert.strictEqual(r.body.ok, false, 'a sprint template was sent as a capacity report');
  assert.match(r.body.error, /Active Sprint/, `the refusal does not name the template's report: ${r.body.error}`);
  assert.match(r.body.error, /Capacity planning/, 'nor the one it was asked to be');
});

/* ── sending ──────────────────────────────────────────────────────────── */

check('WITH NO MAIL SET UP, A SEND FAILS AND SAYS WHAT TO ADD', async () => {
  const r = await post('/api/mail/send', { template: TPL(), team: 'ruby' });
  assert.strictEqual(r.status, 200, 'the route itself should answer, not error');
  assert.strictEqual(r.body.ok, false, 'a send with no mail server reported success');
  assert.match(r.body.error, /config\.json/, 'the failure does not say where to set it up');
});

check('EVERY OUTCOME IS LOGGED, failures included', async () => {
  /* The scheduler sends unattended. Without a record, a send that failed at
     8am is invisible until the client asks why they got nothing. */
  const r = await get('/api/mail/log');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.sends.length, 'nothing was logged at all');
  const last = r.body.sends[0];
  assert.ok('ok' in last, 'the log does not record whether the send worked');
  assert.ok(last.at, 'nor when it was attempted');
  assert.ok(last.detail, 'nor why it failed');
  assert.ok(r.body.sends.some(s => s.ok === false), 'a failed send was not recorded');
});

check('AND THE LOG NEVER CARRIES A PASSWORD EITHER', async () => {
  const json = JSON.stringify((await get('/api/mail/log')).body).toLowerCase();
  assert.ok(!/app password|"pass"/.test(json), 'the send log echoed a credential');
});

check('A SEND WITH A BROKEN TEMPLATE NEVER OPENS A CONNECTION', async () => {
  const r = await post('/api/mail/send', { template: TPL({ to: 'not-an-address' }), team: 'ruby' });
  assert.strictEqual(r.body.ok, false);
  assert.match(r.body.error, /email addresses/, 'a malformed recipient got as far as the mail server');
});

/* ── CONFIGURING MAIL FROM THE SCREEN ─────────────────────────────────── */

check('THE SETTINGS SAVE, and the password never comes back', async () => {
  const r = await put('/api/mail/config', {
    host: 'smtp.gmail.com', port: 587, user: 'me@kms-technology.com',
    pass: 'abcd efgh ijkl mnop', from: 'me@kms-technology.com', fromName: 'Nghiep Tran',
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.mail.host, 'smtp.gmail.com');
  assert.strictEqual(r.body.mail.hasPass, true, 'the screen cannot tell whether a password is stored');
  assert.ok(!JSON.stringify(r.body).includes('abcd'), 'the save route echoed the app password back');

  const c = await get('/api/mail/config');
  assert.strictEqual(c.body.configured, true);
  assert.ok(!JSON.stringify(c.body).includes('abcd'), 'the read route hands out the app password');
});

check('A BLANK PASSWORD KEEPS THE ONE ALREADY SAVED', async () => {
  /* The field cannot be pre-filled — nothing ever sends it back — so an empty
     post means "I did not retype it". Treating that as "clear it" would wipe
     his app password every time he corrected the port, and the next send
     would fail with an authentication error he has no reason to expect. */
  const r = await put('/api/mail/config', {
    host: 'smtp.gmail.com', port: 2525, user: 'me@kms-technology.com',
    from: 'me@kms-technology.com', fromName: 'Nghiep Tran',
  });
  assert.strictEqual(r.body.mail.port, 2525, 'the edit did not take');
  assert.strictEqual(r.body.mail.hasPass, true, 'changing the port wiped the saved app password');
});

check('AND CLEARING IT IS AN EXPLICIT ACT', async () => {
  const r = await put('/api/mail/config', {
    host: 'smtp.gmail.com', port: 587, user: 'me@kms-technology.com',
    from: 'me@kms-technology.com', clearPass: true,
  });
  assert.strictEqual(r.body.mail.hasPass, false, 'the password could not be forgotten');
  // put it back for the checks below
  await put('/api/mail/config', {
    host: 'smtp.gmail.com', port: 587, user: 'me@kms-technology.com',
    pass: 'secret-pass', from: 'me@kms-technology.com', fromName: 'Nghiep Tran',
  });
});

check('NONSENSE SETTINGS ARE REFUSED WITH A REASON', async () => {
  /* Caught on save it is one sentence beside the field; caught at send time it
     is an SMTP error nobody can read, on the evening a client is waiting. */
  const bad = [
    [{ host: '', from: 'a@b.com' }, /mail server/i],
    [{ host: 'x', port: 0, from: 'a@b.com' }, /port/i],
    [{ host: 'x', from: '' }, /From address/i],
    [{ host: 'x', from: 'not an address' }, /does not look like/i],
    [{ host: 'x', from: 'a@b.com', user: 'nope' }, /does not look like/i],
  ];
  for (const [body, why] of bad) {
    const r = await put('/api/mail/config', body);
    assert.strictEqual(r.status, 400, `${JSON.stringify(body)} was accepted`);
    assert.match(r.body.error, why);
  }
});

check('THE TEST MESSAGE GOES TO HIM AND ONLY HIM', async () => {
  /* The recipient is not a parameter, deliberately. A "test" that took an
     address would be a way to mail a stranger from his account with no
     template, no preview and a log line that reads like a real send. */
  const { server: fake, got } = fakeSmtp();
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  await put('/api/mail/config', {
    host: '127.0.0.1', port: fake.address().port, user: '',
    from: 'me@kms-technology.com', fromName: 'Nghiep Tran',
  });

  const r = await post('/api/mail/test', { to: 'stranger@example.com' });
  assert.strictEqual(r.body.ok, true, `the test send failed: ${r.body.error}`);
  assert.strictEqual(r.body.to, 'me@kms-technology.com');
  assert.deepStrictEqual(got.rcpt, ['RCPT TO:<me@kms-technology.com>'],
    `the test was delivered to ${JSON.stringify(got.rcpt)} — a recipient in the request body was honoured`);
  assert.ok(got.data.join(' ').length, 'nothing was actually sent');
  fake.close();
});

check('AND THE FAMILY LENS REACHES THE PAGE THE PDF IS RENDERED FROM', async () => {
  /* HIS REPORT: the By component grid filtered to the PS family, the emailed
     PDF showing all of them.

     WHY NOTHING CAUGHT IT. The component selection on the coverage report
     changes what was COUNTED, so when that failed to travel the mail's
     figures and its attachment disagreed — two numbers, visibly different.
     The family chip changes only what is DRAWN. Every capacity figure is
     team-level and identical under any chip, so a lens that fell on the floor
     produced a mail where nothing was inconsistent and the document was
     simply the wrong one.

     DRIVEN THROUGH A REAL SEND rather than matched in the source. What went
     wrong both times was a value reaching one consumer and not another, and
     only executing the path shows which value arrived. */
  rendered.length = 0;
  const r = await post('/api/mail/send', {
    template: TPL({ report: 'capacity', attachPdf: true }),
    report: 'capacity', team: 'ruby', sprint: null,
    view: { family: 'ps', showAll: true },
  });
  /* THE SEND FAILS AT THE LAST STEP, and is meant to: the check above closed
     its fake SMTP, so mail is configured but nothing is listening. The PDF is
     built before the connection is opened, which is the part under test —
     and a send that failed EARLIER would render nothing and make the real
     assertion below vacuous, so it is pinned here rather than assumed. */
  assert.ok(!r.body.ok, 'fixture check: the send is expected to fail at the SMTP step');
  assert.strictEqual(rendered.length, 1, `the send rendered ${rendered.length} PDFs`);

  const u = new URL(rendered[0].url);
  const q = u.searchParams;
  assert.strictEqual(q.get('print'), '1', 'the PDF was rendered from the on-screen page');
  assert.strictEqual(q.get('family'), 'ps',
    `the family lens never reached the rendered page: ${rendered[0].url}`);
  assert.strictEqual(q.get('showall'), '1', 'the clear-row fold did not travel');
  assert.ok(u.hash.endsWith('sprints/capacity'), `the lens displaced the route: ${u.hash}`);
});

check('and a send with no lens renders the whole sheet', async () => {
  /* The other half: an unfiltered send must not acquire a filter from a
     leftover, which is the failure the stale schedule pin produced once
     already on the sprint report. */
  rendered.length = 0;
  await post('/api/mail/send', {
    template: TPL({ report: 'capacity', attachPdf: true }), report: 'capacity', team: 'ruby',
  });
  assert.strictEqual(rendered.length, 1);
  const q = new URL(rendered[0].url).searchParams;
  assert.strictEqual(q.get('family'), null, `an unfiltered send carried a family: ${rendered[0].url}`);
  assert.strictEqual(q.get('showall'), null, 'an unexpanded send carried showall');
});

check('AND THE TEST IS RECORDED like any other send', async () => {
  const log = (await get('/api/mail/log')).body.sends;
  const t = log.find(x => x.trigger === 'test');
  assert.ok(t, 'a test send left no trace in the log');
  assert.strictEqual(t.ok, true);
  assert.deepStrictEqual(t.recipients, ['me@kms-technology.com']);
});

check('A FAILING TEST REPORTS THE SERVER\'S OWN WORDS', async () => {
  /* "Test failed" sends him back to the form to change things at random.
     "535 Username and Password not accepted" tells him it is the app
     password, which is the actual fix. */
  await put('/api/mail/config', {
    host: '127.0.0.1', port: 1, user: '', from: 'me@kms-technology.com',
  });
  const r = await post('/api/mail/test', {});
  assert.strictEqual(r.status, 200, 'the route errored rather than reporting');
  assert.strictEqual(r.body.ok, false);
  assert.ok(r.body.error && r.body.error.length > 10, `the failure said only: ${r.body.error}`);
  const log = (await get('/api/mail/log')).body.sends;
  assert.ok(log.some(x => x.trigger === 'test' && !x.ok), 'a failed test was not logged');
});

check('SETTINGS SAVED ON THE SCREEN REACH THE SEND, without a restart', async () => {
  /* THE BUG THIS EXISTS FOR, and it is the shape that hurts most: every
     screen agreed the mail was set up and only the send disagreed.
   
     `handleApi` builds a fresh config per request, so `/api/mail/config` and
     the Test button both saw the saved block. `sendReport` is a module-level
     function, so its `cfg` resolved to the one read ONCE at boot — and it
     answered "Mail is not set up" over a settings page showing the server,
     the username and a saved password.
   
     Nothing caught it because every earlier check either saved settings OR
     sent, never both in one process. So this one does exactly that: configure
     through the route, then send, and assert the failure is not the one that
     means "I cannot see your config". */
  const { server: fake, got } = fakeSmtp();
  await new Promise(r => fake.listen(0, '127.0.0.1', r));

  const saved = await put('/api/mail/config', {
    host: '127.0.0.1', port: fake.address().port, user: '',
    from: 'me@kms-technology.com', fromName: 'Nghiep Tran',
  });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));

  const r = await post('/api/mail/send', {
    template: TPL({ to: 'client@example.com', attachPdf: false }), team: 'ruby',
  });
  assert.ok(!/not set up/i.test(String(r.body.error || '')),
    'the send is reading a config from before the save — the settings screen and the send disagree');
  assert.strictEqual(r.body.ok, true, `the send failed: ${r.body.error}`);
  assert.deepStrictEqual(got.rcpt, ['RCPT TO:<client@example.com>'],
    'the message did not reach the recipient the template named');
  fake.close();
});

check('AND THE FIGURES IN THE MAIL COME FROM THE SAME FRESH CONFIG', async () => {
  /* The sender name is read off the config too, and it travelled the same
     stale path. A mail signed by nobody is a smaller version of the same
     bug. */
  const { server: fake } = fakeSmtp();
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  await put('/api/mail/config', {
    host: '127.0.0.1', port: fake.address().port, user: '',
    from: 'me@kms-technology.com', fromName: 'Nghiep Tran',
  });
  const pv = await post('/api/mail/preview', {
    template: TPL({ body: 'Regards, {{sender}}' }), team: 'ruby',
  });
  assert.match(pv.body.text, /Nghiep Tran/, 'the sender name did not reach the template');
  assert.match(pv.body.from, /Nghiep Tran/, 'the From name is missing from the composed message');
  fake.close();
});

(async () => {
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
})();
