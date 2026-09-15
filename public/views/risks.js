/* Risks view — detected signals plus the register you keep by hand.
   Every signal states what was seen, why it matters and what to do about it. */

const RisksView = (() => {
  let filter = null;

  async function render(state, mount) {
    const d = await UI.api(`/api/risks?team=${encodeURIComponent(state.teamId)}&sprint=${encodeURIComponent(state.sprintId)}`);
    const signals = filter ? d.signals.filter(s => s.severity === filter) : d.signals;

    mount.innerHTML = `
      <section class="section">
        <div class="kpis">
          ${UI.kpi({ label: 'High', value: UI.int(d.counts.high), foot: 'Act this sprint', tone: d.counts.high ? 'risk' : 'ok' })}
          ${UI.kpi({ label: 'Medium', value: UI.int(d.counts.medium), foot: 'Plan a response', tone: d.counts.medium ? 'warn' : 'ok' })}
          ${UI.kpi({ label: 'Low', value: UI.int(d.counts.low), foot: 'Keep an eye on it' })}
          ${UI.kpi({ label: 'Register', value: UI.int(d.manual.length), foot: 'Risks you added by hand' })}
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <h2>Detected signals</h2>
          <span class="muted">Recomputed from the plan and Jira every time this page opens</span>
          <div class="spacer"></div>
          <div style="display:flex;gap:6px">
            ${['high', 'medium', 'low'].map(s => `<button class="chip${filter === s ? ' active' : ''}" data-sev="${s}">${s}</button>`).join('')}
          </div>
          <a class="btn ghost sm" href="/api/export?what=risks&team=${encodeURIComponent(state.teamId)}">Export CSV</a>
        </div>
        ${signals.length ? `<div class="grid-2">${signals.map(sigCard).join('')}</div>`
          : '<div class="card"><div class="empty">Nothing detected at this level. That is a real result, not an empty state — the checks ran.</div></div>'}
      </section>

      <section class="section">
        <div class="section-head">
          <h2>Risk register</h2>
          <span class="muted">Things the tool cannot see: dependencies, people, client commitments</span>
          <div class="spacer"></div>
          <button class="btn sm" id="addRisk">Add risk</button>
        </div>
        ${d.manual.length ? `<div class="grid-2">${d.manual.map(manualCard).join('')}</div>`
          : '<div class="card"><div class="empty">No manual risks yet.</div></div>'}
      </section>
    `;

    wire(state, mount, d);
  }

  function sigCard(s) {
    return `
      <div class="risk-card ${s.severity}">
        <div class="meta">
          <span class="tag ${s.severity === 'high' ? 'risk' : s.severity === 'medium' ? 'warn' : ''}">${s.severity}</span>
          <span class="tag">${UI.esc(s.category)}</span>
          <span class="muted" style="font-size:11.5px">${UI.esc(s.teamName)}</span>
        </div>
        <div class="title">${UI.esc(s.title)}</div>
        <div class="detail">${UI.esc(s.detail)}</div>
        <div class="action">${UI.esc(s.action)}</div>
        <div style="margin-top:10px"><button class="btn ghost sm" data-promote='${UI.esc(JSON.stringify({ title: s.title, detail: s.detail, mitigation: s.action, severity: s.severity, category: s.category, teamName: s.teamName }))}'>Add to register</button></div>
      </div>`;
  }

  function manualCard(r) {
    return `
      <div class="risk-card ${r.severity || 'low'}">
        <div class="meta">
          <span class="tag ${r.severity === 'high' ? 'risk' : r.severity === 'medium' ? 'warn' : ''}">${UI.esc(r.severity || 'low')}</span>
          ${r.category ? `<span class="tag">${UI.esc(r.category)}</span>` : ''}
          ${r.owner ? `<span class="muted" style="font-size:11.5px">${UI.esc(r.owner)}</span>` : ''}
          ${r.status ? `<span class="tag">${UI.esc(r.status)}</span>` : ''}
        </div>
        <div class="title">${UI.esc(r.title)}</div>
        ${r.detail ? `<div class="detail">${UI.esc(r.detail)}</div>` : ''}
        ${r.mitigation ? `<div class="action">${UI.esc(r.mitigation)}</div>` : ''}
        <div style="margin-top:10px;display:flex;gap:8px">
          <button class="btn ghost sm" data-edit="${r.id}">Edit</button>
          <button class="btn ghost sm" data-close="${r.id}">${r.status === 'Closed' ? 'Reopen' : 'Close'}</button>
          <button class="btn ghost sm" data-delete="${r.id}">Delete</button>
        </div>
      </div>`;
  }

  function form(existing = {}) {
    return `
      <div class="eyebrow"><i></i>Risk register</div>
      <h2 style="margin:6px 0 16px">${existing.id ? 'Edit risk' : 'Add a risk'}</h2>
      <div class="setting-row"><label>Title</label><input type="text" id="rTitle" value="${UI.esc(existing.title || '')}" placeholder="What could go wrong"></div>
      <div class="setting-row"><label>Severity</label><select id="rSeverity">${['high', 'medium', 'low'].map(s => `<option value="${s}"${existing.severity === s ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
      <div class="setting-row"><label>Category</label><input type="text" id="rCategory" value="${UI.esc(existing.category || '')}" placeholder="Dependency, People, Environment…"></div>
      <div class="setting-row"><label>Owner</label><input type="text" id="rOwner" value="${UI.esc(existing.owner || '')}"></div>
      <div class="setting-row"><label>Detail</label><textarea id="rDetail" rows="3">${UI.esc(existing.detail || '')}</textarea></div>
      <div class="setting-row"><label>Mitigation</label><textarea id="rMitigation" rows="3">${UI.esc(existing.mitigation || '')}</textarea></div>
      <div class="btn-row">
        <button class="btn" id="rSave">Save</button>
        <button class="btn ghost" id="rCancel">Cancel</button>
      </div>`;
  }

  function wire(state, mount, d) {
    UI.$$('[data-sev]', mount).forEach(b => b.addEventListener('click', () => { filter = filter === b.dataset.sev ? null : b.dataset.sev; App.refresh(); }));

    const openForm = (existing) => {
      UI.drawer(form(existing));
      UI.$('#rCancel').addEventListener('click', UI.closeDrawer);
      UI.$('#rSave').addEventListener('click', async () => {
        const body = {
          id: existing && existing.id,
          title: UI.$('#rTitle').value.trim(),
          severity: UI.$('#rSeverity').value,
          category: UI.$('#rCategory').value.trim(),
          owner: UI.$('#rOwner').value.trim(),
          detail: UI.$('#rDetail').value.trim(),
          mitigation: UI.$('#rMitigation').value.trim(),
          teamName: (existing && existing.teamName) || state.teams.find(t => t.id === state.teamId).name,
        };
        if (!body.title) return UI.toast('A risk needs a title', true);
        await UI.api('/api/risk', { method: existing && existing.id ? 'PUT' : 'POST', body: JSON.stringify(body) });
        UI.closeDrawer(); UI.toast('Risk saved'); App.refresh();
      });
    };

    UI.$('#addRisk', mount).addEventListener('click', () => openForm({}));
    UI.$$('[data-promote]', mount).forEach(b => b.addEventListener('click', () => openForm(JSON.parse(b.dataset.promote))));
    UI.$$('[data-edit]', mount).forEach(b => b.addEventListener('click', () => openForm(d.manual.find(r => r.id === b.dataset.edit))));
    UI.$$('[data-close]', mount).forEach(b => b.addEventListener('click', async () => {
      const r = d.manual.find(x => x.id === b.dataset.close);
      await UI.jsonPut('/api/risk', { id: r.id, status: r.status === 'Closed' ? 'Open' : 'Closed' });
      App.refresh();
    }));
    UI.$$('[data-delete]', mount).forEach(b => b.addEventListener('click', async () => {
      const r = d.manual.find(x => x.id === b.dataset.delete);
      if (!confirm(`Delete "${r.title}" from the register? This cannot be undone.`)) return;
      await UI.api('/api/risk', { method: 'DELETE', body: JSON.stringify({ id: r.id }) });
      UI.toast('Risk deleted'); App.refresh();
    }));
  }

  return { render };
})();
