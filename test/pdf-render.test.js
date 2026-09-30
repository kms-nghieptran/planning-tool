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

/* ── PHOTOGRAPHING ONE ELEMENT ──────────────────────────────────────────
 *
 * The coverage email can carry the Backlog chart in its body. The picture is
 * taken from the SAME page load that is printed, so the body and the
 * attachment cannot disagree about a sprint that closed between two renders.
 *
 * EVERYTHING HERE FAILS SOFT. The PDF is what was asked for; the chart is a
 * garnish on the covering note. A backlog that has never been backfilled has
 * no chart to photograph, and refusing to send the report over that would be
 * the tool holding his Monday hostage — so these return a reason rather than
 * throwing, and the checks are mostly about that.
 */

/* The chart sits 1800px down, which is the case that matters: a clip built
   from a viewport-relative rect photographs blank space for anything below the
   fold, and the Backlog section is never above it on a real report. */
const WITH_CHART = `<!doctype html><html><body style="margin:0">
  <div style="height:1800px">${'<p>Filler above the chart, as on the real page.</p>'.repeat(30)}</div>
  <div data-chart="backlog" style="width:600px;height:240px;background:#2E7D32"></div>
  <div style="height:900px"></div>
  <script>setTimeout(function () { document.body.dataset.ptRendered = 'ok'; }, 100);</script>
</body></html>`;

const NO_CHART = `<!doctype html><html><body>
  <p>A report with no Backlog section at all.</p>
  <script>setTimeout(function () { document.body.dataset.ptRendered = 'ok'; }, 100);</script>
</body></html>`;

/* Present in the markup and drawn at nothing — an empty chart, which is what an
   un-backfilled backlog renders as. */
const EMPTY_CHART = `<!doctype html><html><body>
  ${'<p>Katalon Ruby — coverage by component, with the blocked suites called out.</p>'.repeat(40)}
  <div data-chart="backlog" style="width:0;height:0;overflow:hidden"></div>
  <script>setTimeout(function () { document.body.dataset.ptRendered = 'ok'; }, 100);</script>
</body></html>`;

/** PNG magic, so a check cannot pass on a base64 string that is not an image. */
const isPng = (b) => Buffer.isBuffer(b) && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));

/* ── READING THE PICTURE, NOT JUST WEIGHING IT ──────────────────────────
 *
 * The first version of these checks asserted that the PNG had some bytes in
 * it, and three mutations survived that: dropping the scroll offset from the
 * clip, dropping `captureBeyondViewport`, and dropping the clip altogether.
 * Every one of them produces a PNG — of blank white page, or of the whole
 * viewport — and every one of them is an email carrying a picture of nothing.
 * A byte count cannot tell those from a chart.
 *
 * So the pixels are read. `zlib` is built in, a screenshot is always 8-bit
 * RGBA, and un-filtering five scanlines is forty lines of code — a far smaller
 * price than a check that agrees with a blank rectangle.
 */
const zlib = require('node:zlib');

/** Width and height off the IHDR, which is always the first chunk. */
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** The pixel at (x, y) as [r, g, b], by un-filtering the rows up to it. */
function pngPixel(buf, px, py) {
  const { width } = pngSize(buf);
  const depth = buf[24], colour = buf[25];
  if (depth !== 8 || (colour !== 6 && colour !== 2)) {
    throw new Error(`unexpected PNG format: depth ${depth}, colour type ${colour}`);
  }
  const bpp = colour === 6 ? 4 : 3;

  // Every IDAT chunk, concatenated, then inflated.
  const idat = [];
  let at = 8;
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + len));
    if (type === 'IEND') break;
    at += len + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));

  const stride = width * bpp;
  let prev = Buffer.alloc(stride);
  let row = Buffer.alloc(stride);
  for (let y = 0; y <= py; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    row = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      row[i] = v & 0xff;
    }
    prev = row;
  }
  const i = px * bpp;
  return [row[i], row[i + 1], row[i + 2]];
}

const isGreenish = ([r, g, b]) => g > r + 30 && g > b + 30;
const isWhite = ([r, g, b]) => r > 240 && g > 240 && b > 240;

check('THE CHART IS PHOTOGRAPHED FROM THE SAME PAGE LOAD AS THE PDF', async () => {
  const s = await serve(WITH_CHART);
  try {
    const out = await pdf.render(s.url, opts({ capture: pdf.BACKLOG_CHART }));
    assert.ok(out.bytes > 1000, 'the PDF was lost while taking the picture');
    assert.ok(out.capture && out.capture.ok, `no picture: ${JSON.stringify(out.capture)}`);
    assert.ok(isPng(out.capture.png), 'what came back is not a PNG');
    /* THE CLIP IS THE ELEMENT, not the viewport. 600×240 at 2x. A viewport-sized
       answer here means the clip was ignored and the email would carry a
       screenshot of the whole report. */
    assert.strictEqual(out.capture.width, 1200, `width ${out.capture.width}`);
    assert.strictEqual(out.capture.height, 480, `height ${out.capture.height}`);
  } finally { s.close(); }
});

check('AND IT REACHES AN ELEMENT BELOW THE FOLD — the viewport-coordinates trap', async () => {
  /* `getBoundingClientRect` is viewport-relative and the Backlog section sits
     1800px down, so a clip built without the scroll offset photographs blank
     page. The chart in the fixture is solid green on white: if the clip landed
     anywhere else the picture comes back white, which is the bug that ships
     unnoticed because it is still a perfectly valid PNG.

     THE PIXELS ARE READ, NOT THE BYTE COUNT. Weighing the file let three
     separate mutations through — no scroll offset, no `captureBeyondViewport`,
     no clip at all — because every one of them still produces an image. */
  const s = await serve(WITH_CHART);
  try {
    const out = await pdf.render(s.url, opts({ capture: pdf.BACKLOG_CHART }));
    const png = out.capture.png;
    const size = pngSize(png);
    assert.strictEqual(size.width, 1200, `the picture is ${size.width}px wide — the clip was ignored`);
    assert.strictEqual(size.height, 480, `the picture is ${size.height}px tall — the clip was ignored`);

    /* FOUR CORNERS AND THE MIDDLE, because a clip that is off by a little lands
       partly on the chart, and one sampled pixel in the centre would forgive
       it. */
    for (const [x, y] of [[4, 4], [1195, 4], [4, 475], [1195, 475], [600, 240]]) {
      const px = pngPixel(png, x, y);
      assert.ok(isGreenish(px),
        `(${x},${y}) is rgb(${px}) — the picture is not the chart`);
      assert.ok(!isWhite(px), `(${x},${y}) is blank page, so the clip missed the chart`);
    }
  } finally { s.close(); }
});

check('AND THE CLIP IS IN DOCUMENT SPACE, so a scrolled page still finds it', async () => {
  /* `getBoundingClientRect` is relative to the VIEWPORT. On a page sitting at
     scroll 0 — which is every page headless Chrome has just loaded — the scroll
     offset is zero and leaving it out changes nothing, so the fixtures above
     cannot tell the two apart. A page that scrolls itself can: an anchor in the
     URL, a restored position, or a view that jumps to a section will all do it,
     and then a viewport-relative clip photographs the wrong band of the page.

     The chart is green, the filler is white, and the page scrolls 900px before
     it reports ready. */
  const scrolled = `<!doctype html><html><body style="margin:0">
    <div style="height:1800px"></div>
    <div data-chart="backlog" style="width:600px;height:240px;background:#2E7D32"></div>
    <div style="height:2000px"></div>
    <script>
      window.scrollTo(0, 900);
      setTimeout(function () { document.body.dataset.ptRendered = 'ok'; }, 150);
    </script>
  </body></html>`;
  const s = await serve(scrolled);
  try {
    const out = await pdf.render(s.url, opts({ pdf: false, capture: pdf.BACKLOG_CHART }));
    assert.ok(out.capture.ok, `it was refused: ${JSON.stringify(out.capture)}`);
    const png = out.capture.png;
    assert.strictEqual(pngSize(png).width, 1200, 'the clip was not the element');
    for (const [x, y] of [[4, 4], [1195, 475], [600, 240]]) {
      const px = pngPixel(png, x, y);
      assert.ok(isGreenish(px),
        `(${x},${y}) is rgb(${px}) — the clip was built from viewport coordinates on a scrolled page`);
    }
  } finally { s.close(); }
});

check('A PAGE WITH NO CHART SENDS THE REPORT ANYWAY, and says why', async () => {
  const s = await serve(NO_CHART);
  try {
    const out = await pdf.render(s.url, opts({ capture: pdf.BACKLOG_CHART }));
    assert.ok(out.bytes > 1000, 'the PDF was refused over a missing garnish');
    assert.strictEqual(out.capture.ok, false);
    assert.match(out.capture.reason, /matched/i, `the reason says nothing useful: ${out.capture.reason}`);
  } finally { s.close(); }
});

check('AND A CHART WITH NO SIZE IS REPORTED AS EMPTY, not photographed as a sliver', async () => {
  /* An un-backfilled backlog. `captureScreenshot` with a zero-width clip
     returns a 0×0 PNG that every client renders as a broken image. */
  const s = await serve(EMPTY_CHART);
  try {
    const out = await pdf.render(s.url, opts({ capture: pdf.BACKLOG_CHART }));
    assert.strictEqual(out.capture.ok, false);
    assert.match(out.capture.reason, /no size|empty/i, `the reason says nothing useful: ${out.capture.reason}`);
    assert.ok(!out.capture.png, 'a zero-size picture was produced anyway');
  } finally { s.close(); }
});

check('ASKING FOR NO PICTURE PRODUCES NONE, and changes nothing else', async () => {
  const s = await serve(WITH_CHART);
  try {
    const out = await pdf.render(s.url, opts());
    assert.ok(out.bytes > 1000);
    assert.strictEqual(out.capture, null, 'a picture was taken that nobody asked for');
  } finally { s.close(); }
});

check('AND A PICTURE WITH NO PDF SKIPS THE PRINT ENTIRELY', async () => {
  /* A template can carry the chart in the body with no attachment at all, and
     printing a document nobody will receive is four seconds of somebody's
     Monday. */
  const s = await serve(WITH_CHART);
  try {
    const out = await pdf.render(s.url, opts({ pdf: false, capture: pdf.BACKLOG_CHART }));
    assert.strictEqual(out.file, null, 'a PDF was printed for a template that wanted none');
    assert.strictEqual(out.bytes, 0);
    assert.ok(out.capture && out.capture.ok, 'and the one thing it was for did not arrive');
    assert.ok(isPng(out.capture.png));
  } finally { s.close(); }
});

check('A VERY WIDE CHART IS SCALED DOWN RATHER THAN REFUSED', async () => {
  /* This goes in an email body. A 4000px-wide PNG is megabytes, every client
     scales it to 600px anyway, and some mailboxes refuse the message over it —
     on a mail whose real payload is the PDF. Trimmed, not rejected: a wide
     chart is still a perfectly good chart. */
  const wide = `<!doctype html><html><body style="margin:0">
    <div data-chart="backlog" style="width:2400px;height:200px;background:#333"></div>
    <script>setTimeout(function () { document.body.dataset.ptRendered = 'ok'; }, 100);</script>
  </body></html>`;
  const s = await serve(wide);
  try {
    const out = await pdf.render(s.url, opts({ pdf: false, capture: pdf.BACKLOG_CHART }));
    assert.ok(out.capture.ok, `it was refused: ${JSON.stringify(out.capture)}`);
    assert.ok(out.capture.scale < 2, `the scale was not trimmed: ${out.capture.scale}`);
    assert.ok(out.capture.width <= pdf.MAX_SHOT_PX,
      `${out.capture.width}px is past the cap of ${pdf.MAX_SHOT_PX}`);
    assert.ok(out.capture.width > 1000, 'it was trimmed so far the chart is unreadable');
  } finally { s.close(); }
});

check('THE SELECTOR IS ONE AGREEMENT, named on both sides of it', async () => {
  /* The send route asks for `pdf.BACKLOG_CHART` and `report-coverage.js` puts
     that attribute on the chart holder. A selector typed into the route instead
     would drift from the page, and the failure is an email that quietly arrives
     without its picture. */
  const view = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'views', 'report-coverage.js'), 'utf8');
  assert.strictEqual(pdf.BACKLOG_CHART, '[data-chart="backlog"]');
  assert.ok(view.includes('data-chart="backlog"'),
    'the coverage page no longer carries the attribute the renderer looks for');
});

/* ── THE PAGE DRESSES ITS OWN CHART FOR THE PHOTOGRAPH ──────────────────
 *
 * The chart on the page carries no title and no key: the section heading above
 * it and the row beneath it already say both, and putting them in the SVG as
 * well made the screen worse. But a photograph of that element has none of that
 * context — four coloured bands and nothing saying what they are.
 *
 * So the page owns a hook, `window.ptChartShot.<name>`, returning the same
 * chart drawn for standing alone. The renderer asks for it immediately before
 * the picture and AFTER the PDF has been printed from the untouched page.
 */

/* A page whose hook swaps in something taller and captioned — the shape of the
   real one, which grows to fit a title and a key. */
const HOOKED = `<!doctype html><html><body style="margin:0">
  <div style="height:1800px">${'<p>Filler above the chart.</p>'.repeat(30)}</div>
  <div data-chart="backlog"><div style="width:600px;height:240px;background:#2E7D32"></div></div>
  <div style="height:900px"></div>
  <script>
    window.ptChartShot = {
      backlog: () => '<div style="width:600px;height:340px;background:#B22222"></div>',
    };
    setTimeout(function () { document.body.dataset.ptRendered = 'ok'; }, 100);
  </script>
</body></html>`;

check('THE CAPTURE ASKS THE PAGE FOR ITS EXPORT VERSION', async () => {
  const s = await serve(HOOKED);
  try {
    const out = await pdf.render(s.url, opts({ pdf: false, capture: pdf.BACKLOG_CHART }));
    assert.ok(out.capture.ok, `refused: ${JSON.stringify(out.capture)}`);
    assert.strictEqual(out.capture.dressed, true, `the hook was not used: ${out.capture.dressedWhy}`);
    /* THE SWAPPED-IN VERSION IS TALLER, and the picture is of it. 340px at 2x —
       not the 240px that is on the page. Measuring before the swap would have
       clipped the caption straight off the top. */
    assert.strictEqual(pngSize(out.capture.png).height, 680,
      'the picture is the height of the on-page chart, so it was measured before the swap');
    /* AND IT IS THE NEW CONTENT, not the old one at a new size. */
    const px = pngPixel(out.capture.png, 600, 340);
    assert.ok(px[0] > 150 && px[1] < 80, `the picture is rgb(${px}) — it photographed the page's own chart`);
  } finally { s.close(); }
});

check('A PAGE WITH NO HOOK IS PHOTOGRAPHED AS IT STANDS', async () => {
  /* Not an error. An older build, or a chart nobody has wired a hook for, gets
     exactly the picture it used to get — which is still a perfectly good one. */
  const s = await serve(WITH_CHART);
  try {
    const out = await pdf.render(s.url, opts({ pdf: false, capture: pdf.BACKLOG_CHART }));
    assert.ok(out.capture.ok, `a page without a hook was refused: ${JSON.stringify(out.capture)}`);
    assert.strictEqual(out.capture.dressed, false);
    assert.strictEqual(out.capture.dressedWhy, 'no-hook');
    assert.strictEqual(pngSize(out.capture.png).height, 480, 'the undressed chart changed size');
  } finally { s.close(); }
});

check('AND A HOOK THAT THROWS DOES NOT LOSE THE PICTURE', async () => {
  /* The caption is a garnish. A page whose hook is broken should still send a
     chart, and should say why it has no title. */
  const broken = HOOKED.replace(
    "backlog: () => '<div style=\"width:600px;height:340px;background:#B22222\"></div>',",
    'backlog: () => { throw new Error("hook is broken"); },');
  const s = await serve(broken);
  try {
    const out = await pdf.render(s.url, opts({ pdf: false, capture: pdf.BACKLOG_CHART }));
    assert.ok(out.capture.ok, 'a broken hook lost the whole picture');
    assert.strictEqual(out.capture.dressed, false);
    assert.match(out.capture.dressedWhy, /hook is broken/, `the reason is lost: ${out.capture.dressedWhy}`);
    assert.strictEqual(pngSize(out.capture.png).height, 480, 'it should fall back to what is on the page');
  } finally { s.close(); }
});

check('AND A HOOK THAT RETURNS NOTHING IS THE SAME', async () => {
  const empty = HOOKED.replace(
    "backlog: () => '<div style=\"width:600px;height:340px;background:#B22222\"></div>',",
    "backlog: () => '',");
  const s = await serve(empty);
  try {
    const out = await pdf.render(s.url, opts({ pdf: false, capture: pdf.BACKLOG_CHART }));
    assert.ok(out.capture.ok, 'an empty hook lost the picture');
    assert.strictEqual(out.capture.dressedWhy, 'empty');
    assert.strictEqual(pngSize(out.capture.png).height, 480);
  } finally { s.close(); }
});

check('THE PDF IS PRINTED BEFORE THE CHART IS DRESSED, not after', async () => {
  /* THE ORDERING IS THE WHOLE POINT. Dressing changes the page — it puts a
     title on a chart that already sits under a heading saying the same thing —
     so a PDF printed afterwards carries the duplicate the screen was cleaned up
     to avoid.

     ASSERTED ON THE SOURCE, and honestly labelled as such: the two events
     happen inside one Chrome session with nothing observable between them, and
     a check that could not tell the order apart would be worse than one that
     says what it is measuring. */
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'lib', 'pdf-render.js'), 'utf8');
  const body = src.slice(src.indexOf('async function render('));
  const printAt = body.indexOf("Page.printToPDF");
  const dressAt = body.indexOf("photograph(page");
  assert.ok(printAt > -1 && dressAt > -1, 'the two stages are no longer where this check looks');
  assert.ok(printAt < dressAt,
    'the chart is dressed before the PDF is printed, so the attachment carries a doubly-titled chart');
});

check('AND BOTH STILL COME OUT OF ONE PAGE LOAD', async () => {
  /* Two Chrome launches would cost another four seconds on every send and, far
     worse, would photograph a SECOND rendering — so the chart in the body and
     the chart in the attachment could disagree about a sprint that closed
     between them. */
  const s = await serve(HOOKED);
  try {
    const out = await pdf.render(s.url, opts({ capture: pdf.BACKLOG_CHART }));
    assert.ok(out.bytes > 1000, 'the PDF was lost');
    assert.ok(out.capture.ok && out.capture.dressed, 'the dressed picture was lost');
  } finally { s.close(); }
});

/* ── BARE ON THE PAGE, CAPTIONED ON THE WAY OUT ─────────────────────────
 *
 * The first version drew the title and the key into the chart itself. That
 * fixed the email and made the screen worse: the section heading two lines
 * above already says "Backlog", and the row beneath already names every colour,
 * so the card ended up stating the same thing three times.
 *
 * The caption belongs to the EXPORT. `backlogShotSvg` adds it; the chart the
 * page renders does not have it.
 *
 * ASSERTED ON THE SOURCE, and labelled as such. This view has no DOM harness —
 * it is an IIFE over `UI`, `Charts` and `App` — and a check that rendered it
 * would be testing three stubs. What can be pinned exactly is which call gets
 * the caption options, and that is the thing that regressed.
 */
const coverageSrc = fs.readFileSync(
  require('node:path').join(__dirname, '..', 'public', 'views', 'report-coverage.js'), 'utf8');

/** The arguments of the `Charts.stacked(` call starting at `from`. */
function stackedCallAt(src, from) {
  const start = src.indexOf('Charts.stacked(', from);
  if (start === -1) return null;
  let depth = 0;
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (!depth) return src.slice(start, i + 1); }
  }
  return null;
}

check('THE CHART THE PAGE DRAWS HAS NO TITLE AND NO KEY IN IT', () => {
  const inSection = coverageSrc.indexOf('data-chart="backlog"');
  assert.ok(inSection > -1, 'the backlog chart holder is no longer where this check looks');
  const call = stackedCallAt(coverageSrc, inSection);
  assert.ok(call, 'no Charts.stacked call follows the chart holder');
  assert.ok(!/title:/.test(call), `the on-page chart was given a title again: ${call}`);
  assert.ok(!/legend:/.test(call), `the on-page chart was given a key again: ${call}`);
  assert.ok(!/subtitle:/.test(call), `the on-page chart was given a subtitle again: ${call}`);
  /* AND IT IS STILL CLICKABLE, which is the thing the page version is for. */
  assert.match(call, /drill: true/, 'the on-page chart stopped being drillable');
});

check('AND THE ONE IT EXPORTS HAS BOTH', () => {
  const at = coverageSrc.indexOf('function backlogShotSvg');
  assert.ok(at > -1, 'the export builder is gone, so nothing adds the caption');
  const call = stackedCallAt(coverageSrc, at);
  assert.ok(call, 'the export builder does not draw a chart');
  assert.match(call, /title: 'Backlog Movement'/, 'the exported chart has no title');
  assert.match(call, /legend: true/, 'the exported chart has no key');
  /* AND THE SUBTITLE SAYS SOMETHING. `subtitle:` being present is not the
     guarantee — an empty one satisfies that and ships a picture a client can
     read as the whole portfolio when it is two components and one quarter. It
     has to carry the window AND the scope. */
  assert.match(call, /subtitle: `[^`]*\$\{first\.label\}[^`]*\$\{last\.label\}[^`]*`/,
    `the exported chart does not name the window it covers: ${call}`);
  assert.match(call, /subtitle: `[^`]*\$\{scope\}[^`]*`/,
    `the exported chart does not name what it is scoped to: ${call}`);
  /* NO DRILL HOOKS IN A PICTURE. They cannot be clicked and they make the PNG's
     markup claim to be a row of controls. */
  assert.ok(!/drill: true/.test(call), 'the exported chart carries drill hooks');
});

check('AND BOTH EXITS GO THROUGH THAT ONE BUILDER', () => {
  /* The file he downloads and the picture his client receives must not end up
     captioned differently, which is what two builders would eventually do. */
  const uses = (coverageSrc.match(/backlogShotSvg\(/g) || []).length;
  assert.ok(uses >= 3, `only ${uses} references — one definition and two callers is the minimum`);
  assert.match(coverageSrc, /window\.ptChartShot/, 'the renderer has no hook to call');
  assert.match(coverageSrc, /ptChartShot\.backlog = \(\) => backlogShotSvg/,
    'the hook does not resolve to the same builder the button uses');
});

check('THE HOOK NAME IS ONE AGREEMENT, spelled the same on both sides', () => {
  /* The page publishes it and `pdf-render.js` calls it. Two spellings is an
     email that quietly arrives with an uncaptioned chart. */
  const renderSrc = fs.readFileSync(
    require('node:path').join(__dirname, '..', 'lib', 'pdf-render.js'), 'utf8');
  assert.match(renderSrc, /window\.ptChartShot/, 'the renderer no longer asks for the hook');
  assert.match(coverageSrc, /window\.ptChartShot/, 'the page no longer publishes it');
  assert.strictEqual(pdf.BACKLOG_CHART, '[data-chart="backlog"]');
  assert.ok(coverageSrc.includes('data-chart="backlog"'),
    'the page no longer carries the attribute the renderer clips to');
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
