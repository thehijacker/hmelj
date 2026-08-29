// The reported bug: a rule whose move target is the folder the message is
// already in. IMAP MOVE is COPY + EXPUNGE, so the "no-op" mints a new uid
// above the folder's high-water mark; sync calls that new mail, filters it,
// moves it again — one new uid and one push notification per cycle, until
// the message's Date header ages out of sync.js's two-day window.
//
//   node selfmove-test.mjs                 # shipped tree
//   node selfmove-test.mjs control/server  # with the fix reverted
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startImap, startSmtp, startHmelj, imapClient, api, rawMail, freePort } from './filter-e2e-harness.mjs';

const serverDir = process.argv[2] || null;
const USER = 'me@test.local';
const PASS = 'secret';
const DEST = 'INBOX.Nintendo';

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? ' — ' + extra : '')); }
};

async function uidsIn(c, folder) {
  const lock = await c.getMailboxLock(folder);
  try {
    const out = [];
    for await (const m of c.fetch({ all: true }, { uid: true, envelope: true })) out.push({ uid: m.uid, subject: m.envelope.subject });
    return out;
  } finally { lock.release(); }
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-e2e-'));
let imap, smtp, app, c;
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

  await c.append('INBOX', rawMail({ from: 'a@x.test', to: USER, subject: 'Seed' }));
  await c.append(DEST, rawMail({ from: 'a@x.test', to: USER, subject: 'DestSeed' }));
  await call('POST', sync);
  await call('POST', sync);

  // The rule the user has: "to: nintendo@mine.test -> move to INBOX.Nintendo".
  await call('PUT', '/api/filters', [{
    id: 'f1', name: 'Nintendo', enabled: true, match: 'all', accountId: acc.id,
    rules: [{ field: 'to', op: 'contains', value: 'nintendo@mine.test' }],
    actions: [{ type: 'move', value: DEST }],
  }]);

  // Delivered straight into the destination folder, exactly as a server-side
  // Sieve rule would do it — so the very first filter run is already a
  // self-move.
  await c.append(DEST, rawMail({ from: 'deals@x.test', to: 'nintendo@mine.test', subject: 'Deku Deals' }));
  await call('POST', sync);

  let there = (await uidsIn(c, DEST)).filter((m) => m.subject === 'Deku Deals');
  ok(there.length === 1, 'one copy in ' + DEST + ' after the first cycle', `${there.length} copies`);
  const firstUid = there[0]?.uid;

  for (let i = 0; i < 4; i++) await call('POST', sync);
  there = (await uidsIn(c, DEST)).filter((m) => m.subject === 'Deku Deals');
  ok(there.length === 1, 'still one copy after four more cycles', `${there.length} copies`);
  ok(there[0]?.uid === firstUid, 'and its uid never moved', `uid ${firstUid} -> ${there[0]?.uid}`);

  // A message that really does need moving still gets moved.
  await c.append('INBOX', rawMail({ from: 'shop@x.test', to: 'nintendo@mine.test', subject: 'Invoice 456' }));
  await call('POST', sync);
  const inbox = await uidsIn(c, 'INBOX');
  ok(!inbox.some((m) => m.subject === 'Invoice 456'), 'a message arriving in INBOX is still filed out of it');
  const dest = await uidsIn(c, DEST);
  ok(dest.filter((m) => m.subject === 'Invoice 456').length === 1, 'and lands in ' + DEST + ' exactly once',
    `${dest.filter((m) => m.subject === 'Invoice 456').length} copies`);
  ok(dest.some((m) => m.subject === 'DestSeed'), 'the pre-existing message in ' + DEST + ' is untouched');
} catch (e) {
  fail++;
  console.log('  ✗ harness error: ' + (e?.stack || e));
  if (app?.out?.length) console.log('--- server output ---\n' + app.out.join('').slice(-4000));
} finally {
  try { await c?.logout(); } catch {}
  app?.close();
  await imap?.close();
  await smtp?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
