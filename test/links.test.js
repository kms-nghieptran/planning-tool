'use strict';
/**
 * links.test.js — every issue key goes to Jira.
 *
 * WHY THIS SUITE EXISTS
 *
 * Keys were rendered in seven places across six views, and exactly ONE of them
 * was a link: the Search page, because `/api/search` happened to return
 * `jiraBase` in its payload and that view happened to use it. Every other
 * screen printed `<td class="mono">AUTOKAT-1234</td>` — a key you retype into
 * Jira's search box.
 *
 * The fix is one helper, `UI.issueKey()`, fed once at boot from `/api/state`.
 * The interesting risk is not that the helper is wrong; it is that the NEXT
 * table to show a key will reach for `UI.esc(i.key)` because that is what the
 * rows above it do. So the checks here work two ways:
 *
 *   - the helper is exercised directly, including the cases that make it safe
 *     (escaping, no base configured, `rel="noopener"`);
 *   - and the VIEWS are swept for raw key rendering, so a new table that prints
 *     a key without going through the helper fails this suite rather than
 *     shipping as the one screen where keys are dead again.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nEvery issue key goes to Jira\n');

const PUBLIC = path.join(__dirname, '..', 'public');
const VIEWS = path.join(PUBLIC, 'views');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

/** Load `public/ui.js` the way the browser does, and hand back the UI object. */
function loadUI() {
  const ctx = { document: { createElement: () => ({ set innerHTML(_) {}, content: { firstElementChild: null } }) }, console };
  vm.createContext(ctx);
  vm.runInContext(`${read(PUBLIC, 'ui.js')}\n;globalThis.__ui = UI;`, ctx);
  return ctx.__ui;
}

const BASE = 'https://ipipelinejira.atlassian.net';

/* ── the helper ───────────────────────────────────────────────────────── */

check('A KEY BECOMES A LINK TO THAT ISSUE IN JIRA', () => {
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const html = UI.issueKey('AUTOKAT-1234');
  assert.match(html, /href="https:\/\/ipipelinejira\.atlassian\.net\/browse\/AUTOKAT-1234"/);
  assert.match(html, />AUTOKAT-1234</, 'the key is still what is shown — the link is an addition, not a replacement');
});

check('it opens in a new tab, and severs the opener', () => {
  // target="_blank" without rel="noopener" hands the opened page a live
  // `window.opener` back to this one. This is a tool, not a toy.
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const html = UI.issueKey('AUTOKAT-1');
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener"/);
});

check('A TRAILING SLASH ON THE CONFIGURED URL DOES NOT DOUBLE UP', () => {
  const UI = loadUI();
  UI.setJiraBase('https://x.atlassian.net///');
  assert.match(UI.issueKey('A-1'), /href="https:\/\/x\.atlassian\.net\/browse\/A-1"/);
});

check('WITH NO JIRA URL CONFIGURED THE KEY IS PLAIN TEXT, NOT A BROKEN LINK', () => {
  // A tool set up without a Jira base must keep working. `/browse/A-1` with no
  // host would resolve against the planning tool's own origin and 404.
  const UI = loadUI();
  UI.setJiraBase('');
  const html = UI.issueKey('AUTOKAT-1');
  assert.ok(!/<a/.test(html), `expected no anchor, got ${html}`);
  assert.match(html, /AUTOKAT-1/);
});

check('a missing key renders a dash rather than an empty cell', () => {
  const UI = loadUI();
  UI.setJiraBase(BASE);
  assert.match(UI.issueKey(null), /—/);
  assert.match(UI.issueKey(''), /—/);
});

check('A KEY IS ESCAPED IN THE TEXT AND ENCODED IN THE URL', () => {
  // Keys come from Jira, but they reach this helper through the same store
  // that accepts locally-created issues, and "trust the source" is how markup
  // ends up in a page.
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const html = UI.issueKey('A-1"><script>alert(1)</script>');
  assert.ok(!/<script>/.test(html), `unescaped markup reached the page: ${html}`);
  assert.match(html, /%3Cscript%3E/, 'the URL side must be percent-encoded, not merely HTML-escaped');
});

check('a list of keys links each one', () => {
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const html = UI.issueKeys(['A-1', 'A-2']);
  assert.strictEqual((html.match(/<a /g) || []).length, 2);
  assert.match(html, /A-1<\/a>, <a /, 'they read as a list, not as one run-on link');
});

check('and an empty list renders nothing at all', () => {
  const UI = loadUI();
  UI.setJiraBase(BASE);
  assert.strictEqual(UI.issueKeys([]), '');
  assert.strictEqual(UI.issueKeys(null), '');
});

/* ── the wiring ───────────────────────────────────────────────────────── */

check('THE BASE URL IS SET FROM /api/state ON EVERY ADOPT, NOT ONLY AT BOOT', () => {
  // Changing the Jira URL in settings re-fetches state. If the base were set
  // once at boot, every key on the page would keep linking to the old host
  // until the tab was reloaded — and nothing would look wrong.
  const app = read(PUBLIC, 'app.js');
  const adopt = app.slice(app.indexOf('function adopt(s)'), app.indexOf('function adopt(s)') + 900);
  assert.match(adopt, /UI\.setJiraBase\(/, 'adopt() is what runs on every state fetch');

  const server = read(__dirname, '..', 'server.js');
  const state = server.slice(server.indexOf("p === '/api/state'"), server.indexOf("p === '/api/state'") + 2600);
  assert.match(state, /jiraBase:/, '/api/state must carry the base, or the UI has nothing to set');
});

/* ── a component links to that component in Jira ──────────────────────── */

check('A COMPONENT SEARCH REPRODUCES THE SCOPE OF THE NUMBER BESIDE IT', () => {
  // A link that opens a different set from the count it sits next to is worse
  // than no link: you cannot tell which of the two is wrong. Same project,
  // same issue type as the screen is counting.
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const url = UI.componentSearchUrl({ component: 'PS_iGO_NLG', project: 'AUTOKAT', scope: 'Epic' });
  const jql = decodeURIComponent(url.split('jql=')[1]);
  assert.ok(url.startsWith(`${BASE}/issues/?jql=`), `not an issue-navigator URL: ${url}`);
  assert.match(jql, /project = "AUTOKAT"/);
  assert.match(jql, /issuetype = "Epic"/);
  assert.match(jql, /component = "PS_iGO_NLG"/);
});

check('THE "NO COMPONENT" BUCKET SEARCHES FOR EMPTY, NOT FOR A COMPONENT CALLED THAT', () => {
  // `— no component —` is a label this app invented. Passing it to Jira as a
  // component name returns nothing and looks like the data is wrong.
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const jql = decodeURIComponent(UI.componentSearchUrl({ component: null, project: 'AUTOKAT', scope: 'Epic' }).split('jql=')[1]);
  assert.match(jql, /component IS EMPTY/);
  assert.ok(!/component = /.test(jql));
});

check('a quote in a component name cannot break out of the JQL string', () => {
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const jql = decodeURIComponent(UI.componentSearchUrl({ component: 'A" OR x = "y', project: 'P', scope: 'Epic' }).split('jql=')[1]);
  assert.match(jql, /component = "A\\" OR x = \\"y"/, `unescaped quote reached the JQL: ${jql}`);
});

check('with no Jira URL configured there is no component link at all', () => {
  const UI = loadUI();
  UI.setJiraBase('');
  assert.strictEqual(UI.componentSearchUrl({ component: 'X', project: 'P', scope: 'Epic' }), null);
});

check('BOTH COVERAGE SCREENS LINK THEIR COMPONENTS, AND THE API SENDS THE PROJECT KEY', () => {
  // The JQL needs the project, which lives in config and not in the model, so
  // the route has to add it. Without it the link silently searches every
  // project on the instance.
  const server = read(__dirname, '..', 'server.js');
  for (const route of ["/api/reports/coverage", "/api/reports/automation"]) {
    const at = server.indexOf(`p === '${route}'`);
    assert.ok(at > 0, `${route} is missing`);
    assert.match(server.slice(at, at + 700), /project: cfg\.jira\.projectKey/, `${route} does not send the project key`);
  }
  assert.match(read(VIEWS, 'report-coverage.js'), /UI\.componentSearchUrl\(/);
  assert.match(read(VIEWS, 'report-automation.js'), /UI\.componentSearchUrl\(/);
});

check('the Jira link does not swallow the in-screen filter, or the other way round', () => {
  // The delegated handler calls preventDefault on anything with
  // `data-component`. If the Jira anchor carried that attribute the link would
  // never navigate; if the filter button lost it, drilling in would break.
  const src = read(VIEWS, 'report-coverage.js');
  const cell = src.slice(src.indexOf('function componentCell'), src.indexOf('const NO_COMPONENT'));
  assert.ok(!/comp-jira[^`]*data-component/.test(cell), 'the Jira anchor must NOT carry data-component');
  assert.match(cell, /class="comp-filter" data-component=/, 'the filter button must carry it');
  assert.match(cell, /target="_blank" rel="noopener"/);
});

check('a selected component still has a way into Jira', () => {
  // Both tables are hidden once one component is picked, so the link would
  // otherwise have nowhere to live.
  const src = read(VIEWS, 'report-coverage.js');
  const picker = src.slice(src.indexOf('function picker(d)'), src.indexOf('function matchComponent'));
  assert.match(picker, /componentSearchUrl/, 'no Jira link beside Clear');
});

/* ── the shared type-to-search picker ─────────────────────────────────── */

check('SEARCH MATCHES ANY PART OF THE TEXT, IN ANY ORDER', () => {
  // The reason the native <select> had to go from all three pickers: its
  // type-ahead only matches the FIRST characters of an option, and every
  // component begins "PS_"/"R&D_" while every sprint begins "Katalon ".
  const UI = loadUI();
  assert.ok(UI.matchText('PS_iGO_NLG', 'nlg'));
  assert.ok(UI.matchText('Katalon Ruby Sprint 44', '44 ruby'), 'tokens in any order');
  assert.ok(UI.matchText('PS_AFFIRM_MorganStanley', 'morgan'));
  assert.ok(UI.matchText('PS_iGO_NLG', 'ps_igo'), 'separators count as spaces');
  assert.ok(!UI.matchText('PS_iGO_NLG', 'nlg nationwide'), 'EVERY token must match');
  assert.ok(UI.matchText('anything', ''), 'an empty query matches everything');
});

check('AN OPTION CAN BE HIDDEN FROM THE RESTING LIST BUT STILL FOUND BY TYPING', () => {
  // This is what makes the sprint picker rest on active + future while still
  // searching all 42. The markup has to carry the flag, or the behaviour has
  // nowhere to live.
  const UI = loadUI();
  const html = UI.combo({
    id: 'x', label: 'Sprint', value: 'S39',
    options: [
      { value: 'S39', label: 'Sprint 39', tag: 'active', active: true },
      { value: 'S33', label: 'Sprint 33', tag: 'closed', hidden: true },
    ],
    note: '38 closed sprints — type to find them',
  });
  assert.match(html, /data-value="S33"[^>]*data-rest-hidden="1"/s, 'the closed one must be marked');
  assert.ok(!/data-value="S39"[^>]*data-rest-hidden/s.test(html), 'the open one must not be');
  assert.match(html, /combo-note[^>]*>38 closed sprints/, 'and the list says what it is holding back');
  assert.match(html, /data-search="[^"]*closed[^"]*"/, 'the tag is searchable, so "closed" finds them');
});

check('OPENING A PICKER SHOWS THE OPTIONS, NOT JUST THE ONE ALREADY CHOSEN', () => {
  // The input holds the current selection. Filtering by its value on focus
  // gives a list of exactly one item and hides the note — which is what this
  // did until a browser run showed 1 of 42 sprints and "note: (hidden)".
  const ui = read(PUBLIC, 'ui.js');
  const wire = ui.slice(ui.indexOf('function wireCombo'));
  const onFocus = wire.slice(wire.indexOf("addEventListener('focus'"), wire.indexOf("addEventListener('blur'"));
  assert.match(onFocus, /filter\(''\)/,
    "focus must filter by '' — reading the box shows only the current selection");
  assert.match(wire, /function filter\(q0\)/, 'filter has to accept an explicit query for that to be possible');
});

/**
 * A DOM double just big enough to run `wireCombo` and read what it hid.
 *
 * The filtering rules are the feature — "rest on active and future, find
 * everything by typing" — and asserting them against the SOURCE only proves
 * the words are still there. This drives the real handlers.
 */
function driveCombo(options) {
  const UI = loadUI();
  const listeners = new Map();
  const mk = (extra) => ({
    hidden: false, dataset: {}, value: '', classList: {
      _s: new Set(),
      toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      add(c) { this._s.add(c); },
    },
    addEventListener(t, fn) { listeners.set(`${extra && extra.tag}:${t}`, fn); },
    setAttribute() {}, select() {}, scrollIntoView() {},
    querySelector: () => ({ textContent: '' }),
    ...extra,
  });

  const opts = options.map(o => {
    const e = mk({});
    e.dataset.search = o.search;
    e.dataset.value = o.value;
    if (o.hidden) e.dataset.restHidden = '1';
    if (o.active) e.classList.add('active');
    e.querySelector = () => ({ textContent: o.search });
    return e;
  });
  const note = mk({ tag: 'note' });
  const empty = mk({ tag: 'empty' });
  const input = mk({ tag: 'input' });
  const list = mk({
    tag: 'list',
    querySelector: (sel) => (sel === '.combo-empty' ? empty : sel === '.combo-note' ? note : null),
    querySelectorAll: () => opts,
  });
  const root = { querySelector: (sel) => (sel.endsWith('List') ? list : input), querySelectorAll: () => [] };

  let picked = null;
  UI.wireCombo(root, 'x', (v) => { picked = v; });

  return {
    focus() { listeners.get('input:focus')(); return this; },
    type(v) { input.value = v; listeners.get('input:input')(); return this; },
    visible: () => opts.filter(o => !o.hidden).map(o => o.dataset.value),
    noteShown: () => !note.hidden,
    picked: () => picked,
  };
}

const SPRINTS = [
  { value: 'S42', search: 'katalon ruby sprint 42 planned' },
  { value: 'S39', search: 'katalon ruby sprint 39 active', active: true },
  { value: 'S33', search: 'katalon ruby sprint 33 closed', hidden: true },
  { value: 'S12', search: 'katalon ruby sprint 12 closed', hidden: true },
];

check('AT REST THE SPRINT LIST SHOWS ONLY ACTIVE AND FUTURE', () => {
  const c = driveCombo(SPRINTS).focus();
  assert.deepStrictEqual(c.visible(), ['S42', 'S39'], 'closed sprints must not be in the resting list');
  assert.ok(c.noteShown(), 'and the list has to say it is holding some back');
});

check('TYPING SEARCHES ALL SPRINTS, CLOSED ONES INCLUDED', () => {
  // The other half of his ask, and the half a "hide closed" filter would break.
  const c = driveCombo(SPRINTS).focus().type('33');
  assert.deepStrictEqual(c.visible(), ['S33'], 'a closed sprint must be findable by typing');
  assert.ok(!c.noteShown(), 'and the note about hidden entries goes away while searching');
});

check('searching by state finds them too', () => {
  const c = driveCombo(SPRINTS).focus().type('closed');
  assert.deepStrictEqual(c.visible(), ['S33', 'S12']);
});

check('THE CURRENT SELECTION IS ALWAYS IN THE LIST, EVEN IF ITS KIND RESTS HIDDEN', () => {
  // Select a closed sprint: the box shows its name, so a list that cannot show
  // it contradicts the control it belongs to.
  const c = driveCombo([
    { value: 'S42', search: 'sprint 42 planned' },
    { value: 'S33', search: 'sprint 33 closed', hidden: true, active: true },
  ]).focus();
  assert.deepStrictEqual(c.visible(), ['S42', 'S33']);
});

check('and clearing the box brings the resting list back', () => {
  const c = driveCombo(SPRINTS).focus().type('33');
  assert.deepStrictEqual(c.visible(), ['S33']);
  c.type('');
  assert.deepStrictEqual(c.visible(), ['S42', 'S39'], 'an emptied box is the resting state again');
});

check('AN OPTION SHOWS ITS FULL TEXT ON ONE LINE', () => {
  // The sprint box is ~270px in the topbar. Constraining the list to the
  // control's width wrapped every option onto two lines — "Katalon Ruby
  // Sprint / 42" — which is what a dropdown is for NOT doing.
  const css = read(PUBLIC, 'styles.css');
  // Anchored at the start of a line: `.sprint-picker .combo-list` also contains
  // the substring ".combo-list {" and comes first in the file, so an unanchored
  // indexOf reads the wrong rule and the check is meaningless.
  const at = css.search(/^\.combo-list \{/m);
  assert.ok(at > 0, 'the base .combo-list rule has gone');
  const list = css.slice(at, css.indexOf('}', at));
  assert.match(list, /width: max-content/, 'the panel must size to its longest row, not to the input');
  assert.match(list, /min-width: 100%/, 'and never be narrower than the control it belongs to');
  assert.match(list, /max-width: min\(/, 'while still fitting on a phone');
  assert.ok(!/right: 0/.test(list), 'pinning both edges is what forced it to the input width');
  assert.match(css, /\.combo-opt > strong \{[^}]*white-space: nowrap/, 'the name itself must not wrap');
});

check('THE OPTION LIST IS CHOSEN ON MOUSEDOWN, WHICH BEATS THE BLUR THAT CLOSES IT', () => {
  // `blur` fires first and hides the list, so a click handler lands on nothing.
  // The classic dropdown bug, and invisible in review.
  const wire = read(PUBLIC, 'ui.js').slice(read(PUBLIC, 'ui.js').indexOf('function wireCombo'));
  assert.match(wire, /list\.addEventListener\('mousedown'/);
  assert.match(wire, /e\.preventDefault\(\)/);
});

check('NO AUTO-FIT GRID CAN BE WIDER THAN A PHONE', () => {
  // `minmax(420px, 1fr)` forces a 420px track even when only ONE column fits,
  // so raising that floor to make the two-up layout collapse sooner made every
  // page scroll sideways on a 390px screen. `min(420px, 100%)` lets the last
  // column fall back to the container. Caught by measuring, not by looking.
  const css = read(PUBLIC, 'styles.css');
  const bad = [...css.matchAll(/^(\.[\w-]+) \{[^}]*repeat\(auto-fit, minmax\((\d+)px/gm)]
    .map(m => `${m[1]} has a hard ${m[2]}px floor`);
  assert.deepStrictEqual(bad, [], `use minmax(min(Npx, 100%), 1fr):\n      ${bad.join('\n      ')}`);
});

check('A FLEX COLUMN THAT HOLDS A TABLE CAN SHRINK', () => {
  // Without `min-width: 0` a flex item refuses to go narrower than its content,
  // and the per-tool tables pushed the WHOLE PAGE sideways at 600px — 7px of
  // horizontal scroll on every screen, found by measuring rather than looking.
  assert.match(read(PUBLIC, 'styles.css'), /\.tool-col \{[^}]*min-width: 0/);
});

check('ALL THREE PICKERS USE THE ONE CONTROL', () => {
  // It was written inside the Coverage view first. Two more copies is how the
  // keyboard handling ends up subtly different on each screen.
  const app = read(PUBLIC, 'app.js');
  assert.match(app, /UI\.combo\(\{\s*\n?\s*id: 'teamSelect'/, 'the team picker');
  assert.match(app, /id: 'sprintSelect'/, 'the sprint picker');
  assert.match(read(VIEWS, 'report-coverage.js'), /id: 'covSearch'/, 'the component picker');
  for (const [file, src] of [['app.js', app], ['report-coverage.js', read(VIEWS, 'report-coverage.js')]]) {
    assert.ok(!/function wireCombo|function matchComponent/.test(src), `${file} has its own copy of the control`);
  }
});

check('and no native select is left behind for team or sprint', () => {
  const html = read(PUBLIC, 'index.html');
  assert.ok(!/<select id="(teamSelect|sprintSelect)"/.test(html), 'the unsearchable controls must be gone');
  assert.match(html, /id="teamPicker"/);
  assert.match(html, /id="sprintPicker"/);
  // The route handler hides the sprint picker on screens that are not sprint
  // scoped; it referenced an element id that no longer existed, which threw on
  // every render until a browser run caught it.
  assert.match(read(PUBLIC, 'app.js'), /UI\.\$\('#sprintPicker'\)\.hidden/);
});

/* ── every screen the app promises actually exists ────────────────────── */

/**
 * "SourcesView is not defined."
 *
 * A view file that is MISSING breaks its screen at the moment someone clicks
 * it and nowhere earlier: the route is in ROUTES, the sidebar link renders, the
 * server is healthy, and the whole app looks fine until that one tab. It cost
 * him a click to find and me a round trip to diagnose.
 *
 * `npm test` never noticed, because every other check here walks the files that
 * ARE on disk — a sweep over `readdirSync` cannot see what is absent. So this
 * works from the PROMISES instead: every `<script src>` the page loads, and
 * every view ROUTES names, has to resolve to a real file that really defines
 * that global. Three ways to break a screen, all three caught before it ships.
 */
check('EVERY LOCAL ASSET THE PAGE AND ITS CSS REFERENCE EXISTS ON DISK', () => {
  // The script check below was written after eight view files went missing.
  // The same failure applies to every other local reference: a missing logo
  // renders a broken-image icon, a missing font silently falls back, and a
  // missing stylesheet takes the whole look with it — none of them throw.
  const files = [['index.html', read(PUBLIC, 'index.html')], ['styles.css', read(PUBLIC, 'styles.css')],
    ['kms/fonts.css', read(PUBLIC, 'kms', 'fonts.css')], ['kms/tokens.css', read(PUBLIC, 'kms', 'tokens.css')]];
  const missing = [];
  for (const [where, src] of files) {
    const base = path.dirname(path.join(PUBLIC, where));
    const refs = [
      ...[...src.matchAll(/<(?:img|link)[^>]+(?:src|href)="([^"]+)"/g)].map(m => m[1]),
      ...[...src.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(m => m[1]),
    ];
    for (const r of refs) {
      if (/^(https?:|data:|#|\/shared\/)/.test(r)) continue;
      const file = r.startsWith('/') ? path.join(PUBLIC, r.slice(1)) : path.join(base, r);
      if (!fs.existsSync(file)) missing.push(`${where} → ${r}`);
    }
  }
  assert.deepStrictEqual(missing, [], `referenced but not on disk:\n      ${missing.join('\n      ')}`);
});

check('THE SIDEBAR SHOWS THE REAL KMS MARK, NOT A PLACEHOLDER', () => {
  // It was a CSS conic-gradient circle — a stand-in that looked deliberate
  // enough that nobody would notice it was not the logo.
  const html = read(PUBLIC, 'index.html');
  const css = read(PUBLIC, 'styles.css');
  assert.match(html, /<img class="mark" src="kms\/kms-mark-[\w-]+\.svg"[^>]*alt="[^"]+"/,
    'the mark must be a real image with alt text, not an empty decorative span');
  assert.ok(!/\.brand \.mark \{[^}]*conic-gradient/.test(css), 'the placeholder gradient must be gone');
  // Blue on light has too little contrast on the dark surface, so the theme
  // has to swap it — one file cannot serve both.
  assert.match(css, /\[data-theme="dark"\][^{]*\.mark \{[^}]*kms-mark-white\.svg/,
    'dark mode needs the white mark');
});

check('and the page has a favicon, so the browser stops 404ing on every load', () => {
  assert.match(read(PUBLIC, 'index.html'), /<link rel="icon" href="kms\/kms-mark-[\w-]+\.svg"/);
});

check('EVERY SCRIPT THE PAGE LOADS EXISTS ON DISK', () => {
  const html = read(PUBLIC, 'index.html');
  const server = read(__dirname, '..', 'server.js');

  // Not every script is a file under public/. `/shared/query.js` IS lib/query.js,
  // served straight to the browser so the parser cannot exist in two versions —
  // so it is resolved through the server's own map rather than special-cased,
  // and a broken entry in that map fails here too.
  const shared = new Map();
  for (const m of server.matchAll(/'(\/shared\/[\w.-]+)':\s*path\.join\(__dirname,\s*([^)]+)\)/g)) {
    const parts = m[2].split(',').map(x => x.trim().replace(/^['"]|['"]$/g, ''));
    shared.set(m[1], path.join(__dirname, '..', ...parts));
  }

  const missing = [];
  for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    const src = m[1];
    if (/^https?:/.test(src)) continue;
    const file = shared.has(src) ? shared.get(src) : path.join(PUBLIC, src);
    if (!shared.has(src) && src.startsWith('/')) { missing.push(`${src} (absolute, and the server serves no such path)`); continue; }
    if (!fs.existsSync(file)) missing.push(src);
  }
  assert.deepStrictEqual(missing, [],
    `index.html loads files that are not there — every screen below them dies with "X is not defined":\n      ${missing.join('\n      ')}`);
});

check('EVERY ROUTE\'S VIEW IS DEFINED BY A FILE THE PAGE LOADS', () => {
  // The other half: a file can exist and still never be loaded, or be loaded
  // and not define what ROUTES asks for.
  const app = read(PUBLIC, 'app.js');
  const html = read(PUBLIC, 'index.html');
  const table = app.slice(app.indexOf('const ROUTES = ['), app.indexOf('];', app.indexOf('const ROUTES = [')));

  const loaded = [...html.matchAll(/<script src="(views\/[^"]+)"><\/script>/g)].map(m => m[1]);
  const defined = new Set();
  for (const src of loaded) {
    const file = path.join(PUBLIC, src);
    if (!fs.existsSync(file)) continue;
    for (const m of read(PUBLIC, src).matchAll(/^const (\w+) = \(/gm)) defined.add(m[1]);
  }

  const broken = [];
  for (const m of table.matchAll(/view: \(\) => (\w+)/g)) {
    if (!defined.has(m[1])) broken.push(m[1]);
  }
  assert.deepStrictEqual(broken, [],
    `ROUTES names views that nothing loaded defines:\n      ${broken.join('\n      ')}`);
});

check('and every view file on disk is actually loaded', () => {
  // The mirror image: a screen written, saved, and never reachable because the
  // script tag was forgotten. Silent in a different direction.
  const html = read(PUBLIC, 'index.html');
  const orphans = fs.readdirSync(VIEWS)
    .filter(f => f.endsWith('.js'))
    .filter(f => !html.includes(`views/${f}`));
  assert.deepStrictEqual(orphans, [],
    `written but never loaded by index.html:\n      ${orphans.join('\n      ')}`);
});

/* ── the sweep ────────────────────────────────────────────────────────── */

/**
 * Every view file, scanned for a key printed WITHOUT the helper.
 *
 * This is the check that matters in six months. The helper cannot be wrong
 * quietly; a new table that never calls it can.
 */
check('NO VIEW PRINTS AN ISSUE KEY WITHOUT GOING THROUGH THE HELPER', () => {
  // `.key` is not always an issue key. Three places in the app use the name for
  // something else entirely, and linking those to /browse/ would 404 with
  // confidence. Listed by the variable they read from, so adding a fourth is a
  // deliberate act rather than a silently widened regex.
  const NOT_AN_ISSUE = {
    'backlog.js': ['c'],   // c.key — a COMPONENT name in the filter dropdown
    'fields.js': ['f'],    // f.key — a custom field's search slug
  };

  const offenders = [];
  for (const file of fs.readdirSync(VIEWS).filter(f => f.endsWith('.js'))) {
    const src = read(VIEWS, file);
    const allowed = new Set(NOT_AN_ISSUE[file] || []);
    src.split('\n').forEach((line, n) => {
      // `UI.esc(<something>.key)` — the exact shape every dead key had.
      for (const m of line.matchAll(/UI\.esc\(\s*([A-Za-z_$][\w$]*)\.key\s*\)/g)) {
        if (!allowed.has(m[1])) offenders.push(`${file}:${n + 1}  ${line.trim()}`);
      }
      // A hand-rolled /browse/ link is the other way to get this wrong: it
      // works, and then it is the one that forgets rel="noopener".
      if (/\/browse\//.test(line) && !/issueUrl/.test(line)) offenders.push(`${file}:${n + 1}  ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(offenders, [],
    `use UI.issueKey(…) so the key links to Jira:\n      ${offenders.join('\n      ')}`);
});

check('and the views that show keys actually call it', () => {
  // The sweep above passes trivially if a view stops showing keys at all.
  // These are the screens a key is expected on.
  for (const [file, what] of [
    ['sprint.js', 'All sprint items'],
    ['backlog.js', 'the backlog table'],
    ['team.js', 'the team backlog'],
    ['capacity.js', 'a person\'s sprint items'],
    ['search.js', 'search results'],
  ]) {
    assert.match(read(VIEWS, file), /UI\.issueKeys?\(/, `${what} (${file}) shows keys and must link them`);
  }
});

check('the Epic column links its epics too', () => {
  // The epic key is the one most worth clicking — it is the only place in the
  // app that names an issue you are NOT already looking at.
  const src = read(VIEWS, 'sprint.js');
  const fn = src.slice(src.indexOf('function epicCell'), src.indexOf('const trim ='));
  assert.match(fn, /UI\.issueKey\(e\.key\)/);
});

check('a blocked-by list links each blocker', () => {
  assert.match(read(VIEWS, 'sprint.js'), /blocked by \$\{UI\.issueKeys\(i\.blockedBy\)\}/);
});

check('AN ADJUSTMENT ON A RISK IS NOT LINKED AS AN ISSUE', () => {
  // The adjustments table keys on `entity_id`, which is the issue key only when
  // `entity === 'issue'`. Linking a team id or a risk id to /browse/ would
  // produce a confident 404 on every row that is not an issue.
  const src = read(VIEWS, 'adjustments.js');
  assert.match(src, /r\.entity === 'issue' \? UI\.issueKey\(r\.id\) : UI\.esc\(r\.id\)/);
});

/* ── the styling, which is load-bearing here ──────────────────────────── */

check('the link style is specific enough to beat the global anchor colour', () => {
  // `a { color: var(--brand-blue) }` is set globally. A bare `.issue-key` rule
  // loses to it, and a table's first column becomes a wall of blue.
  const css = read(PUBLIC, 'styles.css');
  assert.match(css, /a\.issue-key\s*\{[^}]*color:\s*inherit/,
    'must be `a.issue-key`, not `.issue-key` — the global `a` rule is equally specific otherwise');
  // A keyboard focus ring, asserted as an OUTLINE rather than merely as the
  // selector existing. A colour change alone is what the hover rule already
  // does, so a check that only looks for the selector stays green while the
  // visible focus indicator is deleted — which it did, until this line.
  assert.match(css, /a\.issue-key:focus-visible\s*\{[^}]*outline:/,
    'a link you can only reach with a mouse is half a link');
});

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
