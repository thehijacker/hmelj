// Snoozing a message (server/snooze.js) — the promise to bring mail back.
//
// The move itself is index.js's job and is stubbed here; what this covers is the
// part that has to survive a restart, which is the whole reason the queue is
// files in DATA_DIR rather than rows in the disposable cache.
//
// Four rules, each standing for a real way this can go wrong:
//
//   due is due          something that came due while the process was dead
//                       still comes back at boot — the OPPOSITE of a calendar
//                       reminder, which is stale by then and gets dropped;
//   never early         a snooze for next week is not touched by today's ticks;
//   gone means gone     a message somebody filed by hand in the meantime is not
//                       resurrected into the Inbox on top of that decision;
//   never silently lost a mail server that keeps refusing eventually gives up,
//                       and says WHERE the message actually is.
//
//   node test/snooze-test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';

// Before any import that reaches config.js — it resolves DATA_DIR once, at
// module evaluation, and dotenv does not override an already-set variable.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-snooze-'));
process.env.DATA_DIR = TMP;
process.env.CACHE_DIR = TMP;
process.env.HMELJ_SECRET = 'test-secret-not-a-real-one';
process.env.LOG = process.env.LOG || 'warn';

const session = await import('../server/session.js');
const snooze = await import('../server/snooze.js');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

// A real user, because the runner resolves the mailbox owner through the auth
// list rather than off the directory names (a deleted user's leftover files
// must never be picked up).
session.createUser('owner', 'testpass123');
const U = session.userKey('owner');

const MIN = 60000;
const now = Date.now();

/** Stands in for index.js's wakeMove hook. Records what it was asked to do. */
let moves = [];
let behaviour = () => ({ uid: 99, folder: 'INBOX' });
snooze.setHooks({
  wakeMove: async (uKey, rec) => {
    moves.push({ id: rec.id, from: rec.snoozeFolder, to: rec.fromFolder, attempts: rec.attempts || 0 });
    return behaviour(rec);
  },
});

const add = (over = {}) => snooze.remember(U, {
  accountId: 'acc1', ownerUsername: 'owner',
  fromFolder: 'INBOX', snoozeFolder: 'Snoozed',
  uid: 12, messageId: '<abc@example.com>',
  subject: 'Pogodba', fromAddr: 'ana@example.com', fromName: 'Ana',
  wakeAt: now + 60 * MIN,
  ...over,
});

console.log('what gets written down');
const rec = add();
ok(rec.id && rec.wakeAt === now + 60 * MIN, 'a snooze comes back summarised');
ok(snooze.list(U).length === 1, 'and is listed');
ok(snooze.get(U, rec.id).messageId === '<abc@example.com>',
  'the Message-ID is stored — a uid is per-folder and a MOVE mints a new one, so it is the only stable way back');
ok(snooze.get(U, rec.id).ownerUsername === 'owner',
  'so is the mailbox OWNER, since a shared account is woken as them, not as whoever snoozed it');

console.log('\nrefusals');
for (const bad of [undefined, null, 'soon', NaN]) {
  let threw = null;
  try { add({ wakeAt: bad }); } catch (e) { threw = e; }
  ok(threw?.status === 400, `${JSON.stringify(bad)} is refused as a time`);
}
let threw = null;
try { add({ wakeAt: now + 400 * 24 * 3600e3 }); } catch (e) { threw = e; }
ok(threw?.status === 400, 'and so is more than a year out');
threw = null;
try { snooze.get(U, '../../etc/passwd'); } catch (e) { threw = e; }
ok(threw?.status === 400, 'an id that is not a uuid is refused BEFORE it reaches the filesystem');
ok(snooze.remember(U, { accountId: 'a', ownerUsername: 'owner', fromFolder: 'INBOX', snoozeFolder: 'S', wakeAt: now - 5 * MIN }).wakeAt >= now,
  'a time already past means "next tick", not an error — the browser computed it a moment ago');

console.log('\nnever early');
moves = [];
// A moment past `now`: the clamped record above was stamped with the real
// Date.now(), which is milliseconds later than the constant captured at the top.
await snooze.runFor(U, { now: Date.now() + 1000 });
ok(moves.length === 1, 'only the already-past one ran; the 60-minute snooze was left alone');
ok(snooze.list(U).length === 1, 'and it is gone from the queue afterwards');

console.log('\ndue is due — the catch-up needs no code of its own');
moves = [];
// Nothing runs between these two lines: this IS "the server was off for an hour".
await snooze.runFor(U, { now: now + 61 * MIN });
ok(moves.length === 1 && moves[0].to === 'INBOX', 'a snooze that came due while the process was dead comes back on the next tick');
ok(snooze.list(U).length === 0, 'and the queue is empty');

console.log('\ngone means gone');
const g = add({ wakeAt: now - MIN });
behaviour = () => ({ gone: true });
moves = [];
await snooze.runFor(U, { now: Date.now() + 1000 });
ok(moves.length === 1, 'the wake was attempted');
ok(snooze.list(U).length === 0, 'and the record is dropped rather than retried — somebody filing it by hand is a decision, not a failure');
ok(!snooze.list(U).some((s) => s.id === g.id), 'nothing is put back on top of that decision');
behaviour = () => ({ uid: 99, folder: 'INBOX' });

console.log('\na mail server that refuses is retried, not dropped');
const r = add({ wakeAt: now - MIN });
const failAt = Date.now() + 1000;
behaviour = () => { throw new Error('Connection reset'); };
await snooze.runFor(U, { now: failAt });
let live = snooze.list(U);
ok(live.length === 1, 'still queued after a failure — the message is safe in the folder either way');
ok(live[0].attempts === 1 && /Connection reset/.test(live[0].lastError), 'the attempt and the reason are recorded');
ok(live[0].wakeAt > failAt, 'and it is pushed out to a later time rather than spinning');
const firstRetry = live[0].wakeAt;
await snooze.runFor(U, { now: failAt });
ok(snooze.list(U)[0].attempts === 1, 'a tick before that time does nothing — the backoff is respected');
await snooze.runFor(U, { now: firstRetry });
live = snooze.list(U);
ok(live[0].attempts === 2 && live[0].wakeAt > firstRetry, 'the next attempt backs off further');

console.log('\nbut it does eventually stop promising');
let at = firstRetry;
for (let i = 0; i < 20 && snooze.list(U).length; i++) {
  at = snooze.list(U)[0].wakeAt;
  await snooze.runFor(U, { now: at });
}
ok(snooze.list(U).length === 0, 'the record is given up on rather than retried forever');
ok(fs.existsSync(path.join(TMP, 'users', U, 'snoozed')), 'the queue directory survives (it is where the next snooze goes)');
behaviour = () => ({ uid: 99, folder: 'INBOX' });

console.log('\nrescheduling');
const q = add({ wakeAt: now + 10 * MIN });
snooze.resnooze(U, q.id, now + 90 * MIN);
ok(snooze.get(U, q.id).wakeAt === now + 90 * MIN, 'a snooze can be moved to a new time');
moves = [];
await snooze.runFor(U, { now: now + 20 * MIN });
ok(moves.length === 0, 'and the old time no longer fires');

console.log('\nfinding one from the message list');
const f = snooze.findByMessage(U, 'acc1', 'Snoozed', 12);
ok(f?.id === q.id, 'a row in the snooze folder can be matched back to its record, so the menu can offer "un-snooze"');
ok(snooze.findByMessage(U, 'acc1', 'Snoozed', 777) === null, 'and an unrelated message matches nothing');
ok(snooze.findByMessage(U, 'other-account', 'Snoozed', 12) === null, 'the account is part of the match — a uid alone means nothing');

console.log('\nforgetting');
snooze.forget(U, q.id);
ok(snooze.list(U).length === 0, 'forget() drops the record without moving anything');
snooze.forget(U, q.id);
ok(true, 'and forgetting one twice is not an error');

console.log('\na record whose owner has been deleted is dropped, not retried forever');
add({ wakeAt: now - MIN, ownerUsername: 'someone-who-left' });
moves = [];
await snooze.runFor(U, { now: Date.now() + 1000 });
ok(moves.length === 0, 'no move is attempted for a user that no longer exists');
ok(snooze.list(U).length === 0, 'and the stranded record is cleared rather than left to run every minute');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
