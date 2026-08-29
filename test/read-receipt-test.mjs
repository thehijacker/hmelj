// Read receipts (server/readReceipt.js) — the MIME a receipt has to BE, and the
// header parsing that broke first.
//
// The structure is the whole point: a receipt is a multipart/report whose second
// part is a message/disposition-notification. Get that wrong and it arrives as
// an ordinary email that no client recognises as a receipt — which is why this
// is written by hand rather than composed, and why it is checked here.
//
//   node test/read-receipt-test.mjs
import { buildMdn, receiptAddressOf, encodeHeaderWord, formatAddress } from '../server/readReceipt.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

console.log('reading the address the sender asked for');
ok(receiptAddressOf('sender@example.com') === 'sender@example.com', 'a bare address');
ok(receiptAddressOf('Janez Novak <janez@example.com>') === 'janez@example.com', 'a name + address string');
// The one that shipped broken: mailparser hands address headers back as an
// object, and String(obj) is "[object Object]".
ok(receiptAddressOf({ value: [{ address: 'janez@example.com', name: 'Janez' }], text: 'Janez <janez@example.com>' }) === 'janez@example.com',
  "mailparser's address OBJECT, which is what actually arrives");
ok(receiptAddressOf({ text: 'fallback@example.com', value: [] }) === 'fallback@example.com', 'an object with only text');
ok(receiptAddressOf(null) === '' && receiptAddressOf(undefined) === '' && receiptAddressOf({}) === '', 'nothing in, nothing out');

// Through the real parser, not just the helper: the sibling feature
// (unsubscribe) shipped dead because its glue read a header key mailparser does
// not have, and a pure-function test could never have seen it. This asserts the
// key exists AND that what comes out of it is an address, not "[object Object]".
console.log('through the actual parser');
const { simpleParser } = await import('mailparser');
const parsed = await simpleParser([
  'From: Janez <janez@example.com>', 'To: a@b.si', 'Subject: Račun',
  'Disposition-Notification-To: Janez Novak <janez@example.com>',
  'Content-Type: text/plain; charset=utf-8', '', 'Pozdravljeni', '',
].join('\r\n'));
const header = parsed.headers.get('disposition-notification-to');
ok(header !== undefined, 'mailparser really does keep this header under this key');
ok(receiptAddressOf(header) === 'janez@example.com', 'and it flattens to a plain address', String(receiptAddressOf(header)));
ok(String(header) === '[object Object]', 'while printing it directly is what the banner used to show');

console.log('header encoding');
ok(encodeHeaderWord('Plain ASCII') === 'Plain ASCII', 'ASCII is left alone');
ok(/^=\?UTF-8\?B\?/.test(encodeHeaderWord('Račun za avgust')), 'non-ASCII becomes an RFC 2047 encoded word');
ok(Buffer.from(encodeHeaderWord('Račun').slice(10, -2), 'base64').toString('utf8') === 'Račun', 'and decodes back to the original');
ok(formatAddress('a@b.si', '') === 'a@b.si', 'an address with no display name stays bare');
ok(formatAddress('a@b.si', 'Šef') .endsWith('<a@b.si>'), 'a display name is encoded, the address is not');

console.log('the receipt itself');
const raw = buildMdn({
  to: 'janez@example.com',
  from: 'andrej@example.si',
  fromName: 'Andrej Kralj',
  originalSubject: 'Račun za avgust',
  originalMessageId: '<orig-123@example.com>',
  originalDate: 'Wed, 26 Aug 2026 08:00:00 +0000',
  originalTo: 'andrej@example.si',
  messageId: '<mdn-1@hmelj>',
  date: new Date(Date.UTC(2026, 7, 26, 10, 0, 0)),
});

ok(/^Content-Type: multipart\/report; report-type=disposition-notification;/m.test(raw),
  'it is a multipart/report, report-type=disposition-notification');
const boundary = raw.match(/boundary="([^"]+)"/)[1];
ok(raw.split(`--${boundary}`).length === 4, 'two parts, and a closing delimiter', String(raw.split(`--${boundary}`).length));
ok(raw.trimEnd().endsWith(`--${boundary}--`), 'the closing delimiter is last');
ok(raw.includes('Content-Type: message/disposition-notification'), 'the machine-readable part is a message/disposition-notification');
ok(/^Disposition: manual-action\/MDN-sent-manually; displayed$/m.test(raw),
  'the disposition says manual — nothing here is ever sent without the button');
ok(/^Final-Recipient: rfc822;andrej@example\.si$/m.test(raw), 'Final-Recipient is the reading account');
ok(/^Original-Message-ID: <orig-123@example\.com>$/m.test(raw), 'it names the message being acknowledged');
ok(/^In-Reply-To: <orig-123@example\.com>$/m.test(raw), 'and threads under it');
ok(/^To: janez@example\.com$/m.test(raw), 'addressed to whoever asked for the receipt');
ok(/^From: =\?UTF-8\?B\?.*\?= <andrej@example\.si>$/m.test(raw) || /^From: Andrej Kralj <andrej@example\.si>$/m.test(raw),
  'from the reading account');
ok(/^Subject: =\?UTF-8\?B\?/m.test(raw), "the subject carries the original's, encoded (it has a č in it)");
ok(!/Disposition-Notification-To/i.test(raw), 'a receipt never asks for a receipt of its own — that is how mail loops start');
ok(/^Auto-Submitted: auto-replied$/m.test(raw), 'marked auto-submitted, so it never triggers vacation autoresponders');

console.log('injection');
const evil = buildMdn({
  to: 'x@y.si\r\nBcc: victim@elsewhere.si',
  from: 'me@here.si',
  originalSubject: 'hello\r\nX-Injected: yes',
  messageId: '<m@h>',
});
ok(!/^Bcc:/m.test(evil), 'a CRLF in an address cannot smuggle in another header');
ok(!/^X-Injected:/m.test(evil), 'nor can one in the subject');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
