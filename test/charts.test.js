'use strict';
/**
 * charts.test.js — the axis is part of the chart.
 *
 * WHY THIS SUITE EXISTS
 *
 * The Delivery metrics velocity chart for Katalon Auto Malphite drew twelve
 * correct bars beneath twelve labels reading "null", under an axis captioned
 * "Sprint". Nothing threw, nothing was missing, and the numbers were right —
 * the chart was simply telling him, in the one place he looks to identify a
 * bar, that it did not know which sprint it was.
 *
 * The cause is a disagreement about a deliberate null. Two sprint naming
 * conventions run in this project and `reconcile` supports both on purpose:
 *
 *   "Katalon Ruby Sprint 39"  → a numbered calendar entry
 *   "TT Week 18May-24May"     → a dated weekly window, `number: null`
 *
 * Malphite's board is entirely the second kind, so every one of its sprints has
 * a null number by design. `charts.js` interpolated `row.number` straight into
 * the axis text, and `${null}` is the string "null".
 *
 * WHAT MAKES THIS WORTH A SUITE OF ITS OWN. `charts.js` had no tests at all —
 * every other suite stubs `Charts` out with a proxy that returns '' — so the
 * one file whose entire output is a string nobody asserts on was the one file
 * that could print "null" to the screen for months. These checks read the SVG.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nCharts: the axis is part of the chart\n');

/* ── the real charts.js, in a sandbox ─────────────────────────────────── */

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(
  `${fs.readFileSync(path.join(__dirname, '..', 'public', 'charts.js'), 'utf8')}\n;globalThis.Charts = Charts;`,
  ctx,
);
const Charts = ctx.Charts;

/** The x-axis tick texts of a velocity chart, in order. */
const velocityTicks = (svg) =>
  [...svg.matchAll(/text-anchor="middle" font-size="9"[^>]*>([^<]*)</g)].map(m => m[1]);

/** The sprint labels under a supply/demand chart. */
const supplyTicks = (svg) =>
  [...svg.matchAll(/text-anchor="middle" font-size="10" fill="var\(--app-fg-2\)">([^<]*)</g)].map(m => m[1]);

const bar = (n, over = {}) => ({ predicted: 20 + n, planned: 18 + n, actual: 16 + n, ...over });

/** Malphite's actual shape: every sprint dated, every number null. */
const MALPHITE = [
  { sprintId: 'J16178', number: null, name: 'TT Week 18May-24May', ...bar(1) },
  { sprintId: 'J16179', number: null, name: 'TT Week 25May', ...bar(2) },
  { sprintId: 'J16180', number: null, name: 'TT Week 08Jun', ...bar(3) },
  { sprintId: 'J18499', number: null, name: 'TT Week 14Sep', ...bar(4) },
];

/** Ruby's: numbered, the convention the charts were written against. */
const RUBY = [
  { sprintId: 'S38', number: 38, name: 'Sprint 38', ...bar(1) },
  { sprintId: 'S39', number: 39, name: 'Sprint 39', ...bar(2) },
];

/* ── the bug ──────────────────────────────────────────────────────────── */

check('A SPRINT WITH NO NUMBER NEVER PUTS "null" ON THE AXIS', () => {
  const svg = Charts.velocity(MALPHITE);
  assert.ok(!/>null</.test(svg), 'the literal string "null" reached the screen');
  assert.ok(!/null/.test(svg), `no part of the chart may say "null": ${svg.match(/.{0,40}null.{0,40}/) || ''}`);
});

check('and neither does the forecast chart, which would have said "Snull"', () => {
  // Same defect, one character worse: the forecast prefixes the number with S.
  // It has not been reported only because Malphite has no forecast rows yet.
  const svg = Charts.supplyDemand(MALPHITE.map(s => ({
    ...s, capacityPoints: 30, committedPoints: 25, utilisationPct: 83, headcount: 4, availableDays: 40,
  })));
  assert.ok(!/null/.test(svg), 'the forecast chart carries the same assumption and the same fix');
  assert.ok(!/Snull/.test(svg));
});

check('A DATED SPRINT IS LABELLED WITH THE PART THAT IDENTIFIES IT', () => {
  // "TT Week" is on every sprint of that board, so an axis of twelve ticks
  // would repeat it twelve times and truncate the half that differs. What is
  // left has to be enough to tell one bar from the next.
  const ticks = velocityTicks(Charts.velocity(MALPHITE));
  assert.deepStrictEqual(ticks, ['18May-24May', '25May', '08Jun', '14Sep'],
    'each tick keeps the dates, drops the shared prefix');
  assert.strictEqual(new Set(ticks).size, ticks.length,
    'and no two bars may carry the same label — that is the one thing an axis must never do');
});

check('a numbered sprint still shows its number, unchanged', () => {
  // The fix must not rewrite the convention that already worked. Ruby, Titan and
  // every other numbered board keep exactly the axis they had.
  assert.deepStrictEqual(velocityTicks(Charts.velocity(RUBY)), ['38', '39']);
  const svg = Charts.supplyDemand(RUBY.map(s => ({
    ...s, capacityPoints: 30, committedPoints: 25, utilisationPct: 83, headcount: 4, availableDays: 40,
  })));
  assert.deepStrictEqual(supplyTicks(svg), ['S38', 'S39'], 'including the forecast chart\'s S prefix');
});

check('a mixed calendar labels each sprint by its own convention', () => {
  // katalon-automation carries BOTH: numbered fortnights and the TrueTest weeks
  // it shares with Malphite. One chart, two naming schemes, no fallback that
  // flattens them into one.
  const ticks = velocityTicks(Charts.velocity([RUBY[0], MALPHITE[0], RUBY[1], MALPHITE[1]]));
  assert.deepStrictEqual(ticks, ['38', '18May-24May', '39', '25May']);
});

check('A LONG NAME IS SHORTENED, AND THE FULL ONE IS ONE HOVER AWAY', () => {
  // A 60px band cannot hold a long name. Truncating is fine; truncating with no
  // way back to the whole thing is how a bar becomes unidentifiable.
  const long = [{ sprintId: 'J1', number: null, name: 'TT Week 18May-24May-and-then-some', ...bar(1) }];
  const svg = Charts.velocity(long);
  const tick = velocityTicks(svg)[0];
  assert.ok(tick.length <= 11, `"${tick}" is too wide for the band`);
  assert.match(tick, /…$/, 'a shortened label has to look shortened');
  assert.match(svg, /<title>TT Week 18May-24May-and-then-some<\/title>/,
    'and the full name has to be on the tick itself, not only on the bars above it');
});

check('a sprint with neither a number nor a name falls back to its id', () => {
  // A poor label that is true beats a confident one that is not. The empty
  // string is not an option either: an unlabelled bar in a row of labelled ones
  // reads as a rendering fault.
  const tick = velocityTicks(Charts.velocity([{ sprintId: 'J16180', number: null, name: '', ...bar(1) }]))[0];
  assert.strictEqual(tick, 'J16180');
});

/* ── and the bars themselves were never wrong ─────────────────────────── */

check('THE BARS AND TOOLTIPS ARE UNTOUCHED — only the labels were lying', () => {
  // Worth pinning: the reported symptom was "Sprint null", and the temptation
  // with a labelling bug is to go looking for missing data. There was none.
  const svg = Charts.velocity(MALPHITE);
  assert.strictEqual((svg.match(/<rect /g) || []).length, MALPHITE.length * 3,
    'three series per sprint, all of them drawn');
  for (const s of MALPHITE) {
    assert.ok(svg.includes(`${s.name} — Delivered: ${s.actual} pts`),
      `the tooltip for ${s.name} has to name the sprint and its delivered points`);
  }
});

check('an empty history says so rather than drawing an empty frame', () => {
  assert.match(Charts.velocity([]), /No sprint history yet/);
  assert.match(Charts.velocity(null), /No sprint history yet/);
  assert.match(Charts.supplyDemand([]), /No sprints in the horizon/);
});

check('and a name with markup in it cannot escape into the SVG', () => {
  // Sprint names come from Jira, which is to say from people. Both places the
  // name lands have to be escaped, and they are reached by different names:
  // markup AFTER the first digit-bearing word is dropped from the tick and
  // survives only in the title, while markup before it goes into both.
  const inTick = Charts.velocity([{ sprintId: 'J1', number: null, name: '<b>1</b> wk', ...bar(1) }]);
  assert.strictEqual(velocityTicks(inTick)[0], '&lt;b&gt;1&lt;/b&gt; wk',
    'the tick is the one that gets forgotten — it is built from the name, not printed from it');
  assert.ok(!/<b>/.test(inTick), 'a sprint name is data, not markup');

  const inTitle = Charts.velocity([{ sprintId: 'J2', number: null, name: '<script>x</script> 9Sep', ...bar(1) }]);
  assert.ok(!/<script>/.test(inTitle), 'and the hover title is the other way in');
  assert.match(inTitle, /&lt;script&gt;/);
});

/* ── end to end, through the model that feeds the chart ───────────────── */

check('MALPHITE\'S REAL SHAPE SURVIVES THE WHOLE PATH, MODEL TO AXIS', () => {
  // The unit checks above hand the chart a hand-written row. This one takes the
  // row the model actually produces for a board whose sprints are all dated,
  // because the defect was a disagreement BETWEEN two layers: each was right on
  // its own terms.
  const insights = require('../lib/insights');

  const sprint = (jiraId, name, start, end, state) => ({
    id: `J${jiraId}`, number: null, name, start, end, source: 'jira',
    byTeam: { malphite: { jiraId, name, state, start, end } },
  });
  const plan = {
    version: 1,
    teams: [{
      id: 'malphite', name: 'Katalon Auto Malphite', jiraName: 'Katalon Auto Malphite', boardId: '99',
      jiraTeams: [], components: [], sprintKeywords: [],
      settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 },
      source: 'jira',
      members: [{ id: 'm1', name: 'Someone', role: 'Auto QA', status: 'Active', supportPct: 0, jiraAccountId: 'acc-1', source: 'jira' }],
    }],
    sprints: [
      sprint('16178', 'TT Week 18May-24May', '2026-05-18', '2026-05-25', 'closed'),
      sprint('18499', 'TT Week 14Sep', '2026-09-14', '2026-09-27', 'active'),
    ],
    holidays: [], availability: {}, support: {}, ceremony: {}, overrides: {},
    risks: [], notes: {}, excluded: {}, savedSearches: [], sprintRoster: {}, scenarios: [],
    categoryRules: null, mixTargets: null,
  };
  const issue = (key, jiraSprint, points, done) => ({
    key, project: 'A', summary: key, issueType: 'Story',
    status: done ? 'Done' : 'In Progress', statusCategory: done ? 'done' : 'indeterminate',
    assignee: 'Someone', assigneeId: 'acc-1', points, components: [], labels: [],
    sprints: [{ id: jiraSprint, name: 'x', state: 'closed' }], blockedBy: [], datasets: ['sprintWork'],
  });
  const issues = [issue('A-1', '16178', 5, true), issue('A-2', '16178', 3, true), issue('A-3', '18499', 8, false)];
  const snap = {
    issues: Object.fromEntries(issues.map(i => [i.key, i])),
    byTeam: { malphite: { sprintIssues: { 16178: ['A-1', 'A-2'], 18499: ['A-3'] }, sprints: [], backlog: [], people: [] } },
    people: [{ name: 'Someone', accountId: 'acc-1' }],
  };

  const history = insights.velocityHistory(plan, snap, plan.teams[0]);
  assert.strictEqual(history.length, 2);
  assert.deepStrictEqual(history.map(h => h.number), [null, null],
    'precondition: the model reports no number, which is correct for a dated board');
  assert.deepStrictEqual(history.map(h => h.name), ['TT Week 18May-24May', 'TT Week 14Sep'],
    'and it does carry the name the axis needs');

  const svg = Charts.velocity(history);
  assert.ok(!/null/.test(svg), 'end to end, the axis must not say null');
  assert.deepStrictEqual(velocityTicks(svg), ['18May-24May', '14Sep']);
});

/* ── a stacked bar you can open ──────────────────────────────────────────
   The numbers on this chart are a drill-in, which means the markup has to
   carry enough to identify WHICH bar was pressed — and must carry none of it
   when nobody is listening, because a bar that looks clickable and is not is
   worse than one that plainly is not. */

const SERIES = [
  { key: 'ttBuild', label: 'New TT Build', color: '#123456', ink: '#fff' },
  { key: 'kseBuild', label: 'New KSE Build', color: '#654321', ink: '#fff' },
];
const STACK = [
  { label: 'Aug', start: '2026-08-01', end: '2026-08-31', partial: false, counts: { ttBuild: 12, kseBuild: 9 }, total: 21 },
  { label: 'Sep', start: '2026-09-01', end: '2026-09-30', partial: true, counts: { ttBuild: 7, kseBuild: 4 }, total: 11 },
];
const hooks = (svg) => [...svg.matchAll(/data-period="([^"]*)" data-bucket="([^"]*)"/g)].map(m => `${m[1]}|${m[2]}`);

check('A STACKED BAR IS INERT UNLESS THE CALLER ASKS FOR THE DRILL-IN', () => {
  const svg = Charts.stacked(STACK, SERIES);
  assert.doesNotMatch(svg, /data-act="backlog"/, 'no hooks');
  assert.doesNotMatch(svg, /drillable/, 'and nothing that looks clickable');
  assert.doesNotMatch(svg, /tabindex/, 'nor anything the keyboard stops on');
});

check('EVERY SEGMENT AND EVERY TOTAL CARRIES ITS OWN PERIOD AND COLUMN', () => {
  const svg = Charts.stacked(STACK, SERIES, { drill: true });
  assert.deepStrictEqual(hooks(svg).sort(), [
    '2026-08-01|', '2026-08-01|kseBuild', '2026-08-01|ttBuild',
    '2026-09-01|', '2026-09-01|kseBuild', '2026-09-01|ttBuild',
  ], 'two segments and one total per bar, each naming itself');
});

check('the period is identified by its DATE, never by its label or index', () => {
  // "Sep" is not unique across a window that spans years, and an index breaks
  // the moment the window changes under an open drawer.
  const svg = Charts.stacked(STACK, SERIES, { drill: true });
  assert.doesNotMatch(svg, /data-period="Sep"/);
  assert.doesNotMatch(svg, /data-period="[01]"/);
});

check('an empty segment is not a control — there is nothing behind it', () => {
  const svg = Charts.stacked(
    [{ label: 'Aug', start: '2026-08-01', end: '2026-08-31', counts: { ttBuild: 3, kseBuild: 0 }, total: 3 }],
    SERIES, { drill: true });
  assert.ok(hooks(svg).includes('2026-08-01|ttBuild'));
  assert.ok(!hooks(svg).includes('2026-08-01|kseBuild'), 'a zero opens an empty drawer and teaches nothing');
});

check('and a period with no total has no total to press', () => {
  const svg = Charts.stacked(
    [{ label: 'Aug', start: '2026-08-01', end: '2026-08-31', counts: { ttBuild: 0, kseBuild: 0 }, total: 0 }],
    SERIES, { drill: true });
  assert.deepStrictEqual(hooks(svg), []);
});

check('a period with no date is left inert rather than hooked to nothing', () => {
  // `start` is the identity. Without it the drawer would ask for `period=`
  // and the route would answer 409 — a control that always fails.
  const svg = Charts.stacked(
    [{ label: 'Aug', counts: { ttBuild: 3 }, total: 3 }], SERIES, { drill: true });
  assert.deepStrictEqual(hooks(svg), []);
  assert.doesNotMatch(svg, /data-act="backlog"/);
});

check('THE WHOLE SEGMENT IS THE TARGET, not just the number drawn in it', () => {
  // A value is only drawn where it fits; on a thin bar there is no number at
  // all, and a drill-in hung on the text would be unhittable exactly there.
  const thin = [{ label: 'Aug', start: '2026-08-01', end: '2026-08-31', counts: { ttBuild: 1, kseBuild: 400 }, total: 401 }];
  const svg = Charts.stacked(thin, SERIES, { drill: true });
  assert.ok(hooks(svg).includes('2026-08-01|ttBuild'), 'the sliver still opens');
  // The <g> wraps the rect, so the hit area is the bar rather than the glyph.
  assert.match(svg, /<g class="drillable"[^>]*data-bucket="ttBuild"[^>]*><rect/);
});

check('it is reachable and announced, not just clickable', () => {
  const svg = Charts.stacked(STACK, SERIES, { drill: true, unit: 'automated' });
  assert.match(svg, /role="button"/, 'a screen reader needs to know it is one');
  assert.match(svg, /tabindex="0"/, 'and the keyboard needs to reach it');
  assert.match(svg, /aria-label="Aug — New TT Build: 12 automated"/, 'with the value said out loud');
  assert.match(svg, /aria-label="Aug: 21 automated across every column"/, 'the total says what it opens');
});

check('and it is VISIBLY focusable — the suppression must be paired', () => {
  /* `.drillable:focus { outline: none }` on its own would leave a keyboard
     user tabbing through sixty invisible stops. It is only safe because
     `:focus-visible` puts a ring back, and the two rules have to travel
     together — verified in a browser under real Tab navigation, where
     `:focus-visible` matches and the 2px ring renders. */
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.drillable \{[^}]*cursor: pointer/, 'nothing says a segment can be clicked');
  assert.ok(css.includes('.drillable:focus-visible'), 'the ring the suppression depends on is missing');
  const off = css.indexOf('.drillable:focus {');
  const on = css.indexOf('.drillable:focus-visible');
  assert.ok(off === -1 || on > off,
    'the outline is suppressed after it is restored, so the restore is overridden');
  assert.match(css.slice(on, css.indexOf('}', on)), /outline: 2px solid/, 'and it draws nothing');
});

check('the hover title survives the wrapper', () => {
  // The <title> is the mouse-over value and predates the drill-in; wrapping
  // the rect in a <g> must not orphan it.
  assert.match(Charts.stacked(STACK, SERIES, { drill: true, unit: 'automated' }),
    /<title>Aug — New TT Build: 12 automated<\/title>/);
});

/* ── run ───────────────────────────────────────────────────────────── */

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
