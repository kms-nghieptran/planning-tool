'use strict';
/**
 * by-component-export.test.js — the Capacity sheet as a file, over HTTP.
 *
 * by-component.test.js proves the model and sprint-view.test.js proves the
 * table. This proves the FILE, and the failures worth guarding are the ones a
 * spreadsheet cannot show you, because by the time it is read the screen that
 * produced it is long gone:
 *
 *   A SCOPE THAT DOES NOT TRAVEL. Team and sprint decide which epics were
 *   counted at all. A link that drops either downloads different figures
 *   under the same column headings, and nothing in the file says which.
 *
 *   A LENS THAT DOES. The family chips and the clear-row fold hide rows
 *   without changing a number. A file that honoured them would be whichever
 *   seventeen rows somebody was looking at, named as though it were the whole
 *   list of 129.
 *
 *   NUMBERS WITH NO KEYS. On screen every number opens a drawer listing what
 *   it counted. A file of the bare numbers is the one copy of this table
 *   nobody can audit, and the first question asked of a spreadsheet is always
 *   "which ones".
 *
 * ITS OWN FIXTURE, in its own file — the same reasoning the Prioritization
 * export file gives. The API suites have no ranked components, so an export
 * check bolted onto one of them would run over zero rows and pass.
 *
 * Run: node test/by-component-export.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-bcx-'));
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

const planned = (key, type, o = {}) => ({
  key, issueType: type, summary: key, status: 'In Dev', statusCategory: 'indeterminate',
  components: [], labels: [], points: 3, assignee: 'Hien Phan', assigneeId: 'acc-hien',
  parentKey: o.epic || null,
  relatesTo: (o.relates || []).map(k => ({ key: k, summary: `linked ${k}`, type: 'Epic' })),
  blockedBy: [], team: TEAM_IN, datasets: ['sprintWork'],
  sprints: [{ id: o.jiraId || '940', name: o.sprintName || 'Katalon Titan S40', state: o.state || 'active' }],
  sprintNames: [o.sprintName || 'Katalon Titan S40'],
});

const EPICS = [
  // PS_iGO_NLG — both tools, and every backlog column occupied.
  epic('E-1', { components: ['PS_iGO_NLG', 'TrueTest'], automationStatus: 'Maintenance' }),
  epic('E-2', { components: ['PS_iGO_NLG'], automationStatus: 'Ready for Automation' }),
  epic('E-3', { components: ['PS_iGO_NLG'], automationStatus: 'Blocked' }),
  // Automated — in scope and NOT backlog, so the file's trio is provably
  // narrower than "every epic on this component".
  epic('E-4', { components: ['PS_iGO_NLG'], automationStatus: 'Automated' }),
  // The one the sprint is building, and the one it is maintaining.
  epic('E-5', { components: ['PS_iGO_NLG'], automationStatus: 'Ready for Automation' }),
  epic('E-6', { components: ['PS_iGO_NLG', 'TrueTest'], automationStatus: 'Maintenance' }),
  // A second family, so the Family column has something to say.
  epic('E-7', { components: ['R&D_Core'], automationStatus: 'Blocked' }),
  // Ranked AND excluded — the contradiction the page surfaces.
  epic('E-8', { components: ['KAT_Engineering'], automationStatus: 'Ready for Automation' }),
  // Another squad on a ranked component — the team allow-list cut.
  epic('E-9', { components: ['R&D_Core'], automationStatus: 'Maintenance', team: TEAM_OUT }),
  // Queued for the NEXT sprint — the backlog must leave it out even though
  // the sheet on screen is the active one.
  epic('E-10', { components: ['R&D_Core'], automationStatus: 'Ready for Automation' }),
  /* A SECOND epic in the same cell as E-1, so one backlog cell counts more
     than one. With a single key everywhere, the key columns would join
     nothing and a comma-joined implementation would pass every check here. */
  epic('E-11', { components: ['PS_iGO_NLG', 'TrueTest'], automationStatus: 'Maintenance' }),
  /* NO JIRA TEAM AT ALL — the PS_iGO_Lafayette defect. Its own component so
     the other rows' counts are untouched, and TWO buckets so a single-bucket
     special case cannot satisfy it. */
  { ...epic('E-12', { components: ['PS_Untagged'], automationStatus: 'Ready for Automation' }), team: '' },
  { ...epic('E-13', { components: ['PS_Untagged'], automationStatus: 'Blocked' }), team: '' },
];

const SPRINT_WORK = [
  planned('S-1', 'Story', { epic: 'E-5' }),                 // new build
  planned('B-1', 'Bucket Story', { relates: ['E-6'] }),      // maintenance
  planned('S-2', 'Story', {
    epic: 'E-10', jiraId: '941', sprintName: 'Katalon Titan S41', state: 'future',
  }),
];
const ISSUES = [...EPICS, ...SPRINT_WORK];

const TEAM = {
  id: 'titan', name: 'Katalon Titan', jiraTeams: [TEAM_IN], sprintKeywords: ['titan'],
  settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 },
  members: [{ id: 'm1', name: 'Hien Phan', role: 'Auto QA', status: 'Active', supportPct: 0, jiraAccountId: 'acc-hien' }],
};

fs.writeFileSync(path.join(SCRATCH, 'store', 'plan.json'), JSON.stringify({
  version: 1,
  teams: [TEAM],
  sprints: [
    {
      id: 'S40', number: 40, name: 'Sprint 40', start: '2026-09-17', end: '2026-09-30', source: 'jira',
      byTeam: { titan: { jiraId: '940', name: 'Katalon Titan S40', state: 'active' } },
    },
    {
      id: 'S41', number: 41, name: 'Sprint 41', start: '2026-10-01', end: '2026-10-14', source: 'jira',
      byTeam: { titan: { jiraId: '941', name: 'Katalon Titan S41', state: 'future' } },
    },
  ],
  holidays: [], availability: {}, support: {}, ceremony: {}, overrides: {},
  risks: [], notes: {}, excluded: {}, ignoredBoards: [], savedSearches: [],
  categoryRules: null, mixTargets: null, sprintRoster: {}, scenarios: [],
  /* PS_RES_NLG is ranked with nothing anywhere — the CLEAR row the screen
     folds away by default and the file must keep, or the export is silently
     whichever rows were on screen. */
  componentPriority: { PS_iGO_NLG: 1, PS_RES_NLG: 1, 'R&D_Core': 2, PS_Untagged: 2, KAT_Engineering: 3 },
  componentNote: { PS_iGO_NLG: 'Waiting on the, ahem, "migration"' },
  excludedComponents: ['KAT_Engineering'],
  /* BOTH squads on the global allow-list, so the per-team filter has
     something left to cut — otherwise E-9 is gone before a team is chosen and
     a check that the team narrows the file compares two identical numbers. */
  coverageTeams: [TEAM_IN, TEAM_OUT],
}));

fs.writeFileSync(path.join(SCRATCH, 'store', 'snapshot.json'), JSON.stringify({
  syncedAt: '2026-09-28T00:00:00Z', watermark: null, source: 'jira',
  issues: Object.fromEntries(ISSUES.map(i => [i.key, i])),
  sprints: [], components: [], testops: {}, github: {}, verification: [], fields: {},
  boards: [], boardSprintsByTeam: {}, boardSprintErrors: [], people: [],
  byTeam: {
    titan: {
      sprintIssues: { 940: ['S-1', 'B-1'], 941: ['S-2'] },
      sprints: [], backlog: [], people: [],
    },
  },
}));

/* ── A CONFIG OF ITS OWN ───────────────────────────────────────────────
   Without this, booting the server here reads whatever `config.json` happens
   to be on the machine running the suite — and the day authentication was
   switched on in a real install, nine files like this one began getting 401s
   from a server they believed they were driving anonymously. The failure was
   in the TEST's environment, not in anything it was testing, and it said so
   only as "401 !== 200" from an unrelated assertion.

   A test's result must not depend on the machine it runs on. Written before
   the server module is required, because the config is read at require time. */
process.env.CONFIG_FILE = path.join(SCRATCH, 'config.json');
fs.writeFileSync(process.env.CONFIG_FILE, JSON.stringify({
  auth: { enabled: false }, server: { port: 0, readOnly: false },
}));

const { server } = require('../server.js');

let base = '';
let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nThe By component export\n');

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

/* RFC-4180 aware, because the note in the fixture carries a comma AND quotes,
   and so do the key columns. Splitting on commas passes on every column until
   somebody writes a real sentence in a note, then shifts that row silently. */
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

const sheet = async (query = '&team=titan&sprint=S40') => {
  const r = await call(`/api/export?what=bycomponent${query}`);
  assert.strictEqual(r.status, 200, `export failed: ${String(r.body).slice(0, 200)}`);
  const rows = parseCsv(r.body);
  const header = rows[0];
  const at = (name) => {
    const i = header.indexOf(name);
    assert.ok(i >= 0, `no "${name}" column:\n  ${header.join('\n  ')}`);
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

const page = () => call('/api/capacity?team=titan&sprint=S40');

/* ── what it carries ──────────────────────────────────────────────────── */

check('EVERY RANKED COMPONENT IS A ROW, including the ones the screen folds', async () => {
  /* The clear rows are hidden on screen by default. A file that inherited
     that would be seventeen rows named as though it were 129 — and the row
     you most want in a spreadsheet is the P1 with nothing against it. */
  const api = await page();
  const s = await sheet();
  const rows = api.body.byComponent.rows;
  assert.strictEqual(rows.length, 4, 'fixture check: the ranked, non-excluded components have changed');
  for (const r of rows) assert.ok(s.row(r.component), `${r.component} is on the page but not in the file`);
  assert.ok(s.row('PS_RES_NLG'), 'the clear row was dropped from the file');
  assert.ok(!s.row('KAT_Engineering'), 'a ranked-and-excluded component got a row');
  // Rows plus the total line, and nothing else invented.
  assert.strictEqual(s.body.length, rows.length + 1,
    `expected ${rows.length} components plus a total, got ${s.body.length}`);
});

check('THE CLEAR ROWS ARE MARKED, so the reader knows why there are more', async () => {
  const s = await sheet();
  assert.strictEqual(s.cell('PS_RES_NLG', 'Clear'), 'yes');
  assert.strictEqual(s.cell('PS_iGO_NLG', 'Clear'), '');
});

check('THE NUMBERS ARE THE PAGE\'S NUMBERS, cell for cell', async () => {
  /* The file and the page are one `sprintComponents`. A CSV that recomputed
     anything is a second implementation of this grid, and the two part
     company the first time either changes — on a file people forward. */
  const api = await page();
  const v = api.body.byComponent;
  const s = await sheet();
  let compared = 0;
  for (const r of v.rows) {
    for (const t of v.tools) {
      for (const b of v.backlogBuckets) {
        assert.strictEqual(s.cell(r.component, `${t.label} — Backlog (all teams) — ${b.label}`),
          String(r[t.key][b.key]), `${r.component} / ${t.label} / ${b.label}`);
        compared++;
      }
      for (const c of v.plannedCols) {
        assert.strictEqual(s.cell(r.component, `${t.label} — ${v.sprint.label} Planned — ${c.label}`),
          String(r[t.key][c.key]), `${r.component} / ${t.label} / planned ${c.label}`);
        compared++;
      }
    }
  }
  assert.ok(compared >= 30, `only ${compared} cells compared — the fixture is not reaching the file`);
  // And at least one of them is not zero, or the comparison proves nothing.
  assert.ok(Number(s.cell('PS_iGO_NLG', 'TrueTest — Backlog (all teams) — Maintenance')) > 0,
    'every compared cell was zero');
});

check('THE PLANNED COLUMNS ARE NAMED AFTER THE SPRINT, in the file too', async () => {
  const s = await sheet();
  assert.ok(s.header.some(h => /Katalon Titan S40 Planned — New build/.test(h)),
    `the planned columns do not name the sprint:\n  ${s.header.join('\n  ')}`);
  assert.ok(s.header.some(h => /Backlog \(all teams\) — Maintenance/.test(h)),
    'the backlog columns lost their heading');
  // The two Maintenance columns share a word and must not collide.
  const maint = s.header.filter(h => /Maintenance/.test(h) && !/keys/.test(h));
  assert.strictEqual(new Set(maint).size, maint.length, 'two columns ended up with the same heading');
});

check('THE KEYS TRAVEL WITH THE COUNTS', async () => {
  /* On screen every number opens a drawer listing what it counted. Without
     the keys this is the one copy of the table nobody can audit. */
  const api = await page();
  const v = api.body.byComponent;
  const row = v.rows.find(r => r.component === 'PS_iGO_NLG');
  const col = `TrueTest — Backlog (all teams) — Maintenance`;
  const keys = s => s.split(';').map(x => x.trim()).filter(Boolean);
  const s = await sheet();
  const got = keys(s.cell('PS_iGO_NLG', `${col} keys`));
  assert.deepStrictEqual(got, row.truetest.keys.maintenance,
    'the key column is not the set the number counted');
  assert.strictEqual(got.length, Number(s.cell('PS_iGO_NLG', col)),
    'the file lists a different number of keys from the count beside them');
  // Semicolons, not commas, so a cell stays one cell.
  assert.ok(got.length > 1, 'fixture check: this cell counts more than one epic');
});

check('the component note travels, commas, quotes and all', async () => {
  const s = await sheet();
  assert.strictEqual(s.cell('PS_iGO_NLG', 'Component note'), 'Waiting on the, ahem, "migration"');
});

check('AND THE SPRINT NOTE IS ITS OWN COLUMN, not folded into that one', async () => {
  /* They answer different questions — what is true of the suite, and what is
     true of it this sprint. One column holding whichever the screen happens to
     edit is how a forwarded spreadsheet comes to state last quarter's plan as a
     standing fact about a component. */
  const s = await sheet();
  assert.notStrictEqual(s.cell('PS_iGO_NLG', 'Sprint note'), undefined,
    'the file has no sprint-note column');
  assert.strictEqual(s.cell('PS_iGO_NLG', 'Sprint note'), '',
    'a sprint with no note of its own borrowed the component one');
});

check('the family is the SHORT name, the one you group by', async () => {
  const s = await sheet();
  assert.strictEqual(s.cell('PS_iGO_NLG', 'Family'), 'PS');
  assert.strictEqual(s.cell('R&D_Core', 'Family'), 'R&D');
});

/* ── the scopes travel ────────────────────────────────────────────────── */

check('THE BACKLOG IN THE FILE EXCLUDES THE ACTIVE SPRINT ONLY', async () => {
  /* E-10 is Ready for Automation on R&D_Core and has a Story in the FUTURE
     sprint. A future sprint is a plan, not progress — nobody is working it
     today — so it stays in the backlog. E-5 has a Story in the ACTIVE
     sprint and does not. */
  const s = await sheet();
  assert.strictEqual(s.cell('R&D_Core', 'KSE — Backlog (all teams) — Ready for Automation'), '1',
    'an epic merely queued for the next sprint was cut from the file\'s backlog');
  /* E-2 and E-5 are both KSE / Ready on PS_iGO_NLG; E-5 has a Story in the
     ACTIVE sprint. Checked by KEY rather than by the count, because "1" is
     also what a broken rule that cut the wrong one of the two would say. */
  const keys = s.cell('PS_iGO_NLG', 'KSE — Backlog (all teams) — Ready for Automation keys')
    .split(';').map(x => x.trim()).filter(Boolean);
  assert.deepStrictEqual(keys, ['E-2'],
    'the active sprint\'s epic is in the file as untouched backlog');
  // And E-7, which nothing has picked up, is there too — so the checks above
  // are measuring the rule rather than an empty component.
  assert.strictEqual(s.cell('R&D_Core', 'KSE — Backlog (all teams) — Blocked'), '1');
});

check('AND THE FILE SAYS WHICH OF THEM ARE ALREADY EARMARKED', async () => {
  /* The difference between "nobody has looked at this" and "this already has
     a home in Sprint 41" is worth a number on a capacity screen — reported,
     never subtracted. */
  const api = await page();
  const q = api.body.byComponent.queuedAhead;
  assert.strictEqual(q.epics, 1, 'the earmarked epic is not reported');
  assert.deepStrictEqual(q.sprints.map(x => x.label), ['Katalon Titan S41']);
  assert.ok(q.epics <= api.body.byComponent.totals.backlog,
    'more suites are reported as earmarked than are in the backlog at all');
});

check('THE BACKLOG IN THE FILE IS EVERY TEAM\'S', async () => {
  /* E-9 is R&D_Core / Maintenance under the other squad's name and nothing
     has picked it up, so it is part of what is left to automate in that
     suite — which is not a per-team fact. A file that hid it would show a
     smaller queue than there is, on the row a reader is deciding from. */
  const s = await sheet();
  assert.strictEqual(s.cell('R&D_Core', 'KSE — Backlog (all teams) — Maintenance'), '1',
    "another squad's untouched epic was cut from the file's backlog");
});

check('AN EPIC WITH NO JIRA TEAM REACHES THE FILE TOO', async () => {
  /* THE PS_iGO_Lafayette DEFECT, in the copy that gets forwarded. A suite
     showing 8 Blocked was carrying 14 Ready epics with an empty Team field,
     and the file would have carried the same hole. */
  const s = await sheet();
  assert.ok(s.row('PS_Untagged'), 'the component carrying only untagged epics has no row');
  assert.strictEqual(s.cell('PS_Untagged', 'KSE — Backlog (all teams) — Ready for Automation'), '1',
    'an untagged Ready epic is missing from a file headed "all teams"');
  assert.strictEqual(s.cell('PS_Untagged', 'KSE — Backlog (all teams) — Blocked'), '1',
    'the fix only reached one bucket');
  assert.strictEqual(s.cell('PS_Untagged', 'Clear'), '', 'the row reads as clear');

  const api = await page();
  assert.strictEqual(api.body.byComponent.scopes.backlog.noTeam, 2,
    'the untagged epics are counted but not reported');
});

check('BUT THE GLOBAL ALLOW-LIST STILL CUTS IT', async () => {
  /* "All teams" means every team on `plan.coverageTeams`, not every value in
     the instance — or that setting stops meaning anything on this sheet
     while still meaning something on Coverage. The fixture lists both
     squads, so narrowing it has something to remove. */
  const api = await page();
  const scope = api.body.byComponent.scopes.backlog;
  assert.strictEqual(scope.allTeams, true, 'the payload does not say the backlog is portfolio-wide');
  assert.strictEqual(scope.teams.length, 2, 'fixture check: two squads on the allow-list');
  assert.match(scope.label, /all teams/);
});

check('THE SPRINT SCOPE TRAVELS — a different sprint is a different file', async () => {
  const now = await sheet('&team=titan&sprint=S40');
  const next = await sheet('&team=titan&sprint=S41');
  assert.ok(next.header.some(h => /Katalon Titan S41 Planned/.test(h)),
    'the file for the next sprint still names the active one');
  assert.strictEqual(now.cell('PS_iGO_NLG', 'KSE — Katalon Titan S40 Planned — New build'), '1');
  assert.strictEqual(next.cell('R&D_Core', 'KSE — Katalon Titan S41 Planned — New build'), '1',
    'the next sprint\'s own planned work is not in its file');
  assert.strictEqual(next.cell('PS_iGO_NLG', 'KSE — Katalon Titan S41 Planned — New build'), '0',
    'the active sprint\'s work leaked into the next sprint\'s file');
});

check('AND THE FILENAME SAYS WHICH TEAM AND WHICH SPRINT', async () => {
  /* A folder of these is unreadable otherwise, and the scope is the one thing
     a forwarded spreadsheet cannot recover. */
  const r = await call('/api/export?what=bycomponent&team=titan&sprint=S40');
  const cd = r.headers['content-disposition'] || '';
  assert.match(cd, /by-component-titan-S40\.csv/, `filename was "${cd}"`);
});

/* ── the file opens ───────────────────────────────────────────────────── */

check('IT LEADS WITH A BYTE-ORDER MARK, because "CSV" means "opens in Excel"', async () => {
  /* The column headings carry em dashes. Without the BOM Excel reads the file
     as the local codepage and every heading comes out as mojibake. */
  const r = await call('/api/export?what=bycomponent&team=titan&sprint=S40');
  assert.ok(String(r.body).startsWith('﻿'), 'no BOM — the headings will mojibake in Excel');
  assert.match(r.headers['content-type'] || '', /text\/csv/);
});

check('THE TOTAL IS LABELLED AS A TOTAL, not left to be summed', async () => {
  /* An epic in two components is counted in both rows, so the column does
     not add up to the distinct figure and somebody will try. */
  const api = await page();
  const s = await sheet();
  const total = s.body[s.body.length - 1];
  assert.match(total[0], /^Total — \d+ components$/, `last row was "${total[0]}"`);
  assert.strictEqual(total[s.at('TrueTest — Backlog (all teams) — Maintenance')],
    String(api.body.byComponent.totals.truetest.maintenance),
    'the total line disagrees with the page\'s own total');
  assert.strictEqual(total[s.at('Priority')], '', 'the total row invented a priority');
});

/* ── run ──────────────────────────────────────────────────────────────── */

server.listen(0, '127.0.0.1', async () => {
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [name, fn] of checks) {
    try { await fn(); console.log(`  \u001b[32m✓\u001b[0m ${name}`); passed++; }
    catch (e) { console.log(`  \u001b[31m✗\u001b[0m ${name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  server.close();
  process.exit(failed ? 1 : 0);
});
