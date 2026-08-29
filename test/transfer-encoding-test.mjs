// Repairing a transfer encoding a sender declared but did not apply
// (server/transferEncoding.js).
//
// This test is mostly about what it must REFUSE, and every refusal below is a
// message that a first, looser version of the detector actually corrupted when
// it was run over 2256 real cached messages. That version fired on 54 texts and
// damaged 20 of them. The rule that fixed it is the encoding's own defining
// property — a quoted-printable body is 7-bit ASCII — which no amount of
// pattern-matching on "=XX" would have found.
//
//   node test/transfer-encoding-test.mjs
import { looksQuotedPrintable, repairQuotedPrintable, decodeQuotedPrintable } from '../server/transferEncoding.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

// A real Akcije newsletter's text part, as mailparser handed it over.
const REAL = 'KUHANJE ZA VSE\n=C5=A0E NIKOLI NI BILO TAKO ENOSTAVNO=E2=80=8B=C4=8Ce =C5=A1e ne poznate na=\n=C5=A1ih XXL cvrtnikov';

console.log('what it repairs');
ok(looksQuotedPrintable(REAL), 'a text part that really is undecoded quoted-printable');
const fixed = repairQuotedPrintable(REAL);
ok(fixed.includes('ŠE NIKOLI NI BILO TAKO ENOSTAVNO'), 'the accents come back', JSON.stringify(fixed.slice(0, 40)));
ok(fixed.includes('naših XXL cvrtnikov'), 'and a word split across a soft line break is rejoined');
ok(!/=[0-9A-F]{2}/.test(fixed), 'nothing encoded is left');
ok(repairQuotedPrintable(fixed) === fixed, 'running it again changes nothing — it has to be idempotent, normalize() reruns it on every read');

console.log('what it refuses (each of these was really corrupted by a looser rule)');
// The decisive property: an undecoded QP body cannot contain a character above
// U+007F, because escaping those is the entire reason the encoding exists.
const log = '### TRACER=2 ####\n[Bridge] pid=517, Take lock\nOpozorilo: E-poštno sporočilo zunanjega pošiljatelja';
ok(!looksQuotedPrintable(log), 'a debug log whose text already has accents in it');
ok(repairQuotedPrintable(log) === log, 'so pid=517 does not become pidQ7');

const sha = 'git_sha=2940f9ef5114c1578841c067b7726d07c9e76435 čas: 12:00';
ok(repairQuotedPrintable(sha) === sha, 'a git sha does not become git_sha)40f9…');

const url = 'http://www.banka.example/cgi-bin/bankweb.exe?doc=24030&SeS=19320121215713907 Navodila za Firefox';
ok(repairQuotedPrintable(url) === url, "a bank's query string keeps its parameters (=24 would have become '$')");

const b64 = 'token=gX3TEaldEETY9NYsgIJiAMKJl1shHk_zu-vE9csHzIGuIGbybnv9rvwph6Q==\n\nXTEINK X3';
ok(repairQuotedPrintable(b64) === b64, 'base64 padding at the end of a line is not a soft line break');

ok(!looksQuotedPrintable('price =20 EUR'), 'one token is not evidence of anything');
ok(!looksQuotedPrintable('=3D =20 =09 escapes in documentation'), 'nor are three that all stand for ASCII — QP exists to carry the bytes above 0x7F');
ok(!looksQuotedPrintable('') && !looksQuotedPrintable(null) && !looksQuotedPrintable(42), 'nothing, and not-a-string');
ok(repairQuotedPrintable(null) === null, 'and the repair hands back exactly what it was given');

// The last line of defence, after the decode rather than before it.
console.log('the check after the fact');
ok(repairQuotedPrintable('a=19b=19c=19d') === 'a=19b=19c=19d',
  'a decode that produces control characters decoded something that was never encoded');

console.log('the decoder itself');
ok(decodeQuotedPrintable('=C5=A0e') === 'Še', 'two bytes of one UTF-8 character decode together, not separately');
ok(decodeQuotedPrintable('soft=\r\nbreak') === 'softbreak', 'soft line breaks join');
ok(decodeQuotedPrintable('=FF=FE plain') === '=FF=FE plain', "bytes that aren't valid UTF-8 are left exactly as they were");
// Not a micro-optimisation: this runs over the whole text part of every message
// on every parse, and a per-character version of it was most of what the
// notification preview cost.
const big = '=C5=A0e ne poznate '.repeat(20000);
const t0 = Date.now();
decodeQuotedPrintable(big);
ok(Date.now() - t0 < 500, 'a 380KB body decodes in well under half a second', `${Date.now() - t0}ms`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
