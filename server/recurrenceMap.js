// Hmelj — RRULE ⇄ the recurrence models Microsoft uses.
//
// iCalendar states a recurrence as ONE rule with orthogonal parts (FREQ,
// INTERVAL, BYDAY, BYMONTHDAY, BYSETPOS…). Microsoft states it as one of six
// named PATTERNS plus a range, and the pattern is chosen by shape:
//
//   daily · weekly · absoluteMonthly · relativeMonthly · absoluteYearly · relativeYearly
//
// Translating between them is where calendar clients corrupt data, so two rules
// govern this file:
//
//   1. A rule that does not map EXACTLY is refused, never approximated. Saving
//      "the last working Friday of every second month" as "every second month
//      on the 26th" produces an event that is wrong on almost every occurrence
//      and looks like it saved fine. A refusal the user can read is strictly
//      better, and it is why toGraph/toEws throw rather than returning
//      something plausible.
//
//   2. Round-tripping is asserted, not assumed. Every pattern this file writes
//      must read back as the rule that produced it — see
//      test/recurrence-map-test.mjs.
//
// ── UNTIL and the day boundary ──────────────────────────────────────────────
// iCalendar's UNTIL is an INSTANT and inclusive: the last occurrence may start
// at exactly that moment. Microsoft's range `endDate` is a DATE, and it means
// "the last day an occurrence may start on". Converting one to the other is a
// date extraction, not a subtraction — and doing the subtraction (a common
// off-by-one) silently drops the final occurrence of every series.
import { parseRRule } from './rrule.js';

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const ICAL_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Microsoft's `index` for a relative pattern — which one in the month. */
const INDEX_BY_N = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' };
const N_BY_INDEX = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };

const fail = (why) => {
  throw Object.assign(
    new Error(`${why} Microsoft's calendar cannot express that rule, and Hmelj will not save an approximation of it. `
      + 'Change the repeat to something simpler, or keep this event on a CalDAV or Hmelj calendar.'),
    { status: 400 },
  );
};

/** `YYYY-MM-DD` for an instant, in the given zone — Microsoft's range dates are
 *  plain dates, and which date an instant falls on depends on the zone. */
export function dateOnly(ms, zone = 'UTC') {
  if (!Number.isFinite(ms)) {
    // Reached only through a caller that lost the start. Named, because the
    // RangeError Intl throws for this points at the formatter rather than at
    // whoever failed to pass a date.
    throw Object.assign(new Error('A repeating event needs a start date to state its rule from.'), { status: 400 });
  }
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return f.format(new Date(ms));   // en-CA formats as YYYY-MM-DD
}

/** An iCalendar UNTIL value → `YYYY-MM-DD`. Inclusive on both sides: the date
 *  the last occurrence may start on. */
function untilToDate(until, zone) {
  const s = String(until || '');
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(s);
  if (!m) return '';
  // A UTC instant (`…T230000Z`) can name a different local date than its own
  // digits do, and the range is read in the event's zone.
  if (/T\d{6}Z$/.test(s)) {
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3],
      +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
    return dateOnly(ms, zone);
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/* ==================== RRULE → Microsoft Graph ==================== */

/**
 * A Graph `recurrence` object, or null for a one-off.
 *
 * `startDate` is the series' first day and `zone` the timezone the pattern is
 * read in — both are the EVENT's, not the server's, or a weekly meeting drifts
 * a day for anyone whose offset differs from the process's.
 */
export function toGraph(rrule, { startMs, zone = 'UTC' } = {}) {
  const r = parseRRule(rrule);
  if (!r) return null;
  const pattern = graphPattern(r);
  const range = { type: 'noEnd', startDate: dateOnly(startMs, zone), recurrenceTimeZone: zone || 'UTC' };
  if (r.count) { range.type = 'numbered'; range.numberOfOccurrences = r.count; }
  else if (r.until) {
    const d = untilToDate(r.until, zone);
    if (d) { range.type = 'endDate'; range.endDate = d; }
  }
  return { pattern, range };
}

function graphPattern(r) {
  const interval = r.interval || 1;
  const byday = r.byday || [];
  const positional = byday.filter((d) => d.n !== 0);
  const bymonth = r.bymonth || [];
  const bymonthday = r.bymonthday || [];

  if (r.bysetpos?.length) {
    // BYSETPOS is expressible only in the one shape Microsoft has a name for:
    // "the Nth weekday of the month". Anything else — the 2nd of a BYMONTHDAY
    // list, a negative position over a set — has no pattern.
    if (r.bysetpos.length !== 1 || !byday.length || bymonthday.length) {
      fail('This repeat uses BYSETPOS in a form Microsoft has no pattern for.');
    }
  }
  if (r.byweekno?.length || r.byyearday?.length) {
    fail('This repeat is stated by week or day of the year.');
  }

  switch (r.freq) {
    case 'DAILY':
      if (byday.length || bymonthday.length || bymonth.length) {
        fail('A daily repeat cannot also name days, dates or months.');
      }
      return { type: 'daily', interval };

    case 'WEEKLY':
      if (positional.length || bymonthday.length || bymonth.length) {
        fail('A weekly repeat cannot name a position, a date or a month.');
      }
      return {
        type: 'weekly',
        interval,
        daysOfWeek: (byday.length ? byday : [{ day: -1 }]).map((d) => DAYS[d.day]).filter(Boolean),
        firstDayOfWeek: DAYS[ICAL_DAYS.indexOf(r.wkst || 'MO')] || 'monday',
      };

    case 'MONTHLY':
      if (bymonth.length) fail('A monthly repeat cannot also name a month.');
      if (bymonthday.length) {
        if (byday.length) fail('A monthly repeat cannot name both a date and a weekday.');
        // "The last day of the month" (BYMONTHDAY=-1) IS expressible — just not
        // as an absolute pattern, because Microsoft's dayOfMonth is a number
        // between 1 and 31 and there is no way to say "however many days this
        // month happens to have". The relative pattern with EVERY weekday and
        // index "last" is the shape Outlook itself uses for it, and it is what
        // its own UI calls "The last day of every N month(s)".
        //
        // It reads back (fromGraph) as FREQ=MONTHLY;BYDAY=SU,MO,…,SA;BYSETPOS=-1
        // rather than as BYMONTHDAY=-1 — a different way of writing the same
        // rule, which RFC 5545 also spells out, and which server/rrule.js
        // expands to exactly the same dates. That is a semantic round-trip
        // rather than a textual one, and it is asserted in
        // test/recurrence-map-test.mjs.
        if (bymonthday.length === 1 && bymonthday[0] === -1) {
          return { type: 'relativeMonthly', interval, daysOfWeek: [...DAYS], index: 'last' };
        }
        if (bymonthday.length > 1 || bymonthday[0] < 1) {
          fail('Microsoft can repeat on one day of the month, on the last day of it, but not on some other day counted from the end.');
        }
        return { type: 'absoluteMonthly', interval, dayOfMonth: bymonthday[0] };
      }
      return { type: 'relativeMonthly', interval, ...relative(r, byday) };

    case 'YEARLY': {
      const month = bymonth.length === 1 ? bymonth[0] : null;
      if (bymonth.length > 1) fail('Microsoft can repeat in one month of the year, not several.');
      if (bymonthday.length) {
        if (bymonthday.length > 1 || bymonthday[0] < 1 || byday.length) {
          fail('A yearly repeat maps only as "this date, this month".');
        }
        return { type: 'absoluteYearly', interval, dayOfMonth: bymonthday[0], month: month || 1 };
      }
      if (!byday.length) fail('A yearly repeat needs either a date or a weekday to land on.');
      return { type: 'relativeYearly', interval, month: month || 1, ...relative(r, byday) };
    }

    default:
      fail(`Hmelj does not know the repeat frequency ${r.freq}.`);
      return null;
  }
}

/** The `daysOfWeek` + `index` half of a relative pattern. The position can come
 *  from BYSETPOS ("the last of these weekdays") or from BYDAY's own prefix
 *  ("the last Friday"), and the two mean the same thing here. */
function relative(r, byday) {
  if (!byday.length) fail('A relative repeat needs a weekday.');
  const n = r.bysetpos?.length === 1 ? r.bysetpos[0] : byday[0].n;
  const index = INDEX_BY_N[String(n)];
  if (!index) {
    fail(n ? `Microsoft counts the first four and the last of a month, not the ${n}th.`
           : 'This repeat names a weekday with no position in the month.');
  }
  // Mixed prefixes ("the first Monday and the third Friday") are two patterns,
  // and Microsoft holds one.
  if (byday.some((d) => d.n !== 0 && d.n !== byday[0].n)) {
    fail('This repeat names weekdays at different positions in the month.');
  }
  return { daysOfWeek: byday.map((d) => DAYS[d.day]).filter(Boolean), index };
}

/**
 * Microsoft's "the Nth <these weekdays> of the month", as iCalendar.
 *
 * The two spellings are NOT interchangeable, and picking the wrong one is a
 * silent multiplication rather than an error:
 *
 *   BYDAY=-1FR                 the last Friday                    — one date
 *   BYDAY=-1MO,-1TU,…,-1FR     the last Monday AND the last
 *                              Tuesday AND …                      — FIVE dates
 *   BYDAY=MO,TU,…,FR;BYSETPOS=-1   the last of those days         — one date
 *
 * Microsoft means the third. With a SINGLE weekday all three coincide, which is
 * why the compact `-1FR` form is right there and was the only case this ever
 * handled — an Outlook series set to "the last weekday of every month" was
 * being read as five occurrences a month, and "the last day" (all seven) as
 * seven. The compact form is kept for one day because it is what toGraph reads
 * back (relative() takes the ordinal off byday[0]), so the round trip stays
 * textual there.
 */
function relativeByDay(days, n) {
  if (days.length === 1) return [`BYDAY=${n}${days[0]}`];
  return [`BYDAY=${days.join(',')}`, `BYSETPOS=${n}`];
}

/* ==================== Microsoft Graph → RRULE ==================== */

/** The rule a Graph recurrence states, as an RRULE value with no `RRULE:`
 *  prefix — the same shape parseRRule and the rest of Hmelj expect. */
export function fromGraph(recurrence) {
  const p = recurrence?.pattern;
  const range = recurrence?.range || {};
  if (!p?.type) return null;
  const parts = [];
  const days = (p.daysOfWeek || []).map((d) => ICAL_DAYS[DAYS.indexOf(String(d).toLowerCase())]).filter(Boolean);
  const n = N_BY_INDEX[String(p.index || 'first').toLowerCase()] ?? 1;

  switch (String(p.type).toLowerCase()) {
    case 'daily': parts.push('FREQ=DAILY'); break;
    case 'weekly':
      parts.push('FREQ=WEEKLY');
      if (days.length) parts.push(`BYDAY=${days.join(',')}`);
      if (p.firstDayOfWeek) {
        const wkst = ICAL_DAYS[DAYS.indexOf(String(p.firstDayOfWeek).toLowerCase())];
        if (wkst && wkst !== 'MO') parts.push(`WKST=${wkst}`);
      }
      break;
    case 'absolutemonthly': parts.push('FREQ=MONTHLY', `BYMONTHDAY=${p.dayOfMonth}`); break;
    case 'relativemonthly':
      parts.push('FREQ=MONTHLY', ...relativeByDay(days, n));
      break;
    case 'absoluteyearly': parts.push('FREQ=YEARLY', `BYMONTH=${p.month}`, `BYMONTHDAY=${p.dayOfMonth}`); break;
    case 'relativeyearly':
      parts.push('FREQ=YEARLY', `BYMONTH=${p.month}`, ...relativeByDay(days, n));
      break;
    default: return null;
  }

  const interval = Number(p.interval || 1);
  if (interval > 1) parts.push(`INTERVAL=${interval}`);

  if (String(range.type).toLowerCase() === 'numbered' && range.numberOfOccurrences) {
    parts.push(`COUNT=${range.numberOfOccurrences}`);
  } else if (String(range.type).toLowerCase() === 'enddate' && range.endDate) {
    // A DATE end becomes a DATE-VALUED UNTIL rather than an instant: the range
    // means "up to and including this day", and pinning a time to it would cut
    // the last day short for every occurrence later than that time.
    parts.push(`UNTIL=${String(range.endDate).replace(/-/g, '')}`);
  }
  return parts.join(';');
}

/* ==================== RRULE → EWS ==================== */

const escXml = (s) => String(s).replace(/[<>&'"]/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

const EWS_DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EWS_INDEX = { 1: 'First', 2: 'Second', 3: 'Third', 4: 'Fourth', '-1': 'Last' };

/**
 * The `<t:Recurrence>` element for a rule, or '' for a one-off.
 *
 * Built from the SAME analysis Graph uses — `toGraph` is called first and its
 * refusals apply here too, so a rule Hmelj declines to save on Microsoft 365 is
 * declined identically on Exchange. Two mappers with two sets of edge cases is
 * two sets of bugs.
 */
export function toEws(rrule, { startMs, zone = 'UTC' } = {}) {
  const g = toGraph(rrule, { startMs, zone });
  if (!g) return '';
  const { pattern: p, range } = g;
  const interval = p.interval || 1;
  const days = (p.daysOfWeek || []).map((d) => EWS_DAY[DAYS.indexOf(d)]).filter(Boolean);
  const index = EWS_INDEX[String(N_BY_INDEX[p.index] ?? 1)] || 'First';

  let inner = '';
  switch (p.type) {
    case 'daily':
      inner = `<t:DailyRecurrence><t:Interval>${interval}</t:Interval></t:DailyRecurrence>`;
      break;
    case 'weekly':
      inner = `<t:WeeklyRecurrence><t:Interval>${interval}</t:Interval>`
        + `<t:DaysOfWeek>${escXml(days.join(' '))}</t:DaysOfWeek>`
        + `<t:FirstDayOfWeek>${escXml(EWS_DAY[DAYS.indexOf(p.firstDayOfWeek)] || 'Monday')}</t:FirstDayOfWeek>`
        + '</t:WeeklyRecurrence>';
      break;
    case 'absolutemonthly': case 'absoluteMonthly':
      inner = `<t:AbsoluteMonthlyRecurrence><t:Interval>${interval}</t:Interval>`
        + `<t:DayOfMonth>${p.dayOfMonth}</t:DayOfMonth></t:AbsoluteMonthlyRecurrence>`;
      break;
    case 'relativemonthly': case 'relativeMonthly':
      inner = `<t:RelativeMonthlyRecurrence><t:Interval>${interval}</t:Interval>`
        // Exchange has a word for "any day at all" and it is not a list of the
        // seven: DaysOfWeek here takes a single value, and `Day` is the one
        // that means "the last DAY of the month" rather than "the last
        // <weekday>". Without this, the last-day-of-month pattern would go out
        // as "the last Sunday", which is wrong on six days in seven.
        + `<t:DaysOfWeek>${escXml(days.length === 7 ? 'Day' : (days[0] || 'Monday'))}</t:DaysOfWeek>`
        + `<t:DayOfWeekIndex>${index}</t:DayOfWeekIndex></t:RelativeMonthlyRecurrence>`;
      break;
    case 'absoluteyearly': case 'absoluteYearly':
      inner = '<t:AbsoluteYearlyRecurrence>'
        + `<t:DayOfMonth>${p.dayOfMonth}</t:DayOfMonth>`
        + `<t:Month>${escXml(MONTHS[(p.month || 1) - 1])}</t:Month></t:AbsoluteYearlyRecurrence>`;
      break;
    case 'relativeyearly': case 'relativeYearly':
      inner = '<t:RelativeYearlyRecurrence>'
        + `<t:DaysOfWeek>${escXml(days[0] || 'Monday')}</t:DaysOfWeek>`
        + `<t:DayOfWeekIndex>${index}</t:DayOfWeekIndex>`
        + `<t:Month>${escXml(MONTHS[(p.month || 1) - 1])}</t:Month></t:RelativeYearlyRecurrence>`;
      break;
    default:
      fail('Hmelj does not know how to write that repeat to Exchange.');
  }

  // Exchange requires a range, and rejects the item without one. The order of
  // these elements is fixed by the schema — pattern, then range — and Exchange
  // refuses the whole request if they are the other way round.
  let rangeXml;
  if (range.type === 'numbered') {
    rangeXml = `<t:NumberedRecurrence><t:StartDate>${range.startDate}</t:StartDate>`
      + `<t:NumberOfOccurrences>${range.numberOfOccurrences}</t:NumberOfOccurrences></t:NumberedRecurrence>`;
  } else if (range.type === 'endDate') {
    rangeXml = `<t:EndDateRecurrence><t:StartDate>${range.startDate}</t:StartDate>`
      + `<t:EndDate>${range.endDate}</t:EndDate></t:EndDateRecurrence>`;
  } else {
    rangeXml = `<t:NoEndRecurrence><t:StartDate>${range.startDate}</t:StartDate></t:NoEndRecurrence>`;
  }
  return `<t:Recurrence>${inner}${rangeXml}</t:Recurrence>`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/* ==================== EWS → RRULE ==================== */

/** The rule an EWS `<Recurrence>` states, as an RRULE value. Parsed from the
 *  object fast-xml-parser produces, not from raw XML. */
export function fromEws(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const parts = [];
  // Exchange's DaysOfWeek is a space-separated list of day NAMES — or one of
  // three words that stand for a set. Dropping those (which is what mapping
  // them through EWS_DAY did, since none of them is a day name) left an empty
  // `BYDAY=` behind: an Exchange series set to "the last day of every month",
  // which is exactly the shape this release added on the writing side, read
  // back as a malformed rule that expanded to nothing.
  const DAY_SETS = {
    Day: ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'],
    Weekday: ['MO', 'TU', 'WE', 'TH', 'FR'],
    WeekendDay: ['SA', 'SU'],
  };
  const dayList = (v) => String(v || '').trim().split(/\s+/)
    .flatMap((d) => DAY_SETS[d] || [ICAL_DAYS[EWS_DAY.indexOf(d)]])
    .filter(Boolean);
  const idx = (v) => ({ First: 1, Second: 2, Third: 3, Fourth: 4, Last: -1 }[String(v)] ?? 1);
  const monthNo = (v) => MONTHS.indexOf(String(v)) + 1;
  let interval = 1;

  if (rec.DailyRecurrence) {
    parts.push('FREQ=DAILY');
    interval = Number(rec.DailyRecurrence.Interval || 1);
  } else if (rec.WeeklyRecurrence) {
    const w = rec.WeeklyRecurrence;
    parts.push('FREQ=WEEKLY');
    interval = Number(w.Interval || 1);
    const d = dayList(w.DaysOfWeek);
    if (d.length) parts.push(`BYDAY=${d.join(',')}`);
    const wkst = ICAL_DAYS[EWS_DAY.indexOf(String(w.FirstDayOfWeek || ''))];
    if (wkst && wkst !== 'MO') parts.push(`WKST=${wkst}`);
  } else if (rec.AbsoluteMonthlyRecurrence) {
    const m = rec.AbsoluteMonthlyRecurrence;
    parts.push('FREQ=MONTHLY', `BYMONTHDAY=${m.DayOfMonth}`);
    interval = Number(m.Interval || 1);
  } else if (rec.RelativeMonthlyRecurrence) {
    const m = rec.RelativeMonthlyRecurrence;
    // relativeByDay, not a per-day ordinal — see its comment. "The last day of
    // the month" is one date; "the last Sunday and the last Monday and …" is
    // seven.
    parts.push('FREQ=MONTHLY', ...relativeByDay(dayList(m.DaysOfWeek), idx(m.DayOfWeekIndex)));
    interval = Number(m.Interval || 1);
  } else if (rec.AbsoluteYearlyRecurrence) {
    const y = rec.AbsoluteYearlyRecurrence;
    parts.push('FREQ=YEARLY', `BYMONTH=${monthNo(y.Month)}`, `BYMONTHDAY=${y.DayOfMonth}`);
  } else if (rec.RelativeYearlyRecurrence) {
    const y = rec.RelativeYearlyRecurrence;
    parts.push('FREQ=YEARLY', `BYMONTH=${monthNo(y.Month)}`,
      ...relativeByDay(dayList(y.DaysOfWeek), idx(y.DayOfWeekIndex)));
  } else {
    return null;
  }

  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (rec.NumberedRecurrence?.NumberOfOccurrences) {
    parts.push(`COUNT=${rec.NumberedRecurrence.NumberOfOccurrences}`);
  } else if (rec.EndDateRecurrence?.EndDate) {
    parts.push(`UNTIL=${String(rec.EndDateRecurrence.EndDate).slice(0, 10).replace(/-/g, '')}`);
  }
  return parts.join(';');
}

/**
 * The same rule, ending the day before `beforeMs`.
 *
 * This is the whole of "change this and everything after it": the existing
 * series is capped just before the occurrence being edited, and a NEW series
 * carries the change forward. COUNT has to become UNTIL, because a count that
 * described the whole series describes nothing once it is cut.
 */
export function cappedBefore(rrule, beforeMs, zone = 'UTC') {
  const r = parseRRule(rrule);
  if (!r) return null;
  const endMs = beforeMs - 86400000;
  const until = dateOnly(endMs, zone).replace(/-/g, '');
  const parts = String(rrule).split(';')
    .filter((p) => !/^(UNTIL|COUNT)=/i.test(p.trim()));
  parts.push(`UNTIL=${until}`);
  return parts.join(';');
}
