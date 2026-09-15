/* Jira fields — which field feeds which number, decided by evidence.

   This screen exists because a name match is not enough. An instance can carry
   several fields called "Story Points" and only one is filled in; picking the
   wrong one costs every velocity, capacity and forecast figure in the tool and
   says nothing while doing it. So: probe Jira, show the fill rate, let the user
   choose from what the data says. */

const FieldsView = (() => {
  let probe = null;          // the last probe result, or null until asked
  let busy = false;
  let picker = null;         // which role's candidate list is open
  let extraSearch = '';

  async function render(state, mount) {
    const d = await UI.api('/api/jira/fields');
    paint(state, mount, d);
  }

  function paint(state, mount, d) {
    const est = d.estimation;
    const rec = probe ? probe.recommendations : null;

    mount.innerHTML = `
      ${est && est.staleField ? `
      <section class="section">
        <div class="card" style="border-left:3px solid var(--warn)">
          <div class="eyebrow"><i></i>Your pin is newer than your data</div>
          <p style="margin:8px 0 0;font-size:13.5px">
            The stored issues were pulled using <code>${UI.esc(est.staleField)}</code>, but story points are now
            pinned to <code>${UI.esc(est.field)}</code>. The pin is correct and every future sync will use it —
            the numbers on screen are simply the old ones until the issues are re-read.
          </p>
          <p class="muted" style="font-size:12.5px;margin-top:6px">
            <strong>Run a FULL sync</strong>, not an incremental one: an incremental sync only fetches what
            changed in Jira, and an issue whose estimate was always there has not changed.
          </p>
        </div>
      </section>` : ''}

      ${est && est.fieldLooksWrong && !(est && est.staleField) ? `
      <section class="section">
        <div class="card" style="border-left:3px solid var(--risk)">
          <div class="eyebrow"><i></i>This is why your points are zero</div>
          <p style="margin:8px 0 0;font-size:13.5px">
            All <strong>${UI.int(est.total)}</strong> synced issues came back with no story points, using
            <code>${UI.esc(est.field || 'no field')}</code>. Jira instances routinely carry more than one field
            called "Story Points" and only one is filled in — a name match cannot tell them apart.
          </p>
          <p class="muted" style="font-size:12.5px;margin-top:6px">
            <strong>Detect fields</strong> below samples real issues and measures which field actually holds values.
          </p>
        </div>
      </section>` : ''}

      <section class="section">
        <div class="section-head">
          <h2>Field mapping</h2>
          <span class="muted">${d.lastProbe ? `Last detected ${UI.ago(d.lastProbe)}` : 'Never detected'}</span>
          <div class="spacer"></div>
          <button class="btn sm" data-act="probe"${busy ? ' disabled' : ''}>${busy ? 'Asking Jira…' : 'Detect fields'}</button>
        </div>

        ${probe ? `<p class="muted" style="font-size:12px;margin:-4px 0 10px">
          Measured against the ${probe.sampled} most recently updated issues in ${UI.esc(state.projectKey || 'the project')}.
        </p>` : ''}

        <div class="table-wrap">
          <table>
            <thead><tr>
              <th style="min-width:150px">Used for</th><th>Field</th>
              <th class="num">Filled</th><th>Status</th><th style="min-width:150px"></th>
            </tr></thead>
            <tbody>
              ${Object.entries(d.roles).map(([role, meta]) => roleRow(role, meta, d, rec)).join('')}
            </tbody>
          </table>
        </div>
        ${picker && rec ? candidateList(picker, rec[picker]) : ''}
        <p class="muted" style="font-size:11.5px;margin-top:10px">
          A pinned field is used exactly as given. Clear it and the tool detects one on every sync instead.
          <strong>Changing any of these changes nothing until you run a full sync</strong> — the issues already on
          disk were pulled with the old mapping.
        </p>
      </section>

      <section class="section grid-2">
        <div class="card">
          <h3>Extra fields to sync</h3>
          <div class="sub">Anything else you want to filter, sort, group or export by</div>
          ${(d.extraFields || []).length ? `
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">
              ${d.extraFields.map(f => {
                const got = (d.syncedExtras || []).find(s => s.id === f.id);
                return `<span class="saved-chip">
                  <button title="${UI.esc(f.id)} — search with: ${UI.esc(f.key)}">
                    ${UI.esc(f.name)}
                    <span class="muted" style="font-size:11px">${got ? `${got.fillRate}%` : 'not synced yet'}</span>
                  </button>
                  <button class="x" data-drop-extra="${UI.esc(f.id)}" title="Stop syncing this field">×</button>
                </span>`;
              }).join('')}
            </div>
            <p class="muted" style="font-size:11.5px">
              Search them by name: ${d.extraFields.map(f => `<code>${UI.esc(f.key)}</code>`).join(', ')}.
              They also become columns and CSV headings.
            </p>`
          : '<div class="empty" style="padding:18px 0">None. Detect fields, then add any you want.</div>'}

          ${probe ? `
            <input type="text" id="exSearch" placeholder="Find a field to add…" style="width:100%;margin-top:10px" value="${UI.esc(extraSearch)}">
            <div class="facet-list" style="max-height:260px;margin-top:8px;border:1px solid var(--app-line);border-radius:var(--radius-sm)">
              ${extraCandidates(d).map(f => `
                <label class="facet-opt">
                  <input type="checkbox" data-extra="${UI.esc(f.id)}" data-name="${UI.esc(f.name)}" data-numeric="${f.numeric ? '1' : ''}"
                    ${(d.extraFields || []).some(x => x.id === f.id) ? 'checked' : ''}>
                  <span>${UI.esc(f.name)} <span class="muted" style="font-size:11px">${UI.esc(f.example || '')}</span></span>
                  <b>${f.fillRate}%</b>
                </label>`).join('') || '<div class="muted" style="padding:10px;font-size:12px">Nothing matches.</div>'}
            </div>` : `
            <p class="muted" style="font-size:12px;margin-top:10px">
              Run <strong>Detect fields</strong> to list what this Jira has, with how often each is filled in.
            </p>`}
        </div>

        <div class="card">
          <h3>Sync every field</h3>
          <div class="sub">The escape hatch when a mapping cannot be pinned down</div>
          <label class="col-opt" style="margin-top:12px;font-size:13.5px">
            <input type="checkbox" id="syncAll"${d.syncAllFields ? ' checked' : ''}>
            <span>Ask Jira for <code>*navigable</code> — every field visible on a board</span>
          </label>
          <p class="muted" style="font-size:12px;margin-top:10px">
            Guarantees nothing is missed, and costs for it: the snapshot grows several times over, syncs get slower,
            and the extra fields are stored raw rather than mapped to anything the reports understand.
          </p>
          <p class="muted" style="font-size:12px;margin-top:8px">
            Worth turning on to see what exists, then turning off once the mapping above is right. Picking the
            correct Story Points field fixes the zeros on its own — this does not replace that.
          </p>
        </div>
      </section>

      <section class="section">
        <div class="result-head">
          <div class="spacer"></div>
          <button class="btn" data-act="save"${busy ? ' disabled' : ''}>Save mapping</button>
          <button class="btn ghost sm" data-act="save-sync"${busy ? ' disabled' : ''}>Save and run a full sync</button>
        </div>
      </section>
    `;
    wire(state, mount, d);
  }

  function roleRow(role, meta, d, rec) {
    const current = d.configured[role];
    const r = rec && rec[role];
    const pinned = d.pinned[role];
    const wrong = r && r.configuredLooksWrong;
    const change = r && r.wouldChange;

    return `<tr>
      <td>
        <strong>${UI.esc(meta.label)}</strong>
        <div class="muted" style="font-size:11.5px;white-space:normal;max-width:340px">${UI.esc(meta.why)}</div>
      </td>
      <td class="mono">${current ? UI.esc(current) : '<span class="muted">not set</span>'}
        ${pinned ? '<span class="tag" style="margin-left:6px">pinned</span>' : ''}
      </td>
      <td class="num">${r && r.configuredFillRate != null ? `${r.configuredFillRate}%` : '—'}</td>
      <td style="white-space:normal;max-width:280px">
        ${!r ? '<span class="muted">not detected yet</span>'
          : wrong ? '<span class="tag risk">empty on every sampled issue</span>'
          : change ? `<span class="tag warn">${UI.esc(r.recommendedName)} is better filled</span>`
          : r.confident ? '<span class="tag ok">looks right</span>'
          : `<span class="tag warn">${UI.esc(r.reason)}</span>`}
      </td>
      <td>
        ${r && r.candidates.length ? `<button class="btn ghost sm" data-pick-role="${role}">Choose…</button>` : ''}
        ${change ? `<button class="btn sm" data-use="${role}" data-field="${UI.esc(r.recommended)}">Use ${UI.esc(r.recommendedName)}</button>` : ''}
        ${pinned ? `<button class="btn ghost sm" data-clear-role="${role}">Unpin</button>` : ''}
      </td>
    </tr>`;
  }

  function candidateList(role, r) {
    if (!r) return '';
    return `<div style="margin-top:12px;padding:12px 14px;border-radius:var(--radius-sm);background:var(--app-subtle)">
      <div class="eyebrow"><i></i>Candidates for ${UI.esc(r.label)}</div>
      <p class="muted" style="font-size:12px;margin:6px 0 10px">${UI.esc(r.reason)}</p>
      <div class="table-wrap" style="border:none">
        <table>
          <thead><tr><th>Field</th><th class="mono">Id</th><th class="num">Filled</th><th>Looks like</th><th></th></tr></thead>
          <tbody>${r.candidates.map(c => `
            <tr>
              <td><strong>${UI.esc(c.name)}</strong></td>
              <td class="mono muted">${UI.esc(c.id)}</td>
              <td class="num pct ${c.fillRate >= 50 ? 'good' : c.fillRate > 0 ? 'under' : 'over'}">${c.fillRate}%</td>
              <td class="muted">${UI.esc(c.example || '—')}</td>
              <td><button class="btn ghost sm" data-use="${role}" data-field="${UI.esc(c.id)}">Use this</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  /** Populated fields, minus the four already mapped, minus the ones we always pull. */
  function extraCandidates(d) {
    const mapped = new Set(Object.values(d.configured).filter(Boolean));
    const builtin = /^(summary|issuetype|status|assignee|reporter|labels|components|priority|resolution|created|updated|resolutiondate|duedate|parent|issuelinks|project|timeoriginalestimate|timespent)$/;
    const needle = extraSearch.toLowerCase();
    return (probe.fields || [])
      .filter(f => f.filled > 0 && !mapped.has(f.id) && !builtin.test(f.id))
      .filter(f => !needle || `${f.name} ${f.id}`.toLowerCase().includes(needle))
      .slice(0, 120);
  }

  /* ─────────────────────────── interaction ─────────────────────────── */

  function wire(state, mount, d) {
    const $ = (s) => UI.$(s, mount);
    const act = (name, fn) => { const el = $(`[data-act="${name}"]`); if (el) el.addEventListener('click', fn); };
    // Held locally so several edits can be made before one save.
    const pending = { ...d.configured };
    let extras = (d.extraFields || []).slice();

    act('probe', async () => {
      busy = true; paint(state, mount, d);
      try {
        probe = await UI.jsonPost('/api/jira/fields/probe', { sampleSize: 150 });
        const wrong = Object.values(probe.recommendations).filter(r => r.configuredLooksWrong);
        UI.toast(wrong.length
          ? `Sampled ${probe.sampled} issues — ${wrong.length} mapped field${wrong.length > 1 ? 's are' : ' is'} empty`
          : `Sampled ${probe.sampled} issues — the mapping looks right`);
      } catch (e) {
        UI.toast(e.message, true);
      } finally {
        busy = false; paint(state, mount, d);
      }
    });

    UI.$$('[data-pick-role]', mount).forEach(b => b.addEventListener('click', () => {
      picker = picker === b.dataset.pickRole ? null : b.dataset.pickRole;
      paint(state, mount, d);
    }));

    UI.$$('[data-use]', mount).forEach(b => b.addEventListener('click', async () => {
      pending[b.dataset.use] = b.dataset.field;
      await save(pending, extras, $('#syncAll').checked, { toast: `${b.dataset.use} → ${b.dataset.field}` });
    }));

    UI.$$('[data-clear-role]', mount).forEach(b => b.addEventListener('click', async () => {
      pending[b.dataset.clearRole] = '';
      await save(pending, extras, $('#syncAll').checked, { toast: 'Unpinned — it will be detected on the next sync' });
    }));

    UI.$$('[data-extra]', mount).forEach(cb => cb.addEventListener('change', () => {
      const id = cb.dataset.extra;
      if (cb.checked) {
        if (!extras.some(x => x.id === id)) extras.push({ id, name: cb.dataset.name, numeric: Boolean(cb.dataset.numeric) });
      } else {
        extras = extras.filter(x => x.id !== id);
      }
    }));

    UI.$$('[data-drop-extra]', mount).forEach(b => b.addEventListener('click', async () => {
      extras = extras.filter(x => x.id !== b.dataset.dropExtra);
      await save(pending, extras, $('#syncAll').checked, { toast: 'Removed' });
    }));

    const ex = $('#exSearch');
    if (ex) ex.addEventListener('input', e => {
      extraSearch = e.target.value;
      paint(state, mount, d);
      const again = UI.$('#exSearch', mount);
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    });

    act('save', () => save(pending, extras, $('#syncAll').checked, { toast: 'Saved' }));

    act('save-sync', async () => {
      await save(pending, extras, $('#syncAll').checked, { silent: true });
      UI.toast('Saved — syncing with the new mapping…');
      try {
        const r = await UI.jsonPost('/api/sync', { full: true });
        UI.toast(`Sync done — ${UI.int(r.issues)} issues${r.estimation && !r.estimation.fieldLooksWrong ? ', points are arriving' : ''}`);
        App.reload();
      } catch (e) { UI.toast(e.message, true); }
    });

    async function save(roles, extraList, all, { toast = null, silent = false } = {}) {
      try {
        await UI.api('/api/jira/fields', {
          method: 'PUT',
          body: JSON.stringify({ ...roles, extraFields: extraList, syncAllFields: all }),
        });
        if (!silent) UI.toast(`${toast || 'Saved'} — run a full sync to apply it`);
        if (!silent) App.refresh();
      } catch (e) { UI.toast(e.message, true); }
    }
  }

  return { render };
})();
