'use strict';
/**
 * integrity.js — is the stored data internally consistent?
 *
 * This exists because "are my 9,296 issues duplicated?" is a fair question that
 * took a person asking and an agent digging to answer. It should be a thing the
 * tool says about itself, on a screen, at any time.
 *
 * Every check here is cheap (indexed counts) and STRUCTURAL — it compares the
 * store against itself and against what the last sync recorded Jira saying. It
 * makes no network calls, so it is safe to run on every page load and it works
 * off VPN.
 *
 * A check reports `ok: false` only for something that CANNOT be true, never for
 * something merely surprising. A number that looks high is a question for a
 * person; a number that contradicts another number is a defect.
 */

const db = require('./db');

/** Datasets whose JQLs are mutually exclusive, so no issue may carry both. */
const IMPOSSIBLE_PAIRS = [
  // "sprint IS NOT EMPTY" and "sprint IS EMPTY"
  ['sprintWork', 'backlog'],
];

function check(name, detail, ok, extra = {}) {
  return { name, detail, ok, ...extra };
}

function run() {
  const rows = [];

  /* ── duplicates ─────────────────────────────────────────────────────
     The issue key is the PRIMARY KEY, so a duplicate is impossible by
     construction. Checked anyway, and stated as such: an assertion that
     cannot fail is still worth showing to someone who is asking whether
     it holds. */
  const total = db.get('SELECT count(*) c FROM issue').c;
  const distinct = db.get('SELECT count(DISTINCT key) c FROM issue').c;
  rows.push(check(
    'No duplicate work items',
    `${total.toLocaleString()} rows, ${distinct.toLocaleString()} distinct keys — the key is the primary key, so a second copy cannot be stored`,
    total === distinct,
    { total, distinct },
  ));

  /* ── contradictory dataset membership ───────────────────────────── */
  for (const [a, b] of IMPOSSIBLE_PAIRS) {
    const n = db.get(
      `SELECT count(*) c FROM issue
        WHERE deleted_at IS NULL AND datasets LIKE ? AND datasets LIKE ?`,
      `%"${a}"%`, `%"${b}"%`,
    ).c;
    rows.push(check(
      `Nothing is both "${a}" and "${b}"`,
      n === 0
        ? 'Those two sync queries are mutually exclusive, and nothing claims to be in both'
        : `${n} items claim to be in both. Their queries cannot both match — a full sync rewrites these.`,
      n === 0,
      { count: n },
    ));
  }

  /* ── relations pointing at nothing ──────────────────────────────── */
  for (const [table, label] of [
    ['issue_component', 'component links'],
    ['issue_label', 'label links'],
    ['issue_sprint', 'sprint links'],
  ]) {
    const n = db.get(
      `SELECT count(*) c FROM ${table} WHERE issue_key NOT IN (SELECT key FROM issue)`,
    ).c;
    rows.push(check(
      `No orphaned ${label}`,
      n === 0
        ? 'Every link points at an item that exists — guaranteed by a foreign key, not merely observed'
        : `${n} links point at an item that is not stored`,
      n === 0,
      { count: n },
    ));
  }

  /* ── what the last sync says Jira said ──────────────────────────── */
  for (const v of db.setting.get('snapshot.verification') || []) {
    rows.push(check(
      `${v.dataset}: counted against Jira`,
      v.remote == null
        ? 'Jira did not return a count to compare against'
        : `${Number(v.local).toLocaleString()} stored · ${Number(v.remote).toLocaleString()} in Jira${v.checkedAt ? ` · checked ${v.checkedAt.slice(0, 10)}` : ''}`,
      v.ok !== false,
      { local: v.local, remote: v.remote, jql: v.jql },
    ));
  }

  /* ── where the Epic column gets its answers ─────────────────────────
     Neither number can be "wrong", so neither can fail. They are here because
     an empty Epic column has two completely different causes and the fix for
     one is not the fix for the other: no parents means stories are not filed
     under an epic in Jira; no relates-to links means the sync has not run
     since the tool started asking for them. Without this you cannot tell
     which, and would go looking in the wrong place. */
  const live = 'deleted_at IS NULL';
  const withParent = db.get(`SELECT count(*) c FROM issue WHERE ${live} AND parent_key IS NOT NULL`).c;
  const withRelates = db.get(
    `SELECT count(DISTINCT issue_key) c FROM issue_link WHERE kind = 'relatesTo'
      AND issue_key IN (SELECT key FROM issue WHERE ${live})`).c;
  const liveTotal = db.get(`SELECT count(*) c FROM issue WHERE ${live}`).c;
  // Can the epic be shown BY NAME? Either because the sync stored the parent's
  // name on the item, or because the epic is itself one of the issues we hold.
  const named = db.get(
    `SELECT count(*) c FROM issue i WHERE i.deleted_at IS NULL AND i.parent_key IS NOT NULL
      AND (i.parent_summary IS NOT NULL OR EXISTS (SELECT 1 FROM issue p WHERE p.key = i.parent_key))`).c;

  rows.push(check(
    'Epics: parent links (new implementation)',
    `${withParent.toLocaleString()} of ${liveTotal.toLocaleString()} items sit under a parent · ${
      named.toLocaleString()} of those can be shown by name`,
    true,
    { count: withParent, named },
  ));
  rows.push(check(
    'Epics: "relates to" links (maintenance)',
    withRelates === 0
      ? 'None stored. These are only captured from a sync run since this column was added — a full sync fills them.'
      : `${withRelates.toLocaleString()} items link to related work`,
    true,
    { count: withRelates },
  ));

  /* ── soft-deleted items, which are a state and not a fault ──────── */
  const hidden = db.get('SELECT count(*) c FROM issue WHERE deleted_at IS NOT NULL').c;
  rows.push(check(
    'Items the sync stopped seeing',
    hidden === 0
      ? 'None — every stored item still matches a sync query'
      : `${hidden} hidden rather than destroyed, so any local adjustment on them survives`,
    true,          // never a failure: this is exactly what soft delete is for
    { count: hidden },
  ));

  return { rows, ok: rows.every(r => r.ok), failing: rows.filter(r => !r.ok) };
}

module.exports = { run, IMPOSSIBLE_PAIRS };
