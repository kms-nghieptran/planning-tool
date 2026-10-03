/* global UI, App */
/**
 * account.js — your own account. Every role has this one.
 *
 * ── WHY NOT IN SETTINGS ──────────────────────────────────────────────────
 *
 * Settings is the PROJECT's configuration — the Jira connection, the mail
 * server, the field mapping — and it is admin-only because those routes return
 * credentials. Everything here is PERSONAL: your password, your sessions, your
 * Jira token. Putting the one personal thing a member needs behind a screen
 * only an admin can open is how a feature ends up unreachable by the people it
 * was built for.
 *
 * ── THE JIRA TOKEN IS THE INTERESTING PART ───────────────────────────────
 *
 * Three writes in this tool leave and change a real ticket. They go out under
 * YOUR Jira account, which means Jira's own permissions decide what you can
 * do and Jira's history names you rather than a shared service account. The
 * cost is that everyone who wants to push has to paste a token in once, and
 * this screen is where.
 */
const AccountView = (() => {
  const esc = (s) => UI.esc(s == null ? '' : s);

  const roleWords = (a) => {
    if (!a) return '';
    if (a.role === 'project-admin') return 'Project admin — everything, including settings and accounts.';
    if (a.role === 'lead') {
      const teams = (a.leadTeams || []).map(teamName).join(', ');
      return `Team lead — you can plan ${teams || 'no teams'}. You can read every other team but not change it.`;
    }
    return 'Member — you can read every screen. Changes are made by the team leads.';
  };

  const teamName = (id) => {
    const t = ((App.state || {}).teams || []).find(x => x.id === id);
    return t ? (t.name || t.id) : id;
  };

  const when = (iso) => (iso ? UI.dateTime(iso) : '—');

  /* ── the Jira panel ────────────────────────────────────────────────── */

  function jiraPanel(j) {
    /* THREE STATES, AND THEY NEED THREE DIFFERENT SENTENCES. "Add your token"
       is confusing advice for somebody who can see they already did — which is
       exactly what an unreadable stored token looks like without this. */
    const body = j.unreadable
      ? `<div class="auth-error" style="margin:0 0 12px">
           Your saved token cannot be read any more — the server's encryption key changed,
           or this store was restored from a backup without it. Enter the token again.
         </div>`
      : j.has
        ? `<div class="muted" style="font-size:12.5px;margin-bottom:12px">
             Saved for <strong>${esc(j.email)}</strong>, ending <code>${esc(j.hint)}</code>.
             ${j.checkedAt ? `Jira accepted it ${esc(when(j.checkedAt))}.` : ''}
           </div>`
        : `<div class="muted" style="font-size:12.5px;margin-bottom:12px">
             No token saved. You can read everything without one — it is only needed to push
             a change back to Jira: story points, a due date, or moving an item between sprints.
           </div>`;

    return `
      <div class="card">
        <h3>Your Jira token</h3>
        <div class="sub">Changes you push go out as you, not as a shared account</div>
        ${body}
        <label class="auth-field"><span>Your Jira email</span>
          <input id="jiraEmail" type="email" autocomplete="off" value="${esc(j.email || '')}"
            placeholder="you@kms-technology.com"></label>
        <label class="auth-field"><span>API token</span>
          <input id="jiraToken" type="password" autocomplete="off"
            placeholder="${j.has ? 'Enter a new token to replace the saved one' : 'Paste your Jira API token'}"></label>
        <div class="muted" style="font-size:11.5px;margin:-4px 0 12px">
          Create one at <strong>id.atlassian.com → Security → API tokens</strong>.
          It is stored encrypted and never sent back to this page —
          <em>that protects a copy of the database, not the server itself</em>.
        </div>
        <div class="auth-error" id="jiraError" hidden></div>
        <div style="display:flex;gap:8px;margin-top:4px">
          <button class="btn sm" data-act="save-jira">${j.has ? 'Replace token' : 'Save token'}</button>
          ${j.has ? '<button class="btn ghost sm" data-act="clear-jira">Remove</button>' : ''}
        </div>
      </div>`;
  }

  /* ── render ────────────────────────────────────────────────────────── */

  async function render(state, mount) {
    const me = (await UI.api('/api/auth/me')).actor;
    if (!me) {
      mount.innerHTML = '<section class="section"><div class="card"><div class="empty">Not signed in.</div></div></section>';
      return;
    }
    const j = (await UI.api('/api/auth/jira')).jira || { has: false };
    const sessions = (await UI.api('/api/auth/sessions')).sessions || [];
    const live = sessions.filter(s => !s.revokedAt && s.expiresAt > new Date().toISOString());

    mount.innerHTML = `
      <section class="section">
        <div class="section-head">
          <h2>Your account</h2>
          <span class="muted">${esc(me.email)}</span>
        </div>
        <div class="card" style="margin-bottom:14px">
          <div class="name-cell" style="gap:12px">
            ${UI.avatar(me.name || me.email)}
            <div>
              <div style="font-weight:var(--font-weight-semibold,600)">${esc(me.name || me.email)}</div>
              <div class="muted" style="font-size:12px;margin-top:2px">${esc(roleWords(me))}</div>
            </div>
          </div>
        </div>
      </section>

      <section class="section conn-grid">
        ${jiraPanel(j)}

        <div class="card">
          <h3>Password</h3>
          <div class="sub">Changing it signs out every other session on your account</div>
          <label class="auth-field"><span>Current password</span>
            <input id="pwCurrent" type="password" autocomplete="current-password"></label>
          <label class="auth-field"><span>New password</span>
            <input id="pwNew" type="password" autocomplete="new-password" placeholder="At least 12 characters"></label>
          <label class="auth-field"><span>New password again</span>
            <input id="pwConfirm" type="password" autocomplete="new-password"></label>
          <div class="auth-error" id="pwError" hidden></div>
          <button class="btn sm" data-act="save-pw" style="margin-top:4px">Change password</button>
        </div>
      </section>

      <section class="section">
        <div class="card wide">
          <div class="section-head" style="margin-bottom:6px">
            <h3>Where you are signed in</h3>
            <div class="spacer"></div>
            ${live.length > 1 ? '<button class="btn ghost sm" data-act="signout-all">Sign out everywhere</button>' : ''}
          </div>
          <div class="sub">
            ${live.length} live session${live.length === 1 ? '' : 's'}.
            Signing out everywhere ends this one too.
          </div>
          <div class="table-wrap" style="border:none">
            <table>
              <thead><tr><th>Started</th><th>Last used</th><th>From</th><th>Expires</th></tr></thead>
              <tbody>${live.length ? live.map(s => `
                <tr>
                  <td class="muted" style="font-size:12px">${esc(when(s.issuedAt))}</td>
                  <td class="muted" style="font-size:12px">${esc(when(s.lastSeenAt))}</td>
                  <td class="muted" style="font-size:12px">${esc(s.ip || '—')}</td>
                  <td class="muted" style="font-size:12px">${esc(when(s.expiresAt))}</td>
                </tr>`).join('')
    : '<tr><td colspan="4" class="muted">None.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </section>`;

    const val = (id) => ((document.getElementById(id) || {}).value || '').trim();
    const fail = (id, msg) => {
      const box = document.getElementById(id);
      if (box) { box.textContent = msg; box.hidden = false; }
    };

    mount.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;

      if (act === 'save-jira') {
        const box = document.getElementById('jiraError');
        if (box) box.hidden = true;
        if (!val('jiraEmail') || !val('jiraToken')) {
          return fail('jiraError', 'Both your Jira email and a token are needed.');
        }
        btn.disabled = true; btn.textContent = 'Checking with Jira…';
        try {
          /* The server CHECKS it against Jira before storing. A token that
             does not work but is saved anyway is worse than none: this screen
             would say "saved" and the failure would surface later, somewhere
             that looks like a different bug. */
          const r = await UI.jsonPut('/api/auth/jira', { email: val('jiraEmail'), token: val('jiraToken') });
          UI.toast(r.displayName ? `Jira accepted it — you are ${r.displayName}.` : 'Token saved.');
          App.refresh();
        } catch (err) {
          fail('jiraError', err.message);
          btn.disabled = false; btn.textContent = 'Save token';
        }
        return;
      }

      if (act === 'clear-jira') {
        try { await UI.jsonDelete('/api/auth/jira', {}); App.refresh(); } catch (err) { fail('jiraError', err.message); }
        return;
      }

      if (act === 'save-pw') {
        const box = document.getElementById('pwError');
        if (box) box.hidden = true;
        if (val('pwNew') !== val('pwConfirm')) return fail('pwError', 'The two new passwords do not match.');
        try {
          await UI.jsonPost('/api/auth/password', { current: val('pwCurrent'), password: val('pwNew') });
          UI.toast('Password changed. Your other sessions have been signed out.');
          App.refresh();
        } catch (err) { fail('pwError', err.message); }
        return;
      }

      if (act === 'signout-all') {
        await UI.jsonDelete('/api/auth/sessions', {}).catch(() => {});
        location.assign('/');
      }
    });
  }

  return { render };
})();
