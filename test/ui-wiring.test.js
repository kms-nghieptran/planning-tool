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
    /* THE BROWSER GLOBALS BOOT ACTUALLY TOUCHES. `URLSearchParams` is one of
       them now — print mode reads the query string — and a harness missing a
       global does not fail the check that needed it, it kills the whole
       suite at boot. */
    URLSearchParams,
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

/**
 * BOOT THE REAL `app.js` AND SEE WHICH TEAM IT LANDS ON.
 *
 * Written after a sprint report for Titan arrived showing Ruby's sprint. The
 * URL carried `team=titan`; the page ignored it, because the print block
 * applied the parameters by WRITING localStorage and sat BELOW the two lines
 * that had already read it — and the renderer hands Chrome a throwaway
 * profile, so that localStorage is empty on every single render. The
 * parameters could not have worked.
 *
 * NOTHING SOURCE-LEVEL WOULD HAVE CAUGHT IT. Every part was present and
 * spelt correctly: the URL builder set `team`, the block read `q.get('team')`,
 * the view read `state.teamId`. Only the ORDER was wrong, and order is what a
 * string check cannot see. So this executes boot and asks the one question
 * that matters: which team is the page about.
 */
/* BOOT KEEPS GOING AFTER THE PART UNDER TEST, and it is running without the
   DOM it expects — this harness loads `app.js` alone, so the shell wiring and
   the first render reach for nodes that are not there. Those rejections
   arrive on a later tick than the `await` below, so a try/catch cannot see
   them, and untrapped they kill the process AFTER every check has passed:
   green output, failing exit code.
   Stubbing deeper is whack-a-mole against a DOM this file has no interest in;
   what it is asking is which team and sprint boot settled on, and that is
   decided long before anything is painted. DBG=1 prints them. */
process.on('unhandledRejection', (e) => {
  if (process.env.DBG) console.log('AFTER THE CHECKS:', (e && e.message) || e);
});

async function bootWith({ search = '', stored = {}, teams, sprints, currentByTeam = {}, currentSprintId = null }) {
  const ctx = sandbox([]);
  ctx.location = { search, hash: '#sprints/active', pathname: '/' };
  ctx.localStorage = {
    getItem: (k) => (k in stored ? stored[k] : null),
    setItem(k, v) { stored[k] = v; },
    removeItem(k) { delete stored[k]; },
  };
  ctx.window = { matchMedia: () => ({ matches: false }), scrollY: 0, scrollTo() {}, addEventListener() {} };
  /* THE RENDER IS EXPECTED TO FAIL HERE, loudly and by design: this harness
     loads `app.js` alone, so `routeFor(...).view()` names a view module that
     was never loaded and `refresh` catches it, marks the page `error` and
     carries on — which is the path the notes check below rides. `app.js`
     logs that, seven times, and seven expected stack traces in the output
     are how an UNexpected one goes unnoticed. Kept under DBG rather than
     thrown away. */
  ctx.console = {
    log: console.log,
    warn: () => {},
    error: (...a) => { if (process.env.DBG) console.log('DURING RENDER:', ...a); },
  };
  /* A DOCUMENT WITH THE THREE NODES BOOT ACTUALLY TOUCHES. `documentElement`
     carries the theme and is read before the first await, so a harness
     without it never reaches the line under test — which is how the first
     draft of these checks reported `teamId: null` and looked like the bug
     rather than like a missing stub. */
  const node = () => ({
    dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, addEventListener() {}, removeEventListener() {}, style: {},
    /* ATTRIBUTES, BECAUSE BOOT SETS THEM BEFORE IT RENDERS ANYTHING. The rail
       button gets `aria-expanded` in `wireShell`, which runs BEFORE
       `await refresh()` — so a node without `setAttribute` stopped boot short
       of the refresh entirely. That looked exactly like a product defect: the
       print-mode check below went red saying the page never copied its notes
       out, when the code under it had simply never been reached. A stub that
       stops boot early does not fail honestly; it fails somebody else's
       check. */
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    focus() {}, blur() {}, closest: () => null, insertBefore() {},
    /* AND `replaceChildren`, which `refresh` calls on `#main` BEFORE its own
       try/finally. A throw there skips the finally — and the notes are copied
       out in that finally — so a missing method here silently answered "the
       page never copied its notes out" for a page that never got as far as
       rendering one. `childElementCount` decides which of the two swap paths
       is taken; zero is the honest answer for a first paint. */
    replaceChildren() {}, childElementCount: 0,
    /* A NODE HAS TO BE SEARCHABLE. `UI.$(sel, root)` calls
       `root.querySelector`, so a stub without it throws from deep inside the
       first render — after every check has passed, as an unhandled rejection
       that kills the process and takes the suite's exit code with it. The
       checks were green and the run reported failure. */
    querySelector: () => node(), querySelectorAll: () => [],
    value: '', textContent: '', innerHTML: '', options: [], selectedIndex: 0,
  });
  ctx.document = {
    documentElement: node(), body: node(), head: node(),
    createElement: () => node(), querySelector: () => node(), querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  ctx.UI.api = async (p) => {
    if (String(p).startsWith('/api/state')) {
      return {
        plan: { teams }, sprints, categories: {}, teamIndex: {},
        currentSprintId, currentSprintByTeam: currentByTeam,
        jiraSprints: {}, sync: { syncedAt: null, issues: 1 }, config: {},
      };
    }
    return {};
  };
  ctx.UI.toast = () => {};
  const noteCalls = [];
  ctx.UI.printNotes = () => { noteCalls.push(1); return []; };
  ctx.UI.$ = () => node();
  ctx.UI.$$ = () => [];
  /* THE MODULE'S OWN `App.boot()` IS STRIPPED, and this is not tidiness.
     `app.js` ends by calling boot itself, so loading it starts a run
     immediately; calling boot again from here made TWO runs, and the second
     one read the localStorage the first had just written. Under the very bug
     these checks exist for — the URL applied by writing localStorage — run
     one wrote `pt-team=titan` and run two read it back, so the check went
     GREEN against the broken code. A harness that boots twice does not fail
     loudly; it quietly agrees with whatever it is shown. */
  const appSrc = fs.readFileSync(path.join(VIEWS, '..', 'app.js'), 'utf8').replace(/\nApp\.boot\(\);\s*$/, '\n');
  assert.ok(!/\nApp\.boot\(\);/.test(appSrc), 'app.js still self-boots, so this harness would run it twice');
  vm.runInContext(`${appSrc}\n;globalThis.__app = App;`, ctx);
  /* BOOT IS EXPECTED TO THROW HERE, at the first render: this harness loads
     `app.js` alone, without the view modules it routes to. Everything under
     test — the team, the sprint, and what was or was not written back —
     is settled before that point. Set DBG=1 to see where it actually
     stopped, which is what turned "teamId is null" from a mystery into a
     missing `document.documentElement` stub. */
  try { await ctx.__app.boot(); } catch (e) { if (process.env.DBG) console.log('BOOT STOPPED AT:', e.message); }
  return { state: ctx.__app.state, stored, noteCalls, doc: ctx.document };
}

const TEAMS = [{ id: 'ruby', name: 'Katalon RDA' }, { id: 'titan', name: 'Katalon PSA' }];
const SPRINTS = [{ id: 'S40' }, { id: 'S41' }, { id: 'S42' }];

check('A PRINTED PAGE IS LIGHT, whatever theme he has stored', async () => {
  /* This page is not read, it is PHOTOGRAPHED: headless Chrome loads it to
     print the emailed PDF and to capture the Backlog chart that goes in the
     mail body. Both land in front of a client, on paper or in a reading pane,
     and both are overwhelmingly light — a dark chart arrives as a black slab
     with a hole punched in the page around it.

     IT ONLY LOOKED RIGHT BY ACCIDENT BEFORE. The print STYLESHEET turns the
     dark tokens back to ink, but only under `@media print`, and a screenshot is
     SCREEN media. The capture came out light solely because headless Chrome
     runs a fresh profile with no stored theme and reports a light system
     preference. This fixes it where it is decided rather than relying on
     that. */
  const { doc } = await bootWith({
    search: '?print=1&team=titan',
    stored: { 'pt-theme': 'dark' },
    teams: TEAMS, sprints: SPRINTS, currentSprintId: 'S42',
  });
  assert.strictEqual(doc.documentElement.dataset.theme, 'light',
    `a printed page rendered in ${doc.documentElement.dataset.theme} theme`);
});

check('AND HIS STORED THEME IS NOT REWRITTEN BY PRINTING ONE', async () => {
  /* Same rule as the team and sprint above: `?print=1` is an ordinary URL he
     can open himself, and rendering a report must not edit the reader's
     settings. Forcing the attribute is a render-time decision; writing it back
     to localStorage would flip his own app to light. */
  const stored = { 'pt-theme': 'dark' };
  await bootWith({
    search: '?print=1&team=titan', stored, teams: TEAMS, sprints: SPRINTS, currentSprintId: 'S42',
  });
  assert.strictEqual(stored['pt-theme'], 'dark',
    `printing rewrote his stored theme to ${stored['pt-theme']}`);
});

check('AND AN ORDINARY PAGE STILL HONOURS IT', async () => {
  /* The force must be scoped to printing. Applying it unconditionally would
     take the dark theme away from the person using the app. */
  const { doc } = await bootWith({
    search: '?team=titan',
    stored: { 'pt-theme': 'dark' },
    teams: TEAMS, sprints: SPRINTS, currentSprintId: 'S42',
  });
  assert.strictEqual(doc.documentElement.dataset.theme, 'dark',
    'the dark theme was taken away from an ordinary page load');
});

check('THE PRINTED PAGE IS ABOUT THE TEAM THE URL NAMED', async () => {
  /* THE BUG, exactly as it reached him: the report said Titan, the document
     showed Ruby. `ruby` is first in the list, which is what the page fell
     back to. */
  const { state } = await bootWith({
    search: '?print=1&landscape=1&team=titan&sprint=S41',
    teams: TEAMS, sprints: SPRINTS, currentSprintId: 'S42',
  });
  assert.strictEqual(state.teamId, 'titan',
    `the page rendered for ${state.teamId} when the URL asked for titan`);
  assert.strictEqual(state.sprintId, 'S41',
    `the page rendered sprint ${state.sprintId} when the URL asked for S41`);
});

check('AND RENDERING ONE DOES NOT CHANGE HIS OWN SELECTION', async () => {
  /* The second half, and the one that would have outlived the first:
     `?print=1&team=titan` is an ordinary URL. Applying it by writing
     localStorage means opening one in his own browser silently switches the
     team he had selected. Rendering a report must not edit the reader's
     settings. */
  const stored = { 'pt-team': 'ruby', 'pt-sprint': 'S40' };
  const { state } = await bootWith({
    search: '?print=1&team=titan&sprint=S41',
    stored, teams: TEAMS, sprints: SPRINTS, currentSprintId: 'S42',
  });
  assert.strictEqual(state.teamId, 'titan', 'the URL should still win for this render');
  assert.strictEqual(stored['pt-team'], 'ruby',
    `rendering a Titan report rewrote the stored team to ${stored['pt-team']}`);
  assert.strictEqual(stored['pt-sprint'], 'S40',
    `rendering rewrote the stored sprint to ${stored['pt-sprint']}`);
});

check('A TEAM WITH NO SPRINT NAMED GETS THAT TEAM\'S CURRENT SPRINT', async () => {
  /* The same bug one level down: the right team, somebody else\'s sprint.
     The global "current sprint" belongs to whichever team the app would
     otherwise have opened on. */
  const { state } = await bootWith({
    search: '?print=1&team=titan',
    teams: TEAMS, sprints: SPRINTS,
    currentByTeam: { ruby: 'S40', titan: 'S42' }, currentSprintId: 'S40',
  });
  assert.strictEqual(state.teamId, 'titan');
  assert.strictEqual(state.sprintId, 'S42',
    `Titan's report opened on ${state.sprintId}, which is Ruby's current sprint`);
});

check('AND WITHOUT print=1 THE URL IS IGNORED ENTIRELY', async () => {
  /* `team=` in the address bar of the normal app must not override what he
     picked — the parameters exist for the renderer, and a stray one should
     not quietly move his screen. */
  const { state } = await bootWith({
    search: '?team=titan&sprint=S41',
    stored: { 'pt-team': 'ruby', 'pt-sprint': 'S40' },
    teams: TEAMS, sprints: SPRINTS, currentSprintId: 'S42',
  });
  assert.strictEqual(state.teamId, 'ruby', 'a non-print URL moved his selected team');
  assert.strictEqual(state.sprintId, 'S40', 'a non-print URL moved his selected sprint');
});

check('AN UNKNOWN TEAM IN THE URL FALLS BACK rather than rendering nothing', async () => {
  const { state } = await bootWith({
    search: '?print=1&team=gone&sprint=S99',
    teams: TEAMS, sprints: SPRINTS, currentByTeam: { ruby: 'S42' }, currentSprintId: 'S42',
  });
  assert.strictEqual(state.teamId, 'ruby', 'an unknown team did not fall back to a real one');
  assert.strictEqual(state.sprintId, 'S42', 'an unknown sprint did not fall back to a real one');
});

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

  /* MEASURED FROM THE START OF `boot`, NOT INSIDE A FIXED-SIZE SLICE.
     This used to read the first 900 characters of the function and compare
     positions within them. Adding a comment above the first fetch pushed
     `await UI.api` out of that window, `indexOf` returned -1, and the check
     failed claiming the sidebar would flash — while the code was untouched
     and correct. A window sized in characters is a check that fails when the
     prose around it grows. */
  const bootAt = app.indexOf('async function boot()');
  const navAt = app.indexOf('pt-nav', bootAt);
  const fetchAt = app.indexOf('await UI.api', bootAt);
  assert.ok(navAt > -1, 'the collapsed state is not restored inside boot()');
  assert.ok(fetchAt > -1, 'boot() no longer fetches state, so this check is measuring nothing');
  assert.match(app.slice(navAt, navAt + 200), /nav-collapsed/, 'and restored onto the shell');
  assert.ok(navAt < fetchAt,
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
function navOf({ quiet = true } = {}) {
  const ctx = sandbox([]);
  /* `boot()` refreshes on load, and in this sandbox that render fails because
     no view module is loaded — three raw stack traces in the suite's output
     that say nothing about any check and bury the ones that do. */
  if (quiet) ctx.console = { log() {}, error() {}, warn() {} };
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
  /* THE MODULE'S OWN `App.boot()` IS STRIPPED, and this is not tidiness.
     `app.js` ends by calling boot itself, so loading it starts a run
     immediately; calling boot again from here made TWO runs, and the second
     one read the localStorage the first had just written. Under the very bug
     these checks exist for — the URL applied by writing localStorage — run
     one wrote `pt-team=titan` and run two read it back, so the check went
     GREEN against the broken code. A harness that boots twice does not fail
     loudly; it quietly agrees with whatever it is shown. */
  const appSrc = fs.readFileSync(path.join(VIEWS, '..', 'app.js'), 'utf8').replace(/\nApp\.boot\(\);\s*$/, '\n');
  assert.ok(!/\nApp\.boot\(\);/.test(appSrc), 'app.js still self-boots, so this harness would run it twice');
  vm.runInContext(`${appSrc}\n;globalThis.__app = App;`, ctx);
  return { routes: ctx.__app.ROUTES, ctx };
}

check('THE PRINTED PAGE COPIES ITS NOTES OUT, for the emailed PDF', async () => {
  /* THERE ARE TWO PRINT PATHS AND THE FIX WAS ONLY IN ONE.
     A `<textarea rows="1">` prints one line and silently drops the rest, so
     notes have to be copied into plain nodes before printing. `UI.exportPdf`
     does that for the on-screen button — and the EMAILED PDF never touches
     that function: headless Chrome loads this same page with `?print=1` and
     prints it. So Export PDF carried whole notes while the attachment a
     client receives still cut them off, which is the copy nobody proofreads.

     Driven, because the call sits in `refresh` and reads a flag set in
     `boot`: a `const` in `boot` would be a ReferenceError here and nowhere
     else — in print mode only, on the one path with no human watching. */
  const r = await bootWith({
    search: '?print=1&team=titan&sprint=S41',
    teams: TEAMS, sprints: SPRINTS, currentSprintId: 'S42',
  });
  assert.ok(r.noteCalls.length > 0,
    'the print page never copied its notes out, so the emailed PDF truncates every one');
});

check('AND AN ORDINARY PAGE LOAD DOES NOT', async () => {
  /* On screen the textarea IS the control — he types in it. Copying the text
     out beside it would show every note twice in the app. */
  const r = await bootWith({
    search: '', teams: TEAMS, sprints: SPRINTS, currentSprintId: 'S42',
  });
  assert.strictEqual(r.noteCalls.length, 0,
    'a normal page load duplicated every note on screen');
});

check('THE PLANNING GROUP IS CALLED "PLANNING", and the routes did not move', () => {
  /* The heading holds Capacity planning and Forecast as well as the three
     sprint screens, and those two are about what the team can take on rather
     than about any one sprint.

     THE ROUTE IDS ARE THE POINT OF THIS CHECK, not the word. `sprints/...`
     appears in saved links, in the print URLs the mail renderer builds from
     `REPORTS[*].route`, and in localStorage. Renaming a heading is a label
     change; renaming the ids alongside it would be a silent 404 for every
     bookmark and a PDF of the fallback screen for every scheduled send. */
  const app = fs.readFileSync(path.join(VIEWS, '..', 'app.js'), 'utf8');
  assert.match(app, /\{ group: 'Planning' \}/, 'the group is not called Planning');
  assert.ok(!/\{ group: 'Sprints' \}/.test(app), 'the old heading is still there');
  for (const id of ['sprints/active', 'sprints/future', 'sprints/closed', 'sprints/capacity', 'sprints/forecast']) {
    assert.ok(app.includes(`id: '${id}'`), `${id} was renamed with the heading, breaking every saved link to it`);
  }
});

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

/* ── A CHANGE MUST NOT LOOK LIKE A PAGE RELOAD ────────────────────────
   `refresh` used to replace `#main` with "Loading…" and only then await the
   render. Saving one leave cell, one priority, one chip in Settings tore the
   screen down and rebuilt it: the page jumped to the top and for a moment
   there was nothing on it. The new view is now built detached and swapped in
   when it is ready, so what he was reading stays readable, and a slim bar says
   the app is working. */

/** `navOf`'s harness, with a `#main` that really holds children. */
function appWithMain() {
  const { ctx } = navOf();
  /* `boot()` runs on load and refreshes once, which in this sandbox reaches
     for view modules that are not loaded. Neutralised up front so the noise
     from that first render does not land in the middle of a check. */
  ctx.__app.ROUTES.forEach(r => { r.view = () => ({ render: async () => {} }); });
  const main = {
    children: [],
    get childElementCount() { return this.children.length; },
    replaceChildren(...kids) { this.children = kids; },
    querySelector(sel) {
      // Only `.loading` is asked for, and only to tell a first paint apart
      // from a re-render.
      return this.children.some(k => String(k.innerHTML || '').includes('loading')) ? {} : null;
    },
    set innerHTML(v) { this.children = [{ innerHTML: v }]; },
    get innerHTML() { return this.children.map(k => k.innerHTML || '').join(''); },
  };
  // The busy bar looks itself up by id and creates one if it is missing.
  const bars = {};
  ctx.document.getElementById = (id) => bars[id] || null;
  ctx.document.body = { appendChild(node) { bars[node.id] = node; } };

  const made = [];
  ctx.document.createElement = () => {
    const node = { style: {}, innerHTML: '', id: '', querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, setAttribute(k, v) { this[k] = v; }, appendChild() {},
      classList: { on: false, add() { this.on = true; }, remove() { this.on = false; } } };
    made.push(node);
    return node;
  };
  /* DELEGATES rather than replaces. `boot()` runs on load and reaches for a
     handful of shell elements; a leaner stub here broke it with
     "classList.contains is not a function" — which says nothing about
     refreshing. Only `#main` is answered differently. */
  const base$ = ctx.UI.$;
  ctx.UI.$ = (sel, root) => (sel === '#main' ? main : base$(sel, root));
  ctx.UI.sortable = () => {};
  ctx.window.scrollY = 0;
  ctx.window.scrollTo = () => {};
  // The bar as the app made it — asserting on the real node rather than on a
  // stand-in is what makes "it went up" a fact about the app.
  const uiSrc = fs.readFileSync(path.join(VIEWS, '..', 'ui.js'), 'utf8');
  const realUI = vm.runInContext(`(function () { ${uiSrc}; return UI; })()`, ctx);
  Object.assign(ctx.UI, {
    api: realUI.api, jsonPut: realUI.jsonPut, jsonPost: realUI.jsonPost,
    jsonDelete: realUI.jsonDelete, busy: realUI.busy,
  });
  ctx.__bar = () => { ctx.UI.busy(true); ctx.UI.busy(false); return bars.busybar; };
  return { app: ctx.__app, main, ctx };
}

check('THE PAGE STAYS ON SCREEN WHILE THE NEW ONE IS BUILT', async () => {
  const { app, main, ctx } = appWithMain();
  main.children = [{ innerHTML: '<h2>Per-component progress</h2>' }];   // what he was reading

  let release;
  const rendered = new Promise((r) => { release = r; });
  app.ROUTES.forEach(r => { r.view = () => ({ render: async () => { await rendered; } }); });

  const done = app.refresh();
  await new Promise(r => setTimeout(r, 5));
  assert.match(main.innerHTML, /Per-component progress/,
    'the old view was torn down before the new one was ready — that is the reload he is complaining about');
  assert.ok(!/loading/i.test(main.innerHTML), 'and it was not replaced by a loading state');

  release();
  await done;
  assert.ok(!/Per-component progress/.test(main.innerHTML), 'and the swap does happen once it is ready');
});

check('and the FIRST paint still shows a loading state', async () => {
  // Nothing to keep, so an empty frame would be worse than "Loading…".
  const { app, main } = appWithMain();
  main.children = [];
  let release;
  const rendered = new Promise((r) => { release = r; });
  app.ROUTES.forEach(r => { r.view = () => ({ render: async () => { await rendered; } }); });

  const done = app.refresh();
  await new Promise(r => setTimeout(r, 5));
  assert.match(main.innerHTML, /loading/i, 'a blank frame on first load says nothing is happening');
  release();
  await done;
});

check('THE BUSY BAR GOES UP FOR A WRITE AND COMES BACK DOWN', async () => {
  const { ctx } = appWithMain();
  const bar = ctx.__bar();

  let release;
  ctx.fetch = () => new Promise((r) => { release = () => r({ ok: true, text: async () => '{}' }); });
  const call = ctx.UI.jsonPut('/api/thing', {});
  await new Promise(r => setTimeout(r, 260));      // past the anti-flicker delay
  assert.strictEqual(bar.classList.on, true, 'a write in flight shows nothing is happening');
  release();
  await call;
  assert.strictEqual(bar.classList.on, false, 'and it has to come back down');
});

check('and it comes down even when the write FAILS', async () => {
  // A bar left spinning after an error says the app is still working on
  // something it has already given up on.
  const { ctx } = appWithMain();
  const bar = ctx.__bar();
  ctx.fetch = async () => ({ ok: false, status: 500, statusText: 'Server Error', text: async () => '{"error":"nope"}' });

  await assert.rejects(() => ctx.UI.jsonPut('/api/thing', {}));
  /* PAST THE DELAY before asserting. Checking the instant the rejection lands
     passes whether or not anything lowers it — the bar has not been raised
     yet, so "off" is true either way. Without the `finally` the count stays up
     and the pending timer puts the bar on a moment later, which is the state
     this has to catch: a bar left spinning over an error. */
  await new Promise(r => setTimeout(r, 260));
  assert.strictEqual(bar.classList.on, false, 'left spinning after a failed write');
});

check('TWO OVERLAPPING REQUESTS KEEP IT UP UNTIL THE LAST ONE FINISHES', async () => {
  /* A save and the refresh that follows it overlap. A boolean would be
     switched off by whichever finished first, hiding the bar while work was
     still in flight. */
  const { ctx } = appWithMain();
  const bar = ctx.__bar();

  const releases = [];
  ctx.fetch = () => new Promise((r) => releases.push(() => r({ ok: true, text: async () => '{}' })));
  const a = ctx.UI.jsonPut('/api/one', {});
  const b = ctx.UI.api('/api/two');
  await new Promise(r => setTimeout(r, 260));
  assert.strictEqual(bar.classList.on, true);

  releases[0](); await a;
  assert.strictEqual(bar.classList.on, true, 'one of two finishing must not lower it');
  releases[1](); await b;
  assert.strictEqual(bar.classList.on, false);
});

check('a QUICK request never flashes the bar at all', async () => {
  // Most of these are local and answer in milliseconds. A bar that blinks on
  // and off for every keystroke-triggered fetch is worse than no bar.
  const { ctx } = appWithMain();
  const bar = ctx.__bar();
  /* SLOWER THAN AN INSTANT, FASTER THAN THE DELAY. A fetch that resolves in
     the same tick never shows the bar whatever the delay is set to — so a
     check built on one passes with the delay removed, and the flicker it
     exists to prevent ships. 50ms is a local round trip. */
  ctx.fetch = () => new Promise(r => setTimeout(() => r({ ok: true, text: async () => '{}' }), 50));

  const call = ctx.UI.api('/api/quick');
  await new Promise(r => setTimeout(r, 40));
  assert.strictEqual(bar.classList.on, false, 'shown for a request that answers in 50ms');
  await call;
  await new Promise(r => setTimeout(r, 260));
  assert.strictEqual(bar.classList.on, false, 'and never shown after it finished either');
});

check('NOTHING RELOADS THE BROWSER', () => {
  /* The one that did was "remove a team" — which changes the sidebar, the team
     selector and every screen's scoping, and reached for the browser to get
     all three. `App.reload()` re-reads the state and redraws the nav, which is
     the whole of that, without throwing away the Jira base URL, the sort a
     table was in, or a second of his time. */
  // Comments stripped first: the one explaining why this rule exists names
  // `location.reload()`, and a check that cannot tell code from prose fails on
  // its own documentation.
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of fs.readdirSync(VIEWS)) {
    const hit = code(fs.readFileSync(path.join(VIEWS, f), 'utf8'))
      .split('\n').find(l => /location\.reload\s*\(/.test(l));
    assert.ok(!hit, `${f} reloads the whole page: ${String(hit).trim()}`);
  }
});

/**
 * A PAGE WITH NOTES ON IT, and nothing else.
 *
 * `printNotes` is stubbed in every boot check above — which is right, those
 * ask whether it is CALLED — and that left the function itself unchecked: it
 * could have returned an empty array and the whole suite would have stayed
 * green while every emailed PDF truncated every note. So this builds a small
 * real DOM and asks what the function actually puts on the page.
 *
 * `nextSibling` is a getter over the children array rather than a stored
 * field, because `printNotes` inserts BEFORE it and a stale sibling would let
 * a broken insertion look correct.
 */
function pageWith(values) {
  const parent = { children: [] };
  parent.insertBefore = (n, ref) => {
    const at = ref ? parent.children.indexOf(ref) : -1;
    parent.children.splice(at < 0 ? parent.children.length : at, 0, n);
    n.parentNode = parent;
  };
  parent.removeChild = (n) => {
    const at = parent.children.indexOf(n);
    if (at >= 0) parent.children.splice(at, 1);
    n.parentNode = null;
  };
  for (const value of values) {
    const ta = { tagName: 'TEXTAREA', value, parentNode: parent, className: '' };
    Object.defineProperty(ta, 'nextSibling', {
      get: () => parent.children[parent.children.indexOf(ta) + 1] || null,
    });
    parent.children.push(ta);
  }
  return parent;
}

/** The real `UI`, pointed at that page. */
function notesPage(values) {
  const ctx = sandbox([]);
  const page = pageWith(values);
  ctx.document = {
    createElement: () => ({ className: '', textContent: '', parentNode: null }),
    querySelectorAll: (sel) => (sel === 'textarea'
      ? page.children.filter(n => n.tagName === 'TEXTAREA') : []),
    querySelector: () => null,
  };
  const notes = () => page.children.filter(n => n.className === 'print-note');
  return { UI: ctx.UI, page, notes };
}

check('A NOTE IS COPIED OUT IN FULL, every line of it', () => {
  /* WHAT HE ACTUALLY SAW. The notes live in `<textarea rows="1">`, which
     prints exactly one line and silently drops the rest — so a three-line
     note reached the client as its first sentence. The copy has to carry the
     whole string, newlines and all, or this is not fixed. */
  const long = 'Blocked on the Evolve migration.\nOwner: Duy\n\nRe-check after the 14 Sep cut.';
  const { UI, notes } = notesPage([long]);
  const added = UI.printNotes();
  assert.strictEqual(notes().length, 1, 'the note was never copied out of its textarea');
  assert.strictEqual(notes()[0].textContent, long,
    'the copy is not the whole note — the PDF would truncate it exactly as before');
  assert.strictEqual(added.length, 1, 'printNotes did not report what it added, so nothing can undo it');
});

check('and it lands NEXT TO the note it came from, in order', () => {
  /* Three notes, three copies, each beside its own source. An insertion that
     appended everything to the end would pass a count check and put the
     wrong note under the wrong heading. */
  const { UI, page } = notesPage(['first', 'second', 'third']);
  UI.printNotes();
  const seen = page.children.map(n => (n.className === 'print-note' ? `copy:${n.textContent}` : `ta:${n.value}`));
  assert.deepStrictEqual(seen,
    ['ta:first', 'copy:first', 'ta:second', 'copy:second', 'ta:third', 'copy:third'],
    'the copies are not beside the notes they came from');
});

check('AN EMPTY NOTE ADDS NOTHING', () => {
  /* Most textareas on a sprint page are blank. A copy of each would push real
     content down the page and add blank blocks to the PDF. */
  const { UI, notes } = notesPage(['', '   \n ', 'kept']);
  UI.printNotes();
  assert.strictEqual(notes().length, 1, 'a blank note was copied out as an empty block');
  assert.strictEqual(notes()[0].textContent, 'kept', 'the wrong note survived');
});

check('AND A SECOND RENDER DOES NOT STACK A SECOND COPY', () => {
  /* In print mode this runs at the end of EVERY render, and a view that
     redraws itself would otherwise print each note twice, then three times. */
  const { UI, notes } = notesPage(['once']);
  UI.printNotes();
  UI.printNotes();
  UI.printNotes();
  assert.strictEqual(notes().length, 1, 'the note was copied out once per render, so the PDF repeats it');
});

check('and the on-screen path puts the page back afterwards', () => {
  /* `exportPdf` prints the live page the user is looking at, so its copies
     have to go again. Only the throwaway `?print=1` page keeps them. */
  const { UI, page, notes } = notesPage(['a', 'b']);
  const added = UI.printNotes();
  assert.strictEqual(notes().length, 2, 'nothing to undo — the copies were never made');
  UI.unprintNotes(added);
  assert.strictEqual(notes().length, 0, 'the copies stayed on screen after the print');
  assert.deepStrictEqual(page.children.map(n => n.value), ['a', 'b'], 'undoing it disturbed the notes themselves');
  assert.strictEqual(added.length, 0, 'the list was not emptied, so a second undo would remove live nodes');
});

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
