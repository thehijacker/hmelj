// Hmelj — contact-sync protocol dispatch, and the merge rules that go with it.
//
// Modelled on server/mailClient.js: every caller outside this directory imports
// from HERE, and this is the only file that knows there is more than one kind of
// contact source. Each backend exports the identical set of names with identical
// signatures by design — see ./carddav.js, which is the reference shape.
//
// ── What this file adds on top of dispatch ───────────────────────────────────
// Two things the backends must not each decide for themselves:
//
//   1. CREDENTIALS. A CardDAV source carries its own password; Google, Graph and
//      EWS borrow a mail account's OAuth sign-in. Building that (and running
//      provider backends inside the account's ALS context, the way
//      server/sync.js does for mail) belongs in one place.
//
//   2. WHAT A SYNC RESULT MEANS FOR STORED DATA. `full: true` says "this is the
//      whole collection", and only then may anything we hold and did not see be
//      deleted. Getting that wrong in one backend would quietly empty an address
//      book, so the rule is applied here, once, for all of them.
import { createClient, basicAuth, bearerAuth } from '../dav/client.js';
import * as carddav from './carddav.js';
import * as googleContacts from './googleContacts.js';
import * as graphContacts from './graphContacts.js';
import * as ewsContacts from './ewsContacts.js';
import * as sources from '../contactSources.js';
import * as accounts from '../accounts.js';
import * as oauth from '../oauth.js';
import { runAsAccount, listUsers, userKey } from '../session.js';
import { log } from '../log.js';

const clog = log.scope('contact-sync');

const BACKENDS = {
  carddav,
  google: googleContacts,
  graph: graphContacts,
  ews: ewsContacts,
};

/** Backends that talk DAV and therefore need an HTTP client built for them.
 *  Graph and EWS bring their own transports (graphClient.js, ewsClient.js). */
const DAV_KINDS = new Set(['carddav', 'google']);

/** Backends that reach their server through a client which reads the account
 *  off the ALS context, and so must be run inside runAsAccount. */
const ALS_KINDS = new Set(['graph', 'ews']);

export function backendFor(kind) {
  const b = BACKENDS[kind];
  if (!b) throw Object.assign(new Error(`Unknown contact source type: ${kind}`), { status: 400 });
  return b;
}

/**
 * Everything a backend call needs: the source record, a DAV client where one
 * applies, and the base URL to work from.
 *
 * `uKey` is passed explicitly rather than read from ALS, because the background
 * runner calls this outside any request — the same reason store.js keeps
 * explicit-userKey variants of everything (see its `loadFor`/`saveFor` comment).
 */
async function buildContext(uKey, source) {
  const ctx = { uKey, source, client: null, baseUrl: source.url || '' };
  if (!DAV_KINDS.has(source.kind)) return ctx;

  if (source.kind === 'carddav') {
    const password = sources.passwordOf(source);
    if (!source.username || !password) {
      throw Object.assign(new Error(`${source.label}: no username or password stored — open Settings → Contacts and enter them again.`), { status: 400 });
    }
    ctx.client = createClient({ auth: basicAuth(source.username, password) });
    return ctx;
  }

  // Google: the credential is the mail account's OAuth token.
  const acc = accounts.getAccount(source.accountId);
  if (!acc) throw Object.assign(new Error(`${source.label}: the mail account it signs in with is gone`), { status: 400 });
  ctx.account = acc;
  ctx.baseUrl = googleContacts.baseUrlFor(acc.email);
  ctx.client = createClient({
    // Fetched per request, not once: a token that expires mid-sync is then
    // picked up on the next call rather than failing every remaining one.
    auth: bearerAuth(() => oauth.accessTokenFor(acc, uKey)),
    // A 401 that survives the token cache means the cached token died early.
    // One forced refresh, then the retry — a second 401 is real.
    reauth: async () => { try { await oauth.refresh(acc, uKey); return true; } catch { return false; } },
  });
  return ctx;
}

/**
 * Runs `fn` in whatever context this source's backend needs.
 *
 * Graph and EWS reach their servers through graphClient.js/ewsClient.js, which
 * read the account off the ALS context (`currentAccount()`) rather than taking
 * it as an argument — so those two, and only those two, have to run inside
 * runAsAccount. Exactly what server/sync.js does for the mail poller.
 *
 * Google is account-backed too but does NOT need this: it talks DAV, and its
 * bearer token is built from the account record directly in buildContext.
 */
async function withSource(uKey, source, fn) {
  const ctx = await buildContext(uKey, source);
  if (!ALS_KINDS.has(source.kind)) return fn(ctx);
  const user = listUsers().find((u) => userKey(u.username) === uKey);
  if (!user) throw Object.assign(new Error('Could not resolve the Hmelj user for this contact source'), { status: 500 });
  return runAsAccount(user, source.accountId, () => fn(ctx));
}

/* ---------------- discovery ---------------- */

/**
 * What this source can see, WITHOUT saving anything.
 *
 * Its own step because the alternative — save, then discover, then let the user
 * pick — leaves a broken source behind every time a password is mistyped, and
 * that is the common case when adding one.
 */
export async function discoverFor(uKey, source) {
  return withSource(uKey, source, (ctx) => backendFor(source.kind).discoverBooks(ctx));
}

/* ---------------- syncing ---------------- */

/**
 * One book, brought up to date.
 *
 * Returns `{added, updated, removed, unchanged, total}` — counts, not contacts,
 * because every caller wants to report what happened and none of them wants the
 * cards.
 */
export async function syncBookFor(uKey, source, book, { force = false } = {}) {
  const stored = sources.readBookFor(uKey, source.id, book.id);
  const cards = stored.cards || {};
  const known = new Map(Object.entries(cards).map(([href, c]) => [href, c.etag || '']));

  const result = await withSource(uKey, source,
    (ctx) => backendFor(source.kind).syncBook(ctx, { ...book, url: book.url || ctx.baseUrl }, { known, force }));

  if (result.unchanged && !result.changed.length && !result.removed.length) {
    sources.updateSyncStateFor(uKey, source.id, book.id, {
      ctag: result.ctag || book.ctag, syncToken: result.syncToken || book.syncToken,
      lastSyncAt: Date.now(), lastError: '',
    });
    return { added: 0, updated: 0, removed: 0, unchanged: true, total: Object.keys(cards).length };
  }

  let added = 0, updated = 0;
  for (const item of result.changed) {
    if (cards[item.href]) updated++; else added++;
    cards[item.href] = sources.cardEntry(item.vcard, { href: item.href, url: item.url, etag: item.etag });
  }

  let removed = 0;
  for (const href of result.removed) {
    if (cards[href]) { delete cards[href]; removed++; }
  }

  // The rule this file exists to enforce, and the one place it is applied.
  //
  // `full: true` has exactly one meaning across every backend: `changed` holds
  // EVERY item that currently exists in the collection. Only then does "we hold
  // it and it was not in `changed`" mean it was deleted on the other side.
  //
  // A delta says nothing at all about the items it did not mention, and a
  // backend that computes `removed` itself (the ETag-diff path, EWS) has
  // already reported the deletions above — both report `full: false`, and
  // sweeping on either would empty the book on the first quiet poll.
  if (result.full) {
    const seen = new Set(result.changed.map((c) => c.href));
    for (const href of Object.keys(cards)) {
      if (!seen.has(href)) { delete cards[href]; removed++; }
    }
  }

  sources.writeBookFor(uKey, source.id, book.id, { ...stored, cards });
  sources.updateSyncStateFor(uKey, source.id, book.id, {
    ctag: result.ctag || '', syncToken: result.syncToken || '',
    lastSyncAt: Date.now(), lastError: '', count: Object.keys(cards).length,
  });

  if (added || updated || removed) {
    clog.info(`${source.label} / ${book.displayName}: +${added} ~${updated} -${removed} (${Object.keys(cards).length} total)`);
  }
  return { added, updated, removed, unchanged: false, total: Object.keys(cards).length };
}

/** Every enabled book of one source. Failures are per-book: one collection the
 *  server will not serve must not stop the other three. */
export async function syncSourceFor(uKey, sourceId, { force = false } = {}) {
  const source = sources.rawSourceFor(uKey, sourceId);
  if (!source) throw Object.assign(new Error('No such contact source'), { status: 404 });
  if (source.enabled === false) return { skipped: true, books: [] };

  const out = [];
  let lastError = '';
  for (const book of source.books || []) {
    if (!book.enabled) continue;
    try {
      out.push({ bookId: book.id, displayName: book.displayName, ...await syncBookFor(uKey, source, book, { force }) });
    } catch (e) {
      lastError = e.message;
      clog.warn(`${source.label} / ${book.displayName}: ${e.message}`);
      sources.updateSyncStateFor(uKey, source.id, book.id, { lastError: e.message, lastSyncAt: Date.now() });
      out.push({ bookId: book.id, displayName: book.displayName, error: e.message });
    }
  }
  sources.updateSyncStateFor(uKey, source.id, null, { lastSyncAt: Date.now(), lastError });
  return { skipped: false, books: out };
}

/* ---------------- writing ---------------- */

/** Can this source be written to at all? Both halves have to agree: the backend
 *  must support writing, the collection must not be read-only on the server, and
 *  the user must have asked for two-way sync. */
export function canWrite(source, book) {
  return backendFor(source.kind).writable === true
    && source.direction === 'two-way'
    && !book?.readOnly;
}

function assertWritable(source, book) {
  if (canWrite(source, book)) return;
  const why = backendFor(source.kind).writable !== true
    ? `${source.label} is read-only in Hmelj`
    : book?.readOnly
      ? `${book.displayName} is read-only on the server`
      : `${source.label} is set to one-way sync — change it to two-way in Settings → Contacts to edit from here`;
  throw Object.assign(new Error(why), { status: 400 });
}

export async function createCardFor(uKey, source, book, { uid, vcard }) {
  assertWritable(source, book);
  const res = await withSource(uKey, source,
    (ctx) => backendFor(source.kind).createCard(ctx, { ...book, url: book.url || ctx.baseUrl }, { uid, vcard }));
  storeCard(uKey, source, book, vcard, res);
  return res;
}

export async function updateCardFor(uKey, source, book, target, vcard) {
  assertWritable(source, book);
  const res = await withSource(uKey, source,
    (ctx) => backendFor(source.kind).updateCard(ctx, { ...book, url: book.url || ctx.baseUrl }, target, vcard));
  // The stored copy is keyed by the href we already hold; a write that came back
  // under a different one (a server that relocated the item) has to replace the
  // old entry rather than sit beside it as a duplicate.
  if (res.href && res.href !== target.href) removeStored(uKey, source, book, target.href);
  storeCard(uKey, source, book, vcard, res);
  return res;
}

export async function deleteCardFor(uKey, source, book, target) {
  assertWritable(source, book);
  await withSource(uKey, source,
    (ctx) => backendFor(source.kind).deleteCard(ctx, { ...book, url: book.url || ctx.baseUrl }, target));
  removeStored(uKey, source, book, target.href);
  return true;
}

/**
 * The local mirror, updated to match what was just written.
 *
 * Without this the contact reverts on screen the moment anything re-reads the
 * stored book, and stays reverted until the next poll — which is the single most
 * common "my edit didn't save" report against every sync client ever written.
 */
function storeCard(uKey, source, book, vcard, { href, url, etag }) {
  const stored = sources.readBookFor(uKey, source.id, book.id);
  stored.cards = stored.cards || {};
  stored.cards[href] = sources.cardEntry(vcard, { href, url, etag });
  sources.writeBookFor(uKey, source.id, book.id, stored);
  sources.updateSyncStateFor(uKey, source.id, book.id, { count: Object.keys(stored.cards).length });
}

function removeStored(uKey, source, book, href) {
  const stored = sources.readBookFor(uKey, source.id, book.id);
  if (!stored.cards?.[href]) return;
  delete stored.cards[href];
  sources.writeBookFor(uKey, source.id, book.id, stored);
  sources.updateSyncStateFor(uKey, source.id, book.id, { count: Object.keys(stored.cards).length });
}
