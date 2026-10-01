// Settings › Storage (cache.js#storageReport).
//
// Two things here are easy to get quietly wrong. The category a table lands in
// decides which bar it swells — and an index is part of what its table costs,
// while `message_content` and `message_fts` both start with `message`, so a
// careless prefix match puts the search index under "Message list". And the
// per-account section must only ever describe the asking user's own rows:
// cache.sqlite holds everyone's, and a report that leaked another user's
// account would be a privacy bug that looks like a rounding error.
//
//   node test/storage-report-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-st-'));
process.env.CACHE_DIR = dir; process.env.DATA_DIR = dir;
const cache = await import(new URL('../server/cache.js', import.meta.url).href);

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
const eq = (a, b, m) => ok(a === b, m, `got ${JSON.stringify(a)}`);

console.log('which bar a table belongs to');
// Every table and index this database actually has (read off a live install).
for (const [name, want] of [
  ['message_content', 'bodies'], ['sqlite_autoindex_message_content_1', 'bodies'], ['idx_content_unindexed', 'bodies'],
  ['message_fts_data', 'search'], ['message_fts_idx', 'search'], ['message_fts_docsize', 'search'], ['message_fts_config', 'search'],
  ['search_words', 'search'], ['sqlite_autoindex_search_words_1', 'search'],
  ['analytics_messages', 'analytics'], ['sqlite_autoindex_analytics_messages_1', 'analytics'], ['idx_an_date', 'analytics'], ['analytics_scan_state', 'analytics'],
  ['messages', 'list'], ['sqlite_autoindex_messages_1', 'list'], ['idx_messages_thread', 'list'], ['folders', 'list'], ['sync_state', 'list'],
  ['calendar_events', 'calendars'], ['idx_calendar_window', 'calendars'], ['idx_reminders_fired_at', 'calendars'], ['idx_snoozes_fire_at', 'calendars'],
  ['filter_applied', 'other'], ['user_log', 'other'], ['sqlite_schema', 'other'], ['sqlite_sequence', 'other'],
]) eq(cache.storageCategoryOf(name), want, `${name} → ${want}`);
ok(cache.storageCategoryOf('message_content') !== cache.storageCategoryOf('messages'),
  'message_content and messages are not the same bar, though one name starts the other');
ok(cache.storageCategoryOf('message_fts_data') !== cache.storageCategoryOf('messages'),
  'and nor is the search index');

console.log('\nonly your own accounts');
const ME = 'me-11111111', OTHER = 'other-22222222';
const put = (user, account, uid, size) => {
  cache.upsertMessages(user, account, 'INBOX', null, [{
    uid, subject: 's', from: { name: '', address: 'a@b' }, to: [], date: new Date().toISOString(),
    size: 10, seen: false, flagged: false, deleted: false, draft: false, hasAttachment: false,
    messageId: `${user}-${uid}@x`, threadKey: `${user}-${uid}@x`,
  }]);
  cache.saveMessageContent(user, account, 'INBOX', uid, { subject: 's', html: 'x'.repeat(size) }, size);
};
put(ME, 'mine-1', 1, 500);
put(ME, 'mine-1', 2, 700);
put(ME, 'mine-2', 3, 300);
put(OTHER, 'theirs', 4, 9999);

const r = cache.storageReport(ME, ['mine-1', 'mine-2']);
eq(r.accounts.length, 2, 'the report lists exactly the accounts asked for');
ok(!r.accounts.some((a) => a.accountId === 'theirs'), 'another user\'s account never appears');
const m1 = r.accounts.find((a) => a.accountId === 'mine-1');
eq(m1.bodies.count, 2, 'cached bodies are counted per account');
eq(m1.bodies.bytes, 1200, 'and their bytes are the exact stored sizes, summed');
eq(m1.list.count, 2, 'envelopes are counted per account');
eq(r.accounts.find((a) => a.accountId === 'mine-2').bodies.bytes, 300, 'a second account is kept apart from the first');
// Asking about an account by id is not enough to see it under someone else's key.
const leak = cache.storageReport(ME, ['theirs']);
eq(leak.accounts[0].bodies.bytes, 0, 'naming another user\'s account id still reads only YOUR rows for it — none');
eq(r.whole, null, 'the whole-file section is left out unless asked for (the route asks only for an admin)');

console.log('\nthe whole file');
const w = cache.storageReport(ME, [], { includeWholeFile: true }).whole;
ok(w && w.fileBytes > 0, 'it has a size');
ok(w.usedBytes + w.reclaimableBytes > 0, 'used and reclaimable are reported');
if (w.categories) {
  const sum = Object.values(w.categories).reduce((a, b) => a + b, 0);
  eq(sum, w.usedBytes, 'the categories add up to exactly the used space — nothing counted twice, nothing dropped');
} else {
  ok(true, 'this SQLite has no dbstat — totals only, which the page states');
}

console.log('\nclearing cached bodies');
const removed = cache.clearMessageContentFor(ME, 'mine-1');
eq(removed, 2, 'clearing one account removes its cached bodies');
const after = cache.storageReport(ME, ['mine-1', 'mine-2']);
eq(after.accounts.find((a) => a.accountId === 'mine-1').bodies.count, 0, 'which the next report shows at once, not a minute later');
eq(after.accounts.find((a) => a.accountId === 'mine-1').list.count, 2, 'while the message list is untouched — only the copies of the bodies go');
eq(after.accounts.find((a) => a.accountId === 'mine-2').bodies.count, 1, 'and the other account keeps its own');
eq(cache.storageReport(OTHER, ['theirs']).accounts[0].bodies.count, 1, 'and so does every other user');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
