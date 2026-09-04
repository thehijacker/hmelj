// Hmelj — "what is on my calendar between these two instants".
//
// The read path. Everything the UI draws comes through here, and it is the one
// place three separate things are reconciled: the stored components, the
// recurrence rules that turn one of them into many, and the exceptions that
// replace individual occurrences of a series.
//
// ── Which zone an event recurs in ────────────────────────────────────────────
// Three cases, and they are genuinely different:
//
//   all-day    UTC, always. An all-day event on 25 December is on 25 December
//              for everybody; anchoring it to the viewer's zone would move it to
//              the 24th for anyone west of the anchor and back again when they
//              travelled. Stored as UTC midnight, and formatted back in UTC —
//              which is why `allDay` has to survive all the way to the browser.
//
//   zoned      the event's own zone. "09:00 in Ljubljana" stays 09:00 in
//              Ljubljana across a DST boundary even for a viewer in London, and
//              the UTC instant moves accordingly. See server/rrule.js.
//
//   floating   the VIEWER's zone. That is what floating MEANS — whatever the
//              clock says where you are — so it is resolved at query time and
//              never at storage time, or changing your timezone setting would
//              leave every floating event where the old one put it.
//
// ── Exceptions ───────────────────────────────────────────────────────────────
// A recurring series can have individual occurrences edited or cancelled. Each
// one is stored as its own component keyed by RECURRENCE-ID. Expanding the
// master and then ALSO emitting the exceptions would show every edited
// occurrence twice — once where the rule puts it, once where it actually is —
// which is the single most visible bug a calendar client can have. So the
// master's expansion skips any occurrence an exception overrides, and the
// exceptions are emitted in their own right.
import * as cache from './cache.js';
import * as store from './calendarStore.js';
import { expand } from './rrule.js';
import { instantToWall, wallToInstant, dayKey } from './icalendar.js';
import { log } from './log.js';
import { findJoinUrl } from './onlineMeeting.js';

const clog = log.scope('calendar');

/** How far outside the requested window to look for candidate components.
 *  An event starting at 23:30 the day before still shows in today's grid, and a
 *  floating event's stored start is only accurate to within a zone offset (see
 *  `zoneOf`) — one day of slack covers both without materially widening the
 *  query. */
const CANDIDATE_PAD_MS = 86400000;

/** A hard ceiling on what one query may return. A month view over a dozen
 *  calendars is a few hundred; this is the guard against a per-minute rule
 *  somebody's script generated. */
const MAX_OCCURRENCES = 5000;

/** The zone a component's recurrence is computed in — see this file's header. */
function zoneOf(ev, viewerZone) {
  if (ev.allDay) return 'UTC';
  if (ev.start?.floating) return viewerZone || 'UTC';
  return ev.start?.zone || 'UTC';
}

/** DTSTART as wall-clock components in its own zone, which is what rrule.js
 *  walks. Three shapes in, one shape out. */
function startWall(ev, zone) {
  const iso = ev.start?.iso || '';
  if (ev.allDay) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? { y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, s: 0 } : null;
  }
  if (ev.start?.floating) {
    // A floating time is already wall-clock; reading it as an instant and
    // converting back would apply the viewer's offset twice.
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
    return m ? { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] } : null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? instantToWall(ms, zone) : null;
}

/** An EXDATE/RDATE/RECURRENCE-ID value → the instant it names, resolved the
 *  same way the event's own start is. They have to agree exactly, or an EXDATE
 *  removes nothing and an exception overrides nothing. */
function refInstant(d, zone) {
  if (!d?.iso) return null;
  if (d.allDay) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d.iso);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  }
  if (d.floating) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(d.iso);
    return m ? wallToInstant({ y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] }, zone) : null;
  }
  const ms = Date.parse(d.iso);
  return Number.isFinite(ms) ? ms : null;
}

/** How long the event lasts, in ms. An all-day event with no end is one day;
 *  a timed event with no end is a point in time, which several senders do mean. */
function durationOf(ev) {
  const startMs = refInstant(ev.start, 'UTC');
  const endMs = ev.end ? refInstant(ev.end, 'UTC') : null;
  if (startMs != null && endMs != null && endMs > startMs) return endMs - startMs;
  return ev.allDay ? 86400000 : 0;
}

/** The row a client draws. Flat, already resolved, and carrying nothing it does
 *  not need — the raw iCalendar stays on the server. */
function occurrence(row, ev, startMs, durationMs, viewerZone, colors = null) {
  return {
    // Stable across queries and unique per occurrence, so the UI can key on it:
    // a series has one row per occurrence and they must not collide.
    id: `${row.calendar_id}~${row.uid}~${startMs}`,
    calendarId: row.calendar_id,
    sourceId: row.source_id,
    uid: row.uid,
    // Which occurrence of the series this is, for opening or (later) editing it.
    recurrenceId: row.recurrence_id || '',
    recurring: !!row.rrule || !!row.recurrence_id,
    // The SERIES' rule, on every occurrence of it.
    //
    // eventDetail() below already attached this and says why: opening one
    // Monday of a weekly standup should be able to say it repeats weekly, and
    // to offer "this one or all of them". The LIST did not, and the edit form
    // is opened from the list — so every repeating event opened for editing
    // showed "Does not repeat", and saving it then sent rrule:null, which is an
    // instruction to REMOVE the recurrence. An edit meant to change a colour
    // could flatten a whole series.
    rrule: row.rrule || null,
    start: startMs,
    end: startMs + durationMs,
    allDay: !!ev.allDay,
    // The day it belongs to, decided here rather than in the browser: an
    // all-day event is grouped in UTC and a timed one in the viewer's zone, and
    // a client that used one rule for both would put every late-evening event
    // on the wrong day for half the world.
    day: dayKey(startMs, ev.allDay ? 'UTC' : viewerZone),
    summary: ev.summary || '',
    location: ev.location || '',
    description: ev.description || '',
    status: ev.status || null,
    transparent: !!ev.transparent,
    organizer: ev.organizer || null,
    attendees: ev.attendees || [],
    alarms: ev.alarms || [],
    url: ev.url || '',
    // The "join the call" link. A backend with a field for it fills this in;
    // for everything else it is pulled out of the notes, which is where a
    // Teams or Zoom link actually lives — see server/onlineMeeting.js.
    joinUrl: ev.joinUrl || findJoinUrl(ev.location, ev.description, ev.url),
    // Whether the notes are known to be complete. Microsoft and Exchange hand
    // over a truncated preview in the list, so the UI knows to ask for the
    // whole thing when somebody opens the event rather than showing a
    // sentence that stops mid-word.
    partialDescription: !!ev.partialDescription,
    // The provider's own opaque id for this occurrence — the only handle its
    // API accepts, and the only way to ask for the full body. Carried here and
    // stripped again before the response leaves server/index.js; the browser
    // never sees it.
    providerId: ev.providerId || '',
    itemId: ev.itemId || '',
    categories: ev.categories || [],
    // The event's OWN colour, when it has one. Hmelj's own store first (see
    // calendarStore.js's per-event colours section for why it is not kept in
    // the document), then the iCalendar COLOR property — which is still read so
    // that a colour set by some OTHER client, on a server that does preserve
    // it, is honoured rather than ignored. Empty means "take the calendar's",
    // which is what the browser falls back to (public/js/calendar.js#colorOf).
    color: colors?.[`${row.calendar_id}:${row.uid}`] || ev.color || '',
    // Only when it is not the viewer's own: naming the zone is the honest way
    // to show a meeting somebody else scheduled somewhere else.
    zone: ev.allDay ? null : (ev.start?.zone || null),
    floating: !!ev.start?.floating,
  };
}

/**
 * Every occurrence in `[from, to)`, across the given calendars.
 *
 * `timezone` is the VIEWER's, and is used for two things only: resolving
 * floating events, and deciding which day a timed occurrence belongs to.
 * Everything else is anchored to the event's own zone.
 */
export function occurrencesIn(uKey, calendarIds, from, to, { timezone = 'UTC', max = MAX_OCCURRENCES } = {}) {
  if (!calendarIds?.length) return [];
  const rows = cache.calendarCandidates(uKey, calendarIds, from - CANDIDATE_PAD_MS, to + CANDIDATE_PAD_MS);
  if (!rows.length) return [];
  // Read once for the whole window, not once per occurrence: a month of a busy
  // calendar is hundreds of them and this is a small JSON file.
  const colors = store.eventColorsFor(uKey);

  // Exceptions first: the master's expansion needs to know which occurrences
  // they replace before it emits any of them.
  const overrides = new Map(); // `${calendarId}~${uid}` -> Set of overridden instants
  for (const row of rows) {
    if (!row.recurrence_id) continue;
    const key = `${row.calendar_id}~${row.uid}`;
    if (!overrides.has(key)) overrides.set(key, new Set());
    overrides.get(key).add(Number(row.recurrence_id));
  }

  const out = [];
  const emit = (row, ev, startMs, durationMs) => {
    if (out.length >= max) return;
    // Overlap, not containment: a meeting that started before the window and is
    // still running belongs in it, and so does a multi-day event seen from its
    // middle.
    if (startMs + durationMs <= from || startMs >= to) return;
    // The provider's opaque ids are only ever needed by eventDetail, which
    // reads them off the stored component itself — a month of them would be
    // several kilobytes of identifiers the browser has no use for.
    const { providerId: _p, itemId: _i, ...row_ } = occurrence(row, ev, startMs, durationMs, timezone, colors);
    out.push(row_);
  };

  for (const row of rows) {
    let ev;
    try { ev = JSON.parse(row.json); } catch { continue; }
    if (!ev?.start) continue;

    const zone = zoneOf(ev, timezone);
    const durationMs = durationOf(ev);

    // An exception is one occurrence, at its own time. A CANCELLED one is a
    // hole in the series and is emitted by nobody.
    if (row.recurrence_id) {
      if (ev.status === 'CANCELLED') continue;
      const startMs = refInstant(ev.start, zone);
      if (startMs != null) emit(row, ev, startMs, durationMs);
      continue;
    }

    const wall = startWall(ev, zone);
    if (!wall) continue;

    if (!row.rrule) {
      emit(row, ev, wallToInstant(wall, zone), durationMs);
      continue;
    }

    const skip = overrides.get(`${row.calendar_id}~${row.uid}`);
    let starts;
    try {
      starts = expand({
        start: wall,
        zone,
        rrule: row.rrule,
        exdates: (ev.exdates || []).map((d) => refInstant(d, zone)).filter((n) => n != null),
        rdates: (ev.rdates || []).map((d) => refInstant(d, zone)).filter((n) => n != null),
      }, { from: from - durationMs, to, max: max - out.length });
    } catch (e) {
      // A rule this expander cannot make sense of must not take the whole month
      // view down with it — show the series' first occurrence and move on.
      clog.warn(`Could not expand ${row.uid} (${row.rrule}): ${e.message}`);
      emit(row, ev, wallToInstant(wall, zone), durationMs);
      continue;
    }
    for (const startMs of starts) {
      // The occurrence an exception replaces is emitted by that exception, at
      // its own moved time — never here as well.
      if (skip?.has(startMs)) continue;
      emit(row, ev, startMs, durationMs);
    }
  }

  return out.sort((a, b) => a.start - b.start || (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0)).slice(0, max);
}

/**
 * One component, by calendar and uid — for opening an event.
 *
 * `occurrenceStart` picks which occurrence of a series is meant; without it the
 * master is described, which is what an "edit the series" view wants.
 */
export function eventDetail(uKey, calendarId, uid, { occurrenceStart = null, timezone = 'UTC' } = {}) {
  const row = cache.calendarEvent(uKey, calendarId, uid, '')
    || cache.calendarEvent(uKey, calendarId, uid, String(occurrenceStart ?? ''));
  if (!row) return null;
  let ev;
  try { ev = JSON.parse(row.json); } catch { return null; }
  const colors = store.eventColorsFor(uKey);
  const zone = zoneOf(ev, timezone);
  const durationMs = durationOf(ev);

  if (occurrenceStart != null) {
    // An exception at exactly this instant describes the occurrence better than
    // the master does — it is the whole point of an exception.
    const override = cache.calendarExceptions(uKey, calendarId, uid)
      .find((r) => Number(r.recurrence_id) === Number(occurrenceStart));
    if (override) {
      try {
        const oev = JSON.parse(override.json);
        const startMs = refInstant(oev.start, zoneOf(oev, timezone));
        return {
          ...occurrence(override, oev, startMs, durationOf(oev), timezone, colors),
          // `row` is the master here, so this is the SERIES' rule — an
          // exception carries none of its own.
          rrule: row.rrule || null,
          ical: override.ical, etag: override.etag, href: override.href,
        };
      } catch { /* fall through to the master */ }
    }
    return {
      ...occurrence(row, ev, Number(occurrenceStart), durationMs, timezone, colors),
      // The series' rule travels with the occurrence, not only with the master:
      // opening one Monday of a weekly standup should still be able to say it
      // repeats weekly, and (once writing exists) to offer "this one, or all of
      // them" — neither of which is answerable without it.
      rrule: row.rrule || null,
      ical: row.ical, etag: row.etag, href: row.href,
    };
  }

  const startMs = refInstant(ev.start, zone) ?? wallToInstant(startWall(ev, zone) || { y: 1970, mo: 1, d: 1 }, zone);
  return {
    ...occurrence(row, ev, startMs, durationMs, timezone, colors),
    rrule: row.rrule || null,
    ical: row.ical,
    etag: row.etag,
    href: row.href,
  };
}

/** Exported for the tests and for server/calendarSync.js, which has to compute
 *  the same `until_ms` this file's candidate filter relies on. */
export const _internals = { zoneOf, startWall, refInstant, durationOf };
