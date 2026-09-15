/* Team view — pick a team, see everything Jira says about it in one place:
   who is on it, which sprints it has, and what is queued on its board.

   Everything here comes from a single /api/team call served off the per-team
   index the sync built, so switching teams is instant. */

const TeamView = (() => {
  async function render(state, mount) {
    if (!state.teams.length) return renderNoTeams(mount);
    const d = await UI.api(`/api/team?id=${encodeURIComponent(state.teamId)}`);
    const active = d.sprints.find(s => s.id === d.activeSprintId);
    const closed = d.sprints.filter(s => s.state === 'closed');
    const future = d.sprints.filter(s => s.state === 'future');
    const linked = d.members.filter(m => m.jiraActivity).length;

    mount.innerHTML = `
      <section class="section">
        <div class="kpis">
          ${UI.kpi({
            label: 'Team', value: UI.esc(d.team.name), tone: 'brand', featured: true, variant: 'text',
            foot: d.team.boardId ? `Board ${UI.esc(String(d.team.boardId))}${d.team.jiraTeams.length ? ` · ${UI.esc(d.team.jiraTeams.join(', '))}` : ''}` : '<span style="color:var(--warn)">no Jira board mapped</span>',
          })}
          ${UI.kpi({ label: 'Members', value: UI.int(d.members.filter(m => m.status !== 'Released').length), foot: `${linked} matched to Jira activity` })}
          ${UI.kpi({
            label: 'Sprints', value: UI.int(d.sprints.length),
            foot: d.sprints.length ? `${closed.length} closed · ${active ? '1 active' : 'none active'} · ${future.length} planned` : 'none from Jira yet',
            tone: d.sprints.length ? '' : 'warn',
          })}
          ${UI.kpi({ label: 'Backlog', value: UI.int(d.backlog.points), unit: 'pts', foot: `${d.backlog.count} items · from ${d.backlog.source === 'board' ? 'the board' : 'ownership rules'}`, tone: d.backlog.source === 'board' ? '' : 'warn' })}
          ${UI.kpi({ label: 'Current sprint', variant: 'text', value: active ? UI.esc(active.calendarName || active.name) : '—', foot: active ? `${UI.date(active.start)} – ${UI.date(active.end)}` : 'Jira has no active sprint' })}
        </div>
      </section>

      ${!d.sprints.length ? `
      <section class="section">
        <div class="card">
          <div class="eyebrow"><i></i>Not synced</div>
          <h3 style="margin-top:6px">This team has no Jira sprints yet</h3>
          <p style="margin:8px 0 0;font-size:13px">
            The team, sprint and backlog you can see are the local starting setup, not Jira. Connect Jira in
            <strong>Integrations &amp; setup</strong> and run a sync: teams come from your scrum boards, sprints and their real dates from
            each board, the backlog from that board's backlog, and members from who is assigned work in those sprints.
          </p>
        </div>
      </section>` : ''}

      ${d.sprints.length && d.backlog.source !== 'board' ? `
      <section class="section">
        <div class="card">
          <div class="eyebrow"><i></i>Backlog source</div>
          <p style="margin:8px 0 0;font-size:13px">
            ${d.team.boardId
              // A mapped board that produced no backlog means the sync never asked for
              // it — an older sync, or one that errored on this board. Saying "no board
              // mapped" here while the header shows the board id is how you lose trust
              // in every other message on the screen.
              ? `This backlog is guessed from Team field values, components and assignees, not read from
                 board ${UI.esc(String(d.team.boardId))}. The board's own backlog has not been pulled yet —
                 run a full sync and it becomes exactly what Jira shows there.`
              : `This team has no Jira board mapped, so its backlog is being guessed from Team field values,
                 components and assignees. Map a board in <strong>Integrations &amp; setup → Teams &amp; Jira boards</strong>
                 and the backlog becomes exactly what Jira shows on that board.`}
          </p>
        </div>
      </section>` : ''}

      <section class="section">
        <div class="section-head">
          <h2>Members</h2>
          <span class="muted">Populated from who is assigned work in this team's sprints</span>
          <div class="spacer"></div>
          <button class="btn ghost sm" data-act="add-manual">Add someone manually</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Name</th><th>Role</th><th>Status</th><th>Source</th>
              <th class="num">Jira issues</th><th class="num">Points</th><th>Linked</th><th></th>
            </tr></thead>
            <tbody>
              ${d.members.map(m => `
                <tr class="${m.status === 'Released' ? 'released' : ''}">
                  <td><div class="name-cell">${UI.avatar(m.name)}<span>${UI.esc(m.name)}</span></div></td>
                  <td><select data-role="${m.id}">${['QA Lead', 'Auto QA', 'Manual QA', 'Dev'].map(r => `<option${r === m.role ? ' selected' : ''}>${r}</option>`).join('')}</select></td>
                  <td><select data-status="${m.id}">${['Active', 'Released'].map(v => `<option${v === m.status ? ' selected' : ''}>${v}</option>`).join('')}</select></td>
                  <td>${(m.source || m.addedFrom) === 'jira'
                    ? '<span class="tag ok">Jira</span>'
                    : '<span class="tag warn">manual</span>'}</td>
                  <td class="num">${m.jiraActivity ? m.jiraActivity.issues : '—'}</td>
                  <td class="num">${m.jiraActivity ? UI.num(m.jiraActivity.points) : '—'}</td>
                  <td>${m.jiraAccountId ? '<span class="tag ok">account</span>' : (m.jiraActivity ? '<span class="tag">by name</span>' : '<span class="tag warn">no activity</span>')}</td>
                  <td><button class="btn ghost sm" data-remove-member="${m.id}" data-name="${UI.esc(m.name)}">Remove</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${d.dormant.length ? `<div class="muted" style="font-size:12px;margin-top:10px">
          No Jira activity for ${d.dormant.map(x => UI.esc(x.name)).join(', ')} — usually a display-name mismatch, so their points are landing in "unassigned".
        </div>` : ''}
        ${(d.peopleHistoric || []).length ? `
          <div style="margin-top:12px;padding:12px 14px;border-radius:var(--radius-sm);background:var(--app-subtle)">
            <div class="eyebrow"><i></i>Worked here before</div>
            <div class="muted" style="font-size:12px;margin:6px 0 10px">
              The roster is whoever picked up work in the last ${d.rosterWindow ? d.rosterWindow.sprints : 3} sprints${d.rosterWindow && d.rosterWindow.names.length ? ` (${d.rosterWindow.names.map(UI.esc).join(', ')})` : ''},
              so a board with years of history does not turn into a roster of alumni.
              These ${d.peopleHistoric.length} were active earlier — add anyone who is back.
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${d.peopleHistoric.slice(0, 40).map(p => `
                <button class="chip" data-add-historic="${UI.esc(p.accountId || '')}" data-name="${UI.esc(p.name)}"
                  title="${p.issues} issues, ${UI.num(p.points)} pts — before the current window">+ ${UI.esc(p.name)}</button>`).join('')}
            </div>
          </div>` : ''}
        ${d.excluded.length ? `
          <div style="margin-top:12px;padding:12px 14px;border-radius:var(--radius-sm);background:var(--app-subtle)">
            <div class="eyebrow"><i></i>Kept off this team</div>
            <div class="muted" style="font-size:12px;margin:6px 0 10px">A sync will not re-add these, however often Jira mentions them.</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${d.excluded.map(x => {
                const key = typeof x === 'string' ? x : x.key;
                const name = typeof x === 'string' ? x : x.name;
                return `<button class="chip" data-unexclude="${UI.esc(key)}" title="${UI.esc(key)}">↩ ${UI.esc(name)}</button>`;
              }).join('')}
            </div>
          </div>` : ''}
      </section>

      <section class="section">
        <div class="section-head">
          <h2>Sprints</h2>
          <span class="muted">${d.sprints.length} from this team's board${d.builtAt ? ` · indexed ${UI.ago(d.builtAt)}` : ''}</span>
        </div>
        ${d.sprints.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Sprint</th><th>Jira name</th><th>State</th><th>Dates</th><th class="num">Items</th><th class="num">Points</th><th class="num">Done</th><th style="min-width:110px">Progress</th></tr></thead>
            <tbody>
              ${d.sprints.slice().reverse().map(sp => `
                <tr${sp.id === d.activeSprintId ? ' style="background:color-mix(in srgb, var(--brand-blue) 5%, transparent)"' : ''}>
                  <td><strong>${UI.esc(sp.calendarName || (sp.number != null ? `Sprint ${sp.number}` : sp.name))}</strong></td>
                  <td class="muted">${UI.esc(sp.name)}</td>
                  <td><span class="tag ${sp.state === 'active' ? 'ok' : ''}">${UI.esc(sp.state || '—')}</span></td>
                  <td class="muted">${UI.date(sp.start)} – ${UI.date(sp.end)}</td>
                  <td class="num">${sp.count}</td>
                  <td class="num">${UI.num(sp.points)}</td>
                  <td class="num">${UI.num(sp.donePoints)}</td>
                  <td>${UI.bar(sp.donePoints, sp.points || 1)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<div class="card"><div class="empty">No sprints yet — map a board in Settings and run a sync.</div></div>'}
      </section>

      <section class="section">
        <div class="section-head">
          <h2>Backlog on this board</h2>
          <span class="muted">${d.backlog.count} items · ${UI.num(d.backlog.points)} pts</span>
          <div class="spacer"></div>
          <a class="btn ghost sm" href="/api/export?what=backlog&team=${encodeURIComponent(state.teamId)}">Export CSV</a>
        </div>
        ${d.backlog.count ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Key</th><th>Summary</th><th>Status</th><th>Priority</th><th class="num">Points</th><th>Component</th><th>Assignee</th></tr></thead>
            <tbody>
              ${d.backlog.items.slice(0, 200).map(i => `
                <tr>
                  <td>${UI.issueKey(i.key)}</td>
                  <td class="wrap">${UI.esc(i.summary)}</td>
                  <td>${UI.esc(i.status || '—')}</td>
                  <td class="muted">${UI.esc(i.priority || '—')}</td>
                  <td class="num">${i.points == null ? '<span class="tag risk">—</span>' : UI.num(i.points)}</td>
                  <td class="muted">${UI.esc((i.components || [])[0] || '—')}</td>
                  <td class="muted">${UI.esc(i.assignee || '—')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${d.backlog.count > 200 ? `<div class="muted" style="margin-top:8px;font-size:12px">Showing the first 200 — the Backlog tab has filters.</div>` : ''}
        ` : '<div class="card"><div class="empty">Nothing queued on this board.</div></div>'}
      </section>
    `;

    wire(state, mount, d);
  }

  /** No teams at all — the only useful thing to say is how to get some. */
  function renderNoTeams(mount) {
    mount.innerHTML = `
      <section class="section">
        <div class="card featured">
          <div class="eyebrow"><i></i>Nothing set up yet</div>
          <h2 style="margin:8px 0 10px">No teams yet</h2>
          <p style="font-size:13.5px;line-height:1.6;max-width:62ch;color:var(--app-fg-2)">
            Teams come from your Jira scrum boards. Connect Jira in Settings and run a full sync — each board
            becomes a team, with its own sprints, its board backlog, and members taken from whoever is assigned
            work in its sprints.
          </p>
          <div class="btn-row"><a class="btn" href="#settings">Open Integrations &amp; setup</a></div>
        </div>
      </section>`;
  }

  function wire(state, mount, d) {
    const save = async (memberId, patch) => {
      await UI.jsonPut('/api/team/member', { teamId: state.teamId, memberId, ...patch });
      App.refresh();
    };
    UI.$$('[data-role]', mount).forEach(el => el.addEventListener('change', () => save(el.dataset.role, { role: el.value })));
    UI.$$('[data-status]', mount).forEach(el => el.addEventListener('change', () => save(el.dataset.status, { status: el.value })));

    UI.$$('[data-remove-member]', mount).forEach(btn => btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      if (!confirm(`Remove ${name} from ${d.team.name}?\n\nTheir availability and overrides stay on file, and no sync will re-add them until you undo this.`)) return;
      await UI.api('/api/team/member', { method: 'DELETE', body: JSON.stringify({ teamId: state.teamId, memberId: btn.dataset.removeMember }) });
      UI.toast(`${name} removed from ${d.team.name}`);
      App.refresh();
    }));

    UI.$$('[data-unexclude]', mount).forEach(btn => btn.addEventListener('click', async () => {
      await UI.jsonPost('/api/team/unexclude', { teamId: state.teamId, key: btn.dataset.unexclude });
      UI.toast('Back on the team');
      App.refresh();
    }));

    // Someone who worked here before the roster window and is back. They carry
    // their Jira accountId, so they are added as a synced row, not a typed one.
    UI.$$('[data-add-historic]', mount).forEach(btn => btn.addEventListener('click', async () => {
      try {
        await UI.jsonPost('/api/team/member', {
          teamId: state.teamId, name: btn.dataset.name,
          accountId: btn.dataset.addHistoric || null,
        });
        UI.toast(`${btn.dataset.name} added — check their availability for this sprint`);
        App.refresh();
      } catch (e) { UI.toast(e.message); }
    }));

    const addBtn = UI.$('[data-act="add-manual"]', mount);
    if (addBtn) addBtn.addEventListener('click', () => {
      UI.drawer(`
        <div class="eyebrow"><i></i>${UI.esc(d.team.name)}</div>
        <h2 style="margin:6px 0 4px">Add a member by hand</h2>
        <div class="muted" style="font-size:12.5px;margin-bottom:16px">
          For someone who is joining but has no Jira tickets yet. Anyone already assigned work in this
          team's sprints is added automatically on the next sync.
        </div>
        <div class="setting-row"><label>Name</label><input type="text" id="nmName" placeholder="As it appears in Jira"></div>
        <div class="setting-row"><label>Role</label><select id="nmRole"><option>Auto QA</option><option>QA Lead</option><option>Manual QA</option><option>Dev</option></select></div>
        <div class="btn-row"><button class="btn" id="nmSave">Add</button><button class="btn ghost" id="nmCancel">Cancel</button></div>`);
      UI.$('#nmCancel').addEventListener('click', UI.closeDrawer);
      UI.$('#nmSave').addEventListener('click', async () => {
        const name = UI.$('#nmName').value.trim();
        if (!name) return UI.toast('A name is required', true);
        try {
          await UI.jsonPost('/api/team/member', { teamId: state.teamId, name, role: UI.$('#nmRole').value });
          UI.closeDrawer(); UI.toast(`${name} added — set their availability on Capacity planning`); App.refresh();
        } catch (err) { UI.toast(err.message, true); }
      });
    });
  }

  return { render };
})();
