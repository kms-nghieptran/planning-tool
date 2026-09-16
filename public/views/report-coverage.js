/* Coverage — automation status for one component at a time.

   Three questions, in the order a lead asks them:
     1. What state is this suite in?              → the status breakdown
     2. Which suites are behind?                  → coverage by component (All only)
     3. How much of each has moved to TrueTest?   → TrueTest vs KSE

   The ratio is the one already agreed for iPipeline and is NOT redefined here:
     coverage % = (Automated + Maintenance) ÷ (Automated + Maintenance + Ready + Blocked)
   Obsoleted, N/A and untriaged epics sit outside it and are shown anyway, because
   a number you cannot see the exclusions of is a number you cannot argue with. */

const CoverageReport = (() => {
  const BUCKET_COLOR = {
    automated: 'var(--ok)',
    maintenance: 'var(--brand-pink)',
    ready: 'var(--brand-blue)',
    blocked: 'var(--warn)',
    na: 'var(--app-fg-3)',
    obsoleted: 'var(--app-fg-3)',
    none: 'var(--brand-purple)',
  };
  const TOOL_COLOR = { truetest: 'var(--brand-blue)', kse: 'var(--brand-purple)' };

  // Selection lives in the module, not in the URL: this screen is a lens on one
  // dataset rather than a place you deep-link to, and App.refresh() re-renders
  // from scratch each time.
  let component = null;
  let family = null;

  const tone = (p) => (p >= 80 ? 'good' : p < 50 ? 'over' : 'under');

  async function render(state, mount) {
    const d = await UI.api(`/api/reports/coverage${component ? `?component=${encodeURIComponent(component)}` : ''}`);

    if (!d.total && !d.components.length) {
      mount.innerHTML = `<div class="card"><div class="empty">
        No ${UI.esc(d.scope)}s in the local store yet.<br><br>
        Coverage is read off each ${UI.esc(d.scope)}'s <strong>Automation Status</strong> field — run a full sync to pull them.
      </div></div>`;
      return;
    }

    // Order and labels come from the payload once, so the per-tool tables and
    // the headline cannot drift into different bucket names or a different order.
    BUCKETS_ORDER = d.buckets.map(b => b.key);
    BUCKET_META = Object.fromEntries(d.buckets.map(b => [b.key, b]));

    const bucket = (k) => d.buckets.find(b => b.key === k) || { count: 0, share: 0 };
    const rows = family ? d.byComponent.filter(r => r.family === family) : d.byComponent;
    const toolRows = family ? d.byTool.filter(r => r.family === family) : d.byTool;

    mount.innerHTML = `
      ${picker(d)}

      <section class="section">
        <div class="kpis">
          ${UI.kpi({ label: 'Coverage', value: UI.pct(d.coveragePct), foot: d.component ? UI.esc(d.component) : 'Across every component', tone: 'brand', featured: true })}
          ${UI.kpi({ label: 'Automated', value: UI.int(bucket('automated').count), foot: `${UI.pct(bucket('automated').share)} of all ${UI.esc(d.scope.toLowerCase())}s`, tone: 'ok' })}
          ${UI.kpi({ label: 'Maintenance', value: UI.int(bucket('maintenance').count), foot: 'Automated, being kept working' })}
          ${UI.kpi({ label: 'Still to automate', value: UI.int(bucket('ready').count + bucket('blocked').count), foot: `${bucket('ready').count} ready · ${bucket('blocked').count} blocked`, tone: bucket('blocked').count ? 'risk' : '' })}
          ${UI.kpi({ label: 'On TrueTest', value: UI.pct(share(d)), foot: `${UI.int(d.toolTotals.truetest.total)} of ${UI.int(d.total)} ${UI.esc(d.scope.toLowerCase())}s` })}
        </div>
      </section>

      ${statusSection(d)}
      ${d.component ? '' : componentSection(d, rows)}
      ${toolSection(d, toolRows)}
    `;

    mount.addEventListener('click', (e) => {
      const f = e.target.closest('[data-family]');
      if (f) { e.preventDefault(); family = f.dataset.family || null; App.refresh(); return; }
      // Expanding a component's tool breakdown is a DOM toggle, not a refresh:
      // re-rendering would collapse every other row you had already opened.
      const x = e.target.closest('[data-expand]');
      if (x) {
        e.preventDefault();
        const row = UI.$(`tr[data-detail="${CSS.escape(x.dataset.expand)}"]`, mount);
        if (row) { row.hidden = !row.hidden; x.textContent = row.hidden ? '▸' : '▾'; }
        return;
      }
      // The picker's own options are handled on mousedown; this covers Clear
      // and the component links in the tables.
      const c = e.target.closest('[data-component]');
      if (c && !c.classList.contains('combo-opt')) {
        e.preventDefault();
        component = c.dataset.component || null;
        family = null;
        App.refresh();
      }
    });

    UI.wireCombo(mount, 'covSearch', (value) => {
      component = value || null;
      family = null;
      App.refresh();
    });
  }

  const share = (d) => (d.total ? Math.round((d.toolTotals.truetest.total / d.total) * 1000) / 10 : 0);

  /**
   * A component name, as the thing you click.
   *
   * The NAME opens Jira filtered to that component — the same project and the
   * same issue type this screen counts, so the list that opens matches the
   * number beside it. The ⌖ beside it narrows THIS screen instead, which is
   * what the name used to do; it stays because the grid's whole job is
   * "which suite is behind, let me look at it".
   *
   * `— no component —` is not a name in Jira, so it searches `component IS
   * EMPTY` rather than linking to a component that does not exist.
   */
  function componentCell(d, name) {
    const real = name !== NO_COMPONENT;
    const href = UI.componentSearchUrl({ component: real ? name : null, project: d.project, scope: d.scope });
    const label = `<strong>${UI.esc(name)}</strong>`;
    return `
      <div class="comp-cell">
        ${href
          ? `<a href="${UI.esc(href)}" target="_blank" rel="noopener" class="comp-jira"
               title="Open the ${UI.esc(d.scope.toLowerCase())}s in ${UI.esc(real ? name : 'no component')} in Jira">${label}</a>`
          : label}
        <button class="comp-filter" data-component="${UI.esc(name)}"
          title="Narrow this screen to ${UI.esc(name)}" aria-label="Filter this screen to ${UI.esc(name)}">⌖</button>
      </div>`;
  }

  /** The bucket the model uses for epics with no product component. */
  const NO_COMPONENT = '— no component —';

  /* ── the component selector ───────────────────────────────────────── */

  /**
   * The component picker, built on the shared `UI.combo`.
   *
   * It started here, for 125 components a native <select> could not search;
   * the team and sprint pickers then wanted the same thing, so the control
   * moved into ui.js and this is now one caller of three. Behaviour — DOM
   * filtering, mousedown selection, keyboard nav — lives there.
   */
  function picker(d) {
    return `
      <section class="section">
        <div class="card picker-card">
          ${UI.combo({
            id: 'covSearch', label: 'Component',
            value: d.component || '',
            placeholder: `All components (${d.components.length}) — type to search`,
            options: [
              { value: '', label: 'All components', meta: String(d.components.length), active: !d.component },
              ...d.components.map(c => ({
                value: c.name, label: c.name, meta: String(c.count),
                tag: c.family.split(' —')[0], active: d.component === c.name,
              })),
            ],
          })}
          <div class="picker-note">
            <div class="muted" style="font-size:12px">${UI.esc(d.basis)}</div>
            ${d.componentUnknown ? `<div class="tag warn" style="margin-top:6px">
              No component named "${UI.esc(d.componentRequested)}" — showing all instead
            </div>` : ''}
          </div>
          ${d.component ? `
            <a class="btn ghost sm" target="_blank" rel="noopener"
               href="${UI.esc(UI.componentSearchUrl({ component: d.component, project: d.project, scope: d.scope }) || '#')}"
               title="Open the ${UI.esc(d.scope.toLowerCase())}s in ${UI.esc(d.component)} in Jira">Open in Jira</a>
            <button class="btn ghost sm" data-component="">Clear</button>` : ''}
        </div>
      </section>`;
  }

  /* ── 1. overall automation status ─────────────────────────────────── */

  function statusSection(d) {
    const shown = d.buckets.filter(b => b.count);
    return `
      <section class="section grid-2">
        <div class="card">
          <h3>Overall automation status</h3>
          <div class="sub">${d.component ? `${UI.esc(d.component)} · ` : ''}${UI.int(d.total)} ${UI.esc(d.scope.toLowerCase())}s by their Automation Status</div>
          <div class="mixbar">
            ${shown.map(b => `<i style="width:${b.share}%;background:${BUCKET_COLOR[b.key]}" title="${UI.esc(b.label)}: ${b.count}"></i>`).join('')}
          </div>
          <div class="table-wrap" style="border:none;margin-top:14px">
            <table>
              <thead><tr><th>Status</th><th class="num">${UI.esc(d.scope)}s</th><th class="num">Share</th><th>In the ratio</th></tr></thead>
              <tbody>${d.buckets.map(b => `
                <tr${b.count ? '' : ' class="muted"'}>
                  <td><span class="tag"><i class="dot" style="background:${BUCKET_COLOR[b.key]}"></i>${UI.esc(b.label)}</span></td>
                  <td class="num"><strong>${UI.int(b.count)}</strong></td>
                  <td class="num muted">${UI.pct(b.share)}</td>
                  <td class="muted" style="font-size:12px">${b.inRatio
                    ? (b.covered ? 'Counts as covered' : 'In the denominator')
                    : 'Outside the ratio'}</td>
                </tr>`).join('')}
              </tbody>
              <tfoot><tr>
                <td><strong>Total</strong></td>
                <td class="num"><strong>${UI.int(d.total)}</strong></td>
                <td colspan="2" class="muted" style="font-size:12px">
                  ${UI.int(d.covered)} covered of ${UI.int(d.automatable)} automatable
                </td>
              </tr></tfoot>
            </table>
          </div>
        </div>

        <div class="card">
          <h3>What sits outside the number</h3>
          <div class="sub">Coverage is ${UI.pct(d.coveragePct)} of what can be automated, not of everything</div>
          <ul class="reasons" style="margin-top:10px">
            <li class="ok"><strong>${UI.int(d.covered)}</strong> automated or under maintenance — maintenance still counts as covered, it is automated and being fixed.</li>
            <li><strong>${UI.int(bucketCount(d, 'na'))}</strong> N/A for Automation — out of scope by definition, so out of the denominator.</li>
            <li${d.obsoleted ? '' : ' class="muted"'}><strong>${UI.int(d.obsoleted)}</strong> Obsoleted — no Automation Status and labelled <code>obsolete</code>. Retired, not waiting on anyone.</li>
            <li${d.untriaged ? ' class="warn"' : ' class="muted"'}><strong>${UI.int(d.untriaged)}</strong> with no status and no obsolete label — genuinely untriaged, and the one number here worth acting on.</li>
          </ul>
          ${d.unmappedValues.length ? `
            <div style="margin-top:14px;padding:10px 12px;border-radius:var(--radius-sm);background:var(--app-subtle)">
              <div class="eyebrow"><i></i>Unrecognised status values</div>
              <div class="muted" style="font-size:12px;margin-top:6px">
                ${d.unmappedValues.map(u => `${UI.esc(u.value)} (${u.count})`).join(', ')} — counted as "No Status".
                A renamed Jira option shows up here rather than vanishing from the ratio.
              </div>
            </div>` : ''}
        </div>
      </section>`;
  }

  const bucketCount = (d, k) => (d.buckets.find(b => b.key === k) || {}).count || 0;

  /* ── 2. coverage by component, when nothing is selected ───────────── */

  function componentSection(d, rows) {
    return `
      <section class="section">
        <div class="section-head">
          <h2>Coverage by component</h2>
          <span class="muted">${rows.length} of ${d.byComponent.length}</span>
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
              <th class="num">${UI.esc(d.scope)}s</th>
              <th class="num">Automated</th><th class="num">Maint.</th>
              <th class="num">Ready</th><th class="num">Blocked</th>
              <th class="num">N/A</th><th class="num">Obsolete</th><th class="num">No status</th>
              <th class="num">Coverage</th><th style="min-width:90px"></th>
            </tr></thead>
            <tbody>${rows.map(r => `
              <tr>
                <td>${componentCell(d, r.component)}</td>
                <td class="muted">${UI.esc(r.family.split(' —')[0])}</td>
                <td class="num">${r.total}</td>
                <td class="num">${r.automated}</td>
                <td class="num">${r.maintenance}</td>
                <td class="num">${r.ready}</td>
                <td class="num ${r.blocked ? 'pct over' : ''}">${r.blocked}</td>
                <td class="num muted">${r.na || '—'}</td>
                <td class="num muted">${r.obsoleted || '—'}</td>
                <td class="num ${r.none ? 'pct under' : 'muted'}">${r.none || '—'}</td>
                <td class="num pct ${tone(r.coveragePct)}">${UI.pct(r.coveragePct)}</td>
                <td>${UI.bar(r.covered, r.automatable || 1, r.coveragePct < 50 ? 'under' : '')}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <p class="muted" style="font-size:11.5px;margin-top:10px">
          An ${UI.esc(d.scope.toLowerCase())} with two product components counts in both, so this column adds up to more
          than ${UI.int(d.total)}. Picking one component per ${UI.esc(d.scope.toLowerCase())} would under-report every suite that shares work.
          Click a component to narrow the whole screen to it.
        </p>
      </section>`;
  }

  /* ── 3. TrueTest vs KSE ───────────────────────────────────────────── */

  /**
   * ONE TOOL'S STATUS BREAKDOWN, as a column of counts.
   *
   * The summary row above says TrueTest has 318 epics at 95% coverage. It does
   * not say whether the rest are Ready, Blocked or simply untriaged — which is
   * the difference between "queue some work" and "go and triage". Same seven
   * buckets as the headline, so the two read the same way.
   */
  function toolColumn(t, row, total) {
    return `
      <div class="tool-col">
        <div class="eyebrow"><i style="background:${TOOL_COLOR[t.key]}"></i>${UI.esc(t.label)}</div>
        <div style="display:flex;align-items:baseline;gap:8px;margin:6px 0 10px">
          <span style="font-size:26px;font-weight:800;line-height:1">${UI.int(row.total)}</span>
          <span class="muted" style="font-size:12px">
            ${UI.pct(total ? Math.round((row.total / total) * 1000) / 10 : 0)} of the component ·
            ${row.automatable ? `${UI.pct(row.coveragePct)} covered` : 'nothing automatable'}
          </span>
        </div>
        <table>
          <tbody>${BUCKETS_ORDER.map(k => {
            const b = bucketMeta(k);
            return `
            <tr${row[k] ? '' : ' class="muted"'}>
              <td><span class="tag"><i class="dot" style="background:${BUCKET_COLOR[k]}"></i>${UI.esc(b.label)}</span></td>
              <td class="num"><strong>${UI.int(row[k])}</strong></td>
              <td class="num muted">${UI.pct(row.total ? Math.round((row[k] / row.total) * 1000) / 10 : 0)}</td>
            </tr>`;
          }).join('')}
          </tbody>
          <tfoot><tr>
            <td><strong>Total</strong></td>
            <td class="num"><strong>${UI.int(row.total)}</strong></td>
            <td></td>
          </tr></tfoot>
        </table>
      </div>`;
  }

  /** Bucket order and labels come from the payload, so they cannot drift apart. */
  let BUCKETS_ORDER = [];
  let BUCKET_META = {};
  const bucketMeta = (k) => BUCKET_META[k] || { label: k };

  /** The two tools side by side, for whatever scope is in view. */
  function toolBreakdown(d, row, heading, sub) {
    return `
      <div class="card" style="margin-bottom:16px">
        <h3>${UI.esc(heading)}</h3>
        <div class="sub">${UI.esc(sub)}</div>
        <div style="display:flex;gap:26px;flex-wrap:wrap;margin-top:12px">
          ${d.tools.map(t => toolColumn(t, row[t.key], row.total)).join('')}
        </div>
      </div>`;
  }

  function toolSection(d, rows) {
    const tt = d.toolTotals.truetest, kse = d.toolTotals.kse;
    const whole = { ...d.toolTotals, total: d.total };
    return `
      <section class="section">
        <div class="section-head">
          <h2>TrueTest vs KSE</h2>
          <span class="muted">${d.component ? UI.esc(d.component) : `${rows.length} components`}</span>
        </div>

        <div class="card" style="margin-bottom:16px">
          <div class="mixbar">
            <i style="width:${share(d)}%;background:${TOOL_COLOR.truetest}" title="TrueTest: ${tt.total}"></i>
            <i style="width:${100 - share(d)}%;background:${TOOL_COLOR.kse}" title="KSE: ${kse.total}"></i>
          </div>
          <div class="mixkey">
            <span><i style="background:${TOOL_COLOR.truetest}"></i>TrueTest <strong>${UI.int(tt.total)}</strong> <span class="muted">${UI.pct(share(d))} · ${UI.pct(tt.coveragePct)} covered</span></span>
            <span><i style="background:${TOOL_COLOR.kse}"></i>KSE <strong>${UI.int(kse.total)}</strong> <span class="muted">${UI.pct(100 - share(d))} · ${UI.pct(kse.coveragePct)} covered</span></span>
          </div>
          <p class="muted" style="font-size:11.5px;margin-top:12px">
            The tool is read from the ${UI.esc(d.scope.toLowerCase())}'s component: <code>TrueTest</code> or <code>Katalon</code>.
            ${d.untagged ? `<strong>${UI.int(d.untagged)}</strong> (${UI.pct(d.untaggedPct)}) carry neither and are counted as KSE —
            those components were introduced with the TrueTest rollout, so work without one predates it.
            That is an assumption, and it is the number to watch if it stops holding.` : 'Every one names a tool.'}
          </p>
        </div>

        ${toolBreakdown(d, whole,
          d.component ? `Automation status by tool — ${d.component}` : 'Automation status by tool',
          d.component
            ? 'The same seven buckets, split by where the work runs'
            : 'Across every component. Pick one above, or open a row below, to see it per component.')}

        ${d.component ? '' : `
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th style="width:22px"></th>
              <th>Component</th>
              <th class="num">${UI.esc(d.scope)}s</th>
              <th class="num">TrueTest</th><th class="num">TT coverage</th>
              <th class="num">KSE</th><th class="num">KSE coverage</th>
              <th style="min-width:120px">Split</th>
              <th class="num">Untagged</th>
            </tr></thead>
            <tbody>${rows.map(r => `
              <tr>
                <td><button class="btn ghost sm" data-expand="${UI.esc(r.component)}"
                    title="Automation status for TrueTest and KSE in ${UI.esc(r.component)}"
                    aria-label="Show the status breakdown for ${UI.esc(r.component)}"
                    style="padding:0 6px">▸</button></td>
                <td>${componentCell(d, r.component)}</td>
                <td class="num">${r.total}</td>
                <td class="num">${r.truetest.total || '—'}</td>
                <td class="num ${r.truetest.automatable ? `pct ${tone(r.truetest.coveragePct)}` : 'muted'}">${r.truetest.automatable ? UI.pct(r.truetest.coveragePct) : '—'}</td>
                <td class="num">${r.kse.total || '—'}</td>
                <td class="num ${r.kse.automatable ? `pct ${tone(r.kse.coveragePct)}` : 'muted'}">${r.kse.automatable ? UI.pct(r.kse.coveragePct) : '—'}</td>
                <td>
                  <div class="mixbar" style="height:8px" data-sort-value="${r.truetestShare}">
                    <i style="width:${r.truetestShare}%;background:${TOOL_COLOR.truetest}" title="TrueTest ${r.truetest.total}"></i>
                    <i style="width:${100 - r.truetestShare}%;background:${TOOL_COLOR.kse}" title="KSE ${r.kse.total}"></i>
                  </div>
                </td>
                <td class="num muted" title="Carry neither component, counted as KSE">${r.untagged || '—'}</td>
              </tr>
              <tr class="detail-row" data-detail="${UI.esc(r.component)}" hidden>
                <td colspan="9" style="padding:0">
                  ${toolBreakdown(d, r, `${r.component} — automation status by tool`,
                    `${r.total} ${d.scope.toLowerCase()}s · ${r.truetest.total} on TrueTest, ${r.kse.total} on KSE`)}
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <p class="muted" style="font-size:11.5px;margin-top:10px">
          Each ${UI.esc(d.scope.toLowerCase())} lands in exactly one tool, so unlike the grid above these two columns
          add up to the component's total. A coverage cell reads "—" when nothing in that
          half is automatable yet. Use ▸ to open a component's full status breakdown without leaving the list.
        </p>`}
      </section>`;
  }

  return { render };
})();
