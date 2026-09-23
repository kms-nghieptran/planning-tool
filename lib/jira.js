'use strict';
/**
 * jira.js — thin Jira Cloud REST v3 client (no dependencies, Node >= 20 fetch).
 *
 * Only this module talks to Jira. Everything else reads the local snapshot.
 * Uses POST /rest/api/3/search/jql with nextPageToken, falling back to the legacy
 * GET /rest/api/3/search on older instances.
 */

const sprintDates = require('./sprint-dates');

const FIELDS = [
  'summary', 'issuetype', 'status', 'assignee', 'reporter', 'labels', 'components',
  'priority', 'resolution', 'created', 'updated', 'resolutiondate', 'duedate',
  'parent', 'issuelinks', 'timeoriginalestimate', 'timespent', 'project',
];

class Jira {
  constructor(cfg) {
    this.baseUrl = String(cfg.baseUrl || '').replace(/\/+$/, '');
    this.email = cfg.email;
    this.token = cfg.apiToken;
    this.projectKey = cfg.projectKey || 'AUTOKAT';
    this.storyPointsField = cfg.storyPointsField || null;      // discovered on first sync
    this.sprintField = cfg.sprintField || null;
    this.automationStatusField = cfg.automationStatusField || null;
    this.teamField = cfg.teamField || null;
    // Anything else the user asked to keep: [{ id, name, key }]
    this.extraFields = (cfg.extraFields || []).map(f => (typeof f === 'string' ? f : f.id)).filter(Boolean);
    this.extraFieldMeta = (cfg.extraFields || []).filter(f => f && typeof f === 'object');
    this.syncAllFields = Boolean(cfg.syncAllFields);
    /* THE BOARD'S TIMEZONE, which decides what day a sprint boundary falls on.
       His boards are Asia/Bangkok, where local midnight is 17:00Z the day
       before — so reading the timestamps in UTC put Sprint 41's START on the
       wrong day, not just its end.

       Configurable, but normally discovered: `timeZone()` asks Jira for the
       account's own zone, which is the one the boards were scheduled in. Null
       until then, and null means UTC — the old behaviour, so a sync that
       cannot reach `/myself` still works and is merely a day out where it
       always was. */
    this.tz = cfg.timeZone || null;
  }

  /**
   * The timezone sprint dates are read in, asked of Jira once per client.
   *
   * Cached on the instance rather than per call: a sync reads several boards
   * and this would otherwise be a round trip each time, for a value that
   * cannot change mid-sync.
   */
  async timeZone() {
    if (this.tz !== null) return this.tz;
    try {
      const me = await this.request('/rest/api/3/myself');
      this.tz = (me && me.timeZone) || '';
    } catch (_) {
      this.tz = '';        // asked, unavailable — do not ask again this sync
    }
    return this.tz;
  }

  get configured() { return Boolean(this.baseUrl && this.email && this.token); }

  async request(pathname, options = {}) {
    if (!this.configured) throw new Error('Jira is not configured — add baseUrl, email and apiToken in Settings.');
    const url = `${this.baseUrl}${pathname}`;
    const auth = Buffer.from(`${this.email}:${this.token}`).toString('base64');
    let res;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(Number(process.env.HTTP_TIMEOUT_MS) || 60000),
        ...options,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
      });
    } catch (err) {
      const host = new URL(this.baseUrl).host;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error(`${host} did not respond within 60s — check the VPN, then try again.`);
      }
      throw new Error(`Could not reach ${host} — ${err.message}`);
    }
    if (res.status === 401 || res.status === 403) throw new Error('Jira rejected the credentials (401/403). Check the email and API token.');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Jira ${res.status} on ${pathname}: ${body.slice(0, 300)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  /** Find the custom field ids this instance uses for points / sprint / automation status. */
  async discoverFields() {
    const fields = await this.request('/rest/api/3/field');
    const all = (...names) => {
      const lowered = names.map(n => n.toLowerCase());
      return fields.filter(f => lowered.includes(String(f.name || '').toLowerCase())).map(f => f.id);
    };
    const find = (...names) => all(...names)[0] || null;

    // Jira Cloud routinely carries SEVERAL fields called "Story Points" — a legacy
    // company-managed one, a team-managed "Story point estimate", and whatever a
    // migration left behind. Only one of them holds values, and taking the first
    // name match gives an entire project estimated at nothing. Keep them all;
    // calibrateStoryPointsField() below settles it against the data.
    this.storyPointsCandidates = all('Story Points', 'Story point estimate', 'Story Point Estimate');
    this.storyPointsField = this.storyPointsField || this.storyPointsCandidates[0] || null;
    this.sprintField = this.sprintField || find('Sprint');
    this.automationStatusField = this.automationStatusField || find('Automation Status');
    this.teamField = this.teamField || find('Team');
    return {
      storyPointsField: this.storyPointsField,
      storyPointsCandidates: this.storyPointsCandidates,
      sprintField: this.sprintField,
      automationStatusField: this.automationStatusField,
      teamField: this.teamField,
    };
  }

  /**
   * Pick the story-points field that actually holds values in THIS project.
   *
   * One cheap count per candidate — `<field> IS NOT EMPTY` — and the winner is the
   * one Jira says is populated. This is not a nicety: against AUTOKAT the
   * name-matched field was empty on all 7,140 issues, so every estimate in the
   * tool read as zero and no view could tell an estimated item from an
   * unestimated one. Configure `jira.storyPointsField` to skip this entirely.
   */
  async calibrateStoryPointsField(projectKey, { configured } = {}) {
    if (configured) return { field: configured, reason: 'configured', counts: [] };
    const candidates = (this.storyPointsCandidates || [this.storyPointsField]).filter(Boolean);
    if (candidates.length < 2) return { field: this.storyPointsField, reason: 'only one candidate', counts: [] };

    const counts = [];
    for (const id of candidates) {
      try {
        const c = await this.count(`project = ${projectKey} AND "${id}" IS NOT EMPTY`);
        counts.push({ field: id, populated: c.value ?? 0 });
      } catch (_) {
        counts.push({ field: id, populated: 0, error: true });   // a field with no context 400s — that is a no
      }
    }
    const best = counts.slice().sort((a, b) => b.populated - a.populated)[0];
    if (best && best.populated > 0) this.storyPointsField = best.field;
    return {
      field: this.storyPointsField,
      reason: best && best.populated > 0 ? `populated on ${best.populated} issues` : 'no candidate holds any value',
      counts,
    };
  }

  /**
   * The field catalogue plus a sample of real issues carrying EVERY field.
   *
   * One query, not one per candidate: `fields: ['*all']` brings the whole shape
   * back for a sample, and counting what is populated across it identifies the
   * right field for each role in a way a name match never can.
   *
   * The sample is deliberately ordered by most-recently-updated: a field that
   * was abandoned two years ago should not look healthy because the oldest
   * issues still carry it.
   */
  async probeFields({ sampleSize = 120, projectKey = null } = {}) {
    const catalogue = await this.request('/rest/api/3/field');
    const p = projectKey || this.projectKey;
    const jql = `project = ${p} ORDER BY updated DESC`;
    let issues = [];
    try {
      const data = await this.request('/rest/api/3/search/jql', {
        method: 'POST',
        body: JSON.stringify({ jql, fields: ['*all'], maxResults: Math.min(100, sampleSize) }),
      });
      issues = data.issues || [];
      // One more page when the caller asked for more than a page holds.
      if (issues.length && sampleSize > issues.length && data.nextPageToken) {
        const more = await this.request('/rest/api/3/search/jql', {
          method: 'POST',
          body: JSON.stringify({ jql, fields: ['*all'], maxResults: Math.min(100, sampleSize - issues.length), nextPageToken: data.nextPageToken }),
        });
        issues = issues.concat(more.issues || []);
      }
    } catch (err) {
      if (/404|410/.test(err.message)) {
        const q = `jql=${encodeURIComponent(jql)}&fields=*all&maxResults=${Math.min(100, sampleSize)}`;
        const data = await this.request(`/rest/api/3/search?${q}`);
        issues = data.issues || [];
      } else throw err;
    }
    return { catalogue, sample: issues };
  }

  /**
   * Which fields to ask Jira for.
   *
   * `*navigable` pulls everything the user could see on a board — the escape
   * hatch for an instance whose field mapping nobody can pin down. It makes the
   * snapshot several times larger, so it is opt-in and says so in the UI.
   */
  fieldList() {
    if (this.syncAllFields) return ['*navigable'];
    return FIELDS
      .concat([this.storyPointsField, this.sprintField, this.automationStatusField, this.teamField].filter(Boolean))
      .concat(this.extraFields || []);
  }

  /** Run a JQL query, paging to the end. */
  async search(jql, { max = 5000 } = {}) {
    const out = [];
    const seen = new Set();
    let token = null;
    const fields = this.fieldList();
    for (let page = 0; page < 200; page++) {
      let data;
      try {
        data = await this.request('/rest/api/3/search/jql', {
          method: 'POST',
          body: JSON.stringify({ jql, fields, maxResults: 100, ...(token ? { nextPageToken: token } : {}) }),
        });
      } catch (err) {
        if (page === 0 && /404|410/.test(err.message)) return this.searchLegacy(jql, { max });
        throw err;
      }
      for (const issue of data.issues || []) {
        if (seen.has(issue.key)) continue;      // paging a set being edited can repeat
        seen.add(issue.key);
        out.push(this.normalise(issue));
      }
      token = data.nextPageToken;
      if (!token || out.length >= max) break;
    }
    return out;
  }

  /**
   * The same query, plus each issue's Automation Status transition history.
   *
   * WHY THIS IS A SEPARATE METHOD and not a flag on `search`. Asking for the
   * changelog changes what the call costs and what it is for: `search` feeds the
   * snapshot on every sync and has to stay cheap, while this runs once to
   * backfill a history nobody had. Folding them together would put a changelog
   * expansion on the hot path for a field most screens never read.
   *
   * ONE FIELD, NOT ALL OF THEM. Jira's changelog carries every edit an issue has
   * ever had — summary rewrites, assignee churn, rank drags. Filtering to the
   * Automation Status field here rather than at the caller keeps the returned
   * object small enough to hold a whole project in memory, which is what the
   * reconstruction needs.
   *
   * Jira caps embedded histories per issue. When it says there are more than it
   * returned, the issue is flagged `truncated` rather than being silently
   * treated as complete — a reconstruction built on a partial history is wrong
   * in a way that looks entirely plausible.
   *
   * @returns {Array} [{ key, created, automationStatus, components, labels,
   *                     transitions: [{ at, from, to }], truncated }]
   */
  async searchWithHistory(jql, { max = 5000, onProgress = null } = {}) {
    const field = this.automationStatusField;
    const out = [];
    const seen = new Set();
    let token = null;

    for (let page = 0; page < 200; page++) {
      const data = await this.request('/rest/api/3/search/jql', {
        method: 'POST',
        body: JSON.stringify({
          // `expand` is a COMMA-SEPARATED STRING on this endpoint, not an array.
          // Jira answers an array with a flat 400 — "Invalid request payload" —
          // so the changelog never arrived and the backfill this feeds could
          // not have worked. Verified against the live instance both ways.
          jql, fields: this.fieldList(), maxResults: 100, expand: 'changelog',
          ...(token ? { nextPageToken: token } : {}),
        }),
      });
      for (const issue of data.issues || []) {
        if (seen.has(issue.key)) continue;
        seen.add(issue.key);
        const base = this.normalise(issue);
        const log = issue.changelog || {};
        const histories = log.histories || [];
        const transitions = [];
        for (const h of histories) {
          for (const item of h.items || []) {
            // Matched on the field id when we know it, and on the human name as
            // a fallback: an instance that renamed the field still reports the
            // name, and an instance we could not map the id on has nothing else.
            const isIt = (field && item.fieldId === field)
              || String(item.field || '').toLowerCase() === 'automation status';
            if (!isIt) continue;
            transitions.push({ at: h.created, from: item.fromString ?? null, to: item.toString ?? null });
          }
        }
        out.push({
          key: base.key, created: base.created, automationStatus: base.automationStatus,
          components: base.components || [], labels: base.labels || [], issueType: base.issueType,
          transitions,
          truncated: Number(log.total || 0) > histories.length,
        });
      }
      onProgress && onProgress(out.length);
      token = data.nextPageToken;
      if (!token || out.length >= max) break;
    }
    return out;
  }

  async searchLegacy(jql, { max = 5000 } = {}) {
    const out = []; const seen = new Set();
    const fields = this.fieldList().join(',');
    for (let start = 0; start < max; start += 100) {
      const q = `jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(fields)}&startAt=${start}&maxResults=100`;
      const data = await this.request(`/rest/api/3/search?${q}`);
      for (const issue of data.issues || []) {
        if (seen.has(issue.key)) continue;
        seen.add(issue.key); out.push(this.normalise(issue));
      }
      if (start + 100 >= (data.total || 0)) break;
    }
    return out;
  }

  /** Exact count for a JQL, used to verify the local snapshot matches Jira. */
  async count(jql) {
    try {
      const data = await this.request(`/rest/api/3/search?jql=${encodeURIComponent(stripOrderBy(jql))}&maxResults=0`);
      if (typeof data.total === 'number') return { value: data.total, exact: true };
    } catch (_) { /* fall through */ }
    try {
      const data = await this.request('/rest/api/3/search/approximate-count', {
        method: 'POST', body: JSON.stringify({ jql: stripOrderBy(jql) }),
      });
      if (typeof data.count === 'number') return { value: data.count, exact: false };
    } catch (_) { /* not checked */ }
    return { value: null, exact: false };
  }

  normalise(issue) {
    const f = issue.fields || {};
    const sprintRaw = this.sprintField ? f[this.sprintField] : null;
    const sprints = Array.isArray(sprintRaw)
      ? sprintRaw.map(s => (typeof s === 'string'
          ? parseSprintString(s)
          : { id: s.id != null ? String(s.id) : null, name: s.name, state: s.state, start: s.startDate, end: s.endDate }))
      : [];
    const points = this.storyPointsField ? numberOrNull(f[this.storyPointsField]) : null;
    return {
      key: issue.key,
      summary: f.summary || '',
      issueType: f.issuetype && f.issuetype.name,
      status: f.status && f.status.name,
      statusCategory: f.status && f.status.statusCategory && f.status.statusCategory.key, // 'new'|'indeterminate'|'done'
      assignee: f.assignee ? f.assignee.displayName : null,
      assigneeId: f.assignee ? f.assignee.accountId : null,
      reporter: f.reporter ? f.reporter.displayName : null,
      labels: f.labels || [],
      components: (f.components || []).map(c => c.name),
      priority: f.priority && f.priority.name,
      resolution: f.resolution && f.resolution.name,
      created: f.created, updated: f.updated, resolved: f.resolutiondate, dueDate: f.duedate,
      parentKey: f.parent && f.parent.key,
      parentStatus: f.parent && f.parent.fields && f.parent.fields.status && f.parent.fields.status.name,
      // The parent's own name and type, which Jira hands over inside `parent`
      // and this used to throw away. For a Story that parent IS the epic, so
      // keeping them is the difference between showing a key and showing an
      // epic — without a second round trip to fetch an issue we do not sync.
      parentSummary: f.parent && f.parent.fields && f.parent.fields.summary,
      parentType: f.parent && f.parent.fields && f.parent.fields.issuetype && f.parent.fields.issuetype.name,
      points,
      sprints,
      sprintNames: sprints.map(s => s.name).filter(Boolean),
      sprintIds: sprints.map(s => s.id).filter(Boolean),
      automationStatus: this.automationStatusField ? nameOf(f[this.automationStatusField]) : null,
      team: this.teamField ? nameOf(f[this.teamField]) : null,
      blockedBy: (f.issuelinks || [])
        .filter(l => l.inwardIssue && /block|depend/i.test((l.type && l.type.inward) || ''))
        .map(l => l.inwardIssue.key),
      relatesTo: relatesLinks(f.issuelinks),
      originalEstimate: f.timeoriginalestimate ? f.timeoriginalestimate / 3600 : null,
      timeSpent: f.timespent ? f.timespent / 3600 : null,
      project: f.project && f.project.key,
      ...(this.extraFields.length ? { extra: this.extractExtras(f) } : {}),
    };
  }

  /**
   * Keep the extra fields the user asked for, flattened to something usable.
   *
   * Raw Jira values are objects, arrays of objects, or ADF documents — none of
   * which can be filtered or put in a CSV cell. They are reduced to a string or
   * a number here, at the edge, so nothing downstream has to know what shape a
   * custom field arrives in. A field with no value is left out rather than
   * stored as null, which keeps the snapshot from growing by an empty key per
   * issue per field.
   */
  extractExtras(f) {
    const out = {};
    for (const id of this.extraFields) {
      const raw = f[id];
      if (raw === null || raw === undefined || raw === '') continue;
      const v = flattenValue(raw);
      if (v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
      const meta = this.extraFieldMeta.find(m => m.id === id);
      out[(meta && meta.key) || id] = v;
    }
    return out;
  }

  /** Page any Agile API collection (startAt / maxResults / isLast). */
  async agilePage(pathname, { max = 2000, key = 'values' } = {}) {
    const out = [];
    for (let start = 0; start < max; start += 50) {
      const sep = pathname.includes('?') ? '&' : '?';
      const data = await this.request(`${pathname}${sep}startAt=${start}&maxResults=50`);
      const rows = data[key] || data.issues || [];
      out.push(...rows);
      if (data.isLast || rows.length < 50 || (data.total != null && start + 50 >= data.total)) break;
    }
    return out;
  }

  /**
   * THE team's backlog, straight from its board. This is what "the backlog
   * belonging to this team" actually means in Jira — no component or assignee
   * guesswork, and it already excludes anything sitting in a sprint.
   */
  async boardBacklog(boardId) {
    const fields = this.fieldList().join(',');
    const rows = await this.agilePage(`/rest/agile/1.0/board/${boardId}/backlog?fields=${encodeURIComponent(fields)}`, { key: 'issues' });
    return rows.map(i => this.normalise(i));
  }

  /** Every issue on a board, sprinted or not — used to attribute people to a team. */
  async boardIssues(boardId, { max = 3000 } = {}) {
    const fields = this.fieldList().join(',');
    const rows = await this.agilePage(`/rest/agile/1.0/board/${boardId}/issue?fields=${encodeURIComponent(fields)}`, { key: 'issues', max });
    return rows.map(i => this.normalise(i));
  }

  /** Distinct values of the Jira Team field seen on this project's issues. */
  async teamFieldValues() {
    if (!this.teamField) return [];
    const rows = await this.search(`project = ${this.projectKey} AND "${this.teamField}" IS NOT EMPTY`, { max: 1000 });
    return [...new Set(rows.map(r => r.team).filter(Boolean))].sort();
  }

  /** Board sprints — gives real start/end dates and state instead of parsing names. */
  async boardSprints(boardId) {
    const out = [];
    const tz = await this.timeZone();
    for (let start = 0; start < 500; start += 50) {
      const data = await this.request(`/rest/agile/1.0/board/${boardId}/sprint?startAt=${start}&maxResults=50`);
      out.push(...(data.values || []).map(s => {
        // Both dates come from Jira's own timestamps, read in the board's
        // timezone and measured by the sprint's duration — see sprint-dates.js.
        // Truncating the two timestamps independently is what put the boards a
        // day apart from each other and a day out from the calendar.
        const d = sprintDates.fromJira(s.startDate, s.endDate, tz);
        return {
          id: String(s.id), name: s.name, state: s.state,
          start: d.start, end: d.end,
          // What Jira holds, kept so a date can be checked against its source.
          jiraStartAt: s.startDate || undefined,
          jiraEndAt: s.endDate || undefined,
        };
      }));
      if (data.isLast) break;
    }
    return out;
  }

  async boards() {
    const data = await this.request(`/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(this.projectKey)}&maxResults=50`);
    return (data.values || []).map(b => ({ id: String(b.id), name: b.name, type: b.type }));
  }
}

function nameOf(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(nameOf).filter(Boolean).join('; ');
  return v.value || v.name || null;
}

/**
 * The "relates to" links on an issue, in both directions.
 *
 * Jira's Relates link type is SYMMETRIC — `inward` and `outward` are both the
 * string "relates to" — so which side of it an issue sits on is an accident of
 * who created the link, and a filter that only looked at `inwardIssue` (the way
 * the blocked-by filter above must) would silently find half of them. That was
 * worth getting wrong once: for a maintenance ticket this link IS the epic, so
 * missing a direction means an empty Epic column for no visible reason.
 *
 * The type is matched on the type NAME as well as the directional phrases,
 * because a Jira admin can rename the phrases ("is related to") while the type
 * itself stays "Relates".
 *
 * The related issue's own summary and type come along, since Jira includes them
 * in the link and the epic is usually outside what we sync.
 */
function relatesLinks(links) {
  const out = [];
  const seen = new Set();
  for (const l of links || []) {
    if (!isRelatesType(l && l.type)) continue;
    const other = l.outwardIssue || l.inwardIssue;
    if (!other || !other.key || seen.has(other.key)) continue;
    seen.add(other.key);
    const fields = other.fields || {};
    out.push({
      key: other.key,
      summary: fields.summary || null,
      type: (fields.issuetype && fields.issuetype.name) || null,
    });
  }
  return out;
}

function isRelatesType(t) {
  if (!t) return false;
  const name = String(t.name || '').trim();
  if (/^relate(s|d)?$/i.test(name)) return true;
  return /relate/i.test(String(t.outward || '')) || /relate/i.test(String(t.inward || ''));
}
/**
 * Reduce any Jira field value to a string, number or array of strings.
 *
 * Jira returns custom fields as bare scalars, `{value}` / `{name}` option
 * objects, user objects, arrays of any of those, and rich text as an Atlassian
 * Document Format tree. None of that can be compared in a filter or written to
 * a CSV cell, so everything is flattened once, here, rather than every consumer
 * learning the shapes.
 */
function flattenValue(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(flattenValue).filter(x => x !== null && x !== '');
  if (typeof v !== 'object') return v;
  // Atlassian Document Format: walk it and keep the text.
  if (v.type === 'doc' && Array.isArray(v.content)) return adfText(v).trim() || null;
  const scalar = v.value ?? v.name ?? v.displayName ?? v.key ?? v.id;
  return scalar === undefined ? null : scalar;
}

function adfText(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return node.text || '';
  if (!Array.isArray(node.content)) return '';
  return node.content.map(adfText).join(node.type === 'paragraph' ? '' : ' ') + (node.type === 'paragraph' ? ' ' : '');
}

/**
 * A number, or null when there is no value at all.
 *
 * The nullish guard is the whole point. `Number(null)` is 0 and `Number('')` is 0,
 * so the obvious one-liner silently turned every UNESTIMATED issue into an issue
 * estimated at zero. That looks harmless and is not: "no estimate" is the signal
 * the backlog view, the forecast and the quality metrics are all built on, and
 * zeroing it makes an unplannable backlog look fully estimated and weightless.
 * A real 0 stays 0.
 */
function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function stripOrderBy(jql) { return String(jql).replace(/\s+order\s+by\s+.+$/i, ''); }
function parseSprintString(s) {
  // Legacy Jira renders the sprint field as "...[id=42,rapidViewId=7,state=ACTIVE,name=Sprint 40,...]"
  const id = (/\bid=(\d+)/.exec(s) || [])[1];
  const name = (/name=([^,\]]+)/.exec(s) || [])[1];
  const state = (/state=([^,\]]+)/.exec(s) || [])[1];
  return { id: id || null, name: name || s, state: state ? state.toLowerCase() : undefined };
}

module.exports = { Jira, stripOrderBy, relatesLinks, isRelatesType };
