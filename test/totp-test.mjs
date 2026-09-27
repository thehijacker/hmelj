// Time-based one-time passwords (server/totp.js).
//
// This suite exists because TOTP fails silently in the worst possible way: a
// wrong byte order, a wrong truncation offset or a wrong base32 alphabet all
// produce six perfectly plausible digits that simply never match what the
// user's phone shows — and the only symptom is "2FA doesn't work", with no way
// to tell from inside the app whose clock is wrong.
//
// So it is checked against RFC 6238's own published vectors rather than
// against itself. Those are 8-digit; the last six of each are what a 6-digit
// authenticator shows for the same key and time, which is what this generates.
//
//   node test/totp-test.mjs
import {
  base32Encode, base32Decode, generateSecret, codeAt, verify,
  otpauthUri, generateRecoveryCodes, normalizeRecoveryCode,
} from '../server/totp.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
const eq = (a, b, m) => ok(a === b, m, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

// RFC 6238 Appendix B: the SHA-1 key is the ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

console.log('base32, both ways');
eq(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', "RFC 6238's test key encodes to the documented base32");
eq(base32Decode(RFC_SECRET).toString('ascii'), '12345678901234567890', 'and decodes back to the same bytes');
eq(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').toString('ascii'), '12345678901234567890',
  'lower case and the spaces authenticators insert are accepted — this is what people retype by hand');
eq(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ====').toString('ascii'), '12345678901234567890',
  'and so is padding');
{
  let threw = false;
  try { base32Decode('NOT-BASE32!'); } catch { threw = true; }
  ok(threw, 'a character outside the alphabet throws rather than decoding to the wrong key');
}
{
  // Round-trips at every length, so a partial final group is not silently lost.
  let allBack = true;
  for (let n = 1; n <= 24; n++) {
    const b = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255));
    if (!base32Decode(base32Encode(b)).equals(b)) allBack = false;
  }
  ok(allBack, 'every byte length round-trips, including the ones that leave a partial group');
}

console.log('\nRFC 6238 Appendix B vectors (SHA-1), as 6 digits');
for (const [t, want] of [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],   // past 2038 — the counter no longer fits in 32 bits
]) {
  eq(codeAt(RFC_SECRET, Math.floor(t / 30)), want, `T=${t}`);
}

console.log('\nthe drift window');
const AT = 1111111109 * 1000;
ok(verify(RFC_SECRET, '081804', { at: AT }), 'the current step is accepted');
ok(verify(RFC_SECRET, codeAt(RFC_SECRET, Math.floor(AT / 1000 / 30) - 1), { at: AT }),
  'so is the previous one — a code typed as the step rolled over is not a second too late');
ok(verify(RFC_SECRET, codeAt(RFC_SECRET, Math.floor(AT / 1000 / 30) + 1), { at: AT }),
  'and the next — a phone clock half a minute fast still works');
ok(!verify(RFC_SECRET, codeAt(RFC_SECRET, Math.floor(AT / 1000 / 30) + 2), { at: AT }),
  'two steps out is refused: the window is a tolerance, not an hour');
ok(!verify(RFC_SECRET, '000000', { at: AT }), 'a wrong code is refused');

console.log('\nwhat is not a code');
for (const bad of ['', null, undefined, '81804', '0818040', 'abcdef', '08180a', '81804 1'])
  ok(!verify(RFC_SECRET, bad, { at: AT }), `refused: ${JSON.stringify(bad)}`);

console.log('\nwhitespace is typing, not input');
// Authenticators display "081 804", and a code arrives pasted as often as
// typed — with the app's own grouping space, or a newline from the clipboard.
// Stripping all of it is deliberate: none of these is a different code.
for (const spaced of [' 081804 ', '081 804', '08 18 04', '081804\n', '\t081804'])
  ok(verify(RFC_SECRET, spaced, { at: AT }), `accepted: ${JSON.stringify(spaced)}`);

console.log('\nsecrets');
{
  const a = generateSecret(), b = generateSecret();
  eq(a.length, 32, 'a generated secret is 160 bits, the length SHA-1 authenticators expect');
  ok(a !== b, 'two are not the same');
  ok(/^[A-Z2-7]+$/.test(a), 'and it is in the base32 alphabet, so it can be typed in by hand');
  ok(verify(a, codeAt(a, Math.floor(Date.now() / 1000 / 30))), 'a fresh secret verifies its own current code');
}

console.log('\nthe otpauth:// URI the QR encodes');
{
  const uri = otpauthUri('JBSWY3DPEHPK3PXP', { issuer: 'Hmelj', account: 'andrej' });
  const u = new URL(uri);
  eq(u.protocol, 'otpauth:', 'scheme');
  eq(decodeURIComponent(u.pathname).replace(/^\/+/, ''), 'Hmelj:andrej', 'the label carries issuer AND account, for apps that read only the label');
  eq(u.searchParams.get('issuer'), 'Hmelj', 'and issuer is repeated as a parameter, for the apps that read only that');
  eq(u.searchParams.get('secret'), 'JBSWY3DPEHPK3PXP', 'secret');
  eq(u.searchParams.get('digits'), '6', 'digits');
  eq(u.searchParams.get('period'), '30', 'period');
  eq(u.searchParams.get('algorithm'), 'SHA1', 'algorithm');
  ok(!otpauthUri('S', { account: 'a b@c.si' }).includes(' '), 'an account with a space in it is still a valid URI');
}

console.log('\nrecovery codes');
{
  const codes = generateRecoveryCodes();
  eq(codes.length, 10, 'ten of them');
  eq(new Set(codes).size, 10, 'all different');
  ok(codes.every((c) => /^[23456789BCDFGHJKMNPQRSTVWXYZ]{5}-[23456789BCDFGHJKMNPQRSTVWXYZ]{5}$/.test(c)),
    'no vowels and no 0/O or 1/I — these get read off paper and typed back in');
  eq(normalizeRecoveryCode(' abcde-fghij '), 'ABCDEFGHIJ', 'case and the dash are presentation, not secret');
  eq(normalizeRecoveryCode('ABCDEFGHIJ'), 'ABCDEFGHIJ', 'and a code typed without the dash matches one with it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
