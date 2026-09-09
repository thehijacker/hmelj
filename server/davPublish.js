// Hmelj — which collections Hmelj publishes for other clients to subscribe to.
//
//   users/<viewerKey>/dav-published.json
//
// ── Two shapes, and the difference is the whole feature ─────────────────────
//
//   'single'     One calendar or address book, published as itself. A Hmelj
//                calendar published this way is READ-WRITE over DAV; anything
//                mirrored from somebody else's server is read-only, because
//                Hmelj is not that server and a write here would be lost on the
//                next sync.
//
//   'aggregate'  Several, merged into one collection — the "joined calendar".
//                Always read-only, and not as a limitation: there is no honest
//                answer to which source a PUT into a merged collection belongs
//                to, so the collection advertises no write privileges rather
//                than accepting a write it would then have to guess about.
//
// ── "Partly joined" ─────────────────────────────────────────────────────────
// Each source inside an aggregate contributes at one of two detail levels:
//
//   'full'   the event as it is
//   'busy'   the time only. The summary becomes "Busy" and the location,
//            description, attendees and organizer are dropped.
//
// That is what makes a shared household calendar workable: your partner sees
// that Thursday afternoon is taken without seeing who you are seeing. The
// masking happens at serialization time (see server/davServer.js) and never
// touches what is stored, so switching a source back to 'full' needs no
// re-fetch.
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { currentUser } from './session.js';
import * as calendarStore from './calendarStore.js';
import * as contactSources from './contactSources.js';

/** What a published collection holds. */
export const KINDS = ['calendar', 'addressbook'];
/** How much of a source is exposed — see "Partly joined" above. */
export const DETAILS = ['full', 'busy'];

function userDirFor(uKey) {
  const dir = path.join(config.dataDir, 'users', uKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const fileFor = (uKey) => path.join(userDirFor(uKey), 'dav-published.json');

export function assertId(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw Object.assign(new Error('Bad id'), { status: 400 });
  return String(id);
}

function load(uKey) {
  try { return JSON.parse(fs.readFileSync(fileFor(uKey), 'utf8')); } catch { return []; }
}

function save(uKey, list) {
  const file = fileFor(uKey);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
  return list;
}

const uk = () => currentUser().viewerKey;

export const listFor = (uKey) => load(uKey);
export const list = () => listFor(uk());

export function getFor(uKey, id) {
  return load(uKey).find((p) => p.id === assertId(id)) || null;
}

/**
 * A published collection is READ-WRITE only when every condition holds: it is a
 * single (not aggregate) publication, of a LOCAL calendar, at full detail.
 *
 * Checked here rather than trusted from the record, so a hand-edited config
 * file cannot make a mirror of somebody else's server writable — the write
 * would appear to succeed and be silently discarded by the next sync.
 */
/** A publication's colour: what was asked for, else the source calendar's own,
 *  else the app accent. */
function colorFor(uKey, input, existing, kind, mode, sources) {
  if (/^#[0-9a-f]{6}$/i.test(input.color || '')) return input.color.toLowerCase();
  if (existing?.color) return existing.color;
  if (kind === 'calendar' && mode === 'single' && sources[0]?.calendarId) {
    const found = calendarStore.resolveCalendarFor(uKey, sources[0].calendarId);
    const c = found?.calendar?.color;
    if (/^#[0-9a-f]{6}$/i.test(c || '')) return c.toLowerCase();
  }
  return '#0b57d0';
}

export function isWritable(uKey, pub) {
  if (pub.kind !== 'calendar' || pub.mode !== 'single') return false;
  const src = pub.sources?.[0];
  if (!src || src.detail !== 'full') return false;
  const found = calendarStore.resolveCalendarFor(uKey, src.calendarId);
  return found?.source?.kind === 'local';
}

export function save_(uKey, list_) { return save(uKey, list_); }

export function upsert(input, existingId = null) {
  const uKey = uk();
  const all = load(uKey);
  const kind = KINDS.includes(input.kind) ? input.kind : 'calendar';
  const existing = existingId ? all.find((p) => p.id === assertId(existingId)) : null;
  if (existingId && !existing) throw Object.assign(new Error('No such published collection'), { status: 404 });

  const sources = (Array.isArray(input.sources) ? input.sources : [])
    .map((s) => ({
      calendarId: kind === 'calendar' ? String(s.calendarId || s.id || '') : '',
      bookId: kind === 'addressbook' ? String(s.bookId || s.id || '') : '',
      sourceId: String(s.sourceId || ''),
      detail: DETAILS.includes(s.detail) ? s.detail : 'full',
    }))
    .filter((s) => s.calendarId || s.bookId || s.sourceId === 'local-contacts');

  if (!sources.length) throw Object.assign(new Error('A published collection needs at least one source'), { status: 400 });

  const mode = sources.length > 1 || input.mode === 'aggregate' ? 'aggregate' : 'single';
  const rec = {
    id: existing?.id || crypto.randomUUID(),
    kind,
    mode,
    label: String(input.label || '').trim().slice(0, 80) || (kind === 'calendar' ? 'Calendar' : 'Contacts'),
    // The colour subscribers see (advertised as CalDAV's calendar-color — see
    // davServer.js). Given one, use it. Otherwise inherit from the calendar
    // being shared, which is what makes a shared "Družinski" arrive looking
    // like Družinski: this used to fall straight through to the app accent, so
    // every published collection reached the other side the same shade of blue
    // however carefully its source had been coloured. Only for a single
    // calendar — a merge of several has no one colour to inherit.
    color: colorFor(uKey, input, existing, kind, mode, sources),
    sources,
    createdAt: existing?.createdAt || Date.now(),
  };
  save(uKey, existing ? all.map((p) => (p.id === rec.id ? rec : p)) : [...all, rec]);
  return rec;
}

export function remove(id) {
  const uKey = uk();
  const all = load(uKey);
  const pid = assertId(id);
  if (!all.some((p) => p.id === pid)) throw Object.assign(new Error('No such published collection'), { status: 404 });
  save(uKey, all.filter((p) => p.id !== pid));
  return true;
}

/**
 * Everything that COULD be published, for the picker — and only things that
 * exist: a publication naming a calendar that has since been deleted would
 * serve an empty collection with no explanation.
 */
export function publishableFor(uKey) {
  return {
    calendars: calendarStore.listCalendarsFor(uKey)
      .filter((c) => c.sourceEnabled && c.enabled)
      .map((c) => ({ id: c.id, label: c.displayName, source: c.sourceLabel, local: c.sourceKind === 'local' })),
    addressbooks: [
      // The hand-typed address book is not a "source" anywhere else in Hmelj —
      // it is contacts.json — so it is named explicitly here rather than being
      // absent from the one place somebody would look for it.
      { id: 'local-contacts', label: 'My contacts', source: 'Hmelj', local: true },
      ...contactSources.listSourcesFor(uKey).flatMap((s) =>
        (s.books || []).filter((b) => b.enabled)
          .map((b) => ({ id: b.id, label: b.displayName, source: s.label, sourceId: s.id, local: false }))),
    ],
  };
}
export const publishable = () => publishableFor(uk());

/** The sources of a publication that still resolve to something real. */
export function resolveSourcesFor(uKey, pub) {
  if (pub.kind === 'calendar') {
    return pub.sources
      .map((s) => ({ ...s, calendar: calendarStore.resolveCalendarFor(uKey, s.calendarId) }))
      .filter((s) => s.calendar);
  }
  return pub.sources.filter((s) => s.sourceId === 'local-contacts' || s.bookId);
}
