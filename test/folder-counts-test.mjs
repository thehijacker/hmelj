// Hmelj — a folder's unread count must survive a listing that could not read it.
//
// The bug this pins down: IMAP's LIST does not answer STATUS for the mailbox
// that is currently SELECTED, and the selected mailbox is INBOX almost all of
// the time. So every background poll wrote NULL over INBOX's real counts, the
// badge stopped rendering, a manual refresh put it back (syncFolderNow ends
// with its own STATUS call), and the next poll wiped it again — which is
// exactly what it looked like from the outside.
//
// The durable half of the fix is here: a missing count means "I did not find
// out", never "zero", so the upsert must not clobber a known number with a
// null. Asserted against the real statement in server/cache.js.
//
//   node test/folder-counts-test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-fcount-'));
process.env.DATA_DIR = TMP;
process.env.CACHE_DIR = TMP;
process.env.HMELJ_SECRET = 'test-secret-not-a-real-one';
process.env.LOG = process.env.LOG || 'warn';

const cache = await import('../server/cache.js');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
const eq = (got, want, m) => ok(got === want, m, `got ${got}, want ${want}`);

const UK = 'tester-abc';
const ACC = 'acc-1';
const inbox = (over = {}) => ({
  path: 'INBOX', name: 'INBOX', delimiter: '.', parent: null, specialUse: '\\Inbox',
  subscribed: true, hidden: false, total: 129, unseen: 39, ...over,
});
const sent = { path: 'INBOX.Sent', name: 'Sent', delimiter: '.', parent: 'INBOX', specialUse: '\\Sent', subscribed: true, hidden: false, total: 94, unseen: 0 };
const of = (p) => cache.getFolders(UK, ACC).find((f) => f.path === p);

console.log('a listing that carried counts');
cache.upsertFolders(UK, ACC, [inbox(), sent]);
eq(of('INBOX').unseen, 39, 'the unread count is stored');
eq(of('INBOX').total, 129, 'and so is the total');

console.log('a listing that could NOT read them — the selected mailbox');
// Exactly what imapClient.js#listFolders produces when LIST returns no status
// for a folder: null, not 0.
cache.upsertFolders(UK, ACC, [inbox({ total: null, unseen: null }), sent]);
eq(of('INBOX').unseen, 39, 'the last known unread count survives');
eq(of('INBOX').total, 129, 'and so does the total');
eq(of('INBOX').specialUse, '\\Inbox', 'while everything the listing DID report is still updated');

console.log('undefined is treated the same as null');
const { total: _t, unseen: _u, ...noCounts } = inbox();
cache.upsertFolders(UK, ACC, [noCounts, sent]);
eq(of('INBOX').unseen, 39, 'a row with no count fields at all does not clear it either');

console.log('a real zero is still a zero');
// The distinction that makes this safe rather than merely sticky: reading a
// folder empties its badge, and that must not be mistaken for "unknown".
cache.upsertFolders(UK, ACC, [inbox({ total: 130, unseen: 0 }), sent]);
eq(of('INBOX').unseen, 0, 'marking everything read really does clear the badge');
eq(of('INBOX').total, 130, 'and the new total lands');

console.log('a folder the server stopped reporting is still removed');
cache.upsertFolders(UK, ACC, [inbox({ total: 130, unseen: 0 })]);
ok(!of('INBOX.Sent'), 'COALESCE protects counts, not rows');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
