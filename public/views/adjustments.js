/* Adjustments — every field you have overridden locally, and what Jira says now.

   This screen exists because the local database is the primary source. That is
   a strong claim: it means a number on any other screen might be yours rather
   than Jira's, and there has to be one place that answers "which ones, and what
   did they used to be". Without it, "my data wins" is indistinguishable from
   "the sync is broken".

   Two states worth telling apart, and the table does:

     STILL DIFFERS — your value, Jira's value, and they disagree. The normal
     case. Your value is what every report uses.

     JIRA HAS CAUGHT UP — someone fixed it at the source and the override now
     agrees with it. The override is doing nothing; dropping it is tidy-up, not
     a decision. Those are called out so they do not accumulate forever. */

const AdjustmentsView = (() => {

  async function render(state, mount) {
    const d = await UI.api('/api/adjustments');
    const rows = d.rows || [];
    const redundant = rows.filter(r => !r.stillDiffers);
    const teams = [...new Set(rows.map(r => r.team).filter(Boolean))].sort();

    mount.innerHTML = `
      <section class="section">
        <div class="kpis">
          ${UI.kpi({
            label: 'Fields you have overridden', value: UI.int(rows.length), unit: 'fields',
            foot: rows.length ? 'A sync never overwrites any of these' : 'Nothing is overridden — every number is Jira\'s',
            tone: 'brand', featured: true,
          })}
          ${UI.kpi({
            label: 'Items affected', value: UI.int(new Set(rows.map(r => r.id)).size), unit: 'items',
            foot: teams.length ? `Across ${teams.length} team${teams.length === 1 ? '' : 's'}` : '',
          })}
          ${UI.kpi({
            label: 'Jira has caught up', value: UI.int(redundant.length), unit: 'fields',
            foot: redundant.length ? 'These overrides now agree with the source and can be dropped' : 'Every override is still doing something',
            tone: redundant.length ? 'warn' : 'ok',
          })}
        </div>
      </section>

      ${!rows.length ? `
        <section class="section">
          <div class="card">
            <h3>Nothing overridden yet</h3>
            <div class="sub">Every field on every screen is exactly what Jira last returned</div>
            <p style="margin:12px 0 0;font-size:13px">
              When a story point estimate, a component or a sprint is wrong at the source and you cannot fix it
              there in time, change it here instead. The tool keeps your value, records what Jira said, and
              protects it from every future sync — so a planning session is never undone by a sync running
              underneath it. Whatever you change shows up in this list.
            </p>
          </div>
        </section>
      ` : `
        <section class="section">
          <div class="section-head">
            <h2>Overridden fields</h2>
            <div class="section-actions">
              <label class="field inline">
                <input type="checkbox" id="adjOnlyLive">
                <span style="text-transform:none;letter-spacing:0;font-size:12px">hide the ones Jira has caught up with</span>
              </label>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th><th>Field</th>
                  <th>Your value</th><th>Jira says</th>
                  <th class="wrap">Why</th><th>Changed</th><th></th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(r => `
                  <tr data-live="${r.stillDiffers ? '1' : '0'}">
                    <td>
                      <strong>${r.entity === 'issue' ? UI.issueKey(r.id) : UI.esc(r.id)}</strong>
                      ${r.summary ? `<div class="muted" style="font-size:12px;max-width:320px">${UI.esc(r.summary)}</div>` : ''}
                    </td>
                    <td><span class="tag">${UI.esc(human(r.field))}</span></td>
                    <td><strong>${UI.esc(show(r.value))}</strong></td>
                    <td class="${r.stillDiffers ? '' : 'muted'}">
                      ${UI.esc(show(r.jiraValue))}
                      ${r.stillDiffers ? '' : '<span class="tag ok" title="The source now agrees with you — this override is doing nothing">caught up</span>'}
                    </td>
                    <td class="wrap muted" style="max-width:280px">${UI.esc(r.reason || '—')}</td>
                    <td class="muted" data-sort-value="${UI.esc(r.at || '')}" title="${UI.esc(r.at || '')}">${UI.esc(UI.ago ? UI.ago(r.at) : UI.date(r.at))}</td>
                    <td style="text-align:right">
                      <button class="btn ghost sm" data-revert="${UI.esc(r.entity)}|${UI.esc(r.id)}|${UI.esc(r.field)}"
                        title="Put this field back to what Jira says and drop the override">Use Jira's</button>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </section>
      `}

      <section class="section">
        <div class="card">
          <div class="eyebrow"><i></i>How an override behaves</div>
          <ul class="reasons" style="margin-top:10px">
            <li class="ok"><strong>Your value is the real value.</strong> Reports, the capacity grid, search and
              every aggregate read it — not Jira's. There is no screen where the two disagree.</li>
            <li class="ok"><strong>A sync can never undo one.</strong> Everything you did not override keeps
              syncing normally on the same item; only the overridden field holds.</li>
            <li><strong>Jira's value is still tracked.</strong> Each sync refreshes what the source says, so this
              table always shows the current comparison rather than a stale one.</li>
            <li><strong>"Use Jira's" is not a delete.</strong> It restores the field to the source's current
              value and removes the override. Nothing else you have entered is touched.</li>
          </ul>
        </div>
      </section>
    `;

    wire(mount);
  }

  /** Values can be numbers, nulls, or arrays of components. Show them as they read. */
  function show(v) {
    if (v === null || v === undefined) return '—';
    if (Array.isArray(v)) {
      if (!v.length) return 'none';
      return v.map(x => (x && typeof x === 'object' ? (x.name || x.id) : x)).join(', ');
    }
    if (typeof v === 'object') return v.name || JSON.stringify(v);
    return String(v);
  }

  const human = (f) => f.replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^./, c => c.toUpperCase());

  function wire(mount) {
    const only = UI.$('#adjOnlyLive', mount);
    if (only) {
      only.addEventListener('change', () => {
        UI.$$('tr[data-live]', mount).forEach(tr => {
          tr.hidden = only.checked && tr.dataset.live === '0';
        });
      });
    }

    UI.$$('[data-revert]', mount).forEach(btn => {
      btn.addEventListener('click', async () => {
        const [entity, id, field] = btn.dataset.revert.split('|');
        btn.disabled = true; btn.textContent = 'Reverting…';
        try {
          await UI.jsonDelete('/api/adjustments', { entity, id, field });
          UI.toast(`${id} · ${human(field)} is back to Jira's value`);
          App.refresh();
        } catch (e) {
          UI.toast(`Could not revert: ${e.message}`);
          btn.disabled = false; btn.textContent = 'Use Jira\'s';
        }
      });
    });
  }

  return { render };
})();
