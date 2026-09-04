// Hmelj — the Settings > Subject rewrite engine (server/subjectRules.js).
//
// Worth pinning down for the same reason search-scope-test.mjs is: a wrong
// answer here doesn't fail loudly, it just quietly shows the wrong subject on
// every row of the list. And the two failure modes it guards against are
// opposite ones — a plain-text rule that silently behaves as a regex (its find
// string is FULL of metacharacters: "[Dogodek 2608260021] Posodobljen — "), and
// a regex rule that throws and takes a list response down with it.
//
// The subjects here are the real ones this feature was built for.
//
//   node test/subject-rules-test.mjs
import {
  applyRules, explain, compile, validate, validateAll, appliesTo,
  MAX_SUBJECT, MAX_FIND, MAX_RULES,
} from '../server/subjectRules.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
const eq = (a, b, m) => ok(a === b, m, `got ${JSON.stringify(a)}`);

/** A rule with the defaults filled in, so each test only states what it means. */
const rule = (o) => ({ id: o.find, name: o.find, enabled: true, accountIds: [], mode: 'text', replace: '', ignoreCase: false, all: false, ...o });

const A1 = '[Dogodek 2608260021] Posodobljen — Napovedana vzdrževalna dela A1: Obalno-kraška in Goriška';

console.log('plain text is literal, metacharacters and all');
eq(applyRules('a.c', [rule({ find: 'a.c', replace: 'X' })]), 'X',
  'a literal dot matches a dot');
eq(applyRules('abc', [rule({ find: 'a.c', replace: 'X' })]), 'abc',
  'and NOT any character — this is the whole difference between the two modes');
eq(applyRules(A1, [rule({ find: '[Dogodek 2608260021] Posodobljen — ', replace: 'U-' })]),
  'U-Napovedana vzdrževalna dela A1: Obalno-kraška in Goriška',
  'the real subject, shortened by a plain-text rule whose find string is full of metacharacters');

console.log('regex mode');
eq(applyRules(A1, [rule({ mode: 'regex', find: '^\\[.*?\\] Posodobljen — ', replace: 'U-' })]),
  'U-Napovedana vzdrževalna dela A1: Obalno-kraška in Goriška',
  'the same shortening, written as a pattern');
eq(applyRules(A1, [rule({ mode: 'regex', find: '^\\[Dogodek (\\d+)\\] \\S+ — ', replace: '#$1 ' })]),
  '#2608260021 Napovedana vzdrževalna dela A1: Obalno-kraška in Goriška',
  '$1 puts a captured group into the replacement');

console.log('flags');
eq(applyRules('NOC ticketing', [rule({ find: 'noc ticketing', replace: 'NOC TT' })]), 'NOC ticketing',
  'case matters by default');
eq(applyRules('NOC ticketing', [rule({ find: 'noc ticketing', replace: 'NOC TT', ignoreCase: true })]), 'NOC TT',
  'ignoreCase turns that off');
eq(applyRules('a a a', [rule({ find: 'a', replace: 'b' })]), 'b a a',
  'first occurrence only by default');
eq(applyRules('a a a', [rule({ find: 'a', replace: 'b', all: true })]), 'b b b',
  'all: every occurrence');

console.log('rules chain, top to bottom');
eq(applyRules('[Dogodek 2608260021] Posodobljen — Noc ticketing A1', [
  rule({ find: '[Dogodek 2608260021] Posodobljen — ', replace: 'U-' }),
  rule({ find: 'Noc ticketing', replace: 'NOC TT' }),
]), 'U-NOC TT A1', 'the second rule works on the first one\'s output');
eq(applyRules('one', [
  rule({ find: 'one', replace: 'two' }),
  rule({ find: 'two', replace: 'three' }),
]), 'three', 'a rule can match what the rule above it produced — order is the program');
eq(applyRules('one', [
  rule({ find: 'two', replace: 'three' }),
  rule({ find: 'one', replace: 'two' }),
]), 'two', 'and the reverse order genuinely gives a different answer');

console.log('what is skipped');
eq(applyRules(A1, [rule({ find: 'Posodobljen', replace: 'U', enabled: false })]), A1,
  'a disabled rule does nothing');
eq(applyRules('x', [rule({ find: '', replace: 'y' })]), 'x',
  'an empty find is inert, not a match-everything');
eq(applyRules('x', [rule({ mode: 'regex', find: '([', replace: 'y' })]), 'x',
  'a pattern that does not compile is skipped, NOT thrown — a list response must not die of a typo');
ok(compile(rule({ mode: 'regex', find: '([' })) === null, 'compile() reports that as null');
eq(applyRules('x', []), 'x', 'no rules at all: the same string back');
eq(applyRules('x', null), 'x', 'and a missing rule list is not a crash either');
eq(applyRules(null, [rule({ find: 'a', replace: 'b' })]), '', 'a null subject becomes empty, not "null"');

console.log('account scoping');
const scoped = [rule({ find: 'a', replace: 'b', accountIds: ['acct-1'] })];
eq(applyRules('a', scoped, 'acct-1'), 'b', 'a rule runs for an account it names');
eq(applyRules('a', scoped, 'acct-2'), 'a', 'and not for one it does not');
eq(applyRules('a', [rule({ find: 'a', replace: 'b', accountIds: [] })], 'acct-9'), 'b',
  'an empty accountIds means every account');
ok(appliesTo({ accountIds: undefined }, 'x'), 'so does a missing one');
ok(appliesTo({ accountIds: ['x', 'y'] }, 'y'), 'a rule can name several accounts');

console.log('input is capped');
const huge = 'z'.repeat(5000);
eq(applyRules(huge, []).length, MAX_SUBJECT,
  `a ${huge.length}-character subject is cut to ${MAX_SUBJECT} before any pattern sees it`);

console.log('explain() — what the Test panel shows');
{
  const rules = [
    rule({ id: 'r1', name: 'Dogodek', find: '[Dogodek 2608260021] Posodobljen — ', replace: 'U-' }),
    rule({ id: 'r2', name: 'never', find: 'nothing here', replace: 'x' }),
    rule({ id: 'r3', name: 'A1', find: 'A1', replace: 'avtocesta' }),
  ];
  const { result, steps } = explain(A1, rules);
  eq(result, 'U-Napovedana vzdrževalna dela avtocesta: Obalno-kraška in Goriška', 'the same answer applyRules gives');
  eq(steps.length, 2, 'only the rules that actually CHANGED something are listed');
  eq(steps.map((s) => s.id).join(','), 'r1,r3', 'in the order they ran');
  eq(steps[1].before, 'U-Napovedana vzdrževalna dela A1: Obalno-kraška in Goriška',
    "each step's `before` is the previous step's output, not the original subject");
  eq(explain('x', rules).steps.length, 0, 'nothing matched: no steps');
}

console.log('validate()');
ok(validate(rule({ find: 'a' })).ok, 'an ordinary rule is fine');
ok(!validate(rule({ find: '' })).ok, 'nothing to find is refused');
ok(!validate(rule({ mode: 'regex', find: '([' })).ok, 'an uncompilable pattern is refused at save time (unlike at read time, where it is merely inert)');
ok(!validate(rule({ find: 'a'.repeat(MAX_FIND + 1) })).ok, 'an over-long find is refused');
ok(!validate(rule({ find: 'a', mode: 'sql' })).ok, 'an unknown mode is refused');
ok(!validate(rule({ find: 'a', accountIds: 'acct-1' })).ok, 'accountIds must be a list, not a string');
ok(!validate(rule({ find: 'a', replace: 42 })).ok, 'a non-string replacement is refused');

console.log('validate() refuses a pattern that would stall the server');
{
  // The textbook catastrophic backtracker. On a 998-character run of 'a' with
  // no '!' to find, this explores every way of splitting the run.
  const evil = rule({ mode: 'regex', find: '^(a+)+$', replace: 'x' });
  const t0 = Date.now();
  const r = validate(evil);
  const ms = Date.now() - t0;
  ok(!r.ok, 'a nested-quantifier pattern is refused', JSON.stringify(r));
  ok(ms < 10000, `and the refusal itself comes back promptly (${ms}ms)`);
}

console.log('validateAll()');
{
  const r = validateAll([rule({ find: 'a' }), rule({ name: 'broken', mode: 'regex', find: '([' })]);
  ok(!r.ok, 'one bad rule refuses the whole list — a chain half-saved is a different rewrite, not a smaller one');
  eq(r.index, 1, 'and it says which one');
  ok(r.error.includes('broken'), 'by name', r.error);
  ok(validateAll(Array.from({ length: MAX_RULES + 1 }, () => rule({ find: 'a' }))).ok === false,
    `at most ${MAX_RULES} rules`);
  ok(validateAll([]).ok, 'an empty list is valid — that is how you delete your last rule');
  ok(!validateAll('nope').ok, 'and a non-list is not');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
