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
