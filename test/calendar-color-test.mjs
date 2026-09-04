// Hmelj — a per-event colour.
//
// It is NOT stored in the event. It was, as RFC 7986's COLOR property, which is
// the standard answer and works on a server that keeps what it is given —
// but Google's CalDAV re-serialises an event through Google's own model and
// drops it, and Microsoft and Exchange never stored iCalendar at all. Measured:
// an event saved with COLOR:#9e9e9e came back from Google minutes later as
// Google's own document, RRULE intact and COLOR gone. So Hmelj keeps it
// (server/calendarStore.js), which also makes it work on every backend rather
// than on the one nobody here uses.
//
// What is still asserted about COLOR is READING it: an event authored elsewhere
// on a server that does preserve the property should show that colour rather
// than ignore it.
//
// The guard is the part that earns a test on its own. An event's colour is
// interpolated straight into a `style` attribute in the browser
// (public/js/calendar.js#colorOf), and the value arrives from an iCalendar
// document somebody else's server handed over — so "is this a colour?" is a
// security question, not a tidiness one. normalizeEventColor answers it, and
// these assertions are what keep it answering.
//
// The rest is the same round-trip discipline calendar-write-test.mjs applies:
// a colour written must come back, an edit must not lose what it did not touch,
// and clearing must actually clear rather than silently keeping the old value.
//
//   node test/calendar-color-test.mjs
import { serializeCalendar, parseCalendar, patchEvent } from '../server/icalendar.js';
import { normalizeEventColor } from '../server/calendarWrite.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
const eq = (a, b, m) => ok(a === b, m, `got ${JSON.stringify(a)}`);

/** serialize → parse, which is the trip every created event actually makes.
 *  (serializeEvent hands back LINES; serializeCalendar is what folds and joins
 *  them into a document, and is what the write path actually calls.) */
const roundTrip = (ev) => parseCalendar(serializeCalendar(ev)).events[0];

const base = { uid: 'milk-1', summary: 'Mleko — veliko', start: Date.UTC(2026, 8, 2, 7, 0), end: Date.UTC(2026, 8, 2, 7, 15) };

console.log('the value guard (this one is the security boundary)');
eq(normalizeEventColor('#795548'), '#795548', 'a six-digit hex is a colour');
eq(normalizeEventColor('#FFF'), '#fff', 'so is a three-digit one, lowercased');
eq(normalizeEventColor('  #0B57D0  '), '#0b57d0', 'and it is trimmed');
eq(normalizeEventColor('cornflowerblue'), 'cornflowerblue', 'a bare CSS name — which is what RFC 7986 actually specifies');
eq(normalizeEventColor(''), null, 'empty is null: cleared, back to the calendar colour');
eq(normalizeEventColor(null), null, 'so is null itself');
eq(normalizeEventColor(undefined), null, 'and undefined');
console.log('  …and what must NOT get through:');
for (const bad of [
  'red;background:url(https://evil/x)',
  '#fff;position:fixed;top:0;left:0;width:100vw;height:100vh',
  'url(javascript:alert(1))',
  'expression(alert(1))',
  '#12345',            // neither 3 nor 6 digits
  '#gggggg',           // not hex
  'rgb(1,2,3)',        // parentheses — not worth allowing for what it buys
  '</style><script>',
]) {
  eq(normalizeEventColor(bad), null, `refused: ${JSON.stringify(bad)}`);
}
ok(!/[;(){}<>]/.test(normalizeEventColor('#0b57d0') || ''),
  'and nothing that survives can carry a style-attribute separator');

console.log('reading a colour somebody else wrote');
eq(roundTrip({ ...base, color: '#795548' }).color, '#795548',
  'a COLOR property in the document is still parsed — a CalDAV server that preserves it, or another client that sets it, is honoured');
eq(roundTrip({ ...base }).color, null, 'an event with no colour parses as null, not as a string');
ok(/^COLOR:#795548$/m.test(serializeCalendar({ ...base, color: '#795548' }).replace(/\r\n/g, '\n')),
  'and icalendar.js can still WRITE one — kept for the DAV server Hmelj publishes, which hands whole documents on');

console.log('editing');
{
  // A real event as some other client left it: properties Hmelj does not model,
  // and a colour it does.
  const stored = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Somebody Else//EN',
    'BEGIN:VEVENT', 'UID:trash-1', 'DTSTART:20260902T060000Z', 'DTEND:20260902T061500Z',
    'SUMMARY:Smeti — papir', 'COLOR:#0b57d0',
    'X-MICROSOFT-CDO-BUSYSTATUS:FREE', 'CATEGORIES:Dom',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');

  const recoloured = patchEvent(stored, { COLOR: 'COLOR:#f6bf26' });
  eq(parseCalendar(recoloured).events[0].color, '#f6bf26', 'an edit replaces the colour');
  ok(recoloured.includes('X-MICROSOFT-CDO-BUSYSTATUS:FREE'),
    'and leaves the properties it was not asked about — the whole reason patchEvent exists');
  ok((recoloured.match(/^COLOR:/gm) || []).length === 1, 'exactly one COLOR line, not two');

  const cleared = patchEvent(stored, { COLOR: null });
  eq(parseCalendar(cleared).events[0].color, null, 'a null patch REMOVES the colour rather than blanking it');
  ok(cleared.includes('CATEGORIES:Dom'), 'still without touching anything else');

  const added = patchEvent(
    stored.replace('COLOR:#0b57d0\r\n', ''),
    { COLOR: 'COLOR:#0f9d58' },
  );
  eq(parseCalendar(added).events[0].color, '#0f9d58', 'a colour can be added to an event that had none');
}

console.log('the colour Hmelj writes is NOT in the event');
// The whole point of the rework. An edit must leave the document exactly as
// free of COLOR as it found it, because the document is the provider's and the
// colour is not.
{
  const stored = serializeCalendar({ ...base, rrule: 'FREQ=DAILY;INTERVAL=4' });
  ok(!/^COLOR:/m.test(stored.replace(/\r\n/g, '\n')),
     'an event Hmelj creates carries no COLOR property of its own');
  ok(/^RRULE:/m.test(stored.replace(/\r\n/g, '\n')),
     'while everything that IS the provider\'s business still goes in');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
