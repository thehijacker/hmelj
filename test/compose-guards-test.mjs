// The two pre-send questions (public/js/composeGuards.js).
//
// The one that matters is the attachment reminder, and the thing worth testing
// is the LANGUAGE handling — because the message it exists for is short:
// "Pozdravljeni, v prilogi pošiljam račun." is five words, which is exactly
// where language detection is still guessing. So the rule under test is: when
// the language is unknown, every list is scanned. Being wrong in the other
// direction means the invoice does not go out.
//
// Slovene inflects, which is the other half: "priloga / prilogi / prilogo /
// prilogah" are one word to a reader, and a guard that only knows the
// nominative is a guard that misses most real sentences.
//
//   node test/compose-guards-test.mjs
import fs from 'fs';
import vm from 'vm';

const src = fs.readFileSync(new URL('../public/js/composeGuards.js', import.meta.url), 'utf8');
const ctx = vm.createContext({ window: {} });
vm.runInContext(src, ctx);
const G = ctx.window.ComposeGuards;

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

console.log('English');
for (const s of [
  'Please see attached.',
  'The report is attached.',
  'I have attached the invoice.',
  'Attaching the file now.',
  'Please find attached our offer.',
  'Documents enclosed.',
]) ok(G.mentionsAttachment(s, 'en'), JSON.stringify(s));
for (const s of [
  'Let us meet on Tuesday.',
  'I will send it later.',
]) ok(!G.mentionsAttachment(s, 'en'), JSON.stringify(s) + ' — no false alarm on ordinary prose');
// An accepted false positive, stated rather than hidden: "attachment" used as
// an ordinary noun does fire. The cost is one dismissed dialog; the cost of
// excluding it is missing "the attachment is below", which is the sentence this
// whole guard exists for.
ok(G.mentionsAttachment('The attachment point of the bracket is welded.', 'en'),
  'a sentence using "attachment" as a real noun DOES fire — an accepted false positive, not an oversight');

console.log('\nSlovenian, in the cases that actually occur');
for (const s of [
  'Pozdravljeni, v prilogi pošiljam račun.',
  'Račun je v priponki.',
  'Prilagam ponudbo za marec.',
  'Pripenjam še pogodbo.',
  'Dokument je priložen.',
  'Datoteka je priložena spodaj.',
  'Podatki so v prilogah.',
  'Prilogo najdete spodaj.',
  'Priloge so tri.',
]) ok(G.mentionsAttachment(s, 'sl'), JSON.stringify(s));

console.log('\nwritten without šumniki, which people do constantly');
ok(G.mentionsAttachment('Racun je prilozen.', 'sl'), 'prilozen (no š/ž) still matches');
ok(G.mentionsAttachment('V prilogi je prilozeno vse.', 'sl'), 'and prilozeno');

console.log('\nordinary Slovene prose is left alone');
for (const s of [
  'Se vidimo jutri ob devetih.',
  'Hvala za hiter odgovor.',
  'Priložnost za sodelovanje je zanimiva.', // "priložnost" — starts like "priložen" and is not it
  'Prilagoditev cene je mogoča.',           // "prilagoditev" — starts like "prilagam"
]) ok(!G.mentionsAttachment(s, 'sl'), JSON.stringify(s));

console.log('\nthe language is NOT trusted when it is not known');
// This is the whole point: a four-word Slovene message is exactly what
// detection cannot classify, and exactly what the guard is for.
ok(G.mentionsAttachment('V prilogi.', null), 'unknown language still catches Slovene');
ok(G.mentionsAttachment('V prilogi.', 'auto'), "and so does 'auto'");
ok(G.mentionsAttachment('See attached.', null), 'unknown language still catches English');
ok(G.mentionsAttachment('V prilogi.', 'en') === false,
  'but a CONFIDENT wrong language does narrow it — detection saying "en" is a real answer, not a shrug');

console.log('\nthe decision itself');
ok(G.missingAttachment({ text: 'V prilogi je račun.', attachmentCount: 0, lang: 'sl' }) === true,
  'mentioned and missing → ask');
ok(G.missingAttachment({ text: 'V prilogi je račun.', attachmentCount: 1, lang: 'sl' }) === false,
  'mentioned and present → say nothing');
ok(G.missingAttachment({ text: 'Se vidimo jutri.', attachmentCount: 0, lang: 'sl' }) === false,
  'not mentioned → say nothing');
ok(G.missingAttachment({ text: '', attachmentCount: 0, lang: null }) === false, 'an empty message asks nothing');
ok(G.missingAttachment({ text: null, attachmentCount: 0 }) === false, 'and neither does no message at all');

console.log('\nreply-all: who would be added');
const mine = ['me@example.com'];
ok(G.replyAllWouldAdd({
  to: [{ address: 'me@example.com' }], cc: [], replyingTo: [{ address: 'ana@example.com' }], mine,
}).length === 0, 'a message addressed only to me adds nobody — this is the case that must stay silent');
ok(G.replyAllWouldAdd({
  to: [{ address: 'me@example.com' }, { address: 'bob@example.com' }],
  cc: [{ address: 'cara@example.com' }],
  replyingTo: [{ address: 'ana@example.com' }], mine,
}).length === 2, 'two other people would be added');
ok(G.replyAllWouldAdd({
  to: [{ address: 'ME@example.com' }], cc: [], replyingTo: [], mine,
}).length === 0, 'my own address is matched case-insensitively');
ok(G.replyAllWouldAdd({
  to: [{ address: 'bob@example.com' }], cc: [{ address: 'BOB@example.com' }], replyingTo: [], mine,
}).length === 1, 'somebody on both To and Cc is still one person');
ok(G.replyAllWouldAdd({
  to: [{ address: 'ana@example.com' }], cc: [], replyingTo: [{ address: 'ana@example.com' }], mine,
}).length === 0, 'the person being replied to is not "added" — they are already the recipient');
ok(G.replyAllWouldAdd({}).length === 0, 'nothing in, nothing out');
ok(G.replyAllWouldAdd({ to: ['plain@example.com'], mine: [] })[0] === 'plain@example.com',
  'plain strings work as well as address objects');

console.log('\nadding a language is adding one array');
ok(Object.keys(G.ATTACH_WORDS).sort().join() === 'en,sl', 'the table is keyed by language and nothing else');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
