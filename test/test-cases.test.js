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
const priority = require('../lib/priority');

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
/* `o` carries the fields only a few checks need — labels, above all. Spread
   last so a check can override anything, and defaulted so the call sites that
   predate it read exactly as they did. */
const epic = (key, automationStatus, components = [], o = {}) => ({
  key, summary: key, issueType: 'Epic', automationStatus, components, labels: [], ...o,
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
function payloadFor(items, epics = EPICS, extra = {}) {
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
    /* HIS PRIORITIES, so the harness can see the order the page is sorted in.
       `componentPriority` is where `priority.of` reads them from. */
    componentPriority: { ...(extra.componentPriority || {}) },
  };
  const view = insights.activeSprintView(PLAN, snap, TEAM, SPRINT, { today: '2026-09-24' });
  /* DECORATED AND ORDERED EXACTLY AS `/api/sprint` DOES IT. This returned the
     bare view for a long time, which was fine while nothing on the page
     depended on priority — and silently wrong the moment two tables started
     being SORTED by it: the harness would have rendered rows in the model's
     order and every check on the new order would have passed against a page
     nobody sees. */
  return view.testCases ? {
    ...view,
    testCases: {
      ...view.testCases,
      rows: priority.byPriority(priority.decorate(view.testCases.rows, PLAN)),
    },
    priorityLevels: priority.LEVELS,
  } : view;
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
  /* The item counts — Stories, Bucket stories, Items, Done — used to sit to
     the right of these and are no longer on the table at all; the order check
     that referenced them would now compare against -1 and pass on anything.
     Blocked is what follows Maintaining, and it is the last column. */
  assert.strictEqual(at('Blocked'), at('Maintaining') + 1,
    `Blocked is not straight after Maintaining: ${order.join(' | ')}`);
  assert.strictEqual(at('Blocked'), order.length - 1, 'Blocked is not the last column');
  for (const gone of ['Stories', 'Bucket stories', 'Items', 'Done']) {
    assert.strictEqual(at(gone), -1, `${gone} is still a column on the test-case table`);
  }
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
  assert.ok(n >= 7, `expected the full header, got ${n} columns`);
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

check('THE BLOCKED CELL SHOWS THE BLOCKED NUMBER, and drills to that set', async () => {
  /* The cheap failure this catches: a copy-pasted cell rendering the column
     next door. It renders perfectly, it is a plausible number, and nothing
     else on the page contradicts it. The fixture makes the two DIFFER — with
     Blocked and Maintaining equal, a cell reading the wrong one is invisible. */
  const items = [
    bucket('B-1', ['PS_A'], ['T-A', 'T-B', 'T-D'], { status: 'Refinement' }),
    bucket('B-2', ['PS_A'], ['T-D']),
  ];
  const payload = payloadFor(items, MAINT_EPICS);
  const row = payload.testCases.rows.find(r => r.component === 'PS_A');
  assert.ok(row.blocked && row.blocked !== row.maintaining && row.blocked !== row.maintained,
    `precondition: Blocked (${row.blocked}) must differ from the columns beside it`);

  const tbl = tcTable(await renderSprint(payload));
  const body = tbl.slice(tbl.indexOf('<tbody'), tbl.indexOf('</tbody>'));
  const cells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
  const last = cells[cells.length - 1];
  assert.match(last, new RegExp(`>${row.blocked}<`),
    `the last cell does not show the blocked count (${row.blocked}): ${last}`);
  assert.match(last, /data-col="blocked"/, 'and it does not open the blocked set');

  const foot = tbl.slice(tbl.indexOf('<tfoot'));
  assert.match(foot, new RegExp(`data-col="blocked"[^>]*>${payload.testCases.totals.blocked}<`),
    'the total row disagrees with the model');
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

/* ── BLOCKED: the test cases nobody can move ──────────────────────────── */

/**
 * A PEER OF THE COLUMNS BESIDE IT, which is the whole design of this one.
 *
 * Every other number on this table counts TEST CASES, resolved the same way —
 * a Story speaks for its parent epic, a Bucket Story for the suites it relates
 * to. Blocked counts that same set, restricted to the items still sitting in
 * Refinement, so "3 blocked" is directly comparable with "9 automated" rather
 * than being a count of something else that happens to share the table.
 *
 * The tempting implementation is to count the ITEMS in Refinement, which is a
 * different number entirely — one bucket story in Refinement holding four
 * suites reads as 1 there and 4 here, and 4 is the answer to "how much is
 * held up".
 */

check("BLOCKED COUNTS A STORY'S PARENT EPIC, not the story", () => {
  const items = [
    story('A-1', 'E-1', ['PS_A'], { status: 'Refinement' }),
    story('A-2', 'E-2', ['PS_A']),                            // moving along
  ];
  const t = insights.testCaseSummary(items, store(EPICS));
  const row = t.rows.find(r => r.component === 'PS_A');
  assert.strictEqual(row.blocked, 1);
  assert.deepStrictEqual(row.keys.blocked, ['E-1'], 'the key is the epic, not the story');
  assert.strictEqual(t.totals.blocked, 1);
});

check("AND A BUCKET STORY'S LINKED SUITES — all of them, not the one item", () => {
  /* The number that makes the column worth having. One bucket story in
     Refinement is one row on the board and three suites nobody can touch;
     counting items would report 1. */
  const items = [bucket('B-1', ['PS_A'], ['T-1', 'T-2', 'T-3'], { status: 'Refinement' })];
  const t = insights.testCaseSummary(items, store(EPICS));
  assert.strictEqual(t.totals.blocked, 3, 'the suites behind the item are what is held up');
  assert.deepStrictEqual([...t.totals.keys.blocked].sort(), ['T-1', 'T-2', 'T-3']);
});

check('TWO STORIES UNDER ONE EPIC ARE ONE BLOCKED TEST CASE', () => {
  // The same distinctness every other column on this table has. Two people
  // refining two halves of one test case is one test case held up.
  const items = [
    story('A-1', 'E-1', ['PS_A'], { status: 'Refinement' }),
    story('A-2', 'E-1', ['PS_A'], { status: 'Refinement' }),
  ];
  const t = insights.testCaseSummary(items, store(EPICS));
  assert.strictEqual(t.totals.blocked, 1, 'counted the stories rather than the epic');
});

check('NOTHING ELSE IS BLOCKED — not In Dev, not Done, not Refinement-and-finished', () => {
  const items = [
    story('A-1', 'E-1', ['PS_A'], { status: 'In Dev' }),
    story('A-2', 'E-2', ['PS_A'], { status: 'Done' }),
    // Finished, still parked in the Refinement column: a workflow quirk, not
    // work being held up. This is the case the `!isDone` guard exists for.
    story('A-3', 'E-3', ['PS_A'], { status: 'Refinement', statusCategory: 'done' }),
  ];
  const t = insights.testCaseSummary(items, store(EPICS));
  assert.strictEqual(t.totals.blocked, 0);
});

check('BLOCKED IS A SUBSET OF THE COLUMNS BESIDE IT, never a number of its own', () => {
  /* The guarantee that makes the row readable: a blocked test case is already
     counted under Automated, In flight, Maintained or Maintaining. If this
     ever resolved epics its own way, the row would show a Blocked bigger than
     the columns it is meant to qualify, and nobody could add it up. */
  const items = [
    story('A-1', 'E-1', ['PS_A'], { status: 'Refinement' }),
    story('A-2', 'E-3', ['PS_A'], { status: 'Refinement' }),
    bucket('B-1', ['PS_A'], ['T-1', 'T-100'], { status: 'Refinement' }),
    story('A-3', 'E-2', ['PS_A']),
  ];
  const t = insights.testCaseSummary(items, store(EPICS));
  const row = t.rows.find(r => r.component === 'PS_A');
  const others = new Set([
    ...row.keys.automated, ...row.keys.inFlight,
    ...row.keys.maintained, ...row.keys.maintaining, ...row.keys.unclassified,
  ]);
  assert.ok(row.blocked > 0, 'fixture check: something has to be blocked');
  for (const k of row.keys.blocked) {
    assert.ok(others.has(k), `${k} is blocked but appears in none of the other columns`);
  }
});

check('A COMPONENT WITH NOTHING IN REFINEMENT READS ZERO, and still has the key list', () => {
  // An absent `keys.blocked` would make the drill-in throw rather than open an
  // empty drawer — the difference between "none" and "broken".
  const t = insights.testCaseSummary([story('A-1', 'E-1', ['PS_A'])], store(EPICS));
  const row = t.rows.find(r => r.component === 'PS_A');
  assert.strictEqual(row.blocked, 0);
  assert.deepStrictEqual(row.keys.blocked, []);
  assert.deepStrictEqual(t.totals.keys.blocked, []);
});

/* ── THE REASON, in the drawer behind Blocked ─────────────────────────── */

/**
 * A key on its own does not answer the question the column raises.
 *
 * "T-1 is blocked" prompts "by what?", and the answer is on a different issue
 * entirely — the sprint item stuck in Refinement, and whatever THAT item's epic
 * says it is waiting for. Without it the drawer sends you to Jira to find out
 * what the screen already knew.
 */

/** An epic that names something as blocking it. */
const heldEpic = (key, blockedBy) => ({
  key, summary: `Epic ${key}`, issueType: 'Epic', automationStatus: 'Ready for Automation',
  components: ['PS_A'], labels: [], blockedBy, relatesTo: [],
});

check('THE MODEL CARRIES A REASON FOR EVERY BLOCKED KEY, and for no other', () => {
  /* The invariant that keeps the two honest: the Blocked count is the size of
     this map's key set. A key counted with no reason opens an empty drawer; a
     reason for a key nobody counted is a row that cannot be reached. */
  const items = [
    story('A-1', 'E-1', ['PS_A'], { status: 'Refinement' }),
    bucket('M-1', ['PS_A'], ['T-1', 'T-2'], { status: 'Refinement' }),
    story('A-2', 'E-2', ['PS_A']),
  ];
  const t = insights.testCaseSummary(items, store(EPICS));
  assert.deepStrictEqual(
    Object.keys(t.blockedReasons).sort(),
    [...t.totals.keys.blocked].sort(),
    'the reasons and the counted keys have parted company');
});

check('THE REASON NAMES THE ITEM HOLDING IT, with its status and owner', () => {
  const items = [bucket('M-1', ['PS_A'], ['T-1'], { status: 'Refinement' })];
  const t = insights.testCaseSummary(items, store(EPICS));
  const held = t.blockedReasons['T-1'];
  assert.strictEqual(held.length, 1);
  assert.strictEqual(held[0].item, 'M-1');
  assert.strictEqual(held[0].status, 'Refinement');
  assert.strictEqual(held[0].assignee, 'Hien Phan');
});

check('TWO ITEMS HOLDING ONE TEST CASE BOTH APPEAR', () => {
  // One test case, one Blocked count — but two people to talk to, and the
  // drawer is where you find out there are two.
  const items = [
    story('A-1', 'E-1', ['PS_A'], { status: 'Refinement' }),
    story('A-2', 'E-1', ['PS_A'], { status: 'Refinement', assignee: 'Anh Truong' }),
  ];
  const t = insights.testCaseSummary(items, store(EPICS));
  assert.strictEqual(t.totals.blocked, 1, 'precondition: still one test case');
  assert.deepStrictEqual(t.blockedReasons['E-1'].map(h => h.item), ['A-1', 'A-2']);
});

check("AND WHAT THAT ITEM IS WAITING ON, read from ITS EPIC", () => {
  /* The link is on the epic, never on the story — the finding this whole
     screen was rebuilt around. Reading the item's own `blockedBy` gives an
     empty list on every real story in his sprints. */
  const items = [story('A-1', 'E-HELD', ['PS_A'], { status: 'Refinement' })];
  const epics = [...EPICS, heldEpic('E-HELD', [{ key: 'CLICMNTIGO-11567', summary: 'Env down' }])];
  /* Through the REAL route, not `testCaseSummary` on its own: `epicBlockers`
     is attached by `activeSprintView` when it decorates the items, so a bare
     call here would hand the summary undecorated items and the waiting-on list
     would be empty for a reason that has nothing to do with the data. */
  const t = payloadFor(items, epics).testCases;
  const held = t.blockedReasons['E-HELD'];
  assert.ok(held, 'E-HELD was not counted as blocked at all');
  assert.deepStrictEqual(held[0].waitingOn.map(b => b.key), ['CLICMNTIGO-11567']);
  assert.strictEqual(held[0].waitingOn[0].summary, 'Env down',
    'the summary Jira sent inside the link is the only description this will ever have');
});

check('AN ITEM WAITING ON NOTHING SAYS SO, rather than showing an empty list', () => {
  const items = [story('A-1', 'E-1', ['PS_A'], { status: 'Refinement' })];
  const t = insights.testCaseSummary(items, store(EPICS));
  assert.deepStrictEqual(t.blockedReasons['E-1'][0].waitingOn, [],
    'an absent key and an empty list are different things to the drawer');
});

check('THE DRAWER PRINTS THE REASON — held by, and waiting on', async () => {
  const items = [story('A-1', 'E-HELD', ['PS_A'], { status: 'Refinement' })];
  const epics = [...EPICS, heldEpic('E-HELD', [{ key: 'CLICMNTIGO-11567', summary: 'Env down' }])];
  const r = await renderSprintClickable(payloadFor(items, epics));
  const drawn = r.click({ act: 'drill', scope: 'PS_A', col: 'blocked' });
  assert.ok(drawn, 'the Blocked cell opened nothing');
  assert.match(drawn, /E-HELD/, 'the test case itself');
  assert.match(drawn, /Held by/, 'the drawer does not say what is holding it');
  assert.match(drawn, /A-1/, 'and does not name the item');
  assert.match(drawn, /waiting on/, 'nor what that item is waiting for');
  assert.match(drawn, /CLICMNTIGO-11567/, 'nor name the blocker');
});

check('and prints the unexplained case in words, not as a blank', async () => {
  const items = [story('A-1', 'E-1', ['PS_A'], { status: 'Refinement' })];
  const r = await renderSprintClickable(payloadFor(items));
  const drawn = r.click({ act: 'drill', scope: 'PS_A', col: 'blocked' });
  assert.match(drawn, /Held by/);
  assert.match(drawn, /waiting on refinement, not on another ticket/,
    'a blocked row with nothing recorded rendered as an empty gap');
});

check('NO OTHER COLUMN GROWS A REASON, however blocked the sprint is', async () => {
  /* `reasons` is passed for one column. If it leaked to the others, every
     in-flight epic under a refining story would sprout a "Held by" line and
     the drawer would stop being a list of what the number counted. */
  const items = [story('A-1', 'E-3', ['PS_A'], { status: 'Refinement' })];
  const r = await renderSprintClickable(payloadFor(items));
  const blocked = r.click({ act: 'drill', scope: 'PS_A', col: 'blocked' });
  assert.match(blocked, /Held by/, 'precondition: this fixture does produce a reason');
  const inFlight = r.click({ act: 'drill', scope: 'PS_A', col: 'inFlight' });
  assert.match(inFlight, /E-3/, 'precondition: the same epic is in this column');
  assert.ok(!/Held by/.test(inFlight), 'the reason leaked into a column that did not ask for it');
});

check('THE MARKER APPEARS BESIDE IN FLIGHT, and only when it means something', async () => {
  /* HIS REQUEST. The indicator qualifies the number next to it rather than
     adding a column: "5 in flight, 4 of them going nowhere". */
  const r = await renderSprintClickable(payloadFor(FLAG_ITEMS, FLAG_EPICS));
  const body = r.html.slice(r.html.indexOf('Test cases by component'));
  const row = body.slice(body.indexOf('PS_F'), body.indexOf('</tr>', body.indexOf('PS_F')));
  const mark = row.match(/<button[^>]*data-col="attention"[^>]*>/);
  assert.ok(mark, `no marker beside In flight: ${row}`);
  assert.match(mark[0], /class="stuck-mark"/,
    'the marker does not use the same shape as the Capacity sheet\'s');
  assert.match(mark[0], /data-act="drill"/, 'the marker opens nothing');
  assert.ok(mark[0].includes('data-scope="PS_F"'), 'the marker opens a different component');
  /* ANNOUNCED, not a bare glyph — it is a real control and the only thing on
     the row saying the number is not what it looks like. */
  assert.match(mark[0], /aria-label="[^"]+"/, 'the marker says nothing to a screen reader');
  assert.match(mark[0], /title="[^"]*obsolete[^"]*"/i, 'the tooltip does not say what it means');
});

check('AND NOTHING IS DRAWN WHEN NOTHING IS FLAGGED', async () => {
  /* A marker that is always there is one nobody reads; its whole value is
     being unusual. */
  const items = [story('A-1', 'E-3', ['PS_A'])];
  const r = await renderSprintClickable(payloadFor(items));
  const body = r.html.slice(r.html.indexOf('Test cases by component'));
  const row = body.slice(body.indexOf('PS_A'), body.indexOf('</tr>', body.indexOf('PS_A')));
  assert.match(row, /data-col="inFlight"/, 'precondition: this row has in-flight work');
  assert.ok(!/data-col="attention"/.test(row), 'an unflagged row grew a marker');
});

check('CLICKING IT OPENS THE FLAGGED SUITES, WITH THE REASON ON EACH', async () => {
  const r = await renderSprintClickable(payloadFor(FLAG_ITEMS, FLAG_EPICS));
  const d = r.click({ act: 'drill', scope: 'PS_F', col: 'attention' });
  assert.ok(d, 'the marker opened no drawer');
  for (const k of ['E-BLOCKED', 'E-OBS', 'E-BOTH', 'E-OBS-WITH-STATUS']) {
    assert.ok(d.includes(k), `the drawer does not list ${k}`);
  }
  assert.ok(!d.includes('E-MOVING'), 'the drawer lists a suite that is genuinely in progress');

  /* THE REASON IS MARKED, not buried in the metadata — the same accent the
     Blocked drawer uses, because it is the same kind of statement. */
  assert.match(d, /class="drill-blocked"/, 'the reasons are drawn as plain text');
  assert.match(d, /Automation Status is Blocked/, 'the drawer does not say what blocked means');
  assert.match(d, /labelled obsolete/i, 'the drawer does not say a suite was retired');
  assert.match(d, /not work in progress/i, 'the retired note does not say what it implies');
});

check('AND A SUITE THAT IS BOTH SAYS BOTH', async () => {
  /* Blocked means chase it; obsolete means it should not be in flight at all.
     Showing only the first sends somebody to unblock a retired suite. */
  const r = await renderSprintClickable(payloadFor([story('F-3', 'E-BOTH', ['PS_F'])], FLAG_EPICS));
  const d = r.click({ act: 'drill', scope: 'PS_F', col: 'attention' });
  const marks = (d.match(/class="drill-blocked"/g) || []).length;
  assert.strictEqual(marks, 2, `an epic that is blocked AND retired showed ${marks} reason(s)`);
  assert.match(d, /Blocked/, 'the blocked reason is missing');
  assert.match(d, /Retired/, 'the retired reason is missing');
});

check('AND THE FOOTER MARKER OPENS THE SPRINT-WIDE SET', async () => {
  const r = await renderSprintClickable(payloadFor(FLAG_ITEMS, FLAG_EPICS));
  const foot = r.html.slice(r.html.indexOf('<tfoot'));
  assert.match(foot, /data-col="attention"[^>]*data-scope="__total"|data-scope="__total"[^>]*data-col="attention"/,
    'the sprint total has no marker');
  const d = r.click({ act: 'drill', scope: '__total', col: 'attention' });
  assert.ok(d, 'the total marker opened no drawer');
  for (const k of ['E-BLOCKED', 'E-OBS', 'E-BOTH']) assert.ok(d.includes(k), `the total drawer lost ${k}`);
});

check('AND A RETIRED NOTE DOES NOT LEAK ONTO EVERY OTHER DRAWER', async () => {
  /* The note renders from the row's own labels, so it must be silent wherever
     the fact is absent — a label line on each of forty automated epics is how
     a panel becomes unreadable. */
  const r = await renderSprintClickable(payloadFor(FLAG_ITEMS, FLAG_EPICS));
  const automated = r.click({ act: 'drill', scope: 'PS_F', col: 'automated' });
  assert.ok(automated.includes('E-DONE-OBS'), 'precondition: the automated column has the retired one');
  assert.match(automated, /Retired/,
    'a suite that IS labelled obsolete lost its note in another drawer');
  const moving = r.click({ act: 'drill', scope: 'PS_F', col: 'inFlight' });
  assert.ok(moving.includes('E-MOVING'), 'precondition: the in-flight column has the moving one');
});

/* ── THE SAME COUNTS, SPLIT BY TOOL ────────────────────────────────────
   His requirement, stated first because it is the one that matters: the split
   table must agree with the combined one. Two tables on one screen showing the
   same measures is only useful while they agree; the moment they do not, a
   reader stops believing either. */

const TOOL_EPICS = [
  epic('TT-A', 'Automated', ['PS_T', 'TrueTest']),
  epic('TT-B', 'Ready for Automation', ['PS_T', 'TrueTest']),
  epic('KS-A', 'Automated', ['PS_T', 'Katalon']),
  epic('KS-B', 'Ready for Automation', ['PS_T', 'Katalon']),
  epic('KS-C', 'Blocked', ['PS_T', 'Katalon']),
  // A suite carrying neither tool component — `toolOf` calls it KSE.
  epic('NO-TOOL', 'Automated', ['PS_T']),
  // Maintained / maintaining targets, one per tool.
  epic('TT-M', 'Automated', ['PS_T', 'TrueTest']),
  epic('KS-M', 'Maintenance', ['PS_T', 'Katalon']),
  epic('E-BUCKET2', null, ['PS_T']),
];
const TOOL_ITEMS = [
  story('T-1', 'TT-A', ['PS_T']),
  story('T-2', 'TT-B', ['PS_T']),
  story('T-3', 'KS-A', ['PS_T']),
  story('T-4', 'KS-B', ['PS_T']),
  story('T-5', 'KS-C', ['PS_T'], { status: 'Refinement' }),
  story('T-6', 'NO-TOOL', ['PS_T']),
  bucket('T-7', ['PS_T'], ['TT-M', 'KS-M']),
];
const split = () => insights.testCaseSummary(TOOL_ITEMS, store(TOOL_EPICS));

check('EVERY COLUMN SPLITS, AND THE TWO TOOLS ADD BACK UP', () => {
  const t = split();
  const row = t.rows.find(r => r.component === 'PS_T');
  for (const col of ['automated', 'inFlight', 'maintained', 'maintaining', 'blocked']) {
    const sum = row.byTool.truetest[col] + row.byTool.kse[col];
    assert.strictEqual(sum, row[col],
      `${col}: the tools add to ${sum} and the combined table says ${row[col]}`);
  }
});

check('AND SO DO THE SPRINT TOTALS', () => {
  const t = split();
  for (const col of ['automated', 'inFlight', 'maintained', 'maintaining', 'blocked']) {
    const sum = t.totals.byTool.truetest[col] + t.totals.byTool.kse[col];
    assert.strictEqual(sum, t.totals[col], `${col}: the split total disagrees with the combined one`);
  }
});

check('EACH SUITE LANDS UNDER THE TOOL ITS COMPONENTS NAME', () => {
  const t = split();
  const row = t.rows.find(r => r.component === 'PS_T');
  assert.deepStrictEqual(row.byTool.truetest.keys.automated, ['TT-A']);
  assert.deepStrictEqual(row.byTool.truetest.keys.inFlight, ['TT-B']);
  assert.deepStrictEqual(row.byTool.kse.keys.inFlight.slice().sort(), ['KS-B', 'KS-C']);
  assert.deepStrictEqual(row.byTool.truetest.keys.maintained, ['TT-M']);
  assert.deepStrictEqual(row.byTool.kse.keys.maintaining, ['KS-M']);
  assert.deepStrictEqual(row.byTool.kse.keys.blocked, ['KS-C'],
    'the blocked suite is not under its own tool');
});

check('AN UNTAGGED SUITE FOLLOWS toolOf, AND IS COUNTED AND SAID', () => {
  /* `toolOf` calls anything without the TrueTest component KSE, and the
     Coverage screen has split that way for as long as it has existed. A second
     rule here would put one epic under different tools on two screens. But a
     silent default is worth stating, so the count travels beside the split —
     exactly as Coverage's own `untagged` does. */
  const t = split();
  const row = t.rows.find(r => r.component === 'PS_T');
  assert.strictEqual(cov.hasTool({ components: ['PS_T'] }), false, 'precondition: it carries no tool component');
  assert.strictEqual(cov.toolOf({ components: ['PS_T'] }), 'kse', 'precondition: toolOf defaults to KSE');
  assert.ok(row.byTool.kse.keys.automated.includes('NO-TOOL'),
    'the untagged suite vanished instead of following toolOf');
  assert.strictEqual(row.byTool.untagged, 1, 'the silent default is not counted');
  assert.strictEqual(t.totals.byTool.untagged, 1, 'nor reported for the sprint');
});

check('AND AN UNTAGGED SUITE IS COUNTED ONCE, not once per column', () => {
  /* A suite can sit in two columns at once — blocked and in flight, say — and
     adding the per-column untagged counts would report it twice, over a table
     whose whole promise is that its numbers agree with the one above it. */
  const items = [...TOOL_ITEMS, story('T-8', 'NO-TOOL-2', ['PS_T'], { status: 'Refinement' })];
  const epics = [...TOOL_EPICS, epic('NO-TOOL-2', 'Ready for Automation', ['PS_T'])];
  const t = insights.testCaseSummary(items, store(epics));
  const row = t.rows.find(r => r.component === 'PS_T');
  assert.ok(row.byTool.kse.keys.blocked.includes('NO-TOOL-2'), 'precondition: it is blocked too');
  assert.ok(row.byTool.kse.keys.inFlight.includes('NO-TOOL-2'), 'precondition: and in flight');
  assert.strictEqual(row.byTool.untagged, 2, 'an untagged suite in two columns was counted twice');
});

check('THE ATTENTION MARKER SPLITS TOO', () => {
  /* The In flight marker sits in both tables, so the per-tool number has to be
     that tool's share rather than the row's whole count. */
  const epics = [...TOOL_EPICS, epic('TT-OBS', null, ['PS_T', 'TrueTest'], { labels: ['obsolete'] })];
  const items = [...TOOL_ITEMS, story('T-9', 'TT-OBS', ['PS_T'])];
  const t = insights.testCaseSummary(items, store(epics));
  const row = t.rows.find(r => r.component === 'PS_T');
  assert.deepStrictEqual(row.byTool.truetest.keys.attention, ['TT-OBS']);
  assert.ok(row.byTool.kse.keys.attention.includes('KS-C'), 'the blocked KSE suite is not flagged under KSE');
  assert.strictEqual(row.byTool.truetest.attention + row.byTool.kse.attention, row.attention,
    'the flagged counts do not add back up');
});

check('THE SPLIT TOTAL COUNTS A SHARED SUITE ONCE', () => {
  /* Built from the sprint-wide sets, not by adding the rows: an epic in two
     components is in two rows. */
  const items = [...TOOL_ITEMS, story('T-10', 'TT-A', ['PS_U'])];
  const t = insights.testCaseSummary(items, store(TOOL_EPICS));
  const rows = t.rows.filter(r => r.component === 'PS_T' || r.component === 'PS_U');
  assert.strictEqual(rows.reduce((n, r) => n + r.byTool.truetest.automated, 0), 2,
    'fixture check: the rows double-count it');
  assert.strictEqual(t.totals.byTool.truetest.automated, 1, 'the split total counted one suite twice');
});

check('THE BY-TOOL SECTION IS ON THE PAGE, below the combined one', async () => {
  const r = await renderSprintClickable(payloadFor(TOOL_ITEMS, TOOL_EPICS));
  const combined = r.html.indexOf('>Test cases by component<');
  const byTool = r.html.indexOf('Test cases by component — by tool');
  assert.ok(combined > 0, 'the combined section is gone');
  assert.ok(byTool > 0, 'the by-tool section did not render');
  assert.ok(byTool > combined, 'the by-tool table rendered above the one it is read against');
});

check('AND ITS HEADER IS TWO ROWS: a tool band over five columns each', async () => {
  const r = await renderSprintClickable(payloadFor(TOOL_ITEMS, TOOL_EPICS));
  const sec = r.html.slice(r.html.indexOf('Test cases by component — by tool'));
  const head = sec.slice(sec.indexOf('<thead>'), sec.indexOf('</thead>'));

  for (const tool of ['TrueTest', 'KSE']) {
    assert.ok(head.includes(`>${tool}</th>`), `no ${tool} band in the header`);
  }
  assert.match(head, /colspan="5"/, 'the tool band does not span its five columns');
  /* THE COLUMNS, TWICE — once per tool, in the order of the mock-up. */
  const subs = [...head.matchAll(/<th class="num sub[^>]*>([^<]+)<\/th>/g)].map(m => m[1]);
  assert.deepStrictEqual(subs,
    ['Automated', 'In Flight', 'Maintained', 'Maintaining', 'Blocked',
      'Automated', 'In Flight', 'Maintained', 'Maintaining', 'Blocked'],
    `the column set is not five per tool: ${subs.join(', ')}`);
  /* The banded classes are the Capacity sheet's, so the two grids read alike. */
  assert.match(head, /class="num tool-start tool-head band-a"/, 'the first tool band is unstyled');
  assert.match(head, /class="num tool-start tool-head band-b"/, 'the second tool band is unstyled');
});

check('BOTH TOOLS ARE DRAWN EVEN WHEN ONE IS EMPTY END TO END', async () => {
  /* On his board every sprint is currently one-sided — Titan is all TrueTest,
     Ruby all KSE. A group that vanished at zero would make "KSE did nothing
     this sprint" look like a missing column rather than the finding it is, and
     would change the table's shape between sprints. */
  const ttOnly = [
    epic('X-1', 'Automated', ['PS_X', 'TrueTest']),
    epic('X-2', 'Ready for Automation', ['PS_X', 'TrueTest']),
  ];
  const items = [story('X-a', 'X-1', ['PS_X']), story('X-b', 'X-2', ['PS_X'])];
  const r = await renderSprintClickable(payloadFor(items, ttOnly));
  const sec = r.html.slice(r.html.indexOf('Test cases by component — by tool'));
  assert.ok(sec.includes('>TrueTest</th>'), 'the populated tool is missing');
  assert.ok(sec.includes('>KSE</th>'), 'the empty tool group was dropped, so the table changes shape by sprint');
  const row = sec.slice(sec.indexOf('PS_X'), sec.indexOf('</tr>', sec.indexOf('PS_X')));
  const cells = [...row.matchAll(/<td class="num[^"]*">(.*?)<\/td>/g)].map(m => m[1].replace(/<[^>]*>/g, '').trim());
  assert.strictEqual(cells.length, 10, `expected ten numeric cells, got ${cells.length}`);
  assert.deepStrictEqual(cells.slice(5), ['—', '—', '—', '—', '—'],
    'the empty tool half is not drawn as dashes');
});

check('THE ROW ORDER MATCHES THE COMBINED TABLE', async () => {
  /* Read across, not hunted for: the two tables list the same components in
     the same order so a row can be compared between them at a glance. */
  const items = [
    story('R-1', 'TT-A', ['PS_BUSY']), story('R-2', 'TT-M', ['PS_BUSY']), story('R-3', 'KS-A', ['PS_BUSY']),
    story('R-4', 'KS-B', ['PS_QUIET']),
  ];
  const r = await renderSprintClickable(payloadFor(items, TOOL_EPICS));
  const order = (section) => [...section.matchAll(/>(PS_BUSY|PS_QUIET)</g)].map(m => m[1]);
  const all = r.html;
  const combined = all.slice(all.indexOf('>Test cases by component<'), all.indexOf('Test cases by component — by tool'));
  const byTool = all.slice(all.indexOf('Test cases by component — by tool'));
  assert.deepStrictEqual(order(byTool).slice(0, 2), order(combined).slice(0, 2),
    'the two tables list the components in different orders');
});

check('EVERY NUMBER OPENS THAT TOOL\'S OWN SET', async () => {
  /* Driven through the RENDERED buttons: what this really asks is whether the
     markup carries enough to tell the handler which set to open, and a
     hand-written dataset answers a different question. */
  const r = await renderSprintClickable(payloadFor(TOOL_ITEMS, TOOL_EPICS));
  const SEC = 'Test cases by component — by tool';

  const tt = clickRendered(r, SEC, { col: 'automated', tool: 'truetest', scope: 'PS_T' });
  assert.strictEqual(tt.dataset.src, 'bytool',
    'the by-tool number does not say which table it came from, so it opens the combined set');
  assert.ok(tt.drawn.includes('TT-A'), 'the TrueTest drawer does not list its own suite');
  assert.ok(!tt.drawn.includes('KS-A'), 'the TrueTest drawer lists a KSE suite');
  /* THE HEADING ITSELF, not just the word somewhere in the panel — the
     tool-slice sentence below also says "TrueTest", so a loose match passed
     against a drawer whose title had lost the tool entirely. */
  const titleOf = (h) => (h.match(/<div class="eyebrow"><i><\/i>([^<]*)<\/div>/) || [])[1] || '';
  assert.match(titleOf(tt.drawn), /TrueTest/,
    `the heading does not name the tool, so two drawers share one title: "${titleOf(tt.drawn)}"`);
  assert.match(tt.drawn, /Only the suites that run on TrueTest/, 'the drawer does not say it is a tool slice');

  const ks = clickRendered(r, SEC, { col: 'automated', tool: 'kse', scope: 'PS_T' });
  assert.ok(ks.drawn.includes('KS-A'), 'the KSE drawer does not list its own suite');
  assert.ok(!ks.drawn.includes('TT-A'), 'the KSE drawer lists a TrueTest suite');
  assert.match(titleOf(ks.drawn), /KSE/,
    `the KSE heading does not name its tool: "${titleOf(ks.drawn)}"`);
});

check('AND THE TOTAL ROW OPENS THE SPRINT-WIDE TOOL SET', async () => {
  const r = await renderSprintClickable(payloadFor(TOOL_ITEMS, TOOL_EPICS));
  const d = clickRendered(r, 'Test cases by component — by tool',
    { col: 'automated', tool: 'truetest', scope: '__total' });
  assert.strictEqual(d.dataset.src, 'bytool', 'the total number lost its source');
  assert.ok(d.drawn.includes('TT-A'), 'the sprint-wide TrueTest set is missing its suite');
  assert.ok(!d.drawn.includes('KS-A'), 'the sprint-wide TrueTest set leaked a KSE suite');
});

check('AND THE COMBINED TABLE STILL OPENS THE COMBINED SET', async () => {
  /* Adding a source must not change what the table above opens. */
  const r = await renderSprintClickable(payloadFor(TOOL_ITEMS, TOOL_EPICS));
  const d = r.click({ act: 'drill', scope: 'PS_T', col: 'automated' });
  assert.ok(d.includes('TT-A') && d.includes('KS-A'),
    'the combined drawer no longer lists both tools');
  assert.ok(!/Only the suites that run on/.test(d), 'the combined drawer claims to be a tool slice');
});

check('AND THE UNTAGGED CAVEAT IS ON SCREEN, not just in the payload', async () => {
  const r = await renderSprintClickable(payloadFor(TOOL_ITEMS, TOOL_EPICS));
  const sec = r.html.slice(r.html.indexOf('Test cases by component — by tool'));
  const head = sec.slice(0, sec.indexOf('<table'));
  assert.match(head, /no tool component/i,
    'a suite is silently counted under KSE and the caption does not say so');
  assert.match(head, /KSE/, 'the caption does not say which tool it fell into');
});

/**
 * CLICK THE BUTTON THE PAGE ACTUALLY RENDERED, with the dataset it carries.
 *
 * `r.click({...})` takes a dataset written out by hand. That is the right
 * question for "what does the handler do with this input" and the WRONG one
 * for "does the markup carry what the handler needs" — and the difference is
 * not academic: removing `src` from the by-tool numbers left every
 * hand-written click green, because the checks were feeding in the very
 * attribute the page had just stopped emitting.
 *
 * This finds the rendered control by the attributes a reader would aim at, and
 * hands the handler exactly what that button holds.
 */
const dsOf = (tag) => Object.fromEntries([...tag.matchAll(/data-([a-z-]+)="([^"]*)"/g)]
  .map(([, k, v]) => [k.replace(/-(\w)/g, (_, c) => c.toUpperCase()),
    v.replace(/&quot;/g, '"').replace(/&amp;/g, '&')]));

const clickRendered = (r, after, match) => {
  const at = r.html.indexOf(after);
  assert.ok(at >= 0, `the section "${after}" is not on the page`);
  const sec = r.html.slice(at);
  const hit = [...sec.matchAll(/<button[^>]*>/g)].map(m => dsOf(m[0]))
    .find(dd => Object.entries(match).every(([k, v]) => dd[k] === v));
  assert.ok(hit, `no rendered button matching ${JSON.stringify(match)}`);
  assert.strictEqual(hit.act, 'drill', `that control is a ${hit.act}, not a drill-in`);
  return { drawn: r.click(hit), dataset: hit };
};

check('AND THE SECTION IS ABSENT UNTIL THE PAYLOAD CAN BACK IT', async () => {
  /* `byTool` is new in the model, so a page held against a server that has not
     restarted gets none of it. A ten-column grid of dashes under the real
     table would read as "no test cases run on either tool" — a statement, and
     a false one. */
  const base = payloadFor(TOOL_ITEMS, TOOL_EPICS);
  const stripped = {
    ...base,
    testCases: {
      ...base.testCases,
      totals: { ...base.testCases.totals, byTool: undefined },
      rows: base.testCases.rows.map(({ byTool, ...rest }) => rest),
    },
  };
  const r = await renderSprintClickable(stripped);
  assert.ok(!r.html.includes('Test cases by component — by tool'),
    'the by-tool table rendered as dashes against a payload that carries no split');
  assert.ok(r.html.includes('>Test cases by component<'),
    'the combined table went too — it does not depend on the split');
});

/* ── ORDERED THE WAY HE READS THE SHEET ────────────────────────────────
   P1 → P2 → P3 → P4, then the components he has not prioritised. Both tables
   on this page, and the CSV, take the same order from one place. */

const PRIO_EPICS = [
  epic('P-1', 'Automated', ['C_P1', 'TrueTest']),
  epic('P-2', 'Automated', ['C_P2', 'TrueTest']),
  epic('P-3', 'Automated', ['C_P3', 'Katalon']),
  epic('P-4', 'Automated', ['C_P4', 'Katalon']),
  epic('P-N', 'Automated', ['C_NONE', 'Katalon']),
  /* THE BUSIEST COMPONENT IS THE LEAST PRIORITISED, deliberately: under the
     old busiest-first sort it led the table, so if the new order is not
     applied this fixture puts it first and the check fails loudly rather than
     passing on a coincidence. */
  epic('P-N2', 'Automated', ['C_NONE', 'Katalon']),
  epic('P-N3', 'Ready for Automation', ['C_NONE', 'Katalon']),
];
const PRIO_ITEMS = [
  story('p-a', 'P-1', ['C_P1']),
  story('p-b', 'P-2', ['C_P2']),
  story('p-c', 'P-3', ['C_P3']),
  story('p-d', 'P-4', ['C_P4']),
  story('p-e', 'P-N', ['C_NONE']),
  story('p-f', 'P-N2', ['C_NONE']),
  story('p-g', 'P-N3', ['C_NONE']),
];
const PRIO_PLAN = {
  componentPriority: { C_P1: 1, C_P2: 2, C_P3: 3, C_P4: 4 },
};
const prioPayload = () => payloadFor(PRIO_ITEMS, PRIO_EPICS, PRIO_PLAN);

const rowOrder = (html, from) => {
  const sec = html.slice(html.indexOf(from));
  const body = sec.slice(sec.indexOf('<tbody>'), sec.indexOf('</tbody>'));
  return [...body.matchAll(/>(C_P\d|C_NONE)</g)].map(m => m[1])
    .filter((v, i, a) => a.indexOf(v) === i);
};

check('THE COMBINED TABLE IS ORDERED P1 → P4, then the unprioritised', async () => {
  const r = await renderSprintClickable(prioPayload());
  assert.deepStrictEqual(rowOrder(r.html, '>Test cases by component<'),
    ['C_P1', 'C_P2', 'C_P3', 'C_P4', 'C_NONE'],
    'the combined table is not in priority order');
});

check('AND SO IS THE BY-TOOL TABLE', async () => {
  const r = await renderSprintClickable(prioPayload());
  assert.deepStrictEqual(rowOrder(r.html, 'Test cases by component — by tool'),
    ['C_P1', 'C_P2', 'C_P3', 'C_P4', 'C_NONE'],
    'the by-tool table is not in priority order');
});

check('AND THE TWO STILL LIST THEM IDENTICALLY', async () => {
  /* The point of ordering once rather than in each table: a reader compares a
     component between the two by looking straight down. */
  const r = await renderSprintClickable(prioPayload());
  assert.deepStrictEqual(
    rowOrder(r.html, 'Test cases by component — by tool'),
    rowOrder(r.html, '>Test cases by component<'),
    'the two tables drifted into different orders');
});

check('THE UNPRIORITISED GO LAST even when they are the busiest', async () => {
  /* The old order was busiest-first, and C_NONE is the busiest component in
     this fixture. If the sort were dropped it would lead both tables — which
     is exactly the row he wants at the bottom. */
  const r = await renderSprintClickable(prioPayload());
  const rows = (r.html.match(/>C_NONE</g) || []).length;
  assert.ok(rows > 0, 'fixture check: the unprioritised component is on the page');
  const order = rowOrder(r.html, '>Test cases by component<');
  assert.strictEqual(order[order.length - 1], 'C_NONE',
    `the unprioritised component is not last: ${order.join(' → ')}`);
  /* And it really is the busiest, so this is not passing by luck. */
  const payload = prioPayload();
  const none = payload.testCases.rows.find(x => x.component === 'C_NONE');
  const p1 = payload.testCases.rows.find(x => x.component === 'C_P1');
  assert.ok(none.items > p1.items,
    `fixture check: C_NONE (${none.items} items) must outweigh C_P1 (${p1.items}) or this check proves nothing`);
});

check('AND BUSIEST-FIRST SURVIVES INSIDE ONE PRIORITY', async () => {
  /* The sort is on the level alone and JavaScript's sort is stable, so the
     model's own order is the tie-break — two P1 components still read busiest
     first rather than in whatever order the map happened to yield. */
  /* NAMED AGAINST THE ALPHABET: the busiest is Z_ and the quiet one A_, so a
     comparator that quietly added a name tie-break rearranges them and fails
     rather than agreeing with the expected order by coincidence. */
  const epics = [
    epic('B-1', 'Automated', ['Z_BUSY', 'TrueTest']),
    epic('B-2', 'Automated', ['Z_BUSY', 'TrueTest']),
    epic('B-3', 'Automated', ['A_QUIET', 'TrueTest']),
  ];
  const items = [
    story('b-a', 'B-1', ['Z_BUSY']), story('b-b', 'B-2', ['Z_BUSY']),
    story('b-c', 'B-3', ['A_QUIET']),
  ];
  const r = await renderSprintClickable(
    payloadFor(items, epics, { componentPriority: { Z_BUSY: 1, A_QUIET: 1 } }));
  const sec = r.html.slice(r.html.indexOf('>Test cases by component<'));
  const body = sec.slice(sec.indexOf('<tbody>'), sec.indexOf('</tbody>'));
  const order = [...body.matchAll(/>(Z_BUSY|A_QUIET)</g)].map(m => m[1])
    .filter((v, i, a) => a.indexOf(v) === i);
  assert.deepStrictEqual(order, ['Z_BUSY', 'A_QUIET'],
    'two components at the same priority lost the busiest-first tie-break');
});

check('PER-COMPONENT PROGRESS KEEPS BIGGEST-FIRST INSIDE ONE PRIORITY', () => {
  /* ITS OWN ITEM ORDER, against the grain. The shared sprint fixture happens
     to list its heaviest component first, so a check over it passes whether or
     not the biggest-first sort is still there — dropping that sort entirely
     killed nothing. Here the LIGHT component's story comes first, so insertion
     order and points order disagree and only the real sort satisfies this. */
  const epics = [
    epic('W-LIGHT', 'Automated', ['C_LIGHT']),
    epic('W-HEAVY', 'Automated', ['C_HEAVY']),
  ];
  const items = [
    { ...story('w-1', 'W-LIGHT', ['C_LIGHT']), points: 1 },
    { ...story('w-2', 'W-HEAVY', ['C_HEAVY']), points: 13 },
  ];
  const payload = payloadFor(items, epics, { componentPriority: { C_LIGHT: 1, C_HEAVY: 1 } });
  const rows = payload.byComponent.rows.filter(r => r.component.startsWith('C_'));
  assert.strictEqual(rows.length, 2, `expected both components, got ${rows.map(r => r.component).join(', ')}`);
  assert.strictEqual(rows[0].component, 'C_HEAVY',
    `the heavier component does not lead its priority level: ${rows.map(r => `${r.component} ${r.points}`).join(', ')}`);
  assert.ok(rows[0].points > rows[1].points, 'fixture check: the two must differ in points');
});

check('AND THE PROGRESS TABLE PUTS THE UNJUDGED LAST', () => {
  /* The heaviest is deliberately the unjudged one, so the old
     biggest-commitment-first order and the new one are in direct conflict. */
  const epics = [
    epic('W-A', 'Automated', ['C_JUDGED']),
    epic('W-B', 'Automated', ['C_UNJUDGED']),
  ];
  const items = [
    { ...story('w-3', 'W-A', ['C_JUDGED']), points: 1 },
    { ...story('w-4', 'W-B', ['C_UNJUDGED']), points: 21 },
  ];
  const payload = payloadFor(items, epics, { componentPriority: { C_JUDGED: 3 } });
  const rows = payload.byComponent.rows.filter(r => r.component.startsWith('C_'));
  assert.strictEqual(rows[rows.length - 1].component, 'C_UNJUDGED',
    `the unjudged component is not last: ${rows.map(r => `${r.priorityLabel || '—'} ${r.component}`).join(' → ')}`);
  const heaviest = rows.slice().sort((a, b) => b.points - a.points)[0];
  assert.strictEqual(heaviest.component, 'C_UNJUDGED',
    'fixture check: the unjudged one must be heaviest or the two orders do not conflict');
});

check('THE BY-TOOL TABLE SORTS BY PRIORITY, like the table above it', async () => {
  /* His request. The combined table has always been sortable; this one opted
     out wholesale because its banded header cannot map every column. The
     opt-out now sits on the two BAND headings instead, which is the smallest
     thing that makes Priority work and keeps the bands from ordering the table
     by a column they do not name. */
  const r = await renderSprintClickable(prioPayload());
  const sec = r.html.slice(r.html.indexOf('Test cases by component — by tool'));
  const table = sec.slice(sec.indexOf('<table'), sec.indexOf('</table>'));

  assert.ok(!/<table[^>]*\sdata-nosort/.test(table),
    'the table still opts out of sorting entirely, so Priority cannot be clicked');
  const head = table.slice(table.indexOf('<thead>'), table.indexOf('</thead>'));
  const firstRow = head.slice(head.indexOf('<tr>'), head.indexOf('</tr>'));
  for (const band of ['TrueTest', 'KSE']) {
    const th = firstRow.match(new RegExp(`<th[^>]*>(?:(?!</th>).)*${band}</th>`, 's'));
    assert.ok(th, `no ${band} band heading`);
    assert.match(th[0], /data-nosort/,
      `the ${band} band is a sort control — it would order the table by ${band}'s Automated column`);
  }
});

check('AND ITS PRIORITY COLUMN LINES UP WITH THE HEADING, by index', async () => {
  /* THE FAILURE THE OPT-OUT EXISTS FOR, stated as the thing that would break
     it: sorting maps a heading to a body column by POSITION. Insert one column
     before Priority in the header or in the body and the heading silently
     orders the table by its neighbour — no error, no sign on screen. */
  const r = await renderSprintClickable(prioPayload());
  const sec = r.html.slice(r.html.indexOf('Test cases by component — by tool'));
  const head = sec.slice(sec.indexOf('<thead>'), sec.indexOf('</thead>'));
  const firstRow = head.slice(head.indexOf('<tr>'), head.indexOf('</tr>'));
  const headings = [...firstRow.matchAll(/<th[^>]*>((?:(?!<\/th>).)*)<\/th>/gs)]
    .map(m => m[1].replace(/<[^>]*>/g, '').trim());
  assert.strictEqual(headings[0], 'Component', `header cell 0 is "${headings[0]}"`);
  assert.strictEqual(headings[1], 'Priority', `header cell 1 is "${headings[1]}"`);

  const body = sec.slice(sec.indexOf('<tbody>'), sec.indexOf('</tbody>'));
  const firstBody = body.slice(body.indexOf('<tr>'), body.indexOf('</tr>'));
  const cells = [...firstBody.matchAll(/<td[^>]*>((?:(?!<\/td>).)*)<\/td>/gs)];
  assert.ok(cells.length >= 2, 'the body row has fewer cells than the header');
  assert.match(cells[1][0], /data-sort-value=/,
    'the priority cell carries no sort value, so the column sorts by its rendered label');
  /* AND THE VALUE IS THE ONE THAT SORTS UNJUDGED LAST — the same rule the
     combined table uses, so the two behave alike under the same click. */
  const v = cells[1][0].match(/data-sort-value="([^"]*)"/)[1];
  assert.ok(/^[1-4]$|^—$/.test(v), `the priority sort value is "${v}"`);
});

check('AND BOTH TABLES SORT PRIORITY THE SAME WAY', async () => {
  /* "The same as the table above" is the request, so the two have to agree on
     what a priority cell sorts by — not merely both be clickable. */
  const r = await renderSprintClickable(prioPayload());
  const valuesIn = (from) => {
    const sec = r.html.slice(r.html.indexOf(from));
    const body = sec.slice(sec.indexOf('<tbody>'), sec.indexOf('</tbody>'));
    return [...body.matchAll(/data-sort-value="([^"]*)"/g)].map(m => m[1]);
  };
  const combined = valuesIn('>Test cases by component<');
  const byTool = valuesIn('Test cases by component — by tool');
  assert.ok(combined.length, 'the combined table carries no priority sort values');
  assert.deepStrictEqual(byTool, combined,
    'the two tables sort priority by different values, so one click orders them differently');
});

/* ── THE DRAWER MUST NOT CLAIM AN ABSENCE IT WAS NEVER TOLD ABOUT ──────
   He opened the In flight marker on PS_iGO_Columbus and read "Automation
   Status is Blocked — nothing is linked in Jira, so there is no ticket to
   chase" under AUTOKAT-10663, which is blocked by CLICMNTIGO-11567 in Jira.

   The note renders from the ROW's own `blockedBy`, and the catalogue was never
   given the field — so a row that had never been told about its blockers
   looked exactly like a row that has none, and the panel stated the second.
   That is worse than saying nothing: it sends somebody away from a defect
   there was every reason to chase. */

const LINK_EPICS = [
  ...EPICS,
  epic('E-LINKED', 'Blocked', ['PS_L', 'TrueTest'], {
    blockedBy: [{ key: 'CLICMNTIGO-11567', summary: 'UWRE Bootstrap passes BirthState as an abbreviation', type: 'Defect' }],
  }),
  epic('E-BARE', 'Blocked', ['PS_L', 'TrueTest']),
];
const LINK_ITEMS = [
  story('l-1', 'E-LINKED', ['PS_L']),
  story('l-2', 'E-BARE', ['PS_L']),
];

check('THE CATALOGUE CARRIES THE BLOCKERS, not just the status', () => {
  const t = insights.testCaseSummary(LINK_ITEMS, store(LINK_EPICS));
  const e = t.catalogue['E-LINKED'];
  assert.ok(e, 'the epic is not in the catalogue at all');
  assert.deepStrictEqual((e.blockedBy || []).map(b => b.key), ['CLICMNTIGO-11567'],
    'the drawer is never told what blocks it, so it reports that nothing does');
  assert.strictEqual(e.blockedBy[0].summary, 'UWRE Bootstrap passes BirthState as an abbreviation',
    'the blocker arrives as a bare key — the summary is what says whether to chase it');

  /* AND THE FIELD EXISTS EVEN WHEN EMPTY, so "no blockers" is a value the
     drawer was given rather than a field nobody set. */
  assert.deepStrictEqual(t.catalogue['E-BARE'].blockedBy, [],
    'an epic with no blockers carries no blockedBy field at all');
});

check('AND THE DRAWER NAMES THE BLOCKER instead of denying there is one', async () => {
  const r = await renderSprintClickable(payloadFor(LINK_ITEMS, LINK_EPICS));
  const d = r.click({ act: 'drill', scope: 'PS_L', col: 'attention' });
  assert.ok(d.includes('E-LINKED'), 'precondition: the flagged epic is in the drawer');
  assert.match(d, /CLICMNTIGO-11567/, 'the blocker is not named');
  assert.match(d, /Blocked by/, 'the row does not say it is blocked by anything');
  assert.match(d, /UWRE Bootstrap/, 'the blocker has no summary to judge it by');
});

check('AND IT STILL SAYS SO when there genuinely is nothing linked', async () => {
  /* The other half. "Blocked with nothing recorded" is a real and useful
     state — the fix must not silence it, only stop it being claimed about
     rows that were never asked. */
  const r = await renderSprintClickable(payloadFor([story('l-2', 'E-BARE', ['PS_L'])], LINK_EPICS));
  const d = r.click({ act: 'drill', scope: 'PS_L', col: 'attention' });
  assert.ok(d.includes('E-BARE'), 'precondition: the bare epic is in the drawer');
  assert.match(d, /nothing is linked in Jira/i,
    'a genuinely unlinked blocked epic no longer explains itself');
});

check('AND NO FLAGGED EPIC IS DESCRIBED AS UNLINKED WHILE CARRYING LINKS', async () => {
  /* The sweep, because this failed silently once: every row the panel marks
     Blocked is checked against what the model knows about it, rather than
     trusting one example. */
  const r = await renderSprintClickable(payloadFor(LINK_ITEMS, LINK_EPICS));
  const payload = payloadFor(LINK_ITEMS, LINK_EPICS);
  const d = r.click({ act: 'drill', scope: 'PS_L', col: 'attention' });
  const rows = d.split('<div style="padding:11px 0');
  for (const key of (payload.testCases.rows.find(x => x.component === 'PS_L') || {}).keys.attention || []) {
    const block = rows.find(b => b.includes(key));
    assert.ok(block, `${key} is counted but not drawn`);
    const known = (payload.testCases.catalogue[key] || {}).blockedBy || [];
    if (known.length) {
      assert.ok(!/nothing is linked in Jira/i.test(block),
        `${key} is blocked by ${known.map(b => b.key).join(', ')} and the drawer says nothing is linked`);
    }
  }
});

/* ── run ───────────────────────────────────────────────────────────── */

/* ── IN FLIGHT, BUT NOT GOING ANYWHERE ──────────────────────────────────
   "In flight" means only "not Automated yet", which puts three different
   situations in one number: work genuinely in progress, work whose Automation
   Status reads Blocked, and suites somebody retired with an `obsolete` label.
   Read as progress, the column overstates what the sprint is moving.

   THE FIXTURE MIRRORS HIS BOARD, where all four cases are live: one epic
   Blocked with no label, one labelled obsolete with no status at all, and two
   that are BOTH Blocked and obsolete. */
const FLAG_EPICS = [
  ...EPICS,
  epic('E-BLOCKED', 'Blocked', ['PS_F']),
  epic('E-OBS', null, ['PS_F'], { labels: ['obsolete'] }),
  epic('E-BOTH', 'Blocked', ['PS_F'], { labels: ['NLG-iGO_Life', 'obsolete'] }),
  epic('E-OBS-WITH-STATUS', 'Ready for Automation', ['PS_F'], { labels: ['obsoleted'] }),
  epic('E-MOVING', 'Ready for Automation', ['PS_F']),
  epic('E-DONE-OBS', 'Automated', ['PS_F'], { labels: ['obsolete'] }),
];
const FLAG_ITEMS = [
  story('F-1', 'E-BLOCKED', ['PS_F']),
  story('F-2', 'E-OBS', ['PS_F']),
  story('F-3', 'E-BOTH', ['PS_F']),
  story('F-4', 'E-OBS-WITH-STATUS', ['PS_F']),
  story('F-5', 'E-MOVING', ['PS_F']),
  story('F-6', 'E-DONE-OBS', ['PS_F']),
];
const flagged = () => insights.testCaseSummary(FLAG_ITEMS, store(FLAG_EPICS));

check('AN IN-FLIGHT SUITE THAT IS BLOCKED OR RETIRED IS FLAGGED', () => {
  const t = flagged();
  const row = t.rows.find(r => r.component === 'PS_F');
  assert.strictEqual(row.inFlight, 5, 'fixture check: five of the six epics are not Automated');
  assert.deepStrictEqual(row.keys.attention.slice().sort(),
    ['E-BLOCKED', 'E-BOTH', 'E-OBS', 'E-OBS-WITH-STATUS'],
    'the flagged set is not the four that are stuck or retired');
  assert.strictEqual(row.attention, 4, 'the count and the key list disagree');
});

check('AND IT IS A SUBSET OF IN FLIGHT, never a column of its own', () => {
  /* The marker qualifies the number beside it. If it ever counted something
     the In flight number does not, "4 in flight, 5 of them stuck" would be on
     screen and the table would be unreadable. */
  const t = flagged();
  const row = t.rows.find(r => r.component === 'PS_F');
  assert.ok(row.attention <= row.inFlight, `${row.attention} flagged out of ${row.inFlight} in flight`);
  for (const k of row.keys.attention) {
    assert.ok(row.keys.inFlight.includes(k), `${k} is flagged but is not in flight`);
  }
});

check('AN AUTOMATED SUITE IS NOT FLAGGED, however it is labelled', () => {
  /* E-DONE-OBS is Automated AND labelled obsolete. It is finished, so it is
     not in flight, so there is nothing to flag — a marker there would send
     somebody to look at work that is done. */
  const t = flagged();
  const row = t.rows.find(r => r.component === 'PS_F');
  assert.ok(row.keys.automated.includes('E-DONE-OBS'), 'fixture check: it is automated');
  assert.ok(!row.keys.attention.includes('E-DONE-OBS'), 'a finished suite was flagged as going nowhere');
  assert.ok(!row.keys.attention.includes('E-MOVING'), 'a suite genuinely in progress was flagged');
});

check('AND A RETIRED SUITE THAT KEPT A REAL STATUS IS STILL FLAGGED', () => {
  /* THE CASE `bucketOf` ALONE CANNOT SEE. An epic labelled obsolete that also
     carries a real Automation Status comes back in THAT status by design — so
     `bucketOf` says "ready" for E-OBS-WITH-STATUS and never says "obsoleted".
     Asking only that question would have missed it, silently, and this is the
     shape his board actually has. */
  const t = flagged();
  const row = t.rows.find(r => r.component === 'PS_F');
  assert.strictEqual(cov.bucketOf({ automationStatus: 'Ready for Automation', labels: ['obsoleted'] }), 'ready',
    'precondition: the shared classifier reports the status, not the label');
  assert.ok(row.keys.attention.includes('E-OBS-WITH-STATUS'),
    'a retired suite that kept a status was not flagged');
});

check('THE REASON TRAVELS WITH THE KEY, in the epic\'s own words', () => {
  /* The drawer has to say WHY, and quote Jira rather than paraphrase it:
     "Automation Status is Blocked" can be checked against the ticket. */
  const t = flagged();
  const why = t.attentionReasons || {};
  assert.deepStrictEqual(why['E-BLOCKED'].why, ['blocked']);
  assert.strictEqual(why['E-BLOCKED'].automationStatus, 'Blocked');
  assert.deepStrictEqual(why['E-OBS'].why, ['obsolete']);
  assert.deepStrictEqual(why['E-OBS'].labels, ['obsolete']);

  /* BOTH REASONS, NOT THE FIRST ONE. Blocked means chase it; obsolete means it
     should not be in flight at all. A note showing only one would send
     somebody to unblock a suite that was retired months ago. */
  assert.deepStrictEqual(why['E-BOTH'].why, ['blocked', 'obsolete'],
    'an epic that is both only reported one reason');
  assert.ok(why['E-BOTH'].labels.includes('obsolete'), 'the labels did not travel');
  assert.strictEqual(why['E-MOVING'], undefined, 'a suite in progress carries a reason');
});

check('AND THE CATALOGUE CARRIES WHAT THE DRAWER NEEDS TO SAY IT', () => {
  /* The drawer marks each row from the row's OWN fields, so an entry without
     them can name the epic and say nothing about it. */
  const t = flagged();
  const e = t.catalogue['E-BOTH'];
  assert.ok(e, 'the flagged epic is not in the catalogue');
  assert.strictEqual(e.automationStatus, 'Blocked', 'the catalogue drops the automation status');
  assert.ok((e.labels || []).includes('obsolete'), 'the catalogue drops the labels');
});

check('AND THE SPRINT TOTAL COUNTS EACH SUITE ONCE', () => {
  /* An epic in two components is in two rows. Adding the rows would report it
     twice — the trap every other total on this table documents. */
  const items = [...FLAG_ITEMS, story('F-7', 'E-BOTH', ['PS_G'])];
  const epics = FLAG_EPICS.map(e => (e.key === 'E-BOTH' ? { ...e, components: ['PS_F', 'PS_G'] } : e));
  const t = insights.testCaseSummary(items, store(epics));
  const rows = t.rows.filter(r => r.component === 'PS_F' || r.component === 'PS_G');
  assert.strictEqual(rows.reduce((n, r) => n + r.attention, 0), 5, 'fixture check: the rows double-count it');
  assert.strictEqual(t.totals.attention, 4, 'the sprint total counted one suite twice');
  assert.deepStrictEqual(t.totals.keys.attention.slice().sort(),
    ['E-BLOCKED', 'E-BOTH', 'E-OBS', 'E-OBS-WITH-STATUS']);
});

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
