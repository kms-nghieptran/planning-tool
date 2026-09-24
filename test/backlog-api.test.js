'use strict';
/**
 * backlog-api.test.js — the bar and the list, over real HTTP.
 *
 * WHY THIS SUITE EXISTS SEPARATELY
 *
 * backlog-profile.test.js proves the counting. It proves it against a helper
 * that reproduces what the route does — which is exactly the thing that cannot
 * be trusted, because a helper that mirrors the implementation agrees with it
 * whether or not either is right. Delete the upper bound from the route's date
 * filter and every check in that suite still passes; the drawer then lists
 * every epic automated since the beginning of time under a bar that says four.
 *
 * So this one asks the SERVER. Chart and drawer are fetched over HTTP from the
 * same store, and the contract is checked between the two answers:
 *
 *   the number a bar draws  ===  the number of epics the drawer lists
 *
 * That is the whole point of a drill-in, and it is the one property neither
 * side can verify alone.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-blapi-'));
fs.mkdirSync(path.join(SCRATCH, 'store'), { recursive: true });
process.env.STORE_DIR = SCRATCH;
process.env.DB_FILE = path.join(SCRATCH, 'store', 'test.db');
process.env.PORT = '0';

/* ── the fixture ─────────────────────────────────────────────────────
   Epics spread across four months, two components and both tools, with two
   that were automated, slipped to Maintenance and automated again — so the
   build and maintenance columns are both populated and one epic legitimately
   appears in two different periods under two different columns. */

const EPICS = [];
let n = 0;
/** An Epic, and the moment(s) its Automation Status reached Automated. */
const epic = (component, tt, moves, team = 'Katalon Auto Titan') => {
  n++;
  const key = `AUTOKAT-${100 + n}`;
  EPICS.push({
    key, project: 'AUTOKAT', summary: `${component} suite ${n}`, issueType: 'Epic',
    status: 'Done', statusCategory: 'done', automationStatus: 'Automated', team,
    components: [].concat(component).concat(tt ? ['TrueTest'] : []),
    labels: [], blockedBy: [], sprints: [], datasets: ['epics'], moves,
  });
  return key;
};

for (const [month, count] of [['05', 3], ['06', 2], ['07', 4], ['08', 2]]) {
  for (let i = 0; i < count; i++) {
    epic(i % 2 ? 'PS_Alpha' : 'PS_Beta', i % 3 === 0,
      [[`2026-${month}-1${i}T09:00:00.000Z`, 'Ready for Automation']]);
  }
}
// Built in May, maintained in July: two events, two periods, two columns.
const TWICE = epic('PS_Alpha', true, [
  ['2026-05-04T09:00:00.000Z', 'Ready for Automation'],
  ['2026-07-22T09:00:00.000Z', 'Maintenance'],
]);
// One that has never been automated at all — it must appear in no bar.
const NEVER = epic('PS_Beta', false, []);

/* ── the epics his two coverage settings are supposed to remove ──────
   All four were automated in July, so each one would visibly inflate a bar it
   has no business being in. They exist to be counted by the chart if either
   setting stops being applied, which is the whole reason this fixture carries
   a team on every epic. */
const JUL = [['2026-07-19T09:00:00.000Z', 'Ready for Automation']];
// A team he did not put on the list.
const OTHER_TEAM = epic('PS_Alpha', true, JUL, 'Katalon Auto PS');
// No team at all — the case the allow-list exists for.
const NO_TEAM = epic('PS_Alpha', true, JUL, '');
// Its only real component is one he excluded, so the epic leaves entirely.
const EXCLUDED = epic('Technical_Works', true, JUL);
// The second allowed team, so a check cannot pass by matching one name.
const SECOND_TEAM = epic('PS_Beta', false, JUL, 'Katalon Auto Ruby');
// Excluded component AND a real one: it KEEPS its place, on the strength of
// the component that survives. The opposite mistake to EXCLUDED above.
const MIXED = epic(['Technical_Works', 'PS_Alpha'], false, JUL);

const EXCLUDED_COMPONENTS = ['Technical_Works'];
const COVERAGE_TEAMS = ['Katalon Auto Titan', 'Katalon Auto Ruby'];
// Everything the two settings should have removed, and nothing else.
const BANISHED = [OTHER_TEAM, NO_TEAM, EXCLUDED];

fs.writeFileSync(path.join(SCRATCH, 'store', 'plan.json'), JSON.stringify({
  version: 1, teams: [], sprints: [], holidays: [], availability: {}, support: {},
  ceremony: {}, overrides: {}, risks: [], notes: {}, excluded: {}, ignoredBoards: [],
  savedSearches: [], categoryRules: null, mixTargets: null, sprintRoster: {},
  scenarios: [], componentPriority: {},
  // His decisions, the same two the Coverage headline above the chart obeys.
  excludedComponents: EXCLUDED_COMPONENTS, coverageTeams: COVERAGE_TEAMS,
}));

fs.writeFileSync(path.join(SCRATCH, 'store', 'snapshot.json'), JSON.stringify({
  syncedAt: '2026-09-14T00:00:00Z', watermark: null, source: 'jira',
  issues: Object.fromEntries(EPICS.map(e => {
    const { moves, ...rest } = e;
    return [e.key, rest];
  })),
  sprints: [], components: [], testops: {}, github: {}, verification: [], fields: {},
  boards: [], boardSprintsByTeam: {}, boardSprintErrors: [], people: [], byTeam: {},
}));

const { server } = require('../server.js');
const db = require('../lib/db');

// The transitions the backfill would have written, put straight into the table
// this feature reads — the drill-in's whole input, without needing Jira.
for (const e of EPICS) {
  for (const [at, from] of e.moves) {
    db.run('INSERT OR REPLACE INTO automation_transition (issue_key, at, from_status, to_status) VALUES (?, ?, ?, ?)',
      e.key, at, from, 'Automated');
  }
}

let base = '';
const put = (p, body) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const u = new URL(base + p);
  const req = http.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method: 'PUT',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
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

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

console.log('\nThe bar and the list, over HTTP\n');

const chart = (qs = '') => call(`/api/reports/backlog?grain=month&periods=6${qs}`);
const drill = (period, bucket, qs = '') =>
  call(`/api/reports/backlog/epics?grain=month&periods=6&period=${period}&bucket=${bucket}${qs}`);

/* ── the contract ────────────────────────────────────────────────────── */

check('EVERY BAR THE CHART DRAWS LISTS EXACTLY THAT MANY EPICS', async () => {
  const c = await chart();
  assert.strictEqual(c.status, 200);
  let opened = 0;
  for (const period of c.body.periods) {
    for (const b of c.body.buckets) {
      const drawn = (period.counts || {})[b.key] || 0;
      const d = await drill(period.start, b.key);
      assert.strictEqual(d.status, 200, `${period.label}/${b.key}`);
      assert.strictEqual(d.body.keys.length, drawn,
        `${period.label} / ${b.key}: bar says ${drawn}, drawer lists ${d.body.keys.length}`);
      assert.strictEqual(d.body.shown, drawn, 'and the route agrees about what the bar says');
      if (drawn) opened++;
    }
  }
  assert.ok(opened >= 4, `only ${opened} non-empty bars exercised — the fixture proves nothing`);
});

check('and the total lists the whole period, every column at once', async () => {
  const c = await chart();
  for (const period of c.body.periods) {
    const d = await drill(period.start, '');
    assert.strictEqual(d.body.keys.length, period.total, period.label);
    assert.strictEqual(d.body.label, 'All columns');
  }
});

check('A BAR IS BOUNDED AT BOTH ENDS, not just the near one', async () => {
  // The mutation this suite exists for: drop `<= period.end` and July's drawer
  // quietly gains August's epics while July's bar keeps saying four.
  const c = await chart();
  const jul = c.body.periods.find(p => p.start === '2026-07-01');
  const d = await drill('2026-07-01', '');
  const dates = d.body.keys.map(k => d.body.catalogue[k.toUpperCase()]);
  assert.strictEqual(d.body.keys.length, jul.total);
  assert.ok(jul.total > 0, 'July has to have something in it');
  // Nothing from a later month may appear in July's list.
  const aug = await drill('2026-08-01', '');
  for (const k of aug.body.keys) {
    assert.ok(!d.body.keys.includes(k) || k === TWICE,
      `${k} is in both July and August — the window is not closed at the top`);
  }
  assert.ok(dates.every(Boolean), 'and every key resolves to an epic');
});

check('AN EPIC AUTOMATED TWICE IS IN BOTH PERIODS, under different columns', async () => {
  const may = await drill('2026-05-01', 'ttBuild');
  const jul = await drill('2026-07-01', 'ttMaint');
  assert.ok(may.body.keys.includes(TWICE), 'the build, in May');
  assert.ok(jul.body.keys.includes(TWICE), 'the maintenance, in July');
  const julBuild = await drill('2026-07-01', 'ttBuild');
  assert.ok(!julBuild.body.keys.includes(TWICE), 'and it is not counted as a build twice');
});

check('an epic that was never automated is behind no bar at all', async () => {
  const c = await chart();
  for (const period of c.body.periods) {
    const d = await drill(period.start, '');
    assert.ok(!d.body.keys.includes(NEVER), `${NEVER} surfaced in ${period.label}`);
  }
});

/* ── the window travels with the request ─────────────────────────────── */

check('THE DRAWER ANSWERS FOR THE WINDOW IT WAS ASKED FOR', async () => {
  // Same bar date, two windows. A weekly drawer must not answer with a month.
  const wk = await call('/api/reports/backlog?grain=week&periods=26');
  const bar = wk.body.periods.find(p => p.total > 0);
  assert.ok(bar, 'the weekly window has to contain something');
  const d = await call(`/api/reports/backlog/epics?grain=week&periods=26&period=${bar.start}&bucket=`);
  assert.strictEqual(d.body.keys.length, bar.total, 'the weekly bar and its drawer');
  assert.strictEqual(d.body.grain, 'week');
});

check('and "all" resolves its grain the same way on both sides', async () => {
  // "all" picks its own grain from the data, so the two sides could disagree
  // about what a period even is. They must not.
  const c = await call('/api/reports/backlog?grain=all');
  const bar = c.body.periods.find(p => p.total > 0);
  const d = await call(`/api/reports/backlog/epics?grain=all&period=${bar.start}&bucket=`);
  assert.strictEqual(d.body.grain, c.body.grain, 'the same bar width');
  assert.strictEqual(d.body.window, 'all');
  assert.strictEqual(d.body.keys.length, bar.total);
});

check('a component filter narrows the drawer exactly as it narrows the bar', async () => {
  const c = await chart('&component=PS_Alpha');
  for (const period of c.body.periods) {
    const d = await drill(period.start, '', '&component=PS_Alpha');
    assert.strictEqual(d.body.keys.length, period.total, period.label);
    for (const k of d.body.keys) {
      assert.ok((d.body.catalogue[k.toUpperCase()].components || []).includes('PS_Alpha'), k);
    }
  }
});

/* ── THE CHART COUNTS WHAT THE HEADLINE ABOVE IT COUNTS ───────────────
   The Backlog chart sits under the Coverage headline on one screen. Before
   this, it obeyed neither of his two scope settings: the headline read 4,141
   epics while the bars below it drew 4,144, and the drawer could list an epic
   the chart above it had already dropped. Three readers, one population. */

const everyKey = async (qs = '') => {
  const c = await chart(qs);
  const seen = new Set();
  for (const period of c.body.periods) {
    const d = await drill(period.start, '', qs);
    for (const k of d.body.keys) seen.add(k);
  }
  return { total: c.body.periods.reduce((s, p) => s + p.total, 0), seen };
};

check('AN EPIC WHOSE TEAM IS NOT ON HIS LIST IS BEHIND NO BAR', async () => {
  const { seen } = await everyKey();
  assert.ok(!seen.has(OTHER_TEAM), `${OTHER_TEAM} (Katalon Auto PS) is still in the chart`);
  assert.ok(!seen.has(NO_TEAM), `${NO_TEAM} (no team at all) is still in the chart`);
  // And the allow-list is a list, not a single name: the second team survives.
  assert.ok(seen.has(SECOND_TEAM), `${SECOND_TEAM} (Katalon Auto Ruby) was dropped — the allow-list only matched one name`);
});

check('AN EPIC WHOSE ONLY COMPONENT HE EXCLUDED IS BEHIND NO BAR', async () => {
  const { seen } = await everyKey();
  assert.ok(!seen.has(EXCLUDED), `${EXCLUDED} (Technical_Works only) is still in the chart`);
  // But an epic that merely TOUCHES an excluded component keeps its place —
  // the exclusion drops epics, not the components of epics that have others.
  assert.ok(seen.has(MIXED), `${MIXED} was dropped, and it still has PS_Alpha on it`);
});

check('THE BARS AND THE DRAWER DROP THEM TOGETHER, never one without the other', async () => {
  // A bar that counted a banished epic while the drawer refused to list it
  // would satisfy both checks above and still be wrong on screen.
  const c = await chart();
  const jul = c.body.periods.find(p => p.start === '2026-07-01');
  const d = await drill('2026-07-01', '');
  assert.strictEqual(d.body.keys.length, jul.total, 'July: the bar and its list');
  // July is where all four live, so the numbers there are the ones that move.
  assert.ok(jul.total > 0, 'July has to have something left in it');
  for (const k of BANISHED) assert.ok(!d.body.keys.includes(k), `${k} in July's drawer`);
});

check('AND CLEARING THE SETTINGS PUTS EXACTLY THOSE EPICS BACK', async () => {
  /* The check the others cannot make: it proves the chart is READING the
     settings rather than happening to agree with them. Without it, a route
     that dropped these three for some unrelated reason would look correct. */
  const before = await everyKey();
  try {
    await put('/api/coverage-teams', { teams: [] });
    await put('/api/excluded-components', { components: [] });
    const after = await everyKey();
    assert.strictEqual(after.total, before.total + BANISHED.length,
      `chart total went ${before.total} → ${after.total}, expected +${BANISHED.length}`);
    for (const k of BANISHED) assert.ok(after.seen.has(k), `${k} did not come back`);
  } finally {
    await put('/api/coverage-teams', { teams: COVERAGE_TEAMS });
    await put('/api/excluded-components', { components: EXCLUDED_COMPONENTS });
  }
  const restored = await everyKey();
  assert.strictEqual(restored.total, before.total, 'and putting them back removes them again');
});

/* ── what it does with requests the UI would never send ──────────────── */

check('a period outside the window is refused, not answered with nothing', async () => {
  // Silence here reads as "that month was quiet". It was not — it is not on
  // the chart at all, and the drawer has to say so.
  const d = await drill('1999-01-01', '');
  assert.strictEqual(d.status, 409);
  assert.match(d.body.error, /not in the current window/);
});

check('an unknown column is refused rather than silently listing everything', async () => {
  const d = await drill('2026-07-01', 'nonsense');
  assert.strictEqual(d.status, 400);
  assert.match(d.body.error, /Unknown column/);
});

check('a missing period is refused too', async () => {
  const d = await call('/api/reports/backlog/epics?grain=month&periods=6&bucket=ttBuild');
  assert.strictEqual(d.status, 409);
});

check('every key comes back with something to show for it', async () => {
  const d = await drill('2026-07-01', '');
  for (const k of d.body.keys) {
    const it = d.body.catalogue[k.toUpperCase()];
    assert.ok(it, `${k} has no catalogue entry — the drawer would render a bare key`);
    assert.ok(it.summary || it.absent, `${k} resolves to nothing readable`);
  }
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
