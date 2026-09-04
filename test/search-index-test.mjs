// Full-text search index (cache.js#message_fts + contentCache.js's indexing) —
// the opt-in-per-account body search.
//
// Everything here runs against a throwaway DATA_DIR, never the real one: this
// suite writes, and cache.sqlite is the one file in the project that a test
// getting its path wrong could damage on a live instance. The env vars are set
// before server/config.js is ever imported, which is why the imports below are
// dynamic — a static `import` would be hoisted above them and read the .env.
//
//   node test/search-index-test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-fts-'));
process.env.DATA_DIR = tmp;
process.env.CACHE_DIR = tmp;
process.env.CACHE_ENABLED = 'true';
process.env.HMELJ_SECRET = 'test-secret-not-a-real-one';

const cache = await import('../server/cache.js');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const U = 'user1';
const A = 'acct-indexed';
const B = 'acct-plain';

/** One cached message, indexed the way contentCache.js indexes it. */
function put(account, folder, uid, { subject, body, sender = 'ana@example.com', recipients = 'me@example.com', date = uid }) {
  cache.upsertMessages(U, account, folder, null, [{
    uid, subject, from: { name: '', address: sender }, to: [{ address: recipients }],
    date: new Date(1700000000000 + Number(date) * 1000), size: 100,
  }]);
  const rowid = cache.saveMessageContent(U, account, folder, uid, { subject, text: body }, 100);
  cache.indexMessageContent(rowid, { body, subject, sender, recipients });
  return rowid;
}

const found = (q, { accounts, folder = 'INBOX', account = A }) =>
  cache.queryFolder(U, account, folder, { q, indexed: accounts })
    .messages.map((m) => String(m.uid)).sort();

console.log('the index finds words that only exist in the body');
put(A, 'INBOX', '1', { subject: 'Ponudba za marec', body: 'Pozdravljeni, pogodba je v prilogi. Lep pozdrav, Ana' });
put(A, 'INBOX', '2', { subject: 'Sestanek', body: 'Predlagam sestanek jutri ob devetih v pisarni.' });
put(A, 'INBOX', '3', { subject: 'Racun 2026-09', body: 'V prilogi vam posiljamo racun za opravljene storitve.' });

ok(found('body:pogodba', { accounts: true }).join() === '1', 'body: matches a word that appears nowhere in the envelope');
ok(found('body:pogodba', { accounts: true }).length === 1, 'and only in the message that has it');
ok(found('body:sestanek', { accounts: true }).join() === '2', 'a second body: term picks its own message');
ok(found('body:nikjer', { accounts: true }).length === 0, 'a word in no message finds nothing');

console.log('\ndiacritics fold both ways (the whole point for Slovene mail)');
put(A, 'INBOX', '4', { subject: 'Zadeva', body: 'Račun za šumnike in čevlje je priložen.' });
ok(found('body:racun', { accounts: true }).includes('4'), 'unaccented query finds the accented word');
ok(found('body:šumnike', { accounts: true }).join() === '4', 'accented query finds it too');
ok(found('body:cevlje', { accounts: true }).join() === '4', 'č folds to c');

console.log('\nprefix matching, so a search box behaves like one');
ok(found('body:prilog', { accounts: true }).sort().join() === '1,3', '"prilog" finds both "prilogi" instances');
ok(found('body:posilja', { accounts: true }).join() === '3', 'partial word from the start matches');

console.log('\nan unscoped term searches the body as well as the envelope');
ok(found('pogodba', { accounts: true }).join() === '1', 'unscoped finds a body-only word on an indexed account');
ok(found('Sestanek', { accounts: true }).join() === '2', 'and still finds a subject word');
ok(found('pogodba', { accounts: false }).length === 0, 'without the index, unscoped is envelope-only — body word not found');
ok(found('Sestanek', { accounts: false }).join() === '2', 'while the envelope half is unaffected');

console.log('\noperators a person might type are words here, not syntax');
put(A, 'INBOX', '5', { subject: 'Notes', body: 'the release is scheduled AND approved (finally) * see below' });
for (const q of ['body:AND', 'body:(finally)', 'body:*', 'body:"scheduled AND approved"', 'body:^start', 'body:a:b']) {
  let threw = null;
  try { found(q, { accounts: true }); } catch (e) { threw = e; }
  ok(!threw, `${q} does not blow up the query`, threw?.message);
}
ok(found('body:"scheduled AND approved"', { accounts: true }).join() === '5', 'a quoted phrase matches as a phrase');

console.log('\nexclusion');
ok(found('body:prilogi -body:pogodba', { accounts: true }).join() === '3', '-body: removes the message that matched');

console.log('\nrouting: a body term is only servable when every account in scope is indexed');
ok(cache.bodySearchServable('body:x', [{ searchIndex: true }]) === true, 'one indexed account: servable');
ok(cache.bodySearchServable('body:x', [{ searchIndex: true }, { searchIndex: false }]) === false,
  'mixed: NOT servable — answering from the indexed half would look complete and be partial');
ok(cache.bodySearchServable('body:x', [{ searchIndex: false }]) === false, 'unindexed: not servable');
ok(cache.bodySearchServable('plain words', [{ searchIndex: false }]) === true, 'no body term: always servable from the envelope cache');
ok(cache.bodySearchServable('', [{ searchIndex: false }]) === true, 'empty query: servable');
let threw = null;
try { cache.queryFolder(U, B, 'INBOX', { q: 'body:x', indexed: false }); } catch (e) { threw = e; }
ok(threw && /body search/i.test(threw.message), 'and the cache still refuses a body: term outright when not indexed');

console.log('\none account cannot see another account\'s indexed mail');
put(B, 'INBOX', '9', { subject: 'Drugi racun', body: 'pogodba za drugi racun' });
ok(found('body:pogodba', { accounts: true, account: A }).join() === '1', 'account A sees only its own match');
ok(found('body:pogodba', { accounts: true, account: B }).join() === '9', 'account B sees only its own');

console.log('\nstale entries never outlive the content they shadow');
const before = cache.searchIndexStats(U, A).messages;
cache.removeMessageContent(U, A, 'INBOX', '2');
ok(found('body:sestanek', { accounts: true }).length === 0, 'removing the content removes the index entry');
ok(cache.searchIndexStats(U, A).messages === before - 1, 'and the count drops by exactly one');

cache.pruneMessageContent(U, A, 'INBOX', ['1']);
ok(found('body:racun', { accounts: true }).length === 0, 'pruning out of the window unindexes too');
ok(found('body:pogodba', { accounts: true }).join() === '1', 'while the kept message stays indexed');

console.log('\nre-caching a message replaces its text rather than adding to it');
const rid = cache.saveMessageContent(U, A, 'INBOX', '1', { subject: 'Ponudba', text: 'popolnoma drugo besedilo' }, 100);
cache.indexMessageContent(rid, { body: 'popolnoma drugo besedilo', subject: 'Ponudba' });
ok(found('body:pogodba', { accounts: true }).length === 0, 'the OLD body no longer matches (a contentless FTS row must be deleted before re-insert)');
ok(found('body:besedilo', { accounts: true }).join() === '1', 'the new body does');

console.log('\nsaveMessageContent marks a row for re-indexing');
ok(cache.unindexedContent(U, A, 10).length === 0, 'indexed rows are not in the worklist');
cache.saveMessageContent(U, A, 'INBOX', '1', { subject: 'x', text: 'y' }, 10);
ok(cache.unindexedContent(U, A, 10).length === 1, 'but a re-cache puts it back on it');

console.log('\nthe worklist covers folders the poller never visits');
// The reported symptom: "12 waiting" that never drained. Content is cached for
// any folder a message is OPENED in — Trash, All Mail — and those are out of
// sync scope, so a per-FOLDER worklist was never consulted for them and the
// rows sat unindexed forever.
const orphan = cache.saveMessageContent(U, A, '[Gmail]/Vsa pošta', '500', { subject: 'Arhiv', text: 'staro besedilo' }, 100);
ok(cache.unindexedContent(U, A, 50).some((r) => r.rowid === orphan),
  'a row in a never-polled folder IS on the worklist');
ok(cache.unindexedContent(U, A, 50).find((r) => r.rowid === orphan).folder === '[Gmail]/Vsa pošta',
  'and it says which folder it is in, so the indexer can report failures usefully');
const pendingBefore = cache.searchIndexStats(U, A).pending;
cache.indexMessageContent(orphan, { body: 'staro besedilo' });
ok(cache.searchIndexStats(U, A).pending === pendingBefore - 1,
  'and indexing it drains the "waiting" count — which is the symptom that showed the bug: a number that never went down');
ok(!cache.unindexedContent(U, A, 50).some((r) => r.rowid === orphan), 'it is off the worklist afterwards');

console.log('\nturning the account off drops its index and nothing else');
put(A, 'INBOX', '20', { subject: 'Keep me', body: 'iskalna beseda' });
put(B, 'INBOX', '21', { subject: 'Other', body: 'iskalna beseda' });
cache.dropSearchIndex(U, A);
ok(found('body:iskalna', { accounts: true, account: A }).length === 0, 'account A is no longer searchable by body');
ok(found('body:iskalna', { accounts: true, account: B }).join() === '21', "account B's index is untouched");
ok(cache.getMessageContent(U, A, 'INBOX', '20') != null, 'the cached CONTENT survives — only the index was dropped');
ok(cache.unindexedContent(U, A, 10).length > 0, 'and those rows are ready to be re-indexed if it is turned back on');

console.log('\ndeleting an account leaves nothing behind');
cache.deleteAccountCache(U, B);
ok(found('body:iskalna', { accounts: true, account: B }).length === 0, "a deleted account's mail is not findable");
ok(cache.getMessageContent(U, B, 'INBOX', '21') == null, 'its cached content is gone');
ok(cache.searchIndexStats(U, B).messages === 0, 'and it holds no index rows');

console.log('\nthe size budget is a stop, not an evictor');
ok(cache.searchIndexOverBudget(0) === false, '0 means no limit');
ok(cache.searchIndexOverBudget(1024) === false, 'a budget far above the current size is not exceeded');
ok(cache.searchIndexStats(U).bytes > 0, 'the index reports a size at all');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
