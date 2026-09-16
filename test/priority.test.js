'use strict';
/**
 * priority.test.js — the one column on the Coverage screen that is his, not Jira's.
 *
 * WHY IT NEEDS ITS OWN SUITE
 *
 * Every other number on that grid is derived: lose it and the next sync puts it
 * back. A priority cannot be rederived from anything — there is no field in Jira
 * that says PS_iGO_NLG matters more than a retired internal suite, which is the
 * entire reason the column exists. So the failure that matters here is not a
 * wrong number, it is a LOST one: a sync that overwrites it, a save that reports
 * success without storing anything, a migration that drops the key.
 *
 * The second failure is subtler and is why "unset" is tested as hard as the
 * levels: most of his 125 components will never be given one, and a screen that
 * renders those as the bottom of the scale claims a judgement nobody made.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-prio-'));
fs.mkdirSync(path.join(SCRATCH, 'store'), { recursive: true });
process.env.STORE_DIR = SCRATCH;
process.env.DB_FILE = path.join(SCRATCH, 'store', 'test.db');
process.env.PORT = '0';

const epic = (key, status, components) => ({
  key, project: 'A', summary: key, issueType: 'Epic',
  automationStatus: status, components, labels: [], datasets: ['coverage'],
});
const EPICS = [
  epic('E-1', 'Automated', ['PS_A']),
  epic('E-2', 'Ready for Automation', ['PS_A']),
  epic('E-3', 'Automated', ['PS_B']),
  epic('E-4', 'Blocked', ['PS_B']),
];

fs.writeFileSync(path.join(SCRATCH, 'store', 'plan.json'), JSON.stringify({
  version: 1,
  teams: [{
    id: 'titan', name: 'Katalon Titan', jiraName: 'Katalon Auto Titan', boardId: '2092',
    jiraTeams: [], components: [], sprintKeywords: [],
    settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 }, source: 'jira', members: [],
  }],
  sprints: [], holidays: [], availability: {}, support: {}, ceremony: {}, overrides: {},
  risks: [], notes: {}, excluded: {}, ignoredBoards: [], savedSearches: [],
  categoryRules: null, mixTargets: null, componentPriority: {}, sprintRoster: {}, scenarios: [],
}));
fs.writeFileSync(path.join(SCRATCH, 'store', 'snapshot.json'), JSON.stringify({
  syncedAt: '2026-09-14T00:00:00Z', watermark: null, source: 'jira',
  issues: Object.fromEntries(EPICS.map(i => [i.key, i])),
  sprints: [], components: [], testops: {}, github: {}, verification: [], fields: {},
  boards: [], boardSprintsByTeam: {}, boardSprintErrors: [], people: [], byTeam: {},
}));

const priority = require('../lib/priority');
const store = require('../lib/store');
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
console.log('\nComponent priority — his judgement, not Jira\'s\n');

/* ── the model ────────────────────────────────────────────────────────── */

check('UNSET IS A STATE OF ITS OWN, not the bottom of the scale', () => {
  // Most of his 125 components will never be given one. Rendering those as "Low"
  // would put a decision in his mouth on 120 rows at once.
  assert.strictEqual(priority.of({ componentPriority: {} }, 'PS_A'), null);
  assert.strictEqual(priority.of({ componentPriority: { PS_A: 4 } }, 'PS_A'), 4);
  assert.notStrictEqual(priority.of({ componentPriority: {} }, 'PS_A'), 4,
    'no priority is not the same claim as the lowest priority');
});

check('and it sorts BELOW every set level, whichever way the column points', () => {
  const rows = [null, 1, 4, null, 2].map(v => ({ v, k: priority.sortKey(v) }));
  const asc = rows.slice().sort((a, b) => a.k - b.k).map(r => r.v);
  assert.deepStrictEqual(asc, [1, 2, 4, null, null],
    'the rows he has judged come first; the ones he has not are not data');
});

check('CLEARING A PRIORITY REMOVES THE KEY, it does not store a null', () => {
  // A map that accumulates a null for every component ever touched grows without
  // bound, and makes "has a priority" mean two different things depending on how
  // the row got there.
  const after = priority.set({ PS_A: 2, PS_B: 1 }, 'PS_A', null);
  assert.deepStrictEqual(after, { PS_B: 1 });
  assert.ok(!('PS_A' in after), 'the key is gone, not set to null');
});

check('and setting one never touches another', () => {
  const before = { PS_A: 1, PS_B: 3 };
  const after = priority.set(before, 'PS_C', 2);
  assert.deepStrictEqual(after, { PS_A: 1, PS_B: 3, PS_C: 2 });
  assert.deepStrictEqual(before, { PS_A: 1, PS_B: 3 }, 'and the original is not mutated under the caller');
});

check('A LEVEL THIS TOOL CANNOT READ IS REFUSED, not stored', () => {
  // The quiet failure: a stored 7 is not an error anywhere. The component simply
  // has no priority, and the only place that shows is a column that looks fine.
  const { map, errors } = priority.validate({ PS_A: 7, PS_B: 'high', PS_C: 2 });
  assert.strictEqual(errors.length, 2);
  assert.deepStrictEqual(map, { PS_C: 2 }, 'the good one still lands');
  assert.ok(errors.some(e => /7/.test(e.message)), 'and the message names the value');
});

check('and every level the screen offers is one the model accepts', () => {
  // A dropdown offering a level validate() rejects is a control that fails on
  // use. One list, checked against itself.
  for (const l of priority.LEVELS) {
    const { map, errors } = priority.validate({ PS_A: l.value });
    assert.deepStrictEqual(errors, [], `${l.label} is offered but rejected`);
    assert.strictEqual(map.PS_A, l.value);
  }
});

check('decorate attaches the level and its label without inventing rows', () => {
  const rows = priority.decorate(
    [{ component: 'PS_A' }, { component: 'PS_Z' }],
    { componentPriority: { PS_A: 1 } },
  );
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].priority, 1);
  assert.strictEqual(rows[0].priorityLabel, 'P1');
  assert.strictEqual(rows[1].priority, null);
  assert.strictEqual(rows[1].priorityLabel, null, 'an unset row carries no label to render');
});

/* ── the server ───────────────────────────────────────────────────────── */

check('A PRIORITY SET OVER HTTP IS STILL THERE ON THE NEXT READ', async () => {
  const r = await call('PUT', '/api/component-priority', { component: 'PS_A', level: 1 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.componentPriority, { PS_A: 1 });

  const view = await call('GET', '/api/reports/coverage');
  const row = view.body.byComponent.find(x => x.component === 'PS_A');
  assert.strictEqual(row.priority, 1, 'and it reaches the grid that renders it');
  assert.strictEqual(row.priorityLabel, 'P1');
});

check('and the coverage payload carries the levels the editor offers', async () => {
  const view = await call('GET', '/api/reports/coverage');
  assert.deepStrictEqual((view.body.priorityLevels || []).map(l => l.value), priority.LEVELS.map(l => l.value),
    'the dropdown is built from the model\'s own list, not a second one in the browser');
});

check('the server refuses a level it cannot read, and stores nothing', async () => {
  const before = store.getPlan().componentPriority;
  const r = await call('PUT', '/api/component-priority', { component: 'PS_B', level: 9 });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /9/);
  assert.deepStrictEqual(store.getPlan().componentPriority, before,
    'a refused write leaves the map exactly as it was');
});

check('CLEARING OVER HTTP REMOVES IT, and leaves the others alone', async () => {
  await call('PUT', '/api/component-priority', { component: 'PS_B', level: 3 });
  const r = await call('PUT', '/api/component-priority', { component: 'PS_B', level: null });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.componentPriority, { PS_A: 1 }, 'PS_B gone, PS_A untouched');
});

check('A SYNC NEVER TOUCHES IT — it is a decision, not a discovered value', () => {
  // The reason this lives in the plan rather than the snapshot. Proved by
  // replacing the snapshot wholesale, which is what a full sync does.
  const before = store.getPlan().componentPriority;
  assert.deepStrictEqual(before, { PS_A: 1 }, 'precondition');

  const snap = store.getSnapshot();
  store.saveSnapshot({ ...snap, syncedAt: new Date().toISOString(), issues: {} });
  assert.deepStrictEqual(store.getPlan().componentPriority, before,
    'the one column on that screen a sync must not be able to erase');
});

check('and it survives a plan save that knows nothing about it', async () => {
  // Every other screen saves the plan through PUT /api/plan, which merges a
  // partial object over the whole thing. A key that is not in the payload must
  // not be dropped on the floor by someone editing holidays.
  const r = await call('PUT', '/api/plan', { holidays: ['2027-01-01'] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(store.getPlan().componentPriority, { PS_A: 1 },
    'saving holidays must not clear the priorities');
});

/* ── the screens ──────────────────────────────────────────────────────── */

const COVERAGE_VIEW = fs.readFileSync(path.join(__dirname, '..', 'public', 'views', 'report-coverage.js'), 'utf8');
const SPRINT_VIEW = fs.readFileSync(path.join(__dirname, '..', 'public', 'views', 'sprint.js'), 'utf8');

check('THE COLUMN IS EDITABLE IN EXACTLY ONE PLACE', () => {
  // Two editors is two answers the first time both screens are open, and no way
  // to tell which write landed last.
  assert.match(COVERAGE_VIEW, /data-priority="/, 'the Coverage grid owns the edit');
  assert.match(COVERAGE_VIEW, /jsonPut\('\/api\/component-priority'/, 'and saves it to the validating route');
  assert.ok(!/data-priority="/.test(SPRINT_VIEW),
    'the sprint table shows it and must not offer to change it');
  assert.match(SPRINT_VIEW, /r\.priority/, 'but it does show it');
});

check('the cell carries a sort value, because a <select> has no text to sort on', () => {
  // textContent on a cell holding a dropdown returns every option concatenated,
  // so without this the column sorts by a string nobody can see.
  assert.match(COVERAGE_VIEW, /data-sort-value="\$\{r\.priority == null \? 99 : r\.priority\}"/);
  assert.match(SPRINT_VIEW, /data-sort-value="\$\{r\.priority == null \? 99 : r\.priority\}"/);
});

check('and a failed save puts the dropdown back rather than showing a level nobody stored', () => {
  // Saving on change with no Save button is the right trade for a 125-row grid,
  // and it makes this the only place the screen can end up lying: the control
  // would sit on a value the server refused.
  assert.match(COVERAGE_VIEW, /sel\.value = was;/);
  assert.match(COVERAGE_VIEW, /data-was="/, 'which needs the previous value to have been recorded');
});

/* ── the colour scale ─────────────────────────────────────────────────── */

const STYLES = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

check('EVERY LEVEL IS COLOURED, AND NO TWO SHARE A COLOUR', () => {
  // A scale where P2 and P3 are the same colour is not a scale, it is two
  // labels that happen to sit in the same column — which is the state this
  // started in, where P3's tone was the empty string.
  const colours = new Map();
  for (const l of priority.LEVELS) {
    const rule = STYLES.match(new RegExp(`^\\.prio-${l.key} \\{([^}]*)\\}`, 'm'));
    assert.ok(rule, `.prio-${l.key} has no colour rule`);
    const colour = (rule[1].match(/color:\s*([^;]+);/) || [])[1];
    assert.ok(colour, `${l.label} has a rule but no text colour`);
    assert.ok(!colours.has(colour.trim()), `${l.label} shares its colour with ${colours.get(colour.trim())}`);
    colours.set(colour.trim(), l.label);
  }
  assert.strictEqual(colours.size, priority.LEVELS.length);
});

check('and every colour is a token, so dark mode follows without a second set', () => {
  // The house rule for this sheet, and the practical one: a hard-coded hex that
  // reads on white is the hex that disappears on the dark surface.
  for (const l of priority.LEVELS) {
    const rule = STYLES.match(new RegExp(`^\\.prio-${l.key} \\{([^}]*)\\}`, 'm'))[1];
    const colour = (rule.match(/color:\s*([^;]+);/) || [])[1].trim();
    assert.match(colour, /var\(--/, `${l.label} is painted with ${colour} rather than a token`);
  }
});

check('UNSET IS NOT GIVEN THE BOTTOM OF THE SCALE', () => {
  // The visual half of the rule the model already enforces. Colouring an unset
  // row like P4 says "this is low priority" on 120 rows nobody has judged.
  const p4 = STYLES.match(/^\.prio-p4 \{([^}]*)\}/m)[1];
  const none = STYLES.match(/^\.prio-none \{([^}]*)\}/m)[1];
  assert.ok(!/font-weight/.test(none), 'an unset row must not be emphasised');
  assert.match(none, /var\(--app-fg-3\)/, 'it takes the muted foreground, like every other em-dash');
  void p4;
});

check('THE COLOUR COMES FROM THE LEVEL, not a second list in the browser', () => {
  // A colour map in the view is how a fifth level arrives uncoloured, or how a
  // recoloured P2 changes on one screen and not the other.
  assert.match(COVERAGE_VIEW, /prio-\$\{UI\.esc\(levelOf\(d, v\)\.key/,
    'the class is built from the level key the payload carries');
  assert.ok(!/prio-p1['"`]/.test(COVERAGE_VIEW), 'and not from a literal list of level names');
  assert.match(SPRINT_VIEW, /prio-\$\{UI\.esc\(l\.key/, 'the read-only tag does the same');
});

check('and the payload carries the colour with the level', () => {
  for (const l of priority.LEVELS) {
    assert.ok(l.key, `${l.label} needs a key for the class to be built from`);
    assert.ok(l.tone, `${l.label} needs a tone — the empty string is what left P3 uncoloured`);
  }
});

check('CHANGING THE LEVEL RECOLOURS THE CONTROL, not only the next full render', () => {
  // The dropdown saves in place, so nothing re-renders. Without this the row
  // keeps the colour of the level it used to be — a stale colour beside a fresh
  // value, which is the version of this that gets believed.
  assert.match(COVERAGE_VIEW, /sel\.className = `prio \$\{prioClass\(dRef, level\)\}`/);
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
