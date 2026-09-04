// Editing and deleting a REPEATING event (server/calendarWrite.js).
//
// "Change this meeting" has three different answers when the meeting repeats,
// and each one writes a genuinely different document. Getting the wrong one is
// not a crash — it is next Tuesday quietly moving too, or a whole series
// vanishing when somebody meant to cancel one afternoon.
//
//   one      an EXCEPTION component sharing the UID, carrying RECURRENCE-ID
//   future   a SPLIT: the master gains an UNTIL, a NEW series carries on
//   all      the master itself
//
// planEdit and planDelete do no I/O at all, which is why they can be driven
// here directly and asserted on as documents rather than as screen state.
//
//   node test/calendar-scope-test.mjs
import { planEdit, planDelete, normalizeInput } from '../server/calendarWrite.js';
import { parseCalendar } from '../server/icalendar.js';
import { expand } from '../server/rrule.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const AT = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

/** A weekly Monday meeting, as another client would have written it — with a
 *  VTIMEZONE and an X- property Hmelj does not model, so every assertion about
 *  not destroying things has something real to protect. */
const SERIES = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other Client//EN',
  'BEGIN:VTIMEZONE', 'TZID:Europe/Ljubljana',
  'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT', 'UID:series-1', 'SUMMARY:Standup',
  'DTSTART;TZID=Europe/Ljubljana:20260302T090000',
  'DTEND;TZID=Europe/Ljubljana:20260302T091500',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'SEQUENCE:2', 'X-VENDOR-FLAG:keep-me',
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

const ONE_OFF = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:once-1', 'SUMMARY:Lunch', 'DTSTART:20260610T100000Z', 'DTEND:20260610T110000Z',
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

const next = (over = {}) => normalizeInput({
  summary: 'Standup', start: AT(2026, 3, 9, 13, 0), end: AT(2026, 3, 9, 13, 30),
  zone: 'Europe/Ljubljana', ...over,
});

const occurrencesOf = (doc, from, to) => {
  const ev = parseCalendar(doc).events.find((e) => !e.recurrenceId);
  if (!ev?.rrule) return [Date.parse(ev.start.iso)];
  const w = new Date(Date.parse(ev.start.iso));
  return expand({
    start: { y: 0, mo: 0, d: 0 }, // replaced below
    zone: ev.start.zone,
    rrule: ev.rrule,
  }, { from, to });
};

console.log('normalising what a client sent');
let n = normalizeInput({ summary: ' Meeting ', start: AT(2026, 1, 1, 9, 0) });
ok(n.summary === 'Meeting', 'the summary is trimmed');
ok(n.end === n.start + 3600000, 'an event with no end lasts an hour');
ok(normalizeInput({ start: AT(2026, 1, 1), allDay: true }).end === AT(2026, 1, 1) + 86400000,
  'and an all-day one lasts a day');
ok(normalizeInput({ start: AT(2026, 1, 1), allDay: true }).zone === null,
  'an all-day event has no zone, whatever was sent — that is what keeps Christmas on the 25th everywhere');
ok(normalizeInput({ start: AT(2026, 1, 1), end: AT(2025, 1, 1) }).end > AT(2026, 1, 1),
  'an end before the start is not accepted as one');
ok(normalizeInput({ start: AT(2026, 1, 1), attendees: ['a@b.example', { address: 'not-an-address' }] }).attendees.length === 1,
  'and an attendee without an address is dropped rather than written into the invitation');
let threw = false;
try { normalizeInput({ summary: 'x' }); } catch { threw = true; }
ok(threw, 'an event with no start is refused');

console.log("scope 'all' — the master itself");
let plan = planEdit({ scope: 'all', original: SERIES, occurrenceStart: AT(2026, 3, 9, 8, 0), next: next() });
ok(plan.documents.length === 1, 'one document');
let doc = plan.documents[0];
ok(doc.replaces === 'series-1', 'replacing the original resource');
let parsed = parseCalendar(doc.ical);
ok(parsed.events.length === 1 && !parsed.events[0].recurrenceId, 'still a single master');
ok(parsed.events[0].rrule === 'FREQ=WEEKLY;BYDAY=MO', 'with its rule intact');
ok(doc.ical.includes('X-VENDOR-FLAG:keep-me'), 'and the other client\'s own property untouched');
ok(doc.ical.includes('BEGIN:VTIMEZONE'), 'and its VTIMEZONE');
ok(parsed.events[0].sequence === 3, 'SEQUENCE went up — without it, attendees\' clients ignore the update',
  String(parsed.events[0].sequence));

console.log("scope 'one' — an exception, and nothing else moves");
plan = planEdit({ scope: 'one', original: SERIES, occurrenceStart: AT(2026, 3, 9, 8, 0), next: next() });
doc = plan.documents[0];
parsed = parseCalendar(doc.ical);
ok(parsed.events.length === 2, 'the resource now holds the master AND an exception', String(parsed.events.length));
const master = parsed.events.find((e) => !e.recurrenceId);
const exception = parsed.events.find((e) => e.recurrenceId);
ok(master.rrule === 'FREQ=WEEKLY;BYDAY=MO', 'the master keeps its rule, so next week is still next week');
ok(master.uid === exception.uid, 'both share the UID — that is what makes it an exception rather than a second event');
ok(Date.parse(exception.recurrenceId.iso) === AT(2026, 3, 9, 8, 0),
  'and the RECURRENCE-ID names the occurrence being replaced', exception.recurrenceId?.iso);
ok(Date.parse(exception.start.iso) === AT(2026, 3, 9, 13, 0), 'the exception carries the new time',
  exception.start?.iso);
ok(exception.rrule === null, 'and no rule of its own — it IS one occurrence, and a rule here would expand it twice');

console.log("scope 'future' — a split");
plan = planEdit({ scope: 'future', original: SERIES, occurrenceStart: AT(2026, 3, 9, 8, 0), next: next() });
ok(plan.documents.length === 2, 'two documents: the truncated original and a new series', String(plan.documents.length));
const [head, tail] = plan.documents;
ok(head.replaces === 'series-1' && tail.replaces === null, 'one replaces, one is created');
const headEv = parseCalendar(head.ical).events[0];
ok(/UNTIL=/.test(headEv.rrule), 'the original series is given an end', headEv.rrule);
ok(!/COUNT=/.test(headEv.rrule), 'and any COUNT it had is dropped — the two would contradict each other');
const tailEv = parseCalendar(tail.ical).events[0];
ok(tailEv.uid !== headEv.uid,
  'the continuation gets a NEW uid — sharing it would make every client read the second series as one exception');
ok(tailEv.rrule === 'FREQ=WEEKLY;BYDAY=MO', 'carrying the rule onward');
ok(Date.parse(tailEv.start.iso) === AT(2026, 3, 9, 13, 0), 'from the changed occurrence, at its new time');
// The two halves must not overlap: the old series has to stop before the new
// one starts, or the 9th appears twice.
const headOcc = expand({ start: { y: 2026, mo: 3, d: 2, h: 9, mi: 0, s: 0 }, zone: 'Europe/Ljubljana', rrule: headEv.rrule },
  { from: AT(2026, 1, 1), to: AT(2026, 6, 1) });
ok(headOcc.length === 1 && headOcc[0] === AT(2026, 3, 2, 8, 0),
  'the truncated series has exactly the occurrences before the split — one, the 2nd',
  headOcc.map((m) => new Date(m).toISOString()).join(','));

console.log("deleting: scope 'all' removes the resource");
let del = planDelete({ scope: 'all', original: SERIES, occurrenceStart: AT(2026, 3, 9, 8, 0) });
ok(del.deleteUid === 'series-1' && del.documents.length === 0, 'the whole thing goes');
ok(del.itipMethod === 'CANCEL', 'and attendees are told');

console.log("deleting: scope 'one' is an EXDATE, not a removal");
del = planDelete({ scope: 'one', original: SERIES, occurrenceStart: AT(2026, 3, 9, 8, 0) });
ok(del.deleteUid === null && del.documents.length === 1, 'the resource stays and is rewritten');
const exd = parseCalendar(del.documents[0].ical).events[0];
ok(exd.exdates.length === 1, 'with one EXDATE', String(exd.exdates.length));
ok(Date.parse(exd.exdates[0].iso) === AT(2026, 3, 9, 8, 0), 'naming the cancelled occurrence', exd.exdates[0]?.iso);
ok(exd.rrule === 'FREQ=WEEKLY;BYDAY=MO', 'and the series otherwise untouched');
// Cancelling a SECOND occurrence must not restore the first.
const twice = planDelete({ scope: 'one', original: del.documents[0].ical, occurrenceStart: AT(2026, 3, 16, 8, 0) });
const exd2 = parseCalendar(twice.documents[0].ical).events[0];
ok(exd2.exdates.length === 2,
  'cancelling a second occurrence keeps the first cancelled — an EXDATE is appended, never replaced',
  String(exd2.exdates.length));

console.log("deleting: scope 'future' ends the series");
del = planDelete({ scope: 'future', original: SERIES, occurrenceStart: AT(2026, 3, 16, 8, 0) });
const cut = parseCalendar(del.documents[0].ical).events[0];
ok(del.deleteUid === null, 'nothing is removed outright');
ok(/UNTIL=/.test(cut.rrule), 'the rule gains an UNTIL', cut.rrule);
const left = expand({ start: { y: 2026, mo: 3, d: 2, h: 9, mi: 0, s: 0 }, zone: 'Europe/Ljubljana', rrule: cut.rrule },
  { from: AT(2026, 1, 1), to: AT(2026, 6, 1) });
ok(left.length === 2, 'leaving exactly the occurrences before the cut', left.map((m) => new Date(m).toISOString().slice(0, 10)).join(','));
ok(left.every((m) => m < AT(2026, 3, 16, 8, 0)), 'and none on or after it');

console.log('a one-off event has no scope to choose');
plan = planEdit({ scope: 'one', original: ONE_OFF, occurrenceStart: AT(2026, 6, 10, 10, 0), next: next({ summary: 'Lunch out' }) });
ok(plan.documents.length === 1, 'one document whatever scope was asked for');
ok(parseCalendar(plan.documents[0].ical).events.length === 1,
  'and it stays one component — an exception to a non-repeating event is meaningless');
ok(parseCalendar(plan.documents[0].ical).events[0].summary === 'Lunch out', 'edited in place');
del = planDelete({ scope: 'one', original: ONE_OFF, occurrenceStart: AT(2026, 6, 10, 10, 0) });
ok(del.deleteUid === 'once-1', 'and deleting one occurrence of it deletes it');

console.log('bad input');
threw = false;
try { planEdit({ scope: 'nonsense', original: SERIES, occurrenceStart: 1, next: next() }); } catch (e) { threw = e.status === 400; }
ok(threw, 'an unknown scope is refused with a 400');
threw = false;
try { planEdit({ scope: 'all', original: 'not a calendar', occurrenceStart: 1, next: next() }); } catch (e) { threw = e.status === 409; }
ok(threw, 'and a document that will not parse is a conflict, not a crash');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
