'use strict';
/**
 * fields.test.js — working out which Jira field is which.
 *
 * This exists because a name match got it wrong on the real instance and cost
 * the whole project its estimates. The rule under test is simple and the tests
 * keep it honest: NAME gets a field onto the shortlist, DATA decides.
 */

const assert = require('node:assert');
const F = require('../lib/fields');
const Q = require('../lib/query');
const S = require('../lib/search');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
console.log('\nJira field mapping\n');

/* ── AUTOKAT's real shape: two "Story Points", only one in use ─────────── */

const CATALOGUE = [
  { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
  { id: 'customfield_16012', name: 'Story Points', custom: true, schema: { type: 'number' } },
  { id: 'customfield_10016', name: 'Story point estimate', custom: true, schema: { type: 'number' } },
  { id: 'customfield_10905', name: 'Sprint', custom: true, schema: { type: 'array' } },
  { id: 'customfield_16513', name: 'Automation Status', custom: true, schema: { type: 'option' } },
  { id: 'customfield_11800', name: 'Team', custom: true, schema: { type: 'any' } },
  { id: 'customfield_99999', name: 'Abandoned Estimate', custom: true, schema: { type: 'number' } },
  { id: 'customfield_16410', name: 'Test Type', custom: true, schema: { type: 'option' } },
];

/** n issues where the LEGACY points field is empty and the team-managed one is not. */
function sample(n = 100) {
  return Array.from({ length: n }, (_, i) => ({
    key: `AUTOKAT-${i}`,
    fields: {
      summary: `Issue ${i}`,
      customfield_16012: null,                       // named "Story Points" — always empty
      customfield_10016: i % 2 ? 5 : 3,              // the one actually in use
      customfield_10905: [{ id: 900, name: 'Sprint 39' }],
      customfield_16513: i % 5 === 0 ? { value: 'Automated' } : null,
      customfield_11800: { name: 'Katalon Auto Ruby' },
      customfield_99999: null,
      customfield_16410: i % 3 === 0 ? { value: 'E2E' } : null,
    },
  }));
}

check('profiling counts what is actually populated', () => {
  const p = F.profile(CATALOGUE, sample(100));
  const by = Object.fromEntries(p.map(f => [f.id, f]));
  assert.strictEqual(by.customfield_10016.filled, 100);
  assert.strictEqual(by.customfield_16012.filled, 0, 'the legacy field is empty on every issue');
  assert.strictEqual(by.customfield_10016.fillRate, 100);
  assert.strictEqual(by.customfield_16513.filled, 20);
});

check('THE POPULATED FIELD WINS OVER THE NAME MATCH', () => {
  const r = F.recommend(F.profile(CATALOGUE, sample(100)));
  assert.strictEqual(r.storyPoints.recommended, 'customfield_10016',
    'picking "Story Points" by name is exactly the bug this replaces');
  assert.strictEqual(r.storyPoints.confident, true);
  assert.match(r.storyPoints.reason, /Populated on 100 of 100/);
});

check('…even when the empty field is listed first', () => {
  // Fed in the WRONG order on purpose. Relying on the upstream sort would make
  // the check above pass without the ranking doing any work — the first version
  // of this test did exactly that, and a mutation proved it could not fail.
  const profiled = [
    { id: 'customfield_16012', name: 'Story Points', custom: true, filled: 0, sampled: 100, fillRate: 0, numeric: true },
    { id: 'customfield_10016', name: 'Story point estimate', custom: true, filled: 100, sampled: 100, fillRate: 100, numeric: true },
  ];
  const list = F.candidatesFor(profiled, 'storyPoints');
  assert.strictEqual(list[0].id, 'customfield_10016', 'fill rate decides, not position and not the name');
  assert.strictEqual(F.recommend(profiled).storyPoints.recommended, 'customfield_10016');
});

check('an exact name match loses to a better-populated sibling', () => {
  // "Story Points" is the literal role name; "Story point estimate" is not.
  // Name got them both onto the shortlist; data has to settle it.
  const profiled = [
    { id: 'cf_named', name: 'Story Points', custom: true, filled: 3, sampled: 100, fillRate: 3, numeric: true },
    { id: 'cf_used', name: 'Story point estimate', custom: true, filled: 97, sampled: 100, fillRate: 97, numeric: true },
  ];
  assert.strictEqual(F.candidatesFor(profiled, 'storyPoints')[0].id, 'cf_used');
});

check('the currently configured field is called out when it is empty', () => {
  const r = F.recommend(F.profile(CATALOGUE, sample(100)), { storyPoints: 'customfield_16012' });
  assert.strictEqual(r.storyPoints.configuredFillRate, 0);
  assert.strictEqual(r.storyPoints.configuredLooksWrong, true, 'this is the diagnosis, stated plainly');
  assert.strictEqual(r.storyPoints.wouldChange, true);
});

check('a configured field that IS populated is left alone', () => {
  const r = F.recommend(F.profile(CATALOGUE, sample(100)), { storyPoints: 'customfield_10016' });
  assert.strictEqual(r.storyPoints.configuredLooksWrong, false);
  assert.strictEqual(r.storyPoints.wouldChange, false, 'no nagging when the mapping is already right');
});

check('every candidate empty is reported as doubt, not a confident pick', () => {
  const blank = sample(50).map(i => ({ ...i, fields: { ...i.fields, customfield_10016: null } }));
  const r = F.recommend(F.profile(CATALOGUE, blank));
  assert.strictEqual(r.storyPoints.confident, false);
  assert.match(r.storyPoints.reason, /empty on all 50/);
});

check('a tie is reported as a tie rather than picked arbitrarily', () => {
  const both = sample(40).map(i => ({ ...i, fields: { ...i.fields, customfield_16012: 3 } }));
  const r = F.recommend(F.profile(CATALOGUE, both));
  assert.strictEqual(r.storyPoints.confident, false);
  assert.match(r.storyPoints.reason, /equally populated/);
});

check('a missing role says the field does not exist on this Jira', () => {
  const noTeam = CATALOGUE.filter(f => f.name !== 'Team');
  const r = F.recommend(F.profile(noTeam, sample(20)));
  assert.strictEqual(r.team.recommended, null);
  assert.match(r.team.reason, /No field named "Team"/);
});

check('with no name match, populated numeric custom fields are still offered', () => {
  const renamed = CATALOGUE.map(f => (f.name === 'Story Points' || f.name === 'Story point estimate'
    ? { ...f, name: `Velocity Points ${f.id}` } : f));
  const r = F.recommend(F.profile(renamed, sample(30)));
  assert.strictEqual(r.storyPoints.recommended, 'customfield_10016',
    'a renamed field must not leave the user with nothing to choose from');
});

check('0 and false count as values; empty string, [] and null do not', () => {
  assert.strictEqual(F.hasValue(0), true, 'a zero estimate is an estimate');
  assert.strictEqual(F.hasValue(false), true);
  assert.strictEqual(F.hasValue(''), false);
  assert.strictEqual(F.hasValue([]), false);
  assert.strictEqual(F.hasValue(null), false);
  assert.strictEqual(F.hasValue({}), false);
});

check('the sample preview renders option and user objects readably', () => {
  assert.strictEqual(F.preview({ value: 'Automated' }), 'Automated');
  assert.strictEqual(F.preview({ displayName: 'Hien Phan' }), 'Hien Phan');
  assert.strictEqual(F.preview([{ name: 'Sprint 39' }, { name: 'Sprint 40' }]), '2 × Sprint 39');
});

check('a field in the sample but missing from the catalogue is still offered', () => {
  const s = sample(10).map(i => ({ ...i, fields: { ...i.fields, customfield_77777: 'surprise' } }));
  const p = F.profile(CATALOGUE, s);
  const found = p.find(f => f.id === 'customfield_77777');
  assert.ok(found, 'an out-of-date catalogue must not hide a field that clearly has data');
  assert.strictEqual(found.filled, 10);
});

/* ── the client asks Jira for the right things ────────────────────────── */

const { Jira } = require('../lib/jira');
const client = (cfg = {}) => new Jira({ baseUrl: 'https://x.local', email: 'a@b.c', apiToken: 't', projectKey: 'T', ...cfg });

check('the default field list is the fixed set plus the four mapped fields', () => {
  const j = client({ storyPointsField: 'cf_1', sprintField: 'cf_2' });
  const list = j.fieldList();
  assert.ok(list.includes('summary') && list.includes('cf_1') && list.includes('cf_2'));
  assert.ok(!list.includes('*navigable'));
});

check('extra fields are requested from Jira', () => {
  const j = client({ extraFields: [{ id: 'cf_9', name: 'Test Type', key: 'test-type' }] });
  assert.ok(j.fieldList().includes('cf_9'), 'a field you configured but never request will always be empty');
});

check('sync-all asks for *navigable instead of a list', () => {
  const j = client({ syncAllFields: true, storyPointsField: 'cf_1' });
  assert.deepStrictEqual(j.fieldList(), ['*navigable']);
});

check('extra values are flattened to something usable', () => {
  const j = client({ extraFields: [
    { id: 'cf_opt', name: 'Test Type', key: 'test-type' },
    { id: 'cf_arr', name: 'Squads', key: 'squads' },
    { id: 'cf_txt', name: 'Notes', key: 'notes' },
    { id: 'cf_num', name: 'Weight', key: 'weight' },
    { id: 'cf_gone', name: 'Never Set', key: 'never-set' },
  ] });
  const n = j.normalise({ key: 'X-1', fields: {
    cf_opt: { value: 'E2E' },
    cf_arr: [{ value: 'Ruby' }, { value: 'Titan' }],
    cf_txt: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }] },
    cf_num: 13,
    cf_gone: null,
  } });
  assert.strictEqual(n.extra['test-type'], 'E2E', 'an option object is not a filterable value');
  assert.deepStrictEqual(n.extra.squads, ['Ruby', 'Titan']);
  assert.strictEqual(n.extra.notes, 'hello world', 'rich text must become text');
  assert.strictEqual(n.extra.weight, 13);
  assert.ok(!('never-set' in n.extra), 'an empty field must not cost a key on every issue');
});

check('no extra fields configured means no extra key at all', () => {
  const n = client().normalise({ key: 'X-1', fields: { summary: 's' } });
  assert.ok(!('extra' in n), 'the snapshot should not grow for a feature nobody switched on');
});

/* ── extras reach the search language ─────────────────────────────────── */

check('a synced extra field becomes queryable by name', () => {
  const snap = {
    extraFields: [{ id: 'cf_opt', key: 'test-type', name: 'Test Type', filled: 2, total: 3 }],
    issues: {
      'A-1': { key: 'A-1', summary: 'a', extra: { 'test-type': 'E2E' } },
      'A-2': { key: 'A-2', summary: 'b', extra: { 'test-type': 'Unit' } },
      'A-3': { key: 'A-3', summary: 'c' },
    },
  };
  const r = S.search(snap, {}, 'test-type = E2E', { withFacets: false });
  assert.ok(!r.error, r.error);
  assert.deepStrictEqual(r.rows.map(x => x.key), ['A-1'],
    'a field you configured and synced but cannot filter on is one you did not really get');

  const empty = S.search(snap, {}, 'test-type IS EMPTY', { withFacets: false });
  assert.deepStrictEqual(empty.rows.map(x => x.key), ['A-3']);
});

check('an extra field becomes a chip with its own counts', () => {
  const snap = {
    extraFields: [{ id: 'cf_opt', key: 'test-type', name: 'Test Type', filled: 2, total: 3 }],
    issues: {
      'A-1': { key: 'A-1', extra: { 'test-type': 'E2E' } },
      'A-2': { key: 'A-2', extra: { 'test-type': 'E2E' } },
      'A-3': { key: 'A-3', extra: { 'test-type': 'Unit' } },
    },
  };
  const r = S.search(snap, {}, '', {});
  const f = Object.fromEntries((r.facets['test-type'] || []).map(x => [x.value, x.count]));
  assert.deepStrictEqual(f, { E2E: 2, Unit: 1 });
});

check('an extra field that arrived EMPTY is not offered', () => {
  const snap = {
    extraFields: [{ id: 'cf_x', key: 'ghost', name: 'Ghost', filled: 0, total: 3 }],
    issues: { 'A-1': { key: 'A-1' } },
  };
  const r = S.search(snap, {}, 'ghost = anything', { withFacets: false });
  assert.ok(r.error, 'offering a field with no data would be an error message waiting to happen');
  assert.match(r.error, /Unknown field/);
});

check('removing a field from the config stops it being queryable', () => {
  const withIt = { extraFields: [{ id: 'cf', key: 'temp', name: 'Temp', filled: 1 }], issues: { 'A-1': { key: 'A-1', extra: { temp: 'x' } } } };
  assert.ok(!S.search(withIt, {}, 'temp = x', { withFacets: false }).error);
  const without = { extraFields: [], issues: { 'A-1': { key: 'A-1', extra: { temp: 'x' } } } };
  assert.ok(S.search(without, {}, 'temp = x', { withFacets: false }).error,
    'a stale registration would outlive the config that created it');
});

check('an extra field can never shadow a built-in one', () => {
  Q.registerExtraFields([{ id: 'cf_bad', key: 'status', name: 'Status', filled: 10 }]);
  assert.strictEqual(Q.FIELDS.status.extra, undefined, 'status must keep meaning the issue status');
  Q.registerExtraFields([]);
});

check('extra fields appear as pickable columns', () => {
  const cols = S.columnsFor({ extraFields: [{ id: 'cf', key: 'test-type', name: 'Test Type', filled: 5 }] });
  assert.ok(cols.some(c => c.key === 'test-type' && c.label === 'Test Type'));
  assert.ok(cols.some(c => c.key === 'key'), 'the built-in columns must survive');
});


/* ── end to end: does pinning a field actually fix the zeros? ───────────
   Everything above tests the ADVICE. This tests the PROMISE: that choosing a
   field on the Fields screen changes what a sync stores. Without this, the
   screen could be perfectly right and still fix nothing. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-fields-'));
process.env.STORE_DIR = SCRATCH;
const store = require('../lib/store');
const sync = require('../lib/sync');

/**
 * A Jira where the name-matched field is EMPTY and another holds the estimates —
 * exactly the shape that cost AUTOKAT every one of its points.
 */
function fakeJira(seen) {
  const { Jira } = require('../lib/jira');
  return class extends Jira {
    constructor(cfg) { super(cfg); }
    async discoverFields() {
      // Name matching alone picks the legacy, empty field.
      this.storyPointsField = this.storyPointsField || 'customfield_16012';
      this.sprintField = this.sprintField || 'customfield_10905';
      return {
        storyPointsField: this.storyPointsField,
        storyPointsCandidates: ['customfield_16012', 'customfield_10016'],
        sprintField: this.sprintField,
        automationStatusField: null, teamField: null,
      };
    }
    async calibrateStoryPointsField(_p, { configured } = {}) {
      if (configured) return { field: configured, reason: 'configured', counts: [] };
      // Pretend the count check is unavailable, so the pin is the only fix.
      return { field: this.storyPointsField, reason: 'check failed', counts: [] };
    }
    async search(jql) {
      seen.fields = this.fieldList();
      if (!/sprint IS NOT EMPTY/.test(jql)) return [];
      return [1, 2, 3].map(n => this.normalise({
        key: `T-${n}`,
        fields: {
          summary: `Issue ${n}`,
          status: { name: 'Done', statusCategory: { key: 'done' } },
          customfield_16012: null,          // the legacy field: always empty
          customfield_10016: n * 2,         // the one actually in use
          customfield_16410: { value: 'E2E' },
          customfield_10905: [{ id: '900', name: 'S1', state: 'active' }],
        },
      }));
    }
    async count() { return { value: 3, exact: true }; }
    async boards() { return []; }
  };
}

const CFG = (extra) => ({ jira: { baseUrl: 'https://f.local', email: 'a@b.c', apiToken: 'x', projectKey: 'T', ...extra } });

/* These touch the store and the sync, so they are awaited properly rather than
   run through the synchronous `check` — a promise handed to that would report a
   pass before the assertion ran. */
const asyncChecks = [];
const checkAsync = (name, fn) => asyncChecks.push([name, fn]);

checkAsync('WITHOUT a pin, the name-matched empty field is used and every point is null', async () => {
  const mod = require('../lib/jira');
  const real = mod.Jira; const seen = {}; mod.Jira = fakeJira(seen);
  try {
    await sync.fullSync(CFG({}));
    const issues = Object.values(store.getSnapshot().issues);
    assert.ok(issues.length, 'the sync should still store issues');
    assert.ok(issues.every(i => i.points == null), 'this is the bug: the wrong field yields no estimates');
  } finally { mod.Jira = real; }
});

checkAsync('PINNING the populated field makes the points arrive', async () => {
  const mod = require('../lib/jira');
  const real = mod.Jira; const seen = {}; mod.Jira = fakeJira(seen);
  try {
    await sync.fullSync(CFG({ storyPointsField: 'customfield_10016' }));
    const issues = Object.values(store.getSnapshot().issues).sort((a, b) => a.key.localeCompare(b.key));
    assert.deepStrictEqual(issues.map(i => i.points), [2, 4, 6],
      'choosing the field on the Fields screen has to change what a sync stores, or the screen fixes nothing');
    assert.ok(seen.fields.includes('customfield_10016'), 'and the pinned id must be the one requested from Jira');
  } finally { mod.Jira = real; }
});

checkAsync('the estimation tripwire goes quiet once the right field is pinned', async () => {
  const mod = require('../lib/jira');
  const real = mod.Jira; mod.Jira = fakeJira({});
  try {
    await sync.fullSync(CFG({ storyPointsField: 'customfield_10016' }));
    const est = sync.summary(store.getSnapshot()).estimation;
    assert.strictEqual(est.fieldLooksWrong, false, 'the warning must stop once points are real');
    assert.strictEqual(est.nonZero, 3);
  } finally { mod.Jira = real; }
});

checkAsync('a pinned extra field is requested and stored against the issue', async () => {
  const mod = require('../lib/jira');
  const real = mod.Jira; const seen = {}; mod.Jira = fakeJira(seen);
  try {
    await sync.fullSync(CFG({
      storyPointsField: 'customfield_10016',
      extraFields: [{ id: 'customfield_16410', name: 'Test Type', key: 'test-type' }],
    }));
    assert.ok(seen.fields.includes('customfield_16410'), 'it has to be asked for');
    const one = Object.values(store.getSnapshot().issues)[0];
    assert.strictEqual((one.extra || {})['test-type'], 'E2E', 'and kept under its search key');
  } finally { mod.Jira = real; }
});

/* ── the pin has to keep winning ────────────────────────────────────────
   Found against his real store on 2026-09-14. He pinned customfield_10002 on
   the Fields screen, and his points stayed zero, because a sync BEFORE the pin
   had auto-detected the empty customfield_16012 into snapshot.fields — and the
   two incremental paths spread the snapshot AFTER the config, so the stale
   guess overrode the fresh decision on every run. The Fields screen appeared to
   do nothing at all. */

check('a pinned field beats the one the snapshot discovered', () => {
  const settings = sync.jiraSettings(
    { jira: { projectKey: 'T', storyPointsField: 'customfield_10002' } },
    { fields: { storyPointsField: 'customfield_16012', sprintField: 'customfield_10905' } },
  );
  assert.strictEqual(settings.storyPointsField, 'customfield_10002',
    'a decision you made must not be overridden by a guess a previous sync made');
  assert.strictEqual(settings.sprintField, 'customfield_10905',
    'and a field you did NOT pin should still come from the snapshot rather than being rediscovered');
});

check('unpinning a field falls back to the snapshot, not to nothing', () => {
  // The Fields screen writes an empty string to unpin. That means "go back to
  // auto-detection", not "use no field", and an empty value that overrode a
  // real one would turn unpinning into a way to break the sync.
  const settings = sync.jiraSettings(
    { jira: { projectKey: 'T', storyPointsField: '', automationStatusField: null } },
    { fields: { storyPointsField: 'customfield_16012', automationStatusField: 'customfield_16513' } },
  );
  assert.strictEqual(settings.storyPointsField, 'customfield_16012');
  assert.strictEqual(settings.automationStatusField, 'customfield_16513');
});

checkAsync('AN INCREMENTAL SYNC USES THE PINNED FIELD, not the one in the snapshot', async () => {
  const mod = require('../lib/jira');
  const real = mod.Jira; const seen = {}; mod.Jira = fakeJira(seen);
  try {
    // First sync with no pin: the snapshot records the empty legacy field.
    await sync.fullSync(CFG({}));
    assert.strictEqual(store.getSnapshot().fields.storyPointsField, 'customfield_16012',
      'setting the scene: the snapshot holds the wrong, auto-detected field');

    // Now he pins the right one and syncs again WITHOUT a full resync.
    await sync.incrementalSync(CFG({ storyPointsField: 'customfield_10016' }));
    assert.ok(seen.fields.includes('customfield_10016'),
      'the incremental sync asked Jira for the stale field — this is why his points stayed zero');
    assert.ok(!seen.fields.includes('customfield_16012'),
      'and it must stop asking for the one he replaced');
  } finally { mod.Jira = real; }
});

check('the tripwire names the field the NEXT sync will use, not the last one', () => {
  const snap = { issues: { 'A-1': { key: 'A-1', points: null } }, fields: { storyPointsField: 'customfield_16012' } };
  const est = sync.summary(snap, { jira: { storyPointsField: 'customfield_10002' } }).estimation;
  assert.strictEqual(est.field, 'customfield_10002',
    'naming the field he just replaced told him the pin had not taken effect');
  assert.strictEqual(est.staleField, 'customfield_16012',
    'and the old one has to be named too, or "run a full sync" has no reason attached');
});

check('no stale-field warning when the pin and the data agree', () => {
  const snap = { issues: { 'A-1': { key: 'A-1', points: 3 } }, fields: { storyPointsField: 'customfield_10002' } };
  const est = sync.summary(snap, { jira: { storyPointsField: 'customfield_10002' } }).estimation;
  assert.strictEqual(est.staleField, null, 'a warning that is always on is a warning nobody reads');
});

check('no stale-field warning when nothing is pinned', () => {
  const snap = { issues: { 'A-1': { key: 'A-1', points: 3 } }, fields: { storyPointsField: 'customfield_16012' } };
  const est = sync.summary(snap, { jira: {} }).estimation;
  assert.strictEqual(est.staleField, null);
  assert.strictEqual(est.field, 'customfield_16012', 'with no pin, the snapshot is still the honest answer');
});

checkAsync('sync-all asks Jira for every navigable field', async () => {
  const mod = require('../lib/jira');
  const real = mod.Jira; const seen = {}; mod.Jira = fakeJira(seen);
  try {
    await sync.fullSync(CFG({ storyPointsField: 'customfield_10016', syncAllFields: true }));
    assert.deepStrictEqual(seen.fields, ['*navigable'],
      'the escape hatch has to actually widen the request');
  } finally { mod.Jira = real; }
});


(async () => {
  for (const [name, fn] of asyncChecks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
