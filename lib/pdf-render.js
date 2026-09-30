'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * pdf-render.js — turn a page of this tool into a real PDF file.
 *
 * ── WHY CHROME, AND WHY THAT IS NOT A DEPENDENCY ─────────────────────────
 *
 * "Export PDF" on screen means `window.print()`: the browser renders it and
 * he saves it. That is fine for a human and useless for an attachment —
 * there is no file anywhere for the server to pick up.
 *
 * So something has to render HTML to PDF without a person. The options were
 * a PDF library (the first npm dependency this tool would ever have, and the
 * end of "clone it and run it"), writing a PDF by hand (possible for text,
 * hopeless for the charts and the colour that make this report worth
 * sending), or driving the browser that is already on the machine. Chrome is
 * already installed — he reads Jira in it — and nothing is installed or
 * vendored to use it. THE OUTPUT IS THE REAL PAGE: same stylesheet, same
 * print rules, same numbers. The PDF a client opens is the screen he checked.
 *
 * ── WHY THIS DRIVES CHROME INSTEAD OF JUST ASKING IT TO PRINT ────────────
 *
 * The first version used `--print-to-pdf` with `--virtual-time-budget`, which
 * is the documented way to say "load the page, run the timers fast, print".
 * It shipped, and it hung for sixty seconds and sent nothing.
 *
 * The reason is worth writing down, because that flag looks like exactly the
 * right tool. VIRTUAL TIME WAITS FOR THE NETWORK. Chrome advances the clock
 * quickly but pauses it while any request is outstanding — which is what
 * makes the flag useful for a page that fetches its own data, and also means
 * the budget is not a deadline. One request that never settles and the budget
 * is never spent, the print never happens, and the only thing left to report
 * is that Chrome stopped responding. Reproduced exactly: a page whose single
 * `fetch` never resolves hangs this until it is killed. The failure has a
 * mirror image, too — print a moment early and the attachment is a
 * beautifully typeset loading spinner, which is still a valid PDF.
 *
 * THE PAGE NOW SAYS WHEN IT IS DONE. `public/app.js` sets
 * `document.body.dataset.ptRendered` when a view finishes, to `ok` or
 * `error`, and this file connects over Chrome's DevTools protocol, waits for
 * that, and then prints. Three things follow and all three were missing: the
 * render finishes when the report exists rather than when a guessed budget
 * expires; a view that FAILED is reported as a failure instead of timing out;
 * and a timeout can finally say what it was waiting for.
 *
 * NO NEW DEPENDENCY. Node 22 ships `WebSocket` and `fetch`, which is the
 * whole of what the protocol needs.
 */

/* Where Chrome actually is. macOS first because that is his machine; the
   Linux paths are there so this is testable and so a future server run is
   not a rewrite. `CHROME_PATH` wins over all of them, for the case where it
   is installed somewhere none of this predicted. */
const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/opt/pw-browsers/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findChrome(env = process.env) {
  const named = String(env.CHROME_PATH || '').trim();
  if (named) return fs.existsSync(named) ? named : null;
  for (const p of CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* keep looking */ }
  }
  return null;
}

/** What to tell him when it is not there — an instruction, not a diagnosis. */
const MISSING = 'Could not find Google Chrome, which is what renders the PDF. '
  + 'Install Chrome, or set CHROME_PATH to where it lives, and try again.';

/**
 * ONE DEADLINE FOR THE WHOLE JOB, rather than the three unrelated timers the
 * old version had. Every stage below reports which one it was in when the
 * clock ran out, so a number is always followed by what it was spent on.
 *
 * SIXTY SECONDS IS FOR HIS DATA, not for the fixtures. The coverage report
 * over five thousand issues is not the page the tests render, and a limit
 * tuned on a fixture is how this fails on the only machine that matters.
 */
const BUDGET = 60000;
const POLL_MS = 100;

const wait = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * One DevTools connection — the request/reply plumbing the protocol needs
 * and nothing else.
 *
 * Replies come back out of order and carry the id of the call they answer,
 * so this keeps a map of what is outstanding. A SOCKET THAT CLOSES REJECTS
 * EVERYTHING STILL PENDING: without that, a tab that crashed would look
 * exactly like a tab that was taking a long time, which is the failure this
 * whole rewrite exists to end.
 */
function connect(url) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
    const pending = new Map();
    let id = 0;
    let dead = null;

    const fail = (why) => {
      dead = dead || new Error(why);
      for (const [, p] of pending) p.reject(dead);
      pending.clear();
    };

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'Chrome refused the command.'));
      else p.resolve(msg.result);
    });
    ws.addEventListener('error', () => { fail('The connection to Chrome failed.'); reject(new Error('The connection to Chrome failed.')); });
    ws.addEventListener('close', () => fail('Chrome closed the connection before the PDF was made.'));
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        if (dead) return Promise.reject(dead);
        const mine = ++id;
        return new Promise((res, rej) => {
          pending.set(mine, { resolve: res, reject: rej });
          try { ws.send(JSON.stringify({ id: mine, method, params })); }
          catch (e) { pending.delete(mine); rej(e); }
        });
      },
      close() { try { ws.close(); } catch { /* already gone */ } },
    }));
  });
}

/** Chrome prints `DevTools listening on ws://…` to stderr once it is up. */
function endpointFrom(stderr) {
  const m = String(stderr).match(/DevTools listening on (ws:\/\/\S+)/);
  return m ? m[1] : null;
}

/**
 * THE PROBE, asked of the page about ten times a second.
 *
 * Four answers, and the difference between them is what makes a timeout
 * diagnosable at all:
 *   `ok`      — a view finished rendering. Print it.
 *   `error`   — a view threw. Reported as that rather than as a timeout,
 *               because the two send him to completely different places.
 *   `pending` — the document is complete but no view has finished yet.
 *   `loading` — the document itself is still arriving.
 */
const PROBE = `(function () {
  try {
    var d = document.body && document.body.dataset;
    if (d && d.ptRendered) return d.ptRendered;
    return document.readyState === 'complete' ? 'pending' : 'loading';
  } catch (e) { return 'pending'; }
})()`;

/**
 * IS THAT ACTUALLY A PDF OF THE REPORT?
 *
 * Three ways a render "succeeds" and produces something a client should never
 * receive, and none of them raises an error on its own:
 *
 *   NOTHING WAS WRITTEN. Headless Chrome has reported success having written
 *   no file often enough that trusting it is how an empty attachment goes out.
 *
 *   IT IS NOT A PDF. An error page, a truncated write, a disk that filled.
 *
 *   IT IS A PDF OF A LOADING SPINNER. The worst of the three, because it is
 *   structurally perfect and only a human reading it can tell. A real page of
 *   this report is hundreds of kilobytes; a kilobyte floor catches the stub
 *   without being anywhere near a legitimate document.
 *
 * Its own function so it stays under test directly. It used to be inline, and
 * the only way to exercise it was through a fake Chrome — which stopped being
 * possible the moment the renderer started driving a real one, and would have
 * quietly taken these three guarantees with it.
 */
function verify(file, detail = '') {
  if (!fs.existsSync(file)) throw new Error(`Chrome produced no PDF.${detail}`);
  const bytes = fs.statSync(file).size;
  const head = Buffer.alloc(5);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 5, 0); } finally { fs.closeSync(fd); }
  if (head.toString('latin1') !== '%PDF-') throw new Error('Chrome wrote a file that is not a PDF.');
  if (bytes < 1000) throw new Error(`The rendered PDF is only ${bytes} bytes — the page had not finished loading.`);
  return bytes;
}

/**
 * WHERE AN ELEMENT IS ON THE PAGE, in document coordinates.
 *
 * `getBoundingClientRect` is relative to the VIEWPORT, and the report page is
 * several screens long — so a chart two thirds of the way down has a negative
 * or off-screen `top` and a clip built from it photographs the wrong part of
 * the page, or nothing. The scroll offsets put it back into document space,
 * which is what `captureBeyondViewport` expects.
 *
 * It returns a STRING on failure rather than throwing, because every failure
 * here is a reason to send the email without a picture and none of them is a
 * reason not to send it.
 */
const BOUNDS = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return 'no-element';
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return 'not-drawn';
  return JSON.stringify({
    x: r.left + window.scrollX, y: r.top + window.scrollY,
    width: r.width, height: r.height,
  });
})()`;

/**
 * ASK THE PAGE FOR ITS EXPORT VERSION OF THE CHART.
 *
 * The chart on the page carries no title and no key — the section heading above
 * it and the row beneath it already say both, and putting them in the SVG as
 * well made the screen worse. A photograph of that element has none of that
 * context: four coloured bands and nothing saying what they are.
 *
 * So the page owns a hook, `window.ptChartShot.<name>`, that returns the SAME
 * chart drawn for standing alone. This swaps it in immediately before the
 * picture is taken — after the PDF has already been printed from the untouched
 * page.
 *
 * THE HOOK IS THE PAGE'S, NOT THIS FILE'S. The alternative was for the renderer
 * to build the caption itself, which would mean two places deciding what a
 * Backlog chart looks like, in two processes, drifting apart quietly. Here the
 * only thing this file knows is the name of the chart it wants.
 *
 * MISSING IS NOT AN ERROR. A page that has no hook — an older build, a chart
 * nobody has wired one for — is photographed exactly as it stands, which is
 * what used to happen and is still a perfectly good picture.
 */
const DRESS = (name) => `(() => {
  try {
    const make = window.ptChartShot && window.ptChartShot[${JSON.stringify(name)}];
    if (typeof make !== 'function') return 'no-hook';
    const markup = make();
    if (!markup) return 'empty';
    const host = document.querySelector('[data-chart="' + ${JSON.stringify(name)} + '"]');
    if (!host) return 'no-host';
    host.innerHTML = markup;
    return 'dressed';
  } catch (e) { return 'failed: ' + (e && e.message); }
})()`;

/* A CAP ON THE PICTURE. This goes into an email body: a 4000px-wide PNG is
   megabytes, gets scaled down to 600px by every client anyway, and pushes some
   mailboxes over their attachment limit — on a mail whose actual payload is the
   PDF. Two is the sweet spot for a chart read on a retina screen. */
const SHOT_SCALE = 2;
const MAX_SHOT_PX = 2600;

async function photograph(page, selector, scale = SHOT_SCALE, name = 'backlog') {
  /* DRESSED FIRST, MEASURED SECOND. The export version is taller than the one
     on screen — it grows to fit a title and a key — so measuring before the
     swap would clip the caption straight off the top of the picture. */
  const dressed = await page.send('Runtime.evaluate', { expression: DRESS(name), returnByValue: true });
  const how = (dressed && dressed.result && dressed.result.value) || 'unknown';

  const got = await page.send('Runtime.evaluate', { expression: BOUNDS(selector), returnByValue: true });
  const value = got && got.result && got.result.value;
  if (typeof value !== 'string') return { ok: false, reason: 'The page did not answer where the chart is.' };
  if (value === 'no-element') return { ok: false, reason: `Nothing on the page matched ${selector}.` };
  if (value === 'not-drawn') return { ok: false, reason: 'The chart is on the page but has no size — it is probably empty.' };

  let clip;
  try { clip = JSON.parse(value); } catch { return { ok: false, reason: 'The page gave an unreadable position for the chart.' }; }

  /* THE SCALE IS TRIMMED TO FIT, not refused. A very wide chart at 2x is still
     a perfectly good chart at 1.4x, and failing the picture over a size nobody
     asked for would be the tool being precious. */
  const want = Math.max(1, Math.min(4, Number(scale) || SHOT_SCALE));
  const fit = Math.min(want, MAX_SHOT_PX / Math.max(1, clip.width));
  const used = Math.max(1, Math.round(fit * 100) / 100);

  const png = await page.send('Page.captureScreenshot', {
    format: 'png',
    /* THE CLIP IS IN DOCUMENT COORDINATES and the element is below the fold, so
       without this Chrome photographs the viewport and clips against that —
       which for a chart 2000px down the page is a blank rectangle. */
    captureBeyondViewport: true,
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: used },
  });
  if (!png || !png.data) return { ok: false, reason: 'Chrome took the picture but returned nothing.' };

  return {
    ok: true,
    png: Buffer.from(png.data, 'base64'),
    width: Math.round(clip.width * used),
    height: Math.round(clip.height * used),
    scale: used,
    /* WHETHER IT GOT THE CAPTIONED VERSION, carried back rather than assumed.
       A picture taken from a page whose hook did not answer is a picture with
       no title and no key — still worth sending, and worth being able to see in
       a log when somebody asks why the caption is missing. */
    dressed: how === 'dressed',
    dressedWhy: how,
  };
}

/**
 * Render a URL to a PDF file, and optionally photograph one element of it.
 *
 * @param {string} url   the page, on this tool's own loopback server
 * @param {object} o     { out, landscape, chrome, budget, env, spawn, args,
 *                         capture, captureScale, pdf }
 * @returns {Promise<{file, bytes, chrome, ms, capture}>}
 */
async function render(url, o = {}) {
  /* `o.env` so a caller can ask "what happens with no Chrome" without
     uninstalling one. The container that runs these checks has Chromium on
     it, so a test that relied on absence would pass for the wrong reason
     here and fail on a machine that has Chrome — which is every real one. */
  const chrome = o.chrome || findChrome(o.env || process.env);
  if (!chrome) throw Object.assign(new Error(MISSING), { missingChrome: true });

  const budget = o.budget || BUDGET;
  const startedAt = Date.now();
  const left = () => budget - (Date.now() - startedAt);
  const out = o.out || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-pdf-')), 'report.pdf');
  const launch = o.spawn || spawn;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-chrome-'));

  const args = [
    '--headless=new',
    '--disable-gpu',
    /* PORT 0: CHROME PICKS ONE AND TELLS US. A fixed port collides with a
       second copy of this tool, with a developer's own debugging session, and
       with two scheduled sends that overlap — and the collision does not fail
       cleanly, it attaches to the wrong browser. */
    '--remote-debugging-port=0',
    /* A THROWAWAY PROFILE. Without it Chrome refuses to start when he already
       has a window open — the default profile is locked — which would make
       this feature fail exactly when he is using the machine. */
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    /* NO `--virtual-time-budget` AND NO COMPOSITOR FLAGS. The readiness
       signal replaced the guessing; keeping the flags as well would mean two
       mechanisms deciding when the page is finished and only one of them
       observable when they disagree. */
    ...(o.args || []),
    'about:blank',
  ];

  const child = launch(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let shot = null;
  const said = () => (stderr.trim() ? ` Chrome said: ${stderr.trim().split('\n').pop()}` : '');

  try {
    /* ── stage 1: Chrome starts and announces its port ─────────────────── */
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Chrome did not start within ${Math.round(budget / 1000)}s.${said()}`)),
        Math.max(1000, left()));
      const settle = (fn, v) => { clearTimeout(timer); fn(v); };
      if (child.stderr) {
        child.stderr.on('data', (d) => {
          stderr += String(d).slice(0, 4000);
          const ws = endpointFrom(stderr);
          if (ws) settle(resolve, ws);
        });
      }
      child.on('error', (e) => settle(reject, new Error(`Could not start Chrome — ${e.message}`)));
      child.on('exit', (code) => settle(reject,
        new Error(`Chrome exited (code ${code}) before it was ready.${said()}`)));
    });

    /* ── stage 2: open a tab on the report and attach to it ────────────── */
    const base = endpoint.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '');
    const res = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!res.ok) throw new Error(`Chrome would not open the report page (HTTP ${res.status}).`);
    const target = await res.json();
    if (!target.webSocketDebuggerUrl) throw new Error('Chrome opened the page but offered no way to drive it.');

    const page = await connect(target.webSocketDebuggerUrl);
    try {
      await page.send('Page.enable');
      await page.send('Runtime.enable');

      /* ── stage 3: wait for the page to say it has finished ───────────── */
      let state = 'loading';
      while (left() > 0) {
        const r = await page.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
        state = (r && r.result && r.result.value) || 'pending';
        if (state === 'ok' || state === 'error') break;
        await wait(POLL_MS);
      }

      if (state === 'error') {
        throw new Error('The report page failed to render, so there was nothing to print. '
          + `Open ${url} in a browser to see the error it showed.`);
      }
      if (state !== 'ok') {
        /* THE TIMEOUT THAT SAYS SOMETHING. The old one could only report that
           Chrome had not finished. This names the stage and the last thing
           the page admitted to, which is the difference between "try it
           again" and knowing where to look. */
        throw new Error(`The report did not finish rendering within ${Math.round(budget / 1000)}s `
          + `— the page was still "${state}". That is usually one slow or stuck request. `
          + `Open ${url} in a browser and watch it load.`);
      }

      /* ── stage 4a: print, BEFORE anything is touched ──────────────────
         The PDF is a picture of the page as it stands. The chart capture below
         changes the page — it asks it to redraw the chart with a caption the
         screen deliberately does not show — so printing afterwards would put a
         doubly-titled chart in the attachment, under the section heading that
         already says "Backlog". Print first, then rearrange. */
      if (o.pdf !== false) {
        const pdf = await page.send('Page.printToPDF', {
          landscape: o.landscape !== false,
          /* `printBackground` BECAUSE THE MEANING IS IN THE COLOUR. The
             coverage bars, the blocked markers and the status tags are all
             backgrounds; without this a client opens a grey table and cannot
             tell the blocked rows from the rest. */
          printBackground: true,
          /* The page ships its own `@page` rule for landscape, and honouring it
             keeps the emailed PDF identical to the on-screen Export PDF rather
             than subtly differently sized. */
          preferCSSPageSize: true,
          marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4,
        });
        if (!pdf || !pdf.data) throw new Error('Chrome reported success but returned no PDF.');
        fs.writeFileSync(out, Buffer.from(pdf.data, 'base64'));
      }

      /* ── stage 4b: photograph one element, if asked ──────────────────
         IN THE SAME CHROME AS THE PRINT, deliberately. A second launch would
         cost another four seconds on every send and, worse, would photograph a
         SECOND rendering of the page — so the chart in the body and the chart
         in the attachment could disagree about a sprint that closed between
         them. One page load, two pictures of it.

         AND IT NEVER FAILS THE RENDER. The PDF is the thing that was asked
         for; the picture is a garnish on the covering note. A chart that has
         not been backfilled yet, or a selector that finds nothing because the
         section is empty, must produce an email without an image rather than
         no email — so everything here resolves to a reason instead of throwing,
         and it travels back for the caller to log. */
      if (o.capture) {
        shot = await photograph(page, o.capture, o.captureScale, o.captureName);
      }

      if (o.pdf === false) {
        /* NO PDF WANTED. The template can carry the chart in the body with no
           attachment at all, and printing a document nobody will receive is
           four seconds of somebody's Monday. */
        return { file: null, bytes: 0, chrome, ms: Date.now() - startedAt, capture: shot };
      }
    } finally {
      page.close();
    }

    return { file: out, bytes: verify(out, said()), chrome, ms: Date.now() - startedAt, capture: shot };
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

/**
 * THE URL TO RENDER.
 *
 * `print=1` is read by the app: it hides the nav and the controls and turns
 * on the same landscape rule the on-screen Export PDF uses. Built here rather
 * than by the caller so the page the email attaches and the page he checked
 * are the same page, addressed the same way.
 */
function reportUrl(base, { route = 'reports/coverage', team = null, sprint = null, landscape = true, components = [], view = {} } = {}) {
  const q = new URLSearchParams({ print: '1' });
  if (landscape) q.set('landscape', '1');
  if (team) q.set('team', team);
  if (sprint) q.set('sprint', sprint);
  /* THE COMPONENT FILTER TRAVELS WITH THE URL, and it has to, because the
     figures quoted in the email are computed from the same selection on the
     server. Without it the words and the attachment answer the same question
     differently — the mail says 71% for two components and the PDF shows the
     whole portfolio at 63% — and nobody here would ever see the two side by
     side. `append`, not `set`: a selection is a list, and the page reads it
     back with `getAll`. */
  for (const c of (components || [])) if (c) q.append('component', String(c));
  /* AND THE LENS, which is a different kind of thing and travels anyway.
     The component filter above changes what was COUNTED, so the figures in
     the mail move with it. The capacity sheet's family chip changes only what
     is DRAWN — the KPI strip is team-level and identical either way — but the
     attachment is supposed to be the table he was looking at, and without
     this a plan filtered to the PS family arrived showing all 98 components.
     Same lesson as the components, one layer out: whatever decides the
     picture has to travel with the request for the picture. */
  const vw = view || {};
  if (vw.family) q.set('family', String(vw.family));
  if (vw.showAll) q.set('showall', '1');
  return `${String(base).replace(/\/+$/, '')}/?${q.toString()}#${route}`;
}

/* THE CHART THE COVERAGE MAIL CAN CARRY. Named here rather than typed into the
   send route, because the selector and the element that answers to it are one
   agreement across two files — and the failure when they drift is an email that
   quietly arrives without its picture. `report-coverage.js` puts this attribute
   on the chart holder; nothing else in the app uses it. */
const BACKLOG_CHART = '[data-chart="backlog"]';

module.exports = {
  render, findChrome, reportUrl, endpointFrom, verify, photograph, BOUNDS, DRESS,
  PROBE, CANDIDATES, MISSING, BUDGET, BACKLOG_CHART, SHOT_SCALE, MAX_SHOT_PX,
};
