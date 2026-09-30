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
  components: o.components || ['R&D_iGO_E2E'],
  points: 'points' in o ? o.points : 3,
  /* `'assignee' in o`, NOT `o.assignee || default`. An UNOWNED item is a real
     and important case — it is what the Unassigned chip and the new assignee
     filter are for — and `|| default` silently gives it an owner, so the
     fixture cannot express the thing under test. The same defect the team
     field had in the By component fixture. */
  assignee: 'assignee' in o ? o.assignee : 'Hien Phan',
  priority: o.priority || 'Medium',
  /* `'status' in o` and `'dueDate' in o`, never `|| default`. "No due date"
     and "no category rule matched" are both real states with their own cell,
     and a default applied with `||` makes them inexpressible — the same
     fixture defect that hid the PS_iGO_Lafayette bug and the unowned one. */
  status: 'status' in o ? o.status : 'Open',
  dueDate: 'dueDate' in o ? o.dueDate : null,
  category: 'category' in o ? o.category : 'new',
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
  /* A REAL CLASS SET, not a no-op. The layout switch flips `active` between
     two chips that live OUTSIDE `#blTable` and therefore survive the redraw —
     so "the one you clicked is active and the other is not" is a claim about
     these objects, and a `toggle()` that swallowed its argument would agree
     with a page that had stopped flipping them. */
  const cls = new Set();
  return {
    id, value: '', dataset: {},
    classList: {
      toggle(c, on2) {
        const want = on2 === undefined ? !cls.has(c) : !!on2;
        if (want) cls.add(c); else cls.delete(c);
        return want;
      },
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
    },
    addEventListener(type, fn) { (on[type] = on[type] || []).push(fn); },
    fire(type, e = {}) { for (const fn of on[type] || []) fn({ target: this, preventDefault() {}, ...e }); },
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ''; },
  };
}

/**
 * ONE SECTION'S HEAD, AS A TREE THAT CAN BE WALKED.
 *
 * The fold handler no longer asks "was a twisty clicked". It asks what was
 * under the pointer and walks UP from there — is it inside a head, is it a
 * control in its own right, which section does it belong to. None of that can
 * be answered by an object that returns itself for one selector, so this
 * builds the real shape: section → head → the four things in it, plus a body
 * with a row in it, with parents that link and a `closest` that climbs them.
 *
 * `matches` covers the three selector forms the view actually uses — a class,
 * a `[data-x]` attribute, a tag name, and comma-separated lists of those. It
 * is deliberately small: a matcher that quietly accepts a selector it does not
 * understand would answer `null` and look exactly like a handler that decided
 * not to act.
 */
function headTree(id, { kind = 'sprint' } = {}) {
  const camel = (attr) => attr.replace(/^data-/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
  const mk = (tag, cls, data, parent) => {
    const n = {
      tagName: tag.toUpperCase(), className: cls || '', dataset: data || {},
      parentNode: parent || null,
    };
    n.matches = (sel) => String(sel).split(',').map(s => s.trim()).filter(Boolean).some((s) => {
      if (s.startsWith('.')) return ` ${n.className} `.includes(` ${s.slice(1)} `);
      if (s.startsWith('[') && s.endsWith(']')) return camel(s.slice(1, -1)) in n.dataset;
      if (/^[a-z][\w-]*$/i.test(s)) return n.tagName === s.toUpperCase();
      throw new Error(`headTree cannot match the selector ${s} — teach it that form rather than letting it answer "no"`);
    });
    n.closest = (sel) => { let c = n; while (c) { if (c.matches(sel)) return c; c = c.parentNode; } return null; };
    return n;
  };
  const section = mk('section', 'bl-sec', { sec: String(id), kind }, null);
  const head = mk('div', 'bl-sec-head', {}, section);
  const body = mk('div', 'bl-sec-body', {}, section);
  return {
    section, head, body,
    fold: mk('button', 'bl-fold', { fold: String(id) }, head),
    title: mk('h3', '', {}, head),
    meta: mk('span', 'bl-meta', {}, head),
    /* THE WAY OUT TO JIRA, which sits in the head and is not a fold. */
    jira: mk('a', 'btn ghost sm', {}, head),
    /* NO HEAD CARRIES A BUTTON TODAY — `openInJira` renders an anchor — so
       this one is here for the next control that lands in the bar. The rule
       being pinned is "a control in the head is still itself", and a rule
       that only holds for the controls that happen to exist now is not a
       rule. */
    action: mk('button', 'btn ghost sm', { act: 'bl-something' }, head),
    row: mk('tr', '', { rowKey: `${id}-1` }, body),
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

/* THE STORE, SEPARATE FROM THE CONTEXT THAT USES IT.
   A real one rather than a no-op: "folded, then folded again, is open" is a
   round trip through this, and a stub that swallowed writes would make every
   toggle look like the first one.

   IT IS PASSABLE because "remembered" means remembered by the BROWSER, not by
   the module. A second render in the same context reads the layout back out of
   a module-level variable the click already set, which proves nothing about
   storage — deleting the load entirely leaves that check green. Handing a
   fresh module the same store is the real shape of the claim: a new tab. */
function mkStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function bootBacklog(store = mkStore()) {
  const ctx = {
    console, Promise, setTimeout, clearTimeout, encodeURIComponent,
    Charts: new Proxy({}, { get: () => () => '' }),
    localStorage: store,
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

  /* THE PILE REPAINTS ITSELF IN PLACE. It sits OUTSIDE `#blTable`, so the
     view cannot redraw it by redrawing the table — it writes `#blWho`'s
     innerHTML directly, and a harness that handed back a node whose writes
     went nowhere would make every repaint look like it worked. */
  const pile = fakeEl('#blWho');
  let pileHtml = '';
  Object.defineProperty(pile, 'innerHTML', { get: () => pileHtml, set: (v) => { pileHtml = v; } });

  const keyFor = (sel) => (INSIDE_TABLE.has(sel) ? `${sel}@${gen}` : sel);
  const get = (sel) => {
    if (sel === '#blTable') return table;
    if (sel === '#blWho') return pile;
    const k = keyFor(sel);
    if (!nodes.has(k)) {
      const n = fakeEl(sel);
      // The per-page <select> starts at whatever the pager just rendered.
      if (sel === '#blPageSize') n.value = (tableHtml.match(/<option selected>(\d+)</) || [])[1] || '100';
      nodes.set(k, n);
    }
    return nodes.get(k);
  };

  /* DECLARED ABOVE `getAll` because the layout chips are read back out of it
     — the page head is markup like any other, and a chip list built from
     anything else is a list only this harness could produce. */
  let mountHtml = '';

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
      } else if (sel === '[data-layout]') {
        /* BUILT FROM THE HEAD THE VIEW ACTUALLY RENDERED, active flag and all.
           Seeding these `stack`-active would make "the chips agree with the
           page" a claim about the seed: a page that came back from storage in
           side-by-side and drew its own chip active would still read as
           stacked here, and the remembered-layout check would fail against a
           page that was right. */
        many.set(k, [...mountHtml.matchAll(/class="chip( active)?"\s*data-layout="([a-z]+)"/g)].map(m => {
          const n = fakeEl(sel);
          n.dataset = { layout: m[2] };
          if (m[1]) n.classList.add('active');
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
  // The browser's store, whichever module is currently reading it.
  const store = ctx.localStorage;
  ctx.UI.api = async () => payload;
  /* THE DRAWER IS A REAL RENDER, not a stub that records its arguments. What
     these checks are about is whether the list matches the number, and only
     the rendered rows can answer that. */
  let drawnHtml = '';
  ctx.UI.drawer = (html) => { drawnHtml = html; };
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
    /* CLICK SOMEWHERE IN ONE SECTION'S HEAD. Delegated on the mount, so the
       handler is fed the element under the pointer and walks up from it.

       IT IS GIVEN A REAL LITTLE TREE (see `headTree`) rather than a lone
       object answering one selector. The old stand-in answered `[data-fold]`
       and nothing else, which is a shape only this harness could produce; the
       moment the whole bar became the target it stopped resembling the page,
       and three fold checks went red for a reason that had nothing to do with
       folding.

       `part` picks what the pointer was actually over — the twisty, the
       title, the meta, or the link out to Jira. The default is the twisty, so
       every check written before the bar was clickable still asks exactly
       what it asked then. */
    fold(id, part = 'fold') {
      const tree = headTree(id);
      for (const fn of mountOn.click || []) fn({ target: tree[part], preventDefault() {} });
      return tree;
    },
    /** Click one of the layout chips, as the page delivers it. */
    layout(which) {
      const node = fakeEl('[data-layout]');
      node.dataset = { layout: String(which) };
      node.closest = (sel) => (sel === '[data-layout]' ? node : null);
      for (const fn of mountOn.click || []) fn({ target: node, preventDefault() {} });
      return node;
    },
    /** The layout chips the page is currently showing as active. */
    activeLayouts() {
      return getAll('[data-layout]').filter(n => n.classList.contains('active')).map(n => n.dataset.layout);
    },
    /**
     * Drag one row onto a section, start to drop, as the browser fires it.
     *
     * `pane` puts the section inside a scrolling pane, which is what the split
     * layout does — and `at` says where in that pane the pointer was, so the
     * edge auto-scroll can be driven. Both optional: without them this is the
     * stacked page, exactly as it was.
     */
    async drag(key, toSection, { pane = null, at = null } = {}) {
      const cls = () => ({ add() {}, remove() {}, contains: () => false });
      const row = { dataset: { rowKey: key }, classList: cls() };
      row.closest = (sel) => (sel === '[data-row-key]' ? row : null);
      const sec = { dataset: { sec: String(toSection) }, classList: cls() };
      const paneNode = pane && {
        dataset: { pane: String(pane.name || 'sprints') },
        scrollTop: pane.scrollTop || 0,
        scrollHeight: pane.scrollHeight == null ? 2000 : pane.scrollHeight,
        clientHeight: pane.clientHeight == null ? 500 : pane.clientHeight,
        getBoundingClientRect: () => ({
          top: pane.top == null ? 100 : pane.top,
          bottom: pane.bottom == null ? 600 : pane.bottom,
        }),
      };
      sec.closest = (sel) => (sel === '[data-sec]' ? sec : (sel === '[data-pane]' ? paneNode : null));
      const dt = { setData() {} };
      let allowed = false;
      for (const fn of mountOn.dragstart || []) fn({ target: row, dataTransfer: dt, preventDefault() {} });
      for (const fn of mountOn.dragover || []) {
        fn({ target: sec, dataTransfer: dt, clientY: at == null ? 300 : at, preventDefault() { allowed = true; } });
      }
      for (const fn of mountOn.drop || []) await fn({ target: sec, dataTransfer: dt, preventDefault() {} });
      return { allowed, pane: paneNode };
    },
    /* ── THE FACE PILE ────────────────────────────────────────────────
       Two controls, one Set: an avatar in the row and a checkbox in the
       overflow menu. Both are driven here, because a harness that only
       exercised one could not catch them disagreeing — which is the whole
       failure a two-control filter has. */
    who: {
      /** Click an avatar in the row. */
      chip(name) {
        const node = { dataset: { who: String(name) } };
        node.closest = (sel) => (sel === '[data-who]' ? node : null);
        for (const fn of mountOn.click || []) fn({ target: node, preventDefault() {} });
      },
      /* Tick a box in the overflow menu — CLICK AND THEN CHANGE, which is
         what a browser fires. Sending only `change` would let a handler
         that shuts the menu on any click pass, and the menu would close
         under the reader on every single tick. The click reports itself as
         inside the panel, because that is where the box is. */
      pick(name) {
        const node = { dataset: { whoPick: String(name) } };
        node.closest = (sel) => (sel === '[data-who-pick]' || sel === '[data-who-panel]' ? node : null);
        for (const fn of mountOn.click || []) fn({ target: node, preventDefault() {} });
        for (const fn of mountOn.change || []) fn({ target: node, preventDefault() {} });
      },
      /** Open or close the +N menu. */
      more() {
        const node = { dataset: {} };
        node.closest = (sel) => (sel === '[data-who-more]' ? node : null);
        for (const fn of mountOn.click || []) fn({ target: node, preventDefault() {} });
      },
      clear() {
        const node = { dataset: {} };
        node.closest = (sel) => (sel === '[data-who-clear]' ? node : null);
        for (const fn of mountOn.click || []) fn({ target: node, preventDefault() {} });
      },
      /** A click on something that is not the pile at all. */
      away() {
        const node = { dataset: {} };
        node.closest = () => null;
        for (const fn of mountOn.click || []) fn({ target: node, preventDefault() {} });
      },
      esc() { for (const fn of mountOn.keydown || []) fn({ key: 'Escape', target: {}, preventDefault() {} }); },
      /* The pile's markup. It is drawn once INTO the mount and repainted in
         place after that, so both sources count — reading only the repaint
         would make every check pass against an empty string until something
         had been clicked. */
      html() {
        if (pileHtml) return pileHtml;
        const at = mountHtml.indexOf('id="blWho"');
        if (at < 0) return '';
        const end = mountHtml.indexOf('<div class="field"><span>State', at);
        return mountHtml.slice(at, end < 0 ? mountHtml.length : end);
      },
    },
    /** Click the Blocked KPI, which is delegated on the mount like the rest. */
    blockedKpi() {
      const node = { dataset: { act: 'bl-blocked' } };
      node.closest = (sel) => (sel === '[data-act="bl-blocked"]' ? node : null);
      for (const fn of mountOn.click || []) fn({ target: node, preventDefault() {} });
    },
    drawn: () => drawnHtml,
    page: () => mountHtml,
    table: () => table.innerHTML,
    /* HOW MANY TIMES THE TABLE HAS BEEN REWRITTEN.
       "This click does nothing" cannot be shown by comparing the markup before
       and after: a redraw that changes nothing produces the same string, so the
       comparison passes whether or not the redraw happened. The count is the
       claim. */
    draws: () => gen,
    /* THE SAME BROWSER, A NEW TAB — a brand new module reading the store this
       one has been writing to. */
    newTab: (p = payload, s = st) => renderBacklog(p, { ctx: bootBacklog(store) }, s),
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

/* ── BACKLOG AND SPRINTS, SIDE BY SIDE ──────────────────────────────────
 *
 * Stacked was the only arrangement and it is the wrong shape for what this
 * page is for. Deciding what a sprint takes on is a comparison between two
 * lists, and with sixty unplanned items the sprint you are dragging toward is
 * three screens above the row you are dragging.
 *
 * Both layouts are kept: stacked still reads better narrow and is the only one
 * that prints. So the risk is not "does the new one work" but "do the two stay
 * the same page" — same rows, same sections, same drop targets, same writes.
 */

check('THE PAGE OFFERS BOTH LAYOUTS, and starts stacked', async () => {
  const b = await renderBacklog();
  assert.match(b.page(), /data-layout="stack"/, 'no stacked option');
  assert.match(b.page(), /data-layout="split"/, 'no side-by-side option');
  /* STACKED IS THE DEFAULT, because it is what the page has always been and a
     stored preference nobody set should not change a screen under them. */
  assert.deepStrictEqual(b.activeLayouts(), ['stack']);
  assert.ok(!/bl-split/.test(b.table()), 'the page started split without being asked');
});

check('SWITCHING PUTS THE BACKLOG ON THE LEFT AND THE SPRINTS ON THE RIGHT', async () => {
  const b = await renderBacklog();
  b.layout('split');
  const t = b.table();
  assert.match(t, /class="bl-split"/, 'the split container is not there');
  const backlogPane = t.indexOf('data-pane="backlog"');
  const sprintPane = t.indexOf('data-pane="sprints"');
  assert.ok(backlogPane > -1 && sprintPane > -1, 'one of the panes is missing');
  /* HIS REQUEST, IN SO MANY WORDS: left is the backlog, right is the sprints.
     Jira's own screen is the other way round and the reference picture he sent
     shows that — the words are what is being built. */
  assert.ok(backlogPane < sprintPane,
    'the sprints came first, so the backlog is on the right');
  /* AND EACH SECTION IS IN THE RIGHT PANE. */
  const left = t.slice(backlogPane, sprintPane);
  const right = t.slice(sprintPane);
  assert.match(left, /data-sec="backlog"/, 'the queue is not in the left pane');
  assert.ok(!/data-sec="backlog"/.test(right), 'the queue is in the sprint pane too');
  assert.match(right, /data-sec="S40"/, 'the sprints are not in the right pane');
});

check('AND BOTH LAYOUTS DRAW THE SAME SECTIONS AND THE SAME ROWS', async () => {
  /* THE GUARANTEE THAT MATTERS. Two layouts is two chances for one of them to
     lose a section, a row or a drop target — and the drag depends on every
     `data-sec` existing in both. Built from one set of sections for exactly
     this reason; this is what holds that. */
  const b = await renderBacklog();
  const secsOf = (t) => [...t.matchAll(/data-sec="([^"]*)"/g)].map(m => m[1]).sort();
  const rowsOf = (t) => [...t.matchAll(/data-row-key="([^"]*)"/g)].map(m => m[1]).sort();

  const stackedSecs = secsOf(b.table());
  const stackedRows = rowsOf(b.table());
  assert.ok(stackedSecs.length > 1, 'fixture check: one section cannot show a difference');
  assert.ok(stackedRows.length > 0, 'fixture check: no rows at all');

  b.layout('split');
  assert.deepStrictEqual(secsOf(b.table()), stackedSecs, 'a section is missing from one layout');
  assert.deepStrictEqual(rowsOf(b.table()), stackedRows, 'a row is missing from one layout');

  b.layout('stack');
  assert.deepStrictEqual(secsOf(b.table()), stackedSecs, 'switching back lost a section');
  assert.deepStrictEqual(rowsOf(b.table()), stackedRows, 'switching back lost a row');
});

check('THE CHOICE IS REMEMBERED, and read back on the next load', async () => {
  const b = await renderBacklog();
  b.layout('split');
  assert.strictEqual(b.ctx.localStorage.getItem('pt-backlog-layout'), 'split',
    'the layout was not saved');
  /* THE SAME APP, A FRESH RENDER — which is what a team switch does. */
  const again = await renderBacklog(PAYLOAD, b.app);
  assert.match(again.table(), /bl-split/, 'the saved layout was not picked up on the next draw');
  assert.deepStrictEqual(again.activeLayouts(), ['split'], 'the chips disagree with the page');

  /* AND A NEW TAB, which is the only one of the three that is actually about
     storage. The two renders above share a module, so the layout they read
     back is a variable the click set — deleting the load from storage
     altogether leaves both of them green. This one is a brand new module
     handed the same store, and nothing but the round trip can carry the
     choice into it. */
  const tab = await b.newTab();
  assert.match(tab.table(), /bl-split/, 'a new tab did not read the choice back out of storage');
  assert.deepStrictEqual(tab.activeLayouts(), ['split'], 'the new tab drew the wrong chip active');
});

check('AND RUBBISH IN STORAGE FALLS BACK TO STACKED', async () => {
  /* localStorage is shared with every other tab and version of this app. A
     value this build does not know is not a reason to render nothing. */
  const b = await renderBacklog();
  b.ctx.localStorage.setItem('pt-backlog-layout', 'columns-but-diagonal');
  const again = await renderBacklog(PAYLOAD, b.app);
  assert.ok(!/bl-split/.test(again.table()), 'an unknown layout was honoured');
  assert.deepStrictEqual(again.activeLayouts(), ['stack']);
  // And in a module that has never seen anything else.
  const tab = await b.newTab();
  assert.ok(!/bl-split/.test(tab.table()), 'a fresh module honoured an unknown layout');
  assert.deepStrictEqual(tab.activeLayouts(), ['stack']);
});

check('AND A CHIP ASKING FOR A LAYOUT THIS BUILD DOES NOT HAVE IS IGNORED', async () => {
  /* The chips are rendered from `LAYOUTS`, so this cannot happen from the
     markup this build draws — it happens when the page has been open across a
     deploy that removed an arrangement, and the tab still holds the old head.
     Ignored rather than honoured: an unknown name falls through every branch
     and would leave the board in neither layout with neither chip lit, and
     WRITE that name to storage on the way, so every later load starts from it. */
  const b = await renderBacklog();
  const before = b.table();
  const draws = b.draws();
  b.layout('columns-but-diagonal');
  assert.strictEqual(b.draws(), draws, 'an unknown layout redrew the board');
  assert.strictEqual(b.table(), before, 'an unknown layout changed the board');
  assert.deepStrictEqual(b.activeLayouts(), ['stack'], 'it left the chips somewhere else');
  assert.strictEqual(b.ctx.localStorage.getItem('pt-backlog-layout'), null,
    'an unknown layout was written to storage, so every later load starts from it');
});

check('THE CHIPS FLIP WITHOUT REDRAWING THE FILTERS', async () => {
  /* They sit in the page head, outside `#blTable`. Re-rendering the head to
     mark one active would take the search box's focus and its caret with it
     mid-typing, so the class is flipped in place. */
  const b = await renderBacklog();
  b.search.value = 'auth';
  b.layout('split');
  assert.deepStrictEqual(b.activeLayouts(), ['split'], 'the clicked chip is not active');
  assert.strictEqual(b.search.value, 'auth', 'the search box was rebuilt under the typing');
});

check('CLICKING THE LAYOUT YOU ARE ALREADY ON DOES NOTHING', async () => {
  /* Not an error and not a redraw.

     COUNTED, NOT COMPARED. A redraw of the same layout produces the same
     markup, so "the table is unchanged" is true whether or not the board was
     rebuilt — the string comparison this check used to make passed with the
     guard deleted. What a needless redraw actually costs is the thing you
     cannot see in the markup: every node in the table is replaced, so a drag
     in flight loses its row, an open <select> closes, and the scroll position
     of a pane you were dragging toward goes back to the top. */
  const b = await renderBacklog();
  b.layout('split');
  const before = b.table();
  const draws = b.draws();
  b.layout('split');
  assert.strictEqual(b.draws(), draws, 'the board was rebuilt for a click that changed nothing');
  assert.strictEqual(b.table(), before, 'the table was redrawn for a click that changed nothing');
  assert.deepStrictEqual(b.activeLayouts(), ['split'], 'and it left the chips in a different state');
});

check('A SPLIT BOARD WITH NO OPEN SPRINTS SAYS SO, rather than showing an empty column', async () => {
  /* Side by side, a sprint pane with nothing in it is a tall blank rectangle
     next to a full queue, and it reads as a page that failed to load. Stacked,
     the same emptiness is just the queue starting at the top — which is why
     this needs saying only in one of the two layouts. */
  /* BOTH LISTS CLEARED. `sections` is what the board draws and `sprints` is
     what the row picker offers — a fixture that emptied one and not the other
     is a board this app cannot produce, and a check written against it proves
     something about nothing. */
  const noSprints = { ...PAYLOAD, sections: [], sprints: [] };
  const b = await renderBacklog(noSprints);
  b.layout('split');
  const t = b.table();
  const at = t.indexOf('data-pane="sprints"');
  assert.ok(at > -1, 'the sprint pane is missing entirely');
  assert.match(t.slice(at), /No open sprints/,
    'the empty sprint pane says nothing about why it is empty');
  // And the queue is still there beside it, which is the whole point.
  assert.match(t, /data-sec="backlog"/, 'the queue went with the sprints');
});

/* ── THE DRAG STILL WORKS, AND IT WORKS BETWEEN SPRINTS ────────────────── */

check('A ROW DRAGS FROM THE QUEUE INTO A SPRINT IN THE SPLIT LAYOUT', async () => {
  const b = await renderBacklog();
  b.layout('split');
  const { allowed } = await b.drag('B-1', 'S40', { pane: { name: 'sprints' } });
  assert.ok(allowed, 'the section refused the drop — dragover did not preventDefault');
  assert.strictEqual(b.puts.length, 1, 'the drag saved nothing');
  assert.strictEqual(b.puts[0].url, '/api/backlog/sprint');
  assert.strictEqual(b.puts[0].body.sprintId, 'S40');
});

check('AND BETWEEN TWO SPRINTS, which is the half he thought was missing', async () => {
  /* It already worked — every row is draggable and any section is a drop
     target — but nothing pinned it, so either layout could have lost it
     without a check going red.

     THE ROW IS PUT IN A SPRINT FIRST, by dragging it there. The fixture's
     sprints start empty, and inventing a row in one would test a shape the
     page cannot produce; this way the second drag starts from whatever the
     first one actually left behind. */
  const b = await renderBacklog();
  await b.drag('B-1', 'S40');
  assert.strictEqual(b.puts.length, 1, 'fixture check: the first move did not happen');

  const { allowed } = await b.drag('B-1', 'S41');
  assert.ok(allowed, 'a sprint refused a row dragged from another sprint');
  assert.strictEqual(b.puts.length, 2, 'the sprint-to-sprint move saved nothing');
  assert.strictEqual(b.puts[1].body.sprintId, 'S41', 'it was filed against the wrong sprint');
  assert.strictEqual(b.puts[1].body.was, 'Ruby Sprint 40',
    'the read-before-write `was` did not name the sprint it came from');
});

check('AND THE SAME DRAG WRITES THE SAME THING IN BOTH LAYOUTS', async () => {
  /* The drag is one code path and must stay one. A layout that produced a
     different `was`, or a different destination, would corrupt the
     read-before-write check the server does against Jira — and that failure is
     silent: it does not look like an error, it looks like somebody else's move
     vanishing. */
  const stacked = await renderBacklog();
  await stacked.drag('B-1', 'S40');
  await stacked.drag('B-1', 'S41');

  const split = await renderBacklog();
  split.layout('split');
  await split.drag('B-1', 'S40', { pane: { name: 'sprints' } });
  await split.drag('B-1', 'S41', { pane: { name: 'sprints' } });

  assert.strictEqual(split.puts.length, 2, 'the split layout lost a move');
  /* COMPARED AS THE WIRE SEES THEM. The two renders are two `vm` contexts, so
     their objects carry two different `Object.prototype`s and are never
     deepStrictEqual however identical their contents — a realm difference, not
     a difference in what was written. What the server receives is JSON, so
     that is what is compared: same keys, same values, nothing dropped, and a
     real difference still fails. */
  const wire = (b) => b.puts.map(x => JSON.parse(JSON.stringify(x.body)));
  assert.deepStrictEqual(wire(split), wire(stacked),
    'the two layouts wrote different things for the same pair of drags');
});

/* ── THE PANE SCROLLS WHILE YOU HOLD A ROW OVER ITS EDGE ───────────────── */

check('DRAGGING TO THE BOTTOM EDGE SCROLLS THE PANE DOWN', async () => {
  /* Side by side, a sprint can sit below the fold of a 500px pane — and during
     a drag the wheel and the scrollbar are not yours. Browsers do auto-scroll
     here, but only sometimes and only very near the edge, which is not
     something to build a workflow on. */
  const b = await renderBacklog();
  b.layout('split');
  const { pane } = await b.drag('B-1', 'S40', {
    pane: { top: 100, bottom: 600, scrollTop: 200, scrollHeight: 2000, clientHeight: 500 },
    at: 580,
  });
  assert.ok(pane.scrollTop > 200, `the pane did not scroll down: ${pane.scrollTop}`);
});

check('AND TO THE TOP EDGE SCROLLS IT UP', async () => {
  const b = await renderBacklog();
  b.layout('split');
  const { pane } = await b.drag('B-1', 'S40', {
    pane: { top: 100, bottom: 600, scrollTop: 200, scrollHeight: 2000, clientHeight: 500 },
    at: 120,
  });
  assert.ok(pane.scrollTop < 200, `the pane did not scroll up: ${pane.scrollTop}`);
});

check('BUT THE MIDDLE OF A PANE DOES NOT MOVE IT', async () => {
  /* A pane that crept while you were aiming at a section would make the target
     move out from under the cursor. */
  const b = await renderBacklog();
  b.layout('split');
  const { pane } = await b.drag('B-1', 'S40', {
    pane: { top: 100, bottom: 600, scrollTop: 200, scrollHeight: 2000, clientHeight: 500 },
    at: 350,
  });
  assert.strictEqual(pane.scrollTop, 200, 'the pane scrolled while the cursor was nowhere near an edge');
});

check('AND A PANE WITH NOTHING TO SCROLL STAYS PUT', async () => {
  /* Below the breakpoint and in print the panes are ordinary blocks. Moving
     `scrollTop` on one would be a jump with no scrollbar to explain it. */
  const b = await renderBacklog();
  b.layout('split');
  const { pane } = await b.drag('B-1', 'S40', {
    pane: { top: 100, bottom: 600, scrollTop: 0, scrollHeight: 400, clientHeight: 500 },
    at: 580,
  });
  assert.strictEqual(pane.scrollTop, 0, 'a pane that cannot scroll was scrolled anyway');
});

check('AND THE STACKED LAYOUT IS NEVER SCROLLED BY A DRAG', async () => {
  /* There is no pane; the page's own scroll is the reader's. The whole
     behaviour has to be a no-op there, or the stacked page starts jumping. */
  const b = await renderBacklog();
  const { pane } = await b.drag('B-1', 'S40', { at: 580 });
  assert.strictEqual(pane, null, 'the stacked layout produced a pane to scroll');
  assert.strictEqual(b.puts.length, 1, 'and the drag itself stopped working');
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

check('THE ASSIGNEE FILTER LISTS WHO IS ON THE BOARD, with counts', async () => {
  /* Built from the items actually here, not the roster: a queue routinely
     carries work assigned to somebody who left, and a filter that cannot
     select them cannot find it. */
  const b = await renderBacklog();
  const pile = b.who.html();
  assert.ok(/data-who=/.test(pile), 'there is no assignee filter');
  assert.match(pile, /data-who-pick="Hien Phan"/, 'Hien Phan cannot be selected');
  assert.match(pile, /Hien Phan<\/span><span class="who-n">\d+</, 'the menu does not say how much each person carries');
  assert.match(pile, /data-who-pick="— none —"/, 'the unassigned pile has no entry of its own');
  assert.match(pile, />Unassigned</, 'the unassigned entry is labelled with the raw sentinel');

});

check('EVERY FACE CARRIES ITS NAME — the picture is never the only label', async () => {
  /* Initials in a coloured circle are a scanning affordance, not an
     identifier. Two people on this project share an initial, and a filter
     you cannot read is one you set by accident. */
  const pile = (await renderBacklog()).who.html();
  const chips = [...pile.matchAll(/<button type="button" class="who-chip[^"]*" data-who="([^"]+)"[\s\S]*?title="([^"]*)"/g)];
  assert.ok(chips.length, 'no faces in the row at all');
  for (const [, name, title] of chips) {
    const shown = name === '— none —' ? 'Unassigned' : name;
    assert.ok(title.startsWith(shown), `the face for ${name} says "${title}" — the name is not in it`);
    assert.match(title, /\d+ items?$/, `the face for ${name} does not say how much they carry`);
  }
});

check('AND IT CUTS THE WHOLE BOARD', async () => {
  const b = await renderBacklog();
  const all = b.table();
  assert.ok(all.includes('>B-1<') && all.includes('>B-8<'), 'fixture check');

  b.who.chip('Anh Truong');
  const some = b.table();
  assert.ok(some.includes('>B-8<') && some.includes('>B-9<'), "Anh Truong's items were filtered out");
  assert.ok(!some.includes('>B-1<'), "somebody else's item survived the filter");

  // And the unassigned sentinel selects exactly the ownerless one.
  b.who.chip('Anh Truong');           // off again
  b.who.chip('— none —');
  const none = b.table();
  assert.ok(none.includes('>B-5<'), 'the unassigned item was filtered out');
  assert.ok(!none.includes('>B-1<'), 'an assigned item matched the unassigned filter');
});

check('SEVERAL PEOPLE AT ONCE — the question this filter is actually asked', async () => {
  /* "What is on Anh and Hien" is what a lead asks before planning. A
     single-select turns that into two passes with the numbers held in your
     head, which is the reason this is a Set. */
  const b = await renderBacklog();
  b.who.chip('Anh Truong');
  b.who.chip('— none —');
  const t = b.table();
  assert.ok(t.includes('>B-8<') && t.includes('>B-9<'), "Anh Truong's rows were dropped by the second pick");
  assert.ok(t.includes('>B-5<'), 'the unassigned row was dropped by the first pick');
  assert.ok(!t.includes('>B-1<'), "somebody in neither selection survived");
  assert.strictEqual(saidCount(b.queue()), 3, 'the count does not match the union of the two');
});

check('THE AVATAR AND ITS CHECKBOX ARE ONE SELECTION, not two', async () => {
  /* The failure a two-control filter has: the face says selected and the
     box says not, and which one is true depends on which you clicked last.
     Both write the same Set and repaint the same markup. */
  const b = await renderBacklog();
  b.who.chip('Anh Truong');
  assert.match(b.who.html(), /data-who="Anh Truong"\s+aria-pressed="true"/, 'the face does not show as selected');
  assert.match(b.who.html(), /data-who-pick="Anh Truong" checked/, 'the box disagrees with the face');

  b.who.pick('Anh Truong');           // untick from the menu
  assert.match(b.who.html(), /data-who="Anh Truong"\s+aria-pressed="false"/, 'unticking the box left the face selected');
  assert.ok(!/data-who-pick="Anh Truong" checked/.test(b.who.html()), 'the box stayed ticked');
  assert.ok(b.table().includes('>B-1<'), 'the rows never came back');
});

check('A SELECTED PERSON IS PROMOTED INTO THE ROW — a filter you cannot see is one you forget', async () => {
  /* The row shows the busiest six. Picking somebody out of the overflow
     menu has to put their face on screen, or the board sits filtered by a
     person who appears nowhere on it — and the only clue is a row count
     that looks like a small team. */
  const many = { ...PAYLOAD };
  many.items = ITEMS.map((i, n) => ({ ...i, assignee: `Person ${String.fromCharCode(65 + n)}` }));
  many.items.push(item('B-RARE', { assignee: 'Zoe Last' }));
  many.total = many.items.length;
  const b = await renderBacklog(many);
  assert.ok(!/data-who="Zoe Last"/.test(b.who.html()),
    'fixture check: Zoe carries the least, so she starts in the overflow');

  /* THE MENU LISTS EVERYONE, not just the faces that fit in the row. Ten
     people and six slots: the row is capped and the menu is the only way
     past it, so a menu holding the same six is a control with nothing
     behind it and the other four are unreachable by any means. Asserted
     HERE rather than against the small fixture, where three people fit in
     six slots and truncation would change nothing. */
  const everyone = new Set(everyRowOf(many).map(i => i.assignee || '— none —'));
  assert.ok(everyone.size > 6, `fixture check: ${everyone.size} people is not more than the row holds`);
  const pile = b.who.html();
  for (const name of everyone) {
    assert.ok(pile.includes(`data-who-pick="${name}"`), `${name} is on the board and not in the menu`);
  }
  assert.ok((pile.match(/data-who="/g) || []).length <= 6, 'the row is not capped at all, so nothing is behind the +N');

  b.who.pick('Zoe Last');
  assert.match(b.who.html(), /data-who="Zoe Last"\s+aria-pressed="true"/,
    'picking from the menu left her face off the row');
  assert.ok(b.table().includes('>B-RARE<'), 'and the filter did not take');

  /* AND SHE STAYS when deselected — pulling the face back out would make
     the row shuffle as you worked down a list of people. */
  b.who.pick('Zoe Last');
  assert.match(b.who.html(), /data-who="Zoe Last"\s+aria-pressed="false"/,
    'deselecting pulled her face out from under the cursor');
});

check('THE +N MENU OPENS, SHUTS ON ESCAPE, AND STAYS OPEN WHILE YOU TICK', async () => {
  /* A popover that closed on every tick would make selecting three people
     three round trips; one that only a click could close is a trap for
     anyone filtering from the keyboard. */
  const b = await renderBacklog();
  assert.match(b.who.html(), /data-who-panel hidden/, 'the menu starts open');

  b.who.more();
  assert.ok(!/data-who-panel hidden/.test(b.who.html()), 'the +N button did not open the menu');
  b.who.pick('Hien Phan');
  assert.ok(!/data-who-panel hidden/.test(b.who.html()), 'ticking a box closed the menu you were ticking in');

  b.who.esc();
  assert.match(b.who.html(), /data-who-panel hidden/, 'Escape did not shut the menu');

  b.who.more();
  b.who.away();
  assert.match(b.who.html(), /data-who-panel hidden/, 'a click elsewhere did not shut the menu');
});

check('CLEAR PUTS EVERYONE BACK, and only appears when there is something to clear', async () => {
  const b = await renderBacklog();
  assert.ok(!/data-who-clear/.test(b.who.html()), 'a Clear button offered with nothing selected');

  b.who.chip('Anh Truong');
  assert.match(b.who.html(), /data-who-clear/, 'no way to undo the filter');
  b.who.clear();
  assert.ok(!/data-who-clear/.test(b.who.html()), 'Clear survived clearing');
  assert.strictEqual(saidCount(b.queue()), ITEMS.length, 'clearing did not restore the board');
});

check('AND A FRESH TEAM STARTS WITH NOBODY SELECTED', async () => {
  /* Whoever was selected on the last team is not necessarily on this one,
     so the selection is dropped with the payload — the same as the page
     number. Leaving it would show an empty board for a filter naming
     somebody who does not work here. */
  const b = await renderBacklog();
  b.who.chip('Anh Truong');
  assert.strictEqual(saidCount(b.queue()), 2, 'fixture check');

  const again = await renderBacklog(PAYLOAD, b.app);
  assert.strictEqual(saidCount(again.queue()), ITEMS.length, "the new team's board opened filtered by the old team's people");
  assert.ok(!/data-who-clear/.test(again.who.html()), 'and it still offers to clear a filter nobody set');
});

check('THE ASSIGNEE CELL SHOWS A FACE ON SCREEN AND A NAME ON PAPER', async () => {
  /* `.avatar` is display:none in print. A cell holding ONLY an avatar would
     print an empty Assignee column on every exported PDF — silently, since
     nothing on screen would look wrong. */
  const b = await renderBacklog();
  const row = b.queue().split('<tr ').find(r => r.includes('>B-1<'));
  assert.match(row, /<td class="who-cell" title="Hien Phan">/, 'the cell does not name its person on hover');
  assert.match(row, /class="avatar"/, 'there is no avatar in the cell');
  assert.match(row, /<span class="who-name">Hien Phan<\/span>/, 'the cell has no printable name');

  const nobody = b.queue().split('<tr ').find(r => r.includes('>B-5<'));
  assert.match(nobody, /title="Unassigned"/, 'an unowned row does not say so on hover');
  assert.match(nobody, /class="avatar nobody"/, 'the unowned row got a person\'s avatar');
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

/** Every row on a payload, sprints and queue alike. */
const everyRowOf = (p) => [...(p.items || []), ...(p.sections || []).flatMap(s => s.items || [])];

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

check('THE WHOLE HEAD FOLDS IT — the title, the counts, the bar', async () => {
  /* HIS REQUEST, and the reason for it: the twisty is 11px of arrow at the
     far left of a bar that runs the width of the page. Everything beside it
     reads as part of the same control and did nothing when clicked, so
     shutting a 594-row queue meant hitting a target the size of a full stop,
     dozens of times an afternoon. */
  const b = await renderBacklog(BOARD);

  b.fold('S40', 'title');
  assert.strictEqual(rowsIn(b.sec('S40')).length, 0, 'clicking the sprint name did nothing');
  b.fold('S40', 'title');
  assert.strictEqual(rowsIn(b.sec('S40')).length, 2, 'and it would not open again from the name');

  b.fold('S40', 'meta');
  assert.strictEqual(rowsIn(b.sec('S40')).length, 0, 'clicking "2 items · 8 pts" did nothing');

  /* THE BAR, not just the words on it. A head is mostly empty space and that
     space is the easiest thing to hit. */
  b.fold('S40', 'head');
  assert.strictEqual(rowsIn(b.sec('S40')).length, 2, 'the empty part of the bar is dead');
});

check('and the twisty still folds it, being the keyboard path', async () => {
  /* Widening where a mouse may land must not cost the one control that is in
     the tab order and announces `aria-expanded`. */
  const b = await renderBacklog(BOARD);
  b.fold('S40', 'fold');
  assert.strictEqual(rowsIn(b.sec('S40')).length, 0, 'the twisty stopped working');
  assert.match(b.sec('S40'), /<button class="bl-fold"[^>]*aria-expanded="false"/,
    'the twisty is gone, or no longer says which way it is');
});

check('BUT A CONTROL IN THE HEAD IS STILL ITSELF', async () => {
  /* "Open in Jira" sits in the head. Folding the section underneath it as
     well would be one click doing two things — and the fold is the one you
     did not ask for, discovered only when you come back from Jira to a page
     that has rearranged itself. */
  const b = await renderBacklog(BOARD);
  b.fold('S40', 'jira');
  assert.strictEqual(rowsIn(b.sec('S40')).length, 2,
    'the link out to Jira also folded the section it was sitting in');

  /* A BUTTON IN THE HEAD, for the next one that lands there. The twisty is
     the only one today, and it is the exception — it IS the fold. */
  b.fold('S40', 'action');
  assert.strictEqual(rowsIn(b.sec('S40')).length, 2,
    'a button in the head folded the section as well as doing its own job');
});

check('AND A CLICK IN THE BODY IS NOT A CLICK ON THE HEAD', async () => {
  /* Every row lives inside `[data-sec]` too. A handler that read the section
     off the click without first checking it was in the HEAD would fold the
     section on any click on any of its 594 rows — including the one that
     opens an issue. */
  const b = await renderBacklog(BOARD);
  b.fold('S40', 'row');
  assert.strictEqual(rowsIn(b.sec('S40')).length, 2, 'clicking a row folded the section around it');
  b.fold('S40', 'body');
  assert.strictEqual(rowsIn(b.sec('S40')).length, 2, 'clicking the body folded the section around it');
});

check('AND HIGHLIGHTING THE TITLE DOES NOT FOLD IT AWAY', async () => {
  /* Releasing the mouse after dragging across "Ruby Sprint 40" fires a click
     on the head. Folding at that moment takes the text you just selected off
     the screen, which is the most annoying possible answer to "I wanted to
     copy this". */
  const b = await renderBacklog(BOARD);
  b.ctx.getSelection = () => ({ isCollapsed: false, toString: () => 'Ruby Sprint 40' });
  b.fold('S40', 'title');
  assert.strictEqual(rowsIn(b.sec('S40')).length, 2, 'selecting the sprint name folded the section');

  /* AN EMPTY SELECTION IS NOT A SELECTION. A collapsed caret sits in the
     document after any ordinary click, so treating "a selection exists" as
     "do nothing" would make the whole bar dead again. */
  b.ctx.getSelection = () => ({ isCollapsed: true, toString: () => '' });
  b.fold('S40', 'title');
  assert.strictEqual(rowsIn(b.sec('S40')).length, 0, 'an ordinary click stopped folding');
});

check('THE HEAD LOOKS CLICKABLE, or nobody finds out that it is', async () => {
  /* A hit area with no cursor and no hover is one you never discover. The
     controls inside it keep their own cursor, because they do their own
     thing. */
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.bl-sec-head\s*\{\s*cursor:\s*pointer/,
    'the head does not say it can be clicked');
  assert.match(css, /\.bl-sec-head:hover\s*\{[^}]*background/,
    'the head gives no sign it is under the pointer');
  assert.match(css, /\.bl-sec-head\s+:is\([^)]*input[^)]*\)\s*\{\s*cursor:\s*auto/,
    'a field in the head shows the folding cursor');
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
  assert.ok(b.sec('S41').includes('>B-1<'), 'fixture check: the row moved');

  /* ASSERTED THROUGH THE NEXT MOVE, not off the row's markup. A sprint
     section no longer draws the Sprint picker — inside one, that column
     printed the section's own heading on every row — so `data-was` is not on
     screen there to read. What matters was never the attribute: it is that
     the item's own sprint list was rewritten, and the only way to see that
     is to move it again and look at what gets sent. */
  await b.drag('B-1', 'S40');
  assert.deepEqual(b.puts[1].body, { key: 'B-1', teamId: 'ruby', sprintId: 'S40', was: 'Ruby Sprint 41' },
    'the second move sent a stale `was` — the moved row still thinks it is where it was');

  /* AND BACK IN THE QUEUE THE PICKER IS RIGHT, because that is where it is
     drawn. A row returned to the backlog must offer Backlog as its selected
     option or the next keyboard move sends a `was` naming a sprint it left. */
  await b.drag('B-1', 'backlog');
  const queued = b.queue().split('<tr ').find(r => r.includes('>B-1<'));
  assert.match(queued, /data-was=""/, 'a row back in the queue still claims a sprint');
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

  b.who.chip('Anh Truong');
  assert.deepStrictEqual(rowsIn(b.sec('S40')), ['S-1'], "the sprint kept somebody else's rows");
  assert.strictEqual(rowsIn(b.sec('S41')).length, 0, 'a sprint with no match for the filter still drew rows');
  assert.ok(rowsIn(b.queue()).includes('B-8'), 'the queue lost the rows that do match');
});

check('AND EVERY HEAD SAYS HOW MANY OF ITS OWN IT IS SHOWING', async () => {
  /* "1 of 2 items" — both numbers, so a filtered board can never be mistaken
     for a smaller sprint. */
  const b = await renderBacklog(BOARD);
  b.who.chip('Anh Truong');
  assert.match(b.sec('S40'), /1 of 2 items/, 'the sprint head hid the fact that it is filtered');
  assert.match(b.sec('S41'), /0 of 1 items/);
  assert.match(b.sec('S41'), /Nothing here matches these filters/,
    'an empty filtered sprint reads as an empty sprint');
});

check('THE ASSIGNEE PICKER OFFERS EVERYONE ON THE BOARD, not just the queue', async () => {
  /* An option that could select nothing in the sprints would make a person
     with only committed work appear to have none. */
  // Two queued (B-8, B-9) and one committed (S-1). Counting the queue
  // alone would say 2, which is the failure this is here for.
  const pile = (await renderBacklog(BOARD)).who.html();
  assert.match(pile, /Anh Truong<\/span><span class="who-n">3</, 'the picker counts only the queue');
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

/* ── THE COLUMNS, AND THE KPI THAT OPENS ──────────────────────────────────
 *
 * Four changes, one theme: a number or a cell on this page should answer the
 * question it raises without making you go somewhere else. "195 blocked"
 * opens. A row says what Jira calls it and when it is due. And the Sprint
 * column stops printing the section's own heading on every row inside it.
 */

/** A payload whose rows exercise every "nothing here" case a cell has. */
const COLUMNS = (() => {
  const rows = [
    item('C-1', { status: 'Refinement', dueDate: '2026-01-15', category: 'maintenance' }),
    item('C-2', { category: null, dueDate: null }),       // no category, no due date
    item('C-3', { status: '', dueDate: '2099-12-31' }),   // no status, far-future due date
  ];
  return {
    ...PAYLOAD,
    items: rows,
    total: rows.length,
    blocked: { count: 1, items: [{ key: 'C-1' }] },
    today: '2026-06-01',
    sections: [
      { ...PAYLOAD.sections[0], count: 1, points: 3, items: [item('S-1', { status: 'In Dev', dueDate: '2026-02-01', category: 'maintenance' })] },
      PAYLOAD.sections[1],
    ],
  };
})();

const rowFor = (html, key) => html.split('<tr ').find(r => r.includes(`>${key}<`)) || '';
const headsOf = (html) => [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map(m => m[1].replace(/<[^>]*>/g, ''));

check('A ROW SAYS WHAT JIRA CALLS IT, AND WHEN IT IS DUE', async () => {
  const b = await renderBacklog(COLUMNS);
  const heads = headsOf(b.queue());
  for (const h of ['Status', 'Due']) {
    assert.ok(heads.includes(h), `the queue has no ${h} column — it has ${JSON.stringify(heads)}`);
  }
  const row = rowFor(b.queue(), 'C-1');
  assert.match(row, /Refinement/, 'the row does not show its Jira status');
  assert.match(row, /2026-01-15/, 'the row does not show its due date');
});

check('AND BOTH COLUMNS ARE IN THE SPRINT SECTIONS TOO', async () => {
  /* The whole point of the two halves on one screen is that they read
     across. A column on one and not the other makes the comparison a
     translation exercise. */
  const b = await renderBacklog(COLUMNS);
  const heads = headsOf(b.sec('S40'));
  for (const h of ['Status', 'Due', 'Category']) {
    assert.ok(heads.includes(h), `the sprint section has no ${h} column`);
  }
  const row = rowFor(b.sec('S40'), 'S-1');
  assert.match(row, /In Dev/, 'the sprint row does not show its status');
  assert.match(row, /2026-02-01/, 'the sprint row does not show its due date');
});

check('THE SPRINT COLUMN IS ONLY IN THE QUEUE', async () => {
  /* Inside a sprint section it would print the section's own heading on
     every row — the answer is the box the row is sitting in. */
  const b = await renderBacklog(COLUMNS);
  assert.ok(headsOf(b.queue()).includes('Sprint'), 'the queue lost its Sprint picker');
  assert.ok(!headsOf(b.sec('S40')).includes('Sprint'),
    'a sprint section still draws the Sprint column');
  assert.ok(!/data-sprint-key/.test(b.sec('S40')),
    'a sprint section still draws the picker itself');
  assert.match(b.queue(), /data-sprint-key/, 'the queue lost the picker');
});

check('TWO COLUMNS THAT SOUND ALIKE ARE NAMED APART', async () => {
  /* Status is what Jira says; Readiness is what this page says. Side by side
     as "Status" and "State" they would be two words for two different
     things, one letter apart. */
  const heads = headsOf((await renderBacklog(COLUMNS)).queue());
  assert.ok(heads.includes('Readiness'), 'the readiness column is still called something else');
  assert.ok(!heads.includes('State'), '"State" is still there beside "Status"');
});

check('AN ABSENT CATEGORY, STATUS OR DUE DATE READS AS ITSELF', async () => {
  /* Each of these is a real state on real rows. An empty cell reads as a
     rendering fault, and a coloured chip around nothing is worse. */
  const b = await renderBacklog(COLUMNS);
  const none = rowFor(b.queue(), 'C-2');
  assert.match(none, /No category rule matched/, 'a row with no category drew a blank cell');
  assert.ok(!/class="tag"><i class="dot" style="background:undefined/.test(none),
    'a row with no category drew a chip around nothing');
  const noStatus = rowFor(b.queue(), 'C-3');
  assert.match(noStatus, /—/, 'a row with no status drew an empty cell');
});

check('THE BLOCKED KPI OPENS', async () => {
  /* "195 blocked" is where the question "which ones?" is loudest, and the
     only answer used to be the Blocked chip, which filters the table and
     loses your place. */
  const b = await renderBacklog(COLUMNS);
  assert.match(b.page(), /data-act="bl-blocked"/, 'the Blocked KPI is not a control');
  assert.match(b.page(), /<button[^>]*data-act="bl-blocked"/, 'it is not a real button');
});

check('AND IT LISTS EXACTLY THE SET THE NUMBER COUNTED', async () => {
  /* Built from the list the KPI counted, not from a second filter over the
     queue — a second implementation of "which ones are blocked" is how a
     drawer comes to list 193 under a number saying 195. */
  const b = await renderBacklog(COLUMNS);
  b.blockedKpi();
  const d = b.drawn();
  assert.ok(d, 'clicking the KPI opened nothing');
  assert.match(d, /C-1/, 'the drawer does not list the blocked item');
  assert.ok(!/C-2/.test(d), 'the drawer listed an item that is not blocked');
  assert.match(d, /Refinement/, 'the drawer does not say what blocked means here');
});

check('THE BLOCKED LIST IS NOT CAPPED — the count and the list agree at any size', async () => {
  /* It was capped at 50 when nothing read it. With Titan at 195 the drawer
     would have listed 50 under a number saying 195, with nothing on screen
     to say why. */
  const many = Array.from({ length: 120 }, (_, i) => item(`BLK-${String(i).padStart(3, '0')}`, { status: 'Refinement' }));
  const big = { ...COLUMNS, items: many, total: many.length, blocked: { count: many.length, items: many.map(i => ({ key: i.key })) } };
  const b = await renderBacklog(big);
  b.blockedKpi();
  const d = b.drawn();
  const listed = (d.match(/BLK-\d{3}/g) || []).length;
  assert.strictEqual(new Set(d.match(/BLK-\d{3}/g) || []).size, 120,
    `the drawer listed ${listed} of the 120 the KPI counted`);
});
