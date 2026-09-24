'use strict';
/**
 * coverage-scope-ui.test.js — the two scope settings as they reach the screen.
 *
 * WHY THIS SUITE EXISTS
 *
 * The team-value menu is the control that makes the allow-list safe: his boards
 * are called "Katalon Auto Titan" and "Katalon Auto Ruby" while the Team FIELD
 * on those same epics reads "Katalon PSA (Titan)" and "Katalon RDA (Ruby)", and
 * an allow-list typed from the board names would have dropped more than half the
 * project without a word. The menu removes the typing. That only works if the
 * menu is legible, so its LAYOUT is part of its correctness, not decoration.
 *
 * It was not legible. `.card.wide > .setting-row` is a two-column grid —
 * 170px of label, then the control — and the rule that put things in the
 * control column named only `.hint`. The menu, added to that row later, was
 * auto-placed into the 170px LABEL column and wrapped into a narrow stack of
 * thirteen values beside 1,200px of empty card. Nothing was broken in a way a
 * logic check could see: the right markup was rendered into the wrong column.
 *
 * So this suite checks two things that are usually checked apart — that the
 * RULE puts every child of that row in the control column, and that the panel's
 * own arithmetic is right — because on this screen they are one feature.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-scope-ui-'));
fs.mkdirSync(path.join(SCRATCH, 'store'), { recursive: true });
process.env.STORE_DIR = SCRATCH;
process.env.DB_FILE = path.join(SCRATCH, 'store', 'test.db');
process.env.PORT = '0';

/* ── the fixture: his own team values, as Jira spells them ───────────
   Real names and real proportions, because the layout failure this suite
   exists for only shows up with names long enough to wrap and a list long
   enough to stack. */
const TEAMS = [
  ['Katalon PSA (Titan)', 40], ['Katalon Auto Malphite', 26], ['Katalon RDA (Ruby)', 22],
  ['', 12], ['Katalon Auto Moonstone', 6], ['The Backup Plan', 4], ['Lambda Legion', 3],
  ['Dashboard', 3], ['Katalon Auto PS', 2], ['Katalon Auto Mex', 2], ['Innovators', 1],
];
const ALLOWED = ['Katalon PSA (Titan)', 'Katalon RDA (Ruby)', 'Katalon Auto Mex'];
const TOTAL = TEAMS.reduce((a, [, n]) => a + n, 0);
const UNASSIGNED = TEAMS.find(([t]) => !t)[1];
const KEPT = TEAMS.filter(([t]) => ALLOWED.includes(t)).reduce((a, [, n]) => a + n, 0);

const EPICS = [];
let n = 0;
for (const [team, count] of TEAMS) {
  for (let i = 0; i < count; i++) {
    n++;
    EPICS.push({
      key: `AUTOKAT-${100 + n}`, project: 'AUTOKAT', summary: `suite ${n}`, issueType: 'Epic',
      status: 'Done', statusCategory: 'done', automationStatus: i % 2 ? 'Automated' : 'Ready for Automation',
      team, components: ['PS_Alpha'], labels: [], blockedBy: [], sprints: [], datasets: ['epics'],
    });
  }
}

const PLAN = {
  version: 1,
  teams: [{
    id: 'titan', name: 'Katalon Auto Titan', jiraName: 'Katalon PSA (Titan)', boardId: '2092',
    jiraTeams: [], components: [], sprintKeywords: ['TT Week'], members: [], source: 'jira',
    settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 },
  }],
  sprints: [{ id: 's1', name: 'TT Week 38', start: '2026-09-07', end: '2026-09-18', state: 'active', byTeam: { titan: true } }],
  holidays: [], availability: {}, support: {}, ceremony: {}, overrides: {}, risks: [], notes: {},
  excluded: {}, ignoredBoards: [], savedSearches: [], categoryRules: null, mixTargets: null,
  sprintRoster: {}, scenarios: [], componentPriority: {},
  excludedComponents: ['Technical_Works'], coverageTeams: ALLOWED,
};
fs.writeFileSync(path.join(SCRATCH, 'store', 'plan.json'), JSON.stringify(PLAN));
fs.writeFileSync(path.join(SCRATCH, 'store', 'snapshot.json'), JSON.stringify({
  syncedAt: '2026-09-14T00:00:00Z', watermark: null, source: 'jira',
  issues: Object.fromEntries(EPICS.map(i => [i.key, i])),
  sprints: [], components: [], testops: {}, github: {}, verification: [], fields: {},
  boards: [], boardSprintsByTeam: {}, boardSprintErrors: [], people: [], byTeam: {},
}));

const { server } = require('../server.js');
const db = require('../lib/db');

const PUBLIC = path.join(__dirname, '..', 'public');
const CSS = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');

let base = '';
const get = (p) => new Promise((resolve, reject) => {
  http.get(`${base}${p}`, (res) => {
    let out = '';
    res.on('data', c => { out += c; });
    res.on('end', () => { try { resolve(JSON.parse(out)); } catch (_) { resolve(out); } });
  }).on('error', reject);
});

/**
 * Settings, rendered with the real `ui.js` and the real `/api/state` — so what
 * is checked below is the markup the browser is handed, not a reconstruction.
 */
async function renderSettings(over = {}) {
  const el = () => ({
    addEventListener() {}, value: '', hidden: false, dataset: {}, style: {}, disabled: false,
    files: [], setAttribute() {}, getAttribute: () => null, select() {}, click() {}, innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelector: () => el(), querySelectorAll: () => [], contains: () => true,
  });
  const ctx = {
    console, Promise, setTimeout, clearTimeout, encodeURIComponent, CSS: { escape: String },
    confirm: () => true, prompt: () => '', App: { refresh() {} },
    Charts: new Proxy({}, { get: () => () => '' }),
    document: { createElement: () => el(), querySelector: () => el(), querySelectorAll: () => [] },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(PUBLIC, 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);

  const state = await get('/api/state');
  const scope = await get('/api/coverage/scope');
  if (over.coverageTeams) { state.plan.coverageTeams = over.coverageTeams; scope.coverageTeams = over.coverageTeams; }
  ctx.UI.api = async (p) => (p.startsWith('/api/coverage/scope') ? scope
    : p.startsWith('/api/audit') ? { entries: [] } : state);

  vm.runInContext(`${fs.readFileSync(path.join(PUBLIC, 'views', 'settings.js'), 'utf8')}\n;globalThis.__s = SettingsView;`, ctx);
  let html = '';
  const mount = {
    style: {}, addEventListener() {}, querySelector: () => el(), querySelectorAll: () => [],
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
  };
  await ctx.__s.render({ teamId: 'titan' }, mount);
  return { html, scope, panel: section(html, 'value-panel') };
}

/** The team-value panel, cut out of the page by its own markers. */
function section(html, cls) {
  const i = html.indexOf(`class="${cls}"`);
  if (i < 0) return '';
  const start = html.lastIndexOf('<div', i);
  // Balanced-div scan: the panel holds nested divs and a naive slice to the
  // first </div> would cut it off at the eyebrow.
  let depth = 0, k = start;
  while (k < html.length) {
    const open = html.indexOf('<div', k);
    const close = html.indexOf('</div>', k);
    if (close < 0) break;
    if (open >= 0 && open < close) { depth++; k = open + 4; } else {
      depth--; k = close + 6;
      if (depth === 0) return html.slice(start, k);
    }
  }
  return html.slice(start);
}

/** Every value button in the panel, as {name, count, on, disabled}. */
const buttons = (panel) => [...panel.matchAll(/<button class="chip([^"]*)"([\s\S]*?)<\/button>/g)].map(m => {
  const [, mods, rest] = m;
  const name = (rest.match(/<span>([\s\S]*?)<\/span>/) || [])[1] || '';
  const count = (rest.match(/<span class="muted">([\s\S]*?)<\/span>/) || [])[1] || '';
  return {
    name: name.trim(), count: count.trim(),
    on: / active/.test(mods), disabled: /\bdisabled\b/.test(rest),
    pressed: (rest.match(/aria-pressed="(\w+)"/) || [])[1],
  };
});

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

console.log('\nThe coverage scope settings, as rendered\n');

/* ══ the layout rule that put the menu in the label column ═════════════ */

check('EVERY CONTROL IN A WIDE SETTING ROW SITS IN THE CONTROL COLUMN', () => {
  /* The defect, pinned at its cause. The row is `170px | 1fr`; a child with no
     column of its own is auto-placed into the 170px one. Naming `.hint` was
     naming a single child, and the next child added to the row inherited the
     bug — which is exactly what happened to the team menu. The rule has to
     cover every non-label child, so a fourth one cannot repeat it. */
  const wide = CSS.slice(CSS.indexOf('@media (min-width: 1100px)'));
  const block = wide.slice(0, wide.indexOf('\n}'));
  assert.match(block, /\.card\.wide > \.setting-row > \*:not\(label\)/,
    'the wide-card rule must place every non-label child, not one named class');
  assert.match(block, /\.drawer-panel \.setting-row > \*:not\(label\)/, 'and the same in a drawer');
  assert.match(block, /grid-column:\s*2/, 'in column 2 — the control column');

  // The label is what stays in column 1. If this ever stopped being true the
  // rule above would push the label out of its own column too.
  assert.match(CSS, /\.setting-row > label \{/, 'the label is still addressed as a direct child');
});

check('and the menu is a grid that fills the width it is given', () => {
  // auto-fill, not a fixed column count: the same markup is one column in a
  // narrow drawer and six in a full-width card. A fixed count would be the
  // stacked-column bug again, just at a different width.
  const rule = CSS.slice(CSS.indexOf('.value-menu {'), CSS.indexOf('.value-menu {') + 200);
  assert.match(rule, /display:\s*grid/);
  assert.match(rule, /repeat\(auto-fill,\s*minmax\(/, 'auto-fill so the column count follows the space');

  // And the name is the part that truncates — never the count, which is the
  // number the reader came for.
  assert.match(CSS, /\.value-menu \.chip > span:first-child \{[^}]*text-overflow:\s*ellipsis/);
  assert.match(CSS, /\.value-menu \.chip > \.muted \{[^}]*flex:\s*none/,
    'the count must not be allowed to shrink or clip');
});

check('a count inside a selected value stays readable on the brand colour', () => {
  // `.chip.active` is white-on-blue; `.muted` is a grey chosen for white. The
  // count was inheriting that grey onto blue, which is the one combination on
  // this page that fails contrast — and it is the number, not the chrome.
  assert.match(CSS, /\.chip\.active \.muted \{[^}]*color:\s*rgba\(255,\s*255,\s*255/);
});

/* ══ what the panel says ══════════════════════════════════════════════ */

check('EVERY VALUE IN THE DATA GETS A BUTTON, CHOSEN ONES INCLUDED', async () => {
  const { panel, scope } = await renderSettings();
  assert.ok(panel, 'the panel rendered at all');
  const b = buttons(panel);
  assert.strictEqual(b.length, scope.teamValues.length,
    'a chosen value disappearing from the menu is how you lose track of why a team is missing');
  for (const v of scope.teamValues) {
    assert.ok(b.some(x => x.name === v.name), `${v.name} has no button`);
  }
  // Each name is its own span, so the count can be right-aligned against it.
  // Without the split they are one text run and the grid cannot align anything.
  assert.ok(b.every(x => x.name && x.count), 'name and count are separate elements');
});

check('and the chosen ones are marked, for a pointer and for a screen reader', async () => {
  const b = buttons((await renderSettings()).panel);
  const on = b.filter(x => x.on).map(x => x.name).sort();
  assert.deepStrictEqual(on, [...ALLOWED].sort());
  assert.ok(b.every(x => x.pressed === (x.on ? 'true' : 'false')),
    'aria-pressed has to agree with the colour, or the control is only legible to people who can see it');
});

check('THE RUNNING TOTAL IS THE SUM OF WHAT IS SELECTED', async () => {
  /* The question every click here is really asking. Before, it was answerable
     only by saving, opening Overall Coverage and reading the headline. An epic
     is on at most one team, so these counts partition the population and the
     sum is exact rather than an estimate. */
  const { panel } = await renderSettings();
  const total = section(panel, 'value-total') || panel.slice(panel.indexOf('value-total'));
  assert.ok(total.includes(String(KEPT)), `the kept count ${KEPT} is not on screen`);
  assert.ok(total.includes(String(TOTAL)), `the population ${TOTAL} is not on screen`);
  assert.ok(total.includes(`${Math.round((KEPT / TOTAL) * 100)}%`), 'and the share it works out to');
  assert.ok(KEPT < TOTAL, 'the fixture has to actually drop something or this proves nothing');
});

check('and an empty allow-list says EVERYTHING counts, not nothing', async () => {
  // The state where summing the selected values gives zero and is badly wrong:
  // no allow-list is not "no teams", it is "every team".
  const { panel } = await renderSettings({ coverageTeams: [] });
  const total = panel.slice(panel.indexOf('value-total'));
  const words = total.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.match(words, new RegExp(`\\bAll ${TOTAL} epics counted\\b`),
    `it has to read "All ${TOTAL} epics counted" — got: ${words}`);
  assert.ok(!/\b0 of\b/.test(words), 'and never "0 of" — that is the reading it exists to prevent');
  assert.ok(!buttons(panel).some(x => x.on), 'and nothing is marked as chosen');
});

check('AN ALLOW-LIST ALWAYS DROPS THE EPICS WITH NO TEAM, and says how many', async () => {
  /* The consequence he is most likely to be surprised by, and the largest one
     in his data. "— no team —" cannot be allowed by name, so the moment the
     list is non-empty those epics leave the ratio. */
  const { panel } = await renderSettings();
  const b = buttons(panel);
  const none = b.find(x => x.disabled);
  assert.ok(none, 'the no-team value is present and not clickable — it cannot be allowed by name');
  assert.ok(!none.on, 'and never marked as counted');
  const total = panel.slice(panel.indexOf('value-total'));
  assert.ok(total.includes(String(UNASSIGNED)),
    `${UNASSIGNED} epics have no team and the panel has to say so while a list is in force`);
});

check('and it is not mentioned when there is no allow-list to drop them', async () => {
  // With no list, nothing is dropped, and a warning about epics that are being
  // counted normally is noise that teaches the reader to ignore the line.
  const { panel } = await renderSettings({ coverageTeams: [] });
  const total = panel.slice(panel.indexOf('value-total'));
  assert.ok(!/no team at all/.test(total), 'nothing is being dropped, so nothing is warned about');
});

check('a name that is not in the data adds nothing to the total', async () => {
  // Typing a board name instead of a Team value — the exact mistake the menu
  // exists to prevent. It must not be credited with epics it does not match.
  const { panel } = await renderSettings({ coverageTeams: ['Katalon Auto Titan'] });
  const total = panel.slice(panel.indexOf('value-total'));
  assert.ok(total.includes('0 of'),
    'a value matching no epic counts zero — which is the signal that the name is wrong');
  assert.ok(!buttons(panel).some(x => x.on), 'and no button lights up for it');
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
  try { db.close(); } catch (_) { /* fine */ }
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
