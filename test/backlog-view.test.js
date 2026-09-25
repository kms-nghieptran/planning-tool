'use strict';
/**
 * backlog-view.test.js — the Backlog Items table, as rendered.
 *
 * WHY THIS SUITE EXISTS
 *
 * The Items table is FILTERED, and its "Open in Jira" link is the one control
 * on the page whose meaning depends on that. A link built from the whole
 * backlog while the table shows nine rows is not slightly wrong — it opens a
 * different set from the one the reader is looking at, renders perfectly, and
 * there is nothing on screen to say which of the two is the answer.
 *
 * So these checks render the real view against a real payload and read the
 * HTML, then drive the filters through the handlers the view itself wired and
 * read it again.
 *
 * Run: node test/backlog-view.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nThe Backlog Items table, as rendered\n');

const PUBLIC = path.join(__dirname, '..', 'public');
const BASE = 'https://ipipelinejira.atlassian.net';

/* ── a backlog shaped like his ────────────────────────────────────────────
   Two components, two categories, some unestimated and one blocked, so every
   filter the table offers actually cuts the set. */

const item = (key, o = {}) => ({
  key, summary: o.summary || `Work ${key}`, issueType: 'Story',
  category: o.category || 'new', components: o.components || ['R&D_iGO_E2E'],
  points: 'points' in o ? o.points : 3, assignee: o.assignee || 'Hien Phan',
  priority: o.priority || 'Medium', status: 'Open',
});

const ITEMS = [
  item('B-1'),
  item('B-2', { category: 'maintenance' }),
  item('B-3', { components: ['KAT_Common_Maintenance'] }),
  item('B-4', { points: null }),                       // no estimate
  item('B-5', { assignee: null }),                     // no owner
  item('B-6', { category: 'maintenance', points: null }),
  item('B-7'),                                          // blocked, below
];

const PAYLOAD = {
  teamName: 'Katalon Ruby', source: 'board', basis: 'the board backlog',
  total: ITEMS.length, points: 15, runway: 2, avgVelocity: 8,
  items: ITEMS,
  ready: { points: 12, count: 5, sprints: 2 },
  unestimated: { count: 2, pct: 28 },
  estimated: { pct: 72 },
  blocked: { count: 1, items: [{ key: 'B-7' }] },
  assigned: { count: 6, pct: 85 },
  highPriority: { count: 0, points: 0 },
  mix: { byCategory: { new: { points: 9, share: 60 }, maintenance: { points: 6, share: 40 } } },
  byComponent: [{ key: 'R&D_iGO_E2E', points: 9 }, { key: 'KAT_Common_Maintenance', points: 3 }],
};

const STATE = {
  teamId: 'ruby',
  categories: { new: { label: 'New implementation' }, maintenance: { label: 'Maintenance' } },
};

/* ── the harness ──────────────────────────────────────────────────────────
   A DOM thin enough to read but real enough that the view's own wiring runs:
   the filter controls have to hand back the handlers the view registers, or a
   check "drives the filters" without driving anything. */

function fakeEl(id) {
  const on = {};
  return {
    id, value: '', dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener(type, fn) { (on[type] = on[type] || []).push(fn); },
    fire(type, e = {}) { for (const fn of on[type] || []) fn({ target: this, preventDefault() {}, ...e }); },
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ''; },
  };
}

async function renderBacklog(payload = PAYLOAD) {
  const nodes = new Map();
  const get = (sel) => {
    if (!nodes.has(sel)) nodes.set(sel, fakeEl(sel));
    return nodes.get(sel);
  };
  // The state chips and category chips are sets, so they need their own nodes.
  const many = new Map();
  const getAll = (sel) => {
    if (!many.has(sel)) {
      const keys = sel === '[data-state]' ? ['ready', 'unestimated', 'blocked', 'unassigned']
        : sel === '[data-cat]' ? ['new', 'maintenance'] : [];
      many.set(sel, keys.map(k => {
        const n = fakeEl(sel);
        n.dataset = sel === '[data-state]' ? { state: k } : { cat: k };
        return n;
      }));
    }
    return many.get(sel);
  };

  let mountHtml = '';
  const mount = {
    style: {},
    addEventListener() {},
    querySelector: (sel) => get(sel),
    querySelectorAll: (sel) => getAll(sel),
    set innerHTML(v) { mountHtml = v; }, get innerHTML() { return mountHtml; },
  };

  const ctx = {
    console, Promise, setTimeout, clearTimeout, encodeURIComponent,
    Charts: new Proxy({}, { get: () => () => '' }),
    document: { createElement: () => fakeEl('x'), querySelector: () => fakeEl('x'), querySelectorAll: () => [] },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(PUBLIC, 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);
  ctx.UI.setJiraBase(BASE);
  ctx.UI.api = async () => payload;
  vm.runInContext(`${fs.readFileSync(path.join(PUBLIC, 'views', 'backlog.js'), 'utf8')}\n;globalThis.__v = BacklogView;`, ctx);

  await ctx.__v.render(STATE, mount);
  return {
    ctx,
    page: () => mountHtml,
    table: () => get('#blTable').innerHTML,
    search: get('#blSearch'),
    chips: getAll('[data-state]'),
    cats: getAll('[data-cat]'),
  };
}

/** The keys a built issue-navigator URL names. */
const keysOf = (html) => {
  const href = (html.match(/href="([^"]*issues\/\?jql=[^"]*)"/) || [])[1] || '';
  const m = decodeURIComponent(href.split('jql=')[1] || '').match(/key in \(([^)]*)\)/);
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean).sort() : [];
};

/* ── the checks ───────────────────────────────────────────────────────── */

check('THE ITEMS TABLE OFFERS A WAY INTO JIRA', async () => {
  const b = await renderBacklog();
  assert.match(b.table(), />Open in Jira</, 'the Items table has no way out to Jira');
  assert.deepStrictEqual(keysOf(b.table()), ITEMS.map(i => i.key).sort(),
    'with no filters on, the link has to open the whole queue');
});

check('AND IT FOLLOWS THE FILTERS — the set on screen, not the whole backlog', async () => {
  /* The failure this file exists for. A link built from `data.items` rather
     than the filtered list opens seven issues while the table shows two, and
     nothing on the page says which is the answer. */
  const b = await renderBacklog();
  b.search.value = 'B-2';
  b.search.fire('input');
  assert.deepStrictEqual(keysOf(b.table()), ['B-2'],
    'the link ignored the search box');

  b.search.value = '';
  b.search.fire('input');
  assert.strictEqual(keysOf(b.table()).length, ITEMS.length, 'clearing the search did not restore the set');
});

check('and it follows the chips too, not just the search box', async () => {
  const b = await renderBacklog();
  const unestimated = b.chips.find(c => c.dataset.state === 'unestimated');
  unestimated.fire('click');
  assert.deepStrictEqual(keysOf(b.table()), ['B-4', 'B-6'], 'the No-estimate filter did not reach the link');

  unestimated.fire('click');   // toggles off
  assert.strictEqual(keysOf(b.table()).length, ITEMS.length, 'toggling the chip off did not restore the set');

  const maint = b.cats.find(c => c.dataset.cat === 'maintenance');
  maint.fire('click');
  assert.deepStrictEqual(keysOf(b.table()), ['B-2', 'B-6'], 'the category filter did not reach the link');
});

check('THE LINK OPENS WHAT THE COUNT SAYS, and the count is what it filtered', async () => {
  // Two numbers on one line; they have to be the same number.
  const b = await renderBacklog();
  const maint = b.cats.find(c => c.dataset.cat === 'maintenance');
  maint.fire('click');
  const html = b.table();
  const said = Number((html.match(/>(\d+) items ·/) || [])[1]);
  assert.strictEqual(said, keysOf(html).length,
    `the line says ${said} items and the link opens ${keysOf(html).length}`);
});

check('A BIG QUEUE OPENS WHAT THE COUNT SAYS, not the 400 rows drawn', async () => {
  /* The table stops drawing at 400 because a table that long helps nobody.
     Jira has no such problem, so the link must open what the COUNT says — and
     with a seven-item fixture the two are identical, which is exactly how a
     `slice(0, 400)` on the link survived a full mutation run unnoticed. */
  const many = Array.from({ length: 500 }, (_, i) => item(`BIG-${String(i).padStart(3, '0')}`));
  const b = await renderBacklog({ ...PAYLOAD, total: many.length, items: many, blocked: { count: 0, items: [] } });
  const html = b.table();
  assert.match(html, /Showing the first 400/, 'fixture check: the table has to be cutting rows');

  const said = Number((html.match(/>(\d+) items ·/) || [])[1]);
  assert.strictEqual(said, 500, 'the count line should report the whole filtered set');
  // `openInJira` has its own URL budget and says how many it opens; what it
  // must NOT do is silently inherit the table's 400.
  const opened = keysOf(html).length;
  assert.ok(opened > 0, 'no link on a 500-item queue');
  assert.notStrictEqual(opened, 400, 'the link inherited the table\'s row cap');
  if (opened < said) assert.match(html, new RegExp(`Open ${opened} in Jira`),
    'a cut list has to say how many it is opening');
});

check('NOTHING MATCHING MEANS NO LINK — not one that opens nothing', async () => {
  const b = await renderBacklog();
  b.search.value = 'nothing-matches-this';
  b.search.fire('input');
  assert.ok(!/Open in Jira/.test(b.table()), 'an empty table offered a link to an empty set');
  assert.match(b.table(), /Nothing matches these filters/);
});

check('the link is on the filtered line, NOT in the section head beside Export CSV', async () => {
  /* Export CSV exports the whole backlog whatever the filters say. A filtered
     link sitting next to it would read as the same scope and be a different
     one — so it belongs on the line that is redrawn with the filters. */
  const b = await renderBacklog();
  const page = b.page();
  const from = page.indexOf('<h2>Items</h2>');
  const to = page.indexOf('<div id="blTable"');
  assert.ok(from > 0 && to > from, 'the Items section has moved — this check has gone stale');
  const head = page.slice(from, to);
  assert.match(head, /Export CSV/, 'fixture check: the head is where Export CSV lives');
  assert.ok(!/Open in Jira/.test(head),
    'the link is in the section head, where it cannot follow the filters');
  assert.match(b.table(), />Open in Jira</, 'and it is missing from the line that can');
});

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
