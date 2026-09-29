/* app.js — the shell: team context, sidebar navigation, routing, sync.

   Routes are `#section/sub`, e.g. `#sprints/active`, `#reports/automation`.
   The nav is built from ROUTES, so adding a view is one entry plus a view
   object — that is what "extendable" has to mean in practice. */

const App = (() => {

  /* Every route in one table: the nav, the breadcrumb and the router read it. */
  const ROUTES = [
    // Deliberately ABOVE the team sections and outside them: this is the one
    // screen that looks across every team at once, so scoping it to the team
    // picker would be the wrong shape.
    { id: 'search', label: 'Search work items', view: () => SearchView, global: true },
    { group: 'Team' },
    { id: 'team', label: 'Overview', view: () => TeamView },
    /* ABOVE BACKLOG. It is the shortlist the team works from — which suites
       matter and where each stands — so it belongs before the queue rather
       than under Reports with the readings of what already happened.

       TEAM-SCOPED, through the header picker like every other team screen.
       The priority and the note are still one per component — those are
       global judgements and editing one here changes it everywhere — but
       WHICH ranked components a team is carrying is a per-team question,
       answered by the Team field on the epics inside each component. The
       page keeps an "All teams" toggle for the portfolio reading. */
    { id: 'prioritization', label: 'Prioritization', view: () => PrioritizationView },
    { id: 'backlog', label: 'Backlog', view: () => BacklogView, count: s => (s.teamIndex[s.teamId] || {}).backlog },

    { group: 'Sprints' },
    { id: 'sprints/active', label: 'Active sprint', view: () => SprintView, dot: 'active', sprintScoped: true },
    { id: 'sprints/future', label: 'Future sprints', view: () => SprintsView, dot: 'future' },
    { id: 'sprints/closed', label: 'Closed sprints', view: () => SprintsView, dot: 'closed' },
    { id: 'sprints/capacity', label: 'Capacity planning', view: () => CapacityView, sprintScoped: true },
    { id: 'sprints/forecast', label: 'Forecast', view: () => ForecastView },

    { group: 'Reports' },
    { id: 'reports/delivery', label: 'Delivery metrics', view: () => DeliveryReport },
    // HIDDEN, NOT DELETED. Overall Coverage answers the same question with the
    // movement, backlog and attention sections this one never had, so it is off
    // the nav — but the route still resolves, so an old bookmark or a link in a
    // message opens the page instead of silently landing on Team.
    { id: 'reports/automation', label: 'Automation coverage', view: () => AutomationReport, hidden: true },
    { id: 'reports/coverage', label: 'Overall Coverage', view: () => CoverageReport },
    { id: 'risks', label: 'Risks', view: () => RisksView, sprintScoped: true },
    /* NOT sprintScoped, unlike Risks directly above — and the difference is
       the point. A risk is about a commitment and belongs to the sprint
       carrying it; a blocker outlives the sprint it was noticed in, and 496
       of this board's 543 blocked items are nowhere near one. The page has a
       sprint filter of its own for when the question really is about one. */
    { id: 'blockers', label: 'Blockers', view: () => BlockersView },

    { group: 'Data' },
    { id: 'sources', label: 'Data sources', view: () => SourcesView },
    // Global: an override belongs to an item, not to whichever team happens to
    // be selected, and the whole point of the screen is seeing all of them.
    { id: 'adjustments', label: 'Adjustments', view: () => AdjustmentsView, global: true },
    { id: 'fields', label: 'Jira fields', view: () => FieldsView, global: true },
    { id: 'settings', label: 'Integrations & setup', view: () => SettingsView },
  ];

  const state = {
    route: 'team',
    teamId: null, sprintId: null,
    teams: [], sprints: [], categories: {}, teamIndex: {},
    currentSprintByTeam: {}, jiraSprints: {},
  };

  const routeFor = (id) => ROUTES.find(r => r.id === id) || ROUTES.find(r => r.id === 'team');

  async function boot() {
    const stored = localStorage.getItem('pt-theme');
    document.documentElement.dataset.theme = stored
      || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

    // Applied here, before the first await, for the same reason the theme is:
    // wireShell() runs after /api/state comes back, so setting it there would
    // paint the sidebar open and shut it a beat later.
    if (localStorage.getItem('pt-nav') === 'collapsed') UI.$('.shell').classList.add('nav-collapsed');

    /* ── PRINT MODE ───────────────────────────────────────────────────
       Headless Chrome renders this page to the PDF that gets emailed, and it
       is the SAME page — same stylesheet, same numbers — asked for with
       `?print=1`. The body class hides the nav, the team picker and every
       button; `landscape=1` adds the same `@page` rule the on-screen Export
       PDF injects.

       READ FROM THE QUERY, NOT THE HASH, because the hash is the route and
       the two have to be independent — `?print=1#reports/coverage` has to
       mean "that page, stripped", not a route nothing recognises.

       WRAPPED, because this runs during boot. Print mode is a nicety; a
       browser without `URLSearchParams`, or a host that does not expose
       `location.search`, must still get the tool rather than a blank page
       and a console error.

       ── READ BEFORE THE SELECTION IS MADE, AND NEVER WRITTEN BACK ──────
       This block used to sit BELOW the two lines that choose the team and
       the sprint, and it applied the URL by writing localStorage. Both halves
       of that were wrong, and together they made the parameters do nothing at
       all: the selection had already been read from a localStorage that is
       empty in every render (the renderer gives Chrome a throwaway profile),
       so the page fell back to the first team on the list and the URL only
       took effect on a second boot that never happens. A sprint report for
       Titan arrived showing Ruby's sprint.

       It hid on the Coverage report because that page is scoped by component
       rather than by team, and the team name in the email text comes from the
       server, which had it right — so the only wrong thing was the part
       nobody could see without opening the attachment.

       WRITING localStorage WAS THE SECOND BUG, and it would have outlived the
       first: `?print=1&team=titan` is an ordinary URL, and opening one in his
       own browser would silently switch the team he had selected. Rendering a
       report must not change the reader's settings. */
    const q = (() => {
      try { return new URLSearchParams((location && location.search) || ''); } catch { return null; }
    })();
    const printing = !!(q && q.get('print') === '1');
    const asked = {
      team: printing ? (q.get('team') || null) : null,
      sprint: printing ? (q.get('sprint') || null) : null,
    };

    const s = await UI.api('/api/state');
    adopt(s);

    /* THE URL WINS, THEN THE LAST SELECTION, THEN THE FIRST TEAM — and an
       unknown id falls through to the same fallback a bad localStorage value
       gets, rather than rendering an empty page for a team that is not there. */
    state.teamId = asked.team || localStorage.getItem('pt-team') || (s.plan.teams[0] || {}).id;
    if (!s.plan.teams.some(t => t.id === state.teamId)) state.teamId = (s.plan.teams[0] || {}).id;

    /* WHEN A TEAM WAS NAMED AND A SPRINT WAS NOT, the fallback is THAT team's
       current sprint — not the global one, which belongs to whichever team
       the app would otherwise have opened on. Getting this wrong is the same
       bug one level down: the right team, somebody else's sprint. */
    const currentForTeam = (s.currentSprintByTeam || {})[state.teamId] || s.currentSprintId;
    state.sprintId = asked.sprint || localStorage.getItem('pt-sprint')
      || currentForTeam || (s.sprints[s.sprints.length - 1] || {}).id;
    if (!s.sprints.some(x => x.id === state.sprintId)) state.sprintId = currentForTeam;

    if (printing) {
      document.body.classList.add('print-mode');
      if (q.get('landscape') === '1') {
        const st = document.createElement('style');
        st.textContent = '@page { size: landscape; margin: 10mm; }';
        document.head.appendChild(st);
      }
    }
    state.route = location.hash.slice(1) || 'team';

    renderNav(); fillSelects(); updateSyncState(s); wireShell();
    await refresh();

    if (!s.sync.issues && state.route !== 'settings') {
      UI.toast('No Jira data yet — connect Jira in Integrations & setup', true);
    }
  }

  function adopt(s) {
    state.teams = s.plan.teams;
    state.sprints = s.sprints;
    state.categories = s.categories || state.categories;
    state.teamIndex = s.teamIndex || {};
    state.currentSprintId = s.currentSprintId;
    state.currentSprintByTeam = s.currentSprintByTeam || {};
    state.jiraSprints = s.jiraSprints || {};
    state.syncedAt = s.sync.syncedAt;
    state.estimation = s.sync.estimation || null;
    state.projectKey = (s.config && s.config.jira && s.config.jira.projectKey) || state.projectKey;
    // Set on EVERY adopt, not just at boot: changing the Jira URL in settings
    // re-fetches state, and a stale base would silently link to the old host.
    state.jiraBase = s.jiraBase || (s.config && s.config.jira && s.config.jira.baseUrl) || '';
    UI.setJiraBase(state.jiraBase);
    showStaleness(s.server);
  }

  /**
   * Say it out loud when the running server is older than the code on disk.
   *
   * Node caches modules at require time, so an instance left running through an
   * update keeps applying the old logic while the files say otherwise — which is
   * how a stale process silently rewrote a roster a cleanup had just fixed.
   */
  function showStaleness(info) {
    const el = UI.$('#staleBanner');
    if (!el) return;
    if (!info || !info.stale) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<div class="stale-banner">
      <strong>This server is running older code than the files on disk.</strong>
      Anything you do now uses the version loaded at startup, not the current one — stop the server and run
      <code>node server.js</code> again. Until then, results here may be silently out of date.
    </div>`;
  }

  /* ─────────────────────────── navigation ─────────────────────────── */

  function renderNav() {
    /* A hidden route is dropped here and nowhere else: `routeFor` still finds
       it, so the page stays reachable by URL. Filtering before the map also
       means a group whose every route is hidden does not leave a bare heading
       behind — see `visibleRoutes`. */
    UI.$('#nav').innerHTML = visibleRoutes().map(r => {
      if (r.group) return `<div class="group">${UI.esc(r.group)}</div>`;
      const count = r.count ? r.count(state) : null;
      const sub = r.id.includes('/') ? ' sub' : '';
      return `<a href="#${r.id}" data-route="${r.id}" class="${sub}${state.route === r.id ? ' active' : ''}">
        ${r.dot ? `<span class="dot ${r.dot}"></span>` : ''}
        <span>${UI.esc(r.label)}</span>
        ${count ? `<span class="count">${count}</span>` : ''}
      </a>`;
    }).join('');
  }

  function renderCrumbs() {
    const r = routeFor(state.route);
    const team = state.teams.find(t => t.id === state.teamId);
    const group = groupOf(state.route);
    const sprint = state.sprints.find(x => x.id === state.sprintId);
    const sprintName = sprint ? ((sprint.byTeam || {})[state.teamId] || {}).name || sprint.name : null;
    // A global view is not about the selected team, and a breadcrumb that says
    // otherwise would imply the results are scoped to it.
    UI.$('#crumbs').innerHTML = r.global ? `<b>${UI.esc(r.label)}</b> <span class="muted">across every team</span>` : [
      team ? `<b>${UI.esc(team.jiraName || team.name)}</b>` : '<b>No team</b>',
      group ? `<span class="sep">›</span><span>${UI.esc(group)}</span>` : '',
      `<span class="sep">›</span><b>${UI.esc(r.label)}</b>`,
      r.sprintScoped && sprintName ? `<span class="sep">·</span><span>${UI.esc(sprintName)}</span>` : '',
    ].join(' ');

    // The sprint picker only belongs on views that are about one sprint.
    UI.$('#sprintPicker').hidden = !r.sprintScoped;
  }

  /**
   * ROUTES minus the hidden ones, and minus any group heading left empty by
   * their removal.
   *
   * The second part matters: headings are positional entries in the same list,
   * so hiding the only route under one would print a heading with nothing
   * beneath it — which reads as a page that failed to load rather than one that
   * was never there.
   */
  function visibleRoutes() {
    const shown = ROUTES.filter(r => r.group || !r.hidden);
    return shown.filter((r, i) => {
      if (!r.group) return true;
      const next = shown[i + 1];
      return Boolean(next) && !next.group;
    });
  }

  function groupOf(id) {
    let g = null;
    for (const r of ROUTES) {
      if (r.group) g = r.group;
      else if (r.id === id) return g;
    }
    return null;
  }

  /* ─────────────────────────── context pickers ─────────────────────────── */

  /**
   * The team and sprint pickers.
   *
   * Both are type-to-search rather than native <select>s: the sprint list runs
   * to hundreds of entries across seven boards, and a browser's own type-ahead
   * only matches the FIRST characters of an option — useless when every sprint
   * begins "Katalon ".
   *
   * THE SPRINT LIST RESTS ON ACTIVE + FUTURE. Closed sprints are the bulk of
   * the list and almost never what you are reaching for, but they are exactly
   * what you want when you go looking. So they are marked `hidden`: out of the
   * resting list, found the moment you type. The note under the list says so,
   * because a list that silently omits most of its contents is a list you stop
   * trusting.
   */
  function fillSelects() {
    const teamHost = UI.$('#teamPicker');
    const sprintHost = UI.$('#sprintPicker');
    if (!state.teams.length) {
      teamHost.innerHTML = '<div class="muted" style="font-size:12px">— no teams yet —</div>';
      sprintHost.innerHTML = '<div class="muted" style="font-size:12px">— sync Jira first —</div>';
      return;
    }

    const team = state.teams.find(t => t.id === state.teamId);
    teamHost.innerHTML = UI.combo({
      id: 'teamSelect', label: 'Team',
      value: team ? (team.jiraName || team.name) : '',
      placeholder: `${state.teams.length} teams — type to search`,
      options: state.teams.map(t => ({
        value: t.id,
        label: t.jiraName || t.name,
        meta: (state.teamIndex[t.id] || {}).members ? `${state.teamIndex[t.id].members} people` : '',
        active: t.id === state.teamId,
      })),
    });
    UI.wireCombo(teamHost, 'teamSelect', (id) => {
      if (!id || id === state.teamId) return;
      state.teamId = id;
      localStorage.setItem('pt-team', id);
      const active = (state.currentSprintByTeam || {})[state.teamId];
      if (active) { state.sprintId = active; localStorage.setItem('pt-sprint', active); }
      fillSelects(); renderNav(); refresh();
    });

    // This team's own Jira sprints; local cadence guesses only when it has none.
    const mine = state.sprints.filter(sp => (sp.byTeam || {})[state.teamId]);
    const list = mine.length
      ? mine.concat(state.sprints.filter(sp => sp.id === state.sprintId && !(sp.byTeam || {})[state.teamId]))
      : state.sprints;

    const sorted = list.slice().sort(newestFirst);
    const current = sorted.find(sp => sp.id === state.sprintId);
    const stateOf = (sp) => ((sp.byTeam || {})[state.teamId] || {}).state;
    const restingCount = sorted.filter(sp => stateOf(sp) === 'active' || stateOf(sp) === 'future').length;
    const closedCount = sorted.length - restingCount;

    sprintHost.innerHTML = UI.combo({
      // The box grows to its own value: sprint names run to 27 characters
      // ("Katalon MoonStone Sprint 10") and a fixed box cut them off, so the
      // topbar told you which team's sprint you were on only if the name was
      // short enough.
      id: 'sprintSelect', label: 'Sprint', cls: 'inline', autosize: true,
      value: current ? sprintLabel(current, (current.byTeam || {})[state.teamId]) : '',
      placeholder: `${sorted.length} sprints — type to search`,
      note: closedCount ? `${closedCount} closed sprint${closedCount > 1 ? 's' : ''} — type to find them` : '',
      options: sorted.map(sp => {
        const t = (sp.byTeam || {})[state.teamId] || {};
        const tag = t.state === 'active' ? 'active' : t.state === 'closed' ? 'closed'
          : t.state === 'future' ? 'planned' : 'not in Jira';
        return {
          value: sp.id,
          label: sprintLabel(sp, t),
          meta: `${UI.date(t.start || sp.start)}–${UI.date(t.end || sp.end)}`,
          tag,
          // Everything that is not active or future rests out of sight. A
          // sprint with no Jira state is a local guess, and equally noisy.
          hidden: !(t.state === 'active' || t.state === 'future'),
          active: sp.id === state.sprintId,
        };
      }),
    });
    UI.wireCombo(sprintHost, 'sprintSelect', (id) => {
      if (!id || id === state.sprintId) return;
      state.sprintId = id;
      localStorage.setItem('pt-sprint', id);
      refresh();
    });
  }

  /** Most recent sprint first. Mirrors reconcile.compareSprints, reversed. */
  function newestFirst(a, b) {
    const ad = a.start || firstStart(a), bd = b.start || firstStart(b);
    if (ad && bd && ad !== bd) return ad < bd ? 1 : -1;
    if (a.number != null && b.number != null) return b.number - a.number;
    if (a.number != null) return 1;
    if (b.number != null) return -1;
    return String(b.id).localeCompare(String(a.id));
  }
  const firstStart = (s) => Object.values(s.byTeam || {}).map(t => t && t.start).filter(Boolean).sort()[0] || null;

  /** What to call a sprint on screen: its Jira name, or the calendar number. */
  function sprintLabel(sp, jira) {
    return (jira && jira.name) || sp.calendarName || sp.name
      || (sp.number != null ? `Sprint ${sp.number}` : sp.id);
  }

  function updateSyncState(s) {
    const el = UI.$('#syncState');
    if (!s.sync.syncedAt || !s.sync.issues) {
      el.innerHTML = '<span style="color:var(--warn)">Not synced — showing local setup</span>';
      el.title = 'Teams, sprints and the backlog are placeholders until Jira is connected and synced.';
      return;
    }
    const parts = [`Jira ${UI.ago(s.sync.syncedAt)}`, `${s.sync.issues} issues`];
    const sp = Object.values(s.jiraSprints || {}).reduce((a, b) => a + b, 0);
    if (sp) parts.push(`${sp} sprints`);
    if ((s.sync.verification || []).some(v => !v.ok)) parts.push('⚠ verify failed');
    el.textContent = parts.join(' · ');
    el.title = s.sync.watermark ? `Watermark: ${UI.dateTime(s.sync.watermark)}` : '';
  }

  /* ─────────────────────────── wiring ─────────────────────────── */

  function wireShell() {
    UI.$('#nav').addEventListener('click', e => {
      const a = e.target.closest('[data-route]');
      if (!a) return;
      e.preventDefault();
      go(a.dataset.route);
      UI.$('#sidebar').classList.remove('open');
    });

    // Team and sprint are wired by fillSelects(), which rebuilds both pickers.

    UI.$('#menuBtn').addEventListener('click', () => UI.$('#sidebar').classList.toggle('open'));

    /* COLLAPSING THE SIDEBAR.
     *
     * Remembered, because it is a working preference rather than a per-visit
     * choice: someone who works on a laptop with the nav shut wants it shut
     * tomorrow too, and re-collapsing it on every load is the kind of small
     * friction that makes a tool feel like it is not listening.
     *
     * The class itself is applied in boot(), before the first await, so the
     * layout never paints open and then shuts. This only binds the controls and
     * brings the button's labels into line with whatever boot() decided.
     */
    const shell = UI.$('.shell');
    const railBtn = UI.$('#railBtn');

    const setRail = (collapsed, remember = true) => {
      shell.classList.toggle('nav-collapsed', collapsed);
      railBtn.setAttribute('aria-expanded', String(!collapsed));
      railBtn.setAttribute('aria-label', collapsed ? 'Show navigation' : 'Hide navigation');
      railBtn.title = `${collapsed ? 'Show' : 'Hide'} navigation  ⌘B`;
      if (remember) localStorage.setItem('pt-nav', collapsed ? 'collapsed' : 'open');
    };

    setRail(shell.classList.contains('nav-collapsed'), false);
    railBtn.addEventListener('click', () => setRail(!shell.classList.contains('nav-collapsed')));

    // ⌘B / Ctrl+B, the shortcut every editor uses for this. Ignored while a
    // field has focus: this app is full of text inputs and a shortcut that
    // fires mid-search is worse than no shortcut.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'b' && e.key !== 'B') return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const t = e.target;
      if (t && /^(input|textarea|select)$/i.test(t.tagName || '')) return;
      e.preventDefault();
      setRail(!shell.classList.contains('nav-collapsed'));
    });

    UI.$('#themeBtn').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('pt-theme', next);
      refresh();
    });

    UI.$('#syncBtn').addEventListener('click', async () => {
      const btn = UI.$('#syncBtn');
      btn.disabled = true; btn.textContent = 'Syncing…';
      try {
        const r = await UI.jsonPost('/api/sync', { mode: 'incremental' });
        UI.toast(syncSummary(r));
        await reload(); await refresh();
      } catch (err) { UI.toast(err.message, true); }
      finally { btn.disabled = false; btn.textContent = 'Sync Jira'; }
    });

    UI.$('#drawerClose').addEventListener('click', UI.closeDrawer);
    UI.$('#drawer').addEventListener('click', e => { if (e.target.id === 'drawer') UI.closeDrawer(); });
    window.addEventListener('keydown', e => { if (e.key === 'Escape') UI.closeDrawer(); });
    window.addEventListener('hashchange', () => {
      const v = location.hash.slice(1);
      if (v && v !== state.route) { state.route = v; renderNav(); refresh(); }
    });
  }

  function go(route) {
    state.route = route;
    location.hash = route;
    renderNav();
    refresh();
  }

  async function reload() {
    const s = await UI.api(`/api/state?team=${encodeURIComponent(state.teamId || '')}`);
    adopt(s);
    if (!s.sprints.some(x => x.id === state.sprintId)) state.sprintId = s.currentSprintId;
    fillSelects(); renderNav(); updateSyncState(s);
    return s;
  }

  function syncSummary(r) {
    const bits = [`${r.issues} issues`];
    if (r.removed) bits.push(`${r.removed} removed`);
    const rec = r.reconcile;
    if (rec) {
      if (rec.teams && rec.teams.created) bits.push(`${rec.teams.created} new team${rec.teams.created > 1 ? 's' : ''}`);
      if (rec.sprints.added) bits.push(`${rec.sprints.added} new sprint${rec.sprints.added > 1 ? 's' : ''}`);
      if (rec.members.added) bits.push(`${rec.members.added} member${rec.members.added > 1 ? 's' : ''} joined — check availability`);
      if (rec.members.linked) bits.push(`${rec.members.linked} linked to Jira`);
    }
    if (r.allVerified === false) bits.push('⚠ a dataset did not verify');
    return `Synced — ${bits.join(' · ')}`;
  }

  /**
   * Render the current route into a FRESH element every time.
   *
   * `#main` is one long-lived node. Several views wire their buttons with a
   * single delegated listener on the element they are handed — the normal
   * pattern — and replacing that element's innerHTML does NOT remove listeners
   * bound to the element itself. So every refresh added another listener, and
   * one click ran the handler once per render since the page loaded.
   *
   * It was visible on "Save current plan": three refreshes, one click, three
   * identical scenarios. Every other delegated action in those views was firing
   * repeatedly too — removing a person, applying a scenario, saving a note —
   * mostly invisibly, because doing the same idempotent thing twice looks like
   * doing it once.
   *
   * Handing each render its own container fixes the whole class rather than
   * this one symptom: whatever a view binds dies with the container it was
   * bound to. `display: contents` keeps the wrapper out of the layout entirely,
   * so `main`'s padding and max-width apply to the view's own sections exactly
   * as before.
   */
  /**
   * Re-render the current view WITHOUT the page going away first.
   *
   * It used to replace `#main` with "Loading…" and only then await the render.
   * Every saved leave cell, every priority set from a dropdown, every chip
   * added in Settings tore the screen down and rebuilt it — the page jumped to
   * the top, and for a moment there was nothing on it. For a change to one
   * cell that reads as the app reloading itself.
   *
   * So the new view is built into a DETACHED node while the old one stays on
   * screen, and the two are swapped in one go when it is ready. No view
   * measures layout during render — checked — so building off-document is
   * safe, and `UI.api` is already showing the busy bar for the fetches this
   * render makes. The scroll position is put back because the swap replaces
   * the element the page was scrolled within.
   *
   * THE FIRST PAINT IS THE EXCEPTION: there is nothing to keep, so it still
   * shows the loading state rather than an empty frame.
   */
  async function refresh() {
    renderCrumbs();
    const host = UI.$('#main');
    const hasContent = host.childElementCount > 0 && !host.querySelector('.loading');

    const mount = document.createElement('div');
    mount.style.display = 'contents';
    if (!hasContent) {
      mount.innerHTML = '<div class="loading">Loading…</div>';
      host.replaceChildren(mount);
    } else {
      // Held back, not hidden: what he was reading stays readable while the
      // new one is built behind it.
      UI.busy(true);
    }

    const y = window.scrollY;
    const r = routeFor(state.route);
    /* THE SIGNAL THE PDF RENDERER WAITS FOR.
     *
     * Headless Chrome has no way of knowing when a single-page app has
     * finished: the document is `complete` while the screen is still empty,
     * and every heuristic for "looks done" is a guess. The previous renderer
     * guessed with `--virtual-time-budget`, which waits for the network to go
     * quiet — and hung for sixty seconds when it did not, producing a PDF of
     * nothing or no PDF at all.
     *
     * So the page says so itself, here, at the one place every view in the
     * tool passes through. Written in `finally` and carrying the OUTCOME, not
     * just the fact of finishing: a view that threw has still stopped
     * rendering, and the renderer needs to hear "this failed" rather than
     * wait out its timeout and report something vaguer. */
    let outcome = 'ok';
    try {
      await r.view().render(state, mount, r);
      if (hasContent) {
        host.replaceChildren(mount);
        window.scrollTo(0, y);
      }
      // Every grid on every screen becomes sortable here, once, rather than in
      // fifteen views that would each do it slightly differently. It binds to
      // the per-render container, so it goes when the render goes.
      UI.sortable(mount);
    } catch (err) {
      outcome = 'error';
      host.innerHTML = `
        <div class="card">
          <h3>Could not render this view</h3>
          <p style="font-size:13px;color:var(--app-fg-2)">${UI.esc(err.message)}</p>
          <p class="muted" style="font-size:12px">The local data is intact — check the connection in Integrations &amp; setup.</p>
        </div>`;
      console.error(err);
    } finally {
      if (hasContent) UI.busy(false);
      /* Wrapped: this is a diagnostic aid, and a host that dislikes `dataset`
         must not be able to turn a rendered screen into a blank one. */
      try {
        document.body.dataset.ptRendered = outcome;
        document.body.dataset.ptRoute = state.route;
      } catch { /* the screen is drawn either way */ }
    }
  }

  return { boot, refresh, reload, go, state, ROUTES, sprintLabel, newestFirst };
})();

App.boot();
