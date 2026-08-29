// Spam / Archive filing (server/refile.js) — the ledger that remembers where a
// message was before it was filed, and the plan that sends it back.
//
// The move itself is a folder move like any other; what is worth testing is the
// memory around it, because it is the only thing that can answer "where was
// this?" after the fact — a moved message has a new uid in a different folder,
// so nothing about it points home on its own.
//
//   node test/refile-test.mjs
import {
  originKey, noteOrigins, recallOrigin, dropOrigins, planReturn,
  isBox, BOX_FOLDER, HOME_FALLBACK, MAX_ENTRIES,
} from '../server/refile.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

console.log('what a box is');
ok(isBox('junk') && isBox('archive'), 'junk and archive');
ok(!isBox('trash') && !isBox('') && !isBox(undefined), 'and nothing else — the destination is never free-form');
// The whole point of the mapping: the route resolves the destination from the
// ACCOUNT, so a request can never name a folder of its own choosing.
ok(BOX_FOLDER.junk === 'junkFolder' && BOX_FOLDER.archive === 'archiveFolder', 'each box names a per-account setting');
ok(!isBox('constructor') && !isBox('toString'),
  'and inherited Object properties are not boxes (hasOwnProperty, not `in`)');

console.log('the key');
ok(originKey('a1', 'INBOX', 7) !== originKey('a2', 'INBOX', 7), 'the same uid in two accounts is two different messages');
ok(originKey('a1', 'INBOX', 7) !== originKey('a1', 'Work', 7), 'and so is the same uid in two folders');
// Folder paths contain separators of every kind (Gmail's "[Gmail]/Vsa pošta",
// dotted Courier hierarchies), so the one character they cannot contain is what
// joins them.
ok(originKey('a', 'Junk/Old', 5).includes('\u0000'), 'joined with NUL — the one character a folder path cannot contain');
ok(originKey('a', 'x y', 1) !== originKey('a x', 'y', 1), 'so no account+folder pair can be read as another one');
ok(originKey('a', 'Junk/Old', 5) === originKey('a', 'Junk/Old', '5'), 'uid 5 and "5" are the same message — uids arrive as both');

console.log('remembering');
const t0 = 1_700_000_000_000;
let led = noteOrigins({}, [{ accountId: 'a1', folder: 'Junk', uid: 91, from: 'INBOX' }], { now: t0 });
ok(recallOrigin(led, 'a1', 'Junk', 91) === 'INBOX', 'a message filed from the Inbox remembers the Inbox');
ok(recallOrigin(led, 'a1', 'Junk', 92) === null, 'a message nobody wrote down is null, not a guess');
ok(recallOrigin(led, 'a2', 'Junk', 91) === null, 'and the memory does not leak across accounts');
ok(recallOrigin({}, 'a1', 'Junk', 91) === null && recallOrigin(null, 'a1', 'Junk', 91) === null, 'an empty or missing ledger answers nothing');

led = noteOrigins(led, [{ accountId: 'a1', folder: 'Junk', uid: 91, from: 'Work/Bills' }], { now: t0 + 1000 });
ok(recallOrigin(led, 'a1', 'Junk', 91) === 'Work/Bills', 'filing the same uid again overwrites — a uid names one message at a time');

led = noteOrigins(led, [
  { accountId: 'a1', folder: 'Junk', uid: 0, from: 'INBOX' },
  { accountId: 'a1', folder: 'Junk', from: 'INBOX' },
  { accountId: 'a1', folder: 'Junk', uid: 93 },
  null,
], { now: t0 });
ok(recallOrigin(led, 'a1', 'Junk', 0) === 'INBOX', 'uid 0 is a uid, not a falsy value to be skipped');
ok(recallOrigin(led, 'a1', 'Junk', 93) === null, 'an entry with nowhere to go back to is not recorded');

console.log('forgetting');
const dropped = dropOrigins(led, [originKey('a1', 'Junk', 91)]);
ok(recallOrigin(dropped, 'a1', 'Junk', 91) === null, 'a message that has come back is forgotten');
ok(recallOrigin(dropped, 'a1', 'Junk', 0) === 'INBOX', 'and only that one');
// The reason forgetting matters at all: IMAP uids are not reused within a
// folder's uidvalidity, but folders get recreated and other backends mint ids
// their own way. A stale entry would send a message somewhere it never was.
ok(dropOrigins({}, ['nope']) && Object.keys(dropOrigins({}, ['nope'])).length === 0, 'forgetting something that was never there is fine');

console.log('pruning (this is the only thing that keeps the file bounded)');
const old = noteOrigins({ [originKey('a1', 'Junk', 5)]: { to: 'INBOX', at: t0 - 200 * 24 * 3600e3 } },
  [{ accountId: 'a1', folder: 'Junk', uid: 6, from: 'INBOX' }], { now: t0 });
ok(recallOrigin(old, 'a1', 'Junk', 5) === null, 'an entry past its age is dropped on the next write');
ok(recallOrigin(old, 'a1', 'Junk', 6) === 'INBOX', 'while the new one stays');
const junkShaped = noteOrigins({ bad: 'not an object', worse: { to: 'INBOX' } },
  [{ accountId: 'a1', folder: 'Junk', uid: 1, from: 'INBOX' }], { now: t0 });
ok(!('bad' in junkShaped) && !('worse' in junkShaped), 'and so is anything the wrong shape — a hand-edited file cannot break a move');

const many = {};
for (let i = 0; i < 12; i++) many[originKey('a1', 'Junk', i)] = { to: 'F' + i, at: t0 + i };
const capped = noteOrigins(many, [{ accountId: 'a1', folder: 'Junk', uid: 99, from: 'INBOX' }], { now: t0 + 100, cap: 5 });
ok(Object.keys(capped).length === 5, 'over the cap, only the cap survives', String(Object.keys(capped).length));
ok(recallOrigin(capped, 'a1', 'Junk', 99) === 'INBOX', 'and the newest entry is one of them');
ok(recallOrigin(capped, 'a1', 'Junk', 0) === null, 'the oldest goes first — "not spam" almost always follows the mistake');
ok(MAX_ENTRIES >= 1000, 'the real cap is generous enough that this never bites in practice');

console.log('planning the way back');
const ledger = noteOrigins({}, [
  { accountId: 'a1', folder: 'Junk', uid: 1, from: 'INBOX' },
  { accountId: 'a1', folder: 'Junk', uid: 2, from: 'Work/Bills' },
  { accountId: 'a1', folder: 'Junk', uid: 3, from: 'INBOX' },
], { now: t0 });
const resolve = (uid) => recallOrigin(ledger, 'a1', 'Junk', uid);

let plan = planReturn([1, 2, 3], resolve);
ok(plan.length === 2, 'a selection from two folders is two moves, not one', JSON.stringify(plan));
ok(plan[0].target === 'INBOX' && plan[0].uids.join() === '1,3', 'each destination collects its own messages');
ok(plan[1].target === 'Work/Bills' && plan[1].uids.join() === '2', 'including a folder that is not the Inbox');
ok(planReturn([2, 1], resolve)[0].target === 'Work/Bills', 'order follows the first message of each group, so the answer is predictable');

plan = planReturn([4], resolve);
ok(plan.length === 1 && plan[0].target === HOME_FALLBACK,
  'a message with no memory goes to the Inbox — which is the COMMON case: most spam was filed by the server, and was never anywhere else');
ok(HOME_FALLBACK === 'INBOX', "spelled the way every backend spells it (not 'Inbox')");
ok(planReturn([], resolve).length === 0 && planReturn(null, resolve).length === 0, 'nothing in, nothing to do');
ok(planReturn([1, 1], resolve)[0].uids.length === 2, 'a repeated uid is not silently deduplicated — that is the caller\'s business');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
