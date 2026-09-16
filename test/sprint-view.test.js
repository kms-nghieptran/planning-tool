'use strict';
/**
 * sprint-view.test.js — what the Active sprint screen actually puts on the page.
 *
 * WHY THIS SUITE EXISTS
 *
 * He reported that items with no assignee were missing from "All sprint items".
 * They were not — the model has always returned them and the table has always
 * had an `unassigned` branch in its Assignee cell. What WAS missing was the
 * unowned pile from "Per-person progress", so the person column added up to
 * less than the Committed KPI above it with nothing on screen to explain the
 * gap. Both halves of that are UI facts, and a UI fact is only pinned by
 * looking at the HTML: coverage.test.js learned this the hard way when a render
 * function gutted to `return ''` left every source-level check green.
 *
 * So these checks run the real view, with a real payload from the real model,
 * and read the output.
 *
 * Run: node test/sprint-view.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-sprint-view-'));
process.env.STORE_DIR = SCRATCH;

const insights = require('../lib/insights');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

/* ── fixture ──────────────────────────────────────────────────────────────
   Four owned items and two unowned ones, one of each finished. The two unowned
   items are the whole subject of this file, so they differ from each other:
   if the view only ever showed the planned side, A-9 being Done would not be
   visible anywhere. */

const SPRINT = { id: 'S40', number: 40, name: 'Sprint 40', start: '2026-09-17', end: '2026-09-30' };

const TEAM = {
  id: 'titan', name: 'Katalon Titan',
  sprintKeywords: ['titan'],
  settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 },
  members: [
    { id: 'm1', name: 'Thuan Dinh Cong Ngoc', role: 'QA Lead', status: 'Active', supportPct: 0 },
    { id: 'm2', name: 'Hien Phan', role: 'Auto QA', status: 'Active', supportPct: 0 },
  ],
};

const full = new Array(14).fill('1').map((c, i) => ([2, 3, 9, 10].includes(i) ? 'WO' : c));

const PLAN = {
  version: 1, teams: [TEAM], sprints: [SPRINT], holidays: [],
  availability: { 'titan|S40|m1': full, 'titan|S40|m2': full },
  support: {}, ceremony: {}, overrides: {}, risks: [], notes: {}, categoryRules: null, mixTargets: null,
};

const issue = (o) => ({
  key: o.key, summary: o.summary || `Work item ${o.key}`, issueType: 'Story',
  status: o.status || 'Open', statusCategory: o.status === 'Done' ? 'done' : 'new',
  assignee: o.assignee || null, labels: [], components: o.components || [],
  points: 'points' in o ? o.points : 3, sprintNames: ['Katalon Titan Sprint 40'],
  sprints: [{ name: 'Katalon Titan Sprint 40' }], blockedBy: [],
  updated: '2026-09-20T00:00:00.000Z',
  resolved: o.status === 'Done' ? '2026-09-21T00:00:00.000Z' : null,
  team: 'Katalon Auto Titan', priority: 'Medium',
});

const OWNED = ['A-1', 'A-2', 'A-3', 'A-4'];
const UNOWNED = ['A-8', 'A-9'];

const SNAP = {
  source: 'jira', syncedAt: '2026-09-24T00:00:00.000Z', watermark: '2026-09-24T00:00:00.000Z',
  sprints: [{ name: 'Katalon Titan Sprint 40' }],
  issues: Object.fromEntries([
    // Components on purpose: PS_iGO_NLG carries most of the sprint, KAT_Common
    // a little, and the TrueTest marker rides along on one of them so the
    // per-component section has to strip it.
    issue({ key: 'A-1', assignee: 'Thuan Dinh Cong Ngoc', points: 8, status: 'Done', components: ['PS_iGO_NLG', 'TrueTest'] }),
    issue({ key: 'A-2', assignee: 'Thuan Dinh Cong Ngoc', points: 5, components: ['PS_iGO_NLG'] }),
    issue({ key: 'A-3', assignee: 'Hien Phan', points: 7, status: 'Done', components: ['PS_iGO_NLG'] }),
    issue({ key: 'A-4', assignee: 'Hien Phan', points: 2, components: ['KAT_Common'] }),
    issue({ key: 'A-8', assignee: null, points: 4 }),
    issue({ key: 'A-9', assignee: null, points: 6, status: 'Done' }),
  ].map(i => [i.key, i])),
  testops: { projects: [] }, github: {}, verification: [],
};

/**
 * The shape he reported: work in the sprint assigned to real people who are not
 * on the team's roster. Nothing here is unassigned — every item names someone.
 *
 * The exclusions are what keep them off the roster, and they are the real
 * mechanism: without them the roster simply derives a member from the assignee
 * and the work is attributed normally, which is what SHOULD happen. Titan has
 * 39 of these, which is why 53 of its Sprint 30 items landed nowhere.
 */
const OFF_ROSTER_PLAN = { ...PLAN, excluded: { titan: ['Luong Trinh', 'Dat Ngoc Pham'] } };
const OFF_ROSTER = {
  ...SNAP,
  issues: Object.fromEntries([
    ...Object.entries(SNAP.issues).filter(([k]) => !UNOWNED.includes(k)),
    ...[
      issue({ key: 'A-8', assignee: 'Luong Trinh', points: 4 }),
      issue({ key: 'A-9', assignee: 'Luong Trinh', points: 6, status: 'Done' }),
      issue({ key: 'A-10', assignee: 'Dat Ngoc Pham', points: 3, status: 'Done' }),
    ].map(i => [i.key, i]),
  ]),
};

const MID_SPRINT = new Date('2026-09-24T00:00:00Z');

/* ── the harness ──────────────────────────────────────────────────────── */

const VIEW = fs.readFileSync(path.join(__dirname, '..', 'public', 'views', 'sprint.js'), 'utf8');

/**
 * Render the Active sprint view for real and hand back the HTML, plus the
 * payload it was given so the checks can compare the page against the model
 * rather than against numbers typed into this file.
 */
async function renderHtml(snap = SNAP, plan = PLAN) {
  const payload = insights.activeSprintView(plan, snap, TEAM, SPRINT, { today: MID_SPRINT });
  let html = '';
  const el = () => ({
    addEventListener() {}, value: '', hidden: false, dataset: {}, setAttribute() {},
    classList: { toggle() {}, contains: () => false }, select() {},
    querySelector: () => el(), querySelectorAll: () => [],
  });
  const ctx = {
    console, Promise, setTimeout, encodeURIComponent, CSS: { escape: String },
    App: { refresh() {} },
    Charts: new Proxy({}, { get: () => () => '' }),
    document: { createElement: () => ({ set innerHTML(_) {}, content: { firstElementChild: null } }) },
  };
  vm.createContext(ctx);
  // The real ui.js — a hand-written stub drifts from the thing it stands in for.
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);
  ctx.UI.setJiraBase('https://ipipelinejira.atlassian.net');
  ctx.UI.api = async () => payload;

  vm.runInContext(`${VIEW}\n;globalThis.__v = SprintView;`, ctx);
  const mount = {
    style: {}, addEventListener() {},
    querySelector: () => el(), querySelectorAll: () => [],
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
  };
  await ctx.__v.render({ teamId: 'titan', sprintId: 'S40', categories: {} }, mount);
  return { html, payload };
}

const CAPACITY_VIEW = fs.readFileSync(path.join(__dirname, '..', 'public', 'views', 'capacity.js'), 'utf8');

/**
 * The same, for Capacity planning.
 *
 * It renders the item table from the shared helper, so the table is checked on
 * both screens rather than on the one it started life in — the whole point of
 * sharing it being that the two cannot drift apart.
 */
async function renderCapacity(snap = SNAP, plan = PLAN) {
  const payload = insights.capacityView(plan, snap, TEAM, SPRINT);
  let html = '';
  const el = () => ({
    addEventListener() {}, value: '', hidden: false, dataset: {}, style: {}, setAttribute() {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, select() {},
    getAttribute: () => null, querySelector: () => el(), querySelectorAll: () => [],
  });
  const ctx = {
    console, Promise, setTimeout, clearTimeout, encodeURIComponent, CSS: { escape: String },
    App: { refresh() {} },
    Charts: new Proxy({}, { get: () => () => '' }),
    document: { createElement: () => el(), querySelector: () => el(), querySelectorAll: () => [] },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);
  ctx.UI.setJiraBase('https://ipipelinejira.atlassian.net');
  // The screen fetches the roster and scenarios alongside the grid; neither
  // bears on the item table, and both are allowed to be absent in the app.
  ctx.UI.api = async (p) => (p.startsWith('/api/capacity') ? payload : null);

  vm.runInContext(`${CAPACITY_VIEW}\n;globalThis.__c = CapacityView;`, ctx);
  const mount = {
    style: {}, addEventListener() {},
    querySelector: () => el(), querySelectorAll: () => [],
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
  };
  await ctx.__c.render({
    teamId: 'titan', sprintId: 'S40', categories: {},
    sprints: [{ id: 'S40', name: 'Sprint 40', byTeam: {} }],
  }, mount);
  return { html, payload };
}

/**
 * Just the "All sprint items" section.
 *
 * Bounded at its own closing table, not run to the end of the document: with an
 * open-ended slice, anything rendered AFTER the item table lands inside it and
 * the checks quietly start describing something else. Moving the per-component
 * section below the table turned three of them red for that reason alone.
 */
const itemsSection = (html) => {
  const from = html.indexOf('All sprint items');
  if (from < 0) return '';
  const end = html.indexOf('</table>', from);
  return html.slice(from, end < 0 ? undefined : end);
};
/** Just the "Per-person progress" card. */
const peopleSection = (html) => {
  const from = html.indexOf('Per-person progress');
  return html.slice(from, html.indexOf('</table>', from));
};

/* ── the item table ───────────────────────────────────────────────────── */

check('EVERY SPRINT ITEM IS A ROW, including the ones nobody owns', async () => {
  const { html, payload } = await renderHtml();
  const body = itemsSection(html);
  for (const k of [...OWNED, ...UNOWNED]) {
    assert.ok(body.includes(`>${k}</a>`) || body.includes(`>${k}<`), `${k} has no row in the item table`);
  }
  // Header row plus one per item — so nothing is being dropped silently either.
  assert.strictEqual((body.match(/<tr>/g) || []).length, payload.items.length + 1);
});

check('an item with no assignee says so in the Assignee column', async () => {
  const body = itemsSection((await renderHtml()).html);
  assert.strictEqual((body.match(/tag warn">unassigned/g) || []).length, UNOWNED.length);
});

check('and the caption counts them, so the gap is visible without scanning', async () => {
  const { html } = await renderHtml();
  assert.match(html, /6 items · 2 with no assignee/);
});

check('a sprint where everything is owned says nothing about assignees', async () => {
  const owned = {
    ...SNAP,
    issues: Object.fromEntries(Object.entries(SNAP.issues).filter(([k]) => !UNOWNED.includes(k))),
  };
  const { html } = await renderHtml(owned);
  assert.match(html, /4 items</);
  assert.ok(!/with no assignee/.test(html), 'no zero-count noise on a clean sprint');
});

/* ── per-person progress ──────────────────────────────────────────────── */

check('WORK WITH NOBODY IN THE ASSIGNEE FIELD GETS A ROW OF ITS OWN', async () => {
  const { html, payload } = await renderHtml();
  const table = peopleSection(html);
  assert.ok(table.includes('unassigned-row'), 'no row for the unowned work');
  assert.ok(table.includes('>No assignee<'), 'the row is not labelled');
  assert.ok(table.includes(`${payload.unassigned.count} items`), 'the row does not say how many');
});

check('AND WORK WITH AN OWNER IS NEVER CALLED UNASSIGNED', async () => {
  // The defect he reported: every item in Katalon Titan Sprint 30 named a
  // person, and the screen said 53 of them had no assignee. A row for work
  // that HAS an owner has to carry that owner's name.
  const { html, payload } = await renderHtml(OFF_ROSTER, OFF_ROSTER_PLAN);
  const table = peopleSection(html);
  assert.strictEqual(payload.unassigned.count, 0, 'fixture check: nothing here is truly unassigned');
  assert.ok(!table.includes('>No assignee<'), 'named work was reported as having no assignee');
  for (const p of payload.offRoster.people) {
    assert.ok(table.includes(p.name), `${p.name} does not appear in the table`);
  }
  assert.ok(table.includes('not on sprint'), 'nothing says why they are listed apart');
});

check('and their points are theirs, not a lump', async () => {
  const { html, payload } = await renderHtml(OFF_ROSTER, OFF_ROSTER_PLAN);
  const table = peopleSection(html);
  const luong = payload.offRoster.people.find(p => p.name === 'Luong Trinh');
  const row = table.slice(table.indexOf('Luong Trinh'));
  assert.ok(row.includes(`>${luong.planned}<`), `Luong Trinh's ${luong.planned} pts are not on his row`);
});

check('and it carries planned AND done, not just planned', async () => {
  const table = peopleSection((await renderHtml()).html);
  const cells = [...table.matchAll(/<td class="num">([\d.]+)<\/td>/g)].map(m => m[1]);
  // The last row is the unowned one: planned 10, done 6, then remaining 4.
  assert.deepStrictEqual(cells.slice(-3), ['10', '6', '4']);
});

check('THE PEOPLE TABLE NOW ADDS UP TO THE COMMITTED KPI', async () => {
  const { html, payload } = await renderHtml();
  const table = peopleSection(html);
  const rows = [...table.matchAll(/<td class="num">([\d.]+)<\/td>\s*<td class="num">([\d.]+)<\/td>/g)];
  const planned = rows.reduce((t, m) => t + Number(m[1]), 0);
  const done = rows.reduce((t, m) => t + Number(m[2]), 0);
  // This is the defect the row exists to fix: without it these two sums were
  // short by exactly the unowned pile, with nothing on screen to say why.
  assert.strictEqual(planned, payload.progress.committed);
  assert.strictEqual(done, payload.progress.done);
});

check('a sprint with nothing unowned gets no empty row', async () => {
  const owned = {
    ...SNAP,
    issues: Object.fromEntries(Object.entries(SNAP.issues).filter(([k]) => !UNOWNED.includes(k))),
  };
  const { html } = await renderHtml(owned);
  assert.ok(!html.includes('unassigned-row'), 'an unowned row appeared with nothing in it');
});

/* ── the same table on Capacity planning ──────────────────────────────── */

check('CAPACITY PLANNING SHOWS THE SPRINT ITEMS TOO', async () => {
  // Balancing a sprint ends in the tickets — you move work between people by
  // picking specific ones — and having to change screens to see them meant
  // holding the grid in your head while you looked.
  const { html, payload } = await renderCapacity();
  assert.ok(html.includes('All sprint items'), 'the section is missing');
  const body = itemsSection(html);
  for (const k of [...OWNED, ...UNOWNED]) {
    assert.ok(body.includes(`>${k}</a>`) || body.includes(`>${k}<`), `${k} has no row`);
  }
  assert.strictEqual((body.match(/<tr>/g) || []).length, payload.items.length + 1);
});

check('and it is the SAME table, not a second one that will drift', async () => {
  // Rendered from one helper, so the columns cannot diverge between screens.
  const a = itemsSection((await renderHtml()).html);
  const b = itemsSection((await renderCapacity()).html);
  const headings = (h) => (h.match(/<th[^>]*>([^<]*)<\/th>/g) || []).join('');
  assert.strictEqual(headings(a), headings(b), 'the two screens disagree about the columns');
  assert.ok(headings(a).includes('Epic'), 'fixture check: this is the item table, not some other one');
});

check('the capacity payload carries the items at all', async () => {
  const { payload } = await renderCapacity();
  assert.ok(Array.isArray(payload.items) && payload.items.length === 6,
    'the view can only show what the model returns');
});

check('EVERY ROW HAS AS MANY CELLS AS THE HEADER HAS COLUMNS', async () => {
  // The output-level version of the alignment rule epics.test.js asserts on the
  // source. A column added to the header and not the body shifts every value
  // one to the left and still renders without an error — on both screens now,
  // which is the cost of sharing the table and the reason to check the result
  // rather than the template.
  for (const [where, render] of [['Active sprint', renderHtml], ['Capacity planning', renderCapacity]]) {
    const body = itemsSection((await render()).html);
    // `<th[^>]*>` also matches `<thead>` — the tag name has to end at a space
    // or the closing bracket, or the header comes out one column too wide.
    const cols = (body.match(/<th(?=[\s>])[^>]*>/g) || []).length;
    assert.ok(cols >= 8, `${where}: expected the full item table, saw ${cols} columns`);
    const rows = body.split('<tr>').slice(2);          // past the header row
    assert.ok(rows.length, `${where}: no rows to check`);
    for (const r of rows) {
      assert.strictEqual((r.match(/<td[^>]*>/g) || []).length, cols,
        `${where}: a row has a different number of cells than the header has columns`);
    }
  }
});

/* ── per-component progress ───────────────────────────────────────────── */

/** Just the "Per-component progress" card. */
const componentSection = (html) => {
  const from = html.indexOf('Per-component progress');
  return from < 0 ? '' : html.slice(from, html.indexOf('</table>', from));
};

check('THE ACTIVE SPRINT SCREEN BREAKS PROGRESS DOWN BY COMPONENT', async () => {
  const { html, payload } = await renderHtml();
  const body = componentSection(html);
  assert.ok(body, 'the section is missing');
  for (const r of payload.byComponent.rows) {
    assert.ok(body.includes(r.component), `${r.component} has no row`);
  }
  const rows = body.split('<tr>').slice(2);
  assert.strictEqual(rows.length, payload.byComponent.rows.length);
});

check('and it sits ABOVE the item table, where it was asked for', async () => {
  const { html } = await renderHtml();
  const comp = html.indexOf('Per-component progress');
  const items = html.indexOf('All sprint items');
  assert.ok(comp > 0 && items > 0, 'both sections must be on the page');
  assert.ok(comp < items, 'the breakdown reads before the list it summarises');
});

check('THE TOOL MARKER NEVER BECOMES A ROW', async () => {
  // "TrueTest" is on one of the fixture's items and on two thirds of his real
  // ones. It is where the suite runs, not an area of the product.
  const body = componentSection((await renderHtml()).html);
  assert.ok(body.includes('PS_iGO_NLG'), 'fixture check: the real component is there');
  assert.ok(!body.includes('TrueTest'), 'the automation tool was listed as a product component');
});

check('the numbers on the page are the numbers from the model', async () => {
  const { html, payload } = await renderHtml();
  const body = componentSection(html);
  const nlg = payload.byComponent.rows.find(r => r.component === 'PS_iGO_NLG');
  const row = body.slice(body.indexOf('PS_iGO_NLG'));
  const cells = [...row.matchAll(/<td class="num">([\d.]+)<\/td>/g)].map(m => Number(m[1]));
  assert.deepStrictEqual(cells.slice(0, 3), [nlg.count, nlg.points, nlg.done],
    'items, committed and done, in that order');
});

check('a component behind the sprint is marked', async () => {
  // Six of ten working days gone. KAT_Common has delivered nothing, so it is
  // behind; PS_iGO_NLG is at 15 of 20 and is not.
  const body = componentSection((await renderHtml()).html);
  const kat = body.slice(body.indexOf('KAT_Common'));
  assert.ok(kat.includes('behind the sprint'), 'a component with nothing delivered on day six is behind');
  const nlg = body.slice(body.indexOf('PS_iGO_NLG'), body.indexOf('KAT_Common'));
  assert.ok(!nlg.includes('behind the sprint'), 'and one that is keeping up is not');
});

check('a sprint with no components at all renders no empty section', async () => {
  const bare = {
    ...SNAP,
    issues: Object.fromEntries(Object.entries(SNAP.issues).map(([k, v]) => [k, { ...v, components: [] }])),
  };
  const { html } = await renderHtml(bare);
  // One row — "no component" — is still a real answer, so the section stays.
  // What must not happen is a section with no rows under it.
  const body = componentSection(html);
  if (body) assert.ok(body.split('<tr>').length > 2, 'a section with a header and nothing in it');
});

/* ── run ──────────────────────────────────────────────────────────────── */

(async () => {
  console.log('\nThe Active sprint screen, as rendered\n');
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
