'use strict';
/**
 * sync.js — the ONLY place that pulls from external systems.
 *
 * Contract (same as the automation dashboard, for the same reason): Jira/TestOps/
 * GitHub are contacted only on an explicit Sync. Page loads, filters and tab
 * switches read snapshot.json, so the tool is instant and keeps working when the
 * network or the VPN is down.
 *
 * Integrity, in order of importance:
 *  1. VERIFY — every dataset's stored count is compared against the source's own
 *     count before the snapshot is saved. A mismatch re-pulls once, then surfaces.
 *  2. WATERMARK = sync START, not finish. A long sync must not leave a hole where
 *     edits made while it ran are never picked up.
 *  3. DEDUPE BY KEY — paging a result set that is being edited returns repeats.
 *  4. A full sync is the only thing that catches DELETIONS (a deleted issue never
 *     shows up in an "updated since" query), so the count check doubles as the
 *     tripwire telling you a full sync is due.
 */

const jiraModule = require('./jira');
const { stripOrderBy } = jiraModule;
const { TestOps } = require('./testops');
const { GitHub } = require('./github');
const store = require('./store');
const covHistory = require('./coverage-history');
const reconcile = require('./reconcile');

const OVERLAP_MINUTES = 10;   // re-scan window, absorbs clock skew between us and Jira

/**
 * Read every team's board sprints, one team at a time.
 *
 * Two rules learned from a real sync against AUTOKAT:
 *
 *  1. NO FALLBACK BOARD. A team with no board mapped gets no sprints. The old code
 *     fell back to `boards[0]`, which quietly handed one team another team's
 *     sprints — wrong data that looks right is worse than an empty list that says
 *     so out loud.
 *  2. ONE BAD BOARD MUST NOT SINK THE REST. A kanban board answers
 *     `/board/{id}/sprint` with a 400 "does not support sprints". Without a
 *     per-team catch, that single 400 aborted the loop and threw away the sprints
 *     already read for every other team.
 *
 * Errors are collected per team rather than overwritten into one string, so
 * Settings can name which team is unmapped instead of showing the last raw 400.
 */
async function readBoardSprints(jira, plan, onProgress) {
  const byTeam = {}, errors = [];
  for (const team of plan.teams) {
    if (!team.boardId) { errors.push({ team: team.name, kind: 'unmapped', message: 'No Jira board is mapped to this team' }); continue; }
    onProgress && onProgress(`Reading sprints for ${team.name}…`);
    try {
      byTeam[team.id] = await jira.boardSprints(team.boardId);
    } catch (err) {
      byTeam[team.id] = [];
      const noSprints = /does not support sprints/i.test(err.message || '');
      errors.push({
        team: team.name, boardId: team.boardId,
        kind: noSprints ? 'kanban' : 'error',
        message: noSprints ? `Board ${team.boardId} is a kanban board — it has no sprints. Map a scrum board in Integrations & setup.` : err.message,
      });
    }
  }
  return { byTeam, errors };
}

/** The datasets we keep locally. {PROJECT} is substituted from config. */
/**
 * The Jira settings for a sync: what was DISCOVERED, then what you DECIDED.
 *
 * `snapshot.fields` is the record of what the last sync worked out for itself —
 * useful, because it saves re-discovering the sprint and team field ids on
 * every incremental run. `config.jira` is what you pinned on the Jira fields
 * screen. When the two disagree, YOURS WINS. Discovery is a guess; a pin is a
 * decision, and a decision that a guess can quietly override is not a setting,
 * it is a suggestion.
 *
 * This was the other half of the story-points bug. The two incremental paths
 * spread the snapshot AFTER the config, so a snapshot that had auto-detected
 * the empty `customfield_16012` overrode the `customfield_10002` that had just
 * been pinned — and went on overriding it on every incremental sync, so the
 * points stayed null and the Fields screen appeared to do nothing.
 *
 * Empty config values do NOT override: unpinning a field on that screen writes
 * an empty string, and that means "go back to auto-detection", not "use no
 * field at all".
 */
function jiraSettings(cfg, snap) {
  const decided = {};
  for (const [k, v] of Object.entries(cfg.jira || {})) {
    if (v !== null && v !== undefined && v !== '') decided[k] = v;
  }
  return { ...(cfg.jira || {}), ...(snap.fields || {}), ...decided };
}

function datasets(cfg) {
  const p = cfg.jira && cfg.jira.projectKey || 'AUTOKAT';
  const custom = (cfg.jira && cfg.jira.datasets) || {};
  return Object.assign({
    // Everything in the project that is in a sprint or could be pulled into one.
    sprintWork: `project = ${p} AND sprint IS NOT EMPTY`,
    backlog:    `project = ${p} AND sprint IS EMPTY AND statusCategory != Done`,
    // Coverage is measured on EPICS by their Automation Status, so they are a
    // dataset in their own right — most never sit in a sprint.
    coverage:   `project = ${p} AND issuetype = Epic`,
  }, custom);
}

async function fullSync(cfg, { onProgress } = {}) {
  const startedAt = new Date().toISOString();          // watermark = START
  const jira = new jiraModule.Jira(cfg.jira || {});
  const snap = store.getSnapshot();

  const fields = await jira.discoverFields();
  if (!fields.storyPointsField) {
    throw new Error('Could not find a "Story Points" (or "Story point estimate") field on this Jira. Set jira.storyPointsField in config.json.');
  }

  // Several fields can be called "Story Points"; only one is filled in. Ask Jira
  // which, before pulling 7,000 issues against the wrong one.
  onProgress && onProgress('Checking which Story Points field is in use…');
  const spCal = await jira
    .calibrateStoryPointsField(cfg.jira && cfg.jira.projectKey || 'AUTOKAT', { configured: cfg.jira && cfg.jira.storyPointsField })
    .catch(err => ({ field: fields.storyPointsField, reason: `check failed: ${err.message}`, counts: [] }));
  fields.storyPointsField = spCal.field;
  fields.storyPointsCalibration = spCal;

  const ds = datasets(cfg);
  const issues = {};
  const verification = [];

  for (const [name, jql] of Object.entries(ds)) {
    onProgress && onProgress(`Pulling ${name}…`);
    let rows = await jira.search(jql);
    let check = await verifyDataset(jira, jql, rows.length);
    if (!check.ok && check.remote !== null) {
      onProgress && onProgress(`${name} disagreed with Jira (${rows.length} vs ${check.remote}) — re-pulling once…`);
      rows = await jira.search(jql);
      check = await verifyDataset(jira, jql, rows.length);
    }
    verification.push({ dataset: name, jql, local: rows.length, remote: check.remote, exact: check.exact, ok: check.ok, checkedAt: new Date().toISOString() });
    for (const r of rows) issues[r.key] = { ...r, datasets: [...new Set([...(issues[r.key] && issues[r.key].datasets || []), name])] };
  }

  const all = Object.values(issues);
  const next = {
    ...snap,
    source: 'jira',
    syncedAt: new Date().toISOString(),
    watermark: startedAt,
    fields,
    issues,
    sprints: collectSprints(all),
    people: collectPeople(all),
    components: [...new Set(all.flatMap(i => i.components))].sort(),
    // What the extra-field config actually produced. Declaring a field and
    // having it arrive are different things, and the Fields screen shows both.
    extraFields: extraFieldSummary(cfg, all),
    verification,
  };

  // SPRINTS come from each team's own board, not from parsing issue sprint names:
  // the board gives real start/end dates, real state (future/active/closed) and a
  // stable id. This is what makes the sprint dropdown trustworthy.
  const plan = store.getPlan();
  try {
    onProgress && onProgress('Reading boards…');
    const boards = await jira.boards();
    next.boards = boards;
    try { next.teamFieldValues = await jira.teamFieldValues(); } catch (_) { next.teamFieldValues = []; }
    reconcile.discoverTeams(plan, next);     // a new board becomes a team before we pull its data
    if (boards.length) {
      reconcile.autoAssignBoards(plan, boards);
      const { byTeam, errors } = await readBoardSprints(jira, plan, onProgress);
      next.boardSprintsByTeam = byTeam;
      next.boardSprintErrors = errors;
      if (errors.length) next.boardSprintsError = errors.map(e => `${e.team}: ${e.message}`).join(' · ');
      else delete next.boardSprintsError;
      next.boardSprints = byTeam[(plan.teams[0] || {}).id] || [];   // back-compat

      // THE BACKLOG, per team, from its own board. This is the definitive answer
      // to "what is this team's backlog" — no component or assignee guesswork.
      const backlogByTeam = {};
      for (const team of plan.teams) {
        const boardId = team.boardId;
        if (!boardId) continue;
        onProgress && onProgress(`Reading ${team.name} backlog…`);
        try {
          const rows = await jira.boardBacklog(boardId);
          for (const r of rows) issues[r.key] = { ...(issues[r.key] || {}), ...r, datasets: [...new Set([...((issues[r.key] || {}).datasets || []), 'backlog'])] };
          backlogByTeam[team.id] = rows.map(r => r.key);
        } catch (err) {
          next.backlogError = `${team.name}: ${err.message}`;   // falls back to the heuristic
        }
      }
      if (Object.keys(backlogByTeam).length) {
        next.boardBacklogByTeam = backlogByTeam;
        next.issues = issues;
      }
    }
    delete next.boardSprintsError_;
  } catch (err) {
    next.boardSprintsError = err.message;   // non-fatal: name matching still works
  }

  // Push Jira's sprints and people into the plan the app actually reads.
  //
  // ORDER MATTERS, and getting it wrong is silent: reconcileAll() BUILDS
  // `next.byTeam` — the per-team index every team-scoped screen reads. Saving the
  // snapshot before this line wrote it to disk without the index, computed the
  // index into memory, and threw it away when the request ended. Every team then
  // showed zero sprints, zero backlog and no metrics, against a snapshot that had
  // all of it. Reconcile first, save second.
  onProgress && onProgress('Reconciling sprints and rosters…');
  const rec = reconcile.reconcileAll(plan, next);
  store.saveSnapshot(next);
  store.savePlan(plan);

  recordCoverage(next, cfg);
  store.audit('sync.full', { issues: all.length, datasets: Object.keys(ds), verification, reconcile: rec });
  return { ...summary(next, cfg), reconcile: rec };
}


/**
 * Take a coverage reading, every sync.
 *
 * THE ONLY MOMENT THIS CAN HAPPEN. A sync is the one point where the tool knows
 * what Jira says today, and the next sync overwrites it — so a reading not taken
 * here is a day of history that cannot be recovered afterwards from anything in
 * the store.
 *
 * It never fails a sync. The history is a second-order feature and a sync that
 * pulled 9,000 issues correctly has succeeded whether or not one extra row
 * landed; the error goes to the audit log where it can be found, rather than to
 * a user who asked for a sync and got a stack trace about a chart.
 */
function recordCoverage(snap, cfg) {
  try {
    const scope = ((cfg || {}).metrics || {}).coverageScope || 'Epic';
    return covHistory.recordFromSnapshot(snap, { scope, source: 'sync' });
  } catch (err) {
    try { store.audit('coverage.history.failed', { error: err.message }); } catch (_) { /* nothing left to try */ }
    return null;
  }
}

async function incrementalSync(cfg, { onProgress } = {}) {
  const snap = store.getSnapshot();
  if (!snap.watermark || snap.source !== 'jira') return fullSync(cfg, { onProgress });

  const startedAt = new Date().toISOString();
  const jira = new jiraModule.Jira(jiraSettings(cfg, snap));
  const since = new Date(new Date(snap.watermark).getTime() - OVERLAP_MINUTES * 60000);
  const sinceJql = `"${jiraDate(since)}"`;
  const ds = datasets(cfg);
  const issues = { ...snap.issues };

  // 1. everything touched since the watermark, so we know what to re-evaluate
  onProgress && onProgress('Finding changed issues…');
  const project = (cfg.jira && cfg.jira.projectKey) || 'AUTOKAT';
  const touched = await jira.search(`project = ${project} AND updated >= ${sinceJql}`);
  const touchedKeys = new Set(touched.map(t => t.key));

  // 2. per dataset, which of the touched issues still belong in it
  //
  // `datasets` is RECOMPUTED for a touched issue, not added to. Every dataset
  // is re-queried over the same window, so this run's matches are the complete
  // answer for anything that changed — and unioning with the stored value can
  // only ever keep a tag that has stopped being true.
  //
  // It had exactly that effect: 78 of his issues were tagged both `sprintWork`
  // and `backlog`, whose JQLs are `sprint IS NOT EMPTY` and `sprint IS EMPTY`.
  // All 78 had moved from the backlog into a sprint, and the tag saying
  // otherwise had simply never been cleared.
  const stillMatching = new Set();
  const matchedNow = new Map();          // key -> Set(dataset names) THIS run
  for (const [name, jql] of Object.entries(ds)) {
    const rows = await jira.search(`(${stripOrderBy(jql)}) AND updated >= ${sinceJql}`);
    for (const r of rows) {
      stillMatching.add(r.key);
      if (!matchedNow.has(r.key)) matchedNow.set(r.key, new Set());
      matchedNow.get(r.key).add(name);
      issues[r.key] = { ...r, datasets: [...matchedNow.get(r.key)] };
    }
  }

  // 3. THE IMPORTANT STEP: a touched issue that no longer matches any dataset is
  //    dropped. Without this, closed backlog items linger in the snapshot forever.
  let removed = 0;
  for (const key of touchedKeys) {
    if (!stillMatching.has(key) && issues[key]) { delete issues[key]; removed++; }
  }

  const all = Object.values(issues);
  const next = {
    ...snap,
    syncedAt: new Date().toISOString(),
    watermark: startedAt,
    issues,
    sprints: collectSprints(all),
    people: collectPeople(all),
    components: [...new Set(all.flatMap(i => i.components))].sort(),
  };
  // Board sprints are cheap and change without any issue being touched (a sprint
  // gets started or closed), so refresh them on every incremental sync too.
  const plan = store.getPlan();
  try {
    const boards = snap.boards && snap.boards.length ? snap.boards : await jira.boards();
    next.boards = boards;
    reconcile.autoAssignBoards(plan, boards);
    const { byTeam, errors } = await readBoardSprints(jira, plan, null);
    if (Object.keys(byTeam).length) next.boardSprintsByTeam = byTeam;
    next.boardSprintErrors = errors;
    if (errors.length) next.boardSprintsError = errors.map(e => `${e.team}: ${e.message}`).join(' · ');
    else delete next.boardSprintsError;
  } catch (err) {
    next.boardSprintsError = err.message;
  }

  const rec = reconcile.reconcileAll(plan, next);   // builds next.byTeam — must precede the save
  store.saveSnapshot(next);
  store.savePlan(plan);

  recordCoverage(next, cfg);
  store.audit('sync.incremental', { touched: touchedKeys.size, updated: stillMatching.size, removed, reconcile: rec });
  return { ...summary(next, cfg), touched: touchedKeys.size, removed, reconcile: rec };
}

/** Pull just these keys back — used after a write so KPIs stay right without a sync. */
async function syncKeys(cfg, keys) {
  if (!keys || !keys.length) return null;
  const snap = store.getSnapshot();
  const jira = new jiraModule.Jira(jiraSettings(cfg, snap));
  const rows = await jira.search(`key in (${keys.join(',')})`);
  const issues = { ...snap.issues };
  for (const r of rows) issues[r.key] = { ...(issues[r.key] || {}), ...r };
  // deliberately does NOT move the watermark
  store.saveSnapshot({ ...snap, issues, syncedAt: new Date().toISOString() });
  return rows.length;
}

async function syncTestOps(cfg, { onProgress } = {}) {
  const to = new TestOps(cfg.testops || {});
  const snap = store.getSnapshot();
  const projects = (cfg.testops && cfg.testops.projectIds && cfg.testops.projectIds.length)
    ? (await to.projects()).filter(p => cfg.testops.projectIds.includes(p.id))
    : await to.projects();

  const results = [];
  for (const p of projects) {
    onProgress && onProgress(`TestOps: ${p.name}…`);
    try {
      const executions = await to.executions(p.id, (cfg.testops && cfg.testops.runsPerProject) || 60);
      results.push({ ...p, executions, summary: TestOps.summarise(executions) });
    } catch (err) {
      results.push({ ...p, error: err.message, executions: [], summary: TestOps.summarise([]) });
    }
  }
  const next = { ...snap, testops: { syncedAt: new Date().toISOString(), projects: results } };
  store.saveSnapshot(next);
  store.audit('sync.testops', { projects: results.length });
  return next.testops;
}

async function syncGitHub(cfg, { onProgress } = {}) {
  const gh = new GitHub(cfg.github || {});
  const snap = store.getSnapshot();
  onProgress && onProgress('GitHub: pull requests…');
  const since = new Date(Date.now() - 120 * 864e5).toISOString();   // ~4 months back
  const prs = await gh.pullRequests(since);
  const next = { ...snap, github: { syncedAt: new Date().toISOString(), repos: gh.repos, prs } };
  store.saveSnapshot(next);
  store.audit('sync.github', { prs: prs.length, repos: gh.repos });
  return { syncedAt: next.github.syncedAt, prs: prs.length };
}

/** Import issues from a CSV export instead of a live connection. */
function importIssues(rows, { source = 'import' } = {}) {
  const snap = store.getSnapshot();
  const issues = { ...snap.issues };
  let added = 0;
  for (const r of rows) {
    if (!r.key) continue;
    issues[r.key] = { ...(issues[r.key] || {}), ...r, datasets: ['import'] };
    added++;
  }
  const all = Object.values(issues);
  store.saveSnapshot({
    ...snap, source: snap.source === 'jira' ? 'jira' : source,
    syncedAt: new Date().toISOString(), issues,
    sprints: collectSprints(all), people: collectPeople(all),
    components: [...new Set(all.flatMap(i => i.components || []))].sort(),
  });
  store.audit('import.issues', { added });
  return { added, total: all.length };
}

async function verifyDataset(jira, jql, localCount) {
  const remote = await jira.count(jql);
  if (remote.value === null) return { ok: true, remote: null, exact: false, note: 'not checked' };
  return { ok: remote.exact ? remote.value === localCount : Math.abs(remote.value - localCount) <= 5, remote: remote.value, exact: remote.exact };
}

function collectSprints(issues) {
  const map = new Map();
  for (const i of issues) for (const s of i.sprints || []) {
    if (!s.name) continue;
    const prev = map.get(s.name) || {};
    map.set(s.name, { name: s.name, state: s.state || prev.state, start: s.start || prev.start, end: s.end || prev.end });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function collectPeople(issues) {
  const map = new Map();
  for (const i of issues) if (i.assignee) map.set(i.assignee, { name: i.assignee, accountId: i.assigneeId });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function summary(snap, cfg = {}) {
  return {
    syncedAt: snap.syncedAt,
    watermark: snap.watermark,
    issues: Object.keys(snap.issues || {}).length,
    sprints: (snap.sprints || []).length,
    people: (snap.people || []).length,
    verification: snap.verification || [],
    allVerified: (snap.verification || []).every(v => v.ok),
    // Named per team, so an unmapped or kanban board is visible instead of
    // showing up as a team that mysteriously has no sprints.
    boardErrors: snap.boardSprintErrors || [],
    estimation: estimationHealth(snap, cfg),
    extraFields: snap.extraFields || [],
  };
}

/**
 * Which extra fields were asked for, and how many issues actually carry one.
 *
 * A field you configured but which arrives empty on every issue is the exact
 * failure this whole feature exists to make visible — reporting only what was
 * REQUESTED would repeat it.
 */
function extraFieldSummary(cfg, issues) {
  const declared = ((cfg.jira && cfg.jira.extraFields) || [])
    .map(f => (typeof f === 'string' ? { id: f, key: f, name: f } : f))
    .filter(f => f && f.id);
  if (!declared.length) return [];
  return declared.map(f => {
    const key = f.key || f.id;
    const filled = issues.filter(i => i.extra && i.extra[key] !== undefined).length;
    return {
      id: f.id, key, name: f.name || f.id,
      filled, total: issues.length,
      fillRate: issues.length ? Math.round(filled / issues.length * 1000) / 10 : 0,
    };
  });
}

/**
 * Is the story-points field actually landing?
 *
 * A whole project reading as 0 points is not a team that never estimates — it is
 * the wrong custom field, and it makes every velocity, forecast and capacity
 * number in the tool silently wrong while still looking plausible. So the
 * snapshot carries the answer and Settings says it out loud.
 */
function estimationHealth(snap, cfg = {}) {
  const items = Object.values(snap.issues || {});
  if (!items.length) return null;
  const withValue = items.filter(i => i.points != null).length;
  const nonZero = items.filter(i => i.points != null && i.points > 0).length;

  // What the NEXT sync will use, which is what the screens should name. The
  // snapshot records the field the LAST sync used, and after you pin a
  // different one on the Fields screen those two disagree until a full sync
  // runs. Reporting the snapshot's field then told you the tool was using the
  // field you had just replaced.
  const configured = (cfg.jira || {}).storyPointsField || null;
  const usedBySnapshot = (snap.fields || {}).storyPointsField || null;

  return {
    field: configured || usedBySnapshot,
    // Set only when the stored issues were pulled with a DIFFERENT field from
    // the one now pinned. It means the numbers on screen are stale rather than
    // wrong, and that a full sync — not an incremental one — is what fixes it.
    staleField: configured && usedBySnapshot && configured !== usedBySnapshot ? usedBySnapshot : null,
    total: items.length,
    estimated: withValue,
    nonZero,
    pct: Math.round(withValue / items.length * 1000) / 10,
    // The tripwire: values are arriving, but every one of them is zero.
    fieldLooksWrong: nonZero === 0,
    calibration: (snap.fields || {}).storyPointsCalibration || null,
  };
}

function jiraDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

module.exports = { fullSync, incrementalSync, syncKeys, syncTestOps, syncGitHub, importIssues, datasets, summary, jiraSettings };
