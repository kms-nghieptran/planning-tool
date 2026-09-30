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

/* ── READING THE PAGE AS IF IT WERE LIGHT ───────────────────────────────
 *
 * A chart that leaves the tool goes somewhere this app does not control: an
 * email body, a deck, a document — all overwhelmingly light. A dark-theme chart
 * dropped into one arrives as a black slab with a hole punched in the page.
 *
 * The theme lives in one attribute on `<html>` and every token keys off it, so
 * the export flips it, takes every measurement, and flips it back inside ONE
 * task. A browser paints between tasks and never inside one, so nothing reaches
 * the screen. What has to be guaranteed is that it always flips BACK — leaving
 * somebody's app in the wrong theme because an export failed is a far worse bug
 * than the one being fixed.
 */

/** `<html>` and nothing else — it is all `inLightTheme` touches. */
function stubDoc(theme) {
  let attr = theme;
  ctx.document = {
    documentElement: {
      getAttribute: (k) => (k === 'data-theme' ? attr : null),
      setAttribute: (k, v) => { if (k === 'data-theme') attr = v; },
    },
  };
  return () => attr;
}

check('THE EXPORT READS THE PAGE IN LIGHT THEME, not in his', () => {
  const read = stubDoc('dark');
  let sawInside = null;
  Charts.inLightTheme(() => { sawInside = read(); });
  assert.strictEqual(sawInside, 'light',
    `the colours were read in ${sawInside} theme, so the emailed chart is dark`);
});

check('AND PUTS IT BACK, so nobody is left in the wrong theme', () => {
  const read = stubDoc('dark');
  Charts.inLightTheme(() => 'done');
  assert.strictEqual(read(), 'dark', `his theme was left as ${read()}`);
});

check('AND PUTS IT BACK EVEN WHEN THE EXPORT THROWS', () => {
  /* The whole reason it is a `finally`. An export can fail — a canvas the
     browser will not allocate, a token that resolves to nothing — and the
     failure must not also flip his app to light until he reloads. */
  const read = stubDoc('dark');
  assert.throws(() => Charts.inLightTheme(() => { throw new Error('canvas refused'); }), /canvas refused/);
  assert.strictEqual(read(), 'dark', `a failed export left his theme as ${read()}`);
});

check('AND THE RETURN VALUE COMES BACK OUT', () => {
  /* The background colour is measured inside and used outside. A wrapper that
     swallowed it would paint every chart on the fallback white. */
  stubDoc('dark');
  assert.strictEqual(Charts.inLightTheme(() => '#FFFFFF'), '#FFFFFF');
});

check('A PAGE ALREADY IN LIGHT THEME IS NOT TOUCHED AT ALL', () => {
  const read = stubDoc('light');
  let seen = null;
  Charts.inLightTheme(() => { seen = read(); });
  assert.strictEqual(seen, 'light');
  assert.strictEqual(read(), 'light', 'a light page was left as something else');
});

/* ── A CHART THAT HAS TO STAND ALONE ────────────────────────────────────
 *
 * The emailed report carried a photograph of the bars and nothing else: four
 * colours, no key, and no caption saying what the picture was of. On the page
 * the surrounding markup supplied all of that — an `<h3>` in the section head,
 * a `.mixkey` under the card — and none of it is inside the element the
 * capture clips.
 *
 * So the title and the key are drawn INTO the SVG, which fixes both exits at
 * once: the server-side capture clips one element and gets the whole figure,
 * and Save PNG serializes the same SVG.
 */

const KEYED = [
  { key: 'ttBuild', label: 'New TT Build', color: '#0047B3', ink: '#FFFFFF' },
  { key: 'kseBuild', label: 'New KSE Build', color: '#2E86FF', ink: '#10112A' },
  { key: 'ttMaint', label: 'TT Maintenance', color: '#A3004A', ink: '#FFFFFF' },
  { key: 'kseMaint', label: 'KSE Maintenance', color: '#FF5C9B', ink: '#10112A' },
];
const KEYED_DATA = [
  { label: 'Aug', start: '2026-08-01', counts: { ttBuild: 12, kseBuild: 9, ttMaint: 4, kseMaint: 2 }, total: 27 },
  { label: 'Sep', start: '2026-09-01', partial: true, counts: { ttBuild: 7, kseBuild: 4, ttMaint: 3, kseMaint: 1 }, total: 15 },
];
const viewBoxOf = (svg) => (svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/) || []).slice(1).map(Number);

check('THE CHART CARRIES ITS OWN TITLE, so a photograph of it says what it is', () => {
  const svg = Charts.stacked(KEYED_DATA, KEYED, { title: 'Backlog Movement', legend: true });
  assert.ok(svg.includes('>Backlog Movement<'), 'the title is not drawn');
  /* AS TEXT IN THE PICTURE, not as an SVG <title>. `<title>` is a tooltip and
     an accessible name — it does not appear in a screenshot or a rasterized
     PNG at all, which is exactly the trap here. */
  assert.ok(!/<title>Backlog Movement<\/title>/.test(svg),
    'the title was put somewhere a photograph cannot see it');
});

check('AND ITS OWN KEY, naming every series it draws', () => {
  const svg = Charts.stacked(KEYED_DATA, KEYED, { title: 'Backlog Movement', legend: true });
  for (const s of KEYED) {
    assert.ok(svg.includes(`>${s.label}<`), `the key does not name ${s.label}`);
    /* AND THE SWATCH BESIDE IT. A list of four names with no colours is not a
       key — the reader still cannot tell which band is which. */
    assert.ok(svg.includes(`fill="${s.color}"`), `no swatch is drawn for ${s.label}`);
  }
  const swatches = (svg.match(/<rect[^>]*rx="2"[^>]*\/>/g) || []).length;
  assert.strictEqual(swatches, KEYED.length, `${swatches} swatches for ${KEYED.length} series`);
});

check('THE CANVAS GROWS FOR THEM — the plot does not shrink to make room', () => {
  /* A chart that gets shorter every time you give it a longer caption is one
     nobody trusts to be to scale. */
  const bare = viewBoxOf(Charts.stacked(KEYED_DATA, KEYED, {}));
  const full = viewBoxOf(Charts.stacked(KEYED_DATA, KEYED, {
    title: 'Backlog Movement', subtitle: 'Aug – Sep', legend: true,
  }));
  assert.strictEqual(bare[0], full[0], 'the chart changed width');
  assert.ok(full[1] > bare[1], `the canvas did not grow: ${bare[1]} → ${full[1]}`);
});

check('AND THE BARS KEEP THEIR SCALE, which is the point of growing it', () => {
  /* The tallest bar must still reach the same proportion of the plot. If the
     plot had absorbed the caption instead, every bar would be shorter and the
     picture would understate the work. */
  const tallest = (svg) => {
    const rects = [...svg.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"/g)];
    return Math.max(...rects.map(m => Number(m[2])));
  };
  const bare = Charts.stacked(KEYED_DATA, KEYED, {});
  const full = Charts.stacked(KEYED_DATA, KEYED, { title: 'Backlog Movement', legend: true });
  assert.ok(Math.abs(tallest(bare) - tallest(full)) < 1,
    `the bars were rescaled: ${tallest(bare)} vs ${tallest(full)}`);
});

check('THE X-AXIS LABELS CLEAR THE KEY, rather than being drawn through it', () => {
  /* They were pinned to the bottom of the canvas. The key now sits there, and a
     period label measured from `H` would be drawn over it. */
  const svg = Charts.stacked(KEYED_DATA, KEYED, { title: 'Backlog Movement', legend: true });
  const [, H] = viewBoxOf(svg);
  const periodY = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)" text-anchor="middle" font-size="9\.5" fill="[^"]*">(?:Aug|Sep)</g)]
    .map(m => Number(m[1]));
  assert.ok(periodY.length, 'no period labels were found at all');
  /* AND THE "so far" MARKER, which is the one that actually collides. It sits
     11px BELOW the period label, so a version that cleared the key by a
     comfortable margin on the period labels alone still drew this one straight
     through the swatches — and a check that looked only at the labels above it
     went on passing. */
  const soFarY = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)" text-anchor="middle" font-size="8"[^>]*>so far</g)]
    .map(m => Number(m[1]));
  assert.ok(soFarY.length, 'fixture check: no partial period, so the lower label is not exercised');

  const keyTop = Number((svg.match(/<rect x="[\d.]+" y="([\d.]+)" width="9" height="9" rx="2"/) || [])[1]);
  assert.ok(Number.isFinite(keyTop), 'no key swatch was found');

  /* THE INVARIANT IS THE BAND, NOT THE NEAR MISS. Asserting only "above the
     swatches" passed a version that measured the labels from the bottom of the
     CANVAS instead of from the bottom of the PLOT — it happened to land ten
     pixels clear at four series and one legend row, and would have been drawn
     straight through a second row. What has to hold is that the axis furniture
     stays inside the plot's own bottom padding and the key has the band below
     it to itself. */
  const bare = viewBoxOf(Charts.stacked(KEYED_DATA, KEYED, { title: 'Backlog Movement' }))[1];
  const keyBand = H - bare;
  assert.ok(keyBand > 0, 'fixture check: the key reserved no space at all');
  for (const y of [...periodY, ...soFarY]) {
    /* STRICTLY ABOVE. A baseline sitting exactly ON the boundary puts the
       label's descenders into the key's band, and "exactly on it" is precisely
       where a version that measured from the canvas instead of from the plot
       happened to land. */
    assert.ok(y < H - keyBand,
      `an axis label at y=${y} reaches the key's own band, which starts at y=${H - keyBand}`);
    assert.ok(y < keyTop, `an axis label sits at y=${y}, on top of the key which starts at y=${keyTop}`);
    assert.ok(y < H, `an axis label at y=${y} is off the bottom of a ${H}px canvas`);
  }
});

check('NOTHING IS DRAWN WHEN NOTHING WAS ASKED FOR', () => {
  /* Four other charts share this function and none of them wants a caption. */
  const svg = Charts.stacked(KEYED_DATA, KEYED, { drill: true });
  assert.ok(!svg.includes('Backlog Movement'));
  assert.strictEqual((svg.match(/rx="2"/g) || []).length, 0, 'a key was drawn unasked');
  assert.deepStrictEqual(viewBoxOf(svg), [900, 300], 'the default canvas changed size');
});

check('A SUBTITLE IS OPTIONAL AND DOES NOT DISPLACE THE TITLE', () => {
  const withSub = Charts.stacked(KEYED_DATA, KEYED, { title: 'Backlog Movement', subtitle: 'Aug – Sep · all components' });
  assert.ok(withSub.includes('>Aug – Sep · all components<'), 'the subtitle is not drawn');
  const titleY = Number(withSub.match(/y="([\d.]+)"[^>]*font-weight="700"[^>]*>Backlog Movement</)[1]);
  const subY = Number(withSub.match(/y="([\d.]+)"[^>]*>Aug – Sep/)[1]);
  assert.ok(subY > titleY, `the subtitle (${subY}) is not below the title (${titleY})`);
});

check('AND THE CAPTION IS ESCAPED, because a component name is somebody else\'s string', () => {
  /* Component names come from Jira and go straight into the subtitle. */
  const svg = Charts.stacked(KEYED_DATA, KEYED, { title: 'A & B', subtitle: '<script>x</script>' });
  assert.ok(svg.includes('A &amp; B'), 'the title was not escaped');
  assert.ok(!svg.includes('<script>'), 'markup from a component name reached the SVG');
});

/* ── A CHART THAT LEAVES THE PAGE ───────────────────────────────────────
 *
 * Every colour in these charts is a CSS custom property, which is what makes
 * them theme correctly and what makes them WORTHLESS the moment they are
 * serialized: `var(--cov-automated)` resolves against nothing outside the
 * document, so a naive export is a black-on-transparent rectangle. The `Save
 * PNG` button and the chart in the emailed report both depend on that not
 * happening.
 *
 * `literal` is the part of it that can be checked without a DOM, and it is the
 * part that carries the whole risk — so it is checked hard.
 */

const ROOT = {
  '--cov-automated': '#2E7D32',
  '--app-fg-3': '#6B7280',
  '--indirect': 'var(--cov-automated)',
  '--loop': 'var(--loop)',
  '--blank': '',
};
const rootStyle = { getPropertyValue: (k) => (ROOT[k] == null ? '' : ROOT[k]) };

check('A COLOUR TOKEN IS RESOLVED TO SOMETHING A CANVAS UNDERSTANDS', () => {
  assert.strictEqual(Charts.literal('var(--cov-automated)', rootStyle), '#2E7D32');
  assert.strictEqual(Charts.literal('var(--app-fg-3)', rootStyle), '#6B7280');
});

check('and a plain colour passes through untouched', () => {
  assert.strictEqual(Charts.literal('#123456', rootStyle), '#123456');
  assert.strictEqual(Charts.literal('none', rootStyle), 'none');
  assert.strictEqual(Charts.literal('', rootStyle), '');
});

check('A TOKEN DEFINED AS ANOTHER TOKEN RESOLVES ALL THE WAY DOWN', () => {
  /* Normal in this stylesheet — the brand file defines the `--cov-*` set in
     terms of other tokens — and a single-pass resolver would leave `var(` in
     the output and paint the bar black. */
  assert.strictEqual(Charts.literal('var(--indirect)', rootStyle), '#2E7D32');
});

check('AND A TOKEN THAT REFERS TO ITSELF DOES NOT HANG THE TAB', () => {
  /* A stylesheet bug must not become a browser that stops responding while
     somebody waits for a download. */
  assert.strictEqual(Charts.literal('var(--loop)', rootStyle), '');
});

check('A FALLBACK IS USED WHEN THE TOKEN IS NOT DEFINED', () => {
  assert.strictEqual(Charts.literal('var(--nope, #ABCDEF)', rootStyle), '#ABCDEF');
  /* An EMPTY token with a fallback takes the fallback — which is what CSS
     itself does, and the difference between a legible chart and a black one on
     any theme that does not define every token. */
  assert.strictEqual(Charts.literal('var(--blank, #FEDCBA)', rootStyle), '#FEDCBA');
});

check('AN UNRESOLVED TOKEN COMES BACK EMPTY, never as the literal "var(...)"', () => {
  /* The caller skips empty answers and keeps the element's own attribute.
     Writing `var(--nope)` onto the clone instead would put that string into the
     serialized SVG, where the canvas reads it as an invalid paint and draws
     black — the exact failure this function exists to prevent. */
  const out = Charts.literal('var(--nope)', rootStyle);
  assert.strictEqual(out, '');
  assert.ok(!out.includes('var('), 'a var() reached the output');
});

/* ── THE BUG THAT SHIPPED ────────────────────────────────────────────────
 *
 * "Could not save the chart — The browser could not turn the chart into an
 * image." Nothing was wrong with the browser. The padding read
 *
 *     Math.max(0, Number(o.padding) == null ? 16 : Number(o.padding))
 *
 * meaning "no padding given, use 16" — but `Number(undefined)` is `NaN`, and
 * `NaN == null` is FALSE, so the default never fired. The padding came out
 * `NaN`, the canvas was sized `NaN` and clamped to 0 × 0, and `toBlob` on a
 * zero-size canvas hands back `null` rather than throwing. Every step reported
 * success and the message blamed the browser for arithmetic done here.
 *
 * It shipped because nothing checked the ONE call the button actually makes:
 * `toPng(svg, { scale: 2 })`, with no padding. Every check covered the parts
 * that needed a DOM or the parts that took explicit arguments.
 */

check('THE DEFAULT PADDING IS A NUMBER — the NaN canvas', () => {
  /* `{ scale: 2 }` and nothing else is exactly what Save PNG passes. */
  const box = Charts.shotBox(900, 300, { scale: 2 });
  assert.strictEqual(box.ok, true, `the button's own call is refused: ${box.why}`);
  assert.strictEqual(box.pad, 16, `the padding default did not fire: ${box.pad}`);
  assert.ok(Number.isFinite(box.width) && Number.isFinite(box.height),
    `the canvas is ${box.width}×${box.height}`);
  assert.strictEqual(box.width, 1864);
  assert.strictEqual(box.height, 664);
});

check('AND WITH NO OPTIONS AT ALL, which is the other way in', () => {
  const box = Charts.shotBox(900, 300);
  assert.strictEqual(box.ok, true);
  assert.strictEqual(box.pad, 16);
  assert.strictEqual(box.scale, 2);
  assert.ok(box.width > 0 && box.height > 0, `${box.width}×${box.height}`);
});

check('AN EXPLICIT ZERO PADDING IS HONOURED, not treated as absent', () => {
  /* The bug's tempting one-character fix — `Number(o.padding) || 16` — passes
     every check above and silently turns a deliberate 0 into 16. */
  const box = Charts.shotBox(900, 300, { padding: 0 });
  assert.strictEqual(box.pad, 0, 'an explicit 0 was overridden by the default');
  assert.strictEqual(box.width, 1800);
});

check('AND RUBBISH PADDING FALLS BACK rather than producing a NaN canvas', () => {
  for (const bad of [{ padding: 'wide' }, { padding: NaN }, { padding: Infinity }]) {
    const box = Charts.shotBox(900, 300, bad);
    assert.strictEqual(box.ok, true, `${JSON.stringify(bad)} was refused`);
    assert.ok(Number.isFinite(box.width), `${JSON.stringify(bad)} gave width ${box.width}`);
    assert.ok(box.width > 0, `${JSON.stringify(bad)} gave a ${box.width}px canvas`);
  }
  /* A NEGATIVE ONE IS CLAMPED, not subtracted — it would crop the chart. */
  assert.strictEqual(Charts.shotBox(900, 300, { padding: -50 }).pad, 0);
});

check('A CHART WITH NO SIZE IS REFUSED BY NAME, not as "the browser failed"', () => {
  /* The zero-size canvas is the case that produced the useless message. It is
     now caught where the arithmetic is, and says what it measured. */
  for (const [w, h] of [[0, 0], [0, 300], [900, 0], [NaN, 300]]) {
    const box = Charts.shotBox(w, h, { scale: 2 });
    assert.strictEqual(box.ok, false, `${w}×${h} was accepted`);
    assert.match(box.why, /cannot be drawn|not something/i, `unhelpful reason: ${box.why}`);
  }
});

check('AND A CHART SO LARGE THE CANVAS OVERFLOWS IS REFUSED TOO', () => {
  /* The second guard, and the only thing that reaches it: a finite width that
     is still large enough for `(w + pad) * scale` to come out Infinity. The
     first guard passes it — 1e308 is a finite number — and without the second
     one the canvas is sized Infinity, clamps to 0, and `toBlob` hands back the
     null that started all this. */
  const box = Charts.shotBox(1e308, 300, { scale: 4 });
  assert.strictEqual(box.ok, false, 'a canvas that overflows to Infinity was accepted');
  assert.match(box.why, /canvas/i, `the reason does not name what went wrong: ${box.why}`);
  /* AND THE FIRST GUARD LETS IT THROUGH, which is what makes the second one
     load-bearing rather than decorative. */
  assert.ok(Number.isFinite(1e308), 'fixture check: this must pass the chart-size guard');
});

check('THE SCALE IS CLAMPED, so a wild one cannot ask for a canvas nothing will allocate', () => {
  assert.strictEqual(Charts.shotBox(900, 300, { scale: 99 }).scale, 4);
  assert.strictEqual(Charts.shotBox(900, 300, { scale: 0 }).scale, 2, 'zero should take the default');
  assert.strictEqual(Charts.shotBox(900, 300, { scale: -3 }).scale, 1);
  assert.strictEqual(Charts.shotBox(900, 300, { scale: 'big' }).scale, 2);
});

check('THE EXPORT IS EXPOSED AT ALL, because two callers now depend on it', () => {
  assert.strictEqual(typeof Charts.toPng, 'function', 'Save PNG has nothing to call');
  assert.strictEqual(typeof Charts.literal, 'function');
});

check('AND IT REFUSES SOMETHING THAT IS NOT A CHART rather than throwing past the handler', async () => {
  /* The button hands over whatever `querySelector` found. A null there means
     the page changed shape, and the click handler turns the rejection into a
     message saying so — but only if this REJECTS. A synchronous throw from an
     async function is still a rejection; a throw before the promise exists
     would not be, and would reach the user as a dead button. */
  await assert.rejects(() => Charts.toPng(null), /not a chart/i);
  await assert.rejects(() => Charts.toPng({}), /not a chart/i);
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
