// Hmelj — the Exchange (EWS) contact backend.
//
// Read-only, and that is a decision rather than a gap. EWS can create and
// update contacts (CreateItem/UpdateItem with a SetItemField per property), but
// every write needs the item's current ChangeKey, an UpdateItem carries a
// separate SetItemField element per changed property, and getting the
// ConflictResolution mode wrong silently overwrites rather than failing. That is
// a meaningful amount of protocol to get right for the one provider here whose
// users overwhelmingly also have Outlook open. Pulling is the part that makes
// the address book useful; pushing can follow when there is a reason.
//
// ── No delta, and what stands in for one ─────────────────────────────────────
// EWS has SyncFolderItems, which is a genuine delta. It is not used here for the
// same reason: it needs its own sync-state blob, its own change-type handling,
// and its own recovery when the state is rejected. What this does instead is the
// ETag comparison server/dav/sync.js already falls back to for CardDAV servers
// without sync-collection — list every contact with its ChangeKey (which IS an
// ETag: it changes whenever the item does) and compare. One listing per poll,
// no bodies re-read, and deletions fall out of the comparison.
//
// Runs inside the mail account's ALS context, put there by the dispatcher —
// that is what makes ewsClient.js's currentAccount() resolve.
import * as ews from '../ewsClient.js';
import { cardFromProvider, fromEwsContact } from './providerCard.js';
import { serializeCard } from '../vcard.js';

export const writable = false;
export const kind = 'ews';

export async function discoverBooks(ctx) {
  return {
    principalUrl: '',
    homeUrl: '',
    collections: [{
      href: 'ews:contacts',
      url: 'ews:contacts',
      displayName: ctx.source.label || 'Exchange contacts',
      // Not a property of this collection on the server — a statement about
      // this backend. Surfaced the same way a genuinely read-only DAV
      // collection is, so the UI needs no special case for it.
      readOnly: true,
    }],
  };
}

/**
 * Every contact, compared against what we hold.
 *
 * Reports `full: false` even though it read the whole folder — see the same
 * note in server/dav/sync.js's ETag-diff branch. `full` means "`changed` is
 * every item that exists"; here `changed` holds only what differs and `removed`
 * is computed directly, so it is already authoritative about deletions.
 */
export async function syncBook(ctx, book, { known = new Map() } = {}) {
  const items = await ews.listContactItems();
  const changed = [];
  const seen = new Set();

  for (const it of items) {
    const href = `ews:${it.id}`;
    seen.add(href);
    // The ChangeKey is Exchange's ETag. Unchanged means the item is
    // byte-for-byte what we already stored, so there is nothing to rebuild.
    if (known.get(href) === it.changeKey && it.changeKey) continue;
    changed.push({
      href,
      url: href,
      etag: it.changeKey || '',
      vcard: serializeCard(cardFromProvider(fromEwsContact(it))),
    });
  }

  const removed = [...known.keys()].filter((href) => href.startsWith('ews:') && !seen.has(href));
  return {
    changed, removed, ctag: '', syncToken: '',
    full: false, unchanged: !changed.length && !removed.length, failed: 0,
  };
}

const readOnly = () => {
  throw Object.assign(
    new Error('Exchange contacts are read-only in Hmelj — change them in Outlook and the next sync will pick it up.'),
    { status: 400 },
  );
};

export const createCard = readOnly;
export const updateCard = readOnly;
export const deleteCard = readOnly;
