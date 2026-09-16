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
