// Hmelj — a calendar that lives in Hmelj itself.
//
// The only source whose events are NOT a cache. Everything else here mirrors
// somebody's server and can be re-fetched; these exist in exactly one place, so
// they are stored as .ics files in DATA_DIR (server/calendarStore.js's
// local-calendar section) rather than in cache.sqlite. The same distinction
// server/scheduledSend.js draws, for the same reason.
//
// ── Why it exists ───────────────────────────────────────────────────────────
// Two reasons, and the second is the one that made it worth building now.
// Somebody who wants a calendar but has no CalDAV server should not have to
// find one. And the DAV-server phase publishes calendars for other clients to
// subscribe to — which needs a calendar that Hmelj owns outright, not a
// second-hand copy of one it is already subscribed to.
//
// ── Everything is stored as written ─────────────────────────────────────────
// An event is a whole VCALENDAR document, and an edit rewrites it through
// icalendar.js#patchEvent rather than regenerating it. That is not needed here
// the way it is for a remote server — Hmelj wrote these itself, so there is
// nothing of anybody else's to preserve — but keeping one write path means the
// local calendar and the CalDAV one cannot drift apart in what an edit does.
import crypto from 'node:crypto';
import * as store from '../calendarStore.js';
import { parseCalendar, serializeCalendar, patchEvent } from '../icalendar.js';
import { log } from '../log.js';

const clog = log.scope('local-calendar');

export const kind = 'local';
export const writable = true;
export const expandsServerSide = false;
/** Nothing is mailed on Hmelj's behalf by a filesystem, so invitations for a
 *  local calendar are Hmelj's own job — see server/itip.js. */
export const sendsInvitationsItself = false;

/** A local source IS its calendars; there is nothing to discover. Shaped like a
 *  discovery result anyway so the dispatcher needs no special case. */
export async function discoverCalendars(ctx) {
  return {
    principalUrl: '',
    homeUrl: '',
    collections: (ctx.source.calendars || []).map((c) => ({
      href: c.href || `local:${ctx.source.id}`,
      url: c.url || `local:${ctx.source.id}`,
      displayName: c.displayName || ctx.source.label,
      color: c.color || '',
      readOnly: false,
    })),
  };
}

/**
 * A new local calendar. Nothing is created anywhere — a local calendar IS its
 * record, and the events directory appears under it the first time something is
 * written (calendarStore.js's local-calendar section). The href only has to be
 * unique within the source; the id calendarStore assigns is the real handle.
 */
export async function createCalendar(ctx, { displayName, color }) {
  const href = `local:${ctx.source.id}:${crypto.randomUUID()}`;
  return { href, url: href, displayName, color: color || '', readOnly: false };
}

/**
 * Every event in the calendar.
 *
 * `full: true`, always, and correctly so: this really is the complete truth,
 * because there is no server that could be holding anything back. A local
 * calendar is also small enough that "all of it" is the right granularity —
 * there is no delta to ask for and nothing to ask.
 */
export async function syncCalendar(ctx, calendar) {
  const components = [];
  for (const { uid, ical } of store.listLocalEvents(ctx.uKey, calendar.id)) {
    const cal = parseCalendar(ical);
    if (!cal) { clog.warn(`${calendar.displayName}: ${uid}.ics will not parse — leaving it alone`); continue; }
    for (const ev of cal.events) {
      if (!ev.start || !ev.uid) continue;
      components.push({ href: `local:${uid}`, url: `local:${uid}`, etag: '', event: ev, ical });
    }
  }
  return { components, removedHrefs: [], ctag: '', syncToken: '', full: true, unchanged: false, failed: 0 };
}

/* ---------------- writing ---------------- */

export async function createEvent(ctx, calendar, { uid, ical }) {
  store.writeLocalEvent(ctx.uKey, calendar.id, uid, ical);
  return { href: `local:${uid}`, url: `local:${uid}`, etag: '' };
}

/**
 * Replaces one event's document.
 *
 * `etag` is accepted and ignored: there is no second writer to conflict with,
 * and inventing a version number so the signature matches the CalDAV backend's
 * would be a lie the dispatcher might one day believe. The argument stays so
 * the two backends remain callable through the same code path.
 */
export async function updateEvent(ctx, calendar, { uid }, ical) {
  if (store.readLocalEvent(ctx.uKey, calendar.id, uid) === null) {
    throw Object.assign(new Error('That event is no longer in this calendar'), { status: 404 });
  }
  store.writeLocalEvent(ctx.uKey, calendar.id, uid, ical);
  return { href: `local:${uid}`, url: `local:${uid}`, etag: '' };
}

export async function deleteEvent(ctx, calendar, { uid }) {
  store.deleteLocalEvent(ctx.uKey, calendar.id, uid);
  return true;
}

/** The stored document, for an edit that has to patch rather than replace. */
export async function readEvent(ctx, calendar, { uid }) {
  return store.readLocalEvent(ctx.uKey, calendar.id, uid);
}

export { serializeCalendar, patchEvent };
