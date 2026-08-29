// Hmelj — reading the meeting invitation inside a message.
//
// A meeting request is an ordinary email carrying a `text/calendar` part with
// `METHOD:REQUEST` (RFC 5545 / RFC 6047's iTIP). Parsing it here rather than in
// each protocol client means one implementation covers all three: Exchange and
// Graph both hand over the whole raw MIME, and an IMAP account gets the same
// part from the same place.
//
// ── Scope ────────────────────────────────────────────────────────────────────
// Enough of RFC 5545 to describe ONE event to a reader: when, where, who, and
// what kind of message this is. Deliberately not a calendar engine — no
// recurrence expansion, no free/busy, no VTODO/VJOURNAL. Full calendaring is a
// later, separate thing; this only has to make an invitation in the inbox
// readable and answerable.
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
// Pure, no imports — see test/icalendar-test.mjs.

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

/** Unfolds RFC 5545 line folding: a CRLF followed by one space or tab is a
 *  continuation, not a new line. Done before anything else, or a long LOCATION
 *  arrives in pieces. */
export function unfold(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

/** `\,` `\;` `\n` `\\` — RFC 5545's TEXT escaping. */
export function unescapeText(v) {
  return String(v || '').replace(/\\([\\;,nN])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

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
 *  Node already carries one, and it is the same one the rest of the app uses. */
function zoneOffsetMinutes(tzid, utcGuess) {
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
    // Two passes: the offset depends on the instant, and the instant depends on
    // the offset. Starting from the wall time read as UTC and correcting twice
    // settles it, including across a DST boundary.
    let guess = new Date(wall);
    for (let i = 0; i < 2; i++) {
      const off = zoneOffsetMinutes(zone, guess);
      if (off === null) break;
      guess = new Date(wall - off * 60000);
    }
    return { iso: guess.toISOString(), allDay: false, floating: false, zone };
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

/**
 * The invitation inside a `text/calendar` part, or null if there isn't one.
 *
 * Returns `{ method, uid, sequence, summary, location, description, start, end,
 * allDay, organizer, attendees, recurrence, status }`. `method` is what makes
 * this actionable at all: REQUEST is an invitation, CANCEL a withdrawal, REPLY
 * somebody else's answer to one of yours — three quite different things to show.
 */
export function parseInvitation(text) {
  const src = unfold(text);
  if (!/BEGIN:VCALENDAR/i.test(src)) return null;

  let method = '';
  let inEvent = false, depth = 0;
  const ev = { attendees: [] };
  let dtStart = null, dtEnd = null, duration = null;

  for (const rawLine of src.split('\n')) {
    const line = parseLine(rawLine.trim());
    if (!line) continue;
    if (line.name === 'BEGIN') {
      const v = line.value.toUpperCase();
      if (v === 'VEVENT' && !ev.__seen) { inEvent = true; ev.__seen = true; }
      else if (inEvent) depth++;
      continue;
    }
    if (line.name === 'END') {
      if (inEvent && depth === 0 && line.value.toUpperCase() === 'VEVENT') inEvent = false;
      else if (depth > 0) depth--;
      continue;
    }
    // METHOD lives on the VCALENDAR, outside the event.
    if (!inEvent && line.name === 'METHOD') { method = line.value.trim().toUpperCase(); continue; }
    // Everything below belongs to the FIRST VEVENT only. A recurring meeting's
    // exception events (RECURRENCE-ID) follow it, and taking their fields would
    // describe the wrong occurrence.
    if (!inEvent || depth > 0) continue;

    switch (line.name) {
      case 'UID': ev.uid = line.value.trim(); break;
      case 'SEQUENCE': ev.sequence = Number(line.value) || 0; break;
      case 'SUMMARY': ev.summary = unescapeText(line.value); break;
      case 'LOCATION': ev.location = unescapeText(line.value); break;
      case 'DESCRIPTION': ev.description = unescapeText(line.value); break;
      case 'STATUS': ev.status = line.value.trim().toUpperCase(); break;
      case 'RRULE': ev.recurrence = line.value.trim(); break;
      case 'DTSTART': dtStart = parseDate(line.value, line.params); break;
      case 'DTEND': dtEnd = parseDate(line.value, line.params); break;
      case 'DURATION': duration = parseDuration(line.value); break;
      case 'ORGANIZER': ev.organizer = person(line); break;
      case 'ATTENDEE': { const p = person(line); if (p) ev.attendees.push(p); break; }
      default: break;
    }
  }

  if (!ev.__seen) return null;
  delete ev.__seen;

  // An event may give an end or a length, never neither in practice — and when
  // it really gives neither, an end of null is better than an invented one.
  if (!dtEnd && dtStart && duration && !dtStart.floating && !dtStart.allDay) {
    dtEnd = { iso: new Date(new Date(dtStart.iso).getTime() + duration).toISOString(), allDay: false, floating: false, zone: dtStart.zone };
  }

  return {
    method: method || 'PUBLISH',
    uid: ev.uid || null,
    sequence: ev.sequence || 0,
    summary: ev.summary || '',
    location: ev.location || '',
    description: ev.description || '',
    status: ev.status || null,
    recurrence: ev.recurrence || null,
    start: dtStart,
    end: dtEnd,
    allDay: !!dtStart?.allDay,
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
