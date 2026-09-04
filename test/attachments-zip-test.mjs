// Hmelj — "download all attachments" end to end (the attachments.zip route).
//
// server/zip.js is covered on its own by test/zip-test.mjs, against two
// independent unzip implementations. What is left is everything BETWEEN a real
// message on a real IMAP server and that archive: which parts count as
// attachments, whether their bytes survive the MIME round trip, and what the
// download is called.
//
// The part worth an end-to-end test rather than a unit one is the SELECTION.
// An embedded image and a real attachment are both "attachments" to a MIME
// parser, and telling them apart is a judgement made from several weak signals
// (see server/messageParse.js). A test with hand-built parts would encode
// whichever rule was implemented; a real multipart/related message does not.
//
//   node test/attachments-zip-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startImap, startSmtp, startHmelj, imapClient, api, rawMail, freePort } from './filter-e2e-harness.mjs';

const USER = 'me@test.local';
const PASS = 'secret';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-zip-e2e-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-zip-out-'));

/** A multipart/mixed message: two real attachments (one with a Slovenian name,
 *  one whose name collides with the first), plus a multipart/related part
 *  holding an image the HTML references — which must NOT be bundled. */
function mailWithAttachments() {
  const b64 = (s) => Buffer.from(s).toString('base64');
  return [
    `From: sender@x.test`, `To: ${USER}`, 'Subject: Racun in slike',
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <att-${Math.random().toString(36).slice(2)}@test.local>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="MIX"', '',
    '--MIX',
    'Content-Type: multipart/related; boundary="REL"', '',
    '--REL',
    'Content-Type: text/html; charset=utf-8', '',
    '<p>Pozdrav <img src="cid:logo@x"></p>', '',
    '--REL',
    'Content-Type: image/png', 'Content-ID: <logo@x>',
    'Content-Disposition: inline; filename="logo.png"',
    'Content-Transfer-Encoding: base64', '',
    b64('PNG-LOGO-BYTES'), '',
    '--REL--', '',
    '--MIX',
    'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="=?UTF-8?B?' + b64('Potrditev naročila.pdf') + '?="',
    'Content-Transfer-Encoding: base64', '',
    b64('PDF-ONE'), '',
    '--MIX',
    'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="=?UTF-8?B?' + b64('Potrditev naročila.pdf') + '?="',
    'Content-Transfer-Encoding: base64', '',
    b64('PDF-TWO-DIFFERENT'), '',
    '--MIX--', '',
  ].join('\r\n');
}

let imap; let smtp; let app; let c;
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

  await c.append('INBOX', mailWithAttachments());
  // A plain one too, so the "nothing to bundle" branch below actually runs —
  // without it that assertion silently skipped itself.
  await c.append('INBOX', rawMail({ from: 'a@x.test', to: USER, subject: 'Brez prilog' }));
  await call('POST', `/api/sync-now?account=${acc.id}`);

  const list = await call('GET', `/api/messages/INBOX?account=${acc.id}`);
  const row = list.messages.find((m) => m.subject === 'Racun in slike');
  ok(!!row, 'the message arrived', JSON.stringify(list.messages.map((m) => m.subject)));

  const msg = await call('GET', `/api/message/INBOX/${row.uid}?account=${acc.id}`);
  const shown = (msg.attachments || []).filter((a) => !a.inlineUsed);
  ok(shown.length === 2, 'the reading pane counts two attachments, not three',
     JSON.stringify((msg.attachments || []).map((a) => [a.filename, a.inline, a.inlineUsed])));

  // The download itself — a plain GET, exactly as the browser makes it.
  const res = await fetch(`${app.base}/api/message/INBOX/${row.uid}/attachments.zip?account=${acc.id}`, {
    headers: { cookie: call.cookie() },
  });
  ok(res.status === 200, 'the archive downloads', String(res.status));
  ok(/application\/zip/.test(res.headers.get('content-type') || ''), 'as a zip',
     res.headers.get('content-type'));
  const cd = res.headers.get('content-disposition') || '';
  ok(/Racun in slike\.zip|Racun%20in%20slike\.zip/.test(cd),
     'named after the message rather than "attachments.zip"', cd);

  const file = path.join(tmp, 'got.zip');
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));

  // Read back with an implementation that shares no code with the writer.
  const out = JSON.parse(execFileSync('python3', ['-c', `
import json, zipfile
z = zipfile.ZipFile(${JSON.stringify(file)})
print(json.dumps({"bad": z.testzip(), "names": z.namelist(),
                  "data": {n: z.read(n).decode('utf-8', 'replace') for n in z.namelist()}}, ensure_ascii=False))
`], { encoding: 'utf8' }));

  ok(out.bad === null, 'and it is a valid archive', String(out.bad));
  ok(out.names.length === 2, 'holding exactly the two real attachments', JSON.stringify(out.names));
  ok(!out.names.some((n) => /logo/i.test(n)),
     'the embedded logo is NOT in it — it is part of the body, not an attachment', JSON.stringify(out.names));
  ok(out.names.some((n) => n.includes('naročila')),
     'the Slovenian filename survived the MIME decode and the archive', JSON.stringify(out.names));
  // Both parts are called the same thing; both have to come out, with their own
  // bytes. A ZIP tolerates duplicate names and the unpacker usually keeps the
  // last, so this is where one of two attachments quietly disappears.
  const contents = Object.values(out.data).sort();
  ok(contents.length === 2 && contents.includes('PDF-ONE') && contents.includes('PDF-TWO-DIFFERENT'),
     'two attachments sharing a filename both survive, with their own contents', JSON.stringify(out.data));

  // A message with nothing to bundle says so rather than handing over an
  // archive containing nothing.
  const plain = list.messages.find((m) => m.subject === 'Brez prilog');
  ok(!!plain, 'the plain message is there to test with');
  const r = await fetch(`${app.base}/api/message/INBOX/${plain.uid}/attachments.zip?account=${acc.id}`,
    { headers: { cookie: call.cookie() } });
  ok(r.status === 404, 'a message with no attachments answers 404, not an empty zip', String(r.status));
} catch (e) {
  fail++;
  console.log('  ✗ harness error: ' + (e?.stack || e));
  if (app?.out?.length) console.log('--- server output ---\n' + app.out.join('').slice(-3000));
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
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
