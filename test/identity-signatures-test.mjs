// Several signatures per identity (server/store.js#normalizeIdentities).
//
// An identity used to carry one `signature` string; it now carries
// `signatures: [{id, name, html}]` and a `defaultSignatureId`. This function is
// where the old shape becomes the new one, on every read and every write.
//
// THE ASSERTION THAT MATTERS MOST is the last group: everything that is not a
// signature must come through untouched. Unlike normalizeSavedSearches, which
// owns its whole record, this one stands between the user and their entire
// identity list — name, address, reply-to, which account sends, which identity
// is the default. A normalizer that quietly dropped one of those would cost
// somebody their sending setup, and nothing else in the app would notice.
//
//   node test/identity-signatures-test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-idsig-'));
process.env.DATA_DIR = tmp;
process.env.HMELJ_SECRET = 'test-secret-not-a-real-one';

const { normalizeIdentities } = await import('../server/store.js');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
const eq = (got, want, m) => ok(got === want, m, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const one = (input) => normalizeIdentities([input])[0];

console.log('the old single signature migrates');
{
  const id = one({ id: 'a', email: 'me@x.si', signature: '<p>Lep pozdrav</p>' });
  eq(id.signatures.length, 1, 'a legacy string becomes exactly one signature');
  eq(id.signatures[0].html, '<p>Lep pozdrav</p>', 'its text is carried over verbatim');
  eq(id.signatures[0].name, 'Signature', 'and it gets a name to be picked by');
  eq(id.defaultSignatureId, id.signatures[0].id, 'which is also the default');
}
// Every identity the server has ever seeded carries signature:''. Turning each
// of those into an entry would hand every user a picker full of blank sign-offs
// on first load.
{
  const id = one({ id: 'a', email: 'me@x.si', signature: '' });
  eq(id.signatures.length, 0, 'an EMPTY legacy signature becomes no signatures at all');
  eq(id.defaultSignatureId, null, 'and there is no default to point at');
}
eq(one({ signature: '   ' }).signatures.length, 0, 'whitespace counts as empty');

console.log('\nthe new shape is kept, and repaired');
{
  const id = one({
    signatures: [{ id: 's1', name: 'Work', html: '<b>A</b>' }, { id: 's2', name: 'Short', html: 'B' }],
    defaultSignatureId: 's2',
  });
  eq(id.signatures.length, 2, 'both are kept');
  eq(id.defaultSignatureId, 's2', 'a default that exists is left alone');
}
eq(one({ signatures: [{ id: 's1', html: 'A' }], defaultSignatureId: 'gone' }).defaultSignatureId, 's1',
  'a default pointing at a signature that no longer exists falls back to the first');
eq(one({ signatures: [{ id: 's1', html: 'A' }] }).defaultSignatureId, 's1', 'a missing default is filled in');
eq(one({ signatures: [{ id: 's1', html: 'A' }] }).signatures[0].name, 'Signature 1',
  'an unnamed signature gets a numbered name rather than an empty menu row');
eq(one({ signatures: [{ name: 'Work', html: 'A' }] }).signatures[0].id.length > 0, true, 'a missing id is filled in');
eq(one({ signatures: [{ name: 'Empty', html: '  ' }] }).signatures.length, 0,
  'a named but empty signature is dropped — the name labels the text, it is not a thing on its own');
eq(one({ signatures: Array.from({ length: 40 }, (_, i) => ({ html: `s${i}` })) }).signatures.length, 20,
  'the list is capped');

// Once the new shape exists it is the truth. A leftover `signature` field beside
// it is what an older client would have written; re-migrating it would put a
// deleted sign-off back every time the identity was saved.
eq(one({ signature: 'old', signatures: [{ id: 's1', html: 'new' }] }).signatures.length, 1,
  'a legacy string is NOT re-migrated once a real list exists');
eq(one({ signature: 'old', signatures: [{ id: 's1', html: 'new' }] }).signatures[0].html, 'new',
  'and the real list is what survives');

console.log('\nrun twice, same answer');
{
  const first = normalizeIdentities([{ id: 'a', signature: '<p>x</p>' }]);
  const second = normalizeIdentities(first);
  eq(JSON.stringify(second), JSON.stringify(first),
    'idempotent — it runs on every read AND every write, so it must be');
}

console.log('\njunk in, no crash');
eq(normalizeIdentities(null).length, 0, 'a non-array is an empty list');
eq(normalizeIdentities([null, 0, 'nope']).length, 0, 'junk entries are dropped');
eq(one({ signatures: 'not an array' }).signatures.length, 0, 'so is a signatures field that is not a list');
eq(one({ signatures: [null, 0] }).signatures.length, 0, 'and junk inside one');

console.log('\nEVERYTHING ELSE ABOUT AN IDENTITY SURVIVES UNTOUCHED');
{
  const full = {
    id: 'ident-1', name: 'Andrej', email: 'me@firma.si', organization: 'Firma d.o.o.',
    replyTo: 'office@firma.si', accountId: 'acc-7', default: true,
    signatureOn: 'always', signatureDelimiter: false,
    somethingAddedLater: { deep: ['value'] },
    signature: '<p>Lep pozdrav</p>',
  };
  const out = one(full);
  for (const k of ['id', 'name', 'email', 'organization', 'replyTo', 'accountId', 'signatureOn']) {
    eq(out[k], full[k], `${k} is untouched`);
  }
  eq(out.default, true, 'the default-identity flag is untouched');
  eq(out.signatureDelimiter, false, 'and so is the delimiter opt-out');
  eq(JSON.stringify(out.somethingAddedLater), JSON.stringify(full.somethingAddedLater),
    'a field this function has never heard of passes straight through');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
