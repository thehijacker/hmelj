// Hmelj — the CalDAV calendar backend.
//
// Thin, for the same reason server/contactsSync/carddav.js is: server/dav/*
// already knows how to talk to a DAV server and work out what changed, and
// server/icalendar.js already knows how to read what comes back. What is left
// is the join, plus the one decision specific to calendars.
//
// ── The decision: components, not occurrences ────────────────────────────────
// A CalDAV server hands over iCalendar, recurrence rules and all. Those are
// stored AS WRITTEN — one row per component — and expanded locally over
// whatever window is being looked at (server/rrule.js). That is the opposite of
// what the Graph and EWS backends do, and deliberately so: there the server
// expands and here we do, because here we have the authoritative rule text and
// there we would have to translate somebody else's recurrence model into it.
//
// The upside is that a CalDAV calendar is known for all time rather than over a
// rolling window, so scrolling to 2031 works and needs no fetch.
import crypto from 'node:crypto';
import { syncCollection, fetchItems } from '../dav/sync.js';
import { discover } from '../dav/discover.js';
import { parseCalendar } from '../icalendar.js';
import { log } from '../log.js';

const clog = log.scope('caldav');

export const kind = 'caldav';
export const writable = true;
export const expandsServerSide = false;
/** A CalDAV server stores what it is given and mails nothing on anybody's
 *  behalf, so invitations to attendees are Hmelj's own job — see server/itip.js
 *  and the double-invite guard in ./index.js. */
export const sendsInvitationsItself = false;

export async function discoverCalendars(ctx) {
  const found = await discover(ctx.client, { url: ctx.baseUrl || ctx.source.url, kind: 'caldav' });
  return {
    principalUrl: found.principalUrl,
    homeUrl: found.homeUrl,
    collections: found.collections.map((c) => ({
      href: c.href,
      url: c.url,
      displayName: c.displayName,
      color: c.color,
      readOnly: c.readOnly,
    })),
  };
}

/**
 * A new collection on the server, via MKCALENDAR (RFC 4791 §5.3.1).
 *
 * The href is ours to choose — the spec says the client picks it — so it is a
 * fresh UUID rather than anything derived from the name: a name can repeat, can
 * contain a slash, and can be renamed afterwards, and a collection whose address
 * encodes its old title is a small trap for later.
 *
 * NOT used for Google, which delegates everything else here but does not
 * implement MKCALENDAR at all — see googleCalendar.js's own override.
 */
export async function createCalendar(ctx, { displayName, color }) {
  const home = ctx.source.homeUrl || ctx.baseUrl;
  if (!home) throw Object.assign(new Error('This CalDAV source has no calendar home to create in — re-run discovery for it first'), { status: 400 });
  const href = `${home.replace(/\/*$/, '/')}${crypto.randomUUID()}/`;
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:IC="http://apple.com/ns/ical/">'
    + '<D:set><D:prop>'
    + `<D:displayname>${xmlText(displayName)}</D:displayname>`
    + (color ? `<IC:calendar-color>${xmlText(color)}</IC:calendar-color>` : '')
    // Without this a server is free to accept every component type, and some
    // then offer the collection as a task list too. Events only, said plainly.
    + '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>'
    + '</D:prop></D:set></C:mkcalendar>';
  await ctx.client.raw('MKCALENDAR', href, { body, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
  return { href, url: href, displayName, color: color || '', readOnly: false };
}

/** The five characters that cannot appear as text in XML. Small enough to do
 *  here rather than pull in a dependency for one element's worth of content. */
function xmlText(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

/**
 * What changed in one calendar, bodies included.
 *
 * `known` is the caller's href → ETag view, needed only where the server has no
 * sync-collection. `full: true` means what came back is every item there is —
 * see server/contactsSync/index.js's note on why that word has exactly one
 * meaning everywhere.
 */
export async function syncCalendar(ctx, calendar, { known = new Map(), force = false } = {}) {
  const url = calendar.url || ctx.baseUrl;
  const state = await syncCollection(ctx.client, {
    url, kind: 'caldav', syncToken: calendar.syncToken, ctag: calendar.ctag, known, force,
  });

  if (state.unchanged && !state.changed.length && !state.removed.length) {
    return { components: [], removedHrefs: [], ctag: state.ctag, syncToken: state.syncToken, full: false, unchanged: true };
  }

  const { items, failed } = await fetchItems(ctx.client, url, 'caldav', state.changed.map((c) => c.href));
  if (failed) clog.warn(`${calendar.displayName || url}: ${failed} item(s) could not be fetched — they are left as they were`);

  // One .ics resource holds a master AND its RECURRENCE-ID exceptions, so an
  // item flattens to several components that all belong to the same href. The
  // caller replaces them together, which is what keeps an exception from
  // outliving the occurrence it edited.
  const components = [];
  for (const item of items) {
    const cal = parseCalendar(item.data);
    if (!cal) continue;
    for (const ev of cal.events) {
      if (!ev.start || !ev.uid) continue; // cannot be placed on a grid — see icalendar.js
      components.push({ href: item.href, url: item.url, etag: item.etag, event: ev, ical: item.data });
    }
  }

  return {
    components,
    removedHrefs: state.removed,
    ctag: state.ctag,
    syncToken: state.syncToken,
    full: state.full,
    unchanged: false,
    failed,
  };
}

/* ---------------- writing ---------------- */

/**
 * Where an event lives inside a collection.
 *
 * `<collection>/<uid>.ics`, which is what every other client does and has one
 * property worth having: the URL is a pure function of the UID, so the same
 * event created here and on a phone collides on the server (412) rather than
 * silently becoming two entries. Same reasoning as the CardDAV side.
 */
export function hrefFor(calendar, uid) {
  const base = String(calendar.url || '').replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(uid)}.ics`;
}

/**
 * An absolute URL for an event, from whatever the caller had to hand.
 *
 * The cache stores an href as the server sent it, which is a PATH
 * (`/dav/cals/work/x.ics`) on every server tested — `fetch` refuses one of
 * those outright with "Invalid URL". Resolving against the collection's own URL
 * is what turns it back into something addressable, and it also covers the
 * servers that DO send absolute hrefs, since resolving an absolute URL against
 * a base returns it unchanged.
 */
function resolve(calendar, urlOrHref, uid) {
  const candidate = urlOrHref || (uid ? hrefFor(calendar, uid) : '');
  if (!candidate) throw Object.assign(new Error('No address for that event'), { status: 400 });
  try { return new URL(candidate, calendar.url || undefined).href; } catch { return candidate; }
}

export async function createEvent(ctx, calendar, { uid, ical }) {
  const url = hrefFor(calendar, uid);
  // If-None-Match: * — "only if it does not exist". A UID collision comes back
  // as a 412 instead of overwriting whatever was already there.
  const res = await ctx.client.put(url, ical, { etag: null, contentType: 'text/calendar; charset=utf-8' });
  return { url, href: pathOf(url), etag: res.etag };
}

/**
 * Replaces one event's document, conditionally.
 *
 * The ETag is the whole safety mechanism: a 412 means somebody changed the
 * event since Hmelj read it, and it is surfaced as a conflict rather than
 * retried without the condition. The unconditional retry IS the bug — it is how
 * the other person's edit gets destroyed, quietly, by a browser tab that had
 * been open since this morning.
 */
export async function updateEvent(ctx, calendar, { url, uid, etag }, ical) {
  const target = resolve(calendar, url, uid);
  const res = await ctx.client.put(target, ical, { etag: etag || undefined, contentType: 'text/calendar; charset=utf-8' });
  return { url: target, href: pathOf(target), etag: res.etag };
}

export async function deleteEvent(ctx, calendar, { url, uid, etag }) {
  await ctx.client.del(resolve(calendar, url, uid), { etag: etag || undefined });
  return true;
}

/** The document as it stands on the server — needed by any edit that patches
 *  rather than replaces, and by a conflict that has to be re-read before it can
 *  be resolved. */
export async function readEvent(ctx, calendar, { url, uid }) {
  const res = await ctx.client.get(resolve(calendar, url, uid));
  return res.body;
}

function pathOf(url) {
  try { return new URL(url).pathname; } catch { return url; }
}
