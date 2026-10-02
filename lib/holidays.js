'use strict';
/**
 * holidays.js — the public-holiday list, and the arithmetic a calendar needs.
 *
 * ── WHY THIS IS A MODULE AND NOT A TEXT FIELD ────────────────────────────
 *
 * It was a text field: one comma-separated line, typed by hand, saved through
 * `PUT /api/plan` — which merges whatever it is handed without looking at it.
 * That is survivable for a list you touch twice a year and write carefully.
 * It is not survivable for a calendar, where a click produces a write, and a
 * year of Vietnamese public holidays is a dozen of them in one sitting.
 *
 * So the list gets a shape it can be held to: real dates, no duplicates, in
 * order. Every path writes through here — the calendar, the paste box, and the
 * importer — because two ways of saving one list is how the list comes to hold
 * "2026-02-30" and nothing on screen says so. A date this cannot parse is NOT
 * a silent drop: the caller is handed the reasons, so the paste box can say
 * which line it could not read instead of quietly shortening the list.
 *
 * ── WHAT A HOLIDAY ACTUALLY DOES ─────────────────────────────────────────
 *
 * It changes the DEFAULT availability of a day — `insights.defaultAvailability`
 * marks it `H` — and nothing else. A sprint whose leave grid somebody has
 * already filled in keeps exactly what they entered, because `fitRow` only
 * supplies the cells a saved row is missing.
 *
 * That is the right behaviour and the surprising one: marking Tet in January
 * does not retroactively empty a sprint someone planned in December. The
 * screen has to say so, or the first person to try it concludes the feature
 * does not work.
 */

/* ── WRAPPED, BECAUSE THE BROWSER HAS ONE SCRIPT SCOPE ────────────────────
 *
 * The page loads this as a classic <script> alongside /shared/query.js, and
 * classic scripts all share one top-level scope. Declaring `const API` here
 * when query.js already declares one is not a shadowing nicety — it is
 * `SyntaxError: Identifier 'API' has already been declared`, which aborts
 * THIS ENTIRE FILE before a line of it runs. The calendar then falls back to
 * the paste box and nothing says why, because the error is in the console of
 * a page that otherwise works.
 *
 * `function parse` was the quieter half of the same bug: function
 * declarations redeclare without complaint, so the last file loaded wins the
 * name for BOTH modules — query.js's internal calls to its own `parse` would
 * have started reaching this file's date parser.
 *
 * One wrapper removes the whole class. Nothing in here is visible outside it
 * except the single global it deliberately sets.
 */
(function (root) {
  /** `YYYY-MM-DD`, and nothing else. */
  const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

  /**
   * A real calendar date, or null.
   *
   * THE ROUND TRIP IS THE CHECK. `new Date('2026-02-30T00:00:00Z')` does not
   * throw — it rolls over to 2 March, and a list holding a date that silently
   * became a different date is worse than one that rejected it. Formatting the
   * parsed value back and comparing is what catches the rollover.
   */
  function parse(value) {
    const text = String(value == null ? '' : value).trim();
    const m = ISO.exec(text);
    if (!m) return null;
    const d = new Date(`${text}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    return iso(d) === text ? text : null;
  }

  /** A Date as `YYYY-MM-DD`, in UTC — the only timezone this file knows. */
  function iso(d) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  /** Saturday or Sunday. A holiday on one is allowed and simply changes nothing. */
  function isWeekend(date) {
    const d = parse(date);
    if (!d) return false;
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    return dow === 0 || dow === 6;
  }

  /**
   * Clean a whole list.
   *
   * @returns {{dates: string[], errors: Array<{value, message}>, dropped: number}}
   */
  function normalise(input) {
    const errors = [];
    const seen = new Set();
    const list = Array.isArray(input) ? input : String(input == null ? '' : input).split(/[,\n;]/);
    for (const raw of list) {
      const text = String(raw == null ? '' : raw).trim();
      if (!text) continue;                       // a trailing comma is not a mistake worth reporting
      const d = parse(text);
      if (!d) { errors.push({ value: text, message: `${text} is not a date — use YYYY-MM-DD` }); continue; }
      seen.add(d);
    }
    return { dates: [...seen].sort(), errors, dropped: errors.length };
  }

  /**
   * Add a date, or take it away if it is already there.
   *
   * ONE CLICK, ONE CALL, and the whole list comes back — rather than the screen
   * keeping its own copy and posting a diff. A calendar that tracked its own
   * state would drift from the stored list the first time a save failed, and
   * the drift is invisible: the day stays coloured and the plan does not have it.
   */
  function toggle(list, date) {
    const d = parse(date);
    if (!d) return { dates: normalise(list).dates, changed: false, on: false, error: `${date} is not a date — use YYYY-MM-DD` };
    const { dates } = normalise(list);
    const at = dates.indexOf(d);
    if (at >= 0) { dates.splice(at, 1); return { dates, changed: true, on: false, date: d }; }
    dates.push(d);
    dates.sort();
    return { dates, changed: true, on: true, date: d };
  }

  /** Group a list by calendar year, for a screen that shows one year at a time. */
  function byYear(list) {
    const out = {};
    for (const d of normalise(list).dates) {
      const y = d.slice(0, 4);
      (out[y] = out[y] || []).push(d);
    }
    return out;
  }

  /**
   * The year a calendar should open on, and the ones worth offering.
   *
   * `around` is today. The list always includes last year, this year and next —
   * planning happens across a year boundary and a calendar that could not reach
   * next January would be useless every December — plus any year the plan
   * already has holidays in, because a list you cannot see is a list you cannot
   * correct.
   */
  function years(list, around = new Date()) {
    const here = around instanceof Date ? around.getUTCFullYear() : Number(around) || new Date().getUTCFullYear();
    const set = new Set([here - 1, here, here + 1]);
    for (const y of Object.keys(byYear(list))) set.add(Number(y));
    return [...set].filter(y => Number.isFinite(y)).sort((a, b) => a - b);
  }

  /**
   * One year as twelve months of weeks, Monday first.
   *
   * MONDAY FIRST because the availability grid is Monday first and the sprint
   * weeks are Monday first; a calendar that started on Sunday would be the only
   * thing in the tool that did.
   *
   * Leading and trailing blanks are nulls rather than days from the neighbouring
   * month. A greyed-out 30th of the previous month is a day you can click, and
   * clicking it marks a holiday in a month you are not looking at.
   *
   * @returns {Array<{month: number, name: string, weeks: Array<Array<string|null>>}>}
   */
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  function calendar(year) {
    /* STRICTLY A YEAR. `Number(null)` is 0 and `Number([])` is 0, so a finite
       check alone happily draws the twelve months of year zero — a grid that
       renders perfectly and means nothing. The range is wide enough never to
       argue with and narrow enough that a stray 0 or 20260 cannot get through. */
    const y = (year === null || year === undefined || year === '' || Array.isArray(year))
      ? NaN : Number(year);
    if (!Number.isInteger(y) || y < 1970 || y > 2200) return [];
    return MONTHS.map((name, month) => {
      const first = new Date(Date.UTC(y, month, 1));
      const days = new Date(Date.UTC(y, month + 1, 0)).getUTCDate();
      // getUTCDay is 0=Sunday; Monday-first means Sunday sits at the end.
      const lead = (first.getUTCDay() + 6) % 7;
      const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => iso(new Date(Date.UTC(y, month, i + 1))))];
      while (cells.length % 7) cells.push(null);
      const weeks = [];
      for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
      return { month, name, weeks };
    });
  }

    /* THIS FILE RUNS IN BOTH PLACES, and it has to. The server validates what
       it stores with it; the Settings calendar draws twelve months with it. A
       second implementation of "which weekday does the 1st fall on" in the
       browser is a grid that sits one column out, looks completely normal, and
       marks the wrong day on every availability sheet. */
    const EXPORTS = { ISO, parse, iso, isWeekend, normalise, toggle, byYear, years, calendar, MONTHS };
    if (typeof module !== 'undefined' && module.exports) module.exports = EXPORTS;
    else root.Holidays = EXPORTS;
  }(typeof globalThis !== 'undefined' ? globalThis : this));
