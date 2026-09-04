// Hmelj — expanding an RRULE into the occurrences that fall inside a window.
//
// This is the file where calendars go wrong, so it is worth being explicit
// about the three things that make it hard.
//
// ── 1. Recurrence is arithmetic on a CLOCK, not on an instant ────────────────
// "Every Monday at 09:00" does not mean "every 604800000 milliseconds". In
// Europe/Ljubljana, 09:00 local is 08:00Z in winter and 07:00Z in summer, so a
// rule expanded by adding milliseconds drifts by an hour twice a year and every
// meeting after the last Sunday in March is wrong.
//
// So everything below walks the recurrence in wall-clock components — year,
// month, day, hour — and converts each occurrence to an instant exactly once,
// at the end, through icalendar.js#wallToInstant. The zone is consulted in one
// place and nowhere else.
//
// ── 2. A month is not a fixed length, and RFC 5545 says SKIP, not clamp ──────
// `FREQ=MONTHLY` on the 31st does not fire on the 30th of April. It does not
// fire in April at all. Clamping (which is what naive date arithmetic does,
// and what `new Date(y, m+1, 31)` does by rolling into May) turns "the last
// day of the month" into "sometime near the start of the next one".
//
// ── 3. COUNT is counted from DTSTART, not from the window ────────────────────
// A rule with `COUNT=10` asks about the first ten occurrences ever, so a query
// for next March still has to know how many happened before it. That is why
// there is no shortcut past the iteration when COUNT is present, and why there
// is a hard iteration cap instead.
//
// ── What is deliberately not here ────────────────────────────────────────────
// BYWEEKNO is implemented as a filter only (ISO-8601 weeks); it is vanishingly
// rare outside test suites. VTODO/VJOURNAL recurrence is not handled because
// nothing in Hmelj reads those.
//
// Pure, one import (itself pure) — see test/rrule-test.mjs, which drives it
// against RFC 5545 §3.8.5.3's own worked examples rather than examples of mine.
import { wallToInstant } from './icalendar.js';

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_INDEX = Object.fromEntries(DAYS.map((d, i) => [d, i]));

/** How many periods may be walked before giving up. A daily rule running since
 *  1970 reaches ~20,000; this allows for two and a half centuries of them. The
 *  cap exists so a malformed rule (or one whose BY parts can never match) can
 *  never hang a request — an unbounded loop here is reached from an ordinary
 *  page load. */
const MAX_PERIODS = 100000;

/** Default ceiling on returned occurrences. A month view asks for weeks; this
 *  is the guard against a per-minute rule over a decade. */
const MAX_RESULTS = 2000;

const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const dowOf = (y, mo, d) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();

/** Wall-clock parts plus n days, keeping the time of day. Goes through Date's
 *  own normalisation, which is the one thing it is reliably good at. */
function addDays(w, n) {
  const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: w.h, mi: w.mi, s: w.s };
}

/** The ISO-8601 week number of a date. Only BYWEEKNO needs it. */
function isoWeek(y, mo, d) {
  const t = new Date(Date.UTC(y, mo - 1, d));
  // Thursday of this ISO week decides which year (and therefore which week) the
  // week belongs to — that is the whole trick of ISO week numbering.
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const jan1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - jan1) / 86400000 + 1) / 7);
}

/**
 * An RRULE value string → a rule object, or null if it says nothing usable.
 *
 * Unknown parts are ignored rather than rejected: a rule carrying an extension
 * nobody here understands is still a rule, and refusing the whole thing would
 * hide a real recurring event completely.
 */
export function parseRRule(value) {
  if (!value) return null;
  if (typeof value === 'object') return value; // already parsed
  const rule = { interval: 1, wkst: 'MO' };
  for (const part of String(value).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim().toUpperCase();
    const v = part.slice(eq + 1).trim();
    if (!v) continue;
    const nums = () => v.split(',').map((n) => parseInt(n, 10)).filter(Number.isFinite);
    switch (k) {
      case 'FREQ': rule.freq = v.toUpperCase(); break;
      // An INTERVAL of 0 would make every period identical and the loop
      // infinite; it is malformed, and 1 is the only sane reading.
      case 'INTERVAL': rule.interval = Math.max(1, parseInt(v, 10) || 1); break;
      case 'COUNT': rule.count = Math.max(0, parseInt(v, 10) || 0); break;
      case 'UNTIL': rule.until = v; break;
      case 'BYSECOND': rule.bysecond = nums(); break;
      case 'BYMINUTE': rule.byminute = nums(); break;
      case 'BYHOUR': rule.byhour = nums(); break;
      case 'BYMONTHDAY': rule.bymonthday = nums(); break;
      case 'BYYEARDAY': rule.byyearday = nums(); break;
      case 'BYWEEKNO': rule.byweekno = nums(); break;
      case 'BYMONTH': rule.bymonth = nums(); break;
      case 'BYSETPOS': rule.bysetpos = nums(); break;
      case 'WKST': rule.wkst = v.toUpperCase(); break;
      case 'BYDAY':
        rule.byday = v.split(',').map((tok) => {
          const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(tok.trim());
          return m ? { n: m[1] ? parseInt(m[1], 10) : 0, day: DAY_INDEX[m[2].toUpperCase()] } : null;
        }).filter(Boolean);
        break;
      default: break;
    }
  }
  return rule.freq ? rule : null;
}

/** The times of day one candidate DATE should be expanded into. Defaults to
 *  DTSTART's own time, which is the overwhelmingly common case — BYHOUR on a
 *  weekly meeting is not a thing people write by hand. */
function timesOf(rule, start) {
  const hours = rule.byhour?.length ? rule.byhour : [start.h];
  const mins = rule.byminute?.length ? rule.byminute : [start.mi];
  const secs = rule.bysecond?.length ? rule.bysecond : [start.s];
  const out = [];
  for (const h of hours) for (const mi of mins) for (const s of secs) out.push({ h, mi, s });
  return out.sort((a, b) => a.h - b.h || a.mi - b.mi || a.s - b.s);
}

/** Every date in `[y, mo]` that BYDAY selects, honouring an ordinal.
 *  `n === 0` means "every one of them in this period". */
function bydayInMonth(y, mo, byday) {
  const days = [];
  const len = daysInMonth(y, mo);
  for (const { n, day } of byday) {
    const matches = [];
    for (let d = 1; d <= len; d++) if (dowOf(y, mo, d) === day) matches.push(d);
    if (n === 0) days.push(...matches);
    else {
      // -1 is the LAST one, which is the whole reason negative ordinals exist:
      // "the last Friday of the month" cannot be written any other way, since
      // which numbered Friday that is changes from month to month.
      const pick = n > 0 ? matches[n - 1] : matches[matches.length + n];
      if (pick) days.push(pick);
    }
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

/** The same, spanning a whole year — for `FREQ=YEARLY;BYDAY=20MO` with no
 *  BYMONTH, where the ordinal counts through the year rather than the month. */
function bydayInYear(y, byday) {
  const out = [];
  for (const { n, day } of byday) {
    const matches = [];
    for (let mo = 1; mo <= 12; mo++) {
      const len = daysInMonth(y, mo);
      for (let d = 1; d <= len; d++) if (dowOf(y, mo, d) === day) matches.push({ mo, d });
    }
    if (n === 0) out.push(...matches);
    else {
      const pick = n > 0 ? matches[n - 1] : matches[matches.length + n];
      if (pick) out.push(pick);
    }
  }
  return out;
}

/** A day-of-month from BYMONTHDAY, which counts from the END when negative.
 *  Returns 0 when the month is too short — RFC 5545 says such an occurrence is
 *  SKIPPED, never clamped onto a neighbouring day. */
function monthDay(y, mo, n) {
  const len = daysInMonth(y, mo);
  const d = n > 0 ? n : len + n + 1;
  return d >= 1 && d <= len ? d : 0;
}

/** Candidate dates (no time yet) for one period, ascending. */
function datesInPeriod(rule, periodStart, start) {
  const out = [];
  const push = (y, mo, d) => { if (d >= 1 && d <= daysInMonth(y, mo)) out.push({ y, mo, d }); };

  switch (rule.freq) {
    case 'SECONDLY': case 'MINUTELY': case 'HOURLY':
    case 'DAILY':
      push(periodStart.y, periodStart.mo, periodStart.d);
      break;

    case 'WEEKLY': {
      // The period is the week CONTAINING periodStart, which was aligned to
      // WKST when the walk began. Without that alignment, INTERVAL=2 with
      // BYDAY=MO,FR would put Monday and Friday in different fortnights
      // whenever DTSTART fell mid-week.
      const days = rule.byday?.length ? rule.byday.map((b) => b.day) : [dowOf(start.y, start.mo, start.d)];
      for (let i = 0; i < 7; i++) {
        const c = addDays(periodStart, i);
        if (days.includes(dowOf(c.y, c.mo, c.d))) push(c.y, c.mo, c.d);
      }
      break;
    }

    case 'MONTHLY': {
      const { y, mo } = periodStart;
      if (rule.bymonthday?.length) {
        for (const n of rule.bymonthday) { const d = monthDay(y, mo, n); if (d) push(y, mo, d); }
      } else if (rule.byday?.length) {
        for (const d of bydayInMonth(y, mo, rule.byday)) push(y, mo, d);
      } else {
        // DTSTART's day of month. A 31st simply does not occur in a 30-day
        // month — push() drops it rather than sliding it to the 30th.
        push(y, mo, start.d);
      }
      break;
    }

    case 'YEARLY': {
      const y = periodStart.y;
      const months = rule.bymonth?.length ? rule.bymonth : null;
      if (rule.byyearday?.length) {
        const len = daysInMonth(y, 2) === 29 ? 366 : 365;
        for (const n of rule.byyearday) {
          const doy = n > 0 ? n : len + n + 1;
          if (doy < 1 || doy > len) continue;
          const t = new Date(Date.UTC(y, 0, doy));
          push(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
        }
      } else if (rule.bymonthday?.length) {
        for (const mo of months || [start.mo]) {
          for (const n of rule.bymonthday) { const d = monthDay(y, mo, n); if (d) push(y, mo, d); }
        }
      } else if (rule.byday?.length) {
        if (months) for (const mo of months) for (const d of bydayInMonth(y, mo, rule.byday)) push(y, mo, d);
        // No BYMONTH: the ordinal counts through the whole YEAR, which is what
        // makes "the 20th Monday of the year" expressible at all.
        else for (const { mo, d } of bydayInYear(y, rule.byday)) push(y, mo, d);
      } else if (months) {
        for (const mo of months) push(y, mo, start.d);
      } else {
        push(y, start.mo, start.d);
      }
      break;
    }
    default:
      return [];
  }

  return out.sort((a, b) => a.y - b.y || a.mo - b.mo || a.d - b.d);
}

/** BY parts that act as FILTERS rather than expanding — applied after the
 *  candidates exist, per RFC 5545 §3.3.10's table. */
function passesFilters(rule, c) {
  if (rule.bymonth?.length && rule.freq !== 'YEARLY' && !rule.bymonth.includes(c.mo)) return false;
  if (rule.byweekno?.length) {
    const w = isoWeek(c.y, c.mo, c.d);
    const lastWeek = isoWeek(c.y, 12, 28); // 28 Dec is always in the last ISO week
    if (!rule.byweekno.some((n) => (n > 0 ? n : lastWeek + n + 1) === w)) return false;
  }
  // For DAILY, BYMONTHDAY and BYDAY narrow rather than expand.
  if (rule.freq === 'DAILY') {
    if (rule.bymonthday?.length && !rule.bymonthday.some((n) => monthDay(c.y, c.mo, n) === c.d)) return false;
    if (rule.byday?.length && !rule.byday.some((b) => b.day === dowOf(c.y, c.mo, c.d))) return false;
  }
  // For WEEKLY, BYMONTHDAY is a filter (BYDAY already expanded above).
  if (rule.freq === 'WEEKLY' && rule.bymonthday?.length
      && !rule.bymonthday.some((n) => monthDay(c.y, c.mo, n) === c.d)) return false;
  // For MONTHLY with BOTH BYMONTHDAY and BYDAY, the two intersect: "Friday the
  // 13th" is FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13, and treating either as an
  // expansion alone gives twelve wrong answers a year.
  if (rule.freq === 'MONTHLY' && rule.bymonthday?.length && rule.byday?.length
      && !rule.byday.some((b) => b.day === dowOf(c.y, c.mo, c.d))) return false;
  if (rule.freq === 'YEARLY' && rule.bymonth?.length && !rule.bymonth.includes(c.mo)) return false;
  // YEARLY with BOTH BYMONTHDAY and BYDAY intersects too, exactly as MONTHLY
  // does above. This is what US election day is: FREQ=YEARLY;INTERVAL=4;
  // BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8 — "the first Tuesday after a
  // Monday in November". Without the intersection it is every day from the 2nd
  // to the 8th, which is seven wrong answers per election.
  if (rule.freq === 'YEARLY' && rule.bymonthday?.length && rule.byday?.length
      && !rule.byday.some((b) => b.day === dowOf(c.y, c.mo, c.d))) return false;
  return true;
}

/** `bysetpos` picks positions out of the period's own ordered candidate list.
 *  Negative counts from the end — "the last workday of the month" is
 *  BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1, and there is no other way to say it. */
function applySetPos(list, bysetpos) {
  if (!bysetpos?.length) return list;
  const out = [];
  for (const n of bysetpos) {
    const i = n > 0 ? n - 1 : list.length + n;
    if (i >= 0 && i < list.length) out.push(list[i]);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Moves a period start on by one INTERVAL. */
function advance(rule, p) {
  const n = rule.interval;
  switch (rule.freq) {
    case 'DAILY': return addDays(p, n);
    case 'WEEKLY': return addDays(p, 7 * n);
    case 'MONTHLY': {
      const total = (p.y * 12 + (p.mo - 1)) + n;
      // Day 1, always: a period is a MONTH, and carrying DTSTART's day here
      // would make the walk itself skip 31-day-only months rather than the
      // candidate generation doing it.
      return { y: Math.floor(total / 12), mo: (total % 12) + 1, d: 1, h: p.h, mi: p.mi, s: p.s };
    }
    case 'YEARLY': return { ...p, y: p.y + n, mo: 1, d: 1 };
    default: return addDays(p, n);
  }
}

/** Where the walk begins: the start of the period containing DTSTART. */
function firstPeriod(rule, start) {
  switch (rule.freq) {
    case 'WEEKLY': {
      // Aligned back to WKST — see the note in datesInPeriod.
      const wkst = DAY_INDEX[rule.wkst] ?? 1;
      const back = (dowOf(start.y, start.mo, start.d) - wkst + 7) % 7;
      return addDays(start, -back);
    }
    case 'MONTHLY': return { ...start, d: 1 };
    case 'YEARLY': return { ...start, mo: 1, d: 1 };
    default: return { ...start };
  }
}

/**
 * How many whole INTERVALs may be skipped to reach the window, or 0.
 *
 * Purely an optimisation, and one that is switched OFF whenever COUNT is
 * present — COUNT is counted from DTSTART, so skipping ahead would lose track
 * of how many occurrences have already happened and let a finished series carry
 * on forever. That distinction is the only subtle thing here.
 */
function skipAhead(rule, period, fromMs, zone) {
  if (rule.count) return 0;
  const fromWall = new Date(fromMs);
  const py = period.y, pm = period.mo;
  const fy = fromWall.getUTCFullYear(), fm = fromWall.getUTCMonth() + 1;
  let n = 0;
  switch (rule.freq) {
    case 'DAILY':
      n = Math.floor((fromMs - wallToInstant(period, zone)) / 86400000 / rule.interval);
      break;
    case 'WEEKLY':
      n = Math.floor((fromMs - wallToInstant(period, zone)) / (7 * 86400000) / rule.interval);
      break;
    case 'MONTHLY':
      n = Math.floor(((fy * 12 + fm) - (py * 12 + pm)) / rule.interval);
      break;
    case 'YEARLY':
      n = Math.floor((fy - py) / rule.interval);
      break;
    default: return 0;
  }
  // One period of slack: an occurrence belonging to the period BEFORE the
  // window can still land inside it (a monthly rule whose day falls late in the
  // month, queried from mid-month), and losing it would be a silently missing
  // event rather than a visible error.
  return Math.max(0, n - 1);
}

/**
 * The occurrence start instants of a recurring event that fall in `[from, to)`.
 *
 * `spec`:
 *   start    {y, mo, d, h, mi, s} — DTSTART's WALL-CLOCK components
 *   zone     IANA zone id, or null for a floating/UTC time
 *   rrule    the RRULE value string, or a parsed rule, or null for a one-off
 *   exdates  [ms] instants to remove (EXDATE)
 *   rdates   [ms] instants to add (RDATE)
 *
 * DTSTART is always emitted as the first occurrence, even when it does not
 * itself satisfy the rule. RFC 5545 calls that case undefined; showing the
 * event the author explicitly wrote down is the failure mode that loses nobody
 * a meeting, and hiding it is the one that does.
 */
export function expand(spec, { from, to, max = MAX_RESULTS } = {}) {
  const { start, zone = null, exdates = [], rdates = [] } = spec;
  const rule = parseRRule(spec.rrule);
  const startMs = wallToInstant(start, zone);
  const exclude = new Set(exdates);

  const collect = (list) => {
    const seen = new Set();
    return list
      .filter((ms) => !exclude.has(ms) && ms >= from && ms < to && !seen.has(ms) && seen.add(ms))
      .sort((a, b) => a - b)
      .slice(0, max);
  };

  if (!rule) return collect([startMs, ...rdates]);

  const untilMs = rule.until ? untilInstant(rule.until, zone) : null;
  const results = [];
  let emitted = 0;                 // occurrences since DTSTART, for COUNT
  let period = firstPeriod(rule, start);

  const skip = skipAhead(rule, period, from, zone);
  for (let i = 0; i < skip; i++) period = advance(rule, period);
  // Everything skipped over still counts as having happened, for the one thing
  // that cares — and skipAhead refuses to run at all when COUNT is set, so this
  // is only ever bookkeeping for the UNTIL path.
  emitted += skip;

  for (let n = 0; n < MAX_PERIODS; n++) {
    const dates = datesInPeriod(rule, period, start).filter((c) => passesFilters(rule, c));
    const times = timesOf(rule, start);
    let inPeriod = [];
    for (const c of dates) for (const t of times) inPeriod.push(wallToInstant({ ...c, ...t }, zone));
    inPeriod = applySetPos([...new Set(inPeriod)].sort((a, b) => a - b), rule.bysetpos);

    for (const ms of inPeriod) {
      // Nothing before DTSTART is an occurrence, however well it fits the rule.
      if (ms < startMs) continue;
      if (untilMs !== null && ms > untilMs) { n = MAX_PERIODS; break; }
      emitted++;
      if (rule.count && emitted > rule.count) { n = MAX_PERIODS; break; }
      if (ms >= to) continue;      // later periods may still be needed for COUNT
      if (ms >= from) results.push(ms);
    }
    if (n >= MAX_PERIODS) break;
    if (results.length >= max) break;

    period = advance(rule, period);
    // Past the window with no COUNT left to satisfy: nothing further can land
    // inside it. With COUNT, the walk has to continue until the count is spent,
    // which is what makes a finished series stop appearing.
    if (!rule.count && wallToInstant(period, zone) > to) break;
    if (rule.count && emitted >= rule.count) break;
  }

  // DTSTART is an occurrence in its own right, and RDATEs are added outright —
  // an RDATE is an explicit "also on this date" and is not subject to the rule.
  return collect([startMs, ...results, ...rdates]);
}

/** UNTIL is usually a UTC instant (`…Z`) and occasionally a local wall time.
 *  Read wrong, a series either stops a day early or never stops. */
function untilInstant(value, zone) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d, hh = '23', mi = '59', ss = '59', z] = m;
  const parts = { y: +y, mo: +mo, d: +d, h: +hh, mi: +mi, s: +ss };
  return z ? wallToInstant(parts, 'UTC') : wallToInstant(parts, zone);
}

/** Exported for the test suite, which asserts on the pieces as well as the
 *  whole — a wrong `bydayInMonth` is far easier to read as a failed assertion
 *  about "the last Friday in February" than as a missing occurrence. */
export const _internals = { bydayInMonth, bydayInYear, monthDay, isoWeek, applySetPos, daysInMonth, dowOf };
