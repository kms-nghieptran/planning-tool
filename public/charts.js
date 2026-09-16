/* charts.js — hand-rolled SVG. No chart library: five chart types, all small,
   all needing the same treatment (brand hues, tabular figures, direct labels
   instead of legends wherever a legend would just add a lookup step). */

const Charts = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const AXIS = 'var(--app-fg-3)';
  const GRID = 'var(--app-line-soft)';

  // width:100% + height:auto, NOT a fixed height attribute: a fixed height makes the
  // viewBox letterbox and centre itself inside a wider card, which reads as a layout bug.
  const frame = (w, h, body) => `<svg viewBox="0 0 ${w} ${h}" role="img" preserveAspectRatio="xMinYMid meet" style="display:block;width:100%;height:auto;max-width:${w * 1.35}px;overflow:visible">${body}</svg>`;
  const nice = (max) => { if (max <= 0) return 10; const p = 10 ** Math.floor(Math.log10(max)); return Math.ceil(max / p * 2) / 2 * p; };

  /**
   * THE X-AXIS TICK FOR A SPRINT.
   *
   * NOT EVERY SPRINT HAS A NUMBER. Two naming conventions run in this project
   * and reconcile deliberately keeps both: "Katalon Ruby Sprint 39" becomes a
   * numbered calendar entry, while the TrueTest boards run dated weekly windows
   * — "TT Week 18May-24May" — with no number to take. `sprint.number` is null
   * for those on purpose, and that is the right model.
   *
   * These charts did not know it. Both printed `row.number` straight onto the
   * axis, so Malphite — whose sprints are ALL dated — got a row of bars labelled
   * "null" under an axis captioned "Sprint", and the forecast chart would have
   * said "Snull". The bars were correct the whole time; only the labels were
   * claiming the data was missing.
   *
   * A dated sprint keeps the part of its name that tells it apart from its
   * neighbours. The leading words every sprint on a board shares — "TT Week" —
   * carry nothing on an axis where every tick repeats them, and spending a 60px
   * band on them is how the half that identifies the sprint gets truncated.
   */
  const HAS_DIGIT = /\d/;
  function sprintTick(row, { prefix = '', max = 12 } = {}) {
    const r = row || {};
    if (r.number != null && r.number !== '') return `${prefix}${r.number}`;

    const name = String(r.name || r.calendarName || '').trim();
    if (name) {
      const words = name.split(/\s+/);
      const from = words.findIndex(w => HAS_DIGIT.test(w));
      const short = (from > 0 ? words.slice(from) : words).join(' ');
      return short.length > max ? `${short.slice(0, max - 1)}…` : short;
    }
    // An id is a poor label and still a true one. "null" is neither.
    return String(r.sprintId || r.id || '—');
  }

  /**
   * Grouped columns: capacity vs planned vs actual across sprints.
   * Three series is the maximum a grouped column reads cleanly at this size.
   */
  function velocity(history, { height = 190 } = {}) {
    const data = (history || []).filter(h => h.predicted || h.planned || h.actual).slice(-12);
    if (!data.length) return '<div class="empty">No sprint history yet</div>';

    const W = 760, H = height, padL = 34, padR = 8, padT = 12, padB = 30;
    const max = nice(Math.max(...data.flatMap(d => [d.predicted, d.planned, d.actual])));
    const iw = W - padL - padR, ih = H - padT - padB;
    const bandW = iw / data.length;
    const barW = Math.min(13, (bandW - 8) / 3);
    const y = v => padT + ih - (v / max) * ih;

    const series = [
      { key: 'predicted', color: 'var(--app-fg-3)', label: 'Capacity' },
      { key: 'planned', color: 'var(--brand-blue)', label: 'Committed' },
      { key: 'actual', color: 'var(--brand-pink)', label: 'Delivered' },
    ];

    let body = '';
    for (let g = 0; g <= 4; g++) {
      const v = max * g / 4, yy = y(v);
      body += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="${GRID}"/>`;
      body += `<text x="${padL - 6}" y="${yy + 3.5}" text-anchor="end" font-size="9" fill="${AXIS}">${Math.round(v)}</text>`;
    }
    data.forEach((d, i) => {
      const x0 = padL + i * bandW + (bandW - barW * 3 - 4) / 2;
      series.forEach((s, si) => {
        const v = d[s.key] || 0, yy = y(v);
        body += `<rect x="${x0 + si * (barW + 2)}" y="${yy}" width="${barW}" height="${Math.max(0, padT + ih - yy)}" rx="2" fill="${s.color}"><title>${esc(d.name)} — ${s.label}: ${v} pts</title></rect>`;
      });
      // A title on the tick too: a shortened label is only safe when the full
      // name is one hover away.
      body += `<text x="${padL + i * bandW + bandW / 2}" y="${H - 12}" text-anchor="middle" font-size="9" fill="${AXIS}">`
        + `${esc(sprintTick(d, { max: 11 }))}<title>${esc(d.name || '')}</title></text>`;
    });
    body += `<text x="${padL}" y="${H - 1}" font-size="9" fill="${AXIS}">Sprint</text>`;

    const key = series.map(s => `<span style="display:inline-flex;align-items:center;gap:5px"><i style="width:9px;height:9px;border-radius:2px;background:${s.color};display:inline-block"></i>${s.label}</span>`).join('');
    return `${frame(W, H, body)}<div class="mixkey">${key}</div>`;
  }

  /** Burndown: ideal line vs actual remaining. */
  function burndown(points, { height = 190, committed = 0 } = {}) {
    const data = points || [];
    if (!data.length) return '<div class="empty">Sprint has not started</div>';
    const W = 700, H = height, padL = 34, padR = 10, padT = 12, padB = 26;
    const iw = W - padL - padR, ih = H - padT - padB;
    const max = nice(Math.max(committed, ...data.map(d => d.ideal || 0), ...data.map(d => d.actual || 0)));
    const x = i => padL + (data.length === 1 ? iw / 2 : i / (data.length - 1) * iw);
    const y = v => padT + ih - (v / max) * ih;

    let body = '';
    for (let g = 0; g <= 4; g++) {
      const v = max * g / 4, yy = y(v);
      body += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="${GRID}"/>`;
      body += `<text x="${padL - 6}" y="${yy + 3.5}" text-anchor="end" font-size="9" fill="${AXIS}">${Math.round(v)}</text>`;
    }
    body += `<polyline fill="none" stroke="${AXIS}" stroke-width="1.5" stroke-dasharray="4 3" points="${data.map((d, i) => `${x(i)},${y(d.ideal)}`).join(' ')}"/>`;

    const actual = data.map((d, i) => ({ ...d, i })).filter(d => d.actual !== null);
    if (actual.length) {
      body += `<polyline fill="none" stroke="var(--brand-blue)" stroke-width="2.5" stroke-linejoin="round" points="${actual.map(d => `${x(d.i)},${y(d.actual)}`).join(' ')}"/>`;
      const last = actual[actual.length - 1];
      body += `<circle cx="${x(last.i)}" cy="${y(last.actual)}" r="4" fill="var(--brand-blue)"/>`;
      body += `<text x="${x(last.i) + 8}" y="${y(last.actual) + 3.5}" font-size="10" font-weight="600" fill="var(--brand-blue)">${last.actual} left</text>`;
    }
    data.forEach((d, i) => {
      if (i % Math.ceil(data.length / 6) === 0 || i === data.length - 1) {
        body += `<text x="${x(i)}" y="${H - 10}" text-anchor="middle" font-size="9" fill="${AXIS}">${String(d.date).slice(8, 10)}/${String(d.date).slice(5, 7)}</text>`;
      }
    });
    return frame(W, H, body);
  }

  /** Capacity vs commitment per upcoming sprint — the forecast's headline. */
  function supplyDemand(rows, { height = 200 } = {}) {
    if (!rows || !rows.length) return '<div class="empty">No sprints in the horizon</div>';
    const W = 720, H = height, padL = 34, padR = 10, padT = 14, padB = 42;
    const iw = W - padL - padR, ih = H - padT - padB;
    const max = nice(Math.max(...rows.flatMap(r => [r.capacityPoints, r.committedPoints])));
    const bandW = iw / rows.length;
    const y = v => padT + ih - (v / max) * ih;

    let body = '';
    for (let g = 0; g <= 4; g++) {
      const v = max * g / 4, yy = y(v);
      body += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="${GRID}"/>`;
      body += `<text x="${padL - 6}" y="${yy + 3.5}" text-anchor="end" font-size="9" fill="${AXIS}">${Math.round(v)}</text>`;
    }
    rows.forEach((r, i) => {
      const cx = padL + i * bandW + bandW / 2;
      const w = Math.min(46, bandW - 16);
      // capacity = the outline; committed = the fill inside it. One mark, two readings.
      body += `<rect x="${cx - w / 2}" y="${y(r.capacityPoints)}" width="${w}" height="${Math.max(0, padT + ih - y(r.capacityPoints))}" rx="3" fill="none" stroke="var(--app-line)" stroke-width="1.5" stroke-dasharray="3 2"><title>${esc(r.name)} capacity: ${r.capacityPoints} pts</title></rect>`;
      const over = r.committedPoints > r.capacityPoints;
      body += `<rect x="${cx - w / 2}" y="${y(r.committedPoints)}" width="${w}" height="${Math.max(0, padT + ih - y(r.committedPoints))}" rx="3" fill="${over ? 'var(--brand-pink)' : 'var(--brand-blue)'}" opacity="${over ? 1 : .9}"><title>${esc(r.name)} committed: ${r.committedPoints} pts</title></rect>`;
      body += `<text x="${cx}" y="${y(Math.max(r.capacityPoints, r.committedPoints)) - 6}" text-anchor="middle" font-size="10" font-weight="700" fill="${over ? 'var(--brand-pink)' : 'var(--app-fg-2)'}">${r.utilisationPct}%</text>`;
      body += `<text x="${cx}" y="${H - 26}" text-anchor="middle" font-size="10" fill="var(--app-fg-2)">`
        + `${esc(sprintTick(r, { prefix: 'S' }))}<title>${esc(r.name || '')}</title></text>`;
      body += `<text x="${cx}" y="${H - 13}" text-anchor="middle" font-size="9" fill="${AXIS}">${r.headcount}p · ${r.availableDays}d</text>`;
    });
    return `${frame(W, H, body)}<div class="mixkey"><span><i style="width:9px;height:9px;border-radius:2px;background:var(--brand-blue)"></i>Committed</span><span><i style="width:9px;height:9px;border:1.5px dashed var(--app-line);border-radius:2px"></i>Capacity</span><span><i style="width:9px;height:9px;border-radius:2px;background:var(--brand-pink)"></i>Over capacity</span></div>`;
  }

  /** Ranked horizontal bars — one blue, row labels instead of a colour cycle. */
  function ranked(items, { height = 0, valueKey = 'points', labelKey = 'key', unit = 'pts', max: maxIn = null, color = 'var(--brand-blue)' } = {}) {
    const data = (items || []).slice(0, 10);
    if (!data.length) return '<div class="empty">Nothing to show</div>';
    const rowH = 26, W = 560, H = height || data.length * rowH + 6;
    const max = maxIn || Math.max(...data.map(d => d[valueKey] || 0)) || 1;
    const labelW = 190, valueW = 60;
    const barW = W - labelW - valueW;
    let body = '';
    data.forEach((d, i) => {
      const y = i * rowH + 4;
      const w = Math.max(2, (d[valueKey] || 0) / max * barW);
      const label = String(d[labelKey]);
      body += `<text x="0" y="${y + 13}" font-size="11" fill="var(--app-fg-2)">${esc(label.length > 30 ? label.slice(0, 29) + '…' : label)}<title>${esc(label)}</title></text>`;
      body += `<rect x="${labelW}" y="${y + 3}" width="${w}" height="13" rx="3" fill="${color}"/>`;
      body += `<text x="${labelW + w + 7}" y="${y + 13.5}" font-size="11" font-weight="600" fill="var(--app-fg-2)">${d[valueKey]}${unit ? ` ${unit}` : ''}</text>`;
    });
    return frame(W, H, body);
  }

  /** Sparkline for pass-rate trend. */
  function spark(values, { width = 130, height = 30, color = 'var(--brand-blue)' } = {}) {
    const data = (values || []).filter(v => v != null);
    if (data.length < 2) return '';
    const min = Math.min(...data), max = Math.max(...data);
    const span = max - min || 1;
    const pts = data.map((v, i) => `${i / (data.length - 1) * width},${height - ((v - min) / span) * (height - 4) - 2}`).join(' ');
    return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><polyline fill="none" stroke="${color}" stroke-width="1.8" points="${pts}"/></svg>`;
  }

  /** Per-person load: capacity band with commitment overlaid, sorted worst-first. */
  function load(rows, { over = 110 } = {}) {
    const data = (rows || []).filter(r => r.status !== 'Released');
    if (!data.length) return '<div class="empty">No members</div>';
    const rowH = 30, W = 620, H = data.length * rowH + 8;
    const labelW = 170, max = Math.max(...data.map(r => Math.max(r.predicted, r.planned))) || 1;
    const barW = W - labelW - 90;
    let body = '';
    data.forEach((r, i) => {
      const y = i * rowH + 6;
      const capW = Math.max(2, r.predicted / max * barW);
      const comW = Math.max(0, r.planned / max * barW);
      const isOver = r.workloadPct != null && r.workloadPct > over;
      body += `<text x="0" y="${y + 14}" font-size="11.5" fill="var(--app-fg)">${esc(r.name)}</text>`;
      body += `<rect x="${labelW}" y="${y + 3}" width="${capW}" height="16" rx="3" fill="var(--app-subtle)" stroke="var(--app-line)"/>`;
      body += `<rect x="${labelW}" y="${y + 3}" width="${comW}" height="16" rx="3" fill="${isOver ? 'var(--brand-pink)' : 'var(--brand-blue)'}" opacity=".9"><title>${esc(r.name)}: ${r.planned} pts committed of ${r.predicted} pts capacity</title></rect>`;
      body += `<text x="${labelW + Math.max(capW, comW) + 8}" y="${y + 15}" font-size="11" font-weight="700" fill="${isOver ? 'var(--brand-pink)' : 'var(--app-fg-2)'}">${r.workloadPct == null ? '—' : r.workloadPct + '%'}</text>`;
    });
    return frame(W, H, body);
  }

  /**
   * A percentage over time, with the readings marked.
   *
   * MARKED ON PURPOSE. This series is not sampled at a regular interval — it has
   * a point on every day a sync ran, which is whenever he happened to press the
   * button, plus whatever a changelog backfill reconstructed. Drawing it as a
   * smooth line implies a continuous measurement that was never taken, and the
   * gap between two dots three weeks apart is exactly the thing a reader needs
   * to see before trusting the slope between them.
   *
   * INFERRED POINTS ARE HOLLOW. A reading reconstructed from Jira's transition
   * history is a good guess and not an observation, and a chart that draws the
   * two identically is asking to be quoted as though they were the same.
   */
  function trend(points, { height = 170, band = null } = {}) {
    const data = (points || []).filter(p => p && p.at);
    if (data.length < 2) return '';

    const W = 760, H = height, padL = 34, padR = 12, padT = 14, padB = 26;
    const iw = W - padL - padR, ih = H - padT - padB;

    // Anchored to 0–100 unless the whole series sits in a narrow band, where a
    // full axis would flatten every real move into a straight line.
    const vals = data.map(p => p.coveragePct);
    const lo = Math.max(0, Math.min(...vals) - 8), hi = Math.min(100, Math.max(...vals) + 8);
    const span = hi - lo < 12 ? [Math.max(0, lo - 6), Math.min(100, hi + 6)] : [lo, hi];
    const t0 = new Date(data[0].at).getTime(), t1 = new Date(data[data.length - 1].at).getTime();
    // Spaced by DATE, not by index: evenly spaced dots would hide a three-week
    // gap between two syncs and show a fortnight's drift as a single step.
    const x = (at) => padL + (t1 === t0 ? iw / 2 : ((new Date(at).getTime() - t0) / (t1 - t0)) * iw);
    const y = (v) => padT + ih - ((v - span[0]) / (span[1] - span[0])) * ih;

    let body = '';
    for (let g = 0; g <= 4; g++) {
      const v = span[0] + (span[1] - span[0]) * g / 4, yy = y(v);
      body += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="${GRID}"/>`;
      body += `<text x="${padL - 6}" y="${yy + 3.5}" text-anchor="end" font-size="9" fill="${AXIS}">${Math.round(v)}%</text>`;
    }
    if (band && band.length === 2) {
      body += `<rect x="${padL}" y="${y(band[1])}" width="${iw}" height="${Math.max(0, y(band[0]) - y(band[1]))}" fill="var(--ok)" opacity=".07"/>`;
    }

    const pts = data.map(p => `${x(p.at)},${y(p.coveragePct)}`).join(' ');
    body += `<polyline fill="none" stroke="var(--brand-blue)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/>`;
    for (const p of data) {
      const inferred = p.source && p.source !== 'sync';
      body += `<circle cx="${x(p.at)}" cy="${y(p.coveragePct)}" r="${inferred ? 3 : 3.5}"`
        + ` fill="${inferred ? 'var(--app-surface)' : 'var(--brand-blue)'}" stroke="var(--brand-blue)" stroke-width="1.5">`
        + `<title>${esc(p.at)} — ${p.coveragePct}% (${p.covered}/${p.automatable})`
        + `${inferred ? ' · reconstructed from Jira history' : ''}</title></circle>`;
    }

    const first = data[0], last = data[data.length - 1];
    body += `<text x="${padL}" y="${H - 8}" font-size="9" fill="${AXIS}">${esc(first.at)}</text>`;
    body += `<text x="${W - padR}" y="${H - 8}" text-anchor="end" font-size="9" fill="${AXIS}">${esc(last.at)}</text>`;
    return frame(W, H, body);
  }

  return { velocity, burndown, supplyDemand, ranked, spark, load, trend };
})();
