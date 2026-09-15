/* Data sources — where every number on the other screens comes from.

   The screen exists because "we sync from Jira" is only two thirds true. The
   capacity half of this tool runs on a leave grid no tracker has a field for,
   and a team that has not filled it in is reading a forecast built from
   defaults without knowing it. So: every field, its source, and whether it is
   actually populated right now. */

const SourcesView = (() => {
  const TONE = { jira: 't-brand', csv: 't-ok', api: 't-warn', manual: 't-risk' };

  async function render(state, mount) {
    const d = await UI.api('/api/sources');
    const groups = [...new Set(d.rows.map(r => r.group))];

    mount.innerHTML = `
      <section class="section">
        <div class="kpis">
          ${UI.kpi({ label: 'Synced from Jira', value: UI.int(d.syncedFields), unit: 'fields', foot: 'Rebuilt on every sync — do not edit these locally', tone: 'brand', featured: true })}
          ${UI.kpi({ label: 'Only you can supply', value: UI.int(d.manualRequired), unit: 'fields', foot: 'No integration can fill these in' })}
          ${UI.kpi({ label: 'Not filled in', value: UI.int(d.gaps.length), unit: 'fields', foot: d.gaps.length ? 'Each one weakens a number somewhere' : 'Everything required is populated', tone: d.gaps.length ? 'warn' : 'ok' })}
        </div>
      </section>

      ${d.gaps.length ? `
      <section class="section">
        <div class="card">
          <div class="eyebrow"><i></i>Gaps worth closing</div>
          <ul class="reasons" style="margin-top:10px">
            ${d.gaps.map(g => `<li class="${g.source === 'manual' ? 'warn' : 'risk'}">
              <strong>${UI.esc(g.field)}</strong> — ${UI.esc(g.have)}.
              ${UI.esc(g.detail || '')}
            </li>`).join('')}
          </ul>
        </div>
      </section>` : ''}

      ${groups.map(g => `
        <section class="section">
          <div class="section-head"><h2>${UI.esc(g)}</h2></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Data</th><th>Comes from</th><th>Right now</th><th class="wrap">What it is</th></tr></thead>
              <tbody>
                ${d.rows.filter(r => r.group === g).map(r => `
                  <tr>
                    <td><strong>${UI.esc(r.field)}</strong>${r.optional ? ' <span class="muted" style="font-weight:400">(optional)</span>' : ''}</td>
                    <td>
                      <span class="tag ${r.source === 'jira' ? 'ok' : r.source === 'manual' ? 'warn' : ''}">${UI.esc(sourceWord(r))}</span>
                      ${r.csv ? '<span class="tag" title="A Jira CSV export can supply this when the API is unavailable">or CSV</span>' : ''}
                    </td>
                    <td class="${r.present ? '' : 'muted'}">${r.present ? UI.esc(r.have) : `<span class="tag ${r.optional ? '' : 'risk'}">${UI.esc(r.have)}</span>`}</td>
                    <td class="wrap muted" style="max-width:460px">${UI.esc(r.detail || '')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </section>`).join('')}

      ${d.integrity ? `
      <section class="section">
        <div class="card" style="border-left:3px solid var(--${d.integrity.ok ? 'ok' : 'risk'})">
          <div class="eyebrow"><i></i>Is the stored data consistent?</div>
          <h3 style="margin-top:6px">${d.integrity.ok ? 'Everything checks out' : `${d.integrity.failing.length} check${d.integrity.failing.length === 1 ? '' : 's'} failing`}</h3>
          <div class="sub">Compares the store against itself and against what the last sync recorded Jira saying — no network, so it works off VPN</div>
          <ul class="reasons" style="margin-top:12px">
            ${d.integrity.rows.map(r => `<li class="${r.ok ? 'ok' : 'risk'}">
              <strong>${UI.esc(r.name)}</strong> — ${UI.esc(r.detail)}
            </li>`).join('')}
          </ul>
        </div>
      </section>` : ''}

      <section class="section">
        <div class="card">
          <div class="eyebrow"><i></i>Where it is all stored</div>
          <h3 style="margin-top:6px">The local database</h3>
          <div class="sub">${UI.esc(storeLine(d.store))}</div>
          <div class="table-wrap" style="margin-top:12px">
            <table>
              <thead><tr><th>Holds</th><th style="text-align:right">Rows</th><th>Holds</th><th style="text-align:right">Rows</th></tr></thead>
              <tbody>${pairs(countRows(d.store)).map(([a, b]) => `
                <tr>
                  <td>${UI.esc(a[0])}</td><td style="text-align:right"><strong>${UI.int(a[1])}</strong></td>
                  <td>${b ? UI.esc(b[0]) : ''}</td><td style="text-align:right">${b ? `<strong>${UI.int(b[1])}</strong>` : ''}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <p class="muted" style="font-size:11.5px;margin-top:10px">
            Everything here came from a sync or from you. Your overrides live in their own table and are
            listed on the Adjustments screen — a sync never touches them.
          </p>
        </div>
      </section>

      <section class="section">
        <div class="card">
          <h3>Hand the data back to Jira</h3>
          <div class="sub">Drops everything a sync can rebuild — seeded rosters, locally generated sprints — and keeps everything it cannot</div>
          <p style="margin:12px 0 0;font-size:13px">
            Your leave grid, support percentages, ceremony hours, holidays, capacity constants, categorisation
            rules, work-mix targets and the people you have removed all survive. Nothing here talks to Jira: it
            clears the local copies so the next sync is the only thing that fills them.
          </p>
          <div id="resetPreview"></div>
          <div style="display:flex;gap:8px;margin-top:14px;align-items:center;flex-wrap:wrap">
            <button class="btn ghost sm" data-act="reset-preview">Preview what would change</button>
            <button class="btn sm" data-act="reset-run" hidden>Reset, then sync</button>
            <label class="field inline" style="margin-left:4px"><input type="checkbox" id="resetSnap"> <span style="text-transform:none;letter-spacing:0;font-size:12px">also discard the synced issues</span></label>
          </div>
          <p class="muted" style="font-size:11.5px;margin-top:10px">A timestamped backup of the whole plan is written first, and named in the result.</p>
        </div>
      </section>
    `;

    wire(state, mount);
  }

  /** One line about the store: size, schema version, and how it came to exist. */
  function storeLine(store) {
    if (!store) return 'Not reported';
    const mb = (store.bytes / 1e6).toFixed(1);
    const m = store.migration || {};
    const how = m.imported
      ? `imported from your JSON files${m.verification && m.verification.ok ? ', verified row for row' : ''}`
      : 'already in place';
    return `${mb} MB · schema v${store.version} · ${how}`;
  }

  /** Only the tables that hold something, named the way the app talks about them. */
  function countRows(store) {
    const LABEL = {
      issue: 'Work items', issue_component: 'Item ↔ component', issue_label: 'Item ↔ label',
      issue_sprint: 'Item ↔ sprint', issue_link: 'Issue links (blocked-by, relates-to)', board: 'Boards',
      sprint: 'Jira sprints', sprint_team: 'Sprint ↔ team', person: 'People seen in Jira',
      team: 'Teams', team_member: 'Team members', team_excluded: 'People you removed',
      calendar_sprint: 'Planning sprints', calendar_sprint_team: 'Sprint ↔ team mapping',
      availability: 'Leave grid rows', support_pct: 'Support %', ceremony: 'Ceremony hours',
      plan_override: 'Manual overrides', plan_note: 'Sprint notes', holiday: 'Holidays',
      risk: 'Risks', saved_search: 'Saved searches', setting: 'Settings',
      adjustment: 'Your adjustments', sync_run: 'Sync history',
    };
    return Object.entries((store && store.counts) || {})
      .filter(([t, n]) => n > 0 && t !== 'schema_version')
      .map(([t, n]) => [LABEL[t] || t, n]);
  }

  const pairs = (list) => list.reduce((acc, x, i) => (i % 2 ? acc[acc.length - 1].push(x) : acc.push([x]), acc), []);

  function sourceWord(r) {
    return r.source === 'jira' ? 'Jira' : r.source === 'manual' ? 'You' : r.source === 'csv' ? 'CSV' : (r.via || 'API');
  }

  function wire(state, mount) {
    const box = UI.$('#resetPreview', mount);
    const runBtn = UI.$('[data-act="reset-run"]', mount);

    UI.$('[data-act="reset-preview"]', mount).addEventListener('click', async () => {
      const r = await UI.jsonPost('/api/reset', { mode: 'keep-capacity' });
      box.innerHTML = `
        <div style="margin-top:14px;padding:12px 14px;border-radius:var(--radius-sm);background:var(--app-subtle)">
          <div class="eyebrow"><i></i>Dry run — nothing has changed</div>
          <div class="grid-2" style="margin-top:10px">
            <div>
              <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--app-fg-3);font-weight:600">Would remove</div>
              <ul class="reasons" style="margin-top:6px">
                ${entries(r.removed).map(([k, v]) => `<li class="warn">${UI.esc(human(k))}: <strong>${v}</strong></li>`).join('') || '<li>Nothing</li>'}
              </ul>
            </div>
            <div>
              <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--app-fg-3);font-weight:600">Would keep</div>
              <ul class="reasons" style="margin-top:6px">
                ${entries(r.kept).map(([k, v]) => `<li class="ok">${UI.esc(human(k))}: <strong>${typeof v === 'object' ? Object.entries(v).map(([t, c]) => `${t} ${c}`).join(', ') : v}</strong></li>`).join('')}
              </ul>
            </div>
          </div>
        </div>`;
      runBtn.hidden = false;
    });

    runBtn.addEventListener('click', async () => {
      if (!confirm('Reset the local plan so Jira is the only source for teams, people, sprints and backlog?\n\nYour leave grid, support %, ceremony hours, holidays and capacity constants are kept. A backup is written first.')) return;
      runBtn.disabled = true; runBtn.textContent = 'Resetting…';
      try {
        const r = await UI.jsonPost('/api/reset', {
          mode: 'keep-capacity', confirm: true,
          clearSnapshot: UI.$('#resetSnap', mount).checked,
        });
        UI.toast(`Reset done — backup at ${String(r.backup || '').split('/').pop()}. Run a sync to repopulate.`);
        App.refresh();
      } catch (e) {
        UI.toast(`Reset failed: ${e.message}`);
        runBtn.disabled = false; runBtn.textContent = 'Reset, then sync';
      }
    });
  }

  const entries = (o) => Object.entries(o || {}).filter(([, v]) => v && (typeof v !== 'object' || Object.keys(v).length));
  const human = (k) => k
    .replace(/([A-Z])/g, ' $1').toLowerCase()
    .replace(/^./, c => c.toUpperCase());

  return { render };
})();
