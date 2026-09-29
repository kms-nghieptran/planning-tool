'use strict';
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
function fill(text, report = {}, kind = DEFAULT_REPORT) {
  const used = [];
  const unknown = [];
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
    if (!used.includes(f.key)) used.push(f.key);
    const v = f.of(report);
    return v == null ? '' : String(v);
  });
  return { text: out, used, unknown };
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
function compose(template, report, { from, fromName, attachment = null } = {}) {
  /* THE TEMPLATE'S OWN KIND decides which placeholders resolve, so a coverage
     template composed against sprint figures produces `{{coverage}}` as
     written rather than a number lifted from the wrong report. */
  const kind = (template && template.report) || DEFAULT_REPORT;
  const subject = fill(template.subject, report, kind);
  const body = fill(template.body, report, kind);
  const sender = fromName ? `${fromName} <${mime.bare(from)}>` : from;
  return {
    subject: subject.text,
    text: body.text,
    from: sender,
    to: template.to || [],
    cc: template.cc || [],
    unknown: [...new Set([...subject.unknown, ...body.unknown])],
    used: [...new Set([...subject.used, ...body.used])],
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
  FIELDS, fill, validate, compose, figuresFrom, sprintFiguresFrom, pdfName, safeFilename, newId,
  DEFAULT_FILENAME, MAX_NAME, MAX_SUBJECT, MAX_BODY, MAX_RECIPIENTS, MAX_FILENAME,
};
