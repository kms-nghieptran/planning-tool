'use strict';
/**
 * rules.test.js — the work-categorisation rules, now that he can edit them.
 *
 * WHY THIS SUITE EXISTS
 *
 * Every other bad edit in this tool announces itself. A bad categorisation rule
 * does not: it throws nothing, renders nothing red, and simply never matches —
 * the work falls through to "Other" and the work-mix split on Backlog, Forecast,
 * Active sprint and Search all move together, quietly, by the same amount. The
 * number on screen stays a number. That is the whole hazard of making this
 * panel editable, so these checks are aimed squarely at it:
 *
 *   1. the editor can only offer fields the matcher actually reads,
 *   2. the server refuses a rule that could never match, rather than storing it,
 *   3. a rule the tool no longer understands is shown as broken, never silently
 *      rewritten into a working rule that means something else,
 *   4. "wins" counts what a rule CLAIMS under first-match-wins, so a rule that
 *      has been shadowed into uselessness reads 0 instead of looking busy.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');

const cls = require('../lib/classify');

/* ── a store the server can be pointed at ──────────────────────────── */

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-rules-'));
fs.mkdirSync(path.join(SCRATCH, 'store'), { recursive: true });
process.env.STORE_DIR = SCRATCH;
process.env.DB_FILE = path.join(SCRATCH, 'store', 'test.db');
process.env.PORT = '0';

const issue = (key, over = {}) => ({
  key, project: 'T', summary: key, issueType: 'Story', status: 'Done', statusCategory: 'done',
  assignee: 'Hien Phan', assigneeId: 'acc-hien', points: 3, components: [], labels: [],
  sprints: [{ id: '938', name: 'Katalon Titan S38', state: 'closed' }], blockedBy: [],
  datasets: ['sprintWork'], ...over,
});

const ISSUES = [
  issue('T-1'),                                        // plain Story  → new
  issue('T-2', { labels: ['Maintenance'] }),           // → maintenance
  issue('T-3', { summary: 'Tech: upgrade the runner' }), // → technical
  issue('T-4', { issueType: 'Bucket Story', summary: 'Bucket' }), // → technical
  issue('T-5', { issueType: 'Defect', summary: 'A crash' }),      // → nothing, Other
];

fs.writeFileSync(path.join(SCRATCH, 'store', 'plan.json'), JSON.stringify({
  version: 1,
  teams: [{
    id: 'titan', name: 'Katalon Titan', jiraName: 'Katalon Auto Titan', boardId: '2092',
    jiraTeams: [], components: [], sprintKeywords: [],
    settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 },
    source: 'jira',
    members: [{ id: 'm1', name: 'Hien Phan', role: 'Auto QA', status: 'Active', supportPct: 0, jiraAccountId: 'acc-hien', source: 'jira' }],
  }],
  sprints: [{
    id: 'S38', number: 38, name: 'Sprint S38', start: '2026-08-20', end: '2026-09-02', source: 'jira',
    byTeam: { titan: { jiraId: '938', name: 'Katalon Titan S38', state: 'closed' } },
  }],
  holidays: [], availability: {}, support: {}, ceremony: {}, overrides: {},
  risks: [], notes: {}, excluded: {}, ignoredBoards: [], savedSearches: [],
  categoryRules: null, mixTargets: null, sprintRoster: {}, scenarios: [],
}));

fs.writeFileSync(path.join(SCRATCH, 'store', 'snapshot.json'), JSON.stringify({
  syncedAt: '2026-09-14T00:00:00Z', watermark: null, source: 'jira',
  issues: Object.fromEntries(ISSUES.map(i => [i.key, i])),
  sprints: [], components: [], testops: {}, github: {}, verification: [], fields: {},
  boards: [{ id: '2092', name: 'Katalon Auto Titan', type: 'scrum' }],
  boardSprintsByTeam: { titan: [{ id: '938', name: 'Katalon Titan S38', state: 'closed' }] },
  boardSprintErrors: [],
  people: [{ name: 'Hien Phan', accountId: 'acc-hien' }],
  byTeam: { titan: { sprintIssues: { 938: ISSUES.map(i => i.key) }, sprints: [], backlog: [], people: [] } },
}));

const { server } = require('../server.js');

let base = '';
const call = (method, p, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request(`${base}${p}`, {
    method,
    headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
  }, (res) => {
    let out = '';
    res.on('data', c => { out += c; });
    res.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch (_) { parsed = out; }
      resolve({ status: res.statusCode, body: parsed });
    });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

/** Leave the store the way each check found it — these run in one process. */
const restoreDefaults = () => call('PUT', '/api/category-rules', { rules: null });

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

console.log('\nEditable categorisation rules\n');

/* ══ 1. the vocabulary ═════════════════════════════════════════════════ */

check('EVERY FIELD THE EDITOR OFFERS IS A FIELD THE MATCHER READS', () => {
  // The failure this prevents: a dropdown listing "epicKey" while the matcher
  // has no such case. The rule saves, looks right in the table, and matches
  // nothing forever. One list, declared once, is the only fix that holds — so
  // this proves each offered field can actually carry a winning rule.
  // One issue carrying the token in every place a sync could put it, so each
  // field is asked the same question and only the matcher decides the answer.
  const probe = {
    labels: ['ZZTOKEN'], components: ['ZZTOKEN'], summary: 'ZZTOKEN', issueType: 'ZZTOKEN',
    automationStatus: 'ZZTOKEN', status: 'ZZTOKEN', parentKey: 'ZZTOKEN',
  };
  for (const f of cls.FIELDS) {
    assert.ok(cls.matches(probe, { field: f.key, op: 'equals', value: 'ZZTOKEN' }),
      `the editor offers "${f.key}" but the matcher cannot win on it — a rule on it would never match`);
  }
});

check('and every operator it offers is one the matcher implements', () => {
  for (const o of cls.OPS) {
    assert.ok(cls.matches({ summary: 'Maintenance: fix' }, { field: 'summary', op: o.key, value: 'Maintenance' })
      || cls.matches({ summary: 'Maintenance' }, { field: 'summary', op: o.key, value: 'Maintenance' }),
      `operator "${o.key}" is offered but matches nothing`);
  }
  // And the inverse: an operator that is NOT offered must not quietly work,
  // or the editor's list stops being the truth about what a rule can do.
  assert.ok(!cls.matches({ summary: 'abc' }, { field: 'summary', op: 'endsWith', value: 'bc' }),
    'an operator missing from OPS must not be secretly supported');
});

check('and every field the shipped defaults use is offered', () => {
  const offered = new Set(cls.FIELDS.map(f => f.key));
  const used = [...new Set(cls.DEFAULT_RULES.map(r => r.field))];
  assert.deepStrictEqual(used.filter(f => !offered.has(f)), [],
    'a default rule uses a field the editor cannot show, so opening Settings would rewrite it');
});

/* ══ 2. validation ═════════════════════════════════════════════════════ */

check('A RULE ON A FIELD THAT DOES NOT EXIST IS REFUSED, not stored', () => {
  const { errors } = cls.validateRules([{ field: 'epicKey', op: 'equals', value: 'X', category: 'new' }]);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /epicKey/, 'the message has to name the offending value');
  assert.strictEqual(errors[0].at, 1, 'and the row it is on');
});

check('a blank value is refused — it never matches on any operator', () => {
  // Proved rather than asserted: every operator on a blank value, on an issue
  // that has the field populated.
  for (const o of cls.OPS) {
    const hit = cls.matches({ summary: 'anything at all' }, { field: 'summary', op: o.key, value: '' });
    if (o.key === 'contains' || o.key === 'startsWith') {
      // These are true for the empty string by definition — which is precisely
      // why a blank value is dangerous rather than merely useless: such a rule
      // claims EVERY issue and files the whole sprint under one category.
      assert.ok(hit, `"${o.key}" with a blank value matches everything`);
    }
  }
  const { errors } = cls.validateRules([{ field: 'summary', op: 'contains', value: '  ', category: 'new' }]);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /value/i);
});

check('an unknown operator and an unknown category are each refused', () => {
  const { errors } = cls.validateRules([{ field: 'labels', op: 'matchesRegex', value: 'x', category: 'urgent' }]);
  assert.strictEqual(errors.length, 2, `expected one error each, got ${JSON.stringify(errors)}`);
  assert.ok(errors.some(e => /matchesRegex/.test(e.message)));
  assert.ok(errors.some(e => /urgent/.test(e.message)));
});

check('a good rule normalises and keeps its own id', () => {
  const { rules, errors } = cls.validateRules([{ id: 'mine', field: 'labels', op: 'includes', value: 'Maintenance', category: 'maintenance' }]);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(rules, [{ id: 'mine', field: 'labels', op: 'includes', value: 'Maintenance', category: 'maintenance' }]);
});

check('and two rules can never end up sharing an id', () => {
  // Ids are how a row is tracked while it is being moved. Two the same and the
  // hit counts land on the wrong row — the one number telling him the rule is
  // doing nothing.
  const { rules } = cls.validateRules([
    { id: 'r1', field: 'labels', op: 'includes', value: 'A', category: 'new' },
    { id: 'r1', field: 'labels', op: 'includes', value: 'B', category: 'new' },
  ]);
  assert.notStrictEqual(rules[0].id, rules[1].id, 'duplicate ids must be broken apart');
  assert.strictEqual(rules[0].value, 'A');
  assert.strictEqual(rules[1].value, 'B', 'and the rules themselves must not be reordered by that');
});

/* ══ 3. what a rule actually wins ══════════════════════════════════════ */

check('"WINS" COUNTS WHAT A RULE CLAIMS, NOT WHAT IT MATCHES', () => {
  // The distinction is the whole value of the column. Both rules below match
  // T-2; only the first one gets it. A count of "matches" would show 1 and 1
  // and tell him nothing about why his maintenance share is what it is.
  const rules = [
    { id: 'first', field: 'labels', op: 'includes', value: 'Maintenance', category: 'maintenance' },
    { id: 'shadowed', field: 'labels', op: 'includes', value: 'Maintenance', category: 'technical' },
  ];
  const hits = cls.ruleHits([{ labels: ['Maintenance'] }, { labels: ['Maintenance'] }], rules);
  assert.strictEqual(hits.byRule.first, 2);
  assert.strictEqual(hits.byRule.shadowed, 0,
    'a rule shadowed by one above it must read 0, not 2 — that zero is the only sign it is dead');
  assert.strictEqual(hits.unmatched, 0);
  assert.strictEqual(hits.total, 2);
});

check('and an issue no rule claims is counted as unmatched', () => {
  const hits = cls.ruleHits([{ issueType: 'Defect', labels: [], components: [], summary: 'x' }], cls.DEFAULT_RULES);
  assert.strictEqual(hits.unmatched, 1, 'work that falls through to Other has to be visible as a number');
  assert.strictEqual(Object.values(hits.byRule).reduce((a, b) => a + b, 0), 0);
});

/* ══ 4. the server ═════════════════════════════════════════════════════ */

check('THE SERVER REFUSES A RULE THAT COULD NEVER MATCH, and stores nothing', async () => {
  const before = (await call('GET', '/api/state')).body.plan.categoryRules;
  const r = await call('PUT', '/api/category-rules', {
    rules: [{ field: 'epicKey', op: 'equals', value: 'X', category: 'new' }],
  });
  assert.strictEqual(r.status, 400, 'a rule the matcher cannot read must not reach the plan');
  assert.match(r.body.error, /epicKey/);
  const after = (await call('GET', '/api/state')).body.plan.categoryRules;
  assert.deepStrictEqual(after, before, 'a refused write must leave the rules exactly as they were');
});

check('and refuses an empty list, which would file every issue under Other', async () => {
  const r = await call('PUT', '/api/category-rules', { rules: [] });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /at least one/i);
});

check('A SAVED RULE CHANGES THE CATEGORY ON THE SPRINT SCREEN', async () => {
  // End to end, over HTTP. T-5 is a Defect: no shipped rule claims it, so it
  // reads "other" today. One new rule and it is support — which is exactly the
  // thing he asked for, checked on the payload a screen renders rather than on
  // the model in isolation.
  const before = (await call('GET', '/api/sprint?team=titan&sprint=S38')).body.items.find(i => i.key === 'T-5');
  assert.strictEqual(before.category, 'other');

  const save = await call('PUT', '/api/category-rules', {
    rules: [...cls.DEFAULT_RULES, { id: 'mine', field: 'issueType', op: 'equals', value: 'Defect', category: 'support' }],
  });
  assert.strictEqual(save.status, 200, JSON.stringify(save.body));

  const after = (await call('GET', '/api/sprint?team=titan&sprint=S38')).body.items.find(i => i.key === 'T-5');
  assert.strictEqual(after.category, 'support', 'the rule he saved has to reach the screens that use it');

  assert.strictEqual(save.body.hits.byRule.mine, 1, 'and the reply says how much work it claimed');
  await restoreDefaults();
});

check('and resetting puts the shipped defaults back', async () => {
  await call('PUT', '/api/category-rules', {
    rules: [{ id: 'only', field: 'issueType', op: 'equals', value: 'Story', category: 'support' }],
  });
  const custom = (await call('GET', '/api/state')).body.plan.categoryRules;
  assert.strictEqual(custom.length, 1, 'precondition: his own rules are in force');

  const r = await call('PUT', '/api/category-rules', { rules: null });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.reset, true);
  const back = (await call('GET', '/api/state')).body.plan.categoryRules;
  assert.strictEqual(back, null, 'null means "follow the shipped defaults", not "no rules at all"');

  const item = (await call('GET', '/api/sprint?team=titan&sprint=S38')).body.items.find(i => i.key === 'T-1');
  assert.strictEqual(item.category, 'new', 'and the defaults are classifying again');
});

check('PREVIEW ANSWERS WITHOUT SAVING', async () => {
  // The guardrail that makes this editor safe to use: first match wins, so a
  // rule dropped in at the top can swallow work three other rules used to
  // claim. Seeing that BEFORE it is the live split is the point.
  const rules = [
    { id: 'greedy', field: 'status', op: 'equals', value: 'Done', category: 'support' },
    ...cls.DEFAULT_RULES,
  ];
  const r = await call('POST', '/api/category-rules/preview', { rules });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.errors, []);
  assert.strictEqual(r.body.hits.byRule.greedy, ISSUES.length,
    'the preview has to show the rule taking the work the others used to win');
  assert.strictEqual(r.body.mix.byCategory.support.count, ISSUES.length, 'and what that does to the mix');
  assert.strictEqual(r.body.hits.byRule.r1, 0, 'and the rules it has just shadowed reading 0');

  assert.strictEqual((await call('GET', '/api/state')).body.plan.categoryRules, null,
    'a preview must not write anything — it is the thing you do before deciding');
});

check('and a preview of broken rules reports every problem instead of a mix', async () => {
  const r = await call('POST', '/api/category-rules/preview', {
    rules: [{ field: 'nope', op: 'nope', value: '', category: 'nope' }],
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.errors.length, 4, 'all four faults on one row, not just the first');
  assert.strictEqual(r.body.hits, null, 'and no numbers, which would look like the rules worked');
});

/* ══ 5. the editor as rendered ═════════════════════════════════════════ */

const SETTINGS = fs.readFileSync(path.join(__dirname, '..', 'public', 'views', 'settings.js'), 'utf8');

/**
 * Render Settings with the real `ui.js` and read back what the rule editor put
 * on the page — the rows are written after the template, into `#ruleRows`, so
 * the check has to see through a querySelector the way the browser does.
 */
async function renderSettings(stateOver = {}) {
  const captured = {};
  const el = (sel) => ({
    addEventListener() {}, value: '', hidden: false, dataset: {}, style: {}, disabled: false,
    files: [], setAttribute() {}, getAttribute: () => null, select() {}, click() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    set innerHTML(v) { captured[sel] = v; }, get innerHTML() { return captured[sel] || ''; },
    querySelector: (s) => el(s), querySelectorAll: () => [], contains: () => true,
  });
  let html = '';
  const ctx = {
    console, Promise, setTimeout, clearTimeout, encodeURIComponent, CSS: { escape: String },
    confirm: () => true, prompt: () => '',
    App: { refresh() {} },
    Charts: new Proxy({}, { get: () => () => '' }),
    document: { createElement: () => el('new'), querySelector: () => el('doc'), querySelectorAll: () => [] },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);

  const state = (await call('GET', '/api/state')).body;
  Object.assign(state, stateOver);
  ctx.UI.api = async (p) => (p.startsWith('/api/audit') ? { entries: [] } : state);

  vm.runInContext(`${SETTINGS}\n;globalThis.__s = SettingsView;`, ctx);
  const clicks = [];
  const sent = [];
  ctx.UI.jsonPut = async (p, b) => { sent.push(['PUT', p, b]); return { ok: true, hits: { byRule: {}, total: 0, unmatched: 0 } }; };
  ctx.UI.jsonPost = async (p, b) => { sent.push(['POST', p, b]); return { errors: [], hits: { byRule: {}, total: 0, unmatched: 0 }, mix: { byCategory: {} } }; };
  const mount = {
    style: {},
    addEventListener: (t, fn) => { if (t === 'click') clicks.push(fn); },
    querySelector: (s) => el(s), querySelectorAll: () => [],
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
  };
  await ctx.__s.render({ teamId: 'titan' }, mount);
  /** Fire a click the way the browser would, at a target `closest` resolves. */
  const click = async (act, data = {}) => {
    const t = { dataset: { act, ...data }, closest: (sel) => (/\[data-act\]/.test(sel) ? t : null) };
    for (const fn of clicks.slice()) await fn({ target: t, preventDefault() {} });
    await new Promise(r => setTimeout(r, 5));
  };
  return {
    html, state, click, sent,
    get rows() { return captured['#ruleRows'] || ''; },
    get status() { return captured['#ruleStatus'] || ''; },
  };
}

/** The option values inside the Nth `<select data-k="…">` of each row. */
const optionValues = (rowsHtml, k) => {
  const sel = rowsHtml.match(new RegExp(`<select data-k="${k}"[^>]*>([\\s\\S]*?)</select>`));
  if (!sel) return null;
  return [...sel[1].matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
};

check('THE EDITOR OFFERS EXACTLY THE MATCHER\'S OWN VOCABULARY', async () => {
  const { rows } = await renderSettings();
  assert.ok(rows, 'the rule rows have to be rendered into #ruleRows');

  assert.deepStrictEqual(optionValues(rows, 'field'), cls.FIELDS.map(f => f.key),
    'the field dropdown must come from FIELDS — a hand-kept second list is how a dead rule gets saved');
  assert.deepStrictEqual(optionValues(rows, 'op'), cls.OPS.map(o => o.key));
  assert.deepStrictEqual(optionValues(rows, 'category'), Object.keys(cls.CATEGORIES));
});

check('with one editable row per rule, in order, carrying its stored values', async () => {
  const { rows } = await renderSettings();
  const trs = rows.split('<tr').slice(1);
  assert.strictEqual(trs.length, cls.DEFAULT_RULES.length, 'one row per rule');

  cls.DEFAULT_RULES.forEach((r, i) => {
    assert.match(trs[i], new RegExp(`<option value="${r.field}" selected>`),
      `row ${i + 1} must open on its own field, not on the first one in the list`);
    assert.match(trs[i], new RegExp(`value="${r.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
      `row ${i + 1} must carry its own value`);
    assert.match(trs[i], new RegExp(`<option value="${r.category}" selected>`));
  });
});

check('A RULE THE TOOL NO LONGER UNDERSTANDS IS SHOWN AS BROKEN, never quietly rewritten', async () => {
  // The nastiest shape in this whole feature. A stored rule names a field this
  // build dropped; a dropdown with no matching option renders with the FIRST
  // option selected, and the next save writes that one back. His rule is gone,
  // replaced by a working rule that means something else, and the only sign is
  // the mix moving.
  const { rows } = await renderSettings({
    plan: Object.assign({}, (await call('GET', '/api/state')).body.plan, {
      categoryRules: [{ id: 'old', field: 'epicKey', op: 'equals', value: 'AUTOKAT-1', category: 'new' }],
    }),
  });
  assert.match(rows, /<option value="epicKey" selected>/,
    'the unknown field must stay selected so a save cannot silently replace it');
  assert.match(rows, /epicKey[^<]*not recognised/,
    'and be labelled, so he can see which rule stopped working');
  assert.ok(!/<option value="labels" selected>/.test(rows),
    'the first option must not be the one selected — that is the silent rewrite');
});

check('and the win counts come from the server, with a shadowed rule reading 0', async () => {
  const { rows, status, state } = await renderSettings();
  const wins = [...rows.matchAll(/class="num rule-wins">([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
  const expected = cls.DEFAULT_RULES.map(r => String((state.ruleHits.byRule || {})[r.id] || 0));
  assert.deepStrictEqual(wins, expected, 'each row shows its own rule\'s count');
  assert.ok(wins.includes('0'), 'the fixture has rules that win nothing — those are the ones worth seeing');
  assert.match(status, /match no rule/, 'and the unmatched pile is named, not left implied');
});

check('SAVE SENDS THE RULES TO THE ROUTE THAT VALIDATES THEM', async () => {
  // PUT /api/plan merges whatever it is handed. Pointing Save at it would put
  // the editor's whole output past the only check that exists, and a rule that
  // never matches would be stored with nothing refusing it.
  const r = await renderSettings();
  await r.click('rules-save');
  const puts = r.sent.filter(([m]) => m === 'PUT');
  assert.strictEqual(puts.length, 1, `one save, one request (got ${JSON.stringify(puts)})`);
  assert.strictEqual(puts[0][1], '/api/category-rules', 'the validating route, not the merge-anything one');
  assert.strictEqual(puts[0][2].rules.length, cls.DEFAULT_RULES.length);
});

check('and moving a rule changes the ORDER that is saved, which is its meaning', async () => {
  // First match wins, so ↑/↓ is not cosmetic: it is the only way to say which
  // of two overlapping rules claims the work.
  const r = await renderSettings();
  const first = cls.DEFAULT_RULES[0], second = cls.DEFAULT_RULES[1];
  await r.click('rule-down', { i: '0' });
  await r.click('rules-save');
  const saved = r.sent.find(([m, p]) => m === 'PUT' && p === '/api/category-rules')[2].rules;
  assert.strictEqual(saved[0].id, second.id, 'the rule below must now be first');
  assert.strictEqual(saved[1].id, first.id);
  assert.strictEqual(saved.length, cls.DEFAULT_RULES.length, 'and nothing lost on the way');
});

check('and a deleted rule is gone from what is saved, after a confirmation', async () => {
  const r = await renderSettings();
  const doomed = cls.DEFAULT_RULES[2];
  await r.click('rule-del', { i: '2' });
  await r.click('rules-save');
  const saved = r.sent.find(([m, p]) => m === 'PUT' && p === '/api/category-rules')[2].rules;
  assert.strictEqual(saved.length, cls.DEFAULT_RULES.length - 1);
  assert.ok(!saved.some(x => x.id === doomed.id), 'the deleted rule must not be in the payload');
  assert.match(r.rows, /data-i="0"/, 'and the table renumbers rather than leaving a hole');
});

check('EVERY BUTTON IN THE EDITOR REACHES A BRANCH THAT EXISTS', async () => {
  // Found in a real browser, not here: "Add rule" was `data-act="rules-add"`
  // and the handler tested for `rule-add`. Clicking it did nothing at all —
  // no error, no toast, no row. A check that merely looked for the attribute in
  // the HTML passed the whole time, which is why this one clicks instead.
  const rowsOf = (h) => h.split('<tr').length - 1;
  const cases = [
    ['rules-add', {}, async (r, before) => assert.strictEqual(rowsOf(r.rows), rowsOf(before.rows) + 1, 'Add rule must add a row')],
    ['rule-del', { i: '0' }, async (r, before) => assert.strictEqual(rowsOf(r.rows), rowsOf(before.rows) - 1, 'Delete must remove a row')],
    ['rule-down', { i: '0' }, async (r) => assert.match(r.rows.split('<tr')[1], new RegExp(`value="${cls.DEFAULT_RULES[1].value}"`), 'Move down must reorder')],
    ['rule-up', { i: '1' }, async (r) => assert.match(r.rows.split('<tr')[1], new RegExp(`value="${cls.DEFAULT_RULES[1].value}"`), 'Move up must reorder')],
    ['rules-preview', {}, async (r) => assert.ok(r.sent.some(([m, p]) => m === 'POST' && p === '/api/category-rules/preview'), 'Preview must ask the server')],
    ['rules-save', {}, async (r) => assert.ok(r.sent.some(([m, p]) => m === 'PUT' && p === '/api/category-rules'), 'Save must write')],
    ['rules-reset', {}, async (r) => assert.ok(r.sent.some(([m, p, b]) => m === 'PUT' && p === '/api/category-rules' && b.rules === null), 'Reset must send null, which is what "use the defaults" means')],
  ];
  for (const [act, data, expect] of cases) {
    const r = await renderSettings();
    const before = { rows: r.rows };
    await r.click(act, data);
    await expect(r, before);
  }
});

check('and the panel no longer tells him to hand-edit plan.json', async () => {
  const { html } = await renderSettings();
  assert.ok(!/Edit these in/.test(html),
    'the instruction to edit the file by hand has to go, or the editor is not the answer');
});

/* ── run ───────────────────────────────────────────────────────────── */

server.listen(0, '127.0.0.1', async () => {
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  server.close();
  try { require('../lib/db').close(); } catch (_) { /* fine */ }
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
