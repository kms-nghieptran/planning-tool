'use strict';
/**
 * coverage-epics.test.js — the number and the list, over real HTTP.
 *
 * WHY THIS SUITE EXISTS SEPARATELY
 *
 * Every epic count on Overall Coverage is now a button, and a count you can
 * open is a count someone will check. That makes one property load-bearing
 * above all others:
 *
 *   the number on the screen  ===  the number of epics the drawer lists
 *
 * Neither side can verify that alone, and a model-level check cannot verify it
 * either: a helper that rebuilds the route's filter agrees with the route
 * whether or not either is right. So this asks the SERVER — the grid, the tool
 * split and the headline are fetched from `/api/reports/coverage`, and every
 * number they contain is opened through `/api/reports/coverage/epics` and
 * counted.
 *
 * The screen has 97 components by nine columns on his data. This walks the
 * whole cross-product of the fixture, because the failure this prevents is
 * never in the cell you thought to check by hand.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-covepics-'));
fs.mkdirSync(path.join(SCRATCH, 'store'), { recursive: true });
process.env.STORE_DIR = SCRATCH;
process.env.DB_FILE = path.join(SCRATCH, 'store', 'test.db');
process.env.PORT = '0';

/* ── the fixture ─────────────────────────────────────────────────────
   Three product suites, both tools, every bucket represented, epics that sit
   in two suites at once, one epic whose only component is excluded and one on
   a team outside the allow-list — so the drill-in is checked against the same
   two scope settings the numbers obey. */

const NLG = 'PS_iGO_NLG';
const SIG = 'R&D_Sig_Regression';
const CMN = 'KAT_Common';
const EXCLUDED = 'Technical_Works';
const TEAM_IN = 'Katalon PSA (Titan)';
const TEAM_OUT = 'Katalon Auto PS';

let n = 0;
const EPICS = [];
const epic = (status, components, { team = TEAM_IN, labels = [] } = {}) => {
  n++;
  const key = `AUTOKAT-${1000 + n}`;
  EPICS.push({
    key, project: 'AUTOKAT', summary: `${components[0]} work ${n}`, issueType: 'Epic',
    status: 'In Progress', statusCategory: 'indeterminate', automationStatus: status,
    components, labels, team, blockedBy: [], sprints: [], datasets: ['epics'],
  });
  return key;
};

/* Blocked epics carry a `blockedBy` — or deliberately do not. The Blocked
   BUCKET is the Automation Status field; "is blocked by" is a Jira LINK, and
   on his data 166 epics are in the bucket while only 26 say what by. The two
   populations have to be separable here or the icon cannot be checked. */
const blocking = {};
const blocks = (key, ...by) => { blocking[key] = by; return key; };

// NLG — on TrueTest, a spread of statuses.
epic('Automated', [NLG, 'TrueTest']);
epic('Automated', [NLG, 'TrueTest']);
epic('Maintenance', [NLG, 'TrueTest']);
epic('Ready for Automation', [NLG, 'TrueTest']);
const NLG_BLOCKED = blocks(epic('Blocked', [NLG, 'TrueTest']), 'CLICMNT-1');
epic('N/A', [NLG, 'TrueTest']);
epic('', [NLG, 'TrueTest']);
// SIG — KSE, different spread.
epic('Automated', [SIG]);
epic('Ready for Automation', [SIG]);
epic('Ready for Automation', [SIG]);
// Two SIG epics held by ONE ticket — the case the drawer groups by blocker.
const SIG_B1 = blocks(epic('Blocked', [SIG]), 'CLICMNT-1');
const SIG_B2 = blocks(epic('Blocked', [SIG]), 'CLICMNT-1', 'SHRTEC-9');
// Marked Blocked with nothing linked — the majority of his data, and the
// finding the drawer has to state rather than drop.
const SIG_UNLINKED = epic('Blocked', [SIG]);
// An epic in TWO suites at once — it is one epic and two grid rows, which is
// the case a drill-in gets wrong by listing it twice or by losing it.
const SHARED = epic('Automated', [NLG, SIG]);
// Common, small.
epic('Maintenance', [CMN]);
epic('Automated', [CMN, 'TrueTest']);
// Must never appear: its only real component is excluded.
const GONE_COMP = epic('Automated', [EXCLUDED, 'TrueTest']);
// Must never appear: its team is not on the allow-list.
const GONE_TEAM = epic('Automated', [NLG, 'TrueTest'], { team: TEAM_OUT });
// Keeps its place — one excluded component, one real one.
const MIXED = epic('Ready for Automation', [EXCLUDED, SIG]);

const EXCLUDED_COMPONENTS = [EXCLUDED];
const COVERAGE_TEAMS = [TEAM_IN];
const BANISHED = [GONE_COMP, GONE_TEAM];

fs.writeFileSync(path.join(SCRATCH, 'store', 'plan.json'), JSON.stringify({
  version: 1, teams: [], sprints: [], holidays: [], availability: {}, support: {},
  ceremony: {}, overrides: {}, risks: [], notes: {}, excluded: {}, ignoredBoards: [],
  savedSearches: [], categoryRules: null, mixTargets: null, sprintRoster: {},
  scenarios: [], componentPriority: {},
  excludedComponents: EXCLUDED_COMPONENTS, coverageTeams: COVERAGE_TEAMS,
}));
for (const e of EPICS) e.blockedBy = blocking[e.key] || [];

fs.writeFileSync(path.join(SCRATCH, 'store', 'snapshot.json'), JSON.stringify({
  syncedAt: '2026-09-14T00:00:00Z', watermark: null, source: 'jira',
  issues: Object.fromEntries(EPICS.map(e => [e.key, e])),
  sprints: [], components: [], testops: {}, github: {}, verification: [], fields: {},
  boards: [], boardSprintsByTeam: {}, boardSprintErrors: [], people: [], byTeam: {},
}));

const { server } = require('../server.js');
const db = require('../lib/db');
const coverage = require('../lib/coverage');

let base = '';
const call = (p) => new Promise((resolve, reject) => {
  http.get(`${base}${p}`, (res) => {
    let out = '';
    res.on('data', c => { out += c; });
    res.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch (_) { parsed = out; }
      resolve({ status: res.statusCode, body: parsed });
    });
  }).on('error', reject);
});

const grid = (sel = '') => call(`/api/reports/coverage${sel}`);
/** The drill-in, built the way the view builds it. */
const open = ({ row = null, buckets = [], tool = null, selection = [] } = {}) => call(
  '/api/reports/coverage/epics?' + [
    ...selection.map(c => `component=${encodeURIComponent(c)}`),
    ...buckets.map(b => `bucket=${encodeURIComponent(b)}`),
    row ? `row=${encodeURIComponent(row)}` : '',
    tool ? `tool=${encodeURIComponent(tool)}` : '',
  ].filter(Boolean).join('&'));

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

console.log('\nThe number and the list, over HTTP\n');

/* ── the contract ────────────────────────────────────────────────────── */

check('EVERY CELL OF THE GRID LISTS EXACTLY AS MANY EPICS AS IT SAYS', async () => {
  const g = await grid();
  assert.strictEqual(g.status, 200);
  const cols = coverage.BUCKETS.map(b => b.key);
  let opened = 0;
  for (const r of g.body.byComponent) {
    // The row total first — the number in the scope column.
    const all = await open({ row: r.component });
    assert.strictEqual(all.status, 200, r.component);
    assert.strictEqual(all.body.count, r.total,
      `${r.component}: the grid says ${r.total}, the drawer lists ${all.body.count}`);
    assert.strictEqual(all.body.epics.length, all.body.count, 'and the count matches the list it sent');
    if (r.total) opened++;

    for (const k of cols) {
      const d = await open({ row: r.component, buckets: [k] });
      assert.strictEqual(d.body.count, r[k] || 0,
        `${r.component} / ${k}: the grid says ${r[k] || 0}, the drawer lists ${d.body.count}`);
      if (r[k]) opened++;
    }
  }
  assert.ok(opened >= 10, `only ${opened} non-empty numbers exercised — the fixture proves nothing`);
});

check('and the KPI strip does too, including the one that is two columns', async () => {
  const g = await grid();
  const b = (k) => (g.body.buckets.find(x => x.key === k) || {}).count || 0;

  for (const k of ['automated', 'maintenance']) {
    const d = await open({ buckets: [k] });
    assert.strictEqual(d.body.count, b(k), `the ${k} KPI`);
  }
  /* "Still to automate" is Ready + Blocked — one number over two columns, and
     the reason the route takes a LIST of buckets rather than one. */
  const still = await open({ buckets: ['ready', 'blocked'] });
  assert.strictEqual(still.body.count, b('ready') + b('blocked'),
    'Still to automate has to open both columns, not one of them');
  assert.ok(b('ready') && b('blocked'), 'and both have to be non-empty, or the sum proves nothing');

  // The headline population, behind the "of N epics" on the TrueTest card.
  const whole = await open({});
  assert.strictEqual(whole.body.count, g.body.total);
});

check('AND THE TOOL SPLIT, per component and per tool', async () => {
  const g = await grid();
  let opened = 0;
  for (const r of g.body.byTool) {
    for (const t of ['truetest', 'kse']) {
      const d = await open({ row: r.component, tool: t });
      assert.strictEqual(d.body.count, r[t].total,
        `${r.component} / ${t}: the table says ${r[t].total}, the drawer lists ${d.body.count}`);
      if (r[t].total) opened++;
      // And one cell of the expanded panel underneath, which is tool × bucket.
      const a = await open({ row: r.component, tool: t, buckets: ['automated'] });
      assert.strictEqual(a.body.count, r[t].automated,
        `${r.component} / ${t} / automated`);
    }
  }
  assert.ok(opened >= 3, `only ${opened} tool totals exercised`);
});

check('AN EPIC IN TWO SUITES IS IN BOTH ROWS — one epic, two answers', async () => {
  /* The grid counts a shared epic in both of its components, so its rows total
     more than the epic count. That is deliberate, and it means a drill-in must
     return it for EITHER row — and exactly once for each. */
  const a = await open({ row: NLG, buckets: ['automated'] });
  const b = await open({ row: SIG, buckets: ['automated'] });
  assert.ok(a.body.epics.some(e => e.key === SHARED), `${SHARED} is missing from ${NLG}`);
  assert.ok(b.body.epics.some(e => e.key === SHARED), `${SHARED} is missing from ${SIG}`);
  assert.strictEqual(a.body.epics.filter(e => e.key === SHARED).length, 1, 'and listed once, not twice');

  // The headline counts it ONCE, because there it is a filter over epics.
  const whole = await open({ buckets: ['automated'] });
  assert.strictEqual(whole.body.epics.filter(e => e.key === SHARED).length, 1);
});

/* ── the scope settings apply, because the numbers obey them ──────────── */

check('HIS EXCLUSIONS APPLY TO THE DRAWER, exactly as they do to the number', async () => {
  const whole = await open({});
  const keys = whole.body.epics.map(e => e.key);
  for (const k of BANISHED) {
    assert.ok(!keys.includes(k), `${k} is excluded from the count and is in the drawer`);
  }
  // And the epic that merely TOUCHES an excluded component keeps its place.
  assert.ok(keys.includes(MIXED), `${MIXED} was dropped, and it still has ${SIG} on it`);
  // The excluded component has no row at all, so nothing can open it.
  const g = await grid();
  assert.ok(!g.body.byComponent.some(r => r.component === EXCLUDED),
    'an excluded component must not have a grid row');
});

check('and asking for the excluded component by name returns nothing, not everything', async () => {
  // The failure mode this prevents: an unknown `row` that does not narrow, so
  // the drawer answers with the whole portfolio under a heading naming one
  // suite. Nothing is the honest answer.
  const d = await open({ row: EXCLUDED });
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.body.count, 0);
});

check('THE COMPONENT SELECTION NARROWS THE DRAWER AS IT NARROWS THE SCREEN', async () => {
  /* The picker narrows the grid, the tool split and the headline. A drill-in
     that ignored it would answer for the portfolio under numbers that answer
     for one suite. */
  const sel = await grid(`?component=${encodeURIComponent(NLG)}`);
  const d = await open({ selection: [NLG] });
  assert.strictEqual(d.body.count, sel.body.total,
    `with ${NLG} selected the headline says ${sel.body.total} and the drawer lists ${d.body.count}`);
  assert.ok(sel.body.total < (await grid()).body.total, 'the selection has to actually narrow something');
  for (const e of d.body.epics) {
    assert.ok((e.components || []).includes(NLG), `${e.key} is not in ${NLG}`);
  }
});

/* ── what it does with requests the screen would never send ───────────── */

check('an unknown column is refused rather than silently listing everything', async () => {
  const d = await open({ buckets: ['nonsense'] });
  assert.strictEqual(d.status, 400);
  assert.match(d.body.error, /Unknown column/);
});

check('and an unknown tool is refused too', async () => {
  const d = await open({ tool: 'selenium' });
  assert.strictEqual(d.status, 400);
  assert.match(d.body.error, /Unknown tool/);
});

check('every epic comes back with something to show for it', async () => {
  const d = await open({ buckets: ['automated'] });
  assert.ok(d.body.epics.length);
  for (const e of d.body.epics) {
    assert.ok(e.key, 'an entry with no key renders as a blank row');
    assert.ok(e.summary, `${e.key} has no summary — the drawer would show a bare key`);
    assert.strictEqual(e.bucket, 'automated', `${e.key} came back in the wrong column`);
    // The tool markers are chrome, not suites, and must not be listed as ones.
    assert.ok(!(e.components || []).includes('TrueTest'), `${e.key} lists the tool marker as a component`);
    assert.ok(!(e.components || []).includes(EXCLUDED), `${e.key} lists an excluded component`);
  }
});

check('and the drawer says which slice it is answering for', async () => {
  // Without it the panel is a list of keys with no heading to check against.
  const d = await open({ row: NLG, buckets: ['ready'], tool: 'truetest' });
  assert.strictEqual(d.body.row, NLG);
  assert.deepStrictEqual(d.body.buckets, ['ready']);
  assert.strictEqual(d.body.tool, 'truetest');
  assert.match(d.body.label, /TrueTest/);
  assert.match(d.body.label, /Ready/);
});

/* ── WHAT IS BLOCKING IT ──────────────────────────────────────────────
   The Blocked column counts a FIELD; "is blocked by" is a LINK. The icon
   beside the count opens the second one, and these pin that the two stay
   distinguishable — because the moment they are conflated, a column saying
   166 opens a list of 26 and nothing says why. */

/* A blocking link arrives as `{key, summary, type}` — the same shape as a
   relates-to link. It used to be a bare key, which is why a blocker rendered
   as "Not in the local store" beside a related issue showing its summary: the
   summary Jira sent was stored and then dropped on the way out. Readers that
   want only the key say so. */
const blockKeys = (e) => (e.blockedBy || []).map(b => (b && typeof b === 'object' ? b.key : b));

check('THE BLOCKING LINKS TRAVEL WITH THE EPICS', async () => {
  const d = await open({ buckets: ['blocked'] });
  const by = Object.fromEntries(d.body.epics.map(e => [e.key, blockKeys(e)]));
  assert.deepStrictEqual(by[NLG_BLOCKED], ['CLICMNT-1']);
  assert.deepStrictEqual(by[SIG_B2], ['CLICMNT-1', 'SHRTEC-9'], 'an epic can be held by more than one');
  assert.deepStrictEqual(by[SIG_UNLINKED], [],
    'an epic marked Blocked with nothing linked must come back with an empty list, not be dropped');
});

check('AND THEY CARRY WHAT JIRA SAID ABOUT THE BLOCKER, not just its key', async () => {
  /* The whole point of the fix. Every blocker in his store is in a project
     this tool does not sync, so the link's own summary is the ONLY description
     of it that will ever exist locally. Dropping it left the drawer showing a
     bare key under "Not in the local store" on exactly the rows built to be
     chased. */
  const d = await open({ buckets: ['blocked'] });
  const e = d.body.epics.find(x => x.key === NLG_BLOCKED);
  const link = (e.blockedBy || [])[0];
  assert.ok(link && typeof link === 'object', `a blocking link came back as ${JSON.stringify(link)}`);
  assert.strictEqual(link.key, 'CLICMNT-1');
  assert.ok('summary' in link && 'type' in link,
    'the link has no room for what Jira already told us about it');
});

check('AND THE BUCKET IS NOT THE SAME SET AS THE LINKS', async () => {
  /* The whole reason the icon exists. If these were the same population the
     icon would be a second way to press the number, and this fixture — like
     his data — has to keep them apart or every check below is vacuous. */
  const blocked = await open({ buckets: ['blocked'] });
  const linked = blocked.body.epics.filter(e => (e.blockedBy || []).length);
  assert.ok(blocked.body.count > linked.length,
    'the fixture needs blocked epics with no link, or it does not resemble his data');
  assert.ok(linked.length, 'and some with one, or there is nothing to open');
});

check('every blocked epic is accounted for — linked or not', async () => {
  // The drawer groups by blocker and lists the rest under "no blocker
  // recorded". Together those two have to be the whole column, or the panel
  // is shorter than the number that opened it.
  const d = await open({ buckets: ['blocked'] });
  const linked = d.body.epics.filter(e => (e.blockedBy || []).length).length;
  const unlinked = d.body.epics.filter(e => !(e.blockedBy || []).length).length;
  assert.strictEqual(linked + unlinked, d.body.count);
  assert.ok(unlinked > 0 && linked > 0, 'both groups have to be populated');
});

check('and the links narrow with the row, like every other number here', async () => {
  const sig = await open({ row: SIG, buckets: ['blocked'] });
  const keys = sig.body.epics.map(e => e.key);
  assert.ok(keys.includes(SIG_B1) && keys.includes(SIG_B2) && keys.includes(SIG_UNLINKED));
  assert.ok(!keys.includes(NLG_BLOCKED), `${NLG_BLOCKED} is not in ${SIG}`);
  // One ticket holding two epics is one conversation — the grouping the
  // drawer is built around, checked on the data that feeds it.
  const held = sig.body.epics.filter(e => blockKeys(e).includes('CLICMNT-1'));
  assert.strictEqual(held.length, 2, 'CLICMNT-1 holds two of SIG\'s blocked epics');
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
  try { db.close(); } catch (_) { /* fine */ }
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
