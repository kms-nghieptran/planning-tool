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

  /* BOUNDED BY THE NEXT ROUTE, not by a byte count. This slice was a fixed
     2,600 characters, which is a check that fails when somebody adds a
     COMMENT to the route — and it did. A behavioural assertion that breaks on
     prose is one people learn to edit around rather than read. */
  const server = read(__dirname, '..', 'server.js');
  const at = server.indexOf("p === '/api/state'");
  assert.ok(at > 0, 'the /api/state route has moved or been renamed');
  const nextRoute = server.indexOf("if (p === '", at + 10);
  const state = server.slice(at, nextRoute > at ? nextRoute : server.length);
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
    // Bounded by where the NEXT route begins, not by a character count: a fixed
    // window turns "someone added a line to this handler" into a failing test
    // about the project key, which is a lie about what broke.
    const next = server.indexOf("if (p === '", at + 10);
    assert.match(server.slice(at, next > at ? next : at + 700), /project: cfg\.jira\.projectKey/,
      `${route} does not send the project key`);
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
  // `.key` is not always an issue key. A few places in the app use the name for
  // something else entirely, and linking those to /browse/ would 404 with
  // confidence. Listed by the variable they read from, so adding another is a
  // deliberate act rather than a silently widened regex.
  const NOT_AN_ISSUE = {
    'backlog.js': ['c'],   // c.key — a COMPONENT name in the filter dropdown
    'fields.js': ['f'],    // f.key — a custom field's search slug
    'settings.js': ['choice'], // choice.key — a <option> value in the rule editor
    // lvl.key — a priority level's slug; ph.key — an email template
    // placeholder name ({{team}}, {{coverage}}), listed in the send panel.
    'report-coverage.js': ['lvl', 'ph'],
    // f.key — a component family's slug ('ps', 'rnd'); b.key — a coverage
    // bucket's slug ('automated', 'blocked'), on the column switches.
    'prioritization.js': ['f', 'b'],
    // f.key — the same component-family slug, on the "By component" chips.
    'capacity.js': ['f'],
  };

  const offenders = [];
  for (const file of fs.readdirSync(VIEWS).filter(f => f.endsWith('.js'))) {
    const src = read(VIEWS, file);
    const allowed = new Set(NOT_AN_ISSUE[file] || []);
    src.split('\n').forEach((line, n) => {
      // `UI.esc(<something>.key)` — the exact shape every dead key had.
      for (const m of line.matchAll(/UI\.esc\(\s*([A-Za-z_$][\w$]*)\.key\s*\)/g)) {
        if (allowed.has(m[1])) continue;
        /* AN ATTRIBUTE VALUE IS NOT PRINTED TEXT. The rule is that a key the
           reader SEES has to be a link; a key in `data-sprint-key="…"` is an
           identifier the handler reads back, and `UI.issueKey` there would
           put an anchor inside an attribute. Detected by what precedes the
           match on the line — `="` with no `>` after it means we are still
           inside a tag — rather than by adding the variable to the allow-list
           above, which would blind the whole file to the real mistake. */
        const before = line.slice(0, m.index);
        const openQuote = before.lastIndexOf('="');
        const insideTag = openQuote >= 0 && !before.slice(openQuote).includes('>');
        if (insideTag) continue;
        offenders.push(`${file}:${n + 1}  ${line.trim()}`);
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
  //
  // The cell lives in ui.js now, shared by the Active sprint and Capacity
  // planning screens, so it is read from there. Inside that module the helper
  // is called unqualified.
  const src = read(VIEWS, '..', 'ui.js');
  const fn = src.slice(src.indexOf('function epicCell'), src.indexOf('function itemsTable'));
  assert.ok(fn, 'epicCell has moved again — point this check at it');
  assert.match(fn, /issueKey\(e\.key\)/);
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

/* ── OPEN IN JIRA: the whole drawer, not one key at a time ────────────────
   A drawer is a set the app already decided on, and the point of the button is
   to hand Jira that exact set. The failure mode is a link that opens something
   PLAUSIBLE — a few keys short, a stale filter, the right count of the wrong
   issues — because a reader cannot tell from the far side which of the two
   screens is lying. So these checks read the JQL back out of the URL and
   compare it to what the drawer listed. */

/** The decoded JQL out of a built issue-navigator URL. */
const jqlOf = (href) => decodeURIComponent(String(href).split('jql=')[1] || '');
/** The keys named by a `key in (...)` clause. */
const keysOf = (href) => {
  const m = jqlOf(href).match(/key in \(([^)]*)\)/);
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
};

check('THE LINK OPENS EXACTLY THE KEYS IT WAS GIVEN', () => {
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const keys = ['AUTOKAT-9715', 'AUTOKAT-1', 'AUTOKAT-7789'];
  const r = UI.keysSearchUrl(keys);
  assert.deepStrictEqual(keysOf(r.href).sort(), [...keys].sort(),
    'the URL names a different set from the one handed in');
  assert.strictEqual(r.shown, 3);
  assert.strictEqual(r.truncated, false);
  assert.ok(r.href.startsWith(`${BASE}/issues/?jql=`), 'it has to be the issue navigator');
});

check('and it asks BY KEY, never by a filter that Jira re-evaluates', () => {
  /* The tempting alternative — "status = X AND component = Y" — is evaluated
     against Jira's data at click time, so it opens whatever matches TODAY, not
     what this drawer counted. A drill-in that opens a different set from the
     number that opened it is worse than no link at all. */
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const jql = jqlOf(UI.keysSearchUrl(['A-1', 'A-2']).href);
  assert.match(jql, /^key in \(/, `the query is not a key list: ${jql}`);
  assert.ok(!/status|component|sprint|assignee|project\s*=/i.test(jql),
    `the query re-describes the set instead of naming it: ${jql}`);
});

check('DUPLICATES COLLAPSE, however Jira cased them', () => {
  // Two bucket stories can relate to the same suite. Jira accepts the repeat
  // and then reports a count that disagrees with the heading that was clicked.
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const r = UI.keysSearchUrl(['AUTOKAT-2', 'autokat-2', ' AUTOKAT-2 ', 'AUTOKAT-3']);
  assert.deepStrictEqual(keysOf(r.href), ['AUTOKAT-2', 'AUTOKAT-3']);
  assert.strictEqual(r.total, 2, 'the total counts the set, not the input');
});

check('A LIST TOO LONG FOR ONE URL IS CUT TO FIT, AND SAYS SO', () => {
  /* The coverage drill-in can hand this several thousand epics. A URL naming
     all of them is refused by the browser or truncated mid-key by the server,
     and either way the link opens the wrong thing without saying a word. */
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const many = Array.from({ length: 4000 }, (_, i) => `AUTOKAT-${1000 + i}`);
  const r = UI.keysSearchUrl(many);
  assert.strictEqual(r.total, 4000);
  assert.ok(r.truncated, 'four thousand keys cannot have fitted');
  assert.ok(r.shown > 0 && r.shown < 4000, `cut to ${r.shown}`);
  assert.ok(r.href.length <= 6000, `the url is ${r.href.length} characters, which is the thing this prevents`);
  // Cut BETWEEN keys, never through one: a half key silently opens the wrong issue.
  assert.strictEqual(keysOf(r.href).length, r.shown, 'the url names a different number than it reports');
  for (const k of keysOf(r.href)) assert.match(k, /^AUTOKAT-\d{4}$/, `truncated mid-key: ${k}`);
});

check('THE CUT IS A PREFIX, not whichever keys happened to fit', () => {
  /* Keys are not all the same length, so "stop at the first one that does not
     fit" and "skip the ones that do not fit" are different functions — and the
     second one is wrong in a way no count reveals. It quietly steps over a long
     key, picks up a shorter one further down, and returns a gappy subset while
     the button still says "the first N". The reader gets a set nobody can
     describe, and gets a different one the next time a key is renamed.

     A prefix of the sorted set is the only cut that is both reproducible and
     explainable, so that is the property, pinned on a list whose key lengths
     vary across the budget boundary. */
  const UI = loadUI();
  UI.setJiraBase(BASE);
  /* The fixture has to be BUILT to tell the two apart. A list of same-length
     keys cannot: once one of them does not fit, none of them do, and skipping
     is indistinguishable from stopping. So: fill the budget to one key short,
     then a key far too long to fit, then a short one that would. Stopping ends
     at the long key; skipping steps over it and swallows the short one. */
  const probe = Array.from({ length: 2000 }, (_, i) => `AAA-${String(i).padStart(5, '0')}`);
  const n = UI.keysSearchUrl(probe).shown;
  assert.ok(n > 10 && n < 2000, `the probe has to truncate to be a budget: ${n}`);
  const many = [...probe.slice(0, n - 1), `ZLONG-${'9'.repeat(400)}`, 'ZZ-1'];

  const r = UI.keysSearchUrl(many);
  const sorted = [...new Set(many.map(k => k.toUpperCase()))].sort();
  assert.ok(r.truncated, 'the fixture has to overflow for this to mean anything');
  assert.deepStrictEqual(keysOf(r.href), sorted.slice(0, r.shown),
    'the link opened a gappy subset rather than the first N in key order');
  assert.ok(!keysOf(r.href).includes('ZZ-1'),
    'a key past the cut was pulled in because it happened to be short enough');
});

check('and the button says how many it is opening when it cannot open them all', () => {
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const many = Array.from({ length: 4000 }, (_, i) => `AUTOKAT-${1000 + i}`);
  const shown = UI.keysSearchUrl(many).shown;
  const html = UI.openInJira(many);
  assert.match(html, new RegExp(`Open ${shown} in Jira`), 'a silent cut is the bug this exists to avoid');
  assert.match(html, /do not fit in one URL/, 'and the hover says why');
  // While a list that DOES fit makes no fuss about a limit nobody hit.
  assert.match(UI.openInJira(['A-1', 'A-2']), />Open in Jira</);
  assert.ok(!/do not fit/.test(UI.openInJira(['A-1', 'A-2'])));
});

check('NO JIRA URL, NO BUTTON — not a dead one', () => {
  const UI = loadUI();
  UI.setJiraBase('');
  assert.strictEqual(UI.openInJira(['A-1']), '', 'a button that goes nowhere is worse than no button');
  assert.strictEqual(UI.keysSearchUrl(['A-1']), null);
});

check('and no keys, no button', () => {
  const UI = loadUI();
  UI.setJiraBase(BASE);
  assert.strictEqual(UI.openInJira([]), '');
  assert.strictEqual(UI.openInJira(null), '');
  assert.strictEqual(UI.keysSearchUrl([null, '', undefined]), null, 'a set of nothings is not a set');
});

check('the button opens a new tab and severs the opener, like every other link here', () => {
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const html = UI.openInJira(['A-1']);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener"/);
});

check('THE DRILL DRAWER CARRIES THE BUTTON, for the rows it is showing', () => {
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const html = UI.drillDrawer({
    title: 'Maintained',
    keys: ['AUTOKAT-1', 'AUTOKAT-2'],
    items: [{ key: 'AUTOKAT-1', summary: 'one', points: 3 }],
    catalogue: { 'AUTOKAT-2': { key: 'AUTOKAT-2', summary: 'two' } },
  });
  assert.match(html, />Open in Jira</, 'the drawer has no way into Jira for the set as a whole');
  const href = (html.match(/href="([^"]*issues\/\?jql=[^"]*)"/) || [])[1];
  assert.ok(href, 'the button has no href');
  assert.deepStrictEqual(keysOf(href).sort(), ['AUTOKAT-1', 'AUTOKAT-2'],
    'the link opens a different set from the rows listed below it');
});

check('and a key with no local copy is still in the link — it is the one worth opening', () => {
  /* An unresolvable key is exactly what you go to Jira for. Building the link
     from the rows the tool could resolve would drop it, and quietly. */
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const html = UI.drillDrawer({ title: 'x', keys: ['GHOST-1', 'AUTOKAT-1'], items: [{ key: 'AUTOKAT-1' }], catalogue: {} });
  const href = (html.match(/href="([^"]*issues\/\?jql=[^"]*)"/) || [])[1];
  assert.deepStrictEqual(keysOf(href).sort(), ['AUTOKAT-1', 'GHOST-1']);
});

check('A BLOCKED ROW SAYS WHAT IS BLOCKING IT, and the blocker is a link', () => {
  /* WHAT HE REPORTED: the Blocked column on the Capacity sheet opened a panel
     listing twenty epics with nothing anywhere saying why any of them was
     blocked — the only question that panel is opened to answer.

     THE ANSWER WAS ALREADY IN THE PAYLOAD. `sprintComponentCell` sends Jira's
     own "is blocked by" links and the Automation Status for every row, and
     the drawer drew a key, a status and a summary and dropped the rest. On
     his board eighteen of those twenty name the same defect — one ticket
     worth chasing, invisible.

     AND IT HAS TO BE A LINK, which is this file's whole subject: a blocker
     you retype into Jira's search box is barely better than an unnamed one. */
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const html = UI.drillDrawer({
    title: 'TrueTest · Blocked',
    keys: ['AUTOKAT-9742'],
    items: [{
      key: 'AUTOKAT-9742', summary: '[TRUETEST] - CLICMNTIGO-11398', status: 'Refinement',
      automationStatus: 'Blocked',
      blockedBy: [{ key: 'CLICMNTIGO-11567', summary: 'UWRE Bootstrap passes BirthState as an abbreviation' }],
    }],
  });
  assert.match(html, /Blocked by/, 'the row does not say it is blocked by anything');
  assert.match(html, /CLICMNTIGO-11567/, 'the blocker is not named');
  assert.match(html, /UWRE Bootstrap passes BirthState/,
    'the blocker is a bare key — the summary is what tells him whether to chase it');

  /* THE BLOCKER'S KEY GOES TO JIRA. Read off the anchor that surrounds it
     rather than by asserting a URL shape, so this passes for the same reason
     a reader clicking it succeeds. */
  const anchors = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)]
    .map(m => ({ href: m[1], text: m[2] }));
  const blocker = anchors.find(a => a.text.includes('CLICMNTIGO-11567'));
  assert.ok(blocker, 'the blocker is printed as dead text rather than a link');
  assert.ok(blocker.href.includes('CLICMNTIGO-11567'), `the blocker links to ${blocker.href}`);

  /* AND IT IS MARKED. As plain grey text it sat under the component list and
     read as one more piece of metadata, on a panel opened to read exactly
     this. The class is what carries the accent, so a note that lost it would
     still say the right words and still be missed. */
  assert.match(html, /class="drill-blocked"/,
    'the blocked line is unmarked — it reads as metadata on twenty near-identical rows');
  assert.match(html, /class="lbl">Blocked by</,
    'the label is not marked, so nothing catches the eye while scanning');
});

check('and one blocked with NOTHING linked says so, rather than nothing', () => {
  /* The gap between the two facts is the useful part. The column comes from
     the Automation Status FIELD; the link is somebody recording what it is
     waiting on. Two of his twenty have the field and no link — blocked with
     no ticket to chase. A row rendering nothing for those reads exactly like
     a row that is not blocked at all, on a panel titled Blocked. */
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const html = UI.drillDrawer({
    title: 'TrueTest · Blocked',
    keys: ['AUTOKAT-1'],
    items: [{ key: 'AUTOKAT-1', summary: 'no link', status: 'Refinement', automationStatus: 'Blocked', blockedBy: [] }],
  });
  assert.match(html, /nothing is linked in Jira/i,
    'a blocked row with no blocker explains itself no differently from an unblocked one');
  assert.ok(!/Blocked by/.test(html), 'it claims a blocker it does not have');
  /* THE SAME MARK. Scanning a panel for the accent, an unmarked row reads as
     "not blocked" — which is the opposite of what this one is. */
  assert.match(html, /class="drill-blocked"/,
    'blocked-with-nothing-recorded is drawn unmarked, so it reads as not blocked');
});

check('and an ordinary row gains no blocked line at all', () => {
  /* This renders on every drawer in the tool, so it has to be silent wherever
     the fact is absent — a "not blocked" note on each of 400 automated epics
     is how a panel becomes unreadable. */
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const html = UI.drillDrawer({
    title: 'Automated',
    keys: ['AUTOKAT-2'],
    items: [{ key: 'AUTOKAT-2', summary: 'fine', status: 'Done', automationStatus: 'Automated', blockedBy: [] }],
  });
  assert.ok(!/Blocked by/.test(html), 'an automated epic was described as blocked by something');
  assert.ok(!/nothing is linked/i.test(html), 'an unblocked row carries a blocked note');
});

check('and the mark is a real accent in both themes', () => {
  /* A class nothing styles is a class. Checked in the stylesheet because that
     is the only place this fact exists, and pinned as `color-mix` against the
     theme's own tokens — a fixed pink is how a mark ends up invisible on one
     of the two themes. */
  const css = read(PUBLIC, 'styles.css');
  const block = css.slice(css.indexOf('.drill-blocked {'), css.indexOf('.stale-banner code'));
  assert.ok(block.includes('.drill-blocked {'), 'the blocked mark has no styling at all');
  assert.match(block, /border-left:\s*3px solid var\(--risk\)/,
    'the blocked line has no risk accent, so it does not stand out');
  assert.match(block, /background:\s*color-mix\([^;]*var\(--risk\)[^;]*var\(--app-/,
    'the mark is untinted, or tinted with a fixed colour that will not follow the theme');
  assert.match(block, /\.drill-blocked \.lbl \{[^}]*var\(--risk\)/,
    'the label does not carry the risk colour');
});

check('AND MARKING IT DID NOT MAKE IT HARDER TO READ', () => {
  /* THE REGRESSION THIS CAUGHT, in the first cut of the highlight. Tinting
     the block moved every word in it onto a new background, and this app's
     muted grey measures 2.1:1 there in light mode — so the line that was
     marked to be noticed became the least readable thing on the row. A
     highlight that costs legibility is a net loss.

     MEASURED, NOT EYEBALLED: the ratios are computed here from the same
     tokens the stylesheet resolves, in both themes, because "looks fine to
     me" is exactly the judgement that shipped the 2.1. */
  const css = read(PUBLIC, 'styles.css');

  /* THE TOKENS, READ FROM THE TWO THEME BLOCKS THEMSELVES — so this follows a
     change of palette rather than pinning today's hexes. Taken by matching
     braces from each selector, not by slicing around a landmark declaration:
     the first cut of this check sliced, picked up the light foreground while
     claiming to measure dark, and reported 1.65:1 for a label the browser
     measures at 6.05. A check that mis-measures is worse than no check.
     Dark declares only what it overrides, so it is light merged with those. */
  const blockAt = (sel, from = css) => {
    const at = from.indexOf(sel);
    assert.ok(at >= 0, `${sel} is not in the stylesheet — this check has gone stale`);
    const open = from.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < from.length; i++) {
      if (from[i] === '{') depth++;
      else if (from[i] === '}' && --depth === 0) return from.slice(open + 1, i);
    }
    throw new Error(`${sel} is never closed`);
  };
  const tokens = (from) => {
    const out = {};
    for (const m of from.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    return out;
  };
  /* THE BRAND SHEET COUNTS, AND IT LOADS FIRST. `index.html` pulls
     `kms/tokens.css` before `styles.css`, and styles.css's own values are
     written as `var(--color-fg-secondary, #4B5565)` — a FALLBACK that the
     brand sheet overrides in the browser. Resolving only styles.css measured
     the fallback and reported 6.52:1 for a summary the browser puts at
     4.85:1: comfortably passing a check on colours nobody ever sees. */
  const brand = read(path.join(PUBLIC, 'kms'), 'tokens.css');
  const brandTokens = tokens(blockAt(':root {', brand));
  /* AND IT HAS TO HAVE BEEN READ. Without this, a brand sheet that moved or
     was renamed leaves the check quietly measuring styles.css's fallbacks
     again — passing, on colours nobody sees. That is the failure this whole
     check exists to avoid, one level up. */
  assert.ok(brandTokens['--color-fg-secondary'],
    'the brand tokens were not read, so these ratios are the fallbacks rather than what ships');
  const LIGHT = { ...brandTokens, ...tokens(blockAt(':root {')) };
  const DARK = { ...LIGHT, ...tokens(blockAt('[data-theme="dark"] {')) };

  /* NO SILENT FALLBACK. Returning black for a token it could not resolve is
     how the broken first cut produced a plausible wrong number instead of an
     error — so an unresolvable token fails here, loudly. */
  const hex = (v, all, seen = 0) => {
    const raw = String(v).trim();
    if (/^#[0-9a-f]{3,8}$/i.test(raw)) return raw;
    const m = raw.match(/var\((--[a-z0-9-]+)(?:,\s*([^)]+))?\)/);
    assert.ok(m && seen < 8, `cannot resolve ${v} to a colour — this check would be measuring nothing`);
    return hex(all[m[1]] !== undefined ? all[m[1]] : m[2], all, seen + 1);
  };
  const rgb = (h) => {
    let t = h.replace('#', '');
    if (t.length === 3) t = t.split('').map(c => c + c).join('');
    return [0, 2, 4].map(i => parseInt(t.slice(i, i + 2), 16));
  };
  // `color-mix(in srgb, A p%, B)` — sRGB, which is what the stylesheet asks for.
  const mix = (a, b, pct) => rgb(a).map((v, i) => (v * pct + rgb(b)[i] * (100 - pct)) / 100);
  const lum = (c) => {
    const a = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  };
  const ratio = (f, b) => {
    const [hi, lo] = lum(f) > lum(b) ? [lum(f), lum(b)] : [lum(b), lum(f)];
    return (hi + 0.05) / (lo + 0.05);
  };

  for (const [name, T] of [['light', LIGHT], ['dark', DARK]]) {
    const risk = hex('var(--risk)', T);
    const subtle = hex('var(--app-subtle)', T);
    const fg = hex('var(--app-fg)', T);
    const fg2 = hex('var(--app-fg-2)', T);
    const tint = mix(risk, subtle, 5);          // the mark's background
    const label = mix(risk, fg, 72);            // the "Blocked by" label

    assert.ok(ratio(rgb(fg2), tint) >= 4.5,
      `${name}: the summary on the mark reads ${ratio(rgb(fg2), tint).toFixed(2)}:1 — below 4.5`);
    assert.ok(ratio(label, tint) >= 4.5,
      `${name}: the "Blocked by" label reads ${ratio(label, tint).toFixed(2)}:1 — below 4.5`);
    /* The 3px rule is a graphical element, so 3:1 is its bar. */
    assert.ok(ratio(rgb(risk), tint) >= 3,
      `${name}: the accent bar reads ${ratio(rgb(risk), tint).toFixed(2)}:1 against its own tint`);
    /* AND THE KEY IS THE STRONGEST THING ON THE LINE. It is the one part you
       click, and `a.issue-key` inherits its colour across this app — so
       inside the mark it would otherwise sit at exactly the weight of the
       muted summary next to it. */
    assert.ok(ratio(rgb(fg), tint) > ratio(rgb(fg2), tint),
      `${name}: the blocker key is no more prominent than the muted text beside it`);
  }

  /* AND THE STYLESHEET USES THOSE VALUES. The arithmetic above proves the
     numbers work; these pin that the file actually asks for them. */
  const block = css.slice(css.indexOf('.drill-blocked {'), css.indexOf('.stale-banner code'));
  assert.match(block, /var\(--risk\) 5%, var\(--app-subtle\)/, 'the tint is not the measured one');
  assert.match(block, /color:\s*var\(--app-fg-2\)/, 'the mark does not set its own text colour');
  assert.match(block, /\.drill-blocked \.muted \{\s*color:\s*inherit/,
    'muted text inside the mark keeps the app grey, which is 2.1:1 on this ground');
  assert.match(block, /var\(--risk\) 72%, var\(--app-fg\)/, 'the label is not the measured mix');
  assert.match(block, /\.drill-blocked \.issue-key \{[^}]*color:\s*var\(--app-fg\)/,
    'the blocker key inherits the muted colour, so the clickable part is the faintest thing on the line');
});

check('and the blocked line escapes what Jira sent', () => {
  /* Summaries and field values are free text from Jira and land in markup
     here, beside a key this file exists to make clickable. */
  const UI = loadUI();
  UI.setJiraBase(BASE);
  const html = UI.drillDrawer({
    title: 'x',
    keys: ['A-1'],
    items: [{ key: 'A-1', automationStatus: '<b>Blocked</b>', blockedBy: [{ key: 'B-1', summary: '<img src=x onerror=1>' }] }],
  });
  assert.ok(!/<img src=x/.test(html), 'a blocker summary was written into the panel as markup');
  assert.ok(!/<b>Blocked<\/b>/.test(html), 'an automation status was written into the panel as markup');
});

check('EVERY DRAWER THAT LISTS ISSUES OFFERS THE BUTTON', () => {
  /* The sweep, in the spirit of this file: the next drawer someone adds will
     copy the one above it, and the failure is silent — a panel that simply has
     no way out to Jira. So the drawer-building sites are checked by source. */
  const DRAWERS = [
    // Anchored on where each drawer is BUILT, not where it is opened — the
    // call sites come first in both files, and a window from one of those
    // reads whatever happens to follow it.
    ['views/capacity.js', 'function itemsDrawer'],      // member items, unassigned, off-roster
    ['views/report-coverage.js', 'Blocked by${ds.row'], // the blockers panel
  ];
  for (const [file, marker] of DRAWERS) {
    const src = read(VIEWS, path.basename(file));
    const at = src.indexOf(marker);
    assert.ok(at > 0, `${file}: could not find ${marker} — this check has gone stale`);
    const window = src.slice(at, at + 2000);
    assert.match(window, /UI\.openInJira\(/,
      `${file}: the ${marker} drawer lists issues but offers no way to open them in Jira`);
  }
  // And the shared one, which is where most of them come from.
  assert.match(read(PUBLIC, 'ui.js').slice(read(PUBLIC, 'ui.js').indexOf('function drillDrawer')), /openInJira\(/,
    'drillDrawer lost its button');
});

/* ── THE SPRINT KPI STRIP'S COLOURS ───────────────────────────────────────
   Colour here is not decoration: six cards sat side by side in two colours
   because hue carried STATUS alone, so the strip could not say which measure
   you were reading. Hue now carries identity and status moved to the card's
   edge — which only works if every accent the view asks for actually has a
   hue, and if that hue can be read on both themes. Neither is visible in a
   screenshot of the theme you happen to be using. */

/** Resolve a CSS custom property through however many `var()` hops, per theme. */
const tokens = (css, selector) => {
  const at = css.indexOf(selector);
  assert.ok(at >= 0, `no ${selector} block in styles.css`);
  const block = css.slice(at, css.indexOf('\n}', at));
  const map = new Map();
  for (const m of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) map.set(m[1], m[2].trim());
  return map;
};
const resolve = (name, ...maps) => {
  let v = null;
  for (const m of maps) if (m.has(name)) { v = m.get(name); break; }
  for (let hop = 0; v && hop < 8; hop++) {
    const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(#[0-9a-fA-F]{3,8})\s*)?\)$/.exec(v);
    if (!m) break;
    let next = null;
    for (const mm of maps) if (mm.has(m[1])) { next = mm.get(m[1]); break; }
    v = next || m[2] || null;
  }
  return /^#[0-9a-fA-F]{6}$/.test(v || '') ? v.toUpperCase() : null;
};
const lum = (hex) => {
  const c = hex.slice(1).match(/../g).map(x => parseInt(x, 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** The accents the Active sprint view actually asks for, in the order it asks. */
const accentsUsed = () => {
  const view = read(VIEWS, 'sprint.js');
  const strip = view.slice(view.indexOf('<div class="kpis accented">'), view.indexOf('</div>', view.indexOf('<div class="kpis accented">')));
  assert.ok(strip, 'the accented KPI strip is not in the view');
  return [...strip.matchAll(/accent:\s*'([\w-]+)'/g)].map(m => m[1]);
};

check('EVERY KPI IN THE SPRINT STRIP ASKS FOR AN ACCENT, and no two ask for the same one', () => {
  const view = read(VIEWS, 'sprint.js');
  const from = view.indexOf('<div class="kpis accented">');
  const strip = view.slice(from, view.indexOf('</div>', from));
  const cards = (strip.match(/UI\.kpi\(\{/g) || []).length;
  const used = accentsUsed();
  assert.ok(cards >= 6, `expected the full strip, found ${cards} cards`);
  assert.strictEqual(used.length, cards,
    `${cards} cards but ${used.length} accents — one would fall back to plain text and read as a seventh meaning`);
  assert.strictEqual(new Set(used).size, used.length,
    `two cards share an accent, which is the problem this was meant to fix: ${used.join(', ')}`);
});

check('AND EVERY ACCENT HAS A HUE AND A RULE — a typo is a silent no-op', () => {
  /* `accent: 'commited'` renders `class="kpi k-commited"`, matches nothing,
     and inherits the default text colour. The card looks exactly like the
     neutral one next to it and nothing anywhere fails. */
  const css = read(PUBLIC, 'styles.css');
  for (const a of accentsUsed()) {
    assert.ok(css.includes(`--kpi-${a}:`), `no --kpi-${a} token for the accent the view asks for`);
    // Whitespace-tolerant: the rules are column-aligned in the stylesheet, and
    // a check that breaks on a second space is a check that gets deleted.
    assert.match(css, new RegExp(`\\.kpis\\.accented \\.kpi\\.k-${a}\\s+\\.value`), `no rule paints .k-${a}`);
  }
});

check('THE HUES ARE READABLE ON BOTH THEMES, which no screenshot can show', () => {
  /* 3:1 is the WCAG AA floor for large text, and these are 30px at weight
     800 — comfortably past the 18.66px-bold threshold. Five of the six clear
     4.5 as well; `blocked` is the app's own `--risk` pink, which already
     carries numbers this size elsewhere. */
  const css = read(PUBLIC, 'styles.css');
  const light = tokens(css, ':root {');
  const dark = tokens(css, '[data-theme="dark"] {');
  const LIGHT_BG = '#FFFFFF', DARK_BG = '#181A38';
  assert.strictEqual(resolve('--app-surface', dark), DARK_BG,
    'the dark card is no longer the colour this check measures against');

  const bad = [];
  for (const a of accentsUsed()) {
    const l = resolve(`--kpi-${a}`, light);
    const d = resolve(`--kpi-${a}`, dark, light);
    assert.ok(l, `--kpi-${a} does not resolve to a hex colour in light mode`);
    assert.ok(d, `--kpi-${a} does not resolve to a hex colour in dark mode`);
    if (contrast(l, LIGHT_BG) < 3) bad.push(`${a} light ${l} ${contrast(l, LIGHT_BG).toFixed(2)}:1`);
    if (contrast(d, DARK_BG) < 3) bad.push(`${a} dark ${d} ${contrast(d, DARK_BG).toFixed(2)}:1`);
  }
  assert.deepStrictEqual(bad, [], `KPI hues below the large-text floor:\n      ${bad.join('\n      ')}`);
});

check('NO TWO KPIS IN THE STRIP SHARE A HUE, in either theme', () => {
  // The exact failure being fixed: Committed and Projected landing were both
  // `--risk` pink, so the two numbers a lead compares first looked identical.
  const css = read(PUBLIC, 'styles.css');
  const light = tokens(css, ':root {');
  const dark = tokens(css, '[data-theme="dark"] {');
  for (const [theme, maps] of [['light', [light]], ['dark', [dark, light]]]) {
    const seen = new Map();
    for (const a of accentsUsed()) {
      const hex = resolve(`--kpi-${a}`, ...maps);
      assert.ok(!seen.has(hex), `${theme}: ${a} and ${seen.get(hex)} are both ${hex}`);
      seen.set(hex, a);
    }
  }
});

check('STATUS STILL HAS A CHANNEL — the edge, and it survives printing', () => {
  /* Moving status off the number is only safe because it lands somewhere
     else. Dropping these three rules would leave a strip where nothing marks
     the number that is a problem, and every card would still look deliberate. */
  const css = read(PUBLIC, 'styles.css');
  /* SPLIT THE SCREEN RULES FROM THE PRINT ONES FIRST. The print block restates
     these three with `!important`, so a search of the whole file finds them
     there and passes with the on-screen rules deleted — the edge would then
     appear on paper and nowhere else. Anchored on the restatement and the
     `@media print` that encloses it, because this file has seven print blocks
     and the first of them is four hundred lines above these rules. */
  const restated = css.indexOf('inset 3px 0 0 var(--risk) !important');
  assert.ok(restated > 0, 'the print restatement is gone');
  const screen = css.slice(0, css.lastIndexOf('@media print', restated));
  for (const t of ['ok', 'warn', 'risk']) {
    assert.match(screen, new RegExp(`\\.kpis\\.accented \\.kpi\\.t-${t}\\s*\\{[^}]*inset 3px 0 0`),
      `no status edge for t-${t} on screen`);
  }
  const print = css.slice(css.indexOf('@media print'));
  assert.match(print, /\.kpis\.accented \.kpi\.t-risk\s*\{[^}]*inset 3px 0 0[^}]*!important/,
    'the blanket box-shadow reset takes the status edge off the printed report');
  // ...and the view must still pass the tones, or the rules paint nothing.
  const view = read(VIEWS, 'sprint.js');
  const from = view.indexOf('<div class="kpis accented">');
  const strip = view.slice(from, view.indexOf('</div>', from));
  assert.ok((strip.match(/tone:/g) || []).length >= 3,
    'the strip stopped passing tones, so no card can show a status edge');
});

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
