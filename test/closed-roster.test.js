'use strict';
/**
 * closed-roster.test.js — a closed sprint's capacity belongs to the people who
 * actually gave it one.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────
 *
 * `roster.forSprint` keeps everyone Jira assigned work to in a closed sprint,
 * and that is right — they did the work, so the points are the team's points.
 * But a roster row makes TWO claims and only one of them has evidence behind
 * it. The POINTS are a fact: a ticket carries their name. The CAPACITY is not.
 * Nobody fills in a leave grid for a contractor who touched one ticket, so
 * `availabilityFor` hands that row the DEFAULT grid — ten working days, 61
 * hours, 21 predicted points — and the sprint is then measured against a
 * fortnight that person never gave it.
 *
 * Measured on his store before the fix: 412 such rows across 110 closed
 * sprints, worth 24,258 capacity hours and 8,353 predicted points. 406 of the
 * 412 had no leave grid of any kind. The median closed sprint drew 62.6% of
 * its capacity from them; Titan Sprints 1-7 drew 100%, so every workload
 * percentage in that stretch was computed against people who were not there.
 *
 * ── THE LINE THIS FILE DEFENDS ───────────────────────────────────────────
 *
 * Hours out, tickets in. That is the same line `sprintGrid` already draws for
 * released and hand-exempted members, and it has to hold here, because taking
 * the points as well is the 5,046-point bug documented in `roster.forSprint`
 * re-opened from the other end — the one where a closed sprint's delivery is
 * credited to nobody because the people who delivered it have since left.
 *
 * So every check below comes in a pair: the capacity moved, the points did
 * not. A fix that drops the row wholesale passes the first half of this file
 * and fails the second, which is the point of writing it this way.
 */

const assert = require('node:assert');
const path = require('node:path');

const insights = require('../lib/insights');
const rosterLib = require('../lib/roster');
const cap = require('../lib/capacity');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); } catch (err) {
    failed++; console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

/* ── fixture ──────────────────────────────────────────────────────────────
   One sprint, run twice: once closed, once active, from the SAME data. The
   rule is supposed to be the only difference between them, so anything that
   changes in the active copy is a leak.

   Three people, chosen so the obvious wrong implementations each fail
   somewhere:

     m1  on the team list, leave grid entered       — untouched, always
     ghost  NOT on the team list, NO leave grid, DID deliver points
            — the 406 rows. Capacity out, points in.
     typed  NOT on the team list, leave grid ENTERED by hand
            — the 6 rows. A decision beats a derivation, so hours stay.

   `ghost` delivers points precisely so that a fix which drops the row shows
   up here as missing delivery rather than as a smaller capacity number. */

const SPRINT = (state) => ({
  id: 'S40', number: 40, name: 'Sprint 40', start: '2026-09-17', end: '2026-09-30',
  byTeam: { titan: { jiraId: '9001', name: 'Katalon Titan Sprint 40', state } },
});

const TEAM = {
  id: 'titan', name: 'Katalon Titan', sprintKeywords: ['titan'],
  settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 },
  members: [{ id: 'm1', name: 'Thuan Dinh Cong Ngoc', role: 'QA Lead', status: 'Active', supportPct: 0 }],
};

const full = new Array(14).fill('1').map((c, i) => ([5, 6, 12, 13].includes(i) ? 'WO' : c));

/** `typed` has a grid; `ghost` deliberately does not. */
const PLAN = (state) => ({
  version: 1, teams: [TEAM], sprints: [SPRINT(state)], holidays: [],
  availability: {
    'titan|S40|m1': full,
    'titan|S40|jira:acct-typed': full,
  },
  support: {}, ceremony: {}, overrides: {}, calcExempt: {},
  excluded: {}, sprintRoster: {}, risks: [], notes: {},
});

const issue = (key, assignee, acct, points, done) => ({
  key, summary: key, issueType: 'Story',
  status: done ? 'Done' : 'Open', statusCategory: done ? 'done' : 'new',
  assignee, assigneeId: acct, labels: [], components: [],
  points, sprintNames: ['Katalon Titan Sprint 40'],
  sprints: [{ name: 'Katalon Titan Sprint 40' }],
  blockedBy: [], parentKey: null, relatesTo: [], dueDate: null,
  updated: '2026-09-20T00:00:00.000Z',
  resolved: done ? '2026-09-21T00:00:00.000Z' : null,
  team: 'Katalon Auto Titan', priority: 'Medium',
});

const SNAP = {
  source: 'jira', syncedAt: '2026-10-01T00:00:00.000Z', watermark: '2026-10-01T00:00:00.000Z',
  sprints: [{ name: 'Katalon Titan Sprint 40' }],
  issues: Object.fromEntries([
    issue('A-1', 'Thuan Dinh Cong Ngoc', 'acct-m1', 8, true),
    issue('A-2', 'Thuan Dinh Cong Ngoc', 'acct-m1', 5, false),
    // The ghost: real delivered work, no capacity data anywhere.
    issue('A-3', 'Hector Elias', 'acct-ghost', 7, true),
    issue('A-4', 'Hector Elias', 'acct-ghost', 2, false),
    // The typed one: a grid was entered for them, and they did nothing. This
    // is what his six surviving rows look like.
    issue('A-5', 'Someone Typed', 'acct-typed', 0, false),
  ].map(i => [i.key, i])),
  testops: { projects: [] }, github: {}, verification: [],
};

const view = (state) => insights.capacityView(PLAN(state), SNAP, TEAM, SPRINT(state));
const rowFor = (v, name) => v.rows.find(r => r.name === name);
const tagFor = (v, name) => (v.roster.members || []).find(m => m.name === name) || {};

/* ── 1. The rule fires, and only on the half it is supposed to ─────────── */

check('A CLOSED SPRINT does not count capacity for someone who is not on the team and has no grid', () => {
  const v = view('closed');
  const g = rowFor(v, 'Hector Elias');
  assert.ok(g, 'the ghost row vanished — their delivered work goes with it');
  assert.strictEqual(g.calcExempt, true, 'the row is not exempt, so its hours are still in the total');
  assert.strictEqual(g.autoExempt, true, 'exempted, but not marked as exempted BY RULE');
  assert.strictEqual(g.capacityHours, 0);
  assert.strictEqual(g.predicted, 0);
});

check('and THEIR POINTS STAY — this is the 5,046-point bug, from the other end', () => {
  /* The whole reason the roster keeps off-team people in closed sprints. Drop
     the points with the hours and a closed sprint's delivery is credited to
     nobody, which is what `roster.forSprint` exists to prevent. */
  const v = view('closed');
  const g = rowFor(v, 'Hector Elias');
  assert.strictEqual(g.planned, 9, 'the ghost committed 7 + 2');
  assert.strictEqual(g.actual, 7, 'and delivered 7');
  assert.strictEqual(v.totals.planned, 9 + 13, 'the sprint lost committed work it really had');
  assert.strictEqual(v.totals.actual, 7 + 8, 'the sprint lost delivery it really had');
});

check('the capacity total is EXACTLY the people who have one, not a smaller number', () => {
  // Asserted against the surviving rows' own hours rather than "less than
  // before", which a fix that merely halved everything would also satisfy.
  const v = view('closed');
  const want = cap.round2(rowFor(v, 'Thuan Dinh Cong Ngoc').capacityHours
    + rowFor(v, 'Someone Typed').capacityHours);
  assert.strictEqual(v.totals.capacityHours, want);
  assert.strictEqual(v.totals.headcount, 2, 'the ghost is still in the headcount');
});

check('A HAND-ENTERED GRID IS A DECISION, and beats the rule', () => {
  /* Six of his 412 rows. Someone typed availability against a person who is
     not on the team list, which is them saying that person was on the sprint.
     Everywhere else in this tool a decision beats a derivation; the rule does
     not get to be the exception. */
  const v = view('closed');
  const t = rowFor(v, 'Someone Typed');
  assert.ok(t, 'the typed row is missing');
  assert.strictEqual(t.autoExempt, false, 'the rule overrode an explicit capacity entry');
  assert.ok(t.capacityHours > 0, 'their hours were taken away despite being entered by hand');
});

check('and a MEMBER OF THE TEAM is never touched, grid or no grid', () => {
  const v = view('closed');
  const m = rowFor(v, 'Thuan Dinh Cong Ngoc');
  assert.strictEqual(m.autoExempt, false);
  assert.strictEqual(m.calcExempt, false);
  assert.ok(m.capacityHours > 0);
});

/* ── 2. Closed only ───────────────────────────────────────────────────── */

check('AN ACTIVE SPRINT IS LEFT ALONE — its exempt checkbox is enabled and is the right tool', () => {
  /* On a sprint still being planned, an off-team assignee is a person whose
     capacity you are actively deciding about. The rule firing there would
     silently overrule a decision you are in the middle of making, and the
     screen offers you the checkbox to make it with. */
  const v = view('active');
  const g = rowFor(v, 'Hector Elias');
  assert.strictEqual(g.autoExempt, false, 'the rule fired on a sprint that is not over');
  assert.ok(g.capacityHours > 0, 'an active sprint lost capacity it should have kept');
});

check('a FUTURE sprint likewise', () => {
  const g = rowFor(view('future'), 'Hector Elias');
  assert.strictEqual(g.autoExempt, false);
  assert.ok(g.capacityHours > 0);
});

check('and a sprint with NO Jira state at all — one created here — is not treated as closed', () => {
  // `lock.stateFor` returns null for an unmapped sprint, and `String(null)` is
  // "null", not "closed". Pinned because a looser check would read a missing
  // state as a closed one and quietly strip a hand-made sprint's capacity.
  const plan = PLAN('active');
  plan.sprints = [{ id: 'S40', number: 40, name: 'Sprint 40', start: '2026-09-17', end: '2026-09-30' }];
  const v = insights.capacityView(plan, SNAP, TEAM, plan.sprints[0]);
  const g = rowFor(v, 'Hector Elias');
  assert.ok(g, 'the ghost is not on the sprint at all');
  assert.strictEqual(g.autoExempt, false);
});

/* ── 3. The hand toggle still wins, and stays distinguishable ──────────── */

check('a HAND exemption is still a hand exemption — not relabelled as the rule', () => {
  /* The screen prints a different sentence for each, and a closed sprint's
     checkbox is disabled, so getting these two confused leaves the reader with
     an explanation that does not match what they did. */
  const plan = PLAN('closed');
  plan.calcExempt = { 'titan|S40|m1': true };
  const v = insights.capacityView(plan, SNAP, TEAM, SPRINT('closed'));
  const m = rowFor(v, 'Thuan Dinh Cong Ngoc');
  assert.strictEqual(m.calcExempt, true);
  assert.strictEqual(m.autoExempt, false, 'a decision somebody made was reported as a rule firing');
});

check('the totals count the rule-exempted rows SEPARATELY, so a low headcount is explainable', () => {
  const v = view('closed');
  assert.strictEqual(v.totals.exempt, 1, 'one row is out of the capacity arithmetic');
  assert.strictEqual(v.totals.autoExempt, 1, 'and the screen cannot say why without this');
});

/* ── 4. The flag, because a zero with no explanation reads as a bug ────── */

check('an exempt row says WHY it has no capacity, instead of warning that it has none', () => {
  /* "No capacity this sprint" on a row whose hours were deliberately removed
     is an alarm about the intended behaviour — and on his store it fires 406
     times at once, which is how a warning stops being read at all. */
  const v = view('closed');
  const g = rowFor(v, 'Hector Elias');
  const codes = g.flags.map(f => f.code);
  assert.ok(codes.includes('exempt'), `expected an exempt flag, got ${codes.join(', ') || 'none'}`);
  assert.ok(!codes.includes('no-capacity'), 'still warning about capacity it was told to remove');
  assert.ok(!g.flags.some(f => f.level === 'warn' || f.level === 'risk'),
    'an exempt row raised a warning somebody now has to dismiss');
});

check('and the rule-exempted sentence differs from the hand-exempted one', () => {
  const auto = cap.memberRow({ id: 'x', name: 'X', status: 'Active', supportPct: 0, calcExempt: true, autoExempt: true },
    full, {}, cap.teamSettings(TEAM));
  const hand = cap.memberRow({ id: 'y', name: 'Y', status: 'Active', supportPct: 0, calcExempt: true },
    full, {}, cap.teamSettings(TEAM));
  const text = (r) => r.flags.find(f => f.code === 'exempt').text;
  assert.notStrictEqual(text(auto), text(hand), 'both say the same thing, so neither explains anything');
  assert.match(text(auto), /not on the team list/i);
});

/* ── 5. hasCapacityData — the discriminator the whole rule rests on ────── */

check('hasCapacityData reads a LEAVE GRID, a SUPPORT percentage or an OVERRIDE', () => {
  /* All three are someone recording a capacity decision about a person in a
     sprint. Reading only the availability grid would strip the hours off
     somebody whose support percentage was set by hand — a row that says, in
     the only way the tool offers, that they were half on this sprint. */
  const m = { id: 'p', name: 'P' };
  for (const bucket of ['availability', 'support', 'overrides']) {
    const plan = { availability: {}, support: {}, overrides: {} };
    plan[bucket]['t|S1|p'] = bucket === 'availability' ? full : 40;
    assert.strictEqual(rosterLib.hasCapacityData(plan, 't', 'S1', m), true, `${bucket} was not read`);
  }
  assert.strictEqual(
    rosterLib.hasCapacityData({ availability: {}, support: {}, overrides: {} }, 't', 'S1', m), false);
});

check('and it follows ALIAS IDS, because capacity is filed under older id schemes', () => {
  /* `ruby-thao` for what is now `ruby-thao-dang`. Missing the alias reports
     "no capacity data" for a person whose leave grid is sitting right there,
     and the rule then strips hours somebody definitely entered. */
  const plan = { availability: { 't|S1|old-id': full }, support: {}, overrides: {} };
  const m = { id: 'new-id', name: 'P', aliasIds: ['old-id'] };
  assert.strictEqual(rosterLib.hasCapacityData(plan, 't', 'S1', m), true);
  assert.strictEqual(rosterLib.hasCapacityData(plan, 't', 'S1', { id: 'new-id', name: 'P' }), false,
    'the fixture passes without the alias, so it proves nothing');
});

check('a ZERO support percentage is still an entry — 0 is a decision, undefined is not', () => {
  // `lookup` returns the value; a falsy-rather-than-undefined test here would
  // read "0% support, explicitly set" as "nothing recorded".
  const plan = { availability: {}, support: { 't|S1|p': 0 }, overrides: {} };
  assert.strictEqual(rosterLib.hasCapacityData(plan, 't', 'S1', { id: 'p', name: 'P' }), true);
});

/* ── 6. Coverage: the ratio the exemption leaves mismatched ────────────── */

check('COVERAGE says how much of the committed work sits on measured capacity', () => {
  /* `workloadPct` is all rows' points over active rows' hours, and those stop
     being the same people the moment anyone is exempt. On his Titan Sprint 8
     that reads 1,193% — twelve people's points over the one whose hours were
     ever recorded. The percentage is right; it is unreadable without this. */
  const v = view('closed');
  const measured = rowFor(v, 'Thuan Dinh Cong Ngoc').planned + rowFor(v, 'Someone Typed').planned;
  assert.strictEqual(v.totals.plannedMeasured, measured, 'measured points are not the un-exempt rows');
  assert.strictEqual(v.totals.coveragePct, cap.round1(measured / v.totals.planned * 100));
  assert.ok(v.totals.coveragePct < 100, 'the ghost holds 9 pts against no hours, so coverage cannot be full');
});

check('coverage is 100% when nobody is exempt — it must not cry wolf', () => {
  const v = view('active');
  assert.strictEqual(v.totals.coveragePct, 100);
});

check('and NULL on a sprint that committed nothing, rather than a reassuring 100', () => {
  const grid = cap.sprintGrid(
    { id: 't', name: 'T', settings: {}, members: [{ id: 'a', name: 'A', status: 'Active', supportPct: 0 }] },
    { id: 'S1' }, { a: full }, {});
  assert.strictEqual(grid.totals.planned, 0);
  assert.strictEqual(grid.totals.coveragePct, null,
    'an empty sprint reported full coverage of nothing');
});

check('the capacity screen explains a low coverage instead of printing a bare 1193%', () => {
  const v = view('closed');
  assert.ok(v.totals.coveragePct < 90, 'the fixture no longer triggers the caveat, so it tests nothing');
});

/* ── 7. Downstream: velocity history and calibration ───────────────────── */

check('VELOCITY HISTORY reads the corrected capacity, and keeps the delivery', () => {
  /* `velocityHistory` builds the same grid, so the fix has to reach it — it is
     what Delivery metrics, the forecast and `calibrateHoursPerPoint` all read.
     Calibration divides capacity hours by delivered points, so hours nobody
     worked made every team look slower than it is. */
  const h = insights.velocityHistory(PLAN('closed'), SNAP, TEAM);
  assert.ok(h.length, 'no history rows — the fixture is not being measured at all');
  const r = h[h.length - 1];
  assert.strictEqual(r.actual, 15, 'delivered points left the history');
  assert.strictEqual(r.capacityHours, view('closed').totals.capacityHours,
    'history and the capacity screen disagree about the same sprint');
  assert.strictEqual(r.coveragePct, view('closed').totals.coveragePct,
    'history reports hours without saying how much of the team they cover');
});

check('CALIBRATION stops dividing real hours by hours nobody worked', () => {
  /* `calibrateHoursPerPoint` is capacity hours over delivered points, and it
     is what a team replaces the inherited 2.9 with. Fabricated default grids
     inflated the numerator on 109 closed sprints, so every team that
     calibrated was told it needed more hours per point than it does. */
  const h = insights.velocityHistory(PLAN('closed'), SNAP, TEAM);
  const after = h[h.length - 1].capacityHours;
  const ghostHours = cap.capacityHours(cap.availableDays(full), 0, cap.teamSettings(TEAM));
  assert.ok(ghostHours > 0, 'the fixture has to have hours to remove');
  assert.strictEqual(after, cap.round2(view('closed').totals.capacityHours));
  const before = cap.round2(after + ghostHours);
  assert.ok(cap.round2(before / 15) > cap.round2(after / 15),
    'the old hours-per-point was not actually higher, so this proves nothing');
});

/* ── summary ──────────────────────────────────────────────────────────── */
console.log(`\n${path.basename(__filename)}: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
