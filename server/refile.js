// Hmelj — moving a message to Junk or Archive, and putting it back where it
// came from.
//
// "Mark as spam" and "Archive" are ordinary folder moves; what makes them worth
// a module of their own is the way BACK. Marking something not-spam has to
// return it to the folder it was marked from, and after a move that message has
// a new uid in a different folder — so the only way to answer "where was this?"
// later is to write it down at the time.
//
// Hence a small ledger: the uid a message landed under in Junk/Archive, and the
// folder it left. Kept per person (store.js#getRefileOrigins), pruned by age and
// capped, and treated as a nicety rather than a source of truth — a message that
// is not in it (it arrived in Junk from the server's own filter, the entry aged
// out, someone else filed it) goes back to the Inbox, which is where an
// unrecognised "not spam" belongs anyway.
//
// No imports, no I/O: same reasoning as searchQuery.js, threading.js and
// unsubscribe.js — the parts worth being sure about are the pruning and the
// grouping, and both are pure (see test/refile-test.mjs).

/** Where an unremembered message goes when it comes back. Every backend uses
 *  this exact spelling for the inbox (see ewsClient.js/graphClient.js's
 *  WELL_KNOWN_PATH — 'INBOX', not 'Inbox'). */
export const HOME_FALLBACK = 'INBOX';

/** Which per-account folder setting each box means. */
export const BOX_FOLDER = { junk: 'junkFolder', archive: 'archiveFolder' };

export function isBox(box) {
  return Object.prototype.hasOwnProperty.call(BOX_FOLDER, box);
}

// A uid is only meaningful inside one folder of one account, so all three make
// the key. A NUL separator for the same reason cache.js uses one: a folder path
// may legally contain almost every other character.
const SEP = '\u0000';
export function originKey(accountId, folder, uid) {
  return `${accountId || ''}${SEP}${folder}${SEP}${uid}`;
}

const DAY = 24 * 60 * 60 * 1000;
/** How long a "put it back" memory is worth keeping, and how many. Both are
 *  generous: an entry is ~60 bytes, and the ledger is read once per refile. */
export const MAX_AGE_MS = 180 * DAY;
export const MAX_ENTRIES = 4000;

/**
 * Records where each message came from, and prunes the ledger while it is open.
 *
 * `entries` is [{ accountId, folder, uid, from }] — `folder`/`uid` being where
 * the message now IS (the destination), `from` where it was. Returns a NEW
 * object; the caller saves it.
 *
 * Pruning here rather than on a timer: this is the only thing that ever grows
 * the ledger, so it is the only place that needs to keep it bounded.
 */
export function noteOrigins(ledger, entries, { now = Date.now(), maxAgeMs = MAX_AGE_MS, cap = MAX_ENTRIES } = {}) {
  const next = { ...(ledger || {}) };
  for (const e of entries || []) {
    if (!e || e.uid === undefined || e.uid === null || !e.folder || !e.from) continue;
    next[originKey(e.accountId, e.folder, e.uid)] = { to: e.from, at: now };
  }
  const cutoff = now - maxAgeMs;
  const live = Object.entries(next).filter(([, v]) => typeof v?.at === 'number' && v.at >= cutoff && v.to);
  // Oldest first out when over the cap — the newest memories are the ones most
  // likely to be wanted, since "not spam" almost always follows the mistake.
  const kept = live.length > cap ? live.sort((a, b) => b[1].at - a[1].at).slice(0, cap) : live;
  return Object.fromEntries(kept);
}

/** Where this message was before it was filed, or null if nothing was written down. */
export function recallOrigin(ledger, accountId, folder, uid) {
  return (ledger || {})[originKey(accountId, folder, uid)]?.to || null;
}

/** Drops entries by key — used once a message has been moved back, so a uid
 *  the server reuses later can never resolve to a stale answer. */
export function dropOrigins(ledger, keys) {
  const next = { ...(ledger || {}) };
  for (const k of keys || []) delete next[k];
  return next;
}

/**
 * Groups the messages being sent back by where each of them goes.
 *
 * A selection can perfectly well hold messages that came from three different
 * folders, so this returns one move per destination rather than pretending
 * there is a single target. Order is stable (first uid's destination first) so
 * the answer is predictable to test and to read in a log.
 *
 * `resolve(uid)` returns the remembered folder or null; null means the fallback.
 */
export function planReturn(uids, resolve, fallback = HOME_FALLBACK) {
  const groups = new Map();
  for (const uid of uids || []) {
    const target = resolve(uid) || fallback;
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push(uid);
  }
  return [...groups].map(([target, list]) => ({ target, uids: list }));
}
