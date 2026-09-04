// Hmelj — Slovenian national holiday calendar. Pure calendar module: no I/O, no
// external date library (none exists anywhere in this project — see server/schedule.js
// for the notification-scheduler logic that consumes this).
//
// Two categories, both surfaced in the Scheduler UI's holidays list: work-free (dela
// prost dan — a real paid day off) and non-work-free "state holidays"/observances
// (praznik, ni dela prost dan). Only work-free ones make sense for a default "skip
// notifications on holidays" toggle, but the user can flip any individual holiday's
// work-free flag (see server/store.js's getHolidayOverrides()) — e.g. to also treat a
// non-work-free observance as quiet, or to NOT skip a work-free day they still want
// notified on.

/** Easter Sunday (Western/Gregorian) for a given year, via the Anonymous Gregorian
 *  algorithm (aka Meeus/Jones/Butcher) — integer arithmetic only, accurate for any
 *  Gregorian-calendar year. Returns a UTC-midnight Date.
 *  Verified for 2026: returns April 5 — matches independently-sourced references. */
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

// The 12 non-Easter-derived work-free days (dela prost dan), fixed month/day every
// year. These 12 + Easter Sunday + Easter Monday + Whit Sunday (Pentecost) = 15,
// which matches the official "15 paid work-free days per calendar year" figure.
const SI_FIXED_HOLIDAYS = [
  { month: 1, day: 1, name: 'Novo leto' },
  { month: 1, day: 2, name: 'Novo leto' },
  { month: 2, day: 8, name: 'Prešernov dan, slovenski kulturni praznik' },
  { month: 4, day: 27, name: 'Dan upora proti okupatorju' },
  { month: 5, day: 1, name: 'Praznik dela' },
  { month: 5, day: 2, name: 'Praznik dela' },
  { month: 6, day: 25, name: 'Dan državnosti' },
  { month: 8, day: 15, name: 'Marijino vnebovzetje' },
  { month: 10, day: 31, name: 'Dan reformacije' },
  { month: 11, day: 1, name: 'Dan spomina na mrtve' },
  { month: 12, day: 25, name: 'Božič' },
  { month: 12, day: 26, name: 'Dan samostojnosti in enotnosti' },
];

// Official state holidays that are NOT work-free (praznik, ni dela prost dan) —
// gathered from public sources but NOT fully cross-verified against the authoritative
// legal text (Zakon o praznikih in dela prostih dnevih v RS) as of this writing.
// Cosmetic risk only: workFreeDefault is always false for these, so they never factor
// into "skip holidays" notification gating even if a date below is slightly off — only
// the informational list shown in the Scheduler UI would show a wrong date. VERIFY DATE
// against an authoritative source before treating any of these as certain.
const SI_OBSERVANCES = [
  { month: 6, day: 8, name: 'Dan Primoža Trubarja' }, // VERIFY DATE
  { month: 8, day: 17, name: 'Dan združitve prekmurskih Slovencev z matičnim narodom' }, // VERIFY DATE
  { month: 9, day: 15, name: 'Vrnitev Primorske k matični domovini' }, // VERIFY DATE
  { month: 9, day: 23, name: 'Dan slovenskega športa' }, // VERIFY DATE
  { month: 10, day: 25, name: 'Dan suverenosti' }, // VERIFY DATE
  { month: 11, day: 10, name: 'Dan slovenske znanosti' }, // VERIFY DATE
  { month: 11, day: 23, name: 'Dan Rudolfa Maistra' }, // VERIFY DATE
];

/** Full Slovenian holiday calendar for one year: fixed dates + Easter-derived (Easter
 *  Sunday, Easter Monday, Whit Sunday/Pentecost = Easter + 49 days) + non-work-free
 *  observances, sorted chronologically. Pure, safe to call repeatedly/uncached — cheap
 *  even called once per notification check. */
export function getHolidaysForYear(year) {
  const easter = easterSunday(year);
  const list = [
    ...SI_FIXED_HOLIDAYS.map((h) => ({
      date: ymd(new Date(Date.UTC(year, h.month - 1, h.day))),
      name: h.name,
      workFreeDefault: true,
    })),
    { date: ymd(easter), name: 'Velika noč', workFreeDefault: true },
    { date: ymd(addDays(easter, 1)), name: 'Velikonočni ponedeljek', workFreeDefault: true },
    { date: ymd(addDays(easter, 49)), name: 'Binkošti', workFreeDefault: true },
    ...SI_OBSERVANCES.map((h) => ({
      date: ymd(new Date(Date.UTC(year, h.month - 1, h.day))),
      name: h.name,
      workFreeDefault: false,
    })),
  ];
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return list;
}

/** getHolidaysForYear() plus a user's own custom holidays (server/store.js's
 * getCustomHolidays() — {id, month, day, name, workFree}, no year: recurs every year
 * automatically, exactly like SI_FIXED_HOLIDAYS above, so a user only ever enters one
 * once). Lets a user who isn't in Slovenia build their own holiday list from scratch
 * without touching this file — the actual point of this function existing separately
 * from getHolidaysForYear, which stays Slovenia-only/hardcoded on purpose (a country
 * selector is a bigger feature this doesn't attempt to be).
 *
 * A custom entry's own `workFree` field is authoritative — unlike the built-in Slovenian
 * entries (whose workFreeDefault a user can only override via the separate
 * store.js holiday-overrides map, see server/schedule.js), a custom holiday has no
 * separate "default" to override at all: editing/removing the entry itself IS how its
 * work-free status changes. Marked `custom: true` so callers (the Scheduler UI, and the
 * /api/holidays route's own override-merge step) can tell the two kinds apart. */
export function resolveHolidaysForYear(year, customHolidays = []) {
  const custom = customHolidays.map((h) => ({
    id: h.id,
    date: ymd(new Date(Date.UTC(year, h.month - 1, h.day))),
    name: h.name,
    workFreeDefault: !!h.workFree,
    custom: true,
  }));
  const list = [...getHolidaysForYear(year), ...custom];
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return list;
}
