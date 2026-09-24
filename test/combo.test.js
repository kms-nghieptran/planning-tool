'use strict';
/**
 * combo.test.js — the type-to-search picker, driven for real.
 *
 * WHY THIS SUITE EXISTS
 *
 * `combo()` renders markup and `wireCombo()` gives it behaviour, and until now
 * only the markup half was pinned. That let two defects live in the behaviour
 * half at once, both reported from the sprint picker:
 *
 *   1. CHOOSING DID NOT UPDATE THE CONTROL. `choose` called back and nothing
 *      else, on the assumption that the caller re-renders the picker. The team
 *      picker does; the sprint picker only refreshes the page under it. So
 *      after picking, the box still held the query you had typed and the
 *      highlight still sat on the sprint you had just left.
 *
 *   2. OPENING PUT THE CURSOR ON THE FIRST ROW, not on the current selection,
 *      so Enter straight after opening switched you to whatever sorted first.
 *
 * Neither is visible in the markup, so neither could be caught by reading it.
 * These checks parse the REAL output of `combo()` into a small DOM and run the
 * REAL `wireCombo` against it — a hand-built fixture tree would have drifted
 * from the markup the moment an attribute changed, which is the failure mode
 * coverage.test.js already paid for once.
 *
 * Run: node test/combo.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

/* ── a DOM, small enough to read ──────────────────────────────────────────
   Enough of one for what ui.js actually calls: querySelector/All with `#id`,
   `.class` and bare tags, classList, dataset, hidden, value, closest, and
   listeners. Anything the picker does not use is absent on purpose — a fuller
   fake would be more code standing between the test and the thing tested. */

function parse(html) {
  const VOID = new Set(['input', 'br', 'img', 'hr']);
  const root = node('#root');
  const stack = [root];
  const re = /<\/?([a-zA-Z][\w-]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const [raw, tag, attrs, text] = m;
    if (text != null) {
      const t = text.trim();
      if (t) stack[stack.length - 1].text += t;
      continue;
    }
    if (raw.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    const el = node(tag, attrs || '');
    stack[stack.length - 1].append(el);
    if (!VOID.has(tag.toLowerCase()) && !raw.endsWith('/>')) stack.push(el);
  }
  return root;
}

function node(tag, attrStr = '') {
  const attrs = {};
  for (const a of attrStr.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
    if (a[1]) attrs[a[1]] = a[2] == null ? '' : a[2];
  }
  const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
  const dataset = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('data-')) dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
  }
  const el = {
    tagName: tag.toUpperCase(),
    children: [], parent: null, text: '', listeners: {},
    dataset, attrs,
    id: attrs.id || '',
    hidden: 'hidden' in attrs,
    value: attrs.value == null ? '' : attrs.value,
    // Just the one property the picker sets, parsed from the style attribute so
    // the inline width in the real markup and the one set later are read the
    // same way.
    style: { width: (/(?:^|;)\s*width:\s*([^;]+)/.exec(attrs.style || '') || [])[1] || '' },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on == null ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : on ? classes.add(c) : classes.delete(c)),
    },
    get className() { return [...classes].join(' '); },
    get textContent() { return el.text + el.children.map(c => c.textContent).join(''); },
    append(c) { c.parent = el; el.children.push(c); },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return attrs[k] == null ? null : attrs[k]; },
    scrollIntoView() { el.scrolledTo = true; },
    select() {},
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    fire(type, e = {}) { for (const fn of (el.listeners[type] || []).slice()) fn({ preventDefault() {}, target: el, ...e }); },
    matches(sel) {
      if (sel.startsWith('#')) return el.id === sel.slice(1);
      if (sel.startsWith('.')) return classes.has(sel.slice(1));
      // `[attr]` and `[attr="value"]` — how the tag list finds its own box and
      // its remove buttons. Added when that control arrived; the picker above
      // only ever needed ids, classes and tags.
      const at = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(sel);
      if (at) return at[2] == null ? attrs[at[1]] != null : attrs[at[1]] === at[2];
      return el.tagName === sel.toUpperCase();
    },
    querySelectorAll(sel) {
      const out = [];
      for (const c of el.children) { if (c.matches(sel)) out.push(c); out.push(...c.querySelectorAll(sel)); }
      return out;
    },
    querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
    closest(sel) { let n = el; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parent; } return null; },
  };
  return el;
}

/* ── the picker under test ────────────────────────────────────────────── */

const UI = (() => {
  const ctx = { console, document: { querySelector: () => null, querySelectorAll: () => [] } };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);
  return ctx.UI;
})();

/**
 * Newest first, as the real picker sorts them — so the ACTIVE sprint is NOT
 * the first row. That ordering is load-bearing for this file: with the current
 * selection sitting at the top, "the cursor lands on the selection" and "the
 * cursor lands on row one" are the same assertion and neither defect would
 * show.
 */
const SPRINTS = [
  { value: 'S40', label: 'Katalon Ruby Sprint 40', meta: '17 Sep–30 Sep', tag: 'planned' },
  { value: 'S39', label: 'Katalon Ruby Sprint 39', meta: '3 Sep–16 Sep', tag: 'active', active: true },
  { value: 'S31', label: 'Katalon MoonStone Sprint 31', meta: '1 Jan–14 Jan', tag: 'closed', hidden: true },
];

/** The real markup, parsed, plus the real behaviour wired onto it. */
function picker(opts = {}) {
  const picked = [];
  const html = UI.combo({
    id: 'sprintSelect', label: 'Sprint', autosize: true,
    value: 'Katalon Ruby Sprint 39', options: SPRINTS, note: '40 closed sprints — type to find them',
    ...opts,
  });
  const root = parse(html);
  UI.wireCombo(root, 'sprintSelect', (v) => picked.push(v));
  const input = root.querySelector('#sprintSelect');
  const list = root.querySelector('#sprintSelectList');
  const rows = () => list.querySelectorAll('.combo-opt');
  return {
    root, input, list, picked, rows,
    row: (label) => rows().find(o => o.textContent.includes(label)),
    active: () => rows().filter(o => o.classList.contains('active')).map(o => o.querySelector('strong').textContent.trim()),
    cursor: () => (rows().find(o => o.classList.contains('on')) || { textContent: '' }).textContent.trim(),
    visible: () => rows().filter(o => !o.hidden).map(o => o.querySelector('strong').textContent.trim()),
  };
}

/* ── the box fits its value ───────────────────────────────────────────── */

/** The box's reserved width, in `ch`. */
const width = (p) => {
  const m = /^([\d.]+)ch$/.exec(String(p.input.style.width).trim());
  assert.ok(m, `expected a width in ch, got "${p.input.style.width}"`);
  return Number(m[1]);
};

check('an autosizing box asks for room for its whole value', () => {
  const p = picker();
  assert.ok(p.input.attrs.class.includes('combo-fit'), 'the box is not marked as autosizing');
  // `ch` is the width of "0", which is wider than this font's average
  // character, so a count of characters always over-reserves rather than clips.
  assert.ok(width(p) >= 'Katalon Ruby Sprint 39'.length,
    `${width(p)}ch cannot show a ${'Katalon Ruby Sprint 39'.length}-character name`);
});

check('and a longer name asks for more room, not the same', () => {
  // Both values are comfortably above the minimum, so the difference between
  // the two boxes is the difference between the two names and nothing else.
  const a = 'Katalon Ruby Sprint 39', b = 'Katalon MoonStone Sprint 31';
  const short = width(picker({ value: a })), long = width(picker({ value: b }));
  assert.ok(long > short, `a longer value must widen the box (${short}ch → ${long}ch)`);
  assert.strictEqual(long - short, b.length - a.length, 'the box must track the value, not just be bigger');
});

check('a short value still gets a usable minimum', () => {
  assert.ok(width(picker({ value: 'S1' })) >= 12, 'a two-character box is not a search box');
});

check('a picker that did not ask to autosize is left alone', () => {
  const p = picker({ autosize: false });
  assert.strictEqual(p.input.style.width, '', 'a width appeared on a fixed-width box');
  assert.ok(!p.input.attrs.class.includes('combo-fit'));
});

check('CHOOSING RE-FITS THE BOX to the new value', () => {
  const p = picker({ value: 'Sprint 3' });
  const before = width(p);
  p.list.fire('mousedown', { target: p.row('Katalon MoonStone Sprint 31') });
  assert.ok(width(p) > before, `the box did not grow for a longer name (${before}ch → ${width(p)}ch)`);
});

/* ── choosing updates the control itself ──────────────────────────────── */

check('THE BOX SHOWS WHAT WAS CHOSEN, not what was typed to find it', () => {
  const p = picker();
  p.input.value = '40';
  p.input.fire('input');
  p.list.fire('mousedown', { target: p.row('Katalon Ruby Sprint 40') });
  assert.strictEqual(p.input.value, 'Katalon Ruby Sprint 40');
  assert.deepStrictEqual(p.picked, ['S40'], 'and the caller is told exactly once');
});

check('THE HIGHLIGHT MOVES TO THE CHOSEN ROW, and only that row', () => {
  const p = picker();
  assert.deepStrictEqual(p.active(), ['Katalon Ruby Sprint 39'], 'starts on the current sprint');
  p.list.fire('mousedown', { target: p.row('Katalon Ruby Sprint 40') });
  assert.deepStrictEqual(p.active(), ['Katalon Ruby Sprint 40'], 'the old selection is still highlighted');
});

check('choosing closes the list', () => {
  const p = picker();
  p.input.fire('focus');
  assert.strictEqual(p.list.hidden, false);
  p.list.fire('mousedown', { target: p.row('Katalon Ruby Sprint 40') });
  assert.strictEqual(p.list.hidden, true);
});

check('a click on the note or the padding chooses nothing', () => {
  const p = picker();
  p.list.fire('mousedown', { target: p.list.querySelector('.combo-note') });
  assert.deepStrictEqual(p.picked, []);
});

/* ── opening lands on the current selection ───────────────────────────── */

check('OPENING PUTS THE CURSOR ON THE CURRENT SELECTION, not the top of the list', () => {
  const p = picker();
  p.input.fire('focus');
  assert.match(p.cursor(), /Katalon Ruby Sprint 39/);
});

check('and scrolls it into view, so it is the row you are looking at', () => {
  const p = picker();
  p.input.fire('focus');
  assert.ok(p.row('Katalon Ruby Sprint 39').scrolledTo, 'the selected row was never scrolled to');
});

check('so Enter straight after opening keeps the sprint you are on', () => {
  const p = picker();
  p.input.fire('focus');
  p.input.fire('keydown', { key: 'Enter' });
  assert.deepStrictEqual(p.picked, ['S39']);
});

check('but typing moves the cursor to the best match', () => {
  const p = picker();
  p.input.value = 'moonstone';
  p.input.fire('input');
  assert.match(p.cursor(), /MoonStone Sprint 31/);
  p.input.fire('keydown', { key: 'Enter' });
  assert.deepStrictEqual(p.picked, ['S31'], 'a closed sprint is reachable by typing');
});

check('the resting list still hides closed sprints, and still shows the selected one', () => {
  const p = picker();
  p.input.fire('focus');
  assert.deepStrictEqual(p.visible(), ['Katalon Ruby Sprint 40', 'Katalon Ruby Sprint 39']);
});

check('Escape puts back the selection rather than leaving the box empty', () => {
  const p = picker();
  p.input.value = 'nonsense';
  p.input.fire('input');
  p.input.fire('keydown', { key: 'Escape' });
  assert.strictEqual(p.input.value, 'Katalon Ruby Sprint 39');
  assert.strictEqual(p.list.hidden, true);
});

/* ── the stylesheet has to hold up its end ────────────────────────────── */

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

check('THE SELECTED OPTION IS HIGHLIGHTED, not merely recoloured', () => {
  const at = css.search(/^\.combo-opt\.active \{/m);
  assert.ok(at > 0, 'no rule highlights the selected option');
  const rule = css.slice(at, css.indexOf('}', at));
  assert.match(rule, /background:/, 'the selection needs more than a text colour to be findable');
});

check('the keyboard cursor and the selection stay distinguishable', () => {
  assert.match(css, /\.combo-opt\.on\.active/, 'no rule for the cursor sitting on the selection');
});

check('AN AUTOSIZING BOX IS CAPPED, so it can never take over the topbar', () => {
  const at = css.search(/^input\.combo-fit \{/m);
  assert.ok(at > 0, 'nothing caps an autosizing box');
  const rule = css.slice(at, css.indexOf('}', at));
  assert.match(rule, /max-width:\s*min\([^)]*vw/,
    'an inline width with no viewport-relative cap can push the header sideways on a phone');
});

/**
 * The generic `select, input[type="text"], …` rule sets `max-width: 100%` and
 * `min-width: 0` on every text box in the app. Both of these rules tie with it
 * on specificity, so the only thing that makes them apply is coming later in
 * the sheet — and that is not a style nit. It is exactly why the old
 * `min-width: 210px` on the sprint box had no effect in the browser while
 * reading perfectly well in the file, which is what made the sprint name look
 * truncated in the first place.
 */
const GENERIC = css.search(/^select, input\[type="text"\]/m);

check('THE CAP OUTLASTS THE GENERIC INPUT RULE', () => {
  assert.ok(GENERIC > 0, 'the generic input rule has gone — re-check this guarantee');
  assert.ok(css.search(/^input\.combo-fit \{/m) > GENERIC,
    'input.combo-fit ties with the generic rule on specificity and comes first, so its cap loses');
});

check('and so does the sprint box floor', () => {
  const at = css.search(/^\.sprint-picker input\b[^{]*\{/m);
  assert.ok(at > 0, 'the sprint box has no rule of its own');
  const selector = css.slice(at, css.indexOf('{', at));
  assert.ok(/input\[type="text"\]/.test(selector) || at > GENERIC,
    'the sprint box rule neither outranks nor outlasts the generic input rule, so it will not apply');
  const rule = css.slice(at, css.indexOf('}', at));
  assert.ok(!/min-width:\s*(2[1-9]\d|[3-9]\d\d)px/.test(rule), 'a wide fixed minimum defeats the point of autosizing');
});

/* ── the tag list ────────────────────────────────────────────────────────
   Sprint keywords and Jira Team values are LISTS that were edited as a
   comma-joined string, which hid three things at once: that more than one was
   allowed, which separator to use, and that a trailing comma stored an empty
   keyword matching every sprint in the instance.

   The server is what guarantees the data (see keywords.test.js and
   sprint-api.test.js). These checks are about the control: that it shows a
   list as a list, and that everything typed into it actually arrives. */

function taglist(values) {
  const root = parse(`<div>${UI.tagList({ name: 'kw:titan', values, placeholder: 'ruby', label: 'Add one' })}</div>`);
  const saved = [];
  // Copied into an array of THIS realm. `ui.js` runs in a vm context, so the
  // lists it builds have a different Array.prototype and `deepStrictEqual`
  // rejects them for the prototype alone, with contents that read as identical.
  UI.wireTagList(root, 'kw:titan', (next) => saved.push([...next]));
  const box = root.querySelector('[data-taglist="kw:titan"]');
  const input = root.querySelector('[data-taginput="kw:titan"]');
  return {
    root, box, input, saved,
    chips: () => box.querySelectorAll('.tagval-x').map(b => b.dataset.drop),
    last: () => saved[saved.length - 1],
    type(v) { input.value = v; return this; },
    enter() { input.fire('keydown', { key: 'Enter' }); return this; },
    blur() { input.fire('blur'); return this; },
    back() { input.fire('keydown', { key: 'Backspace' }); return this; },
    remove(v) {
      const x = box.querySelectorAll('.tagval-x').find(b => b.dataset.drop === v);
      assert.ok(x, `no chip for "${v}"`);
      box.fire('click', { target: x });
      return this;
    },
  };
}

check('EVERY VALUE IS ITS OWN CHIP, so a list looks like a list', () => {
  // The whole point: a comma-joined string in a text box reads as one value.
  const t = taglist(['ruby', 'TT Week']);
  assert.deepStrictEqual(t.chips(), ['ruby', 'TT Week']);
  assert.ok(t.input, 'and there is somewhere to add another');
});

check('an empty list still offers the add box, with the placeholder', () => {
  const t = taglist([]);
  assert.deepStrictEqual(t.chips(), []);
  assert.strictEqual(t.input.getAttribute('placeholder'), 'ruby');
});

check('and once there is one, the placeholder says another is allowed', () => {
  // The discoverability fix, in the one place a reader is looking.
  assert.strictEqual(taglist(['ruby']).input.getAttribute('placeholder'), 'add another…');
});

check('ENTER ADDS WHAT WAS TYPED, to the list that is already there', () => {
  const t = taglist(['ruby']).type('titan').enter();
  assert.deepStrictEqual(t.last(), ['ruby', 'titan']);
  assert.strictEqual(t.input.value, '', 'and the box is cleared for the next one');
});

check('BLUR COMMITS TOO — clicking away must not lose what was typed', () => {
  // The obvious way to use this is to type and then click something else.
  const t = taglist(['ruby']).type('titan').blur();
  assert.deepStrictEqual(t.last(), ['ruby', 'titan']);
});

check('one typed entry can be several, split the way the server splits', () => {
  assert.deepStrictEqual(taglist([]).type('ruby, titan; malphite').enter().last(),
    ['ruby', 'titan', 'malphite']);
});

check('and a space is not a separator here either', () => {
  assert.deepStrictEqual(taglist([]).type('TT Week').enter().last(), ['TT Week']);
});

check('AN EMPTY BOX SAVES NOTHING — blur must not fire a pointless write', () => {
  // Every commit is a PUT and a re-render. Tabbing through the field would
  // otherwise save the team on the way past.
  const t = taglist(['ruby']).blur();
  assert.deepStrictEqual(t.saved, [], 'no save at all');
  t.type('   ').enter();
  assert.deepStrictEqual(t.saved, [], 'and whitespace is nothing');
});

check('REMOVING A CHIP REMOVES EXACTLY IT', () => {
  const t = taglist(['ruby', 'titan', 'malphite']).remove('titan');
  assert.deepStrictEqual(t.last(), ['ruby', 'malphite']);
});

check('and the last one can be removed, leaving an empty list', () => {
  // The rule must not become "you can never clear this field".
  assert.deepStrictEqual(taglist(['ruby']).remove('ruby').last(), []);
});

check('backspace in an EMPTY box removes the last chip', () => {
  assert.deepStrictEqual(taglist(['ruby', 'titan']).back().last(), ['ruby']);
});

check('but backspace while typing does not — that is just editing', () => {
  const t = taglist(['ruby', 'titan']).type('mal').back();
  assert.deepStrictEqual(t.saved, [], 'a chip vanishing mid-word is data loss');
});

check('and backspace with nothing to remove does nothing', () => {
  assert.deepStrictEqual(taglist([]).back().saved, []);
});

check('a repeat is not added twice, whatever its case', () => {
  assert.deepStrictEqual(taglist(['Ruby']).type('ruby').enter().last(), ['Ruby'],
    'the first spelling stays — matching is case-insensitive downstream');
  assert.deepStrictEqual(taglist(['ruby']).type('titan, TITAN').enter().last(), ['ruby', 'titan']);
});

check('A VALUE WITH MARKUP IN IT CANNOT ESCAPE INTO THE PAGE', () => {
  // These come from plan.json, which a person edits by hand.
  const html = UI.tagList({ name: 'kw:x', values: ['<img src=x onerror=alert(1)>'], placeholder: '' });
  assert.ok(!html.includes('<img'), 'the chip label is not escaped');
  assert.ok(html.includes('&lt;img'), 'and it is still shown, as text');
});

check('a quote in a value cannot break out of the remove button', () => {
  // `data-drop="..."` is how a chip identifies itself to the click handler.
  const html = UI.tagList({ name: 'kw:x', values: ['say "hi"'], placeholder: '' });
  assert.ok(!/data-drop="say "hi""/.test(html), 'the attribute is unquoted by its own value');
  assert.ok(html.includes('&quot;'), 'quotes are escaped');
});

check('the add box is a labelled control, not an anonymous input', () => {
  const html = UI.tagList({ name: 'kw:x', values: [], placeholder: 'ruby', label: 'Add a keyword for Titan' });
  assert.ok(html.includes('aria-label="Add a keyword for Titan"'), 'a screen reader hears nothing');
  assert.ok(/aria-label="Remove ruby"/.test(UI.tagList({ name: 'k', values: ['ruby'] })),
    'and each × has to say what it removes');
});

check('wiring a name that is not on the page is harmless', () => {
  // Settings wires one per team, on a page that may have re-rendered.
  const root = parse('<div></div>');
  assert.doesNotThrow(() => UI.wireTagList(root, 'kw:nobody', () => { throw new Error('called'); }));
});

check('THE CONTROL LOOKS LIKE THE FIELDS BESIDE IT', () => {
  // It replaces a text input in a row of three. Borrowing the input chrome is
  // what stops one control in that row reading as a different kind of thing.
  const at = css.indexOf('.taglist {');
  assert.ok(at > 0, 'the tag list has no styling at all');
  const rule = css.slice(at, css.indexOf('}', at));
  assert.match(rule, /border: 1px solid var\(--app-line\)/, 'no border — it will not read as a field');
  assert.match(rule, /flex-wrap: wrap/, 'without wrapping, a sixth keyword is off the edge of the card');
  assert.ok(css.includes('.taglist:focus-within'), 'focus has to be visible on the box, not just the inner input');
});

/* ── run ──────────────────────────────────────────────────────────────── */

(async () => {
  console.log('\nThe type-to-search picker\n');
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
