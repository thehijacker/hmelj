// Hmelj — the Google Calendar backend.
//
// Almost nothing here, and that is the point: Google speaks CalDAV, so every
// function delegates to ./caldavCalendar.js. The only differences are handled
// before this file is reached — the credential is a Bearer token rather than a
// password, and the service root is fixed rather than typed by a user.
//
// Same reasoning as server/contactsSync/googleContacts.js. The Calendar REST
// API is better documented, and using it would mean translating Google's own
// recurrence and event model into this one — a second translation layer for
// data that is already available as the iCalendar this project reads natively.
//
// ── Google-specific facts worth knowing ─────────────────────────────────────
//  - The service root is apidata.googleusercontent.com, NOT www.googleapis.com,
//    which is where the CardDAV endpoint lives. Getting these two the wrong way
//    round produces a 404 that reads like a missing calendar.
//  - Google's CalDAV does not implement `sync-collection`, so the ETag-diff
//    fallback in server/dav/sync.js is what actually runs: one collection
//    listing per poll rather than one delta. Correct either way, just slower.
//  - The scope is https://www.googleapis.com/auth/calendar, requested per
//    account and only when calendar sync is switched on for it (see
//    oauth.js#FEATURE_SCOPES).
import * as caldav from './caldavCalendar.js';
import * as oauth from '../oauth.js';

export const kind = 'google';
export const writable = true;
export const expandsServerSide = false;
// Google DOES mail invitations itself when an event is saved with attendees, so
// Hmelj must not also send its own — see the guard in ./index.js. This is the
// one place CalDAV and Google genuinely differ in behaviour rather than only in
// credentials.
export const sendsInvitationsItself = true;

/** Google's CalDAV service root for an account. `/user` is the principal
 *  resource: a PROPFIND there answers with current-user-principal, which is
 *  where server/dav/discover.js's chain begins. */
export function baseUrlFor(email) {
  const who = encodeURIComponent(String(email || '').trim());
  if (!who) throw Object.assign(new Error('This Google account has no address to sync calendars for'), { status: 400 });
  return `https://apidata.googleusercontent.com/caldav/v2/${who}/user`;
}

export async function discoverCalendars(ctx) {
  const found = await caldav.discoverCalendars(ctx);
  return {
    ...found,
    collections: found.collections.map((c) => ({
      ...c,
      // Google's collection hrefs end in the calendar's own id, which for the
      // primary calendar is the account's address — a far better name than the
      // "events" the href's last segment would otherwise give.
      displayName: c.displayName && c.displayName !== 'events' ? c.displayName : (ctx.account?.email || ctx.source.label),
    })),
  };
}

/**
 * A new Google calendar — and the one place this file does NOT delegate.
 *
 * Google's CalDAV endpoint does not implement MKCALENDAR, so caldav.js's
 * version would fail here; creating a calendar is one of the things only the
 * REST API can do. Everything else about it stays CalDAV: the calendar is
 * created here, and the very next discovery finds it through the normal
 * collection listing like any other.
 *
 * No new consent is needed — https://www.googleapis.com/auth/calendar (already
 * requested for any account with calendar sync switched on, see
 * oauth.js#FEATURE_SCOPES) covers creating calendars as well as reading them.
 *
 * The href has to match what discovery will report for this calendar later, or
 * the stored record and the discovered one are two different calendars: Google
 * addresses a collection as /caldav/v2/<calendar id>/events, and the id of a
 * newly created calendar is the `id` in the response.
 */
export async function createCalendar(ctx, { displayName, color }) {
  const token = await oauth.accessTokenFor(ctx.account, ctx.uKey);
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: String(displayName || '').trim() }),
  });
  const text = await res.text();
  if (!res.ok) {
    // Google's error body is JSON with a genuinely useful message in it; the
    // status alone ("403") tells the user nothing about what to do.
    let why = text.slice(0, 300);
    try { why = JSON.parse(text)?.error?.message || why; } catch { /* not JSON — use the raw text */ }
    throw Object.assign(new Error(`Google refused to create the calendar: ${why}`), { status: res.status });
  }
  const made = JSON.parse(text);
  const id = String(made?.id || '');
  if (!id) throw new Error('Google created the calendar but did not say what its id is');
  // Trailing slash, because that is how DISCOVERY reports the same collection
  // and the two have to be recognisable as one address. They were not: a
  // calendar created here stored `…/events` while discovery reported
  // `/caldav/v2/…/events/`, so a later metadata refresh matched nothing and a
  // rename on Google never reached a calendar Hmelj had made. collectionKey in
  // ./index.js now normalises both, but writing the canonical form here keeps
  // the stored records consistent in the first place.
  const url = `https://apidata.googleusercontent.com/caldav/v2/${encodeURIComponent(id)}/events/`;
  return { href: url, url, displayName: made.summary || displayName, color: color || '', readOnly: false };
}

export const syncCalendar = caldav.syncCalendar;
export const createEvent = caldav.createEvent;
export const updateEvent = caldav.updateEvent;
export const deleteEvent = caldav.deleteEvent;
export const readEvent = caldav.readEvent;
export const hrefFor = caldav.hrefFor;
