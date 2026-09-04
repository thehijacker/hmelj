// Writing iCalendar (server/icalendar.js's serializer half).
//
// Two things are being asserted, and the second matters more than the first.
//
// 1. What Hmelj CREATES round-trips: serialize → parse → the same event.
//
// 2. What Hmelj EDITS keeps everything it did not touch. A calendar entry on
//    somebody's server carries a VTIMEZONE, X-MICROSOFT-CDO-* fields Outlook
//    needs, attendee parameters, attachments. Regenerating the event from what
//    Hmelj models would delete all of it on the first edit — silently, and on
//    the server rather than only here. `patchEvent` exists to make that
//    impossible, and the assertions below are what keep it that way.
//
// Plus the VTIMEZONE derivation, because a recurring event written in UTC
// drifts by an hour for half the year — the exact bug server/rrule.js exists to
// prevent, reintroduced at the moment of writing.
//
//   node test/calendar-write-test.mjs
import {
  serializeCalendar, serializeEvent, patchEvent, buildVTimezone,
  dateLine, icalUtc, icalDate, parseCalendar, wallToInstant,
} from '../server/icalendar.js';
import { escapeText, foldLine, unescapeText } from '../server/contentLine.js';
import { expand } from '../server/rrule.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const AT = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

console.log('the shared content-line grammar');
ok(escapeText('a;b,c\\d\ne') === 'a\\;b\\,c\\\\d\\ne', 'every TEXT escape, backslash first');
ok(unescapeText(escapeText('Sejna soba 2; 1. nadstropje')) === 'Sejna soba 2; 1. nadstropje', 'and it round-trips');
ok(foldLine('SUMMARY:' + 'ž'.repeat(80)).split('\r\n').every((l, i) => Buffer.byteLength(l) <= 75),
  'folding counts octets, so a multi-byte name is never cut in half');

console.log('date lines');
ok(dateLine('DTSTART', AT(2026, 9, 1, 9, 0)) === 'DTSTART:20260901T090000Z', 'a plain instant is UTC',
  dateLine('DTSTART', AT(2026, 9, 1, 9, 0)));
ok(dateLine('DTSTART', AT(2026, 12, 25), { allDay: true }) === 'DTSTART;VALUE=DATE:20261225',
  'an all-day value is a DATE with no zone at all — giving it one moves Christmas for half the world',
  dateLine('DTSTART', AT(2026, 12, 25), { allDay: true }));
ok(dateLine('DTSTART', AT(2026, 9, 1, 7, 0), { zone: 'Europe/Ljubljana' }) === 'DTSTART;TZID=Europe/Ljubljana:20260901T090000',
  'and a zoned one carries its TZID and its LOCAL clock reading',
  dateLine('DTSTART', AT(2026, 9, 1, 7, 0), { zone: 'Europe/Ljubljana' }));
ok(icalUtc(AT(2026, 1, 2, 3, 4)) === '20260102T030400Z', 'icalUtc');
ok(icalDate(AT(2026, 1, 2)) === '20260102', 'icalDate');

console.log('VTIMEZONE, derived from what Intl already knows');
const tz = buildVTimezone('Europe/Ljubljana', 2026).join('\n');
ok(tz.includes('TZID:Europe/Ljubljana'), 'names the zone');
ok(/BEGIN:DAYLIGHT[\s\S]*RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU/.test(tz),
  'daylight saving starts on the LAST Sunday in March — the EU rule, not a guess', /RRULE:[^\n]*/.exec(tz)?.[0]);
ok(/BEGIN:STANDARD[\s\S]*RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU/.test(tz), 'and ends on the last Sunday in October');
ok(tz.includes('TZOFFSETFROM:+0100') && tz.includes('TZOFFSETTO:+0200'), 'with the right offsets either side');
// -1SU rather than 5SU: a month with only four Sundays has no fifth one, and
// such a rule would silently never fire.
ok(!/BYDAY=5SU/.test(tz), 'expressed from the END of the month, never as a fifth-weekday rule that may not exist');
const noDst = buildVTimezone('Asia/Kolkata', 2026).join('\n');
ok(noDst.includes('BEGIN:STANDARD') && !noDst.includes('BEGIN:DAYLIGHT'),
  'a zone without daylight saving gets one observance and no rule to get wrong');
ok(noDst.includes('TZOFFSETTO:+0530'), 'including a half-hour offset', /TZOFFSETTO:[^\n]*/.exec(noDst)?.[0]);
ok(buildVTimezone('UTC') === null && buildVTimezone('') === null, 'UTC needs none');

console.log('a created event round-trips');
const made = {
  uid: 'made-1', summary: 'Sestanek z Jožefo', location: 'Sejna soba 2, 1. nadstropje',
  description: 'Prva vrstica\nDruga vrstica',
  start: AT(2026, 9, 1, 7, 0), end: AT(2026, 9, 1, 8, 0), zone: 'Europe/Ljubljana',
  allDay: false, sequence: 0,
  organizer: { name: 'Ana Novak', address: 'ana@example.com' },
  attendees: [{ name: 'Bojan Kos', address: 'bojan@example.com', status: 'NEEDS-ACTION' }],
  alarms: [{ minutesBefore: 15, related: 'START' }],
  categories: ['Work'],
};
const text = serializeCalendar(made);
const back = parseCalendar(text);
ok(back?.events.length === 1, 'it parses back');
const ev = back.events[0];
ok(ev.uid === 'made-1' && ev.summary === 'Sestanek z Jožefo', 'uid and summary');
ok(ev.location === 'Sejna soba 2, 1. nadstropje', 'a comma inside a value survives the escaping', ev.location);
ok(ev.description === 'Prva vrstica\nDruga vrstica', 'and so does a newline');
ok(Date.parse(ev.start.iso) === made.start, 'the start is the same instant', ev.start.iso);
ok(ev.start.zone === 'Europe/Ljubljana', 'in the zone it was written for');
ok(Date.parse(ev.end.iso) === made.end, 'and so is the end');
ok(ev.organizer.address === 'ana@example.com' && ev.attendees[0].address === 'bojan@example.com', 'organizer and attendee');
ok(ev.attendees[0].rsvp === true, 'the attendee is asked to reply — without RSVP=TRUE no mail client offers the buttons');
ok(ev.alarms[0].minutesBefore === 15, 'the alarm');
ok(text.includes('BEGIN:VTIMEZONE'), 'and the document defines the zone it referenced');
ok(text.endsWith('\r\n') && text.includes('\r\n'), 'CRLF throughout, as the RFC requires');

console.log('an all-day event');
const allDay = serializeCalendar({ uid: 'x', summary: 'Christmas', start: AT(2026, 12, 25), allDay: true, zone: 'Europe/Ljubljana' });
ok(allDay.includes('DTSTART;VALUE=DATE:20261225'), 'is a DATE');
ok(!allDay.includes('BEGIN:VTIMEZONE'), 'and needs no VTIMEZONE, because it has no zone', allDay);

console.log('a recurring event keeps its clock across daylight saving');
// The whole reason a zoned DTSTART is written at all. In UTC this same series
// would be 09:00 until the last Sunday in March and 10:00 afterwards.
const weekly = serializeCalendar({
  uid: 'w', summary: 'Standup', start: AT(2026, 3, 2, 8, 0), end: AT(2026, 3, 2, 8, 15),
  zone: 'Europe/Ljubljana', rrule: 'FREQ=WEEKLY;BYDAY=MO',
});
const wev = parseCalendar(weekly).events[0];
ok(wev.rrule === 'FREQ=WEEKLY;BYDAY=MO', 'the rule survives');
const occ = expand({ start: { y: 2026, mo: 3, d: 2, h: 9, mi: 0, s: 0 }, zone: wev.start.zone, rrule: wev.rrule },
  { from: AT(2026, 3, 1), to: AT(2026, 4, 1) });
ok(new Date(occ[0]).toISOString() === '2026-03-02T08:00:00.000Z', '2 March is 08:00Z (CET)', new Date(occ[0]).toISOString());
ok(new Date(occ.at(-1)).toISOString() === '2026-03-30T07:00:00.000Z',
  'and 30 March is 07:00Z (CEST) — the same 09:00 on the clock, which is the point',
  new Date(occ.at(-1)).toISOString());

console.log('EDITING keeps everything Hmelj does not model');
// A real event as another client would have written it.
const original = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Microsoft Corporation//Outlook//EN',
  'BEGIN:VTIMEZONE', 'TZID:W. Europe Standard Time',
  'BEGIN:STANDARD', 'DTSTART:16011028T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT', 'UID:theirs-1', 'SUMMARY:Quarterly review',
  'DTSTART;TZID=W. Europe Standard Time:20260901T100000',
  'DTEND;TZID=W. Europe Standard Time:20260901T110000',
  'X-MICROSOFT-CDO-BUSYSTATUS:BUSY', 'X-ALT-DESC;FMTTYPE=text/html:<html>hello</html>',
  'ATTENDEE;CN=Someone;CUTYPE=INDIVIDUAL;X-NUM-GUESTS=0:mailto:someone@example.com',
  'ATTACH:https://example.com/agenda.pdf',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT30M', 'DESCRIPTION:Reminder', 'END:VALARM',
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

const edited = patchEvent(original, { SUMMARY: 'SUMMARY:Quarterly review (moved)' });
ok(edited.includes('SUMMARY:Quarterly review (moved)'), 'the summary changed');
ok(!edited.includes('SUMMARY:Quarterly review\r'), 'and the old one is gone');
for (const kept of [
  'BEGIN:VTIMEZONE', 'TZID:W. Europe Standard Time',
  'X-MICROSOFT-CDO-BUSYSTATUS:BUSY', 'X-ALT-DESC;FMTTYPE=text/html',
  'X-NUM-GUESTS=0', 'ATTACH:https://example.com/agenda.pdf',
  'BEGIN:VALARM', 'PRODID:-//Microsoft Corporation//Outlook//EN',
]) {
  ok(edited.includes(kept), `an unmodelled line survives the edit: ${kept.slice(0, 32)}`);
}
ok(parseCalendar(edited).events.length === 1, 'and the result still parses as one event');

console.log('adding a property the original never had');
const withLocation = patchEvent(original, { LOCATION: 'LOCATION:Room 4' });
ok(withLocation.includes('LOCATION:Room 4'), 'a property absent from the original is added');
ok(withLocation.indexOf('LOCATION:Room 4') < withLocation.indexOf('BEGIN:VALARM'),
  'before any nested component — after BEGIN:VALARM it would belong to the alarm, not the event');
ok(parseCalendar(withLocation).events[0].location === 'Room 4', 'and reads back as the event\'s location');

console.log('removing one');
const noAlarmDesc = patchEvent(original, { 'X-MICROSOFT-CDO-BUSYSTATUS': null });
ok(!noAlarmDesc.includes('X-MICROSOFT-CDO-BUSYSTATUS'), 'null removes a property');
ok(noAlarmDesc.includes('X-ALT-DESC'), 'and leaves its neighbours alone');

console.log('editing ONE component of several');
const series = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:s', 'SUMMARY:Master', 'DTSTART:20260302T090000Z', 'RRULE:FREQ=WEEKLY', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:s', 'RECURRENCE-ID:20260309T090000Z', 'SUMMARY:Exception', 'DTSTART:20260309T140000Z', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
const onlyException = patchEvent(series, { SUMMARY: 'SUMMARY:Changed' }, {
  match: (e) => e.recurrenceId !== null,
});
const parsedSeries = parseCalendar(onlyException);
ok(parsedSeries.events[0].summary === 'Master', 'the master is untouched');
ok(parsedSeries.events[1].summary === 'Changed', 'and only the matched component changed');
ok(parsedSeries.events[1].rrule === null && parsedSeries.events[0].rrule === 'FREQ=WEEKLY',
  'each keeps its own recurrence — an exception has none and the master keeps its rule');

console.log('a VALARM inside the event is not mistaken for the event');
const alarmPatch = patchEvent(original, { DESCRIPTION: 'DESCRIPTION:Event notes' });
ok(alarmPatch.includes('DESCRIPTION:Event notes'), "the EVENT's description is set");
ok(alarmPatch.includes('DESCRIPTION:Reminder'),
  "and the ALARM's own DESCRIPTION is left alone — nesting, not a flat line scan");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
