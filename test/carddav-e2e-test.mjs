// Discovery and incremental sync, end to end (server/dav/{client,discover,sync}.js).
//
// Driven against test/mock-dav-server.js, which is awkward in the specific ways
// real servers are — a `.well-known` redirect that must keep its method, an
// unexpected namespace prefix, path-only hrefs, a read-only collection, a task
// list that is not a calendar, and both sync mechanisms.
//
// The assertions worth reading twice are the ones about what happens when a
// sync token EXPIRES, and about a collection whose CTag has not moved: the
// first is how a DAV client silently stops syncing days after setup, the second
// is the entire reason polling a dozen collections every five minutes is cheap.
//
//   node test/carddav-e2e-test.mjs
import { startMockDav } from './mock-dav-server.js';
import { createClient, basicAuth, DavError } from '../server/dav/client.js';
import { discover } from '../server/dav/discover.js';
import { syncCollection, fetchItems, fetchAll } from '../server/dav/sync.js';
import { parseCard, cardName, cardUid } from '../server/vcard.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const mock = await startMockDav(3079 + (process.pid % 500));
const client = createClient({ auth: basicAuth(mock.username, mock.password), timeoutMs: 5000 });

try {
  console.log('credentials');
  const bad = createClient({ auth: basicAuth(mock.username, 'wrong'), timeoutMs: 5000 });
  let err = null;
  try { await bad.propfind(mock.url, '<displayname/>', 0); } catch (e) { err = e; }
  ok(err instanceof DavError && err.status === 401, 'a wrong password is a 401 DavError', String(err?.status));
  ok(/app-specific password/i.test(err.message),
    'and the message names the actual likely cause rather than "request failed"');

  console.log('discovery — address books');
  const books = await discover(client, { url: mock.url, kind: 'carddav' });
  ok(books.principalUrl.endsWith('/dav/principals/andrej/'), 'the principal was found', books.principalUrl);
  ok(books.homeUrl.endsWith('/dav/books/'), 'and the address-book home set', books.homeUrl);
  ok(books.via === 'url',
    'via the URL that was typed, NOT .well-known — which on this server points at a different application',
    books.via);
  ok(books.collections.length === 2, 'two address books', String(books.collections.length));
  const personal = books.collections.find((c) => c.displayName === 'Personal contacts');
  const team = books.collections.find((c) => c.displayName === 'Team (read-only)');
  ok(!!personal && !!team, 'both are named from their displayname');
  ok(personal.readOnly === false, 'one the account may write to');
  ok(team.readOnly === true, 'and one it may not — read from the server, never guessed');
  ok(!!personal.ctag && personal.syncToken.startsWith('sync/'), 'with both incremental-sync handles',
    `${personal.ctag} / ${personal.syncToken}`);
  ok(personal.url.startsWith('http://127.0.0.1'), 'the collection URL is absolute', personal.url);
  ok(personal.href === '/dav/books/default/', 'and the raw href is kept as sent');

  console.log('discovery — calendars');
  const cals = await discover(client, { url: mock.url, kind: 'caldav' });
  ok(cals.homeUrl.endsWith('/dav/cals/'), 'the calendar home set is a different one');
  // The mock also publishes a VTODO-only collection. It is a calendar
  // collection by resourcetype and a task list by every other measure, and
  // listing it would give the user a calendar that is permanently empty.
  ok(cals.collections.length === 1, 'a VTODO-only collection is not offered as a calendar',
    cals.collections.map((c) => c.displayName).join(','));
  ok(cals.collections[0].color === '#e37400', 'Apple\'s #RRGGBBAA colour is read and the alpha dropped',
    cals.collections[0].color);
  ok(cals.collections[0].readOnly === false, 'write-content alone counts as writable');

  console.log('discovery — a collection URL pasted directly');
  const direct = await discover(client, { url: personal.url, kind: 'carddav' });
  ok(direct.collections.length === 1 && direct.collections[0].href === '/dav/books/default/',
    'pasting the collection itself short-circuits the whole chain');

  console.log('first sync — sync-collection');
  let s = await syncCollection(client, { url: personal.url, kind: 'carddav' });
  ok(s.method === 'sync-collection', 'the better mechanism is used when the server has it', s.method);
  ok(s.full === true, 'an initial run is the full truth, not a delta');
  ok(s.changed.length === 3, 'all three cards', String(s.changed.length));
  ok(!!s.syncToken, 'and a token to continue from');

  const first = await fetchItems(client, personal.url, 'carddav', s.changed.map((c) => c.href));
  ok(first.items.length === 3 && first.failed === 0, 'their bodies come back in one multiget');
  const ana = first.items.find((i) => i.href.endsWith('a.vcf'));
  ok(cardName(parseCard(ana.data)) === 'Ana Horvat' && cardUid(parseCard(ana.data)) === 'uid-a',
    'and parse as real vCards');
  ok(ana.etag === '"a-1"', 'each carries its ETag, which is what every later write is conditional on');

  console.log('a poll that found nothing');
  const before = mock.state.requests.length;
  let quiet = await syncCollection(client, { url: personal.url, kind: 'carddav', syncToken: s.syncToken, ctag: s.ctag });
  ok(quiet.unchanged === true && quiet.method === 'ctag', 'an unchanged CTag ends the poll immediately', quiet.method);
  ok(mock.state.requests.length - before === 1,
    'in exactly ONE request — this is what makes a five-minute poll over a dozen collections cheap',
    String(mock.state.requests.length - before));

  console.log('somebody else changed something');
  mock.mutate('/dav/books/default/a.vcf', 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:uid-a\r\nFN:Ana Novak\r\nEMAIL:ana@example.com\r\nEND:VCARD\r\n');
  mock.remove('/dav/books/default/c.vcf');
  let d = await syncCollection(client, { url: personal.url, kind: 'carddav', syncToken: s.syncToken, ctag: s.ctag });
  ok(d.method === 'sync-collection' && d.full === false, 'the next run is a real delta');
  ok(d.changed.length === 1 && d.changed[0].href.endsWith('a.vcf'), 'one changed card, not all three',
    d.changed.map((c) => c.href).join(','));
  ok(d.removed.length === 1 && d.removed[0].endsWith('c.vcf'),
    'and the DELETION — the one thing no other mechanism reports', d.removed.join(','));

  console.log('the token expires (the failure that silently stops a client forever)');
  mock.state.expireToken = 1;
  const after = await syncCollection(client, { url: personal.url, kind: 'carddav', syncToken: d.syncToken, ctag: 'stale' });
  ok(after.full === true, 'an expired token means "start over", not "give up"');
  ok(after.changed.length === 2, 'and the whole collection comes back', String(after.changed.length));
  ok(!!after.syncToken, 'with a token to continue from');
  // Not "a DIFFERENT token" — nothing changed between the expiry and the
  // re-read, so the server is entitled to hand back the same value. What has to
  // hold is that it WORKS, which only a subsequent delta can show.
  mock.mutate('/dav/books/default/a.vcf', 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:uid-a\r\nFN:Ana Tretja\r\nEMAIL:ana@example.com\r\nEND:VCARD\r\n');
  const resumed = await syncCollection(client, { url: personal.url, kind: 'carddav', syncToken: after.syncToken, ctag: after.ctag });
  ok(resumed.method === 'sync-collection' && resumed.full === false && resumed.changed.length === 1,
    'and the very next poll is incremental again — the client recovered completely',
    `${resumed.method}/${resumed.changed.length}`);

  console.log('a server with no sync-collection at all');
  mock.state.syncCollection = false;
  // A baseline first: the ETag path can only report what changed relative to
  // what the caller holds, so it needs a current snapshot to compare against.
  const baseline = await syncCollection(client, { url: personal.url, kind: 'carddav', ctag: 'stale' });
  // `full: false`, deliberately, even though this read the whole collection.
  // `full` means "`changed` is every item that exists, so anything absent from
  // it is deleted" — and here `changed` holds only what DIFFERS from `known`
  // while `removed` is computed directly. A caller that swept on this would
  // delete every unchanged contact in the book.
  ok(baseline.method === 'etag-diff', 'a first ETag-diff run reads the whole collection', baseline.method);
  ok(baseline.full === false,
    'but never claims `full` — it reports deletions itself, so `changed` is a diff and not a census');
  ok(baseline.changed.length === 2 && baseline.removed.length === 0,
    'with nothing known yet, everything reads as changed', String(baseline.changed.length));
  const known = new Map(baseline.changed.map((c) => [c.href, c.etag]));
  let e = await syncCollection(client, { url: personal.url, kind: 'carddav', known, ctag: 'stale' });
  ok(e.method === 'etag-diff', 'falls back to comparing ETags', e.method);
  ok(e.changed.length === 0 && e.removed.length === 0, 'and sees no change when there is none');
  mock.mutate('/dav/books/default/b.vcf', 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:uid-b\r\nFN:Bojan Kos ml.\r\nEMAIL:bojan@example.com\r\nEND:VCARD\r\n');
  e = await syncCollection(client, { url: personal.url, kind: 'carddav', known, ctag: 'stale' });
  ok(e.changed.length === 1 && e.changed[0].href.endsWith('b.vcf'), 'a changed ETag is a changed item');
  known.delete('/dav/books/default/a.vcf');
  known.set('/dav/books/default/ghost.vcf', '"gone"');
  e = await syncCollection(client, { url: personal.url, kind: 'carddav', known, ctag: 'stale' });
  ok(e.removed.includes('/dav/books/default/ghost.vcf'),
    'and anything we hold that is no longer listed has been deleted', e.removed.join(','));
  mock.state.syncCollection = true;

  console.log('writing');
  const newHref = '/dav/books/default/new.vcf';
  const put = await client.put(mock.origin + newHref, 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:uid-n\r\nFN:Nova Oseba\r\nEMAIL:nova@example.com\r\nEND:VCARD\r\n',
    { etag: null, contentType: 'text/vcard; charset=utf-8' });
  ok(put.status === 201 && !!put.etag, 'creating with If-None-Match:* returns 201 and the new ETag');
  let conflict = null;
  try {
    await client.put(mock.origin + newHref, 'BEGIN:VCARD\r\nEND:VCARD\r\n', { etag: null });
  } catch (err2) { conflict = err2; }
  ok(conflict?.status === 412, 'and a second create of the same href is refused, not silently overwritten');
  conflict = null;
  try { await client.put(mock.origin + newHref, 'x', { etag: '"stale"' }); } catch (err3) { conflict = err3; }
  ok(conflict?.status === 412 && /changed by somebody else/i.test(conflict.message),
    'a stale If-Match is a real conflict, reported as one', conflict?.message?.slice(0, 60));
  ok(conflict.httpStatus === 412, 'and carries a status the API layer can pass through');

  const got = await client.get(mock.origin + newHref);
  ok(cardName(parseCard(got.body)) === 'Nova Oseba' && got.etag === put.etag, 'GET returns the body and the same ETag');
  await client.del(mock.origin + newHref, { etag: put.etag });
  let gone = null;
  try { await client.get(mock.origin + newHref); } catch (err4) { gone = err4; }
  ok(gone?.status === 404, 'and DELETE with a matching ETag removes it');

  console.log('a whole collection at once');
  const all = await fetchAll(client, personal.url, 'carddav');
  ok(all.items.length === 2 && all.failed === 0, 'fetchAll gets bodies and ETags together', String(all.items.length));
  ok(!!all.ctag, 'plus the CTag to start polling from');

  console.log('a batch the server cannot serve');
  const partial = await fetchItems(client, personal.url, 'carddav',
    ['/dav/books/default/a.vcf', '/dav/books/default/does-not-exist.vcf']);
  ok(partial.items.length === 1 && partial.failed === 1,
    'one bad item is counted, not fatal — otherwise one corrupt card blocks the collection forever');

  console.log('OPTIONS');
  const opts = await client.options(mock.url);
  ok(opts.compliance.includes('addressbook') && opts.compliance.includes('calendar-access'), 'compliance classes',
    opts.compliance.join(','));
} finally {
  await mock.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
