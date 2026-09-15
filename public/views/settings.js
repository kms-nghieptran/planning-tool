/* Settings — connections, teams, capacity constants, import/export, audit.
   Secrets are write-only: the browser is told whether a token exists, never what it is. */

const SettingsView = (() => {
  async function render(state, mount) {
    const s = await UI.api('/api/state');
    const cfg = s.config;
    const audit = await UI.api('/api/audit?limit=40');
    const team = s.plan.teams.find(t => t.id === state.teamId) || s.plan.teams[0];

    mount.innerHTML = `
      <section class="section conn-grid">
        <div class="card">
          <h3>Jira</h3>
          <div class="sub">Sprints, issues, points, assignees. Everything else is derived from this.</div>
          <div class="setting-row"><label>Base URL</label><input type="text" id="jBase" value="${UI.esc(cfg.jira.baseUrl)}" placeholder="https://yourcompany.atlassian.net"></div>
          <div class="setting-row"><label>Email</label><input type="text" id="jEmail" value="${UI.esc(cfg.jira.email)}"></div>
          <div class="setting-row"><label>API token</label><input type="password" id="jToken" placeholder="${cfg.jira.hasToken ? '•••••••• saved' : 'paste token'}"></div>
          <div class="setting-row"><label>Project key</label><input type="text" id="jProject" value="${UI.esc(cfg.jira.projectKey)}"></div>
          <div class="btn-row">
            <button class="btn sm" data-act="save-jira">Save</button>
            <button class="btn ghost sm" data-act="test-jira">Test connection</button>
          </div>
          <p class="muted" style="font-size:11.5px;margin:12px 0 0">Stored in <code>config.json</code> (chmod 600, git-ignored) and never sent to the browser. Env vars <code>JIRA_BASE_URL</code> / <code>JIRA_EMAIL</code> / <code>JIRA_API_TOKEN</code> override the file.</p>
        </div>

        <div class="card">
          <h3>Katalon TestOps</h3>
          <div class="sub">Execution health — turns failing suites into forecast maintenance load.</div>
          <div class="setting-row"><label>Base URL</label><input type="text" id="tBase" value="${UI.esc(cfg.testops.baseUrl)}"></div>
          <div class="setting-row"><label>API key</label><input type="password" id="tKey" placeholder="${cfg.testops.hasKey ? '•••••••• saved' : 'paste key'}"></div>
          <div class="setting-row"><label>Project ids</label><input type="text" id="tProjects" value="${UI.esc((cfg.testops.projectIds || []).join(', '))}" placeholder="blank = all"></div>
          <div class="btn-row">
            <button class="btn sm" data-act="save-testops">Save</button>
            <button class="btn ghost sm" data-act="test-testops">Test connection</button>
            <button class="btn ghost sm" data-act="sync-testops">Sync now</button>
          </div>
          ${s.testops.syncedAt ? `<p class="muted" style="font-size:11.5px;margin:12px 0 0">Last synced ${UI.ago(s.testops.syncedAt)} · ${s.testops.projects.length} projects</p>` : ''}
        </div>

        <div class="card">
          <h3>GitHub</h3>
          <div class="sub">PR activity — catches technical work that never reaches Jira.</div>
          <div class="setting-row"><label>Token</label><input type="password" id="gToken" placeholder="${cfg.github.hasToken ? '•••••••• saved' : 'ghp_…'}"></div>
          <div class="setting-row"><label>Repos</label><input type="text" id="gRepos" value="${UI.esc((cfg.github.repos || []).join(', '))}" placeholder="org/repo, org/other-repo"></div>
          <div class="btn-row">
            <button class="btn sm" data-act="save-github">Save</button>
            <button class="btn ghost sm" data-act="test-github">Test connection</button>
            <button class="btn ghost sm" data-act="sync-github">Sync now</button>
          </div>
          ${s.github.syncedAt ? `<p class="muted" style="font-size:11.5px;margin:12px 0 0">Last synced ${UI.ago(s.github.syncedAt)} · ${s.github.prs} PRs from ${s.github.repos.length} repos</p>` : ''}
        </div>

        <div class="card">
          <h3>No connection? Import instead</h3>
          <div class="sub">Every dataset here has a manual path. A Jira CSV export is enough to run the whole tool.</div>
          <div class="setting-row"><label>Jira CSV export</label><input type="file" id="csvFile" accept=".csv"></div>
          <p class="muted" style="font-size:11.5px">Needs at minimum: <code>Issue key</code>, <code>Summary</code>, <code>Status</code>, <code>Assignee</code>, <code>Sprint</code>, <code>Story Points</code>.</p>
          <div class="btn-row">
            <button class="btn sm" data-act="import-csv">Import issues</button>
            <a class="btn ghost sm" href="/api/backup">Back up plan</a>
            <button class="btn ghost sm" data-act="restore">Restore plan</button>
            <input type="file" id="restoreFile" accept=".json" hidden>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="card wide">
          <div class="section-head" style="margin-bottom:6px">
            <h3>Teams &amp; Jira boards</h3>
            <div class="spacer"></div>
            <button class="btn ghost sm" data-act="reconcile">Re-read sprints &amp; people</button>
          </div>
          <div class="sub">Sprints and rosters come from these boards. A sync pulls each board's real sprint dates and state, so the sprint list is Jira's, not a guess.</div>
          ${s.plan.teams.map(t => teamCard(t, s)).join('')}
          ${(s.boards || []).length ? '' : '<div class="empty">No boards read yet — run a Jira sync.</div>'}
          ${(s.ignoredBoards || []).length ? `
            <div style="margin-top:16px;padding:12px 14px;border-radius:var(--radius-sm);background:var(--app-subtle)">
              <div class="eyebrow"><i></i>Dismissed boards</div>
              <div class="muted" style="font-size:12px;margin:6px 0 10px">No sync will turn these back into teams.</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                ${(s.ignoredBoards || []).map(id => {
                  const b = (s.boards || []).find(x => String(x.id) === String(id));
                  return `<button class="chip" data-unignore="${UI.esc(String(id))}">↩ ${UI.esc(b ? b.name : `Board ${id}`)}</button>`;
                }).join('')}
              </div>
            </div>` : ''}
          ${(s.boards || []).filter(b => b.type === 'scrum' && !s.plan.teams.some(t => String(t.boardId) === String(b.id)) && !(s.ignoredBoards || []).map(String).includes(String(b.id))).length ? `
            <p class="muted" style="font-size:11.5px;margin-top:14px">
              Scrum boards with no team yet: ${(s.boards || []).filter(b => b.type === 'scrum' && !s.plan.teams.some(t => String(t.boardId) === String(b.id)) && !(s.ignoredBoards || []).map(String).includes(String(b.id))).map(b => UI.esc(b.name)).join(', ')}.
              The next sync turns each into a team — remove the ones you do not plan for and they stay gone.
            </p>` : ''}
        </div>
      </section>

      <section class="section">
        <div class="card wide">
          <div class="section-head" style="margin-bottom:6px">
            <h3>Capacity model — ${UI.esc(team.name)}</h3>
            <div class="spacer"></div>
            <label class="field"><span>Team</span><select id="stTeam">${s.plan.teams.map(t => `<option value="${t.id}"${t.id === team.id ? ' selected' : ''}>${UI.esc(t.name)}</option>`).join('')}</select></label>
          </div>
          <div class="sub">These constants scale every number in the tool. Defaults came from your capacity sheet.</div>
          <div class="grid-3" style="margin-top:12px">
            ${numField('Hours per working day', 'cHoursDay', team.settings.hoursPerDay, 0.5, 'A working day is 7 h in the sheet, not 8')}
            ${numField('Hours per story point', 'cHoursPoint', team.settings.hoursPerPoint, 0.1, 'The bridge between capacity and velocity')}
            ${numField('Ceremony hours per sprint', 'cCeremony', team.settings.ceremonyHours, 0.5, 'Standups, planning, review, retro')}
            ${numField('Over-load threshold %', 'cOver', team.settings.workloadOverPct, 5, 'Above this a person is flagged red')}
            ${numField('Under-load threshold %', 'cUnder', team.settings.workloadUnderPct, 5, 'Below this, slack is flagged')}
            ${numField('Points per failing test', 'cPPF', team.settings.pointsPerFailingTest ?? 0.25, 0.05, 'How TestOps failures become forecast maintenance')}
          </div>
          <div class="btn-row"><button class="btn sm" data-act="save-settings">Save capacity model</button></div>
        </div>
      </section>

      <section class="section">
        <div class="card">
          <h3>Sprint calendar</h3>
          <div class="sub">
            ${s.plan.sprints.length} sprints · ${UI.date(s.plan.sprints[0].start)} → ${UI.date(s.plan.sprints[s.plan.sprints.length - 1].end)}
            · <strong>${s.plan.sprints.filter(x => x.source === 'jira').length}</strong> from Jira,
            ${s.plan.sprints.filter(x => x.source !== 'jira').length} local
          </div>
          <div class="muted" style="font-size:11.5px;margin-bottom:10px">Synced sprints keep Jira's real dates and state. Local ones are only a cadence guess — they stay until you delete them.</div>
          <div class="btn-row" style="align-items:flex-end">
            <label class="field"><span>Add sprints</span><input type="number" id="spCount" value="4" min="1" max="24" style="width:80px"></label>
            <button class="btn sm" data-act="add-sprints">Extend calendar</button>
          </div>
          <h3 style="margin-top:22px">Public holidays</h3>
          <div class="sub">Applied to every team's availability grid</div>
          <input type="text" id="holidays" value="${UI.esc((s.plan.holidays || []).join(', '))}" placeholder="2026-09-02, 2027-01-01" style="width:100%">
          <div class="btn-row"><button class="btn sm" data-act="save-holidays">Save holidays</button></div>
        </div>
      </section>

      <section class="section">
        <div class="card">
          <h3>Work categorisation</h3>
          <div class="sub">First rule that matches wins. This is what drives the work-mix split everywhere.</div>
          <div class="table-wrap" style="margin-top:10px">
            <table>
              <thead><tr><th>#</th><th>If</th><th>Operator</th><th>Value</th><th>Category</th></tr></thead>
              <tbody>${(s.plan.categoryRules || s.defaultRules).map((r, i) => `
                <tr><td class="muted">${i + 1}</td><td class="mono">${UI.esc(r.field)}</td><td class="muted">${UI.esc(r.op)}</td><td class="mono">${UI.esc(r.value)}</td>
                <td><span class="tag"><i class="dot" style="background:${UI.CATEGORY_COLORS[r.category]}"></i>${UI.esc((s.categories[r.category] || {}).label || r.category)}</span></td></tr>`).join('')}
              </tbody>
            </table>
          </div>
          <p class="muted" style="font-size:11.5px;margin-top:10px">Edit these in <code>data/store/plan.json</code> under <code>categoryRules</code>, or leave it <code>null</code> to keep these defaults.</p>
        </div>
      </section>

      <section class="section grid-2">
        <div class="card">
          <h3>Sync integrity</h3>
          <div class="sub">Every dataset's local count checked against Jira's own count</div>
          ${(s.sync.verification || []).length ? `
            <div class="table-wrap" style="border:none">
              <table><thead><tr><th>Dataset</th><th class="num">Local</th><th class="num">Jira</th><th>State</th></tr></thead>
                <tbody>${s.sync.verification.map(v => `
                  <tr><td class="mono">${UI.esc(v.dataset)}</td><td class="num">${v.local}</td><td class="num">${v.remote ?? '—'}</td>
                  <td>${v.remote == null ? '<span class="tag">not checked</span>' : v.ok ? '<span class="tag ok">matches</span>' : '<span class="tag risk">mismatch</span>'}</td></tr>`).join('')}
                </tbody></table>
            </div>
            <p class="muted" style="font-size:11.5px;margin-top:10px">A mismatch usually means issues were deleted — only a full sync catches deletions.</p>`
            : '<div class="empty">No sync yet</div>'}
          ${s.sync.estimation && s.sync.estimation.fieldLooksWrong ? `
            <div style="margin-top:14px;padding:11px 13px;border-radius:var(--radius-sm);background:var(--app-subtle);border-left:3px solid var(--risk)">
              <div class="eyebrow"><i></i>Story points are not arriving</div>
              <p style="margin:8px 0 0;font-size:12.5px">
                All ${UI.int(s.sync.estimation.total)} issues came back with <strong>no story points</strong>, which almost always means
                <code>${UI.esc(s.sync.estimation.field || 'the points field')}</code> is the wrong one — Jira often has several fields
                named "Story Points" and only one is filled in.
                ${s.sync.estimation.calibration && s.sync.estimation.calibration.counts.length ? `
                  Jira reported: ${s.sync.estimation.calibration.counts.map(c => `<code>${UI.esc(c.field)}</code> ${c.populated} populated`).join(', ')}.` : ''}
              </p>
              <p class="muted" style="font-size:11.5px;margin-top:6px">
                Until this is right, velocity, capacity and every forecast in the tool are measuring nothing.
                Set <code>jira.storyPointsField</code> in <code>config.json</code> and run a full sync.
              </p>
            </div>` : ''}
          ${(s.sync.boardErrors || []).length ? `
            <div style="margin-top:14px;padding:10px 12px;border-radius:var(--radius-sm);background:var(--app-subtle)">
              <div class="eyebrow"><i></i>Teams with no sprints</div>
              <ul class="reasons" style="margin-top:8px">
                ${s.sync.boardErrors.map(e => `<li class="${e.kind === 'error' ? 'risk' : 'warn'}"><strong>${UI.esc(e.team)}</strong> — ${UI.esc(e.message)}</li>`).join('')}
              </ul>
              <p class="muted" style="font-size:11.5px;margin-top:8px">
                These teams sync issues normally but have no sprint calendar, so their capacity, sprint and forecast
                screens stay empty. Every other team is unaffected.
              </p>
            </div>` : ''}
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="btn sm" data-act="sync-full">Full sync</button>
            <button class="btn ghost sm" data-act="sync-inc">Incremental</button>
          </div>
        </div>

        <div class="card">
          <h3>Recent activity</h3>
          <div class="sub">Every change this tool made, on disk in <code>data/audit.log</code></div>
          ${audit.length ? `<div style="max-height:280px;overflow-y:auto">${audit.map(a => `
            <div style="padding:7px 0;border-bottom:1px solid var(--app-line-soft);font-size:12px;display:flex;gap:10px">
              <span class="muted" style="flex:none;width:130px">${UI.dateTime(a.at)}</span>
              <span class="mono" style="flex:none">${UI.esc(a.action)}</span>
              <span class="muted" style="overflow:hidden;text-overflow:ellipsis">${UI.esc(JSON.stringify(a.detail || {}).slice(0, 90))}</span>
            </div>`).join('')}</div>` : '<div class="empty">Nothing yet</div>'}
        </div>
      </section>
    `;

    wire(state, mount, s);
  }


  /** One team: its board, what Jira gave it, and who Jira has seen that the roster hasn't. */
  function teamCard(t, s) {
    const jiraSprints = s.jiraSprints[t.id] || 0;
    const discovered = (s.discovered && s.discovered[t.id]) || [];
    const dormant = (s.dormant && s.dormant[t.id]) || [];
    const activeId = s.currentSprintByTeam && s.currentSprintByTeam[t.id];
    const active = activeId && s.sprints.find(x => x.id === activeId);
    const boards = s.boards || [];

    return `
      <div style="padding:16px 0;border-top:1px solid var(--app-line-soft)">
        <div class="section-head" style="margin-bottom:10px">
          <h3 style="font-size:14px">${UI.esc(t.jiraName || t.name)}</h3>
          ${t.source === 'jira' ? '<span class="tag">from Jira</span>' : ''}
          <span class="tag">${(t.members || []).filter(m => m.status !== 'Released').length} active members</span>
          ${jiraSprints ? `<span class="tag ok">${jiraSprints} sprints from Jira</span>` : '<span class="tag warn">no Jira sprints yet</span>'}
          ${active ? `<span class="tag">Active: ${UI.esc(active.name)}</span>` : ''}
          <div class="spacer"></div>
          <button class="btn ghost sm" data-remove-team="${t.id}" data-tname="${UI.esc(t.jiraName || t.name)}">Remove team</button>
        </div>

        <div class="grid-3">
          <div class="setting-row" style="border:none;padding-top:0">
            <label>Jira board</label>
            <select data-board="${t.id}">
              <option value="">— not mapped —</option>
              ${boards.map(b => `<option value="${UI.esc(b.id)}"${String(t.boardId) === String(b.id) ? ' selected' : ''}>${UI.esc(b.name)} (${UI.esc(b.type || 'board')})</option>`).join('')}
            </select>
            <div class="hint">Sprints for this team are read from this board</div>
          </div>
          <div class="setting-row" style="border:none;padding-top:0">
            <label>Sprint name keywords</label>
            <input type="text" data-keywords="${t.id}" value="${UI.esc((t.sprintKeywords || []).join(', '))}" placeholder="ruby">
            <div class="hint">Fallback matching when a board is not mapped</div>
          </div>
          <div class="setting-row" style="border:none;padding-top:0">
            <label>Jira Team field values</label>
            <input type="text" data-jirateams="${t.id}" value="${UI.esc((t.jiraTeams || []).join(', '))}" placeholder="Katalon Auto Ruby">
            <div class="hint">Used to claim backlog items</div>
          </div>
        </div>

        ${discovered.length ? `
          <div style="margin-top:12px;padding:12px 14px;border-radius:var(--radius-sm);background:var(--app-subtle)">
            <div class="eyebrow"><i></i>In Jira, not on the roster</div>
            <div class="muted" style="font-size:12px;margin:6px 0 10px">
              Adding someone gives them full default availability — about a sprint's worth of capacity — so this is a deliberate step, never automatic.
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${discovered.map(p => `
                <button class="chip" data-add-member="${t.id}" data-name="${UI.esc(p.name)}" data-account="${UI.esc(p.accountId || '')}" title="${p.issues} issues, ${p.points} pts">
                  + ${UI.esc(p.name)} <span class="muted">${p.issues} issues</span>
                </button>`).join('')}
            </div>
          </div>` : ''}

        ${dormant.length ? `
          <div class="muted" style="font-size:12px;margin-top:10px">
            No Jira activity found for: ${dormant.map(d => UI.esc(d.name)).join(', ')} — usually a display-name mismatch. Add the Jira spelling to that member's aliases in <code>plan.json</code>.
          </div>` : ''}
      </div>`;
  }

  function numField(label, id, value, step, hint) {
    return `<div style="min-width:0">
      <div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--app-fg-3);font-weight:600;margin-bottom:5px">${UI.esc(label)}</div>
      <input type="number" step="${step}" id="${id}" value="${value}" style="width:100%">
      <div class="muted" style="font-size:11px;margin-top:4px">${UI.esc(hint)}</div></div>`;
  }

  function wire(state, mount, s) {
    UI.$('#stTeam', mount).addEventListener('change', (e) => { state.teamId = e.target.value; App.refresh(); });

    const saveTeam = async (teamId, patch) => {
      await UI.jsonPut('/api/team', { teamId, ...patch });
      UI.toast('Team updated — run a sync to pull its sprints');
      App.refresh();
    };
    UI.$$('[data-board]', mount).forEach(el => el.addEventListener('change', () => saveTeam(el.dataset.board, { boardId: el.value || null })));
    UI.$$('[data-keywords]', mount).forEach(el => el.addEventListener('change', () => saveTeam(el.dataset.keywords, { sprintKeywords: el.value.split(',').map(x => x.trim()).filter(Boolean) })));
    UI.$$('[data-jirateams]', mount).forEach(el => el.addEventListener('change', () => saveTeam(el.dataset.jirateams, { jiraTeams: el.value.split(',').map(x => x.trim()).filter(Boolean) })));

    UI.$$('[data-remove-team]', mount).forEach(btn => btn.addEventListener('click', async () => {
      const name = btn.dataset.tname;
      if (!confirm(`Remove the team "${name}"?\n\nIts members, availability, support %, overrides and notes are deleted, and its board will not be rediscovered by a future sync. Issues in Jira are untouched.`)) return;
      try {
        await UI.api('/api/team', { method: 'DELETE', body: JSON.stringify({ teamId: btn.dataset.removeTeam }) });
        UI.toast(`${name} removed`);
        localStorage.removeItem('pt-team');
        location.reload();
      } catch (err) { UI.toast(err.message, true); }
    }));

    UI.$$('[data-unignore]', mount).forEach(btn => btn.addEventListener('click', async () => {
      await UI.jsonPost('/api/board/unignore', { boardId: btn.dataset.unignore });
      UI.toast('Board restored — it is a team again'); App.refresh();
    }));

    UI.$$('[data-add-member]', mount).forEach(btn => btn.addEventListener('click', async () => {
      try {
        await UI.jsonPost('/api/team/member', { teamId: btn.dataset.addMember, name: btn.dataset.name, accountId: btn.dataset.account || null });
        UI.toast(`${btn.dataset.name} added — set their availability on Capacity planning`);
        App.refresh();
      } catch (err) { UI.toast(err.message, true); }
    }));

    mount.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const v = (id) => UI.$(`#${id}`, mount).value.trim();
      try {
        btn.disabled = true;
        if (act === 'save-jira') {
          const jira = { baseUrl: v('jBase'), email: v('jEmail'), projectKey: v('jProject') };
          if (v('jToken')) jira.apiToken = v('jToken');
          await UI.jsonPut('/api/config', { jira });
          UI.toast('Jira settings saved'); App.refresh();
        } else if (act === 'save-testops') {
          const testops = { baseUrl: v('tBase'), projectIds: v('tProjects').split(',').map(x => x.trim()).filter(Boolean) };
          if (v('tKey')) testops.apiKey = v('tKey');
          await UI.jsonPut('/api/config', { testops });
          UI.toast('TestOps settings saved'); App.refresh();
        } else if (act === 'save-github') {
          const github = { repos: v('gRepos').split(',').map(x => x.trim()).filter(Boolean) };
          if (v('gToken')) github.token = v('gToken');
          await UI.jsonPut('/api/config', { github });
          UI.toast('GitHub settings saved'); App.refresh();
        } else if (act.startsWith('test-')) {
          const target = act.slice(5);
          const r = await UI.jsonPost('/api/test-connection', { target });
          UI.toast(r.as ? `Connected as ${r.as}` : `Connected — ${(r.projects || []).length} projects`);
        } else if (act === 'sync-testops' || act === 'sync-github') {
          UI.toast('Syncing…');
          await UI.jsonPost('/api/sync', { mode: act.slice(5) });
          UI.toast('Synced'); App.refresh();
        } else if (act === 'sync-full' || act === 'sync-inc') {
          UI.toast('Syncing…');
          const r = await UI.jsonPost('/api/sync', { mode: act === 'sync-full' ? 'full' : 'incremental' });
          UI.toast(`${r.issues} issues${r.allVerified === false ? ' — a dataset did not verify, check the table' : ''}`);
          App.refresh();
        } else if (act === 'save-settings') {
          const teams = s.plan.teams.map(t => t.id !== state.teamId ? t : ({
            ...t,
            settings: {
              ...t.settings,
              hoursPerDay: Number(v('cHoursDay')), hoursPerPoint: Number(v('cHoursPoint')),
              ceremonyHours: Number(v('cCeremony')), workloadOverPct: Number(v('cOver')),
              workloadUnderPct: Number(v('cUnder')), pointsPerFailingTest: Number(v('cPPF')),
            },
          }));
          await UI.jsonPut('/api/plan', { teams });
          UI.toast('Capacity model saved'); App.refresh();
        } else if (act === 'save-holidays') {
          await UI.jsonPut('/api/plan', { holidays: v('holidays').split(',').map(x => x.trim()).filter(Boolean) });
          UI.toast('Holidays saved'); App.refresh();
        } else if (act === 'add-sprints') {
          await UI.jsonPost('/api/sprints', { count: Number(v('spCount')) });
          UI.toast('Calendar extended'); App.refresh();
        } else if (act === 'import-csv') {
          const file = UI.$('#csvFile', mount).files[0];
          if (!file) return UI.toast('Choose a CSV file first', true);
          const text = await file.text();
          const r = await UI.api('/api/import/issues', { method: 'POST', body: text, raw: true });
          UI.toast(`Imported ${r.added} issues`); App.refresh();
        } else if (act === 'reconcile') {
          const r = await UI.jsonPost('/api/reconcile', {});
          UI.toast(`${r.sprints.added} sprints added, ${r.sprints.updated} updated, ${r.members.linked} members linked to Jira`);
          App.refresh();
        } else if (act === 'restore') {
          const input = UI.$('#restoreFile', mount);
          input.onchange = async () => {
            const f = input.files[0]; if (!f) return;
            if (!confirm('Restoring replaces the entire current plan — teams, sprints, availability, risks. Continue?')) return;
            await UI.jsonPost('/api/restore', JSON.parse(await f.text()));
            UI.toast('Plan restored'); App.refresh();
          };
          input.click();
        }
      } catch (err) {
        UI.toast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  return { render };
})();
