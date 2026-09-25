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
const priority = require('../lib/priority');

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
  sprints: [{ name: 'Katalon Titan Sprint 40' }],
  // The item's OWN blockers, and its parent. Both default to nothing, which is
  // the shape of every Story in Refinement in his sprint: the block is
  // recorded on the epic, never on the Story.
  blockedBy: o.blockedBy || [], parentKey: o.parentKey || null, relatesTo: o.relatesTo || [],
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

/* ── REFINEMENT, AND THE BLOCK RECORDED ONE LEVEL UP ───────────────────────
   His TT Week 14Sep, in miniature. Sixteen Stories sat in Refinement, not one
   of them naming an "is blocked by" of its own, while ten of their parent
   epics named a blocker — and all ten named the SAME ticket, in a project this
   tool does not even sync. The sprint board showed none of it.

   So the fixture is built to fail the plausible implementations:
     · R-1 and R-2 are in Refinement under DIFFERENT epics that share a blocker,
       so a drawer keyed off the story rather than its epic still looks right
       on one of them and wrong on the other.
     · R-3 is in Refinement under an epic with nothing recorded — the icon must
       not appear, or it appears on every row and stops meaning anything.
     · N-1 is NOT in Refinement under a blocked epic, which is the five rows in
       his sprint that this feature deliberately does not mark.
     · R-4 carries its own blocker and sits under an unblocked epic, so an
       implementation that reads the ITEM's blockedBy passes everything above
       and fails here. */
const EPIC = (key, blockedBy) => ({
  key, summary: `Epic ${key}`, issueType: 'Epic', status: 'Open', components: [],
  labels: [], blockedBy, relatesTo: [],
});

const REFINE_SNAP = {
  ...SNAP,
  issues: Object.fromEntries([
    ...Object.values(SNAP.issues),
    EPIC('E-BLOCKED', ['CLICMNTIGO-11567']),
    EPIC('E-ALSO', ['CLICMNTIGO-11567', 'OTHER-1']),
    EPIC('E-CLEAR', []),
    issue({ key: 'R-1', assignee: 'Hien Phan', points: 3, status: 'Refinement', parentKey: 'E-BLOCKED' }),
    issue({ key: 'R-2', assignee: 'Hien Phan', points: 2, status: 'Refinement', parentKey: 'E-ALSO' }),
    issue({ key: 'R-3', assignee: 'Hien Phan', points: 1, status: 'Refinement', parentKey: 'E-CLEAR' }),
    issue({ key: 'R-4', assignee: 'Hien Phan', points: 1, status: 'Refinement', parentKey: 'E-CLEAR', blockedBy: ['OWN-1'] }),
    issue({ key: 'N-1', assignee: 'Hien Phan', points: 1, status: 'In Dev', parentKey: 'E-BLOCKED' }),
  ].map(i => [i.key, i])),
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
  const view = insights.activeSprintView(plan, snap, TEAM, SPRINT, { today: MID_SPRINT });
  /* Assembled the way `/api/sprint` assembles it, risks included — the bare
     view is no longer what the page receives, and a harness that renders a
     payload the server never sends is checking a screen nobody sees. That the
     ROUTE really sends this is checked over HTTP, in sprint-api.test.js. */
  const payload = {
    ...view,
    risks: {
      signals: insights.signalsFor(TEAM, SPRINT, view, snap),
      manual: (plan.risks || []).filter(r => String(r.status || '').toLowerCase() !== 'closed'),
    },
    testCases: view.testCases
      ? { ...view.testCases, rows: priority.decorate(view.testCases.rows, plan) }
      : view.testCases,
    priorityLevels: priority.LEVELS,
  };
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
    /** Fire a click as the browser would, with a target that can be `closest`ed.
        `data` carries the rest of the element's dataset — a handler that reads
        `dataset.key` to find its row gets nothing without it, and then quietly
        opens no drawer at all rather than failing. */
    click(act, data = {}) {
      const target = { closest: (sel) => (sel.includes(act) ? { dataset: { act, ...data } } : null) };
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

/* ── CALC EXEMPT, ON THE CAPACITY GRID ────────────────────────────────
   On the roster, out of the capacity arithmetic. The model is checked in
   capacity.test.js and the round trip in sprint-api.test.js; here it is the
   screen — the control exists, the row is marked, the table still lines up,
   and the consequence is stated rather than left to be discovered. */

/** The member capacity table, cut out by its own header. */
const memberTable = (html) => {
  const at = html.indexOf('Calc exempt');
  assert.ok(at > 0, 'there is no Calc exempt column on the capacity grid');
  const start = html.lastIndexOf('<table', at);
  return html.slice(start, html.indexOf('</table>', start));
};

const EXEMPT_PLAN = { ...PLAN, calcExempt: { 'titan|S40|m2': true } };

check('EVERY MEMBER HAS A CALC-EXEMPT TOGGLE', async () => {
  const { html, payload } = await renderCapacity(SNAP, PLAN);
  const tbl = memberTable(html);
  assert.ok(payload.rows.length, 'the fixture needs members');
  for (const r of payload.rows) {
    assert.match(tbl, new RegExp(`data-exempt="${r.memberId}"`), `${r.name} has no toggle`);
  }
});

check('and an exempt member is TICKED and marked, not hidden', async () => {
  // They are on the sprint and may be carrying work. Hiding them would make
  // this the roster screen, and there is already one of those.
  const { html, payload } = await renderCapacity(SNAP, EXEMPT_PLAN);
  const tbl = memberTable(html);
  const ex = payload.rows.find(r => r.calcExempt);
  assert.ok(ex, 'the fixture did not produce an exempt member');
  assert.match(tbl, new RegExp(`data-exempt="${ex.memberId}"[^>]*checked`), 'the box is not ticked');
  assert.match(tbl, /<tr class="[^"]*exempt"/, 'the row is not marked');
  assert.match(tbl, new RegExp(ex.name), 'the exempt member vanished from the grid');
});

check('THE HOURS COME OUT OF THE TEAM TOTAL, and the screen says how many are exempt', async () => {
  const base = await renderCapacity(SNAP, PLAN);
  const { html, payload } = await renderCapacity(SNAP, EXEMPT_PLAN);
  assert.ok(payload.totals.capacityHours < base.payload.totals.capacityHours,
    'exempting somebody did not reduce the capacity');
  assert.strictEqual(payload.totals.exempt, 1);
  assert.match(memberTable(html), /1 exempt/, 'the total row does not explain its own headcount');
});

check('AND THE CONSEQUENCE IS STATED — committed work still counts', async () => {
  /* The surprising half. Their hours leave the capacity, their work does not
     leave the sprint, so the team can read as more loaded than its capacity
     covers. A reader who is not told that will file it as a bug. */
  const { html } = await renderCapacity(SNAP, EXEMPT_PLAN);
  assert.match(html, /exempt from this sprint's capacity/);
  assert.match(html, /still counted/);
});

check('and nothing is said when nobody is exempt', async () => {
  // A permanent paragraph explaining a feature nobody is using is noise.
  const { html } = await renderCapacity(SNAP, PLAN);
  assert.ok(!/exempt from this sprint's capacity/.test(html));
});

check('THE MEMBER TABLE STILL LINES UP, header, rows and footer', async () => {
  /* Adding a column is where a table quietly goes one cell out: the header
     grows, a row or the footer does not, and every number after it shifts one
     place left while rendering perfectly. */
  for (const [label, plan] of [['no exemptions', PLAN], ['one exempt', EXEMPT_PLAN]]) {
    const tbl = memberTable((await renderCapacity(SNAP, plan)).html);
    const cols = (tbl.match(/<th(?=[\s>])[^>]*>/g) || []).length;
    assert.ok(cols >= 11, `${label}: expected the full table, saw ${cols} columns`);
    const body = tbl.slice(tbl.indexOf('<tbody>'), tbl.indexOf('</tbody>'));
    const rows = body.split('<tr').slice(1);
    assert.ok(rows.length, `${label}: no rows`);
    for (const r of rows) {
      const cells = (r.match(/<td[^>]*>/g) || []).length;
      const span = [...r.matchAll(/colspan="(\d+)"/g)].reduce((t, m) => t + (Number(m[1]) - 1), 0);
      assert.strictEqual(cells + span, cols, `${label}: a row has ${cells + span} cells against ${cols} columns`);
    }
  }
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
  // The number is a control now, so the cell is a button wrapping it. Still
  // matched on the LAST cell for the reason above: this row is also worth 3
  // points, and a looser match was once green with the column deleted.
  assert.match(cells[8], />3<\/button>/, `the test-case cell reads "${cells[8]}"`);
  assert.match(cells[8], /data-act="item-testcases"[^>]*data-key="A-20"/,
    'the number does not open the suites it counted');
});

check('a bucket story maintaining nothing says zero, and says it loudly', async () => {
  // The zero is the answer here, and usually the one worth acting on: a
  // maintenance container with no links to what it maintains.
  const body = itemsSection((await renderHtml()).html);
  const row = rowFor(body, 'A-21');
  assert.ok(row.includes('>0<'), 'no count on an empty bucket story');
  assert.ok(row.includes('tag warn'), 'and nothing draws the eye to it');
});

/* ── THE DRAWER BEHIND THE TEST-CASE NUMBER ───────────────────────────── */

check('THE DRAWER LISTS EXACTLY WHAT THE NUMBER COUNTED', async () => {
  /* The property every drill-in on this screen is built around: a list
     assembled by different code from the figure above it is a list that can
     disagree with it, and both render perfectly. */
  const { payload, ctx, mount } = await renderHtml();
  let drawn = '';
  ctx.UI.drawer = (h) => { drawn = h; };
  const a20 = payload.items.find(i => i.key === 'A-20');
  assert.strictEqual(a20.maintains, 3, 'fixture check');

  mount.click('item-testcases', { key: 'A-20' });
  assert.match(drawn, /Maintained by A-20/, 'the drawer does not name the bucket story');
  const rows = (drawn.match(/border-bottom:1px solid var\(--app-line-soft\)/g) || []).length;
  assert.strictEqual(rows, a20.maintains,
    `the number says ${a20.maintains}, the drawer shows ${rows}`);
  for (const k of ['AUTOKAT-1', 'AUTOKAT-2', 'AUTOKAT-3']) assert.match(drawn, new RegExp(k));
});

check('and the set it lists is the SAME set the count was the size of', async () => {
  /* Pinned on the payload rather than on the markup: `maintains` is the length
     of `maintainsLinks`, so a drawer reading the links and a cell reading the
     count cannot drift. Duplicated links — Jira holds them from both sides —
     are one suite in both. */
  const { payload } = await renderHtml();
  for (const i of payload.items.filter(x => x.bucket)) {
    assert.strictEqual(i.maintains, (i.maintainsLinks || []).length,
      `${i.key}: count ${i.maintains}, set ${(i.maintainsLinks || []).length}`);
    const keys = (i.maintainsLinks || []).map(l => l.key);
    assert.strictEqual(new Set(keys).size, keys.length, `${i.key}: the set holds a key twice`);
  }
});

/* Two bucket stories that BOTH have links, so "opened the wrong row" is
   visible. With only one clickable row in the grid, a handler that ignores the
   key it was given and picks the first bucket story it finds is right by
   accident. */
const TWO_BUCKETS = {
  ...SNAP,
  issues: Object.fromEntries([
    ...Object.values(SNAP.issues),
    issue({ key: 'A-22', assignee: 'Hien Phan', points: 2, type: 'Bucket Story',
      relatesTo: [{ key: 'SHRTEC-7' }, { key: 'SHRTEC-8' }] }),
  ].map(i => [i.key, i])),
};

check('THE DRAWER OPENS THE ROW THAT WAS CLICKED, not the first one like it', async () => {
  const { payload, ctx, mount } = await renderHtml(TWO_BUCKETS);
  let drawn = '';
  ctx.UI.drawer = (h) => { drawn = h; };
  const a22 = payload.items.find(i => i.key === 'A-22');
  assert.strictEqual(a22.maintains, 2, 'fixture check: A-22 maintains a different set');

  mount.click('item-testcases', { key: 'A-22' });
  assert.match(drawn, /Maintained by A-22/, `opened the wrong row: ${drawn.slice(0, 120)}`);
  assert.match(drawn, /SHRTEC-7/);
  assert.ok(!/AUTOKAT-1</.test(drawn), 'it listed the other bucket story\'s suites');
});

check('A ZERO IS NOT A BUTTON — nothing behind it, nothing to press', async () => {
  const body = itemsSection((await renderHtml()).html);
  const row = rowFor(body, 'A-21');
  assert.ok(!/data-act="item-testcases"/.test(row),
    'an empty bucket story offered a control that opens nothing');
});

check('and a link the tool never synced is still listed, with what the link knows', async () => {
  /* A maintained suite usually lives outside the three datasets this tool
     pulls, so the summary Jira put inside the link is the only description of
     it that will ever exist locally. Dropping those rows would make the list
     shorter than the number that opened it. */
  const { payload, ctx } = await renderHtml();
  const item = {
    key: 'B-9', bucket: true, maintains: 2,
    maintainsLinks: [
      { key: 'SHRTEC-8295', summary: 'iGO smoke pack', type: 'Epic' },
      { key: 'GHOST-1', summary: null, type: null },
    ],
  };
  const html = ctx.UI.testCasesDrawer(item, payload.items, {}, {});
  assert.match(html, /iGO smoke pack/, 'the summary the link carried was dropped');
  assert.match(html, /GHOST-1/, 'a link with nothing known was dropped entirely');
  assert.match(html, /Not in the local store/, 'and the one with nothing known has to say so');
  assert.match(html, />Open in Jira</, 'which makes the way out to Jira the point of the panel');
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

/* ── PRIORITY ON "TEST CASES BY COMPONENT" ────────────────────────────
   His judgement of which suites matter, on the sprint's own component table.
   Set on the Coverage grid, shown here — one owner, three readers. */

/** The "Test cases by component" section, cut out by its heading. */
const testCaseSection = (html) => {
  const at = html.indexOf('<h2>Test cases by component</h2>');
  assert.ok(at > 0, 'the test-case section is not on the page');
  return html.slice(html.lastIndexOf('<section', at), html.indexOf('</section>', at));
};

/** A plan where two of the fixture's components carry a priority and one does not. */
const PRIORITISED = { ...PLAN, componentPriority: { PS_iGO_NLG: 1, KAT_Common: 4 } };

check('THE TEST-CASE TABLE SHOWS EACH COMPONENT\'S PRIORITY', async () => {
  const { html, payload } = await renderHtml(SNAP, PRIORITISED);
  const sec = testCaseSection(html);
  assert.match(sec, /<th[^>]*>Priority<\/th>/, 'no Priority column');

  const rows = payload.testCases.rows;
  assert.ok(rows.length, 'the fixture needs test-case rows');
  const set = rows.filter(r => r.priority != null);
  assert.ok(set.length >= 2, `only ${set.length} rows carry a priority — the fixture proves nothing`);
  for (const r of set) {
    assert.match(sec, new RegExp(`prio-p${r.priority}"[^>]*>P${r.priority}<`),
      `${r.component} is P${r.priority} and the table does not say so`);
  }
});

check('and a component nobody has judged shows a dash, not P4', async () => {
  /* Unset is a real state. Rendering it as the bottom of the scale claims a
     judgement nobody made — the rule `priority.js` is built around. */
  const { html, payload } = await renderHtml(SNAP, PRIORITISED);
  const unset = payload.testCases.rows.filter(r => r.priority == null);
  assert.ok(unset.length, 'the fixture needs a component with no priority set');
  const sec = testCaseSection(html);
  // As many dashes as there are unjudged rows, and no P-tag for them.
  const tags = (sec.match(/class="tag prio-tag/g) || []).length;
  assert.strictEqual(tags, payload.testCases.rows.length - unset.length,
    'a row with no priority is wearing a tag');
});

check('and it sorts unset LAST, in both directions', async () => {
  // `data-sort-value="—"` is what `SORT_BLANK` pins to the bottom whichever
  // way the column points. A numeric 99 would float every unjudged row above
  // the P1s on a descending sort — the bug the Coverage grid already had.
  const { html, payload } = await renderHtml(SNAP, PRIORITISED);
  const sec = testCaseSection(html);
  const unset = payload.testCases.rows.filter(r => r.priority == null).length;
  assert.strictEqual((sec.match(/data-sort-value="—"/g) || []).length, unset);
  for (const r of payload.testCases.rows.filter(x => x.priority != null)) {
    assert.match(sec, new RegExp(`data-sort-value="${r.priority}"`));
  }
});

check('THE COLUMN IS READ-ONLY — the Coverage grid owns the value', async () => {
  // Two editors for one field is two places for it to drift. This shows it.
  const sec = testCaseSection((await renderHtml(SNAP, PRIORITISED)).html);
  assert.ok(!/<select/.test(sec), 'a dropdown here is a second owner of the same judgement');
  assert.ok(!/data-prio|data-set-priority/.test(sec), 'and no write handler');
});

check('EVERY ROW AND THE FOOTER MATCH THE HEADER, column for column', async () => {
  /* The failure adding this column risks: a `<th>` with no matching `<td>` in
     the body or the FOOTER shifts every number one place left and still
     renders perfectly. The footer is the easy one to forget — it is written
     once, far from the rows. */
  const sec = testCaseSection((await renderHtml(SNAP, PRIORITISED)).html);
  const cols = (sec.match(/<th(?=[\s>])[^>]*>/g) || []).length;
  assert.ok(cols >= 9, `expected the full table, saw ${cols} columns`);

  const body = sec.slice(sec.indexOf('<tbody>'), sec.indexOf('</tbody>'));
  const rows = body.split('<tr>').slice(1);
  assert.ok(rows.length, 'no rows to check');
  for (const r of rows) {
    assert.strictEqual((r.match(/<td[^>]*>/g) || []).length, cols,
      'a row has a different number of cells than the header has columns');
  }
  const foot = sec.slice(sec.indexOf('<tfoot>'), sec.indexOf('</tfoot>'));
  assert.strictEqual((foot.match(/<td[^>]*>/g) || []).length, cols,
    'the footer has drifted from the header — every total is one column out');
});

/* ── THE RISK SECTION ─────────────────────────────────────────────────
   Sprint health, at the top of this page, says what is TRUE — a score and
   the reasons behind it. This section says what to DO, which is the thing a
   lead opened the page for. It is deliberately not the Risks screen shrunk
   down: no low signals, no closed register entries, no editing. */

/* `UI.esc` as the view applies it, so a title containing an apostrophe or an
   ampersand — "R&D_iGO_E2E depends on …" — is looked for in the form the page
   actually wrote, not the form the model holds. */
const UIesc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The risk section's markup, cut out by its heading. */
const riskBlock = (html) => {
  const at = html.indexOf('<h2>Risks</h2>');
  assert.ok(at > 0, 'there is no Risks section on the Active sprint page');
  const start = html.lastIndexOf('<section', at);
  const end = html.indexOf('</section>', at);
  return html.slice(start, end);
};
const riskCards = (block) => [...block.matchAll(/<div class="risk-card ([a-z]+)">([\s\S]*?)<\/div>\s*<\/div>/g)]
  .map(m => ({ severity: m[1], html: m[2] }));

/* A sprint in trouble, because the base fixture is a healthy one and fires no
   detectors at all. Three separate faults, so the section is checked against
   more than one kind of risk: work nobody can move, a commitment nobody
   estimated, and one person carrying a sprint's worth of points on their own. */
const TROUBLED = {
  ...SNAP,
  issues: Object.fromEntries([
    ...Object.entries(SNAP.issues),
    ...[
      { ...issue({ key: 'A-30', assignee: 'Hien Phan', points: 5 }), blockedBy: ['A-99'] },
      issue({ key: 'A-31', assignee: 'Hien Phan', points: null }),
      issue({ key: 'A-32', assignee: 'Hien Phan', points: 21 }),
      issue({ key: 'A-33', assignee: 'Hien Phan', points: 13 }),
    ].map(i => [i.key, i]),
  ]),
};

check('THE RISKS SIT UNDER ALL SPRINT ITEMS, where he asked for them', async () => {
  // Last on the page, after the list of work it is about. Pinned because it
  // has moved once already — it first went above the burndown.
  const { html } = await renderHtml(TROUBLED);
  const items = html.indexOf('All sprint items');
  const risks = html.indexOf('<h2>Risks</h2>');
  assert.ok(items > 0 && risks > 0, 'both sections must be on the page');
  assert.ok(risks > items, 'Risks reads after the item table, not before it');
  assert.strictEqual(html.indexOf('<section', risks), -1,
    'and no section opens after it — Risks is the end of the report');
});

check('THE ACTIVE SPRINT PAGE CARRIES ITS OWN RISKS', async () => {
  const { html, payload } = await renderHtml(TROUBLED);
  const block = riskBlock(html);
  const acting = payload.risks.signals.filter(s => s.severity !== 'low');
  assert.ok(acting.length >= 2, `the fixture has to produce trouble, got ${acting.length}`);
  // Every high and medium signal the model found is on the page, by title.
  for (const s of acting.slice(0, 6)) {
    assert.ok(block.includes(UIesc(s.title)), `"${s.title}" was detected and is not on the page`);
  }
  // And it is the SAME detector the Risks screen runs, not a second opinion
  // written into the view — that is the whole reason `signalsFor` was split out.
  const fromRiskView = insights.riskView(
    { ...PLAN, teams: [TEAM] }, TROUBLED, { teamId: 'titan', sprintId: 'S40', today: MID_SPRINT },
  ).signals.map(s => s.id).sort();
  assert.deepStrictEqual(payload.risks.signals.map(s => s.id).sort(), fromRiskView,
    'the two screens must detect the same risks, or one of them is lying about this sprint');
});

check('and each card says what to DO, not just what is wrong', async () => {
  // A risk you cannot act on is a number. The Risks screen holds itself to
  // this and so does the page that now borrows from it.
  const block = riskBlock((await renderHtml(TROUBLED)).html);
  const cards = riskCards(block);
  assert.ok(cards.length, 'no cards rendered');
  for (const c of cards) assert.match(c.html, /class="action"/, `a card has no action: ${c.html.slice(0, 80)}`);
});

check('and it never runs past its budget, however bad the sprint is', async () => {
  // Past about a screenful the Risks page is the better tool, and it is one
  // click away. The overflow has to be stated rather than silently dropped.
  const many = { ...PLAN, risks: new Array(9).fill(0).map((_, i) => ({
    id: `r${i}`, title: `Register risk ${i}`, severity: 'high', mitigation: 'Do the thing',
  })) };
  const { html } = await renderHtml(TROUBLED, many);
  const block = riskBlock(html);
  assert.ok(riskCards(block).length <= 6, 'the section has a budget');
  assert.match(block, /\d+ more/, 'and says how many it did not draw');
});

check('LOW SIGNALS ARE COUNTED, NOT LISTED', async () => {
  /* "Keep an eye on it" is not a thing to do today, and a column of them under
     a sprint that is on track is how a section teaches you to scroll past it.
     They stay on the Risks page; here they are a number.

     Work-mix drift is the reliable low one: a target this sprint misses, on a
     category that is not maintenance — maintenance running over is the one
     mix result the detector rates higher than low. */
  const drifted = { ...PLAN, mixTargets: { titan: { technical: [40, 60] } } };
  const { html, payload } = await renderHtml(TROUBLED, drifted);
  const block = riskBlock(html);
  const low = payload.risks.signals.filter(s => s.severity === 'low');
  assert.ok(low.length, 'this fixture has to produce a low signal, or the check proves nothing');
  for (const s of low) {
    assert.ok(!block.includes(UIesc(s.title)), `low signal "${s.title}" is taking a card`);
  }
  assert.match(block, new RegExp(`${low.length} low`), 'and the count has to be stated');
});

check('THE COUNTS AGREE WITH THE CARDS UNDER THEM', async () => {
  /* The first version counted only the detected signals, so his own register
     entry — a high one — made the header read "1 high" above two cards
     tagged high. A header that disagrees with what is under it is worse than
     no header. */
  const plan = {
    ...PLAN,
    risks: [
      { id: 'r1', title: 'RCA ownership is unclear', severity: 'high', category: 'Process', owner: 'Nghiep', mitigation: 'Agree an owner' },
      { id: 'r2', title: 'A risk that was dealt with', severity: 'high', status: 'Closed', mitigation: 'Done' },
    ],
  };
  const { html } = await renderHtml(SNAP, plan);
  const block = riskBlock(html);
  const shownHigh = riskCards(block).filter(c => c.severity === 'high').length;
  const stated = Number((block.match(/(\d+) high/) || [])[1]);
  assert.ok(shownHigh > 0 && stated > 0, 'the fixture must produce a high risk');
  assert.ok(stated >= shownHigh,
    `the header says ${stated} high and ${shownHigh} high cards are drawn under it`);
  assert.match(block, /RCA ownership is unclear/, 'a risk he typed himself belongs on his sprint page');
  assert.match(block, /1 from the register/, 'and it is marked as coming from the register');
});

check('a CLOSED register entry is history, and stays on the Risks page', async () => {
  const plan = {
    ...PLAN,
    risks: [{ id: 'r2', title: 'A risk that was dealt with', severity: 'high', status: 'Closed', mitigation: 'Done' }],
  };
  const { html, payload } = await renderHtml(SNAP, plan);
  assert.strictEqual(payload.risks.manual.length, 0, 'a closed entry must not reach the page at all');
  assert.ok(!riskBlock(html).includes('A risk that was dealt with'));
});

check('and the section links to the full register rather than editing it here', async () => {
  // Two places to edit one register is two places for it to disagree.
  const block = riskBlock((await renderHtml()).html);
  assert.match(block, /href="#risks"/, 'no way through to the Risks page');
  assert.ok(!/data-edit=|data-delete=|id="addRisk"/.test(block),
    'the register is edited in one place, and this is not it');
});

check('A SPRINT WITH NOTHING TO ACT ON SAYS THE CHECKS RAN', async () => {
  /* Silence here reads as "this feature is broken" or "nobody looked". It has
     to read as a result. */
  // The base fixture is a healthy two-person sprint and fires no detector at
  // all — which is exactly the case that has to read as a result.
  const { html, payload } = await renderHtml(SNAP, { ...PLAN, risks: [] });
  const block = riskBlock(html);
  assert.ok(!payload.risks.signals.some(s => s.severity !== 'low') && !payload.risks.manual.length,
    'this fixture has to be quiet, or the check proves nothing');
  assert.match(block, /Nothing to act on/);
  assert.ok(!/<div class="risk-card/.test(block), 'and draws no cards');
});

check('the risks print, because a sprint report without them is the good news only', async () => {
  const { html } = await renderHtml();
  const block = riskBlock(html);
  assert.ok(!/class="section[^"]*print-hide/.test(block.slice(0, block.indexOf('>') + 1)),
    'the section itself must not be print-hidden');
  // The link out is screen furniture and does not belong on paper.
  assert.match(block, /class="btn ghost sm print-hide"/, 'the "All risks" link should not print');
});

/* ── THE "!" ON A STORY IN REFINEMENT ─────────────────────────────────── */

/** The "All sprint items" table, cut out by its heading. */
const itemTable = (html) => {
  const at = html.indexOf('All sprint items');
  assert.ok(at > 0, 'the item table did not render');
  const start = html.indexOf('<table', at);
  return html.slice(start, html.indexOf('</table>', start));
};

/** `rowFor` above, but a missing row is this file's bug rather than a silent ''. */
const theRow = (tbl, key) => {
  const row = rowFor(tbl, key);
  assert.ok(row, `no row for ${key} — the fixture and this check have parted company`);
  return row;
};

const refined = () => renderHtml(REFINE_SNAP);

check('A STORY IN REFINEMENT WHOSE EPIC IS BLOCKED GETS THE ICON', async () => {
  const { html } = await refined();
  const tbl = itemTable(html);
  assert.match(theRow(tbl, 'R-1'), /data-act="epic-blockers"[^>]*data-key="R-1"/,
    'the row that has something to chase has no way to see it');
  assert.match(theRow(tbl, 'R-2'), /data-act="epic-blockers"/);
});

check('and one whose epic names nothing does NOT', async () => {
  // An icon on every row is an icon nobody reads after the second time.
  const { html } = await refined();
  assert.ok(!/data-act="epic-blockers"/.test(theRow(itemTable(html), 'R-3')),
    'the icon appeared on a row with nothing behind it');
});

check('NOR DOES A ROW IN ANY OTHER STATUS, however blocked its epic', async () => {
  /* N-1 sits under the same blocked epic as R-1. It is deliberately unmarked:
     the icon answers "what is this waiting on", and that is the question
     Refinement is asking. */
  const { html } = await refined();
  const row = theRow(itemTable(html), 'N-1');
  assert.match(row, /In Dev/, 'fixture check: N-1 has to be in another status');
  assert.ok(!/data-act="epic-blockers"/.test(row), 'the icon is not scoped to Refinement');
});

check('THE BLOCKERS COME FROM THE EPIC, NOT FROM THE STORY', async () => {
  /* R-4 is in Refinement, carries its OWN blocker, and sits under an epic with
     none. Reading the item's `blockedBy` — the obvious implementation, and the
     one every other screen uses — marks this row and misses the ten that
     matter. On his data not one Story in Refinement names a blocker itself. */
  const { payload } = await refined();
  const r4 = payload.items.find(i => i.key === 'R-4');
  assert.deepStrictEqual(r4.blockedBy, ['OWN-1'], 'fixture check: R-4 names its own blocker');
  assert.deepStrictEqual(r4.epicBlockers, [], 'its epic names nothing, so there is nothing to show');

  const { html } = await refined();
  assert.ok(!/data-act="epic-blockers"/.test(theRow(itemTable(html), 'R-4')),
    'the icon read the item\'s own blockers instead of its epic\'s');
});

check('the payload carries which epic each blocker came from, and how it relates', async () => {
  const { payload } = await refined();
  const r1 = payload.items.find(i => i.key === 'R-1');
  /* The blockers are LINKS, not bare keys: the summary Jira sent inside the
     link is the only description these will ever have, since they live in
     projects this tool does not sync. */
  assert.deepStrictEqual(r1.epicBlockers, [
    { epic: 'E-BLOCKED', name: 'Epic E-BLOCKED', via: 'parent',
      blockers: [{ key: 'CLICMNTIGO-11567', summary: null, type: null }] },
  ], 'without the epic and the via, the drawer cannot say whose blockers these are');
});

check('THE DRAWER LISTS THE EPIC\'S BLOCKERS, and names the epic they belong to', async () => {
  const { payload, ctx } = await refined();
  const item = payload.items.find(i => i.key === 'R-2');
  const html = ctx.UI.epicBlockersDrawer(item, payload.items, {}, {});
  // E-ALSO names two, one of which R-1's epic names as well.
  assert.match(html, /CLICMNTIGO-11567/);
  assert.match(html, /OTHER-1/);
  assert.match(html, /E-ALSO/, 'the drawer does not say whose blockers these are');
  assert.match(html, /parent epic/, 'nor how that epic relates to the story');
  assert.match(html, /R-2/, 'nor which story was clicked');
});

check('and a blocker in a project this tool does not sync is still listed', async () => {
  /* Every one of the ten in his sprint is CLICMNTIGO-11567, which lives in a
     project this tool never syncs. Dropping what it cannot resolve would empty
     the drawer on exactly the rows it was built for. */
  const { payload, ctx } = await refined();
  const item = payload.items.find(i => i.key === 'R-1');
  const html = ctx.UI.epicBlockersDrawer(item, payload.items, {}, {});
  assert.match(html, /CLICMNTIGO-11567/, 'the unresolvable blocker was dropped');
  assert.match(html, /Not in the local store/, 'and it has to say why it shows no detail');
  assert.match(html, />Open in Jira</, 'which makes the way out to Jira the point of the panel');
});

check('REFINEMENT IS MATCHED EXACTLY, not by substring', async () => {
  /* His Jira has one status containing the word today. Workflows grow, and a
     substring match would silently start marking "Ready for Refinement" or
     "Refinement Done" — rows the icon says nothing true about. Cheap to pin
     now, invisible to find later. */
  const { ctx } = await refined();
  const blocked = [{ epic: 'E-1', via: 'parent', blockers: ['B-1'] }];
  assert.ok(ctx.UI.epicBlockerIcon({ key: 'X', status: 'Refinement', epicBlockers: blocked }),
    'the exact status has to still mark');
  for (const status of ['Ready for Refinement', 'Refinement Done', 'Pre-Refinement', 'refinements']) {
    assert.strictEqual(ctx.UI.epicBlockerIcon({ key: 'X', status, epicBlockers: blocked }), '',
      `"${status}" was marked as Refinement`);
  }
  // Whitespace and casing from Jira are not a different status, though.
  assert.ok(ctx.UI.epicBlockerIcon({ key: 'X', status: '  refinement ', epicBlockers: blocked }),
    'a cased or padded value is the same status');
});

/** The "Where the work sits" card, cut out by its heading. */
const workSits = (html) => {
  const at = html.indexOf('Where the work sits');
  assert.ok(at > 0, 'the chart card did not render');
  return html.slice(at, html.indexOf('</section>', at));
};

check('THE CHART CARD SAYS WHAT REFINEMENT IS WAITING ON', async () => {
  /* The bar says how many points are in Refinement and cannot say why. In his
     TT Week 14Sep ten of sixteen are held, all by one ticket — one
     conversation, not ten, and nothing on the board said so. */
  const { html } = await refined();
  const card = workSits(html);
  assert.match(card, /data-act="refinement-blockers"/, 'the card offers no way in');
  assert.match(card, /of 4 in Refinement/, `the line does not say how many of how many: ${card.slice(-300)}`);
  assert.match(card, /waiting on/);
});

check('and the control is a real button, not a shape inside the SVG', async () => {
  /* An SVG has no button. A clickable <g> answers a mouse and is invisible to
     a keyboard, which this app treats as half a control. */
  const { html } = await refined();
  const card = workSits(html);
  const at = card.indexOf('data-act="refinement-blockers"');
  const tagStart = card.lastIndexOf('<', at);
  assert.strictEqual(card.slice(tagStart, tagStart + 7), '<button',
    'the control is not a <button>, so it cannot be reached by keyboard');
  assert.ok(at > card.indexOf('</svg>'), 'the control is inside the chart rather than under it');
});

check('and it is absent when nothing in Refinement is blocked', async () => {
  // SNAP has no Refinement items at all, so the line must not appear.
  const { html } = await renderHtml();
  assert.ok(!/data-act="refinement-blockers"/.test(workSits(html)),
    'the card advertised blockers on a sprint with none');
});

check('THE DRAWER GROUPS BY BLOCKER — one ticket, all the items it holds', async () => {
  /* Ten rows each naming the same ticket is ten rows of one fact. Turned
     around it is one row with the thing to chase at the top of it. */
  const { payload, ctx, mount } = await refined();
  let drawn = '';
  ctx.UI.drawer = (h) => { drawn = h; };
  const held = (payload.items || []).filter(i => ctx.UI.inRefinement(i) && (i.epicBlockers || []).length);
  assert.strictEqual(held.length, 2, 'fixture check: R-1 and R-2 are the blocked ones');

  mount.click('refinement-blockers');
  assert.match(drawn, /Blocking Refinement/);
  // CLICMNTIGO-11567 holds BOTH, through two different epics — so it appears
  // once, with two items under it, not twice.
  const heads = (drawn.match(/CLICMNTIGO-11567/g) || []).length;
  assert.ok(heads >= 1, 'the shared blocker is missing');
  assert.match(drawn, /blocks 2 items/, 'the shared blocker was not grouped');
  assert.match(drawn, /R-1/); assert.match(drawn, /R-2/);
  assert.match(drawn, /via/, 'the drawer does not say which epic carried the block');
});

/* Insertion order deliberately AGAINST size order: the first Refinement item
   seen names a blocker holding only itself, the next two share a bigger one.
   Without a sort the drawer lists the one-item blocker first, which is the
   opposite of "the one ticket worth chasing today". */
const ORDER_SNAP = {
  ...SNAP,
  issues: Object.fromEntries([
    ...Object.values(SNAP.issues),
    EPIC('E-ONLY', ['SOLO-1']),
    EPIC('E-S1', ['BIG-1']),
    EPIC('E-S2', ['BIG-1']),
    issue({ key: 'O-1', assignee: 'Hien Phan', points: 1, status: 'Refinement', parentKey: 'E-ONLY' }),
    issue({ key: 'O-2', assignee: 'Hien Phan', points: 1, status: 'Refinement', parentKey: 'E-S1' }),
    issue({ key: 'O-3', assignee: 'Hien Phan', points: 1, status: 'Refinement', parentKey: 'E-S2' }),
  ].map(i => [i.key, i])),
};

check('THE BIGGEST BLOCKER COMES FIRST — the one ticket worth chasing today', async () => {
  const { ctx, mount } = await renderHtml(ORDER_SNAP);
  let drawn = '';
  ctx.UI.drawer = (h) => { drawn = h; };
  mount.click('refinement-blockers');
  /* Measured on the GROUP HEADINGS, not on where each key first appears in the
     markup: the "Open in Jira" link at the top of the drawer lists every key,
     sorted, so an indexOf for a key finds it in that URL long before its
     heading and passes whatever order the groups are actually in. That version
     of this check was green against a drawer with no sort at all. */
  const sizes = [...drawn.matchAll(/blocks (\d+) item/g)].map(m => Number(m[1]));
  assert.deepStrictEqual(sizes, [2, 1],
    `groups are not biggest-first: ${sizes.join(', ')}`);
  assert.ok(drawn.indexOf('blocks 2 items') < drawn.indexOf('blocks 1 item'),
    'the blocker holding one item was listed above the blocker holding two');
});

check('A BLOCKER SHOWS WHAT JIRA SAID ABOUT IT, not "not in the local store"', async () => {
  /* The bug he reported. Jira sends the blocker's summary and type inside the
     link; `blockedBy` used to map to a bare key and throw both away, so the
     panel showed a naked key under "Not in the local store" — on a blocker
     that no sync will ever resolve, because it lives in a project this tool
     does not pull. 283 of his 356 unresolvable link targets already carry a
     summary on the link row. */
  const { payload, ctx } = await refined();
  const item = {
    key: 'X-1', status: 'Refinement',
    epicBlockers: [{ epic: 'E-A', via: 'parent',
      blockers: [{ key: 'CLICMNTIGO-11567', summary: 'iGO client migration sign-off', type: 'Story' }] }],
  };
  const html = ctx.UI.epicBlockersDrawer(item, payload.items, {}, {});
  assert.match(html, /iGO client migration sign-off/, 'the summary the link carried was dropped');
  assert.ok(!/Not in the local store/.test(html),
    'it claimed to know nothing about an issue it had the summary for');
});

check('and a blocker with nothing known still says so', async () => {
  // The honest remainder: a link that carried no summary has nothing to show,
  // and saying so beats an empty row.
  const { payload, ctx } = await refined();
  const item = {
    key: 'X-1', status: 'Refinement',
    epicBlockers: [{ epic: 'E-A', via: 'parent', blockers: [{ key: 'GHOST-1', summary: null, type: null }] }],
  };
  const html = ctx.UI.epicBlockersDrawer(item, payload.items, {}, {});
  assert.match(html, /GHOST-1/);
  assert.match(html, /Not in the local store/);
});

check('DUPLICATE BLOCKERS ACROSS EPICS COLLAPSE, so the count is a set', async () => {
  // A story under two epics that name the same blocker is blocked by one
  // thing, not two.
  const { payload, ctx } = await refined();
  const item = {
    key: 'X-1', status: 'Refinement',
    epicBlockers: [
      { epic: 'E-A', via: 'parent', blockers: ['B-1', 'B-2'] },
      { epic: 'E-B', via: 'relates', blockers: ['B-2', 'B-3'] },
    ],
  };
  const icon = ctx.UI.epicBlockerIcon(item);
  assert.match(icon, /blocked by 3 issues/, `counted the links, not the set: ${icon}`);
  const html = ctx.UI.epicBlockersDrawer(item, payload.items, {}, {});
  assert.match(html, /3 items/, 'the drawer heading disagrees with the icon');
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
