'use strict';
/**
 * search.js — run a parsed query over the local snapshot.
 *
 * Everything is in memory and local: 7,000 issues filter in a few milliseconds,
 * so the page can re-run the search on every keystroke and every chip click
 * without a spinner. Nothing here touches Jira.
 *
 * Two things beyond plain filtering earn their place:
 *
 *  - FACETS. Each chip dropdown shows how many issues carry each value UNDER
 *    THE OTHER FILTERS. That turns filtering from guesswork ("is there anything
 *    blocked in Malphite?") into reading. A facet computed over the unfiltered
 *    set would be worse than none: it would promise results that are not there.
 *  - COMPUTED FIELDS. Work category, estimated, blocked and sprint state are
 *    not Jira fields but they are what the questions are actually about.
 */

const cls = require('./classify');
const epics = require('./epics');
const { parse, FIELDS } = require('./query');

/* ─────────────────────────── field access ─────────────────────────── */

const norm = (v) => String(v == null ? '' : v).toLowerCase().trim();

/**
 * Read a field off an issue, including the ones Jira does not have.
 * Always returns an array for list-ish fields so the matcher has one shape.
 */
function valueOf(issue, field, ctx) {
  switch (field) {
    case 'key': return issue.key;
    case 'summary': return issue.summary;
    case 'text': return `${issue.key} ${issue.summary}`;
    case 'type': return issue.issueType;
    case 'component': return issue.components || [];
    case 'label': return issue.labels || [];
    case 'sprint': return issue.sprintNames || [];
    case 'sprintState': return (issue.sprints || []).map(s => s && s.state).filter(Boolean);
    case 'parent': return issue.parentKey;
    // The same two rules the Epic column uses, so `epic = AUTOKAT-4412` finds
    // the stories under it AND the maintenance tickets linked to it.
    case 'epic': return epics.epicsFor({ ...issue, category: ctx.categoryOf(issue) }).map(e => e.key);
    case 'relates': return (issue.relatesTo || []).map(l => (l && l.key) || l).filter(Boolean);
    case 'category': return ctx.categoryOf(issue);
    case 'estimated': return issue.points != null && issue.points > 0;
    case 'blocked': return (issue.blockedBy || []).length > 0;
    case 'due': return issue.dueDate;
    default: {
      const def = FIELDS[field];
      // A user-configured Jira field lives under `extra`, keyed by its slug.
      if (def && def.extra) return (issue.extra || {})[field];
      return issue[field];
    }
  }
}

/** A date literal — ISO string or a relative offset — as an epoch ms bound. */
function dateValue(v, now) {
  if (v && typeof v === 'object' && v.rel != null) {
    const mult = { d: 864e5, w: 7 * 864e5, m: 30 * 864e5, y: 365 * 864e5 }[v.unit] || 864e5;
    return now - v.rel * mult;
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

const issueDate = (raw) => {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
};

/* ─────────────────────────── matching ─────────────────────────── */

function matchClause(issue, clause, ctx) {
  const def = FIELDS[clause.field] || { type: 'string' };
  const raw = valueOf(issue, clause.field, ctx);
  const list = Array.isArray(raw) ? raw : [raw];
  const present = list.some(v => v !== null && v !== undefined && v !== '');

  switch (clause.op) {
    case 'is empty': return !present;
    case 'is not empty': return present;
    default: break;
  }

  if (def.type === 'date') {
    const t = issueDate(raw);
    if (t == null) return false;
    const v = clause.values[0];

    // A RELATIVE offset is a moment ("three days ago"), so it compares directly.
    if (v && typeof v === 'object' && v.rel != null) {
      const bound = dateValue(v, ctx.now);
      switch (clause.op) {
        case '>': case '>=': return t >= bound;
        case '<': case '<=': return t <= bound;
        case '=': return sameDay(t, bound);
        case '!=': return !sameDay(t, bound);
        default: return false;
      }
    }

    // A BARE DATE is a whole day, which is the only reading that does not
    // surprise: `created < 2026-08-01` must exclude everything created on the
    // 1st, and `created <= 2026-08-01` must include all of it. Treating the
    // date as an instant at midnight makes those two agree, which is wrong.
    const start = Date.parse(`${v}T00:00:00.000Z`);
    if (Number.isNaN(start)) return false;
    const end = start + 864e5 - 1;
    switch (clause.op) {
      case '=': return t >= start && t <= end;
      case '!=': return t < start || t > end;
      case '>': return t > end;
      case '>=': return t >= start;
      case '<': return t < start;
      case '<=': return t <= end;
      default: return false;
    }
  }

  if (def.type === 'number') {
    const n = raw == null ? null : Number(raw);
    const target = clause.values[0];
    if (clause.op === 'in') return clause.values.some(v => Number(v) === n);
    if (clause.op === 'not in') return !clause.values.some(v => Number(v) === n);
    if (n == null || Number.isNaN(n)) return false;
    switch (clause.op) {
      case '=': return n === target;
      case '!=': return n !== target;
      case '>': return n > target;
      case '>=': return n >= target;
      case '<': return n < target;
      case '<=': return n <= target;
      default: return false;
    }
  }

  if (def.type === 'bool') {
    const b = Boolean(raw);
    const want = clause.values[0];
    return clause.op === '!=' ? b !== want : b === want;
  }

  // Strings, enums and lists all compare case-insensitively: nobody should have
  // to remember whether the status is "In Dev" or "in dev".
  const values = clause.values.map(norm);
  const have = list.map(norm);
  switch (clause.op) {
    case '=': return have.some(v => v === values[0]);
    case '!=': return !have.some(v => v === values[0]);
    case 'in': return have.some(v => values.includes(v));
    case 'not in': return !have.some(v => values.includes(v));
    case '~': return have.some(v => v.includes(values[0]));
    case '!~': return !have.some(v => v.includes(values[0]));
    case '>': return have.some(v => v > values[0]);
    case '>=': return have.some(v => v >= values[0]);
    case '<': return have.some(v => v < values[0]);
    case '<=': return have.some(v => v <= values[0]);
    default: return false;
  }
}

const sameDay = (a, b) => new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);

function matchNode(issue, node, ctx) {
  if (!node) return true;
  if (node.and) return node.and.every(n => matchNode(issue, n, ctx));
  if (node.or) return node.or.some(n => matchNode(issue, n, ctx));
  if (node.not) return !matchNode(issue, node.not, ctx);
  return matchClause(issue, node, ctx);
}

/* ─────────────────────────── facets ─────────────────────────── */

/** Fields worth offering as chips, in the order the UI shows them. */
const FACET_FIELDS = [
  'team', 'sprint', 'type', 'status', 'statusCategory', 'assignee',
  'component', 'label', 'priority', 'automationStatus', 'category', 'resolution', 'sprintState',
];

/**
 * Counts per value for each facet field.
 *
 * Each field's counts are computed with THAT FIELD'S OWN clauses removed, so
 * picking "Story" does not collapse the Type dropdown to a single option —
 * exactly how Jira's own filter counts behave, and the only version that lets
 * you widen a filter as easily as narrow it.
 */
function facets(issues, where, ctx, fields = FACET_FIELDS) {
  fields = fields.filter(f => FIELDS[f]);
  const out = {};
  for (const field of fields) {
    const pruned = withoutField(where, field);
    const counts = new Map();
    for (const issue of issues) {
      if (!matchNode(issue, pruned, ctx)) continue;
      const raw = valueOf(issue, field, ctx);
      const list = (Array.isArray(raw) ? raw : [raw]).filter(v => v !== null && v !== undefined && v !== '');
      if (!list.length) { counts.set('__EMPTY__', (counts.get('__EMPTY__') || 0) + 1); continue; }
      for (const v of list) counts.set(String(v), (counts.get(String(v)) || 0) + 1);
    }
    out[field] = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => (a.value === '__EMPTY__' ? 1 : b.value === '__EMPTY__' ? -1 : 0)
        || b.count - a.count || a.value.localeCompare(b.value));
  }
  return out;
}

/** The same query with every clause on `field` dropped. */
function withoutField(node, field) {
  if (!node) return null;
  if (node.and || node.or) {
    const key = node.and ? 'and' : 'or';
    const kids = node[key].map(n => withoutField(n, field)).filter(Boolean);
    if (!kids.length) return null;
    if (kids.length === 1) return kids[0];
    return { [key]: kids };
  }
  if (node.not) {
    const inner = withoutField(node.not, field);
    return inner ? { not: inner } : null;
  }
  return node.field === field ? null : node;
}

/* ─────────────────────────── sorting ─────────────────────────── */

function sorter(orderBy, ctx) {
  if (!orderBy) {
    // Most recently touched first: the default that answers "what changed?".
    return (a, b) => (issueDate(b.updated) || 0) - (issueDate(a.updated) || 0);
  }
  const { field, dir } = orderBy;
  const def = FIELDS[field] || { type: 'string' };
  const sign = dir === 'desc' ? -1 : 1;
  return (a, b) => {
    const av = flat(valueOf(a, field, ctx));
    const bv = flat(valueOf(b, field, ctx));
    // Empty always sorts last, whichever direction — a blank is not "smallest",
    // it is missing, and burying it under a descending sort hides real rows.
    const ae = av === null || av === undefined || av === '';
    const be = bv === null || bv === undefined || bv === '';
    if (ae && be) return 0;
    if (ae) return 1;
    if (be) return -1;
    if (def.type === 'number') return sign * (Number(av) - Number(bv));
    if (def.type === 'date') return sign * ((issueDate(av) || 0) - (issueDate(bv) || 0));
    if (def.type === 'bool') return sign * ((av ? 1 : 0) - (bv ? 1 : 0));
    return sign * String(av).localeCompare(String(bv), undefined, { numeric: true });
  };
}
const flat = (v) => (Array.isArray(v) ? v[0] : v);

/* ─────────────────────────── the entry point ─────────────────────────── */

/**
 * Run a query.
 *
 * @param {object} snap    the snapshot
 * @param {object} plan    for the categorisation rules
 * @param {string} q       the query string
 * @param {object} opts    { page, pageSize, sort, dir, withFacets, now }
 */
function search(snap, plan, q, opts = {}) {
  const started = Date.now();
  const all = Object.values(snap.issues || {});
  const rules = plan && plan.categoryRules;

  // The user's own synced fields are queryable by name. Registered from the
  // snapshot rather than the config so the parser only ever offers fields that
  // are actually IN the data — promising `"Test Type"` before a sync has pulled
  // it would be an error message waiting to happen.
  const extras = (snap.extraFields || []).filter(f => f.filled > 0);
  require('./query').registerExtraFields(extras);

  // classify() is not free and the same issue is visited by every facet pass,
  // so memoise per run rather than per call.
  const catCache = new Map();
  const ctx = {
    now: opts.now || Date.now(),
    categoryOf: (issue) => {
      if (!catCache.has(issue.key)) catCache.set(issue.key, cls.classify(issue, rules));
      return catCache.get(issue.key);
    },
  };

  let parsed;
  try {
    parsed = parse(q);
  } catch (err) {
    return { error: err.message, at: err.at ?? null, query: q, total: 0, rows: [], facets: {}, tookMs: Date.now() - started };
  }

  const matched = all.filter(i => matchNode(i, parsed.where, ctx));

  const orderBy = opts.sort
    ? { field: opts.sort, dir: opts.dir === 'desc' ? 'desc' : 'asc' }
    : parsed.orderBy;
  matched.sort(sorter(orderBy, ctx));

  const pageSize = Math.min(500, Math.max(1, Number(opts.pageSize) || 50));
  const pages = Math.max(1, Math.ceil(matched.length / pageSize));
  const page = Math.min(pages, Math.max(1, Number(opts.page) || 1));
  const rows = matched.slice((page - 1) * pageSize, page * pageSize)
    .map(i => { const o = { ...i, category: ctx.categoryOf(i) }; o.epics = epics.epicsFor(o); return o; });

  return {
    query: q || '',
    total: matched.length,
    totalAll: all.length,
    page, pages, pageSize,
    sort: orderBy || null,
    rows,
    facets: opts.withFacets === false ? {} : facets(all, parsed.where, ctx,
      FACET_FIELDS.concat(extras.map(f => f.key))),
    // Registered so the UI can offer them as chips and columns.
    extraFields: extras,
    // Sums over the WHOLE match, not the page — a page total answers nothing.
    points: Math.round(matched.reduce((t, i) => t + (Number(i.points) || 0), 0) * 10) / 10,
    unestimated: matched.filter(i => i.points == null || i.points === 0).length,
    tookMs: Date.now() - started,
  };
}

/** Every issue matching the query, unpaged — for CSV export. */
function searchAll(snap, plan, q, opts = {}) {
  const r = search(snap, plan, q, { ...opts, page: 1, pageSize: 500, withFacets: false });
  if (r.error) return r;
  const ctx = { now: opts.now || Date.now(), categoryOf: (i) => cls.classify(i, plan && plan.categoryRules) };
  const parsed = parse(q);
  const matched = Object.values(snap.issues || {}).filter(i => matchNode(i, parsed.where, ctx));
  matched.sort(sorter(opts.sort ? { field: opts.sort, dir: opts.dir } : parsed.orderBy, ctx));
  return { ...r, rows: matched.map(i => { const o = { ...i, category: ctx.categoryOf(i) }; o.epics = epics.epicsFor(o); return o; }) };
}

/**
 * The columns a result table can show, and how each renders.
 *
 * `def: true` is the starting set — enough to recognise a row without making it
 * unreadable. Everything else is one click away rather than absent.
 */
const COLUMNS = [
  { key: 'key', label: 'Key', def: true, width: 110, mono: true },
  { key: 'summary', label: 'Summary', def: true, wrap: true },
  { key: 'type', label: 'Type', def: true },
  { key: 'status', label: 'Status', def: true },
  { key: 'assignee', label: 'Assignee', def: true },
  { key: 'points', label: 'Points', def: true, num: true },
  { key: 'sprint', label: 'Sprint', def: true },
  { key: 'priority', label: 'Priority' },
  { key: 'component', label: 'Components' },
  { key: 'label', label: 'Labels' },
  { key: 'category', label: 'Work type' },
  { key: 'automationStatus', label: 'Automation status' },
  { key: 'team', label: 'Team' },
  { key: 'statusCategory', label: 'Status category' },
  { key: 'resolution', label: 'Resolution' },
  { key: 'parent', label: 'Parent', mono: true },
  { key: 'blocked', label: 'Blocked' },
  { key: 'created', label: 'Created', date: true },
  { key: 'updated', label: 'Updated', date: true },
  { key: 'resolved', label: 'Resolved', date: true },
  { key: 'due', label: 'Due', date: true },
];

/** The built-in columns plus whatever extra Jira fields are in the snapshot. */
function columnsFor(snap) {
  return COLUMNS.concat((snap.extraFields || [])
    .filter(f => f.filled > 0)
    .map(f => ({ key: f.key, label: f.name, extra: true })));
}

/** One row flattened for CSV: list fields joined, dates trimmed to the day. */
function toRow(issue, columns, ctx, allColumns = COLUMNS) {
  const out = {};
  for (const key of columns) {
    const col = allColumns.find(c => c.key === key);
    if (!col) continue;
    const v = valueOf(issue, key, ctx);
    out[col.label] = Array.isArray(v) ? v.join('; ')
      : col.date && v ? String(v).slice(0, 10)
      : v == null ? '' : v;
  }
  return out;
}

module.exports = { search, searchAll, facets, matchNode, valueOf, withoutField, toRow, columnsFor, FACET_FIELDS, COLUMNS };
