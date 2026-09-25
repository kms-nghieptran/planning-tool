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

/* ── the vocabulary a rule may use ────────────────────────────────────────
   Declared once, as data, because a rule editor has to offer exactly the
   fields and operators the matcher understands. Two lists — one in a dropdown,
   one in a switch — is a rule you can save that silently never matches, and
   "silently never matches" is the worst failure this file has: the work is
   classified as Other and every mix chart in the app quietly shifts. */

const FIELDS = [
  { key: 'labels', label: 'Label', note: "Jira's labels", list: true, get: (i) => i.labels || [] },
  { key: 'components', label: 'Component', note: 'Any component on the issue', list: true, get: (i) => i.components || [] },
  { key: 'summary', label: 'Summary', note: 'The issue title', get: (i) => i.summary || '' },
  { key: 'issueType', label: 'Issue type', note: 'Story, Bucket Story, Defect…', get: (i) => i.issueType || '' },
  { key: 'autoStatus', label: 'Automation status', note: 'The Automation Status field', get: (i) => i.automationStatus || '' },
  { key: 'status', label: 'Status', note: 'Workflow status', get: (i) => i.status || '' },
  // `epicKey` has never existed on an issue, so a rule on this field could only
  // ever compare against the empty string — it silently never matched. The epic
  // of a Story is its parent, which is the thing that does exist.
  { key: 'epic', label: 'Epic', note: 'The parent epic key', get: (i) => i.epicKey || i.parentKey || '' },
];

const OPS = [
  { key: 'equals', label: 'is exactly' },
  { key: 'includes', label: 'is one of' },
  { key: 'contains', label: 'contains' },
  { key: 'startsWith', label: 'starts with' },
];

const FIELD_BY_KEY = new Map(FIELDS.map(f => [f.key, f]));
const OP_KEYS = new Set(OPS.map(o => o.key));

function fieldValue(issue, field) {
  const f = FIELD_BY_KEY.get(field);
  return f ? f.get(issue) : '';
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

/* ── editing the rules ────────────────────────────────────────────────────
   These are the team's own rules, edited in Settings, and a bad one does not
   throw — it just never matches, and the work lands in Other. That is why this
   validates rather than trusting: a rule you cannot see is wrong is worse than
   one that refuses to save. */

const isBlank = (v) => String(v == null ? '' : v).trim() === '';

/**
 * Check and normalise a set of rules.
 *
 * @returns {{rules: Array, errors: Array<{at:number, message:string}>}}
 *          `rules` is the cleaned list — safe to store when `errors` is empty.
 */
function validateRules(input) {
  const errors = [];
  const rules = [];
  if (input != null && !Array.isArray(input)) {
    return { rules: [], errors: [{ at: 0, message: 'Rules must be a list' }] };
  }
  (input || []).forEach((r, i) => {
    const at = i + 1;
    const rule = {
      id: !isBlank(r && r.id) ? String(r.id).trim() : `r${at}`,
      field: String((r && r.field) || '').trim(),
      op: String((r && r.op) || '').trim(),
      value: r && r.value == null ? '' : String(r.value),
      category: String((r && r.category) || '').trim(),
    };
    if (!FIELD_BY_KEY.has(rule.field)) errors.push({ at, message: `Rule ${at}: "${rule.field || '(none)'}" is not a field this tool can match on` });
    if (!OP_KEYS.has(rule.op)) errors.push({ at, message: `Rule ${at}: "${rule.op || '(none)'}" is not an operator` });
    if (!CATEGORIES[rule.category]) errors.push({ at, message: `Rule ${at}: "${rule.category || '(none)'}" is not a category` });
    // A blank value matches nothing on every operator here, so a rule with one
    // is dead weight that looks live — exactly the shape that makes a mix chart
    // wrong without anything on screen being visibly broken.
    if (isBlank(rule.value)) errors.push({ at, message: `Rule ${at}: needs a value — a blank one never matches` });
    rules.push(rule);
  });
  // Ids are how a row is tracked while being reordered; two the same and a drag
  // moves the wrong one.
  const seen = new Set();
  rules.forEach((r, i) => {
    if (seen.has(r.id)) r.id = `r${i + 1}-${Math.random().toString(36).slice(2, 6)}`;
    seen.add(r.id);
  });
  return { rules, errors };
}

/**
 * How many of these issues each rule actually claims.
 *
 * FIRST MATCH WINS, so a count of "issues this rule matches" would be a lie for
 * every rule but the first: rule 4 can match a thousand issues and claim none
 * of them because rule 2 got there first. This counts what each rule WINS,
 * which is the number that explains the mix chart — and it makes a rule that
 * has been shadowed into uselessness visible instead of merely present.
 *
 * THE SET, NOT JUST ITS SIZE. The Wins column opens a drawer listing what it
 * counted, so the walk below returns the KEYS each rule won and the count is
 * their length. A drawer that re-walked the rules to build its own list could
 * disagree with the figure that opened it — and both would render perfectly,
 * which is the failure every drill-in in this app is built to avoid.
 */
function decide(issues, rules) {
  const list = (rules && rules.length ? rules : DEFAULT_RULES);
  const byRule = new Map(list.map(r => [r.id, []]));
  const unmatched = [];
  for (const issue of issues || []) {
    const winner = list.find(r => matches(issue, r));
    if (winner) byRule.get(winner.id).push(issue.key);
    else unmatched.push(issue.key);
  }
  return { byRule, unmatched, total: (issues || []).length };
}

function ruleHits(issues, rules) {
  const d = decide(issues, rules);
  return {
    byRule: Object.fromEntries([...d.byRule].map(([id, keys]) => [id, keys.length])),
    unmatched: d.unmatched.length,
    total: d.total,
  };
}

/**
 * The issues ONE rule wins, for the drawer behind its count.
 *
 * `ruleId` may be the sentinel `__unmatched`, which is the Other pile — the
 * issues no rule claimed at all. It is the same walk either way, so the list
 * and the number beside it cannot come apart.
 */
const UNMATCHED = '__unmatched';

/* THE CAP LIVES HERE, WITH THE SET IT CUTS. His `issueType = Story` rule wins
   3,369 issues; a drawer cannot show them and the payload should not carry
   them. `total` stays the TRUE size whatever `limit` does, because a list
   quietly shorter than the number that opened it is the one thing a drill-in
   must never be — and a caller computing the total from the cut list would
   report the cut as the whole truth without ever looking wrong. */
function winnersOf(issues, rules, ruleId, { limit = 0 } = {}) {
  const d = decide(issues, rules);
  const all = ruleId === UNMATCHED ? d.unmatched : (d.byRule.get(ruleId) || []);
  const keys = limit > 0 ? all.slice(0, limit) : all;
  return {
    ruleId, keys,
    total: all.length,
    shown: keys.length,
    truncated: keys.length < all.length,
    known: ruleId === UNMATCHED || d.byRule.has(ruleId),
  };
}

module.exports = {
  CATEGORIES, DEFAULT_RULES, DEFAULT_TARGETS, classify, mix, mixVsTarget, matches,
  FIELDS, OPS, validateRules, ruleHits, decide, winnersOf, UNMATCHED,
};
