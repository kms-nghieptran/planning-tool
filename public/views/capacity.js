/* Capacity view — the sheet's grid, made editable.
   Click a day cell to cycle it; every number above recomputes immediately.

   THREE THINGS THIS SCREEN NOW HAS TO GET RIGHT.

   The roster is PER SPRINT. The rows are the people on this sprint, which is
   not the same set as the team — a closed sprint shows who was assigned the
   work, an open one adds everyone currently on the team, and either can be
   edited. The header says which, because a headcount with no provenance
   invites the question "why is Chau missing" and answers nothing.

   A CLOSED SPRINT IS READ-ONLY. Editing is removed rather than disabled-
   looking: no cycling day cells, no number inputs, no add button. The server
   refuses these writes anyway — this is so nobody tries.

   SCENARIOS sit above the grid, because choosing between plans is the outer
   loop and editing one is the inner loop. */

const CapacityView = (() => {
  const CYCLE = { '1': '0.5', '0.5': '0', '0': 'H', 'H': '1' };
  let data = null, roster = null, ro = false;
  // Guards the one non-idempotent action on this screen — see 'save-scenario'.
  let busy = false;

  async function render(state, mount) {
    data = await UI.api(`/api/capacity?team=${encodeURIComponent(state.teamId)}&sprint=${encodeURIComponent(state.sprintId)}`);
    const t = data.totals, s = data.settings;
    const raw = state.sprints.find(x => x.id === state.sprintId) || {};
    const sprint = { ...raw, ...((raw.byTeam || {})[state.teamId] || {}) };

    const overCount = data.rows.filter(r => r.flags.some(f => f.code === 'overloaded')).length;
    const slackCount = data.rows.filter(r => r.flags.some(f => f.code === 'underloaded' || f.code === 'unplanned')).length;

    ro = !!(data.lock && data.lock.readOnly);
    // Fetched together so the screen paints once. Both are small.
    const [rosterInfo, scenarioInfo] = await Promise.all([
      UI.api(`/api/sprint/roster?team=${encodeURIComponent(state.teamId)}&sprint=${encodeURIComponent(state.sprintId)}`).catch(() => null),
      UI.api(`/api/scenarios?team=${encodeURIComponent(state.teamId)}&sprint=${encodeURIComponent(state.sprintId)}`).catch(() => null),
    ]);
    roster = rosterInfo;

    mount.innerHTML = `
      ${ro ? `
      <section class="section">
        <div class="card" style="border-left:3px solid var(--app-fg-3)">
          <div class="eyebrow"><i></i>Closed sprint · read only</div>
          <p style="margin:8px 0 0;font-size:13.5px">${UI.esc(data.lock.reason)}</p>
          <p class="muted" style="font-size:12.5px;margin-top:6px">
            The roster below is who was actually on this sprint — ${UI.esc(rosterWords(data.roster))} — not the
            whole team list. Anyone you entered a leave grid or support percentage for counts, whether or not a
            ticket ended up in their name. That is what the delivery metrics are built from.
          </p>
        </div>
      </section>` : ''}

      ${scenarioBar(scenarioInfo)}

      <section class="section">
        <div class="kpis">
          ${UI.kpi({ label: 'Capacity', value: UI.int(t.predicted), unit: 'pts', foot: `${UI.num(t.capacityHours)} h across ${t.headcount} people`, tone: 'brand', featured: true })}
          ${UI.kpi({ label: 'Committed', value: UI.int(t.planned), unit: 'pts', foot: t.overBy > 0 ? `<span style="color:var(--risk)">${UI.num(t.overBy)} pts over capacity</span>` : `${UI.num(Math.abs(t.overBy))} pts of headroom` })}
          ${UI.kpi({ label: 'Team load', value: UI.pct(t.workloadPct), foot: `Target ${s.workloadUnderPct}–${s.workloadOverPct}%`, tone: t.workloadPct == null ? '' : t.workloadPct > s.workloadOverPct ? 'risk' : t.workloadPct < s.workloadUnderPct ? 'warn' : 'ok' })}
          ${UI.kpi({ label: 'Delivered', value: UI.int(t.actual), unit: 'pts', foot: `${UI.pct(t.goalPct)} of commitment` })}
          ${UI.kpi({ label: 'Available days', value: UI.num(t.availableDays), foot: `${sprint.start ? UI.date(sprint.start) : '—'} → ${sprint.end ? UI.date(sprint.end) : '—'}` })}
        </div>
      </section>

      ${(overCount || slackCount || data.unassigned.points) ? `
      <section class="section">
        <div class="card">
          <div class="eyebrow"><i></i>Balance</div>
          <ul class="reasons">
            ${overCount ? `<li class="risk">${overCount} ${overCount > 1 ? 'people are' : 'person is'} over ${s.workloadOverPct}% — move work before the sprint starts, not at the review</li>` : ''}
            ${slackCount ? `<li class="warn">${slackCount} ${slackCount > 1 ? 'people have' : 'person has'} unused capacity</li>` : ''}
            ${data.unassigned.points ? `<li class="warn">${UI.num(data.unassigned.points)} pts in this sprint have no assignee <button class="btn ghost sm" data-act="show-unassigned">Show ${data.unassigned.count}</button></li>` : ''}
          </ul>
        </div>
      </section>` : ''}

      <section class="section">
        <div class="section-head">
          <h2>Member capacity</h2>
          <span class="muted">${UI.esc(data.teamName)} · ${UI.esc(sprint.name || state.sprintId)} · ${rosterWords(data.roster)}</span>
          <div class="spacer"></div>
          <span class="muted">${s.hoursPerDay} h/day · ${s.hoursPerPoint} h/pt · ${s.ceremonyHours} h ceremonies</span>
          ${ro ? '' : '<button class="btn ghost sm" data-act="add-member">Add person</button>'}
          <a class="btn ghost sm" href="/api/export?what=capacity&team=${encodeURIComponent(state.teamId)}&sprint=${encodeURIComponent(state.sprintId)}">Export CSV</a>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Role</th><th>Name</th>
              <th class="num">Support %</th><th class="num">Days</th><th class="num">Capacity h</th>
              <th class="num">Capacity pts</th><th class="num">Committed</th><th class="num">Done</th>
              <th class="num">Load</th><th style="min-width:120px">Load bar</th><th class="num">Goal</th>
              ${ro ? '' : '<th style="width:1%"></th>'}
            </tr></thead>
            <tbody>
              ${data.rows.map(r => row(r, s, state)).join('')}
              ${removedRow(state)}
              <tr class="total">
                <td colspan="2">Team total</td>
                <td class="num">—</td>
                <td class="num">${UI.num(t.availableDays)}</td>
                <td class="num">${UI.num(t.capacityHours)}</td>
                <td class="num">${UI.int(t.predicted)}</td>
                <td class="num">${UI.num(t.planned)}</td>
                <td class="num">${UI.num(t.actual)}</td>
                <td class="num pct ${UI.workloadClass(t.workloadPct, s.workloadOverPct, s.workloadUnderPct)}">${UI.pct(t.workloadPct)}</td>
                <td>${UI.bar(t.planned, Math.max(t.predicted, t.planned), UI.workloadClass(t.workloadPct, s.workloadOverPct, s.workloadUnderPct))}</td>
                <td class="num">${UI.pct(t.goalPct)}</td>
                ${ro ? '' : '<td></td>'}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="section">
        <div class="card">
          <div class="section-head" style="margin-bottom:6px">
            <h3>Availability</h3>
            <span class="muted">Click a day to cycle: full → half → off → holiday</span>
            <div class="spacer"></div>
            <label class="field"><span>Ceremony hours</span><input type="number" step="0.5" id="ceremonyInput" value="${s.ceremonyHours}" style="width:90px"></label>
          </div>
          <div style="overflow-x:auto">
            <table style="width:auto">
              <tbody>
                <tr><td style="border:none;padding-bottom:2px"></td><td style="border:none;padding-bottom:2px">${dayHead(data.days)}</td><td style="border:none"></td></tr>
                ${data.rows.map(r => `
                  <tr>
                    <td style="border:none;padding-right:14px"><div class="name-cell">${UI.avatar(r.name)}<span>${UI.esc(r.name)}</span></div></td>
                    <td style="border:none">${dayRow(r, data.availability[r.memberId] || [], data.days)}</td>
                    <td style="border:none;padding-left:12px" class="muted">${UI.num(r.availableDays)} d · ${UI.num(r.capacityHours)} h</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <div class="legend">
            <span><i style="background:transparent"></i>Working day</span>
            <span><i style="background:var(--day-half)"></i>Half day</span>
            <span><i style="background:var(--day-off)"></i>Off</span>
            <span><i style="background:var(--day-hol)"></i>Holiday</span>
            <span><i style="background:var(--day-we)"></i>Weekend</span>
          </div>
        </div>
      </section>

      <section class="section grid-2">
        <div class="card">
          <h3>Work mix this sprint</h3>
          <div class="sub">What the committed points are actually going on</div>
          ${UI.mixBar(data.mix, state.categories)}
          ${data.mixVsTarget.filter(m => m.status !== 'ok' && m.share > 0).length ? `
            <ul class="reasons">
              ${data.mixVsTarget.filter(m => m.status !== 'ok' && m.share > 0).map(m => `<li class="${m.status === 'over' ? 'warn' : ''}">${UI.esc((state.categories[m.category] || {}).label || m.category)} at ${m.share}% vs target ${m.min}–${m.max}%</li>`).join('')}
            </ul>` : ''}
        </div>
        <div class="card">
          <h3>Load balance</h3>
          <div class="sub">Committed points against each person's capacity</div>
          ${Charts.load(data.rows, { over: s.workloadOverPct })}
        </div>
      </section>

      ${data.calibration ? `
      <section class="section">
        <div class="card">
          <div class="eyebrow"><i></i>Calibration</div>
          <p style="margin:8px 0 0;font-size:13px">
            History says this team spends <strong>${data.calibration.value} h per delivered point</strong>, against the
            <strong>${s.hoursPerPoint} h</strong> currently configured — ${UI.esc(data.calibration.basis)} over ${data.calibration.sprints} sprints.
            ${Math.abs(data.calibration.value - s.hoursPerPoint) / s.hoursPerPoint > 0.15
              ? `<button class="btn sm" data-act="apply-calibration" style="margin-left:8px">Use ${data.calibration.value}</button>`
              : '<span class="muted">Close enough — no change needed.</span>'}
          </p>
        </div>
      </section>` : ''}

      <section class="section">
        <div class="card">
          <h3>Sprint goal / notes</h3>
          <div class="sub">Kept with the plan, not in a chat thread</div>
          <textarea id="sprintNote" rows="3" placeholder="What this sprint is for…">${UI.esc(data.note)}</textarea>
          <div style="margin-top:8px"><button class="btn sm" data-act="save-note">Save note</button></div>
        </div>
      </section>
    `;

    wire(state, mount);
  }

  function row(r, s, state) {
    const cls = UI.workloadClass(r.workloadPct, s.workloadOverPct, s.workloadUnderPct);
    // How this person came to be on the sprint. Only the non-obvious cases get
    // a tag: someone assigned work needs no explanation, someone you put here
    // by hand does.
    const on = ((data.roster && data.roster.members) || []).find(m => m.id === r.memberId) || {};
    const why = on.onSprint === 'added' ? '<span class="tag" title="You put this person on the sprint">added</span>'
      : on.onSprint === 'team' ? '<span class="tag" title="On the team, but nothing assigned in this sprint yet">no items yet</span>'
        : on.onSprint === 'planned' ? '<span class="tag" title="No work assigned, but you entered capacity for them in this sprint">planned</span>'
          : '';
    const guest = on.historic ? '<span class="tag" title="Was on this sprint, but is not on the team any more">past member</span>'
      : on.notOnTeamList ? '<span class="tag warn" title="Did work in this sprint but is not on the team list">not on the team</span>'
        : '';
    return `
      <tr class="${r.status === 'Released' ? 'released' : ''}" data-member="${r.memberId}">
        <td class="muted">${UI.esc(r.role)}</td>
        <td><div class="name-cell">${UI.avatar(r.name)}<span>${UI.esc(r.name)}${r.status === 'Released' ? ' <span class="tag">Released</span>' : ''}${why}${guest}</span></div></td>
        <td class="num"><input type="number" min="0" max="100" step="5" value="${r.supportPct}" data-support="${r.memberId}" style="width:64px;text-align:right"></td>
        <td class="num">${UI.num(r.availableDays)}</td>
        <td class="num">${UI.num(r.capacityHours)}</td>
        <td class="num">${UI.int(r.predicted)}</td>
        <td class="num"><a href="#" data-act="member-items" data-member="${r.memberId}">${UI.num(r.planned)}</a></td>
        <td class="num">${UI.num(r.actual)}</td>
        <td class="num pct ${cls}">${UI.pct(r.workloadPct)}</td>
        <td>${UI.bar(r.planned, Math.max(r.predicted, r.planned), cls)}</td>
        <td class="num">${UI.pct(r.goalPct)}</td>
        ${ro ? '' : `<td style="text-align:right;white-space:nowrap">
          <button class="btn ghost sm" data-act="drop-member" data-member="${r.memberId}" data-name="${UI.esc(r.name)}"
            title="Take ${UI.esc(r.name)} off this sprint — only this sprint, and you can put them back">Remove</button>
        </td>`}
      </tr>`;
  }

  /**
   * The people you took OFF this sprint, with one click to put them back.
   *
   * A removal that leaves no trace is the worst kind: capacity drops, nothing
   * says why, and a week later nobody remembers whether it was deliberate.
   */
  function removedRow(state) {
    const ids = (data.roster && data.roster.removed) || [];
    if (!ids.length) return '';
    return `
      <tr>
        <td colspan="12" class="muted" style="font-size:12px;padding:10px 12px">
          <strong style="font-weight:600">Taken off this sprint:</strong>
          ${ids.map(id => `<span class="tag">${UI.esc(nameFor(id))}${ro ? '' :
            ` <button class="btn ghost sm" data-act="restore-member" data-member="${UI.esc(id)}" style="margin-left:6px" title="Put ${UI.esc(nameFor(id))} back on this sprint">Put back</button>`}</span>`).join(' ')}
        </td>
      </tr>`;
  }

  /** A removed person is not in `rows` any more, so their name comes from the team. */
  function nameFor(id) {
    const cand = ((roster && roster.candidates) || []).find(c => c.id === id);
    return (cand && cand.name) || String(id).replace(/^jira:/, '');
  }

  function dayHead(days) {
    return `<div class="dayhead">${days.map(d => `<div class="${['Sat', 'Sun'].includes(d.dow) ? 'we' : ''}">${d.dow ? d.dow[0] : ''}<br>${d.date ? d.date.slice(8, 10) : ''}</div>`).join('')}</div>`;
  }

  function dayRow(r, row, days) {
    return `<div class="daygrid" data-member="${r.memberId}">${days.map((d, i) => {
      const v = row[i] === undefined ? '1' : row[i];
      const label = v === 'WO' ? '' : v === 'H' ? 'H' : v === '0' ? '✕' : v === '0.5' ? '½' : '';
      return `<div class="day" data-v="${v}" data-i="${i}" title="${d.date || ''}${d.holiday ? ' · public holiday' : ''}">${label}</div>`;
    }).join('')}</div>`;
  }

  /**
   * Where this sprint's headcount came from, in words.
   *
   * "4 people" alone invites "why four?" and answers nothing. Saying how many
   * were assigned work, how many came from the team list and how many you put
   * there yourself makes the number checkable at a glance — and makes an
   * accidental removal visible instead of silently lowering capacity.
   */
  function rosterWords(r) {
    if (!r || !r.counts) return '';
    const c = r.counts, bits = [];
    if (c.assigned) bits.push(`${c.assigned} assigned work`);
    if (c.planned) bits.push(`${c.planned} you planned capacity for`);
    if (c.fromTeam) bits.push(`${c.fromTeam} on the team`);
    if (c.added) bits.push(`${c.added} you added`);
    if (c.removed) bits.push(`${c.removed} you removed`);
    return `${c.total} ${c.total === 1 ? 'person' : 'people'}${bits.length ? ` (${bits.join(', ')})` : ''}`;
  }

  /**
   * Saved plans for this sprint, with the live one first.
   *
   * The comparison is the feature. A scenario on its own is a note; a scenario
   * beside the current plan, with both totals on the same row, is a decision
   * you can actually make.
   */
  function scenarioBar(info) {
    if (!info) return '';
    const list = info.scenarios || [];
    // Identical saves, which is what the double-firing click produced. Same
    // name AND same numbers — a re-save under a name you have used before,
    // with a different plan, is legitimate and is not counted here.
    const seen = new Map();
    for (const sc of list) {
      const k = `${sc.name}\u0000${JSON.stringify(sc.totals || {})}`;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    const dupes = [...seen.values()].reduce((n, c) => n + (c > 1 ? c - 1 : 0), 0);
    const row = (name, totals, extra = '', id = null) => `
      <tr${id ? ` data-scenario="${UI.esc(id)}"` : ' class="total"'}>
        <td><strong>${UI.esc(name)}</strong> ${extra}</td>
        <td class="num">${totals ? UI.int(totals.headcount) : '—'}</td>
        <td class="num">${totals ? UI.num(totals.capacityHours) : '—'}</td>
        <td class="num">${totals ? UI.int(totals.predicted) : '—'}</td>
        <td class="num">${totals ? UI.num(totals.planned) : '—'}</td>
        <td style="text-align:right">${id && !ro ? `
          <button class="btn ghost sm" data-act="apply-scenario" data-id="${UI.esc(id)}">Apply</button>
          <button class="btn ghost sm" data-act="delete-scenario" data-id="${UI.esc(id)}">Delete</button>` : ''}</td>
      </tr>`;

    return `
      <section class="section">
        <div class="card">
          <div class="section-head" style="margin-bottom:6px">
            <h3>Capacity scenarios</h3>
            <span class="muted">${list.length ? `${list.length} saved for this sprint` : 'Save a plan before you change it, and you can always get it back'}</span>
            <div class="spacer"></div>
            ${dupes && !ro ? `<button class="btn ghost sm" data-act="dedupe-scenarios">Clean up ${dupes} duplicate${dupes === 1 ? '' : 's'}</button>` : ''}
            ${ro ? '<span class="tag">read only</span>' : '<button class="btn sm" data-act="save-scenario">Save current plan</button>'}
          </div>
          ${dupes ? `<p class="muted" style="font-size:12px;margin:0 0 8px">
            ${dupes} of these are identical copies — a fixed bug made one click save the plan several times.
            Cleaning up keeps the earliest of each and removes the rest.
          </p>` : ''}
          ${list.length ? `
          <div class="table-wrap">
            <table>
              <thead><tr><th>Plan</th><th class="num">People</th><th class="num">Capacity h</th><th class="num">Capacity pts</th><th class="num">Committed</th><th></th></tr></thead>
              <tbody>
                ${row('Current plan', info.live && info.live.totals, '<span class="tag ok">live</span>')}
                ${list.map(sc => row(sc.name, sc.totals,
                  `${sc.note ? `<span class="muted" style="font-weight:400"> — ${UI.esc(sc.note)}</span>` : ''}`
                  + `${sc.appliedAt ? ' <span class="tag">applied</span>' : ''}`, sc.id)).join('')}
              </tbody>
            </table>
          </div>` : ''}
        </div>
      </section>`;
  }

  /** The add-person drawer: the team's own people, then everyone Jira knows. */
  function addDrawer() {
    const list = (roster && roster.candidates) || [];
    const group = (from, title, note) => {
      const rows = list.filter(c => c.from === from);
      if (!rows.length) return '';
      return `
        <div style="margin-top:18px">
          <div class="eyebrow"><i></i>${title}</div>
          <div class="muted" style="font-size:12px;margin:4px 0 8px">${note}</div>
          ${rows.map(c => `
            <div style="display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--app-line-soft)">
              <div class="name-cell">${UI.avatar(c.name)}<span>${UI.esc(c.name)}</span></div>
              ${c.role ? `<span class="tag">${UI.esc(c.role)}</span>` : ''}
              <span class="spacer"></span>
              <button class="btn ghost sm" data-act="add-person"
                data-id="${UI.esc(c.id)}" data-name="${UI.esc(c.name)}"
                data-account="${UI.esc(c.jiraAccountId || '')}">Add to sprint</button>
            </div>`).join('')}
        </div>`;
    };

    return `
      <div class="eyebrow"><i></i>Add someone to this sprint</div>
      <h2 style="margin:6px 0 2px">${UI.esc(data.teamName)}</h2>
      <div class="muted" style="margin-bottom:6px">
        They join this sprint only. Every other sprint keeps the roster it already has.
      </div>
      ${list.length
        ? group('team', 'Already on this team', 'Not on this sprint yet')
          + group('jira', 'From Jira', 'Everyone Jira has seen on this project — a new joiner appears here the first sync after they exist')
        : '<div class="empty">Everyone is already on this sprint</div>'}`;
  }

  function wire(state, mount) {
    // A closed sprint gets no editing wiring at all. Not disabled-looking —
    // absent. The server refuses these writes anyway; leaving live handlers
    // that always fail is how a screen ends up telling you it saved.
    if (ro) {
      UI.$$('input', mount).forEach(i => { i.disabled = true; });
      UI.$$('#sprintNote', mount).forEach(i => { i.readOnly = true; });
    }

    // Day cells cycle; weekends are fixed so a stray click cannot invent a working Saturday.
    UI.$$('.daygrid .day', mount).forEach(cell => {
      cell.addEventListener('click', async () => {
        if (ro || cell.dataset.v === 'WO') return;
        const next = CYCLE[cell.dataset.v] || '1';
        cell.dataset.v = next;
        cell.textContent = next === 'H' ? 'H' : next === '0' ? '✕' : next === '0.5' ? '½' : '';
        const grid = cell.closest('.daygrid');
        const row = UI.$$('.day', grid).map(c => c.dataset.v);
        await UI.jsonPut('/api/availability', { teamId: state.teamId, sprintId: state.sprintId, memberId: grid.dataset.member, row });
        App.refresh();
      });
    });

    UI.$$('[data-support]', mount).forEach(input => {
      input.addEventListener('change', async () => {
        await UI.jsonPut('/api/support', { teamId: state.teamId, sprintId: state.sprintId, memberId: input.dataset.support, pct: Number(input.value) });
        App.refresh();
      });
    });

    const ceremony = UI.$('#ceremonyInput', mount);
    if (ceremony) ceremony.addEventListener('change', async () => {
      await UI.jsonPut('/api/ceremony', { teamId: state.teamId, sprintId: state.sprintId, hours: Number(ceremony.value) });
      App.refresh();
    });

    mount.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const kind = act.dataset.act;
      if (kind === 'member-items') {
        e.preventDefault();
        const r = data.rows.find(x => x.memberId === act.dataset.member);
        UI.drawer(itemsDrawer(r.name, r.items, state));
      } else if (kind === 'show-unassigned') {
        UI.drawer(itemsDrawer('Unassigned in this sprint', data.unassigned.items, state));
      } else if (kind === 'save-note') {
        await UI.jsonPut('/api/note', { teamId: state.teamId, sprintId: state.sprintId, text: UI.$('#sprintNote', mount).value });
        UI.toast('Note saved');
      } else if (kind === 'add-member') {
        UI.drawer(addDrawer());
      } else if (kind === 'add-person') {
        act.disabled = true; act.textContent = 'Adding…';
        try {
          await UI.jsonPut('/api/sprint/roster', {
            teamId: state.teamId, sprintId: state.sprintId,
            memberId: act.dataset.id, state: 'added',
            member: { name: act.dataset.name, jiraAccountId: act.dataset.account || null },
          });
          UI.closeDrawer();
          UI.toast(`${act.dataset.name} added to this sprint`);
          App.refresh();
        } catch (err) {
          UI.toast(err.message);
          act.disabled = false; act.textContent = 'Add to sprint';
        }
      } else if (kind === 'drop-member') {
        const name = act.dataset.name;
        // Removing someone changes the capacity figure, so it asks. The
        // decision itself is reversible — it is a roster note, not a deletion.
        if (!confirm(`Take ${name} off this sprint?\n\nTheir capacity stops counting and any work assigned to them moves to Unassigned. Only this sprint is affected, and you can put them back.`)) return;
        await UI.jsonPut('/api/sprint/roster', {
          teamId: state.teamId, sprintId: state.sprintId, memberId: act.dataset.member, state: 'removed',
        });
        UI.toast(`${name} removed from this sprint`);
        App.refresh();
      } else if (kind === 'restore-member') {
        await UI.jsonPut('/api/sprint/roster', {
          teamId: state.teamId, sprintId: state.sprintId, memberId: act.dataset.member, state: 'clear',
        });
        App.refresh();
      } else if (kind === 'save-scenario') {
        const name = prompt('Name this plan — something you will recognise next week:', suggestName());
        if (name == null) return;
        // Saving is the one action here that is NOT idempotent: a second call
        // makes a second row rather than re-doing the same thing. The
        // structural fix in App.refresh() stops a single click firing twice;
        // this stops a genuinely impatient double-click doing the same.
        if (busy) return;
        busy = true;
        try {
          await UI.jsonPost('/api/scenarios', {
            teamId: state.teamId, sprintId: state.sprintId, name,
          });
          UI.toast('Plan saved — change anything you like, it is safe now');
          App.refresh();
        } catch (err) { UI.toast(err.message); }
        finally { busy = false; }
      } else if (kind === 'apply-scenario') {
        if (!confirm('Apply this plan?\n\nIt replaces the current leave grid, support percentages, ceremony hours and roster for this sprint. Save the current plan first if you want it back.')) return;
        try {
          await UI.jsonPost('/api/scenarios/apply', { id: act.dataset.id });
          UI.toast('Applied');
          App.refresh();
        } catch (err) { UI.toast(err.message); }
      } else if (kind === 'dedupe-scenarios') {
        // Dry run first, always: the confirm text names the real number, and
        // nothing is removed until he answers it.
        const preview = await UI.jsonPost('/api/scenarios/dedupe', {});
        if (!preview.duplicates) { UI.toast('No duplicates to clean up'); return; }
        const names = preview.removing.slice(0, 5).map(r => `· ${r.name}`).join('\n');
        if (!confirm(`Remove ${preview.duplicates} duplicate plan${preview.duplicates === 1 ? '' : 's'}?\n\n${names}${preview.removing.length > 5 ? `\n… and ${preview.removing.length - 5} more` : ''}\n\nThe earliest copy of each is kept. ${preview.keeping} plan${preview.keeping === 1 ? '' : 's'} will remain. This cannot be undone.`)) return;
        const r = await UI.jsonPost('/api/scenarios/dedupe', { confirm: true });
        UI.toast(`Removed ${r.removed} duplicate${r.removed === 1 ? '' : 's'}`);
        App.refresh();
      } else if (kind === 'delete-scenario') {
        if (!confirm('Delete this saved plan? This cannot be undone.')) return;
        await UI.jsonDelete('/api/scenarios', { id: act.dataset.id });
        UI.toast('Deleted');
        App.refresh();
      } else if (kind === 'apply-calibration') {
        const plan = await UI.api('/api/state');
        const teams = plan.plan.teams.map(t => t.id === state.teamId ? { ...t, settings: { ...t.settings, hoursPerPoint: data.calibration.value } } : t);
        await UI.jsonPut('/api/plan', { teams });
        UI.toast(`Hours per point set to ${data.calibration.value}`);
        App.refresh();
      }
    });
  }

  /** A name that says what the plan IS, so a list of five is still readable. */
  function suggestName() {
    const t = data.totals;
    return `${t.headcount} people · ${UI.int(t.predicted)} pts`;
  }

  function itemsDrawer(title, items, state) {
    const sorted = (items || []).slice().sort((a, b) => (b.points || 0) - (a.points || 0));
    const total = sorted.reduce((t, i) => t + (i.points || 0), 0);
    return `
      <div class="eyebrow"><i></i>Sprint items</div>
      <h2 style="margin:6px 0 2px">${UI.esc(title)}</h2>
      <div class="muted" style="margin-bottom:16px">${sorted.length} items · ${UI.num(total)} pts</div>
      ${sorted.length ? sorted.map(i => `
        <div style="padding:11px 0;border-bottom:1px solid var(--app-line-soft)">
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
            ${UI.issueKey(i.key)}
            <span class="tag"><i class="dot" style="background:${UI.CATEGORY_COLORS[i.category]}"></i>${UI.esc((state.categories[i.category] || {}).label || i.category)}</span>
            <span class="tag">${UI.esc(i.status || '—')}</span>
            <span class="spacer"></span>
            <strong>${i.points == null ? '<span class="tag risk">no estimate</span>' : `${i.points} pts`}</strong>
          </div>
          <div style="font-size:13px">${UI.esc(i.summary)}</div>
          ${(i.components || []).length ? `<div class="muted" style="font-size:11.5px;margin-top:3px">${UI.esc(i.components.join(', '))}</div>` : ''}
        </div>`).join('') : '<div class="empty">Nothing here</div>'}`;
  }

  return { render };
})();
