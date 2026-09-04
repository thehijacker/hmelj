// Hmelj — the Google Contacts backend.
//
// Almost nothing here, and that is the point: Google speaks CardDAV. Every
// function below delegates to ./carddav.js, and the only differences are the
// two the dispatcher has already handled by the time this is reached — the
// credential is a Bearer token rather than a password, and the collection URL is
// fixed rather than discovered from what a user typed.
//
// ── Why CardDAV and not the People API ───────────────────────────────────────
// The People API is Google's own, better-documented interface, and using it
// would mean a third structured-contact translation (see ./providerCard.js) plus
// its own pagination, its own sync-token semantics and its own field masks.
// CardDAV gets the same data through code that already exists and is already
// tested against three other servers. The People API would only become the right
// answer if Google's CardDAV endpoint were retired.
//
// ── The one Google-specific fact ─────────────────────────────────────────────
// Google's CardDAV does not implement `sync-collection` on the default list. The
// fallback in server/dav/sync.js — compare ETags from a Depth:1 PROPFIND — is
// what actually runs here, and it is why this backend costs one listing per poll
// where Microsoft costs one delta. Correct either way; just worth knowing before
// wondering where the sync token went.
import * as carddav from './carddav.js';

export const writable = true;
export const kind = 'google';

/** Google's fixed CardDAV collection for an account. Built from the signed-in
 *  address rather than discovered: `.well-known` works too, but it costs two
 *  extra round trips to arrive at a URL that is documented and constant. */
export function baseUrlFor(email) {
  const who = encodeURIComponent(String(email || '').trim());
  if (!who) throw Object.assign(new Error('This Google account has no address to sync contacts for'), { status: 400 });
  return `https://www.googleapis.com/carddav/v1/principals/${who}/lists/default/`;
}

export async function discoverBooks(ctx) {
  const found = await carddav.discoverBooks(ctx);
  // Google answers the collection PROPFIND with no displayname, which would
  // leave the book called "default" in Settings.
  return {
    ...found,
    collections: found.collections.map((c) => ({
      ...c,
      displayName: c.displayName && c.displayName !== 'default' ? c.displayName : (ctx.source.label || 'Google Contacts'),
    })),
  };
}

export const syncBook = carddav.syncBook;
export const createCard = carddav.createCard;
export const updateCard = carddav.updateCard;
export const deleteCard = carddav.deleteCard;
