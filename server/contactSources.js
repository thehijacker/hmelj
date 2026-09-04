// Hmelj — where synced address books live, and the config that describes them.
//
// ── Why synced contacts are NOT in contacts.json ─────────────────────────────
// `contacts.json` is the address book the user typed by hand, plus what
// server/contacts.js added on their behalf. It is the only copy of that data
// anywhere. A sync engine writing into the same file would mean a bug in the
// sync engine — a mis-parsed delta, a collection that came back empty because
// the server was mid-restart — could delete contacts that exist nowhere else.
//
// So synced books live beside it, one file per book, and the two are merged
// only on the way OUT (see `allRows`). Removing a source deletes its directory
// and nothing else; a sync that goes wrong can only ever damage the copy that
// can be re-downloaded.
//
// ── Layout ───────────────────────────────────────────────────────────────────
//   users/<viewerKey>/contact-sources.json        the sources and their books
//   users/<viewerKey>/addressbooks/<srcId>/<bookId>.json   one book's cards
//
// viewerKey, not userKey — same reasoning as store.js's `userDir()`: an address
// book is a property of the PERSON, and must never follow requireAuth's
// shared-mail-account ownership swap.
//
// ── Storage shape, and why the raw vCard is kept ─────────────────────────────
// A book file holds `cards`, keyed by the item's href on the server. Each card
// keeps its raw vCard text. That is what makes a write-back non-destructive
// (see server/vcard.js's header): Hmelj edits three properties and puts the
// other forty back exactly as they arrived. Storing only the parsed
// `{name, email}` would mean every edit silently deleted somebody's phone
// number and postal address.
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { currentUser } from './session.js';
import { encrypt, decrypt } from './accounts.js';
import { parseCard, cardToRows, cardName, cardUid, cardEmails } from './vcard.js';
import { log } from './log.js';

const clog = log.scope('contact-sources');

/** The kinds a source can be. `credentials` says where the sign-in comes from:
 *  'own' means this source carries its own username/password, 'account' means it
 *  borrows a mail account's OAuth token and cannot be used without one. */
export const SOURCE_KINDS = {
  carddav: { label: 'CardDAV', credentials: 'own', writable: true },
  google: { label: 'Google Contacts', credentials: 'account', writable: true },
  graph: { label: 'Microsoft 365', credentials: 'account', writable: true },
  ews: { label: 'Exchange', credentials: 'account', writable: false },
};

/* ---------------- paths ---------------- */

function userDirFor(uKey) {
  const dir = path.join(config.dataDir, 'users', uKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const configFileFor = (uKey) => path.join(userDirFor(uKey), 'contact-sources.json');

/**
 * Ids are minted here and never taken from a request — but they arrive back as
 * route parameters, so every path built from one is built from user input
 * regardless of who minted it. Validated as its own step rather than inside the
 * read, whose catch would turn a rejected id into an indistinguishable "not
 * found" and hide a probe. Same reasoning, and the same shape, as
 * scheduledSend.js#assertId.
 */
export function assertId(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw Object.assign(new Error('Bad id'), { status: 400 });
  return String(id);
}

function bookDirFor(uKey, sourceId) {
  const dir = path.join(userDirFor(uKey), 'addressbooks', assertId(sourceId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const bookFileFor = (uKey, sourceId, bookId) => path.join(bookDirFor(uKey, sourceId), assertId(bookId) + '.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return structuredClone(fallback); }
}

/** Written through a temp file and renamed, like store.js — a half-written book
 *  file after a crash mid-sync would otherwise be an address book that will not
 *  load, and the rename is the only step that is atomic. */
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/* ---------------- sources ---------------- */

const uk = () => currentUser().viewerKey;

/** Every source, with the password stripped. Nothing outside this file ever
 *  sees a stored password: `passwordSet` is all a UI needs, and all it gets. */
export function listSourcesFor(uKey) {
  return readJson(configFileFor(uKey), []).map(publicView);
}
export const listSources = () => listSourcesFor(uk());

/** The stored record, password included — for the sync engine only. */
export function rawSourceFor(uKey, id) {
  return readJson(configFileFor(uKey), []).find((s) => s.id === assertId(id)) || null;
}
export const rawSource = (id) => rawSourceFor(uk(), id);

export function rawSourcesFor(uKey) {
  return readJson(configFileFor(uKey), []);
}

function publicView(s) {
  const { password, ...rest } = s;
  return { ...rest, passwordSet: !!password };
}

/** The decrypted password for a source, or ''. A password stored before the
 *  encryption key changed can no longer be read; that is reported as "not set"
 *  (the user re-enters it) rather than throwing out of every listing, which is
 *  how accounts.js and oauth.js already treat the same situation. */
export function passwordOf(source) {
  if (!source?.password) return '';
  try { return decrypt(source.password); } catch { return ''; }
}

function saveAllFor(uKey, list) {
  writeJson(configFileFor(uKey), list);
  return list;
}

/**
 * Creates or updates a source.
 *
 * The password is only replaced when one was actually supplied — an edit that
 * changes the label must not blank the credentials, and the UI never has the
 * stored password to send back.
 */
export function saveSource(input, existingId = null) {
  const uKey = uk();
  const list = rawSourcesFor(uKey);
  const kind = String(input.kind || 'carddav');
  if (!SOURCE_KINDS[kind]) throw Object.assign(new Error(`Unknown contact source type: ${kind}`), { status: 400 });

  const existing = existingId ? list.find((s) => s.id === assertId(existingId)) : null;
  if (existingId && !existing) throw Object.assign(new Error('No such contact source'), { status: 404 });

  const rec = {
    id: existing?.id || crypto.randomUUID(),
    kind,
    label: String(input.label || '').trim() || SOURCE_KINDS[kind].label,
    // CardDAV only.
    url: kind === 'carddav' ? String(input.url || existing?.url || '').trim() : '',
    username: kind === 'carddav' ? String(input.username ?? existing?.username ?? '').trim() : '',
    password: input.password ? encrypt(String(input.password)) : (existing?.password || ''),
    // Provider-backed only: which mail account's sign-in this borrows.
    accountId: SOURCE_KINDS[kind].credentials === 'account'
      ? String(input.accountId || existing?.accountId || '')
      : '',
    // 'pull' never writes to the server; 'two-way' does. Default pull, because
    // the safe direction is the one that cannot damage somebody else's data,
    // and a user who wants writes has said so.
    //
    // Three cases, not two: absent means "leave it as it was" (a save that only
    // renames the source), and anything present is taken literally. Collapsing
    // the last two — `input.direction === 'two-way' ? … : existing.direction` —
    // reads fine and can never turn write-back OFF again, which is the setting
    // somebody reaches for precisely when they want it to stop.
    direction: input.direction === undefined
      ? (existing?.direction || 'pull')
      : (input.direction === 'two-way' ? 'two-way' : 'pull'),
    enabled: input.enabled === undefined ? (existing?.enabled ?? true) : !!input.enabled,
    principalUrl: input.principalUrl ?? existing?.principalUrl ?? '',
    homeUrl: input.homeUrl ?? existing?.homeUrl ?? '',
    books: mergeBooks(existing?.books || [], input.books),
    createdAt: existing?.createdAt || Date.now(),
    lastSyncAt: existing?.lastSyncAt || 0,
    lastError: existing?.lastError || '',
  };

  if (kind === 'carddav' && !rec.url) throw Object.assign(new Error('A CardDAV source needs a server address'), { status: 400 });
  if (SOURCE_KINDS[kind].credentials === 'account' && !rec.accountId) {
    throw Object.assign(new Error('This source type needs a mail account to sign in with'), { status: 400 });
  }

  const next = existing ? list.map((s) => (s.id === rec.id ? rec : s)) : [...list, rec];
  saveAllFor(uKey, next);
  return publicView(rec);
}

/**
 * Books survive an edit unless the caller sent a replacement list.
 *
 * When it does, only the USER-OWNED fields are taken from it (enabled, colour,
 * label) — never the sync state. A Settings save that carried `ctag` back from
 * a page loaded ten minutes ago would otherwise roll the collection's sync
 * position backwards and re-download everything, or worse, forwards and skip
 * changes permanently.
 */
function mergeBooks(existing, incoming) {
  if (!Array.isArray(incoming)) return existing;
  const byId = new Map(existing.map((b) => [b.id, b]));
  const byHref = new Map(existing.map((b) => [b.href, b]));
  return incoming.map((b) => {
    const prev = byId.get(b.id) || byHref.get(b.href) || null;
    return {
      id: prev?.id || (b.id && /^[0-9a-f-]{36}$/i.test(b.id) ? b.id : crypto.randomUUID()),
      href: b.href ?? prev?.href ?? '',
      url: b.url ?? prev?.url ?? '',
      displayName: String(b.displayName ?? prev?.displayName ?? '').trim(),
      readOnly: b.readOnly === undefined ? (prev?.readOnly ?? false) : !!b.readOnly,
      enabled: b.enabled === undefined ? (prev?.enabled ?? true) : !!b.enabled,
      // Sync state: from the stored record only, never from the request.
      ctag: prev?.ctag || '',
      syncToken: prev?.syncToken || '',
      lastSyncAt: prev?.lastSyncAt || 0,
      lastError: prev?.lastError || '',
      count: prev?.count || 0,
    };
  });
}

/** Sync state written by the runner, which is the only thing allowed to touch
 *  these fields. Kept apart from saveSource for exactly that reason. */
export function updateSyncStateFor(uKey, sourceId, bookId, patch) {
  const list = rawSourcesFor(uKey);
  const src = list.find((s) => s.id === sourceId);
  if (!src) return null;
  if (bookId) {
    const book = (src.books || []).find((b) => b.id === bookId);
    if (book) Object.assign(book, patch);
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
  if (!list.some((s) => s.id === sid)) throw Object.assign(new Error('No such contact source'), { status: 404 });
  saveAllFor(uKey, list.filter((s) => s.id !== sid));
  // Its contacts go with it. They are a mirror of somebody else's server by
  // definition, so there is nothing here that removing the source could lose —
  // which is exactly why they were never allowed into contacts.json.
  try { fs.rmSync(path.join(userDirFor(uKey), 'addressbooks', sid), { recursive: true, force: true }); }
  catch (e) { clog.warn(`Could not remove the stored contacts for source ${sid}: ${e.message}`); }
  return true;
}

/* ---------------- book contents ---------------- */

const EMPTY_BOOK = { cards: {} };

export function readBookFor(uKey, sourceId, bookId) {
  return readJson(bookFileFor(uKey, sourceId, bookId), EMPTY_BOOK);
}
export function writeBookFor(uKey, sourceId, bookId, data) {
  writeJson(bookFileFor(uKey, sourceId, bookId), data);
  return data;
}

/**
 * One stored card, from its raw vCard.
 *
 * The parsed name and addresses are stored ALONGSIDE the raw text rather than
 * derived on every read: the address-book picker asks for every contact on
 * every keystroke, and re-parsing several thousand vCards at 60Hz is not
 * something to do for a field that changes once a week. The raw text stays
 * authoritative — anything written back is built from it, never from these.
 */
export function cardEntry(vcard, { href, etag, url }) {
  const parsed = parseCard(vcard);
  return {
    href,
    url: url || '',
    etag: etag || '',
    uid: parsed ? cardUid(parsed) : '',
    name: parsed ? cardName(parsed) : '',
    emails: parsed ? cardEmails(parsed).map((e) => ({ email: e.email, types: e.types })) : [],
    vcard,
  };
}

/**
 * Every synced contact, as the `{id, name, email}` rows the rest of Hmelj
 * speaks — one per address, not one per card (see vcard.js#cardToRows).
 *
 * The `id` is composite and opaque: `<sourceId>~<bookId>~<uid>~<addressIndex>`.
 * Composite because a row has to be mapped back to a card on a server to be
 * edited or deleted, and opaque because nothing outside this file should ever
 * take it apart — `parseRowId` below is the only reader.
 */
export function allRowsFor(uKey) {
  const out = [];
  for (const src of rawSourcesFor(uKey)) {
    if (src.enabled === false) continue;
    for (const book of src.books || []) {
      if (!book.enabled) continue;
      const stored = readBookFor(uKey, src.id, book.id);
      for (const card of Object.values(stored.cards || {})) {
        const readOnly = !!book.readOnly || src.direction !== 'two-way';
        card.emails?.forEach((e, i) => {
          out.push({
            id: `${src.id}~${book.id}~${card.uid || card.href}~${i}`,
            name: card.name || '',
            email: e.email,
            emailTypes: e.types || [],
            sourceId: src.id,
            sourceLabel: src.label,
            bookId: book.id,
            bookName: book.displayName,
            readOnly,
            synced: true,
          });
        });
      }
    }
  }
  return out;
}
export const allRows = () => allRowsFor(uk());

/** The only place a composite row id is taken apart. `uid` may itself contain
 *  `~`, so the split is bounded from both ends rather than a plain `split`. */
export function parseRowId(id) {
  const s = String(id || '');
  const first = s.indexOf('~');
  const second = s.indexOf('~', first + 1);
  const last = s.lastIndexOf('~');
  if (first < 0 || second < 0 || last <= second) return null;
  return {
    sourceId: s.slice(0, first),
    bookId: s.slice(first + 1, second),
    uid: s.slice(second + 1, last),
    emailIndex: Number(s.slice(last + 1)) || 0,
  };
}

/** The stored card a row points at, plus the source and book it came from. */
export function resolveRowFor(uKey, rowId) {
  const parts = parseRowId(rowId);
  if (!parts) return null;
  const src = rawSourceFor(uKey, parts.sourceId);
  const book = src?.books?.find((b) => b.id === parts.bookId);
  if (!src || !book) return null;
  const stored = readBookFor(uKey, src.id, book.id);
  const card = Object.values(stored.cards || {})
    .find((c) => c.uid === parts.uid || c.href === parts.uid);
  return card ? { source: src, book, card, stored, emailIndex: parts.emailIndex } : null;
}
export const resolveRow = (rowId) => resolveRowFor(uk(), rowId);

/** How many contacts each enabled book holds — for the Settings summary, which
 *  should not have to load every book to show a number. */
export function countsFor(uKey) {
  const out = {};
  for (const src of rawSourcesFor(uKey)) {
    for (const book of src.books || []) out[book.id] = book.count || 0;
  }
  return out;
}
