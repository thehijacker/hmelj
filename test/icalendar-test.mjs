// Reading a meeting invitation out of a message (server/icalendar.js).
//
// The shapes here are the ones Exchange, Google Calendar and iTIP senders
// actually emit, not the ones RFC 5545 makes most convenient to parse. The two
// that matter most, because getting either wrong moves a meeting: the value of
// a property is everything after the first UNQUOTED colon (Exchange writes
// TZID="GMT+01:00 Sarajevo"), and a Windows zone name is not something Intl
// knows.
//
//   node test/icalendar-test.mjs
import {
  parseInvitation, parseLine, parseDate, parseDuration, unfold, unescapeText, ianaZone, isActionable,
} from '../server/icalendar.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
const ics = (...lines) => ['BEGIN:VCALENDAR', ...lines, 'END:VCALENDAR'].join('\r\n');
const event = (...lines) => ics('METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:u1', ...lines, 'END:VEVENT');

console.log('content lines');
let l = parseLine('DTSTART;TZID="GMT+01:00 Sarajevo":20260827T140000');
ok(l.name === 'DTSTART', 'name');
ok(l.params.TZID === 'GMT+01:00 Sarajevo', 'a quoted parameter keeps its own colons', l.params.TZID);
ok(l.value === '20260827T140000', 'and the value is what follows the first UNQUOTED colon', l.value);
ok(parseLine('SUMMARY:no params').value === 'no params', 'a line with no parameters');
ok(parseLine('NOCOLON') === null, 'a line that is not a content line at all');
ok(parseLine('ORGANIZER;CN=Novak, Janez:mailto:j@x.si').value === 'mailto:j@x.si', 'a comma inside an unquoted parameter');

console.log('folding and escaping');
ok(unfold('LOCATION:Sejna\r\n  soba') === 'LOCATION:Sejna soba', 'a folded line is rejoined (the leading space is the fold marker)');
ok(unescapeText('Sejna soba 2\\, 1. nadstropje') === 'Sejna soba 2, 1. nadstropje', 'an escaped comma');
ok(unescapeText('one\\ntwo') === 'one\ntwo', 'an escaped newline');
ok(unescapeText('a\\\\b') === 'a\\b', 'an escaped backslash');

console.log('times');
ok(parseDate('20260827T132200Z').iso === '2026-08-27T13:22:00.000Z', 'a UTC time is exactly itself');
ok(parseDate('20260827').allDay === true, 'a date with no time is an all-day event');
ok(parseDate('20260827T140000', { VALUE: 'DATE' }).allDay === true, 'and so is one that says VALUE=DATE');
// August is CEST (UTC+2), so 14:00 local is 12:00Z. A parser that ignored the
// zone would say 14:00Z and put the meeting two hours late.
ok(parseDate('20260827T140000', { TZID: 'Europe/Ljubljana' }).iso === '2026-08-27T12:00:00.000Z',
  'an IANA zone resolves to a real instant, DST included', parseDate('20260827T140000', { TZID: 'Europe/Ljubljana' }).iso);
ok(parseDate('20260115T140000', { TZID: 'Europe/Ljubljana' }).iso === '2026-01-15T13:00:00.000Z',
  'and the same zone in January is one hour, not two — the offset is read at the event, not now');
// The reason WINDOWS_ZONES exists at all: this is what Exchange writes.
ok(ianaZone('W. Europe Standard Time') === 'Europe/Berlin', "Exchange's Windows zone names are mapped");
ok(parseDate('20260827T140000', { TZID: '"W. Europe Standard Time"' }).iso === '2026-08-27T12:00:00.000Z',
  'including when the name arrives quoted');
// The refusal, and why it is a refusal: converting on a guess moves a meeting.
const floating = parseDate('20260827T140000', { TZID: 'Middle-earth Standard Time' });
ok(floating.floating === true, 'a zone nothing can resolve is reported as floating, never converted');
ok(floating.iso === '2026-08-27T14:00:00', 'the wall clock is preserved exactly as written');
ok(floating.zone === 'Middle-earth Standard Time', 'and the zone is carried through so the pane can name it');
ok(parseDate('nonsense') === null, 'something that is not a date at all');

console.log('duration');
ok(parseDuration('PT1H30M') === 5400000, 'an hour and a half');
ok(parseDuration('P1D') === 86400000, 'a day');
ok(parseDuration('PT0S') === null && parseDuration('') === null, 'nothing, and zero, are both "no duration"');

console.log('a real Exchange invitation');
const inv = parseInvitation(ics(
  'METHOD:REQUEST',
  'BEGIN:VTIMEZONE', 'TZID:W. Europe Standard Time', 'BEGIN:STANDARD', 'DTSTART:16011028T030000', 'END:STANDARD', 'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:040000008200E00074C5B7101A82E008@example.com',
  'SUMMARY:check programi',
  'LOCATION:Sejna soba 2\\, 1. nadstropje',
  'DESCRIPTION:Preverimo\\, kateri programi manjkajo.',
  'DTSTART;TZID="W. Europe Standard Time":20260827T140000',
  'DTEND;TZID="W. Europe Standard Time":20260827T150000',
  'ORGANIZER;CN="Janez Novak":mailto:janez@example.com',
  'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN="Maja Kovač":mailto:maja.kovac@example.com',
  'ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED;CN="Peter":mailto:peter@acme.example',
  'SEQUENCE:0',
  'END:VEVENT',
));
ok(inv.method === 'REQUEST', 'the METHOD is read from the VCALENDAR, outside the event');
ok(inv.summary === 'check programi', 'summary');
ok(inv.location === 'Sejna soba 2, 1. nadstropje', 'location, unescaped');
ok(inv.start.iso === '2026-08-27T12:00:00.000Z' && inv.end.iso === '2026-08-27T13:00:00.000Z', 'start and end as real instants');
ok(inv.organizer.name === 'Janez Novak' && inv.organizer.address === 'janez@example.com', 'the organizer, with the mailto: stripped');
ok(inv.attendees.length === 2, 'both attendees');
ok(inv.attendees[0].status === 'NEEDS-ACTION' && inv.attendees[0].rsvp === true, 'who has not answered yet');
ok(inv.attendees[1].optional === true, 'and who is optional');
// A VTIMEZONE contains its own DTSTART. Taking it would date the meeting to
// 1601, which is exactly the kind of thing a naive scan does.
ok(!String(inv.start.iso).startsWith('1601'), "the VTIMEZONE's own DTSTART is not mistaken for the event's");
ok(isActionable(inv), 'an invitation can be answered');

console.log('the other three kinds of calendar message');
const cancel = parseInvitation(event('SUMMARY:x', 'DTSTART:20260827T120000Z', 'STATUS:CANCELLED'));
ok(!isActionable(cancel), 'a cancelled event is news, not something to accept');
const cancelMethod = parseInvitation(ics('METHOD:CANCEL', 'BEGIN:VEVENT', 'UID:u', 'SUMMARY:x', 'END:VEVENT'));
ok(cancelMethod.method === 'CANCEL' && !isActionable(cancelMethod), 'and neither is a withdrawal');
const reply = parseInvitation(ics('METHOD:REPLY', 'BEGIN:VEVENT', 'UID:u', 'ATTENDEE;PARTSTAT=DECLINED:mailto:a@b.si', 'END:VEVENT'));
ok(reply.method === 'REPLY' && !isActionable(reply), "somebody else's answer to YOUR invitation is not answerable");
ok(reply.attendees[0].status === 'DECLINED', 'and it carries their answer');

console.log('duration instead of an end, and recurrence');
const dur = parseInvitation(event('DTSTART:20260827T120000Z', 'DURATION:PT45M'));
ok(dur.end.iso === '2026-08-27T12:45:00.000Z', 'an event that gives a length instead of an end');
ok(parseInvitation(event('DTSTART:20260827T120000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TH')).recurrence === 'FREQ=WEEKLY;BYDAY=TH',
  'a recurring meeting is flagged as one — expanding it is a calendar\'s job, not this one\'s');

console.log('a recurring meeting with an exception');
// The exception occurrence follows the master in the same file. Reading its
// fields would describe a different day than the invitation is for.
const master = parseInvitation(ics('METHOD:REQUEST',
  'BEGIN:VEVENT', 'UID:u', 'SUMMARY:Weekly', 'DTSTART:20260827T120000Z', 'RRULE:FREQ=WEEKLY', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:u', 'RECURRENCE-ID:20260903T120000Z', 'SUMMARY:Moved', 'DTSTART:20260903T140000Z', 'END:VEVENT'));
ok(master.summary === 'Weekly' && master.start.iso === '2026-08-27T12:00:00.000Z',
  'the first VEVENT is the one described', master.summary);

console.log('what is not an invitation');
ok(parseInvitation('') === null && parseInvitation(null) === null, 'nothing');
ok(parseInvitation('Dear Andrej, see you at 2.') === null, 'an ordinary message body');
ok(parseInvitation(ics('METHOD:REQUEST')) === null, 'a calendar with no event in it');
ok(parseInvitation(ics('BEGIN:VEVENT', 'UID:u', 'SUMMARY:x', 'END:VEVENT')).method === 'PUBLISH',
  'an event with no METHOD is a published event, not an invitation');
ok(!isActionable(parseInvitation(ics('BEGIN:VEVENT', 'UID:u', 'END:VEVENT'))), 'and cannot be answered');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
