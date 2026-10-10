// Catch-all identities (server/catchAll.js, public/js/fromAddress.js).
//
// Two promises are pinned here. The first is the one the feature exists for:
// a reply goes out from the address the message was sent to. The second
// matters more — that NOTHING changes for anyone who has not set a catch-all
// domain, and that with one set the server still refuses every address that is
// not at exactly that domain.
//
//   node test/catch-all-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-ca-'));
process.env.CACHE_DIR = dir; process.env.DATA_DIR = dir;
const ca = await import(new URL('../server/catchAll.js', import.meta.url).href);
const { normalizeIdentities } = await import(new URL('../server/store.js', import.meta.url).href);
const cache = await import(new URL('../server/cache.js', import.meta.url).href);
new Function(fs.readFileSync(new URL('../public/js/fromAddress.js', import.meta.url), 'utf8'))();
const FA = globalThis.FromAddress;

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m, `got ${JSON.stringify(a)}`);
const throws = (fn) => { try { fn(); return false; } catch (e) { return e.status === 400; } };

const IMAP = { id: 'acc-1', type: 'imap', email: 'me@example.com' };
const EWS = { id: 'acc-2', type: 'ews', email: 'me@firma.si' };
const GRAPH = { id: 'acc-3', type: 'graph', email: 'me@outlook.com' };
const plain = { id: 'i-plain', accountId: 'acc-1', name: 'Me', email: 'me@example.com', default: true };
const wild = { ...plain, catchAllDomain: 'example.com' };

console.log('the domain');
eq(ca.normalizeDomain(' @Example.COM '), 'example.com', 'trimmed, lower-cased, a leading @ dropped');
for (const bad of ['', 'example', 'exa mple.com', 'a@b.com', '*.example.com', 'example.com, other.com', '-x.com', null])
  eq(ca.normalizeDomain(bad), '', `not a domain: ${JSON.stringify(bad)}`);
eq(normalizeIdentities([{ ...plain }])[0].catchAllDomain, undefined, 'an identity that never had the field is not given one');
eq(normalizeIdentities([{ ...plain, catchAllDomain: '@Example.com' }])[0].catchAllDomain, 'example.com', 'a stored one is normalised');
eq(normalizeIdentities([{ ...plain, catchAllDomain: 'nonsense' }])[0].catchAllDomain, '', 'and one that is not a domain becomes "none"');

console.log('\nwhat may be sent from');
eq(ca.effectiveFrom(plain, IMAP, 'shop@example.com'), 'me@example.com', 'NO catch-all domain: the request is ignored, the identity\'s own address goes out');
eq(ca.effectiveFrom(plain, IMAP, undefined), 'me@example.com', 'and with no request at all it is simply the identity\'s address');
eq(ca.effectiveFrom(wild, IMAP, 'shop@example.com'), 'shop@example.com', 'catch-all set: an address at the domain is used');
eq(ca.effectiveFrom(wild, IMAP, 'Shop@EXAMPLE.com'), 'Shop@EXAMPLE.com', 'the domain is matched without regard to case');
eq(ca.effectiveFrom(wild, IMAP, undefined), 'me@example.com', 'nothing asked for: the identity\'s own');
for (const bad of ['shop@other.com', 'shop@mail.example.com', 'shop@example.com.evil.org', 'a b@example.com', '"x" <shop@example.com>',
  'shop@example.com, x@example.com', 'shop@example.com\nBcc: x@y.com', '@example.com', '.shop@example.com', 'sh..op@example.com'])
  eq(ca.effectiveFrom(wild, IMAP, bad), 'me@example.com', `refused, falls back: ${JSON.stringify(bad)}`);
eq(ca.effectiveFrom({ ...wild, accountId: 'acc-2' }, EWS, 'shop@example.com'), 'me@example.com', 'never on an Exchange account');
eq(ca.effectiveFrom({ ...wild, accountId: 'acc-3' }, GRAPH, 'shop@example.com'), 'me@example.com', 'nor on Microsoft 365');
ok(!throws(() => ca.assertFrom(plain, IMAP, undefined)), 'assertFrom: no address asked for is always fine');
ok(!throws(() => ca.assertFrom(wild, IMAP, 'shop@example.com')), 'an allowed one passes');
ok(throws(() => ca.assertFrom(plain, IMAP, 'shop@example.com')), 'an identity without a catch-all refuses out loud (400)');
ok(throws(() => ca.assertFrom(wild, IMAP, 'shop@other.com')), 'another domain is refused');
ok(throws(() => ca.assertFrom(wild, EWS, 'shop@example.com')), 'an Exchange account is refused');

console.log('\nwho a reply is written as');
const alias = { id: 'i-alias', accountId: 'acc-1', name: 'Shop', email: 'shop@example.com' };
const other = { id: 'i-other', accountId: 'acc-9', name: 'Else', email: 'x@example.com', catchAllDomain: 'example.com' };
const pick = (identities, addresses, accountId = 'acc-1') => FA.pickForMessage({ identities, accounts: [IMAP, EWS, GRAPH], accountId, addresses });
eq(pick([plain], [{ address: 'someone@else.org' }]), { identityId: 'i-plain' }, 'no match at all: the account\'s usual identity, as before');
eq(pick([plain], [{ address: 'shop@example.com' }]), { identityId: 'i-plain' }, 'no catch-all set: an unknown address at your domain changes nothing');
eq(pick([plain, alias], [{ address: 'Shop@Example.com' }]), { identityId: 'i-alias' }, 'an identity with exactly that address is used (step 1)');
eq(pick([wild], [{ address: 'news@example.com' }]), { identityId: 'i-plain', fromAddress: 'news@example.com' }, 'a catch-all identity sends as the address it was sent to (step 2)');
eq(pick([wild, alias], [{ address: 'shop@example.com' }]), { identityId: 'i-alias' }, 'an exact identity wins over the catch-all');
eq(pick([wild, alias], [{ address: 'a@else.org' }, { address: 'news@example.com' }, { address: 'shop@example.com' }]), { identityId: 'i-alias' }, 'and wins even when the catch-all address comes first in To');
eq(pick([plain, other], [{ address: 'news@example.com' }]), { identityId: 'i-plain' }, 'another account\'s catch-all is not used for this account\'s mail');
eq(pick([{ ...wild, accountId: 'acc-2' }], [{ address: 'news@example.com' }], 'acc-2'), { identityId: 'i-plain' }, 'a catch-all on an Exchange account is ignored');
eq(pick([plain], [], null), { identityId: null }, 'no account known: nothing chosen, the composer\'s own default applies');

console.log('\nis this address mine');
ok(FA.isOwn('me@example.com', [plain], [IMAP]), 'your own address');
ok(!FA.isOwn('news@example.com', [plain], [IMAP]), 'without a catch-all, another address at your domain is not');
ok(FA.isOwn('news@example.com', [wild], [IMAP]), 'with one, it is');
ok(!FA.isOwn('news@other.com', [wild], [IMAP]), 'another domain never is');
const mine = new ca.OwnAddresses(['Me@Example.com'], ['example.com']);
ok(mine.has('me@example.com') && mine.has('ANY@example.com') && !mine.has('x@other.com'), 'the server\'s set answers the same way');
eq([...mine], ['me@example.com'], 'and iterating it still gives only the exact addresses');
ok(!new ca.OwnAddresses(['me@example.com']).has('news@example.com'), 'with no domains it is a plain set');
eq(ca.domainsOf([plain, wild, other, { catchAllDomain: 'bad' }]), ['example.com'], 'the domains of a list of identities, once each');

console.log('\na follow-up does not mistake your own alias for a reply');
{
  const U = 'u-1', A = 'acc-1', T = 'thread-1', SENT = Date.parse('2026-10-01T09:00:00Z');
  let uid = 0;
  const row = (from, date) => cache.upsertMessages(U, A, 'INBOX', null, [{
    uid: ++uid, subject: 's', from: { name: '', address: from }, to: [], date: new Date(date).toISOString(), size: 1,
    seen: false, flagged: false, deleted: false, draft: false, hasAttachment: false, messageId: `m${uid}@x`, threadKey: T,
  }]);
  row('Shop@Example.com', SENT + 3600e3); // a copy of my own message, sent as an alias
  const opts = { ownAddresses: ['me@example.com'], excludeFolders: [] };
  ok(cache.hasReplyInThread(U, A, T, SENT, opts), 'without the domain, my alias looks like somebody answering (the old behaviour, unchanged)');
  ok(!cache.hasReplyInThread(U, A, T, SENT, { ...opts, ownDomains: ['example.com'] }), 'with it, it does not');
  row('ana@firma.si', SENT + 7200e3);
  ok(cache.hasReplyInThread(U, A, T, SENT, { ...opts, ownDomains: ['example.com'] }), 'and a real reply still counts');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
