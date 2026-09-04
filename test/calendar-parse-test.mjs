// Reading a whole calendar file (server/icalendar.js#parseCalendar).
//
// test/icalendar-test.mjs already covers the invitation half — one event, read
// out of a message. This covers what a CalDAV collection actually contains and
// what the invitation reader never had to handle: several events per file,
// VALARMs, recurrence rules with their exception dates, and a recurring series
// whose individual occurrences have been edited.
//
// The assertion worth reading twice is the RECURRENCE-ID one. A component with
// a RECURRENCE-ID is an EXCEPTION replacing one occurrence of the master; a
// component without one IS the master. Getting that backwards shows every
// edited occurrence twice — once from the rule, once from the exception — which
// is the most common visible bug in calendar clients.
//
//   node test/calendar-parse-test.mjs
import { parseCalendar, parseComponents, parseInvitation, wallToInstant, dayKey } from '../server/icalendar.js';
import { expand } from '../server/rrule.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
const cal = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];

console.log('the component tree');
const tree = parseComponents(cal(...vevent('UID:a', 'SUMMARY:x', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM')));
const vcal = tree.children[0];
ok(vcal.name === 'VCALENDAR' && vcal.children.length === 1, 'a VCALENDAR holding one VEVENT');
ok(vcal.children[0].children[0].name === 'VALARM', 'and the VEVENT holding its VALARM — nesting, not a depth counter');
ok(parseComponents('BEGIN:VEVENT\r\nUID:x').children[0].props.length === 1,
  'an unterminated component is closed at end of input rather than lost');
ok(parseComponents('END:VEVENT\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR').children.length === 1,
  'and a stray END closes nothing');

console.log('several events in one file');
let c = parseCalendar(cal(
  ...vevent('UID:a', 'SUMMARY:First', 'DTSTART:20260901T090000Z', 'DTEND:20260901T100000Z'),
  ...vevent('UID:b', 'SUMMARY:Second', 'DTSTART:20260902T090000Z', 'DURATION:PT30M'),
  ...vevent('UID:c', 'SUMMARY:All day', 'DTSTART;VALUE=DATE:20260903'),
));
ok(c.events.length === 3, 'a CalDAV collection is many events per file, not one', String(c.events.length));
ok(c.events[0].summary === 'First' && c.events[1].uid === 'b', 'in document order');
ok(c.events[1].end.iso === '2026-09-02T09:30:00.000Z', 'DURATION becomes an end', c.events[1].end?.iso);
ok(c.events[2].allDay === true && c.events[2].start.iso === '2026-09-03', 'an all-day event is a DATE, not a midnight');
ok(c.method === 'PUBLISH', 'a calendar with no METHOD is a published one');
ok(parseCalendar('nonsense') === null && parseCalendar('') === null, 'and something that is not a calendar is null');

console.log('what a parser must NOT drop');
// An iTIP CANCEL or REPLY carries a UID and little else. Filtering out
// start-less events broke exactly these, and a withdrawn meeting became
// unreadable in the reading pane.
c = parseCalendar(cal('METHOD:CANCEL', ...vevent('UID:gone', 'SUMMARY:Called off')));
ok(c.events.length === 1 && c.events[0].start === null,
  'an event with no DTSTART is reported with start:null, not dropped — the calendar layer decides what to do with it');
ok(parseInvitation(cal('METHOD:CANCEL', ...vevent('UID:gone'))).method === 'CANCEL',
  'which is what keeps the invitation reader working');

console.log('alarms');
c = parseCalendar(cal(...vevent('UID:a', 'DTSTART:20260901T090000Z',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:Soon', 'END:VALARM',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;RELATED=END:-PT5M', 'END:VALARM',
  'BEGIN:VALARM', 'ACTION:EMAIL', 'TRIGGER:-P1D', 'END:VALARM')));
let alarms = c.events[0].alarms;
ok(alarms.length === 2, 'an EMAIL alarm is left out — the server sends those, and firing our own would double them',
  String(alarms.length));
ok(alarms[0].minutesBefore === 15, 'a negative TRIGGER duration reads as "15 minutes before"', String(alarms[0].minutesBefore));
ok(alarms[0].related === 'START' && alarms[1].related === 'END',
  'and RELATED=END is kept — measured from the wrong end, a reminder on a two-hour meeting is two hours out');
c = parseCalendar(cal(...vevent('UID:a', 'DTSTART:20260901T090000Z',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;VALUE=DATE-TIME:20260901T083000Z', 'END:VALARM')));
ok(c.events[0].alarms[0].absolute?.iso === '2026-09-01T08:30:00.000Z' && c.events[0].alarms[0].minutesBefore === null,
  'an absolute TRIGGER is an instant, not an offset', c.events[0].alarms[0].absolute?.iso);

console.log('recurrence, read but not expanded');
c = parseCalendar(cal(...vevent('UID:r', 'SUMMARY:Standup',
  'DTSTART;TZID=Europe/Ljubljana:20260302T090000',
  'DTEND;TZID=Europe/Ljubljana:20260302T091500',
  'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6',
  'EXDATE;TZID=Europe/Ljubljana:20260316T090000',
  'RDATE;TZID=Europe/Ljubljana:20260320T140000')));
let ev = c.events[0];
ok(ev.rrule === 'FREQ=WEEKLY;BYDAY=MO;COUNT=6', 'the RRULE is kept as written — expansion is rrule.js\'s job');
ok(ev.exdates.length === 1 && ev.rdates.length === 1, 'EXDATE and RDATE are resolved to instants');
ok(ev.start.zone === 'Europe/Ljubljana', 'and the zone travels with the start');
// End to end: the parser's output feeds the expander directly. This is the join
// that has to work, and it crosses a DST boundary on the way.
const occ = expand({
  start: { y: 2026, mo: 3, d: 2, h: 9, mi: 0, s: 0 },
  zone: ev.start.zone,
  rrule: ev.rrule,
  exdates: ev.exdates.map((d) => new Date(d.iso).getTime()),
  rdates: ev.rdates.map((d) => new Date(d.iso).getTime()),
}, { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 11, 1) });
ok(occ.length === 6, 'six occurrences: five Mondays left after the EXDATE, plus the RDATE', String(occ.length));
ok(!occ.some((ms) => dayKey(ms, 'Europe/Ljubljana') === '2026-03-16'), 'the excluded Monday is gone');
ok(occ.some((ms) => dayKey(ms, 'Europe/Ljubljana') === '2026-03-20'), 'and the extra Friday is there');
ok(new Date(occ[0]).toISOString() === '2026-03-02T08:00:00.000Z', 'the 2nd is CET (UTC+1)', new Date(occ[0]).toISOString());
ok(new Date(occ.filter((m) => dayKey(m, 'Europe/Ljubljana') === '2026-03-30')[0]).toISOString() === '2026-03-30T07:00:00.000Z',
  'and the 30th is CEST (UTC+2) — same clock, an hour earlier in UTC');

console.log('a series with edited occurrences');
c = parseCalendar(cal(
  ...vevent('UID:s', 'SUMMARY:Weekly', 'DTSTART:20260302T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=4'),
  ...vevent('UID:s', 'SUMMARY:Weekly (moved)', 'RECURRENCE-ID:20260309T090000Z', 'DTSTART:20260309T140000Z'),
  ...vevent('UID:s', 'SUMMARY:Weekly', 'RECURRENCE-ID:20260316T090000Z', 'STATUS:CANCELLED', 'DTSTART:20260316T090000Z'),
));
ok(c.events.length === 3, 'master and both exceptions arrive together, in one file');
ok(c.events[0].recurrenceId === null, 'the component WITHOUT a RECURRENCE-ID is the master');
ok(c.events[1].recurrenceId?.iso === '2026-03-09T09:00:00.000Z',
  'and one WITH it names the occurrence it replaces', c.events[1].recurrenceId?.iso);
ok(c.events[1].start.iso === '2026-03-09T14:00:00.000Z', 'the exception carries its own, moved, start');
ok(c.events.every((e) => e.uid === 's'), 'all three share the UID — the RECURRENCE-ID is what tells them apart');
ok(c.events[2].status === 'CANCELLED', 'and a cancelled occurrence is an exception too, not a deletion');

console.log('a time zone Intl does not know, declared in the file');
// Exchange writes "Customized Time Zone" with its own VTIMEZONE. Intl cannot
// place it, so without reading the file's own declaration the time would fall
// back to floating — shown as written, an hour or two out for the reader.
c = parseCalendar(cal(
  'BEGIN:VTIMEZONE', 'TZID:Customized Time Zone',
  'BEGIN:STANDARD', 'DTSTART:16010101T000000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0100', 'END:STANDARD',
  'END:VTIMEZONE',
  ...vevent('UID:x', 'DTSTART;TZID=Customized Time Zone:20260115T140000'),
));
ok(c.events[0].start.floating === false, 'the file\'s own offset is used rather than giving up');
ok(c.events[0].start.iso === '2026-01-15T13:00:00.000Z', '14:00 at +01:00 is 13:00Z', c.events[0].start.iso);
ok(c.events[0].start.fromVtimezone === true, 'and it says where that came from');

// Two observances means DST, and choosing between them needs their RRULEs
// evaluated. A 50/50 guess moves half the year's meetings by an hour, which is
// worse than the honest "shown as written, zone named" a floating time gets.
c = parseCalendar(cal(
  'BEGIN:VTIMEZONE', 'TZID:Another Custom Zone',
  'BEGIN:STANDARD', 'DTSTART:16011028T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:16010325T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'END:DAYLIGHT',
  'END:VTIMEZONE',
  ...vevent('UID:x', 'DTSTART;TZID=Another Custom Zone:20260715T140000'),
));
ok(c.events[0].start.floating === true, 'a zone WITH daylight saving is left floating rather than guessed at');
ok(c.events[0].start.zone === 'Another Custom Zone', 'with its name carried, so the UI can say so');

console.log('a real Windows zone name still resolves');
c = parseCalendar(cal(...vevent('UID:x', 'DTSTART;TZID=W. Europe Standard Time:20260715T140000')));
ok(c.events[0].start.iso === '2026-07-15T12:00:00.000Z',
  'the Windows-name table still applies — July is CEST, so 14:00 is 12:00Z', c.events[0].start.iso);

console.log('other fields');
c = parseCalendar(cal(...vevent('UID:x', 'DTSTART:20260901T090000Z', 'TRANSP:TRANSPARENT',
  'CATEGORIES:Work,Travel', 'URL:https://example.com/m', 'LOCATION:Sejna soba 2\\, 1. nadstropje')));
ev = c.events[0];
ok(ev.transparent === true, 'TRANSP=TRANSPARENT means on the calendar but not blocking');
ok(JSON.stringify(ev.categories) === '["Work","Travel"]', 'CATEGORIES is a list');
ok(ev.location === 'Sejna soba 2, 1. nadstropje', 'and an escaped comma survives into the location');
ok(parseCalendar(cal(...vevent('UID:x', 'DTSTART:20260901T090000Z'))).events[0].transparent === false,
  'with no TRANSP the default is OPAQUE — the time is busy');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
