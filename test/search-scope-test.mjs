// What the search box actually asks the mail server for
// (imapClient.js#buildImapSearchCriteria), and in particular the difference
// "Search everywhere" makes: an unscoped term stops being three header fields
// and becomes TEXT — the whole message, body included.
//
// This is worth pinning down because a wrong SearchObject doesn't fail loudly;
// it just quietly returns the wrong mail.
//
//   node test/search-scope-test.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-search-'));
process.env.DATA_DIR = dir; process.env.CACHE_DIR = path.join(dir, 'cache');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m, JSON.stringify(a));

const { buildImapSearchCriteria: build } = await import(new URL('../server/imapClient.js', import.meta.url).href);

console.log('the ordinary search (headers only)');
eq(build('dino'), { or: [{ subject: 'dino' }, { from: 'dino' }, { to: 'dino' }] },
  'an unscoped term is subject/from/to — never the body');
eq(build('subject:dino'), { subject: 'dino' }, 'a scoped term stays scoped');
eq(build('body:dino'), { body: 'dino' }, 'body: is the one thing that reaches message text');

console.log('"Search everywhere" (fullText)');
eq(build('dino', true), { text: 'dino' }, 'an unscoped term becomes TEXT: headers AND body, in one key');
eq(build('subject:dino', true), { subject: 'dino' }, 'an explicitly scoped term is left alone');
eq(build('body:dino', true), { body: 'dino' }, 'so is body:');

console.log('structure');
ok(build('') === null && build('   ') === null, 'an empty query asks for nothing at all');
const two = build('dino merlin', true);
ok(two && two.not && Array.isArray(two.not.or) && two.not.or.length === 2,
  'two required terms are ANDed via NOT(OR(NOT a, NOT b))', JSON.stringify(two));
const excl = build('dino -merlin', true);
ok(JSON.stringify(excl).includes('"not"'), 'an excluded term becomes a NOT', JSON.stringify(excl));
eq(build('"dino merlin"', true), { text: 'dino merlin' }, 'a quoted phrase stays one term');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
