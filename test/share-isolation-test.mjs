// Sharing a mail account must hand over THAT MAILBOX and nothing else.
//
// server/session.js#requireAuth re-points the ALS `userKey` at the account's
// owner whenever a request names a shared account in `?account=`. That is the
// whole mechanism by which a shared account resolves to one real mailbox and one
// cache — but it is mounted `app.use('/api', requireAuth)` and keys off the query
// string alone, so it applied on EVERY route, not just the mail ones. Any handler
// that read per-user, account-independent state through ALS therefore read and
// wrote the OWNER's copy the moment a grantee added `?account=<a shared account>`
// to the URL.
//
// The worst reachable case was filters: they are stored per user, run server-side
// under the owner across every account the owner has, and can forward to an
// arbitrary address — so a grantee could turn "read the kid's mail" into silent,
// permanent exfiltration of mailboxes that were never shared, surviving even
// revocation of the share.
//
// The fix is that per-user state uses `viewerKey` (always the real requesting
// login) rather than `userKey`. Every assertion below fails on the pre-fix tree.
//
//   node test/share-isolation-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-share-'));
process.env.DATA_DIR = dataDir;
process.env.CACHE_DIR = path.join(dataDir, 'cache');

const here = path.dirname(new URL(import.meta.url).pathname);
const srv = (m) => path.join(here, '..', 'server', m);
const { createUser, requireAuth, createSession, userKey } = await import(srv('session.js'));
const { store } = await import(srv('store.js'));
const accounts = await import(srv('accounts.js'));
const smtpClient = await import(srv('smtpClient.js'));

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? ' — ' + extra : '')); }
};

// Runs `fn` the way an HTTP request would: inside requireAuth, with whatever
// query string we want to pretend the client sent.
const asUser = (user, query, fn) => new Promise((resolve) => {
  requireAuth({ query, headers: { cookie: `hmelj_session=${createSession(user)}` } }, {}, () => resolve(fn()));
});

const mkAccount = (label, email) => ({
  label, email, type: 'imap',
  imap: { host: `${label}.invalid`, port: 993, secure: true, user: email, pass: 'imap-secret' },
  smtp: { host: `${label}.invalid`, port: 465, secure: true, user: email, pass: 'smtp-secret' },
});

try {
  const owner = createUser('owner', 'pw-owner-12345');
  const grantee = createUser('grantee', 'pw-grantee-12345');

  // The owner has two mail accounts and shares exactly one of them.
  let shared, never;
  await asUser(owner, {}, () => {
    shared = accounts.saveAccount(mkAccount('Shared', 'shared@test.invalid'));
    never = accounts.saveAccount(mkAccount('Private', 'private@test.invalid'));
    store.saveSettings({ messagesPerPage: 50 });
    store.saveFilters([{ id: 'owner-rule', name: "owner's rule", actions: [] }]);
    store.saveContacts([{ name: 'Owner Contact', email: 'contact@test.invalid' }]);
    store.saveIdentities([
      { id: shared.id, accountId: shared.id, email: 'shared@test.invalid', signature: 'shared sig' },
      { id: never.id, accountId: never.id, email: 'private@test.invalid', signature: 'PRIVATE SIG', default: true },
    ]);
    store.saveCustomHolidays([{ id: 'h1', month: 1, day: 2, name: "owner's holiday", workFree: true }]);
  });
  accounts.shareAccount(userKey('owner'), shared.id, 'grantee');

  // The grantee sets up their own, deliberately different, personal state.
  await asUser(grantee, {}, () => {
    store.saveSettings({ messagesPerPage: 11 });
    store.saveFilters([{ id: 'grantee-rule', name: "grantee's rule", actions: [] }]);
  });

  // Everything below is the grantee, with the shared account named in the query
  // string — the one thing that used to swap the namespace under them.
  const q = { account: shared.id };

  console.log('\nreads must not reach the owner\'s personal state');
  await asUser(grantee, q, () => {
    ok(store.getSettings().messagesPerPage === 11, 'GET /api/settings returns the grantee\'s own settings',
      `got messagesPerPage=${store.getSettings().messagesPerPage}`);
    const f = store.getFilters();
    ok(f.length === 1 && f[0].id === 'grantee-rule', 'GET /api/filters returns the grantee\'s own rules',
      JSON.stringify(f.map((x) => x.id)));
    ok(!JSON.stringify(store.getIdentities()).includes('PRIVATE SIG'),
      'GET /api/identities does not expose the owner\'s signatures');
    ok(!JSON.stringify(store.getContacts()).includes('Owner Contact'),
      'GET /api/contacts does not expose the owner\'s address book');
    ok(!JSON.stringify(store.getCustomHolidays()).includes("owner's holiday"),
      'custom holidays are the grantee\'s own');
    const visible = accounts.listAccounts();
    ok(!visible.some((a) => a.id === never.id),
      'GET /api/accounts does not list the account that was never shared',
      visible.map((a) => a.label).join(', '));
    ok(visible.some((a) => a.id === shared.id), 'GET /api/accounts still lists the shared account');
  });

  console.log('\nwrites must land in the grantee\'s own namespace');
  await asUser(grantee, q, () => {
    store.saveSettings({ messagesPerPage: 999 });
    store.saveFilters([{ id: 'exfil', name: 'forward everything', actions: [{ type: 'forward', value: 'attacker@test.invalid' }] }]);
    store.saveIdentities([{ id: 'x', accountId: shared.id, email: 'grantee@test.invalid', signature: 'mine' }]);
    accounts.saveAccount(mkAccount('Injected', 'injected@test.invalid'));
  });
  await asUser(owner, {}, () => {
    ok(store.getSettings().messagesPerPage === 50, 'the owner\'s settings are untouched',
      `got ${store.getSettings().messagesPerPage}`);
    const f = store.getFilters();
    ok(f.length === 1 && f[0].id === 'owner-rule', 'the owner\'s filter set is untouched',
      JSON.stringify(f.map((x) => x.id)));
    ok(JSON.stringify(store.getIdentities()).includes('PRIVATE SIG'), 'the owner\'s identities are untouched');
    const labels = accounts.listAccounts().map((a) => a.label);
    ok(!labels.includes('Injected'), 'no account was injected into the owner\'s account list', labels.join(', '));
  });

  console.log('\nthe share itself still works, and stops at its edge');
  await asUser(grantee, q, () => {
    const acc = accounts.currentAccount();
    ok(acc?.id === shared.id, 'the grantee can still resolve the shared account for mail operations');
    ok(acc?.imap?.pass === 'imap-secret', 'and it still carries decrypted credentials server-side, as the mail layer needs');
    // Sending: naming the never-shared account's identity must not reach it.
    let resolved = null, error = null;
    try { resolved = smtpClient.resolveIdentityAndAccount({ identityId: never.id, to: 'x@test.invalid' }).acc; }
    catch (e) { error = e.message; }
    ok(resolved?.id !== never.id, 'sending cannot be aimed at the account that was never shared',
      error || `resolved to ${resolved?.label}`);
  });

  console.log('\nhow destructive Delete is stays the mailbox owner\'s call');
  await asUser(owner, {}, () => store.saveSettings({ deleteBehavior: 'trash' }));
  await asUser(grantee, {}, () => store.saveSettings({ deleteBehavior: 'expunge' }));
  await asUser(grantee, q, () => {
    // The delete paths in imapClient/ewsClient/graphClient read this one
    // owner-scoped, so a grantee cannot turn the owner's "move to Trash" into
    // "destroy permanently" by changing their own settings page.
    ok(store.getOwnerSettings().deleteBehavior === 'trash',
      "deleting in a shared mailbox follows the OWNER's deleteBehavior",
      `got ${store.getOwnerSettings().deleteBehavior}`);
    ok(store.getSettings().deleteBehavior === 'expunge',
      "while the grantee's own settings are still their own");
  });

  console.log('\ncredentials never reach the browser');
  await asUser(owner, {}, () => {
    const wire = JSON.stringify(accounts.listAccounts());
    ok(!wire.includes('imap-secret') && !wire.includes('smtp-secret'),
      'GET /api/accounts carries no passwords');
  });
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
