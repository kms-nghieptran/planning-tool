'use strict';
/**
 * carryover.test.js — work that arrived from an earlier sprint.
 *
 * The thing worth protecting: a carried item has to be identified by WHOSE
 * board it was on and WHEN that sprint ran. Both halves have already caused
 * real bugs in this codebase — issues sit in two teams' sprints at once, and
 * sprint numbers are not a chronology — so most of what follows is about the
 * ways this could mistake one team's work for another's carryover.
 *
 * Run: node test/carryover.test.js
 */

const assert = require('node:assert');
const c = require('../lib/carryover');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

console.log('\nCarryover — work that arrived from an earlier sprint\n');

const isDone = (i) => i.statusCategory === 'done';

/* Ruby and Titan share the numbered calendar; each has its own Jira sprint per
   row, with its own dates. Taken from the real plan shape. */
const PLAN = {
  sprints: [
    { id: 'S39', name: 'Sprint 39', start: '2026-09-03', end: '2026-09-16',
      byTeam: {
        ruby: { jiraId: '18445', name: 'Katalon Ruby Sprint 39', start: '2026-09-03', end: '2026-09-16' },
        titan: { jiraId: '18304', name: 'Katalon Titan Sprint 39', start: '2026-09-03', end: '2026-09-16' },
      } },
    { id: 'S40', name: 'Sprint 40', start: '2026-09-17', end: '2026-09-30',
      byTeam: {
        ruby: { jiraId: '18532', name: 'Katalon Ruby Sprint 40', start: '2026-09-17', end: '2026-09-30' },
        titan: { jiraId: '18305', name: 'Katalon Titan Sprint 40', start: '2026-09-17', end: '2026-09-30' },
      } },
    { id: 'S41', name: 'Sprint 41', start: '2026-09-30', end: '2026-10-14',
      byTeam: {
        ruby: { jiraId: '18533', name: 'Katalon Ruby Sprint 41', start: '2026-10-01', end: '2026-10-14' },
      } },
    // A dated sprint on a different board entirely.
    { id: 'J18499', name: 'TT Week 14Sep', start: '2026-09-13', end: '2026-09-27',
      byTeam: { titan: { jiraId: '18499', name: 'TT Week 14Sep', start: '2026-09-13', end: '2026-09-27' } } },
  ],
};

const RUBY = { id: 'ruby', name: 'Katalon Ruby' };
const TITAN = { id: 'titan', name: 'Katalon Titan' };
const S41 = PLAN.sprints.find(s => s.id === 'S41');

const idx = (team = RUBY) => c.teamSprintIndex(PLAN, team);
const START = c.startOf(S41, 'ruby');   // 2026-10-01

const item = (key, points, sprintIds, over = {}) => ({
  key, points, status: 'In Dev', statusCategory: 'indeterminate',
  sprints: sprintIds.map(id => {
    const row = PLAN.sprints.find(r => Object.values(r.byTeam || {}).some(t => String(t.jiraId) === String(id)));
    const t = row && Object.values(row.byTeam).find(x => String(x.jiraId) === String(id));
    return { id: String(id), name: t.name, state: 'closed', start: t.start, end: t.end };
  }),
  ...over,
});

/* ── THE INDEX ────────────────────────────────────────────────────────── */

check('THE INDEX HOLDS ONLY THIS TEAM\'S OWN SPRINTS', () => {
  const i = idx(RUBY);
  assert.ok(i.byId.has('18445'), 'Ruby Sprint 39 is missing');
  assert.ok(i.byId.has('18533'), 'Ruby Sprint 41 is missing');
  assert.ok(!i.byId.has('18304'), 'Titan Sprint 39 is in Ruby\'s index');
  assert.ok(!i.byId.has('18499'), 'a TrueTest weekly sprint is in Ruby\'s index');
});

check('AND IT TAKES EACH TEAM\'S OWN DATES, not the shared row\'s', () => {
  /* S41's row says 30 Sep; Ruby's actual sprint started 1 Oct. Ordering by the
     row would call anything starting on 30 Sep "earlier" for a sprint that had
     not begun. */
  assert.strictEqual(idx(RUBY).byId.get('18533').start, '2026-10-01');
  assert.strictEqual(c.startOf(S41, 'ruby'), '2026-10-01');
  assert.strictEqual(c.startOf({ start: '2026-01-01', byTeam: {} }, 'ruby'), '2026-01-01',
    'with no team entry it has to fall back to the row');
});

/* ── WHAT IS CARRIED ──────────────────────────────────────────────────── */

check('AN ITEM FROM AN EARLIER SPRINT OF THIS BOARD IS CARRIED IN', () => {
  const i = item('A-1', 2, ['18532', '18533']);     // Ruby 40 → Ruby 41
  assert.ok(c.isCarriedIn(i, idx(), START));
  const prior = c.priorSprints(i, idx(), START);
  assert.strictEqual(prior.length, 1);
  assert.strictEqual(prior[0].jiraId, '18532');
});

check('AND AN ITEM ONLY IN THIS SPRINT IS NOT', () => {
  assert.ok(!c.isCarriedIn(item('A-2', 3, ['18533']), idx(), START));
});

check('ANOTHER TEAM\'S EARLIER SPRINT IS NOT THIS TEAM\'S CARRYOVER', () => {
  /* The failure this guards: an epic sits in Titan's TT Week 14Sep AND Ruby's
     Sprint 41. It is new work for Ruby. Counting Titan's sprint as "earlier"
     would report Ruby's fresh commitment as carried, and the person would stop
     being flagged for a load they really did just take on. */
  const i = item('A-3', 5, ['18499', '18533']);     // Titan weekly → Ruby 41
  assert.ok(!c.isCarriedIn(i, idx(RUBY), START), 'Titan\'s sprint counted as Ruby\'s carryover');
  // And the same item IS carryover for Titan, measured against Titan's board.
  const titanStart = '2026-09-17';
  assert.ok(c.isCarriedIn(item('A-3', 5, ['18499', '18305']), idx(TITAN), titanStart));
});

check('A LATER SPRINT IS NOT AN EARLIER ONE', () => {
  /* An item already pushed to a future sprint still sits in this one. */
  const i = { key: 'A-4', points: 3, sprints: [
    { id: '18533', name: 'Katalon Ruby Sprint 41', start: '2026-10-01' },
    { id: '18611', name: 'Katalon Ruby Sprint 42', start: '2026-10-15' },
  ] };
  assert.ok(!c.isCarriedIn(i, idx(), START));
});

check('THE SAME SPRINT IS NOT AN EARLIER ONE EITHER', () => {
  /* `>=` not `>`: a sprint cannot be earlier than itself, and an off-by-one
     here makes every item in the sprint look carried. */
  assert.ok(!c.isCarriedIn(item('A-5', 1, ['18533']), idx(), START));
});

check('AN UNDATED SPRINT CANNOT BE PLACED, so it is not guessed at', () => {
  const i = { key: 'A-6', points: 2, sprints: [{ id: '18532', name: 'Katalon Ruby Sprint 40' }, { id: '18533' }] };
  const bare = c.teamSprintIndex({ sprints: [
    { id: 'S40', byTeam: { ruby: { jiraId: '18532', name: 'Katalon Ruby Sprint 40' } } },
    { id: 'S41', byTeam: { ruby: { jiraId: '18533', name: 'Katalon Ruby Sprint 41', start: '2026-10-01' } } },
  ] }, RUBY);
  assert.ok(!c.isCarriedIn(i, bare, START), 'a sprint with no dates was ordered anyway');
});

check('AND NEITHER CAN ANYTHING, WHEN THIS SPRINT HAS NO START', () => {
  assert.deepStrictEqual(c.priorSprints(item('A-7', 2, ['18532', '18533']), idx(), null), []);
});

check('A SPRINT STAMP WITH NO ID FALLS BACK TO ITS NAME', () => {
  /* An older Jira custom-field format carries no id. Without this a team on
     that data reports zero carryover forever — which reads as "none", not as
     "cannot tell". */
  const i = { key: 'A-8', points: 2, sprints: [
    { name: 'Katalon Ruby Sprint 40', start: '2026-09-17' },
    { id: '18533', name: 'Katalon Ruby Sprint 41', start: '2026-10-01' },
  ] };
  assert.ok(c.isCarriedIn(i, idx(), START));
});

check('BUT AN ID THAT IS NOT THIS BOARD\'S DOES NOT FALL BACK TO THE NAME', () => {
  /* "Katalon Titan Sprint 40" would never match Ruby's names, but a board
     whose sprints are named identically would — and falling through on a
     known-foreign id is how one team's sprint becomes the other's. */
  const i = { key: 'A-9', points: 2, sprints: [
    { id: '18305', name: 'Katalon Ruby Sprint 40', start: '2026-09-17' },   // Titan's id, Ruby's name
    { id: '18533', name: 'Katalon Ruby Sprint 41', start: '2026-10-01' },
  ] };
  assert.ok(!c.isCarriedIn(i, idx(), START), 'a foreign id was rescued by a matching name');
});

check('ONE ITEM CARRIED THROUGH MANY SPRINTS REPORTS THE OLDEST', () => {
  /* AUTOKAT-7010 has been in every Ruby sprint since 29. "Carried since Sprint
     39" is a different conversation from "carried once".

     THE STAMPS ARE LISTED NEWEST FIRST, deliberately. Jira does not promise an
     order, and a fixture that happened to be chronological made the sort look
     like it was working when it had been deleted — the list came back right
     because it went in right. */
  const i = item('A-10', 2, ['18533', '18532', '18445']);
  const prior = c.priorSprints(i, idx(), START);
  assert.strictEqual(prior.length, 2, 'both earlier sprints should be listed');
  assert.strictEqual(prior[0].jiraId, '18445', 'the oldest must come first');
  assert.strictEqual(prior[1].jiraId, '18532');
});

check('AND ONE SPRINT STAMPED TWICE IS STILL ONE SPRINT', () => {
  /* Reachable two ways: Jira's sprint custom field can repeat an entry, and
     the name fallback resolves a stamp with no id onto the same sprint a
     stamped one already matched. Counted twice, "carried through 2 sprints"
     is said of an item carried through one. */
  const i = { key: 'A-11', points: 2, sprints: [
    { id: '18532', name: 'Katalon Ruby Sprint 40', start: '2026-09-17' },
    { name: 'Katalon Ruby Sprint 40', start: '2026-09-17' },     // same sprint, no id
    { id: '18533', name: 'Katalon Ruby Sprint 41', start: '2026-10-01' },
  ] };
  const prior = c.priorSprints(i, idx(), START);
  assert.strictEqual(prior.length, 1, `one sprint was counted ${prior.length} times`);
  assert.strictEqual(prior[0].jiraId, '18532');
});

/* ── THE SPLIT ────────────────────────────────────────────────────────── */

check('THE SPLIT SEPARATES NEW SCOPE FROM CARRIED SCOPE', () => {
  const items = [
    item('B-1', 8, ['18533']),                 // new
    item('B-2', 5, ['18533']),                 // new
    item('B-3', 2, ['18532', '18533']),        // carried
    item('B-4', 4, ['18445', '18533']),        // carried, older
  ];
  const s = c.split(items, idx(), START, isDone);
  assert.strictEqual(s.freshPoints, 13);
  assert.strictEqual(s.carriedPoints, 6);
  assert.strictEqual(s.carried.length, 2);
  assert.strictEqual(s.fresh.length, 2);
  assert.strictEqual(s.oldest.jiraId, '18445', 'the oldest carried sprint is not reported');
});

check('A CARRIED ITEM FINISHED SINCE IS STILL CARRIED', () => {
  /* It ARRIVED as carryover. A count that dropped it the moment it closed
     would shrink as the sprint went on, and a commitment figure that falls
     while you work is not a commitment figure. Reported separately so a screen
     can say "6 carried in, 2 since finished". */
  const items = [
    item('B-5', 2, ['18532', '18533'], { statusCategory: 'done', status: 'Done' }),
    item('B-6', 4, ['18532', '18533']),
  ];
  const s = c.split(items, idx(), START, isDone);
  assert.strictEqual(s.carriedPoints, 6, 'a finished carried item stopped counting');
  assert.strictEqual(s.carriedDone, 2);
  assert.strictEqual(s.carriedDoneItems.length, 1);
});

check('ITEMS WITH NO POINTS CARRY NO POINTS, but are still counted as items', () => {
  /* Three of his ride along at 0 points for 10+ sprints. They must not move
     the workload arithmetic and must still be visible as carryover. */
  const items = [item('B-7', null, ['18445', '18533']), item('B-8', 0, ['18445', '18533'])];
  const s = c.split(items, idx(), START, isDone);
  assert.strictEqual(s.carriedPoints, 0);
  assert.strictEqual(s.carried.length, 2, 'a pointless carried item vanished entirely');
});

check('"CANNOT TELL" IS NOT REPORTED AS "NONE"', () => {
  /* With no start date nothing can be ordered. Folding those into `fresh`
     silently would have the screen state there is no carryover, which is a
     claim this cannot make. */
  const s = c.split([item('B-9', 3, ['18532', '18533'])], idx(), null, isDone);
  assert.strictEqual(s.undated, 1);
  assert.strictEqual(s.carriedPoints, 0);
  assert.strictEqual(s.freshPoints, 3, 'the points still have to land somewhere');
});

/* ── THE OTHER END ────────────────────────────────────────────────────── */

check('CARRIED OUT IS WORK THIS SPRINT HANDED ON', () => {
  /* The other half of the double count: the sprint that did not finish it is
     charged in full, and so is the one that picks it up. */
  const sprint40Start = '2026-09-17';
  const items = [
    item('C-1', 3, ['18532']),                                                   // stayed, unfinished, not moved
    item('C-2', 5, ['18532', '18533']),                                          // handed on
    item('C-3', 2, ['18532', '18533'], { statusCategory: 'done', status: 'Done' }), // finished — not carried out
  ];
  const out = c.carriedOut(items, idx(), sprint40Start, isDone);
  assert.strictEqual(out.points, 5, 'the handed-on points are wrong');
  assert.deepStrictEqual(out.items.map(i => i.key), ['C-2']);
});

check('AND A SPRINT WITH NO START HANDS NOTHING ON THAT WE CAN PROVE', () => {
  /* A CONTRACT CHECK, not a behaviour one. Deleting the early return leaves
     this green, because `'2026-10-01' > null` is false anyway — the guard says
     out loud what JS comparison happens to do, so a later change to numeric
     dates cannot turn silence into a wrong answer. Noted rather than dressed
     up: a mutation of that line survives, and should. */
  assert.deepStrictEqual(c.carriedOut([item('C-4', 3, ['18532', '18533'])], idx(), null, isDone),
    { items: [], points: 0 });
});

check('CARRIED OUT OF ONE SPRINT IS CARRIED INTO THE NEXT', () => {
  /* The two ends have to agree or the history screen reports work appearing
     from nowhere. Same item, both directions, one set of rules. */
  const i = item('D-1', 5, ['18532', '18533']);
  const out = c.carriedOut([i], idx(), '2026-09-17', isDone);
  const inn = c.split([i], idx(), START, isDone);
  assert.strictEqual(out.points, 5, 'Sprint 40 did not hand it on');
  assert.strictEqual(inn.carriedPoints, 5, 'Sprint 41 did not receive it');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
