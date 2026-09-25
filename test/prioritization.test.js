'use strict';
/**
 * prioritization.test.js — the shortlist, its numbers, and his note.
 *
 * WHAT THIS SUITE IS PROTECTING
 *
 * Three guarantees, and each one has an obvious implementation that breaks it:
 *
 *   1. THE ROW SET IS THE DECISION. A component appears because it has a
 *      priority — so a P1 suite with no epics still gets a row. The natural
 *      way to write this page is to tally epics and read priorities off the
 *      result, and that drops exactly the row worth looking at.
 *
 *   2. THE NUMBERS ARE THE COVERAGE SCREEN'S NUMBERS. Same exclusions, same
 *      team allow-list, same buckets. Two pages disagreeing about one
 *      component makes both unusable and neither looks wrong.
 *
 *   3. A BLANK NOTE IS NOT A NOTE. Clearing one deletes the key; otherwise
 *      the map grows an entry for every component ever clicked and "has a
 *      note" means two things.
 *
 * Run: node test/prioritization.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pz = require('../lib/prioritization');
const coverage = require('../lib/coverage');
const notes = require('../lib/component-note');
const priority = require('../lib/priority');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nThe Prioritization shortlist\n');

/* ── a project shaped like his ────────────────────────────────────────────
   PS_iGO_NLG runs on both tools. PS_iGO_Columbus has epics but no priority.
   PS_RES_NLG is ranked and has nothing against it at all. KAT_Engineering is
   ranked AND excluded, which is the contradiction the page has to surface. */

const epic = (key, o = {}) => ({
  key, issueType: 'Epic', summary: o.summary || `Epic ${key}`,
  components: o.components || [], automationStatus: o.automationStatus || '',
  labels: o.labels || [], team: o.team || 'Katalon PS Squad', status: 'Open',
});

const SNAP = {
  issues: Object.fromEntries([
    epic('A-1', { components: ['PS_iGO_NLG', 'TrueTest'], automationStatus: 'Automated' }),
    epic('A-2', { components: ['PS_iGO_NLG', 'TrueTest'], automationStatus: 'Maintenance' }),
    epic('A-3', { components: ['PS_iGO_NLG'], automationStatus: 'Ready for Automation' }),
    epic('A-4', { components: ['PS_iGO_NLG'], automationStatus: 'Blocked' }),
    epic('A-5', { components: ['PS_iGO_Lincoln'], automationStatus: 'Automated' }),
    epic('A-6', { components: ['PS_iGO_Lincoln'], automationStatus: '', labels: ['Obsoleted'] }),
    epic('A-7', { components: ['PS_iGO_Columbus'], automationStatus: 'Automated' }),   // no priority
    epic('A-8', { components: ['KAT_Engineering'], automationStatus: 'N/A for Automation' }),
    // Another squad's epic on a ranked component — the team allow-list cut.
    epic('A-9', { components: ['PS_iGO_Lincoln'], automationStatus: 'Automated', team: 'Katalon RDA (Ruby)' }),
    // Not an Epic: the scope cut. It must not reach any number on the page.
    { key: 'A-10', issueType: 'Story', components: ['PS_iGO_NLG'], automationStatus: 'Automated', team: 'Katalon PS Squad' },
  ].map(i => [i.key, i])),
};

const PLAN = () => ({
  componentPriority: {
    PS_iGO_NLG: 1,
    PS_RES_NLG: 1,          // ranked, nothing against it
    PS_iGO_Lincoln: 2,
    KAT_Engineering: 3,     // ranked AND excluded — the contradiction
  },
  componentNote: { PS_RES_NLG: 'waiting on the migration' },
  excludedComponents: ['KAT_Engineering'],
  coverageTeams: [],
});

const rowFor = (v, component) => v.rows.find(r => r.component === component);

/* ── 1. the row set ───────────────────────────────────────────────────── */

check('A RANKED COMPONENT WITH NO EPICS STILL GETS A ROW', () => {
  /* The failure this whole file exists for. Tally the epics, read the
     priorities off the result, and PS_RES_NLG — a P1 with nothing written
     against it — is silently not on the page at all. */
  const v = pz.view(SNAP, PLAN());
  const r = rowFor(v, 'PS_RES_NLG');
  assert.ok(r, 'a ranked component with no epics vanished from the shortlist');
  assert.strictEqual(r.tracked, false, 'it should be marked as carrying nothing');
  assert.strictEqual(r.truetest.total, 0);
  assert.strictEqual(r.kse.total, 0);
  assert.deepStrictEqual(v.untracked, ['PS_RES_NLG'], 'the page has to be able to name it');
});

check('and its blank row has the SAME SHAPE as a populated one', () => {
  /* Otherwise the empty rows render subtly differently from the rest — a
     missing coveragePct is an empty cell, not an error, and nothing says so. */
  const v = pz.view(SNAP, PLAN());
  const real = rowFor(v, 'PS_iGO_NLG');
  const empty = rowFor(v, 'PS_RES_NLG');
  assert.deepStrictEqual(Object.keys(empty).sort(), Object.keys(real).sort(),
    'the empty row is a different shape from a populated one');
  for (const t of ['truetest', 'kse']) {
    assert.deepStrictEqual(Object.keys(empty[t]).sort(), Object.keys(real[t]).sort(),
      `the empty ${t} block is a different shape`);
  }
});

check('A COMPONENT WITH EPICS AND NO PRIORITY IS NOT ON THE LIST', () => {
  // This page is the shortlist. A shortlist that quietly includes everything
  // is a list, and the Coverage screen is already that.
  const v = pz.view(SNAP, PLAN());
  assert.ok(!rowFor(v, 'PS_iGO_Columbus'), 'an unranked component appeared on the shortlist');
  assert.ok(rowFor(v, 'PS_iGO_NLG'), 'fixture check: ranked components do appear');
});

check('a priority this tool cannot read is not a row', () => {
  /* It would render with an empty Priority cell — and the priority is the
     reason the row exists, so a row without one is a contradiction on screen. */
  const plan = PLAN();
  plan.componentPriority.PS_Garbage = 9;
  plan.componentPriority.PS_Blank = null;
  const v = pz.view(SNAP, plan);
  assert.ok(!rowFor(v, 'PS_Garbage'), 'an unreadable level became a row');
  assert.ok(!rowFor(v, 'PS_Blank'), 'a cleared level became a row');
  assert.ok(v.rows.every(r => r.priority != null), 'a row reached the page with no priority');
});

check('P1 FIRST, then by name — the order the sheet is already in', () => {
  const plan = PLAN();
  plan.componentPriority.PS_AAA = 1;     // sorts before PS_iGO_NLG at the same level
  const v = pz.view(SNAP, plan);
  /* `localeCompare`, the same comparator the coverage tables sort by — so
     PS_iGO_NLG comes before PS_RES_NLG, because a locale compare folds case
     rather than sorting every capital ahead of every lowercase letter. That
     is the human order and the one the rest of the app already uses; a plain
     `<` here would put the two lists in different orders on two screens. */
  assert.deepStrictEqual(
    v.rows.map(r => [r.priorityLabel, r.component]),
    [['P1', 'PS_AAA'], ['P1', 'PS_iGO_NLG'], ['P1', 'PS_RES_NLG'], ['P2', 'PS_iGO_Lincoln']],
    'the shortlist is not in priority-then-name order');
});

/* ── 2. the numbers, and the scope they were taken at ─────────────────── */

check('THE BUCKETS ARE THE COVERAGE SCREEN\'S SEVEN, per tool', () => {
  const v = pz.view(SNAP, PLAN());
  const r = rowFor(v, 'PS_iGO_NLG');
  assert.deepStrictEqual(v.buckets.map(b => b.key),
    ['automated', 'maintenance', 'ready', 'blocked', 'na', 'obsoleted', 'none'],
    'the column set has drifted from lib/coverage.js');
  // A-1 and A-2 carry TrueTest; A-3 and A-4 do not, so they are KSE.
  assert.strictEqual(r.truetest.automated, 1);
  assert.strictEqual(r.truetest.maintenance, 1);
  assert.strictEqual(r.kse.ready, 1);
  assert.strictEqual(r.kse.blocked, 1);
  assert.strictEqual(r.total, 4, 'the row total should be every epic on the component');
});

check('AND THEY ARE THE SAME NUMBERS THE COVERAGE SCREEN SHOWS', () => {
  /* Guarantee 2, checked against the other reader rather than against a
     hand-written expectation: a shared bug would pass a hand-written one. */
  const plan = PLAN();
  const cov = coverage.view(SNAP, {
    scope: 'Epic', exclude: plan.excludedComponents, teams: plan.coverageTeams,
  });
  const v = pz.view(SNAP, plan);
  for (const r of v.rows.filter(x => x.tracked)) {
    const mirror = cov.byTool.find(x => x.component === r.component);
    assert.ok(mirror, `${r.component} is on the shortlist and not in the coverage view`);
    for (const t of ['truetest', 'kse']) {
      for (const b of v.buckets) {
        assert.strictEqual(r[t][b.key], mirror[t][b.key],
          `${r.component} ${t}/${b.key}: shortlist says ${r[t][b.key]}, Coverage says ${mirror[t][b.key]}`);
      }
    }
  }
});

check('THE SCOPE CUTS APPLY — issue type, exclusions and the team allow-list', () => {
  const v = pz.view(SNAP, PLAN());
  // A-10 is a Story on PS_iGO_NLG. If the scope cut were dropped it would
  // land in truetest/kse Automated and the row would total 5.
  assert.strictEqual(rowFor(v, 'PS_iGO_NLG').total, 4, 'a non-Epic reached the numbers');

  // KAT_Engineering is ranked AND excluded. The exclusion wins, and it is said.
  assert.ok(!rowFor(v, 'KAT_Engineering'), 'an excluded component was counted anyway');
  assert.deepStrictEqual(v.excluded, ['KAT_Engineering'],
    'an excluded-but-ranked component was dropped silently — he cannot resolve what he cannot see');

  // With the allow-list on, the other squad's epic leaves the count.
  const scoped = pz.view(SNAP, { ...PLAN(), coverageTeams: ['Katalon PS Squad'] });
  assert.strictEqual(rowFor(v, 'PS_iGO_Lincoln').kse.automated, 2, 'fixture check: both squads counted by default');
  assert.strictEqual(rowFor(scoped, 'PS_iGO_Lincoln').kse.automated, 1,
    'the team allow-list did not reach this page');
});

check('THE TOTALS ARE THE ROWS ON SCREEN, not the whole portfolio', () => {
  /* The line a reader quotes in a status update. Totalling the coverage
     view's own tool totals would put 125 components' worth of epics under a
     table showing four, with every individual figure above it correct. */
  const v = pz.view(SNAP, PLAN());
  const sum = (tool, bucket) => v.rows.reduce((n, r) => n + r[tool][bucket], 0);
  for (const t of ['truetest', 'kse']) {
    for (const b of v.buckets) {
      assert.strictEqual(v.totals[t][b.key], sum(t, b.key), `the ${t}/${b.key} total does not match its column`);
    }
  }
  assert.strictEqual(v.totals.components, v.rows.length);
  // PS_iGO_Columbus and KAT_Engineering are both out, so their epics must not be in.
  assert.strictEqual(v.totals.total, 7, 'the totals counted epics from components not on the page');
});

check('byLevel counts what is actually on the page', () => {
  const v = pz.view(SNAP, PLAN());
  for (const l of v.byLevel) {
    assert.strictEqual(l.count, v.rows.filter(r => r.priority === l.value).length,
      `the ${l.label} chip disagrees with the rows behind it`);
  }
  assert.strictEqual(v.byLevel.find(l => l.label === 'P3').count, 0,
    'the excluded P3 was counted in the chip it no longer has a row in');
});

/* ── 2b. the team filter ─────────────────────────────────────────────── */

const TEAMS = [
  { id: 'ruby', name: 'Katalon Ruby', jiraTeams: ['Katalon Auto Ruby', 'Katalon RDA (Ruby)'] },
  { id: 'ps', name: 'Katalon Squad PS Auto', jiraTeams: ['Katalon PS Squad'] },
  { id: 'nomap', name: 'Unmapped Team', jiraTeams: [] },
];
const TEAM_PLAN = () => ({ ...PLAN(), teams: TEAMS });
const teamBy = (id) => TEAMS.find(t => t.id === id);

check('A TEAM NARROWS THE LIST BY THE TEAM FIELD ON THE EPICS', () => {
  /* His ask, and the whole point of the filter: picking a team answers "what
     is MY team carrying", which is a question about the Team field on each
     epic inside a component — not about the component's name. */
  const plan = TEAM_PLAN();
  const all = pz.view(SNAP, plan);
  const ruby = pz.view(SNAP, plan, { team: teamBy('ruby') });

  // A-9 is the only Ruby-team epic in the fixture, on PS_iGO_Lincoln.
  assert.deepStrictEqual(ruby.rows.map(r => r.component), ['PS_iGO_Lincoln'],
    'the team filter did not narrow to that team\'s work');
  assert.strictEqual(ruby.rows[0].kse.automated, 1, 'it should count only that team\'s epic');
  assert.ok(all.rows.length > ruby.rows.length, 'fixture check: the portfolio is wider');

  assert.deepStrictEqual(ruby.team.jiraTeams, teamBy('ruby').jiraTeams,
    'the page cannot name the Team field values it filtered on');
  assert.strictEqual(all.team, null, 'no team selected should mean no team on the payload');
});

check('AND WHAT IT DROPPED IS COUNTED, not silently gone', () => {
  const ruby = pz.view(SNAP, TEAM_PLAN(), { team: teamBy('ruby') });
  // PS_iGO_NLG, PS_RES_NLG are ranked and have nothing of Ruby's.
  assert.ok(ruby.elsewhere.includes('PS_iGO_NLG'), 'a dropped component was not reported');
  assert.ok(ruby.elsewhere.includes('PS_RES_NLG'), 'the epic-less component was not reported either');
  assert.ok(!ruby.elsewhere.includes('KAT_Engineering'), 'an excluded component was reported as a team miss');
  // `localeCompare`, the same comparator the rows sort by — not a plain sort,
  // which orders every capital ahead of every lowercase letter.
  assert.deepStrictEqual(ruby.elsewhere, [...ruby.elsewhere].sort((a, b) => a.localeCompare(b)),
    'the list should be ordered');
  assert.deepStrictEqual(pz.view(SNAP, TEAM_PLAN()).elsewhere, [],
    'with no team selected there is no "elsewhere" to be in');
});

check('AN EPIC-LESS COMPONENT BELONGS TO NO TEAM, so it shows on All teams only', () => {
  /* The two rules pull opposite ways and both are deliberate. On the
     portfolio view a ranked P1 with no epics is the most interesting row
     there is; under a team it belongs to nobody, and putting it on all seven
     teams' pages would make it mean nothing on any of them. */
  const plan = TEAM_PLAN();
  assert.ok(pz.view(SNAP, plan).rows.some(r => r.component === 'PS_RES_NLG'),
    'the epic-less row vanished from the portfolio view');
  assert.ok(!pz.view(SNAP, plan, { team: teamBy('ruby') }).rows.some(r => r.component === 'PS_RES_NLG'),
    'an epic-less component was claimed by a team that has nothing in it');
});

check('A TEAM WITH NO JIRA TEAM VALUES COUNTS NOTHING — it does not count EVERYTHING', () => {
  /* The failure mode this guard exists for. `coverage.scoped` reads an empty
     allow-list as "no allow-list, count everyone", so a team with nothing
     mapped would quietly render the entire portfolio as its own work — and
     the page would look completely normal doing it. */
  const v = pz.view(SNAP, TEAM_PLAN(), { team: teamBy('nomap') });
  assert.strictEqual(v.rows.length, 0, 'an unmapped team was shown the whole portfolio as its own');
  assert.strictEqual(v.totals.total, 0, 'and the totals counted it too');
  assert.strictEqual(v.team.empty, true);
  assert.strictEqual(v.team.reason, 'no-jira-teams', 'the page cannot say which fix this needs');
});

check('and so does a team whose values are all outside the coverage allow-list', () => {
  /* Same empty result, a DIFFERENT fix — widen the allow-list rather than map
     the team — so the two are reported as two reasons, not one blank page. */
  const plan = { ...TEAM_PLAN(), coverageTeams: ['Katalon PSA (Titan)'] };
  const v = pz.view(SNAP, plan, { team: teamBy('ruby') });
  assert.strictEqual(v.rows.length, 0, 'the global allow-list was ignored once a team was picked');
  assert.strictEqual(v.team.reason, 'outside-allow-list');

  // And when they DO overlap, the intersection is what counts.
  const both = { ...TEAM_PLAN(), coverageTeams: ['Katalon RDA (Ruby)', 'Katalon PS Squad'] };
  const v2 = pz.view(SNAP, both, { team: teamBy('ruby') });
  assert.deepStrictEqual(v2.team.jiraTeams, ['Katalon RDA (Ruby)'],
    'the allow-list and the team should intersect, not replace each other');
  assert.deepStrictEqual(v2.rows.map(r => r.component), ['PS_iGO_Lincoln']);
});

check('THE TOTALS AND THE CHIPS FOLLOW THE TEAM TOO', () => {
  const ruby = pz.view(SNAP, TEAM_PLAN(), { team: teamBy('ruby') });
  const sum = (t, b) => ruby.rows.reduce((n, r) => n + r[t][b], 0);
  for (const t of ['truetest', 'kse']) {
    for (const b of ruby.buckets) assert.strictEqual(ruby.totals[t][b.key], sum(t, b.key));
  }
  for (const l of ruby.byLevel) {
    assert.strictEqual(l.count, ruby.rows.filter(r => r.priority === l.value).length,
      `the ${l.label} chip counts rows the team filter removed`);
  }
});

/* ── 3. the note ─────────────────────────────────────────────────────── */

check('A BLANK NOTE DELETES THE KEY — it does not store an empty string', () => {
  let map = notes.set({}, 'PS_iGO_NLG', 'hold until Q3');
  assert.deepStrictEqual(map, { PS_iGO_NLG: 'hold until Q3' });
  map = notes.set(map, 'PS_iGO_NLG', '');
  assert.deepStrictEqual(map, {}, 'clearing a note left a key behind');
  assert.deepStrictEqual(notes.set(map, 'PS_X', '   '), {}, 'whitespace was stored as a note');
  assert.deepStrictEqual(notes.set(map, 'PS_X', null), {}, 'null was stored as a note');
});

check('the note is trimmed, and one too long is REFUSED rather than cut', () => {
  /* Silently keeping the first 600 characters loses the end of a sentence and
     looks, on screen, exactly like a note that was always short. */
  assert.deepStrictEqual(notes.set({}, ' PS_X ', '  spaced  '), { PS_X: 'spaced' });

  const long = 'x'.repeat(notes.MAX + 1);
  const { map, errors } = notes.validate({ PS_X: long });
  assert.strictEqual(errors.length, 1, 'an over-long note was accepted');
  assert.ok(!('PS_X' in map), 'an over-long note was stored anyway');
  assert.match(errors[0].message, new RegExp(String(notes.MAX)), 'the error should say what the limit is');

  const ok = notes.validate({ PS_X: 'x'.repeat(notes.MAX) });
  assert.strictEqual(ok.errors.length, 0, 'a note exactly at the limit was refused');
});

check('a note that is not text is refused, not coerced', () => {
  const { map, errors } = notes.validate({ PS_X: { hello: 1 }, PS_Y: 'fine' });
  assert.strictEqual(errors.length, 1);
  assert.deepStrictEqual(map, { PS_Y: 'fine' }, 'an object became the string "[object Object]"');
  assert.strictEqual(notes.validate([]).errors.length, 1, 'a list was accepted as a note map');
});

check('a whitespace note READS as no note, however it got into the plan', () => {
  /* `set` and `validate` both strip, so this cannot arrive through the UI —
     it arrives through a hand-edited plan.json or a restored backup, which
     are supported paths. Without the guard in `of`, the row comes back with a
     note of "   ": the textarea looks filled, `data-was` holds the spaces, and
     the component reads as annotated when nobody has annotated it. */
  assert.strictEqual(notes.of({ componentNote: { PS_X: '   ' } }, 'PS_X'), null,
    'whitespace came back as a real note');
  assert.strictEqual(notes.of({ componentNote: { PS_X: '' } }, 'PS_X'), null);
  assert.strictEqual(notes.of({ componentNote: { PS_X: 42 } }, 'PS_X'), null, 'a number came back as a note');
  assert.strictEqual(notes.of({}, 'PS_X'), null);
  assert.strictEqual(notes.of(null, 'PS_X'), null, 'reading a note off no plan at all should be null, not a throw');

  const plan = PLAN();
  plan.componentNote = { PS_RES_NLG: '  \n ' };
  assert.strictEqual(rowFor(pz.view(SNAP, plan), 'PS_RES_NLG').note, null,
    'a whitespace note reached the row');
});

check('THE NOTE REACHES THE ROW, including on a component with no epics', () => {
  const v = pz.view(SNAP, PLAN());
  assert.strictEqual(rowFor(v, 'PS_RES_NLG').note, 'waiting on the migration',
    'the note on an epic-less component was lost');
  assert.strictEqual(rowFor(v, 'PS_iGO_NLG').note, null, 'a component with no note should carry null');
});

check('notes and priorities are separate maps — editing one cannot touch the other', () => {
  const plan = PLAN();
  const before = JSON.stringify(plan.componentPriority);
  plan.componentNote = notes.set(plan.componentNote, 'PS_iGO_NLG', 'a note');
  assert.strictEqual(JSON.stringify(plan.componentPriority), before);
  const p = priority.set(plan.componentPriority, 'PS_iGO_NLG', null);
  assert.ok(!('PS_iGO_NLG' in p), 'fixture check: clearing a priority deletes its key');
  assert.strictEqual(plan.componentNote.PS_iGO_NLG, 'a note',
    'clearing a priority took the note with it');
});

/* ── 4. the plan round-trip ───────────────────────────────────────────── */

check('A NOTE SURVIVES THE PLAN ROUND-TRIP — a sync must never eat it', () => {
  /* componentNote is plan data, like the priority beside it. If it is missing
     from the settings list in import-json.js it writes fine, reads back empty,
     and the column is blank the next time the app starts. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'import-json.js'), 'utf8');
  // Anchored on a key that is certainly in THIS list: import-json.js has more
  // than one `for (const key of [...])`, and an unanchored match read the
  // snapshot one — a check that passed while proving nothing.
  const line = (src.match(/for \(const key of \[('categoryRules'[^\]]*)\]\)/) || [])[1] || '';
  assert.ok(line, 'the plan-settings list has moved — this check has gone stale');
  assert.match(line, /'componentNote'/,
    'componentNote is not in the plan-settings list — it would be dropped on every import');
  assert.match(line, /'componentPriority'/, 'fixture check: this is the right list');

  const proj = fs.readFileSync(path.join(__dirname, '..', 'lib', 'project.js'), 'utf8');
  assert.match(proj, /componentNote: s\['plan\.componentNote'\]/,
    'the plan shape does not read componentNote back');
});

/* ── 5. the page, as rendered ─────────────────────────────────────────── */

const PUBLIC = path.join(__dirname, '..', 'public');
const BASE = 'https://ipipelinejira.atlassian.net';

function fakeEl(id) {
  const on = {};
  return {
    id, value: '', dataset: {}, disabled: false, className: '',
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener(type, fn) { (on[type] = on[type] || []).push(fn); },
    fire(type, e = {}) { for (const fn of on[type] || []) fn({ target: this, preventDefault() {}, ...e }); },
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ''; },
  };
}

/* The view runs inside a `vm` context, so a body it builds is an Object from
   THAT realm — `deepStrictEqual` compares prototypes and refuses it. Copied
   out here, once, rather than every check remembering to. */
const out = (v) => JSON.parse(JSON.stringify(v));

/**
 * Load the view ONCE, the way the browser does.
 *
 * The module has to outlive a single render, because App replaces the mount
 * node on every one and the view has to cope with that. A context per render
 * would give each one a brand-new module with brand-new state, which is
 * exactly the condition under which the fresh-mount bug is invisible.
 */
function boot() {
  const puts = [];
  const urls = [];
  let payload = null;
  const ctx = {
    console, Promise, setTimeout, clearTimeout, encodeURIComponent,
    Charts: new Proxy({}, { get: () => () => '' }),
    App: { refresh() {} },
    document: { createElement: () => fakeEl('x'), querySelector: () => fakeEl('x'), querySelectorAll: () => [] },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(PUBLIC, 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);
  ctx.UI.setJiraBase(BASE);
  ctx.UI.api = async (url) => { urls.push(url); return payload; };
  ctx.UI.jsonPut = async (url, body) => { puts.push({ url, body: out(body) }); return { ok: true }; };
  ctx.UI.toast = () => {};
  ctx.UI.drawer = () => {};
  vm.runInContext(`${fs.readFileSync(path.join(PUBLIC, 'views', 'prioritization.js'), 'utf8')}\n;globalThis.__v = PrioritizationView;`, ctx);
  return { ctx, puts, urls, setPayload: (p) => { payload = p; } };
}

/** One render, onto a FRESH mount — the node App hands a view each time. */
async function mountOnce(app, state = {}) {
  const nodes = new Map();
  const get = (sel) => {
    if (!nodes.has(sel)) nodes.set(sel, fakeEl(sel));
    return nodes.get(sel);
  };
  const many = new Map();
  const getAll = (sel) => {
    if (!many.has(sel)) {
      const keys = sel === '[data-level]' ? [1, 2, 3, 4] : sel === '[data-scope]' ? ['team', 'all'] : [];
      many.set(sel, keys.map(k => {
        const n = fakeEl(sel);
        n.dataset = sel === '[data-level]' ? { level: String(k) } : { scope: String(k) };
        return n;
      }));
    }
    return many.get(sel);
  };

  let pageHtml = '';
  const handlers = {};
  const mount = {
    style: {},
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    querySelector: (sel) => get(sel),
    querySelectorAll: (sel) => getAll(sel),
    set innerHTML(v) { pageHtml = v; }, get innerHTML() { return pageHtml; },
  };

  await app.ctx.__v.render(state, mount);

  const fire = (type, e) => { for (const fn of handlers[type] || []) fn({ preventDefault() {}, ...e }); };

  /* The chips are DELEGATED to the mount, because each one's count depends on
     the other lens so they are redrawn on every click. Clicking one therefore
     means dispatching at the mount with a target whose `closest` resolves to
     that chip — which is exactly what the browser does, and what a per-node
     listener in this harness would quietly not be testing. */
  const chip = (attr, value, o = {}) => {
    const node = { dataset: { [attr]: String(value) }, disabled: !!o.disabled };
    node.closest = (sel) => (sel === `[data-${attr === 'family' ? 'family' : 'level'}]` ? node : null);
    fire('click', { target: { closest: node.closest } });
  };

  return {
    page: () => pageHtml,
    chipsHtml: () => get('#pzChips').innerHTML,
    table: () => get('#pzTable').innerHTML,
    clickLevel: (v) => chip('level', v),
    clickFamily: (v, o) => chip('family', v == null ? '' : v, o),
    scopes: getAll('[data-scope]'),
    puts: app.puts,
    urls: app.urls,
    fire,
  };
}

/** The common case: a fresh module and one render. */
async function renderPage(payload, state = {}) {
  const app = boot();
  app.setPayload(payload);
  return mountOnce(app, state);
}

const PAYLOAD = () => ({ ...pz.view(SNAP, PLAN()), noteMax: notes.MAX, project: 'AUTOKAT' });

/* One component in each family, at different levels, so the two lenses cut
   across each other rather than along the same line — which is the only
   arrangement in which a filter that ignores the other one still looks right. */
const FAM_SNAP = {
  issues: Object.fromEntries([
    epic('F-1', { components: ['PS_One'], automationStatus: 'Automated' }),
    epic('F-2', { components: ['R&D_Two'], automationStatus: 'Blocked' }),
    epic('F-3', { components: ['KAT_Three'], automationStatus: 'Maintenance' }),
  ].map(i => [i.key, i])),
};
const FAM_PLAN = {
  componentPriority: { PS_One: 1, 'R&D_Two': 2, KAT_Three: 3, '— no component —': 4 },
  componentNote: {}, excludedComponents: [], coverageTeams: [],
};
const FAM_PAYLOAD = () => ({ ...pz.view(FAM_SNAP, FAM_PLAN), noteMax: notes.MAX, project: 'AUTOKAT' });

check('THE GRID IS HIS SHEET — two tool groups over the seven buckets, then Notes', () => {
  return renderPage(PAYLOAD()).then(p => {
    const html = p.table();
    for (const tool of ['TrueTest', 'KSE']) {
      assert.match(html, new RegExp(`colspan="7"[^>]*>(<i[^>]*></i>)?${tool}<`),
        `the ${tool} group header does not span its seven columns`);
    }
    assert.match(html, />Notes</, 'the Notes column is missing');
    // Seven sub-headers per tool, fourteen in all.
    assert.strictEqual((html.match(/class="[^"]*\bsub\b/g) || []).length, 14,
      'the two tool groups do not carry seven columns each');
    for (const label of ['Automated', 'Maintenance', 'Ready for Automation', 'Blocked', 'N/A for Automation', 'Obsoleted', 'No Status']) {
      assert.ok(html.includes(`title="${label}"`), `the ${label} column has no full label in its title`);
    }
  });
});

check('TWO MEANINGS, TWO CHANNELS — hue is the status, the band is the tool', () => {
  /* The grid has fourteen number columns and a reader has to answer two
     questions about any one of them. If the tool were a hue as well, seven
     statuses and two tools would be competing for one channel and neither
     would arrive — so the tool is a tinted band and the status is the colour
     on the number. These are the two things that must not collapse into one. */
  return renderPage(PAYLOAD()).then(p => {
    const html = p.table();
    const body = html.slice(html.indexOf('<tbody'), html.indexOf('</tbody>'));
    const cells = [...body.matchAll(/<td class="([^"]*\bnum\b[^"]*)"/g)].map(m => m[1]);
    assert.ok(cells.length, 'fixture check: the body has number cells');

    // Every number cell names its bucket AND its tool band, and never both bands.
    for (const c of cells) {
      assert.match(c, /\bcov-(automated|maintenance|ready|blocked|na|obsoleted|none)\b/,
        `a number cell carries no status colour: "${c}"`);
      const bands = (c.match(/\bband-[ab]\b/g) || []);
      assert.strictEqual(bands.length, 1, `a number cell is in ${bands.length} tool bands: "${c}"`);
    }
    // The two tools land in DIFFERENT bands — one band for both is no split.
    const perRow = cells.slice(0, 14);
    assert.strictEqual(new Set(perRow.map(c => (c.match(/band-[ab]/) || [])[0])).size, 2,
      'both tool groups render in the same band, so there is no tool split at all');

    // The three columns outside the coverage ratio are marked as a group.
    const outside = cells.slice(0, 14).filter(c => /\boutside\b/.test(c));
    assert.strictEqual(outside.length, 6, 'the out-of-ratio columns are not dimmed as a group (3 per tool)');
    for (const c of outside) {
      assert.match(c, /cov-(na|obsoleted|none)/, 'a column in the ratio was dimmed as if outside it');
    }
  });
});

check('N/A AND OBSOLETED ARE NOT THE SAME COLOUR ANY MORE', () => {
  /* Two of the seven statuses used to render identically grey, which means
     the grid could not tell them apart at all — and Obsoleted is 294 epics of
     his data, not a rounding error. */
  const seen = new Map();
  for (const b of coverage.BUCKETS) {
    assert.ok(b.color && b.ink, `${b.key} carries no colour — the model owns this, not a view`);
    assert.ok(!seen.has(b.color), `${b.key} and ${seen.get(b.color)} are the same colour`);
    seen.set(b.color, b.key);
  }
  for (const t of coverage.TOOLS) assert.ok(t.color, `${t.key} carries no colour`);
});

check('the legend names every bucket, in the payload\'s own colours', () => {
  /* A legend written by hand is a legend that describes last month's scheme.
     This one is built from the same list the cells are. */
  return renderPage(PAYLOAD()).then(p => {
    const page = p.page();
    for (const b of coverage.BUCKETS) {
      assert.ok(page.includes(`background:${b.color}`), `${b.label} is missing from the legend`);
      assert.ok(page.includes(b.label), `${b.label} is not named in the legend`);
    }
  });
});

check('a long warning is NAMED THEN COUNTED, not dumped as a paragraph', () => {
  /* 31 of his ranked components have no epics. Listing all 31 names produced
     a nine-line wall of text at the top of the page that nobody would read —
     which is the same thing as not warning at all. */
  const many = {};
  for (let i = 0; i < 31; i++) many[`R&D_GHOST_${String(i).padStart(2, '0')}`] = 3;
  const v = pz.view({ issues: {} }, { componentPriority: many, componentNote: {}, excludedComponents: [], coverageTeams: [] });
  assert.strictEqual(v.untracked.length, 31, 'fixture check');

  return renderPage({ ...v, noteMax: notes.MAX, project: 'AUTOKAT' }).then(p => {
    const page = p.page();
    assert.match(page, /and 25 more/, 'all 31 names were dumped into the warning');
    const named = (page.match(/R&D_GHOST_\d\d/g) || []).length;
    assert.ok(named <= 6, `${named} component names in one warning line`);
    assert.match(page, /tagged in the grid below/, 'it should say where the rest are');
    // And the grid still tags every one of them.
    assert.strictEqual((p.table().match(/>no epics</g) || []).length, 31,
      'the grid dropped the tag the warning points at');
  });
});

check('the grid opts OUT of the shared sorter, which cannot read a two-row header', () => {
  /* `UI.sortable` maps header cells to body columns by index and reads the
     first header row — which here is five cells wide because of the colspans.
     Left on, clicking "TrueTest" would sort by the Priority column. */
  return renderPage(PAYLOAD()).then(p => {
    assert.match(p.table(), /<table class="pz" data-nosort>/,
      'the grid is still offered to a sorter that would map its columns wrongly');
  });
});

check('AND EVERY ROW LINES UP UNDER IT — body cells match header columns', () => {
  /* The check the grid actually needs, and the one a header-only assertion
     misses: draw seven number cells under a fourteen-column header and every
     KSE figure renders beneath a TrueTest heading. The table is still valid
     HTML, every number on it is a real number, and the page is completely
     wrong with nothing on it to say so.

     So this counts what the header promises and what a row delivers, and
     compares them — rather than either one against a hand-written 14, which
     would go stale the moment a bucket or a tool is added. */
  return renderPage(PAYLOAD()).then(p => {
    const html = p.table();
    const head = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'));
    const body = html.slice(html.indexOf('<tbody'), html.indexOf('</tbody>'));

    // Component and Priority span both header rows; Notes does too.
    const spanning = (head.match(/rowspan="2"/g) || []).length;
    const grouped = [...head.matchAll(/colspan="(\d+)"/g)].reduce((n, m) => n + Number(m[1]), 0);
    const columns = spanning + grouped;

    const rows = body.split('<tr').slice(1);
    assert.ok(rows.length, 'fixture check: the body has rows');
    for (const r of rows) {
      const cells = (r.match(/<td/g) || []).length;
      const name = (r.match(/>([A-Za-z0-9_&]+)<\/a>/) || [])[1] || '(unnamed)';
      assert.strictEqual(cells, columns,
        `${name} has ${cells} cells under a ${columns}-column header — its numbers are under the wrong headings`);
    }

    // And the footer, which a reader lines up with the columns by eye.
    const foot = html.slice(html.indexOf('<tfoot'), html.indexOf('</tfoot>'));
    assert.strictEqual((foot.match(/<td/g) || []).length, columns,
      'the totals row does not line up with the grid above it');
  });
});

check('EVERY ROW ON THE LIST IS ON THE PAGE, epic-less ones included', () => {
  return renderPage(PAYLOAD()).then(p => {
    const html = p.table();
    for (const c of ['PS_iGO_NLG', 'PS_RES_NLG', 'PS_iGO_Lincoln']) {
      assert.ok(html.includes(c), `${c} is on the shortlist and not in the table`);
    }
    assert.ok(!html.includes('PS_iGO_Columbus'), 'an unranked component was drawn');
    assert.match(html, /class="untracked"/, 'the epic-less row is not marked');
    assert.match(html, />no epics</, 'nothing on the row says it carries no epics');
  });
});

check('THE CHIP FILTERS THE GRID, and the Jira link follows it', () => {
  /* The Backlog page's lesson: a link built from the whole list while the
     table shows one row opens a different set, and nothing says which. */
  return renderPage(PAYLOAD()).then(p => {
    const all = p.table();
    assert.ok(all.includes('PS_iGO_Lincoln') && all.includes('PS_iGO_NLG'), 'fixture check');

    p.clickLevel(1);
    const one = p.table();
    assert.ok(one.includes('PS_iGO_NLG'), 'the P1 filter dropped a P1');
    assert.ok(!one.includes('PS_iGO_Lincoln'), 'the P1 filter kept a P2');

    const href = decodeURIComponent((one.match(/href="([^"]*issues\/\?jql=[^"]*)"/) || [])[1] || '');
    assert.ok(href, 'the filtered line has no way into Jira');
    assert.match(href, /PS_iGO_NLG/, 'the link does not open what the table shows');
    assert.ok(!/PS_iGO_Lincoln/.test(href), 'the link still opens the rows the chip removed');

    // And the count line agrees with the rows it sits above.
    const said = Number((one.match(/>(\d+) components? ·/) || [])[1]);
    assert.strictEqual(said, 2, `the line says ${said} components and the P1 chip has 2`);
  });
});

check('THE FAMILY FILTER CUTS THE GRID, and the Jira link follows it', () => {
  return renderPage(FAM_PAYLOAD()).then(p => {
    /* The view escapes what it renders, so "R&D_Two" appears as "R&amp;D_Two".
       Comparing against the raw name is a check that fails for a reason that
       has nothing to do with the filter under test. */
    const has = (html, name) => html.includes(name.replace(/&/g, '&amp;'));
    assert.ok(has(p.table(), 'PS_One') && has(p.table(), 'R&D_Two'), 'fixture check');

    p.clickFamily('rnd');
    const rnd = p.table();
    assert.ok(has(rnd, 'R&D_Two'), 'the R&D filter dropped an R&D component');
    assert.ok(!has(rnd, 'PS_One'), 'the R&D filter kept a PS component');
    assert.ok(!has(rnd, 'KAT_Three'), 'the R&D filter kept a KAT component');

    const href = decodeURIComponent((rnd.match(/href="([^"]*issues\/\?jql=[^"]*)"/) || [])[1] || '');
    assert.match(href, /R&D_Two/, 'the link does not open what the table shows');
    assert.ok(!/PS_One/.test(href), 'the link still opens the rows the family chip removed');

    const said = Number((rnd.match(/>(\d+) components? ·/) || [])[1]);
    assert.strictEqual(said, 1, `the count line says ${said} and the R&D family has 1`);

    p.clickFamily('rnd');   // toggles off
    assert.ok(has(p.table(), 'PS_One'), 'toggling the family chip off did not restore the grid');
  });
});

check('A KAT COMPONENT IS KAT, not swept into Other', () => {
  /* Named prefixes, asserted by BEHAVIOUR rather than by walking the same
     list the code walks — a check that iterates `FAMILIES` adapts to a family
     being deleted from it and reports success, which is a test validating
     itself. These four prefixes are the team's own division of the work. */
  const cases = [
    ['PS_iGO_NLG', 'ps'], ['ps_lowercase_too', 'ps'],
    ['R&D_Sig_Smoke', 'rnd'], ['KAT_Common_Maintenance', 'kat'],
    ['Technical_Works', 'other'], ['— no component —', 'other'], ['', 'other'],
  ];
  for (const [name, key] of cases) {
    assert.strictEqual(coverage.familyKeyOf(name), key, `${name || '(blank)'} landed in the wrong family`);
  }
  const keys = coverage.FAMILIES.map(f => f.key);
  assert.deepStrictEqual(keys, ['ps', 'rnd', 'kat', 'other'],
    'the families have changed — four prefixes divide this work and the chips are built from them');
  assert.strictEqual(coverage.FAMILIES.filter(f => !f.test).length, 1,
    'exactly one family is the catch-all, and it must be last');
  assert.strictEqual(keys[keys.length - 1], 'other', 'the catch-all has to sort last');

  // And a ranked KAT component reaches the page as KAT.
  const v = pz.view({ issues: {} }, { componentPriority: { KAT_Thing: 2 }, componentNote: {}, excludedComponents: [], coverageTeams: [] });
  assert.strictEqual(v.rows[0].familyKey, 'kat', 'a KAT component did not reach the grid as KAT');
  assert.strictEqual(v.families.find(f => f.key === 'kat').count, 1, 'the KAT chip did not count it');
  assert.strictEqual(v.families.find(f => f.key === 'other').count, 0, 'it was counted in Other as well');
});

check('ALL / PS / R&D / KAT / Other — every declared family gets a chip', () => {
  /* He asked for All, PS, R&D and Other. KAT is a real family in the model,
     so it ships too — a KAT component ranked tomorrow has to appear
     somewhere, and quietly folding it into Other would be a chip that lies
     about what it contains. */
  return renderPage(FAM_PAYLOAD()).then(p => {
    const chips = p.chipsHtml();
    assert.match(chips, /data-family=""[^>]*>All/, 'there is no All chip');
    for (const f of coverage.FAMILIES) {
      assert.match(chips, new RegExp(`data-family="${f.key}"`), `the ${f.short} family has no chip`);
      const esc = (v) => v.replace(/&/g, '&amp;');
      assert.ok(chips.includes(esc(f.short)), `the ${f.key} chip is not labelled`);
      assert.ok(chips.includes(`title="${esc(f.label)}"`), `the ${f.short} chip does not carry its full name`);
    }
    /* The short name comes from the model, not from splitting the label.
       The LONG label belongs in `title` and is checked for above; what must
       not happen is it being drawn as the chip's visible text, which is what
       `label.split(' —')[0]` silently does the moment a label has no dash —
       as "Other" never did. So this reads the text between the tags only. */
    const text = chips.replace(/<[^>]*>/g, ' ');
    assert.ok(!/client delivery|product regression|framework/.test(text),
      'a chip is showing the long label as its visible text');
    for (const f of coverage.FAMILIES) {
      assert.ok(text.includes(f.short.replace(/&/g, '&amp;')), `${f.short} is not visible on its chip`);
    }
  });
});

check('A FAMILY WITH NO ROWS IS SHOWN AND DISABLED, not dropped', () => {
  /* A row of chips that reshuffles as priorities change is one you cannot
     build a habit around — and "R&D: none of yours" is worth saying, which
     an absent chip does not say. */
  const v = pz.view(SNAP, PLAN());     // PS components only
  return renderPage({ ...v, noteMax: notes.MAX, project: 'AUTOKAT' }).then(p => {
    const chips = p.chipsHtml();
    assert.match(chips, /data-family="rnd"[^>]*disabled/, 'an empty family chip is clickable');
    assert.match(chips, /data-family="ps"(?![^>]*disabled)/, 'the family that has rows was disabled');

    // And clicking the disabled one does nothing.
    const before = p.table();
    p.clickFamily('rnd', { disabled: true });
    assert.strictEqual(p.table(), before, 'a disabled family chip emptied the grid');
  });
});

check('THE TWO LENSES COUNT EACH OTHER — a chip never reports a set that is not there', () => {
  /* The reason the chips are redrawn instead of printed once from the
     payload. Pick R&D and a P1 chip still reading the portfolio's 11 is a
     number for a set nobody can see, and nothing on screen says it is stale. */
  return renderPage(FAM_PAYLOAD()).then(p => {
    const counts = (html, attr) => Object.fromEntries(
      [...html.matchAll(new RegExp(`data-${attr}="([^"]*)"[^>]*>[^<]*<strong>(\\d+)</strong>`, 'g'))]
        .map(m => [m[1], Number(m[2])]));

    const wide = counts(p.chipsHtml(), 'level');
    assert.strictEqual(wide['1'], 1, 'fixture check: one P1 across every family');
    assert.strictEqual(wide['2'], 1, 'fixture check: one P2');

    p.clickFamily('rnd');           // R&D holds the single P2 and no P1
    const narrow = counts(p.chipsHtml(), 'level');
    assert.strictEqual(narrow['1'], 0, 'the P1 chip still counts rows the family filter removed');
    assert.strictEqual(narrow['2'], 1, 'the P2 chip lost the row it should still have');

    // And it works the other way: a level narrows the family counts.
    p.clickFamily('rnd');           // off
    p.clickLevel(1);
    const fams = counts(p.chipsHtml(), 'family');
    assert.strictEqual(fams.ps, 1, 'PS holds the only P1');
    assert.strictEqual(fams.rnd, 0, 'the R&D chip counts rows the P1 filter removed');
    assert.strictEqual(fams[''], 1, 'the All chip should count what the other lens leaves');
  });
});

check('the two lenses COMBINE rather than replace each other', () => {
  return renderPage(FAM_PAYLOAD()).then(p => {
    p.clickFamily('ps');
    p.clickLevel(1);
    assert.ok(p.table().includes('PS_One'), 'PS + P1 should keep the PS P1 row');   // no & in this one
    assert.strictEqual(Number((p.table().match(/>(\d+) components? ·/) || [])[1]), 1);

    p.clickLevel(2);   // PS has no P2 — an empty intersection is a real answer
    assert.match(p.table(), /No component matches/, 'an empty intersection should say so');
  });
});

check('THE PRIORITY WRITES TO THE SAME PLAN KEY THE COVERAGE SCREEN DOES', () => {
  /* Not a copy of the judgement — the judgement. Two routes would mean the
     two screens could hold different answers to a question that has one. */
  return renderPage(PAYLOAD()).then(p => {
    const sel = fakeEl('sel');
    sel.dataset = { priority: 'PS_iGO_NLG', was: '1' };
    sel.value = '2';
    p.fire('change', { target: { closest: (s) => (s === '[data-priority]' ? sel : null) } });
    return new Promise(r => setTimeout(r, 0)).then(() => {
      assert.strictEqual(p.puts.length, 1, 'the priority edit did not reach the server');
      assert.strictEqual(p.puts[0].url, '/api/component-priority',
        'the priority is being written somewhere other than the shared route');
      assert.deepStrictEqual(p.puts[0].body, { component: 'PS_iGO_NLG', level: 2 });
    });
  });
});

check('THE NOTE SAVES ON BLUR, and an unchanged one is not an edit', () => {
  return renderPage(PAYLOAD()).then(p => {
    const box = fakeEl('note');
    box.dataset = { note: 'PS_RES_NLG', was: 'waiting on the migration' };
    const fire = () => p.fire('change', {
      target: { closest: (s) => (s === '[data-note]' ? box : null) },
    });

    box.value = 'waiting on the migration';
    fire();
    return new Promise(r => setTimeout(r, 0)).then(() => {
      assert.strictEqual(p.puts.length, 0, 'blurring an untouched note wrote to the server');

      box.value = 'owner left, nobody has picked this up';
      fire();
      return new Promise(r => setTimeout(r, 0));
    }).then(() => {
      assert.strictEqual(p.puts.length, 1, 'the note edit did not reach the server');
      assert.strictEqual(p.puts[0].url, '/api/component-note');
      assert.deepStrictEqual(p.puts[0].body,
        { component: 'PS_RES_NLG', note: 'owner left, nobody has picked this up' });

      box.value = '   ';
      fire();
      return new Promise(r => setTimeout(r, 0));
    }).then(() => {
      assert.strictEqual(p.puts.length, 2, 'clearing a note did not reach the server');
      assert.strictEqual(p.puts[1].body.note, '', 'a cleared note must be sent as blank, so the key is deleted');
    });
  });
});

check('THE UNTAGGED BUCKET SEARCHES `component IS EMPTY`, not a component by that name', () => {
  /* `— no component —` is a LABEL for the epics nobody tagged, not a name in
     Jira. Linked as a name it searches for a suite that does not exist and
     comes back with nothing — which reads as "this one has no epics" rather
     than "that was the wrong question", and is wrong in the direction that
     never looks wrong. */
  const plan = { componentPriority: { PS_Real: 1, '— no component —': 4 }, componentNote: {}, excludedComponents: [], coverageTeams: [] };
  const snap = {
    issues: {
      R: epic('R', { components: ['PS_Real'], automationStatus: 'Automated' }),
      // No components at all — this is what lands in the bucket.
      N: epic('N', { components: [], automationStatus: 'Ready for Automation' }),
    },
  };
  const v = pz.view(snap, plan);
  const bucket = v.rows.find(r => r.component === coverage.NO_COMPONENT);
  assert.ok(bucket, 'fixture check: the untagged bucket should be a ranked row');
  assert.strictEqual(bucket.noComponent, true, 'the model does not mark the untagged bucket');
  assert.strictEqual(v.rows.find(r => r.component === 'PS_Real').noComponent, false,
    'a real component was marked as the untagged bucket');

  return renderPage({ ...v, noteMax: notes.MAX, project: 'AUTOKAT' }).then(p => {
    /* The ROW's own link, not the count line's — that one covers every row on
       screen and is checked separately below. */
    const html = p.table();
    const body = html.slice(html.indexOf('<tbody'), html.indexOf('</tbody>'));
    const hrefs = [...body.matchAll(/href="([^"]*issues\/\?jql=[^"]*)"/g)]
      .map(m => decodeURIComponent(m[1].split('jql=')[1] || ''));
    assert.strictEqual(hrefs.length, 2, 'fixture check: two rows, two component links');
    const empty = hrefs.filter(h => /component IS EMPTY/.test(h));
    assert.strictEqual(empty.length, 1, 'exactly one row is the untagged bucket and only it should search IS EMPTY');
    assert.ok(!hrefs.some(h => h.includes('— no component —')),
      'a link searches for a component literally named "— no component —"');
    assert.ok(hrefs.some(h => /component = "PS_Real"/.test(h)),
      'the real component stopped linking to itself');
  });
});

check('AND SO DOES THE PAGE-LEVEL LINK, with its OR bracketed', () => {
  /* The multi-component link has the same problem plus one of its own: the
     empty bucket is an OR'd clause, and an un-bracketed OR reaches across
     the ANDs — turning "these components, in AUTOKAT, of type Epic" into
     "those components in AUTOKAT, OR every untagged issue in the instance",
     which is a perfectly valid query returning tens of thousands of rows. */
  const plan = { componentPriority: { PS_Real: 1, '— no component —': 4 }, componentNote: {}, excludedComponents: [], coverageTeams: [] };
  const snap = { issues: { R: epic('R', { components: ['PS_Real'] }), N: epic('N', { components: [] }) } };
  const v = pz.view(snap, plan);
  return renderPage({ ...v, noteMax: notes.MAX, project: 'AUTOKAT' }).then(p => {
    // The count line's link covers every row on screen, both kinds.
    const line = p.table().slice(0, p.table().indexOf('<div class="table-wrap"'));
    const href = decodeURIComponent((line.match(/href="([^"]*issues\/\?jql=[^"]*)"/) || [])[1] || '').split('jql=')[1] || '';
    const q = decodeURIComponent((line.match(/jql=([^"]*)"/) || [])[1] || '');
    assert.match(q, /component IS EMPTY/, 'the page link leaves the untagged bucket out');
    assert.match(q, /PS_Real/, 'the page link dropped the real components');
    assert.match(q, /\(component in \([^)]*\) OR component IS EMPTY\)/,
      'the OR is not bracketed — it would reach across the project and issuetype ANDs');
    assert.ok(!q.includes('— no component —'), 'the placeholder leaked into the query as a name');
  });
});

check('a cell opens the epics it counted, against the same scope', () => {
  return renderPage(PAYLOAD()).then(p => {
    const html = p.table();
    assert.match(html, /data-act="pz-epics"/, 'no count on the grid is clickable');
    assert.match(html, /data-act="pz-epics" data-row="PS_iGO_NLG" data-tool="truetest" data-bucket="automated"/,
      'a cell does not carry the row, tool and bucket it counted');
    // A zero is not a drill-in: there is nothing behind it to list.
    assert.match(html, /<span class="muted">—<\/span>/, 'a zero should render as a dash, not a button');
  });
});

check('THE EDIT CONTROLS SURVIVE A SECOND VISIT — a fresh mount is a fresh wiring', () => {
  /* App builds a BRAND NEW mount node on every render. The Priority and Notes
     handlers are delegated to the mount (because a chip click replaces the
     tbody under them), so a once-per-session `wired` flag attaches them to the
     FIRST mount and leaves every later visit to this page with controls that
     look completely normal and do nothing. Two renders, then an edit. */
  const app = boot();
  app.setPayload(PAYLOAD());
  return mountOnce(app).then(() => mountOnce(app)).then(p => {
    const sel = fakeEl('sel');
    sel.dataset = { priority: 'PS_iGO_NLG', was: '1' };
    sel.value = '3';
    p.fire('change', { target: { closest: (s) => (s === '[data-priority]' ? sel : null) } });
    return new Promise(r => setTimeout(r, 0)).then(() => {
      assert.strictEqual(p.puts.length, 1,
        'the second render of this page has dead controls — the wiring was bound to the first mount');
    });
  });
});

check('the page asks the server for the team it is scoped to', () => {
  /* The team cut is against the Team field on every epic, so it cannot be
     done in the browser from a payload that was already narrowed — the
     request has to carry it. */
  return renderPage(PAYLOAD(), { teamId: 'ruby', teams: [{ id: 'ruby', name: 'Katalon Ruby' }] }).then(p => {
    assert.strictEqual(p.urls.length, 1);
    assert.match(p.urls[0], /\/api\/prioritization\?team=ruby$/,
      `the page fetched "${p.urls[0]}" — it has to name the team it is scoping to`);
    assert.match(p.page(), /data-scope="all"/, 'there is no way back to the portfolio view');
    assert.match(p.page(), /Katalon Ruby/, 'the page does not name the team it filtered to');
  });
});

check('A BIG SHORTLIST STILL RENDERS EVERY ROW IT COUNTED', () => {
  /* The page has no row cap, and the count line, the totals and the table
     must agree at a size no hand-built fixture reaches by accident — the
     shape of bug that survived a full mutation run on the Backlog page. */
  const many = {};
  const snap = { issues: {} };
  for (let i = 0; i < 120; i++) {
    const c = `PS_GEN_${String(i).padStart(3, '0')}`;
    many[c] = (i % 4) + 1;
    snap.issues[`G-${i}`] = epic(`G-${i}`, { components: [c], automationStatus: 'Automated' });
  }
  const v = pz.view(snap, { componentPriority: many, componentNote: {}, excludedComponents: [], coverageTeams: [] });
  assert.strictEqual(v.rows.length, 120, 'rows went missing from a 120-component shortlist');
  assert.strictEqual(v.totals.total, 120);
  assert.strictEqual(v.totals.kse.automated, 120);

  return renderPage({ ...v, noteMax: notes.MAX, project: 'AUTOKAT' }).then(p => {
    const html = p.table();
    const drawn = (html.match(/data-priority="/g) || []).length;
    assert.strictEqual(drawn, 120, `the table drew ${drawn} of 120 rows`);
    const said = Number((html.match(/>(\d+) components? ·/) || [])[1]);
    assert.strictEqual(said, 120, `the count line says ${said} and the table drew ${drawn}`);
  });
});

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
