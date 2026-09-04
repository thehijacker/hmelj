// vCard 3.0/4.0, read and write (server/vcard.js).
//
// The cards below are the shapes real servers emit, not the ones RFC 6350 makes
// convenient to parse. Three of them decide whether live CardDAV sync can work
// at all:
//
//   - a vCard 2.1 bare parameter (`TEL;WORK;VOICE:`) still comes off Apple
//     Contacts, older Outlook exports and most phones. iCalendar's parser drops
//     those, which is why this file has its own;
//   - folding counts OCTETS, so a name with a š in it must not be cut in half;
//   - a card carries far more than Hmelj models, and an edit must replace ONLY
//     the managed properties. The round-trip assertions below are the ones that
//     fail first if that ever stops being true.
//
//   node test/vcard-test.mjs
import {
  parseCard, parseCards, parseContentLine, serializeCard, applyContact, newCard,
  cardName, cardEmails, cardUid, cardToRows, components, listOf, escapeText, foldLine,
  propsOf, valueOf,
} from '../server/vcard.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
const vcf = (...lines) => ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD'].join('\r\n') + '\r\n';

console.log('content lines');
let l = parseContentLine('EMAIL;TYPE=WORK:a@b.example');
ok(l.name === 'EMAIL' && l.value === 'a@b.example', 'name and value');
ok(JSON.stringify(l.params.TYPE) === '["WORK"]', 'a parameter is always an array, even when there is one');
l = parseContentLine('TEL;WORK;VOICE:+386 1 234 5678');
ok(JSON.stringify(l.params.TYPE) === '["WORK","VOICE"]',
  'vCard 2.1 bare parameters become TYPEs — iCalendar drops these, which is why this parser exists',
  JSON.stringify(l.params));
l = parseContentLine('item1.EMAIL;TYPE=HOME:x@y.example');
ok(l.group === 'item1' && l.name === 'EMAIL', 'a property group is split off the name (Apple writes these)');
l = parseContentLine('ADR;TYPE="work,postal":;;Slovenska 1;Ljubljana;;1000;SI');
ok(JSON.stringify(l.params.TYPE) === '["work,postal"]',
  'a QUOTED parameter value containing a comma is ONE value, not two', JSON.stringify(l.params.TYPE));
l = parseContentLine('TYPE=A,B' ? 'X-T;TYPE=A,B:v' : '');
ok(JSON.stringify(l.params.TYPE) === '["A","B"]', 'an unquoted one containing a comma is two');
ok(parseContentLine('NOCOLON') === null, 'a line that is not a content line at all');
ok(parseContentLine('NOTE:https://example.com/a:b').value === 'https://example.com/a:b',
  'the value is everything after the FIRST colon, colons and all');

console.log('structured values and escaping');
ok(JSON.stringify(components('Novak;Jožefa;;;')) === '["Novak","Jožefa","","",""]', 'N splits into its five components');
ok(components('a\\;b;c')[0] === 'a;b', 'an ESCAPED semicolon is a literal, not a component boundary');
ok(JSON.stringify(listOf('work,home')) === '["work","home"]', 'a comma list');
ok(listOf('a\\,b')[0] === 'a,b', 'an escaped comma stays one item');
ok(escapeText('a;b,c\\d\ne') === 'a\\;b\\,c\\\\d\\ne', 'every TEXT escape, backslash first', escapeText('a;b,c\\d\ne'));
ok(components(escapeText('Sejna soba 2; 1. nadstropje'))[0] === 'Sejna soba 2; 1. nadstropje',
  'escape then split round-trips a value containing a separator');

console.log('folding');
ok(foldLine('SHORT:value') === 'SHORT:value', 'a short line is left alone');
const longAscii = foldLine('NOTE:' + 'x'.repeat(200));
ok(longAscii.split('\r\n').every((s, i) => Buffer.byteLength(i ? s : s) <= 75),
  'no folded line exceeds 75 octets');
ok(longAscii.split('\r\n').slice(1).every((s) => s.startsWith(' ')), 'every continuation begins with one space');
ok(longAscii.split('\r\n').join('').replace(/^NOTE:/, '').replace(/ /g, '').length === 200,
  'and unfolding it gives back what went in');
// The assertion that matters: 75 CHARACTERS of "žž…" is 150 octets, and cutting
// mid-sequence produces a replacement character the server then rejects.
const folded = foldLine('FN:' + 'ž'.repeat(80));
ok(!folded.includes('�'), 'a multi-byte character is never cut in half');
ok(folded.split('\r\n').map((s, i) => s.slice(i ? 1 : 0)).join('').replace(/^FN:/, '') === 'ž'.repeat(80),
  'and the unfolded value is intact');

console.log('reading a card');
const real = vcf(
  'UID:abc-123',
  'FN:Jožefa Novak',
  'N:Novak;Jožefa;;;',
  'EMAIL;TYPE=WORK;TYPE=PREF:j.novak@acme.example',
  'EMAIL;TYPE=HOME:jozefa@example.org',
  'TEL;WORK;VOICE:+386 1 234 5678',
  'BDAY:1979-04-12',
  'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRg==',
  'X-ABShowAs:COMPANY',
);
const card = parseCard(real);
ok(cardUid(card) === 'abc-123', 'UID');
ok(cardName(card) === 'Jožefa Novak', 'FN is the display name');
const emails = cardEmails(card);
ok(emails.length === 2, 'both addresses');
ok(emails[0].email === 'j.novak@acme.example', 'the PREF one sorts first');
ok(JSON.stringify(emails[0].types) === '["WORK"]',
  'PREF and INTERNET are dropped from the types — neither is a place', JSON.stringify(emails[0].types));
ok(cardName(parseCard(vcf('N:Novak;Janez;;dr.;'))) === 'dr. Janez Novak',
  'with no FN the name is built from N, in reading order', cardName(parseCard(vcf('N:Novak;Janez;;dr.;'))));
ok(cardName(parseCard(vcf('ORG:Acme d.o.o.;Sales'))) === 'Acme d.o.o.',
  'and with neither, the organisation');

console.log('one card, one row per address');
const rows = cardToRows(card, { sourceId: 's1', href: '/x.vcf' });
ok(rows.length === 2, 'two addresses are two things you can write to');
ok(rows[0].sourceId === 's1' && rows[0].href === '/x.vcf', 'the metadata rides along on every row');
ok(rows[1].emailIndex === 1 && rows[1].name === 'Jožefa Novak', 'both rows carry the same name');
ok(cardToRows(parseCard(vcf('FN:Nobody'))).length === 0, 'a card with no address produces no rows');

console.log('quoted-printable, and other things phones emit');
const qp = parseCard('BEGIN:VCARD\r\nVERSION:2.1\r\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jo=C5=BEefa\r\nEND:VCARD');
ok(cardName(qp) === 'Jožefa', 'a DECLARED quoted-printable value is decoded', cardName(qp));
const qpLower = parseCard('BEGIN:VCARD\r\nVERSION:2.1\r\nFN;ENCODING=QUOTED-PRINTABLE:Jo=c5=bEefa\r\nEND:VCARD');
ok(cardName(qpLower) === 'Jožefa', 'including lowercase hex', cardName(qpLower));
ok(cardEmails(parseCard(vcf('EMAIL:not-an-address', 'EMAIL:real@example.com')))
  .every((e) => e.email.includes('@')), 'an EMAIL property holding something that is not one is dropped');

console.log('several cards in one stream');
const many = parseCards(real + vcf('UID:d-4', 'FN:Two') + vcf('UID:e-5', 'FN:Three'));
ok(many.cards.length === 3, 'a .vcf file is routinely hundreds of cards', String(many.cards.length));
ok(cardName(many.cards[2]) === 'Three', 'the last one is intact');
ok(parseCards('').cards.length === 0, 'nothing is no cards');
ok(parseCards('Dear Andrej,\r\nsee you at 2.').cards.length === 0, 'and neither is an ordinary message');
// A .vcf that lost its trailing newline is far more often a truncated download
// than a broken card, and dropping the last contact of every import is worse.
ok(parseCards(vcf('UID:a', 'FN:One') + 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Unterminated').cards.length === 2,
  'an unterminated final card is kept');

console.log('writing — and what must NOT change');
const edited = applyContact(parseCard(real), { name: 'Jožefa Kralj' });
const out = serializeCard(edited);
ok(out.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n') && out.endsWith('END:VCARD\r\n'), 'envelope and CRLF endings');
ok(out.includes('FN:Jožefa Kralj'), 'FN was replaced');
ok(out.includes('N:Kralj;Jožefa;;;'), 'N followed it', /N:[^\r]*/.exec(out)?.[0]);
// The whole design in one assertion: Hmelj models none of these four and must
// not lose any of them.
for (const kept of ['TEL;TYPE=WORK;TYPE=VOICE:+386 1 234 5678', 'BDAY:1979-04-12', 'PHOTO;ENCODING=b', 'X-ABShowAs:COMPANY']) {
  ok(out.includes(kept), `an unmodelled property survives the edit: ${kept.split(/[;:]/)[0]}`);
}
ok(/REV:\d{4}-\d\d-\d\dT/.test(out), 'REV is bumped, in 3.0 extended format', /REV:[^\r]*/.exec(out)?.[0]);
const v4 = applyContact(parseCard(vcf('UID:u').replace('VERSION:3.0', 'VERSION:4.0')), { name: 'X' });
ok(/REV:\d{8}T\d{6}Z/.test(serializeCard(v4)), 'and in 4.0 basic format', /REV:[^\r]*/.exec(serializeCard(v4))?.[0]);

console.log('addresses in, addresses out');
const two = applyContact(parseCard(real), { emails: [{ email: 'new@x.example', types: ['WORK'] }, { email: 'b@y.example' }] });
const twoOut = serializeCard(two);
ok(propsOf(two, 'EMAIL').length === 2, 'the address list is replaced wholesale, not merged');
ok(twoOut.includes('EMAIL;TYPE=WORK;TYPE=PREF:new@x.example'), 'the first is marked preferred in 3.0 dialect',
  /EMAIL[^\r]*/.exec(twoOut)?.[0]);
const v4pref = applyContact(parseCard(vcf('UID:u').replace('VERSION:3.0', 'VERSION:4.0')),
  { emails: [{ email: 'a@x.example' }, { email: 'b@x.example' }] });
ok(serializeCard(v4pref).includes('EMAIL;PREF=1:a@x.example'), 'and with PREF=1 in 4.0 dialect',
  /EMAIL[^\r]*/.exec(serializeCard(v4pref))?.[0]);
ok(propsOf(applyContact(parseCard(real), { emails: [] }), 'EMAIL').length === 0, 'and can be emptied');

console.log('a card Hmelj created');
const fresh = newCard({ name: 'Janez Novak', emails: [{ email: 'janez@example.com', types: ['HOME'] }], uid: 'u-9' });
const freshOut = serializeCard(fresh);
ok(cardUid(fresh) === 'u-9' && cardName(fresh) === 'Janez Novak', 'name and uid');
ok(!freshOut.includes('\nN:'), 'no N is invented — guessing where a one-word name splits is not this file\'s job');
ok(serializeCard(parseCard(freshOut)) === freshOut, 'serialize → parse → serialize is a fixed point');
ok(newCard({ name: 'x' }).version === '3.0', '3.0 by default — some servers still refuse 4.0 outright');

console.log('parameters that need quoting on the way out');
const q = { version: '3.0', props: [{ group: null, name: 'X-T', params: { P: ['a,b'] }, value: 'v' }] };
ok(serializeCard(q).includes('X-T;P="a,b":v'), 'a parameter value containing a comma is re-quoted',
  /X-T[^\r]*/.exec(serializeCard(q))?.[0]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
