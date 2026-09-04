// Hmelj — the Microsoft 365 calendar backend.
//
// ── Why this one stores OCCURRENCES and CalDAV stores components ────────────
// Graph does not hand over iCalendar. It hands over its own event model, whose
// recurrence is a `{pattern, range}` object — "every second month, on the
// weekday instance `last` of type `friday`, ending after 17 occurrences". Turning
// that into an RRULE is a translation, and a translation of recurrence is
// exactly the kind of thing that is right for a year and then quietly wrong for
// one meeting in November.
//
// So this asks Microsoft to expand its own rules (`calendarView`) and stores the
// result as ordinary one-off components — each occurrence its own row, carrying
// the series' UID for display but no rule of its own. Exchange knows its own
// recurrence semantics; asking it to apply them is less code AND more correct.
//
// The price is that a Graph calendar is only known over the window that was
// asked for. server/calendarSync.js syncs a rolling one and says so plainly in
// the UI, because "my 2031 appointment is missing" needs an answer better than
// silence.
//
// Every function runs inside the mail account's ALS context, put there by the
// dispatcher — the same way server/sync.js does it for the mail poller.
import * as graph from '../graphClient.js';
import * as recur from '../recurrenceMap.js';
import { findJoinUrl, readableNotes, trimNotes } from '../onlineMeeting.js';
import { log } from '../log.js';

const clog = log.scope('graph-calendar');

export const kind = 'graph';
export const writable = true;
/** Writes go through createEventNative/updateEventNative/deleteEventNative
 *  rather than the iCalendar path — see the writing section below. */
export const nativeWrite = true;
export const expandsServerSide = true;
/** Read-only. The reason is structural rather than a gap — see the note in
 *  server/calendarStore.js#SOURCE_KINDS. Declared true so the invitation guard
 *  in ./index.js never mails on this backend's behalf either. */
export const sendsInvitationsItself = true;

export async function discoverCalendars(ctx) {
  const cals = await graph.listCalendars();
  return {
    principalUrl: '',
    homeUrl: '',
    collections: cals.map((c) => ({
      href: `graph:${c.id}`,
      url: `graph:${c.id}`,
      displayName: c.displayName,
      color: c.color,
      // Microsoft's own answer, not a blanket rule: a colleague's shared
      // calendar comes back canEdit:false and must stay read-only even though
      // the backend can write.
      readOnly: c.readOnly === true,
    })),
  };
}

/** A new calendar in this mailbox. Shaped like one collection out of
 *  discoverCalendars, because that is what the caller stores. */
export async function createCalendar(ctx, { displayName }) {
  const made = await graph.createCalendar(displayName);
  return {
    href: `graph:${made.id}`,
    url: `graph:${made.id}`,
    displayName: made.displayName || displayName,
    color: made.color || '',
    readOnly: made.readOnly === true,
  };
}

/** Graph's `{dateTime, timeZone}` → the date shape server/icalendar.js produces,
 *  so everything downstream reads one format. The Prefer header on the request
 *  pins timeZone to UTC, so the only ambiguity left is all-day. */
function toDate(v, allDay) {
  const raw = String(v?.dateTime || '');
  if (!raw) return null;
  if (allDay) {
    // An all-day event is a DATE with no zone at all — anchoring it to one is
    // what moves Christmas to the 24th for half the world.
    return { iso: raw.slice(0, 10), allDay: true, floating: false, zone: null };
  }
  // Graph writes seven fractional digits, which Date.parse does not accept.
  const trimmed = raw.replace(/(\.\d{3})\d+$/, '$1');
  const ms = Date.parse(/[Zz]|[+-]\d{2}:?\d{2}$/.test(trimmed) ? trimmed : trimmed + 'Z');
  return Number.isFinite(ms)
    ? { iso: new Date(ms).toISOString(), allDay: false, floating: false, zone: 'UTC' }
    : null;
}

const person = (p) => (p?.emailAddress?.address
  ? { name: String(p.emailAddress.name || ''), address: String(p.emailAddress.address), status: null, role: null, rsvp: false, optional: false }
  : null);

const RESPONSE = {
  none: 'NEEDS-ACTION', notresponded: 'NEEDS-ACTION', organizer: 'ACCEPTED',
  tentativelyaccepted: 'TENTATIVE', accepted: 'ACCEPTED', declined: 'DECLINED',
};

function toEvent(e) {
  const allDay = !!e.isAllDay;
  return {
    // The SERIES uid, shared by every occurrence — kept for display and for
    // recognising two occurrences as the same meeting. It is deliberately NOT
    // the storage key: see the dispatcher, which keys on the occurrence's own
    // opaque Graph id because that is what is unique.
    uid: String(e.iCalUId || e.id),
    // The occurrence's own opaque Graph id, kept because it is the only thing
    // /me/events accepts — the iCalUId above is shared by every occurrence of a
    // series and addresses none of them.
    providerId: String(e.id || ''),
    seriesId: String(e.seriesMasterId || ''),
    sequence: 0,
    recurrenceId: null,
    summary: String(e.subject || ''),
    location: String(e.location?.displayName || ''),
    description: String(e.bodyPreview || ''),
    // bodyPreview is plain text cut off at 255 characters, so what is stored
    // here is a fragment by construction. Flagged rather than left looking
    // complete — the UI asks for the whole body when the event is opened.
    partialDescription: true,
    url: String(e.webLink || ''),
    // Graph has a field for it, so no guessing is needed here — the text
    // search is only the fallback for what has no such field.
    joinUrl: String(e.onlineMeeting?.joinUrl || e.onlineMeetingUrl || ''),
    status: null,
    // `free` is the only showAs that does not block the time — the same
    // distinction iCalendar makes with TRANSP.
    transparent: String(e.showAs || 'busy').toLowerCase() === 'free',
    categories: [],
    start: toDate(e.start, allDay),
    end: toDate(e.end, allDay),
    allDay,
    // No rule: this row IS one occurrence. Storing a rule here as well would
    // expand it a second time.
    rrule: null,
    exdates: [],
    rdates: [],
    // True when it came out of a series, so the UI can say "repeats" without
    // having a rule to show.
    recurring: e.type === 'occurrence' || e.type === 'exception' || !!e.seriesMasterId,
    organizer: person(e.organizer),
    attendees: (e.attendees || []).map((a) => {
      const p = person(a);
      if (!p) return null;
      p.status = RESPONSE[String(a.status?.response || '').toLowerCase()] || 'NEEDS-ACTION';
      p.optional = String(a.type || '').toLowerCase() === 'optional';
      return p;
    }).filter(Boolean),
    alarms: e.isReminderOn && Number.isFinite(e.reminderMinutesBeforeStart)
      ? [{ action: 'DISPLAY', absolute: null, minutesBefore: e.reminderMinutesBeforeStart, related: 'START', description: '' }]
      : [],
    lastModified: String(e.lastModifiedDateTime || ''),
  };
}

/**
 * Every occurrence in the window, as components.
 *
 * `windowed` is what tells the dispatcher how to reconcile: this is the complete
 * truth for THIS RANGE and nothing outside it, so anything stored inside the
 * range that did not come back has been deleted upstream, and anything outside
 * it must be left alone. Reporting `full` instead would wipe every event beyond
 * the window on the first sync.
 */
export async function syncCalendar(ctx, calendar, { window } = {}) {
  const calId = String(calendar.href || '').replace(/^graph:/, '');
  const items = await graph.calendarView(calId, new Date(window.from).toISOString(), new Date(window.to).toISOString());
  const components = [];
  for (const e of items) {
    const ev = toEvent(e);
    if (!ev.start) continue;
    components.push({
      // The occurrence's own opaque id: unique, stable across syncs, and what a
      // write would be addressed to.
      href: `graph:${e.id}`,
      url: `graph:${e.id}`,
      etag: String(e.lastModifiedDateTime || ''),
      key: String(e.id),
      event: ev,
      ical: null, // Graph has none to give; synthesised later if it is ever needed
    });
  }
  return { components, removedHrefs: [], full: false, windowed: window, unchanged: false, failed: 0 };
}

/**
 * The full body, fetched when somebody opens an event.
 *
 * calendarView carries `bodyPreview`, which is plain text truncated at 255
 * characters — and a Teams invitation spends its first several hundred on
 * boilerplate, so the join link is exactly what falls off the end. One request
 * for one event, rather than the whole body of a year of them on every sync.
 */
export async function fetchDetail(ctx, ev) {
  const id = ev?.providerId || '';
  if (!id) return null;
  try {
    const e = await graph.getEvent(id);
    if (!e) return null;
    const raw = String(e.body?.content || '');
    const text = readableNotes(raw, { isHtml: String(e.body?.contentType || '').toLowerCase() === 'html' });
    return {
      description: trimNotes(text || ev.description || ''),
      // Graph's own field first; the text search covers a meeting organized
      // elsewhere and forwarded in, which has no such field set.
      joinUrl: String(e.onlineMeeting?.joinUrl || e.onlineMeetingUrl || '')
        || findJoinUrl(e.location?.displayName, text),
    };
  } catch (err) {
    clog.debug(`Could not read the full event (${err.message})`);
    return null;
  }
}

/* ---------- writing ----------
 *
 * Native rather than iCalendar. Graph has its own model for exactly the three
 * things an edit has to decide between — this occurrence, this and everything
 * after it, the whole series — and asking it to apply them is both less code
 * and more correct than building iCalendar documents and translating them
 * back. It is the same reasoning as for reading: Microsoft knows its own
 * recurrence semantics.
 *
 * Graph events are timezone-explicit: every dateTime carries a timeZone
 * alongside it. UTC is used for a zoned event because the instant is already
 * resolved by then, but an ALL-DAY event must be sent as plain dates in a named
 * zone — Graph rejects an all-day event whose start is not midnight in the zone
 * it names, and "midnight UTC" is not midnight anywhere else.
 */

/** A Graph dateTime pair. */
function stamp(ms, zone, allDay) {
  if (allDay) {
    // Graph wants midnight-to-midnight local dates for an all-day event, and
    // the END is EXCLUSIVE — the day after the last one, which is the same
    // convention iCalendar uses and the opposite of what a UI shows.
    return { dateTime: `${recur.dateOnly(ms, 'UTC')}T00:00:00.0000000`, timeZone: 'UTC' };
  }
  return { dateTime: new Date(ms).toISOString().replace(/Z$/, '').replace(/\.\d+$/, '.0000000'), timeZone: 'UTC' };
}

/** The Graph event body for a normalized input. Only what Hmelj models: a
 *  property left out of a PATCH is left alone on the server, which is how an
 *  edit avoids clobbering fields the app has no concept of. */
function toGraphEvent(next, { forPatch = false } = {}) {
  const e = {};
  if (next.summary !== undefined) e.subject = next.summary || '';
  if (next.description !== undefined) e.body = { contentType: 'text', content: next.description || '' };
  if (next.location !== undefined) e.location = { displayName: next.location || '' };
  if (next.start !== undefined) {
    e.start = stamp(next.start, next.zone, next.allDay);
    e.end = stamp(next.end, next.zone, next.allDay);
    e.isAllDay = !!next.allDay;
  }
  if (next.attendees !== undefined) {
    e.attendees = (next.attendees || []).map((a) => ({
      emailAddress: { address: a.address, name: a.name || '' },
      type: a.optional ? 'optional' : 'required',
    }));
  }
  if (next.rrule !== undefined) {
    e.recurrence = next.rrule
      ? recur.toGraph(next.rrule, { startMs: next.start, zone: next.zone || 'UTC' })
      : null;
  }
  if (forPatch) for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
}

export async function createEventNative(ctx, calendar, next) {
  const created = await graph.createCalendarEvent(calIdOf(calendar), toGraphEvent(next));
  return { uid: String(created?.id || ''), providerId: String(created?.id || '') };
}

/** Whether an edit or a delete has to resolve the series master first. Pure,
 *  and asked before the network call rather than after. */
export const needsMaster = ({ detail, scope }) => !!detail?.recurring && scope !== 'one';

/**
 * What a write BECOMES, as a list of operations — pure, so the part that fails
 * silently when it is wrong can be tested without a Microsoft account.
 *
 * And it does fail silently: "change the whole series" addressed to an
 * occurrence id edits one instance and leaves the rest, which nobody discovers
 * until the following week.
 *
 * `master` is the series master, already fetched when needsMaster said so, and
 * null otherwise.
 */
export function planWrite({ detail, scope, next, master, calendarId, deleting = false }) {
  const id = detail?.providerId;
  if (!id) throw Object.assign(new Error('That event has no Microsoft id — re-sync the calendar and try again.'), { status: 409 });

  // One occurrence, or a one-off: address the occurrence itself. Microsoft
  // creates the exception, which is the one part of this nobody should be
  // hand-rolling.
  if (!needsMaster({ detail, scope })) {
    if (deleting) return [{ op: 'delete', id }];
    // A single occurrence has no rule of its own — sending one would try to
    // turn an exception into a series.
    const { recurrence, ...patch } = toGraphEvent(next, { forPatch: true });
    return [{ op: 'patch', id, body: detail.recurring ? patch : toGraphEvent(next, { forPatch: true }) }];
  }

  if (!master?.id) throw Object.assign(new Error('The repeating event this belongs to could not be found on the server.'), { status: 409 });
  if (scope === 'all') {
    return deleting
      ? [{ op: 'delete', id: master.id }]
      : [{ op: 'patch', id: master.id, body: toGraphEvent(next, { forPatch: true }) }];
  }

  // "This and everything after it": Microsoft has no split operation, so the
  // old series is capped the day before and — for an edit — a new one carries
  // the change forward. The cap is FIRST: the two series would otherwise both
  // cover this occurrence's day, and every client subscribed to the calendar
  // would show it twice until the second write landed.
  const zone = next?.zone || detail.zone || 'UTC';
  const oldRule = recur.fromGraph(master.recurrence);
  const capped = oldRule ? recur.cappedBefore(oldRule, detail.start, zone) : null;
  if (!capped) throw Object.assign(new Error('That repeating event does not state a rule Hmelj can split.'), { status: 400 });
  const masterStart = Date.parse(`${master.start?.dateTime || ''}Z`) || detail.start;

  const ops = [{ op: 'patch', id: master.id, body: { recurrence: recur.toGraph(capped, { startMs: masterStart, zone }) } }];
  if (!deleting) {
    ops.push({ op: 'create', calendarId, body: toGraphEvent({
      ...next,
      // The new series begins at the occurrence being split off. normalizeInput
      // already defaults an untouched start to exactly that, but the rule below
      // is stated from this value and a missing one would be a rule anchored to
      // nothing.
      start: next.start ?? detail.start,
      end: next.end ?? detail.end,
      rrule: next.rrule !== undefined ? next.rrule : oldRule,
    }) });
  }
  return ops;
}

async function run(ops) {
  let createdId = '';
  for (const o of ops) {
    if (o.op === 'patch') await graph.updateCalendarEvent(o.id, o.body);
    else if (o.op === 'delete') await graph.deleteCalendarEvent(o.id);
    else if (o.op === 'create') createdId = String((await graph.createCalendarEvent(o.calendarId, o.body))?.id || '');
  }
  return createdId;
}

const calIdOf = (calendar) => String(calendar.href || '').replace(/^graph:/, '');

export async function updateEventNative(ctx, calendar, { detail, scope }, next) {
  const master = needsMaster({ detail, scope }) ? await graph.getSeriesMaster(detail.providerId) : null;
  const ops = planWrite({ detail, scope, next, master, calendarId: calIdOf(calendar) });
  const uid = await run(ops);
  return { scope, ...(uid ? { uid } : {}) };
}

export async function deleteEventNative(ctx, calendar, { detail, scope }) {
  const master = needsMaster({ detail, scope }) ? await graph.getSeriesMaster(detail.providerId) : null;
  const ops = planWrite({ detail, scope, master, calendarId: calIdOf(calendar), deleting: true });
  await run(ops);
  return { deleted: ops.some((o) => o.op === 'delete') };
}

/** Graph has no iCalendar to read back — the native write path never asks. */
export const readEvent = async () => null;

/** For the tests: the request bodies are the whole of what Microsoft sees. */
export const _internals = { toGraphEvent };
