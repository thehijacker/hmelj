// Writing a calendar event all the way to a server (server/calendarWrite.js
// through server/calendar/* to test/mock-dav-server.js).
//
// test/calendar-scope-test.mjs asserts what the three edit scopes PRODUCE, with
// no I/O at all. This one asserts that what they produce actually arrives —
// through the dispatcher, the backend, the DAV client and a server that is
// strict about conditional requests.
//
// The assertion worth reading twice is the conflict one. An edit is conditional
// on the ETag Hmelj read; a 412 means somebody else got there first and MUST be
// reported rather than retried without the condition. The unconditional retry is
// the bug — it is how the other person's edit gets destroyed, silently, by a
// browser tab that has been open since this morning.
//
//   node test/caldav-write-test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';

// Before any import that reaches config.js — it resolves DATA_DIR once, at
// module evaluation, and dotenv does not override an already-set variable.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-calwrite-'));
process.env.DATA_DIR = TMP;
process.env.CACHE_DIR = TMP;
process.env.HMELJ_SECRET = 'test-secret-not-a-real-one';
process.env.LOG = process.env.LOG || 'warn';

const { startMockDav } = await import('./mock-dav-server.js');
const calendarStore = await import('../server/calendarStore.js');
const backends = await import('../server/calendar/index.js');
const calendarWrite = await import('../server/calendarWrite.js');
const calendarEvents = await import('../server/calendarEvents.js');
const cache = await import('../server/cache.js');
const { parseCalendar } = await import('../server/icalendar.js');
const { runAsUser, userKey } = await import('../server/session.js');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const USER = { id: 'u1', username: 'tester' };
const as = (fn) => runAsUser(USER, fn);
const UK = userKey(USER.username);
const AT = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

const mock = await startMockDav(3900 + (process.pid % 300));
const deps = () => ({
  backendFor: backends.backendFor,
  withSource: backends.withSource,
  organizer: { name: 'Tester', address: 'tester@example.com' },
});

/** The document as it actually stands on the server, read back over HTTP. */
async function onServer(href) {
  const { createClient, basicAuth } = await import('../server/dav/client.js');
  const client = createClient({ auth: basicAuth(mock.username, mock.password) });
  try { return (await client.get(mock.origin + href)).body; } catch { return null; }
}

try {
  console.log('setting up a writable CalDAV calendar');
  let src = as(() => calendarStore.saveSource({
    kind: 'caldav', label: 'Test', url: mock.url, username: mock.username, password: mock.password,
  }));
  const found = await backends.discoverFor(UK, calendarStore.rawSourceFor(UK, src.id));
  src = as(() => calendarStore.saveSource({
    ...src, homeUrl: found.homeUrl,
    calendars: found.collections.map((c) => ({ ...c, enabled: true, readOnly: false })),
  }, src.id));
  const CAL = src.calendars[0].id;
  ok(!!CAL, 'one calendar, enabled and writable');
  await backends.syncSourceFor(UK, src.id, { window: { from: AT(2026, 1, 1), to: AT(2027, 1, 1) } });

  console.log('creating');
  const created = await as(() => calendarWrite.createEventFor(UK, CAL, {
    summary: 'Sestanek', location: 'Sejna soba', start: AT(2026, 9, 1, 7, 0), end: AT(2026, 9, 1, 8, 0),
    zone: 'Europe/Ljubljana',
  }, deps()));
  ok(!!created.uid && !!created.etag, 'it comes back with a uid and an ETag', JSON.stringify(created));
  let doc = await onServer(created.href);
  ok(!!doc, 'and the document really is on the server');
  let ev = parseCalendar(doc).events[0];
  ok(ev.summary === 'Sestanek' && ev.location === 'Sejna soba', 'with what was sent');
  ok(Date.parse(ev.start.iso) === AT(2026, 9, 1, 7, 0), 'at the right instant', ev.start.iso);
  ok(ev.start.zone === 'Europe/Ljubljana', 'in the zone it was written for');
  ok(doc.includes('BEGIN:VTIMEZONE'), 'and the document defines that zone rather than referencing an undefined one');

  console.log('a second create of the same UID is refused, not silently overwritten');
  let conflict = null;
  try {
    await as(() => backends.withSource(UK, calendarStore.rawSourceFor(UK, src.id), (ctx) =>
      backends.backendFor('caldav').createEvent(ctx, { url: found.collections[0].url },
        { uid: created.uid, ical: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' })));
  } catch (e) { conflict = e; }
  ok(conflict?.status === 412, 'If-None-Match:* turns a UID collision into a 412', String(conflict?.status));

  console.log('the event count Settings shows');
  // Asserted across an UNCHANGED sync specifically. The count was once
  // `rows.length` — what a sync pass happened to fetch — so a quiet calendar
  // reported "1 event" however many it held. Fixing that was not enough on its
  // own: the unchanged branch returns early, and until it wrote the count too,
  // the calendars that most needed the new number (the ones nothing changes in)
  // never reached the code that computes it. Both passes below have to agree.
  {
    const countOf = () => calendarStore.listCalendarsFor(UK).find((c) => c.id === CAL)?.count;
    await backends.syncSourceFor(UK, src.id, { window: { from: AT(2026, 1, 1), to: AT(2027, 1, 1) } });
    const first = countOf();
    ok(first >= 1, 'a calendar with an event in it reports at least one', String(first));
    // Nothing has changed on the server since, so this one takes the early
    // return — and must still leave the count correct rather than stale.
    ok(first === cache.calendarEventCount(UK, src.id, CAL),
       'and it is what the cache actually holds', `${first} vs ${cache.calendarEventCount(UK, src.id, CAL)}`);
    // The assertion that matters, and the one an earlier version of this block
    // got wrong: plant a WRONG count, then sync without changing anything on
    // the server. "Leaves it alone" passes whether or not the unchanged branch
    // writes the count — not writing it also leaves it alone. Only a stale
    // value proves the branch corrects itself, which is the whole failure:
    // a calendar nothing ever changes in could never shed a bad number.
    calendarStore.updateSyncStateFor(UK, src.id, CAL, { count: 999 });
    const r = await backends.syncSourceFor(UK, src.id, { window: { from: AT(2026, 1, 1), to: AT(2027, 1, 1) } });
    ok(r.calendars.every((c) => c.unchanged),
       'the sync really did take the unchanged path', JSON.stringify(r.calendars));
    ok(countOf() === first, 'and a stale count is corrected even so', `999 -> ${countOf()}, expected ${first}`);
  }

  console.log('a calendar renamed on the server');
  // Renaming a calendar changes no EVENT, so its ctag does not move and the
  // event sync takes the "nothing changed" path — which is why a rename used to
  // be invisible: the name came from discovery, and discovery only ran when
  // somebody set the source up. Hmelj went on showing whatever the calendar was
  // called on the day it was added.
  {
    const nameOf = () => calendarStore.listCalendarsFor(UK).find((c) => c.id === CAL)?.displayName;
    ok(nameOf() === 'Work', 'starts as the server named it', nameOf());
    mock.rename('/dav/cals/work/', 'Popis vode in elektrike');
    // A plain background sync inside the hourly window does NOT go looking —
    // it is a whole extra request for something that changes once a year.
    await backends.syncSourceFor(UK, src.id, { window: { from: AT(2026, 1, 1), to: AT(2027, 1, 1) } });
    ok(nameOf() === 'Work', 'a background sync soon after does not re-read the list', nameOf());
    // "Sync now" does, which is what somebody who has just renamed one presses.
    await backends.syncSourceFor(UK, src.id, { interactive: true, window: { from: AT(2026, 1, 1), to: AT(2027, 1, 1) } });
    ok(nameOf() === 'Popis vode in elektrike', 'and an interactive sync picks the new name up', nameOf());

    // The href shape matters, and this is the case that shipped broken. A
    // calendar DISCOVERED on the server stores its address as a path with a
    // trailing slash; one CREATED through Hmelj stored an absolute URL without
    // one. Comparing the raw strings matched neither against the other, so a
    // refresh skipped precisely the calendars the user had made themselves —
    // and said nothing, because "no match" looks exactly like "no change".
    const stored = calendarStore.rawSourceFor(UK, src.id).calendars.find((c) => c.id === CAL);
    const original = { href: stored.href, url: stored.url };
    calendarStore.updateSyncStateFor(UK, src.id, CAL, {
      href: `${mock.origin}/dav/cals/work`,
      url: `${mock.origin}/dav/cals/work`,
      displayName: 'Stale name',
    });
    mock.rename('/dav/cals/work/', 'Renamed again');
    await backends.syncSourceFor(UK, src.id, { interactive: true, window: { from: AT(2026, 1, 1), to: AT(2027, 1, 1) } });
    ok(nameOf() === 'Renamed again',
       'an absolute href with no trailing slash still matches the discovered path', nameOf());
    // Put the address back: everything below syncs through it, and a
    // slash-less collection URL is not what the rest of this file is testing.
    calendarStore.updateSyncStateFor(UK, src.id, CAL, original);
  }

  console.log('editing');
  await backends.syncSourceFor(UK, src.id, { window: { from: AT(2026, 1, 1), to: AT(2027, 1, 1) } });
  await as(() => calendarWrite.updateEventFor(UK, CAL, created.uid, { summary: 'Sestanek (prestavljen)' }, {
    scope: 'all', ...deps(),
  }));
  doc = await onServer(created.href);
  ev = parseCalendar(doc).events[0];
  ok(ev.summary === 'Sestanek (prestavljen)', 'the change reached the server', ev.summary);
  ok(ev.location === 'Sejna soba',
    'and the location survived, because the edit never mentioned it — "not sent" is not "cleared"');
  ok(Date.parse(ev.start.iso) === AT(2026, 9, 1, 7, 0), 'as did the start time');
  ok(ev.sequence >= 1, 'SEQUENCE went up, so an attendee\'s client treats it as newer', String(ev.sequence));

  console.log('THE conflict case');
  // Re-sync first, so the ETag Hmelj holds is CURRENT. Without this the 412
  // below would fire because of Hmelj's own previous edit rather than because
  // of somebody else's, and the assertion would pass while testing nothing.
  // (In the app this refresh happens automatically after every write — see
  // afterCalendarWrite in server/index.js, which exists for exactly this.)
  await backends.syncSourceFor(UK, src.id, { window: { from: AT(2026, 1, 1), to: AT(2027, 1, 1) } });
  // Somebody else changes the event. The mock keys its store by the DECODED
  // path, which is what a real server compares too — the href Hmelj holds is
  // percent-encoded, and mutating under that would quietly create a second
  // resource instead of changing this one.
  mock.mutate(decodeURIComponent(created.href), doc.replace('Sestanek (prestavljen)', 'Changed by somebody else'));
  conflict = null;
  try {
    await as(() => calendarWrite.updateEventFor(UK, CAL, created.uid, { summary: 'My edit' }, {
      scope: 'all', ...deps(),
    }));
  } catch (e) { conflict = e; }
  ok(conflict?.status === 412, 'a stale ETag is a 412, not an overwrite', String(conflict?.status));
  doc = await onServer(created.href);
  ok(parseCalendar(doc).events[0].summary === 'Changed by somebody else',
    'and the other person\'s edit is still there — which is the whole point',
    parseCalendar(doc).events[0].summary);

  console.log('a repeating event, edited one occurrence at a time');
  await backends.syncSourceFor(UK, src.id, { window: { from: AT(2026, 1, 1), to: AT(2027, 1, 1) } });
  const weekly = await as(() => calendarWrite.createEventFor(UK, CAL, {
    summary: 'Standup', start: AT(2026, 3, 2, 8, 0), end: AT(2026, 3, 2, 8, 15),
    zone: 'Europe/Ljubljana', rrule: 'FREQ=WEEKLY;BYDAY=MO',
  }, deps()));
  await backends.syncSourceFor(UK, src.id, { window: { from: AT(2026, 1, 1), to: AT(2027, 1, 1) } });
  let march = calendarEvents.occurrencesIn(UK, [CAL], AT(2026, 3, 1), AT(2026, 4, 1), { timezone: 'Europe/Ljubljana' })
    .filter((e) => e.uid === weekly.uid);
  ok(march.length === 5, 'five Mondays in March', String(march.length));

  await as(() => calendarWrite.updateEventFor(UK, CAL, weekly.uid, { summary: 'Standup (moved)', start: AT(2026, 3, 9, 13, 0), end: AT(2026, 3, 9, 13, 30) }, {
    scope: 'one', occurrenceStart: AT(2026, 3, 9, 8, 0), ...deps(),
  }));
  await backends.syncSourceFor(UK, src.id, { window: { from: AT(2026, 1, 1), to: AT(2027, 1, 1) } });
  march = calendarEvents.occurrencesIn(UK, [CAL], AT(2026, 3, 1), AT(2026, 4, 1), { timezone: 'Europe/Ljubljana' })
    .filter((e) => e.uid === weekly.uid);
  ok(march.length === 5, 'still five — an exception REPLACES an occurrence, it does not add one', String(march.length));
  const ninth = march.filter((e) => e.day === '2026-03-09');
  ok(ninth.length === 1 && ninth[0].summary === 'Standup (moved)',
    'and the edited one appears once, at its new time', JSON.stringify(ninth.map((e) => [e.day, e.summary])));
  ok(march.filter((e) => e.day === '2026-03-16')[0]?.summary === 'Standup', 'the following week is untouched');

  console.log('cancelling one occurrence');
  await as(() => calendarWrite.deleteEventFor(UK, CAL, weekly.uid, {
    scope: 'one', occurrenceStart: AT(2026, 3, 23, 8, 0), ...deps(),
  }));
  await backends.syncSourceFor(UK, src.id, { window: { from: AT(2026, 1, 1), to: AT(2027, 1, 1) } });
  march = calendarEvents.occurrencesIn(UK, [CAL], AT(2026, 3, 1), AT(2026, 4, 1), { timezone: 'Europe/Ljubljana' })
    .filter((e) => e.uid === weekly.uid);
  ok(march.length === 4, 'four left', String(march.length));
  ok(!march.some((e) => e.day === '2026-03-23'), 'and the cancelled one is a hole, not a deleted series');

  console.log('deleting the whole thing');
  await as(() => calendarWrite.deleteEventFor(UK, CAL, weekly.uid, { scope: 'all', ...deps() }));
  await backends.syncSourceFor(UK, src.id, { window: { from: AT(2026, 1, 1), to: AT(2027, 1, 1) } });
  ok(calendarEvents.occurrencesIn(UK, [CAL], AT(2026, 3, 1), AT(2026, 4, 1), { timezone: 'UTC' })
    .filter((e) => e.uid === weekly.uid).length === 0, 'the series is gone');
  ok(await onServer(`/dav/cals/work/${encodeURIComponent(weekly.uid)}.ics`) === null, 'and so is its resource on the server');

  console.log('Microsoft and Exchange write through their own model, not iCalendar');
  // They opt out of the document pipeline entirely: calendarWrite hands them
  // the normalized input and lets them address their own ids. Asserted here
  // because it is the branch that decides whether an edit builds an iCalendar
  // document at all, and getting it wrong sends .ics text at a REST API.
  for (const kind of ['graph', 'ews']) {
    const b = backends.backendFor(kind);
    ok(b.writable === true, `${kind} is writable`);
    ok(b.nativeWrite === true, `${kind} takes the native path`);
    ok(typeof b.createEventNative === 'function'
      && typeof b.updateEventNative === 'function'
      && typeof b.deleteEventNative === 'function', `${kind} implements all three`);
    ok(b.sendsInvitationsItself === true,
      `${kind} mails its own invitations, so Hmelj must not send a second one`);
  }

  console.log('a Hmelj calendar needs no server at all');
  const localSrc = as(() => calendarStore.saveSource({ kind: 'local', label: 'My calendar' }));
  ok(localSrc.calendars.length === 1, 'creating the source creates its calendar — there is nothing to discover');
  const localCal = localSrc.calendars[0].id;
  const localEv = await as(() => calendarWrite.createEventFor(UK, localCal, {
    summary: 'Zobozdravnik', start: AT(2026, 5, 4, 8, 0), end: AT(2026, 5, 4, 8, 30),
  }, deps()));
  ok(!!localEv.uid, 'an event can be created in it');
  ok(!!calendarStore.readLocalEvent(UK, localCal, localEv.uid), 'stored as a file in DATA_DIR, not in the cache');
  await backends.syncSourceFor(UK, localSrc.id, {});
  const localList = calendarEvents.occurrencesIn(UK, [localCal], AT(2026, 5, 1), AT(2026, 6, 1), { timezone: 'UTC' });
  ok(localList.length === 1 && localList[0].summary === 'Zobozdravnik', 'and reads back through the same query as any other');
  await as(() => calendarWrite.deleteEventFor(UK, localCal, localEv.uid, { scope: 'all', ...deps() }));
  ok(calendarStore.readLocalEvent(UK, localCal, localEv.uid) === null, 'deleting removes the file');
} finally {
  await mock.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
