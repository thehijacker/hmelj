// Hmelj answering as a CalDAV/CardDAV server (server/davServer.js).
//
// Driven the way a real subscriber drives it: HTTP Basic, then the discovery
// chain (`current-user-principal` → home set → collections), then PROPFIND,
// REPORT, GET, PUT and DELETE. Hmelj's OWN DAV client is used to make the
// requests, which means this also asserts that the two halves agree — the
// parser that reads other servers can read this one.
//
// Four assertions carry more weight than the rest:
//
//   - the Hmelj LOGIN password must never work here. An app password is a
//     credential a phone stores in plain form and sends on every request; if the
//     account password were accepted, a calendar subscription would be handing
//     over the whole app.
//   - a credential scoped to calendars must not reach contacts.
//   - a 'busy' source must expose the TIME and nothing else.
//   - an aggregate must refuse a write rather than guessing which of its
//     sources the change belonged to.
//
//   node test/dav-server-test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-davsrv-'));
process.env.DATA_DIR = TMP;
process.env.CACHE_DIR = TMP;
process.env.HMELJ_SECRET = 'test-secret-not-a-real-one';
process.env.LOG = process.env.LOG || 'warn';

const express = (await import('express')).default;
const { davRouter, wellKnownRedirects } = await import('../server/davServer.js');
const appPasswords = await import('../server/appPasswords.js');
const davPublish = await import('../server/davPublish.js');
const calendarStore = await import('../server/calendarStore.js');
const calendarWrite = await import('../server/calendarWrite.js');
const backends = await import('../server/calendar/index.js');
const { store } = await import('../server/store.js');
const { createClient, basicAuth, DavError } = await import('../server/dav/client.js');
const { parseCalendar } = await import('../server/icalendar.js');
const { parseCard, cardName } = await import('../server/vcard.js');
const session = await import('../server/session.js');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const AT = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

// A real Hmelj login, so verify() has something to resolve.
const USER = session.createUser('tester', 'the-login-password');
const UK = session.userKey('tester');
const as = (fn) => session.runAsUser({ id: USER.id, username: 'tester' }, fn);

const app = express();
app.use(express.json());
wellKnownRedirects(app, '/dav');
app.use('/dav', davRouter());
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const clientFor = (secret) => createClient({ auth: basicAuth('tester', secret), timeoutMs: 8000 });

try {
  console.log('app passwords');
  const { record, secret } = as(() => appPasswords.create({ label: 'Phone', scopes: ['caldav', 'carddav'] }));
  ok(secret.length >= 20 && /^[A-Z2-9-]+$/.test(secret), 'the secret is readable and typeable', secret);
  ok(as(() => appPasswords.list())[0].hash === undefined, 'the stored hash is never handed out');
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'users', UK, 'app-passwords.json'), 'utf8'));
  ok(!JSON.stringify(onDisk).includes(secret.replace(/-/g, '')) && !JSON.stringify(onDisk).includes(secret),
    'and the secret itself is not on disk — only a scrypt hash of it');
  ok(as(() => appPasswords.verify('tester', secret))?.uKey === UK, 'it verifies');
  ok(as(() => appPasswords.verify('tester', secret + 'x')) === null, 'a wrong one does not');
  ok(as(() => appPasswords.verify('nobody', secret)) === null, 'and neither does an unknown user');

  console.log('THE login password must not work here');
  let err = null;
  try { await clientFor('the-login-password').propfind(`${ORIGIN}/dav/`, '<displayname/>', 0); } catch (e) { err = e; }
  ok(err?.status === 401,
    'the Hmelj account password is refused at /dav — a phone stores this credential in the clear',
    String(err?.status));
  ok(/app password/i.test(err?.responseBody || err?.message || ''), 'and the refusal says which credential to use');
  err = null;
  try { await createClient({ auth: () => '' }).propfind(`${ORIGIN}/dav/`, '<displayname/>', 0); } catch (e) { err = e; }
  ok(err?.status === 401, 'so is no credential at all');

  const client = clientFor(secret);

  console.log('discovery, driven by Hmelj\'s own DAV client');
  let rows = await client.propfind(`${ORIGIN}/dav/`, '<current-user-principal/>', 0);
  const principal = rows[0]?.props?.['current-user-principal']?.href?.[0];
  ok(!!principal && String(principal).includes(UK), 'the service root names the principal', String(principal));
  rows = await client.propfind(ORIGIN + principal, '<C:calendar-home-set/><CR:addressbook-home-set/><displayname/>', 0);
  const calHome = rows[0]?.props?.['calendar-home-set']?.href?.[0];
  const cardHome = rows[0]?.props?.['addressbook-home-set']?.href?.[0];
  ok(!!calHome && !!cardHome, 'and the principal names both home sets', `${calHome} / ${cardHome}`);

  console.log('an empty home set is not an error');
  rows = await client.propfind(ORIGIN + calHome, '<resourcetype/><displayname/>', 1);
  ok(rows.length === 1, 'it lists itself and nothing else until something is published', String(rows.length));

  console.log('publishing a Hmelj calendar');
  const src = as(() => calendarStore.saveSource({ kind: 'local', label: 'Family' }));
  const CAL = src.calendars[0].id;
  await as(() => calendarWrite.createEventFor(UK, CAL, {
    summary: 'Zdravnik', location: 'Klinika', description: 'Ne pozabi kartice',
    start: AT(2026, 5, 4, 8, 0), end: AT(2026, 5, 4, 8, 30),
  }, { backendFor: backends.backendFor, withSource: backends.withSource, organizer: null }));
  await backends.syncSourceFor(UK, src.id, {});
  const pub = as(() => davPublish.upsert({
    kind: 'calendar', label: 'Family calendar', sources: [{ calendarId: CAL, detail: 'full' }],
  }));
  ok(pub.mode === 'single', 'one source is a single publication');
  ok(as(() => davPublish.isWritable(UK, pub)) === true, 'and a Hmelj calendar published on its own is writable');

  rows = await client.propfind(ORIGIN + calHome, '<resourcetype/><displayname/><CS:getctag/><current-user-privilege-set/>', 1);
  ok(rows.length === 2, 'the home set now lists it', String(rows.length));
  const coll = rows.find((r) => r.href.includes(pub.id));
  ok('calendar' in (coll?.props?.resourcetype || {}), 'as a calendar collection');
  ok(!!coll.props.getctag, 'with a CTag, which is what makes a subscriber\'s poll cheap');
  const privs = JSON.stringify(coll.props['current-user-privilege-set']);
  ok(privs.includes('write'), 'and write privileges, because this one really can take a write');

  console.log('reading its contents');
  rows = await client.propfind(coll.url, '<getetag/><getcontenttype/>', 1);
  const members = rows.filter((r) => r.props.getetag);
  ok(members.length === 1, 'one event', String(members.length));
  let got = await client.get(members[0].url);
  ok(got.body.includes('SUMMARY:Zdravnik'), 'GET returns the iCalendar');
  ok(!!got.etag, 'with an ETag');
  ok(got.body.includes('LOCATION:Klinika'), 'at full detail, since that is how it was published');

  console.log('calendar-multiget');
  const { rows: mg } = await client.report(coll.url, `<?xml version="1.0"?>
<C:calendar-multiget xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <prop><getetag/><C:calendar-data/></prop><href>${members[0].href}</href>
</C:calendar-multiget>`, 1);
  ok(mg.length === 1 && String(mg[0].props['calendar-data']).includes('Zdravnik'),
    'returns the document the client asked for');

  console.log('calendar-query with a time range');
  const query = (from, to) => client.report(coll.url, `<?xml version="1.0"?>
<C:calendar-query xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <prop><getetag/></prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">
    <C:time-range start="${from}" end="${to}"/>
  </C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`, 1);
  ok((await query('20260501T000000Z', '20260601T000000Z')).rows.length === 1, 'finds an event inside the window');
  ok((await query('20270101T000000Z', '20270201T000000Z')).rows.length === 0, 'and none outside it');

  console.log('writing from a subscriber');
  const newIcs = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test Client//EN', 'BEGIN:VEVENT',
    'UID:from-phone-1', 'SUMMARY:Added on the phone', 'DTSTART:20260612T090000Z', 'DTEND:20260612T100000Z',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const putRes = await client.put(`${coll.url}from-phone-1.ics`, newIcs, { etag: null, contentType: 'text/calendar' });
  ok(putRes.status === 201, 'a PUT creates it', String(putRes.status));
  ok(!!calendarStore.readLocalEvent(UK, CAL, 'from-phone-1'), 'and it really is stored in the calendar');
  rows = await client.propfind(coll.url, '<getetag/>', 1);
  ok(rows.filter((r) => r.props.getetag).length === 2, 'the collection now lists two');
  // Visible in Hmelj itself straight away, not at the next poll.
  const inHmelj = (await import('../server/calendarEvents.js'))
    .occurrencesIn(UK, [CAL], AT(2026, 6, 1), AT(2026, 7, 1), { timezone: 'UTC' });
  ok(inHmelj.some((e) => e.summary === 'Added on the phone'),
    'and Hmelj can see it immediately, without waiting for a sync');

  console.log('conditional writes');
  err = null;
  try { await client.put(`${coll.url}from-phone-1.ics`, newIcs, { etag: null }); } catch (e) { err = e; }
  ok(err?.status === 412, 'If-None-Match:* refuses a second create of the same UID', String(err?.status));
  err = null;
  try { await client.put(`${coll.url}from-phone-1.ics`, newIcs, { etag: '"stale"' }); } catch (e) { err = e; }
  ok(err?.status === 412, 'and a stale If-Match is a conflict, not an overwrite');

  console.log('deleting from a subscriber');
  const cur = await client.get(`${coll.url}from-phone-1.ics`);
  await client.del(`${coll.url}from-phone-1.ics`, { etag: cur.etag });
  ok(calendarStore.readLocalEvent(UK, CAL, 'from-phone-1') === null, 'the event is gone from the calendar');

  console.log('A BUSY-ONLY source shows the time and nothing else');
  const busyPub = as(() => davPublish.upsert({
    kind: 'calendar', label: 'When I am free', sources: [{ calendarId: CAL, detail: 'busy' }],
  }));
  rows = await client.propfind(ORIGIN + calHome, '<resourcetype/>', 1);
  const busyColl = rows.find((r) => r.href.includes(busyPub.id));
  rows = await client.propfind(busyColl.url, '<getetag/>', 1);
  const busyMember = rows.find((r) => r.props.getetag);
  got = await client.get(busyMember.url);
  const busyEv = parseCalendar(got.body).events[0];
  ok(busyEv.summary === 'Busy', 'the summary is masked', busyEv.summary);
  ok(!busyEv.location && !busyEv.description, 'the location and notes are gone');
  ok(!got.body.includes('Klinika') && !got.body.includes('kartice'),
    'and neither appears anywhere in the document — which is the whole point');
  ok(Date.parse(busyEv.start.iso) === AT(2026, 5, 4, 8, 0), 'while the TIME is exactly right', busyEv.start.iso);
  ok(as(() => davPublish.isWritable(UK, busyPub)) === false,
    'a busy-only publication is read-only — a write to it could not know what it was changing');

  console.log('AN AGGREGATE refuses a write');
  const src2 = as(() => calendarStore.saveSource({ kind: 'local', label: 'Work' }));
  const CAL2 = src2.calendars[0].id;
  const joined = as(() => davPublish.upsert({
    kind: 'calendar', label: 'Everything', mode: 'aggregate',
    sources: [{ calendarId: CAL, detail: 'full' }, { calendarId: CAL2, detail: 'busy' }],
  }));
  ok(joined.mode === 'aggregate', 'two sources make an aggregate');
  ok(as(() => davPublish.isWritable(UK, joined)) === false, 'which is never writable');
  rows = await client.propfind(ORIGIN + calHome, '<current-user-privilege-set/>', 1);
  const joinedColl = rows.find((r) => r.href.includes(joined.id));
  ok(!JSON.stringify(joinedColl.props['current-user-privilege-set']).includes('write'),
    'and says so in its privileges rather than only refusing later');
  err = null;
  try { await client.put(`${joinedColl.url}x.ics`, newIcs, { etag: null }); } catch (e) { err = e; }
  ok(err?.status === 403, 'a PUT into it is refused', String(err?.status));
  ok(/merged/i.test(err?.responseBody || ''), 'with a reason a person can act on', err?.responseBody?.slice(0, 60));

  console.log('contacts');
  as(() => store.saveContacts([{ id: 'c-1', name: 'Ana Horvat', email: 'ana@example.com' }]));
  const cardPub = as(() => davPublish.upsert({
    kind: 'addressbook', label: 'My contacts', sources: [{ sourceId: 'local-contacts' }],
  }));
  rows = await client.propfind(ORIGIN + cardHome, '<resourcetype/><displayname/>', 1);
  const cardColl = rows.find((r) => r.href.includes(cardPub.id));
  ok('addressbook' in (cardColl?.props?.resourcetype || {}), 'the address book is an addressbook collection');
  rows = await client.propfind(cardColl.url, '<getetag/><getcontenttype/>', 1);
  const cardMember = rows.find((r) => r.props.getetag);
  ok(!!cardMember, 'with one card');
  got = await client.get(cardMember.url);
  ok(cardName(parseCard(got.body)) === 'Ana Horvat', 'which parses as a real vCard', got.body.slice(0, 40));
  ok(got.body.includes('ana@example.com'), 'carrying the address');

  console.log('SCOPES are enforced');
  const { secret: calOnly } = as(() => appPasswords.create({ label: 'Calendar only', scopes: ['caldav'] }));
  const calClient = clientFor(calOnly);
  rows = await calClient.propfind(ORIGIN + calHome, '<resourcetype/>', 1);
  ok(rows.length >= 1, 'a calendar-only credential reaches calendars');
  err = null;
  try { await calClient.propfind(ORIGIN + cardHome, '<resourcetype/>', 1); } catch (e) { err = e; }
  ok(err?.status === 403, 'and is refused at the address book', String(err?.status));
  ok(/contacts/i.test(err?.responseBody || ''), 'with a message naming what it may not reach');

  console.log('one user cannot read another\'s path');
  session.createUser('other', 'another-password');
  err = null;
  try { await client.propfind(`${ORIGIN}/dav/p/${session.userKey('other')}/cal/`, '<resourcetype/>', 1); } catch (e) { err = e; }
  ok(err?.status === 404,
    'a valid credential aimed at somebody else\'s key is a 404 — which says nothing about whether they exist',
    String(err?.status));

  console.log('housekeeping');
  const opts = await client.options(`${ORIGIN}/dav/`);
  ok(opts.compliance.includes('calendar-access') && opts.compliance.includes('addressbook'),
    'OPTIONS advertises both collection classes', opts.compliance.join(','));
  ok(!opts.compliance.includes('2'),
    'and does NOT claim class 2 — that would promise locking this server does not implement');
  // sync-collection is refused rather than answered badly, so a client falls
  // back to CTag polling instead of trusting a token that skipped a deletion.
  err = null;
  try {
    await client.report(coll.url, '<?xml version="1.0"?><sync-collection xmlns="DAV:"><sync-token/><sync-level>1</sync-level><prop><getetag/></prop></sync-collection>', 1);
  } catch (e) { err = e; }
  ok(err?.status === 403 && /supported-report/.test(err.responseBody || ''),
    'sync-collection is refused with the precondition that tells a client to fall back',
    err?.responseBody?.slice(0, 60));

  const wk = await new Promise((resolve) => {
    http.get(`${ORIGIN}/.well-known/caldav`, (r) => { r.resume(); resolve(r); });
  });
  ok(wk.statusCode === 301 && wk.headers.location === '/dav/', 'the .well-known bootstrap redirects to /dav/',
    `${wk.statusCode} ${wk.headers.location}`);

  console.log('revoking');
  as(() => appPasswords.remove(record.id));
  err = null;
  try { await client.propfind(`${ORIGIN}/dav/`, '<displayname/>', 0); } catch (e) { err = e; }
  ok(err?.status === 401, 'a removed credential stops working immediately');
  ok((await calClient.propfind(ORIGIN + calHome, '<resourcetype/>', 1)).length >= 1,
    'and the other one is unaffected — which is the point of having several');
} finally {
  await new Promise((r) => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
