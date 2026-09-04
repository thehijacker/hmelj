// Hmelj — reading iCalendar: the meeting invitation inside a message, and the
// whole calendars that live on a CalDAV server.
//
// It started as the first of those and grew the second when the calendar
// arrived. The two halves share everything that matters — the content-line
// grammar, the escaping, and above all the time-zone resolution — so keeping
// them together is what stops an invitation and a calendar entry disagreeing
// about when the same meeting is.
//
// A meeting request is an ordinary email carrying a `text/calendar` part with
// `METHOD:REQUEST` (RFC 5545 / RFC 6047's iTIP). Parsing it here rather than in
// each protocol client means one implementation covers all three: Exchange and
// Graph both hand over the whole raw MIME, and an IMAP account gets the same
// part from the same place.
//
// ── Scope ────────────────────────────────────────────────────────────────────
// Reading only. VEVENT and its VALARMs, with recurrence read but not expanded
// (that is server/rrule.js, which builds on the zone helpers below). Still no
// VTODO, no VJOURNAL and no free/busy: nothing in Hmelj shows those, and
// parsing something nothing displays is how a parser acquires bugs nobody
// notices.
//
// ── Times, and the one place this refuses to guess ───────────────────────────
// A DTSTART comes in three forms, and only two of them name an instant:
//   20260827T132200Z            UTC — exact
//   TZID=Europe/Ljubljana:…     a zone — exact, once resolved
//   20260827T132200             floating: whatever the clock said, no zone
// Exchange writes the middle form with a WINDOWS zone name ("W. Europe Standard
// Time"), which no `Intl` implementation knows. Those are mapped below where
// the mapping is unambiguous; anything left over is reported as floating with
// its zone name carried alongside, so the reading pane can show the wall-clock time
// the sender wrote and name the zone rather than silently converting it wrong.
//
// One import, itself pure — see test/icalendar-test.mjs, test/calendar-parse-test.mjs
// and test/calendar-write-test.mjs.

import { unfold, unescapeText, escapeText, foldLine } from './contentLine.js';

/**
 * Windows time-zone names → IANA, for the zones a European Exchange actually
 * emits. Not exhaustive by design: a wrong mapping is worse than no mapping,
 * because an unmapped zone degrades to "shown as written, zone named" while a
 * wrong one silently moves a meeting.
 */
const WINDOWS_ZONES = {
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'gtb standard time': 'Europe/Bucharest',
  'russian standard time': 'Europe/Moscow',
  'utc': 'UTC',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
  'india standard time': 'Asia/Kolkata',
  'china standard time': 'Asia/Shanghai',
  'tokyo standard time': 'Asia/Tokyo',
  'aus eastern standard time': 'Australia/Sydney',
};

// The line grammar itself lives in server/contentLine.js now — iCalendar and
// vCard share it exactly, and server/vcard.js said from the start that the
// arrival of a serializer here would be the moment to extract it. Re-exported
// rather than merely imported: `unfold` and `unescapeText` have been part of
// this module's public surface since it was written, and several callers (and
// test/icalendar-test.mjs) take them from here.
export { unfold, unescapeText, escapeText, foldLine };

/**
 * One content line, split into name, parameters and value.
 *
 * The value is everything after the FIRST unquoted colon — a parameter value
 * may itself be a quoted string containing colons (`TZID="GMT+01:00 Sarajevo"`
 * is a real thing Exchange writes), which is why this cannot be a `split(':')`.
 */
export function parseLine(line) {
  let i = 0, inQuotes = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ':' && !inQuotes) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = [];
  let cur = '', q = false;
  for (const c of head) {
    if (c === '"') { q = !q; continue; }
    if (c === ';' && !q) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  const name = (parts.shift() || '').toUpperCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name, params, value };
}

/** The UTC offset of `tzid` at a given instant, in minutes, or null if the zone
 *  is not one this runtime knows. Uses Intl rather than a bundled tz database:
 *  Node already carries one, and it is the same one the rest of the app uses.
 *
 *  Exported for server/rrule.js, which cannot do its job in UTC — see
 *  `wallToInstant` below. */
export function zoneOffsetMinutes(tzid, utcGuess) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = Object.fromEntries(dtf.formatToParts(utcGuess).map((x) => [x.type, x.value]));
    // What the wall clock in that zone reads at this instant, read back as if
    // it were UTC: the difference between the two IS the offset.
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return Math.round((asUtc - utcGuess.getTime()) / 60000);
  } catch {
    return null; // not a zone this runtime knows — Windows name, or nonsense
  }
}

/** Resolves an IANA zone id from whatever a TZID parameter happens to say. */
export function ianaZone(tzid) {
  const raw = String(tzid || '').replace(/^"|"$/g, '').trim();
  if (!raw) return null;
  if (zoneOffsetMinutes(raw, new Date()) !== null) return raw;
  const mapped = WINDOWS_ZONES[raw.toLowerCase()];
  return mapped && zoneOffsetMinutes(mapped, new Date()) !== null ? mapped : null;
}

/**
 * A wall-clock reading in a zone → the instant it names, in epoch ms.
 *
 * ── Why this exists, and why recurrence cannot be done in UTC ────────────────
 * "Every Monday at 09:00" is a statement about a CLOCK, not about an instant.
 * Across a DST boundary the two diverge: in Europe/Ljubljana, 09:00 local is
 * 08:00Z in winter and 07:00Z in summer. A recurrence expanded by adding
 * 7×24×3600×1000 ms to a UTC instant therefore drifts by an hour twice a year,
 * silently, and every meeting after the last Sunday in March is wrong.
 *
 * So server/rrule.js walks the recurrence in wall-clock components and converts
 * each occurrence through here, which is the only place the zone is consulted.
 *
 * The two-pass correction is not a heuristic: the offset depends on the
 * instant, and the instant depends on the offset. Starting from the wall time
 * read as if it were UTC and correcting twice settles it, including across a
 * boundary. (Two passes suffice because the second correction moves by at most
 * the DST delta, which cannot itself cross another boundary.)
 *
 * A wall time that does not exist — 02:30 on a spring-forward night — resolves
 * to the instant the clock jumped to, which is what every calendar client does
 * and what the user means. One that happens twice resolves to the first.
 */
export function wallToInstant({ y, mo, d, h = 0, mi = 0, s = 0 }, zone) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  if (!zone || zone === 'UTC') return wall;
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const off = zoneOffsetMinutes(zone, new Date(guess));
    if (off === null) return wall; // unknown zone: the wall clock, said plainly
    guess = wall - off * 60000;
  }
  return guess;
}

/** The inverse: what the clock in `zone` reads at an instant. The counterpart
 *  of wallToInstant, and the reason a month grid can be drawn for a viewer in a
 *  different zone from the events in it. */
export function instantToWall(ms, zone) {
  if (!zone || zone === 'UTC') {
    const dt = new Date(ms);
    return {
      y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(),
      h: dt.getUTCHours(), mi: dt.getUTCMinutes(), s: dt.getUTCSeconds(),
    };
  }
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    // hour comes back as 24 rather than 0 for midnight under hour12:false in
    // several ICU versions — the same modulo the offset helper above applies.
    return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
  } catch {
    return instantToWall(ms, 'UTC');
  }
}

/** `2026-08-31` for an instant, as read in `zone`. The key a day-grid groups
 *  by, and deliberately not `toISOString().slice(0,10)` — that answers in UTC,
 *  which puts a 23:30 event on the wrong day for anyone east of Greenwich. */
export function dayKey(ms, zone) {
  const w = instantToWall(ms, zone);
  return `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

/**
 * A DATE or DATE-TIME value → `{ iso, allDay, floating, zone }`.
 *
 * `iso` is an instant whenever one can be established. For a floating time it
 * is still filled in — as the wall-clock reading, marked `floating` — because a
 * reading pane has to show something, and the honest thing to show is the time
 * the sender wrote, with the zone named beside it.
 */
export function parseDate(value, params = {}) {
  const raw = String(value || '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  const allDay = hh === undefined || params.VALUE === 'DATE';
  if (allDay) {
    return { iso: `${y}-${mo}-${d}`, allDay: true, floating: false, zone: null };
  }
  const wall = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
  if (z) return { iso: new Date(wall).toISOString(), allDay: false, floating: false, zone: 'UTC' };

  const declared = String(params.TZID || '').replace(/^"|"$/g, '');
  const zone = ianaZone(declared);
  if (zone) {
    // The two-pass correction lives in wallToInstant now — same arithmetic,
    // one copy, and shared with the recurrence expander that depends on it.
    const ms = wallToInstant({ y: +y, mo: +mo, d: +d, h: +hh, mi: +mi, s: +ss }, zone);
    return { iso: new Date(ms).toISOString(), allDay: false, floating: false, zone };
  }
  // Floating, or a zone nothing here can resolve. The wall clock, said plainly.
  return {
    iso: `${y}-${mo}-${d}T${hh}:${mi}:${ss}`,
    allDay: false, floating: true,
    zone: declared || null,
  };
}

/** `DURATION:PT1H30M` → milliseconds, for an event that gives a length instead
 *  of an end. Weeks and days included; months and years are not valid here. */
export function parseDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value || '').trim());
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+w || 0) * 604800 + (+d || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0)) * 1000;
  if (!ms) return null;
  return sign === '-' ? -ms : ms;
}

const addressOf = (v) => String(v || '').replace(/^mailto:/i, '').trim();

function person(line) {
  const address = addressOf(line.value);
  if (!address) return null;
  return {
    name: unescapeText(line.params.CN || '').replace(/^"|"$/g, ''),
    address,
    // PARTSTAT is the attendee's own answer so far — NEEDS-ACTION until they
    // reply. On an invitation everyone reads as NEEDS-ACTION; it is the
    // ATTENDEE list of a REPLY that carries a real one.
    status: (line.params.PARTSTAT || '').toUpperCase() || null,
    role: (line.params.ROLE || '').toUpperCase() || null,
    rsvp: String(line.params.RSVP || '').toUpperCase() === 'TRUE',
    optional: (line.params.ROLE || '').toUpperCase() === 'OPT-PARTICIPANT',
  };
}

/* ---------------- the component tree ---------------- */

/**
 * An iCalendar stream → a tree of components.
 *
 * BEGIN/END nest: a VCALENDAR holds VEVENTs, a VEVENT holds VALARMs, a
 * VTIMEZONE holds STANDARD and DAYLIGHT. The original invitation reader tracked
 * nesting with a depth counter because it only ever wanted one level; a real
 * calendar needs the alarms and the timezone definitions, so this builds the
 * tree properly and everything below reads it.
 *
 * Malformed nesting is tolerated rather than thrown on: an END with no matching
 * BEGIN closes nothing, and an unterminated component is closed at end of
 * input. A calendar file that is 99% valid should show 99% of its events, not
 * none of them.
 */
export function parseComponents(text) {
  const root = { name: 'ROOT', props: [], children: [] };
  const stack = [root];
  for (const raw of unfold(text).split('\n')) {
    const line = parseLine(raw.trim().replace(/\r$/, ''));
    if (!line) continue;
    if (line.name === 'BEGIN') {
      const node = { name: line.value.trim().toUpperCase(), props: [], children: [] };
      stack.at(-1).children.push(node);
      stack.push(node);
      continue;
    }
    if (line.name === 'END') {
      if (stack.length > 1 && stack.at(-1).name === line.value.trim().toUpperCase()) stack.pop();
      continue;
    }
    stack.at(-1).props.push(line);
  }
  return root;
}

const firstProp = (comp, name) => comp.props.find((p) => p.name === name) || null;
const propValue = (comp, name) => { const p = firstProp(comp, name); return p ? unescapeText(p.value) : ''; };
const allProps = (comp, name) => comp.props.filter((p) => p.name === name);

/**
 * A VTIMEZONE's fixed offset, in minutes, or null.
 *
 * Only ever consulted for a TZID that `Intl` does not know — an Exchange
 * "Customized Time Zone", say. And only when the definition has exactly ONE
 * observance: with both a STANDARD and a DAYLIGHT block, choosing between them
 * means evaluating their RRULEs against the occurrence, and a 50/50 guess that
 * moves half the year's meetings by an hour is worse than the honest fallback
 * (show the wall clock, name the zone) that a floating time already gets.
 */
function fixedOffsetOf(vtimezone) {
  const observances = vtimezone.children.filter((c) => c.name === 'STANDARD' || c.name === 'DAYLIGHT');
  if (observances.length !== 1) return null;
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(propValue(observances[0], 'TZOFFSETTO').trim());
  if (!m) return null;
  const mins = (+m[2]) * 60 + (+m[3]);
  return m[1] === '-' ? -mins : mins;
}

/** A DATE/DATE-TIME property, resolved against the calendar's own VTIMEZONE
 *  definitions when Intl cannot place the zone itself. */
function dateProp(line, tzOffsets) {
  if (!line) return null;
  const parsed = parseDate(line.value, line.params);
  if (!parsed || !parsed.floating) return parsed;
  // Floating because the TZID is one Intl does not know — but the file may have
  // told us the offset itself, and the sender's own declaration beats a guess.
  const declared = String(line.params.TZID || '').replace(/^"|"$/g, '');
  const off = tzOffsets?.get(declared);
  if (off == null) return parsed;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(parsed.iso);
  if (!m) return parsed;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - off * 60000;
  return { iso: new Date(ms).toISOString(), allDay: false, floating: false, zone: declared, fromVtimezone: true };
}

/** Several DATE values on one property (EXDATE, RDATE both take a comma list),
 *  each resolved the same way. */
function dateListProp(lines, tzOffsets) {
  const out = [];
  for (const line of lines) {
    for (const v of String(line.value).split(',')) {
      const d = dateProp({ ...line, value: v.trim() }, tzOffsets);
      if (d) out.push(d);
    }
  }
  return out;
}

/**
 * A VALARM. Only DISPLAY and AUDIO alarms mean anything to Hmelj (both become a
 * notification); an EMAIL alarm is the server's job to send, not this client's,
 * and firing our own as well would double every reminder.
 */
function parseAlarm(comp, tzOffsets) {
  const trigger = firstProp(comp, 'TRIGGER');
  if (!trigger) return null;
  const action = (propValue(comp, 'ACTION') || 'DISPLAY').toUpperCase();
  const isAbsolute = (trigger.params.VALUE || '').toUpperCase() === 'DATE-TIME' || /^\d{8}T/.test(trigger.value.trim());
  if (isAbsolute) {
    const at = dateProp(trigger, tzOffsets);
    return at ? { action, absolute: at, minutesBefore: null, related: null, description: propValue(comp, 'DESCRIPTION') } : null;
  }
  const ms = parseDuration(trigger.value);
  if (ms === null) return null;
  return {
    action,
    absolute: null,
    // Negative durations are the normal case ("15 minutes BEFORE"), so a
    // positive `minutesBefore` reads the way a person says it.
    minutesBefore: Math.round(-ms / 60000),
    // RELATED=END is rare but real, and a reminder measured from the wrong end
    // of a two-hour meeting is off by two hours.
    related: (trigger.params.RELATED || 'START').toUpperCase(),
    description: propValue(comp, 'DESCRIPTION'),
  };
}

/** One VEVENT component → the shape everything above this file works with. */
function parseEvent(comp, tzOffsets) {
  const start = dateProp(firstProp(comp, 'DTSTART'), tzOffsets);
  let end = dateProp(firstProp(comp, 'DTEND'), tzOffsets);
  const duration = parseDuration(propValue(comp, 'DURATION'));
  if (!end && start && duration && !start.floating) {
    end = {
      iso: start.allDay
        ? new Date(new Date(start.iso + 'T00:00:00Z').getTime() + duration).toISOString().slice(0, 10)
        : new Date(new Date(start.iso).getTime() + duration).toISOString(),
      allDay: start.allDay, floating: false, zone: start.zone,
    };
  }
  const rrule = firstProp(comp, 'RRULE');
  return {
    uid: propValue(comp, 'UID') || null,
    sequence: Number(propValue(comp, 'SEQUENCE')) || 0,
    // Present only on an EXCEPTION to a recurring series: it names WHICH
    // occurrence this component replaces. Its absence is what makes a component
    // the master, and getting that backwards duplicates every edited occurrence.
    recurrenceId: dateProp(firstProp(comp, 'RECURRENCE-ID'), tzOffsets),
    summary: propValue(comp, 'SUMMARY'),
    location: propValue(comp, 'LOCATION'),
    description: propValue(comp, 'DESCRIPTION'),
    url: propValue(comp, 'URL'),
    status: (propValue(comp, 'STATUS') || '').toUpperCase() || null,
    // OPAQUE (the default) means the time is busy; TRANSPARENT means the event
    // is on the calendar but does not block it — an all-day birthday, say.
    transparent: (propValue(comp, 'TRANSP') || 'OPAQUE').toUpperCase() === 'TRANSPARENT',
    categories: propValue(comp, 'CATEGORIES').split(',').map((c) => c.trim()).filter(Boolean),
    // RFC 7986's COLOR. The spec says a CSS3 colour NAME; Hmelj writes a hex
    // value, because the point of the feature is picking a colour rather than
    // choosing from the 147 names CSS happens to have, and every server tested
    // stores the property verbatim either way. Read back leniently — a name
    // written by some other client is handed on as-is and the browser resolves
    // it, since both are valid CSS.
    //
    // Note what this is NOT: Google colours its events with a private `colorId`
    // that its CalDAV endpoint does not publish, and Outlook has `categories`
    // with colours defined per mailbox. So a colour set here is Hmelj's own and
    // stays invisible in their web UIs — see normalizeEventColor's caller.
    color: propValue(comp, 'COLOR').trim() || null,
    start,
    end,
    allDay: !!start?.allDay,
    rrule: rrule ? rrule.value.trim() : null,
    exdates: dateListProp(allProps(comp, 'EXDATE'), tzOffsets),
    rdates: dateListProp(allProps(comp, 'RDATE'), tzOffsets),
    organizer: (() => { const l = firstProp(comp, 'ORGANIZER'); return l ? person(l) : null; })(),
    attendees: allProps(comp, 'ATTENDEE').map(person).filter(Boolean),
    alarms: comp.children.filter((c) => c.name === 'VALARM')
      .map((c) => parseAlarm(c, tzOffsets))
      .filter((a) => a && (a.action === 'DISPLAY' || a.action === 'AUDIO')),
    created: propValue(comp, 'CREATED') || null,
    lastModified: propValue(comp, 'LAST-MODIFIED') || null,
    dtstamp: propValue(comp, 'DTSTAMP') || null,
  };
}

/**
 * A whole `text/calendar` document.
 *
 * Returns `{ method, prodid, events, timezones }`, with `events` in document
 * order — masters and their `RECURRENCE-ID` exceptions together, unseparated,
 * because which is which is a property of the event (see `recurrenceId`) and
 * splitting them here would mean every caller had to put them back together to
 * store them.
 *
 * An event may have `start: null`. See the note at the filter below.
 *
 * Never throws. A file that is half garbage yields the half that parsed.
 */
export function parseCalendar(text) {
  const root = parseComponents(text);
  const cal = root.children.find((c) => c.name === 'VCALENDAR');
  if (!cal) return null;

  const tzOffsets = new Map();
  for (const tz of cal.children.filter((c) => c.name === 'VTIMEZONE')) {
    const tzid = propValue(tz, 'TZID').trim();
    const off = fixedOffsetOf(tz);
    if (tzid && off != null) tzOffsets.set(tzid, off);
  }

  // Every VEVENT, INCLUDING ones with no DTSTART. Such an event cannot be
  // placed on a grid, but a parser is not the place to decide that: an iTIP
  // CANCEL or REPLY routinely carries only a UID and a SEQUENCE, and those are
  // exactly the messages the reading pane has to show. Dropping them here made
  // a withdrawn meeting silently unreadable. The calendar sync layer skips
  // start-less events when storing them, which is where "cannot be placed"
  // actually means something.
  const events = cal.children
    .filter((c) => c.name === 'VEVENT')
    .map((c) => parseEvent(c, tzOffsets));

  return {
    method: (propValue(cal, 'METHOD') || 'PUBLISH').toUpperCase(),
    prodid: propValue(cal, 'PRODID'),
    timezones: Object.fromEntries(tzOffsets),
    events,
  };
}

/**
 * The invitation inside a `text/calendar` part, or null if there isn't one.
 *
 * Returns `{ method, uid, sequence, summary, location, description, start, end,
 * allDay, organizer, attendees, recurrence, status }`. `method` is what makes
 * this actionable at all: REQUEST is an invitation, CANCEL a withdrawal, REPLY
 * somebody else's answer to one of yours — three quite different things to show.
 */
export function parseInvitation(text) {
  const cal = parseCalendar(text);
  // The FIRST event only. A recurring meeting's exception components
  // (RECURRENCE-ID) follow the master, and taking their fields would describe
  // the wrong occurrence in the reading pane.
  const ev = cal?.events?.[0];
  if (!ev) return null;
  return {
    method: cal.method || 'PUBLISH',
    uid: ev.uid || null,
    sequence: ev.sequence || 0,
    summary: ev.summary || '',
    location: ev.location || '',
    description: ev.description || '',
    status: ev.status || null,
    recurrence: ev.rrule || null,
    start: ev.start,
    end: ev.end,
    allDay: !!ev.allDay,
    organizer: ev.organizer || null,
    attendees: ev.attendees,
  };
}

/** Can this message be answered with accept/tentative/decline? Only a live
 *  invitation can: a cancellation is news, a reply is somebody else's answer,
 *  and a cancelled event is not something to accept. */
export function isActionable(inv) {
  return !!inv && inv.method === 'REQUEST' && inv.status !== 'CANCELLED';
}

/* ---------------- writing ---------------- */

/**
 * A VTIMEZONE for an IANA zone, derived from what `Intl` already knows.
 *
 * ── Why this is needed at all ────────────────────────────────────────────────
 * A recurring event cannot be written in UTC. "Every Monday at 09:00 in
 * Ljubljana" written as `20260302T080000Z;FREQ=WEEKLY` is 09:00 until the last
 * Sunday in March and 10:00 for the rest of the year — the exact drift
 * server/rrule.js exists to prevent, reintroduced at the moment of writing. So
 * a zoned DTSTART is required, and RFC 5545 says a TZID must be defined by a
 * VTIMEZONE in the same object.
 *
 * ── Why it is derived rather than bundled ────────────────────────────────────
 * Shipping a tz database would be a second copy of something Node already
 * carries, and one that goes stale. This finds the year's transitions by
 * probing Intl (a binary search over `zoneOffsetMinutes`) and expresses each as
 * the "nth weekday of month" rule every real zone actually uses.
 *
 * Returns null when the zone has transitions this cannot express as a simple
 * rule — Lord Howe's half-hour shift, a zone that changed its rules mid-year,
 * anything unusual. The caller then falls back to writing UTC, which is always
 * valid and only loses the DST behaviour of a recurring event. Guessing a rule
 * would lose the same thing AND be wrong about when.
 */
export function buildVTimezone(zone, year = new Date().getUTCFullYear()) {
  if (!zone || zone === 'UTC') return null;
  const offsetAt = (ms) => zoneOffsetMinutes(zone, new Date(ms));
  const jan = Date.UTC(year, 0, 15);
  const jul = Date.UTC(year, 6, 15);
  const winter = offsetAt(jan);
  const summer = offsetAt(jul);
  if (winter === null || summer === null) return null;

  const fmt = (mins) => {
    const sign = mins < 0 ? '-' : '+';
    const a = Math.abs(mins);
    return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`;
  };

  // No daylight saving: one observance, no rule, nothing to get wrong.
  if (winter === summer) {
    return [
      'BEGIN:VTIMEZONE', `TZID:${zone}`,
      'BEGIN:STANDARD', 'DTSTART:19700101T000000',
      `TZOFFSETFROM:${fmt(winter)}`, `TZOFFSETTO:${fmt(winter)}`,
      'TZNAME:STD', 'END:STANDARD', 'END:VTIMEZONE',
    ];
  }

  /** The instant the offset changes, between two known-different probes. */
  const findTransition = (loMs, hiMs) => {
    let lo = loMs, hi = hiMs;
    const before = offsetAt(lo);
    for (let i = 0; i < 40 && hi - lo > 60000; i++) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (offsetAt(mid) === before) lo = mid; else hi = mid;
    }
    return hi;
  };

  const toDst = findTransition(jan, jul);
  const toStd = findTransition(jul, Date.UTC(year + 1, 0, 15));

  /** "the last Sunday in March" — the shape every real DST rule takes. Reported
   *  in the zone's own LOCAL time, which is what a VTIMEZONE observance means. */
  const ruleFor = (utcMs, offsetBefore) => {
    const local = new Date(utcMs + offsetBefore * 60000);
    const y = local.getUTCFullYear(), mo = local.getUTCMonth() + 1, d = local.getUTCDate();
    const dow = local.getUTCDay();
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    // Which occurrence of this weekday it is, counted from the end when that is
    // the shorter description — "-1SU" rather than "5SU", because a month with
    // only four Sundays has no fifth one and the rule would silently not fire.
    const nth = Math.floor((d - 1) / 7) + 1;
    const fromEnd = -Math.floor((daysInMonth - d) / 7) - 1;
    const ord = (daysInMonth - d) < 7 ? fromEnd : nth;
    const wd = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][dow];
    const p = (n) => String(n).padStart(2, '0');
    return {
      dtstart: `${y}${p(mo)}${p(d)}T${p(local.getUTCHours())}${p(local.getUTCMinutes())}00`,
      rrule: `FREQ=YEARLY;BYMONTH=${mo};BYDAY=${ord}${wd}`,
    };
  };

  const dst = ruleFor(toDst, winter);
  const std = ruleFor(toStd, summer);
  return [
    'BEGIN:VTIMEZONE', `TZID:${zone}`,
    'BEGIN:DAYLIGHT', `DTSTART:${dst.dtstart}`, `RRULE:${dst.rrule}`,
    `TZOFFSETFROM:${fmt(winter)}`, `TZOFFSETTO:${fmt(summer)}`, 'TZNAME:DST', 'END:DAYLIGHT',
    'BEGIN:STANDARD', `DTSTART:${std.dtstart}`, `RRULE:${std.rrule}`,
    `TZOFFSETFROM:${fmt(summer)}`, `TZOFFSETTO:${fmt(winter)}`, 'TZNAME:STD', 'END:STANDARD',
    'END:VTIMEZONE',
  ];
}

const pad = (n) => String(n).padStart(2, '0');

/** An instant as a UTC DATE-TIME: `20260901T090000Z`. */
export function icalUtc(ms) {
  const w = instantToWall(ms, 'UTC');
  return `${w.y}${pad(w.mo)}${pad(w.d)}T${pad(w.h)}${pad(w.mi)}${pad(w.s)}Z`;
}

/** An instant as a DATE in a zone: `20260901`. */
export function icalDate(ms, zone = 'UTC') {
  const w = instantToWall(ms, zone);
  return `${w.y}${pad(w.mo)}${pad(w.d)}`;
}

/**
 * One date-ish property line: `DTSTART;TZID=…:…` / `DTSTART;VALUE=DATE:…` /
 * `DTSTART:…Z`, whichever the value actually is.
 *
 * `zone` is only honoured for a timed value. An all-day event has no zone by
 * definition, and giving it one is what moves Christmas to the 24th for half
 * the world.
 */
export function dateLine(name, ms, { allDay = false, zone = null } = {}) {
  if (allDay) return `${name};VALUE=DATE:${icalDate(ms, 'UTC')}`;
  if (!zone || zone === 'UTC') return `${name}:${icalUtc(ms)}`;
  const w = instantToWall(ms, zone);
  return `${name};TZID=${zone}:${w.y}${pad(w.mo)}${pad(w.d)}T${pad(w.h)}${pad(w.mi)}${pad(w.s)}`;
}

const personLine = (name, p, extra = '') => {
  if (!p?.address) return null;
  const cn = p.name ? `;CN=${p.name.replace(/[";:]/g, ' ')}` : '';
  return `${name}${cn}${extra}:mailto:${p.address}`;
};

/**
 * A VEVENT's lines, from the shape parseCalendar produces.
 *
 * Used for events Hmelj CREATES. An event Hmelj is EDITING goes through
 * `patchEvent` instead, which rewrites only the properties Hmelj manages and
 * leaves everything else — the VTIMEZONE it came with, the X- properties its
 * own client wrote, the attendee parameters nothing here models — exactly where
 * they were. Same rule server/vcard.js follows, and for the same reason.
 */
export function serializeEvent(ev) {
  const zone = ev.allDay ? null : (ev.zone || null);
  const lines = ['BEGIN:VEVENT', `UID:${ev.uid}`, `DTSTAMP:${icalUtc(Date.now())}`];
  lines.push(dateLine('DTSTART', ev.start, { allDay: ev.allDay, zone }));
  if (ev.end != null) lines.push(dateLine('DTEND', ev.end, { allDay: ev.allDay, zone }));
  if (ev.recurrenceId != null) lines.push(dateLine('RECURRENCE-ID', ev.recurrenceId, { allDay: ev.allDay, zone }));
  if (ev.summary) lines.push(`SUMMARY:${escapeText(ev.summary)}`);
  if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
  if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
  if (ev.url) lines.push(`URL:${ev.url}`);
  if (ev.status) lines.push(`STATUS:${ev.status}`);
  if (ev.transparent) lines.push('TRANSP:TRANSPARENT');
  if (ev.categories?.length) lines.push(`CATEGORIES:${ev.categories.map(escapeText).join(',')}`);
  if (ev.color) lines.push(`COLOR:${escapeText(ev.color)}`);
  if (ev.rrule) lines.push(`RRULE:${ev.rrule}`);
  for (const ms of ev.exdates || []) lines.push(dateLine('EXDATE', ms, { allDay: ev.allDay, zone }));
  for (const ms of ev.rdates || []) lines.push(dateLine('RDATE', ms, { allDay: ev.allDay, zone }));
  if (Number.isFinite(ev.sequence)) lines.push(`SEQUENCE:${ev.sequence}`);
  const org = personLine('ORGANIZER', ev.organizer);
  if (org) lines.push(org);
  for (const a of ev.attendees || []) {
    // RSVP=TRUE is what makes a mail client offer Accept/Decline at all, and
    // PARTSTAT carries whatever answer is already known.
    const att = personLine('ATTENDEE', a,
      `;ROLE=${a.optional ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT'}`
      + `;PARTSTAT=${a.status || 'NEEDS-ACTION'};RSVP=TRUE`);
    if (att) lines.push(att);
  }
  for (const al of ev.alarms || []) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(al.description || ev.summary || 'Reminder')}`);
    if (al.absolute != null) lines.push(`TRIGGER;VALUE=DATE-TIME:${icalUtc(al.absolute)}`);
    else lines.push(`TRIGGER${al.related === 'END' ? ';RELATED=END' : ''}:-PT${Math.max(0, al.minutesBefore || 0)}M`);
    lines.push('END:VALARM');
  }
  lines.push('END:VEVENT');
  return lines;
}

/**
 * A complete `text/calendar` document.
 *
 * `events` are the shape `serializeEvent` takes. A VTIMEZONE is emitted for
 * every distinct zone the events use, once — and when one cannot be derived
 * (see buildVTimezone), the caller has already been told to fall back to UTC,
 * so a TZID here without a definition would be a bug rather than a compromise.
 */
export function serializeCalendar(events, { method = null, prodid = 'Hmelj' } = {}) {
  const list = Array.isArray(events) ? events : [events];
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${prodid}//EN`, 'CALSCALE:GREGORIAN'];
  if (method) lines.push(`METHOD:${method}`);
  const zones = [...new Set(list.filter((e) => !e.allDay && e.zone).map((e) => e.zone))];
  for (const z of zones) {
    const tz = buildVTimezone(z);
    if (tz) lines.push(...tz);
  }
  for (const ev of list) lines.push(...serializeEvent(ev));
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/**
 * Rewrites an EXISTING iCalendar document, changing only the properties named
 * in `patch` on the component that `match` selects.
 *
 * ── This is the non-destructive half, and it is the whole point ─────────────
 * A calendar entry on somebody's server carries far more than Hmelj models: the
 * VTIMEZONE it was written with, X-MICROSOFT-CDO-* fields Outlook needs,
 * attendee parameters, attachments, the organizer's SENT-BY. Regenerating the
 * event from what Hmelj understands would silently delete all of it on the
 * first edit — the same failure server/vcard.js exists to avoid on the contact
 * side, with the same fix: keep the original text and replace lines in place.
 *
 * `patch` maps a property name to a full replacement LINE (or an array of them,
 * or null to remove the property). Anything not mentioned is untouched.
 */
export function patchEvent(text, patch, { match = () => true } = {}) {
  const src = unfold(text);
  const out = [];
  let depth = 0;          // nesting inside the VEVENT (a VALARM, say)
  let inEvent = false;
  let selected = false;
  let pending = null;     // the component's lines, while deciding whether it matches

  const applyTo = (lines) => {
    const seen = new Set();
    const result = [];
    // Nesting depth INSIDE the VEVENT. A VALARM has its own DESCRIPTION and its
    // own TRIGGER, and a flat scan replaces those too — turning "set the event's
    // notes" into "overwrite the reminder text as well". The whole reason this
    // function exists is not to damage what it was not asked about.
    let inner = 0;
    for (const raw of lines) {
      if (/^BEGIN:/i.test(raw)) { if (result.length) inner++; result.push(raw); continue; }
      if (/^END:/i.test(raw)) { if (inner > 0) inner--; result.push(raw); continue; }
      const p = inner === 0 ? parseLine(raw) : null;
      const name = p?.name;
      if (name && Object.prototype.hasOwnProperty.call(patch, name)) {
        if (seen.has(name)) continue;              // a replaced property appears once
        seen.add(name);
        const replacement = patch[name];
        if (replacement == null) continue;         // removed
        for (const line of [].concat(replacement)) result.push(line);
        continue;
      }
      result.push(raw);
    }
    // Properties the original did not have at all still have to be added, or an
    // event that never carried a LOCATION could never be given one.
    for (const [name, replacement] of Object.entries(patch)) {
      if (seen.has(name) || replacement == null) continue;
      // Before END:VEVENT, and before any nested component — a property after
      // BEGIN:VALARM would belong to the alarm, not to the event.
      const at = result.findIndex((l) => /^BEGIN:VALARM/i.test(l));
      const insertAt = at === -1 ? Math.max(1, result.length - 1) : at;
      result.splice(insertAt, 0, ...[].concat(replacement));
    }
    return result;
  };

  for (const raw of src.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (/^BEGIN:VEVENT$/i.test(line)) {
      inEvent = true; depth = 0; pending = [line];
      continue;
    }
    if (inEvent) {
      if (/^BEGIN:/i.test(line)) depth++;
      else if (/^END:VEVENT$/i.test(line) && depth === 0) {
        pending.push(line);
        const parsed = parseCalendar(['BEGIN:VCALENDAR', 'VERSION:2.0', ...pending, 'END:VCALENDAR'].join('\r\n'));
        selected = !!parsed?.events?.[0] && match(parsed.events[0]);
        out.push(...(selected ? applyTo(pending) : pending));
        inEvent = false; pending = null;
        continue;
      } else if (/^END:/i.test(line)) depth--;
      pending.push(line);
      continue;
    }
    out.push(line);
  }
  if (pending) out.push(...pending); // unterminated component — keep it rather than lose it
  return out.map(foldLine).join('\r\n') + '\r\n';
}
