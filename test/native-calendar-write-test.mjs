// Hmelj — writing to Microsoft 365 and Exchange.
//
// These two do NOT go through the iCalendar document pipeline the CalDAV path
// uses (test/caldav-write-test.mjs covers that one). They speak their own
// models, so what has to be asserted is different: which ID each of the three
// scopes addresses, and what the request actually says.
//
// Addressing is the part worth the test, because it does not fail loudly. "The
// whole series" applied to an occurrence id edits one instance and leaves the
// rest — and the server reports that as a success. Nobody finds out until the
// following week.
//
// Both backends expose planWrite(): the decision, with no I/O, returning the
// operations rather than performing them. That is what is driven here.
//
//   node test/native-calendar-write-test.mjs
import * as graphCal from '../server/calendar/graphCalendar.js';
import * as ewsCal from '../server/calendar/ewsCalendar.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); } };
const eq = (got, want, m) => ok(got === want, m, `got:  ${got}\n      want: ${want}`);
const throws = (fn, test, m) => {
  try { fn(); ok(false, m, 'it returned instead of refusing'); }
  catch (e) { ok(test(e), m, e.message?.slice(0, 90)); }
};

const AT = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

/* An occurrence of a weekly series, and the master behind it, in each
   provider's own shape. Monday 9 March 2026; the series starts the 2nd. */
// Exactly the shape calendarEvents.js#occurrence produces — `end` included,
// because it always sets one and a fixture without it would let a real gap
// through.
const OCC = {
  providerId: 'OCC1', itemId: 'OCC1', recurring: true,
  start: AT(2026, 3, 9, 8, 0), end: AT(2026, 3, 9, 8, 15), zone: 'UTC',
};
const GRAPH_MASTER = {
  id: 'MASTER1',
  start: { dateTime: '2026-03-02T08:00:00.0000000', timeZone: 'UTC' },
  recurrence: {
    pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'], firstDayOfWeek: 'monday' },
    range: { type: 'noEnd', startDate: '2026-03-02' },
  },
};
const EWS_MASTER = {
  id: 'MASTER1', start: '2026-03-02T08:00:00Z',
  recurrence: {
    WeeklyRecurrence: { Interval: 1, DaysOfWeek: 'Monday', FirstDayOfWeek: 'Monday' },
    NoEndRecurrence: { StartDate: '2026-03-02' },
  },
};

console.log('when the series master has to be fetched at all');
for (const [name, mod] of [['Microsoft', graphCal], ['Exchange', ewsCal]]) {
  ok(mod.needsMaster({ detail: OCC, scope: 'all' }), `${name}: the whole series needs it`);
  ok(mod.needsMaster({ detail: OCC, scope: 'future' }), `${name}: so does a split`);
  ok(!mod.needsMaster({ detail: OCC, scope: 'one' }), `${name}: one occurrence does not`);
  ok(!mod.needsMaster({ detail: { recurring: false }, scope: 'all' }), `${name}: and a one-off never does`);
}

console.log('Microsoft 365 — which id each scope addresses');
let ops = graphCal.planWrite({ detail: OCC, scope: 'one', next: { summary: 'Moved' }, master: null, calendarId: 'CAL1' });
eq(ops.length, 1, 'one operation');
eq(ops[0].id, 'OCC1', '"just this one" patches the OCCURRENCE — Microsoft makes the exception itself');
ok(!('recurrence' in ops[0].body),
   'and never sends a rule with it, which would turn one instance into a series');

ops = graphCal.planWrite({ detail: OCC, scope: 'all', next: { summary: 'Renamed' }, master: GRAPH_MASTER, calendarId: 'CAL1' });
eq(ops[0].id, 'MASTER1', '"the whole series" patches the MASTER');
eq(ops[0].body.subject, 'Renamed', 'with the new subject');

ops = graphCal.planWrite({ detail: OCC, scope: 'future', next: { summary: 'From now on' }, master: GRAPH_MASTER, calendarId: 'CAL1' });
eq(ops.length, 2, '"this and following" is two operations');
eq(ops[0].op, 'patch', 'the cap comes FIRST');
eq(ops[0].id, 'MASTER1', 'on the master');
eq(ops[0].body.recurrence.range.endDate, '2026-03-08',
   'ending the day BEFORE the split — the same day would show the occurrence twice');
eq(ops[1].op, 'create', 'and only then is the new series created');
eq(ops[1].body.recurrence.pattern.type, 'weekly',
   'carrying the old rule forward, because the edit did not change it');
eq(ops[1].calendarId, 'CAL1', 'into the calendar that was asked for');

console.log('Microsoft 365 — deleting');
eq(graphCal.planWrite({ detail: OCC, scope: 'one', master: null, deleting: true })[0].id, 'OCC1',
   'one occurrence deletes the occurrence');
eq(graphCal.planWrite({ detail: OCC, scope: 'all', master: GRAPH_MASTER, deleting: true })[0].id, 'MASTER1',
   'the whole series deletes the master');
ops = graphCal.planWrite({ detail: OCC, scope: 'future', master: GRAPH_MASTER, deleting: true });
eq(ops.length, 1, 'and "this and following" deletes nothing at all —');
eq(ops[0].op, 'patch', 'it just ends the series early');

console.log('Microsoft 365 — a one-off is not a series');
ops = graphCal.planWrite({
  detail: { providerId: 'ONE1', recurring: false, start: AT(2026, 5, 1, 9), zone: 'UTC' },
  scope: 'all', next: { summary: 'Lunch' }, master: null, calendarId: 'CAL1',
});
eq(ops[0].id, 'ONE1', 'it is patched directly, with no master lookup');

console.log('Microsoft 365 — what a create sends');
const body = graphCal._internals.toGraphEvent({
  summary: 'Review', description: 'Bring the deck', location: 'Room 2',
  start: AT(2026, 4, 7, 13, 0), end: AT(2026, 4, 7, 14, 0), allDay: false, zone: 'UTC',
  attendees: [{ address: 'a@example.com', name: 'A' }, { address: 'b@example.com', optional: true }],
  rrule: 'FREQ=WEEKLY;BYDAY=TU',
});
eq(body.subject, 'Review', 'the subject');
eq(body.location.displayName, 'Room 2', 'the location');
eq(body.attendees.length, 2, 'both attendees');
eq(body.attendees[1].type, 'optional', 'and the optional one is marked optional');
eq(body.recurrence.pattern.type, 'weekly', 'with the rule translated');
ok(body.start.dateTime.startsWith('2026-04-07T13:00:00'), 'and the start as a zoned dateTime', body.start.dateTime);

console.log('Microsoft 365 — an edit sends only what changed');
const patch = graphCal._internals.toGraphEvent({ summary: 'New title' }, { forPatch: true });
eq(Object.keys(patch).join(','), 'subject', 'one property in, one property out');
ok(!('location' in patch) && !('start' in patch),
   'nothing else is mentioned — "not sent" is what stops an edit clobbering the rest');

console.log('Exchange — which id each scope addresses');
ops = ewsCal.planWrite({ detail: OCC, scope: 'one', next: { summary: 'Moved' }, master: null, folderId: 'F1' });
eq(ops[0].id, 'OCC1', '"just this one" updates the occurrence itself');
ok(!ops[0].fields.includes('calendar:Recurrence'), 'and never sends a recurrence with it');

ops = ewsCal.planWrite({ detail: OCC, scope: 'all', next: { summary: 'Renamed' }, master: EWS_MASTER, folderId: 'F1' });
eq(ops[0].id, 'MASTER1', '"the whole series" updates the recurring master');

ops = ewsCal.planWrite({ detail: OCC, scope: 'future', next: { summary: 'Split' }, master: EWS_MASTER, folderId: 'F1' });
eq(ops[0].op, 'update', 'the cap comes first here too');
eq(ops[0].id, 'MASTER1', 'on the master');
ok(ops[0].fields.includes('<t:EndDate>2026-03-08</t:EndDate>'),
   'as an EndDateRecurrence ending the day before the split', ops[0].fields.slice(0, 140));
eq(ops[1].op, 'create', 'and the new series follows');
eq(ops[1].folderId, 'F1', 'in the folder that was asked for');

console.log('Exchange — deleting');
eq(ewsCal.planWrite({ detail: OCC, scope: 'one', master: null, deleting: true })[0].id, 'OCC1', 'one occurrence');
eq(ewsCal.planWrite({ detail: OCC, scope: 'all', master: EWS_MASTER, deleting: true })[0].id, 'MASTER1', 'the whole series');

console.log('Exchange — the XML a write turns into');
const { newItemXml, fieldsFor } = ewsCal._internals;
const xml = newItemXml({
  summary: 'Sestanek & <pregled>', description: 'Notes', location: 'Soba 1',
  start: AT(2026, 4, 7, 13, 0), end: AT(2026, 4, 7, 14, 0), allDay: false,
  attendees: [{ address: 'a@example.com', name: 'A' }, { address: 'b@example.com', optional: true }],
  rrule: 'FREQ=WEEKLY;BYDAY=TU', zone: 'UTC',
});
ok(xml.includes('<t:Subject>Sestanek &amp; &lt;pregled&gt;</t:Subject>'),
   'a subject with markup characters is escaped, not injected');
ok(xml.includes('<t:Start>2026-04-07T13:00:00Z</t:Start>'), 'the start is an instant with a Z');
ok(xml.indexOf('<t:Subject>') < xml.indexOf('<t:Start>')
   && xml.indexOf('<t:Start>') < xml.indexOf('<t:Location>')
   && xml.indexOf('<t:Location>') < xml.indexOf('<t:RequiredAttendees>')
   && xml.indexOf('<t:RequiredAttendees>') < xml.indexOf('<t:Recurrence>'),
   'and every element is in the schema order Exchange insists on');
ok(xml.includes('<t:OptionalAttendees>') && xml.includes('b@example.com'),
   'the optional attendee goes in its own element');

console.log('Exchange — an edit sends only what changed');
const only = fieldsFor({ summary: 'New title' });
ok(only.includes('item:Subject'), 'the field that was touched is set');
ok(!only.includes('calendar:Location') && !only.includes('calendar:Start'),
   'and nothing else is mentioned at all');
ok(fieldsFor({ location: '' }).includes('<t:DeleteItemField><t:FieldURI FieldURI="calendar:Location"/>'),
   'an explicitly emptied field is DELETED, which is different from not mentioning it');
const timed = fieldsFor({ start: AT(2026, 4, 7, 13), end: AT(2026, 4, 7, 14), allDay: false });
ok(timed.indexOf('calendar:Start') < timed.indexOf('calendar:End'), 'start before end');
const withRule = fieldsFor({ start: AT(2026, 4, 7, 13), end: AT(2026, 4, 7, 14), rrule: 'FREQ=DAILY', zone: 'UTC' });
ok(withRule.indexOf('calendar:Start') < withRule.indexOf('calendar:Recurrence'),
   'and a recurrence always follows the start it is relative to');

console.log('Exchange — what an edit must NOT try to delete');
// ErrorInvalidPropertyDelete: "the delete action is not supported for this
// property". The event form sends every field on every save, empty ones
// included, so an edit that only changed the title used to arrive as "set the
// title, and delete the body, and delete the recurrence, and delete the
// location, and delete both attendee lists" — for an event that had none of
// them. Exchange refused the whole request, naming a property the user had
// never touched.
{
  const untouched = { summary: 'Bins', description: '', location: '', attendees: [], recurring: false };
  const edit = { summary: 'Bins', description: '', location: '', attendees: [], rrule: null,
                 start: AT(2026, 9, 7), end: AT(2026, 9, 8), allDay: true };
  const xml = ewsCal._internals.fieldsFor(edit, { prev: untouched });
  ok(!xml.includes('DeleteItemField'), 'nothing that was already empty is deleted', xml.slice(0, 200));
  ok(xml.includes('<t:Body BodyType="Text"></t:Body>'),
     'an empty body is SET, never deleted — Exchange refuses DeleteItemField on item:Body outright');
}
{
  // …while a real clear still has to go out, or "remove the location" would
  // silently do nothing.
  const had = { summary: 'x', location: 'Room 2', attendees: [{ address: 'a@example.com' }], recurring: true };
  const xml = ewsCal._internals.fieldsFor({ location: '', attendees: [], rrule: null }, { prev: had, wasRecurring: true });
  ok(xml.includes('FieldURI="calendar:Location"') && xml.includes('DeleteItemField'), 'a location that WAS set is deleted');
  ok(xml.includes('FieldURI="calendar:RequiredAttendees"'), 'and so are attendees that were there');
  ok(xml.includes('FieldURI="calendar:Recurrence"'),
     'and a series being turned into a one-off still loses its recurrence');
}
{
  const xml = ewsCal._internals.fieldsFor({ rrule: null }, { prev: { recurring: false }, wasRecurring: false });
  ok(!xml.includes('calendar:Recurrence'),
     'but a one-off never has its (absent) recurrence deleted — the other half of the same failure');
}

console.log('the last day of the month');
// Exchange has no absolute pattern for it — DayOfMonth is a number — so it goes
// out as the relative one, over "Day" rather than a weekday. See
// server/recurrenceMap.js#graphPattern.
{
  const lastDay = newItemXml({ start: AT(2026, 4, 30), end: AT(2026, 5, 1), rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1', zone: 'UTC' });
  ok(lastDay.includes('<t:DaysOfWeek>Day</t:DaysOfWeek>'), 'goes out over "Day", not over a weekday');
  ok(lastDay.includes('<t:DayOfWeekIndex>Last</t:DayOfWeekIndex>'), 'indexed Last');
}

console.log('what is refused rather than guessed');
throws(() => newItemXml({ start: AT(2026, 4, 7), end: AT(2026, 4, 8), rrule: 'FREQ=MONTHLY;BYMONTHDAY=-2', zone: 'UTC' }),
  (e) => e.status === 400 && /approximation/i.test(e.message),
  'a rule Microsoft cannot express is refused, in words somebody can act on');
throws(() => graphCal.planWrite({ detail: { recurring: false }, scope: 'all', next: {}, master: null }),
  (e) => e.status === 409, 'an event with no Microsoft id says to re-sync rather than throwing a TypeError');
throws(() => ewsCal.planWrite({ detail: OCC, scope: 'all', next: {}, master: null }),
  (e) => e.status === 409, 'and a series whose master could not be found says so');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
