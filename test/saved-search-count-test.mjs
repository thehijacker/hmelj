// The badge on a saved-search row — cache.js's `countOnly`.
//
// A saved search's unread count rides along on /api/unread, a request the
// client makes on every reconcile, so it has to be a COUNT and nothing else:
// no page select, and in conversation mode none of pageThreads' three-statement
// grouping pass. `countOnly` is that path, and the only thing it may not do is
// disagree with the listing it stands for.
//
// So that is what is asserted here: for the same options, `countOnly` must
// produce exactly the `total` the real listing produces. If the two ever drift,
// the sidebar says one number and opening the row shows another — which is the
// specific bug this feature could introduce and nothing else would catch.
//
//   node test/saved-search-count-test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-sscount-'));
process.env.DATA_DIR = TMP;
process.env.CACHE_DIR = TMP;
process.env.HMELJ_SECRET = 'test-secret-not-a-real-one';
process.env.LOG = process.env.LOG || 'warn';

const cache = await import('../server/cache.js');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const UK = 'tester-abc';
const ACC = { id: 'acc-1', label: 'Work', color: '#0b57d0', sentFolder: 'Sent', hiddenFolders: [] };
const DAY = 86400000;

const msg = (uid, over = {}) => ({
  uid,
  subject: `Racun ${uid}`,
  from: { name: 'Ana', address: 'ana@firma.si' },
  to: [{ address: 'me@firma.si' }],
  date: new Date(Date.now() - uid * DAY),
  seen: false, flagged: false, hasAttachment: false,
  messageId: `<m${uid}@firma.si>`,
  ...over,
});

cache.upsertFolders(UK, ACC.id, [
  { path: 'INBOX', name: 'INBOX', delimiter: '/', parent: null, specialUse: '\\Inbox', subscribed: true, hidden: false, total: 6, unseen: 4 },
  { path: 'Sent', name: 'Sent', delimiter: '/', parent: null, specialUse: '\\Sent', subscribed: true, hidden: false, total: 0, unseen: 0 },
]);
cache.upsertMessages(UK, ACC.id, 'INBOX', '\\Inbox', [
  msg(1),
  msg(2, { seen: true }),
  msg(3, { flagged: true }),
  msg(4, { subject: 'Pogodba za najem' }),
  msg(5, { subject: 'Pogodba, podpisana', seen: true }),
  msg(6, { subject: 'Racun 6', flagged: true, seen: true }),
]);

/** The two answers to the same question: the real listing's `total`, and the
 *  count-only path's. They are asserted equal, never against a hardcoded
 *  number — the point is that they agree, whatever the fixture happens to
 *  contain. The number is printed so a change to the fixture is still visible. */
const agree = (label, fn) => {
  const listed = fn(false).total;
  const counted = fn(true).total;
  ok(listed === counted, `${label} — ${counted}`, `listing says ${listed}, count says ${counted}`);
  return counted;
};

console.log('one folder');
const folder = (countOnly, opts) => cache.queryFolder(UK, ACC.id, 'INBOX', { pageSize: 50, countOnly, ...opts });
agree('everything in it', (c) => folder(c, {}));
const unread = agree('unread only', (c) => folder(c, { unreadOnly: true }));
ok(unread === 3, 'and the fixture really has 3 unread', `got ${unread}`);
agree('unread and starred', (c) => folder(c, { unreadOnly: true, flaggedOnly: true }));
agree('a search', (c) => folder(c, { q: 'pogodba' }));
agree('an unread search', (c) => folder(c, { q: 'pogodba', unreadOnly: true }));
agree('a search that matches nothing', (c) => folder(c, { q: 'zzz-nothing' }));
// Conversation mode is where countOnly saves the most work — and where it
// deliberately answers a different question from the listing: the listing rows
// are conversations, the badge counts MESSAGES, the same way a folder's own
// unread count does. So this one is not compared against the listing.
ok(folder(true, { threaded: true, unreadOnly: true }).total === unread,
  'in conversation mode the badge still counts messages, not threads');

console.log('\nthe unified view');
const unified = (countOnly, opts) => cache.queryUnified(UK, [ACC], { box: 'inbox', pageSize: 50, countOnly, ...opts });
agree('every inbox', (c) => unified(c, {}));
agree('unread only', (c) => unified(c, { unreadOnly: true }));
agree('starred only', (c) => unified(c, { flaggedOnly: true }));
agree('a search', (c) => unified(c, { q: 'racun' }));
agree('an unread search', (c) => unified(c, { q: 'racun', unreadOnly: true }));

console.log('\nnothing to count');
ok(cache.queryUnified(UK, [], { box: 'inbox', countOnly: true }).total === 0, 'no accounts is 0, not a crash');
ok(cache.queryFolder(UK, ACC.id, 'Nowhere', { countOnly: true }).total === 0, 'an unknown folder is 0');
ok(cache.queryFolder(UK, ACC.id, 'INBOX', { countOnly: true }).messages.length === 0,
  'and a count never carries messages back');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
