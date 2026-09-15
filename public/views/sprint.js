/* Active sprint view — is this sprint going to land, and what is in the way. */

const SprintView = (() => {
  async function render(state, mount) {
    const d = await UI.api(`/api/sprint?team=${encodeURIComponent(state.teamId)}&sprint=${encodeURIComponent(state.sprintId)}`);
    const p = d.progress, w = d.window, h = d.health;

    const byStatus = groupBy(d.items, i => i.status || '—');
    const byMember = d.rows.filter(r => r.status !== 'Released' && (r.planned || r.actual));

    mount.innerHTML = `
      <section class="section">
        <div class="card featured" style="display:flex;gap:26px;align-items:center;flex-wrap:wrap">
          <div>
            <div class="eyebrow"><i></i>Sprint health</div>
            <div style="display:flex;align-items:baseline;gap:12px;margin-top:6px">
              <span style="font-size:44px;font-weight:800;line-height:1">${h.score}</span>
              <span class="rag ${h.rag}"><span class="dot"></span>${h.rag === 'green' ? 'On track' : h.rag === 'amber' ? 'At risk' : 'Off track'}</span>
            </div>
          </div>
          <div style="flex:1;min-width:280px">
            <ul class="reasons">${h.reasons.map(r => `<li class="${r.level}">${UI.esc(r.text)}</li>`).join('')}</ul>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="kpis">
          ${UI.kpi({ label: 'Committed', value: UI.int(p.committed), unit: 'pts', foot: `${d.items.length} items` })}
          ${UI.kpi({ label: 'Done', value: UI.int(p.done), unit: 'pts', foot: `${p.donePct}% of commitment`, tone: p.donePct >= w.timeElapsedPct ? 'ok' : '' })}
          ${UI.kpi({ label: 'Sprint elapsed', value: `${w.timeElapsedPct}`, unit: '%', foot: `Day ${w.elapsed} of ${w.workingDays} working days` })}
          ${UI.kpi({ label: 'Projected landing', value: p.projected == null ? '—' : UI.int(p.projected), unit: 'pts', foot: p.projectedVsCommitted == null ? 'Not enough of the sprint elapsed' : (p.projectedVsCommitted >= 0 ? `${UI.num(p.projectedVsCommitted)} pts above commitment` : `${UI.num(Math.abs(p.projectedVsCommitted))} pts short`), tone: p.projectedVsCommitted == null ? '' : p.projectedVsCommitted < -2 ? 'risk' : 'ok' })}
          ${UI.kpi({ label: 'Blocked', value: UI.int(p.blocked.count), unit: 'items', foot: `${UI.num(p.blocked.points)} pts held up`, tone: p.blocked.count ? 'risk' : 'ok' })}
        </div>
      </section>

      <section class="section grid-2">
        <div class="card">
          <h3>Burndown</h3>
          <div class="sub">Remaining points against the ideal line</div>
          ${Charts.burndown(d.burndown, { committed: p.committed })}
        </div>
        <div class="card">
          <h3>Where the work sits</h3>
          <div class="sub">Committed points by status</div>
          ${Charts.ranked(byStatus, { labelKey: 'key', valueKey: 'points' })}
        </div>
      </section>

      <section class="section grid-2">
        <div class="card">
          <h3>Per-person progress</h3>
          <div class="sub">Delivered against committed</div>
          <div class="table-wrap" style="border:none">
            <table>
              <thead><tr><th>Name</th><th class="num">Committed</th><th class="num">Done</th><th style="min-width:110px">Progress</th><th class="num">Left</th></tr></thead>
              <tbody>${byMember.map(r => `
                <tr>
                  <td><div class="name-cell">${UI.avatar(r.name)}${UI.esc(r.name)}</div></td>
                  <td class="num">${UI.num(r.planned)}</td>
                  <td class="num">${UI.num(r.actual)}</td>
                  <td>${UI.bar(r.actual, r.planned || 1, r.goalPct != null && r.goalPct < w.timeElapsedPct - 20 ? 'under' : '')}</td>
                  <td class="num">${UI.num(r.remainingPoints)}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <h3>Work mix delivered</h3>
          <div class="sub">What this sprint actually went on</div>
          ${UI.mixBar(d.mix, state.categories)}
        </div>
      </section>

      ${p.blocked.count || p.unestimated.count ? `
      <section class="section grid-2">
        ${p.blocked.count ? card('Blocked items', 'These will become carryover unless the blockers move', p.blocked.items, state) : ''}
        ${p.unestimated.count ? card('Committed without an estimate', 'The commitment number is only as good as these', p.unestimated.items, state) : ''}
      </section>` : ''}

      <section class="section">
        <div class="section-head"><h2>All sprint items</h2><span class="muted">${d.items.length} items</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Key</th><th>Summary</th><th>Category</th><th>Assignee</th><th>Status</th><th class="num">Points</th><th>Component</th><th>Epic</th></tr></thead>
            <tbody>${d.items.slice().sort(byStatusThenPoints).map(i => `
              <tr>
                <td>${UI.issueKey(i.key)}</td>
                <td class="wrap">${UI.esc(i.summary)}</td>
                <td><span class="tag"><i class="dot" style="background:${UI.CATEGORY_COLORS[i.category]}"></i>${UI.esc((state.categories[i.category] || {}).label || i.category)}</span></td>
                <td>${i.assignee ? `<div class="name-cell">${UI.avatar(i.assignee)}${UI.esc(i.assignee)}</div>` : '<span class="tag warn">unassigned</span>'}</td>
                <td>${UI.esc(i.status || '—')}</td>
                <td class="num">${i.points == null ? '<span class="tag risk">—</span>' : UI.num(i.points)}</td>
                <td class="muted">${UI.esc((i.components || [])[0] || '—')}</td>
                <td>${epicCell(i)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  /**
   * The Epic cell.
   *
   * A story has one epic (its parent); a maintenance ticket can relate to
   * several, and a handful of them relate to five or six. Showing all of them
   * inline turns the row into a paragraph, so two are shown and the rest are
   * counted — the full list is in the hover, which is where you go when the
   * count is what caught your eye.
   *
   * The key is always shown even when we have the name, because the key is
   * what you paste into Jira.
   */
  function epicCell(i) {
    const list = i.epics || [];
    if (!list.length) return '<span class="muted">—</span>';
    const label = (e) => `${e.key}${e.name ? ` · ${e.name}` : ''}`;
    const VIA = { relates: 'relates to', 'relates-parent': 'parent of a related issue', parent: 'parent' };
    const title = list.map(e => `${label(e)} (${VIA[e.via] || e.via}${e.unconfirmed ? ', type not confirmed as Epic' : ''})`).join('\n');
    const shown = list.slice(0, 2).map(e => `
      <span class="tag${e.unconfirmed ? '' : ' ok'}" title="${UI.esc(title)}">
        ${UI.issueKey(e.key)}${e.name ? ` ${UI.esc(trim(e.name))}` : ''}
      </span>`).join(' ');
    const more = list.length > 2 ? ` <span class="muted" title="${UI.esc(title)}">+${list.length - 2}</span>` : '';
    return `<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">${shown}${more}</div>`;
  }

  const trim = (s) => (String(s).length > 34 ? `${String(s).slice(0, 33)}…` : String(s));

  function card(title, sub, items, state) {
    return `
      <div class="card">
        <h3>${UI.esc(title)}</h3>
        <div class="sub">${UI.esc(sub)}</div>
        ${items.map(i => `
          <div style="padding:9px 0;border-bottom:1px solid var(--app-line-soft)">
            <div style="display:flex;gap:8px;align-items:center">
              ${UI.issueKey(i.key)}
              <span class="spacer"></span>
              <span class="muted" style="font-size:12px">${UI.esc(i.assignee || 'unassigned')}</span>
              ${(i.blockedBy || []).length ? `<span class="tag risk">blocked by ${UI.issueKeys(i.blockedBy)}</span>` : ''}
            </div>
            <div style="font-size:13px;margin-top:3px">${UI.esc(i.summary)}</div>
          </div>`).join('')}
      </div>`;
  }

  function groupBy(items, fn) {
    const m = new Map();
    for (const i of items) {
      const k = fn(i);
      if (!m.has(k)) m.set(k, { key: k, points: 0, count: 0 });
      const g = m.get(k); g.points += Number(i.points) || 0; g.count++;
    }
    return [...m.values()].map(g => ({ ...g, points: Math.round(g.points * 10) / 10 })).sort((a, b) => b.points - a.points);
  }

  const ORDER = ['open', 'refinement', 'in dev', 'in testing', 'done'];
  function byStatusThenPoints(a, b) {
    const ai = ORDER.indexOf(String(a.status || '').toLowerCase());
    const bi = ORDER.indexOf(String(b.status || '').toLowerCase());
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || (b.points || 0) - (a.points || 0);
  }

  return { render };
})();
