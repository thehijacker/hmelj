// A rule that forwards AND files must forward exactly once per delivered
// message. Before filters.js#claimFiled, the move minted a new uid in the
// destination folder, that folder's own poll called it new mail, and the
// forward went out a second time seconds later.
//
// Run against the shipped tree:   node forward-once-test.mjs
// Run against a control tree:     node forward-once-test.mjs /path/to/control/server
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startImap, startSmtp, startHmelj, imapClient, api, rawMail, freePort, sleep } from './filter-e2e-harness.mjs';

const serverDir = process.argv[2] || null;
const USER = 'me@test.local';
const PASS = 'secret';
const FORWARD_TO = 'boss@example.com';
const DEST = 'INBOX.Nintendo';

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? ' — ' + extra : '')); }
};

async function countIn(c, folder) {
  const lock = await c.getMailboxLock(folder);
  try {
    const uids = [];
    for await (const m of c.fetch({ all: true }, { uid: true, envelope: true })) uids.push(m);
    return uids;
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
  let syncPath = '/api/sync-now';

  await call('POST', '/api/signup', { username: 'tester', password: 'pw123456' });
  try { await call('POST', '/api/login', { username: 'tester', password: 'pw123456' }); } catch {}

  const acc = await call('POST', '/api/accounts', {
    type: 'imap',
    label: 'Test',
    email: USER,
    imap: { host: '127.0.0.1', port: imap.port, secure: false, user: USER, pass: PASS, tlsRejectUnauthorized: false },
    smtp: { sameServer: false, sameCredentials: false, host: '127.0.0.1', port: smtp.port, secure: false, user: USER, pass: PASS },
    sentFolder: 'Sent',
  });
  syncPath = `/api/sync-now?account=${acc.id}`;

  // A folder's FIRST sync never runs filters, so seed one message and sync
  // twice before the real test mail arrives — both folders now have a
  // high-water mark and the engine is armed.
  await c.append('INBOX', rawMail({ from: 'a@x.test', to: USER, subject: 'Seed' }));
  await call('POST', syncPath);
  await call('POST', syncPath);
  const warmup = smtp.sent.length;
  ok(warmup === 0, 'warm-up sent no mail', `sent ${warmup}`);

  await call('PUT', '/api/filters', [{
    id: 'f1',
    name: 'Nintendo',
    enabled: true,
    match: 'all',
    accountId: acc.id,
    rules: [{ field: 'to', op: 'contains', value: 'nintendo@mine.test' }],
    actions: [
      { type: 'redirect', value: FORWARD_TO },
      { type: 'move', value: DEST },
    ],
  }]);

  await c.append('INBOX', rawMail({ from: 'deals@x.test', to: 'nintendo@mine.test', subject: 'Deku Deals' }));
  await call('POST', syncPath);

  const first = smtp.sent.filter((m) => m.subject.includes('Deku Deals'));
  ok(first.length === 1, 'the message was forwarded exactly once', `forwarded ${first.length}×`);
  ok(first[0]?.to?.includes(FORWARD_TO), 'and to the address the rule names', JSON.stringify(first[0]?.to));

  let dest = await countIn(c, DEST);
  ok(dest.length === 1, 'and filed into ' + DEST + ', once', `${dest.length} there`);
  let inbox = await countIn(c, 'INBOX');
  ok(inbox.length === 1 && inbox[0].envelope.subject === 'Seed', 'and taken out of INBOX (seed message left behind)',
    inbox.map((m) => m.envelope.subject).join(', '));

  for (let i = 0; i < 3; i++) await call('POST', syncPath);
  const after = smtp.sent.filter((m) => m.subject.includes('Deku Deals'));
  ok(after.length === 1, 'three more sync cycles forward nothing further', `now ${after.length}×`);
  dest = await countIn(c, DEST);
  ok(dest.length === 1, 'and do not duplicate it in the destination', `${dest.length} there`);

  // A genuinely separate delivery still gets its own forward.
  await c.append('INBOX', rawMail({ from: 'shop@x.test', to: 'nintendo@mine.test', subject: 'Invoice 456' }));
  await call('POST', syncPath);
  await call('POST', syncPath);
  const second = smtp.sent.filter((m) => m.subject.includes('Invoice 456'));
  ok(second.length === 1, 'a later message is forwarded on its own account', `forwarded ${second.length}×`);
  ok(second[0]?.subject === 'Fwd: Invoice 456', 'with its own subject', `got "${second[0]?.subject}"`);
  dest = await countIn(c, DEST);
  ok(dest.length === 2, 'and is filed too', `${dest.length} in ${DEST}`);

  // A non-matching message is left completely alone.
  const before = smtp.sent.length;
  await c.append('INBOX', rawMail({ from: 'n@x.test', to: 'someone@else.test', subject: 'Unrelated' }));
  await call('POST', syncPath);
  await call('POST', syncPath);
  ok(smtp.sent.length === before, 'a non-matching message is not forwarded', `${smtp.sent.length - before} extra`);
  inbox = await countIn(c, 'INBOX');
  ok(inbox.some((m) => m.envelope.subject === 'Unrelated'), 'and stays in INBOX');
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
