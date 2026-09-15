# Automation Planning Tool

Sprint planning for the Katalon automation teams — capacity, backlog, sprint
health, forecast, delivery metrics and automation coverage in one place, on the
KMS Technology design system.

It replaces the capacity spreadsheet rather than wrapping it: the same maths, the
same numbers, but the leave grid feeds the forecast, Jira fills in what was
committed and delivered, and the things that used to be noticed at sprint review
are flagged on day two.

---

## Run it

```bash
node server.js          # → http://localhost:4322
```

Node 20+. No `npm install` — zero dependencies, on purpose. macOS users can
double-click **Open Planning Tool.command**.

First launch seeds Ruby and Titan with real members, the sprint calendar and the
capacity constants read out of your sheet, so the app opens with content. Connect
Jira in **Settings** (or import a CSV) to fill in what is actually committed.

---

## The capacity model

Ported from the spreadsheet and verified against 16 member-rows of it
(`node test/capacity.test.js`):

```
AvailableDays = sum of the 14 day cells      1 = full, 0.5 = half, 0 / WO / H = none
Capacity(hrs) = max(0, AvailableDays × hoursPerDay × (1 − support%) − ceremonyHours)
Predicted(pts)= round(Capacity ÷ hoursPerPoint)
Workload(%)   = (Planned × hoursPerPoint) ÷ Capacity
Goal(%)       = Actual ÷ Planned
```

Defaults per team, all editable in Settings:

| Constant | Ruby | Titan | What it is |
|---|---|---|---|
| `hoursPerDay` | 7 | 7 | A working day is 7 h in your sheet, not 8 |
| `hoursPerPoint` | 2.9 | 2.9 | The bridge between hours and story points |
| `ceremonyHours` | 8.0–9.0 | 9.0 | Standups, planning, review, retro — per sprint |
| `workloadOverPct` | 110 | 110 | Above this, a person is flagged red |
| `pointsPerFailingTest` | 0.25 | 0.25 | How TestOps failures become forecast maintenance |

**Order matters.** The support/learning deduction applies to the raw day-hours
*before* ceremony hours come off. Thuan, S37: `10 × 7 × 0.6 − 9 = 33 h`, which is
what the sheet shows. The other order gives 30.6 and everything downstream drifts.

Support % and ceremony hours are stored **per sprint**, not as permanent traits —
someone mentors a new joiner for two sprints and then stops.

### Calibration

`hoursPerPoint` starts at the inherited 2.9 but the app measures what the team
actually spends per delivered point and tells you when the two have drifted more
than 15%. One click adopts the measured value. A constant copied between
spreadsheets for two years is not evidence.

---

## Navigation

The sidebar is the tool's shape: **one team at a time**, and everything below the
picker belongs to that team. The team picker is always visible; the sprint picker
appears only on the screens where a sprint is the unit of work.

```
Search work items     every issue, filtered — across all teams
Team
  Overview            members, sprints, board backlog — is the data right?
  Backlog     (n)     the queue, and whether it is plannable
Sprints
  Active sprint ●     what is running now
  Future sprints ●    what is next — open one to plan it
  Closed sprints ●    what happened — open one to review it
  Capacity planning   the grid, per sprint
  Forecast            the next N sprints
Reports
  Delivery metrics    velocity · productivity · quality
  Automation coverage per component and product family
  Risks               detected signals + the register you keep
Data
  Data sources        where every field comes from, and what is missing
  Adjustments         every field you have overridden, and what Jira says now
  Jira fields         which Jira field feeds which number
  Integrations & setup
```

**Search work items** — Jira's issue search, against the local database. See below.

**Adjustments** — every field you have overridden locally, your value beside
Jira's current one, with the reason and one click to go back. An override Jira
has since caught up with is flagged, because it is no longer doing anything.

**Overview** — what Jira says about the team: members with their real Jira
activity, sprints with state and progress, and the board backlog. The landing
screen, because it answers "is the data right?" before you plan against it.

**Backlog** — the queue as something to *manage*: a readiness bar splitting it
into ready / needs-an-estimate / blocked, how many sprints of runway it
represents at real velocity, work mix and components, and one-click filters for
ready, unestimated, blocked and unowned. Unestimated items are called out
because they are invisible to every forecast — a 200-point backlog with 40% of
it unestimated is not a 200-point backlog.

**Active sprint** — one RAG score with its reasons spelled out, burndown against
the ideal line, projected landing point, per-person progress, and explicit lists
of blocked and unestimated items. Unassigned work counts toward the commitment;
leaving it out would make the burndown look better than the sprint is.

**Future / Closed sprints** — the board's sprints as a planning surface and a
record. Future shows what is already committed and which sprints are still
empty; Closed shows committed vs delivered, carryover and attainment per sprint.
"Plan" jumps to that sprint's capacity grid, "Review" to its sprint view.

**Capacity planning** — the sheet's grid, made editable. Click a day cell to
cycle full → half → off → holiday; every number above recomputes. Over- and
under-loaded people are named, not colour-coded and left for you to spot.

**Forecast** — the next N sprints built from *real* availability rather than an
average headcount, so the sprint where three people are on leave shows up before
you commit to it. Supply vs demand against the backlog, delivery predictability,
and a what-if panel (add people, remove people, change ramp-up load) that answers
a staffing question during the meeting instead of after it.

**Risks** — eleven detected signals plus the register you keep by hand. Each
signal says what was seen, why it matters and what to do: overcommitment,
unnoticed slack, key-person concentration per component, unestimated
commitments, blocked work, pace, work-mix drift, carryover trend, calibration
drift, TestOps execution health feeding maintenance load, and released members
still holding tickets.

**Data sources** — every field the tool reads, where it comes from, and whether
it is actually populated. See below.

**Jira fields** — which Jira field feeds which number, decided by evidence rather
than by name. See below.

**Integrations & setup** — connections, capacity constants, sprint calendar,
holidays, categorisation rules, sync integrity, import/export, audit log.

---

## The local database

Everything lives in one SQLite file, `data/store/planning.db`, and that file is
the primary source — not a cache of Jira. It uses `node:sqlite`, which ships
with Node 22.5+, so the tool still installs nothing.

**Your edits are first-class.** Any synced field on any item can be overridden
locally. The override is not a note stuck on the side: it is written into the
row, so every report, aggregate, search and screen reads your value and none of
them disagree with each other. The original is kept separately, with your
reason and the time, and **a sync can never overwrite an adjusted field** —
everything else on the same item keeps syncing normally. Each sync refreshes
what Jira now says, so the comparison stays current, and one click puts the
field back. The **Adjustments** screen lists all of it.

That guarantee is the whole point. If a sync running underneath a planning
session could silently undo an estimate you had just corrected, every number in
the tool would be suspect — which is where this project started.

**Nothing is destroyed by a sync.** An item the sync stops seeing is marked
deleted, not removed, because a board reconfigured for an afternoon or a JQL
that stopped matching is not a reason to lose your work.

### How your old data got here

The first time the tool opens on an empty database it imports `snapshot.json`
and `plan.json`, verifies the result count-for-count, and writes what it found
to the audit log. It never writes back to those files, and it refuses to import
over a database that already holds rows. If anything about it is wrong, the
JSON files are untouched: delete `planning.db` and it rebuilds.

The migration is tested by round-tripping — the objects go in, come back out,
and are compared field by field, with an *added* key failing just as hard as a
missing one. Counting rows was not enough: an early version matched every count
while alphabetising the team members, re-ordering the board picker, and
dropping the dates off every sprint.

`plan.json` is still written on every save. It is 83KB, nothing can rebuild the
leave grid, and keeping a current copy costs nothing measurable. `snapshot.json`
is not: it is 8.9MB, Jira can rebuild all of it, and writing it on every sync
was most of the cost this change removed.

### What it bought

| | Before | Now |
|---|---|---|
| Reading the plan | parse 8.9MB | 3ms, or 0 cached |
| An indexed aggregate over 7,269 issues | 369ms just to parse | under 100ms |
| A failed save | half-written file, three backups to pick through | transaction rolls back, nothing left behind |
| Your correction to an estimate | gone at the next sync | held, with Jira's value beside it |

One honest caveat: rebuilding the *whole* snapshot object — all 7,269 issues with
their components, labels and sprints — still costs about 350ms, because that is
the compatibility layer handing the old shape to screens that have not moved yet,
not the database. It is cached, so a page load pays it at most once, and every
screen that asks a real question instead of asking for everything is fast. As
screens move to querying the database directly, that number stops being paid.

The database needs a filesystem that supports file locking. A local folder is
fine; a network drive or some synced folders are not, and the tool says so by
name rather than reporting a disk error.

## The roster is a property of the SPRINT, not of the team

A team's size changes. Titan has had three people since Sprint 38 and more
before it, and planning Sprint 39 against the historic list produces a capacity
figure for a team that does not exist — along with a workload percentage
measured against it, which is worse, because it looks plausible.

So the capacity grid's rows are the people on **that sprint**:

| Sprint state | Who is on it |
|---|---|
| **Closed** | Whoever was assigned work in it, **plus anyone you entered capacity for** — a leave grid or support percentage recorded against someone is the clearest statement that they were part of that fortnight, whether or not a ticket ended up in their name. |
| **Active / future** | The assignees **plus** the team's current members — because planning capacity comes before assigning work, and the person with nothing picked up yet is exactly the one whose free fortnight you are looking for. |

On top of that base sit the two things you decided: people you **added** to a
sprint and people you **took off** it. Those are stored as a *difference*, not
as a roster — so a person Jira assigns tomorrow still appears, while your edits
survive every sync. Same shape as the adjustment overlay, for the same reason.

**A person you removed from the team stays off**, even when Jira shows their
work. Titan has 38 people excluded; without that rule the derived roster put ten
of them back on one sprint and reported eleven people on a three-person team.
You can still add a specific person to a specific sprint — that is a narrower
and later decision than "not on this team".

### When the member ids changed underneath you

Member ids were regenerated at some point, so older capacity data is filed
under a shorter scheme — `ruby-thao` for what is now `ruby-thao-dang`. Left
alone, 34 of 35 entered rows were orphaned: invisible, and missing from every
historical capacity total.

Resolution happens **on read**, never by rewriting stored keys, and follows
exactly two conservative rules: an exact id match, then an *unambiguous* prefix
match. A person matched this way gets **one** row carrying their real leave
grid — merged, not appended, because appending gave the same human two rows and
doubled Ruby's Sprint 33 from 4 people and 231 hours to 8 and 462.

There is deliberately no fuzzy name matching. `ruby-chau` and
`ruby-tran-thi-minh-chau` are the same person and this will **not** join them —
that row stays visible as its own "past member" entry and a human decides. A
matcher confident enough to merge those is confident enough to merge two
different people, and what it would be merging is a leave grid nothing can
rebuild.

**Adding someone to a sprint adds them to that sprint only.** They do not become
a team member and they do not appear on any other sprint. The header says where
each person came from — "4 people (3 assigned work, 1 you added)" — because a
headcount with no provenance invites a question it cannot answer.

### Closed sprints are read-only

Every write that names a team and a sprint is refused with **409** when that
sprint is closed for that team. Enforced on the **server**, not in the browser:
a tab left open since last week still has live buttons, an autosaving grid still
autosaves, and `fetch` from the console never saw the UI at all.

Closed is asked per **team and sprint**, never per sprint. A numbered entry like
S39 is shared — each team hangs its own Jira sprint off it — so Ruby's Sprint 39
can be closed while Malphite's is still running. "Is S39 closed" has no single
answer.

What counts as closed is Jira's own state, not the end date. A sprint runs late,
and locking the grid at midnight on the planned end date would take the tool away
exactly when the team is still working in it.

### One click does one thing

`#main` is one long-lived element, and several views wire their buttons with a
single delegated click listener on the element they are handed. Replacing that
element's `innerHTML` does **not** remove a listener bound to the element
itself — so every refresh added another, and one click ran the handler once per
render since the page loaded.

It surfaced on "Save current plan": two clicks produced nine saved scenarios,
five and four copies, timestamps a second apart. Every other delegated action
in those views was firing repeatedly too — removing a person, applying a
scenario, saving a note — invisibly, because doing the same idempotent thing
twice looks like doing it once.

`App.refresh()` now builds a **fresh container for every render**, so whatever a
view binds dies with the container it was bound to. That fixes the class rather
than the symptom, including for views written later. The wrapper is
`display: contents`, so `main`'s padding and max-width still apply to the view's
own sections.

### Capacity scenarios

Save the current plan under a name, change anything, and compare. A scenario
captures the roster, the leave grid, support percentages, ceremony hours and any
planned/actual overrides for one team and sprint — everything that moves the
capacity number — with the headline figures recorded so a list of five is
readable at a glance:

```
Plan                    People  Capacity h  Cap pts
Current plan (live)          3         148       51
Four, with Abiran            4         244       84
Core three                   3         183       63
Hien 50% on support          3         148       51
```

Scenarios are scoped to one team **and** one sprint; a sprint only ever lists
its own. If identical copies exist from the bug above, the bar offers to clean
them up: a **dry run first**, naming what it would remove, keeping the earliest
of each group and removing nothing until you confirm. Identical means the same
*inputs*, not merely the same name — re-saving under a name you have used
before, with a different plan, is a legitimate thing to do and survives.

Applying one **replaces** this sprint's inputs rather than merging into them —
merging would leave a person the scenario never mentioned still sitting in the
grid, so applying "the three-person plan" would quietly give you four. Saving and
applying both obey the closed-sprint lock; a scenario you could never apply is a
trap.

## Is the stored data consistent?

**Data sources** answers this without touching the network, so it works off VPN
and is safe to compute on every load. It checks the store against itself and
against what the last sync recorded Jira saying:

- **no duplicate work items** — the issue key is the primary key, so a second
  copy cannot be stored; shown anyway, because someone asking deserves to see it
- **nothing belongs to two mutually exclusive sync queries** — `sprintWork` is
  `sprint IS NOT EMPTY` and `backlog` is `sprint IS EMPTY`, so no item may carry
  both
- **no orphaned component, label or sprint links** — guaranteed by a foreign key
- **each dataset counted against Jira**, as the last sync measured it
- **items the sync stopped seeing**, hidden rather than destroyed — reported, and
  never a failure, because that is what the soft delete is for

A check fails only for something that *cannot* be true. A number that merely
looks surprising is a question for a person, not a defect.

### A tag that stopped being true

That second check exists because it caught one. 78 issues were tagged both
`sprintWork` and `backlog`; every one had moved from the backlog into a sprint,
and the incremental sync had added the new tag while keeping the old.

An incremental sync re-queries every dataset over the same window, so its
matches are the complete answer for anything that changed. It now **recomputes**
a touched issue's datasets from that answer instead of unioning with the stored
value — a union can only ever preserve a tag that has stopped being true.

## Where the data comes from

"We sync from Jira" is two thirds true, and the missing third is the expensive
one. `lib/provenance.js` holds the catalogue; the **Data sources** screen shows
it measured against your store, so a field that *should* be filled in and is not
says so.

| | Owns | Notes |
|---|---|---|
| **Jira** | Teams, members, sprints and their dates/state, backlog, issues, points, components, labels, blocked-by links, epics + Automation Status, and any extra fields you map | Rebuilt on every sync — editing these locally is pointless, the next sync wins. **Which** Jira field feeds each of these is set on the Jira fields screen |
| **CSV** | Issues, status, assignee, points, components, labels | A Jira CSV export runs the whole tool with no API token |
| **TestOps / GitHub** | Suite pass rate, flakiness, worst suites; PR activity | Optional |
| **You** | The leave grid, support %, ceremony hours, holidays, hours-per-day and hours-per-point, categorisation rules, work-mix targets, the risk register, planned/actual overrides, board mapping, removed people | **Nothing can supply these** |

The leave grid is the one that matters. A capacity forecast is only as good as
"who is actually here for these two weeks", Jira has no field for it, and a team
that has not filled it in is reading a forecast built from defaults without
being told. Hence the screen.

### Handing the data back to Jira

The app ships with a seed (hand-entered Ruby and Titan rosters, a sample sprint
calendar) so it opens with something in it. Once Jira is connected that seed
stops being a convenience: you can no longer tell which rows came from your
tracker and which were typed. **Data sources → Hand the data back to Jira**
drops everything a sync can rebuild and keeps everything it cannot.

- **Removed**: seeded rosters, teams with no board mapped, locally generated
  sprints the board never confirmed, and planning entries pointing at either.
- **Kept**: the leave grid, support %, ceremony hours, holidays, capacity
  constants, board mappings, categorisation rules, work-mix targets, the risk
  register — and the exclusion lists, because a cleanup that silently re-added
  people you removed on purpose would be the opposite of cleaning up.

A dry run is the default; a timestamped backup (`plan.pre-reset.*.json`, never
rotated) is written before anything is removed. Every one of those guarantees
has its own mutation-tested check in `test/reset.test.js` — the dangerous
failure here is not deleting too little.

### Sprint names: numbered and dated both work

Two conventions exist in this project and both have to work:

| Name | Kind | How it is stored |
|---|---|---|
| `Katalon Ruby Sprint 39` | numbered | One shared calendar entry `S39` that several teams hang their own dates and state off — the teams share a fortnight |
| `TT Week 31Aug` | dated | Its own entry `J<jiraSprintId>` — the TrueTest boards run their own windows with no number to line up against |

Requiring a trailing number, and discarding anything else, cost **Katalon Auto
Malphite 10 of its 11 sprints**: Jira returned them, the reconciler dropped them,
and a team with 11 sprints of history looked like one that had never run a
sprint. A sprint Jira returns is a sprint that exists.

Everything downstream therefore orders sprints by **when they ran**, not by the
digits in the name (`reconcile.compareSprints`), and looks index rows up **by
calendar id, never by number** — `number` is `null` on a dated sprint, so a
number-keyed Map makes `null === null` true for every one of them and collapses
them onto a single row. That bug showed up twice: as an active sprint that could
not be found, and as every TT Week reporting the same item count.

Sprint length comes from the sprint's own dates too, so a genuinely weekly board
gets a 7-day capacity grid rather than a fortnight with seven days of the next
sprint in it.

### Who counts as being on a team

The roster is whoever picked up work in the **last 3 sprints** (the active one
plus the two before it), not everyone in the board's history. A 44-sprint board
otherwise yields a 40-person roster for a team that has had 3 people since
Sprint 38, and the only way out is excluding 37 people by hand. Everyone older
is listed on the Team tab under *Worked here before* and added back in one
click. Override per team with `team.settings.rosterWindowSprints`.

---

## Jira fields — name gets you on the shortlist, data decides

A Jira instance routinely carries **several fields called "Story Points"** — a
legacy company-managed one, a team-managed "Story point estimate", whatever a
migration left behind — and only one is filled in. Matching on the name picks
the wrong one about as often as the right one, and the failure is silent: every
issue arrives with no estimate, every velocity and forecast reads zero, and
nothing says why. That is exactly what happened to AUTOKAT: 7,143 issues, all
estimated at nothing, against `customfield_16012`.

A name cannot settle this. Data can.

**Detect fields** asks Jira for the field catalogue and a sample of real issues
with `fields: ['*all']` attached — one query, not one per candidate — and counts
how many carry a value for each. The sample is ordered most-recently-updated
first, so a field abandoned two years ago does not look healthy because the
oldest issues still carry it.

The screen then shows, per role:

| | |
|---|---|
| **Field** | the id in use, and whether it is *pinned* (your choice) or auto-detected |
| **Filled** | what percentage of sampled issues actually carry a value |
| **Status** | `looks right`, `empty on every sampled issue`, `X is better filled`, or the reason it cannot tell |

A recommendation that cannot admit doubt is how the wrong field got picked in
the first place, so `confident` is false when no candidate holds a value or two
are equally populated — and the screen says which, rather than choosing quietly.

**Pinning a field is what fixes the zeros.** A pinned id goes straight into the
Jira request and skips detection entirely; clearing it goes back to detecting on
every sync. Neither changes anything until a full sync runs, because the issues
already on disk were pulled with the old mapping — the screen says so rather
than letting you wonder.

### Extra fields

Anything else populated in your Jira can be synced alongside. Each gets a slug
from its name (`Test Type` → `test-type`) and becomes a **real query field**, a
pickable **column**, and a **CSV heading** — `test-type = E2E` works exactly the
way `status = Done` does. They are registered from the *snapshot*, not the
config, so the parser only ever offers fields that are genuinely in the data;
promising one before a sync has pulled it would be an error waiting to happen.
An extra can never shadow a built-in field name.

### Sync every field

`*navigable` asks Jira for everything visible on a board. It guarantees nothing
is missed and costs for it: the snapshot grows several times over, syncs get
slower, and the extra values are stored raw rather than mapped to anything the
reports understand. Worth turning on to see what exists, then off once the
mapping is right — **picking the correct Story Points field fixes the zeros on
its own, and this does not replace that.**

---

## Search work items

The one screen that is not scoped to a team. Filter chips and a query string are
two views of **one** filter: the chips compile to a query you can see and edit,
and a query you type parses back into chips. Neither is second-class, and
neither can drift from what is actually filtered — if a typed query is too
complex for chips (a cross-field `OR`, a range), the page says which part has no
chip equivalent rather than showing chips that quietly disagree with the results.

```
status = Done AND assignee = "Hien Phan" ORDER BY updated DESC
type IN (Story, Defect) AND sprint IS EMPTY
component = TrueTest AND automationStatus IS EMPTY
updated >= -14d AND statusCategory != done
```

| | |
|---|---|
| **Fields** | key, summary, text, type, status, statusCategory, resolution, priority, assignee, reporter, component, label, sprint, sprintState, team, project, automationStatus, category, parent, points, estimated, blocked, created, updated, resolved, due |
| **Operators** | `= != > >= < <= ~ !~`, `IN (…)`, `NOT IN (…)`, `IS EMPTY`, `IS NOT EMPTY` |
| **Logic** | `AND`, `OR`, parentheses, `NOT` |
| **Dates** | `2026-09-01` (the whole day) or `-14d` / `-2w` / `-3m` |
| **Ordering** | `ORDER BY field [ASC\|DESC]` |

**Facet counts are the point.** Each dropdown shows how many issues carry each
value *under the other filters*, so you read what is there instead of guessing —
and each field's own clauses are excluded from its own counts, so picking
"Story" does not collapse the Type list to one option and trap you into only
ever narrowing.

**Computed fields** are ones Jira does not have but the questions are about:
`category` (new / maintenance / technical / support, from the categorisation
rules), `estimated` (a usable estimate, so `0` does not count), `blocked` (has a
blocking link), `sprintState`.

**A query that cannot be honoured fails loudly**, with the position and the list
of known fields. An empty result set that looks like a real answer is the worst
thing a search box can do, so `banana = 3` is an error, never zero rows. What is
deliberately *not* supported: Jira functions (`currentUser()`, `startOfWeek()`),
the `WAS`/`CHANGED` history operators, and saved-filter references.

Results can be sorted by any column, given whatever columns you want from the 21
available, exported as CSV (the whole result set, not the page you are looking
at), opened in Jira as a JQL search, and saved by name. Saved searches live in
`plan.json` and a sync never touches them; one is refused if its query does not
run, because a saved search that errors a month from now is worse than not
saving it.

The engine is `lib/search.js` and the language is `lib/query.js` — and the
browser is served **that same file** at `/shared/query.js` rather than a copy,
because two implementations of a parser drift.

---

## The reports

`lib/metrics.js`, 19 checks in `test/metrics.test.js`. Every figure on screen
states its basis, because a metric nobody can explain in a review is a metric
nobody acts on.

### Delivery metrics — per team

| Metric | Definition |
|---|---|
| **Velocity** | Points delivered per closed sprint; the headline averages the last 6 |
| **Safe commitment** | `average × max(0.5, mean − stdev)` of delivered ÷ committed — what to commit to when delivery is erratic |
| **Predictability** | Mean and spread of delivered ÷ committed over the window |
| **Attainment** | Delivered ÷ committed, with the count of sprints that landed under 90% |
| **Carryover** | Committed points that did not finish, per sprint, never negative |
| **Rework share** | Maintenance-category points ÷ all delivered points |
| **Estimation discipline** | Committed items with no estimate, as a share |
| **Throughput** | Items completed per sprint |
| **Points per person** | Delivered ÷ people who delivered, per sprint |
| **Capacity used** | Delivered points × `hoursPerPoint` ÷ planned capacity hours |
| **Cycle time** | Median and 85th percentile of created → resolved, absurd values dropped |
| **Suite health** | Pass rate, flakiness and worst suites from TestOps, when connected |

Points per person carries a caveat on screen and it is deliberate: it is a
planning input, not a performance rating. A person on a gnarly integration
suite delivers fewer points than someone adding cases to a stable one.

### Automation coverage — per component and product family

```
coverage % = (Automated + Maintenance) ÷ (Automated + Maintenance + Ready + Blocked)
```

Measured on Jira **Epics** by their **Automation Status** field, which is the
definition already in use for iPipeline.

- **Maintenance counts as covered.** It is automated, it is just being fixed.
- **N/A and untriaged are outside the ratio**, and both are reported next to it
  rather than quietly dropped — an epic with no status set is not an epic with
  0% coverage, and the difference is a triage backlog.
- A **renamed Jira option** appears by name under "Unrecognised status values"
  instead of silently vanishing from the denominator.
- An epic with several components **counts in each** — the grid is a view per
  component, not a partition.
- Components roll up into the three families the team reports on: `R&D_`
  (product regression), `PS_` (client delivery), `KAT_` (framework and common).
- **Katalon and TrueTest are hidden from the grid** as tooling rather than
  product coverage, named in a footnote, and still counted in the headline.
  Configurable: `config.metrics.excludeComponentsFromGrid`.

---

## What syncs from Jira

Jira is the source of truth for **teams, sprints, people and the backlog**. You
pick a team and everything for that team is already on disk.

| What | Where it comes from | Definitive? |
|---|---|---|
| **Teams** | scrum boards in the project + the Jira Team field | yes |
| **Sprints** — id, name, state, real dates | each team's board (`/board/{id}/sprint`) | yes |
| **Backlog** | that team's board backlog (`/board/{id}/backlog`) | yes |
| **Members** | who is assigned work in that team's sprints | yes |
| **Issues** | JQL over the project | yes |
| **Epics + Automation Status** | `issuetype = Epic` over the project | yes — feeds coverage |

### The per-team index — why picking a team is instant

Every sync writes `snapshot.byTeam[teamId]`:

```
sprints       [{ jiraId, number, name, state, start, end, issueKeys, points, donePoints }]
sprintIssues  { <jiraSprintId>: [issueKey, …] }
backlog       [issueKey, …]          ← straight from the board
people        [{ name, accountId, issues, points }]
```

Issue **bodies** live once in `snapshot.issues`, keyed by key; the index holds
only keys. So there is exactly one copy of every issue on disk, the index stays
small, and a view resolves a team's sprint by lookup instead of scanning every
issue in the project. `GET /api/team?id=titan` returns the whole bundle —
members, sprints, backlog — in one call off that index.

### Teams

A scrum board is a team. Its display name comes from the matching Jira Team
field value (`Katalon Auto Titan`), and an existing team is matched — never
duplicated — by board id, by a Team value it already claims, or by one of its
sprint keywords. Kanban boards are skipped: no sprints, nothing to plan.

### Sprints

The board gives a sprint's **id, name, state and real start/end dates**. Sprints
stay one numbered calendar because the teams share a fortnight, but each entry
carries `byTeam[teamId]` with that team's own id, dates and state: Ruby's Sprint
40 and Titan's Sprint 40 are *different Jira sprints* that are only usually
aligned. Capacity, availability and the burndown all use the team's own window.

- **The current sprint is Jira's active sprint**, not a date guess.
- **Issues match their sprint by Jira id**, so renaming a sprint no longer drops
  its issues out of the grid.

### Backlog

`/board/{id}/backlog` is what "this team's backlog" means in Jira — no component
or assignee guesswork, and it already excludes anything sitting in a sprint. A
team with no board mapped falls back to ownership heuristics and **the view says
so**, because a guessed backlog and a real one should never look alike.

### Members

Someone assigned work in a team's sprints is on that team, so they are added
automatically, tagged `source: jira`, and linked by `accountId` (which survives
a display-name change). Availability defaults to the working calendar — check it
after a sync, since a new member adds real capacity to the forecast.

**Removal is permanent.** Remove someone and they go into `plan.excluded[teamId]`;
no future sync re-adds them, however often Jira mentions them. Undo it on the
Team tab and the next reconcile brings them back.

Dormant members — Active on the roster, zero Jira activity — are flagged. That is
nearly always a display-name mismatch, and it means their points are landing in
"unassigned".

### The rule reconcile never breaks

**It never deletes.** A sprint or member Jira stops listing is marked, not
removed — a board reconfigured for one afternoon must not wipe your history.
Mutation-tested.

## Data sources

| Source | What it gives | Required? |
|---|---|---|
| **Jira** (AUTOKAT) | Sprints, issues, points, assignees, status, components | The backbone |
| **Katalon TestOps** | Pass rate, flakiness, worst suites → forecast maintenance load | Optional |
| **GitHub** | PR activity → technical work that never reaches Jira | Optional |
| **CSV import** | A Jira CSV export runs the whole tool with no API token | Always available |

Every dataset has a manual path. Availability, support %, ceremony hours, and
per-member planned/actual can all be entered or overridden by hand, so the tool
works on day one and keeps working when a connection is down.

### How syncing behaves

External systems are contacted **only on an explicit Sync**. Page loads, filters
and tab switches read `data/store/snapshot.json` from disk — the app is instant
and works with Jira unreachable.

Three integrity guarantees, each covered by a test that was mutation-checked
(break the line, watch the test go red):

1. **Verification.** Every dataset's stored count is compared against Jira's own
   count before the snapshot is saved. A mismatch re-pulls once, then surfaces in
   Settings. A full sync is the only thing that catches *deletions* — a deleted
   issue never appears in an "updated since" query — so this check doubles as the
   tripwire telling you a full sync is due.
2. **Watermark = sync START, not finish.** A full sync takes minutes; using the
   finish time means edits made during the run fall into a hole and are never
   picked up.
3. **Dedupe by issue key.** Paging a result set that is being edited returns the
   same issue twice.

An incremental sync also **drops** touched issues that no longer match any
dataset. Without that step, closed backlog items linger in the snapshot forever.

### Three things the first real sync taught us

Each of these was found against the live AUTOKAT project, and each now has a
mutation-tested check.

**1. `null` points are not `0` points.** `Number(null)` is `0`, so the obvious
normaliser turned every unestimated issue into an issue estimated at zero — and
"no estimate" is the signal the backlog, the forecast and the quality metrics
are all built on. An unplannable backlog looked fully estimated and weightless.
A real `0` is still kept as `0`.

**2. Several fields are called "Story Points"; only one is filled in.** Jira
Cloud commonly carries a legacy company-managed field, a team-managed "Story
point estimate", and whatever a migration left behind. Picking the first name
match gave a 7,140-issue project estimated at nothing. The sync now asks Jira
`<field> IS NOT EMPTY` for each candidate and uses the one that is populated.
Set `jira.storyPointsField` in `config.json` to skip the check. If *no*
candidate holds a value, Settings says so in as many words rather than showing
a confident zero — a whole project reading as 0 points is a wrong field, not a
team that never estimates.

**3. One bad board must not sink the rest.** A kanban board answers
`/board/{id}/sprint` with a 400, which used to abort the loop and discard the
sprints already read for every other team. Board reads are now per-team, and a
team with **no** board mapped gets no sprints at all — it is never handed
`boards[0]`, because one team silently showing another team's sprints is worse
than an empty list that says why it is empty. Failures are listed per team in
Settings.

---

## Work categorisation

Jira has no work-type field; the category is smeared across Issue Type, Labels,
Components and Summary prefixes. `lib/classify.js` makes that explicit as an
ordered rule list — first match wins — shown in Settings and editable in
`data/store/plan.json` under `categoryRules`:

| Signal | Category |
|---|---|
| Label `Maintenance`, summary `Maintenance:`, component `KAT_Common_Maintenance` | Maintenance |
| Summary `Tech:` / `Migration`, component `KAT_Framework_Optimization`, Bucket Story | Technical |
| Label/summary `Grooming` | Support & analysis |
| Plain `Story` | New implementation |

Work-mix target bands (default: maintenance under 35% of a sprint) drive a risk
signal when a team drifts outside them.

---

## Files

```
server.js                 local-only HTTP server, binds 127.0.0.1
config.json               credentials, chmod 600, git-ignored
lib/capacity.js           the capacity + velocity maths
lib/classify.js           work categorisation rules
lib/insights.js           capacity, backlog, sprint, forecast — from snapshot + plan
lib/metrics.js            velocity, productivity, quality, coverage, backlog health
lib/reset.js              what a cleanup may and may not delete — stated once
lib/provenance.js         the catalogue of where every field comes from
lib/staleness.js          warns when the running process is older than the files
lib/query.js              the JQL subset — parser, serializer, chip round trip
lib/search.js             matching, sorting, paging and facet counts
lib/fields.js             profiles Jira's fields by what is actually populated
lib/sync.js               the only module that pulls from external systems
lib/reconcile.js          discovers teams, reconciles sprints + rosters, builds the index
lib/jira.js  testops.js  github.js  csv.js
lib/db.js                 the schema, the migrations, the one connection
lib/repo.js               issues and the adjustment overlay, in domain terms
lib/project.js            rebuilds the snapshot/plan shapes from the tables
lib/persist.js            writes a whole snapshot/plan back into the tables
lib/import-json.js        the one-way JSON → database migration, with verification
lib/roster.js             who is on a team FOR ONE SPRINT
lib/lock.js               a closed sprint is read-only, per team and sprint
lib/integrity.js          structural self-checks, shown on the Data sources screen
lib/store.js              the seam: same four functions, database underneath
public/app.js             the router — one ROUTES table drives sidebar and views
public/views/             one file per screen
public/                   vanilla JS, hand-rolled SVG charts, light + dark
data/store/planning.db    THE STORE — everything, in SQLite
data/store/plan.json      mirror of the plan, kept current as an escape hatch
data/store/snapshot.json  the pre-database snapshot; read once, then left alone
data/seed/plan.seed.json  first-run seed (Ruby + Titan)
data/audit.log            every change the tool made
test/                     378 checks, all offline
```

Adding a screen is one entry in `ROUTES` in `public/app.js` plus a view file —
the sidebar, breadcrumbs, sprint-picker visibility and item counts are all read
off that table rather than written twice.

### Security

The server binds `127.0.0.1` and rejects non-local sockets. Credentials live in
`config.json` (chmod 600, git-ignored) and are never sent to the browser — the UI
is told only whether a token exists. `JIRA_BASE_URL`, `JIRA_EMAIL`,
`JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`, `TESTOPS_API_KEY`, `GITHUB_TOKEN` and
`PORT` override the file, so you can run without writing secrets to disk at all.
Setting `server.readOnly: true` blocks every write.

This is also why it is a small server and not a static HTML page: a browser
cannot call Jira directly (CORS), and a token in a page is a token you can
accidentally share.

---

## Tests

```bash
npm test                      # all thirteen suites — 378 checks
node test/capacity.test.js    # 41 — the maths, against the spreadsheet
node test/insights.test.js    # 55 — views, store, sync integrity, fields, CSV
node test/reconcile.test.js   # 45 — teams, sprints, rosters, the index
node test/metrics.test.js     # 19 — velocity, quality, productivity, coverage
node test/reset.test.js       # 17 — what a cleanup may and may not delete
node test/staleness.test.js   #  8 — is this process running the code on disk?
node test/search.test.js      # 48 — the query language, matching, facets
node test/fields.test.js      # 35 — which field is which, and that pinning one wins
node test/ui-wiring.test.js   #  3 — one click does one thing
node test/roster.test.js      # 31 — who is on a sprint, and the closed-sprint lock
node test/sprint-api.test.js  # 25 — what the SERVER does with requests the UI would never send
node test/db.test.js          # 30 — the database and the adjustment overlay
node test/migrate.test.js     # 21 — JSON → database → JSON, field by field
```

The coverage checks are pinned to the real 2026-09-08 numbers (3,444 epics →
76.4% of automatable, 63.1% of all), so a change to the bucket mapping that
would quietly move the headline fails instead.

All of them run offline against a fake Jira — `sprint-api` starts a real server
on an ephemeral port and talks to it over HTTP, because a rule that is only in
the browser is not a rule.

When you add a guarantee, mutation-test it: break the line it protects and
confirm a check goes red, **and that it bites alone** rather than only alongside
a second guard. That is how the watermark test was found to be vacuous in the
sibling dashboard, how two redundant guards on the adjustment overlay were
collapsed into one, and how "adding to a sprint" was caught quietly adding to
the team.

---

## Design

Follows the KMS Technology design system. Tokens are vendored into `public/kms/`
(tokens.css plus self-hosted Poppins) so the app stays offline and
self-contained — to re-skin after a design-system update, copy the new
`tokens.css` in and change nothing else. `public/styles.css` contains no raw
colour or size literals below the theme block; everything is `var(--…)`.

House rules applied: titles Light 300, ExtraBold 800 reserved for KPI figures,
flat pill buttons with no shadow, `--shadow-brand` on the featured tile only,
wide-tracked all-caps eyebrows with the pink dot. Chart palette is brand hues
only; dark mode grounds on the official navy `#10112A`.
