'use strict';
/**
 * search.test.js — the query language and the search engine.
 *
 * Two things matter most here. A query that cannot be honoured must FAIL, never
 * quietly return nothing: an empty result set that looks like a real answer is
 * the worst outcome a search box can produce. And the chip ⇄ query round trip
 * must hold, or the filter bar starts lying about what is being filtered.
 */

const assert = require('node:assert');

const Q = require('../lib/query');
const S = require('../lib/search');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
console.log('\nSearch: query language and engine\n');

/* ── a small corpus shaped like AUTOKAT ──────────────────────────────── */

const ISSUES = {
  'A-1': { key: 'A-1', summary: 'Login flow regression', issueType: 'Story', status: 'Done', statusCategory: 'done',
    assignee: 'Hien Phan', assigneeId: 'acc-hien', labels: ['TestPak'], components: ['R&D_iGO_E2E'], priority: 'High',
    resolution: 'Done', points: 5, sprintNames: ['Katalon Ruby Sprint 39'], sprints: [{ name: 'Katalon Ruby Sprint 39', state: 'active' }],
    team: 'Katalon Auto Ruby', project: 'AUTOKAT', automationStatus: 'Automated', blockedBy: [],
    created: '2026-08-01T00:00:00Z', updated: '2026-09-10T00:00:00Z', resolved: '2026-09-05T00:00:00Z' },

  'A-2': { key: 'A-2', summary: 'Maintenance: fix flaky payment suite', issueType: 'Story', status: 'In Dev', statusCategory: 'indeterminate',
    assignee: 'Thao Dang', assigneeId: 'acc-thao', labels: ['Maintenance'], components: ['PS_RES_NLG', 'TrueTest'], priority: 'Medium',
    resolution: null, points: null, sprintNames: ['Katalon Ruby Sprint 39'], sprints: [{ name: 'Katalon Ruby Sprint 39', state: 'active' }],
    team: 'Katalon Auto Ruby', project: 'AUTOKAT', automationStatus: 'Maintenance', blockedBy: ['A-1'],
    created: '2026-09-01T00:00:00Z', updated: '2026-09-11T00:00:00Z', resolved: null },

  'A-3': { key: 'A-3', summary: 'Add cases for claims screen', issueType: 'Story', status: 'Open', statusCategory: 'new',
    assignee: null, assigneeId: null, labels: [], components: ['PS_iGO_NLG'], priority: 'Low',
    resolution: null, points: 3, sprintNames: [], sprints: [],
    team: 'Katalon Auto Titan', project: 'AUTOKAT', automationStatus: 'Ready for Automation', blockedBy: [],
    created: '2026-07-01T00:00:00Z', updated: '2026-07-02T00:00:00Z', resolved: null },

  'A-4': { key: 'A-4', summary: 'Suite times out on CI', issueType: 'Defect', status: 'Open', statusCategory: 'new',
    assignee: 'Hien Phan', assigneeId: 'acc-hien', labels: ['obsolete'], components: ['Katalon'], priority: 'Highest',
    resolution: null, points: 0, sprintNames: ['TT Week 31Aug'], sprints: [{ name: 'TT Week 31Aug', state: 'active' }],
    team: 'Katalon Auto Malphite', project: 'AUTOKAT', automationStatus: null, blockedBy: ['A-2'],
    created: '2026-09-09T00:00:00Z', updated: '2026-09-09T00:00:00Z', resolved: null },

  'A-5': { key: 'A-5', summary: 'Tech: upgrade the runner', issueType: 'Bucket Story', status: 'Done', statusCategory: 'done',
    assignee: 'Thao Dang', assigneeId: 'acc-thao', labels: [], components: ['KAT_Framework_Optimization'], priority: 'Medium',
    resolution: 'Fixed', points: 8, sprintNames: ['Katalon Ruby Sprint 38'], sprints: [{ name: 'Katalon Ruby Sprint 38', state: 'closed' }],
    team: 'Katalon Auto Ruby', project: 'AUTOKAT', automationStatus: 'N/A for Automation', blockedBy: [],
    created: '2026-06-01T00:00:00Z', updated: '2026-08-20T00:00:00Z', resolved: '2026-08-19T00:00:00Z' },
};

const SNAP = { issues: ISSUES };
const PLAN = { categoryRules: null };
const NOW = Date.parse('2026-09-11T12:00:00Z');
const run = (q, opts = {}) => S.search(SNAP, PLAN, q, { now: NOW, ...opts });
const keys = (q, opts) => run(q, opts).rows.map(r => r.key).sort();

/* ── the parser ──────────────────────────────────────────────────────── */

check('an empty query matches everything', () => {
  assert.strictEqual(run('').total, 5);
  assert.strictEqual(run('   ').total, 5);
});

check('a simple equality clause', () => {
  assert.deepStrictEqual(keys('status = Done'), ['A-1', 'A-5']);
});

check('values are matched case-insensitively', () => {
  assert.deepStrictEqual(keys('status = done'), ['A-1', 'A-5']);
  assert.deepStrictEqual(keys('STATUS = DONE'), ['A-1', 'A-5'], 'field names too');
});

check('a quoted value keeps its spaces', () => {
  assert.deepStrictEqual(keys('assignee = "Hien Phan"'), ['A-1', 'A-4']);
});

check('AND narrows, OR widens', () => {
  assert.deepStrictEqual(keys('status = Open AND priority = Highest'), ['A-4']);
  assert.deepStrictEqual(keys('priority = Highest OR priority = High'), ['A-1', 'A-4']);
});

check('parentheses control precedence', () => {
  // Without the parens this would be (a AND b) OR c and pick up A-5 as well.
  assert.deepStrictEqual(
    keys('team = "Katalon Auto Ruby" AND (status = Done OR status = "In Dev") AND type = Story'),
    ['A-1', 'A-2']);
});

check('IN is OR within one field', () => {
  assert.deepStrictEqual(keys('type IN (Defect, "Bucket Story")'), ['A-4', 'A-5']);
});

check('NOT IN and != exclude', () => {
  assert.deepStrictEqual(keys('type NOT IN (Story)'), ['A-4', 'A-5']);
  assert.deepStrictEqual(keys('assignee != "Hien Phan"'), ['A-2', 'A-3', 'A-5'],
    'an unassigned issue is not assigned to Hien either');
});

check('~ matches substrings, !~ excludes them', () => {
  assert.deepStrictEqual(keys('summary ~ suite'), ['A-2', 'A-4']);
  assert.deepStrictEqual(keys('summary !~ suite'), ['A-1', 'A-3', 'A-5']);
});

check('text searches key and summary together', () => {
  assert.deepStrictEqual(keys('text ~ "A-3"'), ['A-3']);
  assert.deepStrictEqual(keys('text ~ login'), ['A-1']);
});

check('IS EMPTY and IS NOT EMPTY', () => {
  assert.deepStrictEqual(keys('sprint IS EMPTY'), ['A-3']);
  assert.deepStrictEqual(keys('assignee IS EMPTY'), ['A-3']);
  assert.deepStrictEqual(keys('resolution IS NOT EMPTY'), ['A-1', 'A-5']);
});

check('= EMPTY is accepted, the way Jira writes it', () => {
  assert.deepStrictEqual(keys('assignee = EMPTY'), ['A-3']);
  assert.deepStrictEqual(keys('assignee != EMPTY'), ['A-1', 'A-2', 'A-4', 'A-5']);
});

check('numbers compare as numbers, not strings', () => {
  assert.deepStrictEqual(keys('points >= 5'), ['A-1', 'A-5']);
  assert.deepStrictEqual(keys('points < 5'), ['A-3', 'A-4'], '10 must not sort before 5 as a string would');
});

check('a null estimate is not zero', () => {
  // A-2 has points: null; A-4 has points: 0. They are different things.
  assert.deepStrictEqual(keys('points IS EMPTY'), ['A-2']);
  assert.deepStrictEqual(keys('points = 0'), ['A-4']);
});

check('dates accept ISO and relative offsets', () => {
  assert.deepStrictEqual(keys('updated >= 2026-09-10'), ['A-1', 'A-2']);
  assert.deepStrictEqual(keys('updated >= -3d'), ['A-1', 'A-2', 'A-4'], '-3d from 11 Sep reaches 8 Sep');
  assert.deepStrictEqual(keys('created < 2026-08-01'), ['A-3', 'A-5']);
});

check('a bare date means the WHOLE day, so < and <= differ', () => {
  // A-1 was created at 2026-08-01T00:00:00Z, exactly on the boundary.
  assert.deepStrictEqual(keys('created < 2026-08-01'), ['A-3', 'A-5'], 'before the 1st excludes the 1st');
  assert.deepStrictEqual(keys('created <= 2026-08-01'), ['A-1', 'A-3', 'A-5'], 'up to the 1st includes all of it');
  assert.deepStrictEqual(keys('created = 2026-08-01'), ['A-1'], 'anything that day');
  assert.deepStrictEqual(keys('created > 2026-08-01'), ['A-2', 'A-4'], 'after the 1st excludes the 1st');
});

check('ORDER BY sorts, and DESC reverses', () => {
  assert.deepStrictEqual(run('ORDER BY points').rows.map(r => r.key), ['A-4', 'A-3', 'A-1', 'A-5', 'A-2'],
    'unestimated sorts last, not first');
  assert.deepStrictEqual(run('points IS NOT EMPTY ORDER BY points DESC').rows.map(r => r.key), ['A-5', 'A-1', 'A-3', 'A-4']);
});

check('the default order is most recently updated', () => {
  assert.strictEqual(run('').rows[0].key, 'A-2', 'the thing that changed last is what you came to see');
});

/* ── list fields ─────────────────────────────────────────────────────── */

check('a list field matches if ANY value matches', () => {
  assert.deepStrictEqual(keys('component = TrueTest'), ['A-2']);
  assert.deepStrictEqual(keys('label = TestPak'), ['A-1']);
});

check('!= on a list field means "none of them match"', () => {
  assert.deepStrictEqual(keys('component != TrueTest'), ['A-1', 'A-3', 'A-4', 'A-5'],
    'A-2 has TrueTest among its components, so it is excluded');
});

/* ── computed fields ─────────────────────────────────────────────────── */

check('blocked is a real filter even though Jira has no such field', () => {
  assert.deepStrictEqual(keys('blocked = true'), ['A-2', 'A-4']);
  assert.deepStrictEqual(keys('blocked = false'), ['A-1', 'A-3', 'A-5']);
});

check('estimated means a usable estimate, so 0 does not count', () => {
  assert.deepStrictEqual(keys('estimated = false'), ['A-2', 'A-4'],
    'a null estimate and a zero estimate are both unplannable');
});

check('sprint state filters on the sprint, not the issue', () => {
  assert.deepStrictEqual(keys('sprintState = closed'), ['A-5']);
  assert.deepStrictEqual(keys('sprintState = active'), ['A-1', 'A-2', 'A-4']);
});

check('work category is derived from the categorisation rules', () => {
  assert.deepStrictEqual(keys('category = maintenance'), ['A-2']);
  assert.deepStrictEqual(keys('category = technical'), ['A-5']);
});

/* ── errors are loud ─────────────────────────────────────────────────── */

check('AN UNKNOWN FIELD IS AN ERROR, not an empty result', () => {
  const r = run('banana = 3');
  assert.ok(r.error, 'silently matching nothing is the worst thing a search box can do');
  assert.match(r.error, /Unknown field "banana"/);
  assert.match(r.error, /Known fields/, 'and it should say what IS allowed');
});

check('bad syntax reports a position', () => {
  const r = run('status = ');
  assert.ok(r.error);
  assert.strictEqual(typeof r.at, 'number', 'so the UI can point at the character');
});

check('an unclosed quote is caught', () => {
  assert.match(run('summary ~ "unfinished').error, /Unclosed quote/);
});

check('an unclosed parenthesis is caught', () => {
  assert.match(run('(status = Done').error, /parenthesis/i);
});

check('two clauses with no operator between them is an error', () => {
  assert.match(run('status = Done priority = High').error, /AND or OR/);
});

check('a non-numeric value for a numeric field is an error', () => {
  assert.match(run('points > banana').error, /not a number/);
});

check('a malformed date is an error that says the accepted formats', () => {
  const r = run('created > lastweek');
  assert.match(r.error, /not a date/);
  assert.match(r.error, /-14d/, 'the error should teach the syntax');
});

check('an error returns no rows rather than all of them', () => {
  const r = run('banana = 3');
  assert.strictEqual(r.total, 0, 'failing open would silently show everything as if it matched');
  assert.deepStrictEqual(r.rows, []);
});

/* ── round trip: chips ⇄ query ───────────────────────────────────────── */

check('chips compile to a query', () => {
  const q = Q.fromChips({ status: ['Done'], type: ['Story', 'Defect'] }, 'login');
  assert.match(q, /status = Done/);
  assert.match(q, /type IN \(Story, Defect\)/);
  assert.match(q, /text ~ login/);
});

check('a compiled query parses back into the same chips', () => {
  const chips = { status: ['Done'], type: ['Story', 'Defect'], assignee: ['Hien Phan'] };
  const q = Q.fromChips(chips, 'login');
  const back = Q.toChips(q);
  assert.deepStrictEqual(back.chips.status, ['Done']);
  assert.deepStrictEqual(back.chips.type, ['Story', 'Defect']);
  assert.deepStrictEqual(back.chips.assignee, ['Hien Phan'], 'a value with a space must survive the trip');
  assert.strictEqual(back.text, 'login');
  assert.deepStrictEqual(back.unrepresentable, []);
});

check('stringify(parse(q)) is stable', () => {
  for (const q of [
    'status = Done',
    'type IN (Story, Defect) AND assignee = "Hien Phan"',
    'sprint IS EMPTY',
    'points >= 3 ORDER BY points DESC',
    'summary ~ "flaky suite"',
  ]) {
    const once = Q.stringify(Q.parse(q));
    const twice = Q.stringify(Q.parse(once));
    assert.strictEqual(twice, once, `not stable for: ${q}`);
  }
});

check('a query the chips cannot express says so instead of lying', () => {
  const back = Q.toChips('status = Done OR priority = High');
  assert.ok(back.unrepresentable.length, 'cross-field OR has no chip representation');
  assert.deepStrictEqual(back.chips, {}, 'and it must not be silently dropped into chips');
});

check('a range clause is reported as unrepresentable too', () => {
  const back = Q.toChips('points >= 5');
  assert.ok(back.unrepresentable.length);
});

check('quoting survives values containing quotes and backslashes', () => {
  const q = Q.fromChips({ summary: ['say "hi"'] });
  assert.deepStrictEqual(Q.toChips(q).chips.summary, ['say "hi"']);
});

check('a value that collides with a keyword is quoted', () => {
  const q = Q.fromChips({ status: ['In'] });
  assert.match(q, /"In"/, 'an unquoted IN would be parsed as an operator');
  assert.deepStrictEqual(Q.toChips(q).chips.status, ['In']);
});

/* ── facets ──────────────────────────────────────────────────────────── */

check('facets count values under the current filter', () => {
  const r = run('team = "Katalon Auto Ruby"');
  const types = Object.fromEntries(r.facets.type.map(f => [f.value, f.count]));
  assert.deepStrictEqual(types, { Story: 2, 'Bucket Story': 1 }, 'Titan and Malphite work is filtered out');
});

check("a facet ignores its OWN field's clauses, so you can widen a filter", () => {
  const r = run('type = Story');
  const types = Object.fromEntries(r.facets.type.map(f => [f.value, f.count]));
  assert.strictEqual(types.Defect, 1,
    'if picking Story hid every other type, the dropdown could only ever narrow');
  assert.strictEqual(types.Story, 3);
});

check('a facet DOES respect the other fields', () => {
  const r = run('team = "Katalon Auto Ruby" AND type = Story');
  const types = Object.fromEntries(r.facets.type.map(f => [f.value, f.count]));
  assert.strictEqual(types.Defect, undefined, 'the only Defect belongs to Malphite');
  assert.strictEqual(types['Bucket Story'], 1);
});

check('missing values get their own bucket rather than vanishing', () => {
  const r = run('');
  const assignees = Object.fromEntries(r.facets.assignee.map(f => [f.value, f.count]));
  assert.strictEqual(assignees.__EMPTY__, 1, 'unassigned work is the thing you most need to find');
});

check('facets list every value of a multi-valued field', () => {
  const r = run('');
  const comps = Object.fromEntries(r.facets.component.map(f => [f.value, f.count]));
  assert.strictEqual(comps.TrueTest, 1);
  assert.strictEqual(comps.PS_RES_NLG, 1, 'A-2 carries both and must count in each');
});

/* ── totals and paging ───────────────────────────────────────────────── */

check('totals cover the whole match, not the page', () => {
  const r = run('', { pageSize: 2 });
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.total, 5);
  assert.strictEqual(r.pages, 3);
  assert.strictEqual(r.points, 16, 'a per-page sum would answer nothing');
  assert.strictEqual(r.unestimated, 2);
});

check('an out-of-range page clamps instead of returning nothing', () => {
  const r = run('', { pageSize: 2, page: 99 });
  assert.strictEqual(r.page, 3);
  assert.ok(r.rows.length > 0);
});

check('sort can be overridden by the column header', () => {
  const r = run('', { sort: 'key', dir: 'asc' });
  assert.deepStrictEqual(r.rows.map(x => x.key), ['A-1', 'A-2', 'A-3', 'A-4', 'A-5']);
});

check('searchAll returns every match for export, not one page', () => {
  const r = S.searchAll(SNAP, PLAN, '', { now: NOW, pageSize: 2 });
  assert.strictEqual(r.rows.length, 5);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
