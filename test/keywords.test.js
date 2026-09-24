'use strict';
/**
 * keywords.test.js — the lists a team is matched by.
 *
 * THE BUG AT THE CENTRE OF THIS SUITE
 *
 * `'TT Week 31Aug'.includes('')` is true. So is every other string's. A single
 * empty keyword therefore matches EVERY sprint in the Jira instance, and the
 * only way to get one is the most ordinary typo there is — a trailing comma.
 * The field still reads "ruby", the team still looks configured, and the sprint
 * list is simply enormous.
 *
 * That is not hypothetical here: this tool has already shipped one bug of
 * exactly that shape, where Malphite was shown 44 of other teams' sprints as
 * its own. So the empty keyword gets its own checks, and they are the loudest
 * ones in the file.
 *
 * The rest is about not losing what someone typed. A separator that is not a
 * comma used to be swallowed into the keyword itself, producing a value that
 * could never match and never said so.
 *
 * Run: node test/keywords.test.js
 */

const assert = require('node:assert');
const kw = require('../lib/keywords');

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

console.log('\nKeyword lists\n');

/* ── the empty keyword ───────────────────────────────────────────────── */

check('AN EMPTY KEYWORD IS NEVER STORED — it would match every sprint there is', () => {
  // Every shape of "nothing" anyone can type or send.
  for (const input of ['', '   ', ',', ',,', 'ruby,', ',ruby', 'ruby,,titan', ['', 'ruby'], ['ruby', '  '], [null], [undefined]]) {
    for (const k of kw.parse(input)) {
      assert.ok(k.length > 0, `${JSON.stringify(input)} produced an empty keyword`);
    }
  }
  assert.deepStrictEqual(kw.parse('ruby,'), ['ruby'], 'a trailing comma is a typo, not a keyword');
  assert.deepStrictEqual(kw.parse(',,,'), [], 'and nothing but separators is nothing');
});

check('which is the difference between matching one team and matching all of them', () => {
  // Stated as the consequence, because the rule only makes sense as one.
  const names = ['Ruby Sprint 40', 'TT Week 31Aug', 'Titan Sprint 12'];
  const match = (list) => names.filter(n => list.some(k => n.toLowerCase().includes(k.toLowerCase())));
  assert.deepStrictEqual(match(kw.parse('ruby,')), ['Ruby Sprint 40'], 'one team');
  // The unparsed version, for contrast — this is what used to be stored.
  const raw = 'ruby,'.split(',').map(s => s.trim());
  assert.strictEqual(match(raw).length, 3, 'the check is pointless if the bad input was harmless');
});

/* ── separators ──────────────────────────────────────────────────────── */

check('COMMAS, SEMICOLONS, NEWLINES AND TABS ALL SEPARATE', () => {
  const want = ['ruby', 'titan'];
  for (const input of ['ruby,titan', 'ruby, titan', 'ruby;titan', 'ruby; titan', 'ruby\ntitan', 'ruby\ttitan', 'ruby ,; titan']) {
    assert.deepStrictEqual(kw.parse(input), want, JSON.stringify(input));
  }
});

check('BUT A SPACE DOES NOT — "TT Week" is one keyword, not two', () => {
  // Splitting on spaces would turn his TrueTest boards' keyword into "tt" and
  // "week", each of which matches far more than it should.
  assert.deepStrictEqual(kw.parse('TT Week'), ['TT Week']);
  assert.deepStrictEqual(kw.parse('TT Week, Katalon Auto Ruby'), ['TT Week', 'Katalon Auto Ruby']);
});

check('a list whose entries are themselves separated is flattened', () => {
  // What a pasted value looks like once the browser has put it in one slot.
  assert.deepStrictEqual(kw.parse(['ruby, titan', 'malphite']), ['ruby', 'titan', 'malphite']);
});

/* ── shape ───────────────────────────────────────────────────────────── */

check('a bare string is a list of one, not a list of characters', () => {
  assert.deepStrictEqual(kw.parse('ruby'), ['ruby']);
  assert.deepStrictEqual(kw.parse(['ruby']), ['ruby']);
});

check('nothing at all is an empty list, not a crash', () => {
  for (const input of [null, undefined, [], '']) assert.deepStrictEqual(kw.parse(input), []);
});

check('an object in the list is dropped, not stringified into nonsense', () => {
  // `String({})` is "[object Object]" — a keyword that matches nothing and
  // reads like a bug report when someone finds it in plan.json.
  assert.deepStrictEqual(kw.parse(['ruby', {}, ['nested'], 'titan']), ['ruby', 'titan']);
  assert.deepStrictEqual(kw.validate({ ruby: true }).list, []);
  assert.match(kw.validate({ ruby: true }).errors[0], /must be a list/);
});

check('numbers survive, because a sprint keyword can be one', () => {
  assert.deepStrictEqual(kw.parse([2092, 'ruby']), ['2092', 'ruby']);
});

/* ── duplicates ──────────────────────────────────────────────────────── */

check('DUPLICATES COLLAPSE CASE-INSENSITIVELY, keeping the first spelling', () => {
  // Matching is case-insensitive downstream, so "Ruby" and "ruby" are one
  // keyword. Showing both back suggests they do different things.
  assert.deepStrictEqual(kw.parse('Ruby, ruby, RUBY'), ['Ruby']);
  assert.deepStrictEqual(kw.parse(['titan', 'Titan', 'ruby']), ['titan', 'ruby']);
});

check('but two keywords that differ by more than case both stay', () => {
  assert.deepStrictEqual(kw.parse('ruby, ruby2'), ['ruby', 'ruby2']);
});

/* ── limits ──────────────────────────────────────────────────────────── */

check('a pasted file is capped rather than stored whole', () => {
  const many = Array.from({ length: 200 }, (_, i) => `k${i}`);
  assert.strictEqual(kw.parse(many).length, kw.MAX_KEYWORDS);
  assert.match(kw.validate(many).errors.join(' '), /first 40/);
});

check('and an absurdly long keyword is cut, not rejected', () => {
  // Cut rather than dropped: the first 80 characters of what they typed is
  // still probably the keyword they meant.
  const long = 'x'.repeat(500);
  assert.strictEqual(kw.parse(long)[0].length, kw.MAX_LENGTH);
  assert.match(kw.validate(long).errors.join(' '), /80 characters/);
});

/* ── what the save reports ───────────────────────────────────────────── */

check('a dropped empty is REPORTED, not silently swallowed', () => {
  // Silence is how someone concludes the field ate their input.
  assert.deepStrictEqual(kw.validate('ruby,').errors, ['1 empty entry was ignored']);
  // Consecutive separators collapse — `,,` is ONE mistake, not two, so this
  // reports the single trailing blank rather than inflating the count.
  assert.deepStrictEqual(kw.validate('ruby,,titan,').errors, ['1 empty entry was ignored']);
  assert.deepStrictEqual(kw.validate('ruby, ,titan').errors, ['1 empty entry was ignored'],
    'a separator with only space between is still one empty entry');
});

check('but CLEARING the field reports nothing — that is a deletion, not a mistake', () => {
  assert.deepStrictEqual(kw.validate('').errors, []);
  assert.deepStrictEqual(kw.validate([]).errors, []);
  assert.deepStrictEqual(kw.validate(',,').errors, [], 'emptying a field is allowed to be quiet');
});

check('an ordinary save says nothing at all', () => {
  assert.deepStrictEqual(kw.validate('ruby, titan'), { list: ['ruby', 'titan'], errors: [] });
});

/* ── the fallback ────────────────────────────────────────────────────── */

check('A TEAM WITH NO KEYWORDS FALLS BACK TO ITS NAME', () => {
  // Three call sites had their own copy of this rule. They agreed by luck.
  assert.deepStrictEqual(kw.forTeam({ name: 'Katalon Auto Ruby', sprintKeywords: [] }), ['Katalon Auto Ruby']);
  assert.deepStrictEqual(kw.forTeam({ name: 'Katalon Auto Ruby' }), ['Katalon Auto Ruby']);
  assert.deepStrictEqual(kw.forTeam({ name: 'X', sprintKeywords: ['ruby'] }), ['ruby'],
    'and does NOT fall back when it has keywords');
});

check('a team whose stored keywords are all empty falls back too', () => {
  // The state a pre-parsing plan.json can already be in. Without the fallback
  // it would have one empty keyword and match everything.
  assert.deepStrictEqual(kw.forTeam({ name: 'Ruby', sprintKeywords: ['', '  '] }), ['Ruby']);
});

check('and a team with neither matches nothing rather than everything', () => {
  // The dangerous default. An empty list matches nothing, which is visibly
  // wrong; a list containing '' matches everything, which is invisibly wrong.
  assert.deepStrictEqual(kw.forTeam({}), []);
  assert.deepStrictEqual(kw.forTeam(null), []);
  assert.deepStrictEqual(kw.forTeam({ name: '   ' }), []);
});

check('the fallback parses the stored value too, so old data is cleaned on read', () => {
  assert.deepStrictEqual(kw.forTeam({ name: 'X', sprintKeywords: ['ruby,', 'ruby'] }), ['ruby']);
});

/* ── run ───────────────────────────────────────────────────────────── */

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
