'use strict';
/**
 * csv.js — manual path in and out.
 *
 * Every dataset in this tool has a manual fallback: you can run the whole thing
 * from a Jira CSV export with no API token at all, and you can export any view
 * for a status deck. RFC-4180 quoting, handled properly.
 */

function parse(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

function toObjects(text) {
  const rows = parse(text);
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => {
      // Jira exports repeat a column name per value (Components, Labels, Sprint…)
      if (o[h] !== undefined) {
        o[h] = Array.isArray(o[h]) ? o[h].concat(r[i]) : [o[h], r[i]];
      } else o[h] = r[i];
    });
    return o;
  });
}

const pick = (o, ...names) => {
  for (const n of names) {
    const key = Object.keys(o).find(k => k.toLowerCase() === n.toLowerCase());
    if (key !== undefined && o[key] !== undefined && o[key] !== '') return o[key];
  }
  return undefined;
};
const list = (v) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).flatMap(x => String(x).split(';')).map(s => s.trim()).filter(Boolean));

/** Map a Jira CSV export onto the same shape jira.js produces. */
function issuesFromJiraCsv(text) {
  return toObjects(text).map(o => {
    const status = one(pick(o, 'Status'));
    const resolution = one(pick(o, 'Resolution'));
    const statusCategory = (one(pick(o, 'Status Category')) || '').toLowerCase();
    return {
      key: one(pick(o, 'Issue key', 'Key')),
      summary: one(pick(o, 'Summary')),
      issueType: one(pick(o, 'Issue Type', 'Issue type')),
      status,
      statusCategory: (statusCategory === 'done' || /^(done|closed|resolved)$/i.test(status || ''))
        ? 'done'
        : (/in dev|in testing|in progress|review/i.test(status || '') ? 'indeterminate' : 'new'),
      assignee: one(pick(o, 'Assignee')),
      reporter: one(pick(o, 'Reporter')),
      labels: list(pick(o, 'Labels')),
      components: list(pick(o, 'Components', 'Component/s')),
      priority: one(pick(o, 'Priority')),
      resolution,
      created: one(pick(o, 'Created')),
      updated: one(pick(o, 'Updated')),
      resolved: one(pick(o, 'Resolved')),
      dueDate: one(pick(o, 'Due date', 'Due Date')),
      parentKey: one(pick(o, 'parent', 'Parent', 'Parent Link', 'Epic Link')),
      points: numOrNull(pick(o, 'Story Points', 'Story point estimate', 'Custom field (Story Points)')),
      sprintNames: list(pick(o, 'Sprint')),
      sprints: list(pick(o, 'Sprint')).map(n => ({ name: n })),
      automationStatus: one(pick(o, 'Automation Status')),
      team: one(pick(o, 'Team')),
      blockedBy: [],
      relatesTo: [],
      project: one(pick(o, 'Project key', 'Project')),
    };
  }).filter(i => i.key);
}

function one(v) { return Array.isArray(v) ? v.find(x => String(x).trim()) : v; }
function numOrNull(v) { const n = Number(one(v)); return Number.isFinite(n) ? n : null; }

function stringify(rows, headers) {
  const cols = headers || [...new Set(rows.flatMap(r => Object.keys(r)))];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}

module.exports = { parse, toObjects, issuesFromJiraCsv, stringify };
