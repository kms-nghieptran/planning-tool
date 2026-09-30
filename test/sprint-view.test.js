'use strict';
/**
 * sprint-view.test.js — what the Active sprint screen actually puts on the page.
 *
 * WHY THIS SUITE EXISTS
 *
 * He reported that items with no assignee were missing from "All sprint items".
 * They were not — the model has always returned them and the table has always
 * had an `unassigned` branch in its Assignee cell. What WAS missing was the
 * unowned pile from "Per-person progress", so the person column added up to
 * less than the Committed KPI above it with nothing on screen to explain the
 * gap. Both halves of that are UI facts, and a UI fact is only pinned by
 * looking at the HTML: coverage.test.js learned this the hard way when a render
 * function gutted to `return ''` left every source-level check green.
 *
 * So these checks run the real view, with a real payload from the real model,
 * and read the output.
 *
 * Run: node test/sprint-view.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-sprint-view-'));
process.env.STORE_DIR = SCRATCH;

const insights = require('../lib/insights');
const priority = require('../lib/priority');
const prioritization = require('../lib/prioritization');
const coverage = require('../lib/coverage');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

/* ── fixture ──────────────────────────────────────────────────────────────
   Four owned items and two unowned ones, one of each finished. The two unowned
   items are the whole subject of this file, so they differ from each other:
   if the view only ever showed the planned side, A-9 being Done would not be
   visible anywhere. */

const SPRINT = { id: 'S40', number: 40, name: 'Sprint 40', start: '2026-09-17', end: '2026-09-30' };

const TEAM = {
  id: 'titan', name: 'Katalon Titan',
  sprintKeywords: ['titan'],
  settings: { hoursPerDay: 7, hoursPerPoint: 2.9, ceremonyHours: 9 },
  members: [
    { id: 'm1', name: 'Thuan Dinh Cong Ngoc', role: 'QA Lead', status: 'Active', supportPct: 0 },
    { id: 'm2', name: 'Hien Phan', role: 'Auto QA', status: 'Active', supportPct: 0 },
  ],
};

const full = new Array(14).fill('1').map((c, i) => ([2, 3, 9, 10].includes(i) ? 'WO' : c));

const PLAN = {
  version: 1, teams: [TEAM], sprints: [SPRINT], holidays: [],
  availability: { 'titan|S40|m1': full, 'titan|S40|m2': full },
  support: {}, ceremony: {}, overrides: {}, risks: [], notes: {}, categoryRules: null, mixTargets: null,
};

const issue = (o) => ({
  key: o.key, summary: o.summary || `Work item ${o.key}`, issueType: o.type || 'Story',
  status: o.status || 'Open', statusCategory: o.status === 'Done' ? 'done' : 'new',
  assignee: o.assignee || null, labels: [], components: o.components || [],
  points: 'points' in o ? o.points : 3, sprintNames: ['Katalon Titan Sprint 40'],
  sprints: [{ name: 'Katalon Titan Sprint 40' }],
  // The item's OWN blockers, and its parent. Both default to nothing, which is
  // the shape of every Story in Refinement in his sprint: the block is
  // recorded on the epic, never on the Story.
  blockedBy: o.blockedBy || [], parentKey: o.parentKey || null, relatesTo: o.relatesTo || [],
  dueDate: 'dueDate' in o ? o.dueDate : null,
  updated: '2026-09-20T00:00:00.000Z',
  resolved: o.status === 'Done' ? '2026-09-21T00:00:00.000Z' : null,
  team: 'Katalon Auto Titan', priority: 'Medium',
});

const OWNED = ['A-1', 'A-2', 'A-3', 'A-4'];
const UNOWNED = ['A-8', 'A-9'];

const SNAP = {
  source: 'jira', syncedAt: '2026-09-24T00:00:00.000Z', watermark: '2026-09-24T00:00:00.000Z',
  sprints: [{ name: 'Katalon Titan Sprint 40' }],
  issues: Object.fromEntries([
    // Components on purpose: PS_iGO_NLG carries most of the sprint, KAT_Common
    // a little, and the TrueTest marker rides along on one of them so the
    // per-component section has to strip it.
    issue({ key: 'A-1', assignee: 'Thuan Dinh Cong Ngoc', points: 8, status: 'Done', components: ['PS_iGO_NLG', 'TrueTest'] }),
    issue({ key: 'A-2', assignee: 'Thuan Dinh Cong Ngoc', points: 5, components: ['PS_iGO_NLG'] }),
    issue({ key: 'A-3', assignee: 'Hien Phan', points: 7, status: 'Done', components: ['PS_iGO_NLG'] }),
    issue({ key: 'A-4', assignee: 'Hien Phan', points: 2, components: ['KAT_Common'] }),
    issue({ key: 'A-8', assignee: null, points: 4 }),
    issue({ key: 'A-9', assignee: null, points: 6, status: 'Done' }),
    // Bucket stories, which is where maintenance work lives: one maintaining
    // three test cases, one maintaining none.
    issue({ key: 'A-20', assignee: 'Hien Phan', points: 3, type: 'Bucket Story',
      relatesTo: [{ key: 'AUTOKAT-1' }, { key: 'AUTOKAT-2' }, { key: 'AUTOKAT-3' }] }),
    issue({ key: 'A-21', assignee: 'Hien Phan', points: 1, type: 'Bucket Story', relatesTo: [] }),
  ].map(i => [i.key, i])),
  testops: { projects: [] }, github: {}, verification: [],
};

/* ── REFINEMENT, AND THE BLOCK RECORDED ONE LEVEL UP ───────────────────────
   His TT Week 14Sep, in miniature. Sixteen Stories sat in Refinement, not one
   of them naming an "is blocked by" of its own, while ten of their parent
   epics named a blocker — and all ten named the SAME ticket, in a project this
   tool does not even sync. The sprint board showed none of it.

   So the fixture is built to fail the plausible implementations:
     · R-1 and R-2 are in Refinement under DIFFERENT epics that share a blocker,
       so a drawer keyed off the story rather than its epic still looks right
       on one of them and wrong on the other.
     · R-3 is in Refinement under an epic with nothing recorded — the icon must
       not appear, or it appears on every row and stops meaning anything.
     · N-1 is NOT in Refinement under a blocked epic, which is the five rows in
       his sprint that this feature deliberately does not mark.
     · R-4 carries its own blocker and sits under an unblocked epic, so an
       implementation that reads the ITEM's blockedBy passes everything above
       and fails here. */
const EPIC = (key, blockedBy) => ({
  key, summary: `Epic ${key}`, issueType: 'Epic', status: 'Open', components: [],
  labels: [], blockedBy, relatesTo: [],
});

const REFINE_SNAP = {
  ...SNAP,
  issues: Object.fromEntries([
    ...Object.values(SNAP.issues),
    EPIC('E-BLOCKED', ['CLICMNTIGO-11567']),
    EPIC('E-ALSO', ['CLICMNTIGO-11567', 'OTHER-1']),
    EPIC('E-CLEAR', []),
    issue({ key: 'R-1', assignee: 'Hien Phan', points: 3, status: 'Refinement', parentKey: 'E-BLOCKED' }),
    issue({ key: 'R-2', assignee: 'Hien Phan', points: 2, status: 'Refinement', parentKey: 'E-ALSO' }),
    issue({ key: 'R-3', assignee: 'Hien Phan', points: 1, status: 'Refinement', parentKey: 'E-CLEAR' }),
    issue({ key: 'R-4', assignee: 'Hien Phan', points: 1, status: 'Refinement', parentKey: 'E-CLEAR', blockedBy: ['OWN-1'] }),
    issue({ key: 'N-1', assignee: 'Hien Phan', points: 1, status: 'In Dev', parentKey: 'E-BLOCKED' }),
  ].map(i => [i.key, i])),
};

/**
 * The shape he reported: work in the sprint assigned to real people who are not
 * on the team's roster. Nothing here is unassigned — every item names someone.
 *
 * The exclusions are what keep them off the roster, and they are the real
 * mechanism: without them the roster simply derives a member from the assignee
 * and the work is attributed normally, which is what SHOULD happen. Titan has
 * 39 of these, which is why 53 of its Sprint 30 items landed nowhere.
 */
const OFF_ROSTER_PLAN = { ...PLAN, excluded: { titan: ['Luong Trinh', 'Dat Ngoc Pham'] } };
const OFF_ROSTER = {
  ...SNAP,
  issues: Object.fromEntries([
    ...Object.entries(SNAP.issues).filter(([k]) => !UNOWNED.includes(k)),
    ...[
      issue({ key: 'A-8', assignee: 'Luong Trinh', points: 4 }),
      issue({ key: 'A-9', assignee: 'Luong Trinh', points: 6, status: 'Done' }),
      issue({ key: 'A-10', assignee: 'Dat Ngoc Pham', points: 3, status: 'Done' }),
    ].map(i => [i.key, i]),
  ]),
};

const MID_SPRINT = new Date('2026-09-24T00:00:00Z');

/* ── the harness ──────────────────────────────────────────────────────── */

const VIEW = fs.readFileSync(path.join(__dirname, '..', 'public', 'views', 'sprint.js'), 'utf8');

/**
 * Render the Active sprint view for real and hand back the HTML, plus the
 * payload it was given so the checks can compare the page against the model
 * rather than against numbers typed into this file.
 */
async function renderHtml(snap = SNAP, plan = PLAN, opts = {}) {
  const view = insights.activeSprintView(plan, snap, TEAM, SPRINT, { today: MID_SPRINT });
  /* Assembled the way `/api/sprint` assembles it, risks included — the bare
     view is no longer what the page receives, and a harness that renders a
     payload the server never sends is checking a screen nobody sees. That the
     ROUTE really sends this is checked over HTTP, in sprint-api.test.js. */
  const built = {
    ...view,
    risks: {
      signals: insights.signalsFor(TEAM, SPRINT, view, snap),
      manual: (plan.risks || []).filter(r => String(r.status || '').toLowerCase() !== 'closed'),
    },
    testCases: view.testCases
      /* DECORATED AND ORDERED AS THE ROUTE DOES IT — the page sorts these rows
         by his priority, and a harness that skipped the sort would render an
         order nobody sees. */
      ? { ...view.testCases, rows: priority.byPriority(priority.decorate(view.testCases.rows, plan)) }
      : view.testCases,
    priorityLevels: priority.LEVELS,
    /* The lock the route now sends. The Points cells on this screen edit real
       Jira issues, so the page has to know before it renders whether this
       sprint still accepts writes. */
    lock: opts.lock || { readOnly: false },
  };
  /* A HOOK FOR RENDERING AGAINST A PAYLOAD THIS MODEL WOULD NOT PRODUCE —
     specifically an OLDER one. Fields get added to the payload and the browser
     keeps the previous page until it is reloaded, so "what does this screen do
     when a field it now relies on is missing" is a real state and not a
     hypothetical. Built from the real payload and then cut down, so it stays
     in step with the model instead of being a hand-written fake. */
  const payload = opts.payload ? opts.payload(built) : built;
  let html = '';
  const puts = [];
  const el = () => ({
    addEventListener() {}, value: '', hidden: false, dataset: {}, setAttribute() {},
    classList: { toggle() {}, contains: () => false }, select() {},
    querySelector: () => el(), querySelectorAll: () => [],
  });
  // Enough of a window for the export: it prints, and renames the document
  // while it does, so both have to be observable.
  const printed = [];
  const ctx = {
    console, Promise, setTimeout, clearTimeout, encodeURIComponent, CSS: { escape: String },
    App: { refresh() {} },
    Charts: new Proxy({}, { get: () => () => '' }),
    /* THE SEAM IS THE NETWORK, not `UI.jsonPut`. `jsonPut` and `toast` are
       module-private inside ui.js; the Points boxes call those bindings, not
       the exports, so assigning `ctx.UI.jsonPut` stubs nothing — the save path
       runs the real code all the way down to `fetch`. A stub on the export
       bought a check that passed for the wrong reason: the save "failed"
       because there was no `fetch` in the context at all. */
    fetch: async (url, options = {}) => {
      const sent = JSON.parse(options.body || '{}');
      puts.push({ url, method: options.method, body: sent });
      if (opts.failSave) {
        return { ok: false, status: 409, statusText: 'Conflict',
          text: async () => JSON.stringify({ error: opts.failSave }) };
      }
      return { ok: true, status: 200, statusText: 'OK',
        text: async () => JSON.stringify({ ok: true, key: sent.key, points: sent.points }) };
    },
    /* Enough document for the toast. `UI.toast` is module-private — the Points
       boxes call it directly, not through `UI.toast`, so stubbing the export
       stubs nothing and the save path dies on a missing `#toast`. */
    document: {
      title: 'Planning Tool',
      createElement: () => ({ set innerHTML(_) {}, content: { firstElementChild: null } }),
      querySelector: () => el(), querySelectorAll: () => [],
    },
    window: {
      print() { printed.push(ctx.document.title); },
      addEventListener(t, fn) { (ctx.window._on = ctx.window._on || {})[t] = fn; },
      removeEventListener() {},
      _on: {},
    },
  };
  vm.createContext(ctx);
  // The real ui.js — a hand-written stub drifts from the thing it stands in for.
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);
  ctx.UI.setJiraBase('https://ipipelinejira.atlassian.net');
  ctx.UI.api = async () => payload;
  /* WHAT THE DRAWER WAS HANDED. The real `UI.drawer` writes into a document
     this harness only stubs, so a drill-in click did its whole job and left
     nothing to assert against — a check on it would have passed no matter
     which keys it listed, or whether it opened at all. */
  let drawn = null;
  ctx.UI.drawer = (h) => { drawn = h; };

  vm.runInContext(`${VIEW}\n;globalThis.__v = SprintView;`, ctx);
  const clicks = [];
  const handlers = {};
  const mount = {
    style: {},
    addEventListener: (t, fn) => {
      if (t === 'click') clicks.push(fn);
      (handlers[t] = handlers[t] || []).push(fn);
    },
    querySelector: () => el(), querySelectorAll: () => [],
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    /** Fire a click as the browser would, with a target that can be `closest`ed.
        `data` carries the rest of the element's dataset — a handler that reads
        `dataset.key` to find its row gets nothing without it, and then quietly
        opens no drawer at all rather than failing. */
    click(act, data = {}) {
      const target = { closest: (sel) => (sel.includes(act) ? { dataset: { act, ...data } } : null) };
      for (const fn of clicks.slice()) fn({ target, preventDefault() {} });
    },
    /** Fire a non-click event at a specific element — the points boxes save
        on `change`, which the click-only harness could not deliver at all. */
    fire(type, target) {
      for (const fn of (handlers[type] || []).slice()) fn({ target, preventDefault() {} });
    },
  };
  await ctx.__v.render({
    teamId: 'titan', sprintId: 'S40', categories: {},
    teams: [{ id: 'titan', name: 'Katalon Titan', jiraName: 'Katalon Auto Titan' }],
    syncedAt: '2026-09-24T09:00:00.000Z',
  }, mount);
  return { html, payload, mount, ctx, printed, puts, get drawn() { return drawn; } };
}

const CAPACITY_VIEW = fs.readFileSync(path.join(__dirname, '..', 'public', 'views', 'capacity.js'), 'utf8');

/**
 * The same, for Capacity planning.
 *
 * It renders the item table from the shared helper, so the table is checked on
 * both screens rather than on the one it started life in — the whole point of
 * sharing it being that the two cannot drift apart.
 */
async function renderCapacity(snap = SNAP, plan = PLAN, sprint = SPRINT, opts = {}) {
  /* TODAY IS PINNED, like the Active sprint harness pins it. The capacity
     payload now carries a `today` for the Due column's overdue reading, and
     left to the wall clock these checks would pass today and fail whenever
     somebody ran them after the fixture's dates went by. */
  const payload = insights.capacityView(plan, snap, TEAM, sprint, { today: MID_SPRINT });
  /* THE SAME COMPOSITION THE ROUTE PERFORMS. `/api/capacity` attaches the "By
     component" sheet to the grid rather than building it inside
     `capacityView` — `prioritization` already requires `insights`, so doing
     it there would close a require cycle. A harness that skipped this step
     would render the screen with no sheet at all, and every check on that
     section would pass against nothing. */
  /* THE TEAM COMES OFF THE PLAN, as `findTeam` gives it to the route. The
     module-level TEAM has no `jiraTeams` — the older checks in this file do
     not need it — so passing that constant here made the sheet report a team
     that cannot claim an epic, and six checks on it passed against the
     explanation card instead of the grid. */
  const bcTeam = (plan.teams || []).find(t => t.id === TEAM.id) || TEAM;
  payload.byComponent = prioritization.sprintComponents(snap, plan, { team: bcTeam, sprint });
  let html = '';
  const el = () => ({
    addEventListener() {}, value: '', hidden: false, dataset: {}, style: {}, setAttribute() {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, select() {},
    getAttribute: () => null, querySelector: () => el(), querySelectorAll: () => [],
  });
  /* A <body> AND A window.print, so "Export PDF" is testable at all. What
     matters about that button is the state of the document AT PRINT TIME —
     the title it saves under, and whether the section it meant is the only
     one showing — so the stub records both at that moment and nothing else
     about it can be checked after the fact. */
  const printed = [];
  const classesOf = (node) => [...node._cls];
  const mkNode = () => {
    const _cls = new Set();
    return {
      _cls,
      classList: {
        add: (c) => _cls.add(c), remove: (c) => _cls.delete(c),
        toggle: () => {}, contains: (c) => _cls.has(c),
      },
    };
  };
  const body = mkNode();
  const printOnly = mkNode();          // the node `[data-bycomp]` resolves to

  /* A cell holding a note box, with enough DOM for something to be inserted
     beside it and taken away again — which is the whole of what the print
     path does to it. */
  const mkDiv = () => ({
    tag: 'div', className: '', textContent: '', parentNode: null,
    kids: [], style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, setAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
  });
  const noteCell = () => {
    const cell = mkDiv();
    cell.insertBefore = (node, ref) => {
      node.parentNode = cell;
      const at = ref ? cell.kids.indexOf(ref) : cell.kids.length;
      cell.kids.splice(at < 0 ? cell.kids.length : at, 0, node);
      return node;
    };
    cell.removeChild = (node) => {
      const at = cell.kids.indexOf(node);
      if (at >= 0) cell.kids.splice(at, 1);
      node.parentNode = null;
      return node;
    };
    return cell;
  };
  const mkArea = (value) => {
    const cell = noteCell();
    const ta = { tag: 'textarea', value, parentNode: cell, nextSibling: null, cell };
    cell.kids.push(ta);
    return ta;
  };
  /* One long note, one blank. The blank is not filler: an empty note must
     leave an empty cell rather than gain a stray box. */
  const areas = opts.notes === false ? [] : [
    mkArea('Blocked on the Lafayette migration, waiting on the new environment before the suite can run end to end.'),
    mkArea('   '),
  ];
  /* A REAL <head> THAT KEEPS WHAT IS APPENDED. Paper orientation cannot be a
     class — `@page` is a document-level at-rule and no selector reaches it —
     so it is injected as a style element for the duration of one print and
     removed again. That makes "is it there AT print time" and "is it gone
     afterwards" two different questions, and a head that swallowed appends
     could answer neither. */
  const head = {
    kids: [],
    appendChild(n) { n.parentNode = head; head.kids.push(n); return n; },
    removeChild(n) { head.kids = head.kids.filter(x => x !== n); n.parentNode = null; return n; },
  };
  const ctx = {
    console, Promise, setTimeout, clearTimeout, encodeURIComponent, CSS: { escape: String },
    /* THE ADDRESS THIS PAGE WAS OPENED AT. The emailed PDF is this same view
       fetched by headless Chrome with `?print=1&family=…`, and the sheet seeds
       its family chip from that — so a harness with no `location` renders the
       one case the send never produces.

       `URLSearchParams` belongs here for a sharper reason: the seed reads the
       query inside a try/catch, so without the constructor it would throw,
       be swallowed, and every check on the lens would pass against a page
       that had quietly skipped it. A missing global does not fail here, it
       agrees with you. */
    URLSearchParams,
    location: { search: opts.search || '', hash: '#sprints/capacity', pathname: '/' },
    App: { refresh() {} },
    Charts: new Proxy({}, { get: () => () => '' }),
    document: {
      title: 'Planning Tool',
      body,
      head,
      createElement: (tag) => (tag === 'style'
        ? { tag, textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, parentNode: null }
        : mkDiv()),
      querySelector: (sel) => (sel === '[data-bycomp]' ? printOnly : el()),
      /* THE NOTE BOXES ARE REAL ENOUGH TO BE READ AND WRITTEN NEXT TO.
         A textarea prints only its visible rows, so `UI.exportPdf` copies
         each note's live text into a plain node beside it for the duration of
         the print. A harness whose `querySelectorAll` answered `[]` would
         find no notes, do nothing, and pass — which is a check that quietly
         tests the absence of the feature. */
      querySelectorAll: (sel) => (sel === 'textarea' ? areas : []),
    },
    window: {
      _on: {},
      addEventListener(t, fn) { this._on[t] = fn; },
      removeEventListener(t) { delete this._on[t]; },
      print() {
        printed.push({
          title: ctx.document.title,
          body: classesOf(body),
          section: classesOf(printOnly),
          // What the page rule says AT PRINT TIME — the only moment it matters.
          page: head.kids.filter(n => n.tag === 'style').map(n => n.textContent),
          /* And the notes, for the same reason: they exist only between the
             copy and the `afterprint` that removes them. */
          notes: areas.flatMap(a => a.cell.kids.filter(k => k.tag === 'div').map(k => k.textContent)),
        });
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, ctx);
  ctx.UI.setJiraBase('https://ipipelinejira.atlassian.net');
  // The screen fetches the roster and scenarios alongside the grid; neither
  // bears on the item table, and both are allowed to be absent in the app.
  /* THE DRAWER'S ROUTE TOO, answered from the same module the route calls —
     so a check on the drawer exercises the real composition rather than a
     canned reply. `drawn` keeps the last thing handed to UI.drawer. */
  let drawn = null;
  const api = async (p) => {
    if (p.startsWith('/api/capacity/bycomponent/epics')) {
      const qp = new URLSearchParams(p.slice(p.indexOf('?') + 1));
      const out = prioritization.sprintComponentCell(snap, plan, {
        team: bcTeam, sprint,
        component: qp.get('row'), tool: qp.get('tool'), cell: qp.get('cell'),
      });
      if (!out.ok) throw new Error(`No cell "${qp.get('tool')}/${qp.get('cell')}".`);
      return out;
    }
    return p.startsWith('/api/capacity') ? payload : null;
  };

  vm.runInContext(`${CAPACITY_VIEW}\n;globalThis.__c = CapacityView;`, ctx);
  ctx.UI.api = api;
  ctx.UI.drawer = (h) => { drawn = h; };
  /* THE NOTE'S WRITE, recorded rather than performed. `jsonPut` is
     module-private inside ui.js and cannot be stubbed from out here — the
     lesson the points-edit checks already learned — so the seam is `fetch`,
     which is what it actually calls. */
  ctx.fetch = async (url, init = {}) => {
    puts.push({ url, method: init.method || 'GET', body: JSON.parse(init.body || '{}') });
    /* `request` reads the body with `.text()` and parses it itself — a stub
       offering `.json()` looks right and is never called, so the refusal path
       silently succeeds and "puts the old text back" passes against nothing. */
    return opts.failSave
      ? { ok: false, status: 409, statusText: 'Conflict', text: async () => JSON.stringify({ error: 'refused' }) }
      : { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ ok: true }) };
  };

  /* ── A MOUNT THAT CAN ACTUALLY BE CLICKED ──────────────────────────
     The "By component" chips and the fold redraw ONE section in place
     rather than refreshing the page, so neither is reachable through
     `innerHTML` alone: with a mount that swallows listeners, a mutation
     removing the family filter outright passed every check in this file.
     This records the delegated handlers and lets a check fire one, and
     `querySelector('[data-bycomp]')` hands back a node whose `outerHTML`
     setter splices the new markup into the page the same way a browser
     would. */
  const handlers = {};
  const puts = [];
  const section = () => {
    const i = html.indexOf('<section class="section" data-bycomp>');
    if (i < 0) return null;
    const end = html.indexOf('</section>', i) + '</section>'.length;
    return { i, end };
  };
  /* An element that answers `closest` for whichever data-attribute it carries.

     `extra` IS THE ELEMENT, not a template copied into one. A handler that
     writes back to the node it was handed — the note box putting its old text
     back after a refused save — must be writing to the object the check can
     then read, or the check asserts against a copy nobody touched and passes
     whatever the handler did. */
  const targetFor = (data, extra = {}) => {
    const node = Object.assign(extra, {
      dataset: data,
      textContent: data.__text || '',
      disabled: 'disabled' in extra ? extra.disabled : false,
    });
    node.closest = (sel) => {
      const attr = (sel.match(/\[([\w-]+)/) || [])[1];
      const camel = String(attr || '').replace(/^data-/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
      return Object.prototype.hasOwnProperty.call(data, camel) ? node : null;
    };
    return node;
  };

  const mount = {
    style: {},
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    querySelector: (sel) => {
      if (sel !== '[data-bycomp]') return el();
      const at = section();
      if (!at) return null;
      return { set outerHTML(v) { html = html.slice(0, at.i) + v + html.slice(at.end); } };
    },
    querySelectorAll: () => [],
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    /** Fire a click at an element carrying `data`, as the browser would. */
    async click(data, extra) { return mount.fire('click', data, extra); },
    /** Any event type — the note box saves on `focusout`, which a click-only
        harness could not deliver at all. */
    async fire(type, data, extra = {}) {
      const target = targetFor(data, extra);
      for (const fn of (handlers[type] || []).slice()) await fn({ target, preventDefault() {} });
      return target;
    },
    get drawn() { return drawn; },
    get printed() { return printed; },
    get puts() { return puts; },
    /* The two marks the scoped print puts on the document, read AFTER the
       fact — so a check can confirm the page was put back, which is the one
       failure of printing a single section that is worse than not offering
       it at all. */
    get bodyClasses() { return classesOf(body); },
    get sectionClasses() { return classesOf(printOnly); },
    /** What the browser fires when the print dialogue closes. */
    afterprint() {
      const fn = ctx.window._on.afterprint;
      if (fn) fn();
    },
  };
  await ctx.__c.render({
    teamId: 'titan', sprintId: 'S40', categories: {},
    /* THE REAL SPRINT, not a stub of it. The app hands this view the sprints
       off the plan, dates and all, and the Due column reads `end` from here to
       decide what is late — so a stripped-down copy makes that column render
       and never colour anything, which looks exactly like a sprint with no
       late work. It did, until a check asked. */
    sprints: [{ ...sprint, byTeam: sprint.byTeam || {} }],
  }, mount);
  // `html` is read through a getter so a check that clicks and then reads
  // sees the redrawn page, not the one captured at render time.
  return { get html() { return html; }, payload, mount, printed, puts, head, ctx, areas };
}

/**
 * Just the "All sprint items" section.
 *
 * Bounded at its own closing table, not run to the end of the document: with an
 * open-ended slice, anything rendered AFTER the item table lands inside it and
 * the checks quietly start describing something else. Moving the per-component
 * section below the table turned three of them red for that reason alone.
 */
const itemsSection = (html) => {
  const from = html.indexOf('All sprint items');
  if (from < 0) return '';
  const end = html.indexOf('</table>', from);
  return html.slice(from, end < 0 ? undefined : end);
};
/** Just the "Per-person progress" card. */
const peopleSection = (html) => {
  const from = html.indexOf('Per-person progress');
  return html.slice(from, html.indexOf('</table>', from));
};

/* ── the item table ───────────────────────────────────────────────────── */

check('EVERY SPRINT ITEM IS A ROW, including the ones nobody owns', async () => {
  const { html, payload } = await renderHtml();
  const body = itemsSection(html);
  for (const k of [...OWNED, ...UNOWNED]) {
    assert.ok(body.includes(`>${k}</a>`) || body.includes(`>${k}<`), `${k} has no row in the item table`);
  }
  // One row per item — so nothing is being dropped silently either. Counted
  // on the tag rather than on `<tr>` exactly: the item rows carry the values
  // the filter matches on, so their opening tag is no longer bare.
  assert.strictEqual(trs(body).length, payload.items.length);
});

check('an item with no assignee says so in the Assignee column', async () => {
  const body = itemsSection((await renderHtml()).html);
  assert.strictEqual((body.match(/tag warn">unassigned/g) || []).length, UNOWNED.length);
});

check('and the caption counts them, so the gap is visible without scanning', async () => {
  // Derived, not typed: a literal here breaks every time the fixture grows,
  // for a reason that has nothing to do with what this check is about.
  const { html, payload } = await renderHtml();
  const unowned = payload.items.filter(i => !i.assignee).length;
  assert.ok(html.includes(`${payload.items.length} items · ${unowned} with no assignee`),
    `caption does not read "${payload.items.length} items · ${unowned} with no assignee"`);
});

check('a sprint where everything is owned says nothing about assignees', async () => {
  const owned = {
    ...SNAP,
    issues: Object.fromEntries(Object.entries(SNAP.issues).filter(([k]) => !UNOWNED.includes(k))),
  };
  const { html, payload } = await renderHtml(owned);
  assert.ok(html.includes(`${payload.items.length} items`));
  assert.ok(!/with no assignee/.test(html), 'no zero-count noise on a clean sprint');
});

/* ── per-person progress ──────────────────────────────────────────────── */

check('WORK WITH NOBODY IN THE ASSIGNEE FIELD GETS A ROW OF ITS OWN', async () => {
  const { html, payload } = await renderHtml();
  const table = peopleSection(html);
  assert.ok(table.includes('unassigned-row'), 'no row for the unowned work');
  assert.ok(table.includes('>No assignee<'), 'the row is not labelled');
  assert.ok(table.includes(`${payload.unassigned.count} items`), 'the row does not say how many');
});

check('AND WORK WITH AN OWNER IS NEVER CALLED UNASSIGNED', async () => {
  // The defect he reported: every item in Katalon Titan Sprint 30 named a
  // person, and the screen said 53 of them had no assignee. A row for work
  // that HAS an owner has to carry that owner's name.
  const { html, payload } = await renderHtml(OFF_ROSTER, OFF_ROSTER_PLAN);
  const table = peopleSection(html);
  assert.strictEqual(payload.unassigned.count, 0, 'fixture check: nothing here is truly unassigned');
  assert.ok(!table.includes('>No assignee<'), 'named work was reported as having no assignee');
  for (const p of payload.offRoster.people) {
    assert.ok(table.includes(p.name), `${p.name} does not appear in the table`);
  }
  assert.ok(table.includes('not on sprint'), 'nothing says why they are listed apart');
});

check('and their points are theirs, not a lump', async () => {
  const { html, payload } = await renderHtml(OFF_ROSTER, OFF_ROSTER_PLAN);
  const table = peopleSection(html);
  const luong = payload.offRoster.people.find(p => p.name === 'Luong Trinh');
  const row = table.slice(table.indexOf('Luong Trinh'));
  assert.ok(row.includes(`>${luong.planned}<`), `Luong Trinh's ${luong.planned} pts are not on his row`);
});

check('and it carries planned AND done, not just planned', async () => {
  const table = peopleSection((await renderHtml()).html);
  const cells = [...table.matchAll(/<td class="num">([\d.]+)<\/td>/g)].map(m => m[1]);
  // The last row is the unowned one: planned 10, done 6, then remaining 4.
  assert.deepStrictEqual(cells.slice(-3), ['10', '6', '4']);
});

check('THE PEOPLE TABLE NOW ADDS UP TO THE COMMITTED KPI', async () => {
  const { html, payload } = await renderHtml();
  const table = peopleSection(html);
  const rows = [...table.matchAll(/<td class="num">([\d.]+)<\/td>\s*<td class="num">([\d.]+)<\/td>/g)];
  const planned = rows.reduce((t, m) => t + Number(m[1]), 0);
  const done = rows.reduce((t, m) => t + Number(m[2]), 0);
  // This is the defect the row exists to fix: without it these two sums were
  // short by exactly the unowned pile, with nothing on screen to say why.
  assert.strictEqual(planned, payload.progress.committed);
  assert.strictEqual(done, payload.progress.done);
});

check('a sprint with nothing unowned gets no empty row', async () => {
  const owned = {
    ...SNAP,
    issues: Object.fromEntries(Object.entries(SNAP.issues).filter(([k]) => !UNOWNED.includes(k))),
  };
  const { html } = await renderHtml(owned);
  assert.ok(!html.includes('unassigned-row'), 'an unowned row appeared with nothing in it');
});

/* ── the same table on Capacity planning ──────────────────────────────── */

check('CAPACITY PLANNING SHOWS THE SPRINT ITEMS TOO', async () => {
  // Balancing a sprint ends in the tickets — you move work between people by
  // picking specific ones — and having to change screens to see them meant
  // holding the grid in your head while you looked.
  const { html, payload } = await renderCapacity();
  assert.ok(html.includes('All sprint items'), 'the section is missing');
  const body = itemsSection(html);
  for (const k of [...OWNED, ...UNOWNED]) {
    assert.ok(body.includes(`>${k}</a>`) || body.includes(`>${k}<`), `${k} has no row`);
  }
  assert.strictEqual(trs(body).length, payload.items.length);
});

check('and it is the SAME table, not a second one that will drift', async () => {
  // Rendered from one helper, so the columns cannot diverge between screens.
  const a = itemsSection((await renderHtml()).html);
  const b = itemsSection((await renderCapacity()).html);
  const headings = (h) => (h.match(/<th[^>]*>([^<]*)<\/th>/g) || []).join('');
  assert.strictEqual(headings(a), headings(b), 'the two screens disagree about the columns');
  assert.ok(headings(a).includes('Epic'), 'fixture check: this is the item table, not some other one');
});

check('the capacity payload carries the items at all', async () => {
  const { payload } = await renderCapacity();
  const { payload: sprint } = await renderHtml();
  assert.ok(Array.isArray(payload.items) && payload.items.length === sprint.items.length,
    'the capacity screen must carry the same items the sprint screen does');
});

/* ── "BY COMPONENT" ON CAPACITY PLANNING ──────────────────────────────────
   The model behind this section is checked in test/by-component.test.js. What
   is checked HERE is the part only the rendered page can answer: that the
   three-row header adds up, that the planned columns are named after the
   sprint the numbers came from, and that a number opens the set it counted. */

/** The By component section alone, bounded at its own closing table. */
const byCompSection = (html) => {
  const i = html.indexOf('>By component<');
  if (i < 0) return '';
  const end = html.indexOf('</table>', i);
  return html.slice(i, end < 0 ? html.length : end + 8);
};

/* A plan with priorities and a sprint the snapshot indexes, so the section
   has rows to draw. The shared fixture has neither — deliberately, since 135
   checks depend on its exact shape — so this one is built beside it. */
const BC_SPRINT = {
  ...SPRINT,
  byTeam: { titan: { jiraId: '900', name: 'Katalon Titan Sprint 40', state: 'active' } },
};
/* A FUTURE SPRINT, so "a plan is not progress" is testable at all. Without
   one, the active-sprint-only rule and the old open-sprint rule agree on
   every number and the difference between them cannot be seen. */
const BC_NEXT = {
  id: 'S41', number: 41, name: 'Sprint 41', start: '2026-10-01', end: '2026-10-14',
  byTeam: { titan: { jiraId: '901', name: 'Katalon Titan Sprint 41', state: 'future' } },
};
const BC_PLAN = {
  ...PLAN,
  sprints: [BC_SPRINT, BC_NEXT],
  teams: [{ ...TEAM, jiraTeams: ['Katalon Auto Titan'] }],
  /* A FOURTH RANKED SUITE, for the one-item-many-cells case below. It could
     not go on PS_iGO_NLG (half a dozen checks pin those cells) nor on
     PS_RES_NLG (which is the designated CLEAR row three more checks need). */
  componentPriority: { PS_iGO_NLG: 1, KAT_Common: 2, PS_RES_NLG: 3, PS_MAINT_NLG: 4 },
  /* A note on a BUSY row and a note on a CLEAR one. The clear row folds
     away by default, so a fixture whose only note sits there makes every
     check on the note box assert against markup that was never drawn. */
  componentNote: { PS_iGO_NLG: 'waiting on the migration', PS_RES_NLG: 'parked until Q4' },
  excludedComponents: [],
  coverageTeams: ['Katalon Auto Titan'],
};
const bcEpic = (key, components, automationStatus, o = {}) => ({
  key, issueType: 'Epic', summary: `Epic ${key}`, components,
  automationStatus, labels: [], team: 'Katalon Auto Titan', status: 'Open', ...o,
});
const BC_SNAP = {
  ...SNAP,
  issues: {
    ...SNAP.issues,
    'E-1': bcEpic('E-1', ['PS_iGO_NLG', 'TrueTest'], 'Maintenance'),
    /* RETIRED, BUT STILL IN THE MAINTENANCE QUEUE — the case the Maintenance
       marker exists for, and the only one that can reach that column: an epic
       whose Automation Status reads Blocked is counted in the Blocked column
       instead, so on this column only the label can flag anything. Status
       wins over the label in `bucketOf`, which is exactly why `isObsolete`
       has to be asked separately. */
    'E-OBS': bcEpic('E-OBS', ['PS_iGO_NLG', 'TrueTest'], 'Maintenance', { labels: ['Phase1', 'obsolete'] }),
    'E-2': bcEpic('E-2', ['PS_iGO_NLG'], 'Ready for Automation'),
    'E-3': bcEpic('E-3', ['KAT_Common'], 'Blocked'),
    /* RETIRED IN THE OTHER TWO BUCKETS. The model flags all three; only
       Maintenance is drawn. Without these the "only Maintenance carries a
       marker" check passes because nothing is flagged there to draw — it would
       be agreeing with a page that had quietly started marking three columns. */
    'E-ROBS': bcEpic('E-ROBS', ['PS_iGO_NLG'], 'Ready for Automation', { labels: ['obsolete'] }),
    'E-BOBS': bcEpic('E-BOBS', ['PS_iGO_NLG'], 'Blocked', { labels: ['obsoleted'] }),
    /* NO JIRA TEAM — the PS_iGO_Lafayette defect. `coverageTeams` below is
       given a real allow-list so it actually bites; with an empty one every
       epic is in scope anyway and this case cannot be reproduced. */
    'E-6': { ...bcEpic('E-6', ['PS_iGO_NLG'], 'Blocked'), team: '' },
    'E-4': bcEpic('E-4', ['PS_iGO_NLG'], 'Automated'),
    // A Story in the sprint building E-4, so the planned half is not empty.
    'S-1': {
      key: 'S-1', summary: 'S-1', issueType: 'Story', status: 'In Dev', parentKey: 'E-4',
      components: [], labels: [], team: 'Katalon Auto Titan', relatesTo: [],
    },
    /* PLANNED AND UNSTARTABLE — one per signal, so a marker reading only the
       Refinement column and one reading only the automation field are
       distinguishable. Both build E-2, which is on KSE only, so the marker
       lands on a real cell rather than on a row that draws nothing. */
    'S-3': {
      key: 'S-3', summary: 'S-3', issueType: 'Story', status: 'Refinement', parentKey: 'E-2',
      components: [], labels: [], team: 'Katalon Auto Titan', relatesTo: [],
    },
    'S-4': {
      key: 'S-4', summary: 'S-4', issueType: 'Story', status: 'In Dev', parentKey: 'E-2',
      automationStatus: 'Blocked',
      components: [], labels: [], team: 'Katalon Auto Titan', relatesTo: [],
    },
    /* ── ONE BLOCKED ITEM, SEVERAL DESTINATIONS ──────────────────────
       A Bucket Story maintaining THREE epics on PS_MAINT_NLG — E-7 and E-10
       on KSE, E-8 on TrueTest. It is ONE blocked item, and it reaches the
       KSE cell TWICE and the TrueTest cell once.

       ON ITS OWN RANKED COMPONENT, so it cannot disturb the PS_iGO_NLG
       cells half a dozen other checks pin, nor PS_RES_NLG which three more
       need to stay clear.
   
       Without a row like this, "de-duplicate within a cell" and "count the
       row distinctly across tools" are both unfalsifiable — dropping either
       changes no number in the fixture, which is exactly how both survived a
       mutation run. */
    'E-7': bcEpic('E-7', ['PS_MAINT_NLG'], 'Maintenance'),
    'E-8': bcEpic('E-8', ['PS_MAINT_NLG', 'TrueTest'], 'Maintenance'),
    'B-1': {
      key: 'B-1', summary: 'B-1', issueType: 'Bucket Story', status: 'Refinement', parentKey: 'E-9',
      components: [], labels: [], team: 'Katalon Auto Titan',
      relatesTo: [
        { key: 'E-7', summary: 'E-7', type: 'Epic' },
        { key: 'E-8', summary: 'E-8', type: 'Epic' },
        { key: 'E-10', summary: 'E-10', type: 'Epic' },
      ],
    },
    'E-9': bcEpic('E-9', ['KAT_Common'], 'Automated'),
    'E-10': bcEpic('E-10', ['PS_MAINT_NLG'], 'Maintenance'),
    // Queued for the FUTURE sprint against a backlog epic: it must stay in
    // the backlog AND be reported as earmarked.
    'E-5': bcEpic('E-5', ['PS_iGO_NLG'], 'Ready for Automation'),
    'S-2': {
      key: 'S-2', summary: 'S-2', issueType: 'Story', status: 'To Do', parentKey: 'E-5',
      components: [], labels: [], team: 'Katalon Auto Titan', relatesTo: [],
    },
  },
  /* The sprint index carries the ORIGINAL items as well as the new Story:
     `capacityView` takes the fast path through this index, so indexing only
     S-1 would quietly shrink the item table to one row and take several
     checks on that table with it. */
  byTeam: { titan: { sprintIssues: { 900: [...Object.keys(SNAP.issues), 'S-1', 'S-3', 'S-4', 'B-1'], 901: ['S-2'] } } },
};

const renderByComp = () => renderCapacity(BC_SNAP, BC_PLAN, BC_SPRINT);

check('THE "BY COMPONENT" SHEET IS ON THE PAGE, above the item table', async () => {
  /* Order matters and is the request: you decide what the sprint should take
     on from the suites, then look at the tickets. Below the item table it is
     a footnote. */
  const { html } = await renderByComp();
  const sheet = html.indexOf('>By component<');
  const items = html.indexOf('All sprint items');
  assert.ok(sheet > 0, 'the section did not render at all');
  assert.ok(items > 0, 'fixture check: the item table is on the page');
  assert.ok(sheet < items, 'the sheet rendered below the item table');
});

check('THE THREE-ROW HEADER ADDS UP — every body row fits it exactly', async () => {
  /* A colspan that does not match the cells beneath it is the one table bug a
     screenshot will not show you: the browser silently reflows and the
     numbers sit under the wrong headings. Counted rather than eyeballed. */
  const body = byCompSection((await renderByComp()).html);
  const head = body.slice(body.indexOf('<thead>'), body.indexOf('</thead>'));
  const rows = head.split('<tr>').slice(1);
  assert.strictEqual(rows.length, 3, 'the header is not three rows deep');

  // Width of each header row: a cell counts for its colspan, and a rowspan
  // cell also occupies the rows below it.
  const widthOf = (tr) => (tr.match(/<th[^>]*>/g) || [])
    .reduce((n, th) => n + Number((th.match(/colspan="(\d+)"/) || [])[1] || 1), 0);
  const spans = (tr) => (tr.match(/<th[^>]*>/g) || [])
    .filter(th => /rowspan="3"/.test(th)).length;

  const top = widthOf(rows[0]);
  assert.strictEqual(widthOf(rows[1]) + spans(rows[0]), top, 'the second header row does not span the table');
  assert.strictEqual(widthOf(rows[2]) + spans(rows[0]), top, 'the third header row does not span the table');

  const cellsIn = (tr) => (tr.match(/<td[^>]*>/g) || []).length;
  const bodyRows = body.slice(body.indexOf('<tbody>')).split('<tr').slice(1);
  assert.ok(bodyRows.length >= 3, `only ${bodyRows.length} rows rendered — the fixture is not reaching the table`);
  for (const tr of bodyRows) {
    assert.strictEqual(cellsIn(tr), top, `a body row has ${cellsIn(tr)} cells under a ${top}-column header`);
  }
});

check('THE PLANNED COLUMNS ARE NAMED AFTER THE SPRINT THE NUMBERS CAME FROM', async () => {
  /* From the payload, not the picker: the two are different facts the moment
     a request is in flight, and a header naming a sprint the numbers did not
     come from is worse than no header at all. */
  const { html, payload } = await renderByComp();
  const body = byCompSection(html);
  assert.strictEqual(payload.byComponent.sprint.label, 'Katalon Titan Sprint 40',
    'fixture check: the team has its own name for this sprint');
  assert.ok(body.includes('Katalon Titan Sprint 40 Planned'),
    'the planned group is not named after the selected sprint');
  /* THE BACKLOG HEADER IS JUST "BACKLOG" NOW.
     It used to carry "· all teams", because this column counts across every
     team while the rest of the screen is about one. That caveat is real and
     it has NOT gone — it is in the column's own tooltip, asserted just below,
     and in the footnote under the table. It was being said three times, and
     three statements of one caveat read as three different caveats. The
     header is the one of the three with no room to explain itself.
     Pinned BOTH ways round: the qualifier is gone from the heading AND the
     rule is still reachable, because dropping the tooltip with it would take
     the explanation out of the page entirely. */
  assert.ok(/>Backlog<\/th>/.test(body),
    'the backlog heading is not a plain "Backlog"');
  assert.ok(!/all teams<\/span>/.test(body),
    'the "· all teams" qualifier is back in the heading');
  const head = (body.match(/<th[^>]*title="([^"]*)"[^>]*>Backlog</) || [])[1] || '';
  assert.ok(head, 'the backlog heading lost its tooltip, so the scope is now stated nowhere on it');
  assert.ok(/across all teams/.test(head),
    `the tooltip no longer says the backlog spans teams: ${head}`);
  assert.ok(/ACTIVE sprint/.test(head), `the backlog tooltip describes the wrong rule: ${head}`);
  assert.ok(!/any open sprint/.test(head), 'the backlog tooltip still says "any open sprint"');
  assert.ok(/plan, not progress/.test(head), 'it does not say why a future sprint stays in');
  assert.ok(body.includes('>New build<') && body.includes('>Maintenance<'),
    'the planned pair lost its column headings');
});

/* ONE CELL, BY ITS COLUMN CLASS — not the whole section.
   Both checks below started out searching the section for a key and for a
   dash, and both passed while the cells were plain text: the row's component
   NAME links every key it counted (so the key was there), and the Notes
   column renders a dash of its own (so the dash was there). A check that a
   cell links has to look at that cell. */
function bcCell(html, component, cls) {
  const body = byCompSection(html);
  const rows = body.slice(body.indexOf('<tbody>')).split('<tr');
  /* Matched on the bare name, not `>name<`: a row with keys renders the
     component inside an anchor and one without renders it as loose text on
     its own line, so the angle brackets are only there half the time — and
     the half they are missing is the empty row these checks are about. */
  const tr = rows.find(r => r.includes(component));
  assert.ok(tr, `no row for ${component}`);
  const cells = tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
  const hit = cells.find(td => cls.every(c => new RegExp(`class="[^"]*\\b${c}\\b`).test(td)));
  assert.ok(hit, `${component}: no cell matching ${cls.join(' + ')}`);
  return hit;
}

check('A NUMBER OPENS A DRAWER, not a Jira tab', async () => {
  /* You click a 16 to find out WHICH sixteen. An anchor answers that with a
     tab switch, a Jira page load and a trip back; the drawer answers in
     place and carries its own "Open in Jira" for when that was the point.
     Every other number on Coverage and Prioritization already works this
     way — this table was the odd one out. */
  const { html } = await renderByComp();
  const cell = bcCell(html, 'PS_iGO_NLG', ['cov-maintenance', 'band-a']);
  assert.ok(!/<a\b/.test(cell), `the cell still renders a Jira anchor: ${cell}`);
  assert.ok(/<button/.test(cell), 'the number is not a real button, so it is not keyboard-reachable');
  assert.ok(/data-act="bc-epics"/.test(cell), 'the cell opens nothing');
});

check('AND IT CARRIES WHICH CELL IT IS, so the drawer can list that set', async () => {
  const { html } = await renderByComp();
  const backlog = bcCell(html, 'PS_iGO_NLG', ['cov-maintenance', 'band-a']);
  assert.ok(/data-row="PS_iGO_NLG"/.test(backlog), 'the row is not named');
  assert.ok(/data-tool="truetest"/.test(backlog), 'the tool is not named');
  assert.ok(/data-cell="maintenance"/.test(backlog), 'the column is not named');

  // The planned half names its own column, not the backlog's — the two
  // Maintenance columns in a row are different measurements.
  const planned = bcCell(html, 'PS_iGO_NLG', ['plan-build', 'band-b']);
  assert.ok(/data-cell="build"/.test(planned), `the New build cell says the wrong column: ${planned}`);
  assert.ok(/data-tool="kse"/.test(planned), 'the planned cell says the wrong tool');
});

check('THE DRAWER LISTS EXACTLY THE SET THE NUMBER COUNTED', async () => {
  /* The cardinal rule of every drill-in here. The route re-runs the sheet
     and reads the cell's OWN key list rather than rebuilding the filter from
     its query string — a second implementation agrees until the day it does
     not, and then neither side says which one is wrong. */
  const cell = (tool, c) => prioritization.sprintComponentCell(BC_SNAP, BC_PLAN, {
    team: BC_PLAN.teams[0], sprint: BC_SPRINT, component: 'PS_iGO_NLG', tool, cell: c,
  });
  const { payload } = await renderByComp();
  const row = payload.byComponent.rows.find(r => r.component === 'PS_iGO_NLG');

  for (const [tool, name] of [['truetest', 'maintenance'], ['kse', 'ready'], ['kse', 'build']]) {
    const r = cell(tool, name);
    assert.strictEqual(r.ok, true, `${tool}/${name} was refused`);
    assert.strictEqual(r.count, row[tool][name],
      `${tool}/${name}: the cell says ${row[tool][name]} and the drawer would list ${r.count}`);
    assert.deepStrictEqual(r.epics.map(e => e.key), row[tool].keys[name],
      `${tool}/${name}: the drawer lists a different set from the one the number counted`);
    assert.ok(r.epics.every(e => !e.absent), `${tool}/${name}: the drawer could not resolve an epic it listed`);
  }
  // The heading names the tool AND the column, both from the model.
  assert.strictEqual(cell('truetest', 'maintenance').label, 'TrueTest · Maintenance');
  assert.strictEqual(cell('kse', 'build').label, 'KSE · New build');
  assert.strictEqual(cell('truetest', 'maintenance').half, 'backlog');
  assert.strictEqual(cell('kse', 'build').half, 'planned');
});

check('AN UNKNOWN CELL IS REFUSED, not answered with an empty list', async () => {
  /* A drawer saying 0 under a number saying 12 is worse than an error: it
     reads as an answer. */
  const bad = (o) => prioritization.sprintComponentCell(BC_SNAP, BC_PLAN, {
    team: BC_PLAN.teams[0], sprint: BC_SPRINT,
    component: 'PS_iGO_NLG', tool: 'truetest', cell: 'maintenance', ...o,
  });
  assert.strictEqual(bad({ cell: 'automated' }).ok, false, 'a column this table does not draw was answered');
  assert.strictEqual(bad({ cell: 'nonsense' }).ok, false);
  assert.strictEqual(bad({ tool: 'nonsense' }).ok, false);
  assert.strictEqual(bad({ component: 'Not A Suite' }).ok, false);
  assert.strictEqual(bad({}).ok, true, 'fixture check: the good call still works');
  assert.ok((bad({ cell: 'nonsense' }).known || []).includes('build'), 'the refusal does not say what is valid');
});

check('A ZERO DOES NOT OPEN — it is an absence, not a question', async () => {
  const { html } = await renderByComp();
  // PS_iGO_NLG has TrueTest Maintenance but no TrueTest Ready.
  const cell = bcCell(html, 'PS_iGO_NLG', ['cov-ready', 'band-a']);
  assert.ok(!/<button/.test(cell), `a zero cell rendered a control: ${cell}`);
  assert.ok(cell.includes('—'), `a zero cell is not a dash: ${cell}`);
  // The same column on the same row on the other side of the table is NOT
  // zero, so the check above is about the number and not about the column.
  assert.ok(/<button/.test(bcCell(html, 'PS_iGO_NLG', ['cov-ready', 'band-b'])),
    'fixture check: PS_iGO_NLG has a KSE Ready epic');
});

check('THE COMPONENT NAME STILL GOES TO JIRA — it is a search, not a cell', async () => {
  /* The name is the whole suite across both halves, which is the thing you
     would actually search for. Only the CELLS became drawers. */
  const { html } = await renderByComp();
  const tbody = byCompSection(html);
  const row = tbody.slice(tbody.indexOf('<tbody>')).split('<tr').find(r => r.includes('PS_iGO_NLG'));
  const nameCell = (row.match(/<td[^>]*>[\s\S]*?<\/td>/) || [''])[0];
  assert.ok(/<a\b[^>]*class="comp-link"/.test(nameCell), `the component name stopped linking: ${nameCell}`);
  assert.ok(/key(%20|\+)in(%20|\+)\(/.test(nameCell), 'the name links by something other than key');
});

check('A CLEAR RANKED SUITE IS FOLDED AWAY AND COUNTED, not dropped', async () => {
  /* The ranked list is portfolio-wide and a team touches a slice of it: on
     his data Ruby's sheet has 129 ranked rows and something in about twenty.
     Drawing all 129 buries the twenty that need reading under a hundred rows
     of dashes — so the clear ones fold, and the COUNT is the finding. */
  const { html, payload } = await renderByComp();
  const body = byCompSection(html);
  const bc = payload.byComponent;
  assert.ok(bc.rows.some(r => r.component === 'PS_RES_NLG' && r.empty),
    'fixture check: PS_RES_NLG is a ranked component with nothing against it');

  // Bounded at </tbody>: the footer is a <tr> too, and counting it makes the
  // table look like it drew one more row than it did.
  const tbody = body.slice(body.indexOf('<tbody>'), body.indexOf('</tbody>'));
  const drawn = tbody.split('<tr').length - 1;
  assert.strictEqual(drawn, bc.rows.filter(r => !r.empty).length,
    'the clear rows were drawn by default');
  assert.ok(!tbody.includes('PS_RES_NLG'), 'a clear row is in the table body');

  const section = html.slice(html.indexOf('>By component<'));
  assert.ok(/1 clear suite hidden/.test(section),
    'the folded rows were dropped in silence instead of counted');
  assert.ok(/data-act="bc-show-all"/.test(section), 'there is no way to unfold them');
});

check('THE FOOTER COUNTS THE ROWS ON SCREEN, not the ones in the payload', async () => {
  /* Every individual figure correct and the one line a reader quotes in a
     status update wrong — the failure the Prioritization footer already
     documents, and the fold above is exactly what would cause it here. */
  const { html, payload } = await renderByComp();
  const body = byCompSection(html);
  const foot = body.slice(body.indexOf('<tfoot>'));
  const shown = payload.byComponent.rows.filter(r => !r.empty).length;
  assert.ok(foot.includes(`${shown} components`), `the footer does not say "${shown} components"`);
  assert.notStrictEqual(shown, payload.byComponent.rows.length,
    'fixture check: the payload has more rows than the table draws, or this proves nothing');
});

check('EVERY DECLARED FAMILY GETS A CHIP, including the empty ones', async () => {
  /* PS is client delivery, R&D is product regression, KAT is the shared
     framework — three different conversations sharing one table. A filter
     whose buttons appear and disappear as the sprint moves is one you cannot
     learn, so an empty family is drawn disabled and says zero rather than
     vanishing: "KAT: none of yours this sprint" is itself the answer. */
  const { html, payload } = await renderByComp();
  const section = html.slice(html.indexOf('>By component<'));
  const bar = section.slice(0, section.indexOf('<table'));
  const fams = payload.byComponent.families;
  assert.ok(fams.length >= 4, 'the payload ships no family list for the chips');

  assert.ok(/data-bc-family=""/.test(bar), 'there is no All chip');
  for (const f of fams) {
    assert.ok(new RegExp(`data-bc-family="${f.key}"`).test(bar), `no chip for ${f.key}`);
  }
  // The fixture has PS rows and no R&D ones, so both states are exercised.
  assert.ok(fams.find(f => f.key === 'ps').busy > 0, 'fixture check: PS has rows');
  assert.strictEqual(fams.find(f => f.key === 'rnd').busy, 0, 'fixture check: R&D has none');
  assert.ok(/data-bc-family="rnd"[^>]*disabled/.test(bar) || /disabled[^>]*data-bc-family="rnd"/.test(bar),
    'an empty family chip is clickable and would filter the table to nothing');
});

check('THE CHIP COUNTS WHAT THE TABLE WILL DRAW, not the payload\'s rows', async () => {
  /* The clear rows fold away by default. A chip reading "PS 41" over a table
     showing three is the chip counting a different population from the one it
     filters, and one of the two numbers is a lie. */
  const { html, payload } = await renderByComp();
  const section = html.slice(html.indexOf('>By component<'));
  const bar = section.slice(0, section.indexOf('<table'));
  const ps = payload.byComponent.families.find(f => f.key === 'ps');
  assert.notStrictEqual(ps.busy, ps.count,
    'fixture check: PS has a clear row, or the two counts cannot be told apart');
  assert.ok(new RegExp(`data-bc-family="ps"[^>]*>[^<]*<strong>${ps.busy}</strong>`).test(bar),
    `the PS chip does not say ${ps.busy}, the number of rows the folded table draws`);
});

check('CLICKING A FAMILY CHIP NARROWS THE TABLE TO THAT FAMILY', async () => {
  /* The check the first pass of this file could not make: with a mount that
     swallowed its listeners, a mutation deleting the family filter outright
     passed everything. A lens is only tested by moving it. */
  const r = await renderByComp();
  const rows = () => {
    const b = byCompSection(r.html);
    return b.slice(b.indexOf('<tbody>'), b.indexOf('</tbody>'));
  };
  assert.ok(rows().includes('PS_iGO_NLG') && rows().includes('KAT_Common'),
    'fixture check: the unfiltered table holds both families');

  await r.mount.click({ bcFamily: 'kat' });
  assert.ok(rows().includes('KAT_Common'), 'the KAT row went with the filter');
  assert.ok(!rows().includes('PS_iGO_NLG'), 'the PS rows survived a KAT filter');

  // And the chip that is on says so, so the table is never silently narrowed.
  const section = r.html.slice(r.html.indexOf('>By component<'));
  assert.ok(/data-bc-family="kat"[^>]*class="[^"]*active|class="chip active"[^>]*data-bc-family="kat"/.test(section)
    || /class="chip active" data-bc-family="kat"/.test(section),
  'the active family is not marked, so the table looks unfiltered');
});

check('THE PRINTED PAGE OPENS UNDER THE SENDER\'S FAMILY LENS', async () => {
  /* HIS REPORT, exactly: filter the sheet to the PS family, email the report,
     and the attachment shows all 98 components.

     There are two ways this page becomes a PDF. The button on screen prints
     the live document, so it has always honoured the chips. THE EMAILED ONE
     CANNOT: headless Chrome opens this route in a fresh browser where the
     lens is null. The filter has to travel in the URL and be seeded before
     the first draw, which is what this asks.

     A LENS, NOT A SCOPE — and that is why it is testable only here. The
     family chip changes no figure, so nothing in the mail's wording moves
     with it and no server-side check would notice the picture was wrong. The
     only witness is the table itself. */
  const r = await renderCapacity(BC_SNAP, BC_PLAN, BC_SPRINT, { search: '?print=1&family=kat' });
  const b = byCompSection(r.html);
  const rows = b.slice(b.indexOf('<tbody>'), b.indexOf('</tbody>'));
  assert.ok(rows.includes('KAT_Common'), 'the printed sheet dropped the family that was asked for');
  assert.ok(!rows.includes('PS_iGO_NLG'),
    'the printed sheet shows every family — the emailed PDF is not the table he sent');
});

check('and an ordinary page load ignores the same parameter', async () => {
  /* Without `print=1` the query is somebody's address bar, not a render
     instruction. A lens that applied anyway would keep re-winning after every
     chip click and read as the page refusing to change. */
  const r = await renderCapacity(BC_SNAP, BC_PLAN, BC_SPRINT, { search: '?family=kat' });
  const b = byCompSection(r.html);
  const rows = b.slice(b.indexOf('<tbody>'), b.indexOf('</tbody>'));
  assert.ok(rows.includes('PS_iGO_NLG') && rows.includes('KAT_Common'),
    'a family in the URL filtered a normal page load');
});

check('and no family in the URL still prints everything', async () => {
  /* The sender was on "All". An absent parameter and an empty one both mean
     that, and neither may be mistaken for a family named "". */
  for (const search of ['?print=1', '?print=1&family=']) {
    const r = await renderCapacity(BC_SNAP, BC_PLAN, BC_SPRINT, { search });
    const b = byCompSection(r.html);
    const rows = b.slice(b.indexOf('<tbody>'), b.indexOf('</tbody>'));
    assert.ok(rows.includes('PS_iGO_NLG') && rows.includes('KAT_Common'),
      `printing with "${search}" narrowed a sheet that was sent unfiltered`);
  }
});

check('AND THE CLEAR-ROW FOLD TRAVELS WITH IT', async () => {
  /* The other half of "a picture of this table as it stands". A reader who
     expanded the clear rows before sending meant the attachment to have
     them. */
  const shut = await renderCapacity(BC_SNAP, BC_PLAN, BC_SPRINT, { search: '?print=1' });
  const open = await renderCapacity(BC_SNAP, BC_PLAN, BC_SPRINT, { search: '?print=1&showall=1' });
  const bodyOf = (h) => { const b = byCompSection(h); return b.slice(b.indexOf('<tbody>'), b.indexOf('</tbody>')); };
  const count = (h) => (bodyOf(h).match(/<tr/g) || []).length;
  assert.ok(count(open.html) > count(shut.html),
    'showall=1 printed the same rows as the folded sheet, so the fold does not travel');
});

check('CLICKING THE CHIP YOU ARE ON CLEARS IT', async () => {
  const r = await renderByComp();
  const rows = () => {
    const b = byCompSection(r.html);
    return b.slice(b.indexOf('<tbody>'), b.indexOf('</tbody>'));
  };
  await r.mount.click({ bcFamily: 'kat' });
  assert.ok(!rows().includes('PS_iGO_NLG'), 'fixture check: the filter applied');
  await r.mount.click({ bcFamily: 'kat' });
  assert.ok(rows().includes('PS_iGO_NLG'), 'clicking the active chip did not clear the filter');
  assert.ok(rows().includes('KAT_Common'));
});

check('THE FOLD AND THE FAMILY LENS COMPOSE, and the footer follows both', async () => {
  const r = await renderByComp();
  const foot = () => {
    const b = byCompSection(r.html);
    return b.slice(b.indexOf('<tfoot>'));
  };
  const bc = r.payload.byComponent;
  await r.mount.click({ act: 'bc-show-all' });
  const shownAll = bc.rows.length;
  const b = byCompSection(r.html);
  const body = b.slice(b.indexOf('<tbody>'), b.indexOf('</tbody>'));
  assert.strictEqual(body.split('<tr').length - 1, shownAll, 'unfolding did not draw every ranked row');
  assert.ok(body.includes('PS_RES_NLG'), 'the clear row did not come back');
  assert.ok(foot().includes(`${shownAll} components`), 'the footer did not follow the unfold');

  // Now narrow to PS with the fold still open: the footer counts PS rows.
  await r.mount.click({ bcFamily: 'ps' });
  const ps = bc.rows.filter(x => x.familyKey === 'ps').length;
  assert.ok(foot().includes(`${ps} components`),
    `the footer says something other than ${ps} after filtering to PS`);
  assert.notStrictEqual(ps, shownAll, 'fixture check: PS is not the whole table');
});

check('CLICKING A NUMBER OPENS A DRAWER LISTING THAT CELL', async () => {
  /* End to end through the real route composition: the view asks, the model
     re-runs the sheet and reads the cell's own keys, and the drawer lists
     them. A canned reply here would test the drawer's markup and nothing
     about whether the number and the list agree. */
  const r = await renderByComp();
  const row = r.payload.byComponent.rows.find(x => x.component === 'PS_iGO_NLG');
  await r.mount.click({ act: 'bc-epics', row: 'PS_iGO_NLG', tool: 'truetest', cell: 'maintenance', __text: '1' });
  const d = r.mount.drawn;
  assert.ok(d, 'no drawer opened');
  assert.ok(d.includes('TrueTest · Maintenance'), `the drawer is not titled for the cell: ${d.slice(0, 200)}`);
  assert.ok(d.includes('PS_iGO_NLG'), 'the drawer does not name the row');
  for (const k of row.truetest.keys.maintenance) {
    assert.ok(d.includes(k), `the drawer does not list ${k}, which the cell counted`);
  }
  assert.ok(/Across all teams/.test(d) && /no work in an active sprint/.test(d),
    `the drawer does not say what population the backlog half is: ${d.slice(0, 300)}`);
});

check('AND A PLANNED CELL SAYS WHICH SPRINT IT CAME FROM', async () => {
  const r = await renderByComp();
  await r.mount.click({ act: 'bc-epics', row: 'PS_iGO_NLG', tool: 'kse', cell: 'build', __text: '1' });
  const d = r.mount.drawn;
  assert.ok(d.includes('KSE · New build'), `wrong title: ${d.slice(0, 200)}`);
  assert.ok(d.includes('Katalon Titan Sprint 40'),
    'the planned drawer does not name the sprint the work was planned in');
  assert.ok(d.includes('E-4'), 'the drawer does not list the epic the sprint is building');
  assert.ok(!/Across all teams/.test(d),
    'the planned drawer is explained as if it were the portfolio backlog');
  assert.ok(/Katalon Titan planned/.test(d),
    'the planned drawer does not say whose work it is listing');
});

check('THE MAINTENANCE NUMBER CARRIES A MARKER when part of it is retired', async () => {
  /* His request. A Maintenance count reads as "suites waiting to be fixed",
     and a retired one is not waiting for anything. */
  const r = await renderByComp();
  const section = byCompSection(r.html);
  const rows = r.payload.byComponent.rows;
  const flagged = rows.find(x => coverage.TOOLS.some(t => ((x[t.key].flagged || {}).maintenance || []).length));
  assert.ok(flagged, 'fixture check: no component has a retired Maintenance suite');
  const tool = coverage.TOOLS.find(t => ((flagged[t.key].flagged || {}).maintenance || []).length);

  const row = section.slice(section.indexOf(flagged.component), section.indexOf('</tr>', section.indexOf(flagged.component)));
  const mark = row.match(/<button[^>]*data-cell="flag-maintenance"[^>]*>/);
  assert.ok(mark, `no marker beside Maintenance for ${flagged.component}: ${row}`);
  assert.match(mark[0], /class="stuck-mark"/,
    'the marker does not use the same shape as the planned columns\' one');
  assert.ok(mark[0].includes(`data-tool="${tool.key}"`), 'the marker names a different tool');
  assert.match(mark[0], /aria-label="[^"]+"/, 'the marker says nothing to a screen reader');
  assert.match(mark[0], /title="[^"]*obsolete[^"]*"/i, 'the tooltip does not say what it means');

  /* ITS OWN COUNT, because its text is "!". The click handler scrapes digits
     off a control's text when it has no `data-n`, which yields 0 here and
     silently switches off the "this cell was redrawn while the drawer was
     opening" check. */
  const n = ((flagged[tool.key].flagged || {}).maintenance || []).length;
  assert.ok(mark[0].includes(`data-n="${n}"`),
    `the marker does not carry its count, so the redraw check is disabled: ${mark[0]}`);
});

check('AND NO MARKER WHERE NOTHING IS FLAGGED', async () => {
  /* A marker that is always there is one nobody reads. */
  const r = await renderByComp();
  const section = byCompSection(r.html);
  for (const x of r.payload.byComponent.rows) {
    const none = coverage.TOOLS.every(t => !((x[t.key].flagged || {}).maintenance || []).length);
    if (!none) continue;
    const row = section.slice(section.indexOf(x.component), section.indexOf('</tr>', section.indexOf(x.component)));
    assert.ok(!/data-cell="flag-maintenance"/.test(row),
      `${x.component} has nothing retired and grew a marker`);
  }
});

check('AND READY AND BLOCKED CARRY IT TOO, because that is where his are', async () => {
  /* Only Maintenance was asked for, and on his store Maintenance is the one
     backlog column a retired suite CANNOT reach: an obsolete epic that kept a
     status has a Blocked one, and one with no status is bucketed "obsoleted"
     and never enters the backlog. Marking Maintenance alone ships something
     invisible. The condition is identical in all three columns, so all three
     ask it. */
  const r = await renderByComp();
  const section = byCompSection(r.html);
  for (const b of ['maintenance', 'ready', 'blocked']) {
    const any = r.payload.byComponent.rows.some(x =>
      coverage.TOOLS.some(t => ((x[t.key].flagged || {})[b] || []).length));
    assert.ok(any, `fixture check: nothing is flagged under ${b}, so this check cannot bite`);
    assert.ok(section.includes(`data-cell="flag-${b}"`), `the ${b} column carries no marker`);
  }
});

check('AND NO COLUMN IS MARKED WHERE NOTHING IS FLAGGED', async () => {
  /* The other half of the same guarantee, now that all three are eligible: a
     marker on a column with nothing retired in it opens a drawer listing
     nothing. Swept per column rather than per row, so a page that drew the
     marker unconditionally is caught wherever it did it. */
  const r = await renderByComp();
  const section = byCompSection(r.html);
  const marks = [...section.matchAll(/data-row="([^"]*)"[^>]*data-tool="([^"]*)"[^>]*data-cell="flag-([^"]*)"/g)];
  assert.ok(marks.length, 'fixture check: no markers at all, so this check cannot bite');
  for (const [, row, tool, bucket] of marks) {
    const x = r.payload.byComponent.rows.find(y => y.component === row);
    assert.ok(x, `a marker names a component the payload does not have: ${row}`);
    assert.ok((((x[tool] || {}).flagged || {})[bucket] || []).length > 0,
      `${row}/${tool}/${bucket} carries a marker with nothing flagged behind it`);
  }
});

check('CLICKING IT OPENS THE RETIRED SUITES, and says it is a subset', async () => {
  const r = await renderByComp();
  const rows = r.payload.byComponent.rows;
  const flagged = rows.find(x => coverage.TOOLS.some(t => ((x[t.key].flagged || {}).maintenance || []).length));
  const tool = coverage.TOOLS.find(t => ((flagged[t.key].flagged || {}).maintenance || []).length);
  const keys = flagged[tool.key].flagged.maintenance;

  await r.mount.click({ act: 'bc-epics', row: flagged.component, tool: tool.key, cell: 'flag-maintenance', __text: String(keys.length) });
  const d = r.mount.drawn;
  assert.ok(d, 'the marker opened no drawer');
  for (const k of keys) assert.ok(d.includes(k), `the drawer does not list ${k}`);

  /* IT MUST NOT READ AS THE WHOLE COLUMN. Two rows under a column saying 425
     is the kind of panel that makes somebody distrust the number beside it.
     Asserted on the HEADING element, not on the drawer's html: the body
     explains the same thing in prose, so a loose match would go on passing
     with a heading that just said "Maintenance". */
  const head = (d.match(/<div class="eyebrow">(?:<i><\/i>)?([^<]*)</) || [])[1] || '';
  assert.match(head, /Maintenance/, `the heading does not name the column: ${head}`);
  assert.match(head, /retired/i, `the heading reads as the whole Maintenance queue: ${head}`);
  assert.match(d, /nobody intends to work/i, 'the drawer does not explain what it is listing');
  assert.match(d, /obsolete/i, 'the drawer does not name the reason');

  /* AND THE REASON IS ON THE ROW, drawn from the labels the model now sends. */
  assert.match(d, /class="drill-blocked"/, 'the reason is not marked on the rows');
  assert.match(d, /Retired/, 'a retired suite is not said to be retired');
});

check('A REFUSED CELL SAYS SO RATHER THAN OPENING AN EMPTY DRAWER', async () => {
  const r = await renderByComp();
  await r.mount.click({ act: 'bc-epics', row: 'PS_iGO_NLG', tool: 'truetest', cell: 'automated', __text: '3' });
  const d = r.mount.drawn;
  assert.ok(/Could not read/.test(d), `a refused cell opened a normal drawer: ${d.slice(0, 200)}`);
});

check('THE NOTE IS AN EDITABLE BOX, capped by the model that enforces it', async () => {
  const { html, payload } = await renderByComp();
  const body = byCompSection(html);
  assert.ok(/data-bc-note="PS_iGO_NLG"/.test(body), 'the note is not editable');
  assert.ok(/<textarea class="note"/.test(body), 'the note is not the control the other grid uses');
  const max = payload.byComponent.noteMax;
  assert.ok(max > 0, 'the payload does not carry the note cap');
  assert.ok(new RegExp(`maxlength="${max}"`).test(body),
    `the box offers a length other than the server's ${max}`);
  // The existing note is in the box AND in data-was, so a blur with nothing
  // typed can be told from a real edit.
  assert.ok(/data-was="waiting on the migration"/.test(body),
    'the box does not remember what it started as');
});

check('EDITING IT SAVES TO THE SAME NOTE THE OTHER SCREEN EDITS', async () => {
  /* One entry per component in the plan, one route. Not a second
     capacity-only note: "waiting on the migration" is a fact about the suite,
     not about this sprint, and two boxes holding two versions of it is how
     the one you are not looking at goes stale. */
  const r = await renderByComp();
  await r.mount.fire('focusout',
    { bcNote: 'PS_iGO_NLG', was: '' },
    { value: 'chasing the vendor', disabled: false });
  assert.strictEqual(r.puts.length, 1, 'the edit wrote nothing');
  assert.strictEqual(r.puts[0].method, 'PUT');
  assert.ok(r.puts[0].url.includes('/api/component-note'),
    `the note went somewhere else: ${r.puts[0].url}`);
  assert.deepStrictEqual(r.puts[0].body, { component: 'PS_iGO_NLG', note: 'chasing the vendor' });
});

check('A BLUR WITH NOTHING CHANGED IS NOT AN EDIT', async () => {
  /* Clicking into a box and out again writes an audit entry per glance if
     this is not checked. Whitespace-only differences do not count either. */
  const r = await renderByComp();
  await r.mount.fire('focusout',
    { bcNote: 'PS_RES_NLG', was: 'waiting on the migration' },
    { value: '  waiting on the migration  ', disabled: false });
  assert.strictEqual(r.puts.length, 0, 'an unchanged box still wrote to the server');
});

check('A REFUSED NOTE PUTS THE OLD TEXT BACK', async () => {
  /* A box that keeps what you typed after the server refused it reads as
     saved, and the next reader sees a note nobody stored. */
  const r = await renderCapacity(BC_SNAP, BC_PLAN, BC_SPRINT, { failSave: true });
  const box = { value: 'this will be refused', disabled: false };
  await r.mount.fire('focusout', { bcNote: 'PS_iGO_NLG', was: 'old text' }, box);
  assert.strictEqual(r.puts.length, 1, 'fixture check: it tried to save');
  assert.strictEqual(box.value, 'old text', 'the box kept text the server refused');
});

check('EXPORT CSV CARRIES THE SCOPES AND NOT THE LENSES', async () => {
  /* Team and sprint decide which epics were counted at all, so both travel.
     The family chip and the fold only hide rows, so the file carries the
     whole list and the reader filters in the spreadsheet — a CSV that is
     silently whichever twenty rows somebody was looking at is the trap every
     other export here avoids. */
  const r = await renderByComp();
  const sec = r.html.slice(r.html.indexOf('>By component<'));
  const href = (sec.match(/href="([^"]*what=bycomponent[^"]*)"/) || [])[1];
  assert.ok(href, 'there is no Export CSV link');
  assert.ok(/team=titan/.test(href), 'the file would not be scoped to this team');
  assert.ok(/sprint=S40/.test(href), 'the file would not be scoped to this sprint');
  assert.ok(!/family=/.test(href), 'the family chip leaked into the export');

  // And it stays put when a lens moves — the whole point of the split.
  await r.mount.click({ bcFamily: 'kat' });
  const after = r.html.slice(r.html.indexOf('>By component<'));
  assert.strictEqual((after.match(/href="([^"]*what=bycomponent[^"]*)"/) || [])[1], href,
    'filtering the table changed what the CSV would contain');
});

check('EXPORT PDF PRINTS THIS SECTION ALONE, under a name you can file', async () => {
  /* The Capacity screen is a KPI strip, a day grid, a roster and three
     tables. "Export PDF" on one of those tables cannot mean "print all of
     that", so the section is marked and the rest hidden for the duration —
     and both facts are read AT PRINT TIME, the only moment either matters. */
  const r = await renderByComp();
  await r.mount.click({ act: 'bc-export-pdf' });
  assert.strictEqual(r.printed.length, 1, 'the browser was never asked to print');
  const at = r.printed[0];
  assert.ok(at.body.includes('print-only-on'), 'the page was printed whole, not scoped to the section');
  assert.ok(at.section.includes('print-only'), 'the section was not marked, so it would be hidden too');

  assert.match(at.title, /Katalon Titan/, `the file would not say whose sheet it is: "${at.title}"`);
  assert.match(at.title, /Katalon Titan Sprint 40/, 'nor which sprint');
  assert.match(at.title, /by component/i, 'nor which table');
  assert.ok(!/[\\/:*?"<>|]/.test(at.title), 'a filename cannot carry path characters');
});

check('AND IT PRINTS LANDSCAPE, because the sheet is sixteen columns wide', async () => {
  /* Two tools times three backlog buckets, two planned columns each, plus
     priority and the note. On portrait A4 the right-hand half either shrinks
     to unreadable or lands on a second sheet that has lost its row labels.

     READ AT PRINT TIME. The rule is a style element injected for this print
     and removed again — asserting on it afterwards would find nothing and
     say nothing, which is how a check on this could pass against an export
     that came out portrait. */
  const r = await renderByComp();
  await r.mount.click({ act: 'bc-export-pdf' });
  const at = r.printed[0];
  assert.ok(at.page.length, 'no page rule was in force when the browser printed');
  assert.match(at.page.join(' '), /@page\s*\{[^}]*landscape/,
    `the sheet printed portrait — the page rule said "${at.page.join(' ')}"`);
  assert.match(at.page.join(' '), /margin/,
    'landscape without a narrower margin gives back less width than the rotation gained');
});

check('AND THE ORIENTATION RULE DOES NOT OUTLIVE THE PRINT', async () => {
  /* `@page` is document-level: a leftover node here silently rotates the
     next export somebody runs from a different screen, and nothing on that
     screen would explain it. */
  const r = await renderByComp();
  await r.mount.click({ act: 'bc-export-pdf' });
  assert.ok(r.head.kids.some(n => n.tag === 'style'), 'fixture check: the rule was injected at all');

  r.ctx.window._on.afterprint();
  assert.deepStrictEqual(r.head.kids.filter(n => n.tag === 'style'), [],
    'the landscape rule is still in the document, so every later export is rotated too');
});

check('THE CAPACITY PAGE EXPORTS ITSELF, whole and landscape', async () => {
  /* The page-level export, beside the By component one that already existed.
     Two buttons on one screen that both say "Export PDF" have to mean
     different things, and what separates them is scope: this one is the
     capacity CONVERSATION — the KPIs, what is out of balance, and who is
     carrying what — which is what goes into a planning meeting, while the
     other is the one sheet he often wants to send on its own.

     DRIVEN BY A CLICK, not asserted against the source. The handler lives in
     `wire()` and the render locals it wants — the sprint, the team name —
     live in `render()`; referring to one from the other is a ReferenceError
     that happens ONLY on click, because nothing else reaches that line. A
     source check would have read fine. */
  const r = await renderCapacity();

  /* THE BUTTON IS ON THE PAGE. Asserted before the click, because the harness
     SYNTHESISES a click target from the data it is given — it does not go
     looking for the element. So the checks below drive the HANDLER, and
     removing the button from the markup left every one of them green while
     the feature was unreachable. Mutation caught that; this line is the fix. */
  assert.match(r.html, /data-act="cap-export-pdf"/,
    'there is no Export PDF button on the capacity page, only a handler nobody can reach');

  await r.mount.click({ act: 'cap-export-pdf' });

  assert.strictEqual(r.printed.length, 1, 'the Export PDF button printed nothing');
  const at = r.printed[0];

  /* NOT SCOPED. This export IS the page, so neither mark should be on the
     document — `print-only-on` would hide every section except one, and the
     one it kept would be whichever the other button had meant. */
  assert.ok(!at.body.includes('print-only-on'),
    'the page export was scoped to a single section');
  assert.deepStrictEqual(at.section, [],
    'a section was marked as the only one to print');

  /* LANDSCAPE, because Member capacity is thirteen columns and the right-hand
     end of it — Load, the load bar, Goal — is what the meeting is about.
     READ AT PRINT TIME: the rule is injected for this print and removed
     again, so asserting afterwards would find nothing and prove nothing. */
  assert.ok(at.page.some(css => /@page[^}]*landscape/.test(css)),
    `the capacity export came out portrait: ${JSON.stringify(at.page)}`);
});

check('AND IT SAYS WHOSE CAPACITY, FOR WHICH SPRINT', async () => {
  /* The filename is the whole of what a reader gets before opening it, and
     these go into planning meetings beside other teams' sheets. */
  const r = await renderCapacity();
  await r.mount.click({ act: 'cap-export-pdf' });
  const at = r.printed[0];
  assert.match(at.title, /Katalon Titan/, `it does not say whose page it is: "${at.title}"`);
  assert.match(at.title, /Sprint 40/, `nor which sprint: "${at.title}"`);
  assert.match(at.title, /capacity planning/i, `nor which page: "${at.title}"`);
  assert.ok(!/[\\/:*?"<>|]/.test(at.title), 'a filename cannot carry path characters');
  assert.ok(!/undefined|\[object/.test(at.title), `the title has a hole in it: "${at.title}"`);
});

check('AND THE TWO EXPORTS ON THIS SCREEN DO DIFFERENT THINGS', async () => {
  /* Stated directly, because the failure is a quiet one: if the page button
     were wired to the same options as the sheet button, both would print the
     By component section and the second control would be a lie that looks
     like it works. */
  const r = await renderByComp();
  await r.mount.click({ act: 'cap-export-pdf' });
  await r.mount.click({ act: 'bc-export-pdf' });
  assert.strictEqual(r.printed.length, 2, 'fixture check: both printed');
  const [page, sheet] = r.printed;
  assert.ok(!page.body.includes('print-only-on'), 'the page export scoped itself to a section');
  assert.ok(sheet.body.includes('print-only-on'), 'the sheet export printed the whole page');
  assert.notStrictEqual(page.title, sheet.title,
    'both exports save under the same name, so one overwrites the other');
});

check('A NOTE PRINTS IN FULL, not the one line the box shows', async () => {
  /* THE BUG THIS EXISTS FOR. Notes are edited in a `<textarea rows="1">`, and
     a textarea prints exactly what fits in its visible rows — everything
     past the first line is scrolled out of view and never reaches the paper.
     The PDF looks complete, and the only way to know it is not is to have
     read the note on screen first.

     READ AT PRINT TIME, because that is the only moment the text exists
     outside the control: `UI.exportPdf` copies it out just before printing
     and removes it again on `afterprint`. Asserting afterwards would find
     nothing and say nothing. */
  const r = await renderCapacity();
  await r.mount.click({ act: 'cap-export-pdf' });

  const at = r.printed[0];
  assert.strictEqual(at.notes.length, 1,
    `expected one note on the page, got ${at.notes.length} — a blank note should not print a box`);
  assert.strictEqual(at.notes[0],
    'Blocked on the Lafayette migration, waiting on the new environment before the suite can run end to end.',
    'the note was truncated, or something other than its text was printed');
});

check('AND THE PRINT RULES SWAP THE BOX FOR THE TEXT', async () => {
  /* THE OTHER HALF, and it lives in CSS where no click can reach it.
     Copying the text out is only half the fix: without the rule that hides
     the control, the sheet prints the truncated box AND the full text
     underneath it — every note twice, one of them cut off. Mutating that rule
     away left every check above green, which is exactly the kind of gap a
     driven test cannot close on its own. */
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const at = css.indexOf('@media print');
  assert.ok(at > -1, 'there is no print stylesheet at all');
  /* The print block runs to the end of the file's media queries; taking a
     generous slice and searching inside it is enough to tell whether the two
     rules are in there, without parsing CSS. */
  const printBlock = css.slice(at);
  assert.match(printBlock, /textarea\s*\{[^}]*display:\s*none/,
    'the note box still prints, so each note appears twice — once truncated');
  assert.match(printBlock, /\.print-note\s*\{[^}]*display:\s*block/,
    'the copied-out note is not shown in print, so notes print blank');
  assert.match(printBlock, /\.print-note\s*\{[^}]*white-space:\s*pre-wrap/,
    'a note with newlines would print as one run-on line');

  /* AND HIDDEN ON SCREEN. A print interrupted before `afterprint` leaves a
     copy behind; without this rule it shows the note twice in the app. */
  assert.match(css, /\.print-note\s*\{\s*display:\s*none;?\s*\}/,
    'a leftover copy would be visible on screen');
});

check('AND THE PAGE IS PUT BACK AFTERWARDS', async () => {
  /* The copies are scaffolding. Left behind they show every note twice on
     screen — and the next export would copy them again, so the duplication
     compounds with each print. */
  const r = await renderCapacity();
  await r.mount.click({ act: 'cap-export-pdf' });
  assert.ok(r.areas.some(a => a.cell.kids.some(k => k.tag === 'div')),
    'fixture check: something was inserted to print');

  r.ctx.window._on.afterprint();
  for (const a of r.areas) {
    assert.deepStrictEqual(a.cell.kids.filter(k => k.tag === 'div'), [],
      'a printed note is still in the document, so the screen now shows it twice');
  }
});

check('AND PRINTING TWICE DOES NOT DOUBLE THEM', async () => {
  /* The compounding case, stated on its own because the cleanup above could
     pass while a second print still stacked a second copy — `restore` runs
     once per export and the list it empties has to be this export's. */
  const r = await renderCapacity();
  await r.mount.click({ act: 'cap-export-pdf' });
  r.ctx.window._on.afterprint();
  await r.mount.click({ act: 'cap-export-pdf' });
  assert.strictEqual(r.printed[1].notes.length, 1,
    `the second export printed ${r.printed[1].notes.length} copies of one note`);
});

check('AND A NOTE THAT IS ONLY WHITESPACE LEAVES AN EMPTY CELL', async () => {
  /* Not pedantry: the By component sheet has a note column on every row and
     most rows have none. A stray empty box on each would turn a readable
     sheet into a grid of boxes. */
  const r = await renderCapacity();
  await r.mount.click({ act: 'cap-export-pdf' });
  const blank = r.areas.find(a => !a.value.trim());
  assert.ok(blank, 'fixture check: there is a blank note');
  assert.deepStrictEqual(blank.cell.kids.filter(k => k.tag === 'div'), [],
    'a blank note printed a box');
});

check('THE CAPACITY PAGE OFFERS EMAIL THE REPORT TOO', async () => {
  /* The pair — Export saves it, Email sends it — in the same corner as the
     other two screens that have both. Driven, because the handler resolves
     the sprint from `state` and lives in `wire` while the render locals live
     in `render`; a source check reads fine either way. */
  const r = await renderCapacity();
  assert.match(r.html, /data-act="email-report"/,
    'there is no Email the report button on the capacity page');

  /* THE DRAWER IS OPENED WITH THIS SCREEN'S REPORT AND SCOPE. `MailDrawer` is
     not loaded in this harness, so the call is captured — what is being
     checked is what the page ASKS FOR, which is the thing that was wrong
     twice before: the wrong team, and the wrong report's page. */
  const opened = [];
  r.ctx.MailDrawer = { open: (c) => opened.push(c) };
  await r.mount.click({ act: 'email-report' });

  assert.strictEqual(opened.length, 1, 'the button opened no drawer');
  const c = opened[0];
  assert.strictEqual(c.report, 'capacity', `it opened the ${c.report} report`);
  assert.strictEqual(c.team, TEAM.id, `it opened for team ${c.team}`);
  assert.ok(c.scope && c.scope.sprint, 'the sprint was not pinned, so the PDF would render whichever is active');
  assert.ok(c.scopeLabel, 'the drawer would not say what this mail is about');
});

check('AND ONLY THE EXPORT THAT ASKED FOR IT IS ROTATED', async () => {
  /* The narrow one-column screens would waste half a sheet in landscape, so
     orientation is asked for per export rather than set once in the
     stylesheet — where it would apply to every print in the app. */
  const r = await renderByComp();
  r.ctx.UI.exportPdf('something narrow', { only: '[data-bycomp]' });
  const at = r.printed[r.printed.length - 1];
  assert.deepStrictEqual(at.page, [],
    'an export that did not ask for landscape got it anyway');
});

check('AND IT PUTS THE PAGE BACK AFTERWARDS', async () => {
  /* A failed restore leaves the user staring at a page with most of it
     missing and no way to guess why — the one failure of printing a single
     section that is worse than not offering it. */
  const r = await renderByComp();
  await r.mount.click({ act: 'bc-export-pdf' });
  assert.ok(r.mount.bodyClasses.includes('print-only-on') === false
    || r.printed.length === 1, 'fixture check: it printed');
  r.mount.afterprint();
  assert.deepStrictEqual(r.mount.bodyClasses, [], 'the body kept its print class');
  assert.deepStrictEqual(r.mount.sectionClasses, [], 'the section kept its print class');
});

check('THE UNTAGGED EPICS ARE COUNTED, AND SAID OUT LOUD', async () => {
  /* "All teams" has to include the epics nobody assigned a team to, or the
     queue hides part of itself — it hid 295 across 16 ranked suites, and
     PS_iGO_Lafayette showed 8 Blocked while carrying 14 Ready. Counted, and
     reported, because it is also the one number on that line a reader can
     act on: an untriaged epic is a triage job. */
  const r = await renderByComp();
  const bc = r.payload.byComponent;
  assert.strictEqual(bc.scopes.backlog.noTeam, 1, 'the untagged epic is not counted or not reported');
  const row = bc.rows.find(x => x.component === 'PS_iGO_NLG');
  assert.ok(row.kse.keys.blocked.includes('E-6'),
    'an untagged epic is missing from a backlog headed "all teams"');

  const sec = r.html.slice(r.html.indexOf('>By component<'));
  const line = sec.slice(0, sec.indexOf('<table')).replace(/\s+/g, ' ');
  assert.ok(/1 carry no Jira Team/.test(line), `the count is not on the page: ${line.slice(0, 400)}`);
  // And the hover explains why this screen and Prioritization now differ.
  assert.ok(/Prioritization/.test(sec.slice(0, sec.indexOf('<table'))),
    'nothing explains why the two screens disagree');
});

check('THE SCOPE LINE SAYS ACTIVE SPRINT, not open sprints', async () => {
  /* The rule narrowed and the wording has to narrow with it, or the line
     describes a cut the numbers no longer make. */
  const { html } = await renderByComp();
  const sec = html.slice(html.indexOf('>By component<'));
  const line = sec.slice(0, sec.indexOf('<table')).replace(/\s+/g, ' ');
  assert.ok(/in flight in \d+ active sprint/.test(line),
    `the line still describes the old rule: ${line.slice(0, 320)}`);
  assert.ok(!/open sprint/.test(line), 'the line still says "open sprint"');
});

check('AND THE EARMARKED SUITES ARE REPORTED, not subtracted', async () => {
  /* An epic queued for a FUTURE sprint stays in the backlog — nobody is
     working it — and the number says how many of them there are. Subtracting
     them would make the backlog shrink every time somebody fills in a future
     sprint, which is the opposite of what filling one in means. */
  const r = await renderByComp();
  const q = r.payload.byComponent.queuedAhead;
  assert.ok(q.epics > 0, 'fixture check: something is queued for a later sprint');
  const sec = r.html.slice(r.html.indexOf('>By component<'));
  const line = sec.slice(0, sec.indexOf('<table')).replace(/\s+/g, ' ');
  assert.ok(new RegExp(`${q.epics} of them already queued for a later sprint`).test(line),
    `the earmarked count is not on the page: ${line.slice(0, 400)}`);
  // Still counted above, not netted off.
  assert.ok(q.epics <= r.payload.byComponent.totals.backlog);
});

check('EACH FIGURE ON THE SCOPE LINE CARRIES ITS OWN SCOPE', async () => {
  /* One team name at the front of the line with two numbers after it reads
     as though both were that team's — and the backlog is the whole
     portfolio, so a reader would take it for a fifth of what it is. The
     scope is attached to the number it belongs to, which is the same fix the
     Prioritization screen made when a team-scoped 9 was read as a portfolio
     25. */
  const { html, payload } = await renderByComp();
  const sec = html.slice(html.indexOf('>By component<'));
  const line = sec.slice(0, sec.indexOf('<table')).replace(/\s+/g, ' ');
  const t = payload.byComponent.totals;
  assert.ok(new RegExp(`${t.backlog} in backlog[^<]*<strong>[^<]*all teams`).test(line),
    `the backlog figure does not say it is portfolio-wide: ${line.slice(0, 320)}`);
  assert.ok(new RegExp(`${t.planned} planned by <strong>Katalon Titan</strong>`).test(line),
    `the planned figure does not say whose it is: ${line.slice(0, 320)}`);
  assert.ok(/Katalon Titan Sprint 40/.test(line), 'nor which sprint it was planned in');
  assert.ok(/backlog excludes/.test(line), 'the page does not say what the backlog left out');
});

check('AN UNMAPPED TEAM STILL GETS THE WHOLE BACKLOG', async () => {
  /* The sheet used to refuse to draw for a team with no Jira Team values,
     because every number on it was scoped by them. Nothing is any more: the
     backlog is portfolio-wide and the planned half is read from the sprint's
     own issue list, which belongs to one team by construction. So the table
     draws, the backlog is the real backlog, and only the planned half is
     empty — which is the true answer rather than a blank page. */
  const plan = { ...BC_PLAN, teams: [{ ...TEAM, jiraTeams: [] }] };
  const r = await renderCapacity(BC_SNAP, plan, BC_SPRINT);
  const from = r.html.indexOf('>By component<');
  const sec = r.html.slice(from, r.html.indexOf('</section>', from));
  assert.ok(sec.includes('<table'), 'an unmapped team was shown no grid at all');
  assert.ok(r.payload.byComponent.totals.backlog > 0,
    'the backlog went empty for a team that does not scope it');
  assert.strictEqual(r.payload.byComponent.team.mappedEmpty, true,
    'the mapping state is no longer reported at all');
});

check('THE NOTE IS AN EDITABLE BOX, capped by the model that enforces it', async () => {
  const { html, payload } = await renderByComp();
  const body = byCompSection(html);
  assert.ok(/data-bc-note="PS_iGO_NLG"/.test(body), 'the note is not editable');
  assert.ok(/<textarea class="note"/.test(body), 'the note is not the control the other grid uses');
  const max = payload.byComponent.noteMax;
  assert.ok(max > 0, 'the payload does not carry the note cap');
  assert.ok(new RegExp(`maxlength="${max}"`).test(body),
    `the box offers a length other than the server's ${max}`);
  // The existing note is in the box AND in data-was, so a blur with nothing
  // typed can be told from a real edit.
  assert.ok(/data-was="waiting on the migration"/.test(body),
    'the box does not remember what it started as');
});

check('EDITING IT SAVES TO THE SAME NOTE THE OTHER SCREEN EDITS', async () => {
  /* One entry per component in the plan, one route. Not a second
     capacity-only note: "waiting on the migration" is a fact about the suite,
     not about this sprint, and two boxes holding two versions of it is how
     the one you are not looking at goes stale. */
  const r = await renderByComp();
  await r.mount.fire('focusout',
    { bcNote: 'PS_iGO_NLG', was: '' },
    { value: 'chasing the vendor', disabled: false });
  assert.strictEqual(r.puts.length, 1, 'the edit wrote nothing');
  assert.strictEqual(r.puts[0].method, 'PUT');
  assert.ok(r.puts[0].url.includes('/api/component-note'),
    `the note went somewhere else: ${r.puts[0].url}`);
  assert.deepStrictEqual(r.puts[0].body, { component: 'PS_iGO_NLG', note: 'chasing the vendor' });
});

check('A BLUR WITH NOTHING CHANGED IS NOT AN EDIT', async () => {
  /* Clicking into a box and out again writes an audit entry per glance if
     this is not checked. Whitespace-only differences do not count either. */
  const r = await renderByComp();
  await r.mount.fire('focusout',
    { bcNote: 'PS_RES_NLG', was: 'waiting on the migration' },
    { value: '  waiting on the migration  ', disabled: false });
  assert.strictEqual(r.puts.length, 0, 'an unchanged box still wrote to the server');
});

check('A REFUSED NOTE PUTS THE OLD TEXT BACK', async () => {
  /* A box that keeps what you typed after the server refused it reads as
     saved, and the next reader sees a note nobody stored. */
  const r = await renderCapacity(BC_SNAP, BC_PLAN, BC_SPRINT, { failSave: true });
  const box = { value: 'this will be refused', disabled: false };
  await r.mount.fire('focusout', { bcNote: 'PS_iGO_NLG', was: 'old text' }, box);
  assert.strictEqual(r.puts.length, 1, 'fixture check: it tried to save');
  assert.strictEqual(box.value, 'old text', 'the box kept text the server refused');
});

check('EXPORT CSV CARRIES THE SCOPES AND NOT THE LENSES', async () => {
  /* Team and sprint decide which epics were counted at all, so both travel.
     The family chip and the fold only hide rows, so the file carries the
     whole list and the reader filters in the spreadsheet — a CSV that is
     silently whichever twenty rows somebody was looking at is the trap every
     other export here avoids. */
  const r = await renderByComp();
  const sec = r.html.slice(r.html.indexOf('>By component<'));
  const href = (sec.match(/href="([^"]*what=bycomponent[^"]*)"/) || [])[1];
  assert.ok(href, 'there is no Export CSV link');
  assert.ok(/team=titan/.test(href), 'the file would not be scoped to this team');
  assert.ok(/sprint=S40/.test(href), 'the file would not be scoped to this sprint');
  assert.ok(!/family=/.test(href), 'the family chip leaked into the export');

  // And it stays put when a lens moves — the whole point of the split.
  await r.mount.click({ bcFamily: 'kat' });
  const after = r.html.slice(r.html.indexOf('>By component<'));
  assert.strictEqual((after.match(/href="([^"]*what=bycomponent[^"]*)"/) || [])[1], href,
    'filtering the table changed what the CSV would contain');
});

check('EXPORT PDF PRINTS THIS SECTION ALONE, under a name you can file', async () => {
  /* The Capacity screen is a KPI strip, a day grid, a roster and three
     tables. "Export PDF" on one of those tables cannot mean "print all of
     that", so the section is marked and the rest hidden for the duration —
     and both facts are read AT PRINT TIME, the only moment either matters. */
  const r = await renderByComp();
  await r.mount.click({ act: 'bc-export-pdf' });
  assert.strictEqual(r.printed.length, 1, 'the browser was never asked to print');
  const at = r.printed[0];
  assert.ok(at.body.includes('print-only-on'), 'the page was printed whole, not scoped to the section');
  assert.ok(at.section.includes('print-only'), 'the section was not marked, so it would be hidden too');

  assert.match(at.title, /Katalon Titan/, `the file would not say whose sheet it is: "${at.title}"`);
  assert.match(at.title, /Katalon Titan Sprint 40/, 'nor which sprint');
  assert.match(at.title, /by component/i, 'nor which table');
  assert.ok(!/[\\/:*?"<>|]/.test(at.title), 'a filename cannot carry path characters');
});

check('AND IT PUTS THE PAGE BACK AFTERWARDS', async () => {
  /* A failed restore leaves the user staring at a page with most of it
     missing and no way to guess why — the one failure of printing a single
     section that is worse than not offering it. */
  const r = await renderByComp();
  await r.mount.click({ act: 'bc-export-pdf' });
  assert.ok(r.mount.bodyClasses.includes('print-only-on') === false
    || r.printed.length === 1, 'fixture check: it printed');
  r.mount.afterprint();
  assert.deepStrictEqual(r.mount.bodyClasses, [], 'the body kept its print class');
  assert.deepStrictEqual(r.mount.sectionClasses, [], 'the section kept its print class');
});

/* ── CALC EXEMPT, ON THE CAPACITY GRID ────────────────────────────────
   On the roster, out of the capacity arithmetic. The model is checked in
   capacity.test.js and the round trip in sprint-api.test.js; here it is the
   screen — the control exists, the row is marked, the table still lines up,
   and the consequence is stated rather than left to be discovered. */

/** The member capacity table, cut out by its own header. */
const memberTable = (html) => {
  const at = html.indexOf('Calc exempt');
  assert.ok(at > 0, 'there is no Calc exempt column on the capacity grid');
  const start = html.lastIndexOf('<table', at);
  return html.slice(start, html.indexOf('</table>', start));
};

const EXEMPT_PLAN = { ...PLAN, calcExempt: { 'titan|S40|m2': true } };

check('EVERY MEMBER HAS A CALC-EXEMPT TOGGLE', async () => {
  const { html, payload } = await renderCapacity(SNAP, PLAN);
  const tbl = memberTable(html);
  assert.ok(payload.rows.length, 'the fixture needs members');
  for (const r of payload.rows) {
    assert.match(tbl, new RegExp(`data-exempt="${r.memberId}"`), `${r.name} has no toggle`);
  }
});

check('and an exempt member is TICKED and marked, not hidden', async () => {
  // They are on the sprint and may be carrying work. Hiding them would make
  // this the roster screen, and there is already one of those.
  const { html, payload } = await renderCapacity(SNAP, EXEMPT_PLAN);
  const tbl = memberTable(html);
  const ex = payload.rows.find(r => r.calcExempt);
  assert.ok(ex, 'the fixture did not produce an exempt member');
  assert.match(tbl, new RegExp(`data-exempt="${ex.memberId}"[^>]*checked`), 'the box is not ticked');
  assert.match(tbl, /<tr class="[^"]*exempt"/, 'the row is not marked');
  assert.match(tbl, new RegExp(ex.name), 'the exempt member vanished from the grid');
});

check('THE HOURS COME OUT OF THE TEAM TOTAL, and the screen says how many are exempt', async () => {
  const base = await renderCapacity(SNAP, PLAN);
  const { html, payload } = await renderCapacity(SNAP, EXEMPT_PLAN);
  assert.ok(payload.totals.capacityHours < base.payload.totals.capacityHours,
    'exempting somebody did not reduce the capacity');
  assert.strictEqual(payload.totals.exempt, 1);
  assert.match(memberTable(html), /1 exempt/, 'the total row does not explain its own headcount');
});

check('AND THE CONSEQUENCE IS STATED — committed work still counts', async () => {
  /* The surprising half. Their hours leave the capacity, their work does not
     leave the sprint, so the team can read as more loaded than its capacity
     covers. A reader who is not told that will file it as a bug. */
  const { html } = await renderCapacity(SNAP, EXEMPT_PLAN);
  assert.match(html, /exempt from this sprint's capacity/);
  assert.match(html, /still counted/);
});

check('and nothing is said when nobody is exempt', async () => {
  // A permanent paragraph explaining a feature nobody is using is noise.
  const { html } = await renderCapacity(SNAP, PLAN);
  assert.ok(!/exempt from this sprint's capacity/.test(html));
});

check('THE MEMBER TABLE STILL LINES UP, header, rows and footer', async () => {
  /* Adding a column is where a table quietly goes one cell out: the header
     grows, a row or the footer does not, and every number after it shifts one
     place left while rendering perfectly. */
  for (const [label, plan] of [['no exemptions', PLAN], ['one exempt', EXEMPT_PLAN]]) {
    const tbl = memberTable((await renderCapacity(SNAP, plan)).html);
    const cols = (tbl.match(/<th(?=[\s>])[^>]*>/g) || []).length;
    assert.ok(cols >= 11, `${label}: expected the full table, saw ${cols} columns`);
    const body = tbl.slice(tbl.indexOf('<tbody>'), tbl.indexOf('</tbody>'));
    const rows = body.split('<tr').slice(1);
    assert.ok(rows.length, `${label}: no rows`);
    for (const r of rows) {
      const cells = (r.match(/<td[^>]*>/g) || []).length;
      const span = [...r.matchAll(/colspan="(\d+)"/g)].reduce((t, m) => t + (Number(m[1]) - 1), 0);
      assert.strictEqual(cells + span, cols, `${label}: a row has ${cells + span} cells against ${cols} columns`);
    }
  }
});

check('EVERY ROW HAS AS MANY CELLS AS THE HEADER HAS COLUMNS', async () => {
  // The output-level version of the alignment rule epics.test.js asserts on the
  // source. A column added to the header and not the body shifts every value
  // one to the left and still renders without an error — on both screens now,
  // which is the cost of sharing the table and the reason to check the result
  // rather than the template.
  for (const [where, render] of [['Active sprint', renderHtml], ['Capacity planning', renderCapacity]]) {
    const body = itemsSection((await render()).html);
    // `<th[^>]*>` also matches `<thead>` — the tag name has to end at a space
    // or the closing bracket, or the header comes out one column too wide.
    const cols = (body.match(/<th(?=[\s>])[^>]*>/g) || []).length;
    assert.ok(cols >= 8, `${where}: expected the full item table, saw ${cols} columns`);
    const rows = trs(body);                            // past the header row
    assert.ok(rows.length, `${where}: no rows to check`);
    for (const r of rows) {
      assert.strictEqual((r.match(/<td[^>]*>/g) || []).length, cols,
        `${where}: a row has a different number of cells than the header has columns`);
    }
  }
});

/* ── per-component progress ───────────────────────────────────────────── */

/**
 * The `<tr>` fragments in a slice of markup, header row dropped.
 *
 * Split on the tag, not on `'<tr>'` verbatim: the item rows gained attributes
 * the day the table got filters, and three checks that had hard-coded the
 * whole opening tag came back with one fragment and reported "no rows to
 * check" — a count of nothing, asserted against successfully.
 */
const trs = (html, drop = 1) => html.split(/<tr(?=[\s>])/).slice(1 + drop);

/**
 * The whole `<tr>` an issue key sits in.
 *
 * Slicing from the key itself starts INSIDE the first cell, so the row comes
 * back one cell short and a count of its cells is quietly wrong.
 */
const rowFor = (html, key) => {
  const at = html.indexOf(`>${key}<`);
  if (at < 0) return '';
  const start = html.lastIndexOf('<tr', at);
  return html.slice(start, html.indexOf('</tr>', at));
};

/** Just the "Per-component progress" card. */
const componentSection = (html) => {
  const from = html.indexOf('Per-component progress');
  return from < 0 ? '' : html.slice(from, html.indexOf('</table>', from));
};

check('THE ACTIVE SPRINT SCREEN BREAKS PROGRESS DOWN BY COMPONENT', async () => {
  const { html, payload } = await renderHtml();
  const body = componentSection(html);
  assert.ok(body, 'the section is missing');
  for (const r of payload.byComponent.rows) {
    assert.ok(body.includes(r.component), `${r.component} has no row`);
  }
  const rows = trs(body);
  assert.strictEqual(rows.length, payload.byComponent.rows.length);
});

check('and it sits ABOVE the item table, where it was asked for', async () => {
  const { html } = await renderHtml();
  const comp = html.indexOf('Per-component progress');
  const items = html.indexOf('All sprint items');
  assert.ok(comp > 0 && items > 0, 'both sections must be on the page');
  assert.ok(comp < items, 'the breakdown reads before the list it summarises');
});

check('THE TOOL MARKER NEVER BECOMES A ROW', async () => {
  // "TrueTest" is on one of the fixture's items and on two thirds of his real
  // ones. It is where the suite runs, not an area of the product.
  const body = componentSection((await renderHtml()).html);
  assert.ok(body.includes('PS_iGO_NLG'), 'fixture check: the real component is there');
  assert.ok(!body.includes('TrueTest'), 'the automation tool was listed as a product component');
});

check('the numbers on the page are the numbers from the model', async () => {
  const { html, payload } = await renderHtml();
  const body = componentSection(html);
  const nlg = payload.byComponent.rows.find(r => r.component === 'PS_iGO_NLG');
  const row = body.slice(body.indexOf('PS_iGO_NLG'));
  /* READ THROUGH WHATEVER THE CELL HOLDS. These three are drill-in buttons now,
     and a pattern that insisted on a bare number would fail for the one reason
     that is not a defect — while still passing if a button ever rendered the
     WRONG number, which is the thing this check is actually for. */
  const cells = [...row.matchAll(/<td class="num">(.*?)<\/td>/g)]
    .map(m => Number(m[1].replace(/<[^>]*>/g, '').trim()));
  assert.deepStrictEqual(cells.slice(0, 3), [nlg.count, nlg.points, nlg.done],
    'items, committed and done, in that order');
});

check('AND EACH OF THEM OPENS THE SET BEHIND IT', async () => {
  /* Every other number on this screen opens what it counted; these three sat
     as dead text in the middle of a table where the component name beside them
     was already a link out to Jira.

     `src` IS THE PART THAT MATTERS. Two tables on this screen are keyed by
     component name — this one and Test cases by component — so without it the
     handler would resolve a component's Items against the OTHER table's key
     lists: a real list of the wrong population, under the right heading. */
  const { html, payload } = await renderHtml();
  const body = componentSection(html);
  const row = body.slice(body.indexOf('PS_iGO_NLG'), body.indexOf('</tr>', body.indexOf('PS_iGO_NLG')));
  const nlg = payload.byComponent.rows.find(r => r.component === 'PS_iGO_NLG');

  for (const col of ['items', 'committed', 'done']) {
    const btn = row.match(new RegExp(`<button[^>]*data-col="${col}"[^>]*>`));
    assert.ok(btn, `the ${col} number is not clickable`);
    assert.match(btn[0], /data-act="drill"/, `${col} is a button that opens nothing`);
    assert.match(btn[0], /data-src="progress"/,
      `${col} does not say which table it came from, so it would open the Test cases keys`);
    assert.ok(btn[0].includes(`data-scope="PS_iGO_NLG"`), `${col} opens a different component`);
  }

  /* AND POINTS STAY POINTS. `drillNumber` printed whole numbers until now, so
     a half-point column would have changed value on becoming clickable — 12.5
     rendering as 13 in a table that says 12.5 on the row below. Compared as
     numbers against the model, which catches the rounding whatever the
     separator formatting does. */
  const shown = (col) => {
    const m = row.match(new RegExp(`<button[^>]*data-col="${col}"[^>]*>([^<]*)</button>`));
    return m ? Number(m[1].replace(/[^\d.-]/g, '')) : null;
  };
  assert.strictEqual(shown('items'), nlg.count, 'the items button shows a different number from the model');
  assert.strictEqual(shown('committed'), nlg.points, 'committed was rounded on becoming clickable');
  assert.strictEqual(shown('done'), nlg.done, 'done was rounded on becoming clickable');
});

check('AND THE DRAWER LISTS WHAT THAT NUMBER COUNTED', async () => {
  /* The whole point of a drill-in: the list has to be the number's own set,
     not a second count that can disagree with it. Driven through the real
     click handler and the real model payload. */
  const r = await renderHtml();
  const nlg = r.payload.byComponent.rows.find(x => x.component === 'PS_iGO_NLG');

  r.mount.click('drill', { src: 'progress', scope: 'PS_iGO_NLG', col: 'items' });
  let d = r.drawn;
  assert.ok(d, 'clicking Items opened no drawer');
  assert.ok(d.includes('PS_iGO_NLG'), 'the drawer does not name the component');
  for (const k of nlg.keys) assert.ok(d.includes(k), `Items does not list ${k}, which the row counted`);

  /* COMMITTED IS POINTS AND ITS SET IS THE ITEMS — the same rule the sprint
     KPI already follows, so the drawer adds the points up again from the same
     list rather than being told a total. */
  r.mount.click('drill', { src: 'progress', scope: 'PS_iGO_NLG', col: 'committed' });
  d = r.drawn;
  for (const k of nlg.keys) assert.ok(d.includes(k), `Committed does not list ${k}`);
  assert.match(d, /not their count/, 'the drawer does not explain that the row showed points');

  /* DONE IS THE FINISHED SUBSET, from the model's own `doneKeys`. */
  r.mount.click('drill', { src: 'progress', scope: 'PS_iGO_NLG', col: 'done' });
  d = r.drawn;
  assert.ok(Array.isArray(nlg.doneKeys), 'the model sends no doneKeys, so Done cannot list anything');
  assert.ok(nlg.doneKeys.length, 'fixture check: PS_iGO_NLG has finished work');
  assert.ok(nlg.doneKeys.length < nlg.keys.length,
    'fixture check: not everything is done, or this check cannot tell the two lists apart');
  for (const k of nlg.doneKeys) assert.ok(d.includes(k), `Done does not list ${k}`);
  for (const k of nlg.keys.filter(x => !nlg.doneKeys.includes(x))) {
    assert.ok(!d.includes(k), `Done lists ${k}, which is not finished`);
  }
});

check('AND IT DOES NOT OPEN THE OTHER TABLE\'S KEYS BY MISTAKE', async () => {
  /* The failure `src` exists to prevent, made concrete. Both tables key their
     numbers by component name, so a click that did not say which table it came
     from would resolve against Test cases by component — producing a real
     list, under the right heading, of a different population. Nothing on
     screen would look wrong. */
  const r = await renderHtml();
  const nlg = r.payload.byComponent.rows.find(x => x.component === 'PS_iGO_NLG');
  const tc = ((r.payload.testCases || {}).rows || []).find(x => x.component === 'PS_iGO_NLG');
  assert.ok(tc && tc.keys, 'fixture check: the Test cases table also has a PS_iGO_NLG row');

  r.mount.click('drill', { src: 'progress', scope: 'PS_iGO_NLG', col: 'items' });
  const progress = r.drawn;
  r.mount.click('drill', { scope: 'PS_iGO_NLG', col: 'automated' });
  const testCases = r.drawn;
  assert.notStrictEqual(progress, testCases,
    'the two tables opened the same drawer, so the component name alone decided the set');
  for (const k of nlg.keys) assert.ok(progress.includes(k), `the progress drawer lost ${k}`);
});

check('AND A HALF POINT IS STILL A HALF POINT ONCE IT IS CLICKABLE', async () => {
  /* `drillNumber` printed whole numbers for every caller before this one,
     because every caller opened a COUNT. Committed and Done are points, and a
     cell that reads 12.5 in one column and 13 in the next — for the same work,
     because one became a button — is a table nobody should trust.

     ITS OWN FIXTURE, because the shared one estimates in whole points: a
     rounding check over whole numbers passes against the rounding. */
  const half = {
    ...SNAP,
    issues: Object.fromEntries(Object.entries(SNAP.issues).map(([k, v]) => [
      k, k === 'A-2' ? { ...v, points: 2.5 } : v,
    ])),
  };
  const r = await renderHtml(half);
  const nlg = r.payload.byComponent.rows.find(x => x.component === 'PS_iGO_NLG');
  assert.ok(String(nlg.points).includes('.'),
    `fixture check: PS_iGO_NLG totals ${nlg.points} — a whole number cannot show rounding`);

  const body = componentSection(r.html);
  const row = body.slice(body.indexOf('PS_iGO_NLG'), body.indexOf('</tr>', body.indexOf('PS_iGO_NLG')));
  const shown = row.match(/<button[^>]*data-col="committed"[^>]*>([^<]*)<\/button>/);
  assert.ok(shown, 'the committed number is not clickable');
  assert.strictEqual(Number(shown[1].replace(/[^\d.-]/g, '')), nlg.points,
    `the button shows ${shown[1].trim()} where the model says ${nlg.points}`);
});

check('AND A NUMBER ONLY OFFERS TO OPEN WHAT IT CAN', async () => {
  /* `doneKeys` is new in the model, so a browser holding this page against a
     server that has not restarted yet gets a Done column with no set behind
     it. A button there would open an empty drawer under a number saying 24 —
     which reads as "nothing finished", not as "this server is behind". It
     stays plain text until the keys are there.

     Items and Committed both ride `keys`, which every version of the payload
     sends, so they keep working across the gap. */
  const r = await renderHtml(SNAP, PLAN, {
    payload: (p) => ({
      ...p,
      byComponent: {
        ...p.byComponent,
        rows: p.byComponent.rows.map(({ doneKeys, ...rest }) => rest),
      },
    }),
  });
  const body = componentSection(r.html);
  const row = body.slice(body.indexOf('PS_iGO_NLG'), body.indexOf('</tr>', body.indexOf('PS_iGO_NLG')));
  assert.ok(!/data-col="done"/.test(row),
    'Done is clickable against a payload that carries no keys for it, so it opens an empty drawer');
  assert.match(row, /data-col="items"/, 'Items stopped opening, and it did not need doneKeys');
  assert.match(row, /data-col="committed"/, 'Committed stopped opening, and it did not need doneKeys');
  /* AND THE NUMBER IS STILL THERE. Degrading must not blank the cell. */
  const nlg = r.payload.byComponent.rows.find(x => x.component === 'PS_iGO_NLG');
  assert.ok(row.includes(String(nlg.done)), `the done figure vanished with its button: ${row}`);
});

check('a component behind the sprint is marked', async () => {
  // Six of ten working days gone. KAT_Common has delivered nothing, so it is
  // behind; PS_iGO_NLG is at 15 of 20 and is not.
  const body = componentSection((await renderHtml()).html);
  const kat = body.slice(body.indexOf('KAT_Common'));
  assert.ok(kat.includes('behind the sprint'), 'a component with nothing delivered on day six is behind');
  const nlg = body.slice(body.indexOf('PS_iGO_NLG'), body.indexOf('KAT_Common'));
  assert.ok(!nlg.includes('behind the sprint'), 'and one that is keeping up is not');
});

check('a sprint with no components at all renders no empty section', async () => {
  const bare = {
    ...SNAP,
    issues: Object.fromEntries(Object.entries(SNAP.issues).map(([k, v]) => [k, { ...v, components: [] }])),
  };
  const { html } = await renderHtml(bare);
  // One row — "no component" — is still a real answer, so the section stays.
  // What must not happen is a section with no rows under it.
  const body = componentSection(html);
  if (body) assert.ok(trs(body).length >= 1, 'a section with a header and nothing in it');
});

/* ── test cases under maintenance ─────────────────────────────────────── */

check('THE ITEM TABLE COUNTS TEST CASES UNDER MAINTENANCE', async () => {
  const { html, payload } = await renderHtml();
  const body = itemsSection(html);
  assert.ok(body.includes('Test cases'), 'no column for it');
  const a20 = payload.items.find(i => i.key === 'A-20');
  assert.strictEqual(a20.maintains, 3, 'fixture check: three relates-to links');
  // Read the LAST cell of the row, not just any cell holding a 3: this item is
  // also worth 3 points, so a looser match passed happily with the column
  // deleted altogether.
  const row = rowFor(body, 'A-20');
  const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].trim());
  /* Counted off the HEADER rather than typed. A literal here has to be edited
     every time the table gains a column, for a reason that has nothing to do
     with what this check is about — and it broke twice for exactly that. What
     it actually guards is "the LAST cell is the test-case count", which the
     header count gives it for free. */
  const cols = (body.match(/<th(?=[\s>])[^>]*>/g) || []).length;
  assert.strictEqual(cells.length, cols, `the row has ${cells.length} cells and the header ${cols} columns`);
  /* The number is a control now, so the cell is a button wrapping it. Read
     from the LAST cell — `cells[cols - 1]`, not `cells[8]`: the index was
     typed, and inserting a Due column ahead of it silently moved this
     assertion onto the Epic cell, where it failed for a reason that had
     nothing to do with test cases. The point was always "the last column",
     because this row is also worth 3 points and a looser match was once green
     with the column deleted altogether. */
  const last = cells[cols - 1];
  assert.match(last, />3<\/button>/, `the test-case cell reads "${last}"`);
  assert.match(last, /data-act="item-testcases"[^>]*data-key="A-20"/,
    'the number does not open the suites it counted');
});

check('a bucket story maintaining nothing says zero, and says it loudly', async () => {
  // The zero is the answer here, and usually the one worth acting on: a
  // maintenance container with no links to what it maintains.
  const body = itemsSection((await renderHtml()).html);
  const row = rowFor(body, 'A-21');
  assert.ok(row.includes('>0<'), 'no count on an empty bucket story');
  assert.ok(row.includes('tag warn'), 'and nothing draws the eye to it');
});

/* ── THE DRAWER BEHIND THE TEST-CASE NUMBER ───────────────────────────── */

check('THE DRAWER LISTS EXACTLY WHAT THE NUMBER COUNTED', async () => {
  /* The property every drill-in on this screen is built around: a list
     assembled by different code from the figure above it is a list that can
     disagree with it, and both render perfectly. */
  const { payload, ctx, mount } = await renderHtml();
  let drawn = '';
  ctx.UI.drawer = (h) => { drawn = h; };
  const a20 = payload.items.find(i => i.key === 'A-20');
  assert.strictEqual(a20.maintains, 3, 'fixture check');

  mount.click('item-testcases', { key: 'A-20' });
  assert.match(drawn, /Maintained by A-20/, 'the drawer does not name the bucket story');
  const rows = (drawn.match(/border-bottom:1px solid var\(--app-line-soft\)/g) || []).length;
  assert.strictEqual(rows, a20.maintains,
    `the number says ${a20.maintains}, the drawer shows ${rows}`);
  for (const k of ['AUTOKAT-1', 'AUTOKAT-2', 'AUTOKAT-3']) assert.match(drawn, new RegExp(k));
});

check('and the set it lists is the SAME set the count was the size of', async () => {
  /* Pinned on the payload rather than on the markup: `maintains` is the length
     of `maintainsLinks`, so a drawer reading the links and a cell reading the
     count cannot drift. Duplicated links — Jira holds them from both sides —
     are one suite in both. */
  const { payload } = await renderHtml();
  for (const i of payload.items.filter(x => x.bucket)) {
    assert.strictEqual(i.maintains, (i.maintainsLinks || []).length,
      `${i.key}: count ${i.maintains}, set ${(i.maintainsLinks || []).length}`);
    const keys = (i.maintainsLinks || []).map(l => l.key);
    assert.strictEqual(new Set(keys).size, keys.length, `${i.key}: the set holds a key twice`);
  }
});

/* Two bucket stories that BOTH have links, so "opened the wrong row" is
   visible. With only one clickable row in the grid, a handler that ignores the
   key it was given and picks the first bucket story it finds is right by
   accident. */
const TWO_BUCKETS = {
  ...SNAP,
  issues: Object.fromEntries([
    ...Object.values(SNAP.issues),
    issue({ key: 'A-22', assignee: 'Hien Phan', points: 2, type: 'Bucket Story',
      relatesTo: [{ key: 'SHRTEC-7' }, { key: 'SHRTEC-8' }] }),
  ].map(i => [i.key, i])),
};

check('THE DRAWER OPENS THE ROW THAT WAS CLICKED, not the first one like it', async () => {
  const { payload, ctx, mount } = await renderHtml(TWO_BUCKETS);
  let drawn = '';
  ctx.UI.drawer = (h) => { drawn = h; };
  const a22 = payload.items.find(i => i.key === 'A-22');
  assert.strictEqual(a22.maintains, 2, 'fixture check: A-22 maintains a different set');

  mount.click('item-testcases', { key: 'A-22' });
  assert.match(drawn, /Maintained by A-22/, `opened the wrong row: ${drawn.slice(0, 120)}`);
  assert.match(drawn, /SHRTEC-7/);
  assert.ok(!/AUTOKAT-1</.test(drawn), 'it listed the other bucket story\'s suites');
});

check('A ZERO IS NOT A BUTTON — nothing behind it, nothing to press', async () => {
  const body = itemsSection((await renderHtml()).html);
  const row = rowFor(body, 'A-21');
  assert.ok(!/data-act="item-testcases"/.test(row),
    'an empty bucket story offered a control that opens nothing');
});

check('and a link the tool never synced is still listed, with what the link knows', async () => {
  /* A maintained suite usually lives outside the three datasets this tool
     pulls, so the summary Jira put inside the link is the only description of
     it that will ever exist locally. Dropping those rows would make the list
     shorter than the number that opened it. */
  const { payload, ctx } = await renderHtml();
  const item = {
    key: 'B-9', bucket: true, maintains: 2,
    maintainsLinks: [
      { key: 'SHRTEC-8295', summary: 'iGO smoke pack', type: 'Epic' },
      { key: 'GHOST-1', summary: null, type: null },
    ],
  };
  const html = ctx.UI.testCasesDrawer(item, payload.items, {}, {});
  assert.match(html, /iGO smoke pack/, 'the summary the link carried was dropped');
  assert.match(html, /GHOST-1/, 'a link with nothing known was dropped entirely');
  assert.match(html, /Not in the local store/, 'and the one with nothing known has to say so');
  assert.match(html, />Open in Jira</, 'which makes the way out to Jira the point of the panel');
});

check('ANYTHING THAT IS NOT A BUCKET STORY IS NOT ASKED', async () => {
  // A Story's relates-to links are not test cases, and a column of zeroes
  // against them invites someone to total it.
  const { html, payload } = await renderHtml();
  const body = itemsSection(html);
  const story = payload.items.find(i => i.key === 'A-1');
  assert.strictEqual(story.maintains, null, 'the model must not put a number on a Story');
  const cells = [...rowFor(body, 'A-1').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].trim());
  assert.ok(cells[8] && cells[8].includes('—'), `the cell should be blank, not "${cells[8]}"`);
});

check('and the caption totals the sprint\'s maintenance load', async () => {
  const { html } = await renderHtml();
  assert.match(html, /3 test cases maintained across 2 bucket stories/);
});

check('a sprint with no bucket stories says nothing about test cases', async () => {
  const none = {
    ...SNAP,
    issues: Object.fromEntries(Object.entries(SNAP.issues).filter(([k]) => !['A-20', 'A-21'].includes(k))),
  };
  const { html } = await renderHtml(none);
  assert.ok(!/test cases maintained/.test(html), 'no zero-count noise on a sprint with no maintenance');
});

/* ── the KPI row ──────────────────────────────────────────────────────── */

/** The KPI strip, label and value, in the order they appear. */
const kpis = (html) => [...html.matchAll(/<div class="label">([^<]*)<\/div>\s*<div class="value[^"]*">([^<]*)/g)]
  .map(m => [m[1].trim(), m[2].trim()]);

/**
 * The KPI row.
 *
 * Matched on the class TOKEN, not on `class="kpis"` verbatim — the strip
 * gained a second class the day its cards got their own hues, and three
 * checks that had hard-coded the whole attribute went looking for a row that
 * no longer existed. Two of them then reported "the KPI row did not render",
 * which was true of the string and false of the page.
 */
const kpiStrip = (html) => {
  const at = html.search(/<div class="kpis[\s"]/);
  assert.ok(at >= 0, 'the KPI row did not render');
  return html.slice(at, html.indexOf('</section>', at));
};

check('CAPACITY LEADS THE KPI ROW, immediately before Committed', async () => {
  const { html } = await renderHtml();
  const labels = kpis(html).map(([l]) => l);
  const at = labels.indexOf('Capacity');
  assert.ok(at >= 0, `no Capacity KPI — got ${JSON.stringify(labels)}`);
  assert.strictEqual(labels[at + 1], 'Committed', 'Capacity has to read directly into what was committed against it');
});

check('and it shows the capacity the grid computed', async () => {
  const { html, payload } = await renderHtml();
  const cap = kpis(html).find(([l]) => l === 'Capacity');
  assert.strictEqual(cap[1], String(Math.round(payload.totals.predicted)));
});

check('THE HEADROOM IS MEASURED AGAINST THIS SCREEN\'S OWN COMMITMENT', async () => {
  // The grid's `totals.planned` counts only work on roster members; this
  // screen's commitment also counts work that landed on nobody. Printing the
  // grid's own over/under beside them would be a number that does not
  // reconcile with the two cards either side of it.
  const { html, payload } = await renderHtml(OFF_ROSTER, OFF_ROSTER_PLAN);
  const gap = Math.round((payload.totals.predicted - payload.progress.committed) * 10) / 10;
  assert.notStrictEqual(payload.totals.planned, payload.progress.committed,
    'fixture check: this sprint has work outside the roster, or the check proves nothing');
  const strip = kpiStrip(html);
  assert.ok(strip.includes(`${gap} pts of headroom`) || strip.includes(`${Math.abs(gap)} pts over capacity`),
    `the headroom does not match capacity minus commitment (${gap})`);
});

check('a sprint with no capacity says so rather than claiming zero headroom', async () => {
  // Everyone off for the whole sprint, so the grid really does compute zero —
  // an EMPTY availability map would not do it, because a missing row falls back
  // to a full working fortnight and the check would pass without asserting
  // anything. It did, until a mutation that deleted the guard stayed green.
  const off = new Array(14).fill('0');
  const noCapacity = { ...PLAN, availability: { 'titan|S40|m1': off, 'titan|S40|m2': off } };
  const { html, payload } = await renderHtml(SNAP, noCapacity);
  assert.strictEqual(payload.totals.predicted, 0, 'fixture check: this sprint has to have no capacity');
  assert.ok(html.includes('no capacity entered'), 'zero capacity must not read as zero headroom');
  assert.ok(!html.includes('pts of headroom'), 'and must not claim headroom it does not have');
});

/* ── export to PDF ────────────────────────────────────────────────────── */

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const printRules = css.slice(css.indexOf('@media print'));

check('THE SCREEN OFFERS AN EXPORT, and the export is a print', async () => {
  const { html } = await renderHtml();
  assert.ok(html.includes('data-act="export-pdf"'), 'no Export PDF control');
  assert.ok(html.includes('Export PDF'), 'the control is not labelled');
});

check('CLICKING IT PRINTS', async () => {
  const { mount, printed } = await renderHtml();
  mount.click('export-pdf');
  assert.strictEqual(printed.length, 1, 'the browser was never asked to print');
});

check('and the file is named after the sprint, not after the app', async () => {
  // The browser names the download from the document title. Left alone, every
  // sprint report in a folder is called "Planning Tool.pdf".
  const { mount, printed, ctx } = await renderHtml();
  mount.click('export-pdf');
  assert.match(printed[0], /Katalon Auto Titan/, `title at print time was "${printed[0]}"`);
  assert.match(printed[0], /Sprint 40/);
  assert.ok(!/[\\/:*?"<>|]/.test(printed[0]), 'a filename cannot carry path characters');
  ctx.window._on.afterprint();
  assert.strictEqual(ctx.document.title, 'Planning Tool', 'the title has to go back afterwards');
});

check('THE PDF SAYS WHICH TEAM, WHICH SPRINT AND WHEN', async () => {
  // All three are in the furniture on screen — sidebar, topbar, sync line —
  // and print hides every bit of it.
  const { html } = await renderHtml();
  const head = html.slice(html.indexOf('print-only'), html.indexOf('</div>', html.indexOf('print-only')) + 400);
  assert.match(head, /Katalon Auto Titan/, 'the team is not on the page');
  assert.match(head, /Sprint 40/, 'the sprint is not on the page');
  assert.match(head, /synced/, 'nothing says how fresh the Jira data is');
  assert.match(head, /report taken/, 'nothing dates the report itself');
});

check('the title block is print-only, and the button is screen-only', async () => {
  const { html } = await renderHtml();
  assert.match(css, /^\.print-only \{ display: none; \}/m, 'the title block would show on screen');
  assert.match(printRules, /\.print-only \{ display: block !important/, 'and never show in print');
  assert.ok(html.includes('class="section print-hide"'), 'the export button prints as a dead control');
  assert.match(printRules, /\.print-hide \{ display: none !important/);
});

/* ── what print has to undo ───────────────────────────────────────────── */

check('PRINT HIDES THE FURNITURE nobody can click on paper', async () => {
  for (const sel of ['.sidebar', '.topbar', '.drawer', '.toast', '.btn']) {
    assert.ok(printRules.includes(sel), `${sel} would print`);
  }
});

check('A SCROLL CONTAINER MUST NOT CLIP THE WIDEST TABLE', async () => {
  // `.table-wrap` scrolls sideways on screen. On paper there is nowhere to
  // scroll to, so whatever is past the page edge is simply gone.
  assert.match(printRules, /\.table-wrap[^{]*\{[^}]*overflow: visible !important/);
});

check('a long table repeats its header on every page', async () => {
  assert.match(printRules, /thead \{ display: table-header-group/);
});

check('THE DARK THEME PRINTS AS INK ON PAPER', async () => {
  // Without this the report is a black page — expensive, and unreadable once
  // the printer gives up on the backgrounds.
  const dark = printRules.slice(printRules.indexOf(':root[data-theme="dark"]'));
  assert.ok(printRules.includes(':root[data-theme="dark"]'), 'the dark theme is never restored');
  assert.match(dark.slice(0, 400), /--app-bg: #FFFFFF/i, 'the page background is still dark');
  assert.match(dark.slice(0, 400), /--app-fg: #10112A/i, 'the text is still light-on-dark');
});

check('and the backgrounds that carry meaning survive', async () => {
  // A red workload cell, a category dot, the bars: most browsers drop
  // backgrounds when printing unless told otherwise, and the report loses the
  // signal while keeping the numbers.
  assert.match(printRules, /print-color-adjust: exact/);
});

check('THE WIDE TABLE IS LAID OUT TO THE PAGE, not merely un-scrolled', async () => {
  // Letting the wrapper overflow stops the container clipping and does nothing
  // about the table being wider than A4: the item table first printed with
  // Component truncated mid-word and Epic missing altogether, on a page that
  // still looked complete.
  assert.match(printRules, /\.items-table \{ table-layout: fixed/, 'the columns are not sized for paper');
  /* EVERY COLUMN THE TABLE RENDERS NEEDS A WIDTH, and the count comes from the
     table rather than from a number typed here: with `table-layout: fixed` a
     column with no width is given whatever is left, which on a ten-column
     table is a Due date squeezed to two characters. Deriving it means a new
     column fails this check until it is sized. */
  const { html: rendered } = await renderHtml();
  const cols = (itemsSection(rendered).match(/<th(?=[\s>])[^>]*>/g) || []).length;
  const widths = [...printRules.matchAll(/\.items-table \.col-[a-z]+ \{ width: (\d+)%/g)].map(m => Number(m[1]));
  assert.strictEqual(widths.length, cols, `the table renders ${cols} columns and ${widths.length} have a print width`);
  assert.strictEqual(widths.reduce((a, b) => a + b, 0), 100,
    `the column widths add up to ${widths.reduce((a, b) => a + b, 0)}%, so the table cannot fit the page`);
});

check('and the table it sizes is the one the views render', async () => {
  // The print rules key off `.items-table` and the column classes. If the
  // shared table stopped emitting them the rules would silently do nothing.
  const { html } = await renderHtml();
  assert.ok(html.includes('class="items-table"'), 'the shared item table lost its class');
  for (const c of ['col-key', 'col-summary', 'col-category', 'col-assignee',
    'col-status', 'col-points', 'col-component', 'col-epic', 'col-tests']) {
    assert.ok(html.includes(c), `no ${c} column class — the print width for it is dead`);
  }
});

check('AN ISSUE KEY IS NEVER BROKEN ACROSS LINES', async () => {
  // It is the one string on the page someone retypes into Jira, and the same
  // wrapping that makes long component names fit would split it in half.
  assert.match(printRules, /\.issue-key[^{]*\{[^}]*white-space: nowrap/);
});

check('a card is not split across a page break', async () => {
  assert.match(printRules, /break-inside: avoid/);
  assert.match(printRules, /break-after: avoid/, 'a heading must not be orphaned from its table');
});

/* ── PRIORITY ON "TEST CASES BY COMPONENT" ────────────────────────────
   His judgement of which suites matter, on the sprint's own component table.
   Set on the Coverage grid, shown here — one owner, three readers. */

/** The "Test cases by component" section, cut out by its heading. */
const testCaseSection = (html) => {
  const at = html.indexOf('<h2>Test cases by component</h2>');
  assert.ok(at > 0, 'the test-case section is not on the page');
  return html.slice(html.lastIndexOf('<section', at), html.indexOf('</section>', at));
};

/** A plan where two of the fixture's components carry a priority and one does not. */
const PRIORITISED = { ...PLAN, componentPriority: { PS_iGO_NLG: 1, KAT_Common: 4 } };

check('PER-COMPONENT PROGRESS IS ORDERED P1 → P4, then the unjudged', async () => {
  /* The third table on this page to rank this way, and the reason all three
     take it from one helper: he reads the screen top-down by his own priority,
     and a page where one table disagrees is a page he has to re-find his place
     in twice. */
  const { html, payload } = await renderHtml(SNAP, PRIORITISED);
  const body = componentSection(html);
  const order = payload.byComponent.rows.map(r => r.component);
  const seen = order.filter(c => body.includes(c));
  assert.ok(seen.length >= 3, `only ${seen.length} components on the table — this proves little`);

  const key = payload.byComponent.rows.map(r => priority.sortKey(r.priority));
  assert.deepStrictEqual(key, key.slice().sort((a, b) => a - b),
    `the rows are not in priority order: ${payload.byComponent.rows.map(r => `${r.priorityLabel || '—'} ${r.component}`).join(' → ')}`);

  /* AND THE PAGE FOLLOWS THE PAYLOAD, rather than re-sorting on its own. */
  const positions = seen.map(c => body.indexOf(c));
  assert.deepStrictEqual(positions, positions.slice().sort((a, b) => a - b),
    'the table drew the rows in a different order from the payload');
});

check('AND THE UNJUDGED GO LAST even when they carry the most points', async () => {
  /* The old order was biggest-commitment-first. If the new sort were dropped,
     the heaviest component would lead — and in this fixture that is one nobody
     has prioritised, which is exactly the row he wants at the bottom. */
  /* ITS OWN PLAN: the shared one prioritises the heaviest component, so the
     old order and the new one would agree and this would prove nothing.
     Here only the LIGHT component is judged, which puts the two orders in
     direct conflict. */
  const plan = { ...PLAN, componentPriority: { KAT_Common: 2 } };
  const { payload } = await renderHtml(SNAP, plan);
  const rows = payload.byComponent.rows;
  const heaviest = rows.slice().sort((a, b) => b.points - a.points)[0];
  assert.strictEqual(heaviest.priority, null,
    `fixture check: the heaviest component (${heaviest.component}) must be unjudged or this proves nothing`);
  assert.strictEqual(rows[rows.length - 1].priority, null,
    `an unjudged component is not last: ${rows.map(r => r.priorityLabel || '—').join(' ')}`);
  assert.notStrictEqual(rows[0].component, heaviest.component,
    'the heaviest component still leads, so the priority sort is not being applied');
});

check('AND BIGGEST-COMMITMENT-FIRST SURVIVES INSIDE ONE PRIORITY', async () => {
  /* The sort is on the level alone and is stable, so the model's own order is
     the tie-break. Both components here are P1 and the heavier one must lead. */
  const plan = { ...PLAN, componentPriority: { PS_iGO_NLG: 1, KAT_Common: 1 } };
  const { payload } = await renderHtml(SNAP, plan);
  const p1 = payload.byComponent.rows.filter(r => r.priority === 1);
  assert.ok(p1.length >= 2, `only ${p1.length} P1 rows — no tie to break`);
  assert.ok(p1[0].points >= p1[1].points,
    `two P1 components lost the biggest-first tie-break: ${p1.map(r => `${r.component} ${r.points}`).join(', ')}`);
});

check('THE TEST-CASE TABLE SHOWS EACH COMPONENT\'S PRIORITY', async () => {
  const { html, payload } = await renderHtml(SNAP, PRIORITISED);
  const sec = testCaseSection(html);
  assert.match(sec, /<th[^>]*>Priority<\/th>/, 'no Priority column');

  const rows = payload.testCases.rows;
  assert.ok(rows.length, 'the fixture needs test-case rows');
  const set = rows.filter(r => r.priority != null);
  assert.ok(set.length >= 2, `only ${set.length} rows carry a priority — the fixture proves nothing`);
  for (const r of set) {
    assert.match(sec, new RegExp(`prio-p${r.priority}"[^>]*>P${r.priority}<`),
      `${r.component} is P${r.priority} and the table does not say so`);
  }
});

check('and a component nobody has judged shows a dash, not P4', async () => {
  /* Unset is a real state. Rendering it as the bottom of the scale claims a
     judgement nobody made — the rule `priority.js` is built around. */
  const { html, payload } = await renderHtml(SNAP, PRIORITISED);
  const unset = payload.testCases.rows.filter(r => r.priority == null);
  assert.ok(unset.length, 'the fixture needs a component with no priority set');
  const sec = testCaseSection(html);
  // As many dashes as there are unjudged rows, and no P-tag for them.
  const tags = (sec.match(/class="tag prio-tag/g) || []).length;
  assert.strictEqual(tags, payload.testCases.rows.length - unset.length,
    'a row with no priority is wearing a tag');
});

check('and it sorts unset LAST, in both directions', async () => {
  // `data-sort-value="—"` is what `SORT_BLANK` pins to the bottom whichever
  // way the column points. A numeric 99 would float every unjudged row above
  // the P1s on a descending sort — the bug the Coverage grid already had.
  const { html, payload } = await renderHtml(SNAP, PRIORITISED);
  const sec = testCaseSection(html);
  const unset = payload.testCases.rows.filter(r => r.priority == null).length;
  assert.strictEqual((sec.match(/data-sort-value="—"/g) || []).length, unset);
  for (const r of payload.testCases.rows.filter(x => x.priority != null)) {
    assert.match(sec, new RegExp(`data-sort-value="${r.priority}"`));
  }
});

check('THE COLUMN IS READ-ONLY — the Coverage grid owns the value', async () => {
  // Two editors for one field is two places for it to drift. This shows it.
  const sec = testCaseSection((await renderHtml(SNAP, PRIORITISED)).html);
  assert.ok(!/<select/.test(sec), 'a dropdown here is a second owner of the same judgement');
  assert.ok(!/data-prio|data-set-priority/.test(sec), 'and no write handler');
});

check('THE SECTION OFFERS AN EXPORT, pointed at this team and this sprint', async () => {
  /* The link carries the ids because the route needs them, and a link built
     from the wrong ones downloads another team's sprint without complaining —
     the numbers are all plausible and nothing on the file says whose it is. */
  const sec = testCaseSection((await renderHtml()).html);
  const href = /href="(\/api\/export[^"]*)"/.exec(sec);
  assert.ok(href, 'no export link on the test-case section');
  assert.match(href[1], /what=testcases/);
  assert.match(href[1], /team=titan/, 'the link does not name the team on screen');
  assert.match(href[1], /sprint=S40/, 'nor the sprint');
  assert.match(sec.slice(sec.indexOf('/api/export')), /^[^<]*/, 'the link must be a real anchor');
  assert.ok(/class="btn ghost sm print-hide"/.test(sec), 'a download button does not belong on paper');
});

check('THE TABLE IS TEST CASES ONLY — the item counts are gone', async () => {
  /* Stories, Bucket stories, Items and Done were sprint-item counts sitting in
     a table about test cases, and they pushed the columns that answer the
     question off the right-hand edge. The model still carries them — other
     readers use the same payload — so this is a check on the SCREEN, and the
     payload assertion underneath it is what stops the columns being deleted
     from the model by way of "cleaning up". */
  const { html, payload } = await renderHtml(SNAP, PRIORITISED);
  const sec = testCaseSection(html);
  // `<th(?=[\s>])` and not `<th`, or `<thead>` is read as a column with an
  // empty label — the same guard the parity check below uses.
  const heads = [...sec.matchAll(/<th(?=[\s>])[^>]*>([^<]*)</g)].map(m => m[1].trim());
  assert.deepStrictEqual(heads,
    ['Component', 'Priority', 'Automated', 'In flight', 'Maintained', 'Maintaining', 'Blocked'],
    `the columns are not the ones asked for: ${heads.join(' | ')}`);

  const row = payload.testCases.rows[0];
  for (const k of ['stories', 'buckets', 'items', 'done']) {
    assert.ok(k in row, `${k} was removed from the model, not just from the table`);
  }
});

check('EVERY ROW AND THE FOOTER MATCH THE HEADER, column for column', async () => {
  /* The failure adding this column risks: a `<th>` with no matching `<td>` in
     the body or the FOOTER shifts every number one place left and still
     renders perfectly. The footer is the easy one to forget — it is written
     once, far from the rows. */
  const sec = testCaseSection((await renderHtml(SNAP, PRIORITISED)).html);
  const cols = (sec.match(/<th(?=[\s>])[^>]*>/g) || []).length;
  assert.ok(cols >= 7, `expected the full table, saw ${cols} columns`);

  const body = sec.slice(sec.indexOf('<tbody>'), sec.indexOf('</tbody>'));
  const rows = trs(body, 0);
  assert.ok(rows.length, 'no rows to check');
  for (const r of rows) {
    assert.strictEqual((r.match(/<td[^>]*>/g) || []).length, cols,
      'a row has a different number of cells than the header has columns');
  }
  const foot = sec.slice(sec.indexOf('<tfoot>'), sec.indexOf('</tfoot>'));
  assert.strictEqual((foot.match(/<td[^>]*>/g) || []).length, cols,
    'the footer has drifted from the header — every total is one column out');
});

/* ── THE RISK SECTION ─────────────────────────────────────────────────
   Sprint health, at the top of this page, says what is TRUE — a score and
   the reasons behind it. This section says what to DO, which is the thing a
   lead opened the page for. It is deliberately not the Risks screen shrunk
   down: no low signals, no closed register entries, no editing. */

/* `UI.esc` as the view applies it, so a title containing an apostrophe or an
   ampersand — "R&D_iGO_E2E depends on …" — is looked for in the form the page
   actually wrote, not the form the model holds. */
const UIesc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The risk section's markup, cut out by its heading. */
const riskBlock = (html) => {
  const at = html.indexOf('<h2>Risks</h2>');
  assert.ok(at > 0, 'there is no Risks section on the Active sprint page');
  const start = html.lastIndexOf('<section', at);
  const end = html.indexOf('</section>', at);
  return html.slice(start, end);
};
const riskCards = (block) => [...block.matchAll(/<div class="risk-card ([a-z]+)">([\s\S]*?)<\/div>\s*<\/div>/g)]
  .map(m => ({ severity: m[1], html: m[2] }));

/* A sprint in trouble, because the base fixture is a healthy one and fires no
   detectors at all. Three separate faults, so the section is checked against
   more than one kind of risk: work nobody can move, a commitment nobody
   estimated, and one person carrying a sprint's worth of points on their own. */
const TROUBLED = {
  ...SNAP,
  issues: Object.fromEntries([
    ...Object.entries(SNAP.issues),
    ...[
      { ...issue({ key: 'A-30', assignee: 'Hien Phan', points: 5 }), blockedBy: ['A-99'] },
      issue({ key: 'A-31', assignee: 'Hien Phan', points: null }),
      issue({ key: 'A-32', assignee: 'Hien Phan', points: 21 }),
      issue({ key: 'A-33', assignee: 'Hien Phan', points: 13 }),
    ].map(i => [i.key, i]),
  ]),
};

check('THE RISKS SIT UNDER ALL SPRINT ITEMS, where he asked for them', async () => {
  // Last on the page, after the list of work it is about. Pinned because it
  // has moved once already — it first went above the burndown.
  const { html } = await renderHtml(TROUBLED);
  const items = html.indexOf('All sprint items');
  const risks = html.indexOf('<h2>Risks</h2>');
  assert.ok(items > 0 && risks > 0, 'both sections must be on the page');
  assert.ok(risks > items, 'Risks reads after the item table, not before it');
  assert.strictEqual(html.indexOf('<section', risks), -1,
    'and no section opens after it — Risks is the end of the report');
});

check('THE ACTIVE SPRINT PAGE CARRIES ITS OWN RISKS', async () => {
  const { html, payload } = await renderHtml(TROUBLED);
  const block = riskBlock(html);
  const acting = payload.risks.signals.filter(s => s.severity !== 'low');
  assert.ok(acting.length >= 2, `the fixture has to produce trouble, got ${acting.length}`);
  // Every high and medium signal the model found is on the page, by title.
  for (const s of acting.slice(0, 6)) {
    assert.ok(block.includes(UIesc(s.title)), `"${s.title}" was detected and is not on the page`);
  }
  // And it is the SAME detector the Risks screen runs, not a second opinion
  // written into the view — that is the whole reason `signalsFor` was split out.
  const fromRiskView = insights.riskView(
    { ...PLAN, teams: [TEAM] }, TROUBLED, { teamId: 'titan', sprintId: 'S40', today: MID_SPRINT },
  ).signals.map(s => s.id).sort();
  assert.deepStrictEqual(payload.risks.signals.map(s => s.id).sort(), fromRiskView,
    'the two screens must detect the same risks, or one of them is lying about this sprint');
});

check('and each card says what to DO, not just what is wrong', async () => {
  // A risk you cannot act on is a number. The Risks screen holds itself to
  // this and so does the page that now borrows from it.
  const block = riskBlock((await renderHtml(TROUBLED)).html);
  const cards = riskCards(block);
  assert.ok(cards.length, 'no cards rendered');
  for (const c of cards) assert.match(c.html, /class="action"/, `a card has no action: ${c.html.slice(0, 80)}`);
});

check('and it never runs past its budget, however bad the sprint is', async () => {
  // Past about a screenful the Risks page is the better tool, and it is one
  // click away. The overflow has to be stated rather than silently dropped.
  const many = { ...PLAN, risks: new Array(9).fill(0).map((_, i) => ({
    id: `r${i}`, title: `Register risk ${i}`, severity: 'high', mitigation: 'Do the thing',
  })) };
  const { html } = await renderHtml(TROUBLED, many);
  const block = riskBlock(html);
  assert.ok(riskCards(block).length <= 6, 'the section has a budget');
  assert.match(block, /\d+ more/, 'and says how many it did not draw');
});

check('LOW SIGNALS ARE COUNTED, NOT LISTED', async () => {
  /* "Keep an eye on it" is not a thing to do today, and a column of them under
     a sprint that is on track is how a section teaches you to scroll past it.
     They stay on the Risks page; here they are a number.

     Work-mix drift is the reliable low one: a target this sprint misses, on a
     category that is not maintenance — maintenance running over is the one
     mix result the detector rates higher than low. */
  const drifted = { ...PLAN, mixTargets: { titan: { technical: [40, 60] } } };
  const { html, payload } = await renderHtml(TROUBLED, drifted);
  const block = riskBlock(html);
  const low = payload.risks.signals.filter(s => s.severity === 'low');
  assert.ok(low.length, 'this fixture has to produce a low signal, or the check proves nothing');
  for (const s of low) {
    assert.ok(!block.includes(UIesc(s.title)), `low signal "${s.title}" is taking a card`);
  }
  assert.match(block, new RegExp(`${low.length} low`), 'and the count has to be stated');
});

check('THE COUNTS AGREE WITH THE CARDS UNDER THEM', async () => {
  /* The first version counted only the detected signals, so his own register
     entry — a high one — made the header read "1 high" above two cards
     tagged high. A header that disagrees with what is under it is worse than
     no header. */
  const plan = {
    ...PLAN,
    risks: [
      { id: 'r1', title: 'RCA ownership is unclear', severity: 'high', category: 'Process', owner: 'Nghiep', mitigation: 'Agree an owner' },
      { id: 'r2', title: 'A risk that was dealt with', severity: 'high', status: 'Closed', mitigation: 'Done' },
    ],
  };
  const { html } = await renderHtml(SNAP, plan);
  const block = riskBlock(html);
  const shownHigh = riskCards(block).filter(c => c.severity === 'high').length;
  const stated = Number((block.match(/(\d+) high/) || [])[1]);
  assert.ok(shownHigh > 0 && stated > 0, 'the fixture must produce a high risk');
  assert.ok(stated >= shownHigh,
    `the header says ${stated} high and ${shownHigh} high cards are drawn under it`);
  assert.match(block, /RCA ownership is unclear/, 'a risk he typed himself belongs on his sprint page');
  assert.match(block, /1 from the register/, 'and it is marked as coming from the register');
});

check('a CLOSED register entry is history, and stays on the Risks page', async () => {
  const plan = {
    ...PLAN,
    risks: [{ id: 'r2', title: 'A risk that was dealt with', severity: 'high', status: 'Closed', mitigation: 'Done' }],
  };
  const { html, payload } = await renderHtml(SNAP, plan);
  assert.strictEqual(payload.risks.manual.length, 0, 'a closed entry must not reach the page at all');
  assert.ok(!riskBlock(html).includes('A risk that was dealt with'));
});

check('and the section links to the full register rather than editing it here', async () => {
  // Two places to edit one register is two places for it to disagree.
  const block = riskBlock((await renderHtml()).html);
  assert.match(block, /href="#risks"/, 'no way through to the Risks page');
  assert.ok(!/data-edit=|data-delete=|id="addRisk"/.test(block),
    'the register is edited in one place, and this is not it');
});

check('A SPRINT WITH NOTHING TO ACT ON SAYS THE CHECKS RAN', async () => {
  /* Silence here reads as "this feature is broken" or "nobody looked". It has
     to read as a result. */
  // The base fixture is a healthy two-person sprint and fires no detector at
  // all — which is exactly the case that has to read as a result.
  const { html, payload } = await renderHtml(SNAP, { ...PLAN, risks: [] });
  const block = riskBlock(html);
  assert.ok(!payload.risks.signals.some(s => s.severity !== 'low') && !payload.risks.manual.length,
    'this fixture has to be quiet, or the check proves nothing');
  assert.match(block, /Nothing to act on/);
  assert.ok(!/<div class="risk-card/.test(block), 'and draws no cards');
});

check('the risks print, because a sprint report without them is the good news only', async () => {
  const { html } = await renderHtml();
  const block = riskBlock(html);
  assert.ok(!/class="section[^"]*print-hide/.test(block.slice(0, block.indexOf('>') + 1)),
    'the section itself must not be print-hidden');
  // The link out is screen furniture and does not belong on paper.
  assert.match(block, /class="btn ghost sm print-hide"/, 'the "All risks" link should not print');
});

/* ── THE "!" ON A STORY IN REFINEMENT ─────────────────────────────────── */

/** The "All sprint items" table, cut out by its heading. */
const itemTable = (html) => {
  const at = html.indexOf('All sprint items');
  assert.ok(at > 0, 'the item table did not render');
  const start = html.indexOf('<table', at);
  return html.slice(start, html.indexOf('</table>', start));
};

/** `rowFor` above, but a missing row is this file's bug rather than a silent ''. */
const theRow = (tbl, key) => {
  const row = rowFor(tbl, key);
  assert.ok(row, `no row for ${key} — the fixture and this check have parted company`);
  return row;
};

const refined = () => renderHtml(REFINE_SNAP);

/* `UI` on its own, for checks that need a predicate rather than a render —
   loaded from the same file the app loads, so it cannot drift from it. */
const ctx0 = (() => {
  const c = { console };
  vm.createContext(c);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8')}\n;globalThis.UI = UI;`, c);
  return c.UI;
})();

check('A STORY IN REFINEMENT WHOSE EPIC IS BLOCKED GETS THE ICON', async () => {
  const { html } = await refined();
  const tbl = itemTable(html);
  assert.match(theRow(tbl, 'R-1'), /data-act="epic-blockers"[^>]*data-key="R-1"/,
    'the row that has something to chase has no way to see it');
  assert.match(theRow(tbl, 'R-2'), /data-act="epic-blockers"/);
});

check('and one whose epic names nothing does NOT', async () => {
  // An icon on every row is an icon nobody reads after the second time.
  const { html } = await refined();
  assert.ok(!/data-act="epic-blockers"/.test(theRow(itemTable(html), 'R-3')),
    'the icon appeared on a row with nothing behind it');
});

check('NOR DOES A ROW IN ANY OTHER STATUS, however blocked its epic', async () => {
  /* N-1 sits under the same blocked epic as R-1. It is deliberately unmarked:
     the icon answers "what is this waiting on", and that is the question
     Refinement is asking. */
  const { html } = await refined();
  const row = theRow(itemTable(html), 'N-1');
  assert.match(row, /In Dev/, 'fixture check: N-1 has to be in another status');
  assert.ok(!/data-act="epic-blockers"/.test(row), 'the icon is not scoped to Refinement');
});

check('THE BLOCKERS COME FROM THE EPIC, NOT FROM THE STORY', async () => {
  /* R-4 is in Refinement, carries its OWN blocker, and sits under an epic with
     none. Reading the item's `blockedBy` — the obvious implementation, and the
     one every other screen uses — marks this row and misses the ten that
     matter. On his data not one Story in Refinement names a blocker itself. */
  const { payload } = await refined();
  const r4 = payload.items.find(i => i.key === 'R-4');
  assert.deepStrictEqual(r4.blockedBy, ['OWN-1'], 'fixture check: R-4 names its own blocker');
  assert.deepStrictEqual(r4.epicBlockers, [], 'its epic names nothing, so there is nothing to show');

  const { html } = await refined();
  assert.ok(!/data-act="epic-blockers"/.test(theRow(itemTable(html), 'R-4')),
    'the icon read the item\'s own blockers instead of its epic\'s');
});

check('the payload carries which epic each blocker came from, and how it relates', async () => {
  const { payload } = await refined();
  const r1 = payload.items.find(i => i.key === 'R-1');
  /* The blockers are LINKS, not bare keys: the summary Jira sent inside the
     link is the only description these will ever have, since they live in
     projects this tool does not sync. */
  assert.deepStrictEqual(r1.epicBlockers, [
    { epic: 'E-BLOCKED', name: 'Epic E-BLOCKED', via: 'parent',
      blockers: [{ key: 'CLICMNTIGO-11567', summary: null, type: null }] },
  ], 'without the epic and the via, the drawer cannot say whose blockers these are');
});

check('THE DRAWER LISTS THE EPIC\'S BLOCKERS, and names the epic they belong to', async () => {
  const { payload, ctx } = await refined();
  const item = payload.items.find(i => i.key === 'R-2');
  const html = ctx.UI.epicBlockersDrawer(item, payload.items, {}, {});
  // E-ALSO names two, one of which R-1's epic names as well.
  assert.match(html, /CLICMNTIGO-11567/);
  assert.match(html, /OTHER-1/);
  assert.match(html, /E-ALSO/, 'the drawer does not say whose blockers these are');
  assert.match(html, /parent epic/, 'nor how that epic relates to the story');
  assert.match(html, /R-2/, 'nor which story was clicked');
});

check('and a blocker in a project this tool does not sync is still listed', async () => {
  /* Every one of the ten in his sprint is CLICMNTIGO-11567, which lives in a
     project this tool never syncs. Dropping what it cannot resolve would empty
     the drawer on exactly the rows it was built for. */
  const { payload, ctx } = await refined();
  const item = payload.items.find(i => i.key === 'R-1');
  const html = ctx.UI.epicBlockersDrawer(item, payload.items, {}, {});
  assert.match(html, /CLICMNTIGO-11567/, 'the unresolvable blocker was dropped');
  assert.match(html, /Not in the local store/, 'and it has to say why it shows no detail');
  assert.match(html, />Open in Jira</, 'which makes the way out to Jira the point of the panel');
});

check('REFINEMENT IS MATCHED EXACTLY, not by substring', async () => {
  /* His Jira has one status containing the word today. Workflows grow, and a
     substring match would silently start marking "Ready for Refinement" or
     "Refinement Done" — rows the icon says nothing true about. Cheap to pin
     now, invisible to find later. */
  const { ctx } = await refined();
  const blocked = [{ epic: 'E-1', via: 'parent', blockers: ['B-1'] }];
  assert.ok(ctx.UI.epicBlockerIcon({ key: 'X', status: 'Refinement', epicBlockers: blocked }),
    'the exact status has to still mark');
  for (const status of ['Ready for Refinement', 'Refinement Done', 'Pre-Refinement', 'refinements']) {
    assert.strictEqual(ctx.UI.epicBlockerIcon({ key: 'X', status, epicBlockers: blocked }), '',
      `"${status}" was marked as Refinement`);
  }
  // Whitespace and casing from Jira are not a different status, though.
  assert.ok(ctx.UI.epicBlockerIcon({ key: 'X', status: '  refinement ', epicBlockers: blocked }),
    'a cased or padded value is the same status');
});

/** The "Where the work sits" card, cut out by its heading. */
const workSits = (html) => {
  const at = html.indexOf('Where the work sits');
  assert.ok(at > 0, 'the chart card did not render');
  return html.slice(at, html.indexOf('</section>', at));
};

check('THE CHART CARD SAYS WHAT REFINEMENT IS WAITING ON', async () => {
  /* The bar says how many points are in Refinement and cannot say why. In his
     TT Week 14Sep ten of sixteen are held, all by one ticket — one
     conversation, not ten, and nothing on the board said so. */
  const { html } = await refined();
  const card = workSits(html);
  assert.match(card, /data-act="refinement-blockers"/, 'the card offers no way in');
  assert.match(card, /of 4 in Refinement/, `the line does not say how many of how many: ${card.slice(-300)}`);
  assert.match(card, /waiting on/);
});

check('and the control is a real button, not a shape inside the SVG', async () => {
  /* An SVG has no button. A clickable <g> answers a mouse and is invisible to
     a keyboard, which this app treats as half a control. */
  const { html } = await refined();
  const card = workSits(html);
  const at = card.indexOf('data-act="refinement-blockers"');
  const tagStart = card.lastIndexOf('<', at);
  assert.strictEqual(card.slice(tagStart, tagStart + 7), '<button',
    'the control is not a <button>, so it cannot be reached by keyboard');
  assert.ok(at > card.indexOf('</svg>'), 'the control is inside the chart rather than under it');
});

check('and it is absent when nothing in Refinement is blocked', async () => {
  // SNAP has no Refinement items at all, so the line must not appear.
  const { html } = await renderHtml();
  assert.ok(!/data-act="refinement-blockers"/.test(workSits(html)),
    'the card advertised blockers on a sprint with none');
});

check('THE DRAWER GROUPS BY BLOCKER — one ticket, all the items it holds', async () => {
  /* Ten rows each naming the same ticket is ten rows of one fact. Turned
     around it is one row with the thing to chase at the top of it. */
  const { payload, ctx, mount } = await refined();
  let drawn = '';
  ctx.UI.drawer = (h) => { drawn = h; };
  const held = (payload.items || []).filter(i => ctx.UI.inRefinement(i) && (i.epicBlockers || []).length);
  assert.strictEqual(held.length, 2, 'fixture check: R-1 and R-2 are the blocked ones');

  mount.click('refinement-blockers');
  assert.match(drawn, /Blocking Refinement/);
  // CLICMNTIGO-11567 holds BOTH, through two different epics — so it appears
  // once, with two items under it, not twice.
  const heads = (drawn.match(/CLICMNTIGO-11567/g) || []).length;
  assert.ok(heads >= 1, 'the shared blocker is missing');
  assert.match(drawn, /blocks 2 items/, 'the shared blocker was not grouped');
  assert.match(drawn, /R-1/); assert.match(drawn, /R-2/);
  assert.match(drawn, /via/, 'the drawer does not say which epic carried the block');
});

/* Insertion order deliberately AGAINST size order: the first Refinement item
   seen names a blocker holding only itself, the next two share a bigger one.
   Without a sort the drawer lists the one-item blocker first, which is the
   opposite of "the one ticket worth chasing today". */
const ORDER_SNAP = {
  ...SNAP,
  issues: Object.fromEntries([
    ...Object.values(SNAP.issues),
    EPIC('E-ONLY', ['SOLO-1']),
    EPIC('E-S1', ['BIG-1']),
    EPIC('E-S2', ['BIG-1']),
    issue({ key: 'O-1', assignee: 'Hien Phan', points: 1, status: 'Refinement', parentKey: 'E-ONLY' }),
    issue({ key: 'O-2', assignee: 'Hien Phan', points: 1, status: 'Refinement', parentKey: 'E-S1' }),
    issue({ key: 'O-3', assignee: 'Hien Phan', points: 1, status: 'Refinement', parentKey: 'E-S2' }),
  ].map(i => [i.key, i])),
};

check('THE BIGGEST BLOCKER COMES FIRST — the one ticket worth chasing today', async () => {
  const { ctx, mount } = await renderHtml(ORDER_SNAP);
  let drawn = '';
  ctx.UI.drawer = (h) => { drawn = h; };
  mount.click('refinement-blockers');
  /* Measured on the GROUP HEADINGS, not on where each key first appears in the
     markup: the "Open in Jira" link at the top of the drawer lists every key,
     sorted, so an indexOf for a key finds it in that URL long before its
     heading and passes whatever order the groups are actually in. That version
     of this check was green against a drawer with no sort at all. */
  const sizes = [...drawn.matchAll(/blocks (\d+) item/g)].map(m => Number(m[1]));
  assert.deepStrictEqual(sizes, [2, 1],
    `groups are not biggest-first: ${sizes.join(', ')}`);
  assert.ok(drawn.indexOf('blocks 2 items') < drawn.indexOf('blocks 1 item'),
    'the blocker holding one item was listed above the blocker holding two');
});

check('A BLOCKER SHOWS WHAT JIRA SAID ABOUT IT, not "not in the local store"', async () => {
  /* The bug he reported. Jira sends the blocker's summary and type inside the
     link; `blockedBy` used to map to a bare key and throw both away, so the
     panel showed a naked key under "Not in the local store" — on a blocker
     that no sync will ever resolve, because it lives in a project this tool
     does not pull. 283 of his 356 unresolvable link targets already carry a
     summary on the link row. */
  const { payload, ctx } = await refined();
  const item = {
    key: 'X-1', status: 'Refinement',
    epicBlockers: [{ epic: 'E-A', via: 'parent',
      blockers: [{ key: 'CLICMNTIGO-11567', summary: 'iGO client migration sign-off', type: 'Story' }] }],
  };
  const html = ctx.UI.epicBlockersDrawer(item, payload.items, {}, {});
  assert.match(html, /iGO client migration sign-off/, 'the summary the link carried was dropped');
  assert.ok(!/Not in the local store/.test(html),
    'it claimed to know nothing about an issue it had the summary for');
});

check('and a blocker with nothing known still says so', async () => {
  // The honest remainder: a link that carried no summary has nothing to show,
  // and saying so beats an empty row.
  const { payload, ctx } = await refined();
  const item = {
    key: 'X-1', status: 'Refinement',
    epicBlockers: [{ epic: 'E-A', via: 'parent', blockers: [{ key: 'GHOST-1', summary: null, type: null }] }],
  };
  const html = ctx.UI.epicBlockersDrawer(item, payload.items, {}, {});
  assert.match(html, /GHOST-1/);
  assert.match(html, /Not in the local store/);
});

check('DUPLICATE BLOCKERS ACROSS EPICS COLLAPSE, so the count is a set', async () => {
  // A story under two epics that name the same blocker is blocked by one
  // thing, not two.
  const { payload, ctx } = await refined();
  const item = {
    key: 'X-1', status: 'Refinement',
    epicBlockers: [
      { epic: 'E-A', via: 'parent', blockers: ['B-1', 'B-2'] },
      { epic: 'E-B', via: 'relates', blockers: ['B-2', 'B-3'] },
    ],
  };
  const icon = ctx.UI.epicBlockerIcon(item);
  assert.match(icon, /blocked by 3 issues/, `counted the links, not the set: ${icon}`);
  const html = ctx.UI.epicBlockersDrawer(item, payload.items, {}, {});
  assert.match(html, /3 items/, 'the drawer heading disagrees with the icon');
});

/* ── FILTERING THE ITEM TABLE ─────────────────────────────────────────── */

/**
 * The predicate is checked directly and the BAR is checked from the markup.
 *
 * Between them sits fifteen lines of hiding rows, which needs a real DOM to
 * exercise and cannot go wrong in an interesting way: the two things that can
 * are "which items match" and "which options the bar offers", and both are
 * reachable without one.
 */

const filterBar = (html) => {
  const at = html.indexOf('data-items-filters');
  assert.ok(at > 0, 'the item table has no filter bar');
  const from = html.lastIndexOf('<div', at);
  return html.slice(from, html.indexOf('</div>\n      </div>', at) + 20);
};
/** The <option> values under one filter's <select>. */
const optionsOf = (bar, name) => {
  const at = bar.indexOf(`data-items-filter="${name}"`);
  if (at < 0) return null;
  return [...bar.slice(at, bar.indexOf('</select>', at)).matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
};

check('THE FILTER MATCHES ON WHAT THE ROW SHOWS, field by field', async () => {
  const { ctx, payload } = await refined();
  const F = ctx.UI.filterItems;
  const items = payload.items;
  const one = items.find(i => i.assignee && i.status);

  assert.deepStrictEqual(F(items, {}).map(i => i.key), items.map(i => i.key),
    'an empty filter must be the whole list, not an empty one');
  assert.ok(F(items, { status: one.status }).every(i => i.status === one.status));
  assert.ok(F(items, { assignee: one.assignee }).every(i => i.assignee === one.assignee));
  assert.ok(F(items, { status: 'No Such Status' }).length === 0);
});

check('UNASSIGNED IS A CHOICE, not something you can only search for', async () => {
  /* The single most useful thing to ask this table — what has nobody picked
     up — and a plain equality on the name cannot express it, because the
     value being matched is the absence of one. */
  const { ctx, payload } = await renderHtml();
  const items = payload.items;
  const none = items.filter(i => !i.assignee);
  assert.ok(none.length, 'fixture check: something has to be unassigned');
  const got = ctx.UI.filterItems(items, { assignee: ctx.UI.ITEM_UNASSIGNED });
  assert.deepStrictEqual(got.map(i => i.key).sort(), none.map(i => i.key).sort());
  // ...and it is offered, or it can only be reached by typing the sentinel.
  const bar = filterBar((await renderHtml()).html);
  assert.ok((optionsOf(bar, 'assignee') || []).includes(ctx.UI.ITEM_UNASSIGNED),
    'the bar does not offer Unassigned');
});

check('SEARCH LOOKS AT THE KEY AND THE SUMMARY, and ignores case', async () => {
  const { ctx, payload } = await renderHtml();
  const one = payload.items.find(i => i.summary);
  const byKey = ctx.UI.filterItems(payload.items, { q: one.key.toLowerCase() });
  assert.ok(byKey.some(i => i.key === one.key), 'a lower-cased key found nothing');
  const word = String(one.summary).split(' ')[0];
  assert.ok(ctx.UI.filterItems(payload.items, { q: word.toUpperCase() }).some(i => i.key === one.key),
    'an upper-cased word from the summary found nothing');
});

check('EVERY FIELD THE BAR OFFERS ACTUALLY NARROWS — field by field, not by sample', async () => {
  /* Driven off the fields themselves rather than off two hand-picked ones.
     The first version of these checks exercised status, assignee and search,
     which left `category` and `component` with no coverage at all: a mutation
     turning the category clause into `return true` — a filter that WIDENS —
     went through 1,300 checks untouched. */
  const { ctx, payload } = await renderHtml();
  const items = payload.items;
  const pick = {
    status: i => i.status,
    assignee: i => i.assignee,
    component: i => (i.components || [])[0],
    category: i => i.category,
  };
  for (const [field, of] of Object.entries(pick)) {
    const values = [...new Set(items.map(of).filter(Boolean))];
    assert.ok(values.length, `fixture check: nothing to filter ${field} by`);
    for (const v of values) {
      const got = ctx.UI.filterItems(items, { [field]: v });
      const want = items.filter(i => of(i) === v);
      assert.deepStrictEqual(got.map(i => i.key).sort(), want.map(i => i.key).sort(),
        `${field}=${v} returned the wrong set`);
      assert.ok(got.length <= items.length, `${field} widened the list`);
    }
    // A value nothing has must empty the table, or the clause is not running.
    assert.strictEqual(ctx.UI.filterItems(items, { [field]: '☃ nothing has this' }).length, 0,
      `${field} ignores a value no row carries`);
  }
});

check('COMPONENT MATCHES THE ONE ON SCREEN, not any the item carries', async () => {
  /* The column shows the FIRST component and nothing else. A filter that
     matched any of them would leave rows on screen whose Component cell reads
     something other than what was filtered for — which looks like the filter
     failing rather than like a row with two components.

     Hand-built items, not the fixture: every item in the sprint snapshot has
     at most one component, so the two readings agree there and a mutation
     swapping `[0] ===` for `.includes()` walked straight through. */
  const { ctx } = await renderHtml();
  const items = [
    { key: 'X-1', summary: 'two', status: 'Open', components: ['PS_Shown', 'PS_Hidden'] },
    { key: 'X-2', summary: 'one', status: 'Open', components: ['PS_Hidden'] },
  ];
  assert.deepStrictEqual(ctx.UI.filterItems(items, { component: 'PS_Shown' }).map(i => i.key), ['X-1']);
  assert.deepStrictEqual(ctx.UI.filterItems(items, { component: 'PS_Hidden' }).map(i => i.key), ['X-2'],
    'a row whose Component cell reads PS_Shown was kept under a PS_Hidden filter');
});

check('TWO FILTERS NARROW, they do not widen', async () => {
  // An `||` where an `&&` belongs reads as a filter that works right up until
  // you use two of them, and then quietly returns more rows than one alone.
  const { ctx, payload } = await renderHtml();
  const items = payload.items;
  const one = items.find(i => i.assignee && i.status);
  const both = ctx.UI.filterItems(items, { assignee: one.assignee, status: one.status });
  const single = ctx.UI.filterItems(items, { assignee: one.assignee });
  assert.ok(both.length <= single.length, `two filters returned more rows (${both.length}) than one (${single.length})`);
  assert.ok(both.every(i => i.assignee === one.assignee && i.status === one.status));
});

check('THE BAR OFFERS ONLY VALUES THAT ARE IN THE TABLE, so no choice is a dead end', async () => {
  /* A dropdown built from the team roster or the status catalogue rather than
     from these rows offers options that empty the table, which reads exactly
     like a broken filter. */
  const { html, payload } = await renderHtml();
  const bar = filterBar(html);
  const present = {
    status: new Set(payload.items.map(i => i.status).filter(Boolean)),
    assignee: new Set(payload.items.map(i => i.assignee).filter(Boolean)),
    component: new Set(payload.items.map(i => (i.components || [])[0]).filter(Boolean)),
  };
  for (const [name, set] of Object.entries(present)) {
    const opts = (optionsOf(bar, name) || []).filter(v => v !== '' && v !== 'ALL_UNASSIGNED');
    assert.ok(opts.length, `the ${name} filter offers nothing`);
    for (const v of opts) {
      if (v === '— none —') continue;      // the Unassigned sentinel
      assert.ok(set.has(v), `${name} offers "${v}", which no row has`);
    }
    for (const v of set) assert.ok(opts.includes(v), `${name} is missing "${v}", which is on a row`);
  }
});

check('EVERY ROW CARRIES THE VALUES IT IS FILTERED BY', async () => {
  /* The wiring reads these attributes rather than a copy of the item list, so
     a row cannot be hidden for a value it is not showing. Missing attributes
     make every row match nothing, which looks like an empty sprint. */
  const { html, payload } = await renderHtml();
  const body = itemsSection(html);
  for (const i of payload.items) {
    const row = rowFor(body, i.key);
    assert.ok(row, `${i.key} has no row`);
    for (const a of ['key', 'summary', 'status', 'assignee', 'component', 'category', 'points']) {
      assert.match(row, new RegExp(`data-item-${a}="`), `${i.key} is missing data-item-${a}`);
    }
    assert.match(row, new RegExp(`data-item-status="${i.status}"`), `${i.key}'s status attribute disagrees with its cell`);
  }
});

check('AND BOTH SCREENS GET THE BAR, because it is the same table', async () => {
  for (const [where, render] of [['Active sprint', renderHtml], ['Capacity planning', renderCapacity]]) {
    const { html } = await render();
    assert.ok(html.includes('data-items-filters'), `${where}: no filter bar on the item table`);
  }
});

check('AND BOTH SCREENS WIRE IT — a bar nothing listens to is furniture', async () => {
  /* The markup renders either way. Without the wiring call the selects open,
     the options are right, choosing one does nothing, and no check above this
     notices — which is why this one reads the source of both views rather
     than their output. */
  for (const f of ['sprint.js', 'capacity.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'views', f), 'utf8');
    assert.match(src, /UI\.wireItemsFilter\(mount/, `${f} renders the filter bar but never wires it`);
  }
  // And the mount really is given a listener, rather than the call being a
  // no-op that returns early on everything.
  const { ctx } = await renderHtml();
  const types = [];
  ctx.UI.wireItemsFilter({ addEventListener: (t) => types.push(t), querySelector: () => null, querySelectorAll: () => [] });
  for (const t of ['input', 'change', 'click']) {
    assert.ok(types.includes(t), `nothing listens for ${t}, so the bar is dead`);
  }
});

/* ── OPEN IN JIRA, OVER WHAT THE TABLE IS SHOWING ─────────────────────── */

/**
 * The link is rebuilt by the filter wiring, so checking the rendered HTML only
 * covers the unfiltered case. The rest needs the wiring to actually run, which
 * needs enough of a DOM for it to walk — a dozen lines, and the alternative is
 * an untested rewrite of the one link on the page that can silently open the
 * wrong set.
 */
function fakeTable(rows, { jiraBase = 'https://ipipelinejira.atlassian.net' } = {}) {
  const el = (tag, data = {}) => ({
    tagName: tag, dataset: data, hidden: false, value: '', innerHTML: '', textContent: '',
    querySelectorAll: () => [], querySelector: () => null,
    closest(sel) { return sel.replace(/[[\]]/g, '') in this.dataset ? this : null; },
  });
  // `closest('[data-items-filter]')` has to answer for the inputs, so the
  // dataset key is what the selector names, camel-cased as the DOM does it.
  const input = (name) => {
    const n = el('input', { itemsFilter: name });
    n.closest = (sel) => (sel === '[data-items-filter]' ? n : null);
    return n;
  };
  const fields = { q: input('q'), status: input('status'), assignee: input('assignee'), component: input('component'), category: input('category') };
  const bar = el('div', { itemsFilters: '' });
  bar.querySelectorAll = () => Object.values(fields);
  const trs = rows.map(r => el('tr', {
    itemKey: r.key, itemSummary: r.summary || '', itemStatus: r.status || '',
    itemAssignee: r.assignee || '', itemComponent: (r.components || [])[0] || '',
    itemCategory: r.category || '', itemPoints: r.points == null ? '' : String(r.points),
  }));
  const body = el('tbody', { itemsRows: '' });
  body.querySelectorAll = () => trs;
  const jira = el('span', { itemsJira: '' });
  const showing = el('strong', { itemsShowing: '' });
  const clear = el('button', { itemsFilterClear: '' });
  const map = {
    '[data-items-filters]': bar, '[data-items-rows]': body,
    '[data-items-jira]': jira, '[data-items-showing]': showing,
    '[data-items-filter-clear]': clear,
  };
  const handlers = {};
  const mount = {
    addEventListener: (t, fn) => { (handlers[t] = handlers[t] || []).push(fn); },
    querySelector: (sel) => map[sel] || null,
    querySelectorAll: () => [],
    set: (name, v) => { fields[name].value = v; for (const fn of handlers.change || []) fn({ target: fields[name] }); },
  };
  return { mount, jira, showing, clear, rows: trs, jiraBase };
}

const ITEMS = [
  { key: 'F-1', summary: 'one', status: 'Refinement', assignee: 'Hien Phan', components: ['PS_A'], points: 3 },
  { key: 'F-2', summary: 'two', status: 'In Dev', assignee: 'Hien Phan', components: ['PS_A'], points: 5 },
  { key: 'F-3', summary: 'three', status: 'In Dev', assignee: null, components: ['PS_B'], points: 2 },
];

check('THE ITEM TABLE OFFERS OPEN IN JIRA, on both screens', async () => {
  for (const [where, render] of [['Active sprint', renderHtml], ['Capacity planning', renderCapacity]]) {
    const { html, payload } = await render();
    const sec = itemsSection(html);
    assert.ok(sec.includes('data-items-jira'), `${where}: no Open in Jira on the item table`);
    const href = /href="([^"]*jql[^"]*)"/.exec(sec.slice(sec.indexOf('data-items-jira')));
    assert.ok(href, `${where}: the link has no Jira search URL`);
    // Unfiltered, it is the whole sprint — every key on the table.
    const url = decodeURIComponent(href[1]);
    for (const i of payload.items) {
      assert.ok(url.includes(i.key), `${where}: ${i.key} is on the table but not in the link`);
    }
  }
});

check('AND IT FOLLOWS THE FILTER — the link opens what the table shows', async () => {
  /* The failure this exists for: filter to one person, click the link, get the
     whole sprint. It looks like the filter failed, and there is no way to tell
     from the screen which of the two is wrong. */
  const { ctx } = await renderHtml();
  const t = fakeTable(ITEMS);
  ctx.UI.setJiraBase(t.jiraBase);
  ctx.UI.wireItemsFilter(t.mount);

  t.mount.set('status', 'In Dev');
  const url = decodeURIComponent(/href="([^"]*)"/.exec(t.jira.innerHTML)[1]);
  assert.ok(url.includes('F-2') && url.includes('F-3'), `the two In Dev rows are not in the link: ${url}`);
  assert.ok(!url.includes('F-1'), `a filtered-out row is still in the link: ${url}`);
  assert.match(t.showing.textContent, /showing 2 of 3/, `the count disagrees: ${t.showing.textContent}`);
  assert.match(t.showing.textContent, /7 pts/, 'the points do not follow the filter either');
});

check('A FILTER THAT MATCHES NOTHING LEAVES NO LINK, rather than one to nothing', async () => {
  const { ctx } = await renderHtml();
  const t = fakeTable(ITEMS);
  ctx.UI.setJiraBase(t.jiraBase);
  ctx.UI.wireItemsFilter(t.mount);
  t.mount.set('assignee', 'Nobody At All');
  assert.strictEqual(t.jira.innerHTML, '', `an empty result still offered a link: ${t.jira.innerHTML}`);
  assert.match(t.showing.textContent, /showing 0 of 3/);
});

check('CLEARING PUTS EVERY ROW AND EVERY KEY BACK', async () => {
  const { ctx } = await renderHtml();
  const t = fakeTable(ITEMS);
  ctx.UI.setJiraBase(t.jiraBase);
  ctx.UI.wireItemsFilter(t.mount);
  t.mount.set('status', 'In Dev');
  assert.ok(t.rows.some(r => r.hidden), 'precondition: something has to be hidden');
  t.mount.set('status', '');
  assert.ok(!t.rows.some(r => r.hidden), 'a row stayed hidden after the filter was cleared');
  const url = decodeURIComponent(/href="([^"]*)"/.exec(t.jira.innerHTML)[1]);
  for (const i of ITEMS) assert.ok(url.includes(i.key), `${i.key} did not come back into the link`);
  assert.strictEqual(t.showing.hidden, true, 'the count line stayed up with nothing filtered');
  assert.strictEqual(t.clear.hidden, true, 'the Clear button stayed up with nothing to clear');
});

/* ── THE DUE DATE ─────────────────────────────────────────────────────── */

/* The sprint under test runs to 2026-09-30 (see SPRINT). One item is due
   inside it, one after it, one after it but finished, and one has no date —
   the four cases the column has to tell apart. */
const DUE_SNAP = {
  ...SNAP,
  issues: Object.fromEntries([
    ...Object.values(SNAP.issues),
    issue({ key: 'D-1', assignee: 'Hien Phan', points: 1, dueDate: '2026-09-25' }),
    issue({ key: 'D-2', assignee: 'Hien Phan', points: 1, dueDate: '2026-10-14' }),
    issue({ key: 'D-3', assignee: 'Hien Phan', points: 1, dueDate: '2026-10-14', status: 'Done' }),
    /* THE LAST DAY OF THE SPRINT, which is inside it. `>=` instead of `>` is
       the whole of the off-by-one here, and without this row both readings
       agree on every item in the fixture — a mutation swapping them survived
       a thousand checks. */
    issue({ key: 'D-4', assignee: 'Hien Phan', points: 1, dueDate: '2026-09-30' }),
  ].map(i => [i.key, i])),
};

const dueCellOf = (html, key) => {
  const row = rowFor(itemsSection(html), key);
  assert.ok(row, `${key} has no row`);
  const m = /<td class="col-due"[^>]*>([\s\S]*?)<\/td>/.exec(row);
  assert.ok(m, `${key} has no Due cell`);
  return { cell: m[0], inner: m[1] };
};

check('BOTH SCREENS SHOW A DUE DATE COLUMN, because it is one table', async () => {
  for (const [where, render] of [['Active sprint', renderHtml], ['Capacity planning', renderCapacity]]) {
    const { html } = await render(DUE_SNAP);
    const sec = itemsSection(html);
    const heads = [...sec.matchAll(/<th(?=[\s>])[^>]*>([^<]*)</g)].map(m => m[1].trim());
    assert.ok(heads.includes('Due'), `${where}: no Due column — ${heads.join(' | ')}`);
    assert.ok(sec.includes('class="col-due"'), `${where}: the cells are not classed`);
  }
});

check('THE DATE ON THE ROW IS THE DATE ON THE ISSUE', async () => {
  const { html, payload } = await renderHtml(DUE_SNAP);
  const withDate = payload.items.filter(i => i.dueDate);
  assert.strictEqual(withDate.length, 4, 'fixture check: four items should carry a date');
  for (const i of withDate) {
    assert.match(dueCellOf(html, i.key).cell, new RegExp(`data-sort-value="${i.dueDate}"`),
      `${i.key} sorts by something other than its own due date`);
  }
});

check('A DATE AFTER THE SPRINT ENDS IS FLAGGED, and one inside it is not', async () => {
  /* The finding worth a colour: committed to this sprint, dated to land after
     it. Measured against the sprint's end, which is on the payload — not
     against today, which would change overnight with nothing else changing
     and could not be checked without freezing the clock. */
  const { html, payload } = await renderHtml(DUE_SNAP);
  assert.strictEqual(String(payload.sprint.end).slice(0, 10), '2026-09-30', 'fixture check: the sprint end moved');
  /* `due-late` on the wrapper, not `st-late` on a span: the cell is an input
     now, and the state rides on what wraps it — a coloured input border reads
     as a validation error rather than a deadline. */
  assert.match(dueCellOf(html, 'D-2').inner, /due-late/, 'a date past the sprint end is not flagged');
  assert.ok(!/due-late/.test(dueCellOf(html, 'D-1').inner), 'a date inside the sprint was flagged');
  // The boundary: due ON the last day is due inside the sprint.
  assert.ok(!/due-late/.test(dueCellOf(html, 'D-4').inner),
    'an item due on the sprint\'s last day was called late');
});

check('AND FINISHED WORK IS NEVER LATE, whatever its date says', async () => {
  // D-3 is Done and dated a fortnight out. A due date on finished work is
  // history, not a deadline, and colouring it teaches people to ignore the
  // colour.
  const { html, payload } = await renderHtml(DUE_SNAP);
  const d3 = payload.items.find(i => i.key === 'D-3');
  assert.strictEqual(d3.dueDate, '2026-10-14', 'fixture check: still dated past the sprint');
  assert.ok(!/due-late|due-overdue/.test(dueCellOf(html, 'D-3').inner), 'a finished item was flagged');
});

check('AN ITEM WITH NO DUE DATE SORTS LAST, not first', async () => {
  /* An empty sort value sorts before every date, which puts every unknown at
     the top of a column you opened to find the earliest deadline. */
  const { html, payload } = await renderHtml(DUE_SNAP);
  const none = payload.items.find(i => !i.dueDate);
  assert.ok(none, 'fixture check: something has to be undated');
  const { cell, inner } = dueCellOf(html, none.key);
  assert.match(cell, /data-sort-value="9999-/, 'an undated item would sort above every date');
  // Editable, so an undated item is an empty date box rather than a dash —
  // the read-only form is checked on the closed sprint below.
  assert.match(inner, /value=""/, 'an undated box should be empty and typeable');
});

check('THE SPRINT END IS PASSED BY BOTH VIEWS, or nothing is ever flagged', async () => {
  /* The flag lives in the shared table and the end date does not: each view
     has to hand it over. A view that forgot would render a column that never
     colours anything, which looks exactly like a sprint with no late work. */
  for (const f of ['sprint.js', 'capacity.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'views', f), 'utf8');
    assert.match(src, /sprintEnd:/, `${f} renders the Due column but never says when the sprint ends`);
    assert.match(src, /today:/, `${f} renders the Due column but never says what today is`);
  }
  const { html } = await renderCapacity(OVERDUE_SNAP);
  assert.match(dueCellOf(html, 'D-2').inner, /due-late/, 'Capacity planning flags nothing past the sprint end');
  /* AND THE OTHER ANCHOR. `today` travels separately from the sprint end —
     the Active sprint screen reads it off `window.today`, Capacity planning
     off its own payload — so a view that carries one and not the other shows
     a column that flags half of what it should. */
  assert.match(dueCellOf(html, 'D-5').inner, /due-overdue/, 'Capacity planning marks nothing overdue');
});

/* MID_SPRINT is 2026-09-24 and the sprint runs to 2026-09-30, so an item due
   2026-09-20 is overdue and one due 2026-10-14 is merely outside the sprint —
   the two warnings, on the same screen, at the same moment. */
const OVERDUE_SNAP = {
  ...SNAP,
  issues: Object.fromEntries([
    ...Object.values(DUE_SNAP.issues),
    issue({ key: 'D-5', assignee: 'Hien Phan', points: 1, dueDate: '2026-09-20' }),
    issue({ key: 'D-6', assignee: 'Hien Phan', points: 1, dueDate: '2026-09-20', status: 'Done' }),
    /* DUE TODAY, which is not overdue — you have the rest of the day. `<=`
       instead of `<` is the whole of the off-by-one, and without a row dated
       exactly today both readings agree on every item in the fixture. */
    issue({ key: 'D-7', assignee: 'Hien Phan', points: 1, dueDate: '2026-09-24' }),
  ].map(i => [i.key, i])),
};

check('A DATE THAT HAS PASSED ON UNFINISHED WORK IS OVERDUE', async () => {
  const { html, payload } = await renderHtml(OVERDUE_SNAP);
  assert.strictEqual(payload.window.today, '2026-09-24', 'fixture check: today moved');
  const { inner } = dueCellOf(html, 'D-5');
  assert.match(inner, /due-overdue/, 'a date in the past on open work is not marked overdue');
  assert.match(inner, /due-flag/, 'the warning is colour alone — nothing marks it for a reader who cannot see it');
  // Due TODAY is not overdue: the day is not over.
  assert.ok(!/due-overdue/.test(dueCellOf(html, 'D-7').inner),
    'an item due today was already called overdue');
});

check('AND OVERDUE OUTRANKS "after the sprint" when a date is both', async () => {
  /* They are different facts: one says something is wrong now, the other that
     a plan needs revisiting. A date already past is the more urgent reading,
     so it takes the cell. */
  const { ctx } = await renderHtml();
  const opts = { today: '2026-09-24', sprintEnd: '2026-09-30' };
  const past = { key: 'X-1', status: 'In Dev', dueDate: '2026-09-20' };
  assert.strictEqual(ctx.UI.dueState(past, opts), 'overdue');
  assert.strictEqual(ctx.UI.dueState({ ...past, dueDate: '2026-10-14' }, opts), 'late');
  assert.strictEqual(ctx.UI.dueState({ ...past, dueDate: '2026-09-26' }, opts), null,
    'a date ahead of today and inside the sprint is neither');
});

check('FINISHED WORK IS NEVER OVERDUE, however far past its date', async () => {
  // D-6 was due four days ago and is Done. A deadline on closed work is
  // history; colouring it teaches people to ignore the colour.
  const { html, payload } = await renderHtml(OVERDUE_SNAP);
  const d6 = payload.items.find(i => i.key === 'D-6');
  assert.strictEqual(d6.dueDate, '2026-09-20', 'fixture check: still dated in the past');
  assert.ok(!/due-overdue/.test(dueCellOf(html, 'D-6').inner), 'a finished item was marked overdue');
});

check('OVERDUE IS MEASURED AGAINST THE PAYLOAD\'S TODAY, never the browser clock', async () => {
  /* The whole reason `today` is sent rather than read from `new Date()`: a
     cell that consults its own clock changes overnight with nothing else
     changing, and cannot be checked at all without freezing time. Hand it no
     today and it must decline to call anything overdue rather than guess. */
  const { ctx } = await renderHtml();
  const past = { key: 'X-1', status: 'In Dev', dueDate: '2020-01-01' };
  /* Long past, and with no `today` the cell says NOTHING about it — which is
     the point. It is before the sprint's end, so the other anchor has no
     opinion either, and the alternative to silence is a clock. */
  assert.strictEqual(ctx.UI.dueState(past, { sprintEnd: '2026-09-30' }), null,
    'it called a date overdue with no today to measure against');
  assert.strictEqual(ctx.UI.dueState(past, {}), null, 'with neither anchor it claims nothing');
  // The other anchor still works on its own, so "no today" disables overdue
  // rather than the whole cell.
  assert.strictEqual(ctx.UI.dueState({ ...past, dueDate: '2026-10-14' }, { sprintEnd: '2026-09-30' }), 'late');
});

/* ── EDITING THE DUE DATE ─────────────────────────────────────────────── */

check('THE DUE DATE IS EDITABLE ON AN OPEN SPRINT, as a real date input', async () => {
  /* `type="date"` specifically: its value is YYYY-MM-DD whatever the locale
     displays, which is what Jira stores — so no format is guessed at anywhere
     between the keyboard and the API. A free-text box would send "03/04/2026"
     and Jira would pick one of two months. */
  const { html, payload } = await renderHtml(OVERDUE_SNAP);
  const dated = payload.items.find(i => i.dueDate);
  const { inner } = dueCellOf(html, dated.key);
  assert.match(inner, /type="date"/, 'the due cell is not a date input');
  assert.match(inner, new RegExp(`data-edit-key="${dated.key}"`));
  assert.match(inner, /data-edit-field="due"/, 'the box does not say which field it writes');
  assert.match(inner, new RegExp(`data-was="${dated.dueDate}"`),
    'without the starting value the server cannot tell a stale edit from a fresh one');
});

check('A CLOSED SPRINT SHOWS THE DATE AND NO BOX', async () => {
  const { html } = await renderHtml(OVERDUE_SNAP, PLAN, { lock: { readOnly: true, reason: 'closed' } });
  const sec = itemsSection(html);
  assert.ok(!/data-edit-field="due"/.test(sec), 'a closed sprint still offered an editable due date');
  // ...and the date is still there, read-only rather than blank.
  assert.match(dueCellOf(html, 'D-5').inner, /st-overdue/, 'the read-only cell lost its warning');
});

check('CHANGING THE DATE SAVES IT TO JIRA, and says which field', async () => {
  const { payload, mount, puts } = await renderHtml(OVERDUE_SNAP);
  const item = payload.items.find(i => i.dueDate);
  mount.fire('change', {
    closest: (sel) => (sel.includes('data-edit-key')
      ? { dataset: { editKey: item.key, editField: 'due', was: item.dueDate }, value: '2026-11-02', disabled: false }
      : null),
  });
  await new Promise(r => setTimeout(r, 0));
  assert.strictEqual(puts.length, 1, 'the edit reached Jira zero times, or more than once');
  assert.strictEqual(puts[0].url, '/api/sprint/duedate', 'it went to the points endpoint');
  assert.deepStrictEqual(puts[0].body,
    { teamId: 'titan', sprintId: 'S40', key: item.key, dueDate: '2026-11-02', was: item.dueDate });
});

check('CLEARING THE DATE IS A REAL EDIT, sent as null', async () => {
  // "No deadline" and "a deadline nobody typed" are the same thing to Jira and
  // different things to a reader, so clearing has to travel rather than be
  // dropped as an empty string.
  const { payload, mount, puts } = await renderHtml(OVERDUE_SNAP);
  const item = payload.items.find(i => i.dueDate);
  mount.fire('change', {
    closest: () => ({ dataset: { editKey: item.key, editField: 'due', was: item.dueDate }, value: '', disabled: false }),
  });
  await new Promise(r => setTimeout(r, 0));
  assert.strictEqual(puts.length, 1);
  assert.strictEqual(puts[0].body.dueDate, null, 'clearing must send null, not an empty string');
});

check('A REFUSED DATE PUTS THE OLD ONE BACK', async () => {
  const { payload, mount } = await renderHtml(OVERDUE_SNAP, PLAN, { failSave: 'Jira refused the edit' });
  const item = payload.items.find(i => i.dueDate);
  const box = { dataset: { editKey: item.key, editField: 'due', was: item.dueDate }, value: '2026-11-02', disabled: false };
  mount.fire('change', { closest: () => box });
  await new Promise(r => setTimeout(r, 0));
  assert.strictEqual(box.value, item.dueDate, 'the refused date stayed on screen');
  assert.strictEqual(box.dataset.was, item.dueDate, 'a failed save moved the baseline');
  assert.strictEqual(box.disabled, false, 'the box was left disabled');
});

check('THE TWO FIELDS GO TO DIFFERENT ENDPOINTS FROM ONE HANDLER', async () => {
  /* One listener serves both, and the box says which field it is. The failure
     that costs real data is the two crossing — a date sent to the points
     route, or points to the date route — which would look like a save that
     did nothing. */
  const { payload, mount, puts } = await renderHtml(OVERDUE_SNAP);
  const item = payload.items.find(i => i.dueDate && i.points != null);
  mount.fire('change', { closest: () => ({ dataset: { editKey: item.key, editField: 'points', was: String(item.points) }, value: '21', disabled: false }) });
  mount.fire('change', { closest: () => ({ dataset: { editKey: item.key, editField: 'due', was: item.dueDate }, value: '2026-11-02', disabled: false }) });
  await new Promise(r => setTimeout(r, 0));
  assert.deepStrictEqual(puts.map(p => p.url), ['/api/sprint/points', '/api/sprint/duedate']);
  assert.strictEqual(puts[0].body.points, 21);
  assert.strictEqual(puts[1].body.dueDate, '2026-11-02');
});

check('AND A BOX NAMING AN UNKNOWN FIELD WRITES NOTHING', async () => {
  // The handler is keyed by what the box says it is. An unrecognised name must
  // do nothing rather than fall through to whichever endpoint is first.
  const { mount, puts } = await renderHtml(OVERDUE_SNAP);
  mount.fire('change', { closest: () => ({ dataset: { editKey: 'A-1', editField: 'summary', was: 'x' }, value: 'y', disabled: false }) });
  await new Promise(r => setTimeout(r, 0));
  assert.strictEqual(puts.length, 0, 'an unknown field was written to Jira');
});

/* ── THE COMPONENT NAME OPENS ITS WORK ITEMS ──────────────────────────── */

/** The href on a component name inside one section, or '' if it is plain text. */
const compHref = (section, component) => {
  const at = section.indexOf(`>${component}<`);
  if (at < 0) return null;
  const open = section.lastIndexOf('<', at);
  const tag = section.slice(open, at + 1);
  const m = /href="([^"]*)"/.exec(tag);
  return m ? m[1].replace(/&amp;/g, '&') : '';
};

check('BOTH COMPONENT TABLES LINK THE NAME TO JIRA', async () => {
  const { html, payload } = await renderHtml();
  for (const [where, section, rows, keysOf] of [
    ['Per-component progress', componentSection(html), payload.byComponent.rows, r => r.keys],
    ['Test cases by component', testCaseSection(html), payload.testCases.rows, r => r.keys.items],
  ]) {
    assert.ok(rows.length, `${where}: fixture check: no rows means this proves nothing`);
    for (const r of rows) {
      const href = compHref(section, r.component);
      assert.ok(href, `${where}: ${r.component} is not a link`);
      const jql = decodeURIComponent(href);
      for (const k of keysOf(r)) {
        assert.ok(jql.includes(k), `${where}: ${r.component} counted ${k} and the link does not open it`);
      }
    }
  }
});

check('THE LINK OPENS WHAT THE ROW COUNTED — by key, not by component name', async () => {
  /* `component = "X" AND sprint = N` is the obvious JQL and it is a SECOND
     query: the day it answers ten where the row says eleven, nothing on either
     side says which is wrong. The Backlog link was corrected for exactly this.
     So the test is that the URL names the KEYS and never the component. */
  const { html, payload } = await renderHtml();
  const section = componentSection(html);
  const row = payload.byComponent.rows.find(r => r.keys.length);
  assert.ok(row, 'fixture check: a component row has to have items');
  const jql = decodeURIComponent(compHref(section, row.component));
  assert.match(jql, /key in \(/, 'the link is not a key search');
  assert.ok(!jql.includes(`component = `), `the link queries the component name: ${jql}`);
  const listed = (/key in \(([^)]*)\)/.exec(jql) || [])[1].split(',').map(x => x.trim()).filter(Boolean);
  assert.deepStrictEqual(listed.slice().sort(), row.keys.slice().sort(),
    'the link opens a different set from the one the row counted');
});

check('THE TWO TABLES OPEN THE IDENTICAL LIST for the same component', async () => {
  // They are two views of one sprint. A component whose progress row and
  // test-case row opened different sets would be two answers to one question.
  const { html, payload } = await renderHtml();
  const prog = componentSection(html);
  const tc = testCaseSection(html);
  let compared = 0;
  for (const r of payload.testCases.rows) {
    const a = compHref(prog, r.component);
    const b = compHref(tc, r.component);
    if (a == null || b == null) continue;
    assert.strictEqual(a, b, `${r.component} opens two different lists`);
    compared++;
  }
  assert.ok(compared, 'fixture check: no component appears in both tables');
});

check('THE "NO COMPONENT" ROW LINKS TOO, which a JQL could not do', async () => {
  /* "— no component —" is a label this app invented, not a name in Jira: a
     query written from it matches nothing and reads as an empty suite. Keys
     have no such problem, which is half the reason the link is built from
     them. */
  const bare = {
    ...SNAP,
    issues: Object.fromEntries(Object.entries(SNAP.issues).map(([k, v]) => [k, { ...v, components: [] }])),
  };
  const { html, payload } = await renderHtml(bare);
  const row = payload.byComponent.rows[0];
  assert.match(row.component, /no component/i, 'fixture check: everything should be uncomponented here');
  const href = compHref(componentSection(html), row.component);
  assert.ok(href, 'the no-component row lost its link');
  assert.match(decodeURIComponent(href), /key in \(/);
});

check('THE NAME IS ESCAPED — a component name is not trusted markup', async () => {
  /* Component names are Jira data. One of his really does contain an
     ampersand (R&D_iGO_E2E), and the name now sits inside an anchor rather
     than a bare cell — so a quote ends the href's neighbours and a bracket
     ends the tag. The existing escaping check covers a `data-scope`
     attribute; this is the text node, which is a different hole.

     Called directly: the helper is pure, and putting a hostile name through
     the whole fixture to reach it would be a slower check of less. */
  const { ctx } = await renderHtml();
  const nasty = 'R&D_<img src=x onerror=alert(1)>_"odd"';
  const out = ctx.UI.componentLink(nasty, ['A-1']);
  assert.ok(!out.includes('<img'), `the name broke out of the anchor: ${out}`);
  assert.ok(out.includes('&amp;') && out.includes('&lt;img') && out.includes('&quot;odd&quot;'),
    `the name is not escaped: ${out}`);
  // ...and the ordinary case still reads as itself rather than as entities
  // nobody asked for.
  assert.match(ctx.UI.componentLink('PS_iGO_NLG', ['A-1']), />PS_iGO_NLG</);
});

check('AND WITHOUT A JIRA BASE THE NAME IS STILL THERE, just not a link', async () => {
  // A dead anchor that opens the Jira home page is worse than plain text: it
  // looks like the feature works.
  const { ctx, payload } = await renderHtml();
  ctx.UI.setJiraBase('');
  const row = payload.byComponent.rows[0];
  const out = ctx.UI.componentLink(row.component, row.keys);
  assert.ok(!out.includes('<a'), `an anchor was rendered with no Jira base: ${out}`);
  assert.ok(out.includes(row.component.replace(/&/g, '&amp;')), 'the name vanished with the link');
});

/* ── THE BLOCKED NUMBER, AND THE SET BEHIND IT ────────────────────────── */

/**
 * The KPI card with this label, cut out so a match cannot come from elsewhere.
 *
 * BOUNDED BY THE NEXT CARD, not by a closing tag. `</div></div>` only occurs
 * where two of them happen to be adjacent in the source, which in this markup
 * is hundreds of lines further down the page: the first version of this helper
 * handed back the KPI row, both cards under it and the Refinement note, so a
 * check for the wording on the Blocked card passed on wording that lives in a
 * different section entirely. A mutation that reverted the foot line to its old
 * text walked straight through it.
 */
const kpiCard = (html, label) => {
  const section = kpiStrip(html);
  const card = section.split('<div class="kpi ').find(c => c.includes(`>${label}</div>`));
  assert.ok(card, `no KPI labelled ${label}`);
  // The last card in the row has no next card to stop at, so bound it on the
  // row instead of on a closing tag and let the size assertion catch a slice
  // that has quietly swallowed the rest of the page.
  assert.ok(card.length < 1200, `the KPI slice ran past its card (${card.length} chars)`);
  return card;
};

check('EVERY KPI CARD CARRIES ITS OWN ACCENT CLASS, or the hues paint nothing', async () => {
  /* `UI.kpi` builds the class list, and dropping `accent` from it is a silent
     no-op: the strip renders, every number is the default colour, and the
     stylesheet is still full of rules that match no element. The CSS side is
     checked in links.test.js; this is the half that only shows up in markup. */
  const { html } = await renderHtml();
  const section = kpiStrip(html);
  const expected = {
    Capacity: 'capacity', Committed: 'committed', Done: 'done',
    'Sprint elapsed': 'elapsed', 'Projected landing': 'projected', Blocked: 'blocked',
  };
  for (const [label, accent] of Object.entries(expected)) {
    const card = section.split('<div class="kpi ').find(c => c.includes(`>${label}</div>`));
    assert.ok(card, `no KPI labelled ${label}`);
    assert.ok(card.slice(0, card.indexOf('>')).includes(`k-${accent}`),
      `${label} is not painted: ${card.slice(0, card.indexOf('>'))}`);
  }
  assert.match(section.slice(0, 40), /class="kpis[^"]*\baccented\b/,
    'the row does not opt in, so none of the rules apply to it');
});

check('THE BLOCKED KPI COUNTS THE REFINEMENT COLUMN, not "is blocked by" links', async () => {
  /* The reason this screen exists in its current form: on his sprints not one
     Story in Refinement carries a blocker of its own, so the old reading put a
     confident 0 above sixteen items nobody could start. R-4 is the fixture's
     proof — it names its OWN blocker and is in Refinement; N-1 sits under a
     blocked epic but is In Dev. Only the column decides. */
  const { html, payload } = await refined();
  const blocked = payload.progress.blocked;
  const refine = payload.items.filter(i => ctx0.inRefinement(i));
  assert.ok(refine.length >= 3, 'fixture check: several items have to be in Refinement');
  assert.deepStrictEqual(blocked.items.map(i => i.key).sort(), refine.map(i => i.key).sort(),
    'the KPI set is not the Refinement column');
  assert.ok(!blocked.items.some(i => i.key === 'N-1'),
    'an In Dev item under a blocked epic was counted');

  const card = kpiCard(html, 'Blocked');
  assert.match(card, /data-act="blocked"/, 'the number does not open anything');
  assert.match(card, new RegExp(`>${blocked.items.length}</button>`),
    `the card shows a different number from the payload: ${card}`);
  assert.match(card, /in Refinement/, 'the foot line still describes the old definition');
});

check('THE DRAWER LISTS EVERY ITEM THE NUMBER COUNTED, none dropped', async () => {
  // The one rule a drill-in cannot break: shorter than the number that opened
  // it. R-3 names nothing at all and is exactly the row a filter would eat.
  const { payload, ctx, mount } = await refined();
  let drawn = '';
  ctx.UI.drawer = (h) => { drawn = h; };
  mount.click('blocked');
  for (const i of payload.progress.blocked.items) {
    assert.ok(drawn.includes(i.key), `${i.key} is in the number but not in the drawer`);
  }
  assert.match(drawn, new RegExp(`Blocked — ${payload.progress.blocked.items.length} items`),
    `the heading disagrees with the KPI: ${drawn.slice(0, 200)}`);
});

check('and it says what each one is waiting on, or that nothing is recorded', async () => {
  const { ctx, mount } = await refined();
  let drawn = '';
  ctx.UI.drawer = (h) => { drawn = h; };
  mount.click('blocked');
  // R-1's epic names CLICMNTIGO-11567; R-3's names nothing.
  assert.match(drawn, /CLICMNTIGO-11567/, 'the blocker on the epic is not shown');
  assert.match(drawn, /No blocker recorded/,
    'an item with nothing behind it was shown as though it were held by a ticket');
  assert.match(drawn, /via/, 'the drawer does not say which epic carried the block');
});

check('A SPRINT WITH NOTHING IN REFINEMENT SHOWS A ZERO THAT DOES NOT OPEN', async () => {
  // `drillNumber` renders 0 as inert text, so this is really a check that the
  // fixture can reach the empty case at all — and that the card does not go
  // on advertising a drawer with nothing in it.
  const { html, payload } = await renderHtml();
  assert.strictEqual(payload.progress.blocked.count, 0,
    'the base fixture has something in Refinement — this check proves nothing');
  const card = kpiCard(html, 'Blocked');
  assert.ok(!/data-act="blocked"/.test(card), 'an empty Blocked number still offered a drawer');
  assert.match(card, />0</, 'the zero vanished instead of being shown');
});

/* ── editing Points, which writes to Jira ─────────────────────────────── */

/**
 * The one control in this app that changes somebody else's data.
 *
 * These checks are about the SCREEN's half of that: that the boxes appear only
 * when the sprint still accepts writes, that what they send names the issue the
 * user typed into, and that a refusal is visible rather than silently discarded.
 * The server's half — the read-before-write, the staleness 409 — is checked over
 * real HTTP against a stub Jira in points-write.test.js.
 */

const boxFor = (html, key) => {
  const at = html.indexOf(`data-edit-key="${key}"`);
  if (at < 0) return null;
  const from = html.lastIndexOf('<input', at);
  return html.slice(from, html.indexOf('>', at) + 1);
};

check('POINTS ARE EDITABLE ON AN OPEN SPRINT, carrying the value they started at', async () => {
  // `data-was` is not decoration: it is what the server compares against Jira
  // before it writes. A box that renders without it, or with the wrong value,
  // turns every save into either a false conflict or a silent overwrite.
  const { html, payload } = await renderHtml();
  const withPoints = payload.items.find(i => i.points != null);
  assert.ok(withPoints, 'fixture has no estimated item — this check proves nothing');
  const box = boxFor(html, withPoints.key);
  assert.ok(box, `no Points box for ${withPoints.key}`);
  assert.match(box, new RegExp(`data-was="${withPoints.points}"`),
    `the box would tell Jira it started at something else: ${box}`);
  assert.match(box, new RegExp(`value="${withPoints.points}"`));
});

check('A CLOSED SPRINT RENDERS NO POINTS BOXES, because the estimate is history', async () => {
  const { html, payload } = await renderHtml(SNAP, PLAN, { lock: { readOnly: true, reason: 'closed' } });
  assert.ok(payload.items.length, 'no items at all — the check is vacuous');
  assert.ok(!html.includes('data-edit-key'),
    'a closed sprint still offered editable estimates');
  // ...and the numbers are still THERE. Read-only is not blank.
  const withPoints = payload.items.find(i => i.points != null);
  assert.match(itemsSection(html), new RegExp(`>${withPoints.points}<`),
    'read-only dropped the numbers instead of just the inputs');
});

check('CHANGING A BOX SAVES THAT ISSUE, with the team and sprint on screen', async () => {
  const { payload, mount, puts } = await renderHtml();
  const item = payload.items.find(i => i.points != null);
  mount.fire('change', {
    closest: (sel) => (sel.includes('data-edit-key')
      ? { dataset: { editKey: item.key, editField: 'points', was: String(item.points) }, value: '13', disabled: false }
      : null),
  });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(puts.length, 1, 'the edit reached Jira zero times, or more than once');
  assert.equal(puts[0].url, '/api/sprint/points');
  assert.equal(puts[0].method, 'PUT');
  assert.deepStrictEqual(puts[0].body,
    { teamId: 'titan', sprintId: 'S40', key: item.key, points: 13, was: item.points });
});

check('A BOX THAT DID NOT CHANGE SAVES NOTHING, so a blur is not a write', async () => {
  const { payload, mount, puts } = await renderHtml();
  const item = payload.items.find(i => i.points != null);
  mount.fire('change', {
    closest: () => ({ dataset: { editKey: item.key, editField: 'points', was: String(item.points) },
      value: String(item.points), disabled: false }),
  });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(puts.length, 0, `tabbing through a box wrote to Jira: ${JSON.stringify(puts)}`);
});

check('A REFUSED SAVE PUTS THE OLD NUMBER BACK, rather than showing a lie', async () => {
  // The failure that matters is not the error: it is the box left showing the
  // number you typed, which reads exactly like a box that saved.
  const { payload, mount } = await renderHtml(SNAP, PLAN, { failSave: 'Jira refused the edit' });
  const item = payload.items.find(i => i.points != null);
  const box = { dataset: { editKey: item.key, editField: 'points', was: String(item.points) }, value: '99', disabled: false };
  mount.fire('change', { closest: () => box });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(box.value, String(item.points), 'the refused value stayed on screen');
  assert.equal(box.dataset.was, String(item.points), 'a failed save moved the baseline');
  assert.equal(box.disabled, false, 'the box was left disabled — the row is now unusable');
});

check('A CLOSED SPRINT WIRES NO SAVE HANDLER, belt as well as braces', async () => {
  // Not the same guarantee as "renders no boxes". Something else on the page
  // could carry `data-edit-key` one day; the handler must not be listening
  // at all when the sprint is shut.
  const open = await renderHtml();
  const shut = await renderHtml(SNAP, PLAN, { lock: { readOnly: true } });
  const item = open.payload.items.find(i => i.points != null);
  const target = { closest: () => ({ dataset: { editKey: item.key, editField: 'points', was: '1' }, value: '8', disabled: false }) };
  shut.mount.fire('change', target);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(shut.puts.length, 0, 'a closed sprint still saved an edit to Jira');
  // And the same event on an OPEN sprint does save — otherwise the line above
  // passes because `fire` reaches nothing on either screen.
  open.mount.fire('change', target);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(open.puts.length, 1, 'the harness cannot deliver a change event at all');
});

/* ── run ──────────────────────────────────────────────────────────────── */

(async () => {
  console.log('\nThe Active sprint screen, as rendered\n');
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();

/* ── THE "CANNOT BE STARTED" MARKER ───────────────────────────────────────
 *
 * The By-component sheet counts SUITES with work planned this sprint. It says
 * nothing about whether that work can begin — and on this board it often
 * cannot: the item is in Refinement, or its Automation Status reads Blocked.
 * "12 planned" and "12 planned, 5 of them stuck" are different sprints, and
 * only the first was ever on screen.
 *
 * The model checks live in by-component.test.js. These are about the RENDER:
 * that the marker is drawn where the data says it should be, that it is a
 * control a keyboard can reach, and that it is absent when nothing is stuck —
 * a warning that is always there is one nobody reads.
 */

/** Every PLANNED-column marker the sheet drew, as {row, tool, cell, n}.
    SCOPED TO `stuck-*`. The backlog columns now draw the same `!` — same
    class on purpose, so the two read as one idea — and a sweep that matched
    every `.stuck-mark` started failing here for a marker these checks were
    never about. The cell name is the honest discriminator. */
const marksIn = (html) => [...html.matchAll(/<button type="button" class="stuck-mark"[^>]*data-cell="stuck-[^"]*"[^>]*>/g)]
  .map(m => ({
    n: Number((m[0].match(/data-n="(\d+)"/) || [])[1]),
    row: (m[0].match(/data-row="([^"]*)"/) || [])[1],
    tool: (m[0].match(/data-tool="([^"]*)"/) || [])[1],
    cell: (m[0].match(/data-cell="([^"]*)"/) || [])[1],
  }));

check('A PLANNED NUMBER WITH BLOCKED WORK BEHIND IT CARRIES A MARKER', async () => {
  const r = await renderByComp();
  const bc = r.payload.byComponent;
  /* DRIVEN OFF THE PAYLOAD, not off a hand-written expectation. The sheet's
     own numbers decide where a marker belongs; a check asserting a fixed list
     would go stale the first time the fixture's sprint changed and would then
     be testing the fixture rather than the render. */
  const want = [];
  for (const row of bc.rows) {
    for (const t of bc.tools) {
      for (const col of bc.plannedCols) {
        const keys = ((row[t.key] || {}).stuck || {})[col.key] || [];
        if (keys.length) want.push({ row: row.component, tool: t.key, cell: `stuck-${col.key}`, n: keys.length });
      }
    }
  }
  const got = marksIn(r.html);
  assert.deepStrictEqual(
    got.slice().sort((a, b) => `${a.row}${a.tool}${a.cell}`.localeCompare(`${b.row}${b.tool}${b.cell}`)),
    want.slice().sort((a, b) => `${a.row}${a.tool}${a.cell}`.localeCompare(`${b.row}${b.tool}${b.cell}`)),
    'the markers drawn do not match the blocked work the sheet counted');
});

check('AND NO MARKER IS DRAWN WHERE NOTHING IS BLOCKED', async () => {
  /* The property that makes the marker worth having. One on every planned
     cell is furniture; the whole signal is that it is unusual. */
  const r = await renderByComp();
  const bc = r.payload.byComponent;
  const cells = bc.rows.length * bc.tools.length * bc.plannedCols.length;
  const marks = marksIn(r.html).length;
  assert.ok(marks < cells, `every one of the ${cells} planned cells drew a marker`);
  for (const m of marksIn(r.html)) {
    assert.ok(m.n > 0, `${m.row}/${m.tool}/${m.cell} drew a marker for zero blocked items`);
  }
});

check('THE MARKER CARRIES ITS OWN COUNT, because its text is "!"', async () => {
  /* The drawer compares what the cell SHOWED against what the route returns,
     so that a stale redraw is reported rather than silently papered over. It
     reads that number off the control's text — and this control's text is an
     exclamation mark, which scrapes to 0. Without `data-n` every open would
     announce that the sheet had changed since it was clicked. */
  const html = (await renderByComp()).html;
  const marks = [...html.matchAll(/<button type="button" class="stuck-mark"[^>]*data-cell="stuck-[^"]*"[^>]*>(.*?)<\/button>/g)];
  assert.ok(marks.length, 'fixture check: the sheet has at least one marker');
  for (const m of marks) {
    assert.strictEqual(m[1], '!', 'the marker is no longer an exclamation mark');
    assert.match(m[0], /data-n="\d+"/, 'the marker does not carry its count');
  }
});

check('IT IS A BUTTON A KEYBOARD CAN REACH, and it says what it opens', async () => {
  /* The same rule `UI.drillNumber` follows for the numbers it sits beside:
     this opens a list, so it is an action, and an action has to be reachable
     and announced. A styled <span> would be neither. */
  const html = (await renderByComp()).html;
  const marks = [...html.matchAll(/<button type="button" class="stuck-mark"[^>]*data-cell="stuck-[^"]*"[^>]*>/g)].map(m => m[0]);
  assert.ok(marks.length, 'fixture check');
  for (const m of marks) {
    assert.match(m, /aria-label="[^"]+"/, 'the marker has no accessible name');
    assert.match(m, /title="[^"]*Refinement[^"]*"/,
      'the tooltip does not say what "blocked" means here');
    assert.match(m, /data-act="bc-epics"/, 'the marker does not open the drill-in');
  }
});

check('AND THE ROW SAYS HOW MUCH OF ITS OWN PLAN IS STUCK', async () => {
  const r = await renderByComp();
  const bc = r.payload.byComponent;
  const html = r.html;
  for (const row of bc.rows.filter(x => x.stuck)) {
    assert.ok(html.includes(`>${row.stuck} blocked<`),
      `${row.component} has ${row.stuck} blocked planned items and no tag on the row`);
  }
  for (const row of bc.rows.filter(x => !x.stuck)) {
    const at = html.indexOf(`>${row.component}<`);
    if (at < 0) continue;
    const near = html.slice(at, at + 400);
    assert.ok(!/ blocked</.test(near), `${row.component} has nothing stuck and drew a tag anyway`);
  }
});

check('ONE BLOCKED ITEM REACHING A CELL TWICE IS COUNTED ONCE', async () => {
  /* B-1 maintains E-7 and E-10, both KSE suites on PS_MAINT_NLG. It is ONE
     Bucket Story sitting in Refinement. Recorded per epic without a guard it
     lands in that one cell twice, and the marker beside a number reading 2
     says 2 while the drawer behind it lists one row. */
  const r = await renderByComp();
  const row = r.payload.byComponent.rows.find(x => x.component === 'PS_MAINT_NLG');
  assert.ok(row, 'fixture check: the component is ranked');
  assert.deepStrictEqual(row.kse.stuck.maint, ['B-1'],
    `the KSE maintenance cell recorded ${JSON.stringify(row.kse.stuck.maint)} — it maintains two suites there, but it is one item`);
  assert.deepStrictEqual(row.truetest.stuck.maint, ['B-1'],
    'the TrueTest suite it also maintains did not get the marker');
});

check("AND THE ROW'S OWN COUNT IS DISTINCT ACROSS TOOLS", async () => {
  /* Same item, both tools. Summing the cells makes the row shout 2 about one
     blocked Bucket Story — and the row tag is the figure he reads first. */
  const r = await renderByComp();
  const row = r.payload.byComponent.rows.find(x => x.component === 'PS_MAINT_NLG');
  const summed = r.payload.byComponent.tools.reduce((n, tl) => n
    + row[tl.key].stuck.build.length + row[tl.key].stuck.maint.length, 0);
  assert.strictEqual(summed, 2, 'fixture check: the item has to reach both tools, or this proves nothing');
  assert.strictEqual(row.stuck, 1, `the row reports ${row.stuck} blocked items for one Bucket Story`);
  assert.ok(r.html.includes('>1 blocked<'), 'the row tag does not show the distinct count');
});

check('CLICKING A MARKER OPENS ITS OWN LIST, and does not cry stale', async () => {
  /* End to end. Two things at once: the drawer lists the blocked ITEMS
     rather than the epics the column counts, and it does not announce that
     the sheet has been redrawn — which it would on every single open if the
     count were scraped off the control's text, because that text is "!". */
  const r = await renderByComp();
  const row = r.payload.byComponent.rows.find(x => x.component === 'PS_MAINT_NLG');
  const n = row.kse.stuck.maint.length;
  assert.ok(n, 'fixture check: there is something to open');

  await r.mount.click({ act: 'bc-epics', row: 'PS_MAINT_NLG', tool: 'kse', cell: 'stuck-maint', n: String(n), __text: '!' });
  const d = r.mount.drawn;
  assert.ok(d, 'no drawer opened');
  for (const k of row.kse.stuck.maint) assert.ok(d.includes(k), `the drawer does not list ${k}`);
  assert.ok(!/redrawn since this was opened/.test(d),
    'the drawer claims the sheet changed — the count was read off the "!" instead of data-n');
  assert.ok(/Refinement/.test(d), 'the drawer does not say why these are blocked');
  assert.ok(!/epics\./.test(d), 'the drawer calls the planned items epics');
});

check('AND A STALE MARKER SAYS SO, which is the whole reason it carries a count', async () => {
  /* The drawer compares what the control SHOWED against what the route
     returns, so a sheet redrawn under the reader is reported rather than
     silently papered over. That comparison needs the marker's own count —
     and the marker's text is "!", which scrapes to 0. Zero reads as "no
     count given", so the warning would never fire: the failure is not a
     wrong message, it is a missing one, on the only occasion it matters.

     Driven by handing the click a count the route will disagree with, which
     is the one way to tell "compared and agreed" from "never compared". */
  const r = await renderByComp();
  await r.mount.click({ act: 'bc-epics', row: 'PS_MAINT_NLG', tool: 'kse', cell: 'stuck-maint', n: '99', __text: '!' });
  assert.match(r.mount.drawn, /The cell says 99/,
    'a marker showing a stale count opened its drawer without a word about it');
});
