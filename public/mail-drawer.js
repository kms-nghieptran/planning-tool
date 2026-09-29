/* global UI, App */
'use strict';
/**
 * mail-drawer.js — "Email the report", for whichever report you are on.
 *
 * ── WHY THIS IS SHARED RATHER THAN COPIED ────────────────────────────────
 *
 * This panel started inside the Coverage view, which was right while there
 * was one report to email. The Active Sprint report made that a choice
 * between two copies of the same four-hundred-line screen — and it would not
 * have stayed a copy. Every fix so far (the preview gate, the array/string
 * crash, the scope chip, the filename box, the weekly schedule) would have
 * had to be made twice, and the second one is the one nobody remembers.
 *
 * ── WHAT A HOST SCREEN SUPPLIES ──────────────────────────────────────────
 *
 * `MailDrawer.open(ctx)`:
 *   report      'coverage' | 'sprint' — decides the placeholder list, the
 *               figures, the page the PDF renders, and the default filename.
 *   team        the team id the report is about.
 *   scope       what narrows it: `{ components: [...] }` for coverage,
 *               `{ sprint: id }` for the sprint. Sent verbatim with every
 *               preview, send and PDF check, so the words and the attachment
 *               cannot end up answering different questions.
 *   scopeLabel  what that scope reads as, for the chip at the top.
 *   title       the heading, e.g. "Send Active Sprint".
 *
 * The drawer knows nothing else about its host, which is the point: a third
 * report is an entry in `REPORTS` on the server plus five fields here.
 */
const MailDrawer = (() => {


  /* ── EMAILING THE REPORT ──────────────────────────────────────────────
   *
   * Three things in one panel, in the order the decision is made: WHO gets
   * it, WHAT it says, and then — before anything happens — what that
   * actually reads like with this week's numbers in it.
   *
   * THE PREVIEW IS NOT OPTIONAL. This is the one control in the tool whose
   * output cannot be taken back, and the template holds placeholders that
   * resolve against live figures. Send is disabled until the preview for the
   * current wording has been fetched, so the mail that leaves is one he has
   * read. It is also the cheapest moment a typo can be caught: the preview
   * renders no PDF and opens no connection.
   */
  let mailState = { templates: [], cfg: null, editing: null, previewed: null, schedule: null };

  /**
   * THE BODY EVERY REQUEST SENDS — one shape, built once.
   *
   * The scope travels with the template on the preview, the send and the PDF
   * check alike. That is not tidiness: the last two bugs in this feature were
   * both one consumer receiving the scope and another not, so the words
   * described a subset while the attachment showed everything. One builder
   * means there is no second place to forget.
   */
  const payload = (ctx, extra = {}) => ({
    template: readForm(ctx),
    report: ctx.report || 'coverage',
    team: ctx.team || null,
    ...(ctx.scope || {}),
    ...extra,
  });

  async function openMail(ctx) {
    UI.drawer('<div class="empty">Reading the mail setup…</div>');
    try {
      /* THE SCHEDULE HISTORY IS FETCHED WITH THE REST, and its failure is not
         allowed to take the panel down with it. Sending is the job here;
         "what did last Monday do" is useful context beside it. A drawer that
         refused to open because a history query failed would block the one
         action that still works. */
      const [cfg, list, sched] = await Promise.all([
        /* THE FIELDS ARE THE REPORT'S OWN. Asking without saying which
           report would list coverage's placeholders on a sprint template —
           every one of which resolves to an em-dash there. */
        UI.api(`/api/mail/config?report=${encodeURIComponent(ctx.report || 'coverage')}`),
        UI.api('/api/mail/templates'),
        UI.api('/api/mail/schedule').catch(() => null),
      ]);
      mailState = { templates: list.templates || [], cfg, editing: null, previewed: null, schedule: sched };
    } catch (err) {
      UI.drawer(`<div class="empty">Could not read the mail setup — ${UI.esc(err.message)}</div>`);
      return;
    }
    drawMail(ctx);
  }

  /* NOT SET UP IS A SCREEN OF ITS OWN, and it says exactly what to put where.
     "Mail is not configured" with no further help is a dead end on a feature
     whose whole setup is four lines in a file he already has open. */
  function mailSetupHelp(c) {
    return `
      <div class="eyebrow"><i></i>Email the report</div>
      <h2 style="margin:6px 0 14px">Mail is not set up yet</h2>
      <p class="muted" style="font-size:13px;line-height:1.7">
        Open <strong>Integrations &amp; setup</strong> and fill in the <strong>Email</strong> card — mail server,
        your address, and an app password. There is a <em>Send a test to myself</em> button there that proves it
        works before a client is ever involved.
      </p>
      <p class="muted" style="font-size:12.5px;line-height:1.7">
        For a Google account the password must be an <strong>app password</strong>, not your normal one:
        turn on 2-Step Verification, then create one at
        <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a>.
      </p>
      ${c && !c.chrome ? '<p class="muted" style="font-size:12.5px">Google Chrome was also not found. It is what renders the PDF — install it, or set <code>CHROME_PATH</code>.</p>' : ''}
      <div class="btn-row">
        <a class="btn" href="#settings">Open Integrations &amp; setup</a>
        <button class="btn ghost" data-mail="close">Close</button>
      </div>`;
  }


  /**
   * A RECIPIENT LIST, WHATEVER SHAPE IT ARRIVED IN.
   *
   * Two legitimate sources feed this form and they disagree. A SAVED template
   * comes back from the server with `to` as an ARRAY — parsed, trimmed and
   * validated. The form itself produces a STRING, because that is what a text
   * box contains. `readForm()` hands the string version straight back into
   * `mailState.editing`, so the moment Preview or a keystroke redrew the
   * panel, `(t.to || []).join(', ')` ran against a string and the whole drawer
   * died with "join is not a function".
   *
   * NORMALISED WHERE IT IS RENDERED rather than where it is stored, because
   * both shapes are correct for their own source — forcing the form to keep
   * an array would mean re-splitting on every keystroke and fighting the
   * cursor. The render is the one place that has to cope with either.
   */
  const fieldText = (v) => {
    if (Array.isArray(v)) return v.join(', ');
    return v == null ? '' : String(v);
  };

  /**
   * THE EMPTY-BOX HINTS, PER REPORT.
   *
   * Placeholders are not decoration here: they are the worked example of what
   * a template looks like, and they were all written for the coverage report.
   * On the sprint panel that produced a subject hint quoting `{{coverage}}` —
   * a field that does not exist there — next to a field list that does not
   * include it. The first thing a new template does is get typed over that
   * hint, so a wrong one is a wrong template.
   */
  const HINTS = {
    coverage: {
      name: 'Weekly client report',
      subject: 'Automation coverage — {{team}} — {{date}}',
      body: "Hi,&#10;&#10;This week's automation coverage for {{team}} is {{coverage}}.&#10;&#10;The full report is attached.",
    },
    sprint: {
      name: 'Weekly sprint update',
      subject: '{{team}} — {{sprint}} — {{donepct}} complete',
      body: 'Hi,&#10;&#10;{{sprint}} is {{elapsed}} elapsed and {{done}} of {{committed}} points are done ({{donepct}} of the commitment).&#10;&#10;The full report is attached.',
    },
  };
  const hint = (ctx) => HINTS[(ctx && ctx.report) || 'coverage'] || HINTS.coverage;

  function templateForm(t, c, ctx) {
    const h = hint(ctx);
    /* `ph`, not `f`. The links guard forbids printing a `.key` without
       `UI.issueKey`, and rightly — but these are PLACEHOLDER names, not issue
       keys, and turning `{{team}}` into a Jira issue link would 404 with
       confidence.
       Naming the variable for what it holds keeps that guard tight instead of
       widening its allow-list for this one line. */
    const fields = (c.fields || []).map(ph => `<code title="${UI.esc(ph.label)}">{{${UI.esc(ph.key)}}}</code>`).join(' ');
    return `
      <div class="setting-row"><label>Template name</label><input type="text" id="mtName" value="${UI.esc(t.name || '')}" placeholder="${UI.esc(h.name)}"></div>
      <div class="setting-row"><label>To</label><input type="text" id="mtTo" value="${UI.esc(fieldText(t.to))}" placeholder="client@example.com, lead@example.com"></div>
      <div class="setting-row"><label>Cc</label><input type="text" id="mtCc" value="${UI.esc(fieldText(t.cc))}" placeholder="optional"></div>
      <div class="setting-row"><label>Subject</label><input type="text" id="mtSubject" value="${UI.esc(t.subject || '')}" placeholder="${UI.esc(h.subject)}"></div>
      <div class="setting-row" style="align-items:flex-start"><label>Body</label><textarea id="mtBody" rows="9" placeholder="${h.body}">${UI.esc(t.body || '')}</textarea></div>
      <div class="muted" style="font-size:12px;line-height:1.7;margin:-4px 0 12px">
        These are filled in when the mail is sent: ${fields}
      </div>
      <div class="setting-row"><label>Attach the PDF</label><input type="checkbox" id="mtAttach"${t.attachPdf === false ? '' : ' checked'}></div>
      ${t.attachPdf === false ? '' : `
        <div class="setting-row"><label>File name</label>
          <input type="text" id="mtFilename" value="${UI.esc(t.filename || '')}"
            placeholder="${UI.esc(defaultFilename(c, ctx))}"></div>
        <div class="muted" style="font-size:12px;line-height:1.7;margin:-4px 0 12px">
          ${/* THE ONE STRING THAT OUTLIVES THE EMAIL. The body is read once;
                this gets saved to a desktop and searched for six weeks later.
                Same placeholders as the subject, and `.pdf` is added if it is
                not typed — so the box is about the words, not the extension. */''}
          Leave it blank for <code>${UI.esc(defaultFilename(c, ctx))}</code>. The same placeholders work here,
          and <code>.pdf</code> is added for you.
        </div>`}
      ${scheduleForm(t, ctx)}`;
  }

  /* Kept in step with `report-mail.js` by a check in test/mail-api.test.js —
     it is shown as the placeholder, so the two drifting apart would promise
     him one filename on screen and attach another. */
  /* THE DEFAULT COMES FROM THE SERVER, per report — it is shown as the
     file-name placeholder, and a second copy here is a promise on screen that
     the send need not keep. `/api/mail/config` carries it. */
  const defaultFilename = (c, ctx) => {
    /* KEYED ON THE REPORT THE DRAWER IS OPEN FOR, not on whatever the config
       response happened to echo back. The two agree in practice; relying on
       the echo means a stale or cached config silently offers the other
       report's filename, and the box is a promise about the attachment. */
    const want = (ctx && ctx.report) || c.report || 'coverage';
    const r = (c.reports || []).find(x => x.key === want);
    return (r && r.defaultFilename) || 'Report - {{date}}';
  };

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /* A team id is not a thing to show a person. `App.state.teams` is the list
     the shell already holds, so the drawer names the team without a route of
     its own; an id falls through unchanged rather than rendering blank. */
  const teamName = (id) => {
    if (!id) return '';
    try {
      const t = (App.state.teams || []).find(x => x.id === id);
      return (t && (t.name || t.jiraName)) || id;
    } catch { return id; }
  };

  /**
   * THE WEEKLY SCHEDULE — only ever on a SAVED template.
   *
   * A schedule is a promise about a template that has to still exist next
   * Monday, so it cannot be attached to unsaved wording sitting in a text
   * box: the form would offer a day and a time, he would close the drawer,
   * and nothing would ever send. Rather than let that happen and explain it
   * afterwards, an unsaved template is told to save first — one sentence, in
   * the place the question comes up.
   */
  function scheduleForm(t, ctx) {
    if (!t.id) {
      return `<div class="muted" style="font-size:12px;line-height:1.6;margin:10px 0 0">
        Save this as a template to put it on a weekly schedule.
      </div>`;
    }
    const s = t.schedule || {};
    const on = !!s.enabled;
    const hh = String(s.hour == null ? 8 : s.hour).padStart(2, '0');
    const mm = String(s.minute == null ? 0 : s.minute).padStart(2, '0');
    return `
      <div class="setting-row" style="margin-top:14px">
        <label>Send it weekly</label>
        <input type="checkbox" id="mtSchedOn"${on ? ' checked' : ''}>
      </div>
      ${on ? `
        <div class="setting-row"><label>Every</label>
          <select id="mtSchedDay">
            ${DAYS.map((n, i) => `<option value="${i}"${i === (s.day == null ? 1 : s.day) ? ' selected' : ''}>${n}</option>`).join('')}
          </select>
        </div>
        <div class="setting-row"><label>At</label><input type="time" id="mtSchedTime" value="${hh}:${mm}"></div>
        ${/* WHAT THE WEEKLY SEND IS PINNED TO, on screen.
              An armed schedule fires with nobody watching, so it remembers the
              team and scope it was armed on — and that memory used to be
              invisible. A template carrying `team: "titan"` from the page it
              was first saved on quietly outranked the screen, and the only way
              to find out was to open the attachment. State that decides what a
              client receives has to be readable from here. */''}
        <div class="tag ${(s.team && ctx && s.team !== ctx.team) ? 'warn' : ''}"
          style="margin:-2px 0 10px;display:inline-block">
          Pinned to ${UI.esc(teamName(s.team) || 'this team')}${s.sprint ? ` · ${UI.esc(s.sprint)}` : ''}${(s.components || []).length ? ` · ${UI.esc(s.components.join(' + '))}` : ''}
        </div>
        ${(s.team && ctx && s.team !== ctx.team) ? `
          <div class="muted" style="font-size:12px;line-height:1.6;margin:-4px 0 12px">
            That is not the team on screen. Switch the schedule off and on again to re-pin it to
            ${UI.esc(teamName(ctx.team) || 'this team')}.
          </div>` : ''}
        <div class="muted" style="font-size:12px;line-height:1.7;margin:-2px 0 12px">
          ${/* SAID PLAINLY, because all three are surprises otherwise, and all
                three are discovered at the worst moment — the week it matters. */''}
          It sends on its own, with no preview, using whatever the figures say that morning.
          If your Mac is asleep at that time it goes out when the Mac wakes, as long as that is
          within 12 hours — after that the week is skipped rather than sending a stale report.
          <strong>The app has to be running.</strong>
        </div>
        ${mailState.schedule ? scheduleHistory(t.id) : ''}
      ` : ''}`;
  }

  /** What it has actually done — see the route note; an unattended feature needs a screen. */
  function scheduleHistory(id) {
    const row = (mailState.schedule.scheduled || []).find(x => x.id === id);
    if (!row) return '';
    const runs = row.runs || [];
    const tag = { sent: 'ok', failed: 'risk', missed: 'warn', sending: 'warn' };
    return `
      <div class="card" style="padding:10px 12px;margin:0 0 12px">
        <div style="font-size:12.5px"><strong>Next:</strong> ${UI.esc(new Date(row.nextRun).toLocaleString())}</div>
        ${runs.length ? `
          <div class="muted" style="font-size:12px;margin-top:8px">Recent</div>
          ${runs.map(r => `<div style="font-size:12px;margin-top:5px">
              <span class="tag ${tag[r.status] || ''}">${UI.esc(r.status)}</span>
              ${UI.esc(String(r.slot).replace('T', ' '))}
              ${r.detail ? `<span class="muted"> — ${UI.esc(r.detail)}</span>` : ''}
            </div>`).join('')}
        ` : '<div class="muted" style="font-size:12px;margin-top:6px">It has not fired yet.</div>'}
      </div>`;
  }

  /* ONLY THIS REPORT'S TEMPLATES. The list is one store shared by both
     screens, so without this the sprint page offers last quarter's coverage
     wording in its dropdown — pickable, and refused only at send time. A
     template that cannot be sent from here should not be offered here.
     Templates saved before report kinds existed have none, and they were all
     coverage templates; see `reportOf` on the server. */
  const mine = (ctx) => mailState.templates
    .filter(t => (t.report || 'coverage') === (ctx.report || 'coverage'));

  function drawMail(ctx) {
    const c = mailState.cfg || {};
    if (!c.configured) { UI.drawer(mailSetupHelp(c)); wireMail(ctx); return; }
    const list = mine(ctx);
    const t = mailState.editing || list[0] || { name: '', to: [], cc: [], subject: '', body: '', attachPdf: true };
    const p = mailState.previewed;
    UI.drawer(`
      <div class="eyebrow"><i></i>Email the report</div>
      <h2 style="margin:6px 0 4px">${UI.esc(ctx.title || 'Send the report')}</h2>
      <div class="muted" style="font-size:12.5px;margin-bottom:16px">
        From ${UI.esc(c.fromName ? `${c.fromName} <${c.from}>` : c.from)} · via ${UI.esc(c.host)}
        ${c.chrome ? '' : ' · <span class="tag warn">Chrome not found — the PDF cannot be rendered</span>'}
      </div>

      ${/* WHAT THIS MAIL IS ACTUALLY ABOUT, said before he writes a word of
            it. The figures and the attachment are both scoped to whatever is
            selected on the screen behind this drawer, and that selection is
            not visible from in here — so a report he believes is the whole
            portfolio, sent because he forgot two chips were still active, is
            a mistake this one line prevents. */''}
      <div class="tag ${ctx.scopeNarrow ? 'warn' : ''}" style="margin-bottom:14px;display:inline-block">
        ${UI.esc(ctx.scopeLabel || 'Everything')}
      </div>

      ${list.length ? `
        <div class="setting-row"><label>Template</label>
          <select id="mtPick">
            ${list.map(x => `<option value="${UI.esc(x.id)}"${x.id === t.id ? ' selected' : ''}>${UI.esc(x.name)}</option>`).join('')}
            <option value="">— new template —</option>
          </select>
        </div>` : ''}

      ${templateForm(t, c, ctx)}

      <div class="btn-row" style="margin-bottom:6px">
        <button class="btn ghost sm" data-mail="save">${t.id ? 'Save template' : 'Save as template'}</button>
        ${t.id ? '<button class="btn ghost sm" data-mail="delete">Delete template</button>' : ''}
        <span class="spacer"></span>
        ${/* THE OTHER HALF OF THE PREVIEW. "Preview" shows the words; this
              shows the DOCUMENT — the same render, in a tab, attached to
              nothing. The PDF was the only part of this feature that could
              not be checked without mailing a client to find out. */''}
        <button class="btn ghost sm" data-mail="pdf" title="Renders the attachment and opens it — sends nothing">Check the PDF</button>
        <button class="btn ghost sm" data-mail="preview">Preview</button>
      </div>

      ${p ? `
        <div class="card" style="margin-top:8px">
          <div class="eyebrow"><i></i>What they will read</div>
          <div style="font-size:12.5px;margin:8px 0"><strong>To:</strong> ${UI.esc(p.to.join(', '))}${p.cc.length ? ` · <strong>Cc:</strong> ${UI.esc(p.cc.join(', '))}` : ''}</div>
          <div style="font-size:13.5px;font-weight:600;margin-bottom:8px">${UI.esc(p.subject)}</div>
          <div style="font-size:13px;line-height:1.6;white-space:pre-wrap">${UI.esc(p.text)}</div>
          <div class="muted" style="font-size:12px;margin-top:10px">📎 ${UI.esc(p.attachmentName)}</div>
          ${(p.warnings || []).map(w => `<div class="tag warn" style="margin-top:8px">${UI.esc(w)}</div>`).join('')}
          ${(p.unknown || []).length ? `<div class="tag risk" style="margin-top:8px">Nothing will replace ${p.unknown.map(u => `{{${UI.esc(u)}}}`).join(', ')}</div>` : ''}
        </div>` : `
        <div class="empty" style="padding:14px;font-size:12.5px">
          Preview it before sending — the placeholders are filled from this week's figures, and this is the
          last cheap moment to notice a wrong one.
        </div>`}

      <div class="btn-row">
        ${/* DISABLED UNTIL PREVIEWED, and re-disabled by any edit. The one
              control here that cannot be undone should not be reachable from
              wording nobody has read. */''}
        <button class="btn" data-mail="send"${p ? '' : ' disabled'}>Render the PDF and send</button>
        <button class="btn ghost" data-mail="close">Cancel</button>
      </div>`);
    wireMail(ctx);
  }

  function readForm(ctx) {
    const v = (id) => { const n = UI.$(`#${id}`); return n ? n.value : ''; };
    const box = UI.$('#mtAttach');
    return {
      id: (mailState.editing && mailState.editing.id) || null,
      name: v('mtName'), to: v('mtTo'), cc: v('mtCc'),
      subject: v('mtSubject'), body: v('mtBody'),
      attachPdf: box ? !!box.checked : true,
      /* WHICH REPORT THIS TEMPLATE IS FOR. Stored with it, so a coverage
         template can never be opened on the sprint screen and sent with
         sprint figures behind coverage wording — the server refuses that by
         name, and this is what gives it something to refuse on. */
      report: ctx.report || 'coverage',
      /* THE BOX IS ONLY RENDERED WHEN THE PDF IS ATTACHED, so reading it
         blind would wipe a saved filename the moment he unticked and reticked
         the attachment. Falls back to what is already on the template, the
         same way the schedule does. */
      filename: UI.$('#mtFilename')
        ? v('mtFilename')
        : ((mailState.editing && mailState.editing.filename) || ''),
      schedule: readSchedule(ctx),
    };
  }

  /**
   * THE SCHEDULE OFF THE FORM — or the one already saved, when the form is
   * not showing it.
   *
   * The day and time inputs only exist while the checkbox is on, so reading
   * them blind returns nothing and SAVING WOULD SILENTLY WIPE a schedule the
   * moment he toggled it off and on, or saved from a redraw that had not
   * reached them yet. Falling back to what is already on the template keeps
   * every other Save on this panel — a subject fix, a new recipient — from
   * quietly disarming next Monday.
   */
  /**
   * THE WEEKLY SCHEDULE OFF THE FORM.
   *
   * ── WHAT A SCHEDULE MAY AND MAY NOT REMEMBER ─────────────────────────
   *
   * An ARMED schedule has to pin its team, components and sprint: it fires
   * with nobody watching and no screen to read a selection from, so without
   * the pin the Monday mail would report on whatever happened to be selected
   * when the app last started.
   *
   * A schedule that is switched OFF must pin NOTHING, and getting that wrong
   * cost him an afternoon. The old version wrote the current team into every
   * template it saved, armed or not, and then let that stored value win
   * forever — `saved.team || ctx.team`. So a template first saved while he
   * was on Titan's page carried `team: "titan"` with `enabled: false`, and
   * nothing on screen ever said so. His "Sprint report - RDA" had exactly
   * that, which is why checking it from Ruby's page rendered Titan's sprint.
   *
   * So: nothing is remembered while the schedule is off, and the pin is taken
   * from the screen at the moment it is ARMED. A pin only outranks the screen
   * if it was made while the schedule was already armed — which is the case
   * the pin exists for, and the only one.
   */
  function readSchedule(ctx) {
    const box = UI.$('#mtSchedOn');
    /* THE TEMPLATE THE PANEL IS SHOWING, which is not always the one being
       edited. `mailState.editing` is null until he touches a field, so
       reading only that saw NO schedule on first open — and an armed pin
       would then be recomputed from the current screen and silently moved the
       first time he saved anything. Same expression `drawMail` uses to pick
       `t`, so the form and this read can never be looking at different
       templates. */
    const shown = mailState.editing || mine(ctx)[0] || {};
    const saved = shown.schedule || {};
    const when = {
      day: saved.day == null ? 1 : saved.day,
      hour: saved.hour == null ? 8 : saved.hour,
      minute: saved.minute == null ? 0 : saved.minute,
    };
    /* THE CONTROLS ARE ONLY RENDERED WHILE THE SCHEDULE IS ON, so reading
       them blind would wipe an armed schedule on any save made from a redraw
       that had not reached them. */
    if (!box) return saved.enabled ? saved : { enabled: false, ...when };
    if (!box.checked) return { enabled: false, ...when };

    const day = UI.$('#mtSchedDay');
    const time = UI.$('#mtSchedTime');
    const [hh, mm] = String((time && time.value) || '08:00').split(':');
    /* A PIN ONLY SURVIVES IF IT WAS MADE WHILE ARMED. Otherwise it is a
       leftover from a screen he happened to be on, and the screen he is on
       NOW is the honest answer. */
    const pinned = saved.enabled ? saved : {};
    return {
      enabled: true,
      day: day ? Number(day.value) : when.day,
      hour: time ? Number(hh) : when.hour,
      minute: time ? Number(mm) : when.minute,
      team: pinned.team || (ctx && ctx.team) || null,
      components: Array.isArray(pinned.components) && pinned.components.length
        ? pinned.components
        : (((ctx || {}).scope || {}).components || []).slice(),
      /* THE SPRINT IS LEFT NULL unless one was pinned while armed. The server
         resolves a null to whichever sprint is running, and for a WEEKLY
         report that is what he means: Monday's mail is about the sprint
         running on Monday, not the one that was open when he armed it. */
      sprint: pinned.sprint || null,
    };
  }

  function wireMail(ctx) {
    const on = (sel, ev, fn) => UI.$$(sel).forEach(n => n.addEventListener(ev, fn));
    on('[data-mail="close"]', 'click', UI.closeDrawer);

    /* ANY EDIT INVALIDATES THE PREVIEW. Otherwise he previews, tweaks the
       subject, and sends wording nobody read — which is the exact failure the
       preview gate exists to prevent, arrived at one keystroke later. */
    /* THE ATTACHMENT CHECKBOX CHANGES WHICH FIELDS EXIST, so it has to redraw
       — the file-name box only makes sense while something is being
       attached. Not an edit to the wording, so the preview survives it. */
    on('#mtAttach', 'change', () => {
      mailState.editing = { ...(mailState.editing || {}), ...readForm(ctx) };
      drawMail(ctx);
    });

    on('#mtName, #mtTo, #mtCc, #mtSubject, #mtBody, #mtFilename', 'input', () => {
      if (!mailState.previewed) return;
      mailState.previewed = null;
      mailState.editing = { ...(mailState.editing || {}), ...readForm(ctx) };
      drawMail(ctx);
    });

    /* THE SCHEDULE CONTROLS ARE NOT AN EDIT TO THE WORDING, so toggling one
       redraws without clearing the preview. Turning on "send weekly" reveals
       the day and time, which has to redraw; treating that as an edit would
       throw away a preview he had just read and re-disable Send for a change
       that did not touch a single word of the message. */
    on('#mtSchedOn, #mtSchedDay, #mtSchedTime', 'change', () => {
      mailState.editing = { ...(mailState.editing || {}), ...readForm(ctx) };
      drawMail(ctx);
    });

    const pick = UI.$('#mtPick');
    if (pick) pick.addEventListener('change', () => {
      mailState.editing = mine(ctx).find(x => x.id === pick.value)
        || { name: '', to: [], cc: [], subject: '', body: '', attachPdf: true };
      mailState.previewed = null;
      drawMail(ctx);
    });

    on('[data-mail="pdf"]', 'click', () => {
      /* OPENED IN A TAB, not fetched and inspected here. The render takes
         real seconds and the answer is a document — a spinner in this drawer
         followed by "it worked" would be a worse version of looking at it.
         The route returns the failure as readable text for the same reason:
         whatever comes back, the tab is showing him the truth. */
      /* `ctx` AND ONLY `ctx` — never the schedule's pinned team.
         This button answers one question: is the attachment a SEND from this
         screen would produce right. A send uses `ctx`, so anything else here
         checks a different document and reports on it confidently.
         It used to read `readSchedule(ctx).team` first, and a template whose
         schedule still carried `team: "titan"` from the page it was first
         saved on rendered Titan's sprint while he sat on Ruby's — the exact
         failure the button exists to catch, produced by the button. */
      const params = new URLSearchParams({ landscape: '1' });
      params.set('report', ctx.report || 'coverage');
      if (ctx.team) params.set('team', ctx.team);
      const sc = ctx.scope || {};
      if (sc.sprint) params.set('sprint', sc.sprint);
      for (const c of (sc.components || [])) params.append('component', c);
      UI.toast('Rendering the PDF — this takes a few seconds');
      window.open(`/api/mail/preview-pdf?${params.toString()}`, '_blank');
    });

    on('[data-mail="preview"]', 'click', async () => {
      try {
        mailState.editing = readForm(ctx);
        const r = await UI.api('/api/mail/preview', {
          method: 'POST',
          body: JSON.stringify(payload(ctx)),
        });
        mailState.previewed = r;
        drawMail(ctx);
      } catch (err) { UI.toast(err.message, true); }
    });

    on('[data-mail="save"]', 'click', async () => {
      try {
        const r = await UI.api('/api/mail/template', { method: 'PUT', body: JSON.stringify(readForm(ctx)) });
        mailState.templates = r.templates || [];
        mailState.editing = mine(ctx).find(x => x.name === readForm(ctx).name) || mailState.editing;
        /* RE-READ AFTER SAVING, so "next send" appears the moment he arms it.
           Without this the schedule is live on the server and the panel still
           shows nothing until the drawer is reopened — which reads exactly
           like the setting not having taken. */
        mailState.schedule = await UI.api('/api/mail/schedule').catch(() => mailState.schedule);
        const armed = readSchedule(ctx);
        UI.toast(armed && armed.enabled
          ? `Template saved — sending every ${DAYS[armed.day]} at ${String(armed.hour).padStart(2, '0')}:${String(armed.minute).padStart(2, '0')}`
          : 'Template saved');
        drawMail(ctx);
      } catch (err) { UI.toast(err.message, true); }
    });

    on('[data-mail="delete"]', 'click', async () => {
      const t = mailState.editing || {};
      if (!t.id || !confirm(`Delete the template "${t.name}"? This cannot be undone.`)) return;
      try {
        const r = await UI.api('/api/mail/template', { method: 'DELETE', body: JSON.stringify({ id: t.id }) });
        mailState.templates = r.templates || [];
        mailState.editing = null;
        mailState.previewed = null;
        UI.toast('Template deleted');
        drawMail(ctx);
      } catch (err) { UI.toast(err.message, true); }
    });

    on('[data-mail="send"]', 'click', async (e) => {
      const btn = e.target;
      if (btn.disabled) return;
      const p = mailState.previewed;
      if (!p) return;
      /* THE LAST CONFIRMATION NAMES THE RECIPIENTS. "Are you sure?" is a
         reflex click; "send to client@acme.com and two others" is a sentence
         somebody reads. */
      if (!confirm(`Send "${p.subject}" to ${p.to.join(', ')}${p.cc.length ? ` (cc ${p.cc.join(', ')})` : ''}?`)) return;
      btn.disabled = true;
      btn.textContent = 'Rendering and sending…';
      try {
        const r = await UI.api('/api/mail/send', {
          method: 'POST',
          body: JSON.stringify(payload(ctx)),
        });
        if (r.ok) { UI.closeDrawer(); UI.toast(`Sent to ${(r.recipients || []).length} recipient(s)`); }
        else { UI.toast(r.error || 'The send failed', true); btn.disabled = false; btn.textContent = 'Render the PDF and send'; }
      } catch (err) {
        UI.toast(err.message, true);
        btn.disabled = false;
        btn.textContent = 'Render the PDF and send';
      }
    });
  }
  /* THREE HANDLES FOR THE TEST HARNESS. `__readSchedule` is here because the
     pin it produces is invisible state that decides which team a client
     receives a report about — and the only other way to observe it is to save
     a template and read it back out of the database. */
  return { open: openMail, __fieldText: (v) => fieldText(v), __readSchedule: (ctx) => readSchedule(ctx) };
})();
