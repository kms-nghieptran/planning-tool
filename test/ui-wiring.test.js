'use strict';
/**
 * ui-wiring.test.js — one click must do one thing.
 *
 * WHY THIS SUITE EXISTS
 *
 * `#main` is one long-lived element. Views wire their buttons with a single
 * delegated click listener on the element they are handed, which is the normal
 * pattern — but replacing that element's `innerHTML` does NOT remove a listener
 * bound to the element itself. Every refresh added another, so one click ran
 * the handler once per render since the page loaded.
 *
 * He found it on "Save current plan": three refreshes, one click, three
 * identical scenarios. Every other delegated action in those views was firing
 * repeatedly too — removing a person, applying a scenario, saving a note —
 * invisibly, because doing the same idempotent thing twice looks like doing it
 * once.
 *
 * The fix is structural: `App.refresh()` builds a fresh container each time, so
 * whatever a view binds dies with the container. These checks pin the property
 * rather than the symptom, for every view that binds this way — including ones
 * written later.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nOne click does one thing\n');

const VIEWS = path.join(__dirname, '..', 'public', 'views');

/**
 * A stand-in for the element a view is handed. Records click listeners bound
 * to the element ITSELF, which is the thing `innerHTML = …` never clears.
 */
function container() {
  const listeners = [];
  // Queryable, because the real `ui.js` looks things up inside whatever it is
  // handed — `UI.$$('[data-support]', mount)` and friends. A container that
  // only records listeners was enough for a stubbed UI and is not for the real
  // one, which is the more faithful arrangement anyway.
  const el = () => ({
    addEventListener() {}, value: '', hidden: false, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, select() {},
    querySelector: () => el(), querySelectorAll: () => [],
  });
  return {
    innerHTML: '',
    style: {},
    addEventListener: (type, fn) => { if (type === 'click') listeners.push(fn); },
    querySelector: () => el(),
    querySelectorAll: () => [],
    listeners,
    click(target) { for (const fn of listeners.slice()) fn({ target, preventDefault() {} }); },
  };
}

/** A click target that `closest('[data-act]')` resolves to. */
const target = (act, data = {}) => ({
  dataset: { act, ...data },
  closest: (sel) => (/\[data-act\]/.test(sel) ? { dataset: { act, ...data } } : null),
});

/**
 * Enough of the page's globals to let a view render and wire itself.
 *
 * THE REAL `ui.js`, not a hand-written stand-in. A stub drifts from the thing
 * it stands for and then fails for a reason that says nothing about the view:
 * this suite went red with "UI.itemsTable is not a function" the moment two
 * screens started sharing a table, which is a fact about the stub and not about
 * whether one click does one thing. Only the four network helpers are replaced,
 * because recording the calls is the whole point of the suite.
 */
function sandbox(calls) {
  const el = () => ({
    addEventListener() {}, disabled: false, readOnly: false, value: '', checked: false,
    hidden: false, dataset: {}, style: {}, textContent: '', className: '',
    set innerHTML(_) {}, get innerHTML() { return ''; },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, select() {},
    querySelector: () => el(), querySelectorAll: () => [],
    content: { firstElementChild: null },
  });
  const ctx = {
    console, Promise, setTimeout, clearTimeout, encodeURIComponent, CSS: { escape: String },
    prompt: () => 'A plan', confirm: () => true,
    document: { createElement: () => el(), querySelector: () => el(), querySelectorAll: () => [] },
    App: { refresh() {} },
    Charts: new Proxy({}, { get: () => () => '' }),
  };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(VIEWS, '..', 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);
  Object.assign(ctx.UI, {
    api: async () => ({}),
    jsonPut: async (p) => { calls.push(['PUT', p]); },
    jsonPost: async (p) => { calls.push(['POST', p]); },
    jsonDelete: async (p) => { calls.push(['DELETE', p]); },
  });
  return ctx;
}

/** Load a view into a sandbox and hand back its module object. */
function load(file, ctx) {
  const name = fs.readFileSync(path.join(VIEWS, file), 'utf8').match(/^const (\w+) = \(/m)[1];
  vm.runInContext(fs.readFileSync(path.join(VIEWS, file), 'utf8') + `\n;globalThis.__view = ${name};`, ctx);
  return ctx.__view;
}

/* ── the fix itself ─────────────────────────────────────────────────── */

check('APP.REFRESH HANDS EACH RENDER A NEW CONTAINER, never #main itself', () => {
  // The actual fix, asserted against the source. Handing `#main` to a view
  // again would silently restore the bug, and no view-level test would notice.
  const app = fs.readFileSync(path.join(VIEWS, '..', 'app.js'), 'utf8');
  const refresh = app.slice(app.indexOf('async function refresh()'), app.indexOf('async function refresh()') + 1400);

  assert.match(refresh, /document\.createElement\('div'\)/,
    'each render needs its own container, or delegated listeners accumulate on #main');
  assert.match(refresh, /display = 'contents'/,
    'the wrapper must not introduce a box — main carries the padding and max-width');
  assert.ok(!/await r\.view\(\)\.render\(state, host/.test(refresh),
    'rendering into the long-lived host is exactly the bug');
});

/* ── the sidebar collapse ───────────────────────────────────────────── */

check('THE SIDEBAR COLLAPSES TO ZERO, and the way back is always on screen', () => {
  // Collapsed means zero width, not a narrow icon rail: every nav item here is
  // a text label with a count, there are no icons to fall back on, and a rail
  // would spend 56px saying nothing. Which makes the toggle in the topbar the
  // ONLY way back — so it has to be there, and it has to be first.
  const html = fs.readFileSync(path.join(VIEWS, '..', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(VIEWS, '..', 'styles.css'), 'utf8');

  assert.match(html, /id="railBtn"/, 'the toggle has to exist');
  assert.ok(html.indexOf('id="railBtn"') < html.indexOf('id="crumbs"'),
    'and come before the breadcrumbs, so it is never the thing that scrolled off');
  assert.match(css, /\.shell\.nav-collapsed \{ grid-template-columns: 0 minmax\(0, 1fr\); \}/,
    'collapsed is a zero-width first column');
  assert.match(css, /\.shell\.nav-collapsed > \.sidebar \{[^}]*visibility: hidden/,
    'a zero-width sidebar still holds focusable links — tabbing into what you cannot see is the bug this prevents');
});

check('and the state survives a reload, applied before the first paint', () => {
  // A working preference, not a per-visit choice. And it has to be on the shell
  // before the first await in boot(), or the layout paints open and shuts a
  // beat later — which reads as a rendering fault rather than as a setting.
  const app = fs.readFileSync(path.join(VIEWS, '..', 'app.js'), 'utf8');
  // Pinned to the guard, not just to the call: `if (false) localStorage.set…`
  // leaves the string in the file and a search-for-the-name check green while
  // nothing is ever written.
  assert.match(app, /if \(remember\) localStorage\.setItem\('pt-nav'/,
    'the choice is remembered, and the write is reachable');

  const boot = app.slice(app.indexOf('async function boot()'), app.indexOf('async function boot()') + 900);
  assert.match(boot, /pt-nav.*nav-collapsed/s, 'and restored inside boot()');
  assert.ok(boot.indexOf('pt-nav') < boot.indexOf('await UI.api'),
    'before the first await, or the sidebar flashes open on every load');
});

check('the shortcut does not fire while you are typing', () => {
  // This app is full of text inputs and a component search you type into on
  // every visit. A shortcut that collapses the nav mid-search is worse than no
  // shortcut at all.
  const app = fs.readFileSync(path.join(VIEWS, '..', 'app.js'), 'utf8');
  const handler = app.slice(app.indexOf("if (e.key !== 'b'"), app.indexOf("if (e.key !== 'b'") + 500);
  assert.match(handler, /metaKey \|\| e\.ctrlKey/, 'it needs a modifier');
  assert.match(handler, /input\|textarea\|select/i, 'and must stand down inside a field');
});

check('and the narrow layout keeps its own drawer, untouched', () => {
  // Below 1000px the sidebar is already an off-canvas drawer with a ☰ of its
  // own. Two controls for one thing on the same screen is two answers, so the
  // collapse rules are scoped above that breakpoint and the rail button is
  // hidden below it.
  const css = fs.readFileSync(path.join(VIEWS, '..', 'styles.css'), 'utf8');
  assert.match(css, /\.rail-btn \{ display: none;/, 'hidden by default');
  const wide = css.slice(css.indexOf('@media (min-width: 1001px)'));
  assert.match(wide.slice(0, 600), /\.rail-btn \{ display: inline-block/, 'and shown only above the breakpoint');
  assert.ok(css.indexOf('.shell.nav-collapsed { grid-template-columns: 0') > css.indexOf('@media (min-width: 1001px)'),
    'the collapse itself is scoped there too, so it cannot fight the mobile drawer');
});

/* ── the nav ─────────────────────────────────────────────────────────── */

/** ROUTES and the nav it renders, evaluated from the real app.js. */
function navOf() {
  const ctx = sandbox([]);
  /* app.js boots itself on load, so it needs the handful of browser globals
     that boot touches. They are stubs, not a DOM: this check is about the route
     table and how the nav filters it, and a real DOM would add a great deal of
     surface for no extra confidence. */
  const el = () => ({
    innerHTML: '', textContent: '', hidden: false, dataset: {}, style: {}, value: '',
    addEventListener() {}, setAttribute() {}, getAttribute: () => null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelector: () => el(), querySelectorAll: () => [],
    replaceChildren() {}, append() {}, appendChild() {}, remove() {},
    content: { firstElementChild: null },
  });
  ctx.document = {
    documentElement: el(), body: el(), title: '',
    addEventListener() {}, createElement: () => el(),
    querySelector: () => el(), querySelectorAll: () => [],
  };
  ctx.window = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), print() {} };
  ctx.location = { hash: '#team', href: '' };
  ctx.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  ctx.fetch = async () => ({ ok: true, text: async () => '{}' });
  ctx.UI.$ = () => el();
  ctx.UI.$$ = () => [];
  /* boot() adopts /api/state and reaches deep into it. Rather than enumerate
     that shape here — which would make this check fail every time an unrelated
     field is added to the payload — the stub answers ANY path: every property
     is another such object, and it is array-like where something iterates it.
     The check is about the route table, not about the state contract. */
  const anything = () => new Proxy(Object.assign([], { length: 0 }), {
    get(t, k) {
      if (k === Symbol.iterator || k === 'length' || typeof k === 'symbol') return Reflect.get(t, k);
      if (k in t && typeof t[k] === 'function') return t[k].bind(t);
      return anything();
    },
  });
  ctx.UI.api = async () => anything();
  vm.runInContext(`${fs.readFileSync(path.join(VIEWS, '..', 'app.js'), 'utf8')}\n;globalThis.__app = App;`, ctx);
  return { routes: ctx.__app.ROUTES, ctx };
}

check('THE COVERAGE PAGE IS CALLED "OVERALL COVERAGE"', () => {
  const { routes } = navOf();
  const cov = routes.find(r => r.id === 'reports/coverage');
  assert.ok(cov, 'the route still exists');
  assert.strictEqual(cov.label, 'Overall Coverage');
});

check('AND AUTOMATION COVERAGE IS OFF THE NAV BUT STILL REACHABLE', () => {
  // Hidden, not deleted: an old bookmark or a link in a message has to open the
  // page rather than silently landing on Team, which looks like a broken link.
  const { routes } = navOf();
  const auto = routes.find(r => r.id === 'reports/automation');
  assert.ok(auto, 'the route is still registered, so the URL still resolves');
  assert.strictEqual(auto.hidden, true, 'and it is marked hidden rather than removed');
});

check('a hidden route is dropped from the rendered nav, and only from there', () => {
  const app = fs.readFileSync(path.join(VIEWS, '..', 'app.js'), 'utf8');
  const nav = app.slice(app.indexOf('function renderNav()'), app.indexOf('function renderCrumbs()'));
  assert.match(nav, /visibleRoutes\(\)/, 'the nav renders the filtered list');
  const routeFor = app.slice(app.indexOf('const routeFor ='), app.indexOf('const routeFor =') + 200);
  assert.ok(!/hidden/.test(routeFor), 'but route resolution must NOT filter, or the page becomes unreachable');
});

check('and a group left empty by hiding does not leave a bare heading', () => {
  // Headings are positional entries in the same list. Hiding the only route
  // under one would print a heading with nothing beneath it, which reads as a
  // page that failed to load rather than one that was never there.
  const { ctx } = navOf();
  const shown = ctx.__app.ROUTES.filter(r => r.group || !r.hidden);
  const kept = shown.filter((r, i) => {
    if (!r.group) return true;
    const next = shown[i + 1];
    return Boolean(next) && !next.group;
  });
  for (let i = 0; i < kept.length; i++) {
    if (kept[i].group) assert.ok(kept[i + 1] && !kept[i + 1].group, `"${kept[i].group}" has nothing under it`);
  }
  // Reports still has entries, so it survives.
  assert.ok(kept.some(r => r.group === 'Reports'), 'Reports keeps its heading — Delivery metrics and Overall Coverage remain');
  assert.ok(!kept.some(r => r.id === 'reports/automation'), 'and the hidden one is gone from the list');
});

/* ── status colour ───────────────────────────────────────────────────── */

check('EVERY STATUS ON THE BOARD IS COLOURED, and by stage rather than by name', () => {
  const ctx = sandbox([]);
  // The eight statuses the real store actually holds, and what each means.
  const board = {
    'Open': 'todo', 'Refinement': 'todo',
    'Ready for Dev': 'ready', 'Ready for Testing': 'ready',
    'In Dev': 'doing', 'In Testing': 'doing',
    'Acceptance/Feedback': 'review',
    'Done': 'done',
  };
  for (const [status, stage] of Object.entries(board)) {
    assert.strictEqual(ctx.UI.statusStage(status), stage, `${status} is ${stage}`);
    assert.ok(ctx.UI.statusText({ status }).includes(`st-${stage}`), `${status} renders with st-${stage}`);
  }
  // Case and spacing come from Jira, not from us.
  assert.strictEqual(ctx.UI.statusStage('  IN DEV '), 'doing');
});

check('a status nobody has seen before still gets a colour, from Jira\'s own category', () => {
  const ctx = sandbox([]);
  // The workflow gains "Awaiting Deploy" one day and tells no one. Uncoloured,
  // it would be the single plain word in a column of colour — which reads as
  // "this row is odd", not "this status is new".
  assert.strictEqual(ctx.UI.statusStage({ status: 'Awaiting Deploy', statusCategory: 'indeterminate' }), 'doing');
  assert.strictEqual(ctx.UI.statusStage({ status: 'Icebox', statusCategory: 'new' }), 'todo');
  assert.strictEqual(ctx.UI.statusStage({ status: 'Shipped', statusCategory: 'done' }), 'done');
  // The name still wins when we know it, whatever the category says.
  assert.strictEqual(ctx.UI.statusStage({ status: 'Done', statusCategory: 'new' }), 'done');
});

check('a blank status stays an em-dash, not a coloured nothing', () => {
  const ctx = sandbox([]);
  const out = ctx.UI.statusText({ status: '' });
  assert.ok(out.includes('—'), 'it reads as empty');
  assert.ok(!/st-\w/.test(out), `nothing to colour means no stage class — got ${out}`);
  assert.strictEqual(ctx.UI.statusStage({ status: 'Nonsense' }), null, 'and an unknown name with no category is honestly unknown');
});

check('the status cell escapes what Jira sent', () => {
  const ctx = sandbox([]);
  const out = ctx.UI.statusText({ status: '<img src=x onerror=alert(1)>' });
  assert.ok(!out.includes('<img'), `markup must not survive into the cell — got ${out}`);
  assert.ok(out.includes('&lt;img'), 'it is shown as text');
});

check('and every stage the code can produce has a colour to show for it', () => {
  const ctx = sandbox([]);
  const css = fs.readFileSync(path.join(VIEWS, '..', 'styles.css'), 'utf8');
  // Whatever stages the mapping can yield, the sheet must define — a stage
  // added to ui.js with no rule here is an invisible no-op, and nothing else
  // would catch it.
  const stages = new Set();
  for (const s of ['Open', 'Ready for Dev', 'In Dev', 'Acceptance/Feedback', 'Done']) stages.add(ctx.UI.statusStage(s));
  for (const c of ['new', 'indeterminate', 'done']) stages.add(ctx.UI.statusStage({ status: 'x', statusCategory: c }));
  for (const stage of stages) {
    assert.ok(new RegExp(`\\.st-${stage}\\s*\\{`).test(css), `.st-${stage} has no rule in styles.css`);
    // ...and each takes its colour from a token, so dark mode follows without
    // a second ramp written somewhere else.
    assert.ok(new RegExp(`\\.st-${stage}\\s*\\{[^}]*var\\(--st-${stage}\\)`).test(css),
      `.st-${stage} must take its colour from --st-${stage}, not a literal`);
  }
  assert.ok(/\[data-theme="dark"\][^}]*--st-done:/s.test(css),
    'dark mode lifts the ones that are unreadable on the dark card');
});

/* ── and the behaviour it was found through ─────────────────────────── */

check('ONE CLICK ON "SAVE CURRENT PLAN" SAVES ONE SCENARIO', async () => {
  const calls = [];
  const ctx = sandbox(calls);
  const view = load('capacity.js', ctx);

  // Render three times the way the app now does — a new container each time —
  // and click once on the last one.
  let c;
  for (let i = 0; i < 3; i++) {
    c = container();
    ctx.UI.api = async (p) => fixtureFor(p);
    await view.render({ teamId: 't', sprintId: 'S40', sprints: [{ id: 'S40', byTeam: {} }], categories: {} }, c);
  }
  c.click(target('save-scenario'));
  await new Promise(r => setTimeout(r, 30));

  const saves = calls.filter(([m, p]) => m === 'POST' && p === '/api/scenarios');
  assert.strictEqual(saves.length, 1,
    `three renders then one click must save once, not three times (saved ${saves.length})`);
});

check('and removing a person removes them once', async () => {
  const calls = [];
  const ctx = sandbox(calls);
  const view = load('capacity.js', ctx);
  let c;
  for (let i = 0; i < 3; i++) {
    c = container();
    ctx.UI.api = async (p) => fixtureFor(p);
    await view.render({ teamId: 't', sprintId: 'S40', sprints: [{ id: 'S40', byTeam: {} }], categories: {} }, c);
  }
  c.click(target('drop-member', { member: 'm1', name: 'Someone' }));
  await new Promise(r => setTimeout(r, 30));

  const puts = calls.filter(([m, p]) => m === 'PUT' && p === '/api/sprint/roster');
  assert.strictEqual(puts.length, 1, `expected one roster write, got ${puts.length}`);
});

/* ── a capacity payload with just enough in it to render ────────────── */

function fixtureFor(p) {
  if (p.startsWith('/api/capacity')) {
    return {
      teamId: 't', teamName: 'Team', sprintId: 'S40',
      settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9, workloadOverPct: 110, workloadUnderPct: 85 },
      rows: [{ memberId: 'm1', name: 'Someone', role: 'Auto QA', status: 'Active', supportPct: 0, availableDays: 10, capacityHours: 61, predicted: 21, planned: 0, actual: 0, workloadPct: 0, goalPct: null, flags: [], items: [] }],
      totals: { headcount: 1, availableDays: 10, capacityHours: 61, predicted: 21, planned: 0, actual: 0, workloadPct: 0, goalPct: null, overBy: 0 },
      days: [{ date: '2026-09-17', dow: 'Thu', holiday: false }],
      availability: { m1: ['1'] },
      // A real `mix` shape, not `{}`: the stub's mixBar returned '' for anything,
      // which let the fixture drift away from what the model actually returns.
      mix: { total: 0, byCategory: {} }, mixVsTarget: [],
      items: [],
      unowned: { points: 0, done: 0, count: 0, items: [], people: [] },
      unassigned: { points: 0, done: 0, count: 0, items: [] },
      offRoster: { points: 0, done: 0, count: 0, items: [], people: [] },
      history: [], calibration: null, note: '',
      roster: { counts: { total: 1, assigned: 0, planned: 0, fromTeam: 1, added: 0, removed: 0 }, added: [], removed: [], members: [{ id: 'm1', name: 'Someone', onSprint: 'team' }] },
      lock: { state: 'future', readOnly: false, reason: null },
    };
  }
  if (p.startsWith('/api/sprint/roster')) {
    return { counts: { total: 1 }, members: [{ id: 'm1', name: 'Someone', onSprint: 'team' }], candidates: [], lock: { readOnly: false } };
  }
  if (p.startsWith('/api/scenarios')) {
    return { scenarios: [], live: { name: 'Current plan', totals: { headcount: 1, capacityHours: 61, predicted: 21, planned: 0 } }, lock: { readOnly: false } };
  }
  return {};
}

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
