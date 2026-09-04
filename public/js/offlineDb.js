// Hmelj — the offline store's storage layer: IndexedDB, and nothing else.
//
// Why IndexedDB and not the service worker's Cache Storage, which would have
// been the obvious home for cached /api/* responses: the Android shell usually
// points at a plain-http LAN address (see MainActivity#showOfflinePage's own
// note). That is not a secure context, so there is NO service worker there at
// all — an SW-based cache would work in the browser and be silently absent on
// the device most likely to be offline in the first place. IndexedDB works over
// plain http, so the cache lives in the page and the SW keeps doing exactly one
// job: the app shell.
//
// Everything here is deliberately un-opinionated about mail. Policy — what is
// worth caching, when to prefetch, how a queued action is replayed — lives in
// offline.js and outbox.js. This file only knows how to put bytes somewhere and
// get them back, how big they are, and how to throw them all away.
//
// Every entry point resolves rather than rejects. A browser in private mode, a
// profile with storage disabled, a quota that is already full: all of them
// answer null/false and the app behaves exactly as it did before offline mode
// existed. Nothing in Hmelj may fail because a CACHE failed.
const OfflineDb = (() => {
  const DB_NAME = 'hmelj-offline';
  // Bump only for a real schema change — onupgradeneeded creates what is
  // missing, so adding a store is a version bump and nothing else.
  const DB_VERSION = 1;

  // kv        — whole small JSON responses, keyed by request URL
  // lists     — /api/messages and /api/unified responses, keyed by request URL
  // envelopes — one row per message ever seen in a list; powers offline search
  //             and the local list builder
  // bodies    — the /api/message payload, cid: images already inlined
  // bodyIndex — {date, bytes} for each body, so eviction and the storage figure
  //             never have to deserialize the bodies themselves
  // outbox    — queued writes (see outbox.js)
  // meta      — bookkeeping: which user this database belongs to, prefetch state
  const STORES = ['kv', 'lists', 'envelopes', 'bodies', 'bodyIndex', 'outbox', 'meta'];

  let dbPromise = null;
  let unavailable = false; // one failed open is enough; stop trying every call

  /** Composite keys. NUL, like messageViewKey() in app.js and for the same
   * reason: a folder path or a URL can contain any printable separator. */
  function k(...parts) { return parts.map((p) => String(p ?? '')).join('\u0000'); }

  function open() {
    if (unavailable) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch { unavailable = true; return resolve(null); }
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of STORES) {
          if (db.objectStoreNames.contains(name)) continue;
          if (name === 'outbox') {
            // The only store with generated keys: a queued action has no
            // natural id, and FIFO replay wants monotonic ones.
            db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
          } else {
            const s = db.createObjectStore(name, { keyPath: 'key' });
            // The one index worth its write cost: eviction asks bodyIndex for
            // "the oldest message" and nothing else. Envelopes are sliced by
            // key prefix instead (the key IS user\0account\0folder\0uid, so a
            // folder or an account is a plain key range) and sorted in memory
            // — a mailbox's worth of envelopes is a few thousand short records.
            if (name === 'bodyIndex') s.createIndex('date', 'date');
          }
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab ran a version upgrade (or called wipe()); let it, and
        // fall back to "no cache" here rather than holding the upgrade open
        // forever, which would hang that tab instead of this one.
        db.onversionchange = () => { try { db.close(); } catch {} dbPromise = null; unavailable = true; };
        resolve(db);
      };
      req.onerror = () => { unavailable = true; resolve(null); };
      req.onblocked = () => { unavailable = true; resolve(null); };
    });
    return dbPromise;
  }

  /** One transaction, wrapped so a rejection never escapes. `fn` gets the
   * transaction and returns an IDBRequest (or an array of them, or a value);
   * the promise resolves with the last request's result once the WHOLE
   * transaction commits — not when the request fires, which is the difference
   * between "written" and "about to be written" if the tab closes in between. */
  function tx(names, mode, fn) {
    return open().then((db) => {
      if (!db) return null;
      return new Promise((resolve) => {
        let t;
        try { t = db.transaction(names, mode); }
        catch { return resolve(null); }
        let out = null;
        t.oncomplete = () => resolve(out);
        t.onerror = () => resolve(null);
        t.onabort = () => resolve(null);
        try {
          const r = fn(t);
          if (r && typeof r.onsuccess !== 'undefined') r.onsuccess = () => { out = r.result; };
          else out = r;
        } catch {
          try { t.abort(); } catch {}
          resolve(null);
        }
      });
    }).catch(() => null);
  }

  /* ---------- generic record access ---------- */

  function get(store, key) {
    return tx([store], 'readonly', (t) => t.objectStore(store).get(key));
  }

  function put(store, value) {
    return tx([store], 'readwrite', (t) => t.objectStore(store).put(value));
  }

  function del(store, key) {
    return tx([store], 'readwrite', (t) => t.objectStore(store).delete(key));
  }

  /** A whole page of records in ONE transaction. A listing is 50 envelopes at a
   * time; 50 separate transactions is 50 commits and 50 chances for the tab to
   * be closed halfway through a page. */
  function putMany(store, records) {
    if (!records?.length) return Promise.resolve(null);
    return tx([store], 'readwrite', (t) => {
      const s = t.objectStore(store);
      let last = null;
      for (const r of records) last = s.put(r);
      return last;
    });
  }

  function getAll(store, query = null, count = undefined) {
    return tx([store], 'readonly', (t) => t.objectStore(store).getAll(query, count))
      .then((r) => r || []);
  }

  function clear(store) {
    return tx([store], 'readwrite', (t) => t.objectStore(store).clear());
  }

  /** Everything in one store whose key starts with `prefix` — how a per-user or
   * per-folder slice is read, since every key here is a NUL-joined path and
   * IDBKeyRange.bound over "prefix" .. "prefix￿" is exactly that slice. */
  function getAllByPrefix(store, prefix, count = undefined) {
    const range = IDBKeyRange.bound(prefix, prefix + '\uffff', false, false);
    return getAll(store, range, count);
  }

  function deleteByPrefix(store, prefix) {
    const range = IDBKeyRange.bound(prefix, prefix + '\uffff', false, false);
    return tx([store], 'readwrite', (t) => t.objectStore(store).delete(range));
  }

  /* ---------- bodies: written and evicted as a pair ---------- */

  /** A message body plus its index row, in ONE transaction — the index is what
   * eviction and the storage figure read, and a body without one would be
   * invisible to both (leaked space that nothing ever reclaims). */
  function putBody(record) {
    const { key, user, account, folder, uid, date, bytes } = record;
    return tx(['bodies', 'bodyIndex'], 'readwrite', (t) => {
      t.objectStore('bodies').put(record);
      return t.objectStore('bodyIndex').put({ key, user, account, folder, uid, date: date || 0, bytes: bytes || 0, at: Date.now() });
    });
  }

  function deleteBody(key) {
    return tx(['bodies', 'bodyIndex'], 'readwrite', (t) => {
      t.objectStore('bodies').delete(key);
      return t.objectStore('bodyIndex').delete(key);
    });
  }

  /** How much the cached bodies weigh, from the index alone — the bodies
   * themselves are never deserialized to answer this. */
  async function bodyBytes() {
    const rows = await getAll('bodyIndex');
    return rows.reduce((n, r) => n + (r.bytes || 0), 0);
  }

  /**
   * Bring the cache back under `capBytes` by dropping the OLDEST MESSAGES
   * first — oldest by the message's own date, not by when it was cached.
   *
   * Deliberately not LRU. A mailbox is read newest-first: an LRU cache under
   * pressure evicts exactly the old mail nobody touched and keeps whatever was
   * scrolled past last, which is the same thing, and it does it in an order
   * that has no meaning to the person looking at the list. "The newest N
   * messages are available offline" is a promise a user can hold in their head.
   *
   * Envelopes are never evicted here: they are a few hundred bytes each, they
   * are what offline search reads, and a list row whose body is gone still
   * opens to an honest "not saved for offline reading" card.
   */
  async function evictTo(capBytes) {
    // One read of the index, not two: this runs against every cached body, and
    // asking for the same rows twice (once to total them, once to sort them)
    // doubled the cost of the one operation that already has to touch
    // everything.
    const rows = await getAll('bodyIndex');
    let total = rows.reduce((n, r) => n + (r.bytes || 0), 0);
    if (total <= capBytes) return { evicted: 0, bytes: total };
    rows.sort((a, b) => (a.date || 0) - (b.date || 0)); // oldest message first
    let evicted = 0;
    for (const r of rows) {
      if (total <= capBytes) break;
      await deleteBody(r.key);
      total -= r.bytes || 0;
      evicted++;
    }
    return { evicted, bytes: total };
  }

  /* ---------- whose mail is this? ---------- */

  /**
   * Bind this database to one Hmelj login, wiping it if it belonged to someone
   * else.
   *
   * Two people sharing a laptop is the whole reason. Every record is also
   * keyed with the username (see keyFor in offline.js), so a wipe that somehow
   * failed still cannot serve one user another's mail — but the wipe is the
   * primary defence, and it runs before anything is read.
   *
   * Returns true when the store is usable and belongs to `user`.
   */
  async function bindUser(user) {
    if (!user) return false;
    const row = await get('meta', 'user');
    if (row?.value === user) return true;
    if (row?.value) await wipe();
    const ok = await put('meta', { key: 'user', value: user, at: Date.now() });
    return ok !== null;
  }

  /** Everything, gone: logout, a different user, or the Settings button.
   * `meta` goes too — including the user binding, so the next bindUser() starts
   * from a clean slate rather than believing a wipe already happened. */
  async function wipe() {
    for (const s of STORES) await clear(s);
    return true;
  }

  /** What the Settings panel shows. `quota`/`usage` come from the browser and
   * cover EVERYTHING this origin stores (the shell cache included), so the
   * panel shows our own figure next to it rather than instead of it. */
  async function usage() {
    const bodies = await bodyBytes();
    const counts = {
      bodies: (await getAll('bodyIndex')).length,
      envelopes: (await getAll('envelopes')).length,
      outbox: (await getAll('outbox')).length,
    };
    let quota = null, used = null;
    try {
      const est = await navigator.storage?.estimate?.();
      if (est) { quota = est.quota ?? null; used = est.usage ?? null; }
    } catch { /* not supported — the figures are optional */ }
    return { bytes: bodies, counts, quota, used };
  }

  /**
   * Ask the browser not to evict this origin under storage pressure.
   *
   * Without it, IndexedDB is "best effort" and a browser reclaiming space can
   * throw away the entire offline mailbox with no warning — which would look
   * exactly like offline mode being broken. Chrome grants this silently for an
   * installed/engaged origin; Firefox prompts; anything else refuses, and
   * refusing is fine, so this is fire-and-forget.
   */
  async function requestPersistence() {
    try { return await navigator.storage?.persist?.() ?? false; }
    catch { return false; }
  }

  /** Rough byte size of a value as it will be stored. structuredClone-based
   * storage has no cheap "how big is this" API, so this measures the JSON
   * instead: wrong in the third digit (UTF-16 vs UTF-8, IDB's own framing),
   * right in the order of magnitude, and consistent across every record, which
   * is all a cap and an eviction order need. */
  function sizeOf(value) {
    try { return JSON.stringify(value).length; } catch { return 0; }
  }

  return {
    k, open, get, put, putMany, del, getAll, getAllByPrefix, deleteByPrefix, clear,
    putBody, deleteBody, bodyBytes, evictTo,
    bindUser, wipe, usage, requestPersistence, sizeOf,
    isUnavailable: () => unavailable,
  };
})();
if (typeof window !== 'undefined') window.OfflineDb = OfflineDb;
