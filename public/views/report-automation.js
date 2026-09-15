/* Automation coverage — epics bucketed by their Automation Status, and how that
   breaks down by product component.

   The definition is the one already agreed for iPipeline:
     coverage % = (Automated + Maintenance) ÷ (Automated + Maintenance + Ready + Blocked)
   Maintenance counts as covered; N/A and untriaged epics are outside the ratio and
   said so out loud rather than quietly dropped. */

const AutomationReport = (() => {
  const BUCKET_COLOR = {
    automated: 'var(--ok)',
    maintenance: 'var(--brand-pink)',
    ready: 'var(--brand-blue)',
    blocked: 'var(--warn)',
    na: 'var(--app-fg-3)',
    none: 'var(--brand-purple)',
  };
  let family = null;

  /** A component name that opens the same set in Jira this row counts. */
  function componentLink(d, name) {
    const href = UI.componentSearchUrl({ component: name, project: d.project, scope: d.scope });
    const label = `<strong>${UI.esc(name)}</strong>`;
    return href
      ? `<a class="comp-jira" href="${UI.esc(href)}" target="_blank" rel="noopener"
           title="Open the ${UI.esc(d.scope.toLowerCase())}s in ${UI.esc(name)} in Jira">${label}</a>`
      : label;
  }

  async function render(state, mount) {
    const d = await UI.api('/api/reports/automation');

    if (!d.total) {
      mount.innerHTML = `<div class="card"><div class="empty">
        No ${UI.esc(d.scope)}s in the local snapshot yet.<br><br>
        Coverage is measured on Jira ${UI.esc(d.scope)}s by their <strong>Automation Status</strong> field — run a full sync to pull them.
      </div></div>`;
      return;
    }

    const rows = family ? d.byComponent.filter(r => r.family === family) : d.byComponent;
    const bucket = (k) => d.buckets.find(b => b.key === k) || { count: 0, share: 0 };

    mount.innerHTML = `
      <section class="section">
        <div class="kpis">
          ${UI.kpi({ label: 'Coverage', value: UI.pct(d.coveragePct), foot: 'Of everything automatable', tone: 'brand', featured: true })}
          ${UI.kpi({ label: 'Of all epics', value: UI.pct(d.coverageOfAllPct), foot: `${d.covered} of ${d.total} ${UI.esc(d.scope.toLowerCase())}s` })}
          ${UI.kpi({ label: 'Automated', value: UI.int(bucket('automated').count), foot: `${UI.pct(bucket('automated').share)} of all`, tone: 'ok' })}
          ${UI.kpi({ label: 'Maintenance', value: UI.int(bucket('maintenance').count), foot: 'Automated, currently being fixed' })}
          ${UI.kpi({ label: 'Blocked', value: UI.int(bucket('blocked').count), foot: 'Cannot be automated as things stand', tone: bucket('blocked').count ? 'risk' : '' })}
        </div>
      </section>

      <section class="section grid-2">
        <div class="card">
          <h3>Status breakdown</h3>
          <div class="sub">${UI.esc(d.basis)}</div>
          <div class="mixbar">
            ${d.buckets.filter(b => b.count).map(b => `<i style="width:${b.share}%;background:${BUCKET_COLOR[b.key]}" title="${UI.esc(b.label)}: ${b.count}"></i>`).join('')}
          </div>
          <div class="mixkey">
            ${d.buckets.filter(b => b.count).map(b => `<span><i style="background:${BUCKET_COLOR[b.key]}"></i>${UI.esc(b.label)} <strong>${b.count}</strong> <span class="muted">${UI.pct(b.share)}</span></span>`).join('')}
          </div>
          ${d.caveat ? `<p class="muted" style="font-size:12px;margin-top:14px">${UI.esc(d.caveat)}</p>` : ''}
          ${d.unmappedValues.length ? `
            <div style="margin-top:12px;padding:10px 12px;border-radius:var(--radius-sm);background:var(--app-subtle)">
              <div class="eyebrow"><i></i>Unrecognised status values</div>
              <div class="muted" style="font-size:12px;margin-top:6px">
                ${d.unmappedValues.map(u => `${UI.esc(u.value)} (${u.count})`).join(', ')} — these fall into "No status set".
                A renamed Jira option shows up here instead of silently vanishing from the ratio.
              </div>
            </div>` : ''}
        </div>

        <div class="card">
          <h3>Coverage by product family</h3>
          <div class="sub">R&amp;D is product regression, PS is client delivery, KAT is framework and common</div>
          ${d.hiddenFromGrid.length ? `<p class="muted" style="font-size:11.5px;margin:-2px 0 10px">
            Product coverage only, so these totals are lower than the headline: the
            ${d.hiddenFromGrid.map(h => UI.esc(h.component)).join(' and ')} components
            (${d.hiddenFromGrid.reduce((t, h) => t + h.epics, 0)} epics) are tooling and sit outside the families.
          </p>` : ''}
          <div class="table-wrap" style="border:none">
            <table>
              <thead><tr><th>Family</th><th class="num">Comps</th><th class="num">Epics</th><th class="num">Automated</th><th class="num">Coverage</th><th style="min-width:90px"></th></tr></thead>
              <tbody>${d.byFamily.map(f => `
                <tr>
                  <td><a href="#" data-family="${UI.esc(f.family)}" title="${UI.esc(f.family)}"><strong>${UI.esc(f.family.split(' —')[0])}</strong></a></td>
                  <td class="num">${f.components}</td>
                  <td class="num">${f.total}</td>
                  <td class="num">${f.automated + f.maintenance}</td>
                  <td class="num pct ${f.coveragePct >= 80 ? 'good' : f.coveragePct < 50 ? 'over' : 'under'}">${UI.pct(f.coveragePct)}</td>
                  <td>${UI.bar(f.automated + f.maintenance, f.automatable || 1, f.coveragePct < 50 ? 'under' : '')}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <h2>Coverage by component</h2>
          <span class="muted">${rows.length} components${family ? ` in ${UI.esc(family)}` : ''}</span>
          <div class="spacer"></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="chip${family === null ? ' active' : ''}" data-family="">All</button>
            ${d.byFamily.map(f => `<button class="chip${family === f.family ? ' active' : ''}" data-family="${UI.esc(f.family)}">${UI.esc(f.family.split(' —')[0])}</button>`).join('')}
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Component</th><th>Family</th>
              <th class="num">Epics</th><th class="num">Automated</th><th class="num">Maintenance</th>
              <th class="num">Ready</th><th class="num">Blocked</th><th class="num">No status</th>
              <th class="num">Coverage</th><th style="min-width:100px"></th>
            </tr></thead>
            <tbody>${rows.map(r => `
              <tr>
                <td>${componentLink(d, r.component)}</td>
                <td class="muted">${UI.esc(r.family.split(' —')[0])}</td>
                <td class="num">${r.total}</td>
                <td class="num">${r.automated}</td>
                <td class="num">${r.maintenance}</td>
                <td class="num">${r.ready}</td>
                <td class="num ${r.blocked ? 'pct over' : ''}">${r.blocked}</td>
                <td class="num muted">${r.none || '—'}</td>
                <td class="num pct ${r.coveragePct >= 80 ? 'good' : r.coveragePct < 50 ? 'over' : 'under'}">${UI.pct(r.coveragePct)}</td>
                <td>${UI.bar(r.covered, r.automatable || 1, r.coveragePct < 50 ? 'under' : '')}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${d.hiddenFromGrid.length ? `
          <p class="muted" style="font-size:11.5px;margin-top:10px">
            Hidden from this grid as tooling rather than product coverage:
            ${d.hiddenFromGrid.map(h => `${UI.esc(h.component)} (${h.epics} epics)`).join(', ')}.
            They still count in the headline figures above.
          </p>` : ''}
      </section>

      <section class="section">
        <div class="card">
          <h3>Where the gap is</h3>
          <div class="sub">Components with the most work still to automate — ready plus blocked, biggest first</div>
          ${Charts.ranked(
            rows.map(r => ({ key: r.component, points: r.ready + r.blocked })).filter(x => x.points > 0),
            { labelKey: 'key', valueKey: 'points', unit: 'epics', color: 'var(--brand-blue)' })}
        </div>
      </section>
    `;

    mount.addEventListener('click', e => {
      const el = e.target.closest('[data-family]');
      if (!el) return;
      e.preventDefault();
      family = el.dataset.family || null;
      App.refresh();
    });
  }

  return { render };
})();
