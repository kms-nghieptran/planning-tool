'use strict';
/**
 * sprint-note.test.js — the note that belongs to a sprint, not to a suite.
 *
 * WHY THIS SUITE EXISTS
 *
 * The Capacity sheet's note column wrote to the GLOBAL component note, shared
 * with the Prioritization screen, and that was a deliberate decision with a
 * comment explaining it. What it missed is what actually got typed into it.
 * Fourteen notes had been written from that sheet and they read: "2 cases
 * remaining; both will be picked up for implementation in the sprint", "plan to
 * build 3 new TT cases based on the current available capacity". Those are this
 * sprint's plan, stored in a field that would still be showing them in March.
 *
 * WHAT MAKES THE KEY HARD, AND WHY IT IS CHECKED THIS HARD
 *
 * A sprint in the plan is a CALENDAR ROW, not a Jira sprint. On his board:
 *
 *   S40  → Jira 18532 for Ruby, Jira 18305 for Titan   — two different sprints
 *   J18499 "TT Week 14Sep" → Jira 18499 for Titan, Malphite AND Automation
 *                                                      — genuinely one sprint
 *
 * Key the note on the plan's sprint id and Ruby's note appears on Titan's
 * sheet. Key it on team+sprint and he types the TT Week note three times. The
 * only identifier that means "this sprint" in the sense he means it is the Jira
 * sprint the selected row resolves to — and every one of those failures is
 * silent, which is what a suite is for.
 *
 * Run: node test/sprint-note.test.js
 */

const assert = require('node:assert');
const notes = require('../lib/sprint-note');
const global_ = require('../lib/component-note');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nThe note that belongs to a sprint\n');

/* ── his board, in miniature ──────────────────────────────────────────── */

const PLAN = () => ({
  sprints: [
    /* ONE PLAN ROW, TWO REAL SPRINTS. This is the case that decides the whole
       design, and it is his actual data. */
    { id: 'S40', name: 'Sprint 40', byTeam: { ruby: { jiraId: '18532' }, titan: { jiraId: '18305' } } },
    /* ONE REAL SPRINT, THREE TEAMS. The other direction, also his. */
    { id: 'J18499', name: 'TT Week 14Sep', byTeam: { titan: { jiraId: '18499' }, malphite: { jiraId: '18499' }, squad: { jiraId: '18499' } } },
    /* NO JIRA SPRINT AT ALL — added by hand, or the board sync has not run. */
    { id: 'MANUAL', name: 'Planning week', byTeam: {} },
  ],
  componentNote: {},
  sprintComponentNote: {},
});

const RUBY = { id: 'ruby' };
const TITAN = { id: 'titan' };
const MALPHITE = { id: 'malphite' };
const key = (plan, team, sprintId) => notes.keyOf(plan, team, { id: sprintId });

/* ── the key ──────────────────────────────────────────────────────────── */

check('TWO TEAMS ON ONE PLAN ROW BUT TWO JIRA SPRINTS DO NOT SHARE A NOTE', () => {
  /* Ruby's Sprint 40 and Titan's Sprint 40 are different sprints with different
     work in them. A note on one appearing on the other is wrong and says
     nothing on screen about being wrong. */
  const p = PLAN();
  assert.notStrictEqual(key(p, RUBY, 'S40'), key(p, TITAN, 'S40'),
    'Ruby and Titan share a note key for two different Jira sprints');
});

check('AND TWO TEAMS ON ONE JIRA SPRINT DO SHARE IT', () => {
  /* TT Week 14Sep is one sprint that three teams look at. Making him type the
     note three times leaves three copies to drift. */
  const p = PLAN();
  assert.strictEqual(key(p, TITAN, 'J18499'), key(p, MALPHITE, 'J18499'),
    'one Jira sprint was split into a note per team');
});

check('THE KEY IS THE JIRA SPRINT, not the plan row it was reached through', () => {
  const p = PLAN();
  assert.strictEqual(key(p, RUBY, 'S40'), 'jira:18532');
  assert.strictEqual(key(p, TITAN, 'S40'), 'jira:18305');
  assert.strictEqual(key(p, TITAN, 'J18499'), 'jira:18499');
});

check('A SPRINT WITH NO JIRA ID FALLS BACK TO TEAM AND ROW, never to one shared key', () => {
  /* THE FAILURE THIS PREVENTS: an undefined jiraId collapsing every hand-made
     sprint onto a single key, so every one of them shows the same note. The
     fallback is narrower than the truth — two teams on one hand-made sprint
     keep separate notes — and never wrong, which is the right way round. */
  const p = PLAN();
  const a = key(p, RUBY, 'MANUAL');
  const b = key(p, TITAN, 'MANUAL');
  assert.ok(a && b, 'a sprint with no Jira id got no key at all');
  assert.notStrictEqual(a, b, 'two teams collapsed onto one key for a hand-made sprint');
  assert.ok(!a.startsWith('jira:'), `the fallback pretends to be a Jira key: ${a}`);
});

check('AND A BLANK OR MISSING JIRA ID IS TREATED AS ABSENT, not as a key', () => {
  /* `jiraId: ''` and `jiraId: null` reach this from a partial sync, and
     `jira:` as a key would be shared by every sprint that had one. */
  for (const bad of ['', '   ', null, undefined]) {
    const p = PLAN();
    p.sprints[0].byTeam.ruby.jiraId = bad;
    const k = key(p, RUBY, 'S40');
    assert.ok(!/^jira:\s*$/.test(k), `a blank id produced the key ${JSON.stringify(k)}`);
    assert.ok(k.startsWith('plan:'), `a blank id did not fall back: ${k}`);
  }
});

check('NO SPRINT MEANS NO KEY, so a note cannot be filed against nothing', () => {
  const p = PLAN();
  assert.strictEqual(notes.keyOf(p, RUBY, null), null);
  assert.strictEqual(notes.keyOf(p, RUBY, {}), null);
  assert.strictEqual(notes.keyOf(p, RUBY, { id: '' }), null);
});

check('A SPRINT THE PLAN DOES NOT HAVE STILL GETS A KEY OF ITS OWN', () => {
  /* Not silently merged with another. An unknown row is a row nobody can look
     up a Jira id for, which is the fallback's job. */
  const p = PLAN();
  const k = key(p, RUBY, 'GHOST');
  assert.ok(k && k.startsWith('plan:'), `an unknown sprint got ${k}`);
  assert.notStrictEqual(k, key(p, RUBY, 'MANUAL'));
});

check('THE ROW IS LOOKED UP IN THE PLAN, not read off the argument', () => {
  /* Some callers pass a trimmed sprint with no `byTeam` — the capacity view
     builds exactly that. Reading the argument would take the fallback for a
     sprint with a perfectly good Jira id, and the note would land somewhere the
     next render does not look. */
  const p = PLAN();
  assert.strictEqual(notes.keyOf(p, TITAN, { id: 'S40', name: 'Sprint 40' }), 'jira:18305',
    'a sprint passed without byTeam lost its Jira id');
});

/* ── reading and writing ──────────────────────────────────────────────── */

check('A NOTE IS READ BACK FROM THE SPRINT IT WAS WRITTEN TO', () => {
  const p = PLAN();
  p.sprintComponentNote = notes.set({}, key(p, TITAN, 'S40'), 'PS_iGO_NLG', 'two cases left this sprint');
  assert.strictEqual(notes.of(p, key(p, TITAN, 'S40'), 'PS_iGO_NLG'), 'two cases left this sprint');
  /* AND NOT FROM ANOTHER ONE. This is the whole point. */
  assert.strictEqual(notes.of(p, key(p, RUBY, 'S40'), 'PS_iGO_NLG'), null,
    "Ruby's sheet is showing Titan's note");
  assert.strictEqual(notes.of(p, key(p, TITAN, 'J18499'), 'PS_iGO_NLG'), null,
    'the note leaked into another sprint');
});

check('BLANK DELETES, and emptying the last note drops the sprint', () => {
  /* "Has a note" has to mean one thing however the row got there, or the map
     grows a key for every component ever clicked. Same rule as the global note
     one level down — and one level up as well, which that one does not need. */
  const p = PLAN();
  const k = key(p, TITAN, 'S40');
  let all = notes.set({}, k, 'PS_A', 'something');
  all = notes.set(all, k, 'PS_B', 'else');
  assert.deepStrictEqual(Object.keys(all[k]).sort(), ['PS_A', 'PS_B']);

  all = notes.set(all, k, 'PS_A', '   ');
  assert.deepStrictEqual(Object.keys(all[k]), ['PS_B'], 'whitespace did not clear the note');
  all = notes.set(all, k, 'PS_B', null);
  assert.ok(!(k in all), `the sprint stayed behind as an empty object: ${JSON.stringify(all)}`);
});

check('AND WRITING TO ONE SPRINT LEAVES THE OTHERS ALONE', () => {
  const p = PLAN();
  let all = notes.set({}, key(p, TITAN, 'S40'), 'PS_A', 'titan');
  all = notes.set(all, key(p, RUBY, 'S40'), 'PS_A', 'ruby');
  all = notes.set(all, key(p, TITAN, 'S40'), 'PS_A', '');
  p.sprintComponentNote = all;
  assert.strictEqual(notes.of(p, key(p, RUBY, 'S40'), 'PS_A'), 'ruby',
    "clearing Titan's note cleared Ruby's");
});

check('`set` DOES NOT MUTATE WHAT IT WAS GIVEN', () => {
  /* The route reads the stored map, edits it and validates the result; a
     mutating `set` would have already changed the plan before validation had a
     chance to refuse it. */
  const before = { 'jira:1': { PS_A: 'kept' } };
  const snapshot = JSON.stringify(before);
  notes.set(before, 'jira:1', 'PS_A', 'changed');
  notes.set(before, 'jira:2', 'PS_B', 'added');
  assert.strictEqual(JSON.stringify(before), snapshot, 'the stored map was edited in place');
});

/* ── validation ───────────────────────────────────────────────────────── */

check('THE CAP IS ENFORCED, not silently truncated', () => {
  /* Keeping the first 600 characters would lose the end of a sentence and look,
     on screen, exactly like a note that was always short. */
  const k = 'jira:1';
  const ok = { [k]: { PS_A: 'x'.repeat(notes.MAX) } };
  assert.deepStrictEqual(notes.validate(ok).errors, [], 'a note exactly at the cap was refused');
  const over = { [k]: { PS_A: 'x'.repeat(notes.MAX + 1) } };
  const r = notes.validate(over);
  assert.strictEqual(r.errors.length, 1, 'an oversized note was accepted');
  assert.ok(!(k in r.map), 'the oversized note was stored anyway');
  assert.match(r.errors[0].message, new RegExp(String(notes.MAX)), 'the error does not say what the limit is');
});

check('A SPRINT WHOSE NOTES ARE ALL BLANK IS DROPPED ENTIRELY', () => {
  const r = notes.validate({ 'jira:1': { PS_A: '   ', PS_B: '' }, 'jira:2': { PS_C: 'real' } });
  assert.deepStrictEqual(Object.keys(r.map), ['jira:2'], `empty sprint kept: ${JSON.stringify(r.map)}`);
});

check('AND RUBBISH IS REFUSED RATHER THAN STORED', () => {
  assert.deepStrictEqual(notes.validate([]).map, {}, 'an array was accepted as a note map');
  assert.ok(notes.validate([]).errors.length);
  const r = notes.validate({ 'jira:1': { PS_A: 42 }, '  ': { PS_B: 'x' }, 'jira:2': 'not an object' });
  assert.strictEqual(r.map['jira:1'], undefined, 'a number was stored as a note');
  assert.ok(r.errors.length >= 3, `only ${r.errors.length} of three problems were reported`);
});

check('VALIDATION SURVIVES A MAP IT HAS ALREADY BLESSED', () => {
  /* The route validates the result of every edit, so the output has to be a
     legal input — otherwise the second edit of a session fails. */
  const first = notes.validate({ 'jira:1': { PS_A: 'note' } });
  const second = notes.validate(first.map);
  assert.deepStrictEqual(second.map, first.map);
  assert.deepStrictEqual(second.errors, []);
});

/* ── the two notes are independent ────────────────────────────────────── */

check('THE SPRINT NOTE AND THE COMPONENT NOTE DO NOT TOUCH', () => {
  /* The whole point of the change. They live in different keys of the plan and
     neither model can see the other's. */
  const p = PLAN();
  p.componentNote = global_.set({}, 'PS_iGO_NLG', 'no longer supported');
  p.sprintComponentNote = notes.set({}, key(p, TITAN, 'S40'), 'PS_iGO_NLG', 'two cases left');

  assert.strictEqual(global_.of(p, 'PS_iGO_NLG'), 'no longer supported');
  assert.strictEqual(notes.of(p, key(p, TITAN, 'S40'), 'PS_iGO_NLG'), 'two cases left');

  /* CLEARING ONE DOES NOT CLEAR THE OTHER. */
  p.sprintComponentNote = notes.set(p.sprintComponentNote, key(p, TITAN, 'S40'), 'PS_iGO_NLG', '');
  assert.strictEqual(global_.of(p, 'PS_iGO_NLG'), 'no longer supported',
    'clearing the sprint note cleared the component note');

  p.componentNote = global_.set(p.componentNote, 'PS_iGO_NLG', '');
  p.sprintComponentNote = notes.set(p.sprintComponentNote, key(p, TITAN, 'S40'), 'PS_iGO_NLG', 'back again');
  assert.strictEqual(notes.of(p, key(p, TITAN, 'S40'), 'PS_iGO_NLG'), 'back again');
  assert.strictEqual(global_.of(p, 'PS_iGO_NLG'), null);
});

check('AND THEY ARE STORED UNDER DIFFERENT PLAN KEYS', () => {
  /* A shared key would make the two indistinguishable to everything that
     persists, exports or imports the plan. */
  const p = PLAN();
  p.componentNote = { PS_A: 'global' };
  p.sprintComponentNote = { 'jira:1': { PS_A: 'sprint' } };
  assert.strictEqual(global_.of(p, 'PS_A'), 'global');
  assert.strictEqual(notes.of(p, 'jira:1', 'PS_A'), 'sprint');
  assert.strictEqual(notes.of({ componentNote: { PS_A: 'global' } }, 'jira:1', 'PS_A'), null,
    'the sprint model read the global map');
});

/* ── the helpers the view and the route use ───────────────────────────── */

check('`forSprint` RETURNS A COPY, so a caller cannot edit the plan by accident', () => {
  const p = PLAN();
  p.sprintComponentNote = { 'jira:1': { PS_A: 'x' } };
  const got = notes.forSprint(p, 'jira:1');
  got.PS_B = 'added by a caller';
  assert.deepStrictEqual(p.sprintComponentNote['jira:1'], { PS_A: 'x' }, 'the plan was edited through the copy');
});

check('AND ANSWERS SAFELY FOR A SPRINT WITH NOTHING AGAINST IT', () => {
  const p = PLAN();
  assert.deepStrictEqual(notes.forSprint(p, 'jira:nope'), {});
  assert.deepStrictEqual(notes.forSprint(p, null), {});
  assert.strictEqual(notes.of(p, null, 'PS_A'), null);
  assert.strictEqual(notes.of({}, 'jira:1', 'PS_A'), null);
});

check('A MISSING KEY READS NOTHING, even past a sprint that stringifies the same', () => {
  /* `keyOf` returns null when no sprint is selected, and without a guard the
     lookup becomes `all[String(null)]` — which finds a sprint literally keyed
     "null". Contrived, and the guard costs one line; the alternative is a
     sheet with no sprint showing somebody else's notes. */
  const p = PLAN();
  p.sprintComponentNote = { null: { PS_A: 'should never be read' }, undefined: { PS_A: 'nor this' } };
  assert.strictEqual(notes.of(p, null, 'PS_A'), null, 'a null key read a sprint named "null"');
  assert.strictEqual(notes.of(p, undefined, 'PS_A'), null, 'an absent key read a sprint named "undefined"');
  assert.deepStrictEqual(notes.forSprint(p, null), {}, 'a null key listed a sprint named "null"');
});

check('`decorate` PUTS THE SPRINT NOTE ON A ROW WITHOUT DISTURBING THE OTHER', () => {
  const p = PLAN();
  p.sprintComponentNote = { 'jira:1': { PS_A: 'this sprint' } };
  const rows = [{ component: 'PS_A', note: 'global' }, { component: 'PS_B', note: null }];
  const out = notes.decorate(rows, p, 'jira:1');
  assert.strictEqual(out[0].sprintNote, 'this sprint');
  assert.strictEqual(out[0].note, 'global', 'decorating overwrote the component note');
  assert.strictEqual(out[1].sprintNote, null);
  assert.strictEqual(rows[0].sprintNote, undefined, 'the rows were edited in place');
});

/* ── run ──────────────────────────────────────────────────────────────── */

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
