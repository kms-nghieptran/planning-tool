'use strict';
/**
 * auth-view.test.js — the two screens.
 *
 * The server is what refuses things; these screens only stop people walking
 * into a wall. So the checks here are about LEGIBILITY, not security: that the
 * door appears when it should and not when it should not, that a lead can see
 * which teams they lead, and that the one genuinely dangerous control — making
 * somebody a lead — cannot be used without saying of what.
 *
 * The one real security property asserted here is negative: a password must
 * never be rendered into the page, and the setup token must not survive in the
 * URL after it is spent.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let passed = 0, failed = 0;
const pending = [];
const check = (name, fn) => pending.push({ name, fn });

const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'public', p), 'utf8');

/* ── a browser, just enough of one ───────────────────────────────────── */

function makeEl(tag = 'div') {
  const el = {
    tagName: tag, dataset: {}, style: {}, hidden: false, value: '', checked: false,
    textContent: '', _html: '', children: [],
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined ? this._s.has(c) : !on) this._s.delete(c); else this._s.add(c); },
      contains(c) { return this._s.has(c); } },
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    /* HANDLERS ARE KEPT, not swallowed. A no-op addEventListener makes every
       check on behaviour vacuous — the markup is right and nothing is ever
       proven to DO anything. */
    _on: {},
    addEventListener(t, fn) { (this._on[t] = this._on[t] || []).push(fn); },
    fire(t, target) { for (const fn of (this._on[t] || []).slice()) fn({ target, preventDefault() {} }); },
    removeEventListener() {}, setAttribute() {}, appendChild() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {},
  };
  return el;
}

function context({ hash = '', search = '' } = {}) {
  const els = new Map();
  const get = (id) => {
    if (!els.has(id)) els.set(id, makeEl());
    return els.get(id);
  };
  const ctx = {
    console, Promise, setTimeout, clearTimeout, URLSearchParams, JSON, Math, Date, Set, Map, Array, Object, String, Number,
    location: { hash, search, pathname: '/', reload() { ctx.__reloaded = true; } },
    history: { replaceState(...a) { ctx.__replaced = a; } },
    document: {
      getElementById: (id) => (els.has(id) ? els.get(id) : null),
      querySelector: (sel) => (sel === '.shell' ? get('__shell') : null),
      createElement: () => makeEl(),
      body: makeEl('body'),
    },
    __els: els, __ensure: get,
  };
  ctx.UI = {
    esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    $: (sel) => null, $$: () => [],
    avatar: (n) => `<i>${n}</i>`, int: (n) => String(n), num: (n) => String(n),
    dateTime: (d) => String(d),
    api: async () => ({ users: [] }),
    jsonPost: async () => ({ ok: true }), jsonPut: async () => ({ ok: true }), jsonDelete: async () => ({ ok: true }),
    drawer(h) { ctx.__drawn = h; }, closeDrawer() {}, toast(m) { ctx.__toast = m; },
  };
  ctx.App = { state: { actor: null }, refresh() {} };
  vm.createContext(ctx);
  return ctx;
}

function loadLogin(opts) {
  const ctx = context(opts);
  // The gate and the shell have to exist before render() looks for them.
  ctx.__ensure('authGate');
  const shell = ctx.__ensure('__shell');
  vm.runInContext(`${read('views/login.js')}\n;globalThis.LoginView = LoginView;`, ctx);
  return { ctx, shell, gate: ctx.__ensure('authGate') };
}

const html = (ctx) => ctx.__ensure('authGate').innerHTML;

/* ── which door ──────────────────────────────────────────────────────── */

check('SIGNED IN AND NOTHING OWED — no door at all, and the shell stays up', () => {
  const { ctx, shell, gate } = loadLogin();
  /* The gate starts HIDDEN, as the markup has it, so "it stayed hidden" is a
     real observation rather than a comparison against the default. */
  gate.hidden = true;
  const blocked = ctx.LoginView.render({ enabled: true, needsSetup: false, signedIn: true, actor: { role: 'member' } });
  assert.strictEqual(blocked, false, 'the app was blocked for somebody already signed in');
  assert.strictEqual(shell.hidden, false, 'the shell was hidden anyway');
  assert.strictEqual(gate.hidden, true, 'the door was rendered over an app the person may already use');
  assert.strictEqual(gate.innerHTML, '', 'the gate was filled in even though it is not shown');
});

check('NOT SIGNED IN — the sign-in form, and the shell is hidden', () => {
  /* Hidden, not merely covered. A login form rendered over a live shell leaves
     the nav and the team picker reachable by keyboard behind it. */
  const { ctx, shell } = loadLogin();
  const blocked = ctx.LoginView.render({ enabled: true, needsSetup: false, signedIn: false });
  assert.strictEqual(blocked, true, 'the app booted for somebody not signed in');
  assert.strictEqual(shell.hidden, true, 'the shell was left visible behind the login form');
  assert.match(html(ctx), /Sign in/);
  assert.match(html(ctx), /id="email"/);
  assert.match(html(ctx), /type="password"/);
});

check('FIRST RUN WITH A TOKEN IN THE URL — the setup form', () => {
  const { ctx } = loadLogin({ hash: '#setup?token=abc123' });
  assert.strictEqual(ctx.LoginView.setupToken(), 'abc123', 'the token was not read out of the hash');
  ctx.LoginView.render({ enabled: true, needsSetup: true, signedIn: false });
  assert.match(html(ctx), /Create the first account/);
  assert.match(html(ctx), /id="confirm"/, 'setup does not ask for the password twice');
});

check('FIRST RUN WITHOUT A TOKEN — instructions, and NO form to submit', () => {
  /* The failure this prevents is a setup form that posts an empty token and
     reports a server error, which reads as "the tool is broken" rather than
     "you need the link from the console". */
  const { ctx } = loadLogin({ hash: '' });
  ctx.LoginView.render({ enabled: true, needsSetup: true, signedIn: false });
  assert.match(html(ctx), /no accounts yet/i);
  assert.ok(!/id="authForm"/.test(html(ctx)), 'it offered a form with no token to submit');
});

check('A TEMPORARY PASSWORD FORCES A CHANGE BEFORE THE APP OPENS', () => {
  const { ctx } = loadLogin();
  const blocked = ctx.LoginView.render({
    enabled: true, needsSetup: false, signedIn: true,
    actor: { role: 'member', mustChangePassword: true },
  });
  assert.strictEqual(blocked, true, 'somebody with a temporary password got straight into the app');
  assert.match(html(ctx), /Choose a new password/);
  assert.match(html(ctx), /id="current"/, 'it does not ask for the password they were given');
});

check('the token is read from the HASH, not the query — the hash is the router\'s', () => {
  // `?token=` on the query would collide with print mode's own parameters.
  const { ctx } = loadLogin({ hash: '#setup?token=from-hash', search: '?token=from-query' });
  assert.strictEqual(ctx.LoginView.setupToken(), 'from-hash');
});

check('a malformed hash does not throw — it just means no token', () => {
  for (const hash of ['', '#', '#setup', '#setup?', '#?token=']) {
    const { ctx } = loadLogin({ hash });
    assert.doesNotThrow(() => ctx.LoginView.setupToken(), `threw on ${JSON.stringify(hash)}`);
  }
});

/* ── what must never be in the page ──────────────────────────────────── */

check('NO PASSWORD IS EVER RENDERED INTO THE MARKUP', () => {
  /* Values are read from the live inputs at submit time, never interpolated
     into the template. A `value="${...}"` here would put the password in the
     DOM, in any screenshot of it, and in the browser's view-source. */
  const src = read('views/login.js');
  assert.ok(!/value="\$\{[^}]*password/i.test(src), 'a password is interpolated into the markup');
  const { ctx } = loadLogin();
  ctx.LoginView.render({ enabled: true, needsSetup: false, signedIn: false });
  assert.ok(!/value="/.test(html(ctx)), 'the form renders prefilled values');
});

check('SPENDING THE SETUP TOKEN CLEARS IT FROM THE URL', () => {
  /* It is single-use. Leaving it in the address bar means a refresh retries a
     dead token and shows an error that looks like the account was not created
     — the one moment the user has no way to tell. */
  const src = read('views/login.js');
  assert.match(src, /history\.replaceState/, 'the setup flow never clears the token from the URL');
});

/* ── the Users screen ────────────────────────────────────────────────── */

/* ── the Users screen ────────────────────────────────────────────────
 *
 * THE HARNESS MODELS THE DRAWER AS A SEPARATE SUBTREE, because it is one.
 * `UI.drawer` writes into `#drawerBody`, which sits beside the view's mount
 * rather than inside it — so a delegated listener on the mount never sees a
 * click in the drawer.
 *
 * The previous harness fired synthetic clicks straight at the mount with a
 * hand-made target, which made that distinction invisible: the checks passed
 * against a version of the screen whose Create button did nothing at all. A
 * test that cannot tell those two apart is not testing the thing it names.
 */

/** A stub element parsed out of a template string — enough to click and read. */
function stub(tag, attrs) {
  return {
    tagName: tag, dataset: attrs.dataset || {}, id: attrs.id || '', type: attrs.type || '',
    value: attrs.value || '', checked: !!attrs.checked, disabled: false,
    textContent: attrs.text || '', hidden: false, _on: {},
    addEventListener(t, fn) { (this._on[t] = this._on[t] || []).push(fn); },
    focus() {},
    click() { for (const fn of (this._on.click || []).slice()) fn({ preventDefault() {} }); },
    key(k) { for (const fn of (this._on.keydown || []).slice()) fn({ key: k, preventDefault() {} }); },
    querySelector: () => null, querySelectorAll: () => [],
  };
}

/** The drawer: its innerHTML setter builds stubs the way a browser would. */
function drawerEl() {
  const el = {
    id: 'drawerBody', _html: '', kids: [],
    set innerHTML(v) {
      this._html = String(v);
      this.kids = [];
      // [data-act] controls
      for (const m of this._html.matchAll(/<(button|a)\b[^>]*data-act="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
        this.kids.push(stub(m[1], { dataset: { act: m[2] }, text: m[3].replace(/<[^>]*>/g, '').trim() }));
      }
      // inputs, by id / name / type
      for (const m of this._html.matchAll(/<input\b([^>]*)>/g)) {
        const a = m[1];
        const get = (k) => (new RegExp(`${k}="([^"]*)"`).exec(a) || [, ''])[1];
        this.kids.push(stub('input', {
          id: get('id'), type: get('type') || 'text', value: get('value'),
          checked: /\bchecked\b/.test(a),
          dataset: { team: get('data-team'), name: get('name') },
        }));
      }
      // error boxes
      for (const m of this._html.matchAll(/<div\b[^>]*id="([^"]*Error)"[^>]*>/g)) {
        const box = stub('div', { id: m[1] });
        box.hidden = true;
        this.kids.push(box);
      }
      for (const m of this._html.matchAll(/<div\b[^>]*class="role-teams"[^>]*id="(roleTeams)"[^>]*>/g)) {
        this.kids.push(stub('div', { id: m[1] }));
      }
      if (/id="roleTeams"/.test(this._html) && !this.kids.some(k => k.id === 'roleTeams')) {
        this.kids.push(stub('div', { id: 'roleTeams' }));
      }
    },
    get innerHTML() { return this._html; },
    querySelectorAll(sel) {
      if (sel === '[data-act]') return this.kids.filter(k => k.dataset.act);
      if (sel === 'input') return this.kids.filter(k => k.tagName === 'input');
      if (sel === 'input[name="role"]') return this.kids.filter(k => k.dataset.name === 'role');
      if (sel.includes('#roleTeams input')) return this.kids.filter(k => k.dataset.team);
      return [];
    },
    querySelector(sel) {
      if (sel.startsWith('#')) return this.kids.find(k => k.id === sel.slice(1)) || null;
      if (sel === '[data-act^="save-"]') return this.kids.find(k => (k.dataset.act || '').startsWith('save-')) || null;
      if (sel.startsWith('input')) return this.kids.find(k => k.tagName === 'input') || null;
      return null;
    },
    /** Click a drawer control by its data-act — the whole point of this file. */
    press(act) {
      const b = this.kids.find(k => k.dataset.act === act);
      assert.ok(b, `the drawer has no "${act}" control`);
      b.click();
      return b;
    },
    field(id) { return this.kids.find(k => k.id === id); },
  };
  el.innerHTML = '';
  return el;
}

function loadUsers(users, teams, opts = {}) {
  const ctx = context();
  const drawer = drawerEl();
  ctx.__els.set('drawerBody', drawer);
  ctx.UI.api = async () => ({ users });
  ctx.UI.drawer = (h) => { drawer.innerHTML = h; };
  ctx.UI.closeDrawer = () => { ctx.__closed = true; };
  if (opts.ui) Object.assign(ctx.UI, opts.ui);
  const mount = makeEl();
  vm.runInContext(`${read('views/users.js')}\n;globalThis.UsersView = UsersView;`, ctx);
  return { ctx, mount, drawer, run: () => ctx.UsersView.render({ teams }, mount) };
}

const USERS = [
  { id: 'a', email: 'admin@kms-technology.com', name: 'Admin', status: 'active', role: 'project-admin', leadTeams: [], roles: [], hasPassword: true, sessions: 1 },
  { id: 'r', email: 'ruby@kms-technology.com', name: 'Ruby Lead', status: 'active', role: 'lead', leadTeams: ['ruby'], roles: [], hasPassword: true, sessions: 0 },
  { id: 'm', email: 'member@kms-technology.com', name: 'Member', status: 'active', role: 'member', leadTeams: [], roles: [], hasPassword: true, sessions: 0 },
];
const TEAMS = [{ id: 'ruby', name: 'Katalon RDA' }, { id: 'titan', name: 'Katalon PSA' }];

/** Open a drawer by pressing one of the TABLE's buttons, as a person would. */
function openDrawer(mount, act, id) {
  const btn = makeEl('button');
  btn.dataset = { act, id };
  mount.fire('click', { closest: (sel) => (sel === '[data-act]' ? btn : null) });
}

check('ADDING AN ACCOUNT ACTUALLY POSTS — the Create button is wired', async () => {
  /* THE BUG THIS FILE NOW CATCHES. "Add an account" opened a drawer whose
     Create button did nothing: the handler was delegated on the view's mount,
     and the drawer is not in the mount. Markup right, handler right, two
     different subtrees — and every previous check passed because the harness
     fired clicks at the mount directly. */
  let posted = null;
  const { run, mount, drawer } = loadUsers(USERS, TEAMS, {
    ui: { jsonPost: async (path, body) => { posted = { path, body }; return { ok: true }; } },
  });
  await run();

  openDrawer(mount, 'add');
  assert.match(drawer.innerHTML, /Add an account/, 'the drawer did not open');

  drawer.field('newEmail').value = 'new@kms-technology.com';
  drawer.field('newName').value = 'New Person';
  drawer.field('newPw').value = 'a-long-enough-passphrase-42';
  drawer.press('save-new');
  await new Promise(r => setTimeout(r, 0));

  assert.ok(posted, 'pressing Create sent nothing to the server');
  assert.strictEqual(posted.path, '/api/users');
  assert.strictEqual(posted.body.email, 'new@kms-technology.com');
  assert.strictEqual(posted.body.password, 'a-long-enough-passphrase-42');
  assert.strictEqual(posted.body.role, 'member', 'the default role is not member');
});

check('and so are Save role and Set password', async () => {
  // The same wiring bug, on the two drawers nobody would notice as quickly.
  let put = null;
  const ui = { jsonPut: async (path, body) => { put = { path, body }; return { ok: true }; } };

  const a = loadUsers(USERS, TEAMS, { ui });
  await a.run();
  openDrawer(a.mount, 'edit', 'm');
  a.drawer.press('save-role');
  await new Promise(r => setTimeout(r, 0));
  assert.ok(put, 'Save role sent nothing');
  assert.strictEqual(put.path, '/api/users/roles');

  put = null;
  const b = loadUsers(USERS, TEAMS, { ui });
  await b.run();
  openDrawer(b.mount, 'pw', 'm');
  b.drawer.field('newPw').value = 'another-long-passphrase-7';
  b.drawer.press('save-pw');
  await new Promise(r => setTimeout(r, 0));
  assert.ok(put, 'Set password sent nothing');
  assert.strictEqual(put.path, '/api/users/password');
  assert.strictEqual(put.body.mustChange, true, 'an admin-set password does not force a change');
});

check('EVERY CONTROL THE DRAWER RENDERS IS BOUND — none is decoration', async () => {
  /* Generalises the bug rather than pinning one instance of it: whatever the
     drawer draws, pressing it must reach something. */
  const { run, mount, drawer, ctx } = loadUsers(USERS, TEAMS);
  await run();
  for (const [act, id] of [['add', null], ['edit', 'm'], ['pw', 'm']]) {
    openDrawer(mount, act, id);
    const controls = drawer.querySelectorAll('[data-act]');
    assert.ok(controls.length, `the ${act} drawer renders no controls`);
    for (const c of controls) {
      assert.ok((c._on.click || []).length, `"${c.dataset.act}" in the ${act} drawer is not wired to anything`);
    }
  }
  // Cancel really closes.
  openDrawer(mount, 'add');
  ctx.__closed = false;
  drawer.press('close-drawer');
  assert.strictEqual(ctx.__closed, true, 'Cancel does not close the drawer');
});

check('A LEAD WITH NO TEAM PICKED IS REFUSED BEFORE THE REQUEST IS SENT', async () => {
  /* The server refuses it too — this is so the person is told immediately
     rather than after a round trip, and so no half-made account appears. */
  let posted = false;
  const { run, mount, drawer } = loadUsers(USERS, TEAMS, {
    ui: { jsonPost: async () => { posted = true; return { ok: true }; } },
  });
  await run();
  openDrawer(mount, 'add');
  drawer.field('newEmail').value = 'lead@kms-technology.com';
  drawer.field('newPw').value = 'a-long-enough-passphrase-42';
  for (const r of drawer.querySelectorAll('input[name="role"]')) r.checked = (r.value === 'lead');
  drawer.press('save-new');
  await new Promise(r => setTimeout(r, 0));
  assert.strictEqual(posted, false, 'it posted a lead with no teams');
  assert.match(drawer.field('addError').textContent, /at least one team/);
  assert.strictEqual(drawer.field('addError').hidden, false, 'the message was written but not shown');
});

check('ENTER SUBMITS, because three boxes and a button is a form', async () => {
  let posted = false;
  const { run, mount, drawer } = loadUsers(USERS, TEAMS, {
    ui: { jsonPost: async () => { posted = true; return { ok: true }; } },
  });
  await run();
  openDrawer(mount, 'add');
  drawer.field('newEmail').value = 'new@kms-technology.com';
  drawer.field('newPw').value = 'a-long-enough-passphrase-42';
  drawer.field('newEmail').key('Enter');
  await new Promise(r => setTimeout(r, 0));
  assert.strictEqual(posted, true, 'pressing Enter in the form did nothing');
});

check('THE SERVER\'S REFUSAL IS WHAT THE USER READS, word for word', async () => {
  /* "That is the only project admin left — demoting them would leave nobody
     able to manage accounts" explains itself and says what to do. "Could not
     save" does neither, and sends the reader to whoever wrote the tool. */
  const REFUSAL = 'That is the only project admin left — demoting them would lock everyone out.';
  const { run, mount, drawer } = loadUsers(USERS, TEAMS, {
    ui: { jsonPut: async () => { throw new Error(REFUSAL); } },
  });
  await run();
  openDrawer(mount, 'edit', 'a');
  drawer.press('save-role');
  await new Promise(r => setTimeout(r, 0));
  assert.strictEqual(drawer.field('roleError').textContent, REFUSAL,
    `the screen showed "${drawer.field('roleError').textContent}" instead of what the server said`);
  assert.strictEqual(drawer.field('roleError').hidden, false, 'the message was written but never shown');
});

check('a refused save leaves the drawer OPEN, so the typing is not lost', async () => {
  /* Closing on failure throws away what they entered and shows the error on a
     screen that no longer has the form it belongs to. */
  const { run, mount, drawer, ctx } = loadUsers(USERS, TEAMS, {
    ui: { jsonPut: async () => { throw new Error('nope'); } },
  });
  await run();
  openDrawer(mount, 'edit', 'm');
  ctx.__closed = false;
  drawer.press('save-role');
  await new Promise(r => setTimeout(r, 0));
  assert.strictEqual(ctx.__closed, false, 'a failed save closed the drawer');
  const btn = drawer.kids.find(k => k.dataset.act === 'save-role');
  assert.strictEqual(btn.disabled, false, 'the button was left disabled after a failure');
});

check('A LEAD\'S ROW NAMES THE TEAMS THEY LEAD, not just the word "lead"', async () => {
  const { run, mount } = loadUsers(USERS, TEAMS);
  await run();
  const body = mount.innerHTML;
  assert.match(body, /Team lead/);
  assert.match(body, /Katalon RDA/, "the lead's team is not on their row");
});

check('A LEAD WITH NO TEAMS IS FLAGGED, because that account can do nothing', async () => {
  const { run, mount } = loadUsers([{ ...USERS[1], leadTeams: [] }], TEAMS);
  await run();
  assert.match(mount.innerHTML, /no teams/, 'a lead of nothing looks like a working lead');
});

check('A SINGLE PROJECT ADMIN IS CALLED OUT', async () => {
  const { run, mount } = loadUsers(USERS, TEAMS);
  await run();
  assert.match(mount.innerHTML, /one project admin/i);
});

check('and two admins get no warning', async () => {
  const two = [...USERS, { ...USERS[0], id: 'a2', email: 'a2@kms-technology.com', name: 'Second' }];
  const { run, mount } = loadUsers(two, TEAMS);
  await run();
  assert.ok(!/one project admin/i.test(mount.innerHTML), 'it warns when there is no problem');
});

check('EVERY TEAM IS OFFERED when choosing a lead\'s scope', async () => {
  const { run, mount, drawer } = loadUsers(USERS, TEAMS);
  await run();
  openDrawer(mount, 'edit', 'm');
  const boxes = drawer.querySelectorAll('#roleTeams input');
  assert.deepStrictEqual(boxes.map(b => b.dataset.team).sort(), ['ruby', 'titan'],
    'the team picker does not offer every team');
});

check('THE DISABLED STATE IS VISIBLE, not just absent', async () => {
  const { run, mount } = loadUsers([{ ...USERS[2], status: 'disabled' }], TEAMS);
  await run();
  assert.match(mount.innerHTML, /disabled/);
  assert.match(mount.innerHTML, /Enable/, 'a disabled account offers no way back');
});

check('A PASSWORD HASH IS NEVER SHOWN', async () => {
  const { run, mount } = loadUsers(USERS, TEAMS);
  await run();
  assert.ok(!/scrypt/.test(mount.innerHTML));
});

/* ── run ─────────────────────────────────────────────────────────────── */

(async () => {
  for (const { name, fn } of pending) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (err) {
      failed++; console.log(`FAIL  ${name}\n      ${err.message}`);
    }
  }
  console.log(`\nauth-view.test.js: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
