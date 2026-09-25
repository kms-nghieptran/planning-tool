'use strict';
/**
 * repo.js — reading and writing the local database in domain terms.
 *
 * Everything above this file talks about issues, sprints and teams. Everything
 * below it is SQL. The one genuinely interesting thing here is the adjustment
 * overlay, so it is worth saying plainly what it does:
 *
 *   ADJUSTING A FIELD writes your value into the entity row AND records the
 *   original in `adjustment`. The row is therefore always what the tool
 *   believes, so every report, aggregate and search agrees with every screen.
 *
 *   A SYNC SKIPS ADJUSTED FIELDS. Jira keeps arriving, the adjustment keeps
 *   winning, and the recorded `jira_value` is refreshed so you can still see
 *   what the source now says and revert to it.
 *
 * That second rule is the whole promise of "this is my primary data source". If
 * a sync could silently undo an estimate you corrected, you would stop trusting
 * every number on the screen, which is exactly where this tool started.
 */

const db = require('./db');

/* ─────────────────────── column ⇄ domain mapping ─────────────────────── */

/**
 * The issue row, in both directions.
 *
 * Kept explicit rather than generated: a typo in a column name should be a
 * readable diff, not a silently dropped field. The domain names match what the
 * rest of the app has always used, so nothing above had to be rewritten.
 */
const ISSUE_COLUMNS = {
  key: 'key',
  project: 'project',
  summary: 'summary',
  issueType: 'issue_type',
  status: 'status',
  statusCategory: 'status_category',
  resolution: 'resolution',
  priority: 'priority',
  assignee: 'assignee',
  assigneeId: 'assignee_id',
  reporter: 'reporter',
  points: 'points',
  parentKey: 'parent_key',
  parentStatus: 'parent_status',
  parentSummary: 'parent_summary',
  parentType: 'parent_type',
  team: 'team',
  automationStatus: 'automation_status',
  created: 'created',
  updated: 'updated',
  resolved: 'resolved',
  dueDate: 'due_date',
  originalEstimate: 'original_estimate',
  timeSpent: 'time_spent',
  source: 'source',
  syncedAt: 'synced_at',
};
const COLUMN_TO_FIELD = Object.fromEntries(Object.entries(ISSUE_COLUMNS).map(([k, v]) => [v, k]));

/** Fields held in their own tables rather than a column. */
const ISSUE_RELATIONS = ['components', 'labels', 'sprints', 'blockedBy', 'relatesTo'];

/**
 * `issue_link` holds more than one kind of link now, and every statement that
 * touches it must say which. Before this there was exactly one kind, so
 * `DELETE FROM issue_link WHERE issue_key = ?` was correct by accident —
 * rewriting an issue's blocked-by links would have wiped its relates-to links
 * with it, on every single sync.
 */
const LINK_KINDS = { blockedBy: 'blockedBy', relatesTo: 'relatesTo' };

/**
 * A link row as the domain sees it: key, summary and type, for BOTH kinds.
 *
 * blockedBy used to come back as a bare key while relatesTo came back whole —
 * and the columns were filled either way, so a summary Jira had already sent
 * was written to the database and then dropped on the way out. That is why a
 * blocker rendered as "Not in the local store" directly beside a related issue
 * showing its summary.
 *
 * Readers that want only keys go through `epics.asLink`, or the view-side
 * equivalent, both of which accept either shape — so nothing has to know which
 * kind of link it is holding.
 */
function linkOut(kind, r) {
  return { key: r.other_key, summary: r.other_summary || null, type: r.other_type || null };
}

/** The reverse: whatever a caller hands us, as the three columns we store. */
function linkIn(v) {
  if (v && typeof v === 'object') return [v.key, v.summary == null ? null : v.summary, v.type == null ? null : v.type];
  return [v, null, null];
}

/** Every field of an issue a user is allowed to adjust. */
const ADJUSTABLE = new Set([...Object.keys(ISSUE_COLUMNS), ...ISSUE_RELATIONS]
  .filter(f => !['key', 'source', 'syncedAt', 'project'].includes(f)));

/* ─────────────────────────── issues ─────────────────────────── */

/**
 * One row of issue_sprint, as the app's sprint object.
 *
 * `start` and `end` are the sprint's dates AS THE ISSUE CARRIES THEM, which
 * are not the board's dates for the same sprint — the board reports a day
 * ("2025-03-06"), an issue reports the instant the sprint actually began
 * ("2025-03-06T17:13:20.835Z"). The flat sprint list comes from here, so these
 * are the timings every sprint-boundary calculation in the app uses.
 *
 * Null dates are dropped rather than kept as nulls, because the old shape
 * omitted the keys entirely and a `start: null` reads as "no start date" to
 * consumers that only check for presence.
 */
function sprintRow(r) {
  const out = {};
  // Keys only when they have a value. Some sprints arrive from Jira with no id
  // at all (an older custom-field format), and the old shape simply had no `id`
  // key on those. `id: null` is not the same thing to a consumer that tests
  // `if (s.id)` versus one that tests `'id' in s`.
  if (r.sprint_jira_id != null) out.id = r.sprint_jira_id;
  out.name = r.sprint_name;
  out.state = r.sprint_state;
  if (r.sprint_start != null) out.start = r.sprint_start;
  if (r.sprint_end != null) out.end = r.sprint_end;
  return out;
}

/** Turn a row plus its relations into the issue shape the app has always used. */
function hydrate(row, rel = {}) {
  if (!row) return null;
  const out = {};
  for (const [field, col] of Object.entries(ISSUE_COLUMNS)) out[field] = row[col];
  out.extra = db.fromJson(row.extra, {}) || {};
  out.datasets = db.fromJson(row.datasets, []) || [];
  if (row.raw) out.raw = db.fromJson(row.raw, null);
  out.components = rel.components || [];
  out.labels = rel.labels || [];
  out.sprints = rel.sprints || [];
  out.sprintNames = (rel.sprints || []).map(s => s.name).filter(Boolean);
  out.sprintIds = (rel.sprints || []).map(s => s.id).filter(Boolean);
  out.blockedBy = rel.blockedBy || [];
  out.relatesTo = rel.relatesTo || [];
  if (rel.adjusted && rel.adjusted.length) out.adjusted = rel.adjusted;
  return out;
}

/**
 * Every live issue, with relations, as the map the rest of the app expects.
 *
 * Four queries rather than one join: a join across four many-to-many tables
 * multiplies rows and then has to be de-duplicated in JS, which is slower and
 * far easier to get subtly wrong than grouping four flat result sets.
 */
function allIssues({ includeDeleted = false } = {}) {
  const where = includeDeleted ? '' : 'WHERE deleted_at IS NULL';
  const rows = db.all(`SELECT * FROM issue ${where}`);
  const keys = new Set(rows.map(r => r.key));

  const group = (sql, make) => {
    const out = new Map();
    for (const r of db.all(sql)) {
      if (!keys.has(r.issue_key)) continue;
      if (!out.has(r.issue_key)) out.set(r.issue_key, []);
      out.get(r.issue_key).push(make(r));
    }
    return out;
  };
  const comps = group('SELECT issue_key, component FROM issue_component', r => r.component);
  const labels = group('SELECT issue_key, label FROM issue_label', r => r.label);
  const sprints = group('SELECT * FROM issue_sprint', sprintRow);
  const links = group(`SELECT * FROM issue_link WHERE kind = 'blockedBy'`, r => linkOut('blockedBy', r));
  const relates = group(`SELECT * FROM issue_link WHERE kind = 'relatesTo'`, r => linkOut('relatesTo', r));
  const adj = group(`SELECT entity_id AS issue_key, field FROM adjustment WHERE entity = 'issue'`, r => r.field);

  const out = {};
  for (const r of rows) {
    out[r.key] = hydrate(r, {
      components: comps.get(r.key), labels: labels.get(r.key),
      sprints: sprints.get(r.key), blockedBy: links.get(r.key),
      relatesTo: relates.get(r.key), adjusted: adj.get(r.key),
    });
  }
  return out;
}

function getIssue(key) {
  const row = db.get('SELECT * FROM issue WHERE key = ?', key);
  if (!row) return null;
  return hydrate(row, {
    components: db.all('SELECT component FROM issue_component WHERE issue_key = ?', key).map(r => r.component),
    labels: db.all('SELECT label FROM issue_label WHERE issue_key = ?', key).map(r => r.label),
    sprints: db.all('SELECT * FROM issue_sprint WHERE issue_key = ?', key).map(sprintRow),
    blockedBy: db.all(`SELECT * FROM issue_link WHERE issue_key = ? AND kind = 'blockedBy'`, key).map(r => linkOut('blockedBy', r)),
    relatesTo: db.all(`SELECT * FROM issue_link WHERE issue_key = ? AND kind = 'relatesTo'`, key).map(r => linkOut('relatesTo', r)),
    adjusted: db.all(`SELECT field FROM adjustment WHERE entity = 'issue' AND entity_id = ?`, key).map(r => r.field),
  });
}

/**
 * Write issues from a sync.
 *
 * `protectAdjusted` is the load-bearing argument. With it on (always, for a
 * sync) a field you have adjusted keeps your value; Jira's newest value is
 * recorded alongside so the Adjustments screen can show the drift and offer to
 * revert. With it off (an import into an empty database) Jira simply wins.
 */
function upsertIssues(issues, { protectAdjusted = true, syncedAt = new Date().toISOString() } = {}) {
  const list = Array.isArray(issues) ? issues : Object.values(issues || {});
  if (!list.length) return { written: 0, protectedFields: 0 };

  const cols = Object.values(ISSUE_COLUMNS).concat(['extra', 'raw', 'datasets', 'deleted_at']);
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols.filter(c => c !== 'key').map(c => `${c} = excluded.${c}`).join(', ');
  const stmt = db.db().prepare(
    `INSERT INTO issue (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT(key) DO UPDATE SET ${updates}`);

  const delComp = db.db().prepare('DELETE FROM issue_component WHERE issue_key = ?');
  const insComp = db.db().prepare('INSERT OR IGNORE INTO issue_component VALUES (?, ?)');
  const delLabel = db.db().prepare('DELETE FROM issue_label WHERE issue_key = ?');
  const insLabel = db.db().prepare('INSERT OR IGNORE INTO issue_label VALUES (?, ?)');
  const delSprint = db.db().prepare('DELETE FROM issue_sprint WHERE issue_key = ?');
  // Columns named, not positional. `VALUES (?, ?, ?, ?)` bound to column order,
  // so the migration that added sprint_start/sprint_end would have started
  // writing the state into a date column with no error anywhere.
  const insSprint = db.db().prepare(`INSERT OR IGNORE INTO issue_sprint
    (issue_key, sprint_jira_id, sprint_name, sprint_state, sprint_start, sprint_end)
    VALUES (?, ?, ?, ?, ?, ?)`);
  // Kind-scoped, and columns named. `VALUES (?, ?, 'blockedBy')` was positional
  // against a three-column table; migration 5 added two more columns to it.
  const delLink = db.db().prepare('DELETE FROM issue_link WHERE issue_key = ? AND kind = ?');
  const insLink = db.db().prepare(`INSERT OR IGNORE INTO issue_link
    (issue_key, other_key, kind, other_summary, other_type) VALUES (?, ?, ?, ?, ?)`);

  let protectedFields = 0;

  db.tx(() => {
    // One lookup for every adjustment up front beats a query per issue.
    const guarded = new Map();
    if (protectAdjusted) {
      for (const r of db.all(`SELECT entity_id, field FROM adjustment WHERE entity = 'issue'`)) {
        if (!guarded.has(r.entity_id)) guarded.set(r.entity_id, new Set());
        guarded.get(r.entity_id).add(r.field);
      }
    }

    for (const raw of list) {
      if (!raw || !raw.key) continue;
      const mine = guarded.get(raw.key);
      const existing = mine && mine.size ? db.get('SELECT * FROM issue WHERE key = ?', raw.key) : null;

      const issue = { ...raw };
      if (mine) {
        for (const field of mine) {
          protectedFields++;
          // Remember what the source NOW says, then put your value back.
          recordJiraValue('issue', raw.key, field, valueOf(raw, field));
          if (ISSUE_COLUMNS[field] && existing) issue[field] = existing[ISSUE_COLUMNS[field]];
          if (ISSUE_RELATIONS.includes(field)) issue[field] = keepRelation(raw.key, field);
        }
      }

      stmt.run(...cols.map(c => {
        if (c === 'extra') return db.toJson(issue.extra || {});
        if (c === 'raw') return issue.raw ? db.toJson(issue.raw) : null;
        if (c === 'datasets') return db.toJson(issue.datasets || []);
        if (c === 'deleted_at') return null;          // seeing it again un-deletes it
        if (c === 'synced_at') return syncedAt;
        if (c === 'source') return issue.source || 'jira';
        const field = COLUMN_TO_FIELD[c];
        const v = issue[field];
        return v === undefined ? null : v;
      }));

      const guard = (f) => !(mine && mine.has(f));
      if (guard('components')) {
        delComp.run(raw.key);
        for (const c of issue.components || []) insComp.run(raw.key, c);
      }
      if (guard('labels')) {
        delLabel.run(raw.key);
        for (const l of issue.labels || []) insLabel.run(raw.key, l);
      }
      if (guard('sprints')) {
        delSprint.run(raw.key);
        const seen = new Set();
        for (const s of issue.sprints || []) {
          const name = s && (s.name || s);
          if (!name || seen.has(name)) continue;
          seen.add(name);
          insSprint.run(raw.key, s.id != null ? String(s.id) : null, String(name), s.state || null,
            s.start || null, s.end || null);
        }
      }
      for (const kind of Object.keys(LINK_KINDS)) {
        if (!guard(kind)) continue;
        delLink.run(raw.key, kind);
        for (const v of issue[kind] || []) {
          const [k, summary, type] = linkIn(v);
          if (k) insLink.run(raw.key, k, kind, summary, type);
        }
      }
    }
  });

  return { written: list.length, protectedFields };
}

/** The current value of a field on a raw (un-stored) issue. */
function valueOf(issue, field) {
  if (field === 'sprints') return (issue.sprints || []).map(s => (s && s.name) || s);
  return issue[field];
}

/** The relation as it stands in the database, so an adjusted one is preserved. */
function keepRelation(key, field) {
  if (field === 'components') return db.all('SELECT component FROM issue_component WHERE issue_key = ?', key).map(r => r.component);
  if (field === 'labels') return db.all('SELECT label FROM issue_label WHERE issue_key = ?', key).map(r => r.label);
  if (LINK_KINDS[field]) {
    return db.all('SELECT * FROM issue_link WHERE issue_key = ? AND kind = ?', key, field).map(r => linkOut(field, r));
  }
  if (field === 'sprints') {
    return db.all('SELECT * FROM issue_sprint WHERE issue_key = ?', key).map(sprintRow);
  }
  return undefined;
}

/**
 * Mark issues the sync no longer sees.
 *
 * Soft, never hard. A board reconfigured for an afternoon, a JQL that stopped
 * matching, a permissions change — none of those are reasons to destroy an
 * adjustment you made. Deleted rows drop out of every read by default.
 */
function softDeleteIssues(keys, at = new Date().toISOString()) {
  if (!keys || !keys.length) return 0;
  const stmt = db.db().prepare('UPDATE issue SET deleted_at = ? WHERE key = ? AND deleted_at IS NULL');
  let n = 0;
  db.tx(() => { for (const k of keys) n += stmt.run(at, k).changes; });
  return n;
}

/* ─────────────────────────── adjustments ─────────────────────────── */

/** Record what the source says, without disturbing your value. */
function recordJiraValue(entity, id, field, jiraValue) {
  db.run(`UPDATE adjustment SET jira_value = ? WHERE entity = ? AND entity_id = ? AND field = ?`,
    db.toJson(jiraValue === undefined ? null : jiraValue), entity, id, field);
}

/**
 * Override a field locally.
 *
 * Writes the effective value into the row and the provenance into `adjustment`,
 * in one transaction — a row that disagreed with its own adjustment record
 * would be the worst of both designs.
 */
function adjust(entity, id, field, value, opts = {}) {
  // A bare string is the obvious way to pass a reason and it used to destructure
  // into `reason: undefined`, which surfaced four frames down as "value cannot
  // be bound to SQLite parameter 6" — a message that says nothing about the
  // call. Accept both shapes.
  const { reason = null, at = new Date().toISOString() } = typeof opts === 'string' ? { reason: opts } : (opts || {});

  if (entity !== 'issue') throw new Error(`Cannot adjust "${entity}" yet — only issues.`);
  if (!ADJUSTABLE.has(field)) {
    throw new Error(`"${field}" is not an adjustable field. Adjustable: ${[...ADJUSTABLE].sort().join(', ')}`);
  }
  const before = getIssue(id);
  if (!before) throw new Error(`No issue "${id}".`);

  return db.tx(() => {
    const existing = db.get(`SELECT jira_value FROM adjustment WHERE entity='issue' AND entity_id=? AND field=?`, id, field);
    // THE ONE GUARD on the original value, and it is deliberately the only one.
    //
    // `jira_value` means "what the source says", so on a SECOND edit it must be
    // the value already recorded — not the value you set the first time, which
    // would make revert walk back one edit instead of returning to Jira.
    //
    // This used to be defended twice: here, and by omitting jira_value from the
    // ON CONFLICT below. Two guards sound safer and are worse — a test can only
    // catch them failing together, so either could rot silently. One guard,
    // stated once, with a check that bites when it breaks.
    const jiraValue = existing ? db.fromJson(existing.jira_value) : valueOf(before, field);

    writeField(id, field, value);
    db.run(
      `INSERT INTO adjustment (entity, entity_id, field, value, jira_value, reason, adjusted_at)
       VALUES ('issue', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity, entity_id, field) DO UPDATE SET
         value = excluded.value, jira_value = excluded.jira_value,
         reason = excluded.reason, adjusted_at = excluded.adjusted_at`,
      id, field, db.toJson(value), db.toJson(jiraValue), reason ?? null, at);

    return { entity: 'issue', id, field, value, jiraValue, reason, at };
  });
}

/** Put a field back to what the source says, and forget the adjustment. */
function revert(entity, id, field) {
  const row = db.get('SELECT * FROM adjustment WHERE entity = ? AND entity_id = ? AND field = ?', entity, id, field);
  if (!row) throw new Error(`Nothing adjusted for ${entity} ${id}.${field}`);
  return db.tx(() => {
    writeField(id, field, db.fromJson(row.jira_value));
    db.run('DELETE FROM adjustment WHERE entity = ? AND entity_id = ? AND field = ?', entity, id, field);
    return { reverted: true, entity, id, field, to: db.fromJson(row.jira_value) };
  });
}

/** Write one field — column or relation — without touching anything else. */
function writeField(key, field, value) {
  if (ISSUE_COLUMNS[field]) {
    db.run(`UPDATE issue SET ${ISSUE_COLUMNS[field]} = ? WHERE key = ?`, value === undefined ? null : value, key);
    return;
  }
  if (field === 'components') {
    db.run('DELETE FROM issue_component WHERE issue_key = ?', key);
    for (const c of value || []) db.run('INSERT OR IGNORE INTO issue_component VALUES (?, ?)', key, c);
    return;
  }
  if (field === 'labels') {
    db.run('DELETE FROM issue_label WHERE issue_key = ?', key);
    for (const l of value || []) db.run('INSERT OR IGNORE INTO issue_label VALUES (?, ?)', key, l);
    return;
  }
  if (LINK_KINDS[field]) {
    db.run('DELETE FROM issue_link WHERE issue_key = ? AND kind = ?', key, field);
    for (const v of value || []) {
      const [k, summary, type] = linkIn(v);
      if (!k) continue;
      db.run(`INSERT OR IGNORE INTO issue_link
        (issue_key, other_key, kind, other_summary, other_type) VALUES (?, ?, ?, ?, ?)`,
        key, k, field, summary, type);
    }
    return;
  }
  if (field === 'sprints') {
    db.run('DELETE FROM issue_sprint WHERE issue_key = ?', key);
    for (const s of value || []) {
      const name = (s && s.name) || s;
      if (!name) continue;
      db.run(`INSERT OR IGNORE INTO issue_sprint
        (issue_key, sprint_jira_id, sprint_name, sprint_state, sprint_start, sprint_end)
        VALUES (?, ?, ?, ?, ?, ?)`,
        key, s && s.id != null ? String(s.id) : null, String(name), (s && s.state) || null,
        (s && s.start) || null, (s && s.end) || null);
    }
    return;
  }
  throw new Error(`Cannot write "${field}".`);
}

/** Everything currently overridden, newest first, with both values. */
function adjustments({ entity = null, id = null } = {}) {
  let sql = 'SELECT * FROM adjustment';
  const params = [];
  const where = [];
  if (entity) { where.push('entity = ?'); params.push(entity); }
  if (id) { where.push('entity_id = ?'); params.push(id); }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY adjusted_at DESC';
  return db.all(sql, ...params).map(r => ({
    entity: r.entity, id: r.entity_id, field: r.field,
    value: db.fromJson(r.value), jiraValue: db.fromJson(r.jira_value),
    reason: r.reason, at: r.adjusted_at,
    // Whether your value STILL differs from what Jira says today. True for
    // almost every adjustment, by construction — you changed it because it was
    // wrong. The interesting case is FALSE: Jira has since been corrected to
    // match, the override is doing nothing, and it can be dropped.
    //
    // It was called `driftedSince`, which read as "Jira changed after you
    // edited" — something this table cannot answer, because a sync overwrites
    // `jira_value` with the newest value each time. A name that promises
    // history the data does not hold is worse than no flag.
    stillDiffers: JSON.stringify(db.fromJson(r.value)) !== JSON.stringify(db.fromJson(r.jira_value)),
  }));
}

/** Add an item that does not exist in Jira at all. */
function createLocalIssue(fields = {}) {
  const key = fields.key || `LOCAL-${Date.now().toString(36).toUpperCase()}`;
  if (db.get('SELECT key FROM issue WHERE key = ?', key)) throw new Error(`${key} already exists.`);
  upsertIssues([{
    issueType: 'Story', status: 'Open', statusCategory: 'new',
    created: new Date().toISOString(), updated: new Date().toISOString(),
    ...fields, key, source: 'local',
  }], { protectAdjusted: false });
  return getIssue(key);
}

module.exports = {
  ISSUE_COLUMNS, ISSUE_RELATIONS, ADJUSTABLE, LINK_KINDS,
  allIssues, getIssue, upsertIssues, softDeleteIssues,
  adjust, revert, adjustments, createLocalIssue, hydrate, writeField,
};
