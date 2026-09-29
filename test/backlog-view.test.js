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
  points: 'points' in o ? o.points : 3,
  /* `'assignee' in o`, NOT `o.assignee || default`. An UNOWNED item is a real
     and important case — it is what the Unassigned chip and the new assignee
     filter are for — and `|| default` silently gives it an owner, so the
     fixture cannot express the thing under test. The same defect the team
     field had in the By component fixture. */
  assignee: 'assignee' in o ? o.assignee : 'Hien Phan',
  priority: o.priority || 'Medium', status: 'Open',
  sprints: o.sprints || [], sprintNames: (o.sprints || []).map(x => x.name),
});

const ITEMS = [
  item('B-1'),
  item('B-2', { category: 'maintenance' }),
  item('B-3', { components: ['KAT_Common_Maintenance'] }),
  item('B-4', { points: null }),                       // no estimate
  item('B-5', { assignee: null }),                     // no owner
  /* ALREADY IN A SPRINT, and in a CLOSED one — the two cases the Sprint cell
     has to tell apart. B-8's open sprint is one this team can pick, so the
     select shows it selected; B-9's only sprint is closed, which is history
     rather than where it is, so the cell reads as Backlog. */
  item('B-6', { category: 'maintenance', points: null }),
  item('B-7'),                                          // blocked, below
  item('B-8', { assignee: 'Anh Truong', sprints: [{ id: '901', name: 'Ruby Sprint 41', state: 'future' }] }),
  item('B-9', { assignee: 'Anh Truong', sprints: [{ id: '890', name: 'Ruby Sprint 39', state: 'closed' }] }),
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
  /* The team's OPEN sprints, as the route sends them: closed ones are left
     out because Jira refuses them, and an option that always fails is worse
     than no option. */
  sprints: [
    { id: 'S40', name: 'Ruby Sprint 40', state: 'active' },
    { id: 'S41', name: 'Ruby Sprint 41', state: 'future' },
  ],
  /* TWO OPEN SPRINTS, BOTH EMPTY — which is not a degenerate fixture, it is
     the state this whole screen is for: the morning of sprint planning, the
     sprints opened and nothing pulled in yet. The sections and the picker
     options are built from the same list on the server, so a fixture where
     one exists without the other could not happen. */
  sections: [
    { id: 'S40', kind: 'sprint', name: 'Ruby Sprint 40', state: 'active', start: '2026-09-01', end: '2026-09-14', count: 0, points: 0, done: 0, donePoints: 0, epicsExcluded: 0, items: [] },
    { id: 'S41', kind: 'sprint', name: 'Ruby Sprint 41', state: 'future', start: '2026-09-15', end: '2026-09-28', count: 0, points: 0, done: 0, donePoints: 0, epicsExcluded: 0, items: [] },
  ],
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
    /* THE FOLD STATE IS KEPT HERE, so the harness needs a store. A real one
       rather than a no-op: "folded, then folded again, is open" is a round
       trip through this, and a stub that swallowed writes would make every
       toggle look like the first one. */
    localStorage: (() => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
      };
    })(),
    document: { createElement: () => fakeEl('x'), querySelector: () => fakeEl('x'), querySelectorAll: () => [] },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(PUBLIC, 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);
  ctx.UI.setJiraBase(BASE);
  vm.runInContext(`${fs.readFileSync(path.join(PUBLIC, 'views', 'backlog.js'), 'utf8')}\n;globalThis.__v = BacklogView;`, ctx);
  return ctx;
}

/* A FRESH COPY PER RENDER. The view owns the payload it is handed — moving a
   row takes it off `data.items`, which is the right behaviour in the app
   (every render fetches) and a shared mutable fixture here: the first check
   that moved a row deleted it for every check after. Cloned rather than
   rebuilt, so a caller passing its own payload still gets isolation. */
const clone = (v) => JSON.parse(JSON.stringify(v));

async function renderBacklog(payload = PAYLOAD, app = null, st = STATE) {
  payload = clone(payload);
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
  /* THE SPRINT PICKER IS DELEGATED to the mount — the table is rebuilt on
     every filter keystroke and page turn, so a handler on the select would go
     with the markup that replaced it. A harness that swallowed mount
     listeners could not test the move at all, which is how the second-move
     bug hides. */
  const mountOn = {};
  const mount = {
    style: {},
    addEventListener(type, fn) { (mountOn[type] = mountOn[type] || []).push(fn); },
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
  const puts = [];
  let failPut = null;
  ctx.UI.jsonPut = async (url, body) => {
    puts.push({ url, body });
    if (failPut) throw new Error(failPut);
    return { ok: true, key: body.key, sprintId: body.sprintId, sprint: (payload.sprints.find(x => x.id === body.sprintId) || {}).name || null };
  };
  ctx.UI.toast = () => {};

  await ctx.__v.render(st, mount);
  return {
    ctx, app: { ctx }, puts, failPut: (m) => { failPut = m; },
    /** Change one row's Sprint select, as the browser would. */
    async moveSprint(key, toId, wasName) {
      const node = {
        dataset: { sprintKey: key, was: wasName == null ? '' : wasName },
        value: toId == null ? '' : toId,
        disabled: false,
      };
      node.closest = (sel) => (sel === '[data-sprint-key]' ? node : null);
      for (const fn of mountOn.change || []) await fn({ target: node, preventDefault() {} });
      return node;
    },
    /* FOLD ONE SECTION, as a click on its twisty would. Delegated on the
       mount, so the handler is fed a target whose `closest` answers — the
       same shape the sprint picker uses, and for the same reason: the button
       that was clicked is gone by the time the redraw finishes. */
    fold(id) {
      const node = { dataset: { fold: String(id) } };
      node.closest = (sel) => (sel === '[data-fold]' ? node : null);
      for (const fn of mountOn.click || []) fn({ target: node, preventDefault() {} });
      return node;
    },
    /** Drag one row onto a section, start to drop, as the browser fires it. */
    async drag(key, toSection) {
      const cls = () => ({ add() {}, remove() {}, contains: () => false });
      const row = { dataset: { rowKey: key }, classList: cls() };
      row.closest = (sel) => (sel === '[data-row-key]' ? row : null);
      const sec = { dataset: { sec: String(toSection) }, classList: cls() };
      sec.closest = (sel) => (sel === '[data-sec]' ? sec : null);
      const dt = { setData() {} };
      let allowed = false;
      for (const fn of mountOn.dragstart || []) fn({ target: row, dataTransfer: dt, preventDefault() {} });
      for (const fn of mountOn.dragover || []) fn({ target: sec, dataTransfer: dt, preventDefault() { allowed = true; } });
      for (const fn of mountOn.drop || []) await fn({ target: sec, dataTransfer: dt, preventDefault() {} });
      return { allowed };
    },
    page: () => mountHtml,
    table: () => table.innerHTML,
    /** One section's markup, head and body — `backlog` or a sprint id. */
    sec(id) {
      const html = table.innerHTML;
      const at = html.indexOf(`data-sec="${id}"`);
      if (at < 0) return '';
      const from = html.lastIndexOf('<section', at);
      const next = html.indexOf('<section', at);
      return html.slice(from, next < 0 ? html.length : next);
    },
    /** The backlog section alone — what every check about "the queue" means. */
    queue() { return this.sec('backlog'); },
    search: get('#blSearch'),
    assignee: get('#blAssignee'),
    chips: getAll('[data-state]'),
    cats: getAll('[data-cat]'),
    /* The buttons the CURRENT draw wired — see the note on INSIDE_TABLE. */
    pageButtons: () => getAll('[data-page]'),
    get pageSize() { return get('#blPageSize'); },
    pageNow: () => Number((table.innerHTML.match(/page (\d+) of /) || [])[1] || 1),
  };
}

/**
 * HOW MANY ROWS A SECTION HEAD SAYS IT IS SHOWING.
 *
 * The head reads "9 items · 15 pts" unfiltered and "2 of 9 items · 6 pts"
 * once a filter is on — both numbers, because a head that reported only the
 * filtered one would make the page disagree with the sidebar the moment
 * anybody typed in the search box. The SHOWN count is the one that has to
 * match the link beside it, so that is what this returns.
 */
const saidCount = (html) => {
  const m = html.match(/>(?:(\d+) of )?(\d+) items ·/);
  return m ? Number(m[1] != null ? m[1] : m[2]) : NaN;
};

/** The keys a built issue-navigator URL names. */
const keysOf = (html) => {
  const href = (html.match(/href="([^"]*issues\/\?jql=[^"]*)"/) || [])[1] || '';
  const m = decodeURIComponent(href.split('jql=')[1] || '').match(/key in \(([^)]*)\)/);
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean).sort() : [];
};

/* ── the checks ───────────────────────────────────────────────────────── */

check('THE ITEMS TABLE OFFERS A WAY INTO JIRA', async () => {
  const b = await renderBacklog();
  assert.match(b.queue(), />Open in Jira</, 'the queue has no way out to Jira');
  assert.deepStrictEqual(keysOf(b.queue()), ITEMS.map(i => i.key).sort(),
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
  /* THE QUEUE'S OWN SECTION, not the whole board. Every section head now
     carries a count and a link of its own; reading the first one off the
     page would compare a sprint's number against the backlog's link. */
  const html = b.queue();
  const said = saidCount(html);
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
  const html = b.queue();
  assert.strictEqual(rowKeys(html).length, 100, 'fixture check: the page has to be a slice');

  const said = saidCount(html);
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

const jqlIn = (html) => {
  const href = (html.match(/href="([^"]*issues\/\?jql=[^"]*)"/) || [])[1] || '';
  return decodeURIComponent(href.split('jql=')[1] || '');
};
const FILTER = { filterId: 12345, type: 'scrum', boardId: 1961 };

check('UNFILTERED, IT OPENS A JIRA FILTER FOR THE WHOLE BACKLOG', async () => {
  /* What a key list could never do. 892 keys is roughly 11,600 characters,
     so the link truncated to the 393 that fit; naming the board's saved
     filter instead is 159 characters at any size. */
  const b = await renderBacklog({ ...BIG(892), boardId: 1961, boardFilter: FILTER });
  const html = b.queue();
  assert.strictEqual(saidCount(html), 892, 'fixture check');

  const jql = jqlIn(html);
  assert.match(jql, /filter = 12345/, 'the link does not name the board\'s saved filter');
  assert.match(jql, /sprint IS EMPTY/, 'the search would include work already in a sprint');
  assert.match(jql, /statusCategory != Done/, 'the search would include finished work');
  assert.match(jql, /ORDER BY Rank ASC/, 'a backlog opened out of rank order is not a backlog');
  assert.ok(!/key in \(/.test(jql), 'it is still enumerating keys');
  assert.match(html, /all 892 items/, 'nothing tells the reader the link opens the whole backlog');
  // The truncation notice belongs to the key list and must not survive.
  assert.ok(!/Open \d+ in Jira/.test(html), 'a whole-backlog link should never say it opens only some');
});

check('and the URL stays short however big the backlog gets', async () => {
  /* The property that makes this the right answer rather than a bigger URL
     budget: the length does not depend on the number of items at all. */
  const small = await renderBacklog({ ...BIG(10), boardId: 1961, boardFilter: FILTER });
  const huge = await renderBacklog({ ...BIG(892), boardId: 1961, boardFilter: FILTER });
  const href = (html) => (html.match(/href="([^"]*issues\/\?jql=[^"]*)"/) || [])[1] || '';
  assert.strictEqual(href(small.queue()), href(huge.queue()),
    'the link changes with the number of items, so it is describing them rather than the set');
  assert.ok(href(huge.queue()).length < 400, `the link is ${href(huge.queue()).length} characters`);
});

check('BEFORE A SYNC HAS READ A FILTER ID, it falls back to the board view', async () => {
  /* `boardFilter` is null until the next full sync. That must not put the
     screen back to a truncated key list — the board's own backlog view is
     still the whole set. */
  const b = await renderBacklog({ ...BIG(892), boardId: 1961 });      // no boardFilter
  const html = b.queue();
  assert.ok(!jqlIn(html), 'it built a filter search with no filter id');
  const url = boardUrlIn(html);
  assert.ok(url, 'an 892-item backlog fell back to keys, so it cannot open all of them');
  assert.match(url, /rapidView=1961/, "the link does not name this team's board");
  assert.match(url, /view=planning/, 'the link opens the board, not its backlog');
  assert.match(html, /all 892 items/);
});

check('FILTERED, IT GOES BACK TO KEYS — the only exact answer for a subset', async () => {
  /* A board view cannot be narrowed by a search box or a category chip that
     only exists in this app, so keeping the board link while filtered would
     open 892 items beside a count saying 10. */
  const b = await renderBacklog({ ...BIG(892), boardId: 1961, boardFilter: FILTER });
  assert.ok(jqlIn(b.queue()).includes('filter = 12345'), 'fixture check: unfiltered starts on the filter search');

  b.search.value = 'BIG-01';
  b.search.fire('input');
  const html = b.queue();
  assert.ok(!/filter = 12345/.test(jqlIn(html)), 'a filtered table still points at the whole backlog');
  assert.ok(!boardUrlIn(html), 'a filtered table still points at the board backlog view');
  assert.strictEqual(keysOf(html).length, 10, 'the filtered link does not open the filtered set');
  assert.strictEqual(saidCount(html), 10);

  b.search.value = '';
  b.search.fire('input');
  assert.ok(jqlIn(b.queue()).includes('filter = 12345'), 'clearing the filter did not restore the whole-backlog link');
});

check('every filter counts as a filter, not just the search box', async () => {
  const mixed = { ...BIG(500), boardId: 1961, boardFilter: FILTER };
  mixed.items = mixed.items.map((i, n) => (n < 300 ? i : { ...i, category: 'maintenance' }));
  const b = await renderBacklog(mixed);
  assert.ok(jqlIn(b.queue()).includes('filter = 12345'), 'fixture check');

  b.cats.find(c => c.dataset.cat === 'new').fire('click');
  assert.ok(!/filter = 12345/.test(jqlIn(b.queue())), 'a category chip left the whole-backlog link in place');
  assert.strictEqual(saidCount(b.queue()), 300);
});

check('WITH NO BOARD AND NO FILTER it stays on keys, whatever the size', async () => {
  /* Without a board the backlog is a guess from ownership rules — there is no
     Jira view that means the same thing, so the keys remain the honest answer
     even though they truncate. */
  const b = await renderBacklog(BIG(892));      // no boardId
  const html = b.queue();
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
  assert.strictEqual((body.match(/<tr /g) || []).length, ITEMS.length,
    'the whole queue should be on one page when it fits');
});

check('NOTHING MATCHING MEANS NO LINK — not one that opens nothing', async () => {
  const b = await renderBacklog();
  b.search.value = 'nothing-matches-this';
  b.search.fire('input');
  assert.ok(!/Open in Jira/.test(b.table()), 'an empty table offered a link to an empty set');
  assert.match(b.table(), /Nothing in the queue matches these filters/);
});

check('the link is on the filtered line, NOT in the section head beside Export CSV', async () => {
  /* Export CSV exports the whole backlog whatever the filters say. A filtered
     link sitting next to it would read as the same scope and be a different
     one — so it belongs on the line that is redrawn with the filters. */
  const b = await renderBacklog();
  const page = b.page();
  const from = page.indexOf('<h2>Sprints and backlog</h2>');
  const to = page.indexOf('<div id="blTable"');
  assert.ok(from > 0 && to > from, 'the board section has moved — this check has gone stale');
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


/* ── THE SPRINT COLUMN AND THE ASSIGNEE FILTER ────────────────────────────
   The backlog is "what is not yet committed to a sprint", so the one edit
   that belongs on it is committing something — and the one question asked of
   it most often is "what is on X". */

const sprintCellOf = (html, key) => {
  const row = html.split('<tr ').find(r => r.includes(`>${key}<`));
  return row || '';
};

check('EVERY ROW OFFERS A SPRINT, and Backlog is one of the options', async () => {
  const b = await renderBacklog();
  const t = b.table();
  assert.ok(/<th>Sprint<\/th>/.test(t), 'there is no Sprint column');
  assert.ok(/data-sprint-key="B-1"/.test(t), 'the first row has no picker');
  const cell = sprintCellOf(t, 'B-1');
  assert.ok(/<option value=""[^>]*>Backlog</.test(cell),
    'there is no way back to the backlog, so a mistaken move cannot be undone');
  for (const sp of ['Ruby Sprint 40', 'Ruby Sprint 41']) {
    assert.ok(cell.includes(sp), `${sp} is not offered`);
  }
  assert.ok(/Ruby Sprint 40 \(active\)/.test(cell), 'the active sprint is not marked');
});

check('AN ITEM ALREADY IN A SPRINT SHOWS THAT SPRINT SELECTED', async () => {
  const cell = sprintCellOf((await renderBacklog()).table(), 'B-8');
  assert.match(cell, /<option value="S41" selected>Ruby Sprint 41/,
    'the row does not show where it already is');
  assert.ok(!/<option value="" selected>/.test(cell), 'and it still reads as Backlog');
});

check('A CLOSED SPRINT IS HISTORY, NOT WHERE IT IS', async () => {
  /* An issue carries every sprint it has ever been in. Reading the last name
     regardless of state would show a ticket as sitting in a sprint that
     finished in March. */
  const cell = sprintCellOf((await renderBacklog()).table(), 'B-9');
  assert.match(cell, /<option value="" selected>Backlog/,
    'a closed sprint was shown as where the item is now');
  assert.ok(!cell.includes('Ruby Sprint 39'), 'the closed sprint leaked into the options');
});

check('THE DATA-WAS CARRIES WHAT THE SCREEN SHOWED', async () => {
  /* The server compares it against Jira before writing. Without it the write
     is blind and silently discards somebody else\'s move. */
  const t = (await renderBacklog()).table();
  assert.match(sprintCellOf(t, 'B-8'), /data-was="Ruby Sprint 41"/);
  assert.match(sprintCellOf(t, 'B-1'), /data-was=""/, 'an unsprinted row should say so, not guess');
});

check('MOVING A ROW SAVES TO JIRA AND TAKES IT OFF THE BACKLOG', async () => {
  /* This page is what is NOT committed to a sprint. An item that now has one
     does not belong on it, and leaving it there would make this screen
     disagree with the sidebar and with Jira. */
  const b = await renderBacklog();
  const before = b.table();
  assert.ok(before.includes('>B-1<'), 'fixture check');

  await b.moveSprint('B-1', 'S40', '');
  assert.strictEqual(b.puts.length, 1, 'nothing was saved');
  assert.strictEqual(b.puts[0].url, '/api/backlog/sprint');
  /* `deepEqual`, not `deepStrictEqual`: the body is built inside the vm
     context, so its prototype is that realm's Object and a strict compare
     fails on identity rather than on content. */
  assert.deepEqual(b.puts[0].body, { key: 'B-1', teamId: 'ruby', sprintId: 'S40', was: null });
  /* IT LEAVES THE QUEUE AND ARRIVES IN THE SPRINT. Both halves, because
     either one alone is a bug that looks fine: a row that vanished with no
     landing place reads as a delete, and one that appeared in the sprint
     while still queued is counted twice. */
  assert.ok(!b.queue().includes('>B-1<'), 'the row stayed in the queue after being committed');
  assert.ok(b.sec('S40').includes('>B-1<'), 'the row left the queue and arrived nowhere');
});

check('AND MOVING ONE BACK TO THE BACKLOG SENDS null, not an empty string', async () => {
  const b = await renderBacklog();
  await b.moveSprint('B-8', null, 'Ruby Sprint 41');
  assert.strictEqual(b.puts[0].body.sprintId, null, 'the backlog is a destination, not a missing value');
  assert.strictEqual(b.puts[0].body.was, 'Ruby Sprint 41');
});

check('A REFUSED MOVE LEAVES THE ROW WHERE IT WAS', async () => {
  /* A select left on the value the server refused looks exactly like one that
     saved, and the row would also have vanished from a queue it is still in. */
  const b = await renderBacklog();
  b.failPut('Somebody moved it — refresh and try again.');
  const node = await b.moveSprint('B-8', 'S40', 'Ruby Sprint 41');
  assert.strictEqual(b.puts.length, 1, 'fixture check: it tried');
  assert.strictEqual(node.value, 'S41', 'the picker kept a value the server refused');
  assert.ok(b.table().includes('>B-8<'), 'the row left the backlog on a failed move');
});

check('THE ASSIGNEE FILTER LISTS WHO IS IN THE QUEUE, with counts', async () => {
  /* Built from the items actually here, not the roster: a queue routinely
     carries work assigned to somebody who left, and a filter that cannot
     select them cannot find it. */
  const page = (await renderBacklog()).page();
  assert.ok(/id="blAssignee"/.test(page), 'there is no assignee filter');
  assert.ok(/Hien Phan \(\d+\)/.test(page), 'the options do not say how much each person carries');
  assert.ok(/— none — \(1\)/.test(page), 'the unassigned pile has no option of its own');
});

check('AND IT CUTS THE TABLE', async () => {
  const b = await renderBacklog();
  const all = b.table();
  assert.ok(all.includes('>B-1<') && all.includes('>B-8<'), 'fixture check');

  b.assignee.value = 'Anh Truong';
  b.assignee.fire('change');
  const some = b.table();
  assert.ok(some.includes('>B-8<') && some.includes('>B-9<'), "Anh Truong's items were filtered out");
  assert.ok(!some.includes('>B-1<'), "somebody else's item survived the filter");

  // And the unassigned sentinel selects exactly the ownerless one.
  b.assignee.value = '— none —';
  b.assignee.fire('change');
  const none = b.table();
  assert.ok(none.includes('>B-5<'), 'the unassigned item was filtered out');
  assert.ok(!none.includes('>B-1<'), 'an assigned item matched the unassigned filter');
});


/* ── THE BOARD: OPEN SPRINTS ABOVE THE QUEUE ──────────────────────────────
 *
 * The screen he asked for, and the shape Jira's own backlog has: choosing
 * what goes into a sprint is a COMPARISON between what is already committed
 * and what is waiting, and a page showing only the waiting half makes you
 * hold the other in your head.
 *
 * What these checks are actually guarding is that the two halves cannot
 * disagree. A row lives in exactly one section; its count, its points and
 * its "Open in Jira" all come off the same list; and the drag and the
 * picker are the same edit written through the same route — so there is no
 * way for the board to show a total the sidebar would not.
 */

const SEC = (id, name, o = {}) => ({
  id, kind: 'sprint', name, state: o.state || 'future',
  start: o.start || '2026-09-15', end: o.end || '2026-09-28',
  count: (o.items || []).length,
  points: (o.items || []).reduce((t, i) => t + (i.points || 0), 0),
  done: o.done || 0, donePoints: o.donePoints || 0,
  epicsExcluded: o.epicsExcluded || 0,
  items: o.items || [],
});

/* A BOARD MID-PLANNING: the active sprint half full, the next one started,
   and the rest still queued. Every check below needs all three states at
   once — a fixture with an empty sprint cannot tell "rendered whole" from
   "rendered nothing". */
const S40_ITEMS = [
  item('S-1', { assignee: 'Anh Truong', points: 5, sprints: [{ id: '900', name: 'Ruby Sprint 40', state: 'active' }] }),
  item('S-2', { points: 3, sprints: [{ id: '900', name: 'Ruby Sprint 40', state: 'active' }] }),
];
const S41_ITEMS = [
  item('S-3', { assignee: null, points: 8, sprints: [{ id: '901', name: 'Ruby Sprint 41', state: 'future' }] }),
];
const BOARD = {
  ...PAYLOAD,
  sections: [
    SEC('S40', 'Ruby Sprint 40', { state: 'active', start: '2026-09-01', end: '2026-09-14', items: S40_ITEMS, done: 1, donePoints: 5 }),
    SEC('S41', 'Ruby Sprint 41', { items: S41_ITEMS }),
  ],
};

/** The row keys a stretch of markup actually drew. */
const rowsIn = (html) => [...html.matchAll(/data-row-key="([^"]+)"/g)].map(m => m[1]);

check('THE BOARD PUTS THE OPEN SPRINTS ABOVE THE QUEUE, oldest first', async () => {
  const b = await renderBacklog(BOARD);
  const t = b.table();
  const at = (id) => t.indexOf(`data-sec="${id}"`);
  assert.ok(at('S40') > -1 && at('S41') > -1, 'the sprints are not on the board at all');
  assert.ok(at('backlog') > -1, 'the queue lost its own section');
  assert.ok(at('S40') < at('S41'), 'the sprints are out of order — the one you are filling is not first');
  assert.ok(at('S41') < at('backlog'), 'the queue is above the sprints, so the comparison reads backwards');
  assert.match(b.sec('S40'), /class="tag ok">active</, 'nothing says which sprint is running');
});

check('EVERY SPRINT HEAD CARRIES ITS OWN COUNT AND POINTS', async () => {
  /* The number you are checking against capacity. Read off the section's own
     items, so it cannot describe a different set from the rows beneath it. */
  const b = await renderBacklog(BOARD);
  assert.strictEqual(saidCount(b.sec('S40')), 2, "the active sprint's head does not count its rows");
  assert.match(b.sec('S40'), /8 pts/, 'and it does not add up its points');
  assert.match(b.sec('S40'), /1 done/, 'nothing says how much of the sprint is finished');
  assert.strictEqual(saidCount(b.sec('S41')), 1);
  assert.strictEqual(saidCount(b.queue()), ITEMS.length, 'the queue head changed when the sprints arrived');
});

check('AND A SPRINT RENDERS WHOLE — only the queue pages', async () => {
  /* A sprint holds tens of items and a pager on it would be furniture; the
     queue holds 594 and a pager is the only way to read the far end. */
  const many = Array.from({ length: 140 }, (_, i) => item(`SP-${String(i).padStart(3, '0')}`));
  const b = await renderBacklog({ ...BIG(500), sections: [SEC('S40', 'Ruby Sprint 40', { state: 'active', items: many })] });
  assert.strictEqual(rowsIn(b.sec('S40')).length, 140, 'the sprint was paged, so part of the commitment is off screen');
  assert.ok(!/class="pager"/.test(b.sec('S40')), 'a sprint grew a pager');
  assert.strictEqual(rowsIn(b.queue()).length, 100, 'the queue stopped paging');
  assert.match(b.queue(), /class="pager"/, 'a 500-item queue has no pager');
});

check('A SECTION FOLDS — and the head STAYS, because it is a drop target', async () => {
  /* The reason you fold sprints 42–44 away is that you are filling 41 from
     the queue. A fold that also removed the target would make the tidy view
     the one you cannot work in. */
  const b = await renderBacklog(BOARD);
  assert.ok(rowsIn(b.sec('S40')).length > 0, 'fixture check: it starts open');

  b.fold('S40');
  assert.strictEqual(rowsIn(b.sec('S40')).length, 0, 'the rows are still drawn after folding');
  assert.match(b.sec('S40'), /data-sec="S40"/, 'the section left the page, so it can no longer be dropped on');
  assert.match(b.sec('S40'), /aria-expanded="false"/, 'a screen reader is not told it is shut');
  assert.strictEqual(saidCount(b.sec('S40')), 2, 'a folded sprint stopped saying what it holds');
  assert.ok(rowsIn(b.queue()).length > 0, 'folding one section folded another');

  b.fold('S40');
  assert.strictEqual(rowsIn(b.sec('S40')).length, 2, 'it would not open again');
  assert.match(b.sec('S40'), /aria-expanded="true"/);
});

check('THE QUEUE FOLDS TOO — it is a section like any other', async () => {
  const b = await renderBacklog(BOARD);
  b.fold('backlog');
  assert.strictEqual(rowsIn(b.queue()).length, 0, 'the queue would not fold');
  assert.match(b.queue(), /data-sec="backlog"/, 'and it left the page, so nothing can be dropped back');
  assert.strictEqual(saidCount(b.queue()), ITEMS.length, 'a folded queue stopped saying how much is waiting');
});

check('AND THE FOLD IS REMEMBERED — per team, not globally', async () => {
  /* A sprint id is global in the plan while the work under it is not:
     folding Titan's sprint 41 away must not fold Ruby's, and the two are
     the same id. */
  const b = await renderBacklog(BOARD);
  b.fold('S40');
  const again = await renderBacklog(BOARD, b.app);
  assert.strictEqual(rowsIn(again.sec('S40')).length, 0, 'the fold did not survive a redraw');

  const other = await renderBacklog(BOARD, b.app, { ...STATE, teamId: 'titan' });
  assert.strictEqual(rowsIn(other.sec('S40')).length, 2,
    "one team's fold reached another team's board");
});

check('DRAGGING A ROW INTO A SPRINT WRITES THROUGH THE SAME ROUTE AS THE PICKER', async () => {
  /* The drag is a SHORTCUT for choosing an option, not a second way of
     writing to Jira. A second path would be a second place for the
     read-before-write `was` to be got wrong — and that failure is silent: it
     does not look like an error, it looks like somebody else's move
     vanishing. */
  const b = await renderBacklog(BOARD);
  const { allowed } = await b.drag('B-1', 'S41');
  assert.ok(allowed, 'the section never allowed the drop — dragover did not preventDefault');
  assert.strictEqual(b.puts.length, 1, 'the drag saved nothing');
  assert.strictEqual(b.puts[0].url, '/api/backlog/sprint', 'the drag writes somewhere else than the picker does');
  assert.deepEqual(b.puts[0].body, { key: 'B-1', teamId: 'ruby', sprintId: 'S41', was: null });
  assert.ok(!b.queue().includes('>B-1<'), 'the row stayed in the queue');
  assert.ok(b.sec('S41').includes('>B-1<'), 'the row arrived nowhere');
  assert.strictEqual(saidCount(b.sec('S41')), 2, "the sprint's count did not follow the row in");
  assert.strictEqual(saidCount(b.queue()), ITEMS.length - 1, "the queue's count did not follow the row out");
});

check('A DRAG OUT OF A SPRINT CARRIES THE SPRINT IT CAME FROM', async () => {
  /* `was` is the read-before-write guard. Sending null for a row that IS in
     a sprint tells the server "it was in the backlog", and the comparison
     against Jira that stops a blind overwrite passes for the wrong reason. */
  const b = await renderBacklog(BOARD);
  await b.drag('S-1', 'backlog');
  assert.deepEqual(b.puts[0].body, { key: 'S-1', teamId: 'ruby', sprintId: null, was: 'Ruby Sprint 40' });
  assert.ok(b.queue().includes('>S-1<'), 'the row did not come back to the queue');
  assert.ok(!b.sec('S40').includes('>S-1<'), 'and it is still in the sprint as well — counted twice');
});

check('AND BETWEEN TWO SPRINTS', async () => {
  const b = await renderBacklog(BOARD);
  await b.drag('S-1', 'S41');
  assert.deepEqual(b.puts[0].body, { key: 'S-1', teamId: 'ruby', sprintId: 'S41', was: 'Ruby Sprint 40' });
  assert.ok(b.sec('S41').includes('>S-1<') && !b.sec('S40').includes('>S-1<'));
});

check('A DROP BACK WHERE IT STARTED IS NOTHING — not an unchanged write', async () => {
  /* The server would answer `unchanged` and the toast would report a move
     nobody made. Cheaper and quieter to notice here. */
  const b = await renderBacklog(BOARD);
  await b.drag('S-1', 'S40');
  assert.strictEqual(b.puts.length, 0, 'dropping a row on the section it is already in wrote to Jira');
  await b.drag('B-1', 'backlog');
  assert.strictEqual(b.puts.length, 0, 'dropping a queued row back on the queue wrote to Jira');
});

check('A REFUSED DRAG LEAVES THE BOARD EXACTLY AS IT WAS', async () => {
  const b = await renderBacklog(BOARD);
  b.failPut('Somebody moved it — refresh and try again.');
  await b.drag('B-1', 'S41');
  assert.strictEqual(b.puts.length, 1, 'fixture check: it tried');
  assert.ok(b.queue().includes('>B-1<'), 'the row left the queue on a move Jira refused');
  assert.ok(!b.sec('S41').includes('>B-1<'), 'and it appeared in a sprint it never reached');
  assert.strictEqual(saidCount(b.sec('S41')), 1, 'the counts moved without the row');
});

check('A MOVED ROW NOW SAYS WHERE IT IS — or the NEXT move is refused', async () => {
  /* The regression this pins is the quiet one. The Sprint select and every
     `data-was` are computed from the item's own sprint list; moving it
     between lists without rewriting that list leaves the row in sprint 41
     still claiming to be in the backlog. Nothing looks wrong — until the
     second move sends a `was` the first has just superseded, and the
     server, comparing it against Jira, refuses it. */
  const b = await renderBacklog(BOARD);
  await b.drag('B-1', 'S41');
  const row = b.sec('S41').split('<tr ').find(r => r.includes('>B-1<'));
  assert.ok(row, 'fixture check: the row moved');
  assert.match(row, /data-was="Ruby Sprint 41"/, 'the moved row still claims to be where it was');
  assert.match(row, /<option value="S41" selected>/, 'and its picker shows the wrong sprint');

  // So the second move is accepted, with the right `was`.
  await b.drag('B-1', 'S40');
  assert.deepEqual(b.puts[1].body, { key: 'B-1', teamId: 'ruby', sprintId: 'S40', was: 'Ruby Sprint 41' });
});

check('AND A ROW SENT BACK KEEPS ITS CLOSED SPRINTS — that is where it HAS been', async () => {
  const b = await renderBacklog(BOARD);
  await b.drag('B-9', 'S40');            // B-9's only sprint is a closed one
  await b.drag('B-9', 'backlog');
  assert.deepEqual(b.puts[1].body.was, 'Ruby Sprint 40');
  const row = b.queue().split('<tr ').find(r => r.includes('>B-9<'));
  assert.match(row, /data-was=""/, 'a row back in the queue should say it is in no sprint');
  assert.ok(!row.includes('Ruby Sprint 39'), 'the closed sprint leaked back into the options');
});

check('THE FILTERS NARROW THE WHOLE BOARD, not just the queue', async () => {
  /* A filter that applied to one section would be a trap: typing a name in
     the search box and seeing the sprints unchanged reads as "this person
     has nothing queued", which is the opposite of what it means. */
  const b = await renderBacklog(BOARD);
  assert.ok(b.sec('S40').includes('>S-1<'), 'fixture check');

  b.assignee.value = 'Anh Truong';
  b.assignee.fire('change');
  assert.deepStrictEqual(rowsIn(b.sec('S40')), ['S-1'], "the sprint kept somebody else's rows");
  assert.strictEqual(rowsIn(b.sec('S41')).length, 0, 'a sprint with no match for the filter still drew rows');
  assert.ok(rowsIn(b.queue()).includes('B-8'), 'the queue lost the rows that do match');
});

check('AND EVERY HEAD SAYS HOW MANY OF ITS OWN IT IS SHOWING', async () => {
  /* "1 of 2 items" — both numbers, so a filtered board can never be mistaken
     for a smaller sprint. */
  const b = await renderBacklog(BOARD);
  b.assignee.value = 'Anh Truong';
  b.assignee.fire('change');
  assert.match(b.sec('S40'), /1 of 2 items/, 'the sprint head hid the fact that it is filtered');
  assert.match(b.sec('S41'), /0 of 1 items/);
  assert.match(b.sec('S41'), /Nothing here matches these filters/,
    'an empty filtered sprint reads as an empty sprint');
});

check('THE ASSIGNEE PICKER OFFERS EVERYONE ON THE BOARD, not just the queue', async () => {
  /* An option that could select nothing in the sprints would make a person
     with only committed work appear to have none. */
  const page = (await renderBacklog(BOARD)).page();
  // Two queued (B-8, B-9) and one committed (S-1). Counting the queue
  // alone would say 2, which is the failure this is here for.
  assert.match(page, /Anh Truong \(3\)/, 'the picker counts only the queue');
});

check('A SECTION EXISTS FOR EVERY SPRINT THE PICKER OFFERS', async () => {
  /* Otherwise a move made from a row's select would send the row to a
     destination that is not on the page, and it would simply disappear. */
  const b = await renderBacklog(BOARD);
  const offered = [...b.queue().matchAll(/<option value="(S\d+)"/g)].map(m => m[1]);
  assert.ok(offered.length, 'fixture check: the picker offers sprints');
  for (const id of new Set(offered)) {
    assert.ok(b.sec(id), `the picker offers ${id} and the board has no section for it`);
  }
});

check('A BOARD WITH A FULL SPRINT AND AN EMPTY QUEUE STILL DRAWS', async () => {
  /* Malphite's queue is empty and its sprints are not. A page that said
     "nothing here" over two full sprints would be simply wrong. */
  const b = await renderBacklog({ ...BOARD, total: 0, items: [], blocked: { count: 0, items: [] } });
  assert.ok(b.sec('S40').includes('>S-1<'), 'the board vanished because the queue was empty');
  assert.match(b.queue(), /The queue is empty/, 'the empty queue says nothing about why');
});

check('AN EMPTY SPRINT SAYS WHAT TO DO WITH IT', async () => {
  const b = await renderBacklog(PAYLOAD);      // both sprints empty
  assert.match(b.sec('S40'), /drag rows from the backlog/,
    'an empty sprint gives no hint that it is a drop target');
  assert.ok(!/>Open in Jira</.test(b.sec('S40')), 'an empty sprint offered a link to nothing');
});

check('EPICS LEFT OUT OF A SPRINT ARE DECLARED, like they are for the queue', async () => {
  /* A count smaller than Jira's own has to be able to explain itself. */
  const b = await renderBacklog({
    ...BOARD,
    sections: [SEC('S40', 'Ruby Sprint 40', { state: 'active', items: S40_ITEMS, epicsExcluded: 4 })],
  });
  assert.match(b.sec('S40'), /4 epics not counted/,
    'the sprint quietly shows fewer items than Jira does');
});

check('EVERY ROW IS ACTUALLY DRAGGABLE — the attribute, not just the handler', async () => {
  /* THE ONE THING THE HANDLERS CANNOT PROVE. This harness fires `dragstart`
     directly, as every drag test must; the browser only fires it on an
     element carrying `draggable="true"`. Drop that attribute and every check
     above still passes while nothing on the page can be picked up — so the
     attribute is asserted on the markup, once, here.

     ON EVERY ROW IN EVERY SECTION, because the gesture has to work in both
     directions: a queue you can drag out of and sprints you cannot drag back
     out of is a one-way trip through a control that looks reversible. */
  const b = await renderBacklog(BOARD);
  for (const id of ['S40', 'S41', 'backlog']) {
    const html = b.sec(id);
    const rows = rowsIn(html);
    assert.ok(rows.length, `fixture check: ${id} has rows`);
    assert.strictEqual((html.match(/<tr draggable="true"/g) || []).length, rows.length,
      `${id} has ${rows.length} rows and only some of them can be picked up`);
  }
});

check('AND THE TWISTY IS A BUTTON A KEYBOARD CAN REACH', async () => {
  /* Folding is the control a keyboard user needs most on this screen — the
     queue below it is 594 rows long. A clickable heading would do the same
     thing with a mouse and be unreachable without one. */
  const b = await renderBacklog(BOARD);
  const head = b.sec('S40');
  assert.match(head, /<button class="bl-fold"[^>]*aria-expanded="true"/,
    'the twisty is not a button, or does not announce its state');
});
