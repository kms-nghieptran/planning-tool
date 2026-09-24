'use strict';
/**
 * keywords.js — a list of match words, parsed the same way everywhere.
 *
 * WHAT THESE ARE FOR
 *
 * A team's `sprintKeywords` decide which of Jira's sprints belong to it when a
 * board is not mapped, and `jiraTeams` decides which backlog items it claims.
 * Both are lists of words matched with `includes`, and both are typed by hand
 * into a text box.
 *
 * THE FAILURE THIS EXISTS TO PREVENT
 *
 * An EMPTY keyword matches everything. `'any sprint name'.includes('')` is
 * true, always — so one stray comma in that box ("ruby,") gives the team a
 * keyword of `''`, and from then on it silently claims every sprint on every
 * board in the instance. Nothing looks wrong: the field shows "ruby", the team
 * has a keyword, and the sprint list is simply enormous. That is the same
 * shape as the Malphite bug, where 44 of other teams' sprints were being
 * reported as Malphite's own.
 *
 * So empties are dropped here, once, on the way in — not in the browser, where
 * a rule is decoration. A tab left open since last week still has live inputs,
 * and `fetch` from a console never saw the UI at all.
 *
 * WHY IT SPLITS ON MORE THAN COMMAS
 *
 * The box said `ruby` and split on commas only. Someone entering two keywords
 * has no way to know that, and `ruby; titan` or `ruby titan` was stored as ONE
 * keyword containing a semicolon or a space — which then matches nothing, with
 * no error and no clue. A separator being wrong should not be a silent data
 * error, so all the plausible ones are accepted.
 *
 * SPACES ARE NOT A SEPARATOR, deliberately. "TT Week" is one real keyword on
 * his TrueTest boards, and splitting on spaces would break it into two that
 * each match far too much. Comma, semicolon, newline and tab are separators;
 * a space is part of the word.
 */

/** Comma, semicolon, newline, tab — every separator but the space. */
const SPLIT = /[,;\n\r\t]+/;

/** How many, and how long. Not a real limit — a guard against a pasted file. */
const MAX_KEYWORDS = 40;
const MAX_LENGTH = 80;

const norm = (s) => String(s).trim();

/**
 * Anything a person or a route might send, as a clean list of keywords.
 *
 * Accepts a string ("ruby, titan"), a list, or a list whose entries are
 * themselves separated — the last of those is what a pasted value looks like
 * after the browser has put it in one slot, and treating it as a single
 * keyword would store something that can never match.
 *
 * Deduplicated case-insensitively, keeping the FIRST spelling: `includes` is
 * matched case-insensitively downstream, so "Ruby" and "ruby" are one keyword,
 * and showing both back would suggest they do different things.
 */
function parse(input) {
  const raw = input == null ? []
    : Array.isArray(input) ? input
      : [input];

  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    // An object in the list is not a keyword; `String({})` would store
    // "[object Object]", which matches nothing and reads like a bug report.
    if (entry == null || typeof entry === 'object') continue;
    for (const piece of String(entry).split(SPLIT)) {
      const k = norm(piece).slice(0, MAX_LENGTH);
      if (!k) continue;                       // THE EMPTY KEYWORD. Never stored.
      const key = k.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(k);
      if (out.length >= MAX_KEYWORDS) return out;
    }
  }
  return out;
}

/**
 * Parse, and say what was thrown away.
 *
 * The route uses this so a save can report "one of those was empty" rather
 * than silently storing four of the five things that were typed. Silence here
 * is how someone concludes the field is broken.
 */
function validate(input) {
  if (input != null && typeof input === 'object' && !Array.isArray(input)) {
    return { list: [], errors: ['Keywords must be a list, or a separated string'] };
  }
  const list = parse(input);
  const errors = [];

  const given = input == null ? [] : (Array.isArray(input) ? input : [input]);
  const pieces = given
    .filter(e => e != null && typeof e !== 'object')
    .flatMap(e => String(e).split(SPLIT));
  const blanks = pieces.filter(s => !norm(s)).length;
  // Only worth mentioning when something else came through: a field cleared on
  // purpose is every piece blank, and that is a deletion, not a mistake.
  if (blanks && list.length) errors.push(`${blanks} empty ${blanks === 1 ? 'entry was' : 'entries were'} ignored`);
  if (pieces.some(s => norm(s).length > MAX_LENGTH)) errors.push(`Keywords are cut to ${MAX_LENGTH} characters`);
  if (list.length >= MAX_KEYWORDS) errors.push(`Only the first ${MAX_KEYWORDS} keywords are kept`);

  return { list, errors };
}

/**
 * The keywords a team matches by, falling back to its name.
 *
 * Four places worked this out independently and all four wrote it the same way
 * by luck. It is one rule — "the keywords, or the team's own name if it has
 * none" — and it belongs in one place, because the day it changes is the day
 * three of the four keep the old behaviour.
 */
function forTeam(team) {
  const list = parse(team && team.sprintKeywords);
  if (list.length) return list;
  /* `norm(team && team.name)` was wrong here and the difference is not
     cosmetic: `String(undefined)` is the WORD "undefined", so a team object
     without a name produced the keyword `undefined` and claimed every sprint
     with that word in its name. Guarding the null before the String, not
     after — a missing name has to fall through to no keywords at all, which
     matches nothing and is visibly wrong, rather than to a word that matches
     something and is invisibly wrong. */
  const raw = team && team.name;
  const name = raw == null ? '' : norm(raw);
  return name ? [name] : [];
}

module.exports = { parse, validate, forTeam, SPLIT, MAX_KEYWORDS, MAX_LENGTH };
