/* global UI, App */
/**
 * users.js — accounts, roles and sessions. Project admin only.
 *
 * ── THE SCREEN'S REAL JOB IS THE SCOPE ───────────────────────────────────
 *
 * Two of the three roles need nothing but a radio button. The third is the
 * whole feature: a lead is a lead OF SOMETHING, and if that choice is hidden
 * behind a sensible default then "Lead" quietly means "lead of whatever was
 * first in the list". So picking teams is on the same row as picking the role,
 * it is required, and the table shows the teams beside every lead rather than
 * just the word.
 *
 * ── WHAT THIS SCREEN CANNOT DO IS THE POINT ──────────────────────────────
 *
 * It is a convenience over the server's rules, never the rules themselves.
 * Every refusal here — the last admin, a lead with no teams, an address that
 * already exists — is enforced in `server.js` and merely ANTICIPATED here. A
 * tab left open since a demotion still has every button on it, and `fetch`
 * from a console never saw this file at all.
 */
const UsersView = (() => {
  const esc = (s) => UI.esc(s == null ? '' : s);
  let rows = [];
  let teams = [];

  const ROLES = [
    { id: 'member', label: 'Member', hint: 'Reads every screen. Changes nothing.' },
    { id: 'lead', label: 'Team lead', hint: 'Plans the teams you choose. Reads the rest.' },
    { id: 'project-admin', label: 'Project admin', hint: 'Everything, including settings, accounts and the Jira connection.' },
  ];

  const when = (iso) => (iso ? UI.dateTime(iso) : '—');

  /* ── table ─────────────────────────────────────────────────────────── */

  function roleCell(u) {
    const tag = u.role === 'project-admin' ? '<span class="tag warn">Project admin</span>'
      : u.role === 'lead' ? '<span class="tag">Team lead</span>'
        : '<span class="tag muted-tag">Member</span>';
    /* THE TEAMS, ON THE ROW. A column that says "Team lead" and stops is the
       bug this screen exists to prevent — it reads as a rank when it is a
       scope, and nobody can see from the list who can touch what. */
    const scope = u.role === 'lead'
      ? `<div class="muted" style="font-size:11.5px;margin-top:3px">${u.leadTeams.length
        ? esc(u.leadTeams.map(teamName).join(', '))
        : '<span class="tag risk">no teams — cannot plan anything</span>'}</div>`
      : '';
    return tag + scope;
  }

  const teamName = (id) => {
    const t = teams.find(x => x.id === id);
    return t ? (t.name || t.id) : id;
  };

  function row(u) {
    const me = (App.state.actor || {}).id === u.id;
    const dead = u.status !== 'active';
    return `
      <tr class="${dead ? 'released' : ''}" data-user="${esc(u.id)}">
        <td>
          <div class="name-cell">${UI.avatar(u.name || u.email)}
            <span>
              ${esc(u.name || '—')}${me ? ' <span class="tag">you</span>' : ''}
              ${dead ? ' <span class="tag risk">disabled</span>' : ''}
              <div class="muted" style="font-size:11.5px">${esc(u.email)}</div>
            </span>
          </div>
        </td>
        <td>${roleCell(u)}</td>
        <td class="num">${u.sessions ? `${UI.int(u.sessions)}` : '—'}</td>
        <td class="muted" style="font-size:11.5px">${esc(when(u.lastSeenAt))}</td>
        <td class="num">
          ${u.mustChangePassword ? '<span class="tag warn" title="They have to replace it at next sign-in">temporary</span>' : ''}
          ${!u.hasPassword ? '<span class="tag" title="No password set — they cannot sign in yet">no password</span>' : ''}
        </td>
        <td class="num" style="white-space:nowrap">
          <button class="btn ghost xs" data-act="edit" data-id="${esc(u.id)}">Role</button>
          <button class="btn ghost xs" data-act="pw" data-id="${esc(u.id)}">Password</button>
          ${u.sessions ? `<button class="btn ghost xs" data-act="signout" data-id="${esc(u.id)}" title="End every session on this account">Sign out</button>` : ''}
          <button class="btn ghost xs" data-act="${dead ? 'enable' : 'disable'}" data-id="${esc(u.id)}">${dead ? 'Enable' : 'Disable'}</button>
        </td>
      </tr>`;
  }

  /* ── drawers ───────────────────────────────────────────────────────── */

  function teamPicker(selected, disabled) {
    const on = new Set(selected || []);
    return `
      <div class="role-teams" ${disabled ? 'hidden' : ''} id="roleTeams">
        <div class="muted" style="font-size:12px;margin-bottom:6px">
          Which teams do they lead? They can read every team either way — this is about what they can change.
        </div>
        ${teams.map(t => `
          <label class="hol-paste-row" style="display:flex;gap:8px;align-items:center;padding:3px 0">
            <input type="checkbox" data-team="${esc(t.id)}" ${on.has(t.id) ? 'checked' : ''}>
            <span>${esc(t.name || t.id)}</span>
          </label>`).join('')}
      </div>`;
  }

  function editRole(u) {
    UI.drawer(`
      <div class="drawer-head">
        <h3 style="margin:0">${esc(u.name || u.email)}</h3>
        <div class="muted" style="font-size:12px;margin-top:4px">${esc(u.email)}</div>
      </div>
      <div class="drawer-body">
        ${ROLES.map(r => `
          <label class="role-opt">
            <input type="radio" name="role" value="${r.id}" ${u.role === r.id ? 'checked' : ''}>
            <span><strong>${esc(r.label)}</strong><div class="muted" style="font-size:11.5px">${esc(r.hint)}</div></span>
          </label>`).join('')}
        ${teamPicker(u.leadTeams, u.role !== 'lead')}
        <div class="auth-error" id="roleError" hidden></div>
        <div style="margin-top:14px;display:flex;gap:8px">
          <button class="btn" data-act="save-role" data-id="${esc(u.id)}">Save</button>
          <button class="btn ghost" data-act="close-drawer">Cancel</button>
        </div>
      </div>`);
    wireDrawer({
      'save-role': () => submit(() => {
        const role = chosenRole();
        const leadTeams = role === 'lead' ? chosenTeams() : [];
        if (role === 'lead' && !leadTeams.length) throw new Error('A team lead has to lead at least one team.');
        return UI.jsonPut('/api/users/roles', { id: u.id, role, leadTeams });
      }, 'roleError'),
    });

    // The team list only means anything for a lead; shown and hidden live so
    // the choice and its scope stay visibly connected.
    wireRoleRadios();
  }

  function setPassword(u) {
    UI.drawer(`
      <div class="drawer-head">
        <h3 style="margin:0">Set a password for ${esc(u.name || u.email)}</h3>
        <div class="muted" style="font-size:12px;margin-top:4px">
          They will have to replace it the first time they sign in, and every session on the account ends now.
        </div>
      </div>
      <div class="drawer-body">
        <label class="auth-field"><span>New password</span>
          <input id="newPw" type="text" autocomplete="off" placeholder="At least 12 characters"></label>
        <div class="muted" style="font-size:11.5px;margin-top:6px">
          Shown as text on purpose — you have to read it out to them. Send it by a different route from the link to this tool.
        </div>
        <div class="auth-error" id="pwError" hidden></div>
        <div style="margin-top:14px;display:flex;gap:8px">
          <button class="btn" data-act="save-pw" data-id="${esc(u.id)}">Set password</button>
          <button class="btn ghost" data-act="close-drawer">Cancel</button>
        </div>
      </div>`);
    wireDrawer({
      'save-pw': () => submit(() => {
        const pw = fieldValue('newPw');
        if (!pw) throw new Error('Type a password for them.');
        return UI.jsonPut('/api/users/password', { id: u.id, password: pw, mustChange: true });
      }, 'pwError'),
    });
  }

  function addUser() {
    UI.drawer(`
      <div class="drawer-head"><h3 style="margin:0">Add an account</h3></div>
      <div class="drawer-body">
        <label class="auth-field"><span>Email</span><input id="newEmail" type="email" autocomplete="off"></label>
        <label class="auth-field"><span>Name</span><input id="newName" type="text" autocomplete="off"></label>
        <label class="auth-field"><span>Temporary password</span>
          <input id="newPw" type="text" autocomplete="off" placeholder="At least 12 characters"></label>
        <div style="margin-top:12px">
          ${ROLES.map(r => `
            <label class="role-opt">
              <input type="radio" name="role" value="${r.id}" ${r.id === 'member' ? 'checked' : ''}>
              <span><strong>${esc(r.label)}</strong><div class="muted" style="font-size:11.5px">${esc(r.hint)}</div></span>
            </label>`).join('')}
        </div>
        ${teamPicker([], true)}
        <div class="auth-error" id="addError" hidden></div>
        <div style="margin-top:14px;display:flex;gap:8px">
          <button class="btn" data-act="save-new">Create</button>
          <button class="btn ghost" data-act="close-drawer">Cancel</button>
        </div>
      </div>`);
    wireDrawer({
      'save-new': () => submit(() => {
        const role = chosenRole();
        const leadTeams = role === 'lead' ? chosenTeams() : [];
        if (role === 'lead' && !leadTeams.length) throw new Error('A team lead has to lead at least one team.');
        return UI.jsonPost('/api/users', {
          email: fieldValue('newEmail'), name: fieldValue('newName'),
          password: fieldValue('newPw'), role, leadTeams,
        });
      }, 'addError'),
    });
    wireRoleRadios();
  }


  /* ─────────────────── the drawer is not in this view ───────────────────
   *
   * `UI.drawer` writes into `#drawerBody`, which sits beside the view's mount
   * rather than inside it. A delegated listener on the mount therefore never
   * sees a click in the drawer — which is exactly how "Add an account" shipped
   * with a Create button that created nothing. The markup was right, the
   * handler was right, and they were in two different subtrees.
   *
   * So the drawer's own controls are bound here, directly, each time one
   * opens. The elements are rebuilt every time, so there is nothing to unbind.
   */
  function wireDrawer(handlers) {
    const body = drawerBody();
    if (!body) return;
    const all = { 'close-drawer': () => UI.closeDrawer(), ...handlers };
    body.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const fn = all[btn.dataset.act];
        if (fn) await fn(btn);
      });
    });
    /* ENTER SUBMITS. Three boxes and a button is a form, and a form that
       ignores Enter is the single most common "it does nothing" report. */
    body.querySelectorAll('input').forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const primary = body.querySelector('[data-act^="save-"]');
        if (primary) primary.click();
      });
    });
    const first = body.querySelector('input:not([type="radio"]):not([type="checkbox"])');
    if (first && first.focus) first.focus();
  }

  /** The role radios live in the drawer too, so they bind the same way. */
  function wireRoleRadios() {
    const body = drawerBody();
    if (!body) return;
    body.querySelectorAll('input[name="role"]').forEach((el) => el.addEventListener('change', () => {
      const box = body.querySelector('#roleTeams');
      if (box) box.hidden = el.value !== 'lead' || !el.checked;
    }));
  }

  /* ── reading the drawer's fields ───────────────────────────────────────
     SCOPED TO THE DRAWER, never to the document. `UI.$$` searches the whole
     page, and the Accounts table behind the drawer has controls of its own —
     reading those instead is a wrong answer that looks like a right one. */
  const drawerBody = () => document.getElementById('drawerBody');

  const fieldValue = (id) => {
    const body = drawerBody();
    const el = body && body.querySelector(`#${id}`);
    return el ? String(el.value || '').trim() : '';
  };

  const chosenRole = () => {
    const body = drawerBody();
    const el = body && [...body.querySelectorAll('input[name="role"]')].find((x) => x.checked);
    return el ? el.value : 'member';
  };

  const chosenTeams = () => {
    const body = drawerBody();
    if (!body) return [];
    return [...body.querySelectorAll('#roleTeams input[type="checkbox"]')]
      .filter((x) => x.checked).map((x) => x.dataset.team);
  };

  const showError = (id, msg) => {
    const body = drawerBody();
    const box = (body && body.querySelector(`#${id}`)) || document.getElementById(id);
    if (box) { box.textContent = msg; box.hidden = false; }
    else UI.toast(msg, 'error');
  };

  /**
   * One save, with the button locked while it is in flight.
   *
   * THE SERVER'S WORDING IS WHAT THE USER READS. "That is the only project
   * admin left — disabling them would leave nobody able to manage accounts"
   * explains itself and says what to do; "Could not save" does neither and
   * sends them to whoever wrote the tool.
   */
  async function submit(run, errorId) {
    const body = drawerBody();
    const btn = body && body.querySelector('[data-act^="save-"]');
    const was = btn ? btn.textContent : null;
    const box = body && body.querySelector(`#${errorId}`);
    if (box) box.hidden = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      await run();
      UI.closeDrawer();
      App.refresh();
    } catch (err) {
      showError(errorId, err.message || 'That did not work.');
      if (btn) { btn.disabled = false; btn.textContent = was; }
    }
  }

  /* ── render ────────────────────────────────────────────────────────── */

  async function render(state, mount) {
    const data = await UI.api('/api/users');
    rows = data.users || [];
    teams = state.teams || [];

    const admins = rows.filter((u) => u.status === 'active' && u.role === 'project-admin').length;

    mount.innerHTML = `
      <section class="section">
        <div class="section-head">
          <h2>Accounts</h2>
          <span class="muted">Who can sign in, and what they can change</span>
          <div class="spacer"></div>
          <button class="btn sm" data-act="add">Add an account</button>
        </div>
        ${admins === 1 ? `
          <div class="card" style="margin-bottom:12px">
            <div class="muted" style="font-size:12px">
              <strong>There is one project admin.</strong> If that account is lost, nobody can manage accounts or settings —
              the repair is behind the door that would be locked. Consider a second one.
            </div>
          </div>` : ''}
        <div class="card">
          <div class="table-wrap" style="border:none">
            <table>
              <thead><tr>
                <th>Person</th><th>Role</th><th class="num">Sessions</th><th>Last seen</th>
                <th class="num">Password</th><th class="num"></th>
              </tr></thead>
              <tbody>${rows.map(row).join('')}</tbody>
            </table>
          </div>
        </div>
      </section>`;

    /* THE TABLE'S buttons, which ARE inside the mount — unlike the drawer's.
       Delegated, so they survive the table being redrawn. */
    mount.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const u = rows.find((x) => x.id === btn.dataset.id);

      if (act === 'add') return addUser();
      if (act === 'edit') return editRole(u);
      if (act === 'pw') return setPassword(u);

      try {
        if (act === 'signout') await UI.jsonDelete('/api/users/sessions', { id: u.id });
        else if (act === 'disable') await UI.jsonDelete('/api/users', { id: u.id });
        else if (act === 'enable') await UI.jsonPut('/api/users', { id: u.id, status: 'active' });
        else return;
      } catch (err) {
        /* No drawer is open for these, so the refusal has nowhere to land but
           a toast — and it still has to be the SERVER's words. */
        UI.toast(err.message, 'error');
        return;
      }
      App.refresh();
    });
  }

  return { render };
})();
