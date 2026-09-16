'use strict';
/**
 * epics.test.js — which epic is a sprint item against?
 *
 * WHAT IS BEING PROMISED
 *
 * He gave two rules, and they are not the same rule wearing different clothes:
 *
 *   New implementation is a Story; its epic is the PARENT LINK.
 *   Maintenance has no parent; its epics are the LINKED ISSUES whose link type
 *   is "Relates to".
 *
 * Both of those facts were already arriving from Jira and both were being
 * discarded — `parent` was read for its key and status only, and `issuelinks`
 * was filtered down to blocked-by with the rest dropped on the floor. So this
 * suite covers the whole path, not just the rule: Jira payload → normalise →
 * database → read back → the resolved epic → the column in the table.
 *
 * THE ONE THAT WOULD HAVE BITTEN SILENTLY
 *
 * `issue_link` has always had a `kind` column and has only ever held one kind,
 * so `DELETE FROM issue_link WHERE issue_key = ?` was correct by accident. The
 * moment a second kind exists, rewriting an issue's blocked-by links wipes its
 * relates-to links with it — on every sync, with no error, and the Epic column
 * would empty itself hours after it was filled. That is checked directly.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-epics-'));
process.env.STORE_DIR = SCRATCH;
process.env.DB_FILE = path.join(SCRATCH, 'test.db');

const db = require('../lib/db');
const repo = require('../lib/repo');
const epics = require('../lib/epics');
const jira = require('../lib/jira');
const cls = require('../lib/classify');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fresh(); fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
console.log('\nEpics: the parent for new work, the relates-to link for maintenance\n');

function fresh() {
  db.close();
  for (const f of fs.readdirSync(SCRATCH)) fs.rmSync(path.join(SCRATCH, f), { force: true, recursive: true });
  db.openAt(path.join(SCRATCH, 'test.db'));
}

/* ── what Jira actually sends ─────────────────────────────────────────── */

/** One entry of `fields.issuelinks`, shaped the way the REST API shapes it. */
const link = (type, dir, key, summary, issueType) => ({
  type,
  [dir]: { key, fields: { summary, issuetype: { name: issueType } } },
});

const RELATES = { name: 'Relates', inward: 'relates to', outward: 'relates to' };
const BLOCKS = { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };

/* ── 1. the Jira edge ─────────────────────────────────────────────────── */

check('A "RELATES TO" LINK IS FOUND FROM EITHER SIDE', () => {
  // Jira's Relates type is symmetric — inward and outward are both the string
  // "relates to" — so which side an issue sits on is an accident of who made
  // the link. A filter that only read `inwardIssue`, the way the blocked-by
  // filter must, would find roughly half of them and nobody would know which.
  const out = jira.relatesLinks([
    link(RELATES, 'outwardIssue', 'AUTOKAT-100', 'Renewals regression suite', 'Epic'),
    link(RELATES, 'inwardIssue', 'AUTOKAT-200', 'Quoting regression suite', 'Epic'),
  ]);
  assert.deepStrictEqual(out.map(l => l.key), ['AUTOKAT-100', 'AUTOKAT-200'],
    'a relates-to link on the inward side is the same link as one on the outward side');
});

check('and a blocked-by link is not mistaken for one', () => {
  const out = jira.relatesLinks([link(BLOCKS, 'inwardIssue', 'AUTOKAT-9', 'Blocker', 'Bug')]);
  assert.deepStrictEqual(out, [], 'only "Relates to" counts — blocks, duplicates and clones are other relationships');
});

check('the linked issue\'s name and type come with it', () => {
  // Without these the column can only print a key, and an epic is very often
  // NOT one of the issues we sync — the sync selects this team's sprint work.
  const [l] = jira.relatesLinks([link(RELATES, 'outwardIssue', 'AUTOKAT-100', 'Renewals regression suite', 'Epic')]);
  assert.strictEqual(l.summary, 'Renewals regression suite');
  assert.strictEqual(l.type, 'Epic');
});

check('the parent\'s name and type survive normalisation', () => {
  const j = new jira.Jira({ baseUrl: 'https://x', email: 'e', token: 't', projectKey: 'AUTOKAT' });
  const issue = j.normalise({
    key: 'AUTOKAT-5',
    fields: {
      summary: 'Automate renewal quote',
      issuetype: { name: 'Story' },
      parent: { key: 'AUTOKAT-100', fields: { summary: 'Renewals regression suite', status: { name: 'In Progress' }, issuetype: { name: 'Epic' } } },
      issuelinks: [],
    },
  });
  assert.strictEqual(issue.parentKey, 'AUTOKAT-100');
  assert.strictEqual(issue.parentSummary, 'Renewals regression suite',
    'Jira hands the parent summary over inside `parent`; throwing it away costs an extra fetch to get it back');
  assert.strictEqual(issue.parentType, 'Epic');
});

/* ── 2. the store ─────────────────────────────────────────────────────── */

const ISSUE = (over = {}) => ({
  key: 'AUTOKAT-1', project: 'AUTOKAT', summary: 'Automate renewal quote',
  issueType: 'Story', status: 'In Dev', statusCategory: 'indeterminate',
  points: 3, blockedBy: ['AUTOKAT-2'],
  relatesTo: [{ key: 'AUTOKAT-100', summary: 'Renewals regression suite', type: 'Epic' }],
  ...over,
});

check('RELATES-TO LINKS SURVIVE A SYNC THAT REWRITES BLOCKED-BY', () => {
  // The bug this file exists to prevent. Both kinds live in `issue_link`, and
  // the delete that clears one kind before rewriting it did not name a kind.
  repo.upsertIssues([ISSUE()]);
  repo.upsertIssues([ISSUE({ blockedBy: ['AUTOKAT-3'] })]);   // a second sync

  const stored = repo.getIssue('AUTOKAT-1');
  assert.deepStrictEqual(stored.blockedBy, ['AUTOKAT-3'], 'blocked-by is rewritten from the new payload');
  assert.deepStrictEqual(stored.relatesTo.map(l => l.key), ['AUTOKAT-100'],
    'rewriting one kind of link must not delete the other kind — this is how the Epic column would empty itself');
});

check('the reverse too: rewriting relates-to leaves blocked-by alone', () => {
  repo.upsertIssues([ISSUE()]);
  repo.upsertIssues([ISSUE({ relatesTo: [{ key: 'AUTOKAT-200', summary: 'Quoting', type: 'Epic' }] })]);
  const stored = repo.getIssue('AUTOKAT-1');
  assert.deepStrictEqual(stored.blockedBy, ['AUTOKAT-2']);
  assert.deepStrictEqual(stored.relatesTo.map(l => l.key), ['AUTOKAT-200']);
});

check('a link keeps its name and type through the database', () => {
  repo.upsertIssues([ISSUE({ parentKey: 'AUTOKAT-100', parentSummary: 'Renewals regression suite', parentType: 'Epic' })]);
  const stored = repo.allIssues()['AUTOKAT-1'];
  assert.strictEqual(stored.parentSummary, 'Renewals regression suite');
  assert.strictEqual(stored.relatesTo[0].summary, 'Renewals regression suite');
  assert.strictEqual(stored.relatesTo[0].type, 'Epic');
});

check('allIssues and getIssue agree about links', () => {
  // Two separate queries build these; they have disagreed before over sprints.
  repo.upsertIssues([ISSUE()]);
  assert.deepStrictEqual(repo.allIssues()['AUTOKAT-1'].relatesTo, repo.getIssue('AUTOKAT-1').relatesTo);
});

check('an adjusted relates-to list is not overwritten by a sync', () => {
  repo.upsertIssues([ISSUE()]);
  repo.adjust('issue', 'AUTOKAT-1', 'relatesTo', [{ key: 'AUTOKAT-777', summary: 'The real epic', type: 'Epic' }], { by: 'me' });
  repo.upsertIssues([ISSUE()]);                              // Jira says AUTOKAT-100 again
  const stored = repo.getIssue('AUTOKAT-1');
  assert.deepStrictEqual(stored.relatesTo.map(l => l.key), ['AUTOKAT-777'],
    'a sync may never overwrite an adjusted field — that rule holds for the new relation too');
});

/* ── 3. the rule ──────────────────────────────────────────────────────── */

check('NEW IMPLEMENTATION TAKES ITS EPIC FROM THE PARENT LINK', () => {
  const out = epics.epicsFor({
    category: 'new', issueType: 'Story',
    parentKey: 'AUTOKAT-100', parentSummary: 'Renewals regression suite', parentType: 'Epic',
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].key, 'AUTOKAT-100');
  assert.strictEqual(out[0].name, 'Renewals regression suite');
  assert.strictEqual(out[0].via, 'parent');
  assert.strictEqual(out[0].unconfirmed, false, 'Jira told us the parent is an Epic, so nothing is being guessed');
});

check('MAINTENANCE TAKES ITS EPICS FROM THE "RELATES TO" LINKS', () => {
  const out = epics.epicsFor({
    category: 'maintenance',
    relatesTo: [
      { key: 'AUTOKAT-100', summary: 'Renewals regression suite', type: 'Epic' },
      { key: 'AUTOKAT-200', summary: 'Quoting regression suite', type: 'Epic' },
    ],
  });
  assert.deepStrictEqual(out.map(e => e.key), ['AUTOKAT-100', 'AUTOKAT-200'],
    'maintenance can maintain several epics at once — this is a list, not a field');
  assert.ok(out.every(e => e.via === 'relates'));
});

check('a maintenance ticket does not borrow a parent when it has relates-to links', () => {
  // The rule he gave is the rule. A parent on a maintenance ticket is usually
  // a bucket story, and quietly preferring it would put the wrong thing in the
  // column for every maintenance row that has both.
  const out = epics.epicsFor({
    category: 'maintenance',
    parentKey: 'AUTOKAT-999', parentType: 'Bucket Story',
    relatesTo: [{ key: 'AUTOKAT-100', type: 'Epic' }],
  });
  assert.deepStrictEqual(out.map(e => e.key), ['AUTOKAT-100']);
});

check('RELATED WORK THAT IS NOT AN EPIC IS NOT LISTED AS ONE', () => {
  // A maintenance ticket can relate to a duplicate, a support ticket, anything.
  // Where Jira told us the types and one of them IS an Epic, the others are
  // relations and this column says Epic.
  const out = epics.epicsFor({
    category: 'maintenance',
    relatesTo: [
      { key: 'AUTOKAT-50', summary: 'Flaky login spec', type: 'Bug' },
      { key: 'AUTOKAT-100', summary: 'Renewals regression suite', type: 'Epic' },
    ],
  });
  assert.deepStrictEqual(out.map(e => e.key), ['AUTOKAT-100']);
});

check('but nothing is dropped when no type is known', () => {
  // Older rows, or a Jira that did not return the type. Listing them tagged
  // `unconfirmed` is honest; silently emptying the column is not.
  const out = epics.epicsFor({
    category: 'maintenance',
    relatesTo: [{ key: 'AUTOKAT-50' }, { key: 'AUTOKAT-100' }],
  });
  assert.deepStrictEqual(out.map(e => e.key), ['AUTOKAT-50', 'AUTOKAT-100']);
  assert.ok(out.every(e => e.unconfirmed), 'unknown is not the same as confirmed, and must not be shown as it');
});

check('the type can come from the store when the link did not carry it', () => {
  const lookup = (k) => (k === 'AUTOKAT-100' ? { key: k, summary: 'Renewals regression suite', issueType: 'Epic' } : null);
  const out = epics.epicsFor({ category: 'maintenance', relatesTo: [{ key: 'AUTOKAT-50' }, { key: 'AUTOKAT-100' }] }, lookup);
  assert.deepStrictEqual(out.map(e => e.key), ['AUTOKAT-100']);
  assert.strictEqual(out[0].name, 'Renewals regression suite');
  assert.strictEqual(out[0].unconfirmed, false);
});

check('A TEST CASE LINKED FROM MAINTENANCE RESOLVES TO THE EPIC ABOVE IT', () => {
  // In AUTOKAT a maintenance ticket's "relates to" link often points at the
  // TEST CASE it maintains — that is how the maintenance-ratio metric reads
  // these links, and 953 of 1,013 of those test cases were the parent of a
  // "TCn: …" story rather than an epic. Printing a test-case key in a column
  // headed Epic is wrong; the epic above it is the answer.
  const store = {
    'AUTOKAT-77': { key: 'AUTOKAT-77', summary: 'TC12: renew a policy', issueType: 'Story', parentKey: 'AUTOKAT-100' },
    'AUTOKAT-100': { key: 'AUTOKAT-100', summary: 'Renewals regression suite', issueType: 'Epic' },
  };
  const out = epics.epicsFor({ category: 'maintenance', relatesTo: [{ key: 'AUTOKAT-77' }] }, k => store[k] || null);
  assert.deepStrictEqual(out.map(e => e.key), ['AUTOKAT-100']);
  assert.strictEqual(out[0].name, 'Renewals regression suite');
  assert.strictEqual(out[0].via, 'relates-parent', 'the extra hop is recorded, never passed off as the direct link');
});

check('but a directly linked epic is preferred over climbing', () => {
  // His rule is the rule. The climb is a fallback for when it finds nothing,
  // not a second opinion about links that already name an epic.
  const store = {
    'AUTOKAT-77': { key: 'AUTOKAT-77', issueType: 'Story', parentKey: 'AUTOKAT-999' },
    'AUTOKAT-999': { key: 'AUTOKAT-999', issueType: 'Epic' },
    'AUTOKAT-100': { key: 'AUTOKAT-100', issueType: 'Epic' },
  };
  const out = epics.epicsFor({ category: 'maintenance', relatesTo: [{ key: 'AUTOKAT-77' }, { key: 'AUTOKAT-100' }] }, k => store[k] || null);
  assert.deepStrictEqual(out.map(e => e.key), ['AUTOKAT-100']);
});

check('and a linked issue whose parent is not an epic is not climbed', () => {
  const store = {
    'AUTOKAT-77': { key: 'AUTOKAT-77', issueType: 'Story', parentKey: 'AUTOKAT-900' },
    'AUTOKAT-900': { key: 'AUTOKAT-900', issueType: 'Bucket Story' },
  };
  const out = epics.epicsFor({ category: 'maintenance', relatesTo: [{ key: 'AUTOKAT-77' }] }, k => store[k] || null);
  assert.deepStrictEqual(out.map(e => e.key), ['AUTOKAT-77'],
    'with nothing epic-shaped anywhere, report the link he asked for rather than an invented parent');
  assert.ok(out[0].unconfirmed);
});

check('a maintenance ticket with no links at all falls back to its parent', () => {
  const out = epics.epicsFor({ category: 'maintenance', parentKey: 'AUTOKAT-100', parentType: 'Epic' });
  assert.deepStrictEqual(out.map(e => e.key), ['AUTOKAT-100']);
  assert.strictEqual(out[0].via, 'parent', 'the fallback is recorded, never presented as the primary rule');
});

check('a story with no parent falls back to a related epic', () => {
  const out = epics.epicsFor({ category: 'new', relatesTo: [{ key: 'AUTOKAT-100', type: 'Epic' }] });
  assert.deepStrictEqual(out.map(e => e.key), ['AUTOKAT-100']);
  assert.strictEqual(out[0].via, 'relates');
});

check('an item with neither reports no epic rather than an empty one', () => {
  assert.deepStrictEqual(epics.epicsFor({ category: 'new' }), []);
  assert.deepStrictEqual(epics.epicsFor(null), []);
});

check('the same epic reached twice is listed once', () => {
  const out = epics.epicsFor({
    category: 'maintenance',
    relatesTo: [{ key: 'AUTOKAT-100', type: 'Epic' }, { key: 'AUTOKAT-100', type: 'Epic' }],
  });
  assert.strictEqual(out.length, 1);
});

/* ── 4. the category actually drives it ───────────────────────────────── */

check('THE CATEGORY, NOT THE ISSUE TYPE, PICKS THE RULE', () => {
  // The same issue, classified two ways, must resolve two different epics —
  // otherwise "new uses parent, maintenance uses links" is not implemented at
  // all and both halves happen to agree on this row by coincidence.
  const both = {
    parentKey: 'AUTOKAT-900', parentSummary: 'Bucket', parentType: 'Bucket Story',
    relatesTo: [{ key: 'AUTOKAT-100', summary: 'Renewals', type: 'Epic' }],
  };
  assert.deepStrictEqual(epics.epicsFor({ ...both, category: 'new' }).map(e => e.key), ['AUTOKAT-900']);
  assert.deepStrictEqual(epics.epicsFor({ ...both, category: 'maintenance' }).map(e => e.key), ['AUTOKAT-100']);
});

check('the shipped rules put a Story in "new" and a Maintenance label in "maintenance"', () => {
  // The epic rule is only as good as the category under it, so the two pieces
  // are checked joined rather than each in isolation.
  const story = { issueType: 'Story', summary: 'Automate renewal quote', labels: [], components: [] };
  const maint = { issueType: 'Task', summary: 'Fix flaky login spec', labels: ['Maintenance'], components: [] };
  assert.strictEqual(cls.classify(story, null), 'new');
  assert.strictEqual(cls.classify(maint, null), 'maintenance');
});

check('a rule on the "epic" field can finally match something', () => {
  // `issue.epicKey` never existed, so every rule written against this field
  // compared the empty string and silently never fired.
  assert.ok(cls.matches({ parentKey: 'AUTOKAT-100' }, { field: 'epic', op: 'equals', value: 'AUTOKAT-100' }));
});

/* ── 5. the roll-up ───────────────────────────────────────────────────── */

check('the roll-up counts an item against every epic it names', () => {
  const { rows, unmapped } = epics.rollup([
    { points: 3, epics: [{ key: 'E1', name: 'One' }] },
    { points: 5, epics: [{ key: 'E1' }, { key: 'E2', name: 'Two' }] },
    { points: 2, epics: [] },
  ]);
  assert.deepStrictEqual(rows.map(r => [r.key, r.points, r.count]), [['E1', 8, 2], ['E2', 5, 1]]);
  assert.strictEqual(rows[0].name, 'One', 'a name found on any one item names the epic for all of them');
  assert.strictEqual(unmapped, 1, 'items with no epic are counted, not hidden');
});

/* ── 6. the column ────────────────────────────────────────────────────── */

/* ── test cases under maintenance ─────────────────────────────────────────
   His rule, in his words: "1 bucket story maybe do the maintain 1 or more test
   cases … I count based on the Linked work items for that bucket story". One
   "relates to" link, one test case. */

check('A BUCKET STORY MAINTAINS ONE TEST CASE PER RELATES-TO LINK', () => {
  const b = { issueType: 'Bucket Story', relatesTo: [{ key: 'AUTOKAT-1' }, { key: 'AUTOKAT-2' }] };
  assert.strictEqual(epics.maintainedCount(b), 2, 'two linked work items is two test cases');
});

check('COUNTED FROM THE LINKS, NOT FROM THE EPIC COLUMN', () => {
  // `epicsFor` is trying to name the EPIC behind the work, so it drops links
  // that are not epics once it has found one. That is right for a column headed
  // Epic and wrong for a count of what is being maintained.
  //
  // The types are stated on the links themselves, so the two numbers differ
  // whatever lookup is passed — routing the count through `epicsFor` cannot
  // then coincide with the right answer under some other lookup, which is
  // exactly how an earlier version of this check passed while proving nothing.
  const b = {
    issueType: 'Bucket Story', category: 'maintenance',
    relatesTo: [
      { key: 'AUTOKAT-1', type: 'Test' },
      { key: 'AUTOKAT-2', type: 'Test' },
      { key: 'AUTOKAT-99', type: 'Epic' },
    ],
  };
  for (const lookup of [() => null, (k) => ({ key: k, issueType: 'Test' })]) {
    assert.strictEqual(epics.epicsFor(b, lookup).length, 1, 'fixture check: one epic among the links');
  }
  assert.strictEqual(epics.maintainedCount(b), 3, 'but three linked work items are three test cases');
});

check('the same link recorded twice is one test case', () => {
  // Jira holds a link from both sides, and a re-sync can bring back both.
  const b = { issueType: 'Bucket Story', relatesTo: [{ key: 'AUTOKAT-1' }, { key: 'autokat-1' }, 'AUTOKAT-1'] };
  assert.strictEqual(epics.maintainedCount(b), 1);
});

check('a bucket story with no links maintains nothing, and that is a real zero', () => {
  assert.strictEqual(epics.maintainedCount({ issueType: 'Bucket Story', relatesTo: [] }), 0);
  assert.strictEqual(epics.maintainedCount({ issueType: 'Bucket Story' }), 0);
});

check('ONLY A BUCKET STORY IS ASKED THE QUESTION', () => {
  // A Story can "relate to" a duplicate or a support ticket. Counting those as
  // test cases under maintenance would be a number that looks like data.
  assert.ok(epics.isBucketStory({ issueType: 'Bucket Story' }));
  assert.ok(epics.isBucketStory({ issueType: 'bucket story' }), 'Jira casing varies');
  assert.ok(!epics.isBucketStory({ issueType: 'Story' }));
  assert.ok(!epics.isBucketStory({ issueType: 'Epic' }));
  assert.ok(!epics.isBucketStory({}));
});

check('THE EPIC COLUMN SITS DIRECTLY AFTER COMPONENT, IN BOTH HEADER AND BODY', () => {
  // Asserted against the source because a column added to the header and not
  // the body — or added in a different position in each — shifts every cell in
  // the table one to the left and still renders without an error.
  // The table lives in ui.js now, shared by the Active sprint and Capacity
  // planning screens — which is also why this matters more than it did: a
  // column added to the header and not the body now misaligns two screens.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
  const table = src.slice(src.indexOf('function itemsTable'));

  const head = table.match(/<thead>.*?<\/thead>/s)[0];
  const cols = [...head.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(m => m[1].trim());
  assert.strictEqual(cols[cols.indexOf('Component') + 1], 'Epic',
    `Epic must follow Component, got ${JSON.stringify(cols)}`);

  const body = table.slice(table.indexOf('<tbody>'));
  const cells = [...body.matchAll(/<td[^>]*>/g)].length;
  assert.strictEqual(cells, cols.length,
    `${cols.length} headers but ${cells} cells — a table that renders perfectly with every value in the wrong column`);
  assert.ok(/<td[^>]*>\$\{epicCell\(i\)\}<\/td>/.test(body), 'the epic cell renders through epicCell');
});

check('the cell shows a dash rather than nothing when there is no epic', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
  const fn = src.slice(src.indexOf('function epicCell'), src.indexOf('function itemsTable'));
  assert.match(fn, /if \(!list\.length\) return/, 'an empty cell reads as a rendering bug to the person looking at it');
});

(async () => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
