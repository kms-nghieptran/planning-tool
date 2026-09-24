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
  /* THE SELECTION IS A LIST. One component answers "what state is this suite
     in"; several answer "what do these three add up to", which is the question
     when a client spans them and is not answerable by three screens side by
     side. Order is the order they were picked, so the chips do not reshuffle
     under the cursor. */
  let selected = [];
  let family = null;
  // The movement window, in days. Module state like the two above: this screen
  // is a lens on one dataset, not a place you deep-link to.
  let days = 180;

  // The backlog window. Module state for the same reason `days` is — and its
  // own, not shared with the movement window above: "the last thirteen weeks
  // of backlog" and "six months of coverage movement" are two questions a
  // reader asks at once, and one control driving both would mean never being
  // able to look at them on their scales at the same time.
  let grain = 'month';
  /* How many periods each window asks for. "all" is absent on purpose: it is
     not a count, it is "back to the first event", and only the server knows
     when that was. Sending no `periods` is what tells it so. */
  const PERIODS = { week: 13, month: 12, year: 3 };

  const tone = (p) => (p >= 80 ? 'good' : p < 50 ? 'over' : 'under');

  /**
   * WHAT AN UNSET PRIORITY SORTS AS.
   *
   * An em-dash, because `UI.sortable` treats that as "nothing here" and pins it
   * to the bottom in BOTH directions. It used to be 99, which only works one
   * way round: sorted descending, 99 is the largest number in the column, so
   * every component nobody had judged rose to the top above the P1s. The cell's
   * own comment already claimed it sorted last whichever way the column
   * pointed — it did not, and now the grid opens on this column, the second
   * click is where anyone would have found out.
   *
   * "Nobody decided" is not the bottom of the scale, and it is not the top of
   * it either. It is not on the scale.
   */
  const UNSET_SORT = '—';

  async function render(state, mount) {
    const qs = selected.length
      ? `?${selected.map(c => `component=${encodeURIComponent(c)}`).join('&')}`
      : '';
    // In parallel: the movement query walks a different table and there is no
    // reason for the reader to wait for one before the other starts.
    const [d, moved, backlog] = await Promise.all([
      UI.api(`/api/reports/coverage${qs}`),
      UI.api(`/api/reports/coverage/movement${qs}${qs ? '&' : '?'}days=${days}`).catch(() => null),
      UI.api(`/api/reports/backlog${qs}${qs ? '&' : '?'}grain=${grain}`
        + (PERIODS[grain] ? `&periods=${PERIODS[grain]}` : '')).catch(() => null),
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
      ${printHeader(d, state, backlog, moved)}

      ${picker(d)}

      <section class="section">
        <div class="kpis">
          ${UI.kpi({ label: 'Coverage', value: UI.pct(d.coveragePct), foot: UI.esc(scopeFoot(d)), tone: 'brand', featured: true })}
          ${UI.kpi({ label: 'Automated', value: UI.int(bucket('automated').count), foot: `${UI.pct(bucket('automated').share)} of all ${UI.esc(d.scope.toLowerCase())}s`, tone: 'ok' })}
          ${UI.kpi({ label: 'Maintenance', value: UI.int(bucket('maintenance').count), foot: 'Automated, being kept working' })}
          ${UI.kpi({ label: 'Still to automate', value: UI.int(bucket('ready').count + bucket('blocked').count), foot: `${bucket('ready').count} ready · ${bucket('blocked').count} blocked`, tone: bucket('blocked').count ? 'risk' : '' })}
          ${UI.kpi({ label: 'On TrueTest', value: UI.pct(share(d)), foot: `${UI.int(d.toolTotals.truetest.total)} of ${UI.int(d.total)} ${UI.esc(d.scope.toLowerCase())}s` })}
        </div>
      </section>

      ${statusSection(d)}
      ${backlogSection(backlog)}
      ${movementSection(d, moved)}
      ${d.selected.length === 1 ? '' : componentSection(d, rows)}
      ${toolSection(d, toolRows)}
      ${attentionSection(d)}
    `;

    mount.addEventListener('click', async (e) => {
      const w = e.target.closest('[data-days]');
      if (w) { e.preventDefault(); days = Number(w.dataset.days) || 180; App.refresh(); return; }

      const gr = e.target.closest('[data-grain]');
      if (gr) { e.preventDefault(); grain = gr.dataset.grain; App.refresh(); return; }

      const pdf = e.target.closest('[data-act="export-pdf"]');
      if (pdf) {
        e.preventDefault();
        UI.exportPdf(['Overall Coverage', d.selected.length ? d.selected.join(' + ') : 'all components',
          new Date().toISOString().slice(0, 10)]);
        return;
      }

      const bl = e.target.closest('[data-act="backlog"]');
      if (bl) { e.preventDefault(); await openBacklogDrawer(bl.dataset); return; }

      const mv = e.target.closest('[data-act="moved"]');
      if (mv) {
        e.preventDefault();
        const { component, bucket } = mv.dataset;
        // The delta the tag itself shows, so the drawer can say when the two
        // measurements disagree instead of quietly showing the smaller one.
        const shown = Number(String(mv.textContent).replace(/[^0-9+-]/g, '')) || 0;
        UI.drawer('<div class="empty">Reading the change history…</div>');
        try {
          const r = await UI.api(`/api/reports/coverage/moved?component=${encodeURIComponent(component)}`
            + `&bucket=${encodeURIComponent(bucket)}&days=${days}`);
          UI.drawer(r.backfilled
            ? movedDrawer(r, shown)
            /* The drawer is rendered outside this view's mount, so a button
               placed in here would never reach the click handler above. It
               names where the real one is instead — and now there is one at
               the foot of this very section, whatever state it is in. */
            : '<div class="empty"><strong>No change history yet.</strong><br><br>'
              + 'Close this and press <strong>Backfill from Jira history</strong> '
              + 'at the foot of the Coverage movement section.</div>');
        } catch (err) {
          UI.drawer(`<div class="empty">Could not read the change history — ${UI.esc(err.message)}</div>`);
        }
        return;
      }

      const bf = e.target.closest('[data-act="backfill"]');
      if (bf) {
        e.preventDefault();
        // Minutes, not seconds: it reads every epic's changelog out of Jira.
        // Saying so beats a button that looks broken while it works.
        bf.disabled = true;
        UI.toast('Reading Jira transition history — this takes a minute…');
        try {
          const r = await UI.jsonPost('/api/reports/coverage/backfill', { weeks: 26 });
          UI.toast(`${r.withHistory} of ${r.epics} had transitions · ${r.dates} dates reconstructed`
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
      const drop = e.target.closest('[data-unpick]');
      if (drop) {
        e.preventDefault();
        selected = selected.filter(x => x !== drop.dataset.unpick);
        family = null;
        App.refresh();
        return;
      }
      const c = e.target.closest('[data-component]');
      if (c && !c.classList.contains('combo-opt')) {
        e.preventDefault();
        // A component named anywhere on the screen is a jump TO that component,
        // not an addition to the selection: clicking a row in a grid of 125
        // means "show me this one". Shift adds it instead, for building a set
        // out of what the grid is already showing you.
        const name = c.dataset.component || null;
        if (!name) selected = [];
        else if (e.shiftKey) selected = selected.includes(name) ? selected : [...selected, name];
        else selected = [name];
        family = null;
        App.refresh();
      }
    });

    /* A BAR SEGMENT IS AN SVG <g>, NOT A <button>, so Enter and Space have to
       be wired by hand — a `role="button"` that only answers the mouse is a
       worse lie than no role at all. Space is prevented as well as handled,
       or the page scrolls out from under the drawer that just opened. */
    mount.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      const g = e.target.closest && e.target.closest('g[data-act="backlog"]');
      if (!g) return;
      e.preventDefault();
      await openBacklogDrawer(g.dataset);
    });

    /* Priority saves on change, one row at a time.
       No Save button on purpose: a grid of 125 dropdowns with one save at the
       bottom is a grid you lose work in. The trade is that a failed write has
       to put the control back where it was rather than leaving the screen
       showing a level the server never accepted. */
    const dRef = d;
    mount.addEventListener('change', async (e) => {
      const sel = e.target.closest && e.target.closest('[data-priority]');
      if (!sel) return;
      const name = sel.dataset.priority;
      const was = sel.dataset.was == null ? '' : sel.dataset.was;
      const level = sel.value === '' ? null : Number(sel.value);
      sel.disabled = true;
      try {
        await UI.jsonPut('/api/component-priority', { component: name, level });
        sel.dataset.was = sel.value;
        const cell = sel.closest('td');
        if (cell) cell.dataset.sortValue = level == null ? '99' : String(level);
        // The colour is on the control, so it has to move with the value —
        // otherwise the row stays the colour of the level it used to be until
        // the next full render, which is the kind of stale that gets believed.
        sel.className = `prio ${prioClass(dRef, level)}`;
        UI.toast(level == null ? `${name} — priority cleared` : `${name} — P${level}`);
      } catch (err) {
        sel.value = was;              // the server is the truth, not the dropdown
        UI.toast(err.message, true);
      } finally {
        sel.disabled = false;
      }
    });

    // The picker adds to the selection and never holds a value of its own: with
    // the chips above it showing what is chosen, a control that also displayed
    // one of them would be a second, disagreeing answer to "what is selected".
    UI.wireCombo(mount, 'covSearch', (value) => {
      if (!value) selected = [];
      else if (!selected.includes(value)) selected = [...selected, value];
      family = null;
      App.refresh();
    });
  }

  const share = (d) => (d.total ? Math.round((d.toolTotals.truetest.total / d.total) * 1000) / 10 : 0);

  /** What the headline KPI is counting, in the space a foot line has. */
  const scopeFoot = (d) => (!d.selected.length ? 'Across every component'
    : d.selected.length <= 2 ? d.selected.join(' + ')
      : `${d.selected.length} components combined`);

  /**
   * THE TITLE BLOCK THE PDF NEEDS AND THE SCREEN DOES NOT.
   *
   * Every control on this page is hidden in print, and each of them was
   * carrying a fact: the picker says which components, the window chips say
   * over what period, the grain chips say how wide the backlog bars are, the
   * family chips say which slice of the grid is showing. On screen those are
   * all visible as the state of a control. On paper the control is gone and
   * the number is left standing on its own.
   *
   * That is the specific way an exported report goes wrong: it is not that it
   * looks bad, it is that a page headed "Coverage 62%" over a table of eleven
   * components does not say it was filtered to one family, and the reader has
   * no way to know. So everything a chip was saying is restated here in words.
   *
   * The two timestamps are both needed and they are different questions. The
   * sync time is how old the FACTS are; the report time is when this page was
   * taken. A PDF mailed on Friday from Monday's sync is a document that quietly
   * ages into being wrong, and only the pair of them makes that visible.
   */
  /**
   * WHAT THIS SCREEN IS NOT COUNTING.
   *
   * Every percentage here is read against a denominator, so a denominator that
   * quietly got smaller is the one thing that must never happen silently. The
   * exclusions are a deliberate setting and a good one — but a reader who
   * cannot see them cannot check the figure, and "61.5%" means something
   * different depending on what was left out of it.
   *
   * Both halves are stated: WHICH components, and HOW MANY epics went with
   * them. The count is the part that matters — excluding a component nothing
   * is tagged with changes nothing, and excluding one holding two hundred
   * epics changes the headline.
   */
  function exclusionNote(d) {
    const names = d.excludedComponents || [];
    const teams = d.coverageTeams || [];
    if (!names.length && !teams.length) return '';
    const noun = d.scope.toLowerCase();
    const lines = [];

    if (names.length) {
      const n = d.excludedEpics || 0;
      lines.push(`Components not counted: ${names.join(', ')} — `
        + (n ? `${UI.int(n)} ${noun}${n === 1 ? '' : 's'} whose only components are these`
          : `no ${noun} sits only in ${names.length === 1 ? 'it' : 'them'}`) + '.');
    }
    if (teams.length) {
      const n = d.excludedByTeam || 0;
      lines.push(`Teams counted: ${teams.join(', ')}`
        + (n ? ` — ${UI.int(n)} ${noun}${n === 1 ? '' : 's'} on another team, or on none, left out`
          : ` — every ${noun} is on one of them`) + '.');
    }
    return `
      <div class="muted" style="font-size:11.5px;margin-top:6px">
        ${lines.map(l => `<div>${UI.esc(l)}</div>`).join('')}
        <div style="margin-top:2px">Set in Integrations &amp; setup.</div>
      </div>`;
  }

  function printHeader(d, state, b, m) {
    const scope = d.selected.length ? d.selected.join(' + ') : 'All components';
    const bits = [];
    if (family) bits.push(`Family: ${family.split(' —')[0]}`);
    bits.push(`Coverage movement over ${days >= 365 ? '1 year' : `${days} days`}`);
    if (b && b.periods && b.periods.length) {
      // What the backlog window RESOLVED to, not which chip was pressed: "All"
      // chooses its own bar width, and on paper the chip that would have said
      // so is not there.
      const bars = b.window === 'all'
        ? `all time, ${BAR_LABEL[b.grain] || b.grain} bars`
        : `${b.periods.length} ${b.grain}${b.periods.length === 1 ? '' : 's'}`;
      bits.push(`Backlog: ${bars}`);
    }
    if (m && m.span) bits.push(`${m.span.readings} coverage readings`);

    return `
      <div class="print-only" style="margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--app-line)">
        <div class="eyebrow"><i></i>KMS · Automation · Overall Coverage</div>
        <h2 style="margin-top:6px">${UI.esc(scope)} — ${UI.pct(d.coveragePct)} automated</h2>
        <div class="muted" style="font-size:11.5px;margin-top:4px">
          ${UI.esc(bits.join(' · '))}
        </div>
        <div class="muted" style="font-size:11.5px;margin-top:3px">
          ${UI.esc(d.basis || '')}
        </div>
        <div class="muted" style="font-size:11.5px;margin-top:3px">
          Jira data synced ${UI.esc(state && state.syncedAt ? UI.dateTime(state.syncedAt) : 'never')} ·
          report taken ${UI.esc(UI.dateTime(new Date().toISOString()))}
        </div>
      </div>`;
  }

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

  /**
   * THE ONE EDITABLE CELL ON THIS SCREEN.
   *
   * Everything else here is read off Jira; this is his own judgement, and it is
   * the only thing on the page a sync will never overwrite. Which is exactly why
   * it sits in the grid rather than on a settings page: the moment to decide
   * that a suite matters is while looking at the row saying it is at 31%.
   *
   * `data-sort-value` carries the level, because the column sorts by rank and a
   * cell holding a <select> has no text a sorter could read — `textContent` on
   * one returns every option concatenated. Unset rows get a value that sorts
   * last whichever way the column points, since "nobody decided" is not the
   * bottom of the scale.
   */
  function priorityCell(d, r) {
    const levels = d.priorityLevels || [];
    const cur = r.priority == null ? '' : String(r.priority);
    return `
      <td class="prio-cell" data-sort-value="${r.priority == null ? UNSET_SORT : r.priority}">
        <select class="prio ${prioClass(d, r.priority)}" data-priority="${UI.esc(r.component)}" data-was="${cur}"
          title="${UI.esc(r.priority ? `${levelOf(d, r.priority).label} — ${levelOf(d, r.priority).name}` : 'No priority set')}">
          <option value=""${cur === '' ? ' selected' : ''}>—</option>
          ${levels.map(l => `<option value="${l.value}"${cur === String(l.value) ? ' selected' : ''}>${UI.esc(l.label)} ${UI.esc(l.name)}</option>`).join('')}
        </select>
      </td>`;
  }

  const levelOf = (d, v) => (d.priorityLevels || []).find(l => l.value === Number(v)) || { label: '', name: '', key: '' };

  /**
   * The colour class for a level, built from the model's own key.
   *
   * Not a map in this file: the levels, their labels and their colours travel
   * together in the payload, so a fifth level or a recoloured P2 arrives here
   * without anyone remembering to update a second list in the browser.
   */
  const prioClass = (d, v) => (v == null ? 'prio-none' : `prio-${UI.esc(levelOf(d, v).key || `p${v}`)}`);

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
    const picked = d.selected || [];
    // A component already chosen is dropped from the list. Offering it again
    // would be a menu item that does nothing, on the one control whose job is
    // to make the selection grow.
    const taken = new Set(picked);
    return `
      <section class="section">
        <div class="card picker-card">
          ${UI.combo({
            id: 'covSearch', label: 'Component',
            // Never holds a value: the chips beside it are what is selected, and
            // a control also showing one of them is a second, disagreeing answer
            // to "what am I looking at".
            value: '',
            placeholder: picked.length
              ? `Add another (${d.components.length - picked.length} left)`
              : `All components (${d.components.length}) — type to search`,
            options: [
              { value: '', label: 'All components', meta: String(d.components.length), active: !picked.length },
              ...d.components.filter(c => !taken.has(c.name)).map(c => ({
                value: c.name, label: c.name, meta: String(c.count),
                tag: c.family.split(' —')[0], active: false,
              })),
            ],
          })}
          ${picked.length ? `
            <div class="picked">
              ${picked.map(name => `
                <span class="chip picked-chip">
                  ${UI.esc(name)}
                  <button class="picked-x" data-unpick="${UI.esc(name)}"
                    title="Remove ${UI.esc(name)} from the selection"
                    aria-label="Remove ${UI.esc(name)}">×</button>
                </span>`).join('')}
              ${picked.length > 1 ? `<span class="muted" style="align-self:center;font-size:11.5px">combined</span>` : ''}
            </div>` : ''}
          <div class="picker-note">
            <div class="muted" style="font-size:12px">${UI.esc(d.basis)}</div>
            ${exclusionNote(d)}
            ${d.componentUnknown ? `<div class="tag warn" style="margin-top:6px">
              No component named ${(d.componentMissing || []).map(x => `"${UI.esc(x)}"`).join(', ')} — ignored
            </div>` : ''}
          </div>
          ${/* THE ACTIONS, IN THE CARD RATHER THAN ON A ROW OF THEIR OWN.
                Export PDF used to sit in an otherwise empty `section-head`
                above this card — one right-aligned button and a spacer, which
                cost a full band of whitespace between the breadcrumb and the
                first thing on the page. It belongs beside the two buttons that
                were already here: all three act on the selection this card
                holds, and `.picker-card` is hidden in print, which is what the
                removed section's `print-hide` was for. */''}
          <div class="picker-actions">
            ${picked.length === 1 ? `
              <a class="btn ghost sm" target="_blank" rel="noopener"
                 href="${UI.esc(UI.componentSearchUrl({ component: picked[0], project: d.project, scope: d.scope }) || '#')}"
                 title="Open the ${UI.esc(d.scope.toLowerCase())}s in ${UI.esc(picked[0])} in Jira">Open in Jira</a>` : ''}
            ${picked.length ? '<button class="btn ghost sm" data-component="">Clear</button>' : ''}
            <button class="btn ghost sm" data-act="export-pdf"
              title="Opens your browser's print dialogue — choose &quot;Save as PDF&quot;">Export PDF</button>
          </div>
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
          <div class="sub">${d.selected.length ? `${UI.esc(d.selected.join(' + '))} · ` : ''}${UI.int(d.total)} ${UI.esc(d.scope.toLowerCase())}s by their Automation Status</div>
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
  /* THE BACKLOG, PERIOD BY PERIOD.
     Four series, one 2×2: two tools, each doing build work and maintenance.
     The colours say so — hue is the KIND, matching the category colours the
     rest of the app uses, and the darker of each pair is TrueTest — so the
     shape of the split reads before any number does. */
  const BACKLOG_COLORS = {
    ttBuild: { color: 'var(--bl-tt-build)', ink: 'var(--bl-tt-build-ink)' },
    kseBuild: { color: 'var(--bl-kse-build)', ink: 'var(--bl-kse-build-ink)' },
    ttMaint: { color: 'var(--bl-tt-maint)', ink: 'var(--bl-tt-maint-ink)' },
    kseMaint: { color: 'var(--bl-kse-maint)', ink: 'var(--bl-kse-maint-ink)' },
  };
  /* The windows, in the order they widen. "All" last because it is the one
     that has no fixed length — it is however much history there turns out to
     be, which is the answer you reach for after the three fixed ones. */
  const WINDOWS = ['week', 'month', 'year', 'all'];
  const GRAIN_LABEL = { week: 'Week', month: 'Month', year: 'Year', all: 'All' };
  /** What "All" resolved its bars to, for the foot note. */
  const BAR_LABEL = { week: 'weekly', month: 'monthly', year: 'yearly' };

  /**
   * THE BACKFILL CONTROL — AND WHY IT IS A FUNCTION RATHER THAN ONE BUTTON.
   *
   * It used to be rendered in exactly one place: the "no history yet" callout
   * inside Coverage movement. That callout only appears while `hasTrend` is
   * false, which is true only until the second sync has recorded a reading.
   *
   * But the transitions this button reads live in a DIFFERENT table from those
   * readings, and only this button ever fills it. So the moment two syncs had
   * run, the trend appeared, the callout went away, and the button went with
   * it — while the Backlog chart and the "what moved" drawer were still empty
   * and still saying, correctly but uselessly, "run Backfill from Jira
   * history". The instruction outlived the only control that could obey it.
   *
   * The multi-component branch never rendered it at all, so selecting two
   * components hid it too.
   *
   * Hence: one definition, rendered by every branch that can be on screen. A
   * message that names an action must be within reach of that action, or it is
   * not an instruction — it is a description of a dead end.
   *
   * It stays safe to press twice. The route writes transitions with INSERT OR
   * REPLACE and never overwrites a reading a sync took for itself, so a second
   * run costs a minute and changes nothing that was already right.
   */
  /* `src` is anything carrying a `scope` — the coverage payload or the backlog
     one, since both sections render this and both know what they are counting.
     `explain` is off where the surrounding copy already says what it does, and
     `center` follows the `.empty` block it sits in rather than fighting it. */
  function backfillButton(src, { explain = true, center = false } = {}) {
    const scope = UI.esc(((src && src.scope) || 'Epic').toLowerCase());
    return `
      ${explain ? `<p class="muted" style="font-size:11.5px;margin:14px 0 10px">
        Reads every ${scope}'s Automation Status transitions from Jira once. One pass fills all three things
        that need them — the Backlog chart, the Coverage movement trend, and the lists behind each
        "what moved" tag. Takes a minute; safe to run again.
      </p>` : ''}
      <div class="btn-row"${center ? ' style="justify-content:center;margin-top:0"' : ''}>
        <button class="btn sm" data-act="backfill">Backfill from Jira history</button>
      </div>`;
  }

  /**
   * What "All" turned out to mean, in words.
   *
   * The other three chips name their own bars — press Week and you get weeks.
   * All does not: it picks the bar width from how much history there is, so
   * without this the chart would silently change grain underneath him and the
   * only clue would be the axis labels. Saying "yearly bars" is the difference
   * between a chart that adapted and a chart that looks wrong.
   *
   * Nothing is said for the fixed windows, where the chip already is the answer.
   */
  function allNote(b) {
    if (!b || b.window !== 'all') return '';
    const bars = BAR_LABEL[b.grain] || `${b.grain}ly`;
    const from = b.periods && b.periods.length ? b.periods[0].label : '';
    return `All time, in ${UI.esc(bars)} bars${from ? ` from ${UI.esc(from)}` : ''}.`
      + (b.clamped ? ' There is more history than fits — the oldest is off the left edge.' : '');
  }

  function backlogSection(b) {
    const chips = WINDOWS.map(g =>
      `<button class="chip${grain === g ? ' active' : ''}" data-grain="${g}">${GRAIN_LABEL[g]}</button>`).join('');
    const head = `
      <div class="section-head" style="margin-bottom:4px">
        <h3>Backlog</h3>
        <div class="spacer"></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${chips}</div>
      </div>`;

    if (!b || !b.periods || !b.periods.length) {
      return `<section class="section">${head}
        <div class="card"><div class="empty">Nothing to profile yet.</div></div>
      </section>`;
    }

    /* AN EMPTY CHART AND AN UNASKED QUESTION LOOK IDENTICAL, and only one of
       them is news. These bars are read from Jira's changelog, which arrives
       with the backfill below — until that has run there are no events at all,
       and drawing twelve empty months would report a year of doing nothing. */
    if (!b.backfilled) {
      return `<section class="section">${head}
        <div class="card"><div class="empty">
          <strong>No automation history yet.</strong><br><br>
          These bars count the moments an ${UI.esc(b.scope || 'Epic')}'s Automation Status moved to Automated,
          which lives in Jira's change history rather than in the ${UI.esc(b.scope || 'Epic')} as it stands today.
          ${backfillButton({ scope: b.scope }, { center: true })}
        </div></div>
      </section>`;
    }

    const series = (b.buckets || []).map(x => ({ ...x, ...(BACKLOG_COLORS[x.key] || { color: 'var(--app-fg-3)' }) }));
    const last = b.periods[b.periods.length - 1];
    const first = b.periods[0];
    const delta = last.total - first.total;
    // The window's throughput. These are EVENTS, so unlike a backlog size the
    // bars genuinely add up — summing them is the right thing to show.
    const windowTotal = b.periods.reduce((n, p) => n + p.total, 0);

    return `
      <section class="section">
        ${head}
        <div class="card">
          <div class="move-head">
            <div>
              <div class="eyebrow"><i></i>Automated in ${UI.esc(last.label)}${last.partial ? ' so far' : ''}</div>
              <div class="kpi" style="padding:0"><div class="value">${UI.int(last.total)}<small>test cases</small></div></div>
            </div>
            <div class="move-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">
              <strong>${UI.int(windowTotal)}</strong>
              <span>across ${UI.esc(first.label)} – ${UI.esc(last.label)}</span>
            </div>
          </div>
          ${Charts.stacked(b.periods, series, { drill: true, unit: 'automated' })}
          <div class="mixkey" style="margin-top:10px">
            ${series.map(x => `<span><i style="background:${x.color}"></i>${UI.esc(x.label)}
              ${UI.drillNumber((last.counts || {})[x.key] || 0,
                { act: 'backlog', period: last.start, bucket: x.key })}</span>`).join('')}
          </div>
          <p class="muted" style="font-size:11.5px;margin:10px 0 0">
            ${UI.esc(b.basis)}
            ${allNote(b)}
            Read from Jira's change history, so it only goes back as far as the last backfill reached.
            ${UI.int(b.withEvents)} of ${UI.int(b.epics)} ${UI.esc(b.scope || 'Epic')}s have ever been automated.
            ${b.components && b.components.length ? `Filtered to ${UI.esc(b.components.join(', '))}.` : 'Across every component.'}
          </p>
        </div>
      </section>`;
  }

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

    /* SEVERAL COMPONENTS HAVE NO COMBINED SERIES, and inventing one by adding
       two rows together would double-count every epic they share. So the trend
       stands down and the movers table — which ranks the selected components
       against each other — is the whole section. */
    if (m && m.multi) return `
      <section class="section">
        <div class="card wide">
          ${head}
          <div class="sub">${UI.esc((d.selected || []).join(' + '))} · ranked against each other</div>
          <div style="margin-top:10px;padding:10px 12px;border-radius:var(--radius-sm);background:var(--app-subtle)">
            <p class="muted" style="margin:0;font-size:12px;line-height:1.5">
              A reading is recorded per component, so a combination has no trend line of its own — and adding two
              components' readings together would count every ${UI.esc(d.scope.toLowerCase())} they share twice.
              Pick a single component for the chart.
            </p>
          </div>
          ${moversTable(d, (m.movers || []).filter(r => (d.selected || []).includes(r.component)), m)}
          ${sourceNote(m)}
          ${backfillButton(d)}
        </div>
      </section>`;

    if (!m || !m.hasTrend) return `
      <section class="section">
        <div class="card wide">
          ${head}
          <div class="sub">${d.selected.length ? `${UI.esc(d.selected.join(' + '))} · ` : ''}Coverage over time, once there are two readings to compare</div>
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
            ${backfillButton(d, { explain: false })}
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
            ${d.selected.length ? `${UI.esc(d.selected.join(' + '))} · ` : 'Across every component · '}
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

          ${d.selected.length === 1 ? '' : moversTable(d, rows, m)}

          ${sourceNote(m)}
          ${backfillButton(d)}
        </div>
      </section>`;
  }


  /**
   * Which components moved, ranked.
   *
   * Extracted because two branches of the movement section render it: the
   * single-component view shows the whole portfolio's movers, and a multi-select
   * shows only the components in the selection, ranked against each other. One
   * copy, so the columns cannot diverge between them.
   */
  /* READ-ONLY HERE, ON PURPOSE. The component table below owns the priority and
     has the editable control; this column shows it. Two live selects for one
     value on one page is two things to keep in step, and the one that is not
     focused is the one that looks wrong. Border and text only, so a column of
     them does not shout over the percentages beside it. */
  function priorityTag(m, value) {
    if (value == null) return '<span class="muted">—</span>';
    const lvl = (m && m.priorityLevels || []).find(l => l.value === Number(value)) || {};
    const cls = lvl.key ? `prio-${UI.esc(lvl.key)}` : `prio-p${Number(value)}`;
    return `<span class="tag prio-tag ${cls}" title="${UI.esc(lvl.name || '')}">${UI.esc(lvl.label || `P${value}`)}</span>`;
  }

  function moversTable(d, rows, m) {
    if (!rows.length) return '';
    return `
            <h3 style="margin-top:22px">Which components moved</h3>
            <div class="sub">Biggest change first, up and down. Click one to narrow the screen to it.</div>
            <div class="table-wrap" style="margin-top:10px">
              <table>
                <thead><tr>
                  <th>Component</th>
                  <th title="Set on the component table below — this column shows it, it does not own it">Priority</th>
                  <th>Family</th>
                  <th class="num">Then</th><th class="num">Now</th><th class="num">Change</th>
                  <th class="num" title="Automatable ${UI.esc(d.scope.toLowerCase())}s — the denominator">Scope</th>
                  <th>What moved</th>
                </tr></thead>
                <tbody>${rows.map(r => `
                  <tr>
                    <td>${componentCell(d, r.component)}</td>
                    <td data-sort-value="${r.priority == null ? UNSET_SORT : r.priority}">${priorityTag(m, r.priority)}</td>
                    <td class="muted">${UI.esc(r.family.split(' —')[0])}</td>
                    <td class="num muted">${UI.pct(r.from)}</td>
                    <td class="num pct ${tone(r.to)}">${UI.pct(r.to)}</td>
                    <td class="num ${r.delta > 0 ? 'pct good' : r.delta < 0 ? 'pct over' : 'muted'}">
                      ${r.delta > 0 ? '+' : ''}${r.delta === 0 ? '—' : r.delta}
                    </td>
                    <td class="num muted" title="Automatable went ${r.automatableFrom} → ${r.automatableTo}">
                      ${r.automatableDelta > 0 ? '+' : ''}${r.automatableDelta || '—'}
                    </td>
                    <td>${drivers(r, d)}</td>
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>
            <p class="muted" style="font-size:11.5px;margin-top:10px">
              "Scope" is how many automatable ${UI.esc(d.scope.toLowerCase())}s the suite gained or lost. A component that
              fell while its scope grew did not go backwards — it got bigger faster than it got automated.
            </p>`;
  }

  /** The bucket changes behind one component's move, largest first. */
  /* EACH DRIVER OPENS THE EPICS BEHIND IT.
     A real <button>, so the keyboard reaches it and a screen reader announces
     it — these are actions, not decoration. The tag keeps its own look; only
     the affordance is added, because a row of four filled buttons would read
     as a toolbar rather than as a summary of what changed. */
  function drivers(r, d) {
    const parts = Object.entries(r.buckets || {})
      .filter(([, v]) => v)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 3)
      .map(([k, v]) => `<button type="button" class="tag tag-btn" data-act="moved"
        data-component="${UI.esc(r.component)}" data-bucket="${UI.esc(k)}"
        title="Show the ${UI.esc(((d && d.scope) || 'Epic').toLowerCase())}s behind this">
        <i class="dot" style="background:${BUCKET_COLOR[k]}"></i>${UI.esc(bucketMeta(k).label)} <strong>${v > 0 ? '+' : ''}${v}</strong></button>`);
    return parts.length ? `<div style="display:flex;gap:4px;flex-wrap:wrap">${parts.join('')}</div>` : '<span class="muted">—</span>';
  }

  /**
   * The drawer behind one driver tag.
   *
   * ARRIVALS AND DEPARTURES ARE SHOWN APART, and the net is stated. A "+5" can
   * be seven in and two out; one list under a heading saying five would be a
   * list that does not match its own number.
   *
   * And when the net does not equal the delta on the table, the drawer SAYS SO
   * rather than showing the smaller figure quietly. A reading counts epics; a
   * transition counts field changes. An epic created already Automated never
   * transitioned into anything, and one re-tagged between components moves
   * between two readings without a single status change. Those are real gaps,
   * not rounding, and the reader is the one who can tell which.
   */
  /**
   * THE EPICS BEHIND ONE BAR SEGMENT.
   *
   * The window parameters go WITH the request — the same grain and period
   * count the chart was drawn with. Without them the route would profile
   * against its own default of twelve months, and a drawer opened from a
   * weekly bar would answer for a month: a list that is longer than the number
   * that opened it, which is the one thing a drill-in must never be.
   *
   * `shown` comes back from the route as what that bar actually says, and the
   * two are compared here rather than trusted to agree. They always should —
   * both sides run the same `profile` over the same epics — so a mismatch
   * means something real has changed underneath, and saying so is better than
   * quietly showing the other number.
   */
  async function openBacklogDrawer(ds) {
    const period = ds && ds.period;
    if (!period) return;
    UI.drawer('<div class="empty">Reading the change history…</div>');
    const qs = [
      ...selected.map(c => `component=${encodeURIComponent(c)}`),
      `grain=${encodeURIComponent(grain)}`,
      ...(PERIODS[grain] ? [`periods=${PERIODS[grain]}`] : []),
      `period=${encodeURIComponent(period)}`,
      `bucket=${encodeURIComponent(ds.bucket || '')}`,
    ].join('&');
    try {
      const r = await UI.api(`/api/reports/backlog/epics?${qs}`);
      const off = r.shown != null && r.shown !== r.keys.length;
      UI.drawer(UI.drillDrawer({
        title: `${r.period.label} — ${r.label}`,
        meaning: `${UI.esc(r.scope)}s whose Automation Status moved to Automated in ${r.period.label}`
          + `${r.period.partial ? ' so far' : ''}, from Jira's change history.`
          + (r.components && r.components.length ? ` Filtered to ${r.components.join(', ')}.` : '')
          + (off ? ` The bar says ${r.shown} — it has been redrawn since this was opened.` : ''),
        keys: r.keys,
        catalogue: r.catalogue,
      }));
    } catch (err) {
      UI.drawer(`<div class="empty">Could not read the change history — ${UI.esc(err.message)}</div>`);
    }
  }

  function movedDrawer(res, delta) {
    const group = (title, list, tone) => `
      <div class="eyebrow" style="margin-top:14px"><i></i>${UI.esc(title)} — ${UI.int(list.length)}</div>
      ${list.length ? list.map(e => {
        const it = (res.catalogue || {})[e.key] || { key: e.key, absent: true };
        return `<div style="padding:10px 0;border-bottom:1px solid var(--app-line-soft)">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:3px">
            ${UI.issueKey(e.key)}
            <span class="tag ${tone}">${UI.esc(e.from || 'no status')} → ${UI.esc(e.to || 'no status')}</span>
            <span class="spacer"></span>
            <span class="muted" style="font-size:11.5px">${UI.date(String(e.at).slice(0, 10))}</span>
          </div>
          ${it.summary ? `<div style="font-size:13px">${UI.esc(it.summary)}</div>` : ''}
          ${it.absent ? '<div class="muted" style="font-size:11.5px">Not in the local store — open it in Jira</div>' : ''}
          ${(it.components || []).length ? `<div class="muted" style="font-size:11.5px;margin-top:2px">${UI.esc(it.components.join(', '))}</div>` : ''}
        </div>`;
      }).join('') : '<div class="muted" style="font-size:12px;padding:6px 0">None</div>'}`;

    const mismatch = delta != null && res.net !== delta;
    return `
      <div class="eyebrow"><i></i>${UI.esc(res.label)}${res.component ? ` · ${UI.esc(res.component)}` : ''}</div>
      <h2 style="margin:6px 0 2px">${res.net > 0 ? '+' : ''}${UI.int(res.net)}<small class="muted" style="font-size:13px;font-weight:400"> net over ${UI.int(res.days)} days</small></h2>
      <p class="muted" style="font-size:12.5px;margin:2px 0 0;max-width:62ch">
        ${UI.int(res.arrived.length)} moved in, ${UI.int(res.left.length)} moved out, from Jira's change history.
        ${mismatch ? `The table says ${delta > 0 ? '+' : ''}${delta}: a reading counts ${UI.esc(res.scope.toLowerCase())}s and a
          transition counts status changes, so one created already in this state, or re-tagged into this component,
          moves the count without ever changing status.` : ''}
      </p>
      ${group('Moved in', res.arrived, 'ok')}
      ${group('Moved out', res.left, 'warn')}`;
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
          <!-- OPENS ON PRIORITY, P1 FIRST. The grid's own order is biggest
               suite first, which answers "where is the work" — but the column
               he sets by hand is the one that says where the ATTENTION goes,
               and a judgement nobody can see without clicking is one that does
               not get used. Click the heading twice to get back to size order. -->
          <table data-sort-default="1:asc">
            <thead><tr>
              <th>Component</th>
              <th title="Your judgement of how much this suite matters — set it here, it is never touched by a sync. The grid opens sorted by this, P1 first">Priority</th>
              <th>Family</th>
              <th class="num">${UI.esc(d.scope)}s</th>
              <th class="num">Automated</th><th class="num">Maint.</th>
              <th class="num">Ready</th><th class="num">Blocked</th>
              <th class="num">N/A</th><th class="num">Obsolete</th><th class="num">No status</th>
              <th class="num">Coverage</th><th style="min-width:90px"></th>
            </tr></thead>
            <tbody>${rows.map(r => `
              <tr>
                <td>${componentCell(d, r.component)}</td>
                ${priorityCell(d, r)}
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
          <strong>Priority</strong> is yours to set — it saves as you change it, is never touched by a sync, and the
          column sorts by it.
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

  /**
   * How many columns the tool table has, for the expanded row's `colspan`.
   *
   * A constant rather than the literal 9 it used to be, because that number
   * has to track the header and nothing made it. Get it wrong and the panel
   * under a row stops short of the table's width — and worse, `UI.sortable`
   * reads `colspan` to tell a note row from a data row, so an expander that
   * spans the wrong number is also a sorting bug. `sort.test.js` pins the
   * count against the actual `<th>`s.
   */
  const TOOL_COLS = 10;

  function toolSection(d, rows) {
    const tt = d.toolTotals.truetest, kse = d.toolTotals.kse;
    const whole = { ...d.toolTotals, total: d.total };
    return `
      <section class="section">
        <div class="section-head">
          <h2>TrueTest vs KSE</h2>
          <span class="muted">${d.selected.length === 1 ? UI.esc(d.selected[0]) : `${rows.length} components`}</span>
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
          d.selected.length === 1 ? `Automation status by tool — ${d.selected[0]}` : 'Automation status by tool',
          d.selected.length === 1
            ? 'The same seven buckets, split by where the work runs'
            : 'Across every component. Pick one above, or open a row below, to see it per component.')}

        ${d.selected.length === 1 ? '' : `
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th style="width:22px"></th>
              <th>Component</th>
              <th title="Set on the component grid above — this column shows it, it does not own it">Priority</th>
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
                <td data-sort-value="${r.priority == null ? UNSET_SORT : r.priority}">${priorityTag(d, r.priority)}</td>
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
                <td colspan="${TOOL_COLS}" style="padding:0">
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
            ${d.selected.length
              ? `${UI.esc(d.selected.join(' + '))} only — clear the selection above to see this across the portfolio`
              : `Across all ${d.byComponent.length} components — pick one above, or a component below, to see its own`}
          </div>
          ${a.clear
            ? `<div class="empty" style="margin-top:12px">Nothing to flag${d.selected.length ? ` in ${UI.esc(d.selected.join(' + '))}` : ''}.
                 Coverage is ${UI.pct(d.coveragePct)}, nothing is blocked, and every ${UI.esc(d.scope.toLowerCase())} has a status.</div>`
            : `<ul class="findings">${a.findings.map(f => findingRow(d, f)).join('')}</ul>`}
        </div>
      </section>`;
  }

  return { render };
})();
