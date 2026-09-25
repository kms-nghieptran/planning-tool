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

/* THE PAGER LIVES INSIDE `#blTable`, which `renderTable` replaces on every
   draw — so its buttons are NEW nodes each time and the view rewires them.
   A harness that cached them by selector would hand the same objects back
   after every redraw, the listeners would stack, and one click would fire
   four times: a difference from the browser that hides the bug it is meant
   to catch. So nodes under `#blTable` are keyed by a generation that the
   table's own innerHTML setter bumps. Controls outside it — the search box,
   the chips — genuinely do survive, and stay cached. */
const INSIDE_TABLE = new Set(['[data-page]', '#blPageSize']);

function bootBacklog() {
  const ctx = {
    console, Promise, setTimeout, clearTimeout, encodeURIComponent,
    Charts: new Proxy({}, { get: () => () => '' }),
    document: { createElement: () => fakeEl('x'), querySelector: () => fakeEl('x'), querySelectorAll: () => [] },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(PUBLIC, 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);
  ctx.UI.setJiraBase(BASE);
  vm.runInContext(`${fs.readFileSync(path.join(PUBLIC, 'views', 'backlog.js'), 'utf8')}\n;globalThis.__v = BacklogView;`, ctx);
  return ctx;
}

async function renderBacklog(payload = PAYLOAD, app = null) {
  let gen = 0;
  const nodes = new Map();
  const table = fakeEl('#blTable');
  let tableHtml = '';
  Object.defineProperty(table, 'innerHTML', {
    get: () => tableHtml,
    set: (v) => { tableHtml = v; gen++; },
  });

  const keyFor = (sel) => (INSIDE_TABLE.has(sel) ? `${sel}@${gen}` : sel);
  const get = (sel) => {
    if (sel === '#blTable') return table;
    const k = keyFor(sel);
    if (!nodes.has(k)) {
      const n = fakeEl(sel);
      // The per-page <select> starts at whatever the pager just rendered.
      if (sel === '#blPageSize') n.value = (tableHtml.match(/<option selected>(\d+)</) || [])[1] || '100';
      nodes.set(k, n);
    }
    return nodes.get(k);
  };

  // The state chips and category chips are sets, so they need their own nodes.
  const many = new Map();
  const getAll = (sel) => {
    const k = keyFor(sel);
    if (!many.has(k)) {
      if (sel === '[data-page]') {
        // Built from the markup the pager actually rendered, disabled flags
        // included — a test that clicks a button the page has disabled is
        // testing something the reader cannot do.
        many.set(k, [...tableHtml.matchAll(/data-page="(\d+)"( disabled)?/g)].map(m => {
          const n = fakeEl(sel);
          n.dataset = { page: m[1] };
          n.disabled = !!m[2];
          return n;
        }));
      } else {
        const keys = sel === '[data-state]' ? ['ready', 'unestimated', 'blocked', 'unassigned']
          : sel === '[data-cat]' ? ['new', 'maintenance'] : [];
        many.set(k, keys.map(x => {
          const n = fakeEl(sel);
          n.dataset = sel === '[data-state]' ? { state: x } : { cat: x };
          return n;
        }));
      }
    }
    return many.get(k);
  };

  let mountHtml = '';
  const mount = {
    style: {},
    addEventListener() {},
    querySelector: (sel) => get(sel),
    querySelectorAll: (sel) => getAll(sel),
    set innerHTML(v) { mountHtml = v; }, get innerHTML() { return mountHtml; },
  };

  /* The module is loaded ONCE per app, not once per render — App re-renders
     this view into a fresh mount every time the team changes, and the view's
     own `page` survives that. A context per render gives each one a brand
     new module with brand new state, which is exactly the condition under
     which a page number leaking between teams is invisible. */
  const ctx = app ? app.ctx : bootBacklog();
  ctx.UI.api = async () => payload;

  await ctx.__v.render(STATE, mount);
  return {
    ctx, app: { ctx },
    page: () => mountHtml,
    table: () => table.innerHTML,
    search: get('#blSearch'),
    chips: getAll('[data-state]'),
    cats: getAll('[data-cat]'),
    /* The buttons the CURRENT draw wired — see the note on INSIDE_TABLE. */
    pageButtons: () => getAll('[data-page]'),
    get pageSize() { return get('#blPageSize'); },
    pageNow: () => Number((table.innerHTML.match(/page (\d+) of /) || [])[1] || 1),
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

/* ── paging ───────────────────────────────────────────────────────────────
   The table used to draw the first 400 rows and say "narrow the filters to
   see the rest", which on his Katalon Automation backlog of 892 items meant
   492 items nobody could reach. It pages now, and these pin the two things
   paging gets wrong: rows you cannot reach, and a page number that outlives
   the list it was chosen for. */

const BIG = (n = 500) => {
  const many = Array.from({ length: n }, (_, i) => item(`BIG-${String(i).padStart(3, '0')}`));
  return { ...PAYLOAD, total: many.length, items: many, blocked: { count: 0, items: [] } };
};
/** The keys actually drawn as table rows. */
const rowKeys = (html) => [...html.matchAll(/>(BIG-\d{3})</g)].map(m => m[1]);
/* The pager offers First / Previous / Next / Last — NOT one button per page,
   which on a twenty-page queue would be a row of numbers wider than the
   table. So reaching page 4 means pressing Next, the same as a reader would,
   rather than a control the page does not have. */
const goTo = (b, n) => {
  for (let guard = 0; guard < 60 && b.pageNow() !== n; guard++) {
    const at = b.pageNow();
    const step = at < n ? at + 1 : at - 1;
    const btn = b.pageButtons().find(x => x.dataset.page === String(step) && !x.disabled)
      || b.pageButtons().find(x => x.dataset.page === String(n) && !x.disabled);
    assert.ok(btn, `no enabled control to move from page ${at} towards ${n}`);
    btn.fire('click');
  }
  assert.strictEqual(b.pageNow(), n, `could not reach page ${n}`);
};

check('UI.paginate CLAMPS a page that outlived its list', async () => {
  /* Tested directly, because through this view it is unreachable: every
     filter calls `refilter`, which resets to page 1, so the clamp never
     fires. That does not make it dead — it makes it the contract of a shared
     helper. `lib/search.js` clamps the same way on the server for the same
     reason, and the next caller will not necessarily remember to reset.

     What it prevents: a page number surviving a filter, the slice landing
     past the end, and the table rendering zero rows — which a reader takes
     to mean "nothing matches" for a filter that matched nine things. */
  const b = await renderBacklog();
  /* `paginate` runs inside the vm context, so what it returns is an Object
     from THAT realm and `deepStrictEqual` compares prototypes. Copied out. */
  const P = (...a) => JSON.parse(JSON.stringify(b.ctx.UI.paginate(...a)));
  const items = Array.from({ length: 892 }, (_, i) => i + 1);

  assert.deepStrictEqual(
    P(items.slice(0, 9), 7, 100),
    { rows: items.slice(0, 9), page: 1, pages: 1, total: 9, from: 1, to: 9 },
    'a page past the end returned an empty slice instead of the last page');

  assert.strictEqual(P(items, 10, 100).page, 9, 'page 10 of 9 was not pulled back');
  assert.strictEqual(P(items, 10, 100).rows.length, 92, 'and it drew nothing');
  for (const bad of [0, -5, null, undefined, NaN, 'x']) {
    assert.strictEqual(P(items, bad, 100).page, 1, `page ${String(bad)} should fall back to the first`);
  }
  // A nonsense size must not divide by zero into Infinity pages.
  for (const bad of [0, -1, null, 'x']) {
    const r = P(items, 1, bad);
    assert.ok(r.pages > 0 && Number.isFinite(r.pages), `page size ${String(bad)} produced ${r.pages} pages`);
  }
  assert.deepStrictEqual(P([], 3, 100), { rows: [], page: 1, pages: 1, total: 0, from: 0, to: 0 },
    'an empty list should report a zero range, not 1–0');
});

check('EVERY ITEM IS REACHABLE — the queue pages instead of stopping at 400', async () => {
  const b = await renderBacklog(BIG(500));
  assert.ok(!/Showing the first 400/.test(b.table()), 'the old row cap is still there');
  assert.match(b.table(), /class="pager"/, 'a 500-item queue has no pager');

  /* Walk every page and collect what was drawn. Nothing may be missing and
     nothing may appear twice — an off-by-one in the slice does both at once,
     and the count line keeps saying 500 either way. */
  const seen = [];
  for (let guard = 0; guard < 50; guard++) {
    seen.push(...rowKeys(b.table()));
    const at = b.pageNow();
    const next = b.pageButtons().find(x => x.dataset.page === String(at + 1) && !x.disabled);
    if (!next) break;
    next.fire('click');
  }
  assert.strictEqual(seen.length, 500, `${seen.length} of 500 rows were reachable across the pages`);
  assert.strictEqual(new Set(seen).size, 500, 'a row appeared on more than one page');
});

check('A BIG QUEUE OPENS WHAT THE COUNT SAYS, not the rows on this page', async () => {
  /* The link opens the whole FILTERED set. Opening only the hundred rows you
     happen to be looking at would change what the button means every time
     you pressed Next — and with a seven-item fixture the two are identical,
     which is how a `slice` on the link survived a mutation run once already. */
  const b = await renderBacklog(BIG(500));
  const html = b.table();
  assert.strictEqual(rowKeys(html).length, 100, 'fixture check: the page has to be a slice');

  const said = Number((html.match(/>(\d+) items ·/) || [])[1]);
  assert.strictEqual(said, 500, 'the count line should report the whole filtered set');
  const opened = keysOf(html).length;
  assert.ok(opened > 0, 'no link on a 500-item queue');
  assert.notStrictEqual(opened, 100, 'the link inherited the page size');
  if (opened < said) assert.match(html, new RegExp(`Open ${opened} in Jira`),
    'a cut list has to say how many it is opening');
});

/* ── the way out to Jira ─────────────────────────────────────────────────
   A key list is exact but finite — it runs out of URL, and his 892-item
   backlog opened 393 of them. The board's backlog view has no limit because
   it NAMES the set rather than listing it, but it can only ever mean the
   whole backlog. So the link follows the filters, and each one has to mean
   exactly what the count beside it says. */

const boardUrlIn = (html) => (html.match(/href="([^"]*RapidBoard[^"]*)"/) || [])[1] || null;

check('UNFILTERED, IT OPENS THE WHOLE BACKLOG — not the 393 keys that fit a URL', async () => {
  const b = await renderBacklog({ ...BIG(892), boardId: 1961 });
  const html = b.table();
  const said = Number((html.match(/>(\d+) items ·/) || [])[1]);
  assert.strictEqual(said, 892, 'fixture check');

  const url = boardUrlIn(html);
  assert.ok(url, 'an 892-item backlog still links by key, so it cannot open all of them');
  assert.match(url, /rapidView=1961/, 'the link does not name this team\'s board');
  assert.match(url, /view=planning/, 'the link opens the board, not its backlog');
  assert.ok(!/issues\/\?jql=/.test(html), 'both links are on the line — only one can be the answer');
  assert.match(html, /all 892 items/, 'nothing tells the reader the link opens the whole backlog');
  // The truncation notice belongs to the key list and must not survive.
  assert.ok(!/Open \d+ in Jira/.test(html), 'a board link should never say it opens only some');
});

check('FILTERED, IT GOES BACK TO KEYS — the only exact answer for a subset', async () => {
  /* A board view cannot be narrowed by a search box or a category chip that
     only exists in this app, so keeping the board link while filtered would
     open 892 items beside a count saying 10. */
  const b = await renderBacklog({ ...BIG(892), boardId: 1961 });
  assert.ok(boardUrlIn(b.table()), 'fixture check: unfiltered starts on the board link');

  b.search.value = 'BIG-01';
  b.search.fire('input');
  const html = b.table();
  assert.ok(!boardUrlIn(html), 'a filtered table still points at the whole board backlog');
  assert.strictEqual(keysOf(html).length, 10, 'the filtered link does not open the filtered set');
  assert.strictEqual(Number((html.match(/>(\d+) items ·/) || [])[1]), 10);

  b.search.value = '';
  b.search.fire('input');
  assert.ok(boardUrlIn(b.table()), 'clearing the filter did not restore the whole-backlog link');
});

check('every filter counts as a filter, not just the search box', async () => {
  const mixed = { ...BIG(500), boardId: 1961 };
  mixed.items = mixed.items.map((i, n) => (n < 300 ? i : { ...i, category: 'maintenance' }));
  const b = await renderBacklog(mixed);
  assert.ok(boardUrlIn(b.table()), 'fixture check');

  b.cats.find(c => c.dataset.cat === 'new').fire('click');
  assert.ok(!boardUrlIn(b.table()), 'a category chip left the board link in place');
  assert.strictEqual(Number((b.table().match(/>(\d+) items ·/) || [])[1]), 300);
});

check('WITH NO BOARD MAPPED it stays on keys, whatever the size', async () => {
  /* Without a board the backlog is a guess from ownership rules — there is no
     Jira view that means the same thing, so the keys remain the honest answer
     even though they truncate. */
  const b = await renderBacklog(BIG(892));      // no boardId
  const html = b.table();
  assert.ok(!boardUrlIn(html), 'a board link appeared for a team with no board');
  assert.ok(keysOf(html).length > 0, 'and no key link either — there is now no way into Jira at all');
  assert.match(html, /Open \d+ in Jira/, 'a truncated key list has to say how many it opens');
});

check('THE PAGER SAYS WHERE YOU ARE IN WHAT', async () => {
  // "1–100 of 500" is what makes a pager trustworthy; "Page 1 of 5" leaves
  // the reader multiplying to find out how much queue there is.
  const b = await renderBacklog(BIG(500));
  assert.match(b.table(), /1–100 of 500 items · page 1 of 5/, 'the pager does not say the range it shows');
  goTo(b, 5);
  assert.match(b.table(), /401–500 of 500 items · page 5 of 5/, 'the last page does not report its own range');
  assert.strictEqual(rowKeys(b.table()).length, 100);
});

check('A FILTER RESETS THE PAGE — and the clamp catches what it does not', async () => {
  /* Two guarantees. Typing while on page 5 puts you back at the top; and if
     a page number ever DID survive a filter, the clamp in `UI.paginate` has
     to render rows anyway rather than an empty table, which a reader would
     take to mean nothing matched. */
  const b = await renderBacklog(BIG(500));
  goTo(b, 5);
  assert.match(b.table(), /page 5 of 5/, 'fixture check: we are on the last page');

  b.search.value = 'BIG-01';      // ten matches, far short of five pages
  b.search.fire('input');
  const html = b.table();
  assert.strictEqual(rowKeys(html).length, 10, 'filtering from a later page lost rows');
  assert.ok(!/class="pager"/.test(html), 'one page of rows does not need a pager');
});

check('AND THE RESET IS REAL, not the clamp doing its work', async () => {
  /* The check above cannot tell the two apart: it narrows to ten rows, so
     page 5 would be clamped to page 1 whether or not anything reset it —
     which is exactly how dropping the reset survived a mutation run.

     So this narrows to a set that STILL spans pages. Land on page 3 of 3 and
     the clamp was all that happened; land on page 1 and the filter genuinely
     took you back to the top, which is where a reader who just changed the
     question expects to be. */
  const mixed = BIG(500);
  mixed.items = mixed.items.map((i, n) => (n < 300 ? i : { ...i, category: 'maintenance' }));
  const b = await renderBacklog(mixed);
  goTo(b, 5);

  const New = b.cats.find(c => c.dataset.cat === 'new');
  New.fire('click');
  assert.strictEqual(rowKeys(b.table()).length, 100, 'fixture check: the filtered set still spans pages');
  assert.match(b.table(), /page 1 of 3/, 'the filter left the reader on a later page of a set they just changed');
  assert.match(b.table(), /1–100 of 300 items/);
});

check('and a fresh payload starts at the top', async () => {
  /* Module state outlives a render: page 3 of Titan's 604 items means nothing
     once the team picker has moved to Ruby's 77. The second render REUSES the
     first one's module — a second context would hand it a fresh `page` and
     the check would pass without proving anything. */
  const b = await renderBacklog(BIG(500));
  goTo(b, 3);
  assert.match(b.table(), /page 3 of 5/);

  const again = await renderBacklog(BIG(500), b.app);
  assert.match(again.table(), /page 1 of 5/, "a new team's backlog opened on the previous team's page");
});

check('changing the page size goes back to the top', async () => {
  /* Row 301 is on a different page once a page holds 25 instead of 100, so
     there is no honest way to keep your place. */
  const b = await renderBacklog(BIG(500));
  goTo(b, 4);
  const size = b.pageSize;
  size.value = '25';
  size.fire('change');
  assert.match(b.table(), /1–25 of 500 items · page 1 of 20/, 'the page size did not take effect');
  assert.strictEqual(rowKeys(b.table()).length, 25);
});

check('the pager is hidden when everything already fits', async () => {
  const b = await renderBacklog();          // the seven-item fixture
  assert.ok(!/class="pager"/.test(b.table()), 'a seven-row table drew a pager');
  // Body rows only — `<tr>` also matches the header, which is how this check
  // first read 8 for a seven-item fixture.
  const body = b.table().slice(b.table().indexOf('<tbody'), b.table().indexOf('</tbody>'));
  assert.strictEqual((body.match(/<tr>/g) || []).length, ITEMS.length,
    'the whole queue should be on one page when it fits');
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
