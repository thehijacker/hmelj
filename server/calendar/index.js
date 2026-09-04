// Hmelj — calendar protocol dispatch, and the storage rules that go with it.
//
// Modelled on server/mailClient.js and server/contactsSync/index.js: every
// caller outside this directory imports from HERE, and this is the only file
// that knows there is more than one kind of calendar server.
//
// ── The two reconciliation models, and why there are two ─────────────────────
// The backends divide cleanly in half, and the difference is not cosmetic:
//
//   expandsServerSide = false   CalDAV and Google. The server hands over
//     (CalDAV, Google)          iCalendar with its recurrence rules intact, so
//                               components are stored AS WRITTEN and expanded
//                               locally over whatever window is being looked at.
//                               The calendar is then known for all time.
//                               Reconciled by href, like any DAV collection.
//
//   expandsServerSide = true    Graph and EWS. Neither hands over iCalendar;
//     (Graph, EWS)              both will expand their own recurrence over a
//                               window if asked. Each occurrence is stored as an
//                               ordinary one-off component, and the calendar is
//                               known only over the window that was synced.
//                               Reconciled WITHIN THAT WINDOW — anything stored
//                               inside it that did not come back is gone, and
//                               anything outside it is left strictly alone.
//
// Getting the second one wrong in the obvious way — treating a windowed answer
// as the whole truth — deletes every event outside the window on the first sync.
// That rule is applied here, once, rather than in each backend.
import { createClient, basicAuth, bearerAuth } from '../dav/client.js';
import * as caldavCalendar from './caldavCalendar.js';
import * as googleCalendar from './googleCalendar.js';
import * as graphCalendar from './graphCalendar.js';
import * as ewsCalendar from './ewsCalendar.js';
import * as localCalendar from './localCalendar.js';
import * as store from '../calendarStore.js';
import * as cache from '../cache.js';
import * as accounts from '../accounts.js';
import * as oauth from '../oauth.js';
import { parseRRule } from '../rrule.js';
import { _internals as evInternals } from '../calendarEvents.js';
import { runAsAccount, listUsers, userKey } from '../session.js';
import { log } from '../log.js';

const clog = log.scope('calendar-sync');

const BACKENDS = {
  // A calendar that lives in Hmelj itself: no server, no credentials, no
  // client to build — buildContext returns early for it, and withSource runs
  // it directly.
  local: localCalendar,
  caldav: caldavCalendar,
  google: googleCalendar,
  graph: graphCalendar,
  ews: ewsCalendar,
};

/** Backends that talk DAV and need an HTTP client built for them. */
const DAV_KINDS = new Set(['caldav', 'google']);

/** Backends reached through a client that reads the account off the ALS
 *  context, and so must run inside runAsAccount. Google is account-backed too
 *  but does not need this — it talks DAV with a token built from the account
 *  record directly. */
const ALS_KINDS = new Set(['graph', 'ews']);

export function backendFor(kind) {
  const b = BACKENDS[kind];
  if (!b) throw Object.assign(new Error(`Unknown calendar source type: ${kind}`), { status: 400 });
  return b;
}

async function buildContext(uKey, source) {
  const ctx = { uKey, source, client: null, baseUrl: source.url || '', account: null };
  if (source.accountId) ctx.account = accounts.getAccount(source.accountId) || null;
  if (!DAV_KINDS.has(source.kind)) return ctx;

  if (source.kind === 'caldav') {
    const password = store.passwordOf(source);
    if (!source.username || !password) {
      throw Object.assign(new Error(`${source.label}: no username or password stored — open Settings → Calendars and enter them again.`), { status: 400 });
    }
    ctx.client = createClient({ auth: basicAuth(source.username, password) });
    return ctx;
  }

  // Google: the credential is the mail account's OAuth token.
  if (!ctx.account) throw Object.assign(new Error(`${source.label}: the mail account it signs in with is gone`), { status: 400 });
  ctx.baseUrl = googleCalendar.baseUrlFor(ctx.account.email);
  ctx.client = createClient({
    // Fetched per request so a token expiring mid-sync is picked up on the next
    // call rather than failing every remaining one.
    auth: bearerAuth(() => oauth.accessTokenFor(ctx.account, uKey)),
    reauth: async () => { try { await oauth.refresh(ctx.account, uKey); return true; } catch { return false; } },
  });
  return ctx;
}

async function withSource(uKey, source, fn) {
  const ctx = await buildContext(uKey, source);
  if (!ALS_KINDS.has(source.kind)) return fn(ctx);
  const user = listUsers().find((u) => userKey(u.username) === uKey);
  if (!user) throw Object.assign(new Error('Could not resolve the Hmelj user for this calendar source'), { status: 500 });
  return runAsAccount(user, source.accountId, () => fn(ctx));
}

/** What this source can see, without saving anything — same reasoning as the
 *  contact-source probe: save-then-discover leaves a broken source behind every
 *  time a password is mistyped. */
export async function discoverFor(uKey, source) {
  return withSource(uKey, source, (ctx) => backendFor(source.kind).discoverCalendars(ctx));
}

/**
 * Creates a new calendar in a source, on whatever server that source talks to.
 *
 * Only the remote half. The caller stores what comes back
 * (calendarStore.js#addCalendar), which is what gives it a Hmelj id and puts it
 * in the list — exactly the split discoverFor/saveSource already use, and for
 * the same reason: a failed create must leave nothing behind locally.
 */
export async function createCalendarFor(uKey, source, { displayName, color = '' }) {
  const name = String(displayName || '').trim();
  if (!name) throw Object.assign(new Error('A calendar needs a name'), { status: 400 });
  const backend = backendFor(source.kind);
  if (!backend.createCalendar) {
    throw Object.assign(new Error(`Creating calendars is not supported for ${source.kind} sources yet`), { status: 400 });
  }
  return withSource(uKey, source, (ctx) => backend.createCalendar(ctx, { displayName: name, color }));
}

/* ---------------- storing what came back ---------------- */

/**
 * The last instant a series can reach, or null.
 *
 * Only UNTIL can be resolved without expanding. A COUNT-bounded rule stores
 * null and is expanded on every query — which is cheap, because expansion stops
 * the moment the count is spent, and which is much safer than guessing an end
 * and hiding the tail of somebody's series.
 */
function untilMsOf(rruleText, zone) {
  const rule = parseRRule(rruleText);
  if (!rule?.until) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(rule.until).trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 23), +(m[5] ?? 59), +(m[6] ?? 59));
  // A day of slack: a non-UTC UNTIL is a wall time in the event's own zone, and
  // being an hour or two generous at the very end of a series is free, while
  // being short by the same amount silently drops its last occurrence.
  return m[7] ? ms : ms + 86400000;
}

/** One backend component → one database row. */
function rowFor(uKey, source, calendar, comp) {
  const ev = comp.event;
  const zone = evInternals.zoneOf(ev, 'UTC');
  const dtstart = evInternals.refInstant(ev.start, zone);
  if (dtstart == null) return null;
  const dtend = ev.end ? evInternals.refInstant(ev.end, zone) : null;
  const recurrenceId = ev.recurrenceId ? String(evInternals.refInstant(ev.recurrenceId, zone)) : '';
  return {
    user_key: uKey,
    source_id: source.id,
    calendar_id: calendar.id,
    // A backend whose occurrences carry their own opaque id (Graph, EWS) says
    // so with `key`: each row is one occurrence and its id is what makes it
    // unique. A CalDAV component is identified by its iCalendar UID, with the
    // RECURRENCE-ID telling a master from its exceptions.
    uid: comp.key || ev.uid,
    recurrence_id: recurrenceId,
    href: comp.href || null,
    etag: comp.etag || null,
    dtstart_ms: dtstart,
    dtend_ms: dtend,
    all_day: ev.allDay ? 1 : 0,
    until_ms: ev.rrule ? untilMsOf(ev.rrule, zone) : null,
    rrule: ev.rrule || null,
    summary: ev.summary || '',
    json: JSON.stringify(ev),
    ical: comp.ical || null,
    updated_at: Date.now(),
  };
}

/**
 * One calendar, brought up to date.
 *
 * `window` is only consulted by the server-side-expanding backends; the others
 * ignore it and fetch everything the collection holds.
 */
export async function syncCalendarFor(uKey, source, calendar, { force = false, window } = {}) {
  const backend = backendFor(source.kind);
  const known = backend.expandsServerSide
    ? new Map()
    : cache.calendarEtags(uKey, source.id, calendar.id);

  const result = await withSource(uKey, source,
    (ctx) => backend.syncCalendar(ctx, { ...calendar, url: calendar.url || ctx.baseUrl }, { known, force, window }));

  if (result.unchanged && !result.components.length && !result.removedHrefs.length) {
    store.updateSyncStateFor(uKey, source.id, calendar.id, {
      ctag: result.ctag || calendar.ctag, syncToken: result.syncToken || calendar.syncToken,
      lastSyncAt: Date.now(), lastError: '',
      // Written on THIS path too, not only when something came back. A calendar
      // that has not changed takes this branch on every poll — so leaving the
      // count out here means a wrong one can never correct itself, which is
      // precisely what happened when the count stopped being the delta: the
      // calendars that most needed the new number were the quiet ones that
      // never reached the code computing it.
      count: cache.calendarEventCount(uKey, source.id, calendar.id),
    });
    return { added: 0, removed: 0, unchanged: true };
  }

  // Everything that came from an href is replaced together. One .ics resource
  // holds a master AND its exceptions, so removing the href's rows first is
  // what stops an exception outliving the occurrence it edited.
  const seenHrefs = new Set();
  const rows = [];
  for (const comp of result.components) {
    const row = rowFor(uKey, source, calendar, comp);
    if (!row) continue;
    if (row.href && !seenHrefs.has(row.href)) {
      seenHrefs.add(row.href);
      cache.deleteCalendarHref(uKey, source.id, calendar.id, row.href);
    }
    rows.push(row);
  }
  if (rows.length) cache.upsertCalendarEvents(rows);

  let removed = 0;
  for (const href of result.removedHrefs || []) {
    removed += cache.deleteCalendarHref(uKey, source.id, calendar.id, href);
  }

  if (result.windowed) {
    // The windowed model: the answer is complete for THIS RANGE only. Anything
    // stored inside it that did not come back is gone; anything outside it is
    // none of this sync's business.
    const stale = [...cache.calendarHrefsInWindow(uKey, source.id, calendar.id, result.windowed.from, result.windowed.to)]
      .filter((href) => !seenHrefs.has(href));
    if (stale.length) removed += cache.deleteCalendarHrefs(uKey, source.id, calendar.id, stale);
  } else if (result.full) {
    // The whole-collection model: `components` is every item there is.
    const stale = [...cache.calendarEtags(uKey, source.id, calendar.id).keys()].filter((href) => !seenHrefs.has(href));
    if (stale.length) removed += cache.deleteCalendarHrefs(uKey, source.id, calendar.id, stale);
  }

  store.updateSyncStateFor(uKey, source.id, calendar.id, {
    ctag: result.ctag || '', syncToken: result.syncToken || '',
    lastSyncAt: Date.now(), lastError: '',
    // What the calendar HOLDS, asked of the cache — not `rows.length`, which is
    // what this pass happened to fetch. The two agree only on a first, full
    // sync, which is exactly why the old value looked right: a calendar synced
    // once and never changed again kept its total, while every calendar that
    // saw an incremental poll dropped to "how many items changed last time".
    // A calendar with 148 events was reporting 1.
    count: cache.calendarEventCount(uKey, source.id, calendar.id),
  });

  if (rows.length || removed) {
    clog.info(`${source.label} / ${calendar.displayName}: ${rows.length} component(s), ${removed} removed`);
  }
  return { added: rows.length, removed, unchanged: false };
}

/** Every enabled calendar of one source. Failures are per calendar: one the
 *  server will not serve must not stop the others. */
/** One calendar, re-read immediately after a write. Without it, an event
 *  someone just created is invisible until the next poll — up to five minutes
 *  of a screen that looks like the save failed. */
export async function refreshCalendarFor(uKey, sourceId, calendarId, { window } = {}) {
  const source = store.rawSourceFor(uKey, sourceId);
  const calendar = source?.calendars?.find((c) => c.id === calendarId);
  if (!source || !calendar) return null;
  // force: the CTag has just changed under us, and on a local calendar there is
  // no CTag at all — neither should be trusted to notice a write from this
  // very process.
  return syncCalendarFor(uKey, source, calendar, { force: true, window });
}

export async function syncSourceFor(uKey, sourceId, { force = false, window, interactive = false } = {}) {
  let source = store.rawSourceFor(uKey, sourceId);
  if (!source) throw Object.assign(new Error('No such calendar source'), { status: 404 });
  if (source.enabled === false) return { skipped: true, calendars: [] };

  if (shouldRefreshMeta(source, interactive)) {
    await refreshCalendarMeta(uKey, source).catch((e) =>
      clog.warn(`${source.label}: could not refresh calendar names — ${e.message}`));
    // Re-read: refreshCalendarMeta wrote through the store, and the loop below
    // reports each calendar's displayName.
    source = store.rawSourceFor(uKey, sourceId) || source;
  }

  const out = [];
  let lastError = '';
  for (const calendar of source.calendars || []) {
    if (!calendar.enabled) continue;
    try {
      out.push({ calendarId: calendar.id, displayName: calendar.displayName, ...await syncCalendarFor(uKey, source, calendar, { force, window }) });
    } catch (e) {
      lastError = e.message;
      clog.warn(`${source.label} / ${calendar.displayName}: ${e.message}`);
      store.updateSyncStateFor(uKey, source.id, calendar.id, { lastError: e.message, lastSyncAt: Date.now() });
      out.push({ calendarId: calendar.id, displayName: calendar.displayName, error: e.message });
    }
  }
  store.updateSyncStateFor(uKey, source.id, null, { lastSyncAt: Date.now(), lastError });
  return { skipped: false, calendars: out };
}

/**
 * How often a background sync re-reads the calendar LIST from the server.
 *
 * Syncing a calendar reads its events, not its name — the name comes from
 * discovery, which used to run only when somebody set the source up. So
 * renaming a calendar on Google, or recolouring it, never reached Hmelj: it
 * went on showing the name the calendar had on the day it was added.
 *
 * Not done on every poll, because it is a whole extra request per source for
 * something that changes once a year. Hourly in the background, and always on
 * an interactive "Sync now" — which is what somebody who has just renamed a
 * calendar will press.
 */
const META_REFRESH_MS = 3600e3;

/**
 * One collection address, reduced to something two spellings of it agree on.
 *
 * The same collection reaches this code written two ways, and comparing the raw
 * strings quietly matched neither against the other:
 *
 *   discovered   /caldav/v2/andrej%40gmail.com/events/      path, trailing slash
 *   created      https://apidata…/caldav/v2/…/events        absolute, no slash
 *
 * The second is what a calendar CREATED through Hmelj stored, so a refresh
 * silently skipped exactly the calendars the user had made themselves — the
 * name never updated, with nothing in the log to say why, because "no match"
 * is indistinguishable from "no change".
 *
 * Path only, and no trailing slash. Percent-encoding is left as written: both
 * sides encode the address the same way, and decoding would make `/a%2Fb/` and
 * `/a/b/` compare equal when they are different resources.
 */
function collectionKey(href) {
  const s = String(href || '');
  if (!s) return '';
  // Only DAV addresses have the two-spellings problem. `graph:<id>`,
  // `ews:<id>` and `local:<id>` are opaque handles the same code writes and
  // reads, so they are compared whole — running them through URL would strip
  // the scheme and let a Graph calendar and an EWS one with the same id look
  // like the same collection.
  if (!/^(https?:)?\//i.test(s)) return s;
  let out = s;
  // The base only matters for a relative href; an absolute one ignores it.
  try { out = new URL(s, 'http://collection.invalid/').pathname; } catch { /* keep it as written */ }
  return out.replace(/\/+$/, '');
}

function shouldRefreshMeta(source, interactive) {
  return interactive || (Date.now() - (source.lastMetaAt || 0)) > META_REFRESH_MS;
}

/**
 * Re-reads the calendar list and updates what the SERVER owns about each one:
 * its name, whether it is read-only, and its colour.
 *
 * Only calendars already stored are touched. Discovering NEW ones stays an
 * explicit action in Settings — a work server routinely shares a dozen nobody
 * asked for, and having them appear by themselves is the behaviour the
 * enabled-by-default flag exists to prevent (see calendarStore.js#mergeCalendars).
 *
 * A colour the USER picked is left alone; that is exactly what colorLocked
 * means, and re-reading the server's would undo their choice on a schedule.
 */
async function refreshCalendarMeta(uKey, source) {
  const found = await discoverFor(uKey, source);
  const byHref = new Map();
  for (const c of found.collections || []) {
    for (const h of [c.href, c.url]) {
      const k = collectionKey(h);
      if (k) byHref.set(k, c);
    }
  }
  for (const cal of source.calendars || []) {
    const live = byHref.get(collectionKey(cal.href)) || byHref.get(collectionKey(cal.url));
    if (!live) continue;
    const patch = {};
    if (live.displayName && live.displayName !== cal.displayName) patch.displayName = live.displayName;
    if (live.readOnly !== undefined && !!live.readOnly !== !!cal.readOnly) patch.readOnly = !!live.readOnly;
    if (!cal.colorLocked && live.color && live.color !== cal.color) patch.color = live.color;
    if (Object.keys(patch).length) {
      clog.info(`${source.label}: ${cal.displayName} → ${JSON.stringify(patch)}`);
      store.updateSyncStateFor(uKey, source.id, cal.id, patch);
    }
  }
  store.updateSyncStateFor(uKey, source.id, null, { lastMetaAt: Date.now() });
}

/** Whether a source's calendars are only known over a rolling window — which
 *  the UI has to be able to say, because "my appointment in 2031 is missing"
 *  deserves an answer. */
export function isWindowed(kind) {
  return backendFor(kind).expandsServerSide === true;
}

/** Exposed so server/calendarWrite.js can run a backend call in the right
 *  context without re-deriving credentials — the write path needs exactly what
 *  the sync path needs, and two copies of that would drift. */
export { withSource };
