'use strict';
/**
 * component-rank.test.js — his order within a priority level.
 *
 * WHAT THIS SUITE IS PROTECTING
 *
 *   1. RANK NEVER CROSSES A LEVEL. The level is the primary sort and rank
 *      only breaks ties inside it. The obvious implementation — one flat
 *      ordering — is wrong in a way that is hard to see: dragging a row far
 *      enough would leave it reading P3 while sitting among the P1s, and
 *      every other reader of the plan would disagree with the screen.
 *
 *   2. UNRANKED SORTS LAST, ALPHABETICALLY. The map is sparse, so a
 *      component he has never dragged has to land exactly where it did
 *      before this feature existed — otherwise adding a component to the
 *      project silently reshuffles an order he set last quarter.
 *
 *   3. THE SERVER NUMBERS, THE BROWSER ORDERS. Accepting positions from the
 *      browser lets two components claim rank 3, which is an order with no
 *      answer.
 *
 * Run: node test/component-rank.test.js
 */

const assert = require('node:assert');
const ranks = require('../lib/component-rank');
const pz = require('../lib/prioritization');
const priority = require('../lib/priority');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nComponent rank — his order within a level\n');

/* ── the map ──────────────────────────────────────────────────────────── */

check('a rank is read back, and an unplaced component reads null', () => {
  const plan = { componentRank: { A: 1, B: 2 } };
  assert.strictEqual(ranks.of(plan, 'A'), 1);
  assert.strictEqual(ranks.of(plan, 'B'), 2);
  assert.strictEqual(ranks.of(plan, 'C'), null, 'an unplaced component invented a rank');
  assert.strictEqual(ranks.of({}, 'A'), null);
  assert.strictEqual(ranks.of(null, 'A'), null, 'a missing plan threw instead of answering');
});

check('UNRANKED SORTS AFTER EVERY RANKED ONE, however many there are', () => {
  /* `Infinity`, not a big number: a sentinel that could collide with a real
     rank would put an unranked component in the middle of the order the day
     he ranked enough of them, which is the kind of bug nobody reports
     because it looks like a mis-drag. */
  const plan = { componentRank: { A: ranks.MAX } };
  assert.ok(ranks.sortKey(plan, 'unplaced') > ranks.sortKey(plan, 'A'),
    'an unranked component can sort above a ranked one');
  assert.strictEqual(ranks.sortKey(plan, 'unplaced'), ranks.UNRANKED);
});

check('a rank that is not a whole number in range is REFUSED, not coerced', () => {
  /* Refused rather than rounded, for the reason the priorities already are: a
     rank this tool cannot store is not an error anywhere on screen — the
     component just falls back to alphabetical, in a column that looks fine. */
  for (const bad of [0, -1, 1.5, '', 'first', null, undefined, NaN, ranks.MAX + 1]) {
    assert.strictEqual(ranks.of({ componentRank: { A: bad } }, 'A'), null, `${String(bad)} was accepted`);
  }
  const { map, errors } = ranks.validate({ A: 0, B: 'x', C: 3 });
  assert.deepStrictEqual(map, { C: 3 }, 'a bad rank reached the stored map');
  assert.strictEqual(errors.length, 2, 'and it was not reported');
  assert.ok(errors.every(e => e.message.includes(e.component)), 'an error does not name its component');
});

check('validate refuses a map that is not a map at all', () => {
  assert.deepStrictEqual(ranks.validate([1, 2]).map, {});
  assert.strictEqual(ranks.validate([1, 2]).errors.length, 1);
  assert.deepStrictEqual(ranks.validate(null).map, {}, 'null is an empty map, not an error');
  assert.strictEqual(ranks.validate(null).errors.length, 0);
});

/* ── reordering ───────────────────────────────────────────────────────── */

check('THE CALLER SENDS AN ORDER AND THE MODEL NUMBERS IT', () => {
  /* Dense 1..N, assigned here. Trusting numbers from the browser lets two
     components claim rank 3 — an order with no answer — and lets the values
     drift upward forever as rows are dragged. */
  const out = ranks.reorder({}, ['C', 'A', 'B']);
  assert.deepStrictEqual(out, { C: 1, A: 2, B: 3 });
});

check('and it renumbers densely every time, however the list arrives', () => {
  const out = ranks.reorder({ A: 40, B: 7, C: 900 }, ['A', 'B', 'C']);
  assert.deepStrictEqual(out, { A: 1, B: 2, C: 3 }, 'stale numbers survived a reorder');
});

check('A DUPLICATE IN THE LIST IS DROPPED, not counted twice', () => {
  /* The browser reads this list out of the DOM. A row that appeared twice
     would otherwise renumber everything after it and shift a component the
     user never touched. */
  const out = ranks.reorder({}, ['A', 'B', 'A', 'C']);
  assert.deepStrictEqual(out, { A: 1, B: 2, C: 3 });
});

check('blank and whitespace entries are skipped, and names are trimmed', () => {
  assert.deepStrictEqual(ranks.reorder({}, ['  A  ', '', null, 'B']), { A: 1, B: 2 });
});

check('REORDERING ONE LEVEL LEAVES EVERY OTHER ENTRY ALONE', () => {
  /* The whole reason the route can take one level at a time. If this rewrote
     the map, reordering the P1s would strip the ranks off the P2s and move
     rows on a screen nobody was looking at. */
  const out = ranks.reorder({ P2a: 1, P2b: 2 }, ['P1a', 'P1b']);
  assert.strictEqual(out.P2a, 1, 'another level lost its order');
  assert.strictEqual(out.P2b, 2);
  assert.strictEqual(out.P1a, 1);
});

check('clearing one puts it back to sorting by name', () => {
  const out = ranks.clear({ A: 1, B: 2 }, 'A');
  assert.deepStrictEqual(out, { B: 2 });
  assert.strictEqual(ranks.of({ componentRank: out }, 'A'), null);
});

check('prune drops only what is not in the keep set', () => {
  assert.deepStrictEqual(ranks.prune({ A: 1, B: 2, C: 3 }, ['A', 'C']), { A: 1, C: 3 });
  assert.deepStrictEqual(ranks.prune({ A: 1 }, []), {}, 'an empty keep set should empty the map');
});

/* ── the guards on a write ────────────────────────────────────────────── */

const RANKED = { componentPriority: { A: 1, B: 1, C: 2 } };

check('AN ORDER FROM ANOTHER LEVEL IS REFUSED WHOLE', () => {
  /* THE GUARD THAT MATTERS. `reorder` renumbers every name it is handed, so a
     P2 that found its way into a reordering of the P1s would be renumbered
     too — moving a row on a screen nobody was looking at. Refused rather than
     partially applied, because a half-applied order is not an order. */
  const r = ranks.validateOrder(RANKED, 1, ['A', 'C']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 409);
  assert.ok(r.error.includes('C') && r.error.includes('P2'), `the refusal does not say which or why: ${r.error}`);
  assert.deepStrictEqual(r.order, [], 'a refused order still handed back a list to apply');
});

check('an unknown component is refused, not silently ranked', () => {
  /* The sort reads a rank only for components that have a priority, so an
     entry for an unranked one would sit in the plan file forever doing
     nothing — and nothing on screen would ever say so. */
  const r = ranks.validateOrder(RANKED, 1, ['A', 'Nope']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 404);
  assert.ok(r.error.includes('Nope'));
});

check('a level that is not a level, and an empty order, are refused', () => {
  for (const bad of [null, undefined, 0, 5, 'P1', 1.5]) {
    const r = ranks.validateOrder(RANKED, bad, ['A']);
    assert.strictEqual(r.ok, false, `${String(bad)} was accepted as a level`);
    assert.strictEqual(r.status, 400);
  }
  assert.strictEqual(ranks.validateOrder(RANKED, 1, []).status, 400);
  assert.strictEqual(ranks.validateOrder(RANKED, 1, null).status, 400);
  assert.strictEqual(ranks.validateOrder(RANKED, 1, ['  ', '']).status, 400,
    'a list of blanks passed as an order');
});

check('a good order comes back trimmed and ready to apply', () => {
  const r = ranks.validateOrder(RANKED, 1, ['  B ', 'A']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(r.order, ['B', 'A']);
  assert.deepStrictEqual(ranks.reorder({}, r.order), { B: 1, A: 2 });
});

/* ── the sort it feeds ────────────────────────────────────────────────── */

const epic = (key, o = {}) => ({
  key, issueType: 'Epic', summary: key, components: o.components || [],
  automationStatus: o.automationStatus || 'Automated', labels: [], team: 'T', status: 'Open',
});
const SNAP = {
  issues: Object.fromEntries(['Alpha', 'Bravo', 'Charlie', 'Delta']
    .map((c, i) => epic(`E-${i}`, { components: [c] }))
    .map(i => [i.key, i])),
};
const PLAN = (rank = {}) => ({
  componentPriority: { Alpha: 1, Bravo: 1, Charlie: 1, Delta: 2 },
  componentRank: rank,
  excludedComponents: [], coverageTeams: [], teams: [], sprints: [],
});
const order = (plan) => pz.view(SNAP, plan).rows.map(r => r.component);

check('WITH NOTHING RANKED, THE ORDER IS EXACTLY WHAT IT WAS', () => {
  /* The property that makes this safe to ship: a plan with no ranks sorts
     level-then-name, which is what the page did before the feature existed. */
  assert.deepStrictEqual(order(PLAN()), ['Alpha', 'Bravo', 'Charlie', 'Delta']);
});

check('RANK ORDERS WITHIN THE LEVEL', () => {
  assert.deepStrictEqual(order(PLAN({ Charlie: 1, Alpha: 2, Bravo: 3 })),
    ['Charlie', 'Alpha', 'Bravo', 'Delta']);
});

check('IT NEVER CROSSES A LEVEL — the design, made checkable', () => {
  /* Delta is P2. Give it rank 1 — better than every P1's rank — and it must
     still sort below all of them. A flat ordering puts it first and the row
     then reads P2 while sitting above the P1s. */
  const rows = pz.view(SNAP, PLAN({ Delta: 1, Alpha: 9, Bravo: 8, Charlie: 7 })).rows;
  assert.strictEqual(rows[rows.length - 1].component, 'Delta', 'a P2 outranked the P1s');
  assert.deepStrictEqual(rows.map(r => r.priority), [1, 1, 1, 2], 'the levels are not in order');
  // And within P1 the ranks still decide.
  assert.deepStrictEqual(rows.slice(0, 3).map(r => r.component), ['Charlie', 'Bravo', 'Alpha']);
});

check('A PARTLY RANKED LEVEL PUTS THE UNRANKED ONES LAST, BY NAME', () => {
  /* The sparse case, which is what most levels will look like: he drags the
     two that matter and leaves the rest alone. */
  assert.deepStrictEqual(order(PLAN({ Charlie: 1 })), ['Charlie', 'Alpha', 'Bravo', 'Delta']);
});

check('the rank travels on the row, so the screen can draw it', () => {
  const rows = pz.view(SNAP, PLAN({ Charlie: 1, Alpha: 2 })).rows;
  const at = (c) => rows.find(r => r.component === c);
  assert.strictEqual(at('Charlie').rank, 1);
  assert.strictEqual(at('Alpha').rank, 2);
  assert.strictEqual(at('Bravo').rank, null, 'an unranked row must say so, not carry a made-up number');
});

check('AND THE CAPACITY SHEET INHERITS THE SAME ORDER', () => {
  /* One comparator, both readers. The whole reason the rank lives in the plan
     rather than in the Prioritization screen's memory: the order he drags on
     one page is the order the other draws. */
  const plan = PLAN({ Charlie: 1, Alpha: 2, Bravo: 3 });
  const team = { id: 't', name: 'T', jiraTeams: ['T'] };
  const sheet = pz.sprintComponents(SNAP, { ...plan, teams: [team] }, { team, sprint: null });
  assert.deepStrictEqual(sheet.rows.map(r => r.component), order(plan),
    'the two screens disagree about the order');
  assert.strictEqual(sheet.rows[0].rank, 1, 'the sheet does not carry the rank either');
});

/* ── run ──────────────────────────────────────────────────────────────── */

for (const [name, fn] of checks) {
  try { fn(); console.log(`  \u001b[32m✓\u001b[0m ${name}`); passed++; }
  catch (e) { console.log(`  \u001b[31m✗\u001b[0m ${name}\n    ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
