// Conversation keys (server/threading.js) and the grouped list query
// (cache.js#pageThreads). The property that matters and is easiest to break:
// every message of one conversation must derive the SAME key on its own,
// whatever order they are cached in — a folder backfills newest-first, so a
// reply is routinely cached before the message it replies to.
//
//   node test/threading-key-test.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-thread-'));
process.env.DATA_DIR = dir; process.env.CACHE_DIR = path.join(dir, 'cache');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const { threadKeyFrom, firstReference, firstReferenceIn, normalizeId } =
  await import(new URL('../server/threading.js', import.meta.url).href);

console.log('normalizing ids');
ok(normalizeId('<Abc@Host.COM>') === 'abc@host.com', 'brackets stripped, lowercased');
ok(normalizeId('  <a@b>  ') === 'a@b', 'surrounding whitespace ignored');
ok(normalizeId(null) === '' && normalizeId('') === '', 'nothing in, nothing out');

console.log('parsing References out of a raw header block');
const block = (s) => Buffer.from(s.replace(/\n/g, '\r\n'));
ok(firstReference(block('From: a@b\nReferences: <root@x> <r1@x>\nSubject: hi\n')) === 'root@x',
  'first id of a single-line header');
ok(firstReference(block('References:\n <root@x>\n <r1@x>\nSubject: hi\n')) === 'root@x',
  'header folded before its first id');
ok(firstReference(block('references: <ROOT@X>\n')) === 'root@x', 'header name is case-insensitive');
ok(firstReference(block('Subject: no references here\n')) === '', 'absent header yields nothing');
ok(firstReference(null) === '', 'no headers at all yields nothing');
ok(firstReferenceIn('root@x') === 'root@x', 'a bare (already-extracted) id passes through');

console.log('deriving the conversation key');
const root = '<root@x>';
const chain = [
  { messageId: root },
  { messageId: '<r1@x>', inReplyTo: root, references: '<root@x>' },
  { messageId: '<r2@x>', inReplyTo: '<r1@x>', references: '<root@x> <r1@x>' },
  { messageId: '<r3@x>', inReplyTo: '<r2@x>', references: '<root@x> <r1@x> <r2@x>' },
];
const keys = chain.map(threadKeyFrom);
ok(keys.every((k) => k === 'root@x'), 'a 4-deep chain collapses to the root id', keys.join(','));
ok([...chain].reverse().map(threadKeyFrom).every((k) => k === 'root@x'),
  'and does so regardless of the order messages are seen in');
ok(threadKeyFrom({ messageId: '<b@x>', inReplyTo: root }) === 'root@x',
  'a reply whose sender stripped References still keys to its parent');
ok(threadKeyFrom({ messageId: '<lonely@x>' }) === 'lonely@x', 'an unrelated message is a thread of one');
ok(threadKeyFrom({}) === '', 'a message with no ids at all yields no key');
ok(threadKeyFrom({ conversationId: 'AAQkAD', messageId: root }) === 'c:AAQkAD',
  "Exchange/Graph's own conversation id wins over the headers");
ok(threadKeyFrom({ conversationId: 'root@x' }) !== threadKeyFrom({ messageId: '<root@x>' }),
  'a provider id can never collide with a Message-ID');

console.log('grouping a folder listing');
const cache = await import(new URL('../server/cache.js', import.meta.url).href);
const U = 'u1', A = 'a1';
const msg = (uid, folder, subject, threadKey, date, seen = true) => ({
  uid, subject, from: { name: 'Janez', address: 'j@x' }, to: [], date: new Date(date).toISOString(),
  size: 1, seen, flagged: false, answered: false, forwarded: false, deleted: false, draft: false,
  hasAttachment: false, messageId: 'm' + uid, threadKey,
});
// Deliberately inserted newest-first, the way a backfill really arrives.
cache.upsertMessages(U, A, 'INBOX', null, [
  msg(3, 'INBOX', 'Re: Račun', 'root@x', '2026-08-13T10:00:00Z', false),
  msg(1, 'INBOX', 'Račun', 'root@x', '2026-08-02T10:00:00Z'),
  msg(4, 'INBOX', 'Unrelated', null, '2026-08-14T10:00:00Z'),
]);
cache.upsertMessages(U, A, 'Sent', '\\Sent', [
  msg(2, 'Sent', 'Re: Račun', 'root@x', '2026-08-12T10:00:00Z'),
  msg(9, 'Sent', 'Only ever sent', 'sentonly@x', '2026-08-20T10:00:00Z'),
]);

const flat = cache.queryFolder(U, A, 'INBOX', {});
ok(flat.messages.length === 3, 'ungrouped, the folder still lists every message', String(flat.messages.length));

const t = cache.queryFolder(U, A, 'INBOX', { threaded: true, threadFolders: ['Sent'] });
ok(t.total === 2 && t.messages.length === 2, 'three messages in two conversations = two rows', String(t.total));
const conv = t.messages.find((m) => m.threadId === 'root@x');
ok(conv.uid === 3, 'the row IS the conversation\'s newest message', String(conv.uid));
ok(conv.threadCount === 3, 'the count includes the reply that lives in Sent', String(conv.threadCount));
ok(JSON.stringify(conv.threadUids) === '[1,3]', 'but an action on the row only ever touches this folder', JSON.stringify(conv.threadUids));
ok(conv.threadUnseen === 1, 'unread count is over the whole conversation');
ok(!t.messages.some((m) => m.subject === 'Only ever sent'), 'a Sent-only thread is not an Inbox thread');
ok(t.realTotal === null, "the folder's server-side message count is withheld while grouped");

const members = cache.getThread(U, A, 'root@x', ['INBOX', 'Sent']);
ok(members.map((m) => m.uid).join(',') === '1,2,3', 'the stack reads oldest-first across both folders',
  members.map((m) => m.uid).join(','));
const lone = t.messages.find((m) => m.threadCount === 1);
ok(cache.getThread(U, A, lone.threadId, ['INBOX', 'Sent']).length === 1,
  'a thread of one is addressable by the same synthetic key the list handed out');

const p1 = cache.queryFolder(U, A, 'INBOX', { threaded: true, threadFolders: ['Sent'], page: 1, pageSize: 1 });
const p2 = cache.queryFolder(U, A, 'INBOX', { threaded: true, threadFolders: ['Sent'], page: 2, pageSize: 1 });
ok(p1.messages[0].subject === 'Unrelated' && p2.messages[0].subject === 'Re: Račun',
  'pages are pages of conversations, newest conversation first');

// The bug that got reported twice: a conversation whose NEWEST message is a
// reply you sent is represented by a row whose own folder is Sent. Scope the
// thread to that row's folder and you ask for [Sent, Sent] — a stack of nothing
// but your own messages, in a conversation that plainly had two sides. The
// scope has to come from the folder being LISTED (app.js#listedFolderFor,
// index.js#threadScopeFolders), which is what these two assert.
console.log('a conversation whose newest message is your own reply');
cache.upsertMessages(U, A, 'Sent', '\\Sent', [msg(5, 'Sent', 'Re: Račun', 'root@x', '2026-08-15T10:00:00Z')]);
const own = cache.queryFolder(U, A, 'INBOX', { threaded: true, threadFolders: ['INBOX', 'Sent'] })
  .messages.find((m) => m.threadId === 'root@x');
ok(own.folder === 'Sent', 'the row IS that sent message, so it carries folder:Sent', own.folder);
ok(own.threadCount === 4, 'the count covers both sides of the conversation', String(own.threadCount));
ok(cache.getThread(U, A, 'root@x', ['INBOX', 'Sent']).length === 4,
  'and the stack read against the LISTED folder has all four');
ok(cache.getThread(U, A, 'root@x', [own.folder, 'Sent']).length === 2,
  'while the row\'s own folder would have given only the two sent ones — the bug');
ok(JSON.stringify(own.threadUids) === '[1,3]',
  'actions still only ever touch the listed folder, never the Sent copies', JSON.stringify(own.threadUids));


// The count and the stack disagreed three separate times, each for a different
// reason, and the fix in the end was to stop having two notions at all: a
// conversation is every folder of the account except Trash/Junk/Drafts and the
// hidden ones, plus Sent — whatever is being listed, whatever is muted.
//
//   1. the stack was scoped to [the row's folder, Sent] while the unified count
//      spanned everything: a thread filed into "Tickets" opened as ONE
//      message under a chip saying 2;
//   2. the same thread then read 2 in a single-account Inbox and 4 in All
//      inboxes;
//   3. and dropped back to 2 whenever that folder was muted and the list was
//      hiding muted folders — muting silences a folder's alerts, it does not
//      take its messages out of a conversation.
console.log('a conversation spanning a filed-away, muted folder');
cache.upsertFolders(U, A, [
  { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
  { path: 'Sent', name: 'Sent', specialUse: '\\Sent' },
  { path: 'Trash', name: 'Trash', specialUse: '\\Trash' },
  { path: 'Tickets', name: 'Tickets', specialUse: null },
  { path: 'Noisy', name: 'Noisy', specialUse: null },
]);
cache.upsertMessages(U, A, 'Tickets', null, [
  msg(11, 'Tickets', 'Nedelovanje', 'noc@x', '2026-08-27T16:18:00Z'),
  msg(13, 'Tickets', 'Re: Nedelovanje', 'noc@x', '2026-08-27T16:58:00Z'),
]);
cache.upsertMessages(U, A, 'INBOX', null, [
  msg(12, 'INBOX', 'RE: Nedelovanje', 'noc@x', '2026-08-27T16:30:00Z'),
  msg(14, 'INBOX', 'RE: Nedelovanje', 'noc@x', '2026-08-27T17:06:00Z'),
]);

const acct = { id: A, label: 'Work', sentFolder: 'Sent', hiddenFolders: ['Noisy'] };
const convo = cache.conversationFolders(U, acct);
ok(convo.includes('Tickets'), 'the conversation covers an ordinary filed folder');
ok(convo.includes('Sent'), 'and Sent, which no listing shows as rows: your own half still belongs');
ok(!convo.includes('Trash'), 'but not Trash');
ok(!convo.includes('Noisy'), 'nor a folder hidden from the sidebar — that one really is "do not show me this"');

// The number on the row, from all three places it can be drawn.
const inbox = cache.queryFolder(U, A, 'INBOX', {
  threaded: true, threadFolders: ['INBOX', 'Sent'], convoFolders: convo,
}).messages.find((m) => m.threadId === 'noc@x');
ok(inbox.threadCount === 4, 'a single-account Inbox counts the whole conversation', String(inbox.threadCount));
ok(JSON.stringify(inbox.threadUids) === '[12,14]',
  'while an action on the row still only touches the folder being listed', JSON.stringify(inbox.threadUids));
ok(inbox.threadUnseen === 0, 'and the unread mark is over that folder too, so it matches what opening it marks read');

const uni = (mutedPairs) => cache.queryUnified(U, [acct], { box: 'inbox', threaded: true, mutedPairs })
  .messages.find((m) => m.threadId === 'noc@x');
ok(uni(null).threadCount === 4, 'All inboxes agrees', String(uni(null).threadCount));
const mutedPairs = new Set([`${A}${String.fromCharCode(0)}Tickets`]);
ok(uni(mutedPairs).threadCount === 4,
  'and still agrees when that folder is muted and muted folders are hidden — the count is not a view setting',
  String(uni(mutedPairs).threadCount));

ok(cache.getThread(U, A, 'noc@x', convo).length === 4, 'and the stack that opens from it has the same four');
// The listing is still filtered even though the count is not: a muted folder's
// messages must not appear as rows of their own in All inboxes.
const rows = cache.queryUnified(U, [acct], { box: 'inbox', threaded: false, mutedPairs })
  .messages.filter((m) => m.folder === 'Tickets');
ok(rows.length === 0, 'a hidden/muted folder still contributes no rows of its own');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
