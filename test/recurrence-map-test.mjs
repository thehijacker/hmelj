// Hmelj — RRULE ⇄ Microsoft's recurrence models.
//
// The property that matters is the ROUND TRIP: a rule written to Microsoft and
// read back must be the rule it started as. A mapper that silently changes
// "every second Tuesday" into "every Tuesday" produces a calendar that is wrong
// on every occurrence and looks like it saved correctly, so each pattern below
// is asserted in both directions rather than only on the way out.
//
// The refusals are asserted just as hard. Approximating a rule Microsoft cannot
// express is the failure mode this file exists to prevent.
import { toGraph, fromGraph, toEws, fromEws, cappedBefore, dateOnly } from '../server/recurrenceMap.js';

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '\n      ' + extra : '')); }
};
const eq = (got, want, msg) => ok(got === want, msg, `got:  ${got}\n      want: ${want}`);
const throws = (fn, msg) => {
  try { fn(); ok(false, msg, 'it returned instead of refusing'); }
  catch { ok(true, msg); }
};

// 6 January 2026, 09:00 UTC — a Tuesday.
const START = Date.UTC(2026, 0, 6, 9, 0, 0);
const opts = { startMs: START, zone: 'Europe/Ljubljana' };

/** Round-trips a rule through Graph and reports what came back. */
const trip = (rule) => fromGraph(toGraph(rule, opts));

console.log('the patterns Microsoft has names for');
eq(trip('FREQ=DAILY'), 'FREQ=DAILY', 'every day');
eq(trip('FREQ=DAILY;INTERVAL=3'), 'FREQ=DAILY;INTERVAL=3', 'every third day');
eq(trip('FREQ=WEEKLY;BYDAY=MO,WE,FR'), 'FREQ=WEEKLY;BYDAY=MO,WE,FR', 'Mondays, Wednesdays and Fridays');
eq(trip('FREQ=WEEKLY;BYDAY=TU;INTERVAL=2'), 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=2', 'every second Tuesday');
eq(trip('FREQ=MONTHLY;BYMONTHDAY=15'), 'FREQ=MONTHLY;BYMONTHDAY=15', 'the 15th of every month');
eq(trip('FREQ=MONTHLY;BYDAY=-1FR'), 'FREQ=MONTHLY;BYDAY=-1FR', 'the last Friday of every month');
eq(trip('FREQ=MONTHLY;BYDAY=2TU;INTERVAL=3'), 'FREQ=MONTHLY;BYDAY=2TU;INTERVAL=3', 'the second Tuesday of every third month');
eq(trip('FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25'), 'FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25', 'Christmas');
eq(trip('FREQ=YEARLY;BYMONTH=11;BYDAY=4TH'), 'FREQ=YEARLY;BYMONTH=11;BYDAY=4TH', 'the fourth Thursday of November');

console.log('BYSETPOS over several weekdays');
// RFC 5545's own phrasing for "the last working day of the month" — ONE date a
// month. It goes out as Microsoft's relative pattern (five weekdays, index
// last), which means the same thing, and it has to come back as itself.
//
// This assertion previously expected 'FREQ=MONTHLY;BYDAY=-1MO,-1TU,-1WE,-1TH,-1FR'
// and called that "keeps its meaning". It does not: a per-day ordinal is the
// last Monday AND the last Tuesday AND … — five dates. Measured over October
// 2026, the two forms give 10-30 and 10-26,27,28,29,30 respectively. See
// recurrenceMap.js#relativeByDay.
eq(trip('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'),
   'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
   'the last WORKING day of the month round-trips as one date a month, not five');
eq(trip('FREQ=MONTHLY;BYDAY=-1FR'), 'FREQ=MONTHLY;BYDAY=-1FR',
   'while a single weekday keeps the compact form, where the two spellings agree');

console.log('how long it runs for');
eq(trip('FREQ=WEEKLY;BYDAY=MO;COUNT=10'), 'FREQ=WEEKLY;BYDAY=MO;COUNT=10', 'a counted series keeps its count');
eq(trip('FREQ=WEEKLY;BYDAY=MO;UNTIL=20260630T235959Z'),
   'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260701',
   'an UNTIL instant becomes the local date it falls on — 23:59:59Z is already the 1st in Ljubljana');
eq(trip('FREQ=DAILY;UNTIL=20260630'), 'FREQ=DAILY;UNTIL=20260630',
   'a date-valued UNTIL survives as itself');
ok(toGraph('FREQ=DAILY', opts).range.type === 'noEnd', 'and a series with no end says so');

console.log('the last day of the month');
// Microsoft has no way to say "day 28, 29, 30 or 31, whichever ends this
// month" as an ABSOLUTE pattern — dayOfMonth is a plain number. It says it as
// the relative pattern with every weekday and index "last", which is what
// Outlook's own "The last day of every N month(s)" is underneath.
{
  const p = toGraph('FREQ=MONTHLY;BYMONTHDAY=-1', opts).pattern;
  eq(p.type, 'relativeMonthly', 'goes out as a relative pattern, not an absolute one');
  eq(p.index, 'last', 'indexed last');
  eq(p.daysOfWeek.length, 7, 'over every weekday — which is what makes it "day" rather than "Sunday"');
  eq(toGraph('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=-1', opts).pattern.interval, 3, 'and it keeps its interval');
  // The round trip is SEMANTIC here rather than textual: it comes back as the
  // BYDAY/BYSETPOS spelling, which RFC 5545 also defines and which expands to
  // exactly the same dates (test/rrule-test.mjs covers the expansion).
  eq(fromGraph(toGraph('FREQ=MONTHLY;BYMONTHDAY=-1', opts)),
     'FREQ=MONTHLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;BYSETPOS=-1',
     'and reads back as the other way of writing the same rule');
}

console.log('what is refused rather than approximated');
throws(() => toGraph('FREQ=MONTHLY;BYMONTHDAY=-2', opts), 'the SECOND-to-last day — last is the only one from the end Microsoft has');
throws(() => toGraph('FREQ=MONTHLY;BYMONTHDAY=1,15', opts), 'two days of the month');
throws(() => toGraph('FREQ=MONTHLY;BYDAY=1MO,3FR', opts), 'weekdays at different positions');
throws(() => toGraph('FREQ=MONTHLY;BYDAY=5TU', opts), 'the fifth Tuesday — Microsoft counts four and "last"');
throws(() => toGraph('FREQ=YEARLY;BYWEEKNO=20', opts), 'a rule stated by week of the year');
throws(() => toGraph('FREQ=WEEKLY;BYMONTHDAY=1', opts), 'a weekly rule that also names a date');
throws(() => toGraph('FREQ=HOURLY', opts), 'an hourly repeat');
ok(toGraph('', opts) === null, 'and no rule at all is a one-off, not an error');

console.log('the same rules, written for Exchange');
const ews = (rule) => toEws(rule, opts);
ok(ews('FREQ=DAILY;INTERVAL=2').includes('<t:DailyRecurrence><t:Interval>2</t:Interval>'), 'daily interval');
ok(ews('FREQ=WEEKLY;BYDAY=MO,TH').includes('<t:DaysOfWeek>Monday Thursday</t:DaysOfWeek>'),
   'Exchange separates weekdays with spaces, not commas');
ok(ews('FREQ=MONTHLY;BYDAY=-1FR').includes('<t:DayOfWeekIndex>Last</t:DayOfWeekIndex>'), 'the last Friday');
ok(ews('FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25').includes('<t:Month>December</t:Month>'),
   'Exchange names months in words');
ok(ews('FREQ=DAILY').includes('<t:NoEndRecurrence>'), 'a series with no end still carries a range — Exchange rejects one without');
ok(ews('FREQ=DAILY;COUNT=5').includes('<t:NumberOfOccurrences>5</t:NumberOfOccurrences>'), 'a counted range');
ok(ews('FREQ=DAILY;UNTIL=20260630').includes('<t:EndDate>2026-06-30</t:EndDate>'), 'an end-dated range');
ok(ews('FREQ=DAILY').indexOf('<t:DailyRecurrence>') < ews('FREQ=DAILY').indexOf('<t:NoEndRecurrence>'),
   'and the pattern comes before the range, which the schema requires');
throws(() => ews('FREQ=MONTHLY;BYMONTHDAY=-2'), 'Exchange refuses exactly what Graph refuses');
// Exchange has a word for "any day at all", and it is not a list of the seven.
ok(ews('FREQ=MONTHLY;BYMONTHDAY=-1').includes('<t:DaysOfWeek>Day</t:DaysOfWeek>'),
   'the last day of the month is DaysOfWeek "Day" — not "Sunday", which it would be wrong on six days in seven');
ok(ews('FREQ=MONTHLY;BYMONTHDAY=-1').includes('<t:DayOfWeekIndex>Last</t:DayOfWeekIndex>'),
   'indexed Last');
ok(ews('FREQ=MONTHLY;BYDAY=-1FR').includes('<t:DaysOfWeek>Friday</t:DaysOfWeek>'),
   'while the last FRIDAY still names its weekday');

console.log('reading Exchange back');
eq(fromEws({ DailyRecurrence: { Interval: 2 }, NoEndRecurrence: { StartDate: '2026-01-06' } }),
   'FREQ=DAILY;INTERVAL=2', 'a daily recurrence');
eq(fromEws({ WeeklyRecurrence: { Interval: 1, DaysOfWeek: 'Monday Friday', FirstDayOfWeek: 'Monday' } }),
   'FREQ=WEEKLY;BYDAY=MO,FR', 'a weekly one, with the space-separated days');
eq(fromEws({ RelativeMonthlyRecurrence: { Interval: 1, DaysOfWeek: 'Friday', DayOfWeekIndex: 'Last' } }),
   'FREQ=MONTHLY;BYDAY=-1FR', 'the last Friday of the month');
// Exchange's three set-words. These used to map to nothing at all, leaving a
// bare `BYDAY=` that expanded to no occurrences — an Outlook series set to "the
// last day of every month" simply vanished from the grid.
eq(fromEws({ RelativeMonthlyRecurrence: { Interval: 1, DaysOfWeek: 'Day', DayOfWeekIndex: 'Last' } }),
   'FREQ=MONTHLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;BYSETPOS=-1', 'the last DAY of the month — Exchange\'s "Day"');
eq(fromEws({ RelativeMonthlyRecurrence: { Interval: 1, DaysOfWeek: 'Weekday', DayOfWeekIndex: 'Last' } }),
   'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'and "Weekday" is Monday to Friday');
eq(fromEws({ RelativeMonthlyRecurrence: { Interval: 1, DaysOfWeek: 'WeekendDay', DayOfWeekIndex: 'First' } }),
   'FREQ=MONTHLY;BYDAY=SA,SU;BYSETPOS=1', 'and "WeekendDay" the other two');
eq(fromEws({ AbsoluteYearlyRecurrence: { DayOfMonth: 25, Month: 'December' } }),
   'FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25', 'and a yearly date');
eq(fromEws({ DailyRecurrence: { Interval: 1 }, EndDateRecurrence: { StartDate: '2026-01-06', EndDate: '2026-06-30' } }),
   'FREQ=DAILY;UNTIL=20260630', 'an end date becomes UNTIL');
ok(fromEws(null) === null, 'nothing is nothing');

console.log('"this and everything after it" caps the old series');
eq(cappedBefore('FREQ=WEEKLY;BYDAY=MO', Date.UTC(2026, 2, 9, 9), 'UTC'),
   'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260308',
   'the old series ends the day before the occurrence being split off');
eq(cappedBefore('FREQ=WEEKLY;BYDAY=MO;COUNT=20', Date.UTC(2026, 2, 9, 9), 'UTC'),
   'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260308',
   'a COUNT is dropped — it described a series that no longer exists');
eq(cappedBefore('FREQ=DAILY;UNTIL=20261231', Date.UTC(2026, 2, 9, 9), 'UTC'),
   'FREQ=DAILY;UNTIL=20260308', 'and an existing UNTIL is replaced, not appended to');

console.log('which day an instant falls on depends on the zone');
eq(dateOnly(Date.UTC(2026, 0, 5, 23, 30), 'Europe/Ljubljana'), '2026-01-06',
   '23:30 UTC is already tomorrow in Ljubljana');
eq(dateOnly(Date.UTC(2026, 0, 6, 2, 30), 'America/New_York'), '2026-01-05',
   'and still yesterday in New York');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
