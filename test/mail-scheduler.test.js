'use strict';
/**
 * mail-scheduler.test.js — the claim, which is the only thing standing
 * between a client and two identical reports.
 *
 * `mail-schedule.test.js` proves the arithmetic: which moment is due, and
 * when a late one is too late. None of that touches a database, and none of
 * it can tell you whether a send actually happened once.
 *
 * THIS SUITE IS ABOUT THE PART THAT PERSISTS. `runDueSchedules` claims a slot
 * in SQLite, sends, and records the outcome, in that order — and the order is
 * the whole design. Reversed, a crash or a quit in the seconds between the
 * send and the record leaves the slot looking unsent, and the next tick, or
 * the next launch, mails the client a second copy. So what is checked here is
 * not "does it send" but "does it send EXACTLY ONCE, across restarts, across
 * failures, and across a tick every minute for the rest of the week".
 *
 * NOTHING HERE CAN REACH A REAL MAIL SERVER OR A REAL PERSON. The SMTP host
 * is a fake on loopback that counts deliveries, and the PDF is switched off
 * so no browser is ever started.
 *
 * Run: node test/mail-scheduler.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-sched-'));
fs.mkdirSync(path.join(SCRATCH, 'store'), { recursive: true });
process.env.STORE_DIR = SCRATCH;
process.env.DB_FILE = path.join(SCRATCH, 'store', 'test.db');
/* `PORT=0` KEEPS THE REAL TIMER OFF. `server.js` starts the once-a-minute
   scheduler inside `listen`, which this branch never reaches — so the only
   passes that happen here are the ones this file asks for, at the times it
   chooses. A suite racing a live timer would be unreadable when it failed. */
process.env.PORT = '0';
process.env.CONFIG_FILE = path.join(SCRATCH, 'config.json');
fs.writeFileSync(process.env.CONFIG_FILE, JSON.stringify({ jira: {}, testops: {}, github: {}, server: { port: 0 } }));

const epic = (key, o = {}) => ({
  key, project: 'AUTOKAT', summary: key, issueType: 'Epic',
  status: 'Open', statusCategory: 'new', automationStatus: o.automationStatus || 'Automated',
  team: 'Katalon Ruby', components: ['PS_iGO_NLG'],
  labels: [], blockedBy: [], sprints: [], relatesTo: [],
});

fs.writeFileSync(path.join(SCRATCH, 'store', 'plan.json'), JSON.stringify({
  version: 1,
  teams: [{ id: 'ruby', name: 'Katalon Ruby', jiraTeams: ['Katalon Ruby'] }],
  sprints: [], holidays: [], availability: {}, support: {}, ceremony: {}, overrides: {},
  risks: [], blockers: [], mailTemplates: [], notes: {}, excluded: {}, ignoredBoards: [],
  savedSearches: [], categoryRules: null, mixTargets: null, sprintRoster: {},
  scenarios: [], componentPriority: {}, excludedComponents: [], coverageTeams: ['Katalon Ruby'],
}));
fs.writeFileSync(path.join(SCRATCH, 'store', 'snapshot.json'), JSON.stringify({
  syncedAt: '2026-09-29T00:00:00Z', watermark: null, source: 'jira',
  issues: Object.fromEntries([epic('E-1'), epic('E-2'), epic('E-3', { automationStatus: 'Ready for Automation' })]
    .map(i => [i.key, i])),
}));

const app = require('../server.js');
const dbLib = require('../lib/db');
const store = require('../lib/store');

/* ── the fake mail server ─────────────────────────────────────────────── */

function fakeSmtp() {
  const got = { deliveries: 0, rcpt: [] };
  const server = net.createServer((sock) => {
    let inData = false, buf = '';
    const say = (s) => sock.write(`${s}\r\n`);
    say('220 fake ESMTP');
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      const parts = buf.split('\r\n'); buf = parts.pop();
      for (const line of parts) {
        if (inData) { if (line === '.') { inData = false; got.deliveries++; say('250 OK queued'); } continue; }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) { say('250-fake'); say('250 ENHANCEDSTATUSCODES'); }
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

const call = (method, p, body) => new Promise((resolve, reject) => {
  const data = body == null ? null : Buffer.from(JSON.stringify(body));
  const req = http.request({
    host: '127.0.0.1', port: app.server.address().port, path: p, method,
    headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
  }, (res) => {
    let out = '';
    res.on('data', c => { out += c; });
    res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }); } catch { resolve({ status: res.statusCode, body: out }); } });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

/* Helpers that reach past the routes, because the point of this suite is the
   state the routes leave behind rather than what they answer. */
const runsFor = (id) => dbLib.all('SELECT slot, status, detail FROM mail_schedule_run WHERE template = ? ORDER BY slot', id);
const clearRuns = () => dbLib.run('DELETE FROM mail_schedule_run');

/** A Monday-08:00 template, saved through the real route so it is validated. */
async function armed(name, sched = { enabled: true, day: 1, hour: 8, minute: 0, team: 'ruby' }) {
  const r = await call('PUT', '/api/mail/template', {
    name, to: 'client@example.com', cc: '',
    subject: 'Coverage — {{team}}', body: 'Coverage is {{coverage}}.',
    /* NO PDF. Chrome is not started anywhere in this file: the attachment
       path has its own checks, it costs fifteen seconds a send, and it would
       make this suite depend on a browser being installed. */
    attachPdf: false,
    schedule: sched,
  });
  assert.strictEqual(r.status, 200, `could not save the template: ${JSON.stringify(r.body)}`);
  return (r.body.templates || []).find(t => t.name === name);
}

const MON_0800 = new Date(2026, 8, 28, 8, 0, 0, 0); // Monday 2026-09-28, local
const SLOT = '2026-09-28T08:00';

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nThe weekly send, claimed and recorded\n');

/* ── the core guarantee ────────────────────────────────────────────────── */

check('A DUE SCHEDULE SENDS — once, and the slot is recorded as sent', async () => {
  const { server: fake, got } = fakeSmtp();
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  await call('PUT', '/api/mail/config', {
    host: '127.0.0.1', port: fake.address().port, user: '',
    from: 'me@kms-technology.com', fromName: 'Nghiep Tran',
  });
  const t = await armed('Weekly client report');

  const out = await app.runDueSchedules(MON_0800);
  assert.strictEqual(out.length, 1, `expected one send, got ${JSON.stringify(out)}`);
  assert.strictEqual(out[0].status, 'sent', `the send failed: ${out[0].error}`);
  assert.strictEqual(got.deliveries, 1, `the fake server saw ${got.deliveries} deliveries`);
  assert.deepStrictEqual(runsFor(t.id).map(r => [r.slot, r.status]), [[SLOT, 'sent']]);
  fake.close();
});

check('AND EVERY TICK FOR THE REST OF THE WEEK SENDS NOTHING', async () => {
  /* THE EXPENSIVE FAILURE, stated as the thing that actually happens: the
     timer fires once a minute, so after a Monday send there are about ten
     thousand more chances to mail the client a duplicate before the next
     slot. A handful of them, spread across the week, at the exact boundary
     and well past it. */
  const { server: fake, got } = fakeSmtp();
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  await call('PUT', '/api/mail/config', {
    host: '127.0.0.1', port: fake.address().port, user: '', from: 'me@kms-technology.com',
  });
  for (const now of [
    new Date(2026, 8, 28, 8, 1), new Date(2026, 8, 28, 8, 30), new Date(2026, 8, 28, 19, 0),
    new Date(2026, 8, 29, 8, 0), new Date(2026, 9, 4, 23, 59),
  ]) {
    const out = await app.runDueSchedules(now);
    assert.deepStrictEqual(out, [], `it acted again at ${now.toISOString()}: ${JSON.stringify(out)}`);
  }
  assert.strictEqual(got.deliveries, 0, `${got.deliveries} duplicate mails went out`);
  fake.close();
});

check('THE CLAIM SURVIVES A RESTART — the row, not a variable, is what remembers', async () => {
  /* The reason the claim is a table. Everything in memory is gone when he
     quits the app or his Mac sleeps hard; if "already sent this week" lived
     in a variable, the next launch would find the slot unclaimed and send it
     again. Simulated by dropping the module's cached plan and asking again —
     the row in SQLite is the only thing carrying the answer. */
  store.reload ? store.reload() : null;
  const t = (store.getPlan().mailTemplates || [])[0];
  assert.ok(t, 'fixture check: a template exists');
  assert.deepStrictEqual(runsFor(t.id).map(r => r.status), ['sent'], 'the claim did not persist');

  const { server: fake, got } = fakeSmtp();
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  await call('PUT', '/api/mail/config', {
    host: '127.0.0.1', port: fake.address().port, user: '', from: 'me@kms-technology.com',
  });
  const out = await app.runDueSchedules(new Date(2026, 8, 28, 9, 0));
  assert.deepStrictEqual(out, [], 'a restart re-sent the week');
  assert.strictEqual(got.deliveries, 0);
  fake.close();
});

check('THE FOLLOWING MONDAY IS A DIFFERENT SLOT AND DOES SEND', async () => {
  /* The mirror of the guard above, and it has to be written down: a
     `runDueSchedules` that simply never sent again would pass every
     duplicate check in this file perfectly. */
  const { server: fake, got } = fakeSmtp();
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  await call('PUT', '/api/mail/config', {
    host: '127.0.0.1', port: fake.address().port, user: '', from: 'me@kms-technology.com',
  });
  const out = await app.runDueSchedules(new Date(2026, 9, 5, 8, 0));
  assert.strictEqual(out.length, 1, 'the next week did not fire');
  assert.strictEqual(out[0].status, 'sent');
  assert.strictEqual(out[0].slot, '2026-10-05T08:00');
  assert.strictEqual(got.deliveries, 1);
  fake.close();
});

/* ── the failures ──────────────────────────────────────────────────────── */

check('A SLOT MISSED WHILE THE MACHINE WAS OFF IS RECORDED, not sent', async () => {
  /* Wednesday. The Monday report is stale — sending it is worse than
     silence — but the row has to exist, or "no report on Monday" and "the
     tool is broken" look identical on the screen he checks. */
  clearRuns();
  const { server: fake, got } = fakeSmtp();
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  await call('PUT', '/api/mail/config', {
    host: '127.0.0.1', port: fake.address().port, user: '', from: 'me@kms-technology.com',
  });
  const t = (store.getPlan().mailTemplates || [])[0];

  const out = await app.runDueSchedules(new Date(2026, 8, 30, 14, 0));
  assert.strictEqual(got.deliveries, 0, 'a stale report was sent anyway');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].status, 'missed');
  const row = runsFor(t.id).find(r => r.slot === SLOT);
  assert.ok(row, 'the missed slot left no record');
  assert.strictEqual(row.status, 'missed');
  assert.match(row.detail || '', /late|stale/i, `the record does not say why: ${row.detail}`);
  fake.close();
});

check('AND A MISSED SLOT IS NOT RE-EVALUATED EVERY MINUTE FOREVER', async () => {
  /* Without the claim on the missed branch, this dead slot would be decided
     again on every tick until the next Monday — writing a row each time, or
     worse, becoming sendable again if the grace window were ever widened. */
  const before = runsFor((store.getPlan().mailTemplates || [])[0].id).length;
  await app.runDueSchedules(new Date(2026, 8, 30, 14, 1));
  await app.runDueSchedules(new Date(2026, 8, 30, 15, 0));
  const after = runsFor((store.getPlan().mailTemplates || [])[0].id).length;
  assert.strictEqual(after, before, 'the missed slot was recorded more than once');
});

check('A SEND THAT FAILS IS RECORDED AS FAILED AND IS NOT RETRIED', async () => {
  /* A retry loop against a failure it cannot diagnose is how four copies
     arrive at 8:03. The slot is spent; the record says what happened; he
     decides. */
  clearRuns();
  await call('PUT', '/api/mail/config', {
    /* A PORT NOTHING IS LISTENING ON. The send fails at connect, which is the
       realistic shape of a laptop that woke up without wifi. */
    host: '127.0.0.1', port: 9, user: '', from: 'me@kms-technology.com',
  });
  const t = (store.getPlan().mailTemplates || [])[0];

  const first = await app.runDueSchedules(MON_0800);
  assert.strictEqual(first.length, 1);
  assert.strictEqual(first[0].status, 'failed', `expected a failure, got ${JSON.stringify(first[0])}`);
  const row = runsFor(t.id).find(r => r.slot === SLOT);
  assert.strictEqual(row.status, 'failed');
  assert.ok((row.detail || '').length, 'the failure was recorded with no reason');

  const second = await app.runDueSchedules(new Date(2026, 8, 28, 8, 5));
  assert.deepStrictEqual(second, [], 'a failed send was retried five minutes later');
});

check('A SWITCHED-OFF SCHEDULE DOES NOTHING AND LEAVES NO ROW', async () => {
  clearRuns();
  const t = (store.getPlan().mailTemplates || [])[0];
  await call('PUT', '/api/mail/template', {
    id: t.id, name: t.name, to: 'client@example.com', cc: '',
    subject: t.subject, body: t.body, attachPdf: false,
    schedule: { enabled: false, day: 1, hour: 8, minute: 0 },
  });
  const out = await app.runDueSchedules(MON_0800);
  assert.deepStrictEqual(out, [], 'a disabled schedule acted');
  assert.deepStrictEqual(runsFor(t.id), [], 'a disabled schedule left a row');
});

/* ── the schedule survives the rest of the panel ───────────────────────── */

check('SAVING A TEMPLATE KEEPS ITS SCHEDULE', async () => {
  /* The whole point of storing it on the template: every other Save on that
     panel — a fixed typo in the subject, one more recipient — must not
     quietly disarm next Monday. */
  const t = await armed('Keeps its schedule', { enabled: true, day: 3, hour: 17, minute: 30, team: 'ruby' });
  assert.ok(t.schedule, 'the schedule was not stored at all');
  assert.deepStrictEqual(
    [t.schedule.enabled, t.schedule.day, t.schedule.hour, t.schedule.minute],
    [true, 3, 17, 30]);

  const again = await call('PUT', '/api/mail/template', {
    id: t.id, name: t.name, to: 'client@example.com', cc: '',
    subject: 'A new subject', body: t.body, attachPdf: false,
    schedule: t.schedule,
  });
  const after = (again.body.templates || []).find(x => x.id === t.id);
  assert.strictEqual(after.subject, 'A new subject', 'fixture check: the edit landed');
  assert.strictEqual(after.schedule.enabled, true, 'editing the subject disarmed the schedule');
  assert.strictEqual(after.schedule.hour, 17);
});

check('THE SCHEDULE ROUTE SAYS WHEN IT NEXT GOES OUT, and what it did', async () => {
  const r = await call('GET', '/api/mail/schedule');
  assert.strictEqual(r.status, 200);
  const row = (r.body.scheduled || []).find(x => x.name === 'Keeps its schedule');
  assert.ok(row, `the armed template is not listed: ${JSON.stringify(r.body.scheduled)}`);
  assert.strictEqual(row.describes, 'Wednesday at 17:30');
  assert.ok(new Date(row.nextRun).getTime() > Date.now(), 'the next send is in the past');
  assert.strictEqual(new Date(row.nextRun).getDay(), 3);
  assert.ok(Array.isArray(row.runs), 'no history is offered');
});

check('A TEMPLATE WITH A BAD ADDRESS CANNOT BE ARMED AT ALL', async () => {
  /* Validation lives in the model rather than the browser precisely because
     of this route: a schedule that fires at 8am on a template with a broken
     recipient is the one failure with nobody watching it. */
  const r = await call('PUT', '/api/mail/template', {
    name: 'Broken', to: 'not-an-address', subject: 'x', body: 'y',
    schedule: { enabled: true, day: 1, hour: 8, minute: 0 },
  });
  assert.strictEqual(r.status, 400, 'a template with an invalid recipient was stored and armed');
  assert.match(JSON.stringify(r.body), /email address/i);
});

(async () => {
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* scratch */ }
  process.exit(failed ? 1 : 0);
})();
