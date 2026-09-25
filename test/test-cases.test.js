'use strict';
/**
 * test-cases.test.js — how many test cases did this sprint automate, and keep alive?
 *
 * TWO COUNTS FROM OPPOSITE ENDS OF THE DATA, and neither of them is the sprint
 * item, which is the whole reason this table cannot be derived from the
 * per-component one above it on the same screen:
 *
 *   AUTOMATED   a Story is the WORK of automating a test case; the test case is
 *               its PARENT EPIC, and whether it is automated is the epic's own
 *               Automation Status. His correction, and the one this suite is
 *               built around — AUTOKAT-9715 in the live sprint is a Story with
 *               no Automation Status at all, sitting under an epic that is
 *               Automated. Reading the Story would have reported that test case
 *               as not done.
 *
 *   MAINTAINED  a Bucket Story is a fortnight's container for maintenance and
 *               each "relates to" link on it is one suite being kept working.
 *
 * THE FAILURE MODE THIS GUARDS is a plausible number. Every mistake available
 * here — counting the Story's status, counting Bucket Story parents, counting
 * items instead of distinct epics, adding the component rows up — produces a
 * table that renders perfectly and is wrong by a factor nobody can see.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const insights = require('../lib/insights');
const cov = require('../lib/coverage');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nTest cases by component\n');

/* ── a sprint shaped like his ─────────────────────────────────────────── */

const story = (key, parentKey, components, o = {}) => ({
  key, summary: key, issueType: 'Story', status: o.status || 'Open',
  statusCategory: o.status === 'Done' ? 'done' : 'new',
  assignee: 'Hien Phan', points: 3, components, labels: [], relatesTo: [], blockedBy: [],
  parentKey, ...o,
});
const bucket = (key, components, relates, o = {}) => ({
  key, summary: key, issueType: 'Bucket Story', status: o.status || 'Open',
  statusCategory: o.status === 'Done' ? 'done' : 'new',
  assignee: 'Hien Phan', points: 3, components, labels: [], blockedBy: [],
  // Every bucket story in his sprint hangs off the SAME maintenance container.
  parentKey: 'E-BUCKET',
  relatesTo: relates.map(k => ({ key: k, type: 'Epic' })), ...o,
});
const epic = (key, automationStatus, components = []) => ({
  key, summary: key, issueType: 'Epic', automationStatus, components, labels: [],
});

/** key -> stored issue, the lookup activeSprintView hands the summary. */
const store = (list) => {
  const byKey = Object.fromEntries(list.map(i => [i.key, i]));
  return (k) => byKey[k] || null;
};

const EPICS = [
  epic('E-1', 'Automated', ['PS_A']),
  epic('E-2', 'Automated', ['PS_A']),
  epic('E-3', 'Ready for Automation', ['PS_A']),
  epic('E-4', 'Done', ['PS_B']),            // Jira's alias for Automated
  epic('E-BUCKET', null, ['KAT_Common_Maintenance']),
  /* The TEST CASES the bucket stories link to. These are epics too, and it is
     THEIR Automation Status that splits Maintained from Maintaining — so the
     store has to resolve them, exactly as the live one does. T-100 is
     deliberately absent everywhere: a link this tool has no local copy of is a
     real case, and it must not be guessed into either column. */
  epic('T-1', 'Automated', ['PS_A']),
  epic('T-2', 'Automated', ['PS_A']),
  epic('T-3', 'Automated', ['PS_A']),
  epic('T-101', 'Automated', ['PS_A']),
  epic('T-102', 'Automated', ['PS_B']),
];

/* ── the correction this table was rebuilt around ─────────────────────── */

check('AUTOMATED IS READ OFF THE EPIC, NOT OFF THE STORY', () => {
  // The live sprint has a Story with no Automation Status under an epic that is
  // Automated. Reading the Story reports that test case as not automated, which
  // is the number this whole table exists to give him.
  const items = [
    story('A-1', 'E-1', ['PS_A']),                                    // epic automated, story silent
    story('A-2', 'E-3', ['PS_A'], { automationStatus: 'Automated' }), // story says automated, EPIC does not
  ];
  const t = insights.testCaseSummary(items, store(EPICS));
  const row = t.rows.find(r => r.component === 'PS_A');

  assert.strictEqual(row.automated, 1, 'exactly the one whose EPIC is automated');
  assert.strictEqual(row.inFlight, 1, 'and the other is still in flight, whatever the Story claims');
  assert.strictEqual(t.totals.automated, 1);
});

check('and "Done" counts as automated, because the Coverage report says so', () => {
  // A hand-written equality against the string "Automated" would miss Jira's
  // own alias, and this screen would then disagree with the Coverage report
  // about the same epic.
  const t = insights.testCaseSummary([story('A-1', 'E-4', ['PS_B'])], store(EPICS));
  assert.strictEqual(t.totals.automated, 1);
  assert.strictEqual(cov.bucketOf({ automationStatus: 'Done' }), 'automated', 'precondition: the shared classifier');
});

check('BUCKET STORIES ARE NOT COUNTED AS AUTOMATION, however many parents they have', () => {
  // All six bucket stories in his active sprint hang off AUTOKAT-7789. Counting
  // parents indiscriminately reports that one maintenance container as six
  // automated test cases — a number six times too big, on the row a team lead
  // would quote first.
  const items = [
    bucket('B-1', ['PS_A'], ['T-1']),
    bucket('B-2', ['PS_A'], ['T-2']),
    bucket('B-3', ['PS_A'], ['T-3']),
  ];
  const t = insights.testCaseSummary(items, store([...EPICS, epic('E-BUCKET', 'Automated')]));
  assert.strictEqual(t.totals.automated, 0,
    'even with the container epic marked Automated, a bucket story automates nothing');
  assert.strictEqual(t.totals.maintained, 3, 'it maintains, which is the other column');
});

/* ── MAINTAINED vs MAINTAINING ────────────────────────────────────────────
   The maintenance half of the table is one population — the "relates to" links
   on Bucket Stories — split by the state of the thing linked. "We touched 40
   suites" does not say how many are working again, and that is the question the
   split exists to answer.

   THE STATUS READ IS THE LINKED EPIC'S, never the bucket story's and never its
   container's. Every bucket story in his sprint hangs off the same maintenance
   container, so reading anything other than the link target reports one answer
   for the whole fortnight. */

const MAINT_EPICS = [
  epic('T-A', 'Automated'),          // fixed, back to green
  epic('T-B', 'Maintenance'),        // still being worked
  epic('T-C', 'Maintenance'),
  epic('T-D', 'Done'),               // Jira's alias for Automated
  epic('T-E', 'Ready for Automation'),
  epic('T-F', 'Blocked'),
  epic('T-G', null),                 // resolvable, but nobody set the field
  epic('E-BUCKET', 'Maintenance', ['KAT_Common_Maintenance']),
];

check('THE LINKS SPLIT BY THE LINKED EPIC\'S OWN AUTOMATION STATUS', () => {
  const items = [bucket('B-1', ['PS_A'], ['T-A', 'T-B', 'T-C'])];
  const t = insights.testCaseSummary(items, store(MAINT_EPICS));
  const row = t.rows[0];
  assert.strictEqual(row.maintained, 1, 'only T-A is Automated');
  assert.strictEqual(row.maintaining, 2, 'T-B and T-C are still under maintenance');
  assert.strictEqual(t.totals.maintained, 1);
  assert.strictEqual(t.totals.maintaining, 2);
});

check('and NOT by the bucket story\'s own container, which is the same for all of them', () => {
  /* E-BUCKET reads Maintenance. If the container were what got read, every link
     in the sprint would land in Maintaining and the split would be a constant. */
  const items = [bucket('B-1', ['PS_A'], ['T-A', 'T-D'])];
  const t = insights.testCaseSummary(items, store(MAINT_EPICS));
  assert.strictEqual(t.totals.maintaining, 0, 'the container\'s status is not the links\' status');
  assert.strictEqual(t.totals.maintained, 2, 'both targets are Automated — T-D via Jira\'s "Done" alias');
});

check('THE REMAINDER IS COUNTED, NOT FOLDED INTO EITHER SIDE', () => {
  /* Ready for Automation, Blocked, and an epic nobody set the field on. None of
     them is "fixed" and none is "being fixed", and guessing either way reports
     work that did not happen. 118 links across his store were like this when
     the split was built. */
  const items = [bucket('B-1', ['PS_A'], ['T-A', 'T-B', 'T-E', 'T-F', 'T-G'])];
  const t = insights.testCaseSummary(items, store(MAINT_EPICS));
  assert.strictEqual(t.totals.maintained, 1, 'T-A');
  assert.strictEqual(t.totals.maintaining, 1, 'T-B');
  assert.strictEqual(t.totals.unclassified, 3, 'T-E, T-F and T-G are in neither');
  assert.deepStrictEqual([...t.totals.keys.unclassified].sort(), ['T-E', 'T-F', 'T-G']);
});

check('a link the tool cannot resolve is unclassified, not assumed', () => {
  // No local copy means no status to read. Assuming either column would be
  // inventing a fact about a suite this tool has never seen.
  const items = [bucket('B-1', ['PS_A'], ['T-A', 'GHOST-1'])];
  const t = insights.testCaseSummary(items, store(MAINT_EPICS));
  assert.strictEqual(t.totals.maintained, 1);
  assert.strictEqual(t.totals.maintaining, 0);
  assert.deepStrictEqual([...t.totals.keys.unclassified], ['GHOST-1']);
});

check('THE THREE ADD UP TO THE LINKS, so nothing is lost between them', () => {
  /* The property that makes the remainder trustworthy: every distinct link is
     in exactly one of the three. Drop a branch and this goes red, which is the
     point — a link silently in no column is the failure this table exists to
     avoid. */
  const items = [
    bucket('B-1', ['PS_A'], ['T-A', 'T-B', 'T-E']),
    bucket('B-2', ['PS_A'], ['T-B', 'T-F', 'GHOST-9']),   // T-B shared
  ];
  const t = insights.testCaseSummary(items, store(MAINT_EPICS));
  const distinct = new Set(['T-A', 'T-B', 'T-E', 'T-F', 'GHOST-9']).size;
  const T = t.totals;
  assert.strictEqual(T.maintained + T.maintaining + T.unclassified, distinct,
    `${distinct} distinct links, ${T.maintained}+${T.maintaining}+${T.unclassified} counted`);
  const row = t.rows[0];
  assert.strictEqual(row.maintained + row.maintaining + row.unclassified, distinct,
    'and the same holds on the row');
});

check('a Story is untouched by the split — it is the other half of the table', () => {
  /* The split moved the maintenance half only. Automated and In flight still
     count parent epics of Stories, and a change to one half that quietly
     rewrote the other is exactly what this pins. */
  const items = [
    story('A-1', 'E-1', ['PS_A']),      // epic Automated
    story('A-2', 'E-3', ['PS_A']),      // epic Ready for Automation
  ];
  const t = insights.testCaseSummary(items, store(EPICS));
  assert.strictEqual(t.totals.automated, 1);
  assert.strictEqual(t.totals.inFlight, 1, 'still in flight, not moved to the remainder');
  assert.strictEqual(t.totals.maintained, 0, 'a Story contributes to neither maintenance column');
  assert.strictEqual(t.totals.maintaining, 0);
  assert.strictEqual(t.totals.unclassified, 0);
});

/* ── a test case is an epic, so the count is of epics ─────────────────── */

check('TWO STORIES UNDER ONE EPIC ARE ONE TEST CASE', () => {
  const items = [story('A-1', 'E-1', ['PS_A']), story('A-2', 'E-1', ['PS_A'])];
  const t = insights.testCaseSummary(items, store(EPICS));
  assert.strictEqual(t.rows[0].automated, 1, 'the epic is the test case, and there is one of it');
  assert.strictEqual(t.rows[0].stories, 2, 'while both Stories are still reported as work');
});

check('and two bucket stories maintaining the same suite are one test case', () => {
  const items = [bucket('B-1', ['PS_A'], ['T-1', 'T-2']), bucket('B-2', ['PS_A'], ['T-2', 'T-3'])];
  const t = insights.testCaseSummary(items, store(EPICS));
  assert.strictEqual(t.rows[0].maintained, 3, 'T-1, T-2, T-3 — not four');
});

check('an epic key is matched however Jira cased it', () => {
  const items = [story('A-1', 'e-1', ['PS_A']), story('A-2', 'E-1', ['PS_A'])];
  const t = insights.testCaseSummary(items, store([...EPICS, epic('e-1', 'Automated')]));
  assert.strictEqual(t.rows[0].automated, 1, 'one epic, written two ways, is one test case');
});

/* ── the totals trap ──────────────────────────────────────────────────── */

check('THE TOTAL IS THE DISTINCT COUNT, NOT THE COLUMN ADDED UP', () => {
  // One Story in two components is in two rows, so the rows legitimately name
  // the same test case twice. A total that sums them reports work that does not
  // exist, and it is the one number on the table nobody would re-derive.
  const items = [story('A-1', 'E-1', ['PS_A', 'PS_B']), story('A-2', 'E-2', ['PS_A'])];
  const t = insights.testCaseSummary(items, store(EPICS));

  const rowSum = t.rows.reduce((s, r) => s + r.automated, 0);
  assert.strictEqual(rowSum, 3, 'precondition: the rows double-count the shared one');
  assert.strictEqual(t.totals.automated, 2, 'while the sprint automated two test cases');
  assert.strictEqual(t.shared, 1, 'and the caption is told how many items caused it');
});

check('and the same holds for maintained', () => {
  const items = [bucket('B-1', ['PS_A', 'PS_B'], ['T-1'])];
  const t = insights.testCaseSummary(items, store(EPICS));
  assert.strictEqual(t.rows.reduce((s, r) => s + r.maintained, 0), 2);
  assert.strictEqual(t.totals.maintained, 1);
});

/* ── grouped by the item, like the rest of the screen ─────────────────── */

check('A ROW IS THE ITEM\'S COMPONENT, NOT THE EPIC\'S', () => {
  // AUTOKAT-9720 sits in PS_iGO_NYL_Annuities under an epic tagged
  // PS_iGO_NYL_IDI. Grouping by the epic would put this table's rows in
  // different components from the per-component progress table directly above
  // it on the same screen, with no way to tell which was right.
  const items = [story('A-1', 'E-4', ['PS_A'])];   // epic E-4 is tagged PS_B
  const t = insights.testCaseSummary(items, store(EPICS));
  assert.deepStrictEqual(t.rows.map(r => r.component), ['PS_A'],
    'the work is in PS_A, whatever its epic is filed under');
});

check('and the tool markers are stripped, as everywhere else', () => {
  const items = [story('A-1', 'E-1', ['PS_A', 'TrueTest'])];
  const t = insights.testCaseSummary(items, store(EPICS));
  assert.deepStrictEqual(t.rows.map(r => r.component), ['PS_A'],
    'TrueTest is how the tool is recorded, not a product area');
});

/* ── the gaps are counted, not dropped ────────────────────────────────── */

check('A STORY WITH NO PARENT IS REPORTED, not quietly missing from both columns', () => {
  // There is one in his live sprint. It belongs in neither column and the count
  // is therefore short by one — which is fine as long as it says so, and a
  // silent short number is exactly what this table must never produce.
  const items = [story('A-1', 'E-1', ['PS_A']), story('A-2', null, ['PS_A'])];
  const t = insights.testCaseSummary(items, store(EPICS));
  assert.strictEqual(t.unlinked, 1);
  assert.strictEqual(t.rows[0].unlinked, 1, 'and on the row it happened in');
  assert.strictEqual(t.rows[0].automated + t.rows[0].inFlight, 1, 'it is in neither column');
});

check('and a parent this tool has never seen counts as in flight, not automated', () => {
  // The safe direction. An epic missing from the store is an epic we know
  // nothing about, and "we do not know" must never round up to "done".
  const t = insights.testCaseSummary([story('A-1', 'E-NOWHERE', ['PS_A'])], store(EPICS));
  assert.strictEqual(t.totals.automated, 0);
  assert.strictEqual(t.totals.inFlight, 1);
});

check('everything is counted, with done alongside it rather than instead of it', () => {
  const items = [
    story('A-1', 'E-1', ['PS_A'], { status: 'Done' }),
    story('A-2', 'E-2', ['PS_A']),
    bucket('B-1', ['PS_A'], ['T-1'], { status: 'Done' }),
  ];
  const t = insights.testCaseSummary(items, store(EPICS));
  assert.strictEqual(t.totals.items, 3);
  assert.strictEqual(t.totals.done, 2);
  assert.strictEqual(t.totals.stories, 2);
  assert.strictEqual(t.totals.buckets, 1);
});

/* ── on the screen ────────────────────────────────────────────────────── */

const VIEW = fs.readFileSync(path.join(__dirname, '..', 'public', 'views', 'sprint.js'), 'utf8');

/** Render the Active sprint view against a payload and hand back the HTML. */
async function renderSprint(payload) {
  return (await renderSprintClickable(payload)).html;
}

/**
 * The same render, with a mount that can actually be clicked and a record of
 * what the drawer was given.
 *
 * The drill-in is the one feature here that cannot be checked from the HTML:
 * the markup proves a button exists, not that clicking it finds the right set.
 * So the container records the delegated listener the view binds — the same
 * pattern ui-wiring.test.js uses — and `click(attrs)` fires a synthetic event
 * whose `closest` answers for the attributes of the number being clicked.
 */
async function renderSprintClickable(payload) {
  let html = '';
  const el = () => ({
    addEventListener() {}, value: '', hidden: false, dataset: {}, style: {}, setAttribute() {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, select() {},
    querySelector: () => el(), querySelectorAll: () => [],
  });
  const ctx = {
    console, Promise, setTimeout, encodeURIComponent, CSS: { escape: String },
    App: { refresh() {} },
    Charts: new Proxy({}, { get: () => () => '' }),
    document: { title: 'x', createElement: () => ({ set innerHTML(_) {}, content: { firstElementChild: null } }) },
    window: { print() {}, addEventListener() {}, removeEventListener() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);
  ctx.UI.api = async () => payload;
  vm.runInContext(`${VIEW}\n;globalThis.__v = SprintView;`, ctx);
  let drawn = null;
  ctx.UI.drawer = (h) => { drawn = h; };

  const listeners = [];
  const mount = {
    style: {},
    addEventListener(type, fn) { if (type === 'click') listeners.push(fn); },
    querySelector: () => el(), querySelectorAll: () => [],
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
  };
  await ctx.__v.render({ teamId: 'titan', sprintId: 'S40', categories: {}, teams: [{ id: 'titan', name: 'T' }] }, mount);

  const click = (dataset) => {
    drawn = null;
    const node = { dataset };
    const target = { closest: (sel) => (sel === `[data-act="${dataset.act}"]` ? node : null) };
    for (const fn of listeners) fn({ target, preventDefault() {} });
    return drawn;
  };
  return { html, click, ctx };
}

/** The real payload, built the way the route builds it. */
function payloadFor(items, epics = EPICS) {
  const all = [...items, ...epics];
  const snap = {
    source: 'jira', syncedAt: '2026-09-24T00:00:00.000Z',
    issues: Object.fromEntries(all.map(i => [i.key, i])),
    byTeam: { titan: { sprintIssues: { 900: items.map(i => i.key) } } },
    testops: { projects: [] }, github: {}, verification: [],
  };
  const TEAM = {
    id: 'titan', name: 'Katalon Titan', sprintKeywords: ['titan'],
    settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 },
    members: [{ id: 'm2', name: 'Hien Phan', role: 'Auto QA', status: 'Active', supportPct: 0 }],
  };
  const SPRINT = {
    id: 'S40', number: 40, name: 'Sprint 40', start: '2026-09-17', end: '2026-09-30',
    byTeam: { titan: { jiraId: '900', name: 'Katalon Titan Sprint 40', state: 'active' } },
  };
  const PLAN = {
    version: 1, teams: [TEAM], sprints: [SPRINT], holidays: [], availability: {},
    support: {}, ceremony: {}, overrides: {}, risks: [], notes: {}, excluded: {},
    categoryRules: null, mixTargets: null, sprintRoster: {},
  };
  return insights.activeSprintView(PLAN, snap, TEAM, SPRINT, { today: '2026-09-24' });
}

check('THE SECTION IS ON THE ACTIVE SPRINT, between the component table and the items', async () => {
  const items = [
    story('A-1', 'E-1', ['PS_A']), story('A-2', 'E-3', ['PS_A']),
    bucket('B-1', ['PS_B'], ['T-1', 'T-2']),
  ];
  const html = await renderSprint(payloadFor(items));
  const at = html.indexOf('Test cases by component');
  assert.ok(at > 0, 'the section has to render at all');
  assert.ok(at > html.indexOf('Per-component progress'), 'after the progress table it sits beside');
  assert.ok(at < html.indexOf('All sprint items'), 'and before the item list it summarises');
});

check('and both numbers reach the screen, with the sprint total beside them', async () => {
  const items = [
    story('A-1', 'E-1', ['PS_A']), story('A-2', 'E-2', ['PS_A']), story('A-3', 'E-3', ['PS_A']),
    bucket('B-1', ['PS_B'], ['T-1', 'T-2']),
  ];
  const payload = payloadFor(items);
  assert.strictEqual(payload.testCases.totals.automated, 2, 'precondition');
  assert.strictEqual(payload.testCases.totals.maintained, 2);

  const html = await renderSprint(payload);
  const section = html.slice(html.indexOf('Test cases by component'), html.indexOf('All sprint items'));
  assert.match(section, /<strong>2<\/strong>\s*automated/, 'the headline count');
  assert.match(section, /<strong>2<\/strong>\s*maintained/);
  assert.match(section, /Sprint total/, 'and a total row, since the columns do not sum');
  assert.ok((section.match(/<tr>/g) || []).length >= 2, 'one row per component');
});

/* ── the maintenance split, on the screen ─────────────────────────────── */

/** The test-case table, cut out by its own heading. */
const tcTable = (html) => {
  const at = html.indexOf('Test cases by component');
  assert.ok(at > 0, 'the section did not render');
  const start = html.indexOf('<table', at);
  return html.slice(start, html.indexOf('</table>', start));
};

check('MAINTAINING IS A COLUMN OF ITS OWN, next to Maintained', async () => {
  const items = [bucket('B-1', ['PS_A'], ['T-A', 'T-B', 'T-C'])];
  const payload = payloadFor(items, MAINT_EPICS);
  assert.strictEqual(payload.testCases.totals.maintaining, 2, 'precondition');

  const tbl = tcTable(await renderSprint(payload));
  const head = tbl.slice(0, tbl.indexOf('</thead>'));
  /* Matched on the header's TEXT, not on the string anywhere in the cell: the
     Maintained column's own tooltip contains the words "Bucket Stories", so a
     bare indexOf('Stories') finds the tooltip and the order check passes no
     matter where the column actually sits. */
  const order = [...head.matchAll(/>([^<>]+)<\/th>/g)].map(m => m[1].trim());
  const at = (label) => order.indexOf(label);
  assert.ok(at('Maintained') > 0, `Maintained is not a column header: ${order.join(' | ')}`);
  assert.strictEqual(at('Maintaining'), at('Maintained') + 1,
    `Maintaining is not straight after Maintained: ${order.join(' | ')}`);
  assert.ok(at('Maintaining') < at('Stories'),
    'both stay on the test-case side of the table');
});

check('THE TABLE STILL LINES UP — header, row and footer all gained one cell', async () => {
  /* Adding a column is where a table quietly goes one cell out: the header
     grows, a row or the footer does not, and every number after it shifts one
     place left while rendering perfectly. */
  const items = [
    story('A-1', 'E-1', ['PS_A']),
    bucket('B-1', ['PS_A'], ['T-A', 'T-B']),
  ];
  const tbl = tcTable(await renderSprint(payloadFor(items, [...EPICS, ...MAINT_EPICS])));
  const cells = (frag, tag) => (frag.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const head = tbl.slice(0, tbl.indexOf('</thead>'));
  const foot = tbl.slice(tbl.indexOf('<tfoot'));
  const body = tbl.slice(tbl.indexOf('<tbody'), tbl.indexOf('</tbody>'));
  const firstRow = body.slice(body.indexOf('<tr'), body.indexOf('</tr>'));

  const n = cells(head, 'th');
  assert.ok(n >= 10, `expected the widened header, got ${n} columns`);
  assert.strictEqual(cells(firstRow, 'td'), n, 'a body row is a different width from the header');
  assert.strictEqual(cells(foot, 'td'), n, 'the footer is a different width from the header');
});

check('and the numbers on the screen are the numbers the model counted', async () => {
  // The whole table renders from one payload; a cell that recomputed anything
  // could disagree with the column beside it.
  const items = [bucket('B-1', ['PS_A'], ['T-A', 'T-D', 'T-B', 'T-E'])];
  const payload = payloadFor(items, MAINT_EPICS);
  const T = payload.testCases.totals;
  assert.deepStrictEqual([T.maintained, T.maintaining, T.unclassified], [2, 1, 1], 'precondition');

  const html = await renderSprint(payload);
  // From the heading to ITS table — searching from 0 finds an earlier table on
  // the page and slices a window that never contained the headline at all.
  const at = html.indexOf('Test cases by component');
  const head = html.slice(at, html.indexOf('<table', at));
  assert.match(head, /<strong>2<\/strong>\s*maintained/, 'the headline maintained count');
  assert.match(head, /1\s*maintaining/, 'and the maintaining one beside it');
});

check('THE REMAINDER IS STATED ON THE SCREEN, not silently missing', async () => {
  /* Two columns that do not add up to the links they came from is the kind of
     thing a reader files as a bug. It is not one — it is a field nobody set in
     Jira — so the screen has to say so. */
  const items = [bucket('B-1', ['PS_A'], ['T-A', 'T-E', 'T-F'])];
  const payload = payloadFor(items, MAINT_EPICS);
  assert.strictEqual(payload.testCases.totals.unclassified, 2, 'precondition');

  const html = await renderSprint(payload);
  const section = html.slice(html.indexOf('Test cases by component'), html.indexOf('All sprint items'));
  assert.match(section, /neither Maintained nor Maintaining/, 'the gap is named');
  assert.match(section, /Ready for Automation, Blocked, N\/A, or not set/, 'and its cause given');
});

check('and nothing is said when every link has a status', async () => {
  // A permanent paragraph explaining a gap that is not there is noise, and
  // teaches the reader to skip the warnings that matter.
  const items = [bucket('B-1', ['PS_A'], ['T-A', 'T-B'])];
  const payload = payloadFor(items, MAINT_EPICS);
  assert.strictEqual(payload.testCases.totals.unclassified, 0, 'precondition');

  const html = await renderSprint(payload);
  const section = html.slice(html.indexOf('Test cases by component'), html.indexOf('All sprint items'));
  assert.ok(!/neither Maintained nor Maintaining/.test(section), 'the warning cried wolf');
});

check('THE SCREEN SAYS WHEN MAINTAINED IS ZERO BECAUSE THE LINKS ARE NOT SYNCED', async () => {
  // His store has 1,736 Bucket Stories and no "relates to" links on any of
  // them, so this column reads zero everywhere until a full sync. A zero with
  // no explanation reads as "we maintained nothing", which is a different and
  // much worse statement than "this is not synced yet".
  const items = [bucket('B-1', ['PS_A'], []), bucket('B-2', ['PS_A'], [])];
  const html = await renderSprint(payloadFor(items));
  assert.match(html, /carry no "relates to" links/, 'the empty column has to explain itself');
  assert.match(html, /full sync/, 'and say what fixes it');
});

check('and it does not cry wolf once the links are there', async () => {
  const items = [bucket('B-1', ['PS_A'], ['T-1'])];
  const html = await renderSprint(payloadFor(items));
  assert.ok(!/carry no "relates to" links/.test(html),
    'a warning that stays up after it is fixed is one nobody reads next time');
});

check('NOR WHEN THE LINKS ARE THERE BUT NONE OF THEM FINISHED', async () => {
  /* The case the split creates, and it is not hypothetical: his Katalon Titan
     Sprint 40 has five linked suites, every one of them still Maintenance and
     none Automated. "Maintained is zero" is now a true statement about a real
     fortnight, so keying the sync warning off Maintained alone would tell him
     to run a full sync to fix data that is perfectly correct — and send him
     looking for a bug in the tool instead of at a team mid-repair.

     The warning belongs to "no links at all", which is what it was written for. */
  const items = [bucket('B-1', ['PS_A'], ['T-B', 'T-C'])];   // both Maintenance
  const payload = payloadFor(items, MAINT_EPICS);
  assert.strictEqual(payload.testCases.totals.maintained, 0, 'precondition: nothing finished');
  assert.strictEqual(payload.testCases.totals.maintaining, 2, 'precondition: but the links are there');

  const html = await renderSprint(payload);
  assert.ok(!/carry no "relates to" links/.test(html),
    'told him to re-sync a sprint whose links are present and correct');
  assert.ok(!/full sync/.test(html.slice(html.indexOf('Test cases by component'))),
    'and offered the remedy for a problem he does not have');
});

check('the unlinked-story gap is stated on the screen too', async () => {
  const html = await renderSprint(payloadFor([story('A-1', null, ['PS_A'])]));
  assert.match(html, /no parent epic/, 'a count that is short has to say why on the page it is short on');
});

/* ── every number opens the set it is the size of ──────────────────────
   A drill-in has exactly one way to be wrong that matters: the list it opens
   is not the thing that was counted. It renders perfectly either way — a
   plausible list under a plausible number — which is the same failure mode
   this whole table was built to guard against, one level down. */

const DRILL_ITEMS = [
  story('A-1', 'E-1', ['PS_A'], { status: 'Done' }),
  story('A-2', 'E-1', ['PS_A']),                        // same epic: one test case, two items
  story('A-3', 'E-3', ['PS_A', 'PS_B']),                // in flight, and in two components
  bucket('M-1', ['PS_A'], ['T-100', 'T-101', 'T-102']),
  bucket('M-2', ['PS_B'], ['T-101', 'T-102']),          // shares BOTH with M-1
];

check('EVERY COUNT CARRIES THE KEYS IT IS THE COUNT OF', () => {
  const t = insights.testCaseSummary(DRILL_ITEMS, store(EPICS));
  const cols = ['automated', 'inFlight', 'maintained', 'maintaining', 'unclassified', 'stories', 'buckets', 'items', 'done'];
  for (const r of t.rows) {
    for (const c of cols) {
      assert.strictEqual(r.keys[c].length, r[c], `${r.component}.${c}: ${r[c]} counted, ${r.keys[c].length} keys`);
    }
  }
  for (const c of cols) {
    assert.strictEqual(t.totals.keys[c].length, t.totals[c], `total ${c}: ${t.totals[c]} counted, ${t.totals.keys[c].length} keys`);
  }
});

check('and the total\'s keys are DISTINCT, not the rows concatenated', () => {
  const t = insights.testCaseSummary(DRILL_ITEMS, store(EPICS));
  // A-3 is in two components and T-101/T-102 are linked from two bucket stories
  // each, so stitching the rows together would list them twice — a list longer
  // than the number above it, which is the one thing a drill-in must never do.
  const stitched = t.rows.reduce((n, r) => n + r.keys.items.length, 0);
  assert.ok(stitched > t.totals.keys.items.length, 'the fixture really does share an item across components');
  assert.strictEqual(new Set(t.totals.keys.items).size, t.totals.keys.items.length, 'no key twice in the sprint list');
  assert.strictEqual(new Set(t.totals.keys.maintained).size, t.totals.keys.maintained.length, 'nor in the maintained list');
  assert.deepStrictEqual([...t.totals.keys.maintained].sort(), ['T-101', 'T-102'], 'each counted once, not twice');
  // And the link whose target this tool cannot resolve is in its own list,
  // not folded into either side of the split.
  assert.deepStrictEqual([...t.totals.keys.unclassified], ['T-100']);
});

check('the catalogue carries what the sprint item list cannot', () => {
  const t = insights.testCaseSummary(DRILL_ITEMS, store(EPICS));
  // Epics and linked test cases are NOT sprint items, so without this the
  // drawer would have keys it cannot show anything for.
  assert.ok(t.catalogue['E-1'], 'the automated epic is there');
  assert.strictEqual(t.catalogue['E-1'].kind, 'epic');
  assert.strictEqual(t.catalogue['E-1'].summary, 'E-1', 'with enough to display');
  assert.ok(t.catalogue['T-100'], 'and the linked test case');
  assert.strictEqual(t.catalogue['T-100'].absent, true, 'marked as one this tool has no local copy of');
});

check('CLICKING A NUMBER OPENS EXACTLY THAT MANY ROWS', async () => {
  const r = await renderSprintClickable(payloadFor(DRILL_ITEMS));
  const t = insights.testCaseSummary(DRILL_ITEMS, store(EPICS));

  for (const row of t.rows) {
    for (const col of ['automated', 'inFlight', 'maintained', 'maintaining', 'unclassified', 'stories', 'buckets', 'items', 'done']) {
      if (!row[col]) continue;
      const html = r.click({ act: 'drill', scope: row.component, col });
      assert.ok(html, `${row.component}.${col} opened nothing`);
      const shown = (html.match(/border-bottom:1px solid var\(--app-line-soft\)/g) || []).length;
      assert.strictEqual(shown, row[col], `${row.component}.${col}: number says ${row[col]}, drawer shows ${shown}`);
    }
  }
  // And the footer's totals, which are a different set again.
  for (const col of ['automated', 'maintained', 'items']) {
    const html = r.click({ act: 'drill', scope: '__total', col });
    const shown = (html.match(/border-bottom:1px solid var\(--app-line-soft\)/g) || []).length;
    assert.strictEqual(shown, t.totals[col], `total ${col}: number says ${t.totals[col]}, drawer shows ${shown}`);
  }
});

check('a test case with no local copy is still listed, not quietly dropped', async () => {
  /* T-100 has no local copy, so it has no Automation Status to read and lands
     in the unclassified remainder rather than in Maintained or Maintaining.
     It still has to be reachable: a link the tool cannot resolve is the thing
     he would most want to chase, and dropping it would make the remainder a
     number with nothing behind it. */
  const r = await renderSprintClickable(payloadFor(DRILL_ITEMS));
  const html = r.click({ act: 'drill', scope: '__total', col: 'unclassified' });
  assert.match(html, /T-100/, 'the key is shown');
  assert.match(html, /Not in the local store/, 'and said to be unsynced rather than left blank');
  assert.match(html, /1 not synced locally/, 'counted in the header too');
});

check('A KEY THE DRAWER CANNOT RESOLVE AT ALL IS STILL A ROW', async () => {
  const r = await renderSprintClickable(payloadFor(DRILL_ITEMS));
  // Neither a sprint item nor in the catalogue — the case a future caller, or a
  // catalogue that drifts from the key lists, produces. The drawer must still
  // be as long as the number that opened it: a list that is quietly SHORT than
  // its own count is the one outcome a drill-in can never have, and it is the
  // outcome that looks completely normal on screen.
  const html = r.ctx.UI.drillDrawer({ title: 'x', keys: ['GHOST-1', 'A-1'], items: DRILL_ITEMS, catalogue: {} });
  const shown = (html.match(/border-bottom:1px solid var\(--app-line-soft\)/g) || []).length;
  assert.strictEqual(shown, 2, `two keys in, ${shown} rows out`);
  assert.match(html, /GHOST-1/, 'the unresolvable one is shown as itself');
  assert.match(html, /2 items/, 'and counted in the heading');
});

check('the Committed tile opens the sprint, and adds its points up from the same items', async () => {
  const r = await renderSprintClickable(payloadFor(DRILL_ITEMS));
  const html = r.click({ act: 'drill', scope: '__sprint', col: 'committed' });
  const shown = (html.match(/border-bottom:1px solid var\(--app-line-soft\)/g) || []).length;
  assert.strictEqual(shown, DRILL_ITEMS.length, 'every committed item');
  assert.match(html, /15 pts/, 'five items at three points');
});

check('a zero is not a button — nothing to show means nothing to click', async () => {
  const html = await renderSprint(payloadFor([story('A-1', 'E-3', ['PS_A'])]));
  // That component automates nothing, so its Automated cell must be an em-dash.
  assert.ok(!/class="numlink"[^>]*data-col="automated"[^>]*>0</.test(html), 'no zero rendered as a control');
  assert.match(html, /<span class="muted">—<\/span>/, 'an em-dash instead');
});

check('and the numbers are buttons, reachable without a mouse', async () => {
  const html = await renderSprint(payloadFor(DRILL_ITEMS));
  assert.match(html, /<button type="button" class="numlink" data-act="drill" data-scope="PS_A" data-col="automated">/,
    'a real button carrying which set it opens');
  // The component name goes through escaping, not into a template by hand.
  const odd = await renderSprint(payloadFor([story('A-1', 'E-1', ['R&D_"odd"'])]));
  assert.ok(!/data-scope="R&D_"odd""/.test(odd), 'a quote in a component name does not break out of the attribute');
  assert.match(odd, /data-scope="R&amp;D_&quot;odd&quot;"/, 'it is escaped');
});

/* ── run ───────────────────────────────────────────────────────────── */

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
