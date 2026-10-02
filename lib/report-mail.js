'use strict';
const crypto = require('node:crypto');
const mime = require('./mime');
const schedule = require('./mail-schedule');

/**
 * report-mail.js — what gets sent, to whom, and what the words say.
 *
 * The transport is `smtp.js` and the message is `mime.js`; this is the part
 * with his judgement in it: saved templates, who they go to, and the figures
 * the wording is allowed to quote.
 *
 * ── PLACEHOLDERS, AND WHY THEY ARE A CLOSED LIST ─────────────────────────
 *
 * A template says "Coverage is now {{coverage}}" and the tool fills it in at
 * send time. The tempting implementation is to expose the whole report
 * object and let the template reach into it — and that is how a client
 * receives an email containing `[object Object]`, or worse a figure from a
 * part of the payload that means something else.
 *
 * So the list below is closed, each entry is a function of the report, and
 * every one is documented on screen. A placeholder nobody defined is LEFT AS
 * IT IS rather than replaced with a blank: a client reading "Coverage is now
 * {{covrage}}" can see something went wrong, where "Coverage is now " reads
 * as a tool that lost the number.
 */

const pct = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : `${Math.round(Number(v) * 10) / 10}%`);
const int = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : String(Math.round(Number(v))));

/**
 * The fields EVERY report can quote, whatever it is about.
 *
 * `label` is what the editor lists; `of` reads the live report. Adding one is
 * deliberately a code change — these values go to clients.
 */
const COMMON = [
  { key: 'team', label: "The team's name", of: (r) => (r.teamName || '') },
  { key: 'date', label: "Today's date", of: (r) => new Date(r.today || Date.now()).toISOString().slice(0, 10) },
  { key: 'sender', label: 'Your name', of: (r) => (r.senderName || '') },
];

/**
 * ── ONE FIELD LIST PER REPORT, NOT ONE LIST FOR EVERYTHING ───────────────
 *
 * The obvious way to add the sprint report was to append its fields to the
 * coverage list and let every template see all of them. That is wrong for the
 * same reason the placeholder list is closed at all: a coverage template that
 * offers `{{committed}}` will eventually have somebody put it in a subject
 * line, and it resolves to an em-dash in front of a client. A field that
 * cannot mean anything here should not be offered here.
 *
 * So a template BELONGS TO A REPORT. The kind is stored on it, the editor
 * lists only that kind's fields, and the send refuses a template whose kind
 * does not match the report being sent — which is what stops last quarter's
 * coverage wording going out over sprint figures.
 *
 * Each kind also owns its PRINT ROUTE, because the attachment is the screen:
 * the coverage template attaches the Overall Coverage page, the sprint
 * template attaches Active Sprint for that sprint. Keeping the route beside
 * the fields means adding a third report is one entry here rather than a
 * change in the routes, the scheduler and the drawer.
 */
const REPORTS = {
  coverage: {
    key: 'coverage',
    label: 'Overall Coverage',
    route: 'reports/coverage',
    /* SCOPED BY COMPONENT. The picker on that screen narrows both the figures
       and the attachment; see `reportUrl`. */
    scope: 'components',
    defaultFilename: 'Automation Delivery Dashboard - {{date}}',
    fields: [
      ...COMMON,
      { key: 'coverage', label: 'Overall coverage %', of: (r) => pct(r.coveragePct) },
      { key: 'automated', label: 'Automated suites', of: (r) => int(r.automated) },
      { key: 'automatable', label: 'Automatable suites', of: (r) => int(r.automatable) },
      { key: 'ready', label: 'Ready for automation', of: (r) => int(r.ready) },
      { key: 'blocked', label: 'Blocked suites', of: (r) => int(r.blocked) },
      { key: 'sprint', label: 'The selected sprint', of: (r) => (r.sprintLabel || '') },
      /* ── THE ONE PLACEHOLDER THAT IS NOT A NUMBER ──────────────────────
         Every other field resolves to a few characters that read the same in
         both halves of the email. This one resolves to a PICTURE in the HTML
         half and cannot exist in the plain-text half at all, so it carries two
         renderings and `compose` picks per part.

         `inline` is what marks it. It is read in exactly two places — here and
         in `compose` — and it is what stops the chart being treated as an
         ordinary string and pasted, base64 and all, into a text/plain part. */
      {
        key: 'chart',
        label: 'The Backlog chart, as a picture',
        inline: 'chart',
        /* THE PLAIN-TEXT HALF. Not the empty string: a reader whose client
           shows text only would otherwise find a sentence introducing a chart
           and then nothing, and conclude the email was broken. */
        of: () => '[Backlog chart — shown in the HTML version of this email]',
      },
    ],
  },
  sprint: {
    key: 'sprint',
    label: 'Active Sprint',
    route: 'sprints/active',
    /* SCOPED BY SPRINT, not by component — which is why `scope` exists rather
       than every caller assuming components. */
    scope: 'sprint',
    defaultFilename: 'Sprint Report - {{sprint}} - {{date}}',
    /* THESE ARE THE KPI STRIP, in the order it reads on screen. Taken from
       the numbers the page already shows rather than invented for the email,
       so a client quoting the mail back at him is quoting the same figure he
       is looking at. */
    fields: [
      ...COMMON,
      { key: 'sprint', label: 'Sprint name', of: (r) => (r.sprintLabel || '') },
      { key: 'capacity', label: 'Capacity (pts)', of: (r) => int(r.capacity) },
      { key: 'committed', label: 'Committed (pts)', of: (r) => int(r.committed) },
      { key: 'done', label: 'Done (pts)', of: (r) => int(r.done) },
      { key: 'donepct', label: 'Done, % of commitment', of: (r) => pct(r.donePct) },
      { key: 'remaining', label: 'Remaining (pts)', of: (r) => int(r.remaining) },
      { key: 'elapsed', label: 'Sprint elapsed %', of: (r) => pct(r.timeElapsedPct) },
      { key: 'day', label: 'Day N of the sprint', of: (r) => int(r.elapsedDays) },
      { key: 'workingdays', label: 'Working days in the sprint', of: (r) => int(r.workingDays) },
      { key: 'projected', label: 'Projected landing (pts)', of: (r) => int(r.projected) },
      { key: 'items', label: 'Items committed', of: (r) => int(r.items) },
      { key: 'blocked', label: 'Blocked items', of: (r) => int(r.blockedCount) },
      { key: 'blockedpoints', label: 'Blocked (pts)', of: (r) => int(r.blockedPoints) },
      { key: 'health', label: 'Sprint health (RAG)', of: (r) => (r.health || '') },
    ],
  },
  capacity: {
    key: 'capacity',
    label: 'Capacity planning',
    route: 'sprints/capacity',
    scope: 'sprint',
    defaultFilename: 'Capacity Plan - {{sprint}} - {{date}}',
    /* THE KPI STRIP AND THE BALANCE LINE, in the order the page reads. This
       report answers a different question from the sprint one — "can the team
       take this on", not "how is it going" — so it quotes capacity, load and
       who is over, and does NOT offer `done` or `projected`. Overlapping the
       two lists would let a template drift between the reports without
       anything looking wrong. */
    fields: [
      ...COMMON,
      { key: 'sprint', label: 'Sprint name', of: (r) => (r.sprintLabel || '') },
      { key: 'capacity', label: 'Capacity (pts)', of: (r) => int(r.capacity) },
      { key: 'capacityhours', label: 'Capacity (hours)', of: (r) => int(r.capacityHours) },
      { key: 'headcount', label: 'People on the sprint', of: (r) => int(r.headcount) },
      { key: 'committed', label: 'Committed (pts)', of: (r) => int(r.committed) },
      { key: 'headroom', label: 'Headroom (pts), negative if over', of: (r) => int(r.headroom) },
      { key: 'load', label: 'Team load %', of: (r) => pct(r.loadPct) },
      { key: 'delivered', label: 'Delivered (pts)', of: (r) => int(r.delivered) },
      { key: 'goal', label: 'Delivered, % of commitment', of: (r) => pct(r.goalPct) },
      { key: 'availabledays', label: 'Available days', of: (r) => int(r.availableDays) },
      { key: 'overloaded', label: 'People over the load target', of: (r) => int(r.overloaded) },
      { key: 'underloaded', label: 'People with unused capacity', of: (r) => int(r.underloaded) },
      { key: 'unassigned', label: 'Points with no assignee', of: (r) => int(r.unassignedPoints) },
    ],
  },
  delivery: {
    key: 'delivery',
    label: 'Delivery metrics',
    route: 'reports/delivery',
    /* SCOPED BY WINDOW — the fourth report, and the first whose scope is
       neither a sprint nor a set of components. "The last six sprints" and
       "the last twelve" are different reports with the same name, and an
       attachment rendered at a different window from the figures quoted
       beside it is the same failure the component scope exists to prevent,
       one dimension over. */
    scope: 'window',
    defaultFilename: 'Delivery Metrics - {{team}} - {{date}}',
    /* THE NUMBERS THIS PAGE IS FOR: how much the team delivers, how much that
       can be trusted, and whether it lands what it said. Deliberately NOT
       offering per-sprint or per-person figures — a placeholder resolving to
       one person's velocity in an email to a client is a number nobody should
       be able to put there by accident. */
    fields: [
      ...COMMON,
      { key: 'window', label: 'Sprints in the window', of: (r) => int(r.windowSprints) },
      { key: 'velocity', label: 'Average velocity (pts)', of: (r) => int(r.velocity) },
      { key: 'safe', label: 'Safe commitment (pts)', of: (r) => int(r.safeCommitment) },
      { key: 'predictability', label: 'Predictability %', of: (r) => pct(r.predictabilityPct) },
      { key: 'best', label: 'Best sprint (pts)', of: (r) => int(r.best) },
      { key: 'worst', label: 'Worst sprint (pts)', of: (r) => int(r.worst) },
      { key: 'attainment', label: 'Commitment attainment %', of: (r) => pct(r.attainment) },
      { key: 'missed', label: 'Sprints that landed under 90%', of: (r) => int(r.missedSprints) },
      { key: 'carryover', label: 'Average carryover %', of: (r) => pct(r.avgCarryoverPct) },
      { key: 'rework', label: 'Rework share %', of: (r) => pct(r.reworkShare) },
      { key: 'unestimated', label: 'Unestimated commitments %', of: (r) => pct(r.unestimatedPct) },
      { key: 'defects', label: 'Open defects', of: (r) => int(r.openDefects) },
      { key: 'passrate', label: 'Suite pass rate %', of: (r) => pct(r.passRate) },
    ],
  },
};

const DEFAULT_REPORT = 'coverage';

/**
 * Which report a template belongs to.
 *
 * ANYTHING UNRECOGNISED BECOMES COVERAGE, and that is not laziness — it is
 * the migration. Every template saved before this existed has no kind at all,
 * and they were all coverage templates. Defaulting them anywhere else, or
 * refusing them, would break the one thing he already had working.
 */
const reportOf = (kind) => REPORTS[String(kind || '').trim().toLowerCase()] || REPORTS[DEFAULT_REPORT];

/** The fields that report may quote. */
const fieldsFor = (kind) => reportOf(kind).fields;

/* Kept for callers written before there was more than one report. Coverage's
   list, which is what `FIELDS` has always meant. */
const FIELDS = REPORTS[DEFAULT_REPORT].fields;

/** `{{key}}`, with optional spaces, and nothing else. */
const TOKEN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Fill a template's text from the report.
 *
 * UNKNOWN TOKENS SURVIVE UNTOUCHED, and that is the point — see the note
 * above. `used` and `unknown` come back so the preview can say which is
 * which before anything is sent, which is the only moment a typo is cheap.
 */
function fill(text, report = {}, kind = DEFAULT_REPORT, { drop = [], as = {} } = {}) {
  const used = [];
  const unknown = [];
  /* FIELDS THAT ARE REAL BUT NOT ALLOWED HERE. Not the same thing as unknown:
     `{{chart}}` in a subject line is a field that exists and cannot work in
     that position, so it is removed rather than printed, and named separately
     so the preview can explain which of the two happened. */
  const dropped = [];
  /* THE LIST IS THE REPORT'S OWN. `{{committed}}` in a coverage template is
     not a typo to be forgiven, it is a field that has no meaning there — so
     it comes back as UNKNOWN and survives into the text as written, which is
     what makes the preview say so before anybody sends it. */
  const FIELDS = fieldsFor(kind);
  const out = String(text == null ? '' : text).replace(TOKEN, (whole, key) => {
    /* MATCHED WITHOUT REGARD TO CASE. The list on screen is lower-case, but
       `{{Date}}` is what somebody writing a sentence actually types — and the
       old behaviour was to leave an unrecognised token exactly as written, so
       a client would have received a filename with a literal `{{Date}}` in
       it. Being strict here buys nothing: there is no second field called
       `Date` that this could be confused with. */
    const f = FIELDS.find(x => x.key.toLowerCase() === String(key).toLowerCase());
    if (!f) { if (!unknown.includes(key)) unknown.push(key); return whole; }
    if (drop.includes(f.key)) {
      if (!dropped.includes(f.key)) dropped.push(f.key);
      return '';
    }
    if (!used.includes(f.key)) used.push(f.key);
    /* `as` SUBSTITUTES A MARKER FOR THE FIELD'S OWN VALUE, for the one caller
       that fills the same body twice — once as text, once on its way to HTML —
       and must be certain the two passes differ in nothing else. */
    if (Object.prototype.hasOwnProperty.call(as, f.key)) return String(as[f.key]);
    const v = f.of(report);
    return v == null ? '' : String(v);
  });
  return { text: out, used, unknown, dropped };
}

/** The figures a template may quote, pulled off the Overall Coverage payload. */
function figuresFrom(view = {}, extra = {}) {
  const h = view.headline || view || {};
  return {
    teamName: extra.teamName || view.teamName || '',
    sprintLabel: extra.sprintLabel || '',
    senderName: extra.senderName || '',
    today: extra.today || Date.now(),
    coveragePct: h.coveragePct != null ? h.coveragePct : h.pct,
    automated: h.automated,
    automatable: h.automatable,
    ready: h.ready,
    blocked: h.blocked,
  };
}

/**
 * The same, off the Active Sprint payload.
 *
 * READ FROM THE VIEW THE SCREEN DRAWS, exactly as the coverage one is, and
 * for the identical reason: a mail telling a client "42 of 60 points done"
 * over an attachment showing something else is the worst failure this feature
 * has, because both numbers are defensible and nobody here would ever see
 * them side by side. `insights.activeSprintView` is the single source, and
 * these are its own fields renamed for the template, not recomputed.
 */
function sprintFiguresFrom(view = {}, extra = {}) {
  const p = view.progress || {};
  const w = view.window || {};
  const t = (view.totals || {});
  const blocked = p.blocked || {};
  return {
    teamName: extra.teamName || '',
    senderName: extra.senderName || '',
    today: extra.today || Date.now(),
    sprintLabel: extra.sprintLabel || (view.sprint && (view.sprint.name || view.sprint.id)) || '',
    capacity: t.predicted,
    committed: p.committed,
    done: p.done,
    donePct: p.donePct,
    remaining: p.remaining,
    timeElapsedPct: w.timeElapsedPct,
    elapsedDays: w.elapsed,
    workingDays: w.workingDays,
    projected: p.projected,
    items: Array.isArray(view.items) ? view.items.length : null,
    blockedCount: blocked.count,
    blockedPoints: blocked.points,
    /* THE RAG WORD, not the score. "Amber" is what belongs in a sentence to a
       client; a number out of 100 invites a question about the scale that
       nobody here wants to answer in an email. */
    health: (view.health && (view.health.rag || view.health.label)) || '',
  };
}

/**
 * The same, off the Capacity planning payload.
 *
 * READ FROM `insights.capacityView`, the call the screen itself makes. The
 * over- and under-loaded counts are derived from the row flags exactly as the
 * Balance card derives them — the same expression, not a second opinion about
 * what "overloaded" means, which is the way two screens come to disagree
 * about a number that has one definition.
 */
/**
 * The figures for Delivery metrics.
 *
 * Taken from the three blocks the screen already computes — velocity,
 * productivity, quality — rather than recomputed here, for the reason the
 * other three builders give: a mail quoting a number its own attachment does
 * not show is the one failure nobody inside the tool can catch, because both
 * halves look right on their own.
 */
function deliveryFiguresFrom(report = {}, extra = {}) {
  const v = report.velocity || {};
  const q = report.quality || {};
  const pred = v.predictability || {};
  return {
    teamName: extra.teamName || report.teamName || '',
    senderName: extra.senderName || '',
    today: extra.today || Date.now(),
    sprintLabel: '',
    windowSprints: Array.isArray(report.windowSprints) ? report.windowSprints.length : report.window,
    velocity: v.average,
    safeCommitment: v.safeCommitment,
    /* PREDICTABILITY IS A RATIO ON THE SCREEN AND A PERCENTAGE IN THE MAIL.
       `pred.mean` is delivered over committed as a fraction; every other
       percentage placeholder here is already 0-100, and shipping one of them
       as 0.87 would read as 0.87%. */
    predictabilityPct: pred.mean == null ? null : Math.round(pred.mean * 1000) / 10,
    best: v.best,
    worst: v.worst,
    attainment: q.attainment,
    missedSprints: q.missedSprints,
    avgCarryoverPct: q.avgCarryoverPct,
    reworkShare: q.reworkShare,
    unestimatedPct: (q.estimation || {}).pct,
    openDefects: (q.defects || {}).open,
    passRate: (q.suite || {}).passRate,
  };
}

function capacityFiguresFrom(view = {}, extra = {}) {
  const t = view.totals || {};
  const rows = Array.isArray(view.rows) ? view.rows : [];
  const has = (r, ...codes) => (r.flags || []).some(f => codes.includes(f.code));
  return {
    teamName: extra.teamName || view.teamName || '',
    senderName: extra.senderName || '',
    today: extra.today || Date.now(),
    sprintLabel: extra.sprintLabel || '',
    capacity: t.predicted,
    capacityHours: t.capacityHours,
    headcount: t.headcount,
    committed: t.planned,
    /* HEADROOM, SIGNED. `overBy` is positive when the team is OVER capacity,
       which is the opposite sense of the word on screen — the KPI reads "12
       pts of headroom" or "12 pts over capacity" depending on the sign. A
       placeholder that flipped that meaning would put "12 pts of headroom" in
       front of a client about a team that is twelve points underwater. */
    headroom: t.overBy == null ? null : -t.overBy,
    loadPct: t.workloadPct,
    delivered: t.actual,
    goalPct: t.goalPct,
    availableDays: t.availableDays,
    overloaded: rows.filter(r => has(r, 'overloaded')).length,
    underloaded: rows.filter(r => has(r, 'underloaded', 'unplanned')).length,
    unassignedPoints: (view.unassigned || {}).points,
  };
}

const MAX_NAME = 80;
const MAX_SUBJECT = 200;
const MAX_BODY = 20000;
/* A cap so a fat-fingered paste cannot try to send to four hundred people. */
const MAX_RECIPIENTS = 50;

/**
 * Check a template before it is stored.
 *
 * VALIDATED IN THE MODEL, not in the route, so the scheduler cannot store
 * something the screen would have refused. A schedule that fires at 8am on a
 * template with a broken address is the one failure nobody is watching.
 */
function validate(input = {}) {
  const errors = [];
  /* THE KIND IS SETTLED FIRST, because everything below is checked against
     it — which placeholders resolve, and which report the stored template may
     later be sent as. */
  const report = reportOf(input.report);
  const name = String(input.name == null ? '' : input.name).trim();
  if (!name) errors.push('A template needs a name.');
  if (name.length > MAX_NAME) errors.push(`The name is longer than ${MAX_NAME} characters.`);

  const subject = String(input.subject == null ? '' : input.subject).trim();
  if (!subject) errors.push('A template needs a subject line.');
  if (subject.length > MAX_SUBJECT) errors.push(`The subject is longer than ${MAX_SUBJECT} characters.`);

  const body = String(input.body == null ? '' : input.body);
  if (!body.trim()) errors.push('A template needs some words in the body.');
  if (body.length > MAX_BODY) errors.push(`The body is longer than ${MAX_BODY} characters.`);

  const to = mime.parseList(Array.isArray(input.to) ? input.to.join(',') : input.to);
  const cc = mime.parseList(Array.isArray(input.cc) ? input.cc.join(',') : input.cc);
  if (!to.length) errors.push('A template needs at least one recipient.');
  if (to.length + cc.length > MAX_RECIPIENTS) errors.push(`That is more than ${MAX_RECIPIENTS} recipients.`);
  const bad = [...to, ...cc].filter(a => !mime.isEmail(a));
  if (bad.length) errors.push(`These do not look like email addresses: ${bad.join(', ')}`);

  /* AN UNKNOWN PLACEHOLDER IS A WARNING, NOT AN ERROR. It is very often
     deliberate — a literal `{{` in prose — and refusing to save over it would
     be the tool arguing with him about his own words. It is reported so the
     preview can point at it. */
  const seen = [...fill(subject, {}, report.key).unknown, ...fill(body, {}, report.key).unknown,
    ...fill(String(input.filename || ''), {}, report.key).unknown];
  const warnings = seen.length
    ? [`Nothing will replace ${seen.map(s => `{{${s}}}`).join(', ')} — they will appear as written.`]
    : [];

  return {
    ok: !errors.length,
    errors,
    warnings,
    template: {
      id: String(input.id || '').trim() || null,
      name, subject, body, to, cc,
      /* WHICH REPORT THIS TEMPLATE IS FOR, resolved rather than echoed — so a
         template stored before report kinds existed comes back as `coverage`
         instead of `undefined`, and every reader downstream can rely on the
         field being there. */
      report: report.key,
      landscape: input.landscape !== false,
      attachPdf: input.attachPdf !== false,
      /* STORED AS HE TYPED IT, sanitised only when it becomes a real
         filename. Keeping the raw string means the box shows him back what he
         wrote rather than a scrubbed version of it, and the placeholders stay
         placeholders until the moment there are figures to fill them with.
         Blank means "use the default", which is why it is not defaulted
         here — a stored default would be indistinguishable from a choice, and
         he could never get back to automatic. */
      filename: String(input.filename == null ? '' : input.filename).trim().slice(0, MAX_FILENAME),
      /* THE SCHEDULE GOES THROUGH THE SAME GATE AS THE WORDS, which is the
         reason `validate` is called by the route that stores a template
         rather than only by the one that sends it. A schedule can only ever
         be attached to a template that already passed these checks, so the
         thing that fires at 8am on a Monday with nobody watching cannot be
         carrying an address that would have been refused on screen. */
      schedule: schedule.normalise(input.schedule),
    },
  };
}

/**
 * Compose the message for one send.
 *
 * SUBJECT AND BODY ARE FILLED FROM THE SAME REPORT, in one place, so the
 * preview he approved and the mail that goes out cannot differ — the preview
 * route and the send route both call this.
 */
/* THE CHART'S CONTENT-ID, in one place. The HTML says `cid:ptchart`, the MIME
   part says `Content-ID: <ptchart>`, and the two are the same agreement written
   twice — which is the classic way to ship a broken-image box to a client. */
const CHART_CID = 'ptchart';

/* A LINE THE SUBJECT MAY NOT CARRY. `{{chart}}` in a subject cannot be a
   picture — headers are text — and resolving it there to the plain-text
   substitute would put a literal "[Backlog chart — shown in the HTML version]"
   on the subject line of a client email. It is dropped instead, and reported as
   misplaced so the preview can say so before anybody sends it. */
const inlineKeys = (kind) => fieldsFor(kind).filter(f => f.inline).map(f => f.key);

/**
 * THE HTML HALF, BUILT FROM THE SAME FILLED BODY AS THE TEXT HALF.
 *
 * Not a second pass over the template: the two halves of an email that disagree
 * are worse than an email with one half. So the body is filled ONCE, with the
 * chart standing in as a marker no human would type, the whole thing is escaped
 * and paragraphed by the same function every other mail uses, and only then
 * does the marker become an `<img>`. Escaping after the tag was inserted would
 * turn it into visible angle brackets; inserting before escaping is how the
 * body becomes an injection point for anything in a template field.
 */
function chartHtml(cid, alt) {
  /* `max-width:100%` AND a width attribute. Clients that respect CSS scale it
     to the reading pane; the ones that do not — Outlook — read the attribute,
     and without it render the PNG at its full 1800px and put a horizontal
     scrollbar on the email. */
  return `<p style="margin:0 0 14px"><img src="cid:${cid}" alt="${mime.esc(alt)}"`
    + ' width="640" style="max-width:100%;height:auto;border:0;display:block"></p>';
}

function compose(template, report, { from, fromName, attachment = null, chart = null } = {}) {
  /* THE TEMPLATE'S OWN KIND decides which placeholders resolve, so a coverage
     template composed against sprint figures produces `{{coverage}}` as
     written rather than a number lifted from the wrong report. */
  const kind = (template && template.report) || DEFAULT_REPORT;
  const inlines = inlineKeys(kind);

  /* THE SUBJECT IS FILLED WITHOUT THEM. See `inlineKeys` — a picture cannot go
     in a header, and the substitute line must not either. */
  const subject = fill(template.subject, report, kind, { drop: inlines });
  const body = fill(template.body, report, kind);

  const wantsChart = body.used.some(k => inlines.includes(k));
  const misplaced = subject.dropped || [];

  let text = body.text;
  let html = null;
  if (wantsChart && chart && chart.content && chart.content.length) {
    /* A MARKER NOBODY WOULD TYPE, generated per message so a template quoting
       last week's email cannot contain one. */
    const mark = `ptchartmark${crypto.randomBytes(8).toString('hex')}`;
    const marked = fill(template.body, report, kind, { as: { [inlines[0]]: mark } });
    html = '<!doctype html><html><body style="font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a">\n'
      + mime.textToHtml(marked.text)
        /* The marker is alphanumeric, so escaping leaves it untouched and the
           paragraph it sits alone in becomes the picture's own paragraph. */
        .replace(new RegExp(`<p[^>]*>${mark}</p>`, 'g'), chartHtml(CHART_CID, 'Backlog chart'))
        .replace(new RegExp(mark, 'g'), chartHtml(CHART_CID, 'Backlog chart'))
      + '\n</body></html>';
  }

  const sender = fromName ? `${fromName} <${mime.bare(from)}>` : from;
  return {
    subject: subject.text,
    text,
    html,
    from: sender,
    to: template.to || [],
    cc: template.cc || [],
    unknown: [...new Set([...subject.unknown, ...body.unknown])],
    used: [...new Set([...subject.used, ...body.used])],
    /* WHAT THE CALLER HAS TO ACT ON. `wantsChart` says the body asked for a
       picture; whether one arrived is `html`. The send route needs both to
       decide between attaching the image, and telling him it could not. */
    wantsChart,
    misplaced,
    attachment,
  };
}

/**
 * THE NAME ON THE ATTACHMENT.
 *
 * This is the one string in the whole feature that outlives the email. The
 * body gets read once; the PDF gets saved to somebody's desktop, attached to
 * a reply, and found again in six weeks by searching for whatever it was
 * called. So it takes the same placeholders as the subject line, from the
 * same closed list, filled by the same function — a template that says
 * `{{team}}` in the subject and gets it in the filename too is the whole
 * point, and it would not survive two separate implementations.
 */
/* Each report names its own attachment — see `REPORTS` above. This is
   coverage's, kept under the old name for callers written before there was a
   second report to have an opinion. */
const DEFAULT_FILENAME = REPORTS[DEFAULT_REPORT].defaultFilename;
const MAX_FILENAME = 120;

/**
 * Turn whatever is in the box into something a filesystem will accept.
 *
 * FIVE THINGS ARE TAKEN OUT, and each one is a real way this breaks:
 *
 *   PATH SEPARATORS. `/` and `\` in an attachment name is how a malformed
 *   message ends up writing outside the folder the client saved it to. They
 *   never survive this function.
 *
 *   THE WINDOWS-ILLEGAL SET — `: * ? " < > |`. His clients are not all on a
 *   Mac, and a colon is exactly what a date or a time wants to contain. On
 *   Windows the save silently fails or the name is mangled.
 *
 *   CONTROL CHARACTERS, including the CR and LF that would otherwise be
 *   sitting inside a MIME header.
 *
 *   LEADING DOTS. `.pdf` as a whole filename is a hidden file on every Unix,
 *   and `..` is the other half of the traversal problem above.
 *
 *   LENGTH. Some filesystems stop at 255 bytes and a truncated name can lose
 *   its extension; 120 is far below any of them and still long enough for a
 *   team name and a date.
 *
 * AND ONE THING IS ADDED: the `.pdf`, if he did not type it. The template is
 * about the words, not the extension, and an attachment called
 * `Automation Delivery Dashboard - 2026-09-29` opens in nothing.
 */
function safeFilename(raw, fallback = 'report') {
  /* THE ORDER OF THESE IS NOT ARBITRARY. Stripping leading dots before the
     extension turns `.pdf` into `pdf`, which then gets an extension added and
     arrives as `pdf.pdf`. The extension comes off first, THEN the dots, and
     what is left decides whether the fallback is needed. */
  let s = String(raw == null ? '' : raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.pdf$/i, '')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (!s) s = fallback;
  if (s.length > MAX_FILENAME) s = s.slice(0, MAX_FILENAME).trim();
  return `${s}.pdf`;
}

/**
 * The filename for one send.
 *
 * @param {object} report    the figures, for the placeholders
 * @param {object} template  optional; `template.filename` overrides the default
 *
 * THE TEMPLATE ARGUMENT IS OPTIONAL and the default is a complete, sensible
 * name — so a template saved before this existed, and the `Check the PDF`
 * button which has no template at all, both still produce something a client
 * can file.
 */
function pdfName(report = {}, template = null) {
  const kind = reportOf(template && template.report);
  const wanted = (template && String(template.filename || '').trim()) || kind.defaultFilename;
  const filled = fill(wanted, report, kind.key).text;
  /* THE FALLBACK IS THE REPORT'S OWN NAME. If every placeholder in the
     template resolved to nothing, a sprint mail would otherwise arrive
     called "Automation Delivery Dashboard.pdf" — a coverage name on a sprint
     attachment, which is exactly the kind of quiet mismatch this whole split
     exists to prevent. */
  return safeFilename(filled, kind.label);
}

const newId = () => `mt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

module.exports = {
  REPORTS, DEFAULT_REPORT, reportOf, fieldsFor,
  FIELDS, fill, validate, compose, figuresFrom, sprintFiguresFrom, capacityFiguresFrom, deliveryFiguresFrom, pdfName, safeFilename, newId,
  DEFAULT_FILENAME, MAX_NAME, MAX_SUBJECT, MAX_BODY, MAX_RECIPIENTS, MAX_FILENAME,
  CHART_CID, chartHtml, inlineKeys,
};
