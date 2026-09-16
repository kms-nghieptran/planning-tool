'use strict';
/**
 * sort.test.js — clicking a column heading.
 *
 * WHAT MAKES THIS MORE THAN A SORT
 *
 * Every grid in the app is sortable from one helper, so the helper has to know
 * the things the fifteen views know about their own tables and would each have
 * got slightly differently:
 *
 *   · A `total` row summarises the rows above it. Sorted into the middle it
 *     becomes a claim about one row.
 *   · A `detail-row` is the panel belonging to the row above it. Sorted away
 *     from its owner it describes the wrong component.
 *   · A row whose cell spans the table is a note, not a record.
 *   · "—" is not a small number. It is the absence of one, and it belongs at
 *     the bottom whichever way the column points.
 *   · A column is numeric only if ALL of it is, or 10 sorts before 9.
 *   · The search grid sorts on the SERVER because it is paginated; sorting its
 *     visible fifty rows here would claim to have sorted the other thousands.
 *
 * Each of those is a rule that looks like a detail and reads like a bug when it
 * is missing, so each has a check below.
 *
 * Run: node test/sort.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

/* ── a DOM, small enough to read ──────────────────────────────────────── */

/** What a browser gives back from `textContent`, entities and all. */
const decode = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

function parse(html) {
  const VOID = new Set(['input', 'br', 'img', 'hr']);
  const root = node('div', 'id="root"');
  const stack = [root];
  const re = /<\/?([a-zA-Z][\w-]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const [raw, tag, attrs, text] = m;
    if (text != null) {
      const t = decode(text).replace(/\s+/g, ' ').trim();
      if (t) stack[stack.length - 1].text += t;
      continue;
    }
    if (raw.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    const el = node(tag, attrs || '');
    stack[stack.length - 1].appendChild(el);
    if (!VOID.has(tag.toLowerCase()) && !raw.endsWith('/>')) stack.push(el);
  }
  return root;
}

function node(tag, attrStr = '') {
  const attrs = {};
  for (const a of attrStr.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
    if (a[1]) attrs[a[1]] = a[2] == null ? '' : decode(a[2]);
  }
  const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
  // A live view of the data-* attributes, so a write through `dataset` is
  // visible to `getAttribute` and to the attribute selectors below — the same
  // way a real one is, and the sorter relies on exactly that.
  const dataset = new Proxy({}, {
    get: (_, k) => (typeof k === 'string' ? attrs[`data-${dash(k)}`] : undefined),
    set: (_, k, v) => { attrs[`data-${dash(k)}`] = String(v); return true; },
    has: (_, k) => `data-${dash(k)}` in attrs,
  });
  const el = {
    tagName: tag.toUpperCase(),
    children: [], parent: null, text: '', listeners: {}, attrs, dataset,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on == null ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : on ? classes.add(c) : classes.delete(c)),
    },
    get className() { return [...classes].join(' '); },
    get textContent() { return [el.text, ...el.children.map(c => c.textContent)].filter(Boolean).join(' '); },
    appendChild(c) {
      if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1);
      c.parent = el; el.children.push(c);
      return c;
    },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return attrs[k] == null ? null : attrs[k]; },
    hasAttribute(k) { return k in attrs; },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    fire(type, e = {}) { for (const fn of (el.listeners[type] || []).slice()) fn({ preventDefault() {}, target: el, ...e }); },
    matches(sel) {
      for (const part of sel.split(/\s+/).filter(Boolean).slice(-1)) {
        const attr = /\[([\w-]+)\]$/.exec(part);
        const base = part.replace(/\[[\w-]+\]$/, '');
        if (attr && !(attr[1] in attrs)) return false;
        for (const c of base.split('.').slice(1)) if (!classes.has(c)) return false;
        const tagPart = base.split('.')[0];
        if (tagPart && tagPart !== '*' && el.tagName !== tagPart.toUpperCase()) return false;
      }
      return true;
    },
    querySelectorAll(sel) {
      // Descendant selectors are handled by matching the LAST part and then
      // checking an ancestor matches the first — enough for "thead tr".
      const parts = sel.split(/\s+/).filter(Boolean);
      const out = [];
      for (const c of el.children) {
        if (c.matches(parts[parts.length - 1]) && (parts.length === 1 || hasAncestor(c, parts[0], el))) out.push(c);
        out.push(...c.querySelectorAll(sel));
      }
      return out;
    },
    querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
    closest(sel) { let n = el; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parent; } return null; },
  };
  return el;
}

const dash = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const hasAncestor = (el, sel, stopAt) => {
  let n = el.parent;
  while (n && n !== stopAt.parent) { if (n.matches(sel)) return true; n = n.parent; }
  return false;
};

/* ── the helper under test ────────────────────────────────────────────── */

const UI = (() => {
  const ctx = { console, document: { querySelector: () => null, querySelectorAll: () => [] } };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);
  return ctx.UI;
})();

/**
 * Build a grid, wire the real `UI.sortable` to it, and hand back a handle that
 * clicks headings and reads the resulting order.
 */
function grid(html) {
  const root = parse(`<div>${html}</div>`);
  UI.sortable(root);
  const table = root.querySelector('table');
  const heads = () => table.querySelector('thead tr').children;
  return {
    root, table,
    click(label, times = 1) {
      const th = heads().find(h => h.textContent.trim() === label);
      assert.ok(th, `no heading called "${label}"`);
      for (let n = 0; n < times; n++) root.fire('click', { target: th });
      return this;
    },
    th: (label) => heads().find(h => h.textContent.trim() === label),
    /** The first cell of every row in the body, in the order they now sit. */
    col(i = 0) {
      return table.querySelector('tbody').children
        .filter(r => r.tagName === 'TR')
        .map(r => (r.children[i] ? r.children[i].textContent.trim() : ''));
    },
    classes: () => table.querySelector('tbody').children.map(r => r.className),
  };
}

const ROWS = [
  { name: 'Charlie', pts: '9' },
  { name: 'alice', pts: '10' },
  { name: 'Bob', pts: '2' },
];

const simple = () => grid(`
  <table>
    <thead><tr><th>Name</th><th class="num">Points</th></tr></thead>
    <tbody>${ROWS.map(r => `<tr><td>${r.name}</td><td class="num">${r.pts}</td></tr>`).join('')}</tbody>
  </table>`);

/* ── the basics ───────────────────────────────────────────────────────── */

check('a heading sorts the rows under it', () => {
  assert.deepStrictEqual(simple().click('Name').col(), ['alice', 'Bob', 'Charlie']);
});

check('clicking it again reverses', () => {
  assert.deepStrictEqual(simple().click('Name', 2).col(), ['Charlie', 'Bob', 'alice']);
});

check('AND A THIRD CLICK GIVES BACK THE ORDER THE VIEW CHOSE', () => {
  // A sprint list is in sprint order and a backlog is in priority order for a
  // reason. A sort you can only undo by reloading the page destroys that.
  assert.deepStrictEqual(simple().click('Name', 3).col(), ['Charlie', 'alice', 'Bob']);
});

check('and a fourth starts over', () => {
  assert.deepStrictEqual(simple().click('Name', 4).col(), ['alice', 'Bob', 'Charlie']);
});

check('A NUMBER COLUMN SORTS AS NUMBERS, not as text', () => {
  // The whole reason this is not a one-line localeCompare: as text, 10 < 9.
  assert.deepStrictEqual(simple().click('Points').col(1), ['2', '9', '10']);
});

check('A THOUSANDS SEPARATOR IS PART OF THE NUMBER, not a full stop in a string', () => {
  // `UI.int` renders 4100 as "4,100". A text sort — even a natural one, which
  // gets plain 2/9/10 right and so hides this — reads that as 4 and files it
  // before 900. Every count in the coverage report runs into four figures.
  const g = grid(`
    <table>
      <thead><tr><th>Component</th><th class="num">Epics</th></tr></thead>
      <tbody>
        <tr><td>PS_iGO_NLG</td><td class="num">${UI.int(4100)}</td></tr>
        <tr><td>R_AFFIRM</td><td class="num">${UI.int(900)}</td></tr>
      </tbody>
    </table>`);
  assert.deepStrictEqual(g.click('Epics').col(), ['R_AFFIRM', 'PS_iGO_NLG']);
});

check('and a percentage sorts by its number', () => {
  const g = grid(`
    <table>
      <thead><tr><th>Component</th><th class="num">Coverage</th></tr></thead>
      <tbody>
        <tr><td>A</td><td class="num">${UI.pct(9.5)}</td></tr>
        <tr><td>B</td><td class="num">${UI.pct(100)}</td></tr>
        <tr><td>C</td><td class="num">${UI.pct(12)}</td></tr>
      </tbody>
    </table>`);
  assert.deepStrictEqual(g.click('Coverage').col(), ['A', 'C', 'B']);
});

check('sorting a second column releases the first', () => {
  const g = simple().click('Name').click('Points');
  assert.ok(!g.th('Name').className.includes('sort-'), 'two columns claim to be the sort');
  assert.ok(g.th('Points').className.includes('sort-asc'));
});

check('the sorted column says so, for a screen reader as well as an eye', () => {
  const g = simple().click('Name');
  assert.strictEqual(g.th('Name').getAttribute('aria-sort'), 'ascending');
  g.click('Name');
  assert.strictEqual(g.th('Name').getAttribute('aria-sort'), 'descending');
  g.click('Name');
  assert.strictEqual(g.th('Name').getAttribute('aria-sort'), 'none', 'back to unsorted must say unsorted');
});

/* ── what must not move ───────────────────────────────────────────────── */

const withTotal = () => grid(`
  <table>
    <thead><tr><th>Name</th><th class="num">Points</th></tr></thead>
    <tbody>
      <tr><td>Charlie</td><td class="num">9</td></tr>
      <tr><td>alice</td><td class="num">10</td></tr>
      <tr class="total"><td>Team total</td><td class="num">19</td></tr>
    </tbody>
  </table>`);

check('A TOTAL ROW STAYS AT THE BOTTOM, both ways up', () => {
  assert.deepStrictEqual(withTotal().click('Points').col(), ['Charlie', 'alice', 'Team total']);
  assert.deepStrictEqual(withTotal().click('Points', 2).col(), ['alice', 'Charlie', 'Team total']);
});

check('and so does the unassigned row', () => {
  const g = grid(`
    <table>
      <thead><tr><th>Name</th><th class="num">Points</th></tr></thead>
      <tbody>
        <tr><td>Charlie</td><td class="num">9</td></tr>
        <tr><td>alice</td><td class="num">10</td></tr>
        <tr class="unassigned-row"><td>Unassigned</td><td class="num">4</td></tr>
      </tbody>
    </table>`);
  assert.deepStrictEqual(g.click('Points').col(), ['Charlie', 'alice', 'Unassigned']);
});

check('a note row that spans the table is not a record and does not move', () => {
  const g = grid(`
    <table>
      <thead><tr><th>Name</th><th class="num">Points</th></tr></thead>
      <tbody>
        <tr><td>Charlie</td><td class="num">9</td></tr>
        <tr><td>alice</td><td class="num">10</td></tr>
        <tr><td colspan="2">Bulk note: two people came off this sprint</td></tr>
      </tbody>
    </table>`);
  // Sorted as data this lands BETWEEN alice and Charlie, which is the point:
  // a note that sorts last by luck proves nothing.
  assert.deepStrictEqual(g.click('Name').col(),
    ['alice', 'Charlie', 'Bulk note: two people came off this sprint']);
});

check('A DETAIL ROW TRAVELS WITH THE ROW IT BELONGS TO', () => {
  // The coverage grid's expandable panel. Sorted away from its owner it sits
  // under a different component and describes it wrongly.
  const g = grid(`
    <table>
      <thead><tr><th>Component</th><th class="num">Epics</th></tr></thead>
      <tbody>
        <tr><td>PS_iGO_NLG</td><td class="num">9</td></tr>
        <tr class="detail-row"><td colspan="2">detail for NLG</td></tr>
        <tr><td>R&amp;D_AFFIRM</td><td class="num">2</td></tr>
        <tr class="detail-row"><td colspan="2">detail for AFFIRM</td></tr>
      </tbody>
    </table>`);
  assert.deepStrictEqual(g.click('Epics').col(),
    ['R&D_AFFIRM', 'detail for AFFIRM', 'PS_iGO_NLG', 'detail for NLG']);
});

/* ── missing data ─────────────────────────────────────────────────────── */

const withBlanks = () => grid(`
  <table>
    <thead><tr><th>Key</th><th class="num">Points</th></tr></thead>
    <tbody>
      <tr><td>A-1</td><td class="num">5</td></tr>
      <tr><td>A-2</td><td class="num">—</td></tr>
      <tr><td>A-3</td><td class="num">1</td></tr>
    </tbody>
  </table>`);

check('AN UNESTIMATED ROW SORTS LAST GOING UP', () => {
  assert.deepStrictEqual(withBlanks().click('Points').col(), ['A-3', 'A-1', 'A-2']);
});

check('and last coming down too — "—" is not a small number', () => {
  assert.deepStrictEqual(withBlanks().click('Points', 2).col(), ['A-1', 'A-3', 'A-2']);
});

check('one blank does not turn the whole column back into text', () => {
  const g = grid(`
    <table>
      <thead><tr><th>Key</th><th class="num">Points</th></tr></thead>
      <tbody>
        <tr><td>A-1</td><td class="num">9</td></tr>
        <tr><td>A-2</td><td class="num">—</td></tr>
        <tr><td>A-3</td><td class="num">10</td></tr>
      </tbody>
    </table>`);
  assert.deepStrictEqual(g.click('Points').col(), ['A-1', 'A-3', 'A-2'], '10 must still sort after 9');
});

/* ── cells whose text is not the value ────────────────────────────────── */

check('A DATE COLUMN SORTS BY ITS DATE, not by the words shown', () => {
  // "3 Sep" and "17 Sep" sort the wrong way round as text, and every sprint
  // table in the app renders dates exactly like that.
  const g = grid(`
    <table>
      <thead><tr><th>Sprint</th><th>Dates</th></tr></thead>
      <tbody>
        <tr><td>Sprint 40</td><td data-sort-value="2026-09-17">17 Sep – 30 Sep</td></tr>
        <tr><td>Sprint 39</td><td data-sort-value="2026-09-03">3 Sep – 16 Sep</td></tr>
      </tbody>
    </table>`);
  assert.deepStrictEqual(g.click('Dates').col(), ['Sprint 39', 'Sprint 40']);
});

check('A BAR COLUMN SORTS BY WHAT THE BAR SHOWS', () => {
  // A bar is a cell with no text in it. Without the value the bar carries,
  // every row in the column reads as blank and the sort does nothing at all.
  const g = grid(`
    <table>
      <thead><tr><th>Name</th><th>Progress</th></tr></thead>
      <tbody>
        <tr><td>Charlie</td><td>${UI.bar(1, 4)}</td></tr>
        <tr><td>alice</td><td>${UI.bar(3, 4)}</td></tr>
        <tr><td>Bob</td><td>${UI.bar(2, 4)}</td></tr>
      </tbody>
    </table>`);
  assert.deepStrictEqual(g.click('Progress').col(), ['Charlie', 'Bob', 'alice']);
});

check('a cell that has both text and a bar sorts by the text', () => {
  const g = grid(`
    <table>
      <thead><tr><th>Sprint</th><th>Attainment</th></tr></thead>
      <tbody>
        <tr><td>S1</td><td>${UI.bar(1, 4)} 90%</td></tr>
        <tr><td>S2</td><td>${UI.bar(3, 4)} 20%</td></tr>
      </tbody>
    </table>`);
  assert.deepStrictEqual(g.click('Attainment').col(), ['S2', 'S1']);
});

/* ── which tables are ours ────────────────────────────────────────────── */

check('THE SEARCH GRID IS LEFT TO ITS OWN SERVER-SIDE SORT', () => {
  // It is paginated: sorting the rows on screen would silently claim to have
  // sorted the thousands behind them.
  const g = grid(`
    <table class="result-table">
      <thead><tr><th class="sortable" data-sort="key">Key</th><th class="sortable" data-sort="points">Points</th></tr></thead>
      <tbody>
        <tr><td>A-2</td><td class="num">9</td></tr>
        <tr><td>A-1</td><td class="num">10</td></tr>
      </tbody>
    </table>`);
  assert.strictEqual(g.th('Key').dataset.sortCol, undefined, 'the shared sorter claimed a grid that sorts itself');
  g.click('Key');
  assert.deepStrictEqual(g.col(), ['A-2', 'A-1'], 'the rows moved — it was sorted twice');
});

check('a table can opt out entirely', () => {
  const g = grid(`
    <table data-nosort>
      <thead><tr><th>Name</th></tr></thead>
      <tbody><tr><td>Charlie</td></tr><tr><td>alice</td></tr></tbody>
    </table>`);
  g.click('Name');
  assert.deepStrictEqual(g.col(), ['Charlie', 'alice']);
});

check('and so can one column of it', () => {
  const g = grid(`
    <table>
      <thead><tr><th>Name</th><th data-nosort>Actions</th></tr></thead>
      <tbody><tr><td>Charlie</td><td>x</td></tr><tr><td>alice</td><td>y</td></tr></tbody>
    </table>`);
  assert.strictEqual(g.th('Actions').dataset.sortCol, undefined);
  assert.ok(g.th('Name').className.includes('sortable'));
});

check('an empty heading is an actions column, not a sortable one', () => {
  const g = grid(`
    <table>
      <thead><tr><th>Name</th><th></th></tr></thead>
      <tbody><tr><td>Charlie</td><td>x</td></tr></tbody>
    </table>`);
  const blank = g.table.querySelector('thead tr').children[1];
  assert.ok(!blank.className.includes('sortable'), 'a heading with nothing in it has nothing to order by');
});

/* ── how it is bound ──────────────────────────────────────────────────── */

check('ONE LISTENER ON THE CONTAINER, whatever the table count', () => {
  // Same guarantee ui-wiring.test.js pins for views: bind to the per-render
  // container, so the wiring dies with the render instead of accumulating.
  const root = parse(`<div>
    <table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>
    <table><thead><tr><th>B</th></tr></thead><tbody><tr><td>2</td></tr></tbody></table>
  </div>`);
  UI.sortable(root);
  assert.strictEqual((root.listeners.click || []).length, 1);
});

check('a container with no tables in it is harmless', () => {
  const root = parse('<div><p>nothing here</p></div>');
  UI.sortable(root);
  root.fire('click', { target: root.querySelector('p') });
  assert.ok(true);
});

/* ── the stylesheet ───────────────────────────────────────────────────── */

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

check('a sortable heading looks clickable and shows which way it points', () => {
  assert.match(css, /^th\.sortable \{[^}]*cursor: pointer/m, 'nothing says the heading can be clicked');
  assert.match(css, /^th\.sortable\.sort-asc::after/m, 'no ascending indicator');
  assert.match(css, /^th\.sortable\.sort-desc::after/m, 'no descending indicator');
});

check('and the indicator reserves its space, so clicking does not shift the row', () => {
  const at = css.search(/^th\.sortable::after \{/m);
  assert.ok(at > 0, 'the resting indicator is missing, so the caret appears from nowhere');
  assert.match(css.slice(at, css.indexOf('}', at)), /opacity: 0/,
    'the resting indicator must take up room while staying invisible');
});

/* ── run ──────────────────────────────────────────────────────────────── */

(async () => {
  console.log('\nSortable grids\n');
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
