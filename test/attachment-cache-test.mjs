// Holding attachment bytes without holding too many of them
// (server/attachmentCache.js).
//
// This exists because the alternative to caching an attachment is genuinely
// expensive — every backend answers "give me part 2" by downloading the whole
// message and running mailparser over it — and because the obvious cheap cache
// (a Map, or an LRU counting entries) is the wrong shape: sixty-four
// thumbnails is nothing and sixty-four videos is a gigabyte, on a server whose
// whole job is to stay small enough to live on a home box.
//
//   node test/attachment-cache-test.mjs
import { createByteLru, attachmentKey, etagFor, etagMatches } from '../server/attachmentCache.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

console.log('keys');
const k = (u, a, f, uid, i) => attachmentKey(u, a, f, uid, i);
ok(k('u1', 'a1', 'INBOX', 7, 0) === k('u1', 'a1', 'INBOX', 7, 0), 'the same attachment keys the same way twice');
ok(k('u1', 'a1', 'INBOX', 7, 0) !== k('u1', 'a1', 'INBOX', 7, 1), 'two parts of one message are two entries');
ok(k('u1', 'a1', 'INBOX', 7, 0) !== k('u2', 'a1', 'INBOX', 7, 0), 'and one user never reads another user\'s bytes');
ok(k('u1', 'a1', 'INBOX', 7, 0) !== k('u1', 'a2', 'INBOX', 7, 0), 'nor one account another account\'s');
ok(k('u1', 'a1', 'INBOX', 7, 0) !== k('u1', 'a1', 'Sent', 7, 0), 'uid 7 means a different message in a different folder');
// A folder path can contain anything a server allows — "[Gmail]/Vsa pošta",
// "Work/2026", names with spaces. A separator that can appear in a path would
// let two different attachments collide on one key.
ok(attachmentKey('u', 'a', 'A/B', 1, 2) !== attachmentKey('u', 'a', 'A', '/B', 2), 'the separator cannot occur in any part of a key');
ok(attachmentKey('u', 'a', 'INBOX', 7, 'logo@x', 'cid') !== attachmentKey('u', 'a', 'INBOX', 7, 'logo@x'),
  'an inline image by Content-ID is not the attachment at that index');

console.log('the validator');
const key = k('u1', 'a1', 'INBOX', 7, 0);
ok(/^"[0-9a-z]+-\d+"$/.test(etagFor(key, 4096)), 'a strong ETag, quoted');
ok(etagFor(key, 4096) === etagFor(key, 4096), 'stable — the same bytes always answer the same way');
ok(etagFor(key, 4096) !== etagFor(k('u1', 'a1', 'INBOX', 7, 1), 4096), 'a different part is a different resource');
// The reason the length is in there at all. A server that reuses a uid after an
// expunge would otherwise serve the old bytes out of a browser cache that was
// told they were immutable.
ok(etagFor(key, 4096) !== etagFor(key, 4097), 'and so is the same part at a different length');

console.log('conditional requests');
const tag = etagFor(key, 10);
ok(etagMatches(tag, tag), 'the client holds exactly this one');
ok(etagMatches(`"other", ${tag}`, tag), 'one of several it lists');
ok(etagMatches(`W/${tag}`, tag), 'a weak comparison of it — same representation, as far as this resource is concerned');
ok(etagMatches('*', tag), '* means any representation it might have');
ok(!etagMatches('"nope"', tag), 'a tag for something else');
ok(!etagMatches('', tag) && !etagMatches(undefined, tag), 'no If-None-Match at all is not a match');
ok(!etagMatches(tag, ''), 'and neither is having no tag to compare against');

console.log('the cache, by bytes');
const lru = createByteLru({ maxBytes: 1000, maxEntries: 10 });
lru.set('a', 'A', 400);
lru.set('b', 'B', 400);
ok(lru.get('a') === 'A' && lru.get('b') === 'B', 'what went in comes out');
ok(lru.stats().bytes === 800, 'and the total is what was put in', String(lru.stats().bytes));
lru.set('c', 'C', 400);
ok(lru.stats().bytes <= 1000, 'over the budget, something is dropped', String(lru.stats().bytes));
ok(lru.get('c') === 'C' && lru.get('b') === 'B', 'the two most recent survive');
ok(lru.get('a') === undefined, 'and the least recently used is the one that went');

console.log('a hit is what keeps an entry alive');
const lru2 = createByteLru({ maxBytes: 1000, maxEntries: 10 });
lru2.set('x', 'X', 400);
lru2.set('y', 'Y', 400);
lru2.get('x');              // x is now the young one, y the old one
lru2.set('z', 'Z', 400);
ok(lru2.get('x') === 'X', 'the one that was read again is still there');
ok(lru2.get('y') === undefined, 'the one that was not is gone', String(lru2.get('y')));

console.log('replacing, removing, refusing');
const lru3 = createByteLru({ maxBytes: 1000, maxEntries: 10 });
lru3.set('k', 'first', 300);
lru3.set('k', 'second', 100);
ok(lru3.get('k') === 'second', 'writing the same key again replaces it');
ok(lru3.stats().bytes === 100, 'and the old size is not counted twice', String(lru3.stats().bytes));
ok(lru3.delete('k') && lru3.get('k') === undefined && lru3.stats().bytes === 0, 'delete takes the bytes with it');
ok(!lru3.delete('never-was'), 'deleting nothing is not a lie');

// The case that makes a naive byte-bounded LRU useless: one oversized item
// evicts everything, is stored, and is then itself evicted by the next insert —
// so a single large attachment would cost the cache all of its warm entries and
// gain nothing.
lru3.set('small', 'S', 500);
ok(lru3.set('huge', 'H', 5000) === false, 'something larger than the whole budget is refused, not stored');
ok(lru3.get('huge') === undefined, 'so it is not there');
ok(lru3.get('small') === 'S', 'and it did not take the warm entries down with it');
ok(lru3.set('nothing', 'N', 0) === false, 'a zero-length part is not worth an entry');

console.log('entry count bounds it too');
const lru4 = createByteLru({ maxBytes: 1e9, maxEntries: 2 });
lru4.set('1', 1, 10); lru4.set('2', 2, 10); lru4.set('3', 3, 10);
ok(lru4.stats().entries === 2, 'never more than maxEntries, however small they are', String(lru4.stats().entries));
ok(lru4.get('1') === undefined && lru4.get('3') === 3, 'and it is still the oldest that goes');

console.log('switched off');
const off = createByteLru({ maxBytes: 0, maxEntries: 0 });
ok(off.set('a', 'A', 1) === false && off.get('a') === undefined, 'a zero budget stores nothing at all');

console.log('clear');
const lru5 = createByteLru({ maxBytes: 1000 });
lru5.set('a', 'A', 400);
lru5.clear();
ok(lru5.stats().entries === 0 && lru5.stats().bytes === 0, 'nothing left, and no bytes still on the books');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
