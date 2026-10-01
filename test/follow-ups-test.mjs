// Follow-up reminders (server/followUps.js) — does it recognise a reply?
//
// The one thing that has to be right. A false "answered" silently drops a
// reminder the user was relying on; a false "no reply" nags about a
// conversation that was answered days ago. Both are invisible until they
// matter, so the decision is pinned here against a real SQLite cache, row by
// row, for every case that should and should not count — including the
// Exchange/Graph one, where the thread key is a ConversationId that only the
// server could assign and the header-derived guess would never match.
//
//   node test/follow-ups-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-fu-'));
process.env.CACHE_DIR = dir; process.env.DATA_DIR = dir;
const cache = await import(new URL('../server/cache.js', import.meta.url).href);
const { normalizeId, threadKeyFrom } = await import(new URL('../server/threading.js', import.meta.url).href);

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const U = 'tester-00000000';
const A = 'acct-1';
const ME = 'me@example.si';
const SENT_AT = Date.parse('2026-10-01T09:00:00Z');
const own = { ownAddresses: [ME], excludeFolders: ['Sent', 'Drafts'] };
let uid = 100;

/** One cached row, shaped the way the three clients hand them to upsertMessages. */
function row({ folder = 'INBOX', from = 'ana@firma.si', date = SENT_AT + 3600e3, thread, messageId, specialUse = null, deleted = false }) {
  cache.upsertMessages(U, A, folder, specialUse, [{
    uid: ++uid, subject: 'Ponudba', from: { name: '', address: from }, to: [{ address: ME }],
    date: new Date(date).toISOString(), size: 1000, seen: false, flagged: false,
    deleted, draft: false, hasAttachment: false,
    messageId: messageId || `m${uid}@x`, threadKey: thread,
  }]);
}

console.log('IMAP: the thread key is the root Message-ID');
{
  const mine = '<abc-123@example.si>';
  const key = threadKeyFrom({ messageId: mine });          // a new message: it IS the root
  row({ folder: 'Sent', from: ME, date: SENT_AT, thread: key, messageId: normalizeId(mine), specialUse: '\\Sent' });

  ok(cache.findThreadKeyFor(U, A, normalizeId(mine)) === key, 'our sent copy is found by its Message-ID, and gives back its thread key');
  ok(!cache.hasReplyInThread(U, A, key, SENT_AT, own), 'with only our own copy in the thread, there is no reply');

  row({ folder: 'Sent', from: ME, date: SENT_AT + 7200e3, thread: key, specialUse: '\\Sent' });
  ok(!cache.hasReplyInThread(U, A, key, SENT_AT, own), 'a second message WE sent in the same thread is not an answer');

  row({ folder: 'INBOX', from: ME, date: SENT_AT + 8000e3, thread: key });
  ok(!cache.hasReplyInThread(U, A, key, SENT_AT, own), 'nor is one from our own address that landed in the Inbox (Cc to self)');

  row({ folder: 'Drafts', from: 'ana@firma.si', date: SENT_AT + 9000e3, thread: key, specialUse: '\\Drafts' });
  ok(!cache.hasReplyInThread(U, A, key, SENT_AT, own), 'a draft in the thread is not an answer, whoever it names');

  row({ folder: 'INBOX', from: 'ana@firma.si', date: SENT_AT - 86400e3, thread: key });
  ok(!cache.hasReplyInThread(U, A, key, SENT_AT, own), 'a message from BEFORE we sent is the conversation we answered, not an answer to us');

  row({ folder: 'INBOX', from: 'ana@firma.si', date: SENT_AT + 86400e3, thread: key, deleted: true });
  ok(!cache.hasReplyInThread(U, A, key, SENT_AT, own), 'a reply that has since been deleted does not count');

  row({ folder: 'INBOX', from: 'Ana@Firma.si', date: SENT_AT + 86400e3, thread: key });
  ok(cache.hasReplyInThread(U, A, key, SENT_AT, own), 'a reply from someone else, after we sent, in the Inbox — answered');
}

console.log('\nIMAP: a reply that a filter moved out of the Inbox');
{
  const mine = '<filed-1@example.si>';
  const key = threadKeyFrom({ messageId: mine });
  row({ folder: 'Sent', from: ME, date: SENT_AT, thread: key, messageId: normalizeId(mine), specialUse: '\\Sent' });
  row({ folder: 'INBOX/Stranke', from: 'boss@firma.si', date: SENT_AT + 3600e3, thread: key });
  ok(cache.hasReplyInThread(U, A, key, SENT_AT, own), 'still found — any synced folder counts, not only the Inbox');
}

console.log('\nOur message was itself a reply');
{
  // We answered Ana's message <root@firma.si>; References puts that root first,
  // so our copy and her next reply share it as their thread key.
  const key = threadKeyFrom({ messageId: '<ours@example.si>', references: '<root@firma.si>' });
  ok(key === 'root@firma.si', 'the thread key is the conversation root, not our own id');
  row({ folder: 'Sent', from: ME, date: SENT_AT, thread: key, messageId: 'ours@example.si', specialUse: '\\Sent' });
  ok(!cache.hasReplyInThread(U, A, key, SENT_AT, own), 'no reply yet');
  row({ folder: 'INBOX', from: 'ana@firma.si', date: SENT_AT + 600e3, thread: key });
  ok(cache.hasReplyInThread(U, A, key, SENT_AT, own), 'her answer is found in the same conversation');
}

console.log('\nExchange / Graph: the thread key is a ConversationId');
{
  const mine = '<ews-777@podjetje.si>';
  // What followUps.register would GUESS from headers at send time...
  const guessed = threadKeyFrom({ messageId: mine });
  // ...and what the server actually assigned, which the cache stores.
  const real = threadKeyFrom({ conversationId: 'AAQkAGI2TG93AAA=' });
  ok(guessed !== real, 'the header-derived guess does NOT match the real key — this is the trap');

  row({ folder: 'Sent Items', from: ME, date: SENT_AT, thread: real, messageId: normalizeId(mine), specialUse: '\\Sent' });
  row({ folder: 'INBOX', from: 'partner@drugo.si', date: SENT_AT + 3600e3, thread: real });

  ok(!cache.hasReplyInThread(U, A, guessed, SENT_AT, own), 'searching by the guess would miss the reply entirely');
  const found = cache.findThreadKeyFor(U, A, normalizeId(mine));
  ok(found === real, 'reading the key back off our own sent copy gives the real ConversationId');
  ok(cache.hasReplyInThread(U, A, found, SENT_AT, own), '— and with it the reply is found');
}

console.log('\nwhat there is nothing to look for');
ok(cache.findThreadKeyFor(U, A, 'never-sent@nowhere') === null, 'an id the cache has never seen gives no key (the record falls back to its own guess)');
ok(cache.findThreadKeyFor(U, A, '') === null, 'and no id at all gives no key');
ok(!cache.hasReplyInThread(U, A, null, SENT_AT, own), 'no key means no reply, rather than matching every message with a NULL thread');
ok(!cache.hasReplyInThread(U, 'other-account', 'root@firma.si', SENT_AT, own), 'another account\'s cache is not searched');

console.log('\nthe record lifecycle (followUps.js)');
{
  // An account for checkOne to find, the way accounts.js stores one.
  const udir = path.join(dir, 'users', U);
  fs.mkdirSync(udir, { recursive: true });
  fs.writeFileSync(path.join(udir, 'accounts.json'), JSON.stringify([
    { id: A, email: ME, label: 'Test', sentFolder: 'Sent', draftsFolder: 'Drafts', imap: {}, smtp: {} },
  ]));
  const fu = await import(new URL('../server/followUps.js', import.meta.url).href);
  const own = new Set([ME]);

  ok(fu.register(U, U, { messageId: '<x@y>', followUpDays: 4, subject: 's', to: 'a@b' }, A) === null,
    'a day count the composer does not offer keeps no record');
  ok(fu.register(U, U, { followUpDays: 3, subject: 's', to: 'a@b' }, A) === null,
    'nor does a message with no Message-ID — there would be nothing to find the reply by');

  const mine = '<life-1@example.si>';
  const rec = fu.register(U, U, { messageId: mine, followUpDays: 3, subject: 'Račun', to: '"Ana Novak" <ana@firma.si>, b@c.si' }, A);
  ok(rec && rec.state === 'waiting', 'a real one is kept, waiting');
  ok(rec.to === 'Ana Novak', 'it remembers the first recipient by name, for "No reply yet — to Ana Novak"');
  ok(Math.round((rec.dueAt - rec.sentAt) / 864e5) === 3, 'and is due three days after it went out');
  ok(fu.listFor(U).waiting === 1 && fu.listFor(U).due.length === 0, 'it counts as waiting, and the sidebar has nothing to show yet');

  // Not due yet, no reply: nothing happens.
  ok(fu.__test.checkOne(U, rec, own) === null, 'before it is due, with no reply, a check changes nothing');

  // Time passes. Make it due by rewriting dueAt, the way the plan's manual test does.
  const file = path.join(udir, 'follow-ups', `${rec.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...rec, dueAt: Date.now() - 1000 }));
  const overdue = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(fu.__test.checkOne(U, overdue, own) === 'due', 'past its time with no reply, it becomes due');
  ok(fu.listFor(U).due.length === 1, 'and the sidebar now lists it');

  // "Remind me again".
  const again = fu.snooze(U, rec.id, 2);
  ok(again.state === 'waiting' && again.dueAt > Date.now(), 'Remind me again puts it back to waiting, due later');
  ok(fu.listFor(U).due.length === 0, 'and takes it off the list until then');
  let threw = false; try { fu.snooze(U, rec.id, 9); } catch { threw = true; }
  ok(threw, 'a day count that is not offered is refused');

  // Now the reply arrives — even AFTER it was due, it must clear itself.
  const key = threadKeyFrom({ messageId: mine });
  row({ folder: 'Sent', from: ME, date: rec.sentAt, thread: key, messageId: normalizeId(mine), specialUse: '\\Sent' });
  row({ folder: 'INBOX', from: 'ana@firma.si', date: rec.sentAt + 60e3, thread: key });
  const live = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(fu.__test.checkOne(U, live, own) === 'answered', 'once the reply is in the cache, the check says answered');
  ok(!fs.existsSync(file), 'and the record is gone — it resolved itself, nobody had to press Done');

  // Done, by hand.
  const rec2 = fu.register(U, U, { messageId: '<life-2@example.si>', followUpDays: 1, subject: 'x', to: 'a@b' }, A);
  fu.dismiss(U, rec2.id);
  ok(!fs.existsSync(path.join(udir, 'follow-ups', `${rec2.id}.json`)), 'Done removes it');
  threw = false; try { fu.dismiss(U, '../../etc/passwd'); } catch { threw = true; }
  ok(threw, 'an id that is not one of ours is refused before it is ever turned into a path');

  // An account that has since been removed: nothing to watch, so it goes quietly.
  const rec3 = fu.register(U, U, { messageId: '<life-3@example.si>', followUpDays: 1, subject: 'x', to: 'a@b' }, 'gone-account');
  ok(fu.__test.checkOne(U, rec3, own) === 'answered', 'a reminder for a removed account is dropped rather than firing about nothing');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
