// The reported bug: new mail arrives, the notification fires and the unread
// badge goes up — and the message is nowhere in "All inboxes". It appears by
// itself some minutes later.
//
// The window is a filter move. A filter fires on arrival, the message leaves
// the folder it was delivered to, and sync drops that folder's cached row so
// the unified list does not show it twice. But the DESTINATION folder is not
// polled until its own turn comes round, so until then the message is in no
// cached folder at all: gone from the source, not yet in the target. The
// notification has already gone out and the badge already counts it.
//
// /api/filters/run has always closed this for a filter run started by hand.
// The BACKGROUND run — which is how filters actually fire — never did.
//
// Driven end to end against a real IMAP server rather than unit-tested, because
// the bug is entirely in the ORDER of things across a poll: every part of it
// works correctly on its own.
//
// It syncs ONE FOLDER (/api/folders/:path/sync-now), because that is the shape
// of the sync that actually exposes it. An IDLE wake — how mail arriving is
// noticed on an account with live monitoring — polls only the folder the mail
// landed in (sync.js#onWatcherActivity). The whole-account cycle polls every
// folder including the destination, so it papers over the gap and a test
// written against /api/sync-now passes with the bug still in place. It did.
//
//   node filter-unified-gap-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startImap, startSmtp, startHmelj, imapClient, api, rawMail, freePort } from './filter-e2e-harness.mjs';

const serverDir = process.argv[2] || null;
const USER = 'me@test.local';
const PASS = 'secret';
const DEST = 'INBOX.Shop';

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? ' — ' + extra : '')); }
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-gap-'));
let imap; let smtp; let app; let c;
try {
  imap = await startImap({ user: USER, pass: PASS });
  smtp = await startSmtp();
  c = await imapClient({ port: imap.port, user: USER, pass: PASS });
  await c.mailboxCreate(DEST);

  const port = await freePort();
  app = await startHmelj({ dataDir, port, serverDir });
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
  // The narrow one: exactly what an IDLE wake does.
  const syncInbox = `/api/folders/${encodeURIComponent('INBOX')}/sync-now?account=${acc.id}`;

  await c.append('INBOX', rawMail({ from: 'a@x.test', to: USER, subject: 'Seed' }));
  await call('POST', sync);
  await call('POST', sync);

  // The user's real rule shape: everything addressed to one alias is filed away.
  await call('PUT', '/api/filters', [{
    id: 'f1', name: 'Shop', enabled: true, match: 'all', accountId: acc.id,
    rules: [{ field: 'to', op: 'contains', value: 'shop@mine.test' }],
    actions: [{ type: 'move', value: DEST }],
  }]);

  const unified = async () => (await call('GET', '/api/unified/inbox')).messages.map((m) => m.subject);
  const folder = async (p) => (await call('GET', `/api/messages/${encodeURIComponent(p)}?account=${acc.id}`)).messages.map((m) => m.subject);

  // Delivered to INBOX and filed to DEST by the filter, with only INBOX polled
  // — exactly what happens when mail arrives on an account watching with IDLE.
  await c.append('INBOX', rawMail({ from: 'shop@x.test', to: 'shop@mine.test', subject: 'Potrditev narocila' }));
  await call('POST', syncInbox);

  const inboxRows = await folder('INBOX');
  ok(!inboxRows.includes('Potrditev narocila'),
     'the source folder no longer lists it — the filter moved it out', JSON.stringify(inboxRows));

  const destRows = await folder(DEST);
  ok(destRows.includes('Potrditev narocila'),
     'the folder it was filed into lists it straight away', JSON.stringify(destRows));

  // The assertion this file exists for. Everything above passed before the fix
  // too; this is the one that did not.
  const all = await unified();
  ok(all.includes('Potrditev narocila'),
     'and it is in All inboxes in the SAME poll, not minutes later', JSON.stringify(all));

  ok(all.filter((s) => s === 'Potrditev narocila').length === 1,
     'exactly once — not once from a stale source row and once from the target',
     JSON.stringify(all));

  // The seed must not have been disturbed by any of it.
  ok(all.includes('Seed'), 'and ordinary mail nobody filtered is still there', JSON.stringify(all));

  // Steady state: the full cycle that comes round later must not resurrect or
  // duplicate it.
  await call('POST', sync);
  await call('POST', sync);
  const after = await unified();
  ok(after.filter((s) => s === 'Potrditev narocila').length === 1,
     'still exactly once after two more polls', JSON.stringify(after));
} catch (e) {
  fail++;
  console.log('  ✗ harness error: ' + (e?.stack || e));
  if (app?.out?.length) console.log('--- server output ---\n' + app.out.join('').slice(-4000));
} finally {
  try { await c?.logout(); } catch { /* already gone */ }
  // close(), not stop() — and NOT optionally-called. These handles have only
  // ever exposed close(); `await app?.stop?.()` silently evaluated to undefined
  // and killed nothing, which is how this suite leaked a real Hmelj process on
  // every single run (see spawnedServers in filter-e2e-harness.mjs).
  if (app) await app.close();
  if (imap) await imap.close();
  if (smtp) await smtp.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
