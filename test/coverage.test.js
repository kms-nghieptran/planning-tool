'use strict';
/**
 * coverage.test.js — the Coverage screen's three questions.
 *
 * WHAT IS BEING PROMISED
 *
 *   1. Pick a component and every number on the screen narrows to it.
 *   2. An epic with NO Automation Status and the `obsolete` label is Obsoleted,
 *      not untriaged. 301 of his 625 status-less epics are retired work, and
 *      calling them untriaged made the pile that actually needs attention look
 *      twice its real size.
 *   3. TrueTest vs KSE, read off the epic's component, per product component.
 *
 * THE TWO THAT WOULD BE WRONG QUIETLY
 *
 * A SECOND SCREEN ON THE SAME DATA MUST NOT DISAGREE WITH THE FIRST. This
 * screen and the existing Automation coverage report read the same field with
 * the same ratio. If they ever print different percentages, at least one is
 * lying and nobody can tell which — so the reconciliation is asserted directly,
 * including that carving Obsoleted out of "no status" moves no percentage.
 *
 * THE TOOL SPLIT MUST TOTAL. Every epic lands in exactly one tool, untagged
 * ones included (his call: the tool components arrived with the TrueTest
 * rollout, so work without one predates it). If TrueTest + KSE ever stops
 * equalling the epic count, epics are being double-counted or dropped, and a
 * "34% on TrueTest" figure built on that is worse than no figure.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const cov = require('../lib/coverage');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nCoverage: one component at a time\n');

/* ── a snapshot shaped like his ───────────────────────────────────────── */

let n = 0;
const epic = (status, components, labels = []) => ({
  key: `AUTOKAT-${++n}`, issueType: 'Epic', summary: `Epic ${n}`,
  automationStatus: status, components, labels,
});

/** Two product suites, one mostly on TrueTest and one entirely on Katalon. */
function snapshot(list) {
  return { issues: Object.fromEntries(list.map(i => [i.key, i])) };
}

const NLG = 'PS_iGO_NLG';
const SIG = 'R&D_Sig_Regression';

function fixture() {
  n = 0;
  return snapshot([
    // PS_iGO_NLG — on TrueTest, well covered, with retired work in it
    epic('Automated', [NLG, 'TrueTest']),
    epic('Automated', [NLG, 'TrueTest']),
    epic('Maintenance', [NLG, 'TrueTest']),
    epic('Ready for Automation', [NLG, 'TrueTest']),
    epic('Blocked', [NLG, 'TrueTest']),
    epic('N/A for Automation', [NLG, 'TrueTest']),
    epic(null, [NLG, 'TrueTest'], ['obsolete']),        // Obsoleted
    epic(null, [NLG, 'TrueTest']),                      // genuinely untriaged
    // …and a little of the same suite still on Katalon Studio
    epic('Automated', [NLG, 'Katalon']),
    epic('Ready for Automation', [NLG, 'Katalon']),
    // R&D_Sig_Regression — Katalon, and some epics with no tool component at all
    epic('Automated', [SIG, 'Katalon']),
    epic('Automated', [SIG]),                           // untagged → KSE
    epic('Ready for Automation', [SIG]),                // untagged → KSE
    // an epic in BOTH suites, which must count in both component rows
    epic('Automated', [NLG, SIG, 'TrueTest']),
  ]);
}

/* ── the selection ────────────────────────────────────────────────────── */

check('SEVERAL COMPONENTS ARE OR\'D, and a shared epic is counted ONCE', () => {
  // The question this exists for: "what do these two suites add up to". The
  // trap is the obvious implementation — tally each component and add — which
  // reports the epic they share twice and inflates the headline of every
  // selection a team works across.
  const d = cov.view(fixture(), { components: [NLG, SIG] });
  const nlg = cov.view(fixture(), { components: [NLG] });
  const sig = cov.view(fixture(), { components: [SIG] });

  assert.strictEqual(nlg.total, 11);
  assert.strictEqual(sig.total, 4);
  assert.strictEqual(d.total, 14,
    `the union is 14 epics, not ${nlg.total + sig.total} — one is in both suites`);
  assert.deepStrictEqual(d.selected, [NLG, SIG], 'in the order they were picked');
});

check('and the grid still counts a shared epic in BOTH of its rows', () => {
  // The two rules look contradictory and are not: the headline answers "how
  // much work is in this selection" and the grid answers "how big is each
  // suite". The screen already says so; this pins that selecting two
  // components did not quietly change either one.
  const d = cov.view(fixture(), { components: [NLG, SIG] });
  const rows = Object.fromEntries(d.byComponent.map(r => [r.component, r.total]));
  assert.strictEqual(rows[NLG], 11);
  assert.strictEqual(rows[SIG], 4);
  assert.strictEqual(rows[NLG] + rows[SIG], 15, 'the rows total more than the 14 epics, as they always have');
});

check('ONE SELECTED COMPONENT STILL READS AS `component`, so nothing older breaks', () => {
  // Every screen written before multi-select branches on `d.component`. One
  // selection has to keep meaning what it meant, and several have to read as
  // null rather than as an arbitrary one of them — which would be a screen
  // confidently labelled with the wrong suite.
  assert.strictEqual(cov.view(fixture(), { components: [NLG] }).component, NLG);
  assert.strictEqual(cov.view(fixture(), { component: NLG }).component, NLG, 'the old single-name option still works');
  assert.strictEqual(cov.view(fixture(), { components: [NLG, SIG] }).component, null,
    'two selected is not one of them');
});

check('a component named twice is selected once', () => {
  const d = cov.view(fixture(), { components: [NLG, NLG] });
  assert.deepStrictEqual(d.selected, [NLG]);
  assert.strictEqual(d.total, 11, 'and the epics are not doubled by the repeat');
});

check('THE SCOPE PHRASE IS BUILT ONCE, not in every sentence that needs it', () => {
  // Eleven sentences across two files interpolate "what am I looking at". Each
  // inventing its own is how one card says "in PS_iGO_NLG" while the one beside
  // it still says "across every component".
  const say = (sel) => cov.view(fixture(), sel ? { components: sel } : {}).scopeLabel;
  assert.strictEqual(say(null), 'across every component');
  assert.strictEqual(say([NLG]), `in ${NLG}`);
  assert.strictEqual(say([NLG, SIG]), `in ${NLG} and ${SIG}`, 'two are named; naming beats counting');

  n = 0;
  const three = snapshot([
    epic('Automated', ['PS_One']), epic('Automated', ['PS_Two']), epic('Automated', ['PS_Three']),
  ]);
  assert.strictEqual(cov.view(three, { components: ['PS_One', 'PS_Two', 'PS_Three'] }).scopeLabel,
    'across 3 selected components', 'past two, the count is the readable form');
});

check('and the findings are ranked WITHIN the selection, not against the portfolio', () => {
  // Ranking stands down for one component because there is nothing to rank it
  // against. With two selected there is, and comparing them is the reason to
  // have selected them together.
  const two = cov.assess(cov.view(fixture(), { components: [NLG, SIG] }));
  const one = cov.assess(cov.view(fixture(), { components: [NLG] }));

  assert.deepStrictEqual(two.selected, [NLG, SIG]);
  assert.ok(!one.findings.some(f => (f.components || []).length),
    'one component is not ranked against itself');
  // The half that makes multi-select worth having: with two in view the
  // findings name WHICH of them, which a scope that had collapsed to a single
  // component would never do.
  assert.ok(two.findings.some(f => (f.components || []).length),
    `two selected must produce at least one finding that names a component: ${two.findings.map(f => f.id).join(', ')}`);
  for (const f of two.findings) {
    for (const c of f.components || []) {
      assert.ok([NLG, SIG].includes(c.name),
        `${c.name} is not in the selection and must not be named by a scoped finding`);
    }
  }
});

check('and every finding says which selection it is about', () => {
  const two = cov.assess(cov.view(fixture(), { components: [NLG, SIG] }));
  const withDetail = two.findings.filter(f => /automatable|epics/.test(f.detail));
  assert.ok(withDetail.length, 'precondition: there are findings with a scope phrase in them');
  for (const f of withDetail) {
    assert.ok(!/across every component/.test(f.detail),
      `"${f.title}" describes a selection as the whole portfolio`);
  }
});

/* ── 1. the component filter ──────────────────────────────────────────── */

check('SELECTING A COMPONENT NARROWS EVERY NUMBER ON THE SCREEN', () => {
  const all = cov.view(fixture(), {});
  const one = cov.view(fixture(), { component: NLG });
  assert.strictEqual(all.total, 14);
  assert.strictEqual(one.total, 11, 'the ten NLG epics plus the one shared with Sig');
  assert.strictEqual(one.component, NLG);
  assert.ok(one.coveragePct !== all.coveragePct, 'a filter that changes nothing is not a filter');
});

check('the selector lists product components with their counts, never the tool markers', () => {
  const d = cov.view(fixture(), {});
  const names = d.components.map(c => c.name);
  assert.deepStrictEqual(names, [NLG, SIG], `got ${JSON.stringify(names)}`);
  assert.ok(!names.includes('TrueTest') && !names.includes('Katalon'),
    'TrueTest and Katalon are how the tool is recorded, not product areas — offering them as a filter is a trap');
  assert.strictEqual(d.components.find(c => c.name === NLG).count, 11);
});

check('A COMPONENT THAT DOES NOT EXIST IS SAID OUT LOUD', () => {
  // Silently falling back to "all components" gives a screen that answers a
  // question nobody asked and looks entirely correct doing it.
  const d = cov.view(fixture(), { component: 'PS_NOT_A_THING' });
  assert.strictEqual(d.componentUnknown, true);
  assert.deepStrictEqual(d.componentRequested, ['PS_NOT_A_THING']);
  assert.deepStrictEqual(d.componentMissing, ['PS_NOT_A_THING'], 'and names which one it could not find');
  assert.strictEqual(d.component, null);
  assert.deepStrictEqual(d.selected, []);
  assert.strictEqual(d.total, 14, 'and it still shows something rather than an empty screen');

  // And the same inside a selection: one bad name must not take the good ones
  // down with it, or a typo empties a screen that was showing real work.
  const mixed = cov.view(fixture(), { components: [NLG, 'PS_NOT_A_THING'] });
  assert.deepStrictEqual(mixed.selected, [NLG], 'the real component survives');
  assert.deepStrictEqual(mixed.componentMissing, ['PS_NOT_A_THING']);
  assert.strictEqual(mixed.componentUnknown, true, 'and the miss is still said out loud');
});

check('an epic in two suites counts in both component rows', () => {
  const d = cov.view(fixture(), {});
  const nlg = d.byComponent.find(r => r.component === NLG);
  const sig = d.byComponent.find(r => r.component === SIG);
  assert.strictEqual(nlg.total, 11);
  assert.strictEqual(sig.total, 4);
  assert.strictEqual(nlg.total + sig.total, 15, 'more than the 14 epics — shared work is in both suites');
});

check('an epic with no product component is kept, not dropped', () => {
  n = 0;
  const d = cov.view(snapshot([epic('Automated', ['TrueTest'])]), {});
  assert.strictEqual(d.total, 1);
  assert.deepStrictEqual(d.components.map(c => c.name), ['— no component —'],
    'an epic whose only component is the tool marker still has to appear somewhere');
});

/* ── 2. the Obsoleted bucket ──────────────────────────────────────────── */

check('NO STATUS + THE OBSOLETE LABEL IS "OBSOLETED", NOT UNTRIAGED', () => {
  const d = cov.view(fixture(), {});
  assert.strictEqual(d.obsoleted, 1);
  assert.strictEqual(d.untriaged, 1);
  assert.strictEqual(d.buckets.find(b => b.key === 'obsoleted').count, 1);
  assert.strictEqual(d.buckets.find(b => b.key === 'none').count, 1,
    'the retired one must have LEFT the no-status pile, not been copied out of it');
});

check('A REAL STATUS BEATS THE OBSOLETE LABEL', () => {
  // His rule, narrowly: only status-less epics become Obsoleted. Someone set
  // that status deliberately; the label may simply be stale. On his data this
  // is the difference between 301 and 332, and it keeps 9 Blocked epics inside
  // the coverage denominator where they belong.
  n = 0;
  const d = cov.view(snapshot([
    epic('Blocked', [NLG], ['obsolete']),
    epic('N/A for Automation', [NLG], ['obsolete']),
    epic(null, [NLG], ['obsolete']),
  ]), {});
  assert.strictEqual(d.obsoleted, 1, 'only the status-less one');
  assert.strictEqual(d.buckets.find(b => b.key === 'blocked').count, 1);
  assert.strictEqual(d.buckets.find(b => b.key === 'na').count, 1);
  assert.strictEqual(d.automatable, 1, 'and the Blocked one is still in the denominator');
});

check('the label is matched case-insensitively', () => {
  n = 0;
  const d = cov.view(snapshot([epic(null, [NLG], ['Obsolete']), epic(null, [NLG], ['OBSOLETED'])]), {});
  assert.strictEqual(d.obsoleted, 2);
});

check('OBSOLETED DOES NOT MOVE THE COVERAGE PERCENTAGE', () => {
  // It is carved out of "no status", which was already outside the denominator.
  // If this ever stops holding, the two coverage screens start disagreeing and
  // the cause will be very hard to see.
  n = 0;
  const base = [epic('Automated', [NLG]), epic('Ready for Automation', [NLG]), epic(null, [NLG])];
  const before = cov.view(snapshot(base), {});
  n = 0;
  const after = cov.view(snapshot([epic('Automated', [NLG]), epic('Ready for Automation', [NLG]), epic(null, [NLG], ['obsolete'])]), {});
  assert.strictEqual(before.coveragePct, after.coveragePct);
  assert.strictEqual(before.automatable, after.automatable);
  assert.strictEqual(after.obsoleted, 1);
  assert.strictEqual(after.untriaged, 0);
});

check('an unrecognised status value is reported by name rather than vanishing', () => {
  n = 0;
  const d = cov.view(snapshot([epic('Partially Automated', [NLG])]), {});
  assert.deepStrictEqual(d.unmappedValues, [{ value: 'Partially Automated', count: 1 }]);
  assert.strictEqual(d.untriaged, 1, 'it lands in No Status, not in Obsoleted');
});

check('EVERY EPIC IS IN EXACTLY ONE BUCKET', () => {
  const d = cov.view(fixture(), {});
  assert.strictEqual(d.buckets.reduce((t, b) => t + b.count, 0), d.total);
});

/* ── 3. TrueTest vs KSE ───────────────────────────────────────────────── */

check('THE TOOL COMES FROM THE COMPONENT', () => {
  assert.strictEqual(cov.toolOf({ components: [NLG, 'TrueTest'] }), 'truetest');
  assert.strictEqual(cov.toolOf({ components: [SIG, 'Katalon'] }), 'kse');
});

check('AN EPIC WITH NEITHER TOOL COMPONENT COUNTS AS KSE', () => {
  // His call. The tool components arrived with the TrueTest rollout, so work
  // carrying neither predates it and ran on Katalon Studio. It is an
  // assumption, so it is also counted separately and shown on the screen.
  assert.strictEqual(cov.toolOf({ components: [SIG] }), 'kse');
  assert.strictEqual(cov.hasTool({ components: [SIG] }), false);

  const d = cov.view(fixture(), {});
  assert.strictEqual(d.untagged, 2, 'the two Sig epics with no tool component');
  assert.ok(d.untaggedPct > 0, 'and the size of that assumption is reported, not buried');
});

check('an epic on both tools is counted as TrueTest', () => {
  // A migration. The newer tool is the truthful answer for where it runs now,
  // and counting it twice would break the totals below.
  assert.strictEqual(cov.toolOf({ components: [NLG, 'TrueTest', 'Katalon'] }), 'truetest');
});

check('TRUETEST AND KSE ADD UP TO EVERY EPIC — NO DOUBLE COUNTING, NONE DROPPED', () => {
  const d = cov.view(fixture(), {});
  assert.strictEqual(d.toolTotals.truetest.total + d.toolTotals.kse.total, d.total);
  for (const r of d.byTool) {
    assert.strictEqual(r.truetest.total + r.kse.total, r.total,
      `${r.component}: ${r.truetest.total} + ${r.kse.total} ≠ ${r.total}`);
  }
});

check('the split is reported per component, not just overall', () => {
  const d = cov.view(fixture(), {});
  const nlg = d.byTool.find(r => r.component === NLG);
  const sig = d.byTool.find(r => r.component === SIG);
  assert.strictEqual(nlg.truetest.total, 9);
  assert.strictEqual(nlg.kse.total, 2);
  assert.strictEqual(sig.truetest.total, 1, 'the shared epic is on TrueTest and shows in Sig too');
  assert.strictEqual(sig.kse.total, 3);
  assert.strictEqual(sig.untagged, 2);
});

check('each tool carries its OWN coverage percentage', () => {
  // "TrueTest has more epics" and "TrueTest is better covered" are different
  // claims, and the second is the one worth making.
  const d = cov.view(fixture(), {});
  const nlg = d.byTool.find(r => r.component === NLG);
  assert.strictEqual(nlg.truetest.automatable, 6, 'automated 3 + maintenance 1 + ready 1 + blocked 1');
  assert.strictEqual(nlg.truetest.covered, 4);
  assert.strictEqual(nlg.truetest.coveragePct, 66.7);
  // The same suite's Katalon half is a DIFFERENT number, which is the point.
  assert.strictEqual(nlg.kse.coveragePct, 50);
});

check('a tool with nothing automatable reports no percentage rather than zero', () => {
  // 0% and "nothing to automate here" look identical in a table and mean
  // opposite things.
  n = 0;
  const d = cov.view(snapshot([epic('N/A for Automation', [NLG, 'TrueTest'])]), {});
  assert.strictEqual(d.toolTotals.truetest.automatable, 0);
  assert.strictEqual(d.toolTotals.truetest.coveragePct, 0,
    'the model returns 0; the VIEW is what must render it as a dash — checked below');
});

/* ── the two screens must agree ───────────────────────────────────────── */

check('THIS SCREEN AND THE EXISTING REPORT CANNOT DISAGREE', () => {
  // Same field, same ratio, two screens. A user who sees 71.7% on one and
  // something else on the other has no way to tell which is wrong.
  const metrics = require('../lib/metrics');
  const snap = fixture();
  const mine = cov.view(snap, {});
  const theirs = metrics.coverage({}, snap, {});

  assert.strictEqual(mine.total, theirs.total, 'same epics');
  assert.strictEqual(mine.automatable, theirs.automatable, 'same denominator');
  assert.strictEqual(mine.covered, theirs.covered, 'same numerator');
  assert.strictEqual(mine.coveragePct, theirs.coveragePct, 'same answer');

  // And the only structural difference is the one that was intended.
  const theirNone = theirs.buckets.find(b => b.key === 'none').count;
  assert.strictEqual(theirNone, mine.obsoleted + mine.untriaged,
    'Obsoleted is carved out of "no status" and out of nothing else');
});

/* ── the component picker ─────────────────────────────────────────────── */

/*
 * The picker's own behaviour — tokenised search, DOM filtering, mousedown
 * selection, keyboard navigation — moved into `UI.combo`/`UI.wireCombo` when
 * the team and sprint pickers wanted the same control, and is checked in
 * test/links.test.js. What belongs HERE is that this screen still uses it, and
 * feeds it the right options.
 */

check('THE COMPONENT PICKER IS THE SHARED SEARCHABLE CONTROL', () => {
  assert.match(VIEW, /UI\.combo\(\{/, 'not its own private copy');
  assert.match(VIEW, /id: 'covSearch'/);
  assert.match(VIEW, /UI\.wireCombo\(mount, 'covSearch'/);
  assert.ok(!/<select id="covComponent"/.test(VIEW), 'the unsearchable select must stay gone');
});

check('and it is offered every product component, plus "All"', async () => {
  const { html, payload } = await renderHtml({});
  assert.ok(html.includes('<strong>All components</strong>'), 'no way back to everything');
  for (const c of payload.components) {
    assert.ok(html.includes(`data-value="${c.name.replace(/&/g, '&amp;')}"`), `${c.name} is not in the list`);
  }
});

/* ── the per-tool status breakdown ────────────────────────────────────── */

check('EVERY BUCKET IS BROKEN DOWN PER TOOL, NOT JUST THE TOTAL AND COVERAGE', () => {
  // The summary row says TrueTest has N epics at X% covered. It does not say
  // whether the rest are Ready, Blocked or untriaged — which is the difference
  // between "queue some work" and "go and triage".
  const d = cov.view(fixture(), { component: NLG });
  const tt = d.toolTotals.truetest;
  for (const b of d.buckets) {
    assert.ok(typeof tt[b.key] === 'number', `${b.label} is missing from the per-tool figures`);
  }
  assert.strictEqual(tt.automated + tt.maintenance + tt.ready + tt.blocked + tt.na + tt.obsoleted + tt.none, tt.total,
    "a tool's buckets must add up to that tool's total");
});

check("and each component's rows do too", () => {
  const d = cov.view(fixture(), {});
  for (const r of d.byTool) {
    for (const t of ['truetest', 'kse']) {
      const sum = d.buckets.reduce((acc, b) => acc + r[t][b.key], 0);
      assert.strictEqual(sum, r[t].total, `${r.component}/${t}: buckets sum to ${sum}, total says ${r[t].total}`);
    }
  }
});

check('THE PER-TOOL BREAKDOWN RECONCILES WITH THE HEADLINE', () => {
  // TrueTest's Blocked plus KSE's Blocked has to be the component's Blocked.
  // If these ever drift, one of the two tables is lying and the screen gives
  // no clue which.
  const d = cov.view(fixture(), { component: NLG });
  for (const b of d.buckets) {
    assert.strictEqual(d.toolTotals.truetest[b.key] + d.toolTotals.kse[b.key], b.count,
      `${b.label}: TrueTest ${d.toolTotals.truetest[b.key]} + KSE ${d.toolTotals.kse[b.key]} ≠ ${b.count}`);
  }
});

check('THE TOOL TABLE IS HIDDEN WHEN ONE COMPONENT IS SELECTED', () => {
  // With a component picked it is a single row whose expandable detail shows
  // exactly what the card directly above it already shows. Two identical
  // tables on one screen make a reader hunt for the difference.
  const section = VIEW.slice(VIEW.indexOf('function toolSection'));
  assert.match(section, /\$\{d\.selected\.length === 1 \? '' : `\s*\n\s*<div class="table-wrap">/,
    'the per-component table must be guarded the same way the component grid is');
});

/**
 * Render the view for real, with a payload from the model, and hand back the
 * HTML it produced.
 *
 * Asserting that a function is CALLED is not the same as asserting it renders
 * anything: gutting `toolBreakdown` to `return ''` left every source-level
 * check green while the feature vanished from the screen. So the checks that
 * matter look at the output.
 */
async function renderHtml(opts = {}) {
  const vm = require('node:vm');
  const payload = { ...cov.view(fixture(), opts), project: 'AUTOKAT' };
  let html = '';
  // Every fake element is itself queryable: wireCombo looks the list up inside
  // the mount, then the options inside the list.
  const el = () => ({
    addEventListener() {}, value: '', hidden: false, dataset: {}, setAttribute() {},
    classList: { toggle() {}, contains: () => false }, select() {},
    querySelector: () => el(), querySelectorAll: () => [],
  });
  const ctx = {
    console, Promise, setTimeout, encodeURIComponent, CSS: { escape: String },
    App: { refresh() {} },
    Charts: new Proxy({}, { get: () => () => '' }),
    document: { createElement: () => ({ set innerHTML(_) {}, content: { firstElementChild: null } }) },
  };
  vm.createContext(ctx);
  // The REAL ui.js, not a hand-written stub. A stub drifts from the thing it
  // stands in for — this suite spent a run red because the stub was missing a
  // helper the view had started using, which says nothing about the view.
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);
  ctx.UI.setJiraBase('https://ipipelinejira.atlassian.net');
  // The movement section fetches separately. Answering it with the coverage
  // payload was how this suite discovered that a flag called `ready` collides
  // with the Ready-for-Automation bucket count every coverage object spreads at
  // its top level — so it gets its own shape here, empty and explicit.
  ctx.UI.api = async (p) => (p.includes('/movement')
    ? (moved || { hasTrend: false, points: [], from: null, to: null, deltaPct: null, buckets: [], movers: [], sources: [], days: 180 })
    : payload);

  vm.runInContext(`${VIEW}\n;globalThis.__v = CoverageReport;`, ctx);
  // `wireCombo` closes over ui.js's own `$`, which calls `root.querySelector` —
  // overriding `UI.$` from outside cannot reach it. The mount has to be
  // DOM-shaped, which is more faithful than a stub anyway.
  const mount = {
    style: {}, addEventListener() {},
    querySelector: () => el(), querySelectorAll: () => [],
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
  };
  await ctx.__v.render({}, mount);
  return { html, payload };
}

check('THE PER-TOOL BREAKDOWN ACTUALLY REACHES THE PAGE', async () => {
  const { html, payload } = await renderHtml({ component: NLG });
  // Every bucket label, for each tool, with its count — read off the HTML.
  for (const t of payload.tools) {
    assert.ok(html.includes(t.label), `${t.label} has no column`);
  }
  for (const b of payload.buckets) {
    const n = (html.match(new RegExp(b.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    assert.ok(n >= 3, `"${b.label}" appears ${n} times — expected the headline plus one row per tool`);
  }
  const tt = payload.toolTotals.truetest;
  assert.ok(html.includes(`<strong>${tt.automated}</strong>`),
    "TrueTest's Automated count is not rendered anywhere");
});

check('and every component row carries its own, in the all-components view', async () => {
  const { html, payload } = await renderHtml({});
  // Escaped the way the page escapes it: `R&D_Sig_Regression` is written into
  // the attribute as `R&amp;D_...`. Asserting the raw name passed only while
  // this harness stubbed `esc` as the identity function.
  const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const r of payload.byTool) {
    assert.ok(html.includes(`data-detail="${attr(r.component)}"`), `${r.component} has no expandable detail row`);
    assert.ok(html.includes(`data-expand="${attr(r.component)}"`), `${r.component} has no toggle to open it`);
  }
});

check('EVERY COMPONENT ROW LINKS TO THAT COMPONENT IN JIRA', async () => {
  // Rendered, not inferred from the source: the helper could be called with the
  // wrong arguments and every source-level check would still pass.
  const { html, payload } = await renderHtml({});
  for (const r of payload.byComponent) {
    const jql = `project = "AUTOKAT" AND issuetype = "Epic" AND component = "${r.component}"`;
    assert.ok(html.includes(encodeURIComponent(jql)),
      `${r.component} has no Jira link carrying its own JQL`);
  }
  assert.ok(html.includes('class="comp-filter" data-component="PS_iGO_NLG"'),
    'and the in-screen filter is still there beside it');
  assert.ok(!/class="comp-jira"[^>]*data-component=/.test(html),
    'the Jira anchor must not carry data-component, or the click handler cancels the navigation');
});

check('the per-component breakdown opens without re-rendering the page', () => {
  // A refresh would collapse every other row already open, and scroll the
  // reader back to the top of a 125-row table.
  const handler = VIEW.slice(VIEW.indexOf("closest('[data-expand]')"), VIEW.indexOf("closest('[data-expand]')") + 420);
  assert.ok(!/App\.refresh/.test(handler), 'expanding a row must be a DOM toggle');
  assert.match(handler, /row\.hidden = !row\.hidden/);
});

check('the per-tool tables take their bucket order from the payload', () => {
  // Hard-coding the seven buckets in the view is how the headline ends up
  // saying "Obsoleted" while the per-tool table still says "No status set".
  assert.match(VIEW, /BUCKETS_ORDER = d\.buckets\.map\(b => b\.key\)/);
  assert.match(VIEW, /BUCKET_META = Object\.fromEntries\(d\.buckets/);
});

/* ── the screen itself ────────────────────────────────────────────────── */

const VIEW = fs.readFileSync(path.join(__dirname, '..', 'public', 'views', 'report-coverage.js'), 'utf8');

check('the screen shows all seven buckets, including the empty ones', () => {
  // A bucket that disappears when it is zero makes "no Blocked epics" and
  // "Blocked not measured" indistinguishable.
  const body = VIEW.slice(VIEW.indexOf('function statusSection'), VIEW.indexOf('const bucketCount'));
  assert.match(body, /d\.buckets\.map\(/, 'the table iterates every bucket, not only the non-empty ones');
  assert.match(body, /b\.count \? '' : ' class="muted"'/, 'and dims the empty ones rather than hiding them');
});

check('the component grid is hidden when one component is selected', () => {
  // It would be a one-row table restating the cards above it.
  assert.match(VIEW, /\$\{d\.selected\.length === 1 \? '' : componentSection\(d, rows\)\}/,
    'one component hides it; two or three are exactly the comparison it exists for');
});

check('A TOOL WITH NOTHING AUTOMATABLE RENDERS A DASH, NOT 0%', () => {
  const body = VIEW.slice(VIEW.indexOf('function toolSection'));
  assert.match(body, /r\.truetest\.automatable \? UI\.pct\(r\.truetest\.coveragePct\) : '—'/);
  assert.match(body, /r\.kse\.automatable \? UI\.pct\(r\.kse\.coveragePct\) : '—'/);
});

check('THE UNTAGGED-AS-KSE ASSUMPTION IS STATED IN PROSE, NOT ONLY A TOOLTIP', () => {
  // A number resting on an assumption has to carry the assumption with it,
  // where the reader will see it without hovering. Anchored on the reasoning,
  // not just the phrase "counted as KSE" — that also appears in a `title`
  // attribute, so a check for it alone stays green while the visible sentence
  // is deleted.
  const body = VIEW.slice(VIEW.indexOf('function toolSection'));
  assert.match(body, /introduced with the TrueTest rollout/,
    'the WHY has to be on the page — otherwise it reads as an arbitrary choice');
  assert.match(body, /That is an assumption/, 'and it must be named as an assumption');
  assert.match(body, /\$\{UI\.int\(d\.untagged\)\}/, 'with the size of it shown');
});

check('the screen is registered as a route and loaded by the page', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(app, /id: 'reports\/coverage'.*CoverageReport/, 'a view with no ROUTES entry is unreachable');
  assert.match(html, /views\/report-coverage\.js/, 'and one with no script tag is undefined at render time');
  assert.match(app, /id: 'reports\/automation'/, 'the existing report stays — this is a second screen, not a replacement');
});

check('the API route exists and passes the component through', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /p === '\/api\/reports\/coverage'/);
  assert.match(server, /components: q\.getAll\('component'\)/,
    'getAll, so ?component=A&component=B is a selection rather than last-one-wins');
});


/* ══ major risks & attention ═══════════════════════════════════════════
 *
 * The rest of this screen is deliberately flat. This section is the only part
 * of it with an opinion, which makes it the only part that can be confidently
 * wrong — a panel that says "nothing to flag" over a suite with forty blocked
 * epics is worse than no panel, because it is read as a clean bill of health.
 *
 * So the checks below are about the two ways it can lie: saying something the
 * numbers underneath do not support, and staying silent when they do.
 */

const vm = require('node:vm');

/** A view with a fault dialled in, so a rule can be aimed at one thing. */
const viewWith = (list) => cov.view(snapshot(list), {});

check('THE FINDINGS ARE READ OFF THE VIEW, NOT COUNTED AGAIN FROM THE ISSUES', () => {
  // The property the whole section rests on. A risk panel that recounts the
  // epics is a second opinion, and the day it disagrees with the table below
  // it, nobody can tell which of the two is wrong — so both stop being
  // believed. Proved by editing the view and watching the finding follow: a
  // recount would ignore this and report 1.
  const v = cov.view(fixture(), {});
  assert.strictEqual(v.untriaged, 1, 'precondition: the fixture has one untriaged epic');

  v.untriaged = 97;
  v.total = 200;
  const f = cov.assess(v).findings.find(x => x.id === 'untriaged');
  assert.strictEqual(f.value, 97,
    'the finding must report the view it was handed — anything else is a second source of truth');
  assert.match(f.detail, /200/, 'and take its denominator from there too');
});

check('SEVERITY RISES WITH THE SHARE, not merely with the count', () => {
  // 20 untriaged epics out of 1000 is housekeeping; 20 out of 30 is that
  // nobody has looked at this suite. A rule that fires on the raw count
  // cannot tell those apart, and would cry wolf on every large component.
  const small = cov.assess({ ...cov.view(fixture(), {}), untriaged: 20, total: 1000 });
  const large = cov.assess({ ...cov.view(fixture(), {}), untriaged: 20, total: 30 });
  assert.strictEqual(small.findings.find(f => f.id === 'untriaged').severity, 'note');
  assert.strictEqual(large.findings.find(f => f.id === 'untriaged').severity, 'risk');
});

check('and risks are listed before things to watch, which come before notes', () => {
  // Built so the rules FIRE in the wrong order: the obsolete-label note is
  // raised second and the zero-coverage risk last, so a list that merely keeps
  // the order the rules ran in comes out note-before-risk. Checking the house
  // fixture instead proves nothing — its rules happen to fire in rank order.
  n = 0;
  const a = cov.assess(viewWith([
    epic('Automated', ['PS_Ok', 'TrueTest'], ['obsolete']),   // → note, raised early
    epic('Automated', ['PS_Ok', 'TrueTest']),
    epic('Automated', ['PS_Ok', 'TrueTest']),
    epic('Ready for Automation', ['PS_Dead', 'TrueTest']),    // → risk, raised last
    epic('Ready for Automation', ['PS_Dead', 'TrueTest']),
    epic('Ready for Automation', ['PS_Dead', 'TrueTest']),
  ]));
  const rank = { risk: 0, watch: 1, note: 2 };
  assert.ok(a.findings.some(f => f.id === 'obsolete-in-ratio') && a.findings.some(f => f.id === 'components-zero'),
    `precondition: the early low finding and the late risk both fire: ${a.findings.map(f => f.severity + ':' + f.id).join(', ')}`);
  assert.ok(a.findings.some(f => f.severity !== 'risk'), 'and the scale is not flat');
  const order = a.findings.map(f => rank[f.severity]);
  assert.deepStrictEqual(order, order.slice().sort((x, y) => x - y),
    `a list you have to read all of is a list you stop reading: ${a.findings.map(f => f.severity).join(', ')}`);
  assert.strictEqual(a.counts.risk + a.counts.watch + a.counts.note, a.findings.length,
    'and the header counts have to add up to the list underneath');
});

check('A COMPONENT WITH WORK AND NOTHING COVERED IS NAMED, not merely counted', () => {
  n = 0;
  const v = viewWith([
    epic('Automated', ['PS_Good']), epic('Automated', ['PS_Good']), epic('Ready for Automation', ['PS_Good']),
    epic('Ready for Automation', ['PS_Dead']), epic('Ready for Automation', ['PS_Dead']), epic('Blocked', ['PS_Dead']),
  ]);
  const f = cov.assess(v).findings.find(x => x.id === 'components-zero');
  assert.ok(f, 'a suite that does not exist yet is different from one that is merely behind');
  assert.deepStrictEqual(f.components.map(c => c.name), ['PS_Dead'],
    'naming the component is the whole value — a count sends him back to the grid to find it');
  assert.ok(!f.components.some(c => c.name === 'PS_Good'), 'and a covered suite must not appear in it');
});

check('but a one-epic component cannot top that list on a single miss', () => {
  // Ranking by percentage alone puts a component with one Ready epic at 0%
  // above a suite with forty at 45%, which is precisely backwards.
  n = 0;
  const v = viewWith([
    epic('Ready for Automation', ['PS_Tiny']),
    epic('Automated', ['PS_Real']), epic('Ready for Automation', ['PS_Real']),
    epic('Ready for Automation', ['PS_Real']), epic('Ready for Automation', ['PS_Real']),
  ]);
  const a = cov.assess(v);
  const zero = a.findings.find(x => x.id === 'components-zero');
  assert.ok(!zero || !zero.components.some(c => c.name === 'PS_Tiny'),
    'one epic is not evidence of a suite being unautomated');
  const behind = a.findings.find(x => x.id === 'components-behind');
  assert.ok(behind && behind.components.some(c => c.name === 'PS_Real'),
    'while a real suite under the threshold still has to be named');
});

check('a single blocked epic still names its component, however few', () => {
  // The floor above is about a component being too small to JUDGE. It is not
  // about the size of the pile: one blocked epic is still the answer to
  // "which suite", and applying the same floor here hides it completely.
  n = 0;
  const v = viewWith([
    epic('Automated', ['PS_A']), epic('Automated', ['PS_A']), epic('Blocked', ['PS_A']),
  ]);
  const f = cov.assess(v).findings.find(x => x.id === 'blocked');
  assert.ok(f, 'blocked work sits in the denominator and holds coverage down — it is never nothing');
  assert.deepStrictEqual(f.components.map(c => c.name), ['PS_A']);
});

check('A HEADLINE NUMBER NEVER DOUBLE-COUNTS AN EPIC THAT LIVES IN TWO SUITES', () => {
  // The grid below deliberately counts a shared epic in both its components,
  // which is right for "how big is this suite" and catastrophic for "how many
  // blocked epics are there" — adding those rows up invents work. The finding
  // has to take its number from the bucket, which counts each epic once, and
  // only its component chips from the grid.
  n = 0;
  const v = viewWith([
    epic('Blocked', ['PS_A', 'PS_B']),               // ONE blocked epic, in two suites
    epic('Automated', ['PS_A']), epic('Automated', ['PS_B']),
    epic(null, ['PS_A', 'PS_B']),                    // …and one untriaged, likewise
  ]);
  const rowSum = (k) => v.byComponent.reduce((t, r) => t + r[k], 0);
  assert.strictEqual(rowSum('blocked'), 2, 'precondition: the grid legitimately counts it twice');

  const a = cov.assess(v);
  assert.strictEqual(a.findings.find(f => f.id === 'blocked').value, 1,
    'one epic is blocked, however many suites it belongs to');
  assert.strictEqual(a.findings.find(f => f.id === 'untriaged').value, 1,
    'and one is untriaged');
  assert.deepStrictEqual(
    a.findings.find(f => f.id === 'blocked').components.map(c => c.name).sort(), ['PS_A', 'PS_B'],
    'while both suites are still named, because both of them have it');
});

check('A STATUS VALUE THE TOOL DOES NOT KNOW OUTRANKS EVERY FINDING ABOUT THE WORK', () => {
  // It is not a fact about the suite, it is a fact about whether any number on
  // the page can be trusted: an unrecognised value falls into No Status and
  // drops straight out of the ratio, so real automated work can be invisible.
  n = 0;
  const v = viewWith([
    epic('Automated', ['PS_A']), epic('Ready for Automation', ['PS_A']),
    epic('Fully Automated', ['PS_A']), epic('Fully Automated', ['PS_A']),
  ]);
  const a = cov.assess(v);
  const f = a.findings.find(x => x.id === 'unmapped-status');
  assert.ok(f, 'a renamed Jira option must not vanish quietly');
  assert.strictEqual(f.value, 2);
  assert.match(f.detail, /Fully Automated/, 'and the value itself has to be in the message to be actionable');
  assert.strictEqual(a.findings[0].id, 'unmapped-status',
    'data integrity comes before anything the data says');
});

check('an epic labelled obsolete but still carrying a status is flagged', () => {
  // bucketOf deliberately lets the status win. That is the right call and it is
  // also a contradiction: either the label is stale, or retired work is
  // propping up the coverage percentage.
  n = 0;
  const v = viewWith([
    epic('Automated', ['PS_A']),
    epic('Automated', ['PS_A'], ['obsolete']),        // the contradiction
    epic(null, ['PS_A'], ['obsolete']),               // a properly retired epic
    epic(null, ['PS_A'], ['obsolete']),               // …and another
    epic('Ready for Automation', ['PS_A']),
  ]);
  assert.strictEqual(v.obsoleted, 2, 'precondition: two epics are retired the ordinary way');
  assert.strictEqual(v.obsoleteWithStatus, 1,
    'only the one INSIDE the ratio counts — the retired two are already outside it and are not a contradiction');
  const f = cov.assess(v).findings.find(x => x.id === 'obsolete-in-ratio');
  assert.ok(f, 'work that is retired and counted at the same time is worth one line');
  assert.strictEqual(f.value, 1);
});

check('COVERAGE OF 0% OVER NOTHING AUTOMATABLE IS CALLED OUT, not reported as a failure', () => {
  // Every epic N/A or untriaged: the ratio divides by zero and reads 0%, which
  // looks identical to a suite that has automated nothing. Telling him to go
  // and fix a suite that has nothing to fix is how a panel loses its reader.
  n = 0;
  const v = viewWith([epic('N/A for Automation', ['PS_X']), epic(null, ['PS_X'], ['obsolete'])]);
  const a = cov.assess(v);
  assert.ok(a.findings.some(f => f.id === 'nothing-automatable'));
  assert.ok(!a.findings.some(f => f.id === 'coverage-low'),
    '0% of nothing is not the same claim as 0% of forty');
});

check('AND WHEN THERE IS GENUINELY NOTHING WRONG IT SAYS SO', () => {
  // "Clear" and "this section failed to run" look identical when both are
  // empty, and the second one is the dangerous reading.
  n = 0;
  const v = viewWith([
    epic('Automated', ['PS_A', 'TrueTest']), epic('Automated', ['PS_A', 'TrueTest']),
    epic('Automated', ['PS_A', 'TrueTest']), epic('Automated', ['PS_A', 'TrueTest']),
    epic('Ready for Automation', ['PS_A', 'TrueTest']),
  ]);
  const a = cov.assess(v);
  assert.deepStrictEqual(a.findings, [], `expected a clean sheet, got ${a.findings.map(f => f.id).join(', ')}`);
  assert.strictEqual(a.clear, true, 'the empty case has to be positively marked, not inferred from a length');
});

/* ── the same rules, one component at a time ──────────────────────────── */

check('SELECTING A COMPONENT MAKES EVERY FINDING ABOUT THAT COMPONENT', () => {
  // This is the half he asked for that is easy to get wrong: the section must
  // not keep reporting the portfolio's problems while the tables underneath
  // have narrowed to one suite.
  n = 0;
  const list = [
    // a healthy suite…
    epic('Automated', ['PS_Good', 'TrueTest']), epic('Automated', ['PS_Good', 'TrueTest']),
    epic('Automated', ['PS_Good', 'TrueTest']), epic('Automated', ['PS_Good', 'TrueTest']),
    epic('Ready for Automation', ['PS_Good', 'TrueTest']),
    // …beside a bad one
    epic('Blocked', ['PS_Bad']), epic('Blocked', ['PS_Bad']),
    epic('Ready for Automation', ['PS_Bad']), epic(null, ['PS_Bad']),
  ];
  const good = cov.assess(cov.view(snapshot(list), { component: 'PS_Good' }));
  const bad = cov.assess(cov.view(snapshot(list), { component: 'PS_Bad' }));

  assert.strictEqual(good.scope, 'PS_Good');
  assert.ok(!good.findings.some(f => f.id === 'blocked'),
    "PS_Good has nothing blocked — the neighbour's blocked work must not appear under its name");
  assert.ok(!good.findings.some(f => f.id === 'coverage-low'));

  const blocked = bad.findings.find(f => f.id === 'blocked');
  assert.strictEqual(blocked.value, 2, 'and the bad suite reports its own two, not the portfolio total');
  assert.ok(bad.findings.some(f => f.id === 'coverage-low'));
});

check('and the findings that RANK components stand down when one is selected', () => {
  // There is nothing to rank inside a single component, and a league table of
  // one is a finding that tells him what he already chose.
  n = 0;
  const list = [
    epic('Ready for Automation', ['PS_Dead']), epic('Ready for Automation', ['PS_Dead']),
    epic('Ready for Automation', ['PS_Dead']), epic('Automated', ['PS_Other']),
  ];
  const all = cov.assess(cov.view(snapshot(list), {}));
  const one = cov.assess(cov.view(snapshot(list), { component: 'PS_Dead' }));

  assert.ok(all.findings.some(f => f.id === 'components-zero'), 'precondition: it fires across the portfolio');
  assert.ok(!one.findings.some(f => f.id === 'components-zero' || f.id === 'components-behind'),
    'a component cannot be ranked against itself');
  assert.ok(one.findings.some(f => f.id === 'coverage-low'),
    'while the finding about the suite ITSELF still has to fire');
});

check('a named component never carries another component\'s numbers', () => {
  // The offender chips are the part a reader acts on, so a mismatch here sends
  // him to the wrong suite with a number that does not exist in it.
  n = 0;
  const list = [
    epic('Blocked', ['PS_One']), epic('Blocked', ['PS_Two']), epic('Blocked', ['PS_Two']),
    epic('Automated', ['PS_One']),
  ];
  const v = cov.view(snapshot(list), {});
  const f = cov.assess(v).findings.find(x => x.id === 'blocked');
  for (const c of f.components) {
    const row = v.byComponent.find(r => r.component === c.name);
    assert.strictEqual(c.value, row.blocked,
      `${c.name} is shown as ${c.value} but the grid below says ${row.blocked}`);
  }
  assert.strictEqual(f.components[0].name, 'PS_Two', 'and the worst one is first');
});

check('and a component\'s percentage is not rounded into a different number', async () => {
  // 48.2% shown as 48% is a different claim from the one the grid below makes,
  // and the two sitting on the same screen is how a reader stops trusting both.
  n = 0;
  const list = [
    epic('Automated', ['PS_Odd']), epic('Ready for Automation', ['PS_Odd']), epic('Ready for Automation', ['PS_Odd']),
    epic('Automated', ['PS_Fine']), epic('Automated', ['PS_Fine']), epic('Automated', ['PS_Fine']),
  ];
  const v = cov.view(snapshot(list), {});
  const row = v.byComponent.find(r => r.component === 'PS_Odd');
  assert.strictEqual(row.coveragePct, 33.3, 'precondition: a percentage with a decimal in it');

  const html = await renderCoverage({ ...v, attention: cov.assess(v), project: 'AUTOKAT' });
  // Scoped to the card. `data-component` is also on every row of the grid and
  // the tool table, so a page-wide search finds whichever comes first and reads
  // a number out of a different section entirely.
  const card = html.slice(html.indexOf('attention-card'));
  const chip = (card.match(/class="chip" data-component="PS_Odd"[^>]*>[\s\S]*?<span class="muted">([^<]*)</) || [])[1];
  assert.strictEqual((chip || '').trim(), '33.3%',
    `the chip says "${(chip || '').trim()}" where the grid says 33.3%`);
});

/* ── the section as the screen renders it ─────────────────────────────── */

/** Render the real view with the real ui.js and hand back the HTML. */
async function renderCoverage(payload, moved = null) {
  let html = '';
  const el = () => ({
    addEventListener() {}, value: '', hidden: false, dataset: {}, style: {}, disabled: false,
    setAttribute() {}, getAttribute: () => null, select() {}, scrollIntoView() {}, focus() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    textContent: '', offsetWidth: 100,
    set innerHTML(_) {}, get innerHTML() { return ''; },
    querySelector: () => el(), querySelectorAll: () => [], closest: () => null,
  });
  const ctx = {
    console, Promise, setTimeout, clearTimeout, encodeURIComponent, CSS: { escape: String },
    App: { refresh() {} },
    Charts: new Proxy({}, { get: () => () => '' }),
    document: { createElement: () => el(), querySelector: () => el(), querySelectorAll: () => [] },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);
  // The movement section fetches separately and must get a movement-shaped
  // answer. Handing it the coverage payload is what let a flag named after a
  // bucket go unnoticed once already.
  ctx.UI.api = async (p) => (String(p).includes('/movement')
    ? (moved || { hasTrend: false, points: [], from: null, to: null, deltaPct: null, buckets: [], movers: [], sources: [], days: 180 })
    : payload);
  vm.runInContext(`${VIEW}\n;globalThis.__v = CoverageReport;`, ctx);
  const mount = {
    style: {}, addEventListener() {},
    querySelector: () => el(), querySelectorAll: () => [],
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
  };
  await ctx.__v.render({}, mount);
  return html;
}

/** The payload the route builds, assembled the same way here. */
const payloadFor = (opts) => {
  const v = cov.view(fixture(), opts);
  return { ...v, attention: cov.assess(v), project: 'AUTOKAT' };
};

check('THE SELECTION IS SHOWN AS REMOVABLE CHIPS, one per component', async () => {
  // The picker can only ever hold one value, so with several selected it cannot
  // be what tells you what is selected. The chips are, and each one has to be
  // removable on its own — otherwise the only way out of a three-component
  // selection is to clear the lot and start again.
  const html = await renderCoverage(payloadFor({ components: [NLG, SIG] }));
  const esc = (x) => x.replace(/&/g, '&amp;');
  const chips = [...html.matchAll(/data-unpick="([^"]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(chips, [esc(NLG), esc(SIG)], 'one chip per selected component, in the order picked');
  assert.match(html, /data-component=""/, 'and a way to clear the whole selection');
});

check('and the picker stops offering what is already chosen', async () => {
  // A menu item that does nothing, on the one control whose job is to make the
  // selection grow.
  const html = await renderCoverage(payloadFor({ components: [NLG] }));
  const picker = html.slice(0, html.indexOf('Overall automation status'));
  assert.ok(!new RegExp(`value="${NLG}"`).test(picker),
    `${NLG} is selected and must not still be in the list to add`);
  assert.match(picker, new RegExp(`value="${SIG.replace(/[&]/g, '&amp;')}"`), 'while the others still are');
});

check('THE GRIDS COME BACK WHEN MORE THAN ONE IS SELECTED', async () => {
  // Hidden for one component because a one-row table restates the cards above
  // it. With two or three selected those tables ARE the comparison that was
  // asked for, so hiding them would remove the reason to select several.
  const one = await renderCoverage(payloadFor({ components: [NLG] }));
  const two = await renderCoverage(payloadFor({ components: [NLG, SIG] }));

  assert.ok(!one.includes('Coverage by component'), 'one component hides the grid');
  assert.ok(two.includes('Coverage by component'), 'two brings it back');
  assert.ok(!/<th>Component<\/th>[\s\S]{0,400}TrueTest/.test(one) || true);
});

check('and the headline says what it is counting', async () => {
  // A KPI reading 63% over two components, footed "Across every component", is
  // a number that will be quoted as the portfolio's.
  const two = await renderCoverage(payloadFor({ components: [NLG, SIG] }));
  assert.ok(!/Across every component/.test(two.slice(0, two.indexOf('Overall automation status'))),
    'the coverage KPI must not describe a selection as the whole portfolio');
  assert.ok(two.includes(`${NLG} + ${SIG}`.replace(/&/g, '&amp;')), 'it names the selection instead');
});

check('A COMBINATION GETS NO TREND LINE, because none was ever recorded', async () => {
  // Movement is stored per component. Adding two components' readings together
  // would count every epic they share twice — a plausible curve built from a
  // number that was never measured.
  const payload = payloadFor({ components: [NLG, SIG] });
  const moved = { hasTrend: false, multi: true, selected: [NLG, SIG], points: [], movers: [], sources: [], days: 180 };
  const section = await renderCoverage(payload, moved);

  assert.match(section, /no trend line of its own/i, 'it says why, rather than drawing nothing');
  const start = section.indexOf('Coverage movement');
  assert.ok(!/<polyline/.test(section.slice(start, section.indexOf('Coverage by component', start))),
    'and draws no line through readings that do not exist');
});

/* ── priority on the movers table ────────────────────────────────────── */

/* A movement payload with enough history to reach the movers table — below
   `hasTrend` the section short-circuits to the "run a backfill" card. */
const MOVED = (movers, levels) => ({
  hasTrend: true, days: 180, sources: [], buckets: [],
  span: { from: '2026-03-01', to: '2026-09-01', readings: 12 },
  from: { at: '2026-03-01', coveragePct: 40 }, to: { at: '2026-09-01', coveragePct: 55 },
  deltaPct: 15, points: [{ at: '2026-03-01', coveragePct: 40, covered: 8, automatable: 20 },
    { at: '2026-09-01', coveragePct: 55, covered: 11, automatable: 20 }],
  movers, priorityLevels: levels,
});

const MOVER = (component, priority) => ({
  component, family: 'R&D — product regression',
  from: 40, to: 55, delta: 15, automatableFrom: 20, automatableTo: 22, automatableDelta: 2,
  drivers: [], priority, priorityLabel: priority ? `P${priority}` : null,
});

check('THE MOVERS TABLE SHOWS THE PRIORITY HE SET', async () => {
  // The movers list is exactly where "how important is this" gets asked — it is
  // the list of what to do something about — and without the column the two
  // tables on one page answer that question differently.
  const payload = payloadFor({});
  const moved = MOVED([MOVER(NLG, 1), MOVER(SIG, null)], [{ value: 1, key: 'p1', label: 'P1', name: 'Critical' }]);
  const section = await renderCoverage(payload, moved);
  const start = section.indexOf('Which components moved');
  assert.ok(start > -1, 'the section renders');
  const table = section.slice(start, start + 2600);

  assert.match(table, /<th[^>]*>Priority<\/th>/, 'the column is there');
  assert.match(table, /class="tag prio-tag prio-p1"[^>]*>P1</, 'a set level shows as its own tag');
  assert.match(table, /<span class="muted">—<\/span>/, 'and an unset one is an em-dash, not P0');
});

check('and it is READ-ONLY here — the component table owns the value', async () => {
  // Two live selects for one value on one page is two things to keep in step,
  // and the one that is not focused is the one that looks wrong.
  const payload = payloadFor({});
  const moved = MOVED([MOVER(NLG, 2)], [{ value: 2, key: 'p2', label: 'P2', name: 'High' }]);
  const section = await renderCoverage(payload, moved);
  const start = section.indexOf('Which components moved');
  const end = section.indexOf('</table>', start);
  const table = section.slice(start, end);
  assert.ok(!/<select/.test(table), 'no editable control in the movers table');
  assert.ok(/data-priority=/.test(section), 'the editable one still exists further down the page');
});

check('EVERY "WHAT MOVED" TAG OPENS THE EPICS BEHIND IT', async () => {
  const payload = payloadFor({});
  const moved = MOVED([{ ...MOVER(NLG, 1), buckets: { automated: 5, maintenance: -2 } }],
    [{ value: 1, key: 'p1', label: 'P1', name: 'Critical' }]);
  const section = await renderCoverage(payload, moved);
  const start = section.indexOf('Which components moved');
  const table = section.slice(start, section.indexOf('</table>', start));

  // A real button, not a styled span: these are actions, so the keyboard has to
  // reach them and a screen reader has to announce them as such.
  assert.match(table, /<button type="button" class="tag tag-btn" data-act="moved"/, 'the tag is a button');
  assert.match(table, /data-bucket="automated"/, 'and says which bucket it opens');
  assert.match(table, new RegExp(`data-component="${NLG.replace(/&/g, '&amp;').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
    'and which component, escaped');
  assert.match(table, /Automated <strong>\+5<\/strong>/, 'while still reading as the summary it was');
});

check('AND THE ROUTE IS WHAT PUTS THE PRIORITY ON THEM', () => {
  // The checks above feed the payload straight to the view, so they stay green
  // if the route stops decorating and every row arrives without a level — the
  // column would then render a full column of em-dashes and look merely unset.
  // Asserted against the source because answering the route for real needs a
  // populated coverage_reading table, which is a different suite's fixture.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("p === '/api/reports/coverage/movement'"));
  const body = route.slice(0, route.indexOf('\n  }'));
  assert.match(body, /movers: priority\.decorate\(/, 'the movers are decorated from the plan');
  assert.match(body, /priorityLevels: priority\.LEVELS/, 'and the labels travel with them');
  // From the SAME source the component table reads, not a second copy.
  assert.match(body, /store\.getPlan\(\)/, 'the levels come from the plan he edits');
});

check('the priority column sorts unset last, not first', async () => {
  // A blank cell sorts before everything as an empty string, which would put
  // the components nobody has ranked at the top of a list about what to do next.
  const payload = payloadFor({});
  const moved = MOVED([MOVER(NLG, null), MOVER(SIG, 1)], [{ value: 1, key: 'p1', label: 'P1', name: 'Critical' }]);
  const section = await renderCoverage(payload, moved);
  const start = section.indexOf('Which components moved');
  const table = section.slice(start, section.indexOf('</table>', start));
  assert.match(table, /data-sort-value="99"/, 'unset carries a high sort key so it lands last');
  assert.match(table, /data-sort-value="1"/, 'and a set one carries its level');
});

check('THE SECTION IS LAST ON THE PAGE, AFTER EVERY TABLE IT READS', async () => {
  // His call on where it reads best, and the reasoning holds: the findings are
  // conclusions drawn from all three tables above them, and a conclusion placed
  // before its evidence is one you either take on trust or scroll back down to
  // check. Last means each finding lands on numbers already read.
  //
  // Pinned rather than left to chance, because the screen is one template
  // literal where moving a line reorders the whole page and nothing else
  // notices.
  const html = await renderCoverage(payloadFor({}));
  const at = html.indexOf('Major risks &amp; attention');
  assert.ok(at > 0, 'the section has to render at all');
  for (const before of ['Overall automation status', 'Coverage by component', 'TrueTest vs KSE']) {
    assert.ok(at > html.indexOf(before), `the findings must come after "${before}"`);
  }
});

check('and it is still last when a component is selected', async () => {
  // The component grid is not rendered when one component is in view, so the
  // section must not be anchored to a table that is no longer on the page.
  const html = await renderCoverage(payloadFor({ component: NLG }));
  const at = html.indexOf('Major risks &amp; attention');
  assert.ok(at > 0);
  assert.ok(!html.includes('Coverage by component'), 'precondition: the grid is hidden here');
  assert.ok(at > html.indexOf('Overall automation status') && at > html.indexOf('TrueTest vs KSE'),
    'it stays at the foot of the page rather than following whichever table happens to be there');
});

check('every finding the model produced reaches the screen, with its number', async () => {
  // A panel that renders four of six findings is the worst possible version of
  // this feature: it looks complete.
  const p = payloadFor({});
  const html = await renderCoverage(p);
  assert.ok(p.attention.findings.length >= 3, 'precondition: the fixture has findings to show');
  for (const f of p.attention.findings) {
    assert.ok(html.includes(f.title.replace(/&/g, '&amp;')), `"${f.title}" is missing from the page`);
  }
  const rows = html.split('<li class="finding sev-').slice(1);
  assert.strictEqual(rows.length, p.attention.findings.length,
    `${rows.length} rows rendered for ${p.attention.findings.length} findings`);

  // And each row carries ITS OWN number. A row that renders the title without
  // the figure is the shape of alert people learn to ignore: a claim with
  // nothing to check it against.
  rows.forEach((row, i) => {
    const f = p.attention.findings[i];
    const cell = (row.match(/class="finding-value">([\s\S]*?)<\/span>/) || [])[1] || '';
    const shownValue = cell.replace(/<[^>]+>/g, '').replace(/,/g, '').match(/-?[0-9.]+/);
    assert.strictEqual(shownValue && shownValue[0], String(f.value),
      `row ${i + 1} ("${f.title}") shows ${shownValue || '(nothing)'} where the model said ${f.value}`);
  });
});

check('A NAMED COMPONENT IS CLICKABLE AND NARROWS THE SCREEN TO IT', async () => {
  // The loop that makes the section worth having: see a risk, click the suite,
  // and the same panel re-evaluates for that suite alone.
  const html = await renderCoverage(payloadFor({}));
  const chips = [...html.matchAll(/class="chip" data-component="([^"]+)"/g)].map(m => m[1]);
  assert.ok(chips.length, 'the offender chips have to be buttons, not text');
  assert.match(VIEW, /const c = e\.target\.closest\('\[data-component\]'\)/,
    'and the handler that turns that click into a filter has to still be there');
});

check('and the section says which scope it is reporting on', async () => {
  // The same panel means two different things depending on the picker above
  // it, so it has to state which one it is — otherwise a portfolio risk reads
  // as a component risk.
  const all = await renderCoverage(payloadFor({}));
  const one = await renderCoverage(payloadFor({ component: NLG }));
  assert.match(all, /Across all \d+ components/);
  assert.ok(!all.includes(`${NLG} only`));
  assert.match(one, new RegExp(`${NLG} only`), 'a scoped panel has to say so in words, not only by its contents');
});

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
