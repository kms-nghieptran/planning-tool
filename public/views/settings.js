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
          <div class="sub">First rule that matches wins, so the order <em>is</em> the meaning. This drives the work-mix split everywhere.</div>
          <div class="table-wrap rules-wrap" style="margin-top:10px">
            <table class="rules-table">
              <thead><tr><th>#</th><th>If</th><th>Operator</th><th>Value</th><th>Category</th><th class="num" title="Issues this rule wins outright — a rule shadowed by one above it shows 0">Wins</th><th></th></tr></thead>
              <tbody id="ruleRows"></tbody>
            </table>
          </div>
          <div class="btn-row">
            <button class="btn sm" data-act="rules-save">Save rules</button>
            <button class="btn ghost sm" data-act="rules-add">Add rule</button>
            <button class="btn ghost sm" data-act="rules-preview">Preview effect</button>
            <button class="btn ghost sm" data-act="rules-reset">Reset to defaults</button>
          </div>
          <div id="ruleStatus" class="muted" style="font-size:11.5px;margin-top:10px"></div>
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

    /* ── the work-categorisation rule editor ─────────────────────────────
       The draft lives in this closure, not in the DOM, and the table is drawn
       FROM the draft. Reordering is the whole point of this editor — first
       match wins, so a rule's position is its meaning — and scraping five
       controls back out of a table on every move is exactly how row 3 ends up
       wearing row 2's value. */
    const rules = (s.plan.categoryRules || s.defaultRules || []).map(r => ({ ...r }));
    const cats = Object.entries(s.categories || {}).map(([key, c]) => ({ key, label: c.label || key }));
    let counts = s.ruleHits || { byRule: {}, unmatched: 0, total: 0 };
    let custom = !!s.plan.categoryRules;
    let stale = false;   // edited since the counts on screen were computed

    const STALE = '<strong>Unsaved changes.</strong> The win counts are cleared because they belong to the rules in force, not to this draft — <em>Preview effect</em> recounts without saving.';
    const status = (html) => { UI.$('#ruleStatus', mount).innerHTML = html; };

    /* A stored rule may name a field, operator or category this build no longer
       offers. Quietly selecting the first option would rewrite his rule the next
       time he saves anything, so the unknown value stays in the list, selected
       and labelled, and fails validation loudly at save. */
    const opt = (list, cur) => {
      const items = list || [];
      const known = items.some(x => x.key === cur);
      return items.map(choice => `<option value="${UI.esc(choice.key)}"${choice.key === cur ? ' selected' : ''}>${UI.esc(choice.label)}</option>`).join('')
        + (known ? '' : `<option value="${UI.esc(cur || '')}" selected>${UI.esc(cur || '(none)')}${items.length ? ' — not recognised' : ''}</option>`);
    };

    const ruleRow = (r, i, n) => `
      <tr data-i="${i}">
        <td class="muted">${i + 1}</td>
        <td><select data-k="field" title="${UI.esc(((s.fields || []).find(f => f.key === r.field) || {}).note || '')}">${opt(s.fields, r.field)}</select></td>
        <td><select data-k="op">${opt(s.ops, r.op)}</select></td>
        <td><input type="text" data-k="value" value="${UI.esc(r.value == null ? '' : r.value)}" placeholder="e.g. Maintenance"></td>
        <td><select data-k="category">${opt(cats, r.category)}</select></td>
        <td class="num rule-wins">${stale ? '<span class="muted">—</span>'
          : `<span class="${(counts.byRule || {})[r.id] ? '' : 'muted'}">${UI.int((counts.byRule || {})[r.id] || 0)}</span>`}</td>
        <td class="rule-ops">
          <button class="btn ghost xs" data-act="rule-up" data-i="${i}" title="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
          <button class="btn ghost xs" data-act="rule-down" data-i="${i}" title="Move down"${i === n - 1 ? ' disabled' : ''}>↓</button>
          <button class="btn ghost xs" data-act="rule-del" data-i="${i}" title="Delete this rule">✕</button>
        </td>
      </tr>`;

    const drawRules = () => {
      UI.$('#ruleRows', mount).innerHTML = rules.length
        ? rules.map((r, i) => ruleRow(r, i, rules.length)).join('')
        : '<tr><td colspan="7" class="empty">No rules — every issue would classify as Other. Add one.</td></tr>';
      status(stale ? STALE
        : `Using ${custom ? '<strong>your rules</strong>' : 'the shipped defaults'} · ${UI.int(counts.total || 0)} issues classified, `
          + `<strong>${UI.int(counts.unmatched || 0)}</strong> match no rule and file under Other. A rule showing 0 is shadowed by one above it.`);
    };

    // No redraw while typing — it would steal focus mid-edit. Only the counts
    // and the status line go wrong, and both now say so.
    const markStale = () => {
      stale = true;
      UI.$$('#ruleRows .rule-wins', mount).forEach(td => { td.innerHTML = '<span class="muted">—</span>'; });
      status(STALE);
    };

    mount.addEventListener('change', (e) => {
      const ctl = e.target.closest('[data-k]');
      const rows = UI.$('#ruleRows', mount);
      if (!ctl || !rows || !rows.contains(ctl)) return;
      const i = Number(ctl.closest('tr').dataset.i);
      if (!rules[i]) return;
      rules[i][ctl.dataset.k] = ctl.value;
      markStale();
    });

    drawRules();

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
        } else if (act === 'rules-add') {
          rules.push({ id: `r${Date.now().toString(36)}`, field: 'labels', op: 'includes', value: '', category: 'maintenance' });
          stale = true; drawRules();
        } else if (act === 'rule-up' || act === 'rule-down') {
          const i = Number(btn.dataset.i), j = act === 'rule-up' ? i - 1 : i + 1;
          if (j < 0 || j >= rules.length) return;
          [rules[i], rules[j]] = [rules[j], rules[i]];
          stale = true; drawRules();
        } else if (act === 'rule-del') {
          const i = Number(btn.dataset.i), r = rules[i];
          if (!r) return;
          if (!confirm(`Delete rule ${i + 1} — ${r.field} ${r.op} "${r.value}" → ${r.category}?\n\nWork it used to claim falls through to the rules below it, or to Other. Nothing is written until you press Save rules.`)) return;
          rules.splice(i, 1);
          stale = true; drawRules();
        } else if (act === 'rules-preview') {
          const r = await UI.jsonPost('/api/category-rules/preview', { rules });
          if ((r.errors || []).length) {
            status(`<span style="color:var(--risk)">${r.errors.map(x => UI.esc(x.message)).join('<br>')}</span>`);
            return UI.toast(`${r.errors.length} problem${r.errors.length > 1 ? 's' : ''} — nothing saved`, true);
          }
          counts = r.hits; stale = false; drawRules();
          const split = Object.entries(r.mix.byCategory).filter(([, m]) => m.count)
            .map(([k, m]) => `${UI.esc((s.categories[k] || {}).label || k)} <strong>${m.share}%</strong>`).join(' · ');
          status(`Over all ${UI.int(r.hits.total)} issues this draft gives ${split} — ${UI.int(r.hits.unmatched)} match no rule. <strong>Not saved yet.</strong>`);
        } else if (act === 'rules-save') {
          try {
            await UI.jsonPut('/api/category-rules', { rules });
          } catch (err) {
            status(`<span style="color:var(--risk)">${UI.esc(err.message).split(' · ').join('<br>')}</span>`);
            throw err;
          }
          UI.toast(`${rules.length} rule${rules.length === 1 ? '' : 's'} saved — the work mix is recalculated everywhere`);
          App.refresh();
        } else if (act === 'rules-reset') {
          if (!confirm('Replace your categorisation rules with the shipped defaults?\n\nYour current rules are discarded and cannot be recovered from here.')) return;
          await UI.jsonPut('/api/category-rules', { rules: null });
          UI.toast('Back to the shipped defaults'); App.refresh();
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
