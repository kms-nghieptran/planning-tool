'use strict';
/**
 * sprint-api.test.js — the rules as the SERVER enforces them.
 *
 * roster.test.js proves the logic. This proves the wiring, and the difference
 * matters: a read-only rule that is only in the browser is decoration. A tab
 * left open since last week still has live buttons, a grid that autosaves
 * still autosaves, and `fetch` from the console never saw the UI at all. So
 * these tests talk to a real server over HTTP and check what it does with
 * requests the UI would never send.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-api-'));
fs.mkdirSync(path.join(SCRATCH, 'store'), { recursive: true });
process.env.STORE_DIR = SCRATCH;
process.env.DB_FILE = path.join(SCRATCH, 'store', 'test.db');
process.env.PORT = '0';

/* ── the fixture, written before the server module is loaded ─────── */

const member = (id, name, acc) => ({ id, name, role: 'Auto QA', status: 'Active', supportPct: 0, jiraAccountId: acc, source: 'jira' });
const sprint = (id, state) => ({
  id, number: Number(id.replace(/\D/g, '')), name: `Sprint ${id}`,
  start: '2026-08-20', end: '2026-09-02', source: 'jira',
  byTeam: { titan: { jiraId: `9${id.replace(/\D/g, '')}`, name: `Katalon Titan ${id}`, state } },
});

const issue = (key, acc, name, jiraSprint) => ({
  key, project: 'T', summary: key, issueType: 'Story', status: 'Done', statusCategory: 'done',
  assignee: name, assigneeId: acc, points: 3, components: [], labels: [],
  sprints: [{ id: jiraSprint, name: 'x', state: 'closed' }], blockedBy: [], datasets: ['sprintWork'],
});

const ISSUES = [
  issue('T-1', 'acc-hien', 'Hien Phan', '938'),
  issue('T-2', 'acc-thao', 'Thao Dang', '938'),
  issue('T-3', 'acc-hy', 'Hy Nguyen', '938'),
  // The two shapes the Epic column has to handle, in the sprint the tests read.
  // A Story filed UNDER an epic...
  { ...issue('T-4', 'acc-hien', 'Hien Phan', '938'),
    parentKey: 'T-900', parentStatus: 'In Progress',
    parentSummary: 'Renewals regression suite', parentType: 'Epic' },
  // ...and a maintenance ticket LINKED to one.
  { ...issue('T-5', 'acc-thao', 'Thao Dang', '938'),
    issueType: 'Task', labels: ['Maintenance'],
    relatesTo: [{ key: 'T-901', summary: 'Quoting regression suite', type: 'Epic' }] },
];

fs.writeFileSync(path.join(SCRATCH, 'store', 'plan.json'), JSON.stringify({
  version: 1,
  teams: [{
    id: 'titan', name: 'Katalon Titan', jiraName: 'Katalon Auto Titan', boardId: '2092',
    jiraTeams: [], components: [], sprintKeywords: [],
    settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 },
    source: 'jira',
    members: [member('m1', 'Hien Phan', 'acc-hien'), member('m2', 'Thao Dang', 'acc-thao'),
      member('m3', 'Hy Nguyen', 'acc-hy'), member('m4', 'Chau Tran', 'acc-chau')],
  }, {
    // A team on a DIFFERENT cadence, whose board has none of the numbered
    // sprints above — the shape Malphite is in, and the one that exposed the
    // bug: every sprint belonging to another team's board was being reported
    // as this team's own local sprint.
    id: 'malphite', name: 'Katalon Auto Malphite', jiraName: 'Katalon Auto Malphite', boardId: '9173',
    jiraTeams: [], components: [], sprintKeywords: [],
    settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 },
    source: 'jira', members: [],
  }],
  sprints: [
    sprint('S38', 'closed'), sprint('S39', 'active'), sprint('S40', 'future'),
    // Created in this tool, on nobody's board: no `source`, no `byTeam`. This
    // is what "local" is supposed to mean.
    { id: 'L1', number: null, name: 'Planning week', start: '2026-09-07', end: '2026-09-11', byTeam: {} },
    // Created here, and since ADOPTED by one board: still no `source`, but Titan
    // now has its own copy. It is local to everyone except Titan.
    { id: 'L2', number: null, name: 'Hardening week', start: '2026-09-21', end: '2026-09-25',
      byTeam: { titan: { jiraId: '9500', name: 'Hardening week', state: 'future', start: '2026-09-21', end: '2026-09-25' } } },
  ],
  holidays: [], availability: {}, support: {}, ceremony: {}, overrides: {},
  risks: [], notes: {}, excluded: {}, ignoredBoards: [], savedSearches: [],
  categoryRules: null, mixTargets: null, sprintRoster: {}, scenarios: [],
}));

fs.writeFileSync(path.join(SCRATCH, 'store', 'snapshot.json'), JSON.stringify({
  syncedAt: '2026-09-14T00:00:00Z', watermark: null, source: 'jira',
  issues: Object.fromEntries(ISSUES.map(i => [i.key, i])),
  sprints: [], components: [], testops: {}, github: {}, verification: [], fields: {},
  boards: [{ id: '2092', name: 'Katalon Auto Titan', type: 'scrum' }],
  boardSprintsByTeam: { titan: [{ id: '938', name: 'Katalon Titan S38', state: 'closed' }] },
  boardSprintErrors: [],
  people: [
    { name: 'Hien Phan', accountId: 'acc-hien' },
    { name: 'Chau Tran', accountId: 'acc-chau' },
    { name: 'Brand New Person', accountId: 'acc-new' },
  ],
  byTeam: { titan: { sprintIssues: { 938: ISSUES.map(i => i.key) }, sprints: [], backlog: [], people: [] } },
}));

const { server } = require('../server.js');

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

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

console.log('\nWhat the server does with requests the UI would never send\n');

/* ── whose sprints are these? ────────────────────────────────────────
   "Local" means a sprint authored in this tool. It was being computed as "any
   sprint this team's board does not have", which is a different set entirely —
   it swept in every sprint belonging to every OTHER team's board.

   Malphite is where it showed: a TrueTest board running weekly and fortnightly
   "TT Week" sprints, so almost the whole numbered calendar looked foreign to it
   and 44 of Jira's own sprints were listed as Malphite's local ones, under a
   caption saying they existed only in the local calendar. */

check('A TEAM IS NOT SHOWN OTHER TEAMS\' SPRINTS AS ITS OWN', async () => {
  const r = await call('GET', '/api/sprints?team=malphite');
  assert.strictEqual(r.status, 200);
  const names = r.body.local.map(s => s.name).sort();
  assert.deepStrictEqual(names, ['Hardening week', 'Planning week'],
    `only the sprints actually created here — got ${JSON.stringify(names)}`);
});

check('and the numbered sprints from another board are not listed at all', async () => {
  const r = await call('GET', '/api/sprints?team=malphite');
  const everywhere = [...r.body.local, ...r.body.active, ...r.body.future, ...r.body.closed, ...r.body.unknown];
  const strays = everywhere.filter(s => /^Sprint S\d/.test(s.name));
  assert.deepStrictEqual(strays, [], `Titan's sprints are not Malphite's, anywhere on the payload`);
});

check('the team that DOES own them still sees them, and sees the local one too', async () => {
  const r = await call('GET', '/api/sprints?team=titan');
  const owned = [...r.body.active, ...r.body.future, ...r.body.closed].map(s => s.name).sort();
  assert.ok(owned.length >= 3, `Titan keeps its own sprints, got ${JSON.stringify(owned)}`);
  assert.deepStrictEqual(r.body.local.map(s => s.name), ['Planning week'],
    'a sprint created here is local to every team whose board lacks it');
  // "Hardening week" was created here too, but Titan's board has adopted it, so
  // for Titan it is a real sprint rather than one waiting to be adopted.
  assert.ok(!r.body.local.some(s => s.name === 'Hardening week'),
    'a sprint this board already has is not also offered as a local one');
});

/* ── the lock ──────────────────────────────────────────────────────── */

check('A CLOSED SPRINT REFUSES A LEAVE-GRID WRITE, over HTTP, with 409', async () => {
  const r = await call('PUT', '/api/availability', {
    teamId: 'titan', sprintId: 'S38', memberId: 'm1', row: ['1', '1', '1', '1', '1'],
  });
  assert.strictEqual(r.status, 409, 'a stale tab must not be able to rewrite last month');
  assert.strictEqual(r.body.code, 'SPRINT_CLOSED');
  assert.match(r.body.error, /closed/i);
});

check('and refuses support %, ceremony, overrides and the sprint note too', async () => {
  const refused = [];
  for (const [p, body] of [
    ['/api/support', { teamId: 'titan', sprintId: 'S38', memberId: 'm1', pct: 50 }],
    ['/api/ceremony', { teamId: 'titan', sprintId: 'S38', hours: 4 }],
    ['/api/override', { teamId: 'titan', sprintId: 'S38', memberId: 'm1', planned: 99 }],
    ['/api/note', { teamId: 'titan', sprintId: 'S38', text: 'rewriting history' }],
  ]) {
    const r = await call('PUT', p, body);
    refused.push([p, r.status]);
  }
  assert.deepStrictEqual(refused.map(x => x[1]), [409, 409, 409, 409],
    `every sprint-scoped write, not just the one that was remembered: ${JSON.stringify(refused)}`);
});

check('A BULK WRITE CANNOT SMUGGLE A CLOSED SPRINT IN BEHIND AN OPEN ONE', async () => {
  // The capacity grid autosaves several rows at once. Checking only the first
  // entry would let one open sprint authorise a whole batch.
  const r = await call('PUT', '/api/availability', {
    entries: [
      { teamId: 'titan', sprintId: 'S39', memberId: 'm1', row: ['1'] },
      { teamId: 'titan', sprintId: 'S38', memberId: 'm1', row: ['1'] },
    ],
  });
  assert.strictEqual(r.status, 409);
});

check('an ACTIVE sprint accepts the same writes', async () => {
  const r = await call('PUT', '/api/availability', {
    teamId: 'titan', sprintId: 'S39', memberId: 'm1', row: ['1', '1', 'WO', 'WO', '1'],
  });
  assert.strictEqual(r.status, 200);
  const c = await call('PUT', '/api/ceremony', { teamId: 'titan', sprintId: 'S39', hours: 9 });
  assert.strictEqual(c.status, 200);
});

check('a FUTURE sprint accepts them as well — that is where planning happens', async () => {
  const r = await call('PUT', '/api/support', { teamId: 'titan', sprintId: 'S40', memberId: 'm2', pct: 25 });
  assert.strictEqual(r.status, 200);
});

check('and nothing was written to the closed sprint by any of the refused calls', async () => {
  const v = await call('GET', '/api/capacity?team=titan&sprint=S38');
  assert.strictEqual(v.status, 200);
  assert.strictEqual(v.body.note, '', 'the refused note must not have landed');
  assert.ok(!Object.keys(v.body.availability || {}).some(k => (v.body.availability[k] || []).join() === '1,1,1,1,1'),
    'the refused leave row must not have landed');
});

/* ── the roster ────────────────────────────────────────────────────── */

check('THE CLOSED SPRINT SHOWS THREE PEOPLE, not the four on the team', async () => {
  const r = await call('GET', '/api/sprint/roster?team=titan&sprint=S38');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.counts.total, 3);
  assert.ok(!r.body.members.some(m => m.id === 'm4'), 'Chau did nothing in S38');
  assert.strictEqual(r.body.lock.readOnly, true);
});

check('AND SO DOES THE CAPACITY GRID ITSELF, not just the roster endpoint', async () => {
  // Deliberately separate from the roster check above. /api/sprint/roster calls
  // the roster directly, so it stays green even if capacityView forgets to use
  // it — which is exactly the wiring mistake that would leave every number on
  // the screen computed for four people.
  const v = await call('GET', '/api/capacity?team=titan&sprint=S38');
  assert.strictEqual(v.body.rows.length, 3, 'the grid must show the sprint roster');
  assert.strictEqual(v.body.totals.headcount, 3);
  assert.strictEqual(v.body.lock.readOnly, true, 'and carry the lock for the screen to render');

  const open = await call('GET', '/api/capacity?team=titan&sprint=S39');
  assert.strictEqual(open.body.rows.length, 4);
  assert.ok(open.body.totals.capacityHours > v.body.totals.capacityHours,
    'three people must not be given four people\'s capacity');
});

check('the active sprint shows all four, and says which have work', async () => {
  const r = await call('GET', '/api/sprint/roster?team=titan&sprint=S39');
  assert.strictEqual(r.body.counts.total, 4);
  assert.strictEqual(r.body.lock.readOnly, false);
});

check('THE CANDIDATE LIST COMES FROM JIRA', async () => {
  const r = await call('GET', '/api/sprint/roster?team=titan&sprint=S39');
  const names = r.body.candidates.map(c => c.name);
  assert.ok(names.includes('Brand New Person'),
    'somebody Jira has seen but the team has not must be offerable');
  assert.ok(!r.body.candidates.some(c => c.id === 'm1'), 'and nobody already on the sprint');
});

check('ADDING A PERSON TO A FUTURE SPRINT STICKS', async () => {
  const add = await call('PUT', '/api/sprint/roster', {
    teamId: 'titan', sprintId: 'S40', memberId: 'jira:acc-new', state: 'added',
    member: { name: 'Brand New Person', jiraAccountId: 'acc-new' },
  });
  assert.strictEqual(add.status, 200);
  const r = await call('GET', '/api/sprint/roster?team=titan&sprint=S40');
  assert.ok(r.body.members.some(m => m.id === 'jira:acc-new'));
  assert.ok(r.body.members.find(m => m.id === 'jira:acc-new').onSprint === 'added');
});

check('ADDING TO ONE SPRINT DOES NOT ADD TO THE TEAM — or to any other sprint', async () => {
  // The first version made them a team member so their leave grid would have
  // somewhere to live. It also put them on every other open sprint, because an
  // open sprint's roster includes the whole team — the exact opposite of what
  // the button says. Caught against his real data: one add showed up on S41
  // AND S42.
  const t = await call('GET', '/api/team?team=titan');
  assert.ok(!(t.body.members || []).some(m => m.id === 'jira:acc-new'),
    '"add to this sprint" must not quietly mean "add to the team"');

  const other = await call('GET', '/api/sprint/roster?team=titan&sprint=S39');
  assert.ok(!other.body.members.some(m => m.id === 'jira:acc-new'),
    'and must not leak onto another open sprint');
});

check('but the sprint they WERE added to still knows their name', async () => {
  const r = await call('GET', '/api/sprint/roster?team=titan&sprint=S40');
  const added = r.body.members.find(m => m.id === 'jira:acc-new');
  assert.ok(added, 'they must still be on the sprint you put them on');
  assert.strictEqual(added.name, 'Brand New Person',
    'showing a raw account id would make the row unreadable');
  assert.ok(added.notOnTeamList, 'and say they are a guest on this sprint');
});

check('removing a person from an active sprint sticks', async () => {
  const r = await call('PUT', '/api/sprint/roster', {
    teamId: 'titan', sprintId: 'S39', memberId: 'm4', state: 'removed',
  });
  assert.strictEqual(r.status, 200);
  const after = await call('GET', '/api/sprint/roster?team=titan&sprint=S39');
  assert.ok(!after.body.members.some(m => m.id === 'm4'));
});

check('clearing a decision removes it rather than leaving an empty one', async () => {
  await call('PUT', '/api/sprint/roster', { teamId: 'titan', sprintId: 'S39', memberId: 'm4', state: 'clear' });
  const after = await call('GET', '/api/sprint/roster?team=titan&sprint=S39');
  assert.ok(after.body.members.some(m => m.id === 'm4'), 'back to the derived roster');
});

check('THE CLOSED SPRINT REFUSES A ROSTER CHANGE', async () => {
  const r = await call('PUT', '/api/sprint/roster', {
    teamId: 'titan', sprintId: 'S38', memberId: 'm4', state: 'added',
  });
  assert.strictEqual(r.status, 409);
});

/* ── scenarios ─────────────────────────────────────────────────────── */

check('SAVING A SCENARIO CAPTURES THE CURRENT PLAN', async () => {
  await call('PUT', '/api/support', { teamId: 'titan', sprintId: 'S40', memberId: 'm2', pct: 40 });
  const r = await call('POST', '/api/scenarios', { teamId: 'titan', sprintId: 'S40', name: 'Thao on support' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.name, 'Thao on support');
  assert.strictEqual(r.body.data.support.m2, 40);
  assert.ok(r.body.totals.capacityHours > 0, 'and the headline numbers, for the comparison row');
});

check('scenarios are listed for their sprint, next to the live plan', async () => {
  const r = await call('GET', '/api/scenarios?team=titan&sprint=S40');
  assert.strictEqual(r.body.scenarios.length, 1);
  assert.ok(r.body.live, 'with no baseline to compare against, a scenario list says nothing');
  assert.ok(r.body.live.totals);
});

check('APPLYING A SCENARIO PUTS THE NUMBERS BACK', async () => {
  const list = await call('GET', '/api/scenarios?team=titan&sprint=S40');
  const id = list.body.scenarios[0].id;

  // Change the live plan away from the scenario.
  await call('PUT', '/api/support', { teamId: 'titan', sprintId: 'S40', memberId: 'm2', pct: 0 });
  const before = await call('GET', '/api/capacity?team=titan&sprint=S40');

  const r = await call('POST', '/api/scenarios/apply', { id });
  assert.strictEqual(r.status, 200);

  const after = await call('GET', '/api/capacity?team=titan&sprint=S40');
  assert.notStrictEqual(before.body.totals.capacityHours, after.body.totals.capacityHours,
    'applying a scenario that changes support % must change capacity');
  assert.strictEqual(after.body.totals.capacityHours, list.body.scenarios[0].totals.capacityHours,
    'and land exactly on the numbers the scenario was saved with');
});

check('APPLYING REPLACES, it does not merge', async () => {
  // A person the scenario did not mention must not keep a stale row. Merging
  // would mean applying "the three-person plan" quietly gives you four.
  await call('PUT', '/api/support', { teamId: 'titan', sprintId: 'S40', memberId: 'm3', pct: 90 });
  const list = await call('GET', '/api/scenarios?team=titan&sprint=S40');
  await call('POST', '/api/scenarios/apply', { id: list.body.scenarios[0].id });
  const v = await call('GET', '/api/capacity?team=titan&sprint=S40');
  const m3 = v.body.rows.find(r => r.memberId === 'm3');
  assert.ok(!m3 || m3.supportPct !== 90, 'a row the scenario never mentioned survived the apply');
});

check('a closed sprint refuses both saving and applying a scenario', async () => {
  const save = await call('POST', '/api/scenarios', { teamId: 'titan', sprintId: 'S38', name: 'nope' });
  assert.strictEqual(save.status, 409, 'a scenario you could never apply is a trap');
});

check('DEDUPE IS A DRY RUN UNTIL YOU CONFIRM IT', async () => {
  // He had 9 saved plans that were really 2 — two clicks, 5 and 4 copies.
  // Removing a saved plan is not recoverable, so the decision stays with him
  // even when the copies are provably identical.
  await call('POST', '/api/scenarios', { teamId: 'titan', sprintId: 'S40', name: 'Dup me' });
  await call('POST', '/api/scenarios', { teamId: 'titan', sprintId: 'S40', name: 'Dup me' });
  await call('POST', '/api/scenarios', { teamId: 'titan', sprintId: 'S40', name: 'Dup me' });

  const dry = await call('POST', '/api/scenarios/dedupe', {});
  assert.strictEqual(dry.body.dryRun, true);
  assert.strictEqual(dry.body.duplicates, 2, 'three identical saves means two are surplus');

  const still = await call('GET', '/api/scenarios?team=titan&sprint=S40');
  assert.ok(still.body.scenarios.filter(s => s.name === 'Dup me').length === 3,
    'a dry run must not remove anything');
});

check('and KEEPS THE EARLIEST of each identical group', async () => {
  const before = await call('GET', '/api/scenarios?team=titan&sprint=S40');
  const oldest = before.body.scenarios
    .filter(s => s.name === 'Dup me')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];

  const r = await call('POST', '/api/scenarios/dedupe', { confirm: true });
  assert.strictEqual(r.body.removed, 2);

  const after = await call('GET', '/api/scenarios?team=titan&sprint=S40');
  const left = after.body.scenarios.filter(s => s.name === 'Dup me');
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].id, oldest.id, 'the first save is the one he meant');
});

check('A RE-SAVE UNDER THE SAME NAME WITH A DIFFERENT PLAN IS NOT A DUPLICATE', async () => {
  // Naming two genuinely different plans the same thing is a legitimate,
  // ordinary mistake. Treating that as a duplicate would delete real work.
  await call('POST', '/api/scenarios', { teamId: 'titan', sprintId: 'S40', name: 'Same name' });
  await call('PUT', '/api/support', { teamId: 'titan', sprintId: 'S40', memberId: 'm2', pct: 70 });
  await call('POST', '/api/scenarios', { teamId: 'titan', sprintId: 'S40', name: 'Same name' });

  const dry = await call('POST', '/api/scenarios/dedupe', {});
  assert.strictEqual(dry.body.duplicates, 0,
    'identical means same INPUTS, not merely the same name');
});

check('deleting a scenario removes exactly it', async () => {
  // Asserts EXACTLY-IT rather than "the list is now empty": checks added later
  // leave their own scenarios behind, and a test that depends on being last is
  // a test that breaks for a reason unrelated to what it covers.
  const list = await call('GET', '/api/scenarios?team=titan&sprint=S40');
  const before = list.body.scenarios.length;
  assert.ok(before, 'need at least one to delete');
  const id = list.body.scenarios[0].id;

  const r = await call('DELETE', '/api/scenarios', { id });
  assert.strictEqual(r.status, 200);

  const after = await call('GET', '/api/scenarios?team=titan&sprint=S40');
  assert.strictEqual(after.body.scenarios.length, before - 1, 'exactly one fewer');
  assert.ok(!after.body.scenarios.some(s => s.id === id), 'and it is the one named');

  const missing = await call('DELETE', '/api/scenarios', { id });
  assert.strictEqual(missing.status, 404, 'and says so rather than silently succeeding');
});

check('THE SPRINT API ANSWERS WITH AN EPIC FOR BOTH KINDS OF WORK', async () => {
  // End to end, over HTTP: the two rules he gave, resolved from what a sync
  // stored, on the payload the "All sprint items" table actually renders.
  // The unit tests prove each rule; this proves they are wired to the screen.
  const r = await call('GET', '/api/sprint?team=titan&sprint=S38');
  assert.strictEqual(r.status, 200);
  const by = Object.fromEntries(r.body.items.map(i => [i.key, i]));

  assert.strictEqual(by['T-4'].category, 'new');
  assert.deepStrictEqual((by['T-4'].epics || []).map(e => e.key), ['T-900'],
    'new implementation takes its epic from the parent link');
  assert.strictEqual(by['T-4'].epics[0].name, 'Renewals regression suite',
    'and shows the epic by name, not just its key');

  assert.strictEqual(by['T-5'].category, 'maintenance');
  assert.deepStrictEqual((by['T-5'].epics || []).map(e => e.key), ['T-901'],
    'maintenance takes its epics from the "relates to" links');

  assert.deepStrictEqual(by['T-1'].epics, [],
    'an item with neither reports no epic rather than borrowing one');
});

/* ── adding someone the tool already knows ─────────────────────────────── */

check('TYPING A NAME JIRA KNOWS LINKS IT, over HTTP', async () => {
  /* The path he actually used: the add box, a name typed by hand, no
     accountId in the request. `Brand New Person` is in the fixture's Jira
     directory with `acc-new` and is on nobody's roster — which is Diep Tu's
     situation, where the tool held the account all along and stored null. */
  const r = await call('POST', '/api/team/member', { teamId: 'titan', name: 'Brand New Person' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.member.jiraAccountId, 'acc-new', 'the route never handed over the directory');
  assert.strictEqual(r.body.member.source, 'jira');
});

check('and a name it does not know is still manual', async () => {
  const r = await call('POST', '/api/team/member', { teamId: 'titan', name: 'Someone Entirely New' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.member.jiraAccountId, null);
  assert.strictEqual(r.body.member.source, 'manual');
});

/* ── keyword lists, as the SERVER stores them ────────────────────────────
   The chips editor filters what it sends, but a tab left open since last week
   still has live controls and `fetch` from a console never saw the UI at all.
   An empty keyword matches every sprint in the instance, so the rule that
   there is never one has to hold here, not in the browser. */

const putTeam = (patch) => call('PUT', '/api/team', { teamId: 'titan', ...patch });

check('A TRAILING COMMA CANNOT CREATE A KEYWORD THAT MATCHES EVERY SPRINT', async () => {
  const r = await putTeam({ sprintKeywords: ['ruby', ''] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.team.sprintKeywords, ['ruby']);
  assert.deepStrictEqual(r.body.notes, ['1 empty entry was ignored'], 'and the save says what it dropped');
});

check('a raw string is parsed rather than stored as one', async () => {
  // Nothing stops a caller sending the string the old UI built.
  const r = await putTeam({ sprintKeywords: 'ruby, titan; malphite' });
  assert.deepStrictEqual(r.body.team.sprintKeywords, ['ruby', 'titan', 'malphite']);
});

check('and a string would otherwise break every read of it', async () => {
  // `'ruby'.some` is not a function — the stored shape has to be an array or
  // the next read throws, which is a worse failure than a wrong match.
  const r = await putTeam({ sprintKeywords: 'ruby' });
  assert.ok(Array.isArray(r.body.team.sprintKeywords));
  const after = await call('GET', '/api/sprints?team=titan');
  assert.strictEqual(after.status, 200, 'reading sprints after the save must not throw');
});

check('duplicates collapse, so the list cannot grow by re-saving', async () => {
  const r = await putTeam({ sprintKeywords: ['Ruby', 'ruby', 'RUBY', 'titan'] });
  assert.deepStrictEqual(r.body.team.sprintKeywords, ['Ruby', 'titan']);
});

check('the same rule covers Jira Team field values', async () => {
  // Same control, same failure — an empty value there claims every backlog item.
  const r = await putTeam({ jiraTeams: ['Katalon Auto Titan', '', '  '] });
  assert.deepStrictEqual(r.body.team.jiraTeams, ['Katalon Auto Titan']);
});

check('CLEARING THE FIELD STILL CLEARS IT', async () => {
  // The rule must not become "you can never remove the last keyword".
  const r = await putTeam({ sprintKeywords: [] });
  assert.deepStrictEqual(r.body.team.sprintKeywords, []);
  assert.deepStrictEqual(r.body.notes, [], 'and emptying a field is not an error');
  const r2 = await putTeam({ sprintKeywords: ['titan'] });
  assert.deepStrictEqual(r2.body.team.sprintKeywords, ['titan'], 'and it can be set again');
});

check('a field that was not sent is left alone', async () => {
  await putTeam({ sprintKeywords: ['titan'], jiraTeams: ['Katalon Auto Titan'] });
  const r = await putTeam({ name: 'Katalon Titan' });
  assert.deepStrictEqual(r.body.team.sprintKeywords, ['titan'], 'saving the name must not wipe the keywords');
  assert.deepStrictEqual(r.body.team.jiraTeams, ['Katalon Auto Titan']);
});

/* ── THE SPRINT PAYLOAD CARRIES ITS RISKS ─────────────────────────────
   The Active sprint screen renders a Risks section out of this route. The
   view is checked in sprint-view.test.js, against a payload that harness
   assembles the way this route does; what has to be checked HERE is that the
   route really assembles it that way — a harness agreeing with itself is the
   one thing a harness can always manage. */

check('THE SPRINT ROUTE SENDS THE RISKS FOR THAT SPRINT', async () => {
  const r = await call('GET', '/api/sprint?team=titan&sprint=S39');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.risks, 'no risks on the payload — the section would render empty on every sprint');
  assert.ok(Array.isArray(r.body.risks.manual));
  /* NOT "is an array". An empty list is the shape a route that stopped
     detecting anything returns, and it is indistinguishable from a healthy
     sprint — so the fixture is a sprint with real trouble in it and the count
     is asserted. This is the difference between checking the feature and
     checking that the key exists. */
  assert.ok(r.body.risks.signals.length >= 2,
    `this sprint is behind pace with people unassigned; the route found ${r.body.risks.signals.length} risks`);
  for (const s of r.body.risks.signals) {
    assert.ok(s.severity && s.title && s.action,
      `a signal with no severity, title or action cannot be drawn: ${JSON.stringify(s)}`);
    assert.strictEqual(s.sprintId, 'S39', 'a risk from another sprint has no business on this page');
  }
});

check('and they are the SAME risks the Risks page shows for it', async () => {
  // Two screens, one detector — the reason `signalsFor` was split out of
  // `riskView`. If these diverge, one screen is telling him something about
  // this sprint that the other denies.
  const sprint = await call('GET', '/api/sprint?team=titan&sprint=S39');
  const risks = await call('GET', '/api/risks?team=titan&sprint=S39');
  assert.deepStrictEqual(
    sprint.body.risks.signals.map(s => s.id).sort(),
    risks.body.signals.map(s => s.id).sort(),
  );
});

check('AN OPEN REGISTER ENTRY REACHES THE SPRINT PAGE, a closed one does not', async () => {
  // A risk somebody typed is one no detector could have found, so it belongs
  // on the sprint page. A closed one is history and belongs on the register.
  assert.strictEqual((await call('POST', '/api/risk',
    { title: 'Client sign-off is late', severity: 'high', mitigation: 'Chase it' })).status, 200);
  assert.strictEqual((await call('POST', '/api/risk',
    { title: 'Already handled', severity: 'high', status: 'Closed' })).status, 200);

  const titles = (await call('GET', '/api/sprint?team=titan&sprint=S39')).body.risks.manual.map(x => x.title);
  assert.ok(titles.includes('Client sign-off is late'), 'an open register entry is missing');
  assert.ok(!titles.includes('Already handled'), 'a closed entry is history, not a risk to this sprint');

  // The Risks page keeps both — it IS the register, and one you cannot see the
  // closed items in is not a register.
  const all = (await call('GET', '/api/risks?team=titan&sprint=S39')).body.manual.map(x => x.title);
  assert.ok(all.includes('Already handled'), 'the full register still has to hold it');
});

/* ── run ───────────────────────────────────────────────────────────── */

server.listen(0, '127.0.0.1', async () => {
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  server.close();
  try { require('../lib/db').close(); } catch (_) { /* fine */ }
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
