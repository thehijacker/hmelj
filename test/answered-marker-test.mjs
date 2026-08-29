// Reply/forward markers: the cache round-trip and the EWS property mapping.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-ans-'));
process.env.CACHE_DIR = dir; process.env.DATA_DIR = dir;
const cache = await import(new URL('../server/cache.js', import.meta.url).href);

let pass=0, fail=0;
const ok=(c,m,e='')=>{ if(c){pass++;console.log('  ✓ '+m);} else {fail++;console.log('  ✗ '+m+(e?' — '+e:''));} };

const U='u', A='acct', F='INBOX';
cache.upsertMessages(U, A, F, null, [
  { uid: 1, subject: 'plain',     date: 3, seen: true },
  { uid: 2, subject: 'replied',   date: 2, seen: true, answered: true },
  { uid: 3, subject: 'forwarded', date: 1, seen: true, forwarded: true },
]);
const rows = cache.queryFolder(U, A, F, { page: 1, pageSize: 10 }).messages;
const by = Object.fromEntries(rows.map(r => [r.subject, r]));
console.log('cache round-trip');
ok(by.replied.answered === true && by.replied.forwarded === false, 'answered survives insert and read-back');
ok(by.forwarded.forwarded === true && by.forwarded.answered === false, 'forwarded survives insert and read-back');
ok(by.plain.answered === false && by.plain.forwarded === false, 'an untouched message has neither');

console.log('\napplyFlags (what the send path calls)');
cache.applyFlags(U, A, F, [1], { add: ['\\Answered'] });
cache.applyFlags(U, A, F, [2], { add: ['$Forwarded'] });
cache.applyFlags(U, A, F, [3], { add: ['$forwarded'] }); // lowercase: keywords are case-insensitive
const after = Object.fromEntries(cache.queryFolder(U, A, F, { page:1, pageSize:10 }).messages.map(r=>[String(r.uid),r]));
ok(after['1'].answered === true, '\\Answered marks the row');
ok(after['2'].forwarded === true, '$Forwarded marks the row');
ok(after['3'].forwarded === true, '$forwarded (lowercase) marks it too');
ok(after['2'].answered === true, 'a forwarded reply keeps its reply mark (separate columns)');

console.log('\nreconcile must not wipe the marks');
// A poll returning the same flags must leave them alone.
cache.applyFlagsSnapshot(U, A, F, [
  { uid: 1, seen: true, flagged: false, answered: true,  forwarded: false, deleted: false },
  { uid: 2, seen: true, flagged: false, answered: true,  forwarded: true,  deleted: false },
  { uid: 3, seen: true, flagged: false, answered: false, forwarded: true,  deleted: false },
]);
const rec = Object.fromEntries(cache.queryFolder(U, A, F, { page:1, pageSize:10 }).messages.map(r=>[String(r.uid),r]));
ok(rec['1'].answered && rec['2'].forwarded && rec['3'].forwarded, 'a reconcile carrying the same state preserves it');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
