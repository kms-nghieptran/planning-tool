'use strict';
/**
 * provenance.js — where every number in this tool comes from.
 *
 * Once Jira is connected it is tempting to assume everything on screen is
 * synced. It is not, and the gap matters: a capacity forecast is built from a
 * leave grid that only a human can supply, and a team that has not filled it in
 * is reading a forecast made of defaults. So the catalogue below states, for
 * every field the tool reads, whether it is:
 *
 *   jira    — a sync owns it; editing it locally would be overwritten
 *   csv     — a Jira CSV export can supply it when the API is unavailable
 *   api     — an optional integration (TestOps, GitHub) supplies it
 *   manual  — nothing can supply it but you
 *
 * `status()` then measures the live store against the catalogue, so the screen
 * shows not just where data *should* come from but whether it is actually
 * there. "Manual and empty" is the interesting state, and it is the one a
 * spreadsheet never tells you about.
 */

const CATALOGUE = [
  // ── Jira owns these ───────────────────────────────────────────────────
  { group: 'Teams & people', field: 'Teams', source: 'jira', detail: 'One per scrum board, named by the Jira Team field' },
  { group: 'Teams & people', field: 'Team → board mapping', source: 'manual', detail: 'Guessed from the board name on first sync; yours to correct', optional: true },
  { group: 'Teams & people', field: 'Members', source: 'jira', detail: 'Anyone assigned work in the team\'s recent sprints' },
  { group: 'Teams & people', field: 'Removed people', source: 'manual', detail: 'Your decision; no sync ever re-adds them' },

  { group: 'Sprints & work', field: 'Sprints, dates, state', source: 'jira', detail: 'From each team\'s board — active/future/closed' },
  { group: 'Sprints & work', field: 'Backlog', source: 'jira', detail: 'The board\'s own backlog; falls back to a heuristic with no board' },
  { group: 'Sprints & work', field: 'Issues, status, assignee', source: 'jira', csv: true },
  { group: 'Sprints & work', field: 'Story points', source: 'jira', csv: true, detail: 'Everything measured in points depends on this one field' },
  { group: 'Sprints & work', field: 'Components & labels', source: 'jira', csv: true },
  { group: 'Sprints & work', field: 'Blocked-by links', source: 'jira', detail: 'Drives the blocked counts and the risk signal' },
  { group: 'Sprints & work', field: 'Epics + Automation Status', source: 'jira', detail: 'The whole coverage report is built on this' },

  // ── Capacity: the spreadsheet's half of the tool ───────────────────────
  { group: 'Capacity', field: 'Availability (the leave grid)', source: 'manual', detail: 'Who is in, half-day, off or on holiday, per sprint. Jira has no such field — this is the input the forecast lives on' },
  { group: 'Capacity', field: 'Support / learning %', source: 'manual', detail: 'Time not going to sprint work — mentoring, support rota' },
  { group: 'Capacity', field: 'Ceremony hours', source: 'manual', detail: 'Standup, planning, review, retro — per team per sprint' },
  { group: 'Capacity', field: 'Public holidays', source: 'manual', detail: 'Applied to every team' },
  { group: 'Capacity', field: 'Hours per day, hours per point', source: 'manual', detail: 'From your spreadsheet: 7 h/day, 2.9 h/point. The app measures the real figure and offers to adopt it' },
  { group: 'Capacity', field: 'Planned / actual overrides', source: 'manual', detail: 'Only when you want to override what Jira says', optional: true },

  // ── Judgement ──────────────────────────────────────────────────────────
  { group: 'Judgement', field: 'Work categorisation rules', source: 'manual', detail: 'Jira has no work-type field; the rules map labels, components and prefixes onto new/maintenance/technical/support' },
  { group: 'Judgement', field: 'Work-mix targets', source: 'manual', detail: 'e.g. maintenance under 35% of a sprint — drives a risk signal' },
  { group: 'Judgement', field: 'Risk register', source: 'manual', detail: 'The risks you track by hand, alongside the detected signals', optional: true },
  { group: 'Judgement', field: 'Planning notes', source: 'manual', optional: true },
  { group: 'Judgement', field: 'Saved searches', source: 'manual', detail: 'Your named queries on the Search page — local, never touched by a sync', optional: true },

  // ── Optional integrations ──────────────────────────────────────────────
  { group: 'Optional integrations', field: 'Suite pass rate & flakiness', source: 'api', via: 'Katalon TestOps', detail: 'Feeds quality metrics and the forecast maintenance load', optional: true },
  { group: 'Optional integrations', field: 'PR activity', source: 'api', via: 'GitHub', detail: 'Technical work that never reaches Jira', optional: true },
];

const LABEL = {
  jira: 'Jira — synced',
  csv: 'CSV import',
  api: 'External API',
  manual: 'You — nothing else can supply it',
};

/**
 * Measure the live store against the catalogue.
 *
 * Returns each catalogue row with `present` (is there anything there?) and a
 * short `have` string. A required row that is empty is the point of the screen.
 */
function status(plan, snapshot) {
  const issues = Object.values(snapshot.issues || {});
  const teams = plan.teams || [];
  const byTeam = snapshot.byTeam || {};
  const n = (o) => Object.keys(o || {}).length;

  const sprintCount = (plan.sprints || []).filter(s =>
    Object.values(s.byTeam || {}).some(b => b && b.jiraId)).length;
  const withPoints = issues.filter(i => i.points != null && i.points > 0).length;
  const epics = issues.filter(i => /^epic$/i.test(i.issueType || ''));
  const epicsWithStatus = epics.filter(i => i.automationStatus).length;
  const members = teams.reduce((t, x) => t + (x.members || []).length, 0);
  const manualMembers = teams.reduce((t, x) => t + (x.members || []).filter(m => m.source === 'manual').length, 0);
  const backlogBoards = Object.values(byTeam).filter(t => t.backlogSource === 'board').length;

  const measured = {
    'Teams': [teams.length, `${teams.length} teams`],
    'Team → board mapping': [teams.filter(t => t.boardId).length, `${teams.filter(t => t.boardId).length} of ${teams.length} mapped`],
    'Members': [members, manualMembers ? `${members} (${manualMembers} added by hand)` : `${members} people`],
    'Removed people': [n(plan.excluded), `${Object.values(plan.excluded || {}).reduce((t, x) => t + x.length, 0)} excluded`],
    'Sprints, dates, state': [sprintCount, `${sprintCount} Jira sprints`],
    'Backlog': [backlogBoards, `${backlogBoards} of ${teams.length} from a board`],
    'Issues, status, assignee': [issues.length, `${issues.length} issues`],
    'Story points': [withPoints, withPoints ? `${withPoints} of ${issues.length} estimated` : 'none — nothing is measurable in points'],
    'Components & labels': [issues.filter(i => (i.components || []).length).length, `${issues.filter(i => (i.components || []).length).length} issues have a component`],
    'Blocked-by links': [issues.filter(i => (i.blockedBy || []).length).length, `${issues.filter(i => (i.blockedBy || []).length).length} blocked`],
    // Where the Epic column gets its two answers. Counted separately, because
    // an empty "relates to" count and an empty parent count mean different
    // things: the first says maintenance has no epic, the second says stories
    // are not filed under one.
    'Epic parents (new implementation)': [issues.filter(i => i.parentKey).length, `${issues.filter(i => i.parentKey).length} items have a parent`],
    'Relates-to links (maintenance epics)': [issues.filter(i => (i.relatesTo || []).length).length, `${issues.filter(i => (i.relatesTo || []).length).length} items link to related work`],
    'Epics + Automation Status': [epicsWithStatus, epics.length ? `${epicsWithStatus} of ${epics.length} epics triaged` : 'no epics synced yet'],
    'Availability (the leave grid)': [n(plan.availability), `${n(plan.availability)} person-sprints filled in`],
    'Support / learning %': [n(plan.support), `${n(plan.support)} entries`],
    'Ceremony hours': [n(plan.ceremony), `${n(plan.ceremony)} team-sprints`],
    'Public holidays': [(plan.holidays || []).length, `${(plan.holidays || []).length} dates`],
    'Hours per day, hours per point': [teams.filter(t => t.settings).length, `set for ${teams.filter(t => t.settings).length} of ${teams.length} teams`],
    'Planned / actual overrides': [n(plan.overrides), `${n(plan.overrides)} overrides`],
    'Work categorisation rules': [plan.categoryRules ? 1 : 1, plan.categoryRules ? 'customised' : 'using the defaults'],
    'Work-mix targets': [n(plan.mixTargets), `${n(plan.mixTargets)} teams`],
    'Risk register': [(plan.risks || []).length, `${(plan.risks || []).length} risks`],
    'Planning notes': [n(plan.notes), `${n(plan.notes)} notes`],
    'Saved searches': [(plan.savedSearches || []).length, `${(plan.savedSearches || []).length} saved`],
    'Suite pass rate & flakiness': [snapshot.testops ? 1 : 0, snapshot.testops ? 'connected' : 'not connected'],
    'PR activity': [snapshot.github ? 1 : 0, snapshot.github ? 'connected' : 'not connected'],
  };

  const rows = CATALOGUE.map(row => {
    const [count, have] = measured[row.field] || [0, '—'];
    return { ...row, sourceLabel: LABEL[row.source], present: count > 0, have };
  });

  return {
    rows,
    gaps: rows.filter(r => !r.present && !r.optional),
    manualRequired: rows.filter(r => r.source === 'manual' && !r.optional).length,
    syncedFields: rows.filter(r => r.source === 'jira').length,
  };
}

module.exports = { CATALOGUE, LABEL, status };
