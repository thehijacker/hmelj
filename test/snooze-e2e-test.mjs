// Snooze, end to end: a real IMAP server, a real Hmelj process, a real move.
//
// test/snooze-test.mjs covers the queue's own logic with the move stubbed out.
// This covers the half that stub cannot: that the folder is created, that the
// message actually leaves the Inbox and comes back, and that the route is
// reachable the way the browser reaches it.
//
// It exists because of a bug this would have caught and the unit test could
// not: the client called the snooze route without `?account=`, and the server
// answered "No mail account selected (missing ?account= parameter)". Every
// message-scoped route needs that parameter, and nothing in a pure test of
// snooze.js goes near it.
//
//   node test/snooze-e2e-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startImap, startSmtp, startHmelj, imapClient, api, rawMail, freePort } from './filter-e2e-harness.mjs';

const USER = 'me@test.local';
const PASS = 'secret';

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? ' — ' + extra : '')); }
};

/**
 * What is REALLY in a folder, read over a connection opened for the question.
 *
 * A long-lived client cannot be used for this. hoodiecrow keeps per-connection
 * mailbox state, so a client that selected INBOX before Hmelj moved a message
 * out of it goes on reporting the message as present — which looks exactly like
 * a move that copied instead of moving, and cost an hour of chasing a bug that
 * was not there. A fresh connection is the only honest observer.
 *
 * \Deleted-but-not-expunged does not count as present: that is what a deferred
 * IMAP expunge looks like, and no mail client shows those rows either.
 */
async function inFolder(folder) {
  const c = await imapClient({ port: imap.port, user: USER, pass: PASS });
  try {
    let lock;
    try { lock = await c.getMailboxLock(folder); }
    catch { return null; } // no such folder
    try {
      const out = [];
      for await (const m of c.fetch({ all: true }, { uid: true, envelope: true, flags: true })) {
        const flags = [...(m.flags || [])];
        if (!flags.includes('\\Deleted')) out.push({ uid: m.uid, subject: m.envelope.subject, flags });
      }
      return out;
    } finally { lock.release(); }
  } finally { try { await c.logout(); } catch {} }
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-snooze-e2e-'));
let imap, smtp, app, c;
try {
  imap = await startImap({ user: USER, pass: PASS });
  smtp = await startSmtp();
  c = await imapClient({ port: imap.port, user: USER, pass: PASS });

  const port = await freePort();
  app = await startHmelj({ dataDir, port });
  const call = api(app.base);
  await call('POST', '/api/signup', { username: 'tester', password: 'pw123456' });
  try { await call('POST', '/api/login', { username: 'tester', password: 'pw123456' }); } catch {}
  const acc = await call('POST', '/api/accounts', {
    type: 'imap', label: 'Test', email: USER,
    imap: { host: '127.0.0.1', port: imap.port, secure: false, user: USER, pass: PASS, tlsRejectUnauthorized: false },
    smtp: { sameServer: false, sameCredentials: false, host: '127.0.0.1', port: smtp.port, secure: false, user: USER, pass: PASS },
    sentFolder: 'Sent',
  });
  const sync = `/api/sync-now?account=${acc.id}`;

  await c.append('INBOX', rawMail({ from: 'ana@x.test', to: USER, subject: 'Pogodba' }));
  await c.append('INBOX', rawMail({ from: 'bob@x.test', to: USER, subject: 'Leave me alone' }));
  await call('POST', sync);
  await call('POST', sync);

  const inbox = await inFolder('INBOX');
  const target = inbox.find((m) => m.subject === 'Pogodba');
  ok(!!target, 'the message is in the Inbox to begin with');

  console.log('\nthe account has no snooze folder until one is needed');
  ok((await call('GET', '/api/accounts')).find((a) => a.id === acc.id).snoozeFolder === '',
    'no folder is conjured at account-creation time');

  console.log('\nsnoozing');
  // A minute out: far enough that the runner will not take it mid-test.
  const wakeAt = Date.now() + 60_000;
  const res = await call('POST', `/api/messages/INBOX/snooze?account=${acc.id}`, {
    uids: [target.uid], wakeAt, addCalendar: false,
  });
  ok(res.ok && res.snoozed?.length === 1, 'the route accepts it');
  const rec = res.snoozed[0];

  const snoozeFolder = (await call('GET', '/api/accounts')).find((a) => a.id === acc.id).snoozeFolder;
  ok(!!snoozeFolder, 'a snooze folder was created on first use', JSON.stringify(snoozeFolder));
  ok(res.folder === snoozeFolder, 'and the route reports the name it actually used');

  const afterInbox = await inFolder('INBOX');
  const liveInbox = afterInbox;
  ok(!liveInbox.some((m) => m.subject === 'Pogodba'), 'the message really left the Inbox — not just hidden in Hmelj',
    JSON.stringify(afterInbox.filter((m) => m.subject === 'Pogodba')));
  ok(liveInbox.some((m) => m.subject === 'Leave me alone'), 'and nothing else moved');
  const parked = await inFolder(snoozeFolder);
  ok(parked?.some((m) => m.subject === 'Pogodba'), 'it is sitting in the snooze folder, visible to any other mail client');

  // Control: does an ordinary move behave any differently on this server? If
  // this fails too, the mock's MOVE is the thing to distrust, not the snooze
  // route — worth knowing before chasing a bug in the wrong file.
  console.log('\ncontrol: a plain move');
  const other = liveInbox.find((m) => m.subject === 'Leave me alone');
  await call('POST', `/api/messages/INBOX/move?account=${acc.id}`, { uids: [other.uid], target: 'Trash' });
  const afterMove = await inFolder('INBOX');
  ok(!afterMove.some((m) => m.subject === 'Leave me alone'),
    'a plain /move also removes the source (if this fails, the mock server is the problem)',
    JSON.stringify(afterMove.map((m) => m.subject)));

  // And into the JUST-CREATED folder specifically, which is the one thing the
  // snooze path does that /move above does not.
  await c.append('INBOX', rawMail({ from: 'c@x.test', to: USER, subject: 'Into new folder' }));
  await call('POST', sync);
  const fresh = (await inFolder('INBOX')).find((m) => m.subject === 'Into new folder');
  await call('POST', `/api/messages/INBOX/move?account=${acc.id}`, { uids: [fresh.uid], target: snoozeFolder });
  const afterMove2 = await inFolder('INBOX');
  ok(!afterMove2.some((m) => m.subject === 'Into new folder'),
    'a plain /move into the newly created snooze folder also removes the source',
    JSON.stringify(afterMove2.map((m) => m.subject)));

  console.log('\nwhat was written down');
  const listed = await call('GET', '/api/snoozed');
  ok(listed.length === 1 && listed[0].id === rec.id, 'it is listed as snoozed');
  ok(listed[0].subject === 'Pogodba', 'with the subject, read BEFORE the move (afterwards that uid names nothing)');
  ok(listed[0].from === 'INBOX', 'and where to put it back');
  ok(listed[0].wakeAt === wakeAt, 'at the time asked for');

  console.log('\nrefusals');
  for (const [body, why] of [
    [{ uids: [], wakeAt }, 'no messages'],
    [{ uids: [target.uid], wakeAt: null }, 'a null time'],
    [{ uids: [target.uid], wakeAt: 'tomorrow' }, 'an unparseable time'],
  ]) {
    let status = 0;
    try { await call('POST', `/api/messages/INBOX/snooze?account=${acc.id}`, body); }
    catch (e) { status = e.status || 400; }
    ok(status >= 400, `${why} is refused`);
  }

  console.log('\nbringing it back early');
  const woke = await call('POST', `/api/snoozed/${rec.id}/wake`, {});
  ok(woke.ok, 'the un-snooze route answers');
  const back = await inFolder('INBOX');
  const returned = back.find((m) => m.subject === 'Pogodba');
  ok(!!returned, 'the message is back in the Inbox');
  ok(!(await inFolder(snoozeFolder)).some((m) => m.subject === 'Pogodba'), 'and no longer in the snooze folder');
  ok(!returned.flags.includes('\\Seen'), 'it comes back UNREAD — the whole point is that it asks for attention again');
  ok((await call('GET', '/api/snoozed')).length === 0, 'and the promise is discharged');

  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  try { await c?.logout(); } catch {}
  app?.close?.();
  await imap?.close?.();
  await smtp?.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
