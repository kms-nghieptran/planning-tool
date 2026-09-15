'use strict';
/**
 * classify.js — what KIND of work is this?
 *
 * The sheet has no work-type column; the category is smeared across Issue Type,
 * Labels, Components and Summary prefixes. This module makes that explicit and
 * editable, because the whole point of the Backlog and Forecast views is being
 * able to say "we are spending 60% of the sprint on maintenance".
 *
 * Rules are evaluated in order, first match wins. They live in plan.json so the
 * team can change them in Settings without touching code.
 */

const CATEGORIES = {
  new:         { label: 'New implementation', color: 'var(--cat-new)',   note: 'New automated coverage' },
  maintenance: { label: 'Maintenance',        color: 'var(--cat-maint)', note: 'Fixing/updating existing tests' },
  technical:   { label: 'Technical work',     color: 'var(--cat-tech)',  note: 'Framework, tooling, CI, migration' },
  support:     { label: 'Support & analysis', color: 'var(--cat-supp)',  note: 'Triage, grooming, investigation' },
  other:       { label: 'Other',              color: 'var(--cat-other)', note: 'Unclassified' },
};

/** Shipped defaults, derived from how AUTOKAT is actually labelled today. */
const DEFAULT_RULES = [
  { id: 'r1',  category: 'maintenance', field: 'labels',     op: 'includes',    value: 'Maintenance' },
  { id: 'r2',  category: 'maintenance', field: 'summary',    op: 'startsWith',  value: 'Maintenance:' },
  { id: 'r3',  category: 'maintenance', field: 'components', op: 'includes',    value: 'KAT_Common_Maintenance' },
  { id: 'r4',  category: 'maintenance', field: 'autoStatus', op: 'equals',      value: 'Maintenance' },
  { id: 'r5',  category: 'technical',   field: 'summary',    op: 'startsWith',  value: 'Tech:' },
  { id: 'r6',  category: 'technical',   field: 'components', op: 'includes',    value: 'KAT_Framework_Optimization' },
  { id: 'r7',  category: 'technical',   field: 'summary',    op: 'startsWith',  value: 'Migration' },
  { id: 'r8',  category: 'support',     field: 'labels',     op: 'includes',    value: 'Grooming' },
  { id: 'r9',  category: 'support',     field: 'summary',    op: 'startsWith',  value: 'Grooming' },
  { id: 'r10', category: 'new',         field: 'issueType',  op: 'equals',      value: 'Story' },
  { id: 'r11', category: 'technical',   field: 'issueType',  op: 'equals',      value: 'Bucket Story' },
];

function fieldValue(issue, field) {
  switch (field) {
    case 'labels':     return issue.labels || [];
    case 'components': return issue.components || [];
    case 'summary':    return issue.summary || '';
    case 'issueType':  return issue.issueType || '';
    case 'autoStatus': return issue.automationStatus || '';
    case 'status':     return issue.status || '';
    // `epicKey` has never existed on an issue, so a rule on this field could
    // only ever compare against the empty string — it silently never matched.
    // The epic of a Story is its parent, which is the thing that does exist.
    case 'epic':       return issue.epicKey || issue.parentKey || '';
    default:           return '';
  }
}

function matches(issue, rule) {
  const v = fieldValue(issue, rule.field);
  const target = String(rule.value || '');
  const list = Array.isArray(v) ? v : [String(v)];
  switch (rule.op) {
    case 'includes':   return list.some(x => String(x).toLowerCase() === target.toLowerCase());
    case 'contains':   return list.some(x => String(x).toLowerCase().includes(target.toLowerCase()));
    case 'startsWith': return list.some(x => String(x).toLowerCase().startsWith(target.toLowerCase()));
    case 'equals':     return list.some(x => String(x).toLowerCase() === target.toLowerCase());
    default:           return false;
  }
}

/** @returns {string} one of the CATEGORIES keys */
function classify(issue, rules) {
  if (issue.categoryOverride && CATEGORIES[issue.categoryOverride]) return issue.categoryOverride;
  for (const rule of (rules && rules.length ? rules : DEFAULT_RULES)) {
    if (matches(issue, rule)) return CATEGORIES[rule.category] ? rule.category : 'other';
  }
  return 'other';
}

/** Points split by category, plus each category's share of the total. */
function mix(issues, rules) {
  const out = {};
  for (const key of Object.keys(CATEGORIES)) out[key] = { points: 0, count: 0, share: 0 };
  let total = 0;
  for (const it of issues || []) {
    const cat = classify(it, rules);
    const pts = Number(it.points) || 0;
    out[cat].points += pts;
    out[cat].count += 1;
    total += pts;
  }
  for (const key of Object.keys(out)) {
    out[key].points = Math.round(out[key].points * 10) / 10;
    out[key].share = total ? Math.round(out[key].points / total * 1000) / 10 : 0;
  }
  return { byCategory: out, totalPoints: Math.round(total * 10) / 10, totalCount: (issues || []).length };
}

/** Work-mix target bands per team, e.g. keep maintenance under 35% of a sprint. */
const DEFAULT_TARGETS = { new: [45, 100], maintenance: [0, 35], technical: [5, 25], support: [0, 15] };

function mixVsTarget(mixResult, targets) {
  const t = Object.assign({}, DEFAULT_TARGETS, targets || {});
  return Object.keys(t).map(cat => {
    const share = (mixResult.byCategory[cat] || {}).share || 0;
    const [lo, hi] = t[cat];
    return { category: cat, share, min: lo, max: hi, status: share > hi ? 'over' : (share < lo ? 'under' : 'ok') };
  });
}

module.exports = { CATEGORIES, DEFAULT_RULES, DEFAULT_TARGETS, classify, mix, mixVsTarget, matches };
