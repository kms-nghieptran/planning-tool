/* Coverage — automation status for one component at a time.

   Four questions, in the order a lead asks them:
     1. What state is this suite in?              → the status breakdown
     2. Which suites are behind?                  → coverage by component (All only)
     3. How much of each has moved to TrueTest?   → TrueTest vs KSE
     4. So what should I be doing about it?       → major risks & attention

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
  // The movement window, in days. Module state like the two above: this screen
  // is a lens on one dataset, not a place you deep-link to.
  let days = 180;

  const tone = (p) => (p >= 80 ? 'good' : p < 50 ? 'over' : 'under');

  async function render(state, mount) {
    const qs = component ? `?component=${encodeURIComponent(component)}` : '';
    // In parallel: the movement query walks a different table and there is no
    // reason for the reader to wait for one before the other starts.
    const [d, moved] = await Promise.all([
      UI.api(`/api/reports/coverage${qs}`),
      UI.api(`/api/reports/coverage/movement${qs}${qs ? '&' : '?'}days=${days}`).catch(() => null),
    ]);

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
      ${movementSection(d, moved)}
      ${d.component ? '' : componentSection(d, rows)}
      ${toolSection(d, toolRows)}
      ${attentionSection(d)}
    `;

    mount.addEventListener('click', async (e) => {
      const w = e.target.closest('[data-days]');
      if (w) { e.preventDefault(); days = Number(w.dataset.days) || 180; App.refresh(); return; }

      const bf = e.target.closest('[data-act="backfill"]');
      if (bf) {
        e.preventDefault();
        // Minutes, not seconds: it reads every epic's changelog out of Jira.
        // Saying so beats a button that looks broken while it works.
        bf.disabled = true;
        UI.toast('Reading Jira transition history — this takes a minute…');
        try {
          const r = await UI.jsonPost('/api/reports/coverage/backfill', { weeks: 26 });
          UI.toast(`${r.withHistory} of ${r.epics} ${UI.esc('')}had transitions · ${r.dates} dates reconstructed`
            + (r.truncated ? ` · ${r.truncated} had more history than Jira returned` : ''));
          App.refresh();
        } catch (err) {
          UI.toast(err.message, true);
          bf.disabled = false;
        }
        return;
      }

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

  /* ── 1b. coverage movement ────────────────────────────────────────── */

  /**
   * HOW COVERAGE HAS MOVED — the one question this screen could not answer.
   *
   * Everything else here is a photograph. "Are we getting better?" needs two
   * photographs, and until now the store kept only the latest: a sync overwrote
   * each epic's Automation Status and the previous value was gone. There was no
   * reconstructing it either — only a third of the automated epics carry a
   * resolution date, so two thirds of any curve would have been invented.
   *
   * So the history is now recorded on every sync, and Jira's own transition
   * history can be replayed to fill in the past. Both are shown, and which is
   * which is visible: an observed reading is a solid dot, a reconstructed one
   * is hollow. That distinction is the whole reason this section can be quoted
   * in a status report without a caveat attached by hand.
   *
   * MOVEMENT IS IN PERCENTAGE POINTS. 50% to 55% is "+5 points", never "+10%".
   */
  function movementSection(d, m) {
    const windows = [30, 90, 180, 365];
    const head = `
      <div class="section-head" style="margin-bottom:4px">
        <h3>Coverage movement</h3>
        <div class="spacer"></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${windows.map(w => `<button class="chip${days === w ? ' active' : ''}" data-days="${w}">${w >= 365 ? '1 year' : `${w}d`}</button>`).join('')}
        </div>
      </div>`;

    if (!m || !m.hasTrend) return `
      <section class="section">
        <div class="card wide">
          ${head}
          <div class="sub">${d.component ? `${UI.esc(d.component)} · ` : ''}Coverage over time, once there are two readings to compare</div>
          <div style="margin-top:12px;padding:12px 14px;border-radius:var(--radius-sm);background:var(--app-subtle)">
            <div class="eyebrow"><i></i>${(m && m.points || []).length ? 'One reading so far' : 'No history yet'}</div>
            <p style="margin:8px 0 0;font-size:12.5px;line-height:1.5">
              Nothing in this tool remembered what coverage <em>was</em> — a sync overwrites each
              ${UI.esc(d.scope.toLowerCase())}'s Automation Status and the old value is gone, and it could not be
              worked out backwards either: only a third of the automated ${UI.esc(d.scope.toLowerCase())}s carry a
              resolution date to place them by.
            </p>
            <p style="margin:8px 0 0;font-size:12.5px;line-height:1.5">
              From now on <strong>every sync records one</strong>${(m && m.points || []).length
                ? ` — the first is ${UI.esc(m.points[0].at)}. A second one and this becomes a chart.`
                : '. Run a sync and this starts filling in.'}
              To have it now instead, <strong>Backfill from Jira</strong> replays each
              ${UI.esc(d.scope.toLowerCase())}'s Automation Status transitions and reconstructs the past six months.
            </p>
            <div class="btn-row">
              <button class="btn sm" data-act="backfill">Backfill from Jira history</button>
            </div>
            <p class="muted" style="font-size:11.5px;margin:10px 0 0">
              A reconstruction places each ${UI.esc(d.scope.toLowerCase())} by Jira's own transition dates, but reads
              today's components and labels — so a suite something moved between is right in total and can be wrong
              per component. It never overwrites a reading this tool took itself.
            </p>
          </div>
        </div>
      </section>`;

    const up = m.deltaPct > 0, flat = m.deltaPct === 0;
    const arrow = flat ? '→' : up ? '↑' : '↓';
    const moved = m.buckets.filter(b => b.delta).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const rows = family ? (m.movers || []).filter(r => r.family === family) : (m.movers || []);

    return `
      <section class="section">
        <div class="card wide">
          ${head}
          <div class="sub">
            ${d.component ? `${UI.esc(d.component)} · ` : 'Across every component · '}
            ${UI.esc(m.span.from)} → ${UI.esc(m.span.to)} · ${m.span.readings} readings
          </div>

          <div class="move-head">
            <div class="move-delta ${flat ? '' : up ? 'up' : 'down'}">
              <span class="move-arrow">${arrow}</span>
              <span class="move-value">${flat ? 'no change' : `${up ? '+' : ''}${m.deltaPct}`}</span>
              ${flat ? '' : '<small>points</small>'}
            </div>
            <div class="move-from">
              ${UI.pct(m.from.coveragePct)} <span class="muted">on ${UI.esc(m.from.at)}</span>
              &nbsp;→&nbsp; <strong>${UI.pct(m.to.coveragePct)}</strong> <span class="muted">today</span>
            </div>
          </div>

          ${Charts.trend(m.points)}

          <div class="move-buckets">
            ${moved.length
              ? moved.map(b => `
                <span class="tag ${b.delta > 0 ? (b.covered ? 'ok' : 'warn') : ''}" title="${UI.esc(b.label)}: ${b.from} → ${b.to}">
                  <i class="dot" style="background:${BUCKET_COLOR[b.key]}"></i>${UI.esc(b.label)}
                  <strong>${b.delta > 0 ? '+' : ''}${UI.int(b.delta)}</strong>
                </span>`).join('')
              : '<span class="muted" style="font-size:12px">No bucket changed over this window.</span>'}
          </div>
          <p class="muted" style="font-size:11.5px;margin-top:10px">
            Counts, not percentages. Coverage can fall while Automated rises — new work arriving unautomated grows the
            denominator faster than the numerator, which is a different problem from work going backwards.
          </p>

          ${d.component || !rows.length ? '' : `
            <h3 style="margin-top:22px">Which components moved</h3>
            <div class="sub">Biggest change first, up and down. Click one to narrow the screen to it.</div>
            <div class="table-wrap" style="margin-top:10px">
              <table>
                <thead><tr>
                  <th>Component</th><th>Family</th>
                  <th class="num">Then</th><th class="num">Now</th><th class="num">Change</th>
                  <th class="num" title="Automatable ${UI.esc(d.scope.toLowerCase())}s — the denominator">Scope</th>
                  <th>What moved</th>
                </tr></thead>
                <tbody>${rows.map(r => `
                  <tr>
                    <td>${componentCell(d, r.component)}</td>
                    <td class="muted">${UI.esc(r.family.split(' —')[0])}</td>
                    <td class="num muted">${UI.pct(r.from)}</td>
                    <td class="num pct ${tone(r.to)}">${UI.pct(r.to)}</td>
                    <td class="num ${r.delta > 0 ? 'pct good' : r.delta < 0 ? 'pct over' : 'muted'}">
                      ${r.delta > 0 ? '+' : ''}${r.delta === 0 ? '—' : r.delta}
                    </td>
                    <td class="num muted" title="Automatable went ${r.automatableFrom} → ${r.automatableTo}">
                      ${r.automatableDelta > 0 ? '+' : ''}${r.automatableDelta || '—'}
                    </td>
                    <td>${drivers(r)}</td>
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>
            <p class="muted" style="font-size:11.5px;margin-top:10px">
              "Scope" is how many automatable ${UI.esc(d.scope.toLowerCase())}s the suite gained or lost. A component that
              fell while its scope grew did not go backwards — it got bigger faster than it got automated.
            </p>`}

          ${sourceNote(m)}
        </div>
      </section>`;
  }

  /** The bucket changes behind one component's move, largest first. */
  function drivers(r) {
    const parts = Object.entries(r.buckets || {})
      .filter(([, v]) => v)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 3)
      .map(([k, v]) => `<span class="tag"><i class="dot" style="background:${BUCKET_COLOR[k]}"></i>${UI.esc(bucketMeta(k).label)} <strong>${v > 0 ? '+' : ''}${v}</strong></span>`);
    return parts.length ? `<div style="display:flex;gap:4px;flex-wrap:wrap">${parts.join('')}</div>` : '<span class="muted">—</span>';
  }

  /**
   * Where these readings came from.
   *
   * A curve that mixes observation and inference has to say so on the same
   * screen as the curve, not in a tooltip nobody opens — otherwise the first
   * time it is pasted into a status report it becomes a measurement.
   */
  function sourceNote(m) {
    const by = Object.fromEntries((m.sources || []).map(s => [s.source, s.days]));
    const observed = by.sync || 0, inferred = by.changelog || 0;
    if (!inferred) return `<p class="muted" style="font-size:11.5px;margin-top:14px">
      ${UI.int(observed)} readings, each taken by a sync. Solid dots are days this tool counted for itself.</p>`;
    return `<p class="muted" style="font-size:11.5px;margin-top:14px">
      ${UI.int(observed)} day${observed === 1 ? '' : 's'} observed by a sync (solid dots) ·
      ${UI.int(inferred)} reconstructed from Jira's transition history (hollow).
      A reconstruction uses today's components and labels, so a suite something moved between can be wrong per
      component while the portfolio total stays right. Observations are never overwritten by one.</p>`;
  }

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

  /* ── 4. major risks & attention ───────────────────────────────────── */

  /**
   * The findings, last on the page — the conclusion after all the evidence.
   *
   * The rest of this screen is deliberately flat — seven buckets, 125
   * components, two tools, all of it equally loud. That is the right way to
   * show the data and the wrong way to answer "what do I do on Monday". This
   * section is the only opinionated thing here, which is why every finding
   * carries its own number and the sentence that justifies it: an alert you
   * cannot check is an alert you learn to scroll past.
   *
   * It reads every table above it — the status buckets, the component grid,
   * the tool split — so it goes after all three. A conclusion placed before
   * its evidence is one you either take on trust or scroll back down to
   * check; placed after, each finding lands on numbers already read.
   *
   * It moves with the component picker for free — the payload it reads is
   * already scoped — so the same panel is the portfolio view when nothing is
   * selected and the suite's own view when something is.
   */
  const SEV = {
    risk: { tag: 'risk', label: 'Risk' },
    watch: { tag: 'warn', label: 'Watch' },
    note: { tag: '', label: 'Note' },
  };

  // A percentage is rounded to one place by the model and must be printed that
  // way: UI.int would turn 63.6% into 64%, which is a different claim from the
  // one the tables below make.
  const pctUnit = (f) => String(f.unit || '').startsWith('%');

  function findingRow(d, f) {
    const sev = SEV[f.severity] || SEV.note;
    const comps = f.components || [];
    return `
      <li class="finding sev-${UI.esc(f.severity)}">
        <div class="finding-head">
          <span class="tag ${sev.tag}">${sev.label}</span>
          <strong>${UI.esc(f.title)}</strong>
          <div class="spacer"></div>
          <span class="finding-value">${pctUnit(f) ? UI.pct(f.value) : UI.int(f.value)}${f.unit && !pctUnit(f) ? `<small>${UI.esc(f.unit)}</small>` : ''}${pctUnit(f) && f.unit !== '%' ? `<small>${UI.esc(f.unit.replace(/^%\s*/, ''))}</small>` : ''}</span>
        </div>
        <p class="finding-detail">${UI.esc(f.detail)}</p>
        ${comps.length ? `
          <div class="finding-comps">
            ${comps.map(c => `<button class="chip" data-component="${UI.esc(c.name)}"
                title="Narrow this screen to ${UI.esc(c.name)}">${UI.esc(c.name)}
                <span class="muted">${pctUnit(c) ? UI.pct(c.value) : `${UI.int(c.value)}${UI.esc(c.unit || '')}`}</span></button>`).join('')}
            ${f.more ? `<span class="muted" style="align-self:center;font-size:12px">and ${UI.int(f.more)} more</span>` : ''}
          </div>` : ''}
        ${f.action ? `<p class="finding-action">${UI.esc(f.action)}</p>` : ''}
      </li>`;
  }

  function attentionSection(d) {
    const a = d.attention || { findings: [], counts: { risk: 0, watch: 0, note: 0 }, clear: true };
    const c = a.counts;
    const chips = [
      c.risk ? `<span class="tag risk">${c.risk} risk${c.risk === 1 ? '' : 's'}</span>` : '',
      c.watch ? `<span class="tag warn">${c.watch} to watch</span>` : '',
      c.note ? `<span class="tag">${c.note} note${c.note === 1 ? '' : 's'}</span>` : '',
    ].filter(Boolean).join(' ');

    return `
      <section class="section">
        <div class="card wide attention-card">
          <div class="section-head" style="margin-bottom:4px">
            <h3>Major risks &amp; attention</h3>
            <div class="spacer"></div>
            ${chips}
          </div>
          <div class="sub">
            ${d.component
              ? `${UI.esc(d.component)} only — clear the component above to see this across the portfolio`
              : `Across all ${d.byComponent.length} components — pick one above, or a component below, to see its own`}
          </div>
          ${a.clear
            ? `<div class="empty" style="margin-top:12px">Nothing to flag${d.component ? ` in ${UI.esc(d.component)}` : ''}.
                 Coverage is ${UI.pct(d.coveragePct)}, nothing is blocked, and every ${UI.esc(d.scope.toLowerCase())} has a status.</div>`
            : `<ul class="findings">${a.findings.map(f => findingRow(d, f)).join('')}</ul>`}
        </div>
      </section>`;
  }

  return { render };
})();
