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
  bucket('M-1', ['PS_A'], ['T-100', 'T-101']),
  bucket('M-2', ['PS_B'], ['T-101']),                   // shares T-101 with M-1
];

check('EVERY COUNT CARRIES THE KEYS IT IS THE COUNT OF', () => {
  const t = insights.testCaseSummary(DRILL_ITEMS, store(EPICS));
  const cols = ['automated', 'inFlight', 'maintained', 'stories', 'buckets', 'items', 'done'];
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
  // A-3 is in two components and T-101 is linked from two bucket stories, so
  // stitching the rows together would list both twice — a list longer than the
  // number above it, which is the one thing a drill-in must never do.
  const stitched = t.rows.reduce((n, r) => n + r.keys.items.length, 0);
  assert.ok(stitched > t.totals.keys.items.length, 'the fixture really does share an item across components');
  assert.strictEqual(new Set(t.totals.keys.items).size, t.totals.keys.items.length, 'no key twice in the sprint list');
  assert.strictEqual(new Set(t.totals.keys.maintained).size, t.totals.keys.maintained.length, 'nor in the maintained list');
  assert.deepStrictEqual([...t.totals.keys.maintained].sort(), ['T-100', 'T-101'], 'T-101 counted once, not twice');
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
    for (const col of ['automated', 'inFlight', 'maintained', 'stories', 'buckets', 'items', 'done']) {
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
  const r = await renderSprintClickable(payloadFor(DRILL_ITEMS));
  const html = r.click({ act: 'drill', scope: '__total', col: 'maintained' });
  assert.match(html, /T-100/, 'the key is shown');
  assert.match(html, /Not in the local store/, 'and said to be unsynced rather than left blank');
  assert.match(html, /2 not synced locally/, 'counted in the header too');
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
