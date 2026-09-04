// Hmelj — the CardDAV contact backend.
//
// Thin, because everything hard is already done: server/dav/* knows how to talk
// to a DAV server and how to work out what changed, and server/vcard.js knows
// how to read and write a card without destroying the parts Hmelj does not
// model. What is left here is the join between them, plus the two decisions
// that are specific to contacts.
//
// ── Decision 1: where a new card goes ────────────────────────────────────────
// RFC 6352 leaves the item's URL entirely to the client. `<collection>/<uid>.vcf`
// is what every other client does, and it has one property worth having: the URL
// is a pure function of the UID, so a card created here and a card created for
// the same person on a phone collide on the server (409/412) instead of
// silently becoming two contacts. UIDs are minted here, so that only happens
// when the same card is genuinely being re-created.
//
// ── Decision 2: conflicts are reported, never resolved by overwriting ────────
// Every write is conditional — `If-Match` on the ETag we read, `If-None-Match: *`
// on a create. A 412 means somebody else got there first. That is surfaced to
// the caller as a conflict rather than retried without the condition, because
// the unconditional retry IS the bug: it is how a contact edited on a phone
// thirty seconds ago gets silently replaced by what a stale browser tab held.
import { syncCollection, fetchItems } from '../dav/sync.js';
import { discover } from '../dav/discover.js';
import { log } from '../log.js';

const clog = log.scope('carddav');

export const writable = true;
export const kind = 'carddav';

/** Everything this account can see. `ctx.client` is built by the dispatcher —
 *  Basic for a plain CardDAV server, Bearer for Google, and nothing else here
 *  needs to know which. */
export async function discoverBooks(ctx) {
  const url = ctx.baseUrl || ctx.source.url;
  const found = await discover(ctx.client, { url, kind: 'carddav' });
  return {
    principalUrl: found.principalUrl,
    homeUrl: found.homeUrl,
    collections: found.collections.map((c) => ({
      href: c.href,
      url: c.url,
      displayName: c.displayName,
      readOnly: c.readOnly,
    })),
  };
}

/**
 * What changed in one book since last time, bodies included.
 *
 * `known` is the caller's href → ETag view, needed only when the server has no
 * sync-collection support. Returns `full: true` when what came back is the
 * whole collection rather than a delta — the caller must then treat anything it
 * holds and did not see as deleted, which is the only safe reading of a
 * from-scratch listing.
 */
export async function syncBook(ctx, book, { known = new Map(), force = false } = {}) {
  const url = book.url || ctx.source.homeUrl;
  const state = await syncCollection(ctx.client, {
    url, kind: 'carddav', syncToken: book.syncToken, ctag: book.ctag, known, force,
  });

  if (state.unchanged && !state.changed.length) {
    return { changed: [], removed: state.removed, ctag: state.ctag, syncToken: state.syncToken, full: false, unchanged: true };
  }

  const { items, failed } = await fetchItems(ctx.client, url, 'carddav', state.changed.map((c) => c.href));
  if (failed) clog.warn(`${book.displayName || url}: ${failed} card(s) could not be fetched — they are left as they were`);

  return {
    changed: items.map((i) => ({ href: i.href, url: i.url, etag: i.etag, vcard: i.data })),
    removed: state.removed,
    ctag: state.ctag,
    syncToken: state.syncToken,
    full: state.full,
    unchanged: false,
    failed,
  };
}

/** Where a card with this UID lives inside a collection. */
export function hrefFor(book, uid) {
  const base = String(book.url || '').replace(/\/+$/, '');
  // Percent-encoded: a UID is opaque and may legitimately contain a slash or a
  // space, both of which would otherwise change which resource is addressed.
  return `${base}/${encodeURIComponent(uid)}.vcf`;
}

export async function createCard(ctx, book, { uid, vcard }) {
  const url = hrefFor(book, uid);
  // If-None-Match: * — "only if it does not exist". A UID collision then comes
  // back as a 412 instead of overwriting whatever was already there.
  const res = await ctx.client.put(url, vcard, { etag: null, contentType: 'text/vcard; charset=utf-8' });
  return { url, href: pathOf(url), etag: res.etag };
}

export async function updateCard(ctx, book, { url, etag }, vcard) {
  const res = await ctx.client.put(url, vcard, { etag: etag || undefined, contentType: 'text/vcard; charset=utf-8' });
  return { url, href: pathOf(url), etag: res.etag };
}

export async function deleteCard(ctx, book, { url, etag }) {
  await ctx.client.del(url, { etag: etag || undefined });
  return true;
}

/**
 * The path a server would send back for this URL.
 *
 * Stored cards are keyed by href-as-sent, and a PUT is made to a full URL — so
 * after a write the two have to be reconciled, or the next sync sees the card
 * as new and stores a second copy of it.
 */
function pathOf(url) {
  try { return new URL(url).pathname; } catch { return url; }
}

/** A server that answered a PUT without an ETag has left us unable to make the
 *  next write conditional. Re-reading is one request and restores that, which
 *  is much better than falling back to unconditional writes for the life of the
 *  card. */
export async function etagAfterWrite(ctx, url, etag) {
  if (etag) return etag;
  try { return (await ctx.client.get(url)).etag; } catch { return ''; }
}
