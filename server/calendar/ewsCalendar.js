// Hmelj — the Exchange (EWS) calendar backend.
//
// Same shape as ./graphCalendar.js and for the same reason: Exchange expands
// its own recurrence when asked with a `CalendarView`, and asking it to is both
// less code and more correct than re-implementing Exchange's recurrence model
// from its Recurrence element. Each occurrence is stored as its own one-off
// component over a rolling window — see graphCalendar.js's header for what that
// costs and why it is the right trade.
//
// Writing is native rather than iCalendar-based (nativeWrite below): Exchange
// has its own answer for "this occurrence / this and following / the series",
// and handing it .ics to translate back would re-derive that and get the edges
// wrong.
//
// Runs inside the mail account's ALS context, put there by the dispatcher.
import * as ews from '../ewsClient.js';
import { findJoinUrl, readableNotes, trimNotes } from '../onlineMeeting.js';
import * as recur from '../recurrenceMap.js';
import { log } from '../log.js';

const clog = log.scope('ews-calendar');

export const kind = 'ews';
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
  const folders = await ews.listCalendarFolders();
  return {
    principalUrl: '',
    homeUrl: '',
    collections: folders.map((f) => ({
      href: `ews:${f.id}`,
      url: `ews:${f.id}`,
      displayName: f.displayName,
      color: '',
      // Exchange does not report a per-folder writability in FindFolder, and a
      // folder in your own mailbox is writable. A delegate's shared folder
      // fails at the write with Exchange's own reason, which is a better
      // message than a guess made here.
      readOnly: f.readOnly === true,
    })),
  };
}

/** Exchange writes ISO 8601 with a Z. Anything else is a server that has been
 *  configured to answer in local time, which cannot be resolved from here — so
 *  it is reported as floating rather than silently read as UTC. */
function toDate(raw, allDay) {
  const s = String(raw || '');
  if (!s) return null;
  if (allDay) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
    return m ? { iso: m[1], allDay: true, floating: false, zone: null } : null;
  }
  if (!/[Zz]$/.test(s)) {
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(s);
    return m ? { iso: m[1], allDay: false, floating: true, zone: null } : null;
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? { iso: new Date(ms).toISOString(), allDay: false, floating: false, zone: 'UTC' } : null;
}

function toEvent(it) {
  return {
    uid: it.uid,
    // The occurrence's own opaque ItemId, kept because it is the ONLY thing
    // GetItem accepts — the iCalendar UID above is shared by every occurrence
    // of a series and identifies none of them.
    itemId: it.id,
    seriesId: it.itemType === 'Single' ? '' : it.uid,
    sequence: 0,
    recurrenceId: null,
    summary: it.subject,
    location: it.location,
    // FindItem never returns a body — see ewsClient.js#getCalendarItem. Flagged
    // so the UI fetches it when the event is opened rather than showing an
    // event that looks like it has no notes.
    description: '',
    partialDescription: true,
    url: '',
    status: null,
    transparent: !!it.free,
    categories: [],
    start: toDate(it.start, it.allDay),
    end: toDate(it.end, it.allDay),
    allDay: !!it.allDay,
    rrule: null,
    exdates: [],
    rdates: [],
    // Occurrence and Exception both mean "part of a series"; Single does not.
    recurring: it.itemType === 'Occurrence' || it.itemType === 'Exception' || it.itemType === 'RecurringMaster',
    organizer: it.organizerEmail
      ? { name: it.organizerName, address: it.organizerEmail, status: null, role: null, rsvp: false, optional: false }
      : null,
    // FindItem does not return the attendee list — that needs a GetItem per
    // event, which for a year of a busy calendar is hundreds of extra round
    // trips for something the month grid never shows. Opening one event could
    // fetch them; nothing does yet.
    attendees: [],
    alarms: [],
    lastModified: it.lastModified,
  };
}

export async function syncCalendar(ctx, calendar, { window } = {}) {
  const folderId = String(calendar.href || '').replace(/^ews:/, '');
  const items = await ews.calendarView(folderId, new Date(window.from).toISOString(), new Date(window.to).toISOString());
  const components = [];
  for (const it of items) {
    const ev = toEvent(it);
    if (!ev.start) continue;
    components.push({
      href: `ews:${it.id}`,
      url: `ews:${it.id}`,
      // The ChangeKey is Exchange's ETag: it moves whenever the item does.
      etag: it.changeKey || it.lastModified || '',
      key: it.id,
      event: ev,
      ical: null,
    });
  }
  return { components, removedHrefs: [], full: false, windowed: window, unchanged: false, failed: 0 };
}

/**
 * The parts of an event FindItem cannot return: the body, the attendee list,
 * and the online-meeting link. Fetched only when somebody opens an event —
 * see ewsClient.js#getCalendarItem for why it is not part of the sync.
 *
 * Returns null rather than throwing when the item is gone: an event deleted in
 * Outlook since the last sync should open with what Hmelj still knows, not
 * fail to open.
 */
export async function fetchDetail(ctx, ev) {
  if (!ev?.itemId) return null;
  try {
    const d = await ews.getCalendarItem(ev.itemId);
    if (!d) return null;
    // readableNotes either way, not only for HTML: Exchange's "text" body for
    // an item stored as HTML has dropped the tags and kept the entities, so a
    // meeting request arrives full of &lt; and &#xD;.
    const description = readableNotes(d.description, { isHtml: d.descriptionIsHtml });
    return {
      description: trimNotes(description),
      location: d.location || ev.location || '',
      // Exchange's own field first; the text search is what covers a meeting
      // organized elsewhere and forwarded in, which has no such field set.
      joinUrl: d.joinUrl || findJoinUrl(d.location, description),
      organizer: d.organizer ? { ...d.organizer, status: null, role: null, rsvp: false, optional: false } : ev.organizer,
      attendees: d.attendees.map((a) => ({
        name: a.name, address: a.address, role: null, rsvp: false,
        optional: !!a.optional,
        status: RESPONSE[String(a.status || '').toLowerCase()] || null,
      })),
    };
  } catch (e) {
    clog.debug(`Could not read the full event (${e.message})`);
    return null;
  }
}

/** Exchange's ResponseType, in iCalendar's words. */
const RESPONSE = {
  accept: 'ACCEPTED', decline: 'DECLINED', tentative: 'TENTATIVE',
  noresponsereceived: 'NEEDS-ACTION', organizer: 'ACCEPTED', unknown: null,
};


/* ---------- writing ----------
 *
 * Native rather than iCalendar, for the same reason the read path is: Exchange
 * holds the recurrence and applies it, and translating rules in and out to
 * write them back is where the errors would come from.
 *
 * An EWS update is stated property by property — one `SetItemField` per field
 * that actually changed. That is why `next` carries `undefined` for anything
 * the form did not touch: an untouched property is never sent, so an edit
 * cannot clear something Hmelj has no concept of.
 *
 * Exchange checks the SCHEMA ORDER of the fields in a new item and refuses the
 * whole request when they are out of it, so these are emitted in the schema's
 * order rather than the input's.
 */

const esc = (v) => String(v ?? '').replace(/[<>&'"]/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

/** Exchange takes an instant as ISO 8601 with a Z. `IsAllDayEvent` is what
 *  makes an event all-day; the times still have to be sent, and Exchange
 *  rejects an all-day event whose start is not a midnight. */
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function attendeeXml(tag, people) {
  if (!people.length) return '';
  return `<t:${tag}>${people.map((a) =>
    `<t:Attendee><t:Mailbox><t:EmailAddress>${esc(a.address)}</t:EmailAddress>`
    + (a.name ? `<t:Name>${esc(a.name)}</t:Name>` : '')
    + '</t:Mailbox></t:Attendee>').join('')}</t:${tag}>`;
}

/** The `<t:CalendarItem>` body for a NEW event, in the EWS schema's order. */
function newItemXml(next) {
  const parts = [];
  if (next.summary) parts.push(`<t:Subject>${esc(next.summary)}</t:Subject>`);
  if (next.description) parts.push(`<t:Body BodyType="Text">${esc(next.description)}</t:Body>`);
  parts.push(`<t:Start>${stamp(next.start)}</t:Start>`);
  parts.push(`<t:End>${stamp(next.end)}</t:End>`);
  if (next.allDay) parts.push('<t:IsAllDayEvent>true</t:IsAllDayEvent>');
  if (next.location) parts.push(`<t:Location>${esc(next.location)}</t:Location>`);
  parts.push(attendeeXml('RequiredAttendees', (next.attendees || []).filter((a) => !a.optional)));
  parts.push(attendeeXml('OptionalAttendees', (next.attendees || []).filter((a) => a.optional)));
  if (next.rrule) parts.push(recur.toEws(next.rrule, { startMs: next.start, zone: next.zone || 'UTC' }));
  return parts.join('');
}

/** The SetItemField list for an EDIT — only the properties that were touched. */
function fieldsFor(next, { allowRecurrence = true, wasRecurring = false, prev = null } = {}) {
  const out = [];
  const set = (uri, xml) => out.push(ews.calField(uri, xml));
  const clear = (uri) => out.push(ews.calDelete(uri));

  /**
   * Did the event actually HAVE this before?
   *
   * A DeleteItemField for a property that was already empty is at best a no-op
   * and at worst the whole request — Exchange answers ErrorInvalidPropertyDelete
   * for several of them, and refuses the update entirely. The event form sends
   * every field on every save, empty ones included, so an edit that only changed
   * the title was arriving as "set the title, and delete the location, and
   * delete both attendee lists" for an event that never had any of those. That
   * is what made editing an ordinary Exchange event fail with a message about a
   * property the user had not touched.
   *
   * With no `prev` to consult the old behaviour stands, since the alternative —
   * assuming empty — would stop a real clear from ever going out.
   */
  const had = (key) => {
    if (!prev) return true;
    const v = prev[key];
    return Array.isArray(v) ? v.length > 0 : !!v;
  };

  if (next.summary !== undefined) {
    if (next.summary) set('item:Subject', `<t:Subject>${esc(next.summary)}</t:Subject>`);
    else if (had('summary')) clear('item:Subject');
  }
  if (next.description !== undefined) {
    // An EMPTY body is SET, never deleted. Exchange refuses DeleteItemField on
    // item:Body with ErrorInvalidPropertyDelete ("the delete action is not
    // supported for this property") — and since the event form always sends its
    // notes field, every edit of an Exchange event with empty notes failed on
    // this, whatever the edit was actually about. Setting an empty body is what
    // "clear the notes" means here, and Exchange accepts it.
    set('item:Body', `<t:Body BodyType="Text">${esc(next.description)}</t:Body>`);
  }
  if (next.start !== undefined) {
    set('calendar:Start', `<t:Start>${stamp(next.start)}</t:Start>`);
    set('calendar:End', `<t:End>${stamp(next.end)}</t:End>`);
    set('calendar:IsAllDayEvent', `<t:IsAllDayEvent>${next.allDay ? 'true' : 'false'}</t:IsAllDayEvent>`);
  }
  if (next.location !== undefined) {
    if (next.location) set('calendar:Location', `<t:Location>${esc(next.location)}</t:Location>`);
    else if (had('location')) clear('calendar:Location');
  }
  if (next.attendees !== undefined) {
    const required = next.attendees.filter((a) => !a.optional);
    const optional = next.attendees.filter((a) => a.optional);
    const hadRequired = (prev?.attendees || []).some((a) => !a.optional);
    const hadOptional = (prev?.attendees || []).some((a) => a.optional);
    if (required.length) set('calendar:RequiredAttendees', attendeeXml('RequiredAttendees', required));
    else if (!prev || hadRequired) clear('calendar:RequiredAttendees');
    if (optional.length) set('calendar:OptionalAttendees', attendeeXml('OptionalAttendees', optional));
    else if (!prev || hadOptional) clear('calendar:OptionalAttendees');
  }
  // Last, and only where it means anything: a recurrence must follow the start
  // it is relative to, and an OCCURRENCE cannot carry one at all — sending it
  // would try to turn one instance into a series of its own.
  if (allowRecurrence && next.rrule !== undefined) {
    if (next.rrule) set('calendar:Recurrence', recur.toEws(next.rrule, { startMs: next.start, zone: next.zone || 'UTC' }));
    // Only worth deleting when there is one to delete. Exchange answers
    // ErrorInvalidPropertyDelete for a DeleteItemField on calendar:Recurrence
    // of an item that never had one — and the form sends `rrule: null` for
    // "Does not repeat" on every save, so editing an ordinary one-off Exchange
    // event hit this on a property the edit had nothing to do with.
    else if (wasRecurring) clear('calendar:Recurrence');
  }
  return out.join('');
}

export async function createEventNative(ctx, calendar, next) {
  const created = await ews.createCalendarItem(folderIdOf(calendar), newItemXml(next));
  return { uid: created.id, itemId: created.id };
}

/** Whether an edit or a delete has to resolve the recurring master first. */
export const needsMaster = ({ detail, scope }) => !!detail?.recurring && scope !== 'one';

/**
 * What a write BECOMES, as a list of operations — pure, so the addressing can
 * be tested without an Exchange server.
 *
 * Worth being pure: "the whole series" applied to an occurrence id edits one
 * instance and leaves the rest, and Exchange reports that as a success.
 */
export function planWrite({ detail, scope, next, master, folderId, deleting = false }) {
  const id = detail?.itemId;
  if (!id) throw Object.assign(new Error('That event has no Exchange id — re-sync the calendar and try again.'), { status: 409 });

  if (!needsMaster({ detail, scope })) {
    if (deleting) return [{ op: 'delete', id }];
    // An OCCURRENCE cannot carry a recurrence — sending one would try to turn
    // one instance into a series of its own.
    return [{ op: 'update', id, fields: fieldsFor(next, { allowRecurrence: !detail.recurring, wasRecurring: !!detail.recurring, prev: detail }) }];
  }

  if (!master?.id) throw Object.assign(new Error('The repeating event this belongs to could not be found on the server.'), { status: 409 });
  if (scope === 'all') {
    return deleting
      ? [{ op: 'delete', id: master.id }]
      : [{ op: 'update', id: master.id, fields: fieldsFor(next, { wasRecurring: true, prev: detail }) }];
  }

  // "This and everything after it": Exchange has no split operation either, so
  // the old series is capped the day before and a new one carries the change
  // forward. Capped FIRST, or both series cover this occurrence's day and every
  // subscriber sees it twice until the second write lands.
  const zone = next?.zone || detail.zone || 'UTC';
  const oldRule = recur.fromEws(master.recurrence);
  const capped = oldRule ? recur.cappedBefore(oldRule, detail.start, zone) : null;
  if (!capped) throw Object.assign(new Error('That repeating event does not state a rule Hmelj can split.'), { status: 400 });
  const masterStart = Date.parse(master.start) || detail.start;

  const ops = [{
    op: 'update', id: master.id,
    fields: ews.calField('calendar:Recurrence', recur.toEws(capped, { startMs: masterStart, zone })),
  }];
  if (!deleting) {
    ops.push({ op: 'create', folderId, xml: newItemXml({
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
    if (o.op === 'update') await ews.updateCalendarItem(o.id, o.fields);
    else if (o.op === 'delete') await ews.deleteCalendarItem(o.id);
    else if (o.op === 'create') createdId = (await ews.createCalendarItem(o.folderId, o.xml)).id;
  }
  return createdId;
}

const folderIdOf = (calendar) => String(calendar.href || '').replace(/^ews:/, '');

export async function updateEventNative(ctx, calendar, { detail, scope }, next) {
  const master = needsMaster({ detail, scope }) ? await ews.recurringMasterOf(detail.itemId) : null;
  const ops = planWrite({ detail, scope, next, master, folderId: folderIdOf(calendar) });
  const uid = await run(ops);
  return { scope, ...(uid ? { uid } : {}) };
}

export async function deleteEventNative(ctx, calendar, { detail, scope }) {
  const master = needsMaster({ detail, scope }) ? await ews.recurringMasterOf(detail.itemId) : null;
  const ops = planWrite({ detail, scope, master, folderId: folderIdOf(calendar), deleting: true });
  await run(ops);
  return { deleted: ops.some((o) => o.op === 'delete') };
}

/** Exchange has no iCalendar to read back — the native write path never asks. */
export const readEvent = async () => null;

/** For the tests: the XML an edit turns into is the whole of what Exchange
 *  sees, and asserting it is the only way to catch a field left un-escaped or
 *  emitted out of schema order. */
export const _internals = { newItemXml, fieldsFor };
