'use strict';
/**
 * pdf-render.test.js — the renderer, against a real headless browser.
 *
 * WHY THIS SUITE EXISTS
 *
 * The first renderer shipped with checks that passed, and then hung for sixty
 * seconds on his machine and sent nothing. Everything it was asked about was
 * true: Chrome was found, the flags were right, the output was validated as a
 * PDF. The one thing nobody asked was WHAT HAPPENS WHEN THE PAGE DOES NOT
 * FINISH — and that turned out to be the only question that mattered, because
 * `--virtual-time-budget` waits for the network, so a single request that
 * never settles means the print never happens at all.
 *
 * So the checks here are mostly about failure. A renderer that produces a
 * good PDF from a good page is the easy half and it is one check. The rest is
 * the half that reaches a client: the page that hangs, the page that broke,
 * the browser that will not start, and the PDF that is technically valid and
 * actually a picture of a loading spinner.
 *
 * A REAL BROWSER, deliberately. A mocked Chrome would have passed against the
 * old renderer too — the bug was in what Chrome did with the flags, which is
 * precisely what a mock invents. The pages are served from loopback here in
 * the file and nothing reaches the network.
 *
 * Run: node test/pdf-render.test.js
 */

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const pdf = require('../lib/pdf-render');

/* CI AND THE CONTAINER RUN AS ROOT, where Chrome refuses to sandbox. This is
   a property of the test machine, not of the tool — his Mac never needs it —
   so it is added here rather than in the renderer, where it would weaken
   every real render to make a test pass. */
const SANDBOX = (typeof process.getuid === 'function' && process.getuid() === 0) ? ['--no-sandbox'] : [];
const opts = (o = {}) => ({ args: SANDBOX, ...o });

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nRendering the report to a PDF\n');

/* ── the pages ────────────────────────────────────────────────────────── */

/** Serve one HTML body on loopback; returns { url, close }. */
function serve(html, extra) {
  const server = http.createServer((req, res) => {
    if (extra && extra(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => server.close(),
  })));
}

/* A page that behaves like the tool: it draws, then announces it is done in
   exactly the way `public/app.js` does. Enough content that a real PDF comes
   out rather than something under the size floor. */
const READY = `<!doctype html><html><body>
  <h1>Overall Coverage</h1>
  ${'<p>Katalon Ruby — automation coverage by component, with the blocked suites called out.</p>'.repeat(40)}
  <script>setTimeout(function () { document.body.dataset.ptRendered = 'ok'; }, 150);</script>
</body></html>`;

/* ── the easy half ────────────────────────────────────────────────────── */

check('A PAGE THAT FINISHES IS RENDERED, and the file is a real PDF', async () => {
  const s = await serve(READY);
  try {
    const out = await pdf.render(s.url, opts());
    assert.ok(out.bytes > 1000, `the PDF is only ${out.bytes} bytes`);
    assert.strictEqual(fs.readFileSync(out.file).subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(out.ms >= 0 && out.ms < 30000, `it took ${out.ms}ms`);
  } finally { s.close(); }
});

check('AND IT RETURNS AS SOON AS THE PAGE SAYS SO, not when a timer expires', async () => {
  /* THE POINT OF THE REWRITE. The old renderer waited out a virtual-time
     budget whatever the page did, so every send carried a fixed cost and a
     fixed risk. This should finish in about the time the page takes. */
  const s = await serve(READY);
  try {
    const t0 = Date.now();
    await pdf.render(s.url, opts({ budget: 30000 }));
    const took = Date.now() - t0;
    assert.ok(took < 15000, `it took ${took}ms against a 30s budget — it is still waiting on something`);
  } finally { s.close(); }
});

/* ── the half that reaches a client ───────────────────────────────────── */

check('A PAGE WITH A STUCK REQUEST FAILS AT THE DEADLINE — the shipped bug', async () => {
  /* THE EXACT FAILURE HE HIT. One `fetch` that never resolves. Under the old
     renderer virtual time never advanced, Chrome never printed, and the whole
     thing sat there until it was killed — reported as "Chrome did not finish
     rendering within 60s", which names no cause and suggests no action. */
  const s = await serve(
    `<!doctype html><html><body><h1>Report</h1><script>fetch('/stuck');</script></body></html>`,
    (req) => (req.url === '/stuck'));     // answered never
  try {
    const t0 = Date.now();
    await assert.rejects(() => pdf.render(s.url, opts({ budget: 6000 })), (err) => {
      assert.match(err.message, /did not finish rendering/i);
      /* THE MESSAGE HAS TO CARRY THE DIAGNOSIS. A timeout that only says it
         timed out sent him back here to ask; this one names the state the
         page was stuck in and the URL to open. */
      assert.match(err.message, /pending|loading/, `it does not say what it was waiting for: ${err.message}`);
      assert.ok(err.message.includes(s.url), `it does not say which page: ${err.message}`);
      return true;
    });
    const took = Date.now() - t0;
    assert.ok(took < 20000, `it overran its own 6s budget by a lot: ${took}ms`);
  } finally { s.close(); }
});

check('A VIEW THAT THREW IS REPORTED AS THAT, not as a timeout', async () => {
  /* These send him to completely different places — one is a broken report,
     the other is a slow one — so collapsing both into "it timed out" costs
     him the afternoon. `app.js` writes `error` into the same marker, and it
     has to come back promptly rather than after the full budget. */
  const s = await serve(`<!doctype html><html><body><h1>x</h1>
    <script>document.body.dataset.ptRendered = 'error';</script></body></html>`);
  try {
    const t0 = Date.now();
    await assert.rejects(() => pdf.render(s.url, opts({ budget: 20000 })),
      /failed to render/i);
    assert.ok(Date.now() - t0 < 10000, 'it waited out the budget instead of believing the page');
  } finally { s.close(); }
});

check('A PAGE THAT NEVER SIGNALS IS NOT PRINTED HALF-DRAWN', async () => {
  /* The quiet failure, and the worse one: printing early produces a VALID
     PDF of a loading spinner, which passes every structural check and is
     discovered by the client. Nothing signals here, so nothing may be sent. */
  const s = await serve('<!doctype html><html><body><div>Loading…</div></body></html>');
  try {
    await assert.rejects(() => pdf.render(s.url, opts({ budget: 4000 })), /did not finish rendering/i);
  } finally { s.close(); }
});

check('A MISSING CHROME SAYS WHAT TO DO ABOUT IT', async () => {
  await assert.rejects(
    () => pdf.render('http://127.0.0.1:1/', { chrome: null, env: { CHROME_PATH: '/nope/not/here' } }),
    (err) => {
      assert.ok(err.missingChrome, 'the caller cannot tell this apart from a render failure');
      assert.match(err.message, /install chrome|CHROME_PATH/i);
      return true;
    });
});

check('AND A CHROME THAT WILL NOT START IS NOT A HANG', async () => {
  /* `/bin/false` exits at once. The old code waited for a greeting that was
     never coming; the exit has to be noticed and reported immediately. */
  const t0 = Date.now();
  await assert.rejects(
    () => pdf.render('http://127.0.0.1:1/', opts({ chrome: '/bin/false', budget: 20000 })),
    /exited|could not start/i);
  assert.ok(Date.now() - t0 < 10000, 'it waited out the budget for a process that had already died');
});

/* ── the plumbing ─────────────────────────────────────────────────────── */

check('THE DEVTOOLS ENDPOINT IS READ OUT OF WHAT CHROME PRINTS', async () => {
  assert.strictEqual(
    pdf.endpointFrom('\nDevTools listening on ws://127.0.0.1:51234/devtools/browser/abc-123\n'),
    'ws://127.0.0.1:51234/devtools/browser/abc-123');
  assert.strictEqual(pdf.endpointFrom('some other warning entirely'), null);
  assert.strictEqual(pdf.endpointFrom(''), null);
});

check('THE PROBE SURVIVES A PAGE THAT HAS NO BODY YET', async () => {
  /* It runs about ten times a second from the moment the tab exists, which
     includes the instant before there is a `document.body` to ask. A probe
     that threw there would come back as a DevTools error and be read as a
     dead tab. */
  const early = new Function(`return ${pdf.PROBE.replace('document.body', 'null')}`);
  assert.doesNotThrow(early);
});

check('THE APP AND THE RENDERER AGREE ON THE SIGNAL', async () => {
  /* THE CONTRACT THIS WHOLE FIX RESTS ON, and it spans two files that have no
     other reason to be read together. `app.js` writes the marker; this module
     polls for it. Rename it on one side — a tidy-up, a refactor, a dataset key
     that reads better — and every render times out after sixty seconds with a
     message about a slow page, while the page is fine. Nothing else in the
     suite would notice, because each file is correct on its own. */
  const app = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /dataset\.ptRendered\s*=/, 'app.js no longer sets the readiness marker');
  assert.match(pdf.PROBE, /ptRendered/, 'the renderer no longer looks for it');

  /* BOTH VALUES, not just the happy one. `error` is what turns a broken view
     into an immediate, accurate message instead of a timeout — and it is the
     one a refactor drops, because nothing on screen depends on it. */
  assert.match(app, /outcome\s*=\s*'error'/, "app.js no longer reports a failed view as 'error'");
  assert.match(app, /let outcome\s*=\s*'ok'/, "app.js no longer reports a good view as 'ok'");
});

check('AND THE OLD GUESSING FLAGS ARE GONE', async () => {
  /* `--virtual-time-budget` is what hung. Leaving it in alongside the
     readiness signal would mean two mechanisms deciding when the page is
     finished, and the observable one is not the one that would win. */
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'lib', 'pdf-render.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');   // the comments discuss it at length
  assert.ok(!/virtual-time-budget/.test(code), 'the virtual-time budget is back');
  assert.ok(!/run-all-compositor-stages/.test(code), 'the compositor flag is back');
  assert.ok(!/print-to-pdf/.test(code), 'it is printing by flag again rather than by protocol');
});

check('THE PRINT URL IS THE SAME PAGE HE CHECKED', async () => {
  const u = pdf.reportUrl('http://127.0.0.1:4322/', { route: 'reports/coverage', team: 'ruby', landscape: true });
  assert.match(u, /print=1/);
  assert.match(u, /landscape=1/);
  assert.match(u, /team=ruby/);
  assert.match(u, /#reports\/coverage$/);
  assert.ok(!u.includes('//?'), 'a trailing slash on the base produced a double slash');
  const plain = pdf.reportUrl('http://127.0.0.1:4322', { landscape: false });
  assert.ok(!/landscape/.test(plain), 'portrait asked for landscape anyway');
});

check('AND IT CARRIES THE COMPONENT SELECTION', async () => {
  /* THE BUG THIS EXISTS FOR, and it was silent. The server computed the
     emailed FIGURES from the selected components, but the PDF was rendered by
     a fresh browser at a URL that said nothing about them — so the words read
     "coverage is now 71%" for two components while the attachment underneath
     showed the whole portfolio at 63%. Both numbers correct, in one email,
     and the only person placed to notice was the client. */
  const u = pdf.reportUrl('http://127.0.0.1:4322', {
    team: 'ruby', components: ['PS_iGO_Lafayette', 'PS_iGO_John Hancock'],
  });
  const q = new URLSearchParams(u.slice(u.indexOf('?') + 1, u.indexOf('#')));
  assert.deepStrictEqual(q.getAll('component'), ['PS_iGO_Lafayette', 'PS_iGO_John Hancock'],
    `the selection did not survive into the URL: ${u}`);
  /* APPENDED, NOT SET. A selection is a list and the page reads it with
     `getAll`; `set` would silently keep only the last one, which looks like a
     working filter reporting on one component instead of three. */
  assert.strictEqual(q.getAll('component').length, 2, 'the list collapsed to a single value');
  assert.ok(u.includes('John+Hancock') || u.includes('John%20Hancock'),
    `a component name with a space was not encoded: ${u}`);

  const none = pdf.reportUrl('http://127.0.0.1:4322', { components: [] });
  assert.ok(!/component=/.test(none), 'an empty selection still filtered the report');
  const junk = pdf.reportUrl('http://127.0.0.1:4322', { components: ['A', '', null, 'B'] });
  assert.deepStrictEqual(
    new URLSearchParams(junk.slice(junk.indexOf('?') + 1, junk.indexOf('#'))).getAll('component'),
    ['A', 'B'], 'an empty entry became an empty filter');
});

check('AND IT CARRIES THE VIEW LENS, which is a different kind of thing', async () => {
  /* THE SECOND VERSION OF THE SAME BUG, found on Capacity planning: the sheet
     filtered to the PS family, the attachment showing all 98 components.

     WHY IT SURVIVED THE FIRST FIX. The component selection above changes what
     was COUNTED, so the figures in the mail move with it and a mismatch is at
     least visible to anyone comparing the two. The family chip changes only
     what is DRAWN — every KPI is team-level and identical under any chip — so
     when the lens failed to travel, nothing anywhere disagreed. The document
     was simply the wrong document, quietly, with no number out of place.

     Which is why it travels even though no figure depends on it: the
     attachment is a picture of a screen, and whatever decides the picture has
     to travel with the request for it. */
  const u = pdf.reportUrl('http://127.0.0.1:4322', {
    route: 'sprints/capacity', team: 'titan', sprint: 'S40',
    view: { family: 'ps', showAll: true },
  });
  const q = new URLSearchParams(u.slice(u.indexOf('?') + 1, u.indexOf('#')));
  assert.strictEqual(q.get('family'), 'ps', `the family lens did not survive into the URL: ${u}`);
  assert.strictEqual(q.get('showall'), '1', 'the clear-row fold did not travel');
  assert.match(u, /#sprints\/capacity$/, 'the lens displaced the route');

  /* NOTHING FOR "ALL", rather than `family=`. An empty parameter and a missing
     one both have to mean all, and the page treats them alike — but writing
     one of them makes a sent-unfiltered report look filtered in the log and in
     any URL somebody pastes into a ticket. */
  for (const view of [undefined, {}, { family: null }, { family: '' }]) {
    const plain = pdf.reportUrl('http://127.0.0.1:4322', { view });
    assert.ok(!/family=/.test(plain), `an unfiltered sheet wrote a family: ${plain}`);
    assert.ok(!/showall=/.test(plain), `an unexpanded sheet wrote showall: ${plain}`);
  }
});

check('AND THE PAGE READS IT BACK', async () => {
  /* The other half of the contract, in a different file: `reportUrl` writes
     `component=` and the coverage view has to seed its picker from it. Either
     side alone is correct and useless — and the failure is the silent one
     above, where the PDF simply ignores the filter. */
  const view = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'views', 'report-coverage.js'), 'utf8');
  assert.match(view, /getAll\('component'\)/, 'the coverage view no longer reads the selection out of the URL');
  /* ONLY IN PRINT MODE. Seeding from the URL in the normal app would have it
     re-winning on every redraw, so the picker would snap back after each
     change and read as a broken screen. */
  const seed = view.slice(view.indexOf('function seedPrintSelection'), view.indexOf('async function render'));
  assert.match(seed, /print'\)\s*!==\s*'1'/, 'the URL seeding is not confined to print mode');
});

(async () => {
  if (!pdf.findChrome()) {
    /* SKIPPED, NOT FAILED — but said loudly enough that it is never mistaken
       for coverage. Some machines that run this suite have no browser (a
       plain Linux shell, a CI image without one), and failing there would
       stop every later suite over an environment fact rather than a
       regression. His Mac has Chrome, so these run where it matters. The
       banner exists because a silent skip is how a suite quietly stops
       testing the thing it was written for. */
    console.log('  ! SKIPPED — no Chrome on this machine, so the PDF renderer was NOT tested here.');
    console.log('    These checks need a real browser; run them on a machine that has one.\n');
    console.log('0 passed, 0 failed\n');
    process.exit(0);
  }
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
