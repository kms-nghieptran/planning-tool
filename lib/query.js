'use strict';
/**
 * query.js — a small, honest subset of JQL.
 *
 * The point is a round trip: the filter chips on the Search page COMPILE to a
 * query string, and a query string you type PARSES back into chips. One
 * representation, two ways in. That is why this is a real parser rather than
 * string concatenation — a query you can read but not edit back is a dead end.
 *
 * What is supported, stated plainly so nobody has to discover it by failing:
 *
 *   clause     field OP value            status = Done
 *   lists      field IN (a, b, c)        type IN (Story, Defect)
 *   negation   field != v | NOT IN (…)   assignee != "Hien Phan"
 *   contains   field ~ "text"            summary ~ login
 *   emptiness  field IS EMPTY            sprint IS EMPTY
 *   ranges     field >= value            points >= 3, created >= -14d
 *   logic      AND, OR, parentheses      a = 1 AND (b = 2 OR c = 3)
 *   ordering   ORDER BY field [ASC|DESC]
 *
 * What is NOT supported, and fails loudly rather than quietly matching nothing:
 * functions (currentUser(), startOfWeek()), WAS/CHANGED history operators, and
 * saved-filter references. A query that cannot be honoured is an error with a
 * position, never an empty result set that looks like a real answer.
 */

/* ─────────────────────────── the field catalogue ─────────────────────────── */

/**
 * Every queryable field. `type` drives both parsing and how a value is compared;
 * `aliases` exist because muscle memory from Jira types `issuetype` and `text`.
 */
const FIELDS = {
  key:              { type: 'string', label: 'Key' },
  summary:          { type: 'string', label: 'Summary' },
  text:             { type: 'string', label: 'Text', synthetic: true, label2: 'key + summary' },
  type:             { type: 'enum', label: 'Type', aliases: ['issuetype'], facet: 'issueType' },
  status:           { type: 'enum', label: 'Status' },
  statusCategory:   { type: 'enum', label: 'Status category' },
  resolution:       { type: 'enum', label: 'Resolution' },
  priority:         { type: 'enum', label: 'Priority' },
  assignee:         { type: 'enum', label: 'Assignee' },
  reporter:         { type: 'enum', label: 'Reporter' },
  component:        { type: 'list', label: 'Component', aliases: ['components'] },
  label:            { type: 'list', label: 'Label', aliases: ['labels'] },
  sprint:           { type: 'list', label: 'Sprint', aliases: ['sprints'] },
  sprintState:      { type: 'enum', label: 'Sprint state' },
  team:             { type: 'enum', label: 'Team' },
  project:          { type: 'enum', label: 'Project' },
  automationStatus: { type: 'enum', label: 'Automation status', aliases: ['automation'] },
  category:         { type: 'enum', label: 'Work type' },
  parent:           { type: 'string', label: 'Parent', aliases: ['parentKey'] },
  epic:             { type: 'list',   label: 'Epic', aliases: ['epics'] },
  relates:          { type: 'list',   label: 'Relates to', aliases: ['relatesTo'] },
  points:           { type: 'number', label: 'Story points', aliases: ['storypoints'] },
  estimated:        { type: 'bool', label: 'Estimated' },
  blocked:          { type: 'bool', label: 'Blocked' },
  created:          { type: 'date', label: 'Created' },
  updated:          { type: 'date', label: 'Updated' },
  resolved:         { type: 'date', label: 'Resolved', aliases: ['resolutiondate'] },
  due:              { type: 'date', label: 'Due', aliases: ['duedate'] },
};

const ALIAS = {};
function indexAliases() {
  for (const k of Object.keys(ALIAS)) delete ALIAS[k];
  for (const [name, def] of Object.entries(FIELDS)) {
    ALIAS[name.toLowerCase()] = name;
    for (const a of def.aliases || []) ALIAS[a.toLowerCase()] = name;
  }
}
indexAliases();

/**
 * Make the user's own synced Jira fields queryable by name.
 *
 * A custom field you configured and synced but cannot filter on is a field you
 * did not really get. Registering it here is what puts it in the parser, the
 * error message's list of known fields, and the chips — so `"Test Type" = E2E`
 * works the same way `status = Done` does.
 *
 * Re-registering replaces the previous set: the config is the source of truth,
 * and a field removed from it must stop being queryable rather than lingering.
 */
function registerExtraFields(list = []) {
  for (const [name, def] of Object.entries(FIELDS)) if (def.extra) delete FIELDS[name];
  for (const f of list) {
    const key = String((f && (f.key || f.id)) || '').trim();
    if (!key || FIELDS[key]) continue;          // never shadow a built-in field
    FIELDS[key] = {
      type: f.numeric ? 'number' : 'list',      // list matching also covers scalars
      label: f.name || key,
      extra: true,
      fieldId: f.id || key,
    };
  }
  indexAliases();
  return Object.keys(FIELDS).filter(k => FIELDS[k].extra);
}

const OPS = ['>=', '<=', '!=', '!~', '=', '>', '<', '~'];
const WORD_OPS = ['in', 'is'];

/* ─────────────────────────── tokenizer ─────────────────────────── */

function tokenize(input) {
  const out = [];
  const s = String(input || '');
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === ',') { out.push({ t: c, at: i }); i++; continue; }
    if (c === '"' || c === "'") {
      const quote = c; let j = i + 1; let val = '';
      while (j < s.length && s[j] !== quote) {
        if (s[j] === '\\' && j + 1 < s.length) { val += s[j + 1]; j += 2; continue; }
        val += s[j]; j++;
      }
      if (j >= s.length) throw queryError('Unclosed quote', i);
      out.push({ t: 'str', v: val, at: i });
      i = j + 1; continue;
    }
    const op = OPS.find(o => s.startsWith(o, i));
    if (op) { out.push({ t: 'op', v: op, at: i }); i += op.length; continue; }
    // bare word: stops at whitespace, punctuation and operators
    let j = i;
    while (j < s.length && !/[\s(),"']/.test(s[j]) && !OPS.some(o => s.startsWith(o, j))) j++;
    if (j === i) throw queryError(`Unexpected character "${c}"`, i);
    out.push({ t: 'word', v: s.slice(i, j), at: i });
    i = j;
  }
  return out;
}

function queryError(message, at, near) {
  const e = new Error(near ? `${message} near "${near}"` : message);
  e.name = 'QueryError';
  e.at = at;
  return e;
}

/* ─────────────────────────── parser ─────────────────────────── */

/**
 * Parse a query string into `{ where, orderBy }`.
 *
 * `where` is a tree of {and:[…]} / {or:[…]} / clause nodes. A clause is
 * `{ field, op, values }` with `op` already normalised, so the matcher never has
 * to think about syntax again.
 */
function parse(input) {
  const text = String(input || '').trim();
  if (!text) return { where: null, orderBy: null };

  // ORDER BY is split off first: it is a tail, not part of the boolean tree.
  let orderBy = null;
  const ob = /\border\s+by\b/i.exec(text);
  let body = text;
  if (ob) {
    body = text.slice(0, ob.index);
    orderBy = parseOrderBy(text.slice(ob.index + ob[0].length), ob.index);
  }

  const toks = tokenize(body);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const isKeyword = (tok, word) => tok && tok.t === 'word' && tok.v.toLowerCase() === word;

  function parseExpr() {
    let node = parseAnd();
    while (isKeyword(peek(), 'or')) {
      next();
      const rhs = parseAnd();
      node = node && node.or ? { or: [...node.or, rhs] } : { or: [node, rhs] };
    }
    return node;
  }
  function parseAnd() {
    let node = parsePrimary();
    while (isKeyword(peek(), 'and')) {
      next();
      const rhs = parsePrimary();
      node = node && node.and ? { and: [...node.and, rhs] } : { and: [node, rhs] };
    }
    return node;
  }
  function parsePrimary() {
    const tok = peek();
    if (!tok) throw queryError('Query ends unexpectedly — a condition is missing', body.length);
    if (tok.t === '(') {
      next();
      const inner = parseExpr();
      const close = next();
      if (!close || close.t !== ')') throw queryError('Missing closing parenthesis', tok.at);
      return inner;
    }
    if (isKeyword(tok, 'not')) {
      next();
      return { not: parsePrimary() };
    }
    return parseClause();
  }

  function parseClause() {
    const fieldTok = next();
    if (!fieldTok || fieldTok.t !== 'word') {
      throw queryError('Expected a field name', fieldTok ? fieldTok.at : 0, fieldTok && fieldTok.v);
    }
    const field = ALIAS[fieldTok.v.toLowerCase()];
    if (!field) {
      throw queryError(`Unknown field "${fieldTok.v}". Known fields: ${Object.keys(FIELDS).join(', ')}`, fieldTok.at);
    }

    const opTok = next();
    if (!opTok) throw queryError(`"${fieldTok.v}" needs an operator`, fieldTok.at);

    // IS EMPTY / IS NOT EMPTY
    if (opTok.t === 'word' && opTok.v.toLowerCase() === 'is') {
      let negate = false;
      if (isKeyword(peek(), 'not')) { next(); negate = true; }
      const what = next();
      if (!what || what.t !== 'word' || !/^(empty|null)$/i.test(what.v)) {
        throw queryError('Expected EMPTY or NULL after IS', opTok.at);
      }
      return { field, op: negate ? 'is not empty' : 'is empty', values: [] };
    }

    // IN (…) / NOT IN (…)
    if (opTok.t === 'word' && ['in', 'not'].includes(opTok.v.toLowerCase())) {
      let negate = false;
      if (opTok.v.toLowerCase() === 'not') {
        negate = true;
        const inTok = next();
        if (!inTok || inTok.t !== 'word' || inTok.v.toLowerCase() !== 'in') {
          throw queryError('Expected IN after NOT', opTok.at);
        }
      }
      const open = next();
      if (!open || open.t !== '(') throw queryError('Expected ( after IN', opTok.at);
      const values = [];
      for (;;) {
        const v = next();
        if (!v) throw queryError('Unclosed IN list', open.at);
        if (v.t === ')') break;
        if (v.t === ',') continue;
        if (v.t !== 'word' && v.t !== 'str') throw queryError('Unexpected value in IN list', v.at);
        values.push(coerce(field, v.v, v.at));
      }
      if (!values.length) throw queryError('IN list is empty', open.at);
      return { field, op: negate ? 'not in' : 'in', values };
    }

    if (opTok.t !== 'op') throw queryError(`Expected an operator after "${fieldTok.v}"`, opTok.at, opTok.v);

    const valTok = next();
    if (!valTok || (valTok.t !== 'word' && valTok.t !== 'str')) {
      throw queryError(`"${fieldTok.v} ${opTok.v}" needs a value`, opTok.at);
    }
    // `field = EMPTY` is idiomatic Jira and worth honouring.
    if (valTok.t === 'word' && /^(empty|null)$/i.test(valTok.v)) {
      return { field, op: opTok.v === '!=' ? 'is not empty' : 'is empty', values: [] };
    }
    return { field, op: opTok.v, values: [coerce(field, valTok.v, valTok.at)] };
  }

  // "ORDER BY points" on its own is a legitimate query: show everything, sorted.
  if (!toks.length) return { where: null, orderBy };

  const where = parseExpr();
  if (pos < toks.length) {
    const t = toks[pos];
    throw queryError('Unexpected text — did you mean AND or OR?', t.at, t.v);
  }
  return { where, orderBy };
}

function parseOrderBy(text, offset) {
  const parts = String(text).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) throw queryError('ORDER BY needs a field', offset);
  const field = ALIAS[parts[0].toLowerCase()];
  if (!field) throw queryError(`Cannot sort by unknown field "${parts[0]}"`, offset);
  const dir = parts[1] && /^desc$/i.test(parts[1]) ? 'desc' : 'asc';
  return { field, dir };
}

/**
 * Turn a literal into the type its field compares in.
 *
 * Dates accept ISO (2026-09-01) and relative offsets (-14d, -2w, -3m), because
 * "changed in the last fortnight" is the question people actually ask, and a
 * hard-coded date in a saved search goes stale the day after you save it.
 */
function coerce(field, raw, at) {
  const def = FIELDS[field];
  const v = String(raw);
  if (def.type === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) throw queryError(`"${v}" is not a number`, at);
    return n;
  }
  if (def.type === 'bool') {
    if (/^(true|yes|1)$/i.test(v)) return true;
    if (/^(false|no|0)$/i.test(v)) return false;
    throw queryError(`"${v}" is not true or false`, at);
  }
  if (def.type === 'date') {
    const rel = /^-(\d+)([dwmy])$/i.exec(v);
    if (rel) return { rel: Number(rel[1]), unit: rel[2].toLowerCase() };
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    throw queryError(`"${v}" is not a date (use 2026-09-01 or -14d)`, at);
  }
  return v;
}

/* ─────────────────────────── serializer ─────────────────────────── */

/** Does this value need quoting to survive a round trip through the tokenizer? */
function quote(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v && typeof v === 'object' && v.rel != null) return `-${v.rel}${v.unit}`;
  const s = String(v);
  return /^[A-Za-z0-9_.\-/]+$/.test(s) && !/^(and|or|not|in|is|empty|null|order)$/i.test(s)
    ? s : `"${s.replace(/(["\\])/g, '\\$1')}"`;
}

/** Render a parsed tree back to a query string. parse(stringify(x)) === x. */
function stringify(parsed) {
  if (!parsed) return '';
  const where = parsed.where ? render(parsed.where, 0) : '';
  const ob = parsed.orderBy ? ` ORDER BY ${parsed.orderBy.field}${parsed.orderBy.dir === 'desc' ? ' DESC' : ''}` : '';
  return (where + ob).trim();
}

function render(node, depth) {
  if (!node) return '';
  if (node.and) return wrap(node.and.map(n => render(n, depth + 1)).join(' AND '), depth);
  if (node.or) return wrap(node.or.map(n => render(n, depth + 1)).join(' OR '), depth);
  if (node.not) return `NOT ${render(node.not, depth + 1)}`;
  const { field, op, values } = node;
  if (op === 'is empty') return `${field} IS EMPTY`;
  if (op === 'is not empty') return `${field} IS NOT EMPTY`;
  if (op === 'in' || op === 'not in') return `${field} ${op.toUpperCase()} (${values.map(quote).join(', ')})`;
  return `${field} ${op} ${quote(values[0])}`;
}
// Parenthesise only where precedence would otherwise change the meaning.
const wrap = (s, depth) => (depth > 0 ? `(${s})` : s);

/* ─────────────────────────── chips ⇄ query ─────────────────────────── */

/**
 * Compile the UI's chip state into a query string.
 *
 * Chips are `{ field: [values…] }` plus a free-text box. Several values on one
 * field mean OR (an IN list); different fields mean AND — which is what people
 * expect from a filter bar, and what Jira's basic mode does.
 */
function fromChips(chips = {}, textQuery = '') {
  const clauses = [];
  for (const [field, raw] of Object.entries(chips)) {
    if (!ALIAS[field.toLowerCase()]) continue;
    const name = ALIAS[field.toLowerCase()];
    const values = (Array.isArray(raw) ? raw : [raw]).filter(v => v !== '' && v != null);
    if (!values.length) continue;
    if (values.length === 1 && values[0] === '__EMPTY__') { clauses.push({ field: name, op: 'is empty', values: [] }); continue; }
    if (values.length === 1) clauses.push({ field: name, op: '=', values: [castChip(name, values[0])] });
    else clauses.push({ field: name, op: 'in', values: values.map(v => castChip(name, v)) });
  }
  const text = String(textQuery || '').trim();
  if (text) clauses.push({ field: 'text', op: '~', values: [text] });
  if (!clauses.length) return '';
  return stringify({ where: clauses.length === 1 ? clauses[0] : { and: clauses }, orderBy: null });
}

function castChip(field, v) {
  const t = FIELDS[field].type;
  if (t === 'number') return Number(v);
  if (t === 'bool') return v === true || v === 'true';
  return String(v);
}

/**
 * Read a query back into chip state, reporting what would not fit.
 *
 * A query with OR across fields, or a range, cannot be shown as chips. Rather
 * than dropping those silently — which would make the chips lie about what is
 * being filtered — they come back in `unrepresentable` so the UI can say the
 * chips are a partial view and leave the query string in charge.
 */
function toChips(queryString) {
  const parsed = parse(queryString);
  const chips = {};
  const unrepresentable = [];
  let text = '';

  const clauses = !parsed.where ? [] : parsed.where.and ? parsed.where.and : [parsed.where];
  for (const c of clauses) {
    if (c.and || c.or || c.not) { unrepresentable.push(stringify({ where: c })); continue; }
    if (c.field === 'text' && c.op === '~') { text = c.values[0]; continue; }
    if (c.op === '=' ) { (chips[c.field] = chips[c.field] || []).push(c.values[0]); continue; }
    if (c.op === 'in') { chips[c.field] = (chips[c.field] || []).concat(c.values); continue; }
    if (c.op === 'is empty') { chips[c.field] = ['__EMPTY__']; continue; }
    unrepresentable.push(stringify({ where: c }));
  }
  return { chips, text, unrepresentable, orderBy: parsed.orderBy };
}

/* This file runs in BOTH places: Node executes queries with it, and the browser
   uses it to compile chips into a query and read one back into chips. Shipping a
   second copy to the page would guarantee the two drift, so the server serves
   this very file at /shared/query.js and it exports either way. */
const API = { FIELDS, ALIAS, parse, stringify, fromChips, toChips, tokenize, quote, registerExtraFields };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else if (typeof window !== 'undefined') window.QueryChips = API;
