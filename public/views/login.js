/* global UI */
/**
 * login.js — the door.
 *
 * NOT A ROUTE. Every other screen in this app renders into the shell, beside a
 * nav and a team picker that assume `/api/state` came back. Before sign-in it
 * has not, so there is no team list, no sprint, no anything — and a login form
 * rendered into that shell is a login form surrounded by the furniture of an
 * app the reader cannot use yet. This replaces the shell instead.
 *
 * THREE SCREENS, ONE FILE, because they are one flow and the differences are
 * small: first-run setup, ordinary sign-in, and the forced password change that
 * follows an admin resetting somebody's password. Keeping them apart would mean
 * three copies of the same form and three places for the error handling to
 * drift.
 */
const LoginView = (() => {
  const esc = (s) => UI.esc(s == null ? '' : s);

  /** The token the server printed to the console, if this is a setup link. */
  function setupToken() {
    try {
      const hash = String(location.hash || '');
      const at = hash.indexOf('?');
      if (at < 0) return null;
      return new URLSearchParams(hash.slice(at + 1)).get('token');
    } catch (_) { return null; }
  }

  const frame = (title, sub, inner, note) => `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-brand">
          <img class="mark" src="kms/kms-mark-blue.svg" alt="KMS Technology" width="30" height="30">
          <div>
            <div class="eyebrow"><i></i>KMS · Automation</div>
            <h1>Planning Tool</h1>
          </div>
        </div>
        <h2>${esc(title)}</h2>
        ${sub ? `<p class="auth-sub">${sub}</p>` : ''}
        ${inner}
        <div class="auth-error" id="authError" hidden></div>
        ${note ? `<p class="auth-note">${note}</p>` : ''}
      </div>
    </div>`;

  const field = (id, label, type, opts = {}) => `
    <label class="auth-field">
      <span>${esc(label)}</span>
      <input id="${id}" type="${type}" ${opts.autocomplete ? `autocomplete="${opts.autocomplete}"` : ''}
        ${opts.autofocus ? 'autofocus' : ''} ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ''}>
    </label>`;

  /* ── the three screens ─────────────────────────────────────────────── */

  const signIn = () => frame(
    'Sign in',
    'Use the email and password your project admin set up for you.',
    `<form id="authForm" novalidate>
      ${field('email', 'Email', 'email', { autocomplete: 'username', autofocus: true })}
      ${field('password', 'Password', 'password', { autocomplete: 'current-password' })}
      <button class="btn" type="submit" id="authGo">Sign in</button>
    </form>`,
    'Forgotten it? A project admin can set you a new one — there is no self-service reset.',
  );

  const setup = () => frame(
    'Create the first account',
    'This install has no accounts yet. The link you followed works once, and makes you the project admin.',
    `<form id="authForm" novalidate>
      ${field('name', 'Your name', 'text', { autofocus: true })}
      ${field('email', 'Email', 'email', { autocomplete: 'username' })}
      ${field('password', 'Password', 'password', { autocomplete: 'new-password', placeholder: 'At least 12 characters' })}
      ${field('confirm', 'Password again', 'password', { autocomplete: 'new-password' })}
      <button class="btn" type="submit" id="authGo">Create account</button>
    </form>`,
    /* Said here because it is the one thing a reader cannot discover: the
       token is single-use AND short-lived, so a failed attempt they come back
       to tomorrow needs a restart, not a retry. */
    'Lost the link, or left it too long? Restart the server — it prints a fresh one while there are no accounts.',
  );

  const needSetupNoToken = () => frame(
    'This tool has no accounts yet',
    'The server prints a one-time setup link when it starts. Open that link to create the first project admin.',
    `<pre class="auth-pre">node server.js</pre>`,
    'Only whoever can read the server\'s console can create the first account — which is the point.',
  );

  const mustChange = () => frame(
    'Choose a new password',
    'Your password was set by an admin, so it has to be replaced before you can go on.',
    `<form id="authForm" novalidate>
      ${field('current', 'The password you were given', 'password', { autocomplete: 'current-password', autofocus: true })}
      ${field('password', 'New password', 'password', { autocomplete: 'new-password', placeholder: 'At least 12 characters' })}
      ${field('confirm', 'New password again', 'password', { autocomplete: 'new-password' })}
      <button class="btn" type="submit" id="authGo">Save and continue</button>
    </form>`,
    'Changing it signs out every other session on your account.',
  );

  /* ── wiring ────────────────────────────────────────────────────────── */

  const val = (id) => {
    const el = document.getElementById(id);
    return el ? el.value : '';
  };

  function fail(message) {
    const box = document.getElementById('authError');
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
  }

  /**
   * Submit, with the button locked while it is in flight.
   *
   * Not politeness: the login route is rate limited per account, and a
   * double-click that fires two requests spends two of five free attempts on
   * one sign-in. Two mistyped passwords then lock the person out.
   */
  function onSubmit(handler) {
    const form = document.getElementById('authForm');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const go = document.getElementById('authGo');
      const box = document.getElementById('authError');
      if (box) box.hidden = true;
      if (go) { go.disabled = true; go.textContent = 'Working…'; }
      try {
        await handler();
        location.reload();
      } catch (err) {
        fail(err.message || 'That did not work.');
        if (go) { go.disabled = false; go.textContent = go.dataset.label || 'Try again'; }
      }
    });
    const go = document.getElementById('authGo');
    if (go) go.dataset.label = go.textContent;
  }

  const bothMatch = () => {
    if (val('password') !== val('confirm')) throw new Error('The two passwords do not match.');
  };

  /**
   * Render whichever door applies, and return true if the app must not boot.
   *
   * `status` is `/api/auth/status`, which is reachable before sign-in and says
   * only three things: whether auth is on, whether this install still needs
   * setting up, and whether this caller is signed in. Deliberately nothing
   * else — not how many accounts exist, not whether an address is one of them.
   */
  function render(status) {
    const gate = document.getElementById('authGate');
    const shell = document.querySelector('.shell');
    if (!gate || !shell) return false;

    const token = setupToken();
    let html = null;
    let submit = null;

    if (status.needsSetup && token) {
      html = setup();
      submit = async () => {
        bothMatch();
        await UI.jsonPost('/api/auth/setup', {
          token, name: val('name'), email: val('email'), password: val('password'),
        });
        // The token is spent; drop it from the URL so a refresh does not retry it.
        try { history.replaceState(null, '', location.pathname); } catch (_) { /* fine */ }
      };
    } else if (status.needsSetup) {
      html = needSetupNoToken();
    } else if (!status.signedIn) {
      html = signIn();
      submit = () => UI.jsonPost('/api/auth/login', { email: val('email'), password: val('password') });
    } else if (status.actor && status.actor.mustChangePassword) {
      html = mustChange();
      submit = async () => {
        bothMatch();
        await UI.jsonPost('/api/auth/password', { current: val('current'), password: val('password') });
      };
    } else {
      return false;   // signed in and nothing owed — boot the app
    }

    shell.hidden = true;
    gate.hidden = false;
    gate.innerHTML = html;
    if (submit) onSubmit(submit);
    return true;
  }

  return { render, setupToken };
})();
