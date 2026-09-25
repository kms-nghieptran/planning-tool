'use strict';
/**
 * migrate.test.js — the JSON files go into the database and come back out
 * unchanged.
 *
 * WHY THIS TEST LOOKS THE WAY IT DOES
 *
 * The first version of the migration verified itself by counting: 19 rows of
 * leave grid in, 19 rows out, green. Every count matched and the migration was
 * still losing data. What the counts could not see:
 *
 *   - team members came back alphabetised, so every capacity grid reordered
 *   - the board picker came back alphabetised, so board 5 was now board 12
 *   - exclusions came back in account-id order
 *   - a sprint on an issue lost its start and end dates
 *   - `plan.updatedAt`, `team.source`, `team.boardName` came back empty
 *   - `shared: false` on the dated sprints was gone, and `source` had grown
 *     onto five sprints that never had it
 *
 * None of those changes a count. All of them change what he sees. So this test
 * compares the projected objects against the source objects FIELD BY FIELD,
 * key order included, and treats an added key as a failure just as much as a
 * missing one.
 *
 * The fixture below is small, but every shape in it is one the real data
 * actually contains — the lowercase account name that sorts differently, the
 * sprint with no id, the sprint with no dates, the calendar entry with no
 * source, the `shared: false` entry, the member list that is not alphabetical.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-migrate-'));
process.env.STORE_DIR = SCRATCH;
process.env.DB_FILE = path.join(SCRATCH, 'test.db');

const db = require('../lib/db');
const dates = require('../lib/sprint-dates');
const imp = require('../lib/import-json');
const project = require('../lib/project');
const store = require('../lib/store');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fresh(); fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
console.log('\nJSON → database → JSON, without losing anything\n');

function fresh() {
  db.close();
  for (const f of fs.readdirSync(SCRATCH)) fs.rmSync(path.join(SCRATCH, f), { force: true, recursive: true });
  db.openAt(path.join(SCRATCH, 'test.db'));
}

/* ─────────────────────────── the fixture ─────────────────────────── */

const SNAPSHOT = () => ({
  syncedAt: '2026-09-14T15:52:30.566Z',
  watermark: '2026-09-14T15:52:18.738Z',
  source: 'jira',
  issues: {
    'AUTOKAT-1': {
      key: 'AUTOKAT-1', project: 'AUTOKAT', summary: 'Login regression',
      issueType: 'Story', status: 'In Dev', statusCategory: 'indeterminate',
      assignee: 'Thao Dang', assigneeId: '62734ff066ad530069d43bdc', reporter: 'Nghiep Tran',
      priority: 'High', resolution: null, points: 5,
      created: '2026-08-01T00:00:00Z', updated: '2026-09-10T00:00:00Z',
      resolved: null, dueDate: null,
      // A Story UNDER an epic: the new-implementation shape. The parent's own
      // name and type ride along, because the epic is usually not synced.
      parentKey: 'AUTOKAT-100', parentStatus: 'In Progress',
      parentSummary: 'Renewals regression suite', parentType: 'Epic',
      automationStatus: 'Automated', team: 'Katalon Auto Ruby',
      originalEstimate: null, timeSpent: null,
      components: ['R&D_Sig_Regression'], labels: ['TestPak'],
      // dates on the sprint, which the board's copy of the same sprint does not have
      sprints: [{ id: '900', name: 'Katalon Ruby Sprint 39', state: 'active', start: '2026-09-03T02:22:43.935Z', end: '2026-09-16T14:27:27.000Z' }],
      sprintNames: ['Katalon Ruby Sprint 39'], sprintIds: ['900'],
      blockedBy: ['AUTOKAT-2'], relatesTo: [], datasets: ['sprintWork'],
    },
    'AUTOKAT-2': {
      key: 'AUTOKAT-2', project: 'AUTOKAT', summary: 'Blocked by infra',
      issueType: 'Bug', status: 'Backlog', statusCategory: 'new',
      assignee: null, assigneeId: null, reporter: 'Nghiep Tran',
      priority: 'Medium', resolution: null, points: null,
      created: '2026-08-02T00:00:00Z', updated: '2026-09-09T00:00:00Z',
      resolved: null, dueDate: null, parentKey: null, parentStatus: null,
      parentSummary: null, parentType: null,
      automationStatus: null, team: 'Katalon Auto Ruby',
      originalEstimate: null, timeSpent: null,
      components: [], labels: [],
      // a sprint with NO id and NO dates — the older custom-field format
      sprints: [{ name: 'Katalon Ruby Sprint 40', state: 'future' }],
      sprintNames: ['Katalon Ruby Sprint 40'], sprintIds: [],
      // Maintenance: no parent, epics reached through "relates to" links. These
      // share one table with blockedBy, so this row is also what proves a
      // round trip does not let one kind of link overwrite the other.
      blockedBy: [],
      relatesTo: [{ key: 'AUTOKAT-100', summary: 'Renewals regression suite', type: 'Epic' }],
      datasets: ['backlog'],
    },
  },
  // ordered by start date, undated last — what the projection produces
  sprints: [
    { name: 'Katalon Ruby Sprint 39', state: 'active', start: '2026-09-03T02:22:43.935Z', end: '2026-09-16T14:27:27.000Z' },
    { name: 'Katalon Ruby Sprint 40', state: 'future' },
  ],
  // NOT alphabetical, and the lowercase one is where a case-insensitive sort puts it
  people: [
    { name: 'Abiran Lopez', accountId: 'acc-abiran' },
    { name: 'quyennguyen', accountId: '60b0189543aeb10070fa2de7' },
    { name: 'Thao Dang', accountId: '62734ff066ad530069d43bdc' },
  ],
  components: ['R&D_Sig_Regression', 'KAT_Common_Maintenance'],
  testops: { syncedAt: null, projects: [], suites: [] },
  github: { syncedAt: null, repos: [], activity: [] },
  verification: [{ dataset: 'sprintWork', local: 4404, remote: 4404, ok: true }],
  fields: { storyPointsField: 'customfield_16012', sprintField: 'customfield_10905' },
  // Jira's order, which is not alphabetical
  boards: [
    { id: '2356', name: 'Shared Technology ', type: 'kanban' },
    { id: '2093', name: 'Katalon Auto Ruby', type: 'scrum' },
  ],
  boardSprintsByTeam: {
    ruby: [
      { id: '900', name: 'Katalon Ruby Sprint 39', state: 'active', start: '2026-09-03', end: '2026-09-16' },
      { id: '901', name: 'Katalon Ruby Sprint 40', state: 'future', start: null, end: null },
    ],
  },
  boardSprintErrors: [],
});

const PLAN = () => ({
  version: 1,
  updatedAt: '2026-09-14T15:52:37.914Z',
  teams: [{
    id: 'ruby', name: 'Katalon Ruby', jiraName: 'Katalon Auto Ruby',
    jiraTeams: ['Katalon Auto Ruby'], boardId: '2093', boardName: 'Katalon Auto Ruby',
    components: ['R&D_Sig_Regression'], sprintKeywords: ['ruby'],
    settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 8.5 },
    source: 'jira',
    // deliberately NOT alphabetical: this is the order the grid shows
    members: [
      { id: 'ruby-thao-dang', name: 'Thao Dang', role: 'Auto QA', status: 'Active', supportPct: 0, jiraAccountId: '62734ff066ad530069d43bdc', source: 'jira', addedAt: '2026-09-11T10:51:14.159Z' },
      { id: 'ruby-abiran-lopez', name: 'Abiran Lopez', role: 'Auto QA', status: 'Active', supportPct: 0, jiraAccountId: 'acc-abiran', source: 'jira', addedAt: '2026-09-11T10:51:14.159Z' },
    ],
  }],
  sprints: [
    // a numbered entry, shared across teams, from Jira
    {
      id: 'S39', number: 39, name: 'Sprint 39', start: '2026-09-03', end: '2026-09-16', source: 'jira',
      byTeam: { ruby: { jiraId: '900', name: 'Katalon Ruby Sprint 39', state: 'active', start: '2026-09-03', end: '2026-09-16', syncedAt: '2026-09-14T15:52:37.117Z' } },
    },
    // a dated entry with its own calendar row: `shared: false`, no number
    {
      id: 'J16178', number: null, name: 'TT Week 18May-24May', start: '2026-05-18', end: '2026-05-25',
      source: 'jira', shared: false,
      byTeam: { ruby: { jiraId: '16178', name: 'TT Week 18May-24May', state: 'closed', start: '2026-05-18', end: '2026-05-25', syncedAt: '2026-09-14T15:52:37.119Z' } },
    },
    // a future entry he created here: NO `source` key at all
    { id: 'S40', number: 40, name: 'Sprint 40', start: '2026-09-17', end: '2026-09-30', byTeam: {} },
  ],
  holidays: ['2026-04-30', '2026-05-01'],
  availability: { 'ruby|S39|ruby-thao-dang': ['1', '1', 'WO', 'WO', '1', '1', '1', '1', '1', 'WO', 'WO', '1', '1', '0.5'] },
  support: { 'ruby|S39|ruby-thao-dang': 25 },
  /* On the roster, out of the capacity arithmetic — a decision no sync can
     rederive, and one a migration that drops it turns back into a full-time
     person whose hours nobody meant to plan against. */
  calcExempt: { 'ruby|S39|ruby-hien-phan': true },
  ceremony: { 'ruby|S39': 8.5 },
  overrides: { 'ruby|S39|ruby-abiran-lopez': { planned: 30, actual: 28 } },
  risks: [{ id: 'r1', title: 'Env unstable', severity: 'High' }],
  categoryRules: null,
  mixTargets: { ruby: { new: [45, 100], maintenance: [0, 35] } },
  // His own judgement of which suites matter. Plan data by definition — there
  // is nothing in Jira to rederive it from, so losing it in a migration loses
  // it for good.
  componentPriority: { 'R&D_Sig_Regression': 1, 'KAT_Common_Maintenance': 3 },
  // Components that are not automation suites. Plan data for the same reason
  // as the priorities above: a decision, with nothing in Jira to rederive it
  // from, so a migration that drops it drops it for good.
  excludedComponents: ['Technical_Works', 'KAT_Common_Maintenance'],
  // The allow-list of Jira Team field values. Note the SPELLINGS: these are
  // the Team field's own strings, which on his instance are not the board
  // names — a distinction a migration must carry through untouched.
  coverageTeams: ['Katalon PSA (Titan)', 'Katalon RDA (Ruby)'],
  /* A sprint span he corrected by hand. Jira says one thing and the team
     worked another, and only the plan remembers which — a migration that
     drops this silently hands every screen Jira's figure back. */
  /* A sprint span he corrected by hand. Kept on an id this plan no longer
     has, so the round-trip is exercised without steering the normalisation
     checks below — an override for a departed sprint is inert by
     construction, which is also what happens when a sprint is removed. */
  sprintDates: { 'S-gone': { start: '2026-01-05', end: '2026-01-21' } },
  notes: { 'ruby|S39': 'Focus on Sig regression' },
  excluded: { ruby: ['acc-zzz', 'acc-aaa', 'An Nguyen'] },
  // Roster decisions: one person put on a sprint, one taken off. These are the
  // only two things about a sprint's roster that a sync cannot rederive.
  sprintRoster: {
    'ruby|S39': { added: ['ruby-abiran-lopez'], removed: ['jira:acc-gone'] },
    'ruby|S40': {
      added: ['jira:acc-newjoiner'], removed: [],
      // Who they are, on the sprint's own row — they are NOT a team member.
      people: { 'jira:acc-newjoiner': { name: 'New Joiner', jiraAccountId: 'acc-newjoiner' } },
    },
  },
  scenarios: [{
    id: 'sc1', teamId: 'ruby', sprintId: 'S40', name: 'Chau on leave', note: 'two weeks off',
    data: {
      roster: ['ruby-thao-dang'],
      availability: { 'ruby-thao-dang': ['1', '1', 'WO', 'WO', '1', '1', '1', '1', '1', 'WO', 'WO', '1', '1', '1'] },
      support: { 'ruby-thao-dang': 10 },
      ceremony: 8.5,
      overrides: {},
    },
    totals: { headcount: 1, capacityHours: 62.3, predicted: 21 },
    createdAt: '2026-09-14T10:00:00Z', appliedAt: null,
  }],
  ignoredBoards: [],
  savedSearches: [{ id: 'sv1', name: 'My unestimated', query: 'points IS EMPTY', columns: ['key', 'summary'], sort: 'updated', dir: 'desc', matchedWhenSaved: 12, savedAt: '2026-09-12T00:00:00Z' }],
});

/**
 * Deep comparison that reports WHERE, and treats an added key as a difference.
 * `assert.deepStrictEqual` would catch the same things but says only that two
 * 9,000-line objects differ, which is not a usable failure message here.
 */
function diff(a, b, at = '', out = []) {
  if (a === b) return out;
  const t = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  if (t(a) !== t(b)) { out.push(`${at}: ${t(a)} became ${t(b)}`); return out; }
  if (t(a) === 'array') {
    if (a.length !== b.length) { out.push(`${at}: ${a.length} entries became ${b.length}`); return out; }
    a.forEach((_, i) => diff(a[i], b[i], `${at}[${i}]`, out));
    return out;
  }
  if (t(a) === 'object') {
    for (const k of Object.keys(a)) if (!(k in b)) out.push(`${at}.${k}: lost`);
    for (const k of Object.keys(b)) if (!(k in a)) out.push(`${at}.${k}: added`);
    for (const k of Object.keys(a)) if (k in b) diff(a[k], b[k], `${at}.${k}`, out);
    return out;
  }
  out.push(`${at}: ${JSON.stringify(a)} became ${JSON.stringify(b)}`);
  return out;
}

const same = (a, b, what) => {
  const d = diff(a, b, what);
  assert.ok(!d.length, `${d.length} difference(s):\n      ` + d.slice(0, 12).join('\n      '));
};

/* ─────────────────────────── the checks ─────────────────────────── */

check('THE PLAN COMES BACK EXACTLY AS IT WENT IN', () => {
  const plan = PLAN();
  imp.importAll({ snapshot: SNAPSHOT(), plan });
  same(plan, project.plan(), 'plan');
});

/* ── the sprint-date seam ─────────────────────────────────────────────
   The projection above is a PURE READ, and the check before this one is the
   proof of it. The sprint-date normalisation therefore sits one layer up, in
   `store.getPlan`, which is the first point above every consumer — the eight
   screens that print a date and the capacity grid that derives its day window
   from the same fields.

   These two checks pin the seam from both sides. Without the second, the first
   time anyone saved a holiday the derived end dates would be written into the
   database as though Jira had said them, and the raw values — the only thing
   that lets a wrong date be traced — would be gone for good. */

check('THE STORE HANDS OUT NORMALISED SPRINT DATES', () => {
  const plan = PLAN();
  imp.importAll({ snapshot: SNAPSHOT(), plan });
  store.invalidate();

  const out = store.getPlan();
  const s39 = out.sprints.find(s => s.id === 'S39');
  // 3 Sep → 16 Sep is Thu → Wed, already a clean fortnight, so it is untouched.
  assert.strictEqual(s39.end, '2026-09-16');
  assert.strictEqual(s39.jiraEnd, undefined, 'nothing added where nothing was wrong');

  // The TT week is Mon → Mon: eight calendar days for a one-week sprint.
  const tt = out.sprints.find(s => s.id === 'J16178');
  assert.strictEqual(tt.end, '2026-05-22', `Fri 22 May, got ${tt.end}`);
  assert.strictEqual(tt.jiraEnd, '2026-05-25', 'and Jira\'s own date is kept');
  assert.strictEqual(tt.byTeam.ruby.end, '2026-05-22', 'the team\'s own copy too, from its OWN start');
  assert.strictEqual(tt.start, '2026-05-18', 'the start is never moved');
});

check('AND HIS OWN SPAN BEATS JIRA\'S, on the row AND on every team\'s copy', () => {
  /* The case this exists for: a sprint that really ran longer than Jira says.
     `reconcile.forTeam` prefers the TEAM's dates over the row's, so an
     override that reached only the row would fix the sprint list and leave
     every sprint screen on Jira's figure — the page disagreeing with itself. */
  const plan = PLAN();
  plan.sprintDates = { J16178: { start: '2026-05-18', end: '2026-06-03' } };
  imp.importAll({ snapshot: SNAPSHOT(), plan });
  store.invalidate();

  const tt = store.getPlan().sprints.find(s => s.id === 'J16178');
  assert.strictEqual(tt.start, '2026-05-18');
  assert.strictEqual(tt.end, '2026-06-03', `his end, got ${tt.end}`);
  assert.strictEqual(tt.jiraEnd, '2026-05-25', "and Jira's own end is kept, to trace it back");
  assert.strictEqual(tt.byTeam.ruby.end, '2026-06-03', "the team's copy is overridden too");

  // 18 May → 3 Jun is 17 days, which `snapToWeeks` leaves alone: 13 working days.
  const span = dates.normalise(tt);
  assert.strictEqual(span.workingDays, 13, `got ${span.workingDays}`);
});

check('AN OVERRIDE ENDING ON A WEEKEND STILL LEAVES JIRA\'S DATES RECOVERABLE', () => {
  /* The case that hides the leak. When his end date is already a working day,
     `applied` normalises to the same value and returns early — so it never
     touches the provenance `overridden` recorded, and a clobber there goes
     unnoticed. Give it an end that has to be normalised (a Saturday) and
     `applied` runs its assignment: if it overwrites `jiraEnd` with what it was
     handed, that is HIS date, `restored` writes it back as though Jira had
     said it, and the original is gone for good. That is not a display bug —
     it is his data, destroyed on the next save. */
  const plan = PLAN();
  plan.sprintDates = { J16178: { start: '2026-05-18', end: '2026-06-06' } };   // Sat
  imp.importAll({ snapshot: SNAPSHOT(), plan });
  store.invalidate();

  const tt = store.getPlan().sprints.find(s => s.id === 'J16178');
  assert.strictEqual(tt.end, '2026-06-05', `normalised to the Friday, got ${tt.end}`);
  assert.strictEqual(tt.jiraEnd, '2026-05-25', `Jira's own end, got ${tt.jiraEnd}`);

  store.savePlan(store.getPlan());
  store.invalidate();
  const row = db.get('SELECT start, end FROM calendar_sprint WHERE id = ?', 'J16178');
  assert.strictEqual(row.end, '2026-05-25', `Jira's end must survive the save, got ${row.end}`);
  assert.strictEqual(row.start, '2026-05-18');
});

check('and saving the plan writes JIRA\'S dates back, never his override', () => {
  /* The override is a READ-time decision. If a save persisted it, the next
     sync would find Jira's own dates already "agreeing" and the record of what
     Jira actually said would be gone for good. */
  const plan = PLAN();
  plan.sprintDates = { J16178: { start: '2026-05-18', end: '2026-06-03' } };
  imp.importAll({ snapshot: SNAPSHOT(), plan });
  store.invalidate();

  store.savePlan(store.getPlan());          // a read-modify-write, as every route does
  store.invalidate();

  const rawRow = db.get('SELECT start, end FROM calendar_sprint WHERE id = ?', 'J16178');
  assert.strictEqual(rawRow.start, '2026-05-18');
  assert.strictEqual(rawRow.end, '2026-05-25', `Jira's end must survive a save, got ${rawRow.end}`);
  // And the override is still in force on the next read.
  assert.strictEqual(store.getPlan().sprints.find(s => s.id === 'J16178').end, '2026-06-03');
});

check('AND WHAT GOES BACK IN IS WHAT JIRA SAID', () => {
  const plan = PLAN();
  imp.importAll({ snapshot: SNAPSHOT(), plan });
  store.invalidate();

  // Exactly what a route does: read the whole plan, change one field, save it.
  const edited = store.getPlan();
  store.savePlan({ ...edited, holidays: ['2026-12-25'] });
  store.invalidate();

  // The stored row still holds Jira's date, not the one the screen showed.
  const row = db.get("SELECT end FROM calendar_sprint WHERE id = 'J16178'");
  assert.strictEqual(row.end, '2026-05-25', `the database keeps Jira's date, got ${row.end}`);
  const team = db.get("SELECT end FROM calendar_sprint_team WHERE sprint_id = 'J16178'");
  assert.strictEqual(team.end, '2026-05-25', 'and so does the team row');
  // And no derived key leaked in as a column of its own.
  assert.ok(!('jiraEnd' in row), 'jiraEnd is a read-time field, never a stored one');
  // The edit itself landed.
  assert.deepStrictEqual(store.getPlan().holidays, ['2026-12-25']);
});

check('THE SNAPSHOT COMES BACK EXACTLY AS IT WENT IN', () => {
  const snapshot = SNAPSHOT();
  imp.importAll({ snapshot, plan: PLAN() });
  const out = project.snapshot();
  // Issues carry three keys the database adds and the JSON never had — where
  // the row came from, when it was last synced, and the extra-fields bag. They
  // are new information, not changed information, so they are removed before
  // the comparison rather than quietly tolerated by a loose comparison.
  for (const i of Object.values(out.issues)) {
    delete i.source; delete i.syncedAt; delete i.extra;
    if (!i.sprintIds.length && !snapshot.issues[i.key].sprintIds.length) i.sprintIds = snapshot.issues[i.key].sprintIds;
  }
  /* A BLOCKING LINK IS NORMALISED ON THE WAY IN, and that is deliberate. An
     export taken before blockers carried their summary holds bare keys; the
     store keeps every link as `{key, summary, type}`, so importing an older
     file upgrades the shape. No information is lost — a bare key simply has
     no summary to carry — so the keys are compared and the shape is not. */
  for (const i of Object.values(out.issues)) {
    const was = snapshot.issues[i.key].blockedBy || [];
    assert.deepStrictEqual(
      (i.blockedBy || []).map(l => (l && typeof l === 'object' ? l.key : l)),
      was.map(l => (l && typeof l === 'object' ? l.key : l)),
      `${i.key}: a blocker was lost or renamed importing an older export`);
    i.blockedBy = was;
  }
  same(snapshot, out, 'snapshot');
});

check('team members keep the order they were added, not alphabetical order', () => {
  imp.importAll({ snapshot: SNAPSHOT(), plan: PLAN() });
  assert.deepStrictEqual(
    project.plan().teams[0].members.map(m => m.name),
    ['Thao Dang', 'Abiran Lopez'],
    'alphabetising the members reorders every row of the capacity grid',
  );
});

check('boards keep Jira\'s order, so the picker does not renumber itself', () => {
  imp.importAll({ snapshot: SNAPSHOT(), plan: PLAN() });
  assert.deepStrictEqual(project.snapshot().boards.map(b => b.id), ['2356', '2093']);
});

check('exclusions keep the order they were excluded in', () => {
  imp.importAll({ snapshot: SNAPSHOT(), plan: PLAN() });
  assert.deepStrictEqual(project.plan().excluded.ruby, ['acc-zzz', 'acc-aaa', 'An Nguyen']);
});

check('a sprint on an issue keeps its own start and end', () => {
  imp.importAll({ snapshot: SNAPSHOT(), plan: PLAN() });
  const s = project.snapshot().issues['AUTOKAT-1'].sprints[0];
  assert.strictEqual(s.start, '2026-09-03T02:22:43.935Z');
  assert.strictEqual(s.end, '2026-09-16T14:27:27.000Z');
  // and the board's copy of the same sprint keeps the board's dates, which
  // are days rather than instants — these are two different records
  assert.strictEqual(project.snapshot().boardSprintsByTeam.ruby[0].start, '2026-09-03');
});

check('a sprint with no id does not grow one', () => {
  imp.importAll({ snapshot: SNAPSHOT(), plan: PLAN() });
  const s = project.snapshot().issues['AUTOKAT-2'].sprints[0];
  assert.ok(!('id' in s), `id: ${JSON.stringify(s.id)} appeared on a sprint that never had one`);
});

check('the flat sprint list is what work happened in, not what boards offer', () => {
  const snapshot = SNAPSHOT();
  // A third board sprint nobody has put an issue in yet.
  snapshot.boardSprintsByTeam.ruby.push({ id: '902', name: 'Katalon Ruby Sprint 41', state: 'future', start: null, end: null });
  imp.importAll({ snapshot, plan: PLAN() });
  const names = project.snapshot().sprints.map(s => s.name);
  assert.ok(!names.includes('Katalon Ruby Sprint 41'),
    'a sprint with no work in it leaked into the list of sprints work happened in');
  assert.strictEqual(names.length, 2);
});

check('`shared: false` survives, and `shared: true` is not invented', () => {
  imp.importAll({ snapshot: SNAPSHOT(), plan: PLAN() });
  const [numbered, dated] = project.plan().sprints;
  assert.strictEqual(dated.shared, false);
  assert.ok(!('shared' in numbered), 'shared: true appeared on a sprint that never carried the key');
});

check('a sprint you created here does not acquire a source', () => {
  imp.importAll({ snapshot: SNAPSHOT(), plan: PLAN() });
  const local = project.plan().sprints.find(s => s.id === 'S40');
  assert.ok(!('source' in local), 'a locally-created sprint was labelled as coming from Jira');
});

check('ROSTER DECISIONS SURVIVE — who you put on a sprint and who you took off', () => {
  const plan = PLAN();
  imp.importAll({ snapshot: SNAPSHOT(), plan });
  // Not rederivable from anything. A sync knows who was ASSIGNED work; only
  // this table knows that you decided someone belongs on the sprint anyway.
  same(plan.sprintRoster, project.plan().sprintRoster, 'sprintRoster');
  same(plan.componentPriority, project.plan().componentPriority, 'componentPriority');
});

check('a saved scenario survives with its numbers intact', () => {
  const plan = PLAN();
  imp.importAll({ snapshot: SNAPSHOT(), plan });
  same(plan.scenarios, project.plan().scenarios, 'scenarios');
});

check('THE LEAVE GRID SURVIVES CELL FOR CELL', () => {
  const plan = PLAN();
  imp.importAll({ snapshot: SNAPSHOT(), plan });
  // Not a count: the half-day in the last cell is the kind of thing a
  // round-trip through a number column would quietly turn into 0 or 1.
  assert.deepStrictEqual(project.plan().availability, plan.availability);
});

check('importing twice is refused rather than doubling the data', () => {
  imp.importAll({ snapshot: SNAPSHOT(), plan: PLAN() });
  assert.throws(() => imp.importAll({ snapshot: SNAPSHOT(), plan: PLAN() }), /already holds/);
});

check('a forced re-import replaces rather than accumulates', () => {
  imp.importAll({ snapshot: SNAPSHOT(), plan: PLAN() });
  imp.importAll({ snapshot: SNAPSHOT(), plan: PLAN(), force: true });
  assert.strictEqual(db.get('SELECT count(*) c FROM issue').c, 2);
  assert.strictEqual(db.get('SELECT count(*) c FROM team_member').c, 2);
  assert.strictEqual(db.get('SELECT count(*) c FROM availability').c, 1);
});

check('A FORCED RE-IMPORT DOES NOT DESTROY YOUR ADJUSTMENTS', () => {
  const repo = require('../lib/repo');
  imp.importAll({ snapshot: SNAPSHOT(), plan: PLAN() });
  repo.adjust('issue', 'AUTOKAT-1', 'points', 8, 'Re-estimated in planning');

  imp.importAll({ snapshot: SNAPSHOT(), plan: PLAN(), force: true });

  const adj = db.get(`SELECT * FROM adjustment WHERE entity_id = 'AUTOKAT-1' AND field = 'points'`);
  assert.ok(adj, 'a re-import wiped the record of a local edit');
  assert.strictEqual(db.fromJson(adj.value), 8);
  assert.strictEqual(db.fromJson(adj.jira_value), 5);
});

check('THE RECONCILE INDEX SURVIVES THE MIGRATION', () => {
  // Not decoration. byTeam is what every team-scoped screen reads, it is only
  // rebuilt by a sync or an explicit reconcile, and losing it leaves a database
  // that is complete and a tool that shows nothing.
  const snapshot = SNAPSHOT();
  snapshot.byTeam = { ruby: { boardId: '2093', sprints: [{ sprintId: 'S39', issueKeys: ['AUTOKAT-1'] }] } };
  imp.importAll({ snapshot, plan: PLAN() });
  same(snapshot.byTeam, project.snapshot().byTeam, 'byTeam');
});

check('a snapshot that has never been reconciled has no index, rather than an empty one', () => {
  imp.importAll({ snapshot: SNAPSHOT(), plan: PLAN() });
  assert.ok(!('byTeam' in project.snapshot()),
    'an empty index reads as "reconciled, nothing found" to the staleness banner');
});

check('verify reports what is short rather than just failing', () => {
  const plan = PLAN();
  const snapshot = SNAPSHOT();
  imp.importAll({ snapshot, plan });
  const v = imp.verify({ snapshot, plan });
  assert.ok(v.ok, `verify said short: ${JSON.stringify(v.short)}`);

  db.run(`DELETE FROM availability`);
  const after = imp.verify({ snapshot, plan });
  assert.ok(!after.ok);
  assert.strictEqual(after.short.length, 1);
  assert.match(after.short[0].what, /leave grid/);
});

check('an empty store imports to an empty database rather than throwing', () => {
  const counts = imp.importAll({ snapshot: {}, plan: {} });
  assert.strictEqual(counts.issues, 0);
  assert.strictEqual(counts.teams, 0);
  assert.deepStrictEqual(project.plan().teams, []);
  assert.deepStrictEqual(project.snapshot().issues, {});
});

check('board sprints for a team the plan no longer has are skipped, not fatal', () => {
  const snapshot = SNAPSHOT();
  snapshot.boardSprintsByTeam.deleted_team = [{ id: '999', name: 'Ghost Sprint 1', state: 'closed' }];
  const counts = imp.importAll({ snapshot, plan: PLAN() });
  assert.strictEqual(counts.sprintTeamLinks, 2, 'a sprint was linked to a team that does not exist');
  assert.ok(imp.verify({ snapshot, plan: PLAN() }).ok);
});

check('EVERY PLAN TABLE THE IMPORT FILLS IS ONE THE SAVE CLEARS', () => {
  /* Two lists that have to agree, and one of them had drifted. `persist.savePlan`
     wipes PLAN_TABLES and then re-imports; `import-json` wipes its own list on a
     full import. A plan table missing from the FIRST list is never cleared on a
     save, so a row can be written and never removed — which is exactly what
     happened to `calc_exempt`: ticking the toggle worked, clearing it did
     nothing, and the person stayed out of the capacity for good.

     Checked structurally rather than by naming the tables, so the next
     per-sprint table added cannot repeat it. */
  const persistSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'persist.js'), 'utf8');
  const importSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'import-json.js'), 'utf8');

  const listIn = (src, anchor2) => {
    const at = src.indexOf(anchor2);
    assert.ok(at > 0, `could not find ${anchor2}`);
    return new Set([...src.slice(at, src.indexOf(']', at)).matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
  };
  const saved = listIn(persistSrc, 'const PLAN_TABLES = [');
  const wiped = listIn(importSrc, "'issue_component', 'issue_label'");
  assert.ok(saved.size > 5 && wiped.size > 5, 'the lists did not parse');

  // Snapshot tables are Jira's and savePlan has no business touching them.
  const SNAPSHOT_ONLY = new Set(['issue_component', 'issue_label', 'issue_sprint', 'issue_link',
    'issue', 'sprint_team', 'sprint', 'board', 'person']);
  const missing = [...wiped].filter(t => !SNAPSHOT_ONLY.has(t) && !saved.has(t));
  assert.deepStrictEqual(missing, [],
    `re-imported on save but never cleared, so rows cannot be deleted: ${missing.join(', ')}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
db.close();
fs.rmSync(SCRATCH, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
