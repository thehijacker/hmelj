// Hmelj — the display-name impersonation warning (public/js/app.js#authSpoofCheck).
//
// This is the one sender warning that cannot be answered by SPF, DKIM or DMARC:
// a message from a domain that genuinely authorised it, signed with the name of
// somebody in your address book. All three checks pass, correctly, and the
// message is still a forgery.
//
// Which is exactly why the false-positive direction is the dangerous one. The
// banner is red and says "treat this as untrusted"; showing it on the user's own
// reply — the first thing that actually happened — teaches them to ignore it, and
// then it is worth nothing on the day it is right.
//
// app.js is a classic script, so it is evaluated in a vm and its top-level
// bindings are handed out by a line appended inside its own script scope. Same
// trick, same stub philosophy, as test/select-range-test.mjs.
//
//   node test/spoof-check-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const noop = () => {};
const el = () => new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : (t[k] = ['style', 'dataset', 'classList'].includes(k) ? el() : noop)),
  set: (t, k, v) => ((t[k] = v), true),
});
const ctx = {
  console: { ...console, debug: noop },
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  addEventListener: noop, removeEventListener: noop, requestAnimationFrame: noop,
  fetch: () => Promise.reject(new Error('offline in test')),
  location: { pathname: '/', hash: '', href: '/', replace: noop },
  navigator: { serviceWorker: new Proxy({}, { get: () => noop }), userAgent: 'test' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  innerWidth: 1200, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
  CSS: { highlights: undefined, escape: (s) => s },
  URLSearchParams, URL, Blob: function () {}, FileReader: function () {}, Image: function () {},
  Notification: undefined, EventSource: function () { return new Proxy({}, { get: () => noop }); },
};
ctx.window = ctx;
ctx.self = ctx;
ctx.document = {
  getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
  createElement: () => el(), createTreeWalker: () => ({ nextNode: () => null }),
  addEventListener: noop, body: el(), documentElement: el(), head: el(), readyState: 'complete',
};
vm.createContext(ctx);

for (const f of ['i18n.js', 'connection.js', 'api.js', 'dialog.js', 'app.js']) {
  let src = fs.readFileSync(path.join(root, 'public/js', f), 'utf8');
  if (f === 'app.js') src += '\n;globalThis.__t = { state, authSpoofCheck };';
  try { vm.runInContext(src, ctx, { filename: f }); }
  catch (e) { if (f === 'app.js') throw e; }
}

const { state, authSpoofCheck } = ctx.__t;
ok(typeof authSpoofCheck === 'function', 'authSpoofCheck is reachable at app.js top level');

/** The address book, the user's own identities, and their accounts. */
function world({ contacts = [], identities = [], accounts = [] } = {}) {
  state.contacts = contacts;
  state.identities = identities;
  state.accounts = accounts;
}
const from = (name, address) => ({ name, address });

const ANA_WORK = { name: 'Ana Novak', email: 'ana@example.com' };
const ANA_HOME = { name: 'Ana Novak', email: 'ana.novak@gmail.com' };

console.log('\nthe attack it exists for');
{
  world({ contacts: [ANA_WORK] });
  const hit = authSpoofCheck(from('Ana Novak', 'ceo@totally-real-invoices.com'));
  ok(hit === 'ana@example.com',
    'a known name over an unknown address is flagged, and names the address you know', String(hit));
  ok(authSpoofCheck(from('ANA  NOVAK', 'ceo@totally-real-invoices.com')) === 'ana@example.com',
    'case and doubled spaces do not get past it');
}

console.log('\nthe false positive that was reported: your own mail');
{
  // Reported on a reply the user sent themselves: "You know this name as
  // andrej.kralj@litija.com — this message came from somewhere else."
  // The address book knew the name at a DIFFERENT one of their own addresses.
  world({
    contacts: [{ name: 'Andrej Kralj', email: 'andrej.kralj@litija.com' }],
    identities: [{ email: 'andrej@work.example' }],
    accounts: [{ email: 'andrej@work.example' }],
  });
  ok(authSpoofCheck(from('Andrej Kralj', 'andrej@work.example')) === null,
    'a message from one of your OWN identities is never called an impersonation');

  world({
    contacts: [{ name: 'Andrej Kralj', email: 'andrej.kralj@litija.com' }],
    identities: [],
    accounts: [{ email: 'ANDREJ@Work.Example' }],
  });
  ok(authSpoofCheck(from('Andrej Kralj', 'andrej@work.example')) === null,
    'and an account address matches regardless of case');
}

console.log('\nthe other false positive: a contact with two addresses');
{
  // A contact ROW is one name + one address (server/contacts.js), so a person
  // with two addresses is two rows. Stopping at the first row that mismatches
  // accuses somebody entirely legitimate.
  world({ contacts: [ANA_WORK, ANA_HOME] });
  ok(authSpoofCheck(from('Ana Novak', 'ana.novak@gmail.com')) === null,
    'the SECOND address the address book has for a name is not a spoof');
  ok(authSpoofCheck(from('Ana Novak', 'ana@example.com')) === null, 'nor is the first');
  ok(authSpoofCheck(from('Ana Novak', 'ana@elsewhere.invalid')) !== null,
    'while a third, unknown address still is');

  world({ contacts: [ANA_HOME, ANA_WORK] });
  ok(authSpoofCheck(from('Ana Novak', 'ana@example.com')) === null,
    'and the row order does not decide it');
}

console.log('\nwhat it stays quiet about');
for (const [why, f, w] of [
  ['no display name at all', from('', 'ana@example.com'), { contacts: [ANA_WORK] }],
  ['a display name that is just the address', from('ana@example.com', 'ana@example.com'), { contacts: [ANA_WORK] }],
  ['a name too short to mean anything', from('Ana', 'x@y.invalid'), { contacts: [{ name: 'Ana', email: 'ana@example.com' }] }],
  ['a name nobody in the address book has', from('Somebody Else', 'x@y.invalid'), { contacts: [ANA_WORK] }],
  ['an empty address book', from('Ana Novak', 'x@y.invalid'), {}],
  ['a contact row with no address', from('Ana Novak', 'x@y.invalid'), { contacts: [{ name: 'Ana Novak', email: '' }] }],
]) {
  world(w);
  ok(authSpoofCheck(f) === null, why, String(authSpoofCheck(f)));
}

console.log('\nit never throws on a half-built message');
for (const [why, f] of [
  ['no address', from('Ana Novak', undefined)],
  ['nothing at all', {}],
]) {
  world({ contacts: [ANA_WORK, { name: null, email: null }, {}] });
  let threw = null;
  try { authSpoofCheck(f); } catch (e) { threw = e; }
  ok(!threw, why, threw?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
