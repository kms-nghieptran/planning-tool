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
 * @param {object} opts    `component` narrows everything; `scope` is the issue type
 */
function view(snap, { component = null, scope = 'Epic', statusMap = STATUS_BUCKETS } = {}) {
  const all = Object.values(snap.issues || {}).filter(i => norm(i.issueType) === norm(scope));

  // The selector lists product components only, with their epic counts, so an
  // empty component is visibly empty rather than missing from the list.
  const componentCounts = new Map();
  for (const e of all) for (const c of productComponents(e)) componentCounts.set(c, (componentCounts.get(c) || 0) + 1);
  const components = [...componentCounts.entries()]
    .map(([name, count]) => ({ name, count, family: familyOf(name) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const selected = component && componentCounts.has(component) ? component : null;
  const scoped = selected ? all.filter(e => productComponents(e).includes(selected)) : all;

  // Bucket once. Everything below counts the same classification, so the three
  // sections of this screen cannot disagree about a single epic.
  const classified = scoped.map(issue => ({ issue, bucket: bucketOf(issue, statusMap), tool: toolOf(issue) }));

  const counts = blank();
  const unmapped = new Map();
  for (const { issue, bucket } of classified) {
    counts[bucket]++;
    if (bucket === 'none' && issue.automationStatus) {
      unmapped.set(issue.automationStatus, (unmapped.get(issue.automationStatus) || 0) + 1);
    }
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
    componentRequested: component || null,
    // A component that was asked for and does not exist is said out loud. The
    // alternative — silently showing everything — is a screen that answers a
    // question nobody asked and looks right while doing it.
    componentUnknown: Boolean(component && !selected),
    byComponent,
    byFamily,
    byTool,
    toolTotals,
    tools: TOOLS,
    untagged,
    untaggedPct: pct(untagged, classified.length),
    obsoleted: counts.obsoleted,
    untriaged: counts.none,
    unmappedValues: [...unmapped.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count),
    basis: `${classified.length} ${scope}s${selected ? ` in ${selected}` : ''} · coverage = (Automated + Maintenance) ÷ (Automated + Maintenance + Ready + Blocked)`,
  };
}

module.exports = {
  view, bucketOf, toolOf, hasTool, productComponents, familyOf,
  BUCKETS, TOOLS, TOOL_COMPONENTS, STATUS_BUCKETS, OBSOLETE_LABELS,
};
