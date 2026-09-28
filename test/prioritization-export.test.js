'use strict';
/**
 * prioritization-export.test.js — the file has to be the screen.
 *
 * prioritization.test.js proves the model. This proves the FILE, over HTTP,
 * and the two failures worth guarding are both silent:
 *
 *   A SCOPE THAT DOES NOT TRAVEL. "Exclude active sprint items" changes what
 *   the numbers are counted over. A link that drops it downloads different
 *   figures under the same column headings as the screen that produced them,
 *   and nothing in the file says which one it is. That is worse than no
 *   export: a spreadsheet gets forwarded, and the screen is long gone.
 *
 *   A LENS THAT DOES. The level and family chips hide rows without changing a
 *   number. A file that honoured them would be whatever shortlist somebody
 *   happened to be looking at, named as though it were the whole list — the
 *   trap the Backlog export already documents.
 *
 * ITS OWN FIXTURE, in its own file. The API suites have no ranked components
 * at all, so an export check bolted onto one of them would have run over zero
 * rows and passed — which is exactly what the first attempt did. Adding
 * priorities to a shared fixture to fix that is how a suite about something
 * else starts failing for reasons nobody can place.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-pzx-'));
fs.mkdirSync(path.join(SCRATCH, 'store'), { recursive: true });
process.env.STORE_DIR = SCRATCH;
process.env.DB_FILE = path.join(SCRATCH, 'store', 'test.db');
process.env.PORT = '0';

/* ── a project shaped like his ───────────────────────────────────────── */

const TEAM_IN = 'Katalon PSA (Titan)';
const TEAM_OUT = 'Katalon RDA (Ruby)';

const epic = (key, o = {}) => ({
  key, issueType: 'Epic', summary: o.summary || `Epic ${key}`,
  components: o.components || [], automationStatus: o.automationStatus || '',
  labels: o.labels || [], team: o.team || TEAM_IN, status: 'Open',
  relatesTo: [], blockedBy: [],
});

/** A Story in the active sprint, hung off an epic — what the exclude scope reads. */
const story = (key, parentKey) => ({
  key, issueType: 'Story', summary: key, status: 'In Dev', statusCategory: 'indeterminate',
  components: [], labels: [], points: 3, assignee: 'Hien Phan', assigneeId: 'acc-hien',
  parentKey, relatesTo: [], blockedBy: [],
  sprints: [{ id: '940', name: 'Katalon Titan S40', state: 'active' }],
  sprintNames: ['Katalon Titan S40'], team: TEAM_IN, datasets: ['sprintWork'],
});

const EPICS = [
  // PS_iGO_NLG — both tools, and the one the sprint is working on.
  epic('E-1', { components: ['PS_iGO_NLG', 'TrueTest'], automationStatus: 'Automated' }),
  epic('E-2', { components: ['PS_iGO_NLG', 'TrueTest'], automationStatus: 'Maintenance' }),
  epic('E-3', { components: ['PS_iGO_NLG'], automationStatus: 'Ready for Automation' }),
  epic('E-4', { components: ['PS_iGO_NLG'], automationStatus: 'Ready for Automation' }),
  // R&D_Core — a second family, so the Family column has something to say.
  epic('E-5', { components: ['R&D_Core'], automationStatus: 'Automated' }),
  epic('E-6', { components: ['R&D_Core'], automationStatus: 'Blocked' }),
  // Ranked AND excluded — the contradiction the page surfaces.
  epic('E-7', { components: ['KAT_Engineering'], automationStatus: 'N/A for Automation' }),
  // Another squad on a ranked component — the team allow-list cut.
  epic('E-8', { components: ['R&D_Core'], automationStatus: 'Automated', team: TEAM_OUT }),
];

/* E-4 is planned in the active sprint. With "exclude active sprint items" on
   it leaves the Ready for Automation count on PS_iGO_NLG — which is the one
   number these checks watch, so the scope is provably not a no-op here. */
const SPRINT_WORK = [story('S-1', 'E-4')];
const ISSUES = [...EPICS, ...SPRINT_WORK];

const TEAM = {
  id: 'titan', name: 'Katalon Titan', jiraTeams: [TEAM_IN], sprintKeywords: ['titan'],
  settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 },
  members: [{ id: 'm1', name: 'Hien Phan', role: 'Auto QA', status: 'Active', supportPct: 0, jiraAccountId: 'acc-hien' }],
};

fs.writeFileSync(path.join(SCRATCH, 'store', 'plan.json'), JSON.stringify({
  version: 1,
  teams: [TEAM],
  sprints: [{
    id: 'S40', number: 40, name: 'Sprint 40', start: '2026-09-17', end: '2026-09-30', source: 'jira',
    byTeam: { titan: { jiraId: '940', name: 'Katalon Titan S40', state: 'active' } },
  }],
  holidays: [], availability: {}, support: {}, ceremony: {}, overrides: {},
  risks: [], notes: {}, excluded: {}, ignoredBoards: [], savedSearches: [],
  categoryRules: null, mixTargets: null, sprintRoster: {}, scenarios: [],
  componentPriority: { PS_iGO_NLG: 1, 'R&D_Core': 2, KAT_Engineering: 3 },
  componentNote: { PS_iGO_NLG: 'Waiting on the, ahem, "migration"' },
  excludedComponents: ['KAT_Engineering'],
  /* BOTH squads on the global allow-list, so the per-team filter has something
     left to cut. With only TEAM_IN here the allow-list has already removed
     E-8 before any team is chosen, and a check that the team filter narrows
     the file compares two identical numbers. */
  coverageTeams: [TEAM_IN, TEAM_OUT],
}));

fs.writeFileSync(path.join(SCRATCH, 'store', 'snapshot.json'), JSON.stringify({
  syncedAt: '2026-09-28T00:00:00Z', watermark: null, source: 'jira',
  issues: Object.fromEntries(ISSUES.map(i => [i.key, i])),
  sprints: [], components: [], testops: {}, github: {}, verification: [], fields: {},
  boards: [], boardSprintsByTeam: {}, boardSprintErrors: [], people: [],
  byTeam: { titan: { sprintIssues: { 940: SPRINT_WORK.map(i => i.key) }, sprints: [], backlog: [], people: [] } },
}));

const { server } = require('../server.js');

let base = '';
let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nThe Prioritization export\n');

const call = (p) => new Promise((resolve, reject) => {
  http.get(`${base}${p}`, (res) => {
    let out = '';
    res.on('data', c => { out += c; });
    res.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch (_) { parsed = out; }
      resolve({ status: res.statusCode, body: parsed, headers: res.headers });
    });
  }).on('error', reject);
});

/* RFC-4180 aware, because the note in the fixture carries a comma AND quotes.
   Splitting on commas would pass on every column until somebody wrote a real
   sentence in a note, and then shift that row silently. */
const parseCsv = (text) => {
  const src = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
};

const sheet = async (query = '') => {
  const r = await call(`/api/export?what=prioritization${query}`);
  assert.strictEqual(r.status, 200, `export failed: ${JSON.stringify(r.body).slice(0, 200)}`);
  const rows = parseCsv(r.body);
  const header = rows[0];
  const at = (name) => {
    const i = header.indexOf(name);
    assert.ok(i >= 0, `no "${name}" column: ${header.join(' | ')}`);
    return i;
  };
  const body = rows.slice(1);
  return {
    raw: r, header, body, at,
    row: (component) => body.find(x => x[0] === component),
    cell: (component, col) => {
      const x = body.find(y => y[0] === component);
      assert.ok(x, `${component} has no row in the file`);
      return x[at(col)];
    },
  };
};

/* ── what it carries ──────────────────────────────────────────────────── */

check('EVERY RANKED COMPONENT IS A ROW, whatever the chips would have hidden', async () => {
  const api = await call('/api/prioritization');
  const s = await sheet();
  // Two: PS_iGO_NLG and R&D_Core. KAT_Engineering is ranked AND excluded, so
  // it is named on the page as a contradiction rather than counted as a row.
  assert.strictEqual(api.body.rows.length, 2, 'fixture check: the ranked components have changed');
  for (const r of api.body.rows) {
    assert.ok(s.row(r.component), `${r.component} is on the page but not in the file`);
  }
  // Rows plus the total line, and nothing else invented.
  assert.strictEqual(s.body.length, api.body.rows.length + 1,
    `expected ${api.body.rows.length} components plus a total, got ${s.body.length}`);
});

check('THE NUMBERS ARE THE PAGE\'S NUMBERS, cell for cell', async () => {
  /* The file and the page are one `prioritization.view`. A CSV that recomputed
     anything is a second implementation of this grid, and the two part company
     the first time either changes — on a file people forward. */
  const api = await call('/api/prioritization');
  const s = await sheet();
  let compared = 0;
  for (const r of api.body.rows) {
    for (const t of api.body.tools) {
      for (const b of api.body.buckets) {
        assert.strictEqual(s.cell(r.component, `${t.label} — ${b.label}`), String(r[t.key][b.key]),
          `${r.component} / ${t.label} ${b.label} disagrees with the page`);
        compared++;
      }
    }
  }
  assert.ok(compared >= 20, `only ${compared} cells compared — the fixture is too thin to mean anything`);
});

check('PRIORITY, FAMILY AND THE NOTE TRAVEL — the three columns that are his, not Jira\'s', async () => {
  const s = await sheet();
  assert.strictEqual(s.cell('PS_iGO_NLG', 'Priority'), 'P1');
  assert.strictEqual(s.cell('R&D_Core', 'Priority'), 'P2');
  assert.strictEqual(s.cell('PS_iGO_NLG', 'Family'), 'PS');
  assert.strictEqual(s.cell('R&D_Core', 'Family'), 'R&D');
  // The short name, not "PS — client delivery": a column to pivot on, not an
  // explanation. The explanation belongs on the screen.
  assert.ok(!s.cell('PS_iGO_NLG', 'Family').includes('—'), 'the long family label leaked into the file');
  assert.strictEqual(s.cell('PS_iGO_NLG', 'Notes'), 'Waiting on the, ahem, "migration"',
    'a note with a comma and quotes must survive the round trip intact');
});

/* ── the scopes travel ────────────────────────────────────────────────── */

check('EXCLUDE ACTIVE SPRINT ITEMS CHANGES THE FILE, exactly as it changes the page', async () => {
  /* The failure this exists for: the toggle is on, the file is not, and the
     spreadsheet carries different figures under the same headings. */
  const plain = await call('/api/prioritization');
  const excl = await call('/api/prioritization?excludeActiveSprint=1');
  const before = plain.body.rows.find(r => r.component === 'PS_iGO_NLG');
  const after = excl.body.rows.find(r => r.component === 'PS_iGO_NLG');
  assert.notStrictEqual(before.kse.ready, after.kse.ready,
    'fixture check: the scope has to move a number, or this check proves nothing');

  const a = await sheet();
  const b = await sheet('&excludeActiveSprint=1');
  assert.strictEqual(a.cell('PS_iGO_NLG', 'KSE — Ready for Automation'), String(before.kse.ready));
  assert.strictEqual(b.cell('PS_iGO_NLG', 'KSE — Ready for Automation'), String(after.kse.ready),
    'the scope did not reach the file');
});

check('AND THE FILENAME SAYS WHICH ONE IT IS', async () => {
  // Two files with the same name and different numbers is how the wrong one
  // gets attached to the wrong email.
  const plain = await call('/api/export?what=prioritization');
  const excl = await call('/api/export?what=prioritization&excludeActiveSprint=1');
  assert.match(plain.headers['content-disposition'], /filename="prioritization\.csv"/);
  assert.match(excl.headers['content-disposition'], /filename="prioritization-not-in-sprint\.csv"/);
});

check('THE TEAM TRAVELS, and an unknown one is refused rather than answered for', async () => {
  /* `findTeam` falls back to the first team on an id it does not know, which
     is right for a capacity screen that must show something and wrong here:
     the file would answer for Titan a question asked about Ruby, and look
     entirely normal doing it. */
  const mine = await call('/api/export?what=prioritization&team=titan');
  assert.strictEqual(mine.status, 200);
  assert.match(mine.headers['content-disposition'], /filename="prioritization-titan\.csv"/);

  const ghost = await call('/api/export?what=prioritization&team=nosuch');
  assert.strictEqual(ghost.status, 404, 'an unknown team must be refused, not silently substituted');
});

check('THE TEAM FILTER NARROWS THE FILE the way it narrows the page', async () => {
  const api = await call('/api/prioritization?team=titan');
  const s = await sheet('&team=titan');
  for (const r of api.body.rows) {
    assert.strictEqual(s.cell(r.component, 'KSE — Automated'), String(r.kse.automated),
      `${r.component} disagrees with the page under the team filter`);
  }
  // E-8 belongs to another squad on R&D_Core, so the team cut has to bite.
  const all = await call('/api/prioritization');
  const allRow = all.body.rows.find(r => r.component === 'R&D_Core');
  const mineRow = api.body.rows.find(r => r.component === 'R&D_Core');
  assert.ok(mineRow, 'fixture check: R&D_Core must survive the team filter');
  assert.notStrictEqual(allRow.kse.automated, mineRow.kse.automated,
    'fixture check: the team filter has to move a number here');
});

/* ── the total, and the file's manners ────────────────────────────────── */

check('THE TOTAL ROW IS LABELLED A TOTAL, and matches the page', async () => {
  /* A component is counted under both tools, so the two tool columns are not
     addable across each other — and somebody will try. The label is what
     stops the last row being read as another component. */
  const api = await call('/api/prioritization');
  const s = await sheet();
  const last = s.body[s.body.length - 1];
  assert.match(last[0], /^Total — \d+ components$/, `the last row does not announce itself: ${last[0]}`);
  assert.strictEqual(last[s.at('KSE — Automated')], String(api.body.totals.kse.automated));
  assert.strictEqual(last[s.at('TrueTest — Automated')], String(api.body.totals.truetest.automated));
  assert.strictEqual(last[s.at('Priority')], '', 'the total row must not claim a priority');
});

check('THE FILE LEADS WITH A BYTE-ORDER MARK, or Excel mangles the dashes', async () => {
  // Every column heading here contains an em dash — "TrueTest — Automated".
  // Without the BOM Excel reads them as the local codepage and the whole
  // header row comes out as mojibake.
  const r = await call('/api/export?what=prioritization');
  assert.ok(String(r.body).startsWith('﻿'), 'no BOM');
  assert.match(String(r.headers['content-type']), /charset=utf-8/);
});

check('AND IT IS SERVED AS A DOWNLOAD, not rendered in the tab', async () => {
  const r = await call('/api/export?what=prioritization');
  assert.match(String(r.headers['content-type']), /^text\/csv/);
  assert.match(String(r.headers['content-disposition']), /^attachment;/);
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
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
