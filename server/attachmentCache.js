// Hmelj — a bounded, in-memory cache of already-extracted attachment bytes.
//
// Reading one attachment is not the small operation it looks like. Every
// backend answers the same way (imapClient/ewsClient/graphClient all end in
// `parseAttachment(await getMessageSource(...), index)`): pull the message's
// ENTIRE raw source — base64-encoded, so roughly 1.33x the size of everything
// hanging off it — and run the whole thing through mailparser to pick out one
// part. A message with three attachments cost three of those, and the second
// and third bought nothing new.
//
// What makes caching them safe is that they cannot change: for a given
// (account, folder, uid, index) there is no other version of that attachment,
// ever. The same fact is what lets server/index.js hand the browser a strong
// ETag and a long max-age, so the far bigger win — never asking this server at
// all — happens one layer up.
//
// Memory only, and deliberately: attachment bytes are the one thing
// server/cache.js keeps OUT of SQLite (see its schema comment), and nothing
// here changes that. A bounded LRU that dies with the process cannot quietly
// grow into a second copy of a mail archive on disk.

/**
 * A least-recently-used map bounded by TOTAL BYTES as well as entry count.
 *
 * Bytes, not entries, because the whole point is holding attachments: 64 slots
 * of thumbnail is nothing and 64 slots of video is a gigabyte, and only one of
 * those two numbers describes the risk.
 *
 * Insertion order in a Map is its LRU order — a hit deletes and re-inserts, so
 * the oldest key is always the first one iteration yields.
 */
export function createByteLru({ maxBytes = 32 * 1024 * 1024, maxEntries = 64 } = {}) {
  const map = new Map(); // key -> { value, bytes }
  let bytes = 0;

  function evictWhileOver() {
    for (const key of map.keys()) {
      if (bytes <= maxBytes && map.size <= maxEntries) break;
      bytes -= map.get(key).bytes;
      map.delete(key);
    }
  }

  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      map.delete(key);      // re-inserting moves it to the young end
      map.set(key, hit);
      return hit.value;
    },
    /** Stores `value`, or declines to. Returns whether it was kept. */
    set(key, value, size) {
      const n = Number(size) || 0;
      const existing = map.get(key);
      if (existing) { bytes -= existing.bytes; map.delete(key); }
      // One item bigger than the whole budget would evict everything else to
      // store something that then gets evicted itself on the next insert. It
      // is not a cache entry worth having — refuse it and leave the rest warm.
      if (n <= 0 || n > maxBytes) { evictWhileOver(); return false; }
      map.set(key, { value, bytes: n });
      bytes += n;
      evictWhileOver();
      return map.has(key);
    },
    delete(key) {
      const hit = map.get(key);
      if (!hit) return false;
      bytes -= hit.bytes;
      return map.delete(key);
    },
    clear() { map.clear(); bytes = 0; },
    stats() { return { entries: map.size, bytes, maxBytes, maxEntries }; },
  };
}

const SEP = '\u0000';

/** Cache key for one attachment. `kind` separates the two routes that read
 *  attachment bytes: `/attachment/:index` by position, `/cid/:cid` by the
 *  Content-ID an HTML body refers to. */
export function attachmentKey(userKey, accountId, folder, uid, ref, kind = 'idx') {
  return [kind, userKey || '', accountId || '', folder || '', String(uid), String(ref)].join(SEP);
}

/**
 * A strong HTTP validator for those bytes.
 *
 * Strong, not weak, and with no timestamp in it: the resource is immutable, so
 * the honest ETag is a pure function of WHICH attachment this is plus its
 * length. It only has to differ between different resources, and the length
 * catches the one case the key alone would not — a uid reused by a server
 * after an expunge, where a browser would otherwise serve the old bytes.
 *
 * FNV-1a, because reaching for crypto to name a cache entry would be theatre.
 */
export function etagFor(key, size) {
  let h = 0x811c9dc5;
  const s = key + SEP + size;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `"${(h >>> 0).toString(36)}-${Number(size) || 0}"`;
}

/** Does the client already hold exactly these bytes? RFC 9110 §13.1.2: a
 *  comma-separated list, and `*` means "any representation I might have". */
export function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) return false;
  return String(ifNoneMatch).split(',').some((t) => {
    const tag = t.trim().replace(/^W\//, '');
    return tag === '*' || tag === etag;
  });
}
