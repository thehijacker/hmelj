// Hmelj — creating, changing and deleting calendar events.
//
// The interesting part is not the writing. It is that "change this meeting" has
// three different answers when the meeting repeats, and a calendar that does not
// ask which one you meant will eventually do the wrong one.
//
// ── The three scopes ────────────────────────────────────────────────────────
//
//   'one'       Just this occurrence. Written as an EXCEPTION: a second VEVENT
//               sharing the series' UID and carrying a RECURRENCE-ID naming the
//               occurrence it replaces. The master is untouched, so next week is
//               still next week.
//
//   'future'    This one and everything after it. Written as a SPLIT: the
//               original master gains an UNTIL ending it just before this
//               occurrence, and a SECOND master with a NEW UID carries the
//               changed series onward. Two series, because there is no way to
//               say "the rule changes halfway" in one.
//
//   'all'       The whole series. The master itself is edited.
//
// A one-off event has no scope; the prompt is never shown for one.
//
// ── Why 'future' mints a new UID ────────────────────────────────────────────
// Because the two halves are now genuinely different series and a client that
// saw them share a UID would treat the second as an exception to the first — one
// occurrence, not a run of them. Every other calendar client does the same, and
// it is why moving a weekly meeting "from here on" leaves the old one visibly
// ending rather than disappearing.
//
// ── The double-invite guard ─────────────────────────────────────────────────
// Graph, EWS and Google all mail invitations themselves when an event with
// attendees is saved. CalDAV servers and Hmelj's own local calendars do not. So
// whether Hmelj sends its own iTIP mail is decided by the BACKEND, once, here —
// not by each call site remembering. Sending both means every attendee is
// invited twice, from two addresses, and the second one usually cancels the
// first in their client.
import crypto from 'node:crypto';
import * as store from './calendarStore.js';
import * as cache from './cache.js';
import * as calendarEvents from './calendarEvents.js';
import * as itip from './itip.js';
import {
  parseCalendar, serializeCalendar, serializeEvent, patchEvent,
  dateLine, icalUtc, instantToWall, wallToInstant,
} from './icalendar.js';
import { escapeText } from './contentLine.js';
import { parseRRule } from './rrule.js';
import { log } from './log.js';

const clog = log.scope('calendar-write');

export const SCOPES = ['one', 'future', 'all'];

/* ---------------- resolving what is being written to ---------------- */

/**
 * The source, calendar and backend for one calendar id, with the write refused
 * up front when it cannot succeed.
 *
 * Refusing here rather than letting the backend throw means the message names
 * the actual reason — a read-only provider, a collection the server marked
 * read-only, a source switched off — instead of whatever the protocol layer
 * happened to say.
 */
export function resolveWritable(uKey, calendarId, backendFor) {
  const found = store.resolveCalendarFor(uKey, store.assertId(calendarId));
  if (!found) throw Object.assign(new Error('No such calendar'), { status: 404 });
  const { source, calendar } = found;
  const backend = backendFor(source.kind);
  if (!backend.writable) {
    // The backend's own refusal explains WHY for its own protocol, which is
    // more useful than anything this layer could say.
    backend.createEvent();
  }
  if (calendar.readOnly) {
    throw Object.assign(
      new Error(`${calendar.displayName} is read-only on the server — Hmelj cannot change it.`),
      { status: 400 },
    );
  }
  if (source.enabled === false) {
    throw Object.assign(new Error(`${source.label} is switched off.`), { status: 400 });
  }
  return { source, calendar, backend };
}

/* ---------------- turning a form into iCalendar ---------------- */

/** The shape the API takes from a client, normalised. Times arrive as epoch
 *  milliseconds because that is the one representation that cannot be
 *  misunderstood; the zone is separate and says how to WRITE them. */
export function normalizeInput(input, { existing = null } = {}) {
  const allDay = input.allDay !== undefined ? !!input.allDay : !!existing?.allDay;
  const start = Number(input.start ?? existing?.start);
  if (!Number.isFinite(start)) throw Object.assign(new Error('An event needs a start time'), { status: 400 });
  let end = Number(input.end ?? existing?.end);
  if (!Number.isFinite(end) || end < start) end = start + (allDay ? 86400000 : 3600000);

  // `undefined` means NOT MENTIONED and is what keeps an edit non-destructive:
  // patchFor omits those properties entirely, so the stored line survives. An
  // explicit empty string or null is different and DOES clear the property —
  // which is what "remove the location" has to mean.
  //
  // Collapsing the two (`?? existing?.x ?? ''`) is what made changing a
  // repeating event's title silently delete its RRULE: the title edit sent no
  // rrule, the fallback turned that into null, and null removes.
  const text = (a, b) => (a !== undefined ? String(a).trim() : (b !== undefined ? String(b).trim() : undefined));
  return {
    summary: text(input.summary, existing?.summary),
    location: text(input.location, existing?.location),
    description: text(input.description, existing?.description),
    start,
    end,
    allDay,
    // An all-day event has no zone by definition — see server/calendarEvents.js.
    zone: allDay ? null : (input.zone || existing?.zone || null),
    rrule: input.rrule !== undefined ? (input.rrule || null) : existing?.rrule,
    attendees: Array.isArray(input.attendees)
      ? input.attendees
        .map((a) => (typeof a === 'string' ? { address: a } : a))
        .filter((a) => String(a?.address || '').includes('@'))
        .map((a) => ({ name: String(a.name || '').trim(), address: String(a.address).trim(), status: a.status || 'NEEDS-ACTION', optional: !!a.optional }))
      : existing?.attendees,
    alarms: Array.isArray(input.reminders)
      ? input.reminders.filter((m) => Number.isFinite(Number(m))).map((m) => ({ minutesBefore: Number(m), related: 'START' }))
      : existing?.alarms,
    transparent: input.transparent !== undefined ? !!input.transparent : existing?.transparent,
    categories: Array.isArray(input.categories) ? input.categories.map(String) : existing?.categories,
  };
}

/**
 * A colour that is safe to store and to interpolate into a `style` attribute in
 * the browser.
 *
 * Still here rather than in calendarStore.js because it guards BOTH ends: the
 * colours Hmelj stores itself (calendarStore.js's per-event colours) and the
 * COLOR property read back out of somebody ELSE's iCalendar, which is the more
 * dangerous of the two — that one is written by a server Hmelj does not
 * control.
 *
 * Deliberately strict rather than clever: `#rgb`/`#rrggbb`, or a bare CSS
 * colour NAME (which is what RFC 7986 actually specifies, and what another
 * client may well have written). Anything else becomes null — cleared — rather
 * than being passed through, because this value ends up inside a style
 * attribute in the browser and `red;background:url(...)` is not a colour.
 *
 * @returns {string|null} null both for "cleared" and for "not a colour", which
 *   are the same outcome: the event falls back to its calendar's colour.
 */
export function normalizeEventColor(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^[a-z]{3,24}$/i.test(v)) return v.toLowerCase();
  return null;
}

/** The property lines an edit replaces. Everything not listed here is left
 *  exactly as the other client wrote it — see icalendar.js#patchEvent. */
function patchFor(ev, { organizer = null } = {}) {
  const zone = ev.allDay ? null : ev.zone;
  const patch = {
    DTSTART: dateLine('DTSTART', ev.start, { allDay: ev.allDay, zone }),
    DTEND: dateLine('DTEND', ev.end, { allDay: ev.allDay, zone }),
    // DURATION and DTEND are alternatives; leaving a stale DURATION beside a new
    // DTEND is how an edited event ends up the wrong length in half the clients
    // that read it.
    DURATION: null,
    'LAST-MODIFIED': `LAST-MODIFIED:${icalUtc(Date.now())}`,
    DTSTAMP: `DTSTAMP:${icalUtc(Date.now())}`,
  };
  // Only what the caller actually mentioned — see normalizeInput. A property
  // left out of the patch keeps whatever the other client wrote; one set to
  // null is deliberately removed.
  const maybe = (name, value, line) => { if (value !== undefined) patch[name] = value ? line() : null; };
  maybe('SUMMARY', ev.summary, () => `SUMMARY:${escapeText(ev.summary)}`);
  maybe('LOCATION', ev.location, () => `LOCATION:${escapeText(ev.location)}`);
  maybe('DESCRIPTION', ev.description, () => `DESCRIPTION:${escapeText(ev.description)}`);
  maybe('RRULE', ev.rrule, () => `RRULE:${ev.rrule}`);
  maybe('TRANSP', ev.transparent, () => 'TRANSP:TRANSPARENT');
  if (ev.attendees) {
    patch.ATTENDEE = ev.attendees.map((a) =>
      `ATTENDEE${a.name ? `;CN=${a.name.replace(/[";:]/g, ' ')}` : ''}`
      + `;ROLE=${a.optional ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT'}`
      + `;PARTSTAT=${a.status || 'NEEDS-ACTION'};RSVP=TRUE:mailto:${a.address}`);
    if (!patch.ATTENDEE.length) patch.ATTENDEE = null;
  }
  if (organizer?.address) {
    patch.ORGANIZER = `ORGANIZER${organizer.name ? `;CN=${organizer.name.replace(/[";:]/g, ' ')}` : ''}:mailto:${organizer.address}`;
  }
  return patch;
}

/** SEQUENCE must go up whenever an event with attendees changes — it is how
 *  their clients know the update is newer than the invitation they already
 *  have, and an unchanged SEQUENCE is silently ignored by several of them. */
function bumpSequence(text) {
  const current = parseCalendar(text)?.events?.[0]?.sequence || 0;
  return patchEvent(text, { SEQUENCE: `SEQUENCE:${current + 1}` });
}

/* ---------------- the three scopes ---------------- */

/** An UNTIL that ends a series just before `ms`. Written in UTC, which is what
 *  RFC 5545 requires of an UNTIL on a zoned DTSTART and what every server
 *  expects. */
const untilBefore = (ms) => icalUtc(ms - 1000);

/**
 * The document(s) an edit produces, given its scope.
 *
 * Returns `{ documents, itipMethod }` where each document is
 * `{ uid, ical, replaces }` — `replaces` naming the stored uid whose resource
 * this overwrites, or null for a new one. The caller writes them; deciding what
 * to write is entirely this function's job, and it does no I/O at all so it can
 * be tested directly.
 */
export function planEdit({ scope, original, occurrenceStart, next, organizer }) {
  const parsed = parseCalendar(original);
  const master = parsed?.events?.find((e) => !e.recurrenceId) || parsed?.events?.[0];
  if (!master) throw Object.assign(new Error('That event could not be read back'), { status: 409 });
  const uid = master.uid;
  const recurring = !!master.rrule;

  // Nothing to choose between: a one-off event has exactly one occurrence.
  if (!recurring || scope === 'all') {
    return {
      documents: [{ uid, ical: bumpSequence(patchEvent(original, patchFor(next, { organizer }), {
        match: (e) => !e.recurrenceId,
      })), replaces: uid }],
      itipMethod: 'REQUEST',
    };
  }

  if (scope === 'one') {
    // An EXCEPTION component, added to the same resource. Sharing the UID is
    // what makes it an exception rather than a separate event; the
    // RECURRENCE-ID says which occurrence it replaces.
    const zone = master.allDay ? null : (next.zone || master.start?.zone || null);
    const exception = serializeEvent({
      ...next,
      uid,
      zone,
      recurrenceId: occurrenceStart,
      sequence: (master.sequence || 0) + 1,
      organizer: organizer || master.organizer,
      // An exception has no rule of its own — it IS one occurrence. Carrying the
      // master's rule here would expand it a second time.
      rrule: null,
      exdates: [],
      rdates: [],
    });
    // Appended before END:VCALENDAR so the master and its exceptions stay in one
    // resource, which is what CalDAV requires of components sharing a UID.
    const merged = original.replace(/END:VCALENDAR\s*$/i, `${exception.join('\r\n')}\r\nEND:VCALENDAR\r\n`);
    return { documents: [{ uid, ical: merged, replaces: uid }], itipMethod: 'REQUEST' };
  }

  if (scope === 'future') {
    // The split. The original series is ended just before this occurrence, and
    // a NEW series with a NEW uid carries the change onward — see this file's
    // header for why the uid has to be new.
    const rule = parseRRule(master.rrule) || {};
    const truncated = { ...rule, until: untilBefore(occurrenceStart), count: undefined };
    const ruleText = Object.entries({
      FREQ: truncated.freq,
      INTERVAL: truncated.interval > 1 ? truncated.interval : undefined,
      UNTIL: truncated.until,
      BYDAY: truncated.byday?.map((b) => `${b.n || ''}${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][b.day]}`).join(','),
      BYMONTHDAY: truncated.bymonthday?.join(','),
      BYMONTH: truncated.bymonth?.join(','),
      BYSETPOS: truncated.bysetpos?.join(','),
      WKST: truncated.wkst !== 'MO' ? truncated.wkst : undefined,
    }).filter(([, v]) => v !== undefined && v !== '' && v !== null).map(([k, v]) => `${k}=${v}`).join(';');

    const head = bumpSequence(patchEvent(original, { RRULE: `RRULE:${ruleText}` }, { match: (e) => !e.recurrenceId }));
    const tailUid = crypto.randomUUID();
    const tail = serializeCalendar({
      ...next,
      uid: tailUid,
      sequence: 0,
      organizer: organizer || master.organizer,
      // The changed occurrence's own start becomes the new series' DTSTART, and
      // the rule continues from there unchanged apart from having no UNTIL of
      // its own to inherit.
      rrule: next.rrule || master.rrule,
    });
    return {
      documents: [
        { uid, ical: head, replaces: uid },
        { uid: tailUid, ical: tail, replaces: null },
      ],
      itipMethod: 'REQUEST',
    };
  }

  throw Object.assign(new Error(`Unknown edit scope: ${scope}`), { status: 400 });
}

/**
 * The document a DELETE produces — which for one occurrence of a series is not
 * a delete at all but an EXDATE added to the master.
 *
 * Returns `{ documents, deleteUid }`: either a rewritten document to store, or
 * a uid whose whole resource goes.
 */
export function planDelete({ scope, original, occurrenceStart }) {
  const parsed = parseCalendar(original);
  const master = parsed?.events?.find((e) => !e.recurrenceId) || parsed?.events?.[0];
  if (!master) throw Object.assign(new Error('That event could not be read back'), { status: 409 });

  if (!master.rrule || scope === 'all') {
    return { documents: [], deleteUid: master.uid, itipMethod: 'CANCEL' };
  }

  const zone = master.allDay ? null : (master.start?.zone || null);

  if (scope === 'one') {
    // An EXDATE, not a removal: the occurrence becomes a hole in the series and
    // every other one is untouched. Appended to whatever EXDATEs are already
    // there rather than replacing them, or cancelling a second occurrence would
    // silently restore the first.
    const existing = (master.exdates || []).map((d) =>
      dateLine('EXDATE', Date.parse(d.iso.length === 10 ? `${d.iso}T00:00:00Z` : d.iso), { allDay: master.allDay, zone }));
    const line = dateLine('EXDATE', occurrenceStart, { allDay: master.allDay, zone });
    return {
      documents: [{
        uid: master.uid,
        ical: bumpSequence(patchEvent(original, { EXDATE: [...new Set([...existing, line])] }, { match: (e) => !e.recurrenceId })),
        replaces: master.uid,
      }],
      deleteUid: null,
      itipMethod: 'CANCEL',
    };
  }

  if (scope === 'future') {
    // Everything from here on: end the series just before this occurrence.
    const rule = parseRRule(master.rrule);
    const parts = String(master.rrule).split(';').filter((p) => !/^(UNTIL|COUNT)=/i.test(p));
    parts.push(`UNTIL=${untilBefore(occurrenceStart)}`);
    return {
      documents: [{
        uid: master.uid,
        ical: bumpSequence(patchEvent(original, { RRULE: `RRULE:${parts.join(';')}` }, { match: (e) => !e.recurrenceId })),
        replaces: master.uid,
      }],
      deleteUid: null,
      itipMethod: 'CANCEL',
    };
  }

  throw Object.assign(new Error(`Unknown delete scope: ${scope}`), { status: 400 });
}

/* ---------------- the operations ---------------- */

/** Reads the stored document for an event, preferring the server's copy over
 *  the cached one: an edit is conditional on an ETag, and patching a stale
 *  document would send back an event missing whatever changed in between. */
async function currentDocument(ctx, backend, calendar, row) {
  try {
    const live = await backend.readEvent(ctx, calendar, { url: row.href?.startsWith('local:') ? undefined : row.url || row.href, uid: row.uid });
    if (live) return live;
  } catch (e) {
    clog.debug(`Could not re-read ${row.uid} before editing (${e.message}) — using the cached copy`);
  }
  return row.ical;
}

export async function createEventFor(uKey, calendarId, input, { backendFor, withSource, organizer }) {
  const { source, calendar, backend } = resolveWritable(uKey, calendarId, backendFor);
  const next = normalizeInput(input);

  // Microsoft and Exchange have their own event model and their own answer for
  // "this occurrence / this and following / the whole series". Building
  // iCalendar documents and asking them to translate back would re-derive what
  // they already do, and get it wrong at the edges — see the writing sections
  // in calendar/graphCalendar.js and calendar/ewsCalendar.js.
  if (backend.nativeWrite) {
    const res = await withSource(uKey, source, (ctx) =>
      backend.createEventNative({ ...ctx, uKey }, calendar, next));
    // No iTIP: both backends declare sendsInvitationsItself, so the server has
    // already mailed the attendees and a second invitation would double up.
    return res;
  }

  const uid = `${crypto.randomUUID()}@hmelj`;
  const ical = serializeCalendar({ ...next, uid, sequence: 0, organizer });

  const res = await withSource(uKey, source, (ctx) =>
    backend.createEvent({ ...ctx, uKey }, calendar, { uid, ical }));

  await itip.maybeInvite({
    uKey, backend, method: 'REQUEST', organizer,
    attendees: next.attendees, ical, summary: next.summary,
  });
  return { uid, ...res };
}

export async function updateEventFor(uKey, calendarId, uid, input, { scope = 'all', occurrenceStart = null, backendFor, withSource, organizer }) {
  const { source, calendar, backend } = resolveWritable(uKey, calendarId, backendFor);
  const row = cache.calendarEvent(uKey, calendar.id, uid, '');
  if (!row) throw Object.assign(new Error('No such event'), { status: 404 });

  const ctxRun = (fn) => withSource(uKey, source, (ctx) => fn({ ...ctx, uKey }));

  if (backend.nativeWrite) {
    const detail = calendarEvents.eventDetail(uKey, calendar.id, uid, { occurrenceStart });
    if (!detail) throw Object.assign(new Error('No such event'), { status: 404 });
    const next = normalizeInput(input, { existing: detail });
    return {
      uid, scope,
      ...await ctxRun((ctx) => backend.updateEventNative(ctx, calendar, { detail, scope }, next)),
    };
  }

  const original = await ctxRun((ctx) => currentDocument(ctx, backend, calendar, row));
  if (!original) throw Object.assign(new Error('That event could not be read back'), { status: 409 });

  const existing = calendarEvents.eventDetail(uKey, calendar.id, uid, { occurrenceStart });
  const next = normalizeInput(input, { existing });
  const plan = planEdit({ scope, original, occurrenceStart: Number(occurrenceStart) || existing?.start, next, organizer });

  for (const doc of plan.documents) {
    if (doc.replaces) {
      await ctxRun((ctx) => backend.updateEvent(ctx, calendar, { url: row.url || row.href, uid: doc.uid, etag: row.etag }, doc.ical));
    } else {
      await ctxRun((ctx) => backend.createEvent(ctx, calendar, { uid: doc.uid, ical: doc.ical }));
    }
  }

  await itip.maybeInvite({
    uKey, backend, method: plan.itipMethod, organizer,
    attendees: next.attendees, ical: plan.documents[0]?.ical, summary: next.summary,
  });
  return { uid, scope, documents: plan.documents.length };
}

export async function deleteEventFor(uKey, calendarId, uid, { scope = 'all', occurrenceStart = null, backendFor, withSource, organizer }) {
  const { source, calendar, backend } = resolveWritable(uKey, calendarId, backendFor);
  const row = cache.calendarEvent(uKey, calendar.id, uid, '');
  if (!row) throw Object.assign(new Error('No such event'), { status: 404 });

  const ctxRun = (fn) => withSource(uKey, source, (ctx) => fn({ ...ctx, uKey }));

  if (backend.nativeWrite) {
    const d = calendarEvents.eventDetail(uKey, calendar.id, uid, { occurrenceStart });
    if (!d) throw Object.assign(new Error('No such event'), { status: 404 });
    const res = await ctxRun((ctx) => backend.deleteEventNative(ctx, calendar, { detail: d, scope }));
    // The row is dropped locally too. The post-write refresh in index.js will
    // re-read the calendar anyway, but between here and there the deleted event
    // would still be on screen.
    if (res?.deleted) cache.deleteCalendarHref(uKey, source.id, calendar.id, row.href);
    return { uid, scope, ...res };
  }

  const original = await ctxRun((ctx) => currentDocument(ctx, backend, calendar, row));
  if (!original) throw Object.assign(new Error('That event could not be read back'), { status: 409 });

  const detail = calendarEvents.eventDetail(uKey, calendar.id, uid, { occurrenceStart });
  const plan = planDelete({ scope, original, occurrenceStart: Number(occurrenceStart) || detail?.start });

  if (plan.deleteUid) {
    await ctxRun((ctx) => backend.deleteEvent(ctx, calendar, { url: row.url || row.href, uid: plan.deleteUid, etag: row.etag }));
    cache.deleteCalendarHref(uKey, source.id, calendar.id, row.href);
  } else {
    for (const doc of plan.documents) {
      await ctxRun((ctx) => backend.updateEvent(ctx, calendar, { url: row.url || row.href, uid: doc.uid, etag: row.etag }, doc.ical));
    }
  }

  await itip.maybeInvite({
    uKey, backend, method: 'CANCEL', organizer,
    attendees: detail?.attendees || [], ical: plan.documents[0]?.ical || original, summary: detail?.summary,
  });
  return { uid, scope, deleted: !!plan.deleteUid };
}
