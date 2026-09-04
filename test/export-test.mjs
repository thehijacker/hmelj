// Exporting mail as mbox (server/export.js).
//
// The whole format rests on one ambiguity: a line inside a message that begins
// "From " is indistinguishable from the separator that starts the next message.
// Get the escaping wrong and an importer either splits one message into two or
// silently corrupts the text. mboxrd's answer is reversible — escape "From " to
// ">From ", and add one more ">" to anything already escaped — which is what
// this checks, in both directions.
//
// Bytes, not strings: old mail is in whatever encoding its sender used, and an
// export that round-trips it through a JS string turns everything that is not
// valid UTF-8 into replacement characters. That is precisely the mail an export
// exists to preserve, so there is a test for it below.
//
//   node test/export-test.mjs
import { mboxEntry, mboxDate, mboxSender, exportFilename, settingsArchive } from '../server/export.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const entry = (body, opts) => mboxEntry(Buffer.from(body, 'utf8'), opts).toString('utf8');

console.log('the separator line');
const one = entry('Subject: Hi\n\nhello\n', { from: 'ana@example.com', date: new Date(Date.UTC(2026, 0, 1, 9, 5, 3)) });
ok(one.startsWith('From ana@example.com Thu Jan  1 09:05:03 2026\n'), 'sender and ctime-format date', JSON.stringify(one.slice(0, 60)));
ok(mboxDate(new Date(Date.UTC(2026, 8, 3))).includes('Sep  3'), 'a single-digit day is space-padded, as ctime(3) does it');
ok(mboxSender('not an address') === 'MAILER-DAEMON', 'an unusable sender becomes the conventional stand-in');
ok(mboxSender('a b@c.d') === 'MAILER-DAEMON', 'and so does one with a space — the separator is whitespace-delimited');
ok(mboxSender('ana@example.com') === 'ana@example.com', 'a real one is kept');
ok(mboxDate(null).length > 0 && mboxDate(new Date('nonsense')).length > 0, 'a missing or invalid date does not produce garbage');

console.log('\nescaping — the entire point of the format');
ok(entry('Subject: x\n\nFrom now on we agree.\n').includes('\n>From now on'),
  'a body line starting "From " is escaped, or an importer would split the message in two');
ok(entry('Subject: x\n\n>From now on\n').includes('\n>>From now on'),
  'an already-escaped line gains another ">" — this is what makes it REVERSIBLE');
ok(entry('Subject: x\n\n>>>From now\n').includes('\n>>>>From now'), 'and so does a deeply escaped one');
ok(!entry('Subject: x\n\nFromage is cheese.\n').includes('>Fromage'),
  '"Fromage" is not "From " — the space is part of the token');
ok(!entry('Subject: x\n\n  From here\n').includes('>  From'), 'and neither is an indented "From"');
ok(entry('From: ana@example.com\nSubject: x\n\nbody\n').includes('\nFrom: ana@example.com'),
  'the From: HEADER is untouched — it has a colon, the separator does not');

console.log('\nreversibility, in full');
// What an importer does: strip one ">" from any line matching /^>+From /.
const original = 'Subject: x\n\nFrom a\n>From b\n>>From c\nordinary\n';
const written = entry(original);
const body = written.split('\n').slice(1); // drop the separator line
const restored = body.map((l) => (/^>+From /.test(l) ? l.slice(1) : l)).join('\n');
ok(restored.startsWith(original), 'unescaping gives back exactly what went in', JSON.stringify(restored.slice(0, 60)));

console.log('\nentries are separated so the next one can be found');
const two = entry('Subject: a\n\nbody\n') + entry('Subject: b\n\nbody\n');
ok(two.split(/^From /m).length === 3, 'two entries, two separators');
ok(entry('no trailing newline').endsWith('\n\n'), 'a message not ending in a newline still gets its blank line');
ok(entry('ends with one\n').endsWith('\n\n'), 'and one that does is not given two');
ok(mboxEntry(Buffer.alloc(0)).toString().split('\n').length >= 2, 'an empty message is still a valid entry');

console.log('\nbytes survive, whatever encoding they are in');
// A latin-1 "Št" — valid bytes, NOT valid UTF-8. Round-tripping through a
// string would replace them with U+FFFD and the exported mail would be wrong.
const latin1 = Buffer.concat([Buffer.from('Subject: x\n\n', 'ascii'), Buffer.from([0x8a, 0x74, 0x0a])]);
const outBuf = mboxEntry(latin1);
ok(outBuf.includes(0x8a), 'a non-UTF-8 byte comes out exactly as it went in');
ok(Buffer.isBuffer(outBuf), 'and the result is a Buffer, not a string');
const crlf = mboxEntry(Buffer.from('Subject: x\r\n\r\nFrom a\r\n', 'utf8')).toString();
ok(crlf.includes('>From a\r'), 'CRLF line endings are escaped correctly too — IMAP delivers CRLF');

console.log('\nfilenames');
ok(exportFilename(['Work', 'INBOX'], 'mbox') === 'Work-INBOX.mbox', 'the obvious case');
ok(!/[\\/:*?"<>|]/.test(exportFilename(['a/b:c*d?e"f<g>h|i'], 'mbox')), 'every character Windows refuses is gone');
ok(exportFilename([''], 'mbox') === 'hmelj.mbox', 'an empty name still produces a file');
ok(exportFilename(['x'.repeat(500)], 'mbox').length <= 85, 'and an absurd one is cut');

console.log('\nthe settings archive says what it does NOT contain');
const files = settingsArchive({ settings: { a: 1 }, identities: [{ id: 'i1' }], contacts: [] });
const names = files.map((f) => f.name);
ok(names.includes('settings.json') && names.includes('identities.json'), 'what there is');
ok(!names.includes('contacts.json'), 'an empty list is left out rather than exported as []');
ok(!names.some((n) => /account/i.test(n)), 'mail accounts are NOT in it');
const readme = files.find((f) => f.name === 'README.txt').data.toString();
ok(/accounts/i.test(readme) && /password/i.test(readme),
  'and the README says so, with the reason — a silent omission would look like a bug');
ok(/mbox/i.test(readme), 'it also says where the mail went');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
