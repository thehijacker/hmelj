// Recurrence expansion (server/rrule.js).
//
// The cases below are RFC 5545 §3.8.5.3's OWN worked examples, with the answers
// the RFC prints beside them. That matters: recurrence is exactly the kind of
// code where examples invented alongside the implementation agree with it and
// with nothing else. Where a case is not from the RFC it says so and says why
// it is here.
//
// Three of these stand for bugs that are invisible until months later:
//   - a weekly rule expanded across a DST boundary keeps its WALL-CLOCK time,
//     so the UTC instant moves by an hour;
//   - FREQ=MONTHLY on the 31st SKIPS short months, it does not clamp to the
//     30th;
//   - COUNT is counted from DTSTART, so a window far in the future must still
//     know how many occurrences already happened.
//
//   node test/rrule-test.mjs
import { parseRRule, expand, _internals } from '../server/rrule.js';
import { wallToInstant, instantToWall, dayKey } from '../server/icalendar.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const W = (y, mo, d, h = 0, mi = 0, s = 0) => ({ y, mo, d, h, mi, s });

/** Occurrences as `YYYY-MM-DD HH:MM` strings in the event's own zone, which is
 *  how the RFC prints its answers and the only way these read as calendar
 *  dates rather than as epoch integers. */
function run(spec, from, to, max) {
  const zone = spec.zone ?? null;
  return expand(spec, {
    from: wallToInstant(W(...from), zone),
    to: wallToInstant(W(...to), zone),
    max,
  }).map((ms) => {
    const w = instantToWall(ms, zone || 'UTC');
    const p = (n) => String(n).padStart(2, '0');
    return `${w.y}-${p(w.mo)}-${p(w.d)} ${p(w.h)}:${p(w.mi)}`;
  });
}
const dates = (list) => list.map((s) => s.slice(0, 10));

console.log('parsing');
let r = parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20260401T000000Z;WKST=SU');
ok(r.freq === 'WEEKLY' && r.interval === 2, 'FREQ and INTERVAL');
ok(r.byday.length === 2 && r.byday[0].day === 1 && r.byday[0].n === 0, 'BYDAY without an ordinal');
ok(parseRRule('FREQ=MONTHLY;BYDAY=-1FR').byday[0].n === -1, 'and with a negative one');
ok(parseRRule('FREQ=MONTHLY;BYDAY=2TU').byday[0].n === 2, 'and a positive one');
ok(r.wkst === 'SU', 'WKST');
ok(parseRRule('FREQ=DAILY;INTERVAL=0').interval === 1,
  'INTERVAL=0 is read as 1 — taken literally it makes every period identical and the walk endless');
ok(parseRRule('') === null && parseRRule('BYDAY=MO') === null, 'a rule with no FREQ is not a rule');
ok(parseRRule('FREQ=DAILY;X-VENDOR-THING=7').freq === 'DAILY',
  'an unknown part is ignored, not fatal — refusing the rule would hide the event entirely');

console.log('the pieces');
const { bydayInMonth, monthDay, isoWeek, applySetPos } = _internals;
ok(JSON.stringify(bydayInMonth(2026, 2, [{ n: -1, day: 5 }])) === '[27]',
  'the LAST Friday of February 2026 is the 27th', JSON.stringify(bydayInMonth(2026, 2, [{ n: -1, day: 5 }])));
ok(JSON.stringify(bydayInMonth(2026, 2, [{ n: 5, day: 5 }])) === '[]',
  'and there is no fifth Friday, so nothing is produced rather than the nearest one');
ok(JSON.stringify(bydayInMonth(2026, 2, [{ n: 0, day: 5 }])) === '[6,13,20,27]', 'no ordinal means every one of them');
ok(monthDay(2026, 1, -1) === 31 && monthDay(2026, 2, -1) === 28, 'BYMONTHDAY=-1 is the last day, whatever length the month is');
ok(monthDay(2026, 2, 31) === 0, 'and a day the month does not have is 0, so the caller can SKIP it');
ok(isoWeek(2026, 1, 1) === 1, 'ISO week of 1 Jan 2026', String(isoWeek(2026, 1, 1)));
ok(JSON.stringify(applySetPos([10, 20, 30], [-1])) === '[30]', 'BYSETPOS=-1 is the last of the period');
ok(JSON.stringify(applySetPos([10, 20, 30], [1, -1])) === '[10,30]', 'and a list picks several');

console.log('a one-off event');
ok(JSON.stringify(run({ start: W(2026, 3, 10, 9, 0) }, [2026, 3, 1], [2026, 4, 1])) === '["2026-03-10 09:00"]',
  'no rule at all is one occurrence');
ok(run({ start: W(2026, 3, 10, 9, 0) }, [2026, 4, 1], [2026, 5, 1]).length === 0, 'outside the window, none');

console.log('RFC 5545 §3.8.5.3 — daily');
// "Daily for 10 occurrences: DTSTART;TZID=America/New_York:19970902T090000"
let got = run({ start: W(1997, 9, 2, 9, 0), zone: 'America/New_York', rrule: 'FREQ=DAILY;COUNT=10' },
  [1997, 1, 1], [1998, 1, 1]);
ok(got.length === 10, 'daily for 10 occurrences', String(got.length));
ok(got[0] === '1997-09-02 09:00' && got[9] === '1997-09-11 09:00', 'Sep 2 through Sep 11', `${got[0]} … ${got[9]}`);
ok(got.every((s) => s.endsWith('09:00')), 'and every one of them at 09:00 local');

// "Every other day - forever" (windowed, since forever is not a thing to assert)
got = run({ start: W(1997, 9, 2, 9, 0), zone: 'America/New_York', rrule: 'FREQ=DAILY;INTERVAL=2' },
  [1997, 9, 1], [1997, 9, 15]);
ok(JSON.stringify(dates(got)) === '["1997-09-02","1997-09-04","1997-09-06","1997-09-08","1997-09-10","1997-09-12","1997-09-14"]',
  'every other day', JSON.stringify(dates(got)));

// "Every 10 days, 5 occurrences"
got = run({ start: W(1997, 9, 2, 9, 0), zone: 'America/New_York', rrule: 'FREQ=DAILY;INTERVAL=10;COUNT=5' },
  [1997, 1, 1], [1998, 1, 1]);
ok(JSON.stringify(dates(got)) === '["1997-09-02","1997-09-12","1997-09-22","1997-10-02","1997-10-12"]',
  'every 10 days, 5 occurrences', JSON.stringify(dates(got)));

console.log('RFC 5545 §3.8.5.3 — weekly');
// "Weekly until December 24, 1997"
got = run({ start: W(1997, 9, 2, 9, 0), zone: 'America/New_York', rrule: 'FREQ=WEEKLY;UNTIL=19971224T000000Z' },
  [1997, 1, 1], [1998, 6, 1]);
ok(got.length === 17, 'weekly until 24 Dec 1997 is 17 occurrences', String(got.length));
ok(got.at(-1) === '1997-12-23 09:00', 'the last one is 23 Dec — UNTIL is inclusive and 24 Dec 00:00Z is before 09:00 local', got.at(-1));

// "Every other week on Monday, Wednesday, and Friday until December 24, 1997,
//  starting on Monday, September 1, 1997"  (WKST=SU)
got = run({
  start: W(1997, 9, 1, 9, 0), zone: 'America/New_York',
  rrule: 'FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000Z;WKST=SU;BYDAY=MO,WE,FR',
}, [1997, 9, 1], [1997, 10, 1]);
ok(JSON.stringify(dates(got)) === '["1997-09-01","1997-09-03","1997-09-05","1997-09-15","1997-09-17","1997-09-19","1997-09-29"]',
  'every other week on Mon/Wed/Fri — the fortnight gap is what WKST alignment buys',
  JSON.stringify(dates(got)));

// "Every other week on Tuesday and Thursday, for 8 occurrences"
got = run({ start: W(1997, 9, 2, 9, 0), zone: 'America/New_York', rrule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=8;WKST=SU;BYDAY=TU,TH' },
  [1997, 1, 1], [1998, 1, 1]);
ok(JSON.stringify(dates(got)) === '["1997-09-02","1997-09-04","1997-09-16","1997-09-18","1997-09-30","1997-10-02","1997-10-14","1997-10-16"]',
  'every other week on Tue/Thu, 8 occurrences', JSON.stringify(dates(got)));

console.log('RFC 5545 §3.8.5.3 — monthly');
// "Monthly on the first Friday for 10 occurrences"
got = run({ start: W(1997, 9, 5, 9, 0), zone: 'America/New_York', rrule: 'FREQ=MONTHLY;COUNT=10;BYDAY=1FR' },
  [1997, 1, 1], [1999, 1, 1]);
ok(JSON.stringify(dates(got).slice(0, 4)) === '["1997-09-05","1997-10-03","1997-11-07","1997-12-05"]',
  'monthly on the first Friday', JSON.stringify(dates(got).slice(0, 4)));
ok(got.length === 10, 'ten of them', String(got.length));

// "Monthly on the second-to-last Monday of the month for 6 months"
got = run({ start: W(1997, 9, 22, 9, 0), zone: 'America/New_York', rrule: 'FREQ=MONTHLY;COUNT=6;BYDAY=-2MO' },
  [1997, 1, 1], [1999, 1, 1]);
ok(JSON.stringify(dates(got)) === '["1997-09-22","1997-10-20","1997-11-17","1997-12-22","1998-01-19","1998-02-16"]',
  'the second-to-last Monday, six times', JSON.stringify(dates(got)));

// "Every Friday the 13th, forever". Two things at once: BYDAY and BYMONTHDAY
// INTERSECT, and the RFC's own example carries
//   EXDATE;TZID=America/New_York:19970902T090000
// to drop DTSTART — which is the RFC demonstrating that DTSTART counts as an
// instance in its own right even when it does not satisfy the rule. That is
// why expand() emits it, and why removing it takes an explicit EXDATE.
got = run({
  start: W(1997, 9, 2, 9, 0), zone: 'America/New_York',
  rrule: 'FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13',
  exdates: [wallToInstant(W(1997, 9, 2, 9, 0), 'America/New_York')],
}, [1997, 1, 1], [2001, 1, 1]);
ok(JSON.stringify(dates(got)) === '["1998-02-13","1998-03-13","1998-11-13","1999-08-13","2000-10-13"]',
  'Friday the 13th — BYDAY and BYMONTHDAY intersect, they do not each expand',
  JSON.stringify(dates(got)));

// Not from the RFC, and the single most common real-world recurrence bug.
got = run({ start: W(2026, 1, 31, 9, 0), zone: 'UTC', rrule: 'FREQ=MONTHLY;COUNT=4' }, [2026, 1, 1], [2027, 1, 1]);
ok(JSON.stringify(dates(got)) === '["2026-01-31","2026-03-31","2026-05-31","2026-07-31"]',
  'monthly on the 31st SKIPS short months — it does not fire on the 28th or slide into the next one',
  JSON.stringify(dates(got)));

// "Monthly on the last day of the month"
got = run({ start: W(1997, 9, 30, 9, 0), zone: 'America/New_York', rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1' },
  [1997, 9, 1], [1998, 3, 1]);
ok(JSON.stringify(dates(got)) === '["1997-09-30","1997-10-31","1997-11-30","1997-12-31","1998-01-31","1998-02-28"]',
  'the last day of each month, whatever length it is', JSON.stringify(dates(got)));

console.log('RFC 5545 §3.8.5.3 — yearly');
// "Every 4 years, the first Tuesday after a Monday in November, forever
//  (U.S. Presidential Election day)"
got = run({
  start: W(1996, 11, 5, 9, 0), zone: 'America/New_York',
  rrule: 'FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8',
}, [1996, 1, 1], [2009, 1, 1]);
ok(JSON.stringify(dates(got)) === '["1996-11-05","2000-11-07","2004-11-02","2008-11-04"]',
  'US election day', JSON.stringify(dates(got)));

// "Every 20th Monday of the year, forever" — the ordinal counts through the YEAR.
got = run({ start: W(1997, 5, 19, 9, 0), zone: 'America/New_York', rrule: 'FREQ=YEARLY;BYDAY=20MO' },
  [1997, 1, 1], [2000, 1, 1]);
ok(JSON.stringify(dates(got)) === '["1997-05-19","1998-05-18","1999-05-17"]',
  'the 20th Monday OF THE YEAR — with no BYMONTH the ordinal is not a month ordinal',
  JSON.stringify(dates(got)));

// "Every Thursday in March, forever"
got = run({ start: W(1997, 3, 13, 9, 0), zone: 'America/New_York', rrule: 'FREQ=YEARLY;BYMONTH=3;BYDAY=TH' },
  [1997, 1, 1], [1998, 1, 1]);
ok(JSON.stringify(dates(got)) === '["1997-03-13","1997-03-20","1997-03-27"]',
  'every Thursday in March', JSON.stringify(dates(got)));

console.log('RFC 5545 §3.8.5.3 — BYSETPOS');
// "The last work day of the month"
got = run({ start: W(1997, 9, 29, 9, 0), zone: 'America/New_York', rrule: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1' },
  [1997, 9, 1], [1998, 1, 1]);
ok(JSON.stringify(dates(got)) === '["1997-09-29","1997-09-30","1997-10-31","1997-11-28","1997-12-31"]',
  'the last WORK day of the month — there is no other way to express this',
  JSON.stringify(dates(got)));
// Worth being explicit, because the RFC's PRINTED answer for this example is
// "September 29; October 31; November 28; December 31" — it lists DTSTART
// (the 29th, a Monday) but omits the 30th, which is genuinely the last workday
// of September 1997. Those two cannot both follow from one rule about DTSTART.
// Hmelj takes the reading the Friday-the-13th example above demonstrates:
// DTSTART is always an instance, and the rule's own instances are added to it.
// Under that reading September has both, and the RFC's printed list is
// inconsistent with its own EXDATE workaround rather than with this code.
// Real ICS files from Google, Outlook and Apple always synchronise DTSTART with
// the rule, so the case never arises in practice; when it does, showing the
// date the author wrote down is the failure that loses nobody a meeting.
ok(dates(got).includes('1997-09-30'), 'including the one the rule itself selects for September');

// "The third instance into the month of one of Tuesday, Wednesday, or Thursday,
//  for the next 3 months"
got = run({ start: W(1997, 9, 4, 9, 0), zone: 'America/New_York', rrule: 'FREQ=MONTHLY;COUNT=3;BYDAY=TU,WE,TH;BYSETPOS=3' },
  [1997, 1, 1], [1999, 1, 1]);
ok(JSON.stringify(dates(got)) === '["1997-09-04","1997-10-07","1997-11-06"]',
  'the third Tue/Wed/Thu of the month', JSON.stringify(dates(got)));

console.log('daylight saving — the drift that only shows up in April');
// Europe/Ljubljana moves to CEST on the last Sunday of March. A weekly rule
// keeps its WALL-CLOCK time, so the UTC instant shifts by an hour. Anything
// that expanded by adding 7×86400000 ms would hold the instant and move the
// clock instead — every meeting an hour early for half the year.
const dst = expand({ start: W(2026, 3, 23, 9, 0), zone: 'Europe/Ljubljana', rrule: 'FREQ=WEEKLY;COUNT=3' },
  { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 11, 1) });
ok(dst.length === 3, 'three Mondays');
ok(new Date(dst[0]).toISOString() === '2026-03-23T08:00:00.000Z',
  '23 March 09:00 local is 08:00Z — CET, UTC+1', new Date(dst[0]).toISOString());
ok(new Date(dst[1]).toISOString() === '2026-03-30T07:00:00.000Z',
  '30 March 09:00 local is 07:00Z — CEST, UTC+2. Same clock time, an hour earlier in UTC.',
  new Date(dst[1]).toISOString());
ok(dst[1] - dst[0] === 6 * 86400000 + 23 * 3600000,
  'so the gap between them is 6 days 23 hours, not 7 days — which is the whole point',
  String((dst[1] - dst[0]) / 3600000) + 'h');
ok(instantToWall(dst[1], 'Europe/Ljubljana').h === 9, 'and the clock still reads 09:00');

console.log('COUNT is counted from DTSTART, not from the window');
// A finished series must not reappear just because somebody looks at next year.
const finished = { start: W(2026, 1, 5, 9, 0), zone: 'UTC', rrule: 'FREQ=WEEKLY;COUNT=4' };
ok(run(finished, [2026, 1, 1], [2026, 3, 1]).length === 4, 'four occurrences in January');
ok(run(finished, [2026, 3, 1], [2027, 1, 1]).length === 0,
  'and NONE in March — the count was already spent, which a window-relative count could not know');
ok(run({ start: W(2026, 1, 5, 9, 0), zone: 'UTC', rrule: 'FREQ=WEEKLY' }, [2026, 6, 1], [2026, 7, 1]).length === 5,
  'an endless rule still produces all five June Mondays (the skip-ahead path)');

console.log('UNTIL');
ok(run({ start: W(2026, 1, 5, 9, 0), zone: 'UTC', rrule: 'FREQ=DAILY;UNTIL=20260108T090000Z' },
  [2026, 1, 1], [2027, 1, 1]).length === 4, 'UNTIL is inclusive of an occurrence landing exactly on it');
ok(run({ start: W(2026, 1, 5, 9, 0), zone: 'UTC', rrule: 'FREQ=DAILY;UNTIL=20260108T085959Z' },
  [2026, 1, 1], [2027, 1, 1]).length === 3, 'and exclusive of one a second later');
ok(run({ start: W(2026, 1, 5, 9, 0), zone: 'UTC', rrule: 'FREQ=DAILY;UNTIL=20260108' },
  [2026, 1, 1], [2027, 1, 1]).length === 4, 'a date-only UNTIL covers the whole of that day');

console.log('EXDATE and RDATE');
const base = { start: W(2026, 1, 5, 9, 0), zone: 'UTC', rrule: 'FREQ=WEEKLY;COUNT=4' };
const skipped = expand({ ...base, exdates: [Date.UTC(2026, 0, 12, 9, 0)] },
  { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 1, 1) });
ok(skipped.length === 3, 'an EXDATE removes exactly one occurrence', String(skipped.length));
ok(!skipped.includes(Date.UTC(2026, 0, 12, 9, 0)), 'and it is the right one');
const added = expand({ ...base, rdates: [Date.UTC(2026, 0, 7, 14, 0)] },
  { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 1, 1) });
ok(added.length === 5 && added.includes(Date.UTC(2026, 0, 7, 14, 0)),
  'an RDATE adds one outright — it is not subject to the rule', String(added.length));
ok(added[1] === Date.UTC(2026, 0, 7, 14, 0), 'and lands in date order');

console.log('all-day events');
const allDay = expand({ start: W(2026, 12, 25), zone: 'Europe/Ljubljana', rrule: 'FREQ=YEARLY;COUNT=3' },
  { from: Date.UTC(2026, 0, 1), to: Date.UTC(2030, 0, 1) });
ok(allDay.length === 3, 'a yearly all-day event');
ok(dayKey(allDay[0], 'Europe/Ljubljana') === '2026-12-25', 'on the right day in its own zone',
  dayKey(allDay[0], 'Europe/Ljubljana'));
ok(dayKey(allDay[1], 'Europe/Ljubljana') === '2027-12-25', 'and the year after');
// dayKey, not toISOString().slice(0,10) — the latter answers in UTC and puts a
// midnight-local event on the previous day for anyone east of Greenwich.
ok(new Date(allDay[0]).toISOString().slice(0, 10) === '2026-12-24',
  'and this is exactly why dayKey exists: read as UTC the same instant is the 24th');

console.log('bounds and bad input');
ok(expand({ start: W(2026, 1, 1, 9, 0), zone: 'UTC', rrule: 'FREQ=DAILY' },
  { from: Date.UTC(2026, 0, 1), to: Date.UTC(2036, 0, 1), max: 5 }).length === 5, 'max is honoured');
ok(expand({ start: W(2026, 1, 1, 9, 0), zone: 'UTC', rrule: 'FREQ=MINUTELY' },
  { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 2) }).length <= 2000,
  'a per-minute rule cannot exhaust memory');
ok(run({ start: W(2026, 1, 1, 9, 0), zone: 'UTC', rrule: 'FREQ=NONSENSE' }, [2026, 1, 1], [2027, 1, 1]).length === 1,
  'an unrecognised FREQ degrades to the one event, rather than to nothing or to a hang');
// The cap has to hold even when the BY parts can never be satisfied — 30 Feb
// exists in no year, and without a bound the walk would run forever.
const t0 = Date.now();
const impossible = expand({ start: W(2026, 1, 1, 9, 0), zone: 'UTC', rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30' },
  { from: Date.UTC(2026, 0, 1), to: Date.UTC(2027, 0, 1) });
ok(impossible.length <= 1 && Date.now() - t0 < 5000,
  'a rule that can never match terminates instead of hanging', `${impossible.length} in ${Date.now() - t0}ms`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
