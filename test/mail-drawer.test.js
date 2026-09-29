'use strict';
/**
 * mail-drawer.test.js — the "Email the report" panel, driven.
 *
 * WHY THIS SUITE EXISTS
 *
 * This drawer has now produced two bugs that no check could see, and both had
 * the same shape: the model was right, the routes were right, and the panel
 * threw on the way to the screen.
 *
 *   `UI.drillDrawer(...)` called bare — it RETURNS html, it does not open a
 *   drawer — so three drill-ins silently did nothing.
 *
 *   `(t.to || []).join(', ')` against a string. A saved template carries `to`
 *   as an ARRAY; the form produces a STRING, and `readForm()` puts the string
 *   back into the panel's own state. So the first redraw after Preview died
 *   with "join is not a function", and the preview he is required to read
 *   before sending could not be reached at all.
 *
 * Neither is reachable from the model tests or the route tests. So this boots
 * the real view, opens the panel, and drives the buttons — which is the only
 * place either failure exists.
 *
 * Run: node test/mail-drawer.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
console.log('\nThe "Email the report" panel\n');

/* ── the harness ──────────────────────────────────────────────────────────
   Thin, but real where it counts: the drawer's markup is captured as a
   string, and the handlers the view registers are the ones a click runs. A
   stub that swallowed either would pass against a panel that never drew. */

function boot({ templates = [], cfg = null, api = null } = {}) {
  const drawn = [];
  const toasts = [];
  const nodes = new Map();

  const el = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id, value: '', checked: true, disabled: false, textContent: '',
        _on: {},
        addEventListener(t, fn) { (this._on[t] = this._on[t] || []).push(fn); },
        /* THE HANDLERS ARE ASYNC and the panel redraws after an await, so a
           `fire` that dropped the returned promise would let a check read the
           drawer one tick before it was rewritten — passing or failing on
           timing rather than on behaviour. Every handler's promise comes
           back so the caller can wait for the redraw it triggered. */
        fire(t, e = {}) {
          return Promise.all((this._on[t] || []).map(fn => fn({ target: this, preventDefault() {}, ...e })));
        },
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      });
    }
    return nodes.get(id);
  };

  /* THE DRAWER'S OWN MARKUP IS PARSED FOR ITS CONTROLS. `UI.$$` over the
     rendered html is what the real page does via the DOM; here the ids in the
     string decide which stub nodes exist, so a control the view stopped
     rendering stops being clickable — which is the point. */
  const inDrawer = (sel) => {
    const html = drawn[drawn.length - 1] || '';
    /* THE COMMA LIST IS CHECKED FIRST, and the order is not cosmetic.
       The view wires its "any edit" handler with one multi-selector —
       `#mtName, #mtTo, #mtCc, #mtSubject, #mtBody`. Testing `startsWith('#')`
       before splitting matches that whole string as a single id, finds
       nothing, and attaches the handler to no element at all — so the check
       that Send is re-disabled after an edit passed against a panel where
       editing did nothing. A harness that is wrong in this direction does not
       fail; it quietly stops testing. */
    if (sel.includes(',')) return sel.split(',').flatMap(x => inDrawer(x.trim()));
    if (sel.startsWith('#')) return html.includes(`id="${sel.slice(1)}"`) ? [el(sel.slice(1))] : [];
    const m = sel.match(/\[data-mail="([^"]+)"\]/);
    if (m) return html.includes(`data-mail="${m[1]}"`) ? [el(`mail:${m[1]}`)] : [];
    return [];
  };

  const ctx = {
    console, Promise, setTimeout, clearTimeout, encodeURIComponent, URLSearchParams,
    JSON, Date, Math, Number, String, Array, Object, Boolean, RegExp, Error,
    App: { refresh() {} },
    Charts: new Proxy({}, { get: () => () => '' }),
    confirm: () => true,
    document: { createElement: () => ({ set innerHTML(_) {}, content: {} }), querySelector: () => null, querySelectorAll: () => [] },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(PUBLIC, 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);

  ctx.UI.drawer = (html) => { drawn.push(html); };
  ctx.UI.closeDrawer = () => { drawn.push('[closed]'); };
  ctx.UI.toast = (m, bad) => { toasts.push({ m, bad }); };
  ctx.UI.$ = (sel) => (inDrawer(sel)[0] || null);
  ctx.UI.$$ = (sel) => inDrawer(sel);
  ctx.UI.api = api || (async (p) => {
    /* MATCHED ON THE PATH, NOT THE WHOLE STRING. The drawer asks
       `/api/mail/config?report=sprint` so the placeholder list belongs to the
       report it is on, and an exact-match stub answered nothing — which the
       panel read as "mail is not set up" and every check below failed on a
       setup screen. A stub that is too strict does not fail loudly; it
       quietly tests a different panel. */
    const route = String(p).split('?')[0];
    if (route === '/api/mail/config') {
      return cfg || {
        configured: true, host: 'smtp.gmail.com', port: 587,
        from: 'me@kms-technology.com', fromName: 'Nghiep Tran',
        authenticated: true, hasPass: true, chrome: true,
        fields: [{ key: 'team', label: "The team's name" }, { key: 'coverage', label: 'Overall coverage %' }],
        report: 'coverage',
        reports: [
          { key: 'coverage', label: 'Overall Coverage', defaultFilename: 'Automation Delivery Dashboard - {{date}}' },
          { key: 'sprint', label: 'Active Sprint', defaultFilename: 'Sprint Report - {{sprint}} - {{date}}' },
        ],
      };
    }
    if (route === '/api/mail/templates') return { templates };
    if (route === '/api/mail/preview') {
      return {
        subject: 'Coverage — Katalon Ruby', text: 'Coverage is now 63.3%.',
        to: ['client@example.com'], cc: [], attachmentName: 'Overall Coverage.pdf',
        warnings: [], unknown: [],
      };
    }
    return { ok: true, templates };
  });

  vm.runInContext(`${fs.readFileSync(path.join(PUBLIC, 'mail-drawer.js'), 'utf8')}\n;globalThis.__v = MailDrawer;`, ctx);

  return {
    ctx, drawn, toasts, el,
    html: () => drawn[drawn.length - 1] || '',
    /** Open the panel the way an Email the report button does. */
    async open(over = {}) {
      await ctx.__v.open({
        report: 'coverage', title: 'Send Overall Coverage', team: 'ruby',
        scope: { components: [] }, scopeLabel: 'All components', ...over,
      });
    },
    click: (what) => el(`mail:${what}`).fire('click'),
    type: (id, value) => { el(id).value = value; return el(id).fire('input'); },
  };
}

/* The view keeps its mail helpers private. Exposing ONE entry point for the
   panel is the smallest hole that makes it drivable — the alternative is
   re-rendering the whole Coverage page in this harness to reach a button. */
const SAVED = {
  id: 'mt1', name: 'Weekly client report',
  subject: 'Coverage — {{team}}', body: 'Coverage is now {{coverage}}.',
  to: ['client@example.com', 'second@example.com'], cc: ['pm@example.com'],
  attachPdf: true, landscape: true, report: 'coverage',
};

/** The same panel, opened from the Active Sprint screen. */
const SPRINT_TPL = {
  id: 'mt2', name: 'Weekly sprint update',
  subject: '{{sprint}} — {{donepct}} done', body: '{{done}} of {{committed}} points.',
  to: ['client@example.com'], cc: [],
  attachPdf: true, landscape: true, report: 'sprint',
};
const AS_SPRINT = {
  report: 'sprint', title: 'Send Active Sprint',
  scope: { sprint: 'S41' }, scopeNarrow: true, scopeLabel: 'PSA Sprint 41',
};

/**
 * THE TEMPLATE DROPDOWN'S OPTIONS, and nothing else on the panel.
 *
 * Written after a check that simply searched the html for a template's name
 * reported a leak that was not there: it had matched the "Weekly client
 * report" HINT in the empty name box. A substring search over a whole screen
 * finds whatever else happens to say the same words, and it fails in the
 * direction that costs most — a green run, or an afternoon chasing a bug that
 * does not exist. (It did earn its keep: those hints were all written for the
 * coverage report and were being shown on the sprint panel.)
 */
const options = (html) => [...String(html).matchAll(/<option value="[^"]+"[^>]*>([^<]+)<\/option>/g)]
  .map(m => m[1]).filter(n => n !== '— new template —');

/* ── the checks ───────────────────────────────────────────────────────── */

check('THE PANEL OPENS WITH A SAVED TEMPLATE IN IT', async () => {
  const b = boot({ templates: [SAVED] });
  await b.open();
  const h = b.html();
  assert.match(h, /Send Overall Coverage/, 'the panel did not draw');
  assert.match(h, /client@example\.com, second@example\.com/,
    'the saved recipients are not in the To field');
  assert.match(h, /pm@example\.com/, 'the Cc list is missing');
});

check('PREVIEW DOES NOT KILL THE PANEL — the array/string bug', async () => {
  /* THE REGRESSION. A saved template carries `to` as an array; `readForm()`
     puts the text box's STRING back into the panel's state, and the redraw
     that follows Preview called `.join` on it. The drawer threw, the preview
     never appeared, and Send stays disabled until a preview appears — so the
     feature was unreachable, not merely ugly. */
  const b = boot({ templates: [SAVED] });
  await b.open();
  b.el('mtTo').value = 'client@example.com, second@example.com';
  b.el('mtSubject').value = 'Coverage — {{team}}';
  b.el('mtBody').value = 'Coverage is now {{coverage}}.';

  await b.click('preview');
  const h = b.html();
  assert.match(h, /What they will read/, `the preview never rendered — last drawer was: ${h.slice(0, 120)}`);
  assert.match(h, /Coverage is now 63\.3%/, 'the previewed body is missing');
  assert.match(h, /client@example\.com/, 'the To field lost its value on the redraw');
});

check('AND A STRING OR AN ARRAY BOTH RENDER', async () => {
  /* Stated directly, because the fix is one function and this is what it
     guarantees. Both shapes are legitimate — one comes from the server, one
     from a text box — so the render has to take either. */
  const b = boot({ templates: [SAVED] });
  await b.open();
  for (const shape of [['a@b.com', 'c@d.com'], 'a@b.com, c@d.com', null, undefined, '']) {
    assert.doesNotThrow(() => b.ctx.__v.__fieldText(shape), `${JSON.stringify(shape)} threw`);
  }
  assert.strictEqual(b.ctx.__v.__fieldText(['a@b.com', 'c@d.com']), 'a@b.com, c@d.com');
  assert.strictEqual(b.ctx.__v.__fieldText('a@b.com, c@d.com'), 'a@b.com, c@d.com');
  assert.strictEqual(b.ctx.__v.__fieldText(null), '');
});

check('SEND IS DISABLED UNTIL A PREVIEW HAS BEEN READ', async () => {
  /* The one control whose output cannot be taken back. It must not be
     reachable from wording nobody has looked at. */
  const b = boot({ templates: [SAVED] });
  await b.open();
  assert.match(b.html(), /data-mail="send" disabled/, 'Send was live before any preview');

  b.el('mtTo').value = 'client@example.com';
  await b.click('preview');
  assert.ok(!/data-mail="send" disabled/.test(b.html()), 'Send stayed disabled after a preview');
});

check('AND AN EDIT AFTER THE PREVIEW DISABLES IT AGAIN', async () => {
  /* Otherwise he previews, tweaks the subject, and sends wording nobody
     read — the exact failure the gate exists to prevent, one keystroke
     later. */
  const b = boot({ templates: [SAVED] });
  await b.open();
  b.el('mtTo').value = 'client@example.com';
  await b.click('preview');
  assert.ok(!/data-mail="send" disabled/.test(b.html()), 'fixture check: previewed');

  await b.type('mtSubject', 'Something else entirely');
  assert.match(b.html(), /data-mail="send" disabled/,
    'the subject changed after the preview and Send stayed live');
});

check('WITH NO MAIL SET UP IT EXPLAINS ITSELF instead of offering a dead button', async () => {
  const b = boot({ templates: [], cfg: { configured: false, chrome: true, fields: [] } });
  await b.open();
  const h = b.html();
  assert.match(h, /not set up/i);
  /* THE LINK, not the prose. Wording can be rewritten and the panel still
     works; a panel with no way to reach the settings screen is a dead end,
     and that is the property worth pinning. */
  assert.match(h, /href="#settings"/, 'there is no way from here to the settings screen');
  assert.match(h, /apppasswords/, 'nor how to get the password it needs');
  assert.ok(!/data-mail="send"/.test(h), 'a Send button was offered with no way to send');
});

check('AND A MISSING CHROME IS SAID OUT LOUD', async () => {
  /* Chrome renders the PDF. Without it the send refuses — better to know
     before writing the email than after. */
  const b = boot({ templates: [SAVED], cfg: { configured: true, host: 'x', from: 'a@b.com', chrome: false, fields: [] } });
  await b.open();
  assert.match(b.html(), /Chrome not found/, 'nothing warns that the PDF cannot be rendered');
});

check('A SPRINT TEMPLATE IS NOT OFFERED ON THE COVERAGE SCREEN', async () => {
  /* One template store, two screens. Without the filter the coverage page
     lists "Weekly sprint update" in its dropdown — pickable, and refused only
     at send time, after he has written the recipients. A template that cannot
     be sent from here must not be offered here. */
  const b = boot({ templates: [SAVED, SPRINT_TPL] });
  await b.open();
  assert.deepStrictEqual(options(b.html()), ['Weekly client report'],
    'the coverage screen offered the wrong set of templates');
});

check('AND THE COVERAGE ONE IS NOT OFFERED ON THE SPRINT SCREEN', async () => {
  const b = boot({ templates: [SAVED, SPRINT_TPL] });
  await b.open(AS_SPRINT);
  assert.deepStrictEqual(options(b.html()), ['Weekly sprint update'],
    'the sprint screen offered the wrong set of templates');
  assert.match(b.html(), /Send Active Sprint/, 'the panel still calls itself the coverage report');
});

check('THE SCOPE CHIP SAYS WHAT THIS MAIL IS ABOUT', async () => {
  /* The scope lives on the screen BEHIND the drawer and is invisible from
     inside it. A sprint report sent for the wrong sprint, or a coverage
     report sent wide because two chips were still active, are the same
     mistake — and this line is what prevents both. */
  const cov = boot({ templates: [SAVED] });
  await cov.open({ scope: { components: ['PS_A', 'PS_B'] }, scopeNarrow: true, scopeLabel: 'Scoped to PS_A + PS_B' });
  assert.match(cov.html(), /Scoped to PS_A \+ PS_B/, 'the coverage scope is not stated');

  const sp = boot({ templates: [SPRINT_TPL] });
  await sp.open(AS_SPRINT);
  assert.match(sp.html(), /PSA Sprint 41/, 'the sprint being reported on is not stated');
});

check('THE FILE-NAME PLACEHOLDER IS THE REPORT\'S OWN DEFAULT', async () => {
  /* Each report names its attachment differently, and the box shows that as
     its placeholder — so the drawer must not carry one hardcoded default for
     both. A sprint mail arriving as "Automation Delivery Dashboard.pdf" is
     the mismatch this whole split exists to stop. */
  const b = boot({ templates: [SPRINT_TPL] });
  await b.open(AS_SPRINT);
  const h = b.html();
  assert.match(h, /Sprint Report - \{\{sprint\}\} - \{\{date\}\}/,
    'the sprint panel offers the coverage filename as its default');
  assert.ok(!/Automation Delivery Dashboard/.test(h),
    'the coverage default leaked onto the sprint panel');
});

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
