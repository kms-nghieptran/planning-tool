'use strict';
/**
 * metrics.js — the reports: delivery (productivity · velocity · quality) and
 * automation coverage.
 *
 * Everything is computed from snapshot.json + plan.json. No network, no caching:
 * a report is a pure function of the data on disk, so two people looking at the
 * same snapshot always see the same number.
 *
 * Every figure carries its own `basis` — the sentence that says what was counted.
 * A metric you cannot explain in a review is a metric nobody acts on.
 */

const cap = require('./capacity');
const cls = require('./classify');
const insights = require('./insights');
const backlogLib = require('./backlog-item');
const reconcile = require('./reconcile');

const r1 = (n) => Math.round(n * 10) / 10;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const norm = (s) => String(s || '').toLowerCase().trim();
const isDone = (i) => i.statusCategory === 'done' || /^(done|closed|resolved)$/i.test(i.status || '');

/* ═══════════════════════════ delivery report ═══════════════════════════ */

/* ═══════════════════════════ the reporting window ═══════════════════════════ */

/**
 * WHICH SPRINTS A "4 SPRINT" WINDOW MEANS.
 *
 * His definition, and the only one that matches how the team talks about it:
 * **the sprint you are in, plus the 3 most recently closed.** It counts
 * backwards from the active sprint, and it stops there.
 *
 * What it replaced took the last N sprints by DATE ORDER out of everything the
 * plan knew, which quietly let FUTURE sprints in — a 4-sprint window on Ruby
 * could be two planned sprints, the active one, and a single closed one, so
 * "the last 4 sprints" was reporting mostly on work that had not happened. A
 * planned sprint has a commitment but no delivery, so it also dragged every
 * average towards zero.
 *
 * Three rules:
 *   1. FUTURE SPRINTS NEVER COUNT. They have not happened.
 *   2. The ACTIVE sprint is included, and marked `inProgress`, because it is
 *      half-finished and every chart has to be able to say so.
 *   3. With no active sprint (between sprints, or a team whose board has none)
 *      the window is simply the N most recent closed ones, and `active` is
 *      null so the screen can say which it did.
 *
 * @returns {{ids: string[], active: string|null, closed: number, requested: number}}
 */
function windowSprints(plan, team, n = 12) {
  const want = Math.max(1, Number(n) || 1);
  /* THIS TEAM'S OWN CHRONOLOGY. The shared row dates belong to whichever team
     set the cadence, and a team that numbers its sprints independently gets
     them back in the wrong order — and loses the ones that sort past its own
     active sprint. See reconcile.compareForTeam. */
  const ordered = plan.sprints.slice().sort(reconcile.compareForTeam(team.id));
  const stateOf = (sp) => norm(((sp.byTeam || {})[team.id] || {}).state);
  const mine = ordered.filter(sp => sp.byTeam && sp.byTeam[team.id]);
  const list = mine.length ? mine : ordered;

  // The LAST active one: a board occasionally reports two, and the later is the
  // one you are actually in.
  let activeAt = -1;
  for (let i = 0; i < list.length; i++) if (stateOf(list[i]) === 'active') activeAt = i;

  const active = activeAt >= 0 ? list[activeAt] : null;
  // Closed sprints BEFORE the active one — a closed sprint that sorts after it
  // is a data oddity, not history.
  const upTo = activeAt >= 0 ? activeAt : list.length;
  const closed = list.slice(0, upTo).filter(sp => stateOf(sp) === 'closed');

  const take = active ? want - 1 : want;
  const chosen = take > 0 ? closed.slice(-take) : [];
  const ids = chosen.map(sp => sp.id);
  if (active) ids.push(active.id);

  return { ids, active: active ? active.id : null, closed: chosen.length, requested: want };
}

/** The velocity history narrowed to that window, oldest first, active marked. */
function windowHistory(plan, snap, team, n, opts = {}) {
  const w = windowSprints(plan, team, n);
  const want = new Set(w.ids);
  const history = insights.velocityHistory(plan, snap, team, opts)
    .filter(h => want.has(h.sprintId))
    .map(h => ({ ...h, inProgress: h.sprintId === w.active }));
  return { history, window: w };
}

/**
 * PER-PERSON VELOCITY — who delivered what, sprint by sprint.
 *
 * One row per person, one column per sprint in the window, delivered story
 * points in the cells. DELIVERED, not committed: velocity is what landed, and
 * a table of commitments would say the same thing as the capacity sheet while
 * looking like it said something else. The committed figure travels alongside
 * each cell anyway, so a screen can put it in a tooltip without a second call.
 *
 * ── WHAT THIS IS AND IS NOT FOR ──────────────────────────────────────────
 *
 * It answers "where did the sprint's points come from" and "is one person
 * carrying the board". It is NOT a productivity ranking, and the numbers will
 * not support being used as one: story points are sized by the team for
 * planning, they are not comparable between people, a person at 40% support
 * has less than half the delivery time of the person beside them, and whoever
 * takes the unestimated work scores zero for a fortnight of it. The `basis`
 * line says so out loud, because a table of names against numbers invites
 * exactly the reading the numbers cannot carry.
 *
 * ── THE SPRINT IN PROGRESS IS INCLUDED, AND MARKED ───────────────────────
 *
 * Unlike the team average, which excludes it: an average that dips every
 * Monday is a number nobody can use. Here the column is the point — "what has
 * X landed so far this sprint" is a real question — so it is shown with
 * `inProgress` set, for the screen to mark.
 */
function perPerson(plan, snap, team, { sprints = 12 } = {}) {
  const { history, window } = windowHistory(plan, snap, team, sprints, { withItems: true });

  /* ONE CATALOGUE FOR THE WHOLE WINDOW, keyed by issue.
     Cells carry keys; this carries the tickets. A ticket worked by one person
     across three sprints is serialised once rather than three times, and the
     drawer behind any number is a lookup rather than a second walk over the
     sprint — which is how a count and the list behind it come to disagree. */
  const items = {};
  for (const h of history) for (const i of h.items || []) items[i.key] = i;

  const columns = history.map(h => ({
    sprintId: h.sprintId, number: h.number, name: h.name,
    start: h.start, end: h.end, inProgress: !!h.inProgress,
  }));

  /* ONE ROW PER PERSON, ACROSS THE WHOLE WINDOW — including sprints they were
     not on. A row that existed only for the sprints someone appeared in would
     make a blank and a zero look identical, and "delivered nothing in Sprint 2"
     is a different fact from "was not on the team in Sprint 2". */
  const rows = new Map();
  for (const h of history) {
    for (const p of h.byPerson || []) {
      if (!rows.has(p.key)) {
        rows.set(p.key, { key: p.key, name: p.name, onRoster: p.onRoster, bySprint: {}, delivered: 0, committed: 0, items: 0, keys: [] });
      }
      const row = rows.get(p.key);
      // The latest name wins: people get renamed, and the newest sprint has the
      // newest spelling.
      row.name = p.name;
      if (p.onRoster) row.onRoster = true;
      row.bySprint[h.sprintId] = {
        delivered: p.delivered, committed: p.committed, items: p.items || 0, keys: p.keys || [],
      };
      row.delivered = r1(row.delivered + p.delivered);
      row.committed = r1(row.committed + p.committed);
      row.items += p.items || 0;
      row.keys.push(...(p.keys || []));
    }
  }

  const people = [...rows.values()].sort((a, b) => b.delivered - a.delivered || String(a.name).localeCompare(String(b.name)));

  /* THE COLUMN TOTAL IS THE SPRINT'S OWN DELIVERED FIGURE, not the sum of the
     rows. They differ by work nobody is holding — a ticket with no assignee
     still delivered points — and a total built by adding the column up would
     silently drop it, leaving a table whose totals disagree with the velocity
     chart directly above it. */
  const totals = {};
  for (const h of history) {
    const summed = r1(people.reduce((t, p) => t + ((p.bySprint[h.sprintId] || {}).delivered || 0), 0));
    totals[h.sprintId] = {
      delivered: h.actual, attributed: summed, unattributed: r1(h.actual - summed),
      /* THE WHOLE SPRINT, not the union of the rows — this number includes work
         nobody is holding, and the drawer has to be able to show it or the
         asterisk explains nothing. */
      keys: (h.items || []).map(i => i.key),
    };
  }

  const unattributed = r1(Object.values(totals).reduce((t, x) => t + Math.max(0, x.unattributed), 0));

  return {
    columns, people, totals, window, items,
    grandTotal: r1(people.reduce((t, p) => t + p.delivered, 0)),
    unattributed,
    basis: people.length
      ? `${people.length} ${people.length === 1 ? 'person' : 'people'} across ${columns.length} sprint${columns.length === 1 ? '' : 's'}`
        + (unattributed > 0 ? ` · ${unattributed} pts delivered by nobody on the roster` : '')
      : 'Nobody delivered points in this window',
    caveat: 'Delivered story points. Points are sized for planning, not for comparing people — '
      + 'support load, unestimated work and who picks up the awkward tickets all move these numbers.',
  };
}

/**
 * Velocity — capacity, committed and delivered per sprint, plus the two numbers
 * people actually plan with: what the team averages, and how much that average
 * can be trusted.
 */
function velocity(plan, snap, team, { sprints = 12 } = {}) {
  const { history, window } = windowHistory(plan, snap, team, sprints);

  // THE PLANNING NUMBERS EXCLUDE THE SPRINT IN PROGRESS. It is half delivered
  // by definition, so folding it into an average makes velocity sink every
  // Monday and recover every other Friday — a number that moves for a reason
  // that has nothing to do with the team. The CHART still shows it, marked.
  const finished = history.filter(h => !h.inProgress);
  const completed = finished.filter(h => h.actual > 0);
  const avg = cap.averageVelocity(finished, 6);
  const pred = cap.predictability(finished);
  const calib = cap.calibrateHoursPerPoint(finished);

  // The honest planning number: the average discounted by how erratic delivery is.
  // Planning to the mean means missing half the time by construction.
  const safe = avg != null && pred ? r1(avg * Math.max(0.5, pred.mean - pred.stdev)) : null;

  return {
    history,
    window,
    sprintsCounted: completed.length,
    average: avg,
    safeCommitment: safe,
    predictability: pred,
    calibration: calib,
    best: completed.length ? Math.max(...completed.map(h => h.actual)) : null,
    worst: completed.length ? Math.min(...completed.map(h => h.actual)) : null,
    basis: completed.length
      ? `${completed.length} completed sprints, ${r1(completed.reduce((t, h) => t + h.actual, 0))} pts delivered`
      : 'No completed sprints yet',
  };
}

/**
 * Productivity — output per person and how quickly work moves, NOT a measure of
 * how hard anyone is working. Points per person is a planning input; it makes a
 * terrible performance rating and this report says so where it is shown.
 */
function productivity(plan, snap, team, { sprints = 12 } = {}) {
  // The same window as velocity, so the two cards cannot describe different
  // sprints. Sprints that delivered nothing are still IN the window — they are
  // part of the record — they just cannot contribute a per-person figure.
  const { history } = windowHistory(plan, snap, team, sprints);
  const perSprint = history.map(h => ({
    ...h,
    perPerson: h.headcount ? r1(h.actual / h.headcount) : null,
    perCapacityHour: h.capacityHours ? Math.round((h.actual / h.capacityHours) * 100) / 100 : null,
    utilisation: h.predicted ? pct(h.actual, h.predicted) : null,
  }));

  // Throughput and cycle time over the same window, from the issues themselves.
  const idx = (snap.byTeam || {})[team.id] || {};
  const windowIds = new Set(history.map(h => {
    const sp = plan.sprints.find(s => s.id === h.sprintId);
    return sp && sp.byTeam && sp.byTeam[team.id] && String(sp.byTeam[team.id].jiraId);
  }).filter(Boolean));

  const items = [];
  for (const [sid, keys] of Object.entries(idx.sprintIssues || {})) {
    if (windowIds.size && !windowIds.has(String(sid))) continue;
    for (const k of keys) { const i = (snap.issues || {})[k]; if (i) items.push(i); }
  }
  const done = items.filter(isDone);

  const cycleDays = done
    .map(i => cycleTime(i))
    .filter(d => d != null && d >= 0 && d < 365)
    .sort((a, b) => a - b);

  return {
    perSprint,
    avgPerPerson: perSprint.length ? r1(perSprint.reduce((t, s) => t + (s.perPerson || 0), 0) / perSprint.length) : null,
    avgThroughput: history.length ? r1(done.length / history.length) : null,
    avgUtilisation: perSprint.length ? r1(perSprint.reduce((t, s) => t + (s.utilisation || 0), 0) / perSprint.length) : null,
    cycleTime: cycleDays.length ? {
      median: median(cycleDays),
      p85: cycleDays[Math.floor(cycleDays.length * 0.85)],
      count: cycleDays.length,
    } : null,
    mix: cls.mix(items, plan.categoryRules),
    basis: `${done.length} items completed across ${history.length} sprints`,
    caveat: 'Points per person is a planning input, not a performance rating — story points are relative and are not comparable between people.',
  };
}

function cycleTime(i) {
  const start = i.created && new Date(i.created);
  const end = (i.resolved && new Date(i.resolved)) || (i.updated && new Date(i.updated));
  if (!start || !end || Number.isNaN(+start) || Number.isNaN(+end)) return null;
  return Math.round(((end - start) / 864e5) * 10) / 10;
}

function median(sorted) {
  if (!sorted.length) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : r1((sorted[m - 1] + sorted[m]) / 2);
}

/**
 * Quality — for an automation team this is NOT "how many bugs did we write".
 * It is: does the suite hold up, how much of the sprint goes on rework, and does
 * the team land what it said it would.
 */
function quality(plan, snap, team, { sprints = 12 } = {}) {
  const { history } = windowHistory(plan, snap, team, sprints);
  const idx = (snap.byTeam || {})[team.id] || {};

  // Rework and defects were counted over EVERY sprint the team has ever had,
  // whatever window was selected — so changing the window moved the velocity
  // chart and left these two numbers untouched. They are windowed now.
  const windowIds = new Set(history.map(h => {
    const sp = plan.sprints.find(s => s.id === h.sprintId);
    return sp && sp.byTeam && sp.byTeam[team.id] && String(sp.byTeam[team.id].jiraId);
  }).filter(Boolean));

  const items = [];
  for (const [sid, keys] of Object.entries(idx.sprintIssues || {})) {
    if (windowIds.size && !windowIds.has(String(sid))) continue;
    for (const k of keys) { const i = (snap.issues || {})[k]; if (i) items.push(i); }
  }

  // Rework: the share of delivered effort that went on fixing existing automation.
  const mix = cls.mix(items.filter(isDone), plan.categoryRules);
  const reworkShare = mix.byCategory.maintenance ? mix.byCategory.maintenance.share : 0;

  // Commitment reliability: delivered ÷ committed, and how often it lands short.
  // Excluding the sprint in progress: a sprint three days old has delivered
  // almost nothing against its full commitment, and counting it would report
  // the team as missing commitments it has not reached yet.
  const completed = history.filter(h => !h.inProgress && h.actual > 0);
  const attainment = completed.length
    ? pct(completed.reduce((t, h) => t + h.actual, 0), completed.reduce((t, h) => t + h.planned, 0))
    : null;
  const missed = completed.filter(h => h.actual < h.planned * 0.9).length;

  /* MISSED ON WHAT IT TOOK ON, as against missed on what it was holding.
     A sprint that opened already carrying a third of the previous one's
     unfinished work is measured here against a commitment it did not entirely
     choose. Both are reported: `missed` stays the gross count every past
     report was written from, `missedOnNewScope` is the one that answers
     whether the team is over-committing or still paying off a backlog of its
     own making. Sprints with no carryover land in both identically. */
  const missedOnNewScope = completed.filter((h) => {
    const scope = h.newScope == null ? h.planned : h.newScope;
    return scope > 0 && h.actual < scope * 0.9;
  }).length;

  /* CARRYOVER, MEASURED WHERE THE DATA ALLOWS IT.
     `planned - actual` is a PROXY: it assumes everything undelivered moved to
     the next sprint, when some of it was dropped, de-scoped or pulled out
     entirely. `carriedOut` counts the items that are genuinely in a later
     sprint of this team's board. Both are carried — `shortfall` is what every
     previous report of this number meant, `carried` is what it claimed to
     mean — because they differ, and the difference is itself worth seeing:
     a large gap is work that left the plan without being delivered. */
  const carryover = completed.map(h => ({
    number: h.number, name: h.name,
    committed: h.planned, delivered: h.actual,
    newScope: h.newScope == null ? null : h.newScope,
    carriedIn: h.carriedIn == null ? null : h.carriedIn,
    carried: h.carriedOut == null ? r1(Math.max(0, h.planned - h.actual)) : h.carriedOut,
    shortfall: r1(Math.max(0, h.planned - h.actual)),
    measured: h.carriedOut != null,
    pct: pct(h.carriedOut == null ? Math.max(0, h.planned - h.actual) : h.carriedOut, h.planned),
  }));

  // Defects raised against the team's own work.
  const defects = items.filter(i => /bug|defect/i.test(i.issueType || ''));
  const openDefects = defects.filter(i => !isDone(i));

  // Estimation discipline — an unestimated commitment makes every forecast fiction.
  const committed = items.filter(i => !/bug|defect/i.test(i.issueType || ''));
  const unestimated = committed.filter(i => i.points == null);

  // Suite health from TestOps, when it is connected.
  const pressure = insights.testopsPressure(snap, team, cap.averageVelocity(history));

  return {
    attainment,
    /* Delivered against what each sprint newly took on. Where a sprint has no
       carryover the two are identical, which is the point: the gap between
       them IS the carried load. */
    attainmentOnNewScope: completed.length
      ? pct(completed.reduce((t, h) => t + h.actual, 0),
        completed.reduce((t, h) => t + (h.newScope == null ? h.planned : h.newScope), 0))
      : null,
    missedSprints: missed,
    missedOnNewScope,
    missedShare: completed.length ? pct(missed, completed.length) : null,
    carryover,
    avgCarryoverPct: carryover.length ? r1(carryover.reduce((t, c) => t + (c.pct || 0), 0) / carryover.length) : null,
    reworkShare,
    reworkPoints: mix.byCategory.maintenance ? mix.byCategory.maintenance.points : 0,
    defects: { total: defects.length, open: openDefects.length, items: openDefects.slice(0, 20) },
    estimation: {
      total: committed.length,
      unestimated: unestimated.length,
      pct: committed.length ? pct(unestimated.length, committed.length) : null,
    },
    suite: pressure ? {
      passRate: pressure.passRate, flakyRate: pressure.flakyRate,
      failingTests: pressure.failingTests, worstSuites: (pressure.projects[0] || {}).worstSuites || [],
    } : null,
    basis: `${completed.length} completed sprints · ${items.length} items · ${defects.length} defects`,
  };
}

/* ═══════════════════════════ automation coverage ═══════════════════════════ */

/**
 * Coverage buckets, matching the definition already agreed for iPipeline:
 * epics bucketed by the Automation Status field, matched case-insensitively.
 * Anything Jira returns that is not in the map lands in "No status set" AND is
 * listed by name, so a renamed option surfaces instead of silently vanishing.
 */
const STATUS_BUCKETS = {
  automated: ['automated', 'done'],
  maintenance: ['maintenance'],
  ready: ['ready for automation', 'ready'],
  blocked: ['blocked'],
  na: ['n/a for automation', 'na', 'not applicable', 'n/a'],
};

const BUCKET_LABEL = {
  automated: 'Automated', maintenance: 'Maintenance', ready: 'Ready for automation',
  blocked: 'Blocked', na: 'N/A for automation', none: 'No status set',
};

function bucketOf(value, map = STATUS_BUCKETS) {
  const v = norm(value);
  if (!v) return 'none';
  for (const [bucket, values] of Object.entries(map)) {
    if (values.some(x => norm(x) === v)) return bucket;
  }
  return 'none';
}

/** Component families, as the team already names them. */
function familyOf(component) {
  const c = String(component || '');
  if (/^R&D_/i.test(c)) return 'R&D — product regression';
  if (/^PS_/i.test(c)) return 'PS — client delivery';
  if (/^KAT_/i.test(c)) return 'KAT — framework & common';
  return 'Other';
}

/**
 * Automation coverage across the project.
 *
 *   coverage % = (Automated + Maintenance) ÷ (Automated + Maintenance + Ready + Blocked)
 *
 * Maintenance counts as covered — it IS automated, just being fixed. N/A is out of
 * scope by definition and untriaged epics would bias the number either way, so both
 * are out of the denominator; the all-epics figure is reported alongside so the
 * exclusion is visible rather than hidden.
 */
function coverage(plan, snap, { excludeFromGrid = ['Katalon', 'TrueTest'], statusMap = STATUS_BUCKETS, scope = 'Epic' } = {}) {
  const all = Object.values(snap.issues || {});
  const epics = all.filter(i => norm(i.issueType) === norm(scope));

  const buckets = { automated: 0, maintenance: 0, ready: 0, blocked: 0, na: 0, none: 0 };
  const unmapped = new Map();
  for (const e of epics) {
    const b = bucketOf(e.automationStatus, statusMap);
    buckets[b]++;
    if (b === 'none' && e.automationStatus) unmapped.set(e.automationStatus, (unmapped.get(e.automationStatus) || 0) + 1);
  }

  const automatable = buckets.automated + buckets.maintenance + buckets.ready + buckets.blocked;
  const covered = buckets.automated + buckets.maintenance;

  // Per component. An epic with several components counts in each, so column
  // totals exceed the epic count — the same rule the maintenance report uses.
  const byComponent = new Map();
  for (const e of epics) {
    for (const c of (e.components || []).length ? e.components : ['— no component —']) {
      if (!byComponent.has(c)) byComponent.set(c, { component: c, family: familyOf(c), automated: 0, maintenance: 0, ready: 0, blocked: 0, na: 0, none: 0, total: 0 });
      const row = byComponent.get(c);
      row[bucketOf(e.automationStatus, statusMap)]++;
      row.total++;
    }
  }

  const hidden = [];
  const rows = [...byComponent.values()].map(row => {
    const auto = row.automated + row.maintenance + row.ready + row.blocked;
    return { ...row, automatable: auto, covered: row.automated + row.maintenance, coveragePct: pct(row.automated + row.maintenance, auto) };
  });

  // Tooling components are not product coverage, so they leave the GRID only —
  // they still count in the headline, and each is named below the table.
  const grid = rows.filter(row => {
    const hide = excludeFromGrid.some(x => norm(row.component).includes(norm(x)));
    if (hide) hidden.push({ component: row.component, epics: row.total });
    return !hide;
  }).sort((a, b) => b.total - a.total);

  // Families roll the grid up into the three things the team actually reports on.
  const families = new Map();
  for (const row of grid) {
    if (!families.has(row.family)) families.set(row.family, { family: row.family, components: 0, automated: 0, maintenance: 0, ready: 0, blocked: 0, na: 0, none: 0, total: 0 });
    const f = families.get(row.family);
    f.components++;
    for (const k of ['automated', 'maintenance', 'ready', 'blocked', 'na', 'none', 'total']) f[k] += row[k];
  }

  return {
    scope,
    total: epics.length,
    buckets: Object.entries(buckets).map(([key, count]) => ({
      key, label: BUCKET_LABEL[key], count, share: pct(count, epics.length),
    })),
    automatable,
    covered,
    coveragePct: pct(covered, automatable),
    coverageOfAllPct: pct(covered, epics.length),
    untriaged: buckets.none,
    unmappedValues: [...unmapped.entries()].map(([value, count]) => ({ value, count })),
    byComponent: grid,
    byFamily: [...families.values()]
      .map(f => ({ ...f, automatable: f.automated + f.maintenance + f.ready + f.blocked, coveragePct: pct(f.automated + f.maintenance, f.automated + f.maintenance + f.ready + f.blocked) }))
      .sort((a, b) => b.total - a.total),
    hiddenFromGrid: hidden,
    basis: `${epics.length} ${scope}s · coverage = (Automated + Maintenance) ÷ (Automated + Maintenance + Ready + Blocked)`,
    caveat: buckets.none
      ? `${buckets.none} ${scope.toLowerCase()}s carry no Automation Status and are outside the ratio — they would bias it either way.`
      : null,
  };
}

/* ═══════════════════════════ backlog health ═══════════════════════════ */

/**
 * The backlog as something to manage, not just a list: what is ready to plan,
 * what is blocked behind an estimate, and how much runway it represents.
 */
function backlogHealth(plan, snap, team) {
  const idx = (snap.byTeam || {})[team.id] || {};
  const issues = snap.issues || {};
  /* THE SAME DEFINITION THE BACKLOG VIEW USES — `insights.isBacklogItem`,
     not a second type check written here. An EPIC is the container work
     hangs off, never the thing pulled into a sprint, so it is not a backlog
     item; on his data 1,283 of Titan's 1,857 were epics and this page said
     seven sprints of runway where there were two.

     FILTERED AT READ TIME rather than in the sync's index. The index stays
     the raw answer from the board (or from the ownership heuristic), which
     is what it is for, and this correction needs no re-sync to take effect —
     it also means one edit to `isBacklogItem` moves this page and the
     Backlog view together, which was the whole problem: they read the same
     index through two different pieces of code and only one of them was
     ever fixed. */
  const raw = (idx.backlog || []).map(k => issues[k]).filter(Boolean);
  const { items: kept, excluded: epicsExcluded } = backlogLib.split(raw);
  const items = kept.map(i => ({ ...i, category: cls.classify(i, plan.categoryRules) }));

  const estimated = items.filter(i => i.points != null);
  const unestimated = items.filter(i => i.points == null);
  const assigned = items.filter(i => i.assignee);
  const prioritised = items.filter(i => /highest|high/i.test(i.priority || ''));

  /* Ready to plan = estimated AND not blocked. Everything else needs work first.
   *
   * THROUGH `insights.isBlocked`, NOT A LOCAL RULE. This line used to read
   * `(i.blockedBy || []).length` — Jira's own link on the item — and seven of
   * the 5,418 non-epic issues in this store have one. So this KPI reported
   * "0 blocked" for every team while 32 of Ruby's queue and 195 of Titan's
   * sat in Refinement, and `ready` counted every estimated item as plannable,
   * which is the number the runway forecast is built on.
   *
   * A fourth definition of "blocked", in the one place with no second copy on
   * screen to contradict it. Now it is the same predicate the Active Sprint
   * figure, the health score, the risk signal and the Blockers page read. */
  const blocked = items.filter(insights.isBlocked);
  const blockedKeys = new Set(blocked.map(i => i.key));
  const ready = estimated.filter(i => !blockedKeys.has(i.key));

  const history = insights.velocityHistory(plan, snap, team);
  const avg = cap.averageVelocity(history);
  const points = r1(items.reduce((t, i) => t + (Number(i.points) || 0), 0));
  const readyPoints = r1(ready.reduce((t, i) => t + (Number(i.points) || 0), 0));

  return {
    source: idx.backlogSource || 'heuristic',
    /* The board's saved filter, passed through so the screen can offer a
       Jira SEARCH that opens all of these rather than the few hundred keys
       that fit in a URL. Null until a full sync has read it. */
    boardFilter: idx.boardFilter || null,
    total: items.length,
    /* What the index held before the epics came out, and how many those
       were. A runway figure that fell by two thirds has to be able to say
       why — and 1,283 epics sitting in a board's backlog is itself worth
       seeing. */
    scanned: raw.length,
    epicsExcluded,
    points,
    estimated: { count: estimated.length, points, pct: pct(estimated.length, items.length) },
    unestimated: { count: unestimated.length, pct: pct(unestimated.length, items.length), items: unestimated.slice(0, 50) },
    ready: { count: ready.length, points: readyPoints, sprints: avg ? r1(readyPoints / avg) : null },
    /* THE WHOLE LIST, NOT THE FIRST 50. It was capped when nothing read it —
       now the Blocked KPI opens a drawer built from exactly these keys, and a
       cap would put "195" over a list of 50 with nothing on screen to say
       why. The full queue is already in `items` below, so this costs nothing
       that was not being sent anyway. */
    blocked: { count: blocked.length, items: blocked },
    assigned: { count: assigned.length, pct: pct(assigned.length, items.length) },
    highPriority: { count: prioritised.length, points: r1(prioritised.reduce((t, i) => t + (Number(i.points) || 0), 0)) },
    mix: cls.mix(items, plan.categoryRules),
    byComponent: groupBy(items, i => (i.components || [])[0] || '— none —'),
    byPriority: groupBy(items, i => i.priority || '— none —'),
    runway: avg ? r1(points / avg) : null,
    avgVelocity: avg,
    items,
    basis: `${items.length} open items on ${idx.backlogSource === 'board' ? "the team's Jira board backlog" : 'ownership rules (no board mapped)'}`,
  };
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const i of items) {
    const k = keyFn(i);
    if (!map.has(k)) map.set(k, { key: k, count: 0, points: 0, unestimated: 0 });
    const g = map.get(k);
    g.count++; g.points += Number(i.points) || 0;
    if (i.points == null) g.unestimated++;
  }
  return [...map.values()].map(g => ({ ...g, points: r1(g.points) })).sort((a, b) => b.points - a.points || b.count - a.count);
}

module.exports = {
  perPerson,
  velocity, productivity, quality, coverage, backlogHealth,
  windowSprints, windowHistory,
  STATUS_BUCKETS, BUCKET_LABEL, bucketOf, familyOf, cycleTime, median,
};
