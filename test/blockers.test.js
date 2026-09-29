'use strict';
/**
 * blockers.test.js — what is holding this team up.
 *
 * WHY THIS SUITE EXISTS
 *
 * Every number on the Blockers page is a count of items, and all of them are
 * computed from the same 543-item pile by different slices. The failures that
 * matter are the ones where two of those slices stop adding up — explained +
 * unrecorded ≠ items, a group counting an item its own key list does not
 * name, a sprint filter that silently widens to the whole board. None of
 * those look wrong on screen: they render as a slightly different number on
 * a page nobody has a second copy of.
 *
 * So these check the ARITHMETIC of the view, not its wording.
 *
 * Run: node test/blockers.test.js
 */

const assert = require('node:assert');
const blockers = require('../lib/blockers');
const insights = require('../lib/insights');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nWhat is holding this team up\n');

/* ── a board shaped like his ──────────────────────────────────────────────
   Stories in Refinement whose EPICS carry the blocker, which is the shape
   that made this feature necessary: not one Story in his store names its own
   blocker, and reading the Story alone shows a sprint that is merely slow. */

const issue = (key, o = {}) => ({
  key,
  summary: o.summary || `Work ${key}`,
  issueType: o.issueType || 'Story',
  status: 'status' in o ? o.status : 'Refinement',
  statusCategory: o.statusCategory || 'indeterminate',
  points: 'points' in o ? o.points : 3,
  parentKey: o.parent || null,
  blockedBy: o.blockedBy || [],
  sprints: o.sprints || [],
  /* `'automationStatus' in o`, not `o.automationStatus || ''`. An item with
     the field genuinely unset is the ordinary case and has to stay
     expressible — the same fixture defect that made the PS_iGO_Lafayette bug
     unreproducible, and the assignee one after it. */
  automationStatus: 'automationStatus' in o ? o.automationStatus : null,
});

const epic = (key, blockedBy = []) => issue(key, {
  issueType: 'Epic', status: 'Open', points: null,
  blockedBy: blockedBy.map(b => (typeof b === 'string' ? { key: b } : b)),
});

const S40 = [{ id: '900', name: 'Sprint 40', state: 'active' }];

function board() {
  const issues = {};
  const put = (i) => { issues[i.key] = i; return i; };

  /* ONE TICKET HOLDING SEVERAL, which is the whole reason the page groups by
     the blocker: three items behind one call, not three rows to chase. */
  put(epic('E-1', [{ key: 'EXT-1', summary: 'Client schema sign-off', type: 'Story' }]));
  put(issue('A-1', { parent: 'E-1', sprints: S40 }));
  put(issue('A-2', { parent: 'E-1', sprints: S40 }));
  put(issue('A-3', { parent: 'E-1' }));                      // no sprint

  // An epic naming TWO blockers — the item is waiting on both.
  put(epic('E-2', ['EXT-1', 'EXT-2']));
  put(issue('B-1', { parent: 'E-2', points: 5, sprints: S40 }));

  /* A TICKET WHOSE ALPHABETICAL PLACE DISAGREES WITH ITS COUNT. `AAA-9` holds
     two and sorts first by name; `EXT-2` holds one and sorts last. Without a
     pair like this an alphabetical sort and a by-count sort produce the same
     order on this fixture, and the ordering check proves nothing — which is
     exactly how dropping the sort survived a mutation run once already. */
  put(epic('E-4', ['AAA-9']));
  put(issue('F-1', { parent: 'E-4' }));
  put(issue('F-2', { parent: 'E-4' }));

  // In Refinement, epic names nothing. The pile the register exists for.
  put(epic('E-3', []));
  put(issue('C-1', { parent: 'E-3', points: 2 }));
  put(issue('C-2', { parent: 'E-3' }));
  put(issue('C-3', { parent: 'E-3', sprints: S40 }));

  /* ── THE SECOND SIGNAL ────────────────────────────────────────────
     Automation status = Blocked. Not redundant with the Refinement column:
     226 open items in his store carry it and only 131 are also in
     Refinement, so the column alone missed 95 pieces of work somebody had
     explicitly marked as stuck. An item can be In Dev and still be blocked
     for automation, which is exactly what this tool is about. */
  put(issue('G-1', { parent: 'E-3', status: 'Open', automationStatus: 'Blocked', points: 8 }));
  // Both signals at once — counted ONCE, not twice.
  put(issue('G-2', { parent: 'E-1', status: 'Refinement', automationStatus: 'Blocked' }));
  // An EPIC marked blocked for automation. 182 of his 226 are epics.
  put(issue('G-3', { issueType: 'Epic', status: 'Open', automationStatus: 'Blocked', points: null }));

  // NOT blocked: in flight, done-in-Refinement (a workflow quirk), and a
  // finished suite whose automation status was never moved off Blocked.
  put(issue('D-1', { parent: 'E-3', status: 'In Dev' }));
  put(issue('D-2', { parent: 'E-3', status: 'Refinement', statusCategory: 'done' }));
  put(issue('D-3', { parent: 'E-3', status: 'Done', statusCategory: 'done', automationStatus: 'Blocked' }));
  // And one merely READY for automation — the adjacent value that must not match.
  put(issue('D-4', { parent: 'E-3', status: 'Open', automationStatus: 'Ready for Automation' }));
  /* A VALUE THAT CONTAINS THE WORD. AUTOKAT grows statuses — Bucket Story and
     Test both arrived after this tool did — and the day somebody adds
     "Unblocked" a substring match starts counting the opposite of what it
     means, on a field nobody would think to re-check. */
  put(issue('D-5', { parent: 'E-3', status: 'Open', automationStatus: 'Unblocked' }));

  const keys = Object.keys(issues);
  return {
    issues,
    byTeam: {
      ruby: {
        sprintIssues: { 900: keys.filter(k => (issues[k].sprints || []).length) },
        backlog: keys.filter(k => !(issues[k].sprints || []).length),
      },
    },
  };
}

const PLAN = () => ({
  teams: [{ id: 'ruby', name: 'Katalon Ruby' }],
  sprints: [{ id: 's40', name: 'Sprint 40', byTeam: { ruby: { jiraId: '900', name: 'Sprint 40', state: 'active' } } }],
  blockers: [],
});

const view = (o = {}, planPatch = {}) =>
  blockers.blockerView({ ...PLAN(), ...planPatch }, board(), { teamId: 'ruby', ...o });

/* ── the checks ───────────────────────────────────────────────────────── */

check('"BLOCKED" IS THE SAME PREDICATE THE REST OF THE TOOL USES', () => {
  /* The worst possible place to introduce a second definition of blocked is
     a page called Blockers. `insights.isBlocked` already has four readers and
     is documented at its definition; this is the fifth, not a sixth opinion. */
  const v = view();
  assert.strictEqual(v.counts.items, 12, 'the blocked set is not the twelve blocked items');

  const all = Object.values(board().issues);
  assert.strictEqual(v.counts.items, all.filter(insights.isBlocked).length,
    'the page counts something different from the Blocked KPI two screens away');

  // The two that must NOT be in it, and why each one is a real case.
  const named = new Set([...v.detected.flatMap(g => g.items), ...v.unrecorded.items]);
  assert.ok(!named.has('D-1'), 'an item in progress was counted as blocked');
  assert.ok(!named.has('D-2'), 'finished work in a Refinement-named column was counted as blocked');
});

check('BLOCKED IS EITHER SIGNAL — the column OR the automation field', () => {
  /* The board records the same fact in two places depending on who noticed
     it. The Refinement column is the process saying "waiting"; automation
     status = Blocked is a person saying "cannot". Neither subsumes the
     other — in his store 226 open items carry the field and only 131 are
     also in Refinement — so a screen reporting one of them is right about
     half the board and quietly wrong about the other half. */
  const v = view();
  const held = new Set([...v.detected.flatMap(g => g.items), ...v.unrecorded.items]);

  assert.ok(held.has('A-1'), 'an item in Refinement is no longer counted');
  assert.ok(held.has('G-1'), 'an item marked Blocked for automation is not counted');
  assert.ok(held.has('G-3'), 'an EPIC marked Blocked for automation is not counted — 182 of his 226 are epics');
});

check('AN ITEM CARRYING BOTH SIGNALS IS COUNTED ONCE', () => {
  /* A union, not a sum. G-2 is in Refinement AND marked Blocked; counted
     twice it would inflate every figure on the page by the size of the
     overlap, which on his data is 131 items. */
  const v = view();
  const all = [...v.detected.flatMap(g => g.items), ...v.unrecorded.items];
  assert.strictEqual(all.filter(k => k === 'G-2').length, 1,
    'the double-signalled item was counted once per signal');
  assert.strictEqual(new Set(all).size, v.counts.items,
    'some item is counted twice across the two piles');
});

check('DONE WORK IS NEVER BLOCKED, whichever signal fired', () => {
  /* A finished item in a Refinement-named column is a workflow quirk, and an
     Automated suite whose automation status was never moved off Blocked is
     stale data — twelve of those are in his store right now. Counting either
     would make the figure rise as the team finished work. */
  const v = view();
  const held = new Set([...v.detected.flatMap(g => g.items), ...v.unrecorded.items]);
  assert.ok(!held.has('D-2'), 'finished work in a Refinement column was counted as blocked');
  assert.ok(!held.has('D-3'), 'a finished suite still marked Blocked for automation was counted');
});

check('AND "READY FOR AUTOMATION" IS NOT BLOCKED', () => {
  /* The adjacent value in the same field. A predicate matching anything
     truthy, or doing a substring test, would sweep in 1,127 items that are
     the opposite of blocked. */
  const v = view();
  const held = new Set([...v.detected.flatMap(g => g.items), ...v.unrecorded.items]);
  assert.ok(!held.has('D-4'), 'an item READY for automation was counted as blocked');
  assert.ok(!held.has('D-1'), 'an item in progress was counted as blocked');
  /* THE MATCH IS THE WHOLE VALUE, not a substring of it. "Unblocked"
     contains "blocked", and a loose test would count the one status that
     means the opposite. */
  assert.ok(!held.has('D-5'), '"Unblocked" was counted as blocked — the match is a substring, not the whole value');
});

check('EVERY BLOCKED ITEM IS IN EXACTLY ONE OF THE TWO PILES', () => {
  /* explained + unrecorded = items. If this ever stops holding, one of the
     three numbers in the KPI strip is describing a set that does not exist,
     and there is nothing on the page to say which. */
  const v = view();
  assert.strictEqual(v.counts.explained + v.counts.unrecorded, v.counts.items,
    `${v.counts.explained} explained + ${v.counts.unrecorded} unrecorded ≠ ${v.counts.items} blocked`);
  assert.strictEqual(v.counts.unrecorded, v.unrecorded.items.length,
    'the unrecorded count and its own key list disagree');

  const explained = new Set(v.detected.flatMap(g => g.items));
  assert.strictEqual(explained.size, v.counts.explained, 'the groups hold a different number of items than reported');
  for (const k of v.unrecorded.items) {
    assert.ok(!explained.has(k), `${k} is in both piles at once`);
  }
});

check('THE KEYS TRAVEL WITH THE COUNT — every group lists what it counted', () => {
  /* The rule this whole tool is built on. A count whose set cannot be listed
     is a number nobody can check, and the drawer behind it has to walk the
     data again — which is how two readings of the same figure diverge. */
  const v = view();
  assert.ok(v.detected.length, 'nothing was detected at all');
  for (const g of v.detected) {
    assert.strictEqual(g.count, g.items.length, `${g.key} says ${g.count} and lists ${g.items.length}`);
    assert.ok(g.items.every(Boolean), `${g.key} has a blank key in its list`);
  }
  assert.strictEqual(v.unrecorded.count, v.unrecorded.items.length);
});

check('GROUPED BY WHAT HOLDS THEM, NOT BY WHAT IS HELD', () => {
  /* 543 rows of stuck work is a list nobody reads twice; "EXT-1 is holding
     four" is one phone call. That inversion is the page's entire value. */
  const v = view();
  const ext1 = v.detected.find(g => g.key === 'EXT-1');
  assert.ok(ext1, 'EXT-1 holds four items and is not in the list');
  assert.deepStrictEqual(ext1.items.slice().sort(), ['A-1', 'A-2', 'A-3', 'B-1', 'G-2'],
    'EXT-1 is not holding the items whose epics name it');
  assert.strictEqual(ext1.count, 5);
  assert.strictEqual(ext1.points, 17, 'the points behind EXT-1 are wrong (3+3+3+5+3)');
  assert.deepStrictEqual(ext1.via.slice().sort(), ['E-1', 'E-2'], 'it does not say which epics name it');
});

check('AN ITEM HELD BY TWO TICKETS IS UNDER BOTH — chasing either is real', () => {
  /* So the group counts sum to MORE than the item count, deliberately. The
     payload reports `items` separately as the honest denominator. */
  const v = view();
  const under = v.detected.filter(g => g.items.includes('B-1')).map(g => g.key).sort();
  assert.deepStrictEqual(under, ['EXT-1', 'EXT-2'], 'an item waiting on two tickets appears under only one');

  const summed = v.detected.reduce((t, g) => t + g.count, 0);
  assert.ok(summed > v.counts.explained,
    'the fixture no longer has a double-held item, so this check proves nothing');
  assert.strictEqual(v.counts.explained, 7, 'the denominator was inflated by the double count');
});

check('BIGGEST FIRST — by how much it holds, NOT by name', () => {
  /* The order IS the advice: the top card is the call to make first. An
     alphabetical list looks identical on a fixture where the two agree, so
     `AAA-9` holds two and sorts first by name while `EXT-1` holds four. */
  const v = view();
  const counts = v.detected.map(g => g.count);
  assert.deepStrictEqual(counts, counts.slice().sort((a, b) => b - a),
    'the tickets are not ordered by how much they hold');
  assert.strictEqual(v.detected[0].key, 'EXT-1',
    'the biggest blocker is not first — the list is sorted by name');
  const names = v.detected.map(g => g.key);
  assert.notDeepStrictEqual(names, names.slice().sort(),
    'fixture check: the order is still alphabetical by accident, so this proves nothing');
});

check('SEVERITY IS DERIVED FROM HOW MUCH IS HELD, not stored', () => {
  /* Nobody grades a Jira link, and a field asking them to would be empty on
     every row. One ticket holding fifteen is not the same problem as one
     holding one, and that is the only thing here anybody can act on. */
  assert.strictEqual(blockers.severityFor(15), 'high');
  assert.strictEqual(blockers.severityFor(5), 'high');
  assert.strictEqual(blockers.severityFor(4), 'medium');
  assert.strictEqual(blockers.severityFor(2), 'medium');
  assert.strictEqual(blockers.severityFor(1), 'low');

  const v = view();
  assert.strictEqual(v.detected.find(g => g.key === 'EXT-1').severity, 'high');
  assert.strictEqual(v.detected.find(g => g.key === 'EXT-2').severity, 'low');
});

check('A BLOCKER IN AN UNSYNCED PROJECT IS NAMED, NOT LEFT BLANK', () => {
  /* Every blocker in his store is in a project this tool does not sync, so
     the summary Jira sent inside the link is the only description of it that
     will ever exist locally. Dropping it leaves the card showing a bare key
     on exactly the rows it exists to help chase. */
  const v = view();
  const ext1 = v.detected.find(g => g.key === 'EXT-1');
  assert.strictEqual(ext1.summary, 'Client schema sign-off', 'the link summary was thrown away');
  assert.strictEqual(ext1.local, false, 'a ticket not in the store was reported as local');

  const ext2 = v.detected.find(g => g.key === 'EXT-2');
  assert.strictEqual(ext2.summary, null, 'a summary was invented for a link that carried none');
});

check('THE SCOPE IS THE TEAM, AND THE SPRINT ONLY NARROWS IT', () => {
  /* Risks is sprint-scoped; this is not, and the difference is the feature.
     A blocker outlives the sprint it was noticed in, and most blocked work
     is nowhere near one. */
  const whole = view();
  const sprint = view({ sprintId: 's40' });
  assert.strictEqual(whole.scope.sprintId, null, 'the default scope is a sprint');
  assert.strictEqual(whole.scope.label, 'the whole board');
  assert.strictEqual(sprint.scope.label, 'this sprint');

  assert.strictEqual(whole.counts.items, 12);
  assert.strictEqual(sprint.counts.items, 4, 'the sprint filter did not narrow the set');
  assert.strictEqual(sprint.scope.teamTotal, 12,
    'a filtered page has to say how big the unfiltered board is, or the number reads as the whole truth');
});

check('A SPRINT WITH NO JIRA ID FILTERS TO NOTHING, not to everything', () => {
  /* The alternative — ignoring a filter the tool could not apply — puts the
     whole team's pile under a heading naming one sprint, which is the kind
     of wrong that looks exactly like being right. */
  const plan = PLAN();
  plan.sprints.push({ id: 's41', name: 'Sprint 41', byTeam: { ruby: { name: 'Sprint 41', state: 'future' } } });
  const v = blockers.blockerView(plan, board(), { teamId: 'ruby', sprintId: 's41' });
  assert.strictEqual(v.counts.items, 0, 'an unmapped sprint showed the whole board');
  assert.strictEqual(v.scope.teamTotal, 12, 'and it does not say what it is hiding');
});

check('AN UNKNOWN TEAM IS EMPTY, not everything', () => {
  const v = blockers.blockerView(PLAN(), board(), { teamId: 'nobody' });
  assert.strictEqual(v.counts.items, 0);
  assert.strictEqual(v.scope.teamName, null);
  assert.deepStrictEqual(v.detected, []);
});

check('AN ITEM IN TWO SPRINTS IS COUNTED ONCE', () => {
  /* A twice-slipped ticket appears in several sprint lists, and counting it
     twice inflates exactly the figures this page exists to report. */
  const snap = board();
  snap.issues['A-1'].sprints = [...S40, { id: '901', name: 'Sprint 41', state: 'future' }];
  snap.byTeam.ruby.sprintIssues['901'] = ['A-1'];
  const v = blockers.blockerView(PLAN(), snap, { teamId: 'ruby' });
  assert.strictEqual(v.counts.items, 12, 'a slipped item was counted in every sprint it has been in');
  assert.strictEqual(v.detected.find(g => g.key === 'EXT-1').count, 5);
});

check('THE REGISTER CLAIMS ITEMS OUT OF THE UNEXPLAINED PILE', () => {
  /* Otherwise the unexplained number never falls however much work he does,
     which is the fastest way to make a screen ignorable. It still COUNTS
     them — they are genuinely unrecorded in Jira — but says how many now
     have a human answer. */
  const bare = view();
  assert.strictEqual(bare.unrecorded.claimed, 0);

  const v = view({}, { blockers: [{ id: 'b1', title: 'Env down', items: ['C-1', 'C-2'], status: 'Open' }] });
  assert.strictEqual(v.unrecorded.count, 5, 'registering a blocker removed items from the count');
  assert.strictEqual(v.unrecorded.claimed, 2, 'the register did not claim the items it names');
});

check('THE LINKABLE LIST PUTS THE UNEXPLAINED FIRST', () => {
  /* Those are the ones the register exists to explain, so they are the ones
     at the top of the picker. */
  const v = view();
  assert.strictEqual(v.linkable.length, v.counts.items, 'the picker does not offer every blocked item');
  const firstRecorded = v.linkable.findIndex(i => i.recorded);
  const lastUnrecorded = v.linkable.map(i => i.recorded).lastIndexOf(false);
  assert.ok(firstRecorded === -1 || lastUnrecorded < firstRecorded,
    'an item whose epic already names a blocker is above one that explains nothing');
});

check('THE CATALOGUE NAMES EVERY KEY THE DRAWERS CAN SHOW', () => {
  /* Every count on the page opens into a list, and a list of bare keys is
     one somebody has to go to Jira to read. */
  const v = view();
  for (const k of [...v.detected.flatMap(g => g.items), ...v.unrecorded.items]) {
    assert.ok(v.catalogue[k], `${k} can be listed in a drawer and has no entry in the catalogue`);
    assert.ok(v.catalogue[k].summary, `${k} has no summary, so the drawer shows a bare key`);
  }
  // And the blocking tickets themselves, including the unsynced one.
  assert.ok(v.catalogue['EXT-1'], 'the blocking ticket is not in the catalogue');
  assert.strictEqual(v.catalogue['EXT-1'].summary, 'Client schema sign-off');
});

check('ONE WALK FOR "WHAT IS THIS WAITING FOR" — shared with the sprint view', () => {
  /* `epics.blockersFor` is the single definition; `workForSprint` attaches it
     to sprint rows and this page runs it over the whole board. A second walk
     is how two screens come to disagree about what a ticket is waiting on. */
  const epicsLib = require('../lib/epics');
  const snap = board();
  const lookup = (k) => snap.issues[k] || null;
  const groups = epicsLib.blockersFor(snap.issues['B-1'], lookup);
  assert.strictEqual(groups.length, 1, 'B-1 hangs off one epic');
  assert.deepStrictEqual(groups[0].blockers.map(b => b.key).sort(), ['EXT-1', 'EXT-2']);
  assert.strictEqual(groups[0].epic, 'E-2');

  // And an epic naming nothing yields nothing — never a group with an empty list.
  assert.deepStrictEqual(epicsLib.blockersFor(snap.issues['C-1'], lookup), [],
    'an epic with no blockers produced a group, so "nothing recorded" is indistinguishable from "not looked up"');
});

check('A DUPLICATE OR ODDLY-CASED LINK IS ONE BLOCKER, not two', () => {
  /* Jira hands back what people typed. `ext-1 ` and `EXT-1` are one ticket,
     and stored as two they are two cards, two counts and two people to
     chase — for one phone call.

     ASSERTED AT THE EPICS LAYER TOO. `blockerView` groups into a Map keyed by
     the blocker, which quietly hides a missing dedupe one level down: the
     Map would collapse the pair anyway if the KEYS matched. Only a check on
     `blockersFor` itself can tell "deduplicated" from "normalised by luck". */
  const epicsLib = require('../lib/epics');
  const snap = board();
  snap.issues['E-1'].blockedBy = [{ key: 'EXT-1' }, { key: 'ext-1 ' }, { key: 'EXT-1', summary: 'again' }];
  const lookup = (k) => snap.issues[k] || null;

  const groups = epicsLib.blockersFor(snap.issues['A-1'], lookup);
  const keys = groups.flatMap(g => g.blockers.map(b => b.key));
  assert.deepStrictEqual(keys, ['EXT-1'],
    `the epic's three links came back as ${JSON.stringify(keys)} instead of one normalised key`);

  const v = blockers.blockerView(PLAN(), snap, { teamId: 'ruby' });
  const before = view().detected.length;
  assert.strictEqual(v.detected.length, before,
    'the duplicated link created an extra group on the board');
  const hits = v.detected.filter(g => g.key.trim().toUpperCase() === 'EXT-1');
  assert.strictEqual(hits.length, 1, 'the same ticket appeared as two groups');
  assert.strictEqual(hits[0].count, 5, 'and it counted its items more than once');
});

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
