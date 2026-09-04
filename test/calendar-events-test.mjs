// The calendar read path (server/calendarEvents.js + the cache tables).
//
// This is where stored components, recurrence rules and per-occurrence
// exceptions are reconciled into "what is on my calendar this month". Two of
// the assertions below stand for the most visible bug a calendar client can
// have, and one for the least visible:
//
//   - an edited occurrence must appear ONCE, at its moved time, not twice;
//   - a cancelled occurrence must appear NOT AT ALL, and must not leave the
//     original in its place;
//   - an all-day event must be on the same date for every viewer, which means
//     it is the one thing NOT read in the viewer's zone.
//
//   node test/calendar-events-test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';

// Before any import that reaches config.js — it resolves DATA_DIR once, at
// module evaluation, and dotenv does not override an already-set variable.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-cal-'));
process.env.DATA_DIR = TMP;
process.env.CACHE_DIR = TMP;
process.env.HMELJ_SECRET = 'test-secret-not-a-real-one';
process.env.LOG = process.env.LOG || 'warn';

const cache = await import('../server/cache.js');
const { occurrencesIn, eventDetail } = await import('../server/calendarEvents.js');
const { parseCalendar, wallToInstant, dayKey } = await import('../server/icalendar.js');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const UK = 'tester-abcd1234';
const CAL = 'cal-1';
const SRC = 'src-1';
const ics = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];

/** Stores an .ics exactly the way server/calendar/index.js does — every
 *  component in it, keyed by uid + recurrence-id, sharing one href. */
function store(href, text) {
  const cal = parseCalendar(text);
  cache.deleteCalendarHref(UK, 'src-1', CAL, href);
  const rows = cal.events.filter((e) => e.start && e.uid).map((ev) => {
    const zone = ev.allDay ? 'UTC' : (ev.start.zone || 'UTC');
    const at = (d) => {
      if (!d) return null;
      if (d.allDay) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d.iso); return Date.UTC(+m[1], +m[2] - 1, +m[3]); }
      return Date.parse(d.iso);
    };
    return {
      user_key: UK, source_id: SRC, calendar_id: CAL,
      uid: ev.uid, recurrence_id: ev.recurrenceId ? String(at(ev.recurrenceId)) : '',
      href, etag: '"1"',
      dtstart_ms: at(ev.start), dtend_ms: at(ev.end), all_day: ev.allDay ? 1 : 0,
      until_ms: null, rrule: ev.rrule || null, summary: ev.summary,
      json: JSON.stringify(ev), ical: text, updated_at: Date.now(),
    };
  });
  cache.upsertCalendarEvents(rows);
  return rows.length;
}

const between = (fromIso, toIso, opts = {}) =>
  occurrencesIn(UK, [CAL], Date.parse(fromIso), Date.parse(toIso), { timezone: 'Europe/Ljubljana', ...opts });

try {
  console.log('a one-off event');
  store('/c/one.ics', ics(...vevent('UID:one', 'SUMMARY:Lunch',
    'DTSTART;TZID=Europe/Ljubljana:20260610T120000', 'DTEND;TZID=Europe/Ljubljana:20260610T130000')));
  let got = between('2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z');
  ok(got.length === 1 && got[0].summary === 'Lunch', 'is one occurrence', String(got.length));
  ok(got[0].start === Date.parse('2026-06-10T10:00:00Z'), '12:00 in Ljubljana is 10:00Z in June (CEST)',
    new Date(got[0].start).toISOString());
  ok(got[0].day === '2026-06-10', 'and belongs to the 10th');
  ok(got[0].end - got[0].start === 3600000, 'lasting an hour');
  ok(between('2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z').length === 0, 'and is not in July');

  console.log('every occurrence carries the SERIES rule');
  // The edit form is opened from the LIST, and it reads `rrule` off the row to
  // decide what the Repeats dropdown shows. When the list did not carry it,
  // every repeating event opened saying "Does not repeat" — and saving that
  // sent rrule:null, which is an instruction to REMOVE the recurrence. An edit
  // meant to change a colour could flatten a whole series, silently, and report
  // "Event saved".
  store('/c/milk.ics', ics(...vevent('UID:milk', 'SUMMARY:Mleko malo',
    'DTSTART;VALUE=DATE:20260903', 'DTEND;VALUE=DATE:20260904', 'RRULE:FREQ=DAILY;INTERVAL=4')));
  {
    const milk = between('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z').filter((e) => e.summary === 'Mleko malo');
    ok(milk.length > 1, 'the series expands', String(milk.length));
    ok(milk.every((e) => e.rrule === 'FREQ=DAILY;INTERVAL=4'),
       'and EVERY occurrence states the rule, not just the first', JSON.stringify(milk[1]?.rrule));
    ok(milk.every((e) => e.recurring === true), 'and knows it is part of a series');
    ok(milk.every((e) => e.color === ''), 'with no colour of its own until one is set');
  }

  console.log('the count Settings shows beside a calendar');
  // It used to be `rows.length` from the last sync PASS — the delta, not the
  // total. A calendar synced once and never changed kept a correct-looking
  // number; every calendar that saw an incremental poll dropped to "how many
  // items changed last time". Observed live: a calendar holding 148 events
  // reporting 1, and one holding 3 reporting 1.
  {
    // Relative rather than absolute, so adding a fixture above this line cannot
    // break it: one new event moves the count by exactly one.
    const before = cache.calendarEventCount(UK, SRC, CAL);
    store('/c/counted.ics', ics(...vevent('UID:counted', 'SUMMARY:Counted',
      'DTSTART;VALUE=DATE:20260915', 'DTEND;VALUE=DATE:20260916')));
    ok(cache.calendarEventCount(UK, SRC, CAL) === before + 1,
       'counts what the calendar HOLDS, not what the last sync fetched',
       `${before} -> ${cache.calendarEventCount(UK, SRC, CAL)}`);
  }
  {
    // A series is ONE event however many occurrences it has — which is the
    // distinction that matters on Microsoft and Exchange, where the cache holds
    // one row per expanded occurrence.
    const before = cache.calendarEventCount(UK, SRC, CAL);
    store('/c/exception.ics', ics(
      ...vevent('UID:milk', 'SUMMARY:Mleko malo', 'DTSTART;VALUE=DATE:20260907',
        'DTEND;VALUE=DATE:20260908', 'RECURRENCE-ID;VALUE=DATE:20260907')));
    ok(cache.calendarEventCount(UK, SRC, CAL) === before,
       'and an exception to a series is not a second event');
  }

  console.log('the window is an OVERLAP test, not containment');
  store('/c/long.ics', ics(...vevent('UID:long', 'SUMMARY:Conference',
    'DTSTART:20260610T080000Z', 'DTEND:20260614T170000Z')));
  ok(between('2026-06-12T00:00:00Z', '2026-06-13T00:00:00Z').some((e) => e.uid === 'long'),
    'a multi-day event seen from its MIDDLE is in the window — containment would hide it');
  ok(between('2026-06-01T00:00:00Z', '2026-06-11T00:00:00Z').some((e) => e.uid === 'long'),
    'and so is one that started before the window and is still running');
  cache.deleteCalendarHref(UK, 'src-1', CAL, '/c/long.ics');

  console.log('a recurring series');
  store('/c/weekly.ics', ics(...vevent('UID:weekly', 'SUMMARY:Standup',
    'DTSTART;TZID=Europe/Ljubljana:20260302T090000',
    'DTEND;TZID=Europe/Ljubljana:20260302T091500',
    'RRULE:FREQ=WEEKLY;BYDAY=MO')));
  got = between('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z').filter((e) => e.uid === 'weekly');
  ok(got.length === 5, 'five Mondays in March 2026', String(got.length));
  ok(got.every((e) => e.recurring === true), 'each knows it is part of a series');
  ok(new Set(got.map((e) => e.id)).size === 5, 'and each occurrence has its own id, so a list can key on them');
  // The DST boundary falls inside this month.
  ok(got[0].start === Date.parse('2026-03-02T08:00:00Z'), '2 March 09:00 local is 08:00Z (CET)',
    new Date(got[0].start).toISOString());
  ok(got.at(-1).start === Date.parse('2026-03-30T07:00:00Z'), '30 March 09:00 local is 07:00Z (CEST) — same clock, an hour earlier',
    new Date(got.at(-1).start).toISOString());
  ok(got.every((e) => e.day.startsWith('2026-03')), 'and every one of them is on a March day');

  console.log('AN EDITED OCCURRENCE APPEARS ONCE');
  // The master says every Monday at 09:00; one Monday was moved to 14:00.
  // Expanding the master AND emitting the exception shows that week twice — at
  // 09:00 where the rule puts it and at 14:00 where it is. That is the single
  // most visible bug a calendar client can have.
  store('/c/weekly.ics', ics(
    ...vevent('UID:weekly', 'SUMMARY:Standup',
      'DTSTART;TZID=Europe/Ljubljana:20260302T090000',
      'DTEND;TZID=Europe/Ljubljana:20260302T091500',
      'RRULE:FREQ=WEEKLY;BYDAY=MO'),
    ...vevent('UID:weekly', 'SUMMARY:Standup (moved)',
      'RECURRENCE-ID;TZID=Europe/Ljubljana:20260309T090000',
      'DTSTART;TZID=Europe/Ljubljana:20260309T140000',
      'DTEND;TZID=Europe/Ljubljana:20260309T143000'),
  ));
  got = between('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z').filter((e) => e.uid === 'weekly');
  ok(got.length === 5, 'still five occurrences — the exception REPLACES one, it does not add one', String(got.length));
  const ninth = got.filter((e) => e.day === '2026-03-09');
  ok(ninth.length === 1, 'and the edited Monday appears exactly once', String(ninth.length));
  ok(ninth[0].summary === 'Standup (moved)' && ninth[0].start === Date.parse('2026-03-09T13:00:00Z'),
    'at its moved time, with its own summary', new Date(ninth[0].start).toISOString());
  ok(ninth[0].end - ninth[0].start === 1800000, 'and its own length');

  console.log('A CANCELLED OCCURRENCE APPEARS NOT AT ALL');
  store('/c/weekly.ics', ics(
    ...vevent('UID:weekly', 'SUMMARY:Standup',
      'DTSTART;TZID=Europe/Ljubljana:20260302T090000', 'DTEND;TZID=Europe/Ljubljana:20260302T091500',
      'RRULE:FREQ=WEEKLY;BYDAY=MO'),
    ...vevent('UID:weekly', 'SUMMARY:Standup', 'STATUS:CANCELLED',
      'RECURRENCE-ID;TZID=Europe/Ljubljana:20260316T090000',
      'DTSTART;TZID=Europe/Ljubljana:20260316T090000'),
  ));
  got = between('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z').filter((e) => e.uid === 'weekly');
  ok(got.length === 4, 'four left', String(got.length));
  ok(!got.some((e) => e.day === '2026-03-16'),
    'and the cancelled Monday is a hole — the master must not fill it back in');

  console.log('EXDATE');
  store('/c/ex.ics', ics(...vevent('UID:ex', 'SUMMARY:Gym',
    'DTSTART;TZID=Europe/Ljubljana:20260302T070000', 'DTEND;TZID=Europe/Ljubljana:20260302T080000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=Europe/Ljubljana:20260309T070000')));
  got = between('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z').filter((e) => e.uid === 'ex');
  ok(got.length === 4 && !got.some((e) => e.day === '2026-03-09'),
    'an EXDATE removes the occurrence, and the instant it names has to match exactly',
    got.map((e) => e.day).join(','));

  console.log('all-day events are the ONE thing not read in the viewer\'s zone');
  store('/c/xmas.ics', ics(...vevent('UID:xmas', 'SUMMARY:Christmas', 'DTSTART;VALUE=DATE:20261225')));
  const ljubljana = between('2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z', { timezone: 'Europe/Ljubljana' })
    .find((e) => e.uid === 'xmas');
  const auckland = between('2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z', { timezone: 'Pacific/Auckland' })
    .find((e) => e.uid === 'xmas');
  const anchorage = between('2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z', { timezone: 'America/Anchorage' })
    .find((e) => e.uid === 'xmas');
  ok(ljubljana?.day === '2026-12-25', 'the 25th in Ljubljana');
  ok(auckland?.day === '2026-12-25', 'the 25th in Auckland — twelve hours ahead');
  ok(anchorage?.day === '2026-12-25', 'and the 25th in Anchorage — eleven hours behind');
  ok(ljubljana.allDay === true, 'because it is marked all-day, which is what tells the UI to format it without a zone');
  ok(ljubljana.end - ljubljana.start === 86400000, 'and an all-day event with no end lasts one day');

  console.log('a timed event near midnight IS read in the viewer\'s zone');
  store('/c/late.ics', ics(...vevent('UID:late', 'SUMMARY:Late call', 'DTSTART:20260610T230000Z', 'DTEND:20260610T233000Z')));
  const inLj = between('2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z', { timezone: 'Europe/Ljubljana' }).find((e) => e.uid === 'late');
  const inUtc = between('2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z', { timezone: 'UTC' }).find((e) => e.uid === 'late');
  ok(inUtc.day === '2026-06-10' && inLj.day === '2026-06-11',
    '23:00Z is the 10th in UTC and already the 11th in Ljubljana — which is the whole reason `day` is computed on the server',
    `${inUtc.day} vs ${inLj.day}`);
  ok(inUtc.start === inLj.start, 'while the instant itself is of course the same');

  console.log('a floating event follows the VIEWER');
  store('/c/float.ics', ics(...vevent('UID:float', 'SUMMARY:Floating', 'DTSTART:20260610T120000', 'DTEND:20260610T130000')));
  const fLj = between('2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z', { timezone: 'Europe/Ljubljana' }).find((e) => e.uid === 'float');
  const fNy = between('2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z', { timezone: 'America/New_York' }).find((e) => e.uid === 'float');
  ok(fLj.floating === true, 'it is reported as floating, so the UI can say so');
  ok(fLj.start === Date.parse('2026-06-10T10:00:00Z'), 'noon for a viewer in Ljubljana', new Date(fLj.start).toISOString());
  ok(fNy.start === Date.parse('2026-06-10T16:00:00Z'),
    'and noon for a viewer in New York — that is what floating MEANS', new Date(fNy.start).toISOString());

  console.log('opening one event');
  const detail = eventDetail(UK, CAL, 'weekly', { occurrenceStart: Date.parse('2026-03-02T08:00:00Z'), timezone: 'Europe/Ljubljana' });
  ok(detail?.summary === 'Standup', 'a series resolves to its master');
  ok(detail.rrule === 'FREQ=WEEKLY;BYDAY=MO', 'carrying the rule, so the UI can say how it repeats');
  ok(eventDetail(UK, CAL, 'nope', {}) === null, 'and an unknown one is null, not a crash');

  console.log('housekeeping');
  ok(cache.calendarEtags(UK, 'src-1', CAL).size >= 3, 'stored hrefs are listed for the ETag-diff sync path');
  const inWindow = cache.calendarHrefsInWindow(UK, 'src-1', CAL, Date.parse('2026-06-01T00:00:00Z'), Date.parse('2026-07-01T00:00:00Z'));
  ok(inWindow.has('/c/one.ics') && !inWindow.has('/c/xmas.ics'),
    'and a window listing covers only what STARTS inside it — which is what stops a windowed sync deleting everything outside its range',
    [...inWindow].join(','));
  cache.deleteCalendar(UK, 'src-1', CAL);
  ok(between('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z').length === 0, 'deleting a calendar clears its events');
  ok(occurrencesIn(UK, [], 0, Date.now()).length === 0, 'and asking about no calendars is not an error');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
