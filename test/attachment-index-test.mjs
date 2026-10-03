// The Attachments page's index (cache.js#listAttachments).
//
// Pinned: an inline image the body draws is not an "attachment"; the same
// message filed under two Gmail labels is listed once; a moved or deleted
// message drops out at once; and nobody sees another user's files.
//
//   node test/attachment-index-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-att-'));
process.env.CACHE_DIR = dir; process.env.DATA_DIR = dir;
const cache = await import(new URL('../server/cache.js', import.meta.url).href);

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const U = 'me-1', OTHER = 'other-2', A = 'acct-1';
function put(user, folder, uid, messageId, attachments, date = Date.now()) {
  cache.upsertMessages(user, A, folder, null, [{
    uid, subject: 'S' + uid, from: { name: 'Ana', address: 'ana@firma.si' }, to: [], date: new Date(date).toISOString(),
    size: 10, seen: true, flagged: false, deleted: false, draft: false, hasAttachment: true, messageId, threadKey: messageId,
  }]);
  cache.saveMessageContent(user, A, folder, uid, { subject: 'S' + uid, attachments }, 100);
}

put(U, 'INBOX', 1, 'm1@x', [
  { index: 0, filename: 'logo.png', contentType: 'image/png', size: 900, inline: true, inlineUsed: true },
  { index: 1, filename: 'Ponudba.PDF', contentType: 'application/pdf', size: 50000 },
], Date.parse('2026-09-01'));
put(U, '[Gmail]/All Mail', 7, 'm1@x', [{ index: 1, filename: 'Ponudba.PDF', contentType: 'application/pdf', size: 50000 }], Date.parse('2026-09-01'));
put(U, 'INBOX', 2, 'm2@x', [{ index: 0, filename: 'tabela.xlsx', size: 8000 }, { index: 1, filename: 'foto.jpg', size: 900000 }], Date.parse('2026-09-20'));
put(OTHER, 'INBOX', 3, 'm3@x', [{ index: 0, filename: 'secret.pdf', size: 1 }]);

const all = cache.listAttachments(U, [A]);
ok(all.total === 3, 'three real attachments: the inline logo is not one, and the labelled copy is not a second', `got ${all.total}`);
ok(all.items[0].filename === 'tabela.xlsx' || all.items[0].filename === 'foto.jpg', 'newest first');
ok(!all.items.some((i) => i.filename === 'secret.pdf'), 'another user\'s files never appear');
ok(cache.listAttachments(U, [A], { type: 'pdf' }).items.map((i) => i.filename).join() === 'Ponudba.PDF', 'the PDF filter, case-insensitively');
ok(cache.listAttachments(U, [A], { type: 'images' }).items.map((i) => i.filename).join() === 'foto.jpg', 'the image filter');
ok(cache.listAttachments(U, [A], { type: 'other' }).total === 0, '"other" is what no group claims — nothing here');
ok(cache.listAttachments(U, [A], { sort: 'size' }).items[0].filename === 'foto.jpg', 'largest first');
ok(cache.listAttachments(U, [A], { q: 'ponud' }).total === 1, 'search by file name');
ok(cache.listAttachments(U, [A], { q: 'ana@' }).total === 3, 'and by sender');
const it = cache.listAttachments(U, [A], { type: 'spreadsheets' }).items[0];
ok(it.folder === 'INBOX' && it.uid === 2 && it.index === 0, 'each row says where to fetch the file from');

cache.removeMessages(U, A, 'INBOX', [2]);
ok(cache.listAttachments(U, [A]).total === 1, 'a message that is gone takes its attachments with it, at once');
ok(cache.pruneAttachmentIndex() >= 2, 'and the leftover rows are tidied away');

console.log('\nwhat is not a file');
const E = cache.attachmentEntry;
ok(E({ index: 0, filename: 'attachment-0', contentType: 'text/calendar', size: 2165 }) === null, 'the invitation part an invite is drawn from');
ok(E({ index: 0, filename: 'attachment-0', contentType: 'text/x-amp-html', size: 19398 }) === null, "Gmail's AMP copy of the body");
ok(E({ index: 1, filename: 'attachment-1', contentType: 'message/global-headers', size: 17448 }) === null, "a bounce's report");
ok(E({ index: 2, filename: '.', contentType: 'application/octet-stream', size: 5042, cid: 'x@y' }) === null, 'a marketplace logo named "."');
ok(E({ index: 3, filename: 'img-4b970134-ce98-4937-9729-9e3866ed3867', contentType: 'application/octet-stream', size: 5449, cid: 'a@b' }) === null, 'an Exchange forward\'s img-<uuid> picture');
ok(E({ index: 0, filename: 'image001.jpg', contentType: 'image/jpeg', size: 12134, cid: 'image001', inline: true }) === null, 'a signature picture the HTML forgot to reference');
ok(E({ index: 0, filename: 'attachment-0', contentType: 'message/rfc822', size: 1461 })?.filename === 'message.eml', 'an attached email is kept, named message.eml');
ok(E({ index: 0, filename: 'attachment-0', contentType: 'image/png', size: 4405 })?.filename === 'image.png', 'an unnamed picture is kept, named image.png');
ok(E({ index: 0, filename: 'Skeniran račun.jpg', contentType: 'image/jpeg', size: 40000, cid: 'c', inline: true }) === null, 'a small inline picture with a Content-ID is decoration even when named');
ok(E({ index: 0, filename: 'Skeniran račun.jpg', contentType: 'image/jpeg', size: 400000, cid: 'c', inline: true })?.filename === 'Skeniran račun.jpg', 'but a large one is a real photo, kept');
ok(E({ index: 0, filename: '.', contentType: 'application/octet-stream', size: 4123, cid: null, inline: false }) === null, 'a nameless part of no known type ("." from bolha.com) — not "file"');
ok(E({ index: 0, filename: '', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 9000 })?.filename === 'spreadsheet.xlsx', 'a nameless spreadsheet is kept and called one');
ok(E({ index: 0, filename: 'Pogodba.pdf', contentType: 'application/pdf', size: 90000 })?.filename === 'Pogodba.pdf', 'an ordinary file is kept as it is');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
