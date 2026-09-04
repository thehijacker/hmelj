// Saved searches (server/store.js#normalizeSavedSearches) — the shaping every
// write goes through before a saved search becomes a row in the sidebar.
//
// The rule this file exists for: a saved search is a QUESTION that gets re-run,
// so the two things it cannot be missing are something to ask and something to
// call it. Everything else is repaired rather than rejected — refusing a whole
// save would take the person's other saved searches down with the bad one.
//
//   node test/saved-searches-test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-saved-'));
process.env.DATA_DIR = tmp;
process.env.HMELJ_SECRET = 'test-secret-not-a-real-one';

const { normalizeSavedSearches } = await import('../server/store.js');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
const one = (input) => normalizeSavedSearches([input])[0];

console.log('a saved search must have something to ask');
ok(normalizeSavedSearches([{ name: 'No query' }]).length === 0, 'no query at all is dropped');
ok(normalizeSavedSearches([{ name: 'Blank', query: '   ' }]).length === 0, 'a whitespace-only query is dropped');
ok(normalizeSavedSearches([{ query: 42 }]).length === 0, 'a non-string query is dropped');
ok(normalizeSavedSearches([null, undefined, 0]).length === 0, 'junk entries are dropped');
ok(normalizeSavedSearches(null).length === 0, 'a non-array is an empty list, not a crash');
ok(normalizeSavedSearches(undefined).length === 0, 'and so is nothing at all');

console.log('\nand something to call it');
ok(one({ query: 'faktura' }).name === 'faktura', 'no name falls back to the query text');
// The bug this pins down: "   " is truthy, so a fallback that tests the name
// before trimming it accepted the whitespace and then trimmed it to "", leaving
// a sidebar row with no label on it.
ok(one({ name: '   ', query: 'body:pogodba' }).name === 'body:pogodba', 'a whitespace-ONLY name falls back too, rather than becoming empty');
ok(one({ name: '  Racuni  ', query: 'x' }).name === 'Racuni', 'a real name is kept, trimmed');
ok(one({ name: 'x'.repeat(200), query: 'q' }).name.length === 80, 'an over-long name is cut');
ok(one({ query: 'q'.repeat(900) }).query.length === 500, 'and so is an over-long query');

console.log('\nscope round-trips exactly as asked');
const unified = one({ name: 'All', query: 'q' });
ok(unified.accountId === null && unified.folder === null, 'no account means the unified view');
const scoped = one({ name: 'Work', query: 'q', accountId: 'acc1', folder: 'Archive/2026' });
ok(scoped.accountId === 'acc1' && scoped.folder === 'Archive/2026', 'an account and folder are carried through');
ok(one({ query: 'q', accountId: 'gone-account' }).accountId === 'gone-account',
  'an account that no longer exists is NOT scrubbed — a disabled account should survive, and opening it reports the problem then');

console.log('\nfilters are booleans, whatever was sent');
const f = one({ query: 'q', unreadOnly: 'yes', flaggedOnly: 0 });
ok(f.unreadOnly === true && f.flaggedOnly === false, 'truthy/falsy values become real booleans');
ok(one({ query: 'q' }).unreadOnly === false, 'and default to off');

console.log('\nids');
ok(one({ query: 'q' }).id.length > 0, 'an entry with no id is given one');
ok(one({ query: 'q', id: 'keep-me' }).id === 'keep-me', 'an existing id is kept, so renaming does not orphan the row');
const two = normalizeSavedSearches([{ query: 'a' }, { query: 'b' }]);
ok(two[0].id !== two[1].id, 'generated ids are distinct');

console.log('\nthe sidebar cannot be flooded');
ok(normalizeSavedSearches(Array.from({ length: 500 }, (_, i) => ({ query: 'q' + i }))).length === 100, 'capped at 100');

console.log('\nnothing unexpected survives into the stored record');
ok(!('junk' in one({ query: 'q', junk: 'dropped' })), 'an unknown field is not carried through');
ok(Object.keys(one({ query: 'q' })).sort().join() === 'accountId,flaggedOnly,folder,id,name,query,unreadOnly',
  'the shape is exactly the seven known fields');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
