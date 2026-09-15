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
  assert.strictEqual(d.componentRequested, 'PS_NOT_A_THING');
  assert.strictEqual(d.component, null);
  assert.strictEqual(d.total, 14, 'and it still shows something rather than an empty screen');
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
  assert.match(section, /\$\{d\.component \? '' : `\s*\n\s*<div class="table-wrap">/,
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
  ctx.UI.api = async () => payload;

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
  assert.match(VIEW, /\$\{d\.component \? '' : componentSection\(d, rows\)\}/);
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
  assert.match(server, /component: q\.get\('component'\) \|\| null/);
});

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
