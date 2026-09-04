// Live contact sync, end to end (server/contactSources.js + server/contactsSync/*).
//
// Runs the real engine against test/mock-dav-server.js, over a throwaway
// DATA_DIR. The assertions that matter most are the destructive ones, because
// this is the layer where a bug does not show up as an error — it shows up as
// somebody's address book quietly emptying itself:
//
//   - a DELTA must never delete anything it did not explicitly mention;
//   - a FULL listing must delete what it did not mention;
//   - synced contacts must never be written into contacts.json, which is the
//     only copy of the hand-typed address book;
//   - deleting a source must take its mirror with it and nothing else;
//   - an edit must preserve every vCard property Hmelj does not model.
//
//   node test/contact-sync-test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';

// Before ANY import that reaches config.js — it resolves DATA_DIR once, at
// module evaluation. dotenv does not override an env var that is already set,
// so this wins over the project's own .env and nothing touches the real data.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-contact-sync-'));
process.env.DATA_DIR = TMP;
process.env.CACHE_DIR = TMP;
process.env.HMELJ_SECRET = 'test-secret-not-a-real-one';
process.env.LOG = process.env.LOG || 'warn';

const { startMockDav } = await import('./mock-dav-server.js');
const sources = await import('../server/contactSources.js');
const sync = await import('../server/contactsSync/index.js');
const { runAsUser } = await import('../server/session.js');
const { store } = await import('../server/store.js');
const { parseCard, serializeCard, applyContact, cardName } = await import('../server/vcard.js');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const USER = { id: 'u1', username: 'tester' };
const as = (fn) => runAsUser(USER, fn);
const uKey = (await import('../server/session.js')).userKey(USER.username);

const mock = await startMockDav(3600 + (process.pid % 300));

try {
  console.log('adding a source');
  let src = as(() => sources.saveSource({
    kind: 'carddav', label: 'Nextcloud', url: mock.url,
    username: mock.username, password: mock.password, direction: 'two-way',
  }));
  ok(!!src.id, 'it gets an id');
  ok(src.passwordSet === true && src.password === undefined,
    'the stored password is never handed back — only whether one is set');
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'users', uKey, 'contact-sources.json'), 'utf8'));
  ok(!onDisk[0].password.includes(mock.password),
    'and it is encrypted at rest, with the same key mailbox passwords use');

  console.log('discovery');
  const found = await as(() => sync.discoverFor(uKey, sources.rawSourceFor(uKey, src.id)));
  ok(found.collections.length === 2, 'both address books were found', String(found.collections.length));
  src = as(() => sources.saveSource({
    ...src,
    homeUrl: found.homeUrl,
    // Only the writable one is enabled, which is the ordinary case: a user
    // ticks the book they want and leaves the shared one alone.
    books: found.collections.map((c) => ({ ...c, enabled: c.displayName === 'Personal contacts' })),
  }, src.id));
  ok(src.books.length === 2 && src.books.filter((b) => b.enabled).length === 1, 'one enabled, one not');
  const bookId = src.books.find((b) => b.enabled).id;

  console.log('first sync');
  let r = await as(() => sync.syncSourceFor(uKey, src.id));
  let book = r.books.find((b) => b.bookId === bookId);
  ok(r.books.length === 1, 'only the enabled book is synced');
  ok(book.added === 3 && book.removed === 0, 'three contacts pulled', JSON.stringify(book));
  let rows = sources.allRowsFor(uKey);
  ok(rows.length === 3, 'and they are readable as contact rows');
  ok(rows.every((x) => x.synced === true && x.sourceId === src.id), 'each knows where it came from');
  ok(rows.some((x) => x.name === 'Ana Horvat' && x.email === 'ana@example.com'), 'with the right name and address');
  ok(rows.every((x) => x.readOnly === false), 'and is editable, since the book is writable and sync is two-way');

  console.log('synced contacts stay OUT of the hand-typed address book');
  ok(as(() => store.getContacts()).length === 0,
    'contacts.json is untouched — it is the only copy of what the user typed, and a sync bug must not be able to reach it');
  ok(fs.existsSync(path.join(TMP, 'users', uKey, 'addressbooks', src.id, bookId + '.json')),
    'the mirror lives in its own file, per source and per book');

  console.log('a quiet poll');
  r = await as(() => sync.syncSourceFor(uKey, src.id));
  ok(r.books[0].unchanged === true, 'an unchanged CTag means there is nothing to do');
  ok(sources.allRowsFor(uKey).length === 3, 'and nothing was disturbed');

  console.log('THE destructive case: a delta must not sweep');
  // One card changes. A delta mentions only that card. Anything that treated
  // "not in this answer" as "deleted" would drop the other two here.
  mock.mutate('/dav/books/default/a.vcf',
    'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:uid-a\r\nFN:Ana Novak\r\nEMAIL;TYPE=WORK:ana@example.com\r\nEND:VCARD\r\n');
  r = await as(() => sync.syncSourceFor(uKey, src.id));
  ok(r.books[0].updated === 1 && r.books[0].added === 0, 'one contact updated');
  ok(r.books[0].removed === 0, 'and NOTHING removed — the other two were simply not mentioned',
    JSON.stringify(r.books[0]));
  rows = sources.allRowsFor(uKey);
  ok(rows.length === 3, 'all three are still there', String(rows.length));
  ok(rows.some((x) => x.name === 'Ana Novak'), 'and the change landed');

  console.log('a real deletion');
  mock.remove('/dav/books/default/c.vcf');
  r = await as(() => sync.syncSourceFor(uKey, src.id));
  ok(r.books[0].removed === 1, 'reported by the server, so it is applied');
  ok(sources.allRowsFor(uKey).length === 2, 'and only that one went');

  console.log('a card with several addresses is several rows');
  mock.mutate('/dav/books/default/b.vcf', 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:uid-b\r\nFN:Bojan Kos\r\n'
    + 'EMAIL;TYPE=WORK;TYPE=PREF:bojan@acme.example\r\nEMAIL;TYPE=HOME:bojan@example.org\r\nEND:VCARD\r\n');
  await as(() => sync.syncSourceFor(uKey, src.id));
  rows = sources.allRowsFor(uKey);
  const bojan = rows.filter((x) => x.name === 'Bojan Kos');
  ok(bojan.length === 2, 'two addresses are two things you can write to', String(bojan.length));
  ok(bojan[0].email === 'bojan@acme.example', 'preferred first');
  ok(new Set(rows.map((x) => x.id)).size === rows.length, 'and every row id is distinct');

  console.log('writing back');
  const target = sources.resolveRowFor(uKey, bojan[0].id);
  ok(!!target, 'a row resolves back to the card it came from');
  ok(target.card.vcard.includes('EMAIL;TYPE=HOME'), 'and the card kept its raw vCard');
  const edited = serializeCard(applyContact(parseCard(target.card.vcard), { name: 'Bojan Kos ml.' }));
  await as(() => sync.updateCardFor(uKey, target.source, target.book, { url: target.card.url, href: target.card.href, etag: target.card.etag }, edited));
  rows = sources.allRowsFor(uKey);
  ok(rows.filter((x) => x.name === 'Bojan Kos ml.').length === 2,
    'the local mirror is updated immediately — not left to revert until the next poll');
  const server = await (await import('../server/dav/client.js')).createClient({
    auth: (await import('../server/dav/client.js')).basicAuth(mock.username, mock.password),
  }).get(mock.origin + '/dav/books/default/b.vcf');
  ok(cardName(parseCard(server.body)) === 'Bojan Kos ml.', 'and the server has it too');
  ok(server.body.includes('EMAIL;TYPE=HOME:bojan@example.org'),
    'with the second address intact — an edit replaces what Hmelj models and nothing else');

  console.log('a conflict is reported, never resolved by overwriting');
  mock.state.failNextPut = 1;
  let conflict = null;
  try {
    await as(() => sync.updateCardFor(uKey, target.source, target.book,
      { url: target.card.url, href: target.card.href, etag: '"stale"' }, edited));
  } catch (e) { conflict = e; }
  ok(conflict?.status === 412, 'a 412 comes back as a 412, not a retry without the condition', String(conflict?.status));

  console.log('one-way sync refuses to write');
  const pull = as(() => sources.saveSource({ ...src, direction: 'pull' }, src.id));
  const t2 = sources.resolveRowFor(uKey, sources.allRowsFor(uKey)[0].id);
  let refused = null;
  try { await as(() => sync.updateCardFor(uKey, t2.source, t2.book, { url: t2.card.url, href: t2.card.href }, edited)); }
  catch (e) { refused = e; }
  ok(/one-way/i.test(refused?.message || ''), 'and says why', refused?.message);
  ok(sources.allRowsFor(uKey).every((x) => x.readOnly === true), 'its rows read as read-only too');
  as(() => sources.saveSource({ ...pull, direction: 'two-way' }, src.id));

  console.log('an edit must not roll the sync position backwards');
  const beforeSave = sources.rawSourceFor(uKey, src.id).books.find((b) => b.id === bookId);
  as(() => sources.saveSource({
    ...src, label: 'Renamed',
    // A Settings page loaded ten minutes ago carries a stale ctag and token.
    books: src.books.map((b) => ({ ...b, ctag: 'ancient', syncToken: 'sync/0' })),
  }, src.id));
  const afterSave = sources.rawSourceFor(uKey, src.id).books.find((b) => b.id === bookId);
  ok(afterSave.ctag === beforeSave.ctag && afterSave.syncToken === beforeSave.syncToken,
    'sync state comes from the stored record only, never from the request',
    `${afterSave.ctag} / ${afterSave.syncToken}`);
  ok(afterSave.id === beforeSave.id, 'and the book keeps its id, so its stored file is still its own');

  console.log('deleting the source');
  const bookFile = path.join(TMP, 'users', uKey, 'addressbooks', src.id, bookId + '.json');
  as(() => sources.deleteSource(src.id));
  ok(sources.listSourcesFor(uKey).length === 0, 'the source is gone');
  ok(!fs.existsSync(bookFile), 'and so is its mirror — which is safe, because it was only ever a mirror');
  ok(sources.allRowsFor(uKey).length === 0, 'no rows left');
  ok(as(() => store.getContacts()).length === 0, 'and contacts.json was never involved at any point');

  console.log('bad input');
  let bad = null;
  try { as(() => sources.saveSource({ kind: 'nonsense', label: 'x' })); } catch (e) { bad = e; }
  ok(bad?.status === 400, 'an unknown source type is refused');
  bad = null;
  try { as(() => sources.saveSource({ kind: 'carddav', label: 'x' })); } catch (e) { bad = e; }
  ok(bad?.status === 400 && /server address/i.test(bad.message), 'a CardDAV source with no URL is refused');
  bad = null;
  try { sources.assertId('../../etc/passwd'); } catch (e) { bad = e; }
  ok(bad?.status === 400, 'and an id that is a path is rejected before it can build one');
  ok(sources.parseRowId('not-a-row-id') === null, 'a malformed row id resolves to nothing');
} finally {
  await mock.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
