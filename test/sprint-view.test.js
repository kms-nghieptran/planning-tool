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
  key: o.key, summary: o.summary || `Work item ${o.key}`, issueType: o.type || 'Story',
  status: o.status || 'Open', statusCategory: o.status === 'Done' ? 'done' : 'new',
  assignee: o.assignee || null, labels: [], components: o.components || [],
  points: 'points' in o ? o.points : 3, sprintNames: ['Katalon Titan Sprint 40'],
  sprints: [{ name: 'Katalon Titan Sprint 40' }], blockedBy: [], relatesTo: o.relatesTo || [],
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
    // Bucket stories, which is where maintenance work lives: one maintaining
    // three test cases, one maintaining none.
    issue({ key: 'A-20', assignee: 'Hien Phan', points: 3, type: 'Bucket Story',
      relatesTo: [{ key: 'AUTOKAT-1' }, { key: 'AUTOKAT-2' }, { key: 'AUTOKAT-3' }] }),
    issue({ key: 'A-21', assignee: 'Hien Phan', points: 1, type: 'Bucket Story', relatesTo: [] }),
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
  // Enough of a window for the export: it prints, and renames the document
  // while it does, so both have to be observable.
  const printed = [];
  const ctx = {
    console, Promise, setTimeout, encodeURIComponent, CSS: { escape: String },
    App: { refresh() {} },
    Charts: new Proxy({}, { get: () => () => '' }),
    document: {
      title: 'Planning Tool',
      createElement: () => ({ set innerHTML(_) {}, content: { firstElementChild: null } }),
    },
    window: {
      print() { printed.push(ctx.document.title); },
      addEventListener(t, fn) { (ctx.window._on = ctx.window._on || {})[t] = fn; },
      removeEventListener() {},
      _on: {},
    },
  };
  vm.createContext(ctx);
  // The real ui.js — a hand-written stub drifts from the thing it stands in for.
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);
  ctx.UI.setJiraBase('https://ipipelinejira.atlassian.net');
  ctx.UI.api = async () => payload;

  vm.runInContext(`${VIEW}\n;globalThis.__v = SprintView;`, ctx);
  const clicks = [];
  const mount = {
    style: {},
    addEventListener: (t, fn) => { if (t === 'click') clicks.push(fn); },
    querySelector: () => el(), querySelectorAll: () => [],
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    /** Fire a click as the browser would, with a target that can be `closest`ed. */
    click(act) {
      const target = { closest: (sel) => (sel.includes(act) ? { dataset: { act } } : null) };
      for (const fn of clicks.slice()) fn({ target, preventDefault() {} });
    },
  };
  await ctx.__v.render({
    teamId: 'titan', sprintId: 'S40', categories: {},
    teams: [{ id: 'titan', name: 'Katalon Titan', jiraName: 'Katalon Auto Titan' }],
    syncedAt: '2026-09-24T09:00:00.000Z',
  }, mount);
  return { html, payload, mount, ctx, printed };
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
  // Derived, not typed: a literal here breaks every time the fixture grows,
  // for a reason that has nothing to do with what this check is about.
  const { html, payload } = await renderHtml();
  const unowned = payload.items.filter(i => !i.assignee).length;
  assert.ok(html.includes(`${payload.items.length} items · ${unowned} with no assignee`),
    `caption does not read "${payload.items.length} items · ${unowned} with no assignee"`);
});

check('a sprint where everything is owned says nothing about assignees', async () => {
  const owned = {
    ...SNAP,
    issues: Object.fromEntries(Object.entries(SNAP.issues).filter(([k]) => !UNOWNED.includes(k))),
  };
  const { html, payload } = await renderHtml(owned);
  assert.ok(html.includes(`${payload.items.length} items`));
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
  const { payload: sprint } = await renderHtml();
  assert.ok(Array.isArray(payload.items) && payload.items.length === sprint.items.length,
    'the capacity screen must carry the same items the sprint screen does');
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

/**
 * The whole `<tr>` an issue key sits in.
 *
 * Slicing from the key itself starts INSIDE the first cell, so the row comes
 * back one cell short and a count of its cells is quietly wrong.
 */
const rowFor = (html, key) => {
  const at = html.indexOf(`>${key}<`);
  if (at < 0) return '';
  const start = html.lastIndexOf('<tr', at);
  return html.slice(start, html.indexOf('</tr>', at));
};

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

/* ── test cases under maintenance ─────────────────────────────────────── */

check('THE ITEM TABLE COUNTS TEST CASES UNDER MAINTENANCE', async () => {
  const { html, payload } = await renderHtml();
  const body = itemsSection(html);
  assert.ok(body.includes('Test cases'), 'no column for it');
  const a20 = payload.items.find(i => i.key === 'A-20');
  assert.strictEqual(a20.maintains, 3, 'fixture check: three relates-to links');
  // Read the LAST cell of the row, not just any cell holding a 3: this item is
  // also worth 3 points, so a looser match passed happily with the column
  // deleted altogether.
  const row = rowFor(body, 'A-20');
  const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].trim());
  assert.strictEqual(cells.length, 9, `expected 9 cells in the row, got ${cells.length}`);
  assert.strictEqual(cells[8], '3', `the test-case cell reads "${cells[8]}"`);
});

check('a bucket story maintaining nothing says zero, and says it loudly', async () => {
  // The zero is the answer here, and usually the one worth acting on: a
  // maintenance container with no links to what it maintains.
  const body = itemsSection((await renderHtml()).html);
  const row = rowFor(body, 'A-21');
  assert.ok(row.includes('>0<'), 'no count on an empty bucket story');
  assert.ok(row.includes('tag warn'), 'and nothing draws the eye to it');
});

check('ANYTHING THAT IS NOT A BUCKET STORY IS NOT ASKED', async () => {
  // A Story's relates-to links are not test cases, and a column of zeroes
  // against them invites someone to total it.
  const { html, payload } = await renderHtml();
  const body = itemsSection(html);
  const story = payload.items.find(i => i.key === 'A-1');
  assert.strictEqual(story.maintains, null, 'the model must not put a number on a Story');
  const cells = [...rowFor(body, 'A-1').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].trim());
  assert.ok(cells[8] && cells[8].includes('—'), `the cell should be blank, not "${cells[8]}"`);
});

check('and the caption totals the sprint\'s maintenance load', async () => {
  const { html } = await renderHtml();
  assert.match(html, /3 test cases maintained across 2 bucket stories/);
});

check('a sprint with no bucket stories says nothing about test cases', async () => {
  const none = {
    ...SNAP,
    issues: Object.fromEntries(Object.entries(SNAP.issues).filter(([k]) => !['A-20', 'A-21'].includes(k))),
  };
  const { html } = await renderHtml(none);
  assert.ok(!/test cases maintained/.test(html), 'no zero-count noise on a sprint with no maintenance');
});

/* ── the KPI row ──────────────────────────────────────────────────────── */

/** The KPI strip, label and value, in the order they appear. */
const kpis = (html) => [...html.matchAll(/<div class="label">([^<]*)<\/div>\s*<div class="value[^"]*">([^<]*)/g)]
  .map(m => [m[1].trim(), m[2].trim()]);

check('CAPACITY LEADS THE KPI ROW, immediately before Committed', async () => {
  const { html } = await renderHtml();
  const labels = kpis(html).map(([l]) => l);
  const at = labels.indexOf('Capacity');
  assert.ok(at >= 0, `no Capacity KPI — got ${JSON.stringify(labels)}`);
  assert.strictEqual(labels[at + 1], 'Committed', 'Capacity has to read directly into what was committed against it');
});

check('and it shows the capacity the grid computed', async () => {
  const { html, payload } = await renderHtml();
  const cap = kpis(html).find(([l]) => l === 'Capacity');
  assert.strictEqual(cap[1], String(Math.round(payload.totals.predicted)));
});

check('THE HEADROOM IS MEASURED AGAINST THIS SCREEN\'S OWN COMMITMENT', async () => {
  // The grid's `totals.planned` counts only work on roster members; this
  // screen's commitment also counts work that landed on nobody. Printing the
  // grid's own over/under beside them would be a number that does not
  // reconcile with the two cards either side of it.
  const { html, payload } = await renderHtml(OFF_ROSTER, OFF_ROSTER_PLAN);
  const gap = Math.round((payload.totals.predicted - payload.progress.committed) * 10) / 10;
  assert.notStrictEqual(payload.totals.planned, payload.progress.committed,
    'fixture check: this sprint has work outside the roster, or the check proves nothing');
  const strip = html.slice(html.indexOf('<div class="kpis">'), html.indexOf('</section>', html.indexOf('<div class="kpis">')));
  assert.ok(strip.includes(`${gap} pts of headroom`) || strip.includes(`${Math.abs(gap)} pts over capacity`),
    `the headroom does not match capacity minus commitment (${gap})`);
});

check('a sprint with no capacity says so rather than claiming zero headroom', async () => {
  // Everyone off for the whole sprint, so the grid really does compute zero —
  // an EMPTY availability map would not do it, because a missing row falls back
  // to a full working fortnight and the check would pass without asserting
  // anything. It did, until a mutation that deleted the guard stayed green.
  const off = new Array(14).fill('0');
  const noCapacity = { ...PLAN, availability: { 'titan|S40|m1': off, 'titan|S40|m2': off } };
  const { html, payload } = await renderHtml(SNAP, noCapacity);
  assert.strictEqual(payload.totals.predicted, 0, 'fixture check: this sprint has to have no capacity');
  assert.ok(html.includes('no capacity entered'), 'zero capacity must not read as zero headroom');
  assert.ok(!html.includes('pts of headroom'), 'and must not claim headroom it does not have');
});

/* ── export to PDF ────────────────────────────────────────────────────── */

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const printRules = css.slice(css.indexOf('@media print'));

check('THE SCREEN OFFERS AN EXPORT, and the export is a print', async () => {
  const { html } = await renderHtml();
  assert.ok(html.includes('data-act="export-pdf"'), 'no Export PDF control');
  assert.ok(html.includes('Export PDF'), 'the control is not labelled');
});

check('CLICKING IT PRINTS', async () => {
  const { mount, printed } = await renderHtml();
  mount.click('export-pdf');
  assert.strictEqual(printed.length, 1, 'the browser was never asked to print');
});

check('and the file is named after the sprint, not after the app', async () => {
  // The browser names the download from the document title. Left alone, every
  // sprint report in a folder is called "Planning Tool.pdf".
  const { mount, printed, ctx } = await renderHtml();
  mount.click('export-pdf');
  assert.match(printed[0], /Katalon Auto Titan/, `title at print time was "${printed[0]}"`);
  assert.match(printed[0], /Sprint 40/);
  assert.ok(!/[\\/:*?"<>|]/.test(printed[0]), 'a filename cannot carry path characters');
  ctx.window._on.afterprint();
  assert.strictEqual(ctx.document.title, 'Planning Tool', 'the title has to go back afterwards');
});

check('THE PDF SAYS WHICH TEAM, WHICH SPRINT AND WHEN', async () => {
  // All three are in the furniture on screen — sidebar, topbar, sync line —
  // and print hides every bit of it.
  const { html } = await renderHtml();
  const head = html.slice(html.indexOf('print-only'), html.indexOf('</div>', html.indexOf('print-only')) + 400);
  assert.match(head, /Katalon Auto Titan/, 'the team is not on the page');
  assert.match(head, /Sprint 40/, 'the sprint is not on the page');
  assert.match(head, /synced/, 'nothing says how fresh the Jira data is');
  assert.match(head, /report taken/, 'nothing dates the report itself');
});

check('the title block is print-only, and the button is screen-only', async () => {
  const { html } = await renderHtml();
  assert.match(css, /^\.print-only \{ display: none; \}/m, 'the title block would show on screen');
  assert.match(printRules, /\.print-only \{ display: block !important/, 'and never show in print');
  assert.ok(html.includes('class="section print-hide"'), 'the export button prints as a dead control');
  assert.match(printRules, /\.print-hide \{ display: none !important/);
});

/* ── what print has to undo ───────────────────────────────────────────── */

check('PRINT HIDES THE FURNITURE nobody can click on paper', async () => {
  for (const sel of ['.sidebar', '.topbar', '.drawer', '.toast', '.btn']) {
    assert.ok(printRules.includes(sel), `${sel} would print`);
  }
});

check('A SCROLL CONTAINER MUST NOT CLIP THE WIDEST TABLE', async () => {
  // `.table-wrap` scrolls sideways on screen. On paper there is nowhere to
  // scroll to, so whatever is past the page edge is simply gone.
  assert.match(printRules, /\.table-wrap[^{]*\{[^}]*overflow: visible !important/);
});

check('a long table repeats its header on every page', async () => {
  assert.match(printRules, /thead \{ display: table-header-group/);
});

check('THE DARK THEME PRINTS AS INK ON PAPER', async () => {
  // Without this the report is a black page — expensive, and unreadable once
  // the printer gives up on the backgrounds.
  const dark = printRules.slice(printRules.indexOf(':root[data-theme="dark"]'));
  assert.ok(printRules.includes(':root[data-theme="dark"]'), 'the dark theme is never restored');
  assert.match(dark.slice(0, 400), /--app-bg: #FFFFFF/i, 'the page background is still dark');
  assert.match(dark.slice(0, 400), /--app-fg: #10112A/i, 'the text is still light-on-dark');
});

check('and the backgrounds that carry meaning survive', async () => {
  // A red workload cell, a category dot, the bars: most browsers drop
  // backgrounds when printing unless told otherwise, and the report loses the
  // signal while keeping the numbers.
  assert.match(printRules, /print-color-adjust: exact/);
});

check('THE WIDE TABLE IS LAID OUT TO THE PAGE, not merely un-scrolled', async () => {
  // Letting the wrapper overflow stops the container clipping and does nothing
  // about the table being wider than A4: the item table first printed with
  // Component truncated mid-word and Epic missing altogether, on a page that
  // still looked complete.
  assert.match(printRules, /\.items-table \{ table-layout: fixed/, 'the columns are not sized for paper');
  const widths = [...printRules.matchAll(/\.items-table \.col-[a-z]+ \{ width: (\d+)%/g)].map(m => Number(m[1]));
  assert.strictEqual(widths.length, 9, `expected a width for all 9 columns, found ${widths.length}`);
  assert.strictEqual(widths.reduce((a, b) => a + b, 0), 100,
    `the column widths add up to ${widths.reduce((a, b) => a + b, 0)}%, so the table cannot fit the page`);
});

check('and the table it sizes is the one the views render', async () => {
  // The print rules key off `.items-table` and the column classes. If the
  // shared table stopped emitting them the rules would silently do nothing.
  const { html } = await renderHtml();
  assert.ok(html.includes('class="items-table"'), 'the shared item table lost its class');
  for (const c of ['col-key', 'col-summary', 'col-category', 'col-assignee',
    'col-status', 'col-points', 'col-component', 'col-epic', 'col-tests']) {
    assert.ok(html.includes(c), `no ${c} column class — the print width for it is dead`);
  }
});

check('AN ISSUE KEY IS NEVER BROKEN ACROSS LINES', async () => {
  // It is the one string on the page someone retypes into Jira, and the same
  // wrapping that makes long component names fit would split it in half.
  assert.match(printRules, /\.issue-key[^{]*\{[^}]*white-space: nowrap/);
});

check('a card is not split across a page break', async () => {
  assert.match(printRules, /break-inside: avoid/);
  assert.match(printRules, /break-after: avoid/, 'a heading must not be orphaned from its table');
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
