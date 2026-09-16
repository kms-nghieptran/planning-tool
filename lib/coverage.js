'use strict';
/**
 * coverage.js — automation coverage, one component at a time.
 *
 * The existing Automation coverage report answers "how are we doing overall".
 * This answers the question a team lead actually asks in planning: "pick
 * PS_iGO_NLG — what is the state of THAT suite, and how much of it is on
 * TrueTest versus Katalon Studio?" Same source field, three differences:
 *
 *   1. A COMPONENT FILTER. Everything below narrows to one product component,
 *      or reports across all of them.
 *
 *   2. AN "OBSOLETED" BUCKET. 301 of his 625 status-less epics carry the
 *      `obsolete` label — they are not untriaged, they are retired, and
 *      lumping them together made the untriaged pile look twice its real size.
 *      Per his rule this is the NARROW reading: an epic is Obsoleted only when
 *      it has NO Automation Status AND the label. An epic labelled obsolete
 *      that still carries a real status keeps that status, because someone set
 *      it deliberately and the label may just be stale.
 *
 *   3. A TOOL SPLIT. TrueTest and Katalon are carried as COMPONENTS alongside
 *      the product one, which is why both are already hidden from the
 *      coverage-by-component grid — they are tool markers, not product areas.
 *      Read the other way round they are exactly the TrueTest-vs-KSE split.
 *
 * WHAT THE RATIO DOES NOT CHANGE
 *
 *   coverage % = (Automated + Maintenance) ÷ (Automated + Maintenance + Ready + Blocked)
 *
 * unchanged from the existing report, so the two screens cannot disagree.
 * Obsoleted is carved out of "no status", which was already outside the
 * denominator, so pulling it into its own bucket moves no percentage at all —
 * it only stops 301 retired epics being described as untriaged.
 */

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

/** Automation Status values, matched case-insensitively. */
const STATUS_BUCKETS = {
  automated: ['automated', 'done'],
  maintenance: ['maintenance'],
  ready: ['ready for automation', 'ready'],
  blocked: ['blocked'],
  na: ['n/a for automation', 'na', 'not applicable', 'n/a'],
};

/** Labels that retire an epic. Matched case-insensitively, any one is enough. */
const OBSOLETE_LABELS = ['obsolete', 'obsoleted'];

/**
 * Display order, which is also reading order: what is done, what is being kept
 * working, what is queued, what is stuck, then the three that sit outside the
 * ratio. Obsoleted before "no status" so the retired pile is accounted for
 * before the reader reaches the genuinely untriaged one.
 */
const BUCKETS = [
  { key: 'automated', label: 'Automated', inRatio: true, covered: true },
  { key: 'maintenance', label: 'Maintenance', inRatio: true, covered: true },
  { key: 'ready', label: 'Ready for Automation', inRatio: true, covered: false },
  { key: 'blocked', label: 'Blocked', inRatio: true, covered: false },
  { key: 'na', label: 'N/A for Automation', inRatio: false, covered: false },
  { key: 'obsoleted', label: 'Obsoleted', inRatio: false, covered: false },
  { key: 'none', label: 'No Status', inRatio: false, covered: false },
];
const KEYS = BUCKETS.map(b => b.key);
const IN_RATIO = BUCKETS.filter(b => b.inRatio).map(b => b.key);
const COVERED = BUCKETS.filter(b => b.covered).map(b => b.key);

/** The two automation tools, carried on the epic as components. */
const TOOLS = [
  { key: 'truetest', label: 'TrueTest', component: 'TrueTest' },
  { key: 'kse', label: 'KSE', component: 'Katalon' },
];
/** Component names that mark a tool rather than a product area. */
const TOOL_COMPONENTS = TOOLS.map(t => t.component);

const isObsolete = (issue) => (issue.labels || []).some(l => OBSOLETE_LABELS.includes(norm(l)));

/**
 * Which bucket an epic belongs to.
 *
 * Status first, label second. The one exception is the whole point of the
 * Obsoleted bucket: a retired epic normally has no status at all, so the label
 * is consulted only when the status is empty or unrecognised.
 */
function bucketOf(issue, statusMap = STATUS_BUCKETS) {
  const v = norm(issue.automationStatus);
  if (v) {
    for (const [bucket, values] of Object.entries(statusMap)) {
      if (values.some(x => norm(x) === v)) return bucket;
    }
  }
  return isObsolete(issue) ? 'obsoleted' : 'none';
}

/**
 * Which tool an epic is automated with.
 *
 * TrueTest is checked first and wins outright: the handful of epics carrying
 * BOTH components are migrations, and the newer tool is the truthful answer
 * for where that suite runs now.
 *
 * Everything else counts as KSE, INCLUDING epics that name no tool at all —
 * his call, and the right one for this data: the tool components were
 * introduced with the TrueTest rollout, so an epic with neither predates it
 * and ran on Katalon Studio. It is an assumption, so it is stated on the
 * screen and counted separately in `untagged` rather than buried.
 */
function toolOf(issue) {
  const comps = (issue.components || []).map(norm);
  if (comps.includes(norm('TrueTest'))) return 'truetest';
  return 'kse';
}

const hasTool = (issue) =>
  (issue.components || []).some(c => TOOL_COMPONENTS.some(t => norm(t) === norm(c)));

/** The product components on an epic — the tool markers are not product areas. */
function productComponents(issue) {
  const out = (issue.components || []).filter(c => !TOOL_COMPONENTS.some(t => norm(t) === norm(c)));
  return out.length ? out : ['— no component —'];
}

/** Component families, as the team already names them. */
function familyOf(component) {
  const c = String(component || '');
  if (/^R&D_/i.test(c)) return 'R&D — product regression';
  if (/^PS_/i.test(c)) return 'PS — client delivery';
  if (/^KAT_/i.test(c)) return 'KAT — framework & common';
  return 'Other';
}

const blank = () => Object.fromEntries(KEYS.map(k => [k, 0]));
const sum = (row, keys) => keys.reduce((t, k) => t + (row[k] || 0), 0);

/** Totals plus the derived figures every table and card needs. */
function withRatio(row) {
  const automatable = sum(row, IN_RATIO);
  const covered = sum(row, COVERED);
  return { ...row, automatable, covered, coveragePct: pct(covered, automatable) };
}

function tally(issues, keyFor) {
  const m = new Map();
  for (const { issue, bucket } of issues) {
    for (const k of keyFor(issue)) {
      if (!m.has(k)) m.set(k, { key: k, ...blank(), total: 0 });
      const row = m.get(k);
      row[bucket]++;
      row.total++;
    }
  }
  return m;
}

/**
 * @param {object} snap    the store snapshot
 * @param {object} opts    `component` (one name) or `components` (several) narrows
 *                         everything; `scope` is the issue type
 */
function view(snap, { component = null, components: wanted = null, scope = 'Epic', statusMap = STATUS_BUCKETS } = {}) {
  const all = Object.values(snap.issues || {}).filter(i => norm(i.issueType) === norm(scope));

  // The selector lists product components only, with their epic counts, so an
  // empty component is visibly empty rather than missing from the list.
  const componentCounts = new Map();
  for (const e of all) for (const c of productComponents(e)) componentCounts.set(c, (componentCounts.get(c) || 0) + 1);
  const components = [...componentCounts.entries()]
    .map(([name, count]) => ({ name, count, family: familyOf(name) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  /* ── the selection ──────────────────────────────────────────────────
     SEVERAL COMPONENTS, OR'D. "Show me these three suites together" is the
     question a lead asks when a client spans them, and it is not answerable by
     three screens side by side — the point is the combined ratio.
     
     An epic in two selected components is counted ONCE here, because `scoped`
     is a filter over epics rather than a union of per-component tallies. The
     grid below still counts it in both of its rows, which is the same rule it
     has always followed and the reason the rows can total more than the
     headline. */
  const asked = (wanted != null ? [].concat(wanted) : (component != null ? [component] : []))
    .map(c => String(c).trim()).filter(Boolean);
  const seenSel = new Set();
  const selectedList = asked.filter(c => componentCounts.has(c) && !seenSel.has(c) && seenSel.add(c));
  const missing = asked.filter(c => !componentCounts.has(c));
  const chosen = new Set(selectedList);
  const scoped = chosen.size ? all.filter(e => productComponents(e).some(c => chosen.has(c))) : all;

  // Kept for every caller written before multi-select: one selected component
  // still reads as `component`, and several read as null rather than as an
  // arbitrary one of them.
  const selected = selectedList.length === 1 ? selectedList[0] : null;

  // Bucket once. Everything below counts the same classification, so the three
  // sections of this screen cannot disagree about a single epic.
  const classified = scoped.map(issue => ({ issue, bucket: bucketOf(issue, statusMap), tool: toolOf(issue) }));

  const counts = blank();
  const unmapped = new Map();
  // An epic labelled obsolete that kept a real status stays in that status —
  // see bucketOf. That is deliberate, and it is also a contradiction worth
  // counting: either the label is stale, or retired work is inside the ratio.
  let obsoleteWithStatus = 0;
  for (const { issue, bucket } of classified) {
    counts[bucket]++;
    if (bucket === 'none' && issue.automationStatus) {
      unmapped.set(issue.automationStatus, (unmapped.get(issue.automationStatus) || 0) + 1);
    }
    if (IN_RATIO.includes(bucket) && isObsolete(issue)) obsoleteWithStatus++;
  }
  const overall = withRatio({ ...counts, total: classified.length });

  /* ── coverage by component ──────────────────────────────────────────
     An epic with two product components counts in both, so the column
     totals exceed the epic count. That is the same rule the maintenance
     report uses, and the alternative — picking one component per epic —
     would quietly under-report every suite that shares work. */
  const byComponent = [...tally(classified, e => productComponents(e)).values()]
    .map(r => withRatio({ ...r, component: r.key, family: familyOf(r.key) }))
    .sort((a, b) => b.total - a.total || a.component.localeCompare(b.component));

  const byFamily = [...tally(classified, e => [familyOf(productComponents(e)[0])]).values()]
    .map(r => withRatio({ ...r, family: r.key }))
    .sort((a, b) => b.total - a.total);

  /* ── TrueTest vs KSE ────────────────────────────────────────────────
     Per COMPONENT, because "which of my suites has moved to TrueTest" is
     the question this section exists for. Each epic lands in exactly one
     tool, so unlike the grid above these rows DO sum to the epic count. */
  const toolRows = new Map();
  for (const { issue, bucket, tool } of classified) {
    for (const c of productComponents(issue)) {
      if (!toolRows.has(c)) {
        toolRows.set(c, {
          component: c, family: familyOf(c), total: 0, untagged: 0,
          ...Object.fromEntries(TOOLS.map(t => [t.key, { key: t.key, label: t.label, ...blank(), total: 0 }])),
        });
      }
      const row = toolRows.get(c);
      row[tool][bucket]++;
      row[tool].total++;
      row.total++;
      if (!hasTool(issue)) row.untagged++;
    }
  }
  const byTool = [...toolRows.values()]
    .map(r => ({
      ...r,
      ...Object.fromEntries(TOOLS.map(t => [t.key, withRatio(r[t.key])])),
      truetestShare: pct(r.truetest.total, r.total),
    }))
    .sort((a, b) => b.total - a.total || a.component.localeCompare(b.component));

  const toolTotals = Object.fromEntries(TOOLS.map(t => {
    const rows = classified.filter(c => c.tool === t.key);
    const row = { ...blank(), total: rows.length };
    for (const { bucket } of rows) row[bucket]++;
    return [t.key, withRatio(row)];
  }));
  const untagged = classified.filter(c => !hasTool(c.issue)).length;

  return {
    scope,
    buckets: BUCKETS.map(b => ({ ...b, count: counts[b.key], share: pct(counts[b.key], classified.length) })),
    ...overall,
    components,
    component: selected,
    // The whole selection, in the order it was asked for. Every screen that
    // wants to know "what am I looking at" reads this; `component` above is the
    // single-selection shorthand the older callers use.
    selected: selectedList,
    componentRequested: asked.length ? asked : null,
    // A component that was asked for and does not exist is said out loud. The
    // alternative — silently showing everything — is a screen that answers a
    // question nobody asked and looks right while doing it.
    componentUnknown: missing.length > 0,
    componentMissing: missing,
    /* How to say what is in view, in one phrase, so twelve sentences across two
       files do not each invent their own. Naming two is clearer than counting
       them; past that the count is the readable form. */
    scopeLabel: !selectedList.length
      ? 'across every component'
      : selectedList.length === 1 ? `in ${selectedList[0]}`
        : selectedList.length === 2 ? `in ${selectedList[0]} and ${selectedList[1]}`
          : `across ${selectedList.length} selected components`,
    byComponent,
    byFamily,
    byTool,
    toolTotals,
    tools: TOOLS,
    untagged,
    untaggedPct: pct(untagged, classified.length),
    obsoleted: counts.obsoleted,
    obsoleteWithStatus,
    untriaged: counts.none,
    unmappedValues: [...unmapped.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count),
    basis: `${classified.length} ${scope}s${selectedList.length ? ` ${selectedList.length === 1 ? 'in' : 'across'} ${selectedList.join(', ')}` : ''}`
      + ' · coverage = (Automated + Maintenance) ÷ (Automated + Maintenance + Ready + Blocked)',
  };
}

/* ══ what needs attention ═══════════════════════════════════════════════
 *
 * The screen above is honest and completely flat: seven buckets, a hundred and
 * twenty-five components, two tools. Everything is on it, which means nothing
 * on it is louder than anything else, and "which of these hundred and
 * twenty-five suites should I do something about on Monday" is left entirely to
 * the reader. This turns that reading into rules.
 *
 * TWO PROPERTIES THIS SECTION HAS TO HAVE, or it is worse than no section:
 *
 *   1. IT IS DERIVED FROM THE VIEW, NOT RECOMPUTED FROM THE ISSUES. `assess`
 *      takes the assembled view object and reads the same fields the tables
 *      render. A risk panel that counts the epics again is a second opinion,
 *      and the day the two disagree is the day the whole screen stops being
 *      believed. There is no path here back to `snap.issues`.
 *
 *   2. IT SCOPES FOR FREE. `view()` already narrows every bucket, tool total
 *      and unmapped value to the selected component, so the same rules fired
 *      against a scoped view are automatically about that component. Only the
 *      rules that RANK components have to know the difference, and those are
 *      the ones that stand down when a single component is in view — there is
 *      nothing to rank.
 *
 * Severities read as verbs, not colours: `risk` means do something, `watch`
 * means it is heading the wrong way, `note` means know this before you quote
 * the number.
 */

const THRESHOLDS = {
  coverageGood: 80,      // the grid's green — above this a suite is healthy
  coveragePoor: 50,      // the grid's red — below this it is behind
  untriagedShare: 10,    // % of epics with no status and no obsolete label
  blockedShare: 5,       // % of automatable work that cannot move
  maintenanceShare: 40,  // % of COVERED work that is maintenance, not plain automated
  maintenanceHeavy: 65,  // …and the point where the suite is mostly firefighting
  untaggedShare: 20,     // % of epics naming neither tool, so the KSE split is a guess
  thinComponent: 3,      // below this an epic count is too small to rank on
  topN: 4,               // how many components a finding names before "and N more"
};

const RANK = { risk: 0, watch: 1, note: 2 };

/**
 * Findings for whatever is in view — every component, or the selected one.
 *
 * @param {object} v        the object `view()` returned
 * @param {object} [opts]   `thresholds` to override the defaults
 * @returns {{findings: Array, counts: object, scope: string|null, clear: boolean}}
 */
function assess(v, opts = {}) {
  const t = { ...THRESHOLDS, ...(opts.thresholds || {}) };
  // Ranking stands down when exactly ONE component is in view — there is
  // nothing to rank against itself. With two or three selected there is, and
  // ranking them against each other is the reason to select them together.
  const selected = v.selected || (v.component ? [v.component] : []);
  const one = selected.length === 1 ? selected[0] : null;
  const noun = String(v.scope || 'Epic').toLowerCase();
  const found = [];
  const add = (f) => { if (f) found.push(f); };

  /**
   * The worst N components by some measure, for a finding to name.
   *
   * `min` is a floor on the MEASURE, not on the component's size. Those are
   * different questions and conflating them hides small piles entirely: one
   * blocked epic in a suite is still the answer to "which suite", even though
   * a three-epic component is too thin to rank a coverage percentage on.
   */
  const worst = (value, { min = 1, unit = '' } = {}) => {
    const rows = (v.byComponent || []).filter(r => value(r) >= min);
    rows.sort((a, b) => value(b) - value(a) || a.component.localeCompare(b.component));
    return {
      named: rows.slice(0, t.topN).map(r => ({ name: r.component, value: value(r), unit })),
      more: Math.max(0, rows.length - t.topN),
      all: rows.length,
    };
  };

  // One phrase for what is in view, taken from the view rather than rebuilt —
  // eleven sentences below interpolate it and they must all say the same thing.
  const here = v.scopeLabel || (one ? `in ${one}` : 'across every component');

  /* ── data integrity first ──────────────────────────────────────────
     These do not describe the work, they describe whether the numbers can be
     trusted at all — so they outrank every finding about the work itself. */

  if ((v.unmappedValues || []).length) {
    const n = v.unmappedValues.reduce((s, u) => s + u.count, 0);
    add({
      id: 'unmapped-status',
      severity: share(n, v.total) >= t.untriagedShare ? 'risk' : 'watch',
      title: 'Automation Status values this tool does not recognise',
      value: n, unit: noun + 's',
      detail: `${v.unmappedValues.map(u => `"${u.value}" (${u.count})`).join(', ')} — counted as No Status, `
        + `which puts them outside the coverage ratio entirely. If one of these is a renamed Jira option for automated work, `
        + `coverage ${here} is being under-reported by up to ${share(n, v.automatable + n)}%.`,
      action: 'Check the field\'s options in Jira, then add the new value to the status map.',
    });
  }

  if (v.obsoleteWithStatus) {
    add({
      id: 'obsolete-in-ratio',
      severity: share(v.obsoleteWithStatus, v.automatable) >= t.untriagedShare ? 'watch' : 'note',
      title: 'Labelled obsolete but still counted in coverage',
      value: v.obsoleteWithStatus, unit: noun + 's',
      detail: `These carry the obsolete label AND a real Automation Status, so the status wins and they stay in the ratio — `
        + `${share(v.obsoleteWithStatus, v.automatable)}% of the ${v.automatable} automatable ${noun}s ${here}. `
        + 'Either the label is stale or retired work is propping up the percentage.',
      action: 'Clear the status on the ones that are genuinely retired, or drop the label from the ones that are not.',
    });
  }

  /* ── the number itself ─────────────────────────────────────────────── */

  if (!v.automatable) {
    add({
      id: 'nothing-automatable',
      severity: 'note',
      title: 'Coverage here is not a meaningful number',
      value: v.total, unit: noun + 's',
      detail: `Nothing ${here} is in the ratio — every ${noun} is N/A, obsoleted or untriaged — so the ${v.coveragePct}% `
        + 'above is dividing by nothing rather than reporting on anything.',
      action: 'Triage these before quoting a coverage figure for this suite.',
    });
  } else if (v.coveragePct < t.coveragePoor) {
    add({
      id: 'coverage-low',
      severity: 'risk',
      title: `Coverage is under ${t.coveragePoor}%`,
      value: v.coveragePct, unit: '%',
      detail: `${v.covered} of ${v.automatable} automatable ${noun}s are covered ${here}. `
        + `${v.buckets.find(b => b.key === 'ready').count} are ready to be picked up.`,
      action: 'The Ready pile is the cheapest place to move this number.',
    });
  } else if (v.coveragePct < t.coverageGood) {
    add({
      id: 'coverage-under-target',
      severity: 'watch',
      title: `Coverage is below the ${t.coverageGood}% mark`,
      value: v.coveragePct, unit: '%',
      detail: `${v.automatable - v.covered} automatable ${noun}s ${here} are still uncovered.`,
      action: null,
    });
  }

  /* ── work that cannot move ─────────────────────────────────────────── */

  const blocked = v.buckets.find(b => b.key === 'blocked').count;
  if (blocked) {
    const s = share(blocked, v.automatable);
    const off = one ? null : worst(r => r.blocked, { unit: ' blocked' });
    add({
      id: 'blocked',
      severity: s >= t.blockedShare * 2 ? 'risk' : s >= t.blockedShare ? 'watch' : 'note',
      title: 'Blocked, and counted against coverage',
      value: blocked, unit: noun + 's',
      detail: `${s}% of the automatable work ${here} is blocked. Blocked sits in the denominator, so it holds coverage down `
        + 'without anyone being able to work on it.',
      components: off ? off.named : null, more: off ? off.more : 0,
      action: 'Each of these needs an owner and a reason, or it needs to be N/A.',
    });
  }

  /* ── the untriaged pile ────────────────────────────────────────────── */

  if (v.untriaged) {
    const s = share(v.untriaged, v.total);
    const off = one ? null : worst(r => r.none, { unit: ' untriaged' });
    add({
      id: 'untriaged',
      severity: s >= t.untriagedShare * 2 ? 'risk' : s >= t.untriagedShare ? 'watch' : 'note',
      title: 'Untriaged — no Automation Status, no obsolete label',
      value: v.untriaged, unit: noun + 's',
      detail: `${s}% of the ${v.total} ${noun}s ${here} have never been assessed. They are outside the ratio, so coverage `
        + `is reporting on ${share(v.automatable, v.total)}% of the work and saying nothing about the rest.`,
      components: off ? off.named : null, more: off ? off.more : 0,
      action: 'Triage decides whether each is automatable — until then the coverage figure covers less than it appears to.',
    });
  }

  /* ── automated, but fragile ────────────────────────────────────────── */

  const maint = v.buckets.find(b => b.key === 'maintenance').count;
  if (v.covered && share(maint, v.covered) >= t.maintenanceShare) {
    const s = share(maint, v.covered);
    add({
      id: 'maintenance-heavy',
      severity: s >= t.maintenanceHeavy ? 'watch' : 'note',
      title: 'Most of what is covered is under maintenance',
      value: s, unit: '% of covered',
      detail: `${maint} of the ${v.covered} covered ${noun}s ${here} are in Maintenance rather than simply Automated. `
        + 'Maintenance counts as covered, which is right — but a suite that is mostly maintenance is being kept alive, not extended.',
      action: 'Worth asking whether the capacity going into fixes is being planned as new coverage.',
    });
  }

  /* ── can the tool split be trusted ─────────────────────────────────── */

  if (v.untagged && v.untaggedPct >= t.untaggedShare) {
    add({
      id: 'tool-untagged',
      severity: 'note',
      title: 'The TrueTest / KSE split rests on an assumption',
      value: v.untagged, unit: noun + 's',
      detail: `${v.untaggedPct}% ${here} carry neither the TrueTest nor the Katalon component and are counted as KSE, `
        + 'on the grounds that those components arrived with the TrueTest rollout. Above this share the split is a guess, not a measurement.',
      action: 'Tagging these is a one-off job that makes every tool number on this page real.',
    });
  }

  /* ── which suites, when you are looking at all of them ─────────────── */

  if (!one) {
    const dead = worst(r => (r.automatable && r.coveragePct === 0 ? r.automatable : 0), { min: t.thinComponent, unit: ' automatable' });
    if (dead.all) {
      add({
        id: 'components-zero',
        severity: 'risk',
        title: 'Components with automatable work and nothing covered',
        value: dead.all, unit: 'components',
        detail: `Each has at least ${t.thinComponent} automatable ${noun}s and not one of them automated or under maintenance. `
          + 'These are the suites that do not exist yet, as opposed to the ones that are merely behind.',
        components: dead.named, more: dead.more,
        action: 'Pick one and the whole screen narrows to it.',
      });
    }

    const zeroNames = new Set(dead.named.map(x => x.name));
    const behindRows = (v.byComponent || [])
      .filter(r => r.automatable >= t.thinComponent && r.coveragePct > 0 && r.coveragePct < t.coveragePoor);
    if (behindRows.length) {
      behindRows.sort((a, b) => a.coveragePct - b.coveragePct || b.automatable - a.automatable);
      add({
        id: 'components-behind',
        severity: 'watch',
        title: `Components under ${t.coveragePoor}% coverage`,
        value: behindRows.length, unit: 'components',
        detail: `Ranked worst first, counting only suites with at least ${t.thinComponent} automatable ${noun}s so a `
          + 'one-epic component cannot sit at the top of the list on a single miss.',
        components: behindRows.filter(r => !zeroNames.has(r.component)).slice(0, t.topN)
          .map(r => ({ name: r.component, value: r.coveragePct, unit: '%' })),
        more: Math.max(0, behindRows.length - t.topN),
        action: null,
      });
    }
  }

  found.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const counts = { risk: 0, watch: 0, note: 0 };
  for (const f of found) counts[f.severity]++;

  return {
    findings: found,
    counts,
    scope: one,
    selected,
    // "Nothing to flag" is a real answer and has to be distinguishable from
    // "this section failed to run", which looks identical when it is empty.
    clear: found.length === 0,
  };
}

/** Local alias so the rules above read as prose. */
function share(a, b) { return pct(a, b); }

module.exports = {
  view, assess, bucketOf, toolOf, hasTool, productComponents, familyOf,
  BUCKETS, TOOLS, TOOL_COMPONENTS, STATUS_BUCKETS, OBSOLETE_LABELS, THRESHOLDS,
};
