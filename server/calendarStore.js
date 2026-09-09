// Hmelj — which calendars exist, where they come from, and how they are shown.
//
// The CONFIG only. The events themselves live in cache.sqlite (see the
// calendar_events block at the end of server/cache.js for why): every one of
// them can be re-read from the server it came from, which is the definition of
// a cache in this project.
//
// Deliberately parallel to server/contactSources.js rather than sharing code
// with it. The two records look alike today — a server, some credentials, a list
// of collections with per-collection sync state — and they will not stay alike:
// a calendar carries a colour, a default reminder and (from the DAV-server phase)
// whether it is published, none of which mean anything for an address book. The
// same reasoning store.js applies to its own duplicated load/save pair.
//
//   users/<viewerKey>/calendar-sources.json
//
// viewerKey, not userKey — a calendar is a property of the PERSON, and must
// never follow requireAuth's shared-mail-account ownership swap. See store.js's
// userDir() comment for what went wrong the last time that distinction was
// missed.
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { currentUser } from './session.js';
import { encrypt, decrypt } from './accounts.js';
import * as cache from './cache.js';
import { log } from './log.js';

const clog = log.scope('calendar-store');

/** Where a source's sign-in comes from: 'own' means it carries its own
 *  username/password, 'account' means it borrows a mail account's OAuth token.
 *
 *  `writable` says whether Hmelj can change a source's events at all, which
 *  is one question the UI asks in one place rather than each caller growing
 *  its own list of kinds. See server/calendarWrite.js for what writing a
 *  given kind actually involves. */
export const SOURCE_KINDS = {
  // A calendar that lives in Hmelj itself. No server, no credentials — its
  // events are .ics files in DATA_DIR, beside the scheduled-send queue and for
  // the same reason that file's header gives: they exist NOWHERE ELSE, so
  // unlike everything synced from somebody's server they cannot be re-fetched
  // if lost.
  local: { label: 'Hmelj calendar', credentials: 'none', writable: true, canCreate: true },
  caldav: { label: 'CalDAV', credentials: 'own', writable: true, canCreate: true },
  google: { label: 'Google Calendar', credentials: 'account', writable: true, canCreate: true },
  // Microsoft and Exchange are writable through their OWN models rather than
  // through iCalendar. They store expanded occurrences over a rolling window
  // rather than components with rules, so an edit is addressed to the server's
  // own ids — the occurrence for "just this one", the series master for the
  // rule — and the recurrence is translated by server/recurrenceMap.js, which
  // refuses any rule it cannot express exactly rather than saving an
  // approximation. See the writing sections in calendar/graphCalendar.js and
  // calendar/ewsCalendar.js.
  //
  // There is deliberately no `eventColor` flag here any more. It said which
  // backends could store a per-event colour, back when the colour lived in the
  // iCalendar document — Microsoft and Exchange could not, and (as it turned
  // out by measurement) neither could Google, whose CalDAV drops the property
  // on the way through. Hmelj stores the colour itself now, so the answer is
  // "all of them" and there is nothing left to ask. See the per-event colours
  // section further down.
  //
  // `canCreate` says whether a NEW calendar can be made in this source.
  // Exchange is the one no: EWS can do it (CreateFolder with a CalendarFolder),
  // but every folder operation in server/ewsClient.js is notImplemented and
  // there is no folder SOAP in that file to build on yet.
  graph: { label: 'Microsoft 365', credentials: 'account', writable: true, canCreate: true },
  ews: { label: 'Exchange', credentials: 'account', writable: true, canCreate: false },
};

/**
 * The reminder offsets Hmelj offers, in minutes before the event.
 *
 * Outlook's own list, deliberately — this is the vocabulary people already have
 * for the question, and inventing a different one buys nothing. `0` is "at the
 * time of the event"; `-1` is the odd one out and means "never remind me from
 * this calendar at all", which is not an offset but belongs in the same picker
 * because that is where somebody looks for it.
 */
export const REMINDER_MINUTES = [0, 5, 10, 15, 30, 60, 120, 720, 1440, 2880, 10080];

/** `null` means "use whatever the event itself asks for, and nothing if it asks
 *  for nothing" — which is the right default, because an event that carries a
 *  VALARM has already been told when to remind you. */
export const REMINDER_NEVER = -1;

/** The palette a calendar with no colour of its own gets, in order. Mirrors
 *  accounts.js#ACCOUNT_COLORS so a calendar and a mail account never look like
 *  two unrelated colour schemes in the same sidebar. */
export const CALENDAR_COLORS = ['#0b57d0', '#0f9d58', '#e37400', '#a142f4', '#d93025', '#00897b', '#f6bf26', '#5f6368'];

/* ---------------- paths ---------------- */

function userDirFor(uKey) {
  const dir = path.join(config.dataDir, 'users', uKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const configFileFor = (uKey) => path.join(userDirFor(uKey), 'calendar-sources.json');

/** Ids are minted here and never taken from a request — but they come back as
 *  route parameters, so anything built from one is built from user input
 *  whoever minted it. Same guard, same reasoning, as scheduledSend.js#assertId. */
export function assertId(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw Object.assign(new Error('Bad id'), { status: 400 });
  return String(id);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return structuredClone(fallback); }
}

/** Temp file then rename — the rename is the only atomic step, and a
 *  half-written config after a crash mid-sync is a calendar list that will not
 *  load. Same as store.js. */
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/* ---------------- sources ---------------- */

const uk = () => currentUser().viewerKey;

export function rawSourcesFor(uKey) { return readJson(configFileFor(uKey), []); }

export function rawSourceFor(uKey, id) {
  return rawSourcesFor(uKey).find((s) => s.id === assertId(id)) || null;
}
export const rawSource = (id) => rawSourceFor(uk(), id);

/** Nothing outside this file ever sees a stored password: `passwordSet` is all
 *  a UI needs and all it gets. */
function publicView(s) {
  const { password, ...rest } = s;
  return { ...rest, passwordSet: !!password };
}

export function listSourcesFor(uKey) { return rawSourcesFor(uKey).map(publicView); }
export const listSources = () => listSourcesFor(uk());

/** A password stored before the encryption key changed can no longer be read.
 *  Reported as "not set" — the user re-enters it — rather than throwing out of
 *  every listing, which is how accounts.js and oauth.js treat the same case. */
export function passwordOf(source) {
  if (!source?.password) return '';
  try { return decrypt(source.password); } catch { return ''; }
}

function saveAllFor(uKey, list) { writeJson(configFileFor(uKey), list); return list; }

/**
 * Calendars survive an edit unless the caller sends a replacement list, and even
 * then only the USER-OWNED fields are taken from it.
 *
 * The sync state — ctag, syncToken, lastSyncAt — comes from the stored record
 * and never from the request. A Settings page loaded ten minutes ago would
 * otherwise carry a stale token back and either re-download the whole calendar
 * or, far worse, skip forward past changes that will then never be seen again.
 * Exactly the same guard contactSources.js#mergeBooks applies, for the same
 * reason and with the same consequences if it is removed.
 */
function mergeCalendars(existing, incoming) {
  if (!Array.isArray(incoming)) return existing;
  const byId = new Map(existing.map((c) => [c.id, c]));
  const byHref = new Map(existing.map((c) => [c.href, c]));
  return incoming.map((c, i) => {
    const prev = byId.get(c.id) || byHref.get(c.href) || null;
    return {
      id: prev?.id || (c.id && /^[0-9a-f-]{36}$/i.test(c.id) ? c.id : crypto.randomUUID()),
      href: c.href ?? prev?.href ?? '',
      url: c.url ?? prev?.url ?? '',
      displayName: String(c.displayName ?? prev?.displayName ?? '').trim(),
      // A colour the USER picked wins over everything, including the server's
      // own on the next discovery — which is the whole point of colorLocked.
      // Without it, choosing a colour here lasted exactly until the next time
      // the source's calendar list was re-read and Google said "#9a9cff" again.
      // Otherwise: the server's own colour if it published one, else a stable
      // pick from the palette — stable because it is indexed by position, so a
      // calendar does not change colour every time the list is re-read.
      colorLocked: c.colorLocked === undefined ? !!prev?.colorLocked : !!c.colorLocked,
      color: (prev?.colorLocked && prev.color)
        || c.color || prev?.color || CALENDAR_COLORS[i % CALENDAR_COLORS.length],
      readOnly: c.readOnly === undefined ? (prev?.readOnly ?? true) : !!c.readOnly,
      // Whether it is SYNCED at all. A work server routinely shares a dozen
      // calendars nobody wants; syncing them all by default would be slow and
      // useless in equal measure.
      enabled: c.enabled === undefined ? (prev?.enabled ?? false) : !!c.enabled,
      // Whether it is currently DRAWN. Separate from `enabled` on purpose:
      // hiding a calendar for an afternoon should not throw away its sync state
      // and re-download it when it comes back.
      visible: c.visible === undefined ? (prev?.visible ?? true) : !!c.visible,
      // null  — follow each event's own VALARM, and stay silent when it has none
      // -1    — never remind from this calendar, VALARMs included
      // <n>   — remind n minutes before an event that carries no VALARM of its own
      //
      // An event's own alarm always wins over a number here: somebody who set a
      // reminder on one meeting meant that meeting, and a calendar-wide default
      // overriding it would be the app arguing with them.
      defaultReminder: c.defaultReminder === undefined
        ? (prev?.defaultReminder ?? null)
        : (c.defaultReminder === null ? null : Number(c.defaultReminder)),
      // Whether reminders from this calendar respect the mail notification
      // schedule. OFF by default, and that is the considered answer rather than
      // an oversight: a 07:00 meeting reminder is wanted even by somebody whose
      // mail stays quiet until 08:00. The two are different kinds of
      // interruption, and conflating them silently loses meetings.
      followQuietHours: c.followQuietHours === undefined ? (prev?.followQuietHours ?? false) : !!c.followQuietHours,
      // Sync state: stored record only.
      ctag: prev?.ctag || '',
      syncToken: prev?.syncToken || '',
      lastSyncAt: prev?.lastSyncAt || 0,
      lastError: prev?.lastError || '',
      count: prev?.count || 0,
    };
  });
}

export function saveSource(input, existingId = null) {
  const uKey = uk();
  const list = rawSourcesFor(uKey);
  const kind = String(input.kind || 'caldav');
  if (!SOURCE_KINDS[kind]) throw Object.assign(new Error(`Unknown calendar source type: ${kind}`), { status: 400 });

  const existing = existingId ? list.find((s) => s.id === assertId(existingId)) : null;
  if (existingId && !existing) throw Object.assign(new Error('No such calendar source'), { status: 404 });

  const rec = {
    id: existing?.id || crypto.randomUUID(),
    kind,
    label: String(input.label || '').trim() || SOURCE_KINDS[kind].label,
    url: kind === 'caldav' ? String(input.url || existing?.url || '').trim() : '',
    username: kind === 'caldav' ? String(input.username ?? existing?.username ?? '').trim() : '',
    password: input.password ? encrypt(String(input.password)) : (existing?.password || ''),
    accountId: SOURCE_KINDS[kind].credentials === 'account'
      ? String(input.accountId || existing?.accountId || '')
      : '',
    enabled: input.enabled === undefined ? (existing?.enabled ?? true) : !!input.enabled,
    principalUrl: input.principalUrl ?? existing?.principalUrl ?? '',
    homeUrl: input.homeUrl ?? existing?.homeUrl ?? '',
    calendars: mergeCalendars(existing?.calendars || [], input.calendars),
    createdAt: existing?.createdAt || Date.now(),
    lastSyncAt: existing?.lastSyncAt || 0,
    lastError: existing?.lastError || '',
  };

  if (kind === 'caldav' && !rec.url) throw Object.assign(new Error('A CalDAV source needs a server address'), { status: 400 });
  if (SOURCE_KINDS[kind].credentials === 'account' && !rec.accountId) {
    throw Object.assign(new Error('This source type needs a mail account to sign in with'), { status: 400 });
  }
  // A local source IS its calendar — there is nothing to discover, so one is
  // created with it rather than waiting for a discovery step that will never
  // come.
  if (kind === 'local' && !rec.calendars.length) {
    rec.calendars = mergeCalendars([], [{
      displayName: rec.label, href: `local:${rec.id}`, url: `local:${rec.id}`,
      readOnly: false, enabled: true, visible: true,
    }]);
  }

  saveAllFor(uKey, existing ? list.map((s) => (s.id === rec.id ? rec : s)) : [...list, rec]);
  return publicView(rec);
}

/**
 * Appends a calendar that has just been created on the server (see
 * calendar/index.js#createCalendarFor) to its source's list.
 *
 * Switched on and visible: somebody who has just made a calendar wants to put
 * something in it, and having to go and tick it afterwards would be a step with
 * no decision in it. That is the opposite of the default for a DISCOVERED
 * calendar, which is off — see mergeCalendars — because a work server routinely
 * shares a dozen nobody asked for.
 *
 * @returns the stored calendar record, id and all.
 */
export function addCalendarFor(uKey, sourceId, collection) {
  const list = rawSourcesFor(uKey);
  const src = list.find((s) => s.id === sourceId);
  if (!src) throw Object.assign(new Error('No such calendar source'), { status: 404 });
  src.calendars = src.calendars || [];
  // Through mergeCalendars like everything else, so a new calendar cannot end
  // up with a different shape from a discovered one — the palette fallback, the
  // id, and every default all come from one place.
  const merged = mergeCalendars(src.calendars, [
    ...src.calendars,
    { ...collection, enabled: true, visible: true, readOnly: collection.readOnly === true },
  ]);
  src.calendars = merged;
  saveAllFor(uKey, list);
  return merged[merged.length - 1];
}

/**
 * A colour of the user's own for one calendar, or back to the automatic one.
 *
 * Its own function rather than a plain updateSyncStateFor patch, because
 * CLEARING has to restore a real colour rather than leave an empty string: every
 * reader here assumes a calendar has one (the sidebar swatch, the event grid,
 * mergeCalendars' own fallback), and blanking it is how a calendar ends up drawn
 * in the generic accent colour with no way back short of a re-discovery.
 *
 * `color` empty means "follow the server again": the palette pick for this
 * calendar's position, which is exactly what mergeCalendars would have given it,
 * and which the next discovery replaces with the server's own if it publishes
 * one.
 *
 * @returns the stored calendar record.
 */
export function setCalendarColorFor(uKey, sourceId, calendarId, color) {
  const list = rawSourcesFor(uKey);
  const src = list.find((s) => s.id === sourceId);
  const i = (src?.calendars || []).findIndex((c) => c.id === calendarId);
  if (!src || i < 0) throw Object.assign(new Error('No such calendar'), { status: 404 });
  const cal = src.calendars[i];
  if (color) {
    cal.color = color;
    cal.colorLocked = true;
  } else {
    cal.color = CALENDAR_COLORS[i % CALENDAR_COLORS.length];
    cal.colorLocked = false;
  }
  saveAllFor(uKey, list);
  return cal;
}

/** Sync state, written by the runner — which is the only thing allowed to touch
 *  these fields, which is why it is not part of saveSource. */
export function updateSyncStateFor(uKey, sourceId, calendarId, patch) {
  const list = rawSourcesFor(uKey);
  const src = list.find((s) => s.id === sourceId);
  if (!src) return null;
  if (calendarId) {
    const cal = (src.calendars || []).find((c) => c.id === calendarId);
    if (cal) Object.assign(cal, patch);
  } else {
    Object.assign(src, patch);
  }
  saveAllFor(uKey, list);
  return src;
}

export function deleteSource(id) {
  const uKey = uk();
  const list = rawSourcesFor(uKey);
  const sid = assertId(id);
  if (!list.some((s) => s.id === sid)) throw Object.assign(new Error('No such calendar source'), { status: 404 });
  const gone = list.find((s) => s.id === sid);
  saveAllFor(uKey, list.filter((s) => s.id !== sid));
  try { cache.deleteCalendarSource(uKey, sid); }
  catch (e) { clog.warn(`Could not clear cached events for source ${sid}: ${e.message}`); }
  // A synced source's events are a mirror of somebody else's server, so removing
  // them loses nothing. A LOCAL calendar's are the only copy there is — so the
  // files go too, but only because deleting the calendar is an explicit,
  // confirmed act. Nothing else in this file may touch them.
  if (gone?.kind === 'local') {
    for (const cal of gone.calendars || []) {
      try { fs.rmSync(path.join(userDirFor(uKey), 'calendars', cal.id), { recursive: true, force: true }); }
      catch (e) { clog.warn(`Could not remove local calendar ${cal.id}: ${e.message}`); }
    }
  }
  return true;
}

/* ---------------- per-event colours ---------------- */
//
//   users/<viewerKey>/calendar-event-colors.json   { "<calendarId>:<uid>": "#hex" }
//
// A colour set on an event is stored HERE and never sent to the provider, and
// that is a correction rather than a shortcut. The first version wrote RFC
// 7986's COLOR property into the iCalendar document, which is the standard
// answer and works on a CalDAV server that stores what it is given. Google does
// not: its CalDAV endpoint parses an event into Google's own model and
// re-serialises it, and anything not in that model is dropped on the way
// through. Measured, not assumed — an event saved with COLOR:#9e9e9e came back
// minutes later as Google's own document, RRULE intact, COLOR gone. Microsoft
// and Exchange never had it at all, since neither stores iCalendar.
//
// So the property that only ever mattered to Hmelj is kept by Hmelj. That also
// makes it work uniformly across every backend, which the document-based
// version could not: there is no longer a class of calendar where the colour
// picker has to be hidden because the server would silently swallow it.
//
// Keyed by (calendar, uid) — the SERIES, not the occurrence. Colouring one
// Tuesday of a weekly series differently is not what this is for; "paper is
// blue" is a property of the series.

const colorKey = (calendarId, uid) => `${calendarId}:${uid}`;

export function eventColorsFor(uKey) {
  return readJson(path.join(userDirFor(uKey), 'calendar-event-colors.json'), {});
}

/** `color` empty removes the entry rather than storing '', so the file does not
 *  accumulate a row for every event whose colour was set and then cleared. */
export function setEventColorFor(uKey, calendarId, uid, color) {
  const file = path.join(userDirFor(uKey), 'calendar-event-colors.json');
  const all = readJson(file, {});
  const key = colorKey(calendarId, uid);
  if (color) all[key] = color; else delete all[key];
  writeJson(file, all);
  return all;
}

/** Drops an event's colour — called when the event itself is deleted, so the
 *  file does not grow a permanent entry for something that no longer exists. */
export function forgetEventColorFor(uKey, calendarId, uid) {
  return setEventColorFor(uKey, calendarId, uid, '');
}

/* ---------------- local calendars ---------------- */
//
//   users/<viewerKey>/calendars/<calendarId>/<uid>.ics
//
// One file per event, exactly as server/scheduledSend.js stores a queued
// message, and for the two reasons its header gives: a payload rewrite must not
// touch its neighbours, and a partial write can then only ever damage one item.
//
// In DATA_DIR rather than in cache.sqlite because these are the one part of the
// calendar that is NOT a cache — nothing else has a copy. The cache still holds
// a parsed row for each of them so the window query is uniform across every
// source, but that row is derived and is rebuilt from these files.

function localDirFor(uKey, calendarId) {
  const dir = path.join(userDirFor(uKey), 'calendars', assertId(calendarId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A UID is minted by Hmelj but arrives back as a route parameter, so the path
 *  it builds is built from user input whoever minted it. Percent-encoded rather
 *  than validated against a pattern: a UID is opaque and may legitimately
 *  contain a slash, which a pattern would either reject (losing a real event) or
 *  let through (escaping the directory). */
const localFileFor = (uKey, calendarId, uid) =>
  path.join(localDirFor(uKey, calendarId), encodeURIComponent(String(uid)).replace(/\*/g, '%2A') + '.ics');

export function readLocalEvent(uKey, calendarId, uid) {
  try { return fs.readFileSync(localFileFor(uKey, calendarId, uid), 'utf8'); } catch { return null; }
}

export function writeLocalEvent(uKey, calendarId, uid, ical) {
  const file = localFileFor(uKey, calendarId, uid);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, ical);
  fs.renameSync(tmp, file);
  return true;
}

export function deleteLocalEvent(uKey, calendarId, uid) {
  try { fs.unlinkSync(localFileFor(uKey, calendarId, uid)); return true; } catch { return false; }
}

/** Every stored event in a local calendar, as `{uid, ical}`. The backend's
 *  whole read path — a local calendar is small enough that "all of it" is the
 *  right granularity, and there is no server to ask what changed. */
export function listLocalEvents(uKey, calendarId) {
  let names;
  try { names = fs.readdirSync(localDirFor(uKey, calendarId)); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.ics')) continue;
    const ical = readLocalEventFile(path.join(localDirFor(uKey, calendarId), name));
    if (ical) out.push({ uid: decodeURIComponent(name.slice(0, -4)), ical, file: name });
  }
  return out;
}

function readLocalEventFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * Every calendar across every source, flattened, with its source's identity
 * folded in — which is what both the sidebar and the event query want, and
 * neither wants to do the join itself.
 */
export function listCalendarsFor(uKey) {
  const out = [];
  for (const src of rawSourcesFor(uKey)) {
    for (const cal of src.calendars || []) {
      out.push({
        id: cal.id,
        sourceId: src.id,
        sourceLabel: src.label,
        sourceKind: src.kind,
        sourceEnabled: src.enabled !== false,
        // The MAIL account this calendar signs in through, where there is one —
        // an Exchange, Microsoft or Google source is attached to an account, a
        // CalDAV or local one is not. This is what lets "remind me about this
        // message" put the reminder in the calendar belonging to the account the
        // message arrived in, instead of whichever calendar happens to sort
        // first (see addSnoozeReminderEvent in server/index.js).
        accountId: src.accountId || null,
        displayName: cal.displayName,
        color: cal.color,
        // Whether that colour is the user's own choice rather than the server's
        // — what lets the UI offer to hand it back (see the PATCH route).
        colorLocked: !!cal.colorLocked,
        readOnly: cal.readOnly !== false,
        // Whether this SOURCE KIND can be written to at all, separately from
        // whether the server marked this collection read-only. The UI needs
        // both: a Microsoft calendar is writable on the server and read-only in
        // Hmelj, and offering an Edit button that will be refused is worse than
        // not offering one.
        writable: SOURCE_KINDS[src.kind]?.writable === true,
        // Whether a new calendar can be created in this source — see
        // SOURCE_KINDS for the one that says no and why.
        canCreate: SOURCE_KINDS[src.kind]?.canCreate === true,
        enabled: !!cal.enabled,
        visible: cal.visible !== false,
        defaultReminder: cal.defaultReminder ?? null,
        followQuietHours: !!cal.followQuietHours,
        count: cal.count || 0,
        lastSyncAt: cal.lastSyncAt || 0,
        lastError: cal.lastError || src.lastError || '',
      });
    }
  }
  return out;
}
export const listCalendars = () => listCalendarsFor(uk());

/** The calendars whose events should actually be DRAWN right now: synced, shown,
 *  and belonging to a source that is switched on. The one place that decision is
 *  made, so the sidebar and the event query cannot disagree about it. */
export function visibleCalendarIdsFor(uKey) {
  return listCalendarsFor(uKey)
    .filter((c) => c.sourceEnabled && c.enabled && c.visible)
    .map((c) => c.id);
}

/** Which source and calendar a calendar id belongs to. */
export function resolveCalendarFor(uKey, calendarId) {
  for (const src of rawSourcesFor(uKey)) {
    const cal = (src.calendars || []).find((c) => c.id === calendarId);
    if (cal) return { source: src, calendar: cal };
  }
  return null;
}
export const resolveCalendar = (calendarId) => resolveCalendarFor(uk(), calendarId);
