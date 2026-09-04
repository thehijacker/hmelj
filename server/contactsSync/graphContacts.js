// Hmelj — the Microsoft 365 contact backend.
//
// Graph is the one provider here with a genuinely good incremental story:
// `/me/contacts/delta` answers "what changed" in one request, deletions
// included, which is the same shape CardDAV's sync-collection gives and the
// reason both feel instant on a five-minute poll.
//
// There is only ever ONE book. Graph exposes contact FOLDERS
// (`/me/contactFolders`), but `/me/contacts` is the default folder and is where
// every Outlook client puts things by default; offering a folder picker for a
// feature almost nobody uses would mean a second delta token per folder and a
// listing step on every discovery, for no gain. If that ever needs to change,
// it changes here and nowhere else.
//
// Every function runs inside the mail account's ALS context — the dispatcher
// puts it there with runAsAccount, the same way server/sync.js does for the mail
// poller — which is what makes graphClient.js's currentAccount() resolve.
import * as graph from '../graphClient.js';
import { cardFromProvider, fromGraphContact, graphFieldsFromCard } from './providerCard.js';
import { serializeCard, parseCard } from '../vcard.js';

export const writable = true;
export const kind = 'graph';

/** The single default contact folder. Shaped like a DAV collection so the
 *  dispatcher and the storage layer do not need a second code path — `href` is
 *  the stable key, and for Graph that is a constant. */
export async function discoverBooks(ctx) {
  return {
    principalUrl: '',
    homeUrl: '',
    collections: [{
      href: 'graph:/me/contacts',
      url: 'graph:/me/contacts',
      displayName: ctx.source.label || 'Microsoft 365 contacts',
      readOnly: false,
    }],
  };
}

/**
 * A delta, converted into the same `{changed, removed, full}` shape the CardDAV
 * backend returns.
 *
 * `syncToken` holds Graph's `@odata.deltaLink` — an opaque URL, not a token in
 * any format worth inspecting. It is stored in the same field CardDAV's sync
 * token uses because it plays exactly the same role, and nothing above this
 * layer should have to know which provider produced it.
 */
export async function syncBook(ctx, book, { force = false } = {}) {
  const res = await graph.listContactsDelta(force ? '' : (book.syncToken || ''));
  const changed = res.changed.map((c) => {
    const card = cardFromProvider(fromGraphContact(c));
    return {
      // The contact's own id is the href: stable, opaque, and the thing every
      // later write is addressed to.
      href: `graph:${c.id}`,
      url: `graph:${c.id}`,
      // Graph does not return @odata.etag on delta pages, and a contact's
      // lastModifiedDateTime is not in the delta select either. An empty ETag
      // means the next write goes out unconditionally — acceptable here and
      // nowhere else, because Graph's PATCH is partial: the worst case is that
      // two edits to the SAME field race, not that a whole contact is replaced.
      etag: String(c['@odata.etag'] || ''),
      vcard: serializeCard(card),
    };
  });
  return {
    changed,
    removed: res.removed.map((id) => `graph:${id}`),
    ctag: '',
    syncToken: res.token,
    full: res.full,
    unchanged: !changed.length && !res.removed.length,
    failed: 0,
  };
}

export async function createCard(ctx, book, { vcard }) {
  const created = await graph.createContact(graphFieldsFromCard(parseCard(vcard)));
  return { url: `graph:${created.id}`, href: `graph:${created.id}`, etag: String(created['@odata.etag'] || '') };
}

export async function updateCard(ctx, book, { href, etag }, vcard) {
  const id = idOf(href);
  const updated = await graph.updateContact(id, graphFieldsFromCard(parseCard(vcard)), etag);
  return { url: `graph:${id}`, href: `graph:${id}`, etag: String(updated?.['@odata.etag'] || etag || '') };
}

export async function deleteCard(ctx, book, { href, etag }) {
  await graph.deleteContact(idOf(href), etag);
  return true;
}

/** The Graph item id out of the `graph:<id>` href this backend stores. A Graph
 *  id contains base64url characters including `-` and `_` but never a colon, so
 *  the first one is always the separator. */
function idOf(href) {
  const s = String(href || '');
  return s.startsWith('graph:') ? s.slice('graph:'.length) : s;
}
