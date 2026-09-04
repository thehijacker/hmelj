// Hmelj — offline reads: what gets cached, what comes back when the server is
// unreachable, and the background prefetch that puts mail there before it is
// needed.
//
// The shape of the whole thing is one idea: **every GET that succeeds is
// remembered under its own URL, and every GET that fails because nothing
// answered is served from that memory instead.** That single hook in api.js is
// what makes boot(), loadMessages(), showSingleMessage(), loadFolders(), the
// calendar, contact autocomplete and message.html all work offline without one
// line changing at any of their call sites.
//
// Two things that hook alone can't do, and which live here too:
//
//   - **Mail you never opened.** A passive cache only ever holds what you
//     already read online, which is precisely not what "open my email offline"
//     means. So there is a prefetcher: while online and idle it walks the newest
//     N messages per account and pulls their bodies down.
//   - **A view the cache has never seen** — page 3 of a folder, a search typed
//     while offline. Those are answered from the `envelopes` store instead, by
//     building the list locally. Such an answer is labelled, never passed off as
//     the server's.
//
// Policy only. The IndexedDB mechanics are in offlineDb.js; queued WRITES and
// the overlay they impose on these reads are in outbox.js.
const Offline = (() => {
  const USER_KEY = 'hmelj-offline-user';
  const DEVICE_SETTINGS_KEY = 'hmelj-device-settings'; // shared with app.js's loadDeviceSettings()

  // Defaults duplicated from server/store.js's DEFAULT_SETTINGS on purpose:
  // this module runs before boot() has read any settings at all (message.html
  // never reads them), and a prefetcher that silently does nothing because the
  // settings object wasn't there yet is worse than one with a sane default.
  const DEFAULTS = {
    offlineEnabled: true,
    offlineMessages: 300,   // newest messages per account whose bodies are kept
    offlineAttachments: false,
    offlineMaxMb: 250,
  };

  // Per-message ceilings for inlined inline images. A newsletter with a 6 MB
  // hero image is not worth six ordinary messages' worth of the cache.
  const INLINE_MAX_ONE = 512 * 1024;
  const INLINE_MAX_TOTAL = 2 * 1024 * 1024;
  // Prefetch pacing. Every number here was made smaller after a first run
  // showed why it matters: a self-hosted Hmelj answers a /bodies request by
  // going to IMAP for each message in it, so a big batch occupies the server —
  // and one of the browser's handful of connections to it — for a long time.
  // The visible result was /api/sync-now and the SSE stream timing out behind
  // the prefetcher, the connection reading as down, and the app refreshing
  // itself every few seconds. A background nicety must never be able to do
  // that, so: small batches, real gaps, a timeout, and a long stand-down at the
  // first sign the server is struggling.
  const BODY_BATCH = 5;             // uids per /bodies request
  const PREFETCH_PAUSE_MS = 1500;   // between batches
  const BODIES_TIMEOUT_MS = 20000;  // give up on one batch rather than hold a connection
  const PASS_MIN_GAP_MS = 60000;    // between whole passes
  const STAND_DOWN_MS = 5 * 60000;  // after a failure or a timeout
  const QUIET_MS = 3000;            // how long since the app's last request counts as idle
  const QUIET_MAX_WAIT_MS = 20000;  // …but never wait longer than this to start a batch

  let user = null;
  let ready = null;           // Promise<boolean> — the bindUser handshake
  let envSnapshot = null;     // in-memory copy of the envelopes store (see envelopes())

  /* ---------- small helpers ---------- */

  function deviceSettings() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(DEVICE_SETTINGS_KEY) || '{}') }; }
    catch { return { ...DEFAULTS }; }
  }
  function enabled() { return deviceSettings().offlineEnabled !== false; }
  function currentUser() {
    if (user) return user;
    try { user = localStorage.getItem(USER_KEY) || null; } catch { user = null; }
    return user;
  }
  const path = (url) => String(url).split('?')[0];
  /** Epoch ms, or 0 — never NaN. NaN would poison every sort this field is read
   *  by (the local list builder, the prefetcher's newest-first walk, eviction's
   *  oldest-first one) and would do it silently. */
  const dateMs = (d) => { const t = d ? new Date(d).getTime() : 0; return Number.isFinite(t) ? t : 0; };
  const query = (url) => new URLSearchParams(String(url).split('?')[1] || '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Bind the cache to a Hmelj login. Called from boot() the moment a session is
   * known, and from nowhere else — until it has run, every entry point below is
   * a no-op, which is what keeps a logged-out or never-booted device from
   * accumulating anything.
   */
  function init(username) {
    if (!username) return Promise.resolve(false);
    user = String(username);
    // Before bindUser, which may be about to wipe the store because the last
    // person to use this device was someone else. The snapshot is an in-memory
    // copy of what was there a moment ago, and a wipe cannot reach it — leaving
    // it in place would show the previous user's message list to this one until
    // the next reload. Records are user-prefixed as a second line of defence,
    // but this is the first.
    envSnapshot = null;
    try { localStorage.setItem(USER_KEY, user); } catch { /* private mode */ }
    ready = OfflineDb.bindUser(user).then((ok) => {
      if (ok) OfflineDb.requestPersistence(); // fire-and-forget; a refusal is fine
      return ok;
    });
    return ready;
  }

  /** Everything gone — logout, a different user, or the Settings button. */
  async function wipe() {
    envSnapshot = null;
    await OfflineDb.wipe();
    try { localStorage.removeItem(USER_KEY); } catch {}
    user = null;
    ready = null;
  }

  async function usable() {
    if (!currentUser() || !enabled()) return false;
    if (!ready) ready = OfflineDb.bindUser(currentUser());
    return !!(await ready);
  }

  /* ---------- which URLs are cached, and where ---------- */

  // An ALLOWLIST, never a denylist. Everything here is either the user's own
  // mail or their own configuration; what is deliberately absent is just as
  // important — /api/app-passwords (secrets shown once), /api/admin/* (other
  // people's accounts), /api/oauth/* (sign-in state that must never be
  // replayed), /api/log, /api/export/*, /api/proofread, /api/analytics/*.
  // A route added to the API is not cached until someone puts it here.
  const KV_ALLOW = [
    '/api/session', '/api/status', '/api/settings', '/api/identities',
    '/api/accounts', '/api/folders', '/api/saved-searches', '/api/templates',
    '/api/snoozed', '/api/scheduled', '/api/unread', '/api/filters',
    '/api/subject-rules', '/api/holidays', '/api/fonts',
    '/api/contacts', '/api/contact-sources',
    '/api/calendars', '/api/calendar/events',
    '/api/thread/', '/api/message/', // /api/message/... that isn't a body: /headers
  ];

  const IS_LIST = /^\/api\/(messages|unified)\/[^/]+$/;
  const IS_BODY = /^\/api\/message\/[^/]+\/[^/]+$/;

  /** 'list' | 'body' | 'kv' | null — null means "never cache this". */
  function route(url) {
    const p = path(url);
    if (IS_LIST.test(p)) return 'list';
    if (IS_BODY.test(p)) return 'body';
    if (KV_ALLOW.some((a) => p === a || p.startsWith(a))) return 'kv';
    return null;
  }

  /**
   * The cache key for a URL.
   *
   * `allowImages` is stripped: it changes only whether REMOTE images survive
   * sanitizing, and offline no remote image can load anyway — keeping both
   * variants would double the store to hold two copies of the same reading
   * experience. The user prefix is what makes a stale record from another login
   * unreachable even if a wipe were somehow missed.
   */
  function urlKey(url) {
    const p = path(url);
    const q = query(url);
    q.delete('allowImages');
    const rest = q.toString();
    return OfflineDb.k(currentUser(), rest ? `${p}?${rest}` : p);
  }

  /** Which account/folder/uid a /api/message/:f/:uid URL is about. */
  function bodyRef(url) {
    const m = path(url).match(/^\/api\/message\/([^/]+)\/([^/]+)$/);
    if (!m) return null;
    return {
      folder: decodeURIComponent(m[1]),
      uid: decodeURIComponent(m[2]),
      account: query(url).get('account') || '',
    };
  }

  const bodyKey = (account, folder, uid) => OfflineDb.k(currentUser(), account, folder, uid);

  /* ---------- envelopes ---------- */

  /** The envelopes store, kept in memory between writes.
   *
   * Read on every offline search keystroke and on every prefetch pass, and a
   * whole mailbox's worth of envelopes is a few thousand records of a few
   * hundred bytes — cheaper to hold one copy than to re-read it, and simpler
   * than maintaining compound indexes for the two questions ever asked of it
   * ("newest N of this account", "which of these match this text"). */
  async function envelopes() {
    if (envSnapshot) return envSnapshot;
    if (!await usable()) return [];
    const prefix = OfflineDb.k(currentUser()) + '\u0000';
    envSnapshot = await OfflineDb.getAllByPrefix('envelopes', prefix);
    return envSnapshot;
  }

  /** Text an offline search matches against. Built once, at write time — a
   *  search must not deserialize and re-derive this for every row on every
   *  keystroke. Body text is folded in later, when a body is cached. */
  function searchTextOf(m) {
    const people = [...(m.from ? [m.from] : []), ...(m.to || []), ...(m.cc || [])]
      .map((p) => `${p?.name || ''} ${p?.address || ''}`).join(' ');
    return `${m.subject || ''} ${m.subjectOriginal || ''} ${people}`.toLowerCase();
  }

  /**
   * Record every message a list response mentioned.
   *
   * This is what makes offline search and the local list builder possible at
   * all, and it is free: the rows are already in hand. In the unified view a
   * row names its own account and folder; in a single account's folder view
   * those come from the request URL, exactly as API._acct put them there.
   */
  async function harvest(url, data) {
    const rows = data?.messages;
    if (!Array.isArray(rows) || !rows.length) return;
    const urlAccount = query(url).get('account') || '';
    const m = path(url).match(/^\/api\/messages\/([^/]+)$/);
    const urlFolder = m ? decodeURIComponent(m[1]) : '';
    const u = currentUser();
    const records = [];
    for (const msg of rows) {
      const account = msg.account?.id || urlAccount;
      const folder = msg.folder || urlFolder;
      // A unified row with neither is not addressable and must not be stored:
      // it could never be opened again, and it would pollute every local list.
      if (!account || !folder || msg.uid === undefined) continue;
      records.push({
        key: OfflineDb.k(u, account, folder, msg.uid),
        user: u, account, folder, uid: msg.uid,
        date: dateMs(msg.date),
        search: searchTextOf(msg),
        msg,
      });
    }
    if (!records.length) return;
    // One transaction for the whole page: 50 separate ones is 50 commits.
    await OfflineDb.putMany('envelopes', records);
    // The snapshot is now stale in a way that matters immediately (the row the
    // user is about to search for). Cheapest correct answer: drop it.
    envSnapshot = null;
  }

  /* ---------- inline (cid:) images ---------- */

  // The server rewrites <img src="cid:…"> to a same-origin URL of its own
  // (server/index.js's img sanitizer). That URL is useless offline, and — this
  // is the part that forces the whole approach — it cannot be repaired later
  // either: the reading pane renders a body inside a SANDBOXED srcdoc iframe
  // with no allow-same-origin (messageFrame.js#buildFrame), so that document
  // has an opaque origin. Its requests reach no service worker, and its DOM is
  // unreachable from the page afterwards. The only moment an inline image can
  // be substituted is before the HTML string is handed to srcdoc — which means
  // the bytes have to be sitting in the HTML we cached.
  const CID_SRC = /src="(\/api\/message\/[^"]*?\/cid\/[^"]*?)"/gi;

  // 1×1 transparent GIF. What an inline image becomes when it wasn't cached —
  // a broken-image glyph in the middle of a newsletter reads as a rendering
  // fault, which this isn't.
  const BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  async function fetchDataUrl(url, maxBytes) {
    // Same reasoning as the batch route's timeout (see the pacing constants):
    // these are background fetches of parts the server pulls out of IMAP, and
    // one that never answers would hold a connection the app needs.
    const ctl = new AbortController();
    const bail = setTimeout(() => ctl.abort(), BODIES_TIMEOUT_MS);
    let res;
    try { res = await fetch(url, { credentials: 'same-origin', signal: ctl.signal }); }
    finally { clearTimeout(bail); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    if (blob.size > maxBytes) throw new Error('too large');
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('read failed'));
      fr.readAsDataURL(blob);
    });
  }

  /** Replace every cid: image reference in `html` with a data: URL. Returns
   *  null when there was nothing to do, so a caller can tell "already fine"
   *  from "tried and failed". */
  async function inlineCids(html) {
    if (!html) return null;
    const urls = [...new Set([...html.matchAll(CID_SRC)].map((m) => m[1]))];
    if (!urls.length) return null;
    let budget = INLINE_MAX_TOTAL;
    let out = html;
    for (const raw of urls) {
      // The HTML is escaped, so a query separator arrives as &amp;. Fetch the
      // decoded URL, but substitute against the escaped one that is actually
      // in the document.
      const fetchUrl = raw.replace(/&amp;/g, '&');
      let data;
      try { data = await fetchDataUrl(fetchUrl, Math.min(INLINE_MAX_ONE, budget)); }
      catch (e) {
        // A timeout is about the SERVER, not this image: stop asking it for
        // things rather than working through the rest of the list.
        if (e?.name === 'AbortError') { standDown(); break; }
        continue; // too big, or gone — leave it for replaceUninlined()
      }
      budget -= data.length;
      out = out.split(`src="${raw}"`).join(`src="${data}"`);
      if (budget <= 0) break;
    }
    return out === html ? null : out;
  }

  /** Anything still pointing at the server when we are serving from cache can
   *  never load — swap it for the blank rather than a broken-image glyph. */
  function replaceUninlined(html) {
    if (!html) return html;
    return html.replace(CID_SRC, `src="${BLANK_GIF}" data-hmelj-offline-image="1"`);
  }

  /* ---------- custom fonts ---------- */

  // The same problem the inline images have, and the same only answer.
  //
  // A message body renders inside a sandboxed srcdoc iframe with no
  // allow-same-origin, so that document has an opaque origin: its font request
  // is cross-origin even though it points back at this very server (which is
  // why /fonts/custom has to send Access-Control-Allow-Origin at all — see
  // server/index.js), and it reaches no service worker, so nothing can serve it
  // from a cache offline. The bytes have to already be in the @font-face rule.
  //
  // Only the family actually in use is kept, and only its real styles — at most
  // four files. This is not a font cache, it is "the font this device reads mail
  // in", which is a small and bounded thing.
  const FONT_MAX_BYTES = 2 * 1024 * 1024;
  let fontCache = null; // {url: dataUrl}, loaded once at boot

  const fontKey = (url) => OfflineDb.k(currentUser(), 'font', url);

  /** Load the stored fonts into memory. Must finish before the first
   *  buildFontFaceCss() call, because that one is synchronous — boot() awaits
   *  it just ahead of refreshCustomFonts(). */
  async function loadFonts() {
    fontCache = {};
    try {
      if (!await usable()) return fontCache;
      const prefix = OfflineDb.k(currentUser(), 'font') + '\u0000';
      for (const rec of await OfflineDb.getAllByPrefix('kv', prefix)) {
        if (rec?.url && rec?.data) fontCache[rec.url] = rec.data;
      }
    } catch { /* no cache is not an error — the font falls back */ }
    return fontCache;
  }

  /**
   * The saved copy of one font file, or null.
   *
   * Only offered while OFFLINE. Online the real URL is better: a font file can
   * be replaced in place by an admin re-upload (the URL carries the family id
   * and the style, not a content hash), and serving a stale face from here
   * would be a change nobody could explain.
   */
  function fontUrl(url) {
    if (!url || !fontCache) return null;
    if (window.Connection?.isOnline?.() !== false) return null;
    return fontCache[url] || null;
  }

  /**
   * Keep exactly `urls` saved and drop everything else.
   *
   * The caller decides what matters (app.js: the styles of the families the App
   * font and Message font settings actually name), because only it knows which
   * settings are in force. Changing the setting therefore also evicts the
   * previous family on the next pass, rather than accumulating every font ever
   * selected.
   */
  async function cacheFonts(urls) {
    try {
      if (!await usable() || !window.Connection?.isOnline?.()) return;
      if (!fontCache) await loadFonts();
      const want = new Set((urls || []).filter(Boolean));
      const prefix = OfflineDb.k(currentUser(), 'font') + '\u0000';
      for (const rec of await OfflineDb.getAllByPrefix('kv', prefix)) {
        if (rec?.url && !want.has(rec.url)) {
          await OfflineDb.del('kv', rec.key);
          delete fontCache[rec.url];
        }
      }
      for (const url of want) {
        if (fontCache[url]) continue;
        let data;
        try { data = await fetchDataUrl(url, FONT_MAX_BYTES); }
        catch { continue; } // too big, gone, or slow — the message just reads in the fallback face
        await OfflineDb.put('kv', { key: fontKey(url), url, at: Date.now(), data });
        fontCache[url] = data;
      }
    } catch { /* never worth failing anything over */ }
  }

  /* ---------- attachments ---------- */

  // Off by default (`offlineAttachments`), and capped when on. Attachments are
  // by a wide margin the largest thing in a mailbox, and unlike a body they are
  // not what "read my mail offline" usually means — so this is opt-in, and even
  // then it takes the small ones and leaves the 40 MB video.
  const ATTACH_MAX_ONE = 1024 * 1024;
  const ATTACH_MAX_TOTAL = 4 * 1024 * 1024;

  /** The attachment URLs the server builds (API.attachmentUrl), parsed back.
   *  `download=1` is stripped: it asks for a different Content-Disposition, not
   *  a different file, and keying on it would cache the same bytes twice. */
  function attachmentRef(url) {
    const m = path(url).match(/^\/api\/message\/([^/]+)\/([^/]+)\/attachment\/([^/]+)$/);
    if (!m) return null;
    return {
      folder: decodeURIComponent(m[1]),
      uid: decodeURIComponent(m[2]),
      index: String(decodeURIComponent(m[3])),
      account: query(url).get('account') || '',
    };
  }

  /**
   * One saved attachment, as a Blob — what the attachment viewer falls back to
   * when its fetch cannot reach the server (see attachmentViewer.js).
   *
   * Stored on the message record rather than in a store of its own, and that is
   * the point: an attachment is evicted exactly when its message is, which is
   * the only sensible answer. Keeping the file after losing the mail it arrived
   * with would leave bytes nothing can reach or explain.
   */
  async function attachment(url) {
    try {
      if (!await usable()) return null;
      const ref = attachmentRef(url);
      if (!ref) return null;
      const rec = await OfflineDb.get('bodies', bodyKey(ref.account, ref.folder, ref.uid));
      const dataUrl = rec?.msg?.__offlineAttachments?.[ref.index];
      if (!dataUrl) return null;
      const res = await fetch(dataUrl); // a data: URL — no network involved
      const blob = await res.blob();
      return { blob, type: blob.type };
    } catch { return null; }
  }

  /** Download the attachments of one already-cached message, within the caps,
   *  and fold them into its stored record. Inline images are skipped — they are
   *  already in the HTML (see inlineCids). */
  async function saveAttachmentsFor(rec) {
    const msg = rec.msg || {};
    const list = (msg.attachments || []).filter((a) => !a.inlineUsed && (a.size || 0) <= ATTACH_MAX_ONE);
    const saved = { ...(msg.__offlineAttachments || {}) };
    let budget = ATTACH_MAX_TOTAL;
    for (const a of list) {
      if (saved[String(a.index)]) continue;
      if (!window.Connection?.isOnline?.()) break;
      const url = `/api/message/${encodeURIComponent(rec.folder)}/${encodeURIComponent(rec.uid)}`
        + `/attachment/${encodeURIComponent(a.index)}?account=${encodeURIComponent(rec.account)}`;
      try {
        const data = await fetchDataUrl(url, Math.min(ATTACH_MAX_ONE, budget));
        saved[String(a.index)] = data;
        budget -= data.length;
      } catch (e) {
        if (e?.name === 'AbortError') { standDown(); break; } // the server is busy — see standDown()
        /* too large, or gone — the next pass retries */
      }
      if (budget <= 0) break;
    }
    // The marker goes on whether or not anything was saved, so a message whose
    // attachments are all too big is not re-examined on every pass forever.
    await storeBody(rec, { ...msg, __offlineAttachments: saved, __attachmentsDone: true }, { inlined: rec.inlined });
  }

  /* ---------- remember (the success path) ---------- */

  /**
   * Called by api.js for every GET that came back 2xx. Never awaited by the
   * caller — a cache write must not add a millisecond to a response the user
   * is waiting for.
   */
  async function remember(url, data) {
    try {
      if (!await usable()) return;
      const kind = route(url);
      if (!kind || !data || typeof data !== 'object') return;
      if (kind === 'list') {
        await OfflineDb.put('lists', { key: urlKey(url), url: path(url), at: Date.now(), data });
        await harvest(url, data);
        return;
      }
      if (kind === 'body') {
        const ref = bodyRef(url);
        if (!ref?.account) return; // unaddressable without one — see harvest()
        await storeBody(ref, data, { inlined: false });
        return;
      }
      await OfflineDb.put('kv', { key: urlKey(url), url: path(url), at: Date.now(), data });
    } catch { /* a cache that cannot write is not an error the user should see */ }
  }

  /** Write one message body, keep the cache under its cap, and fold the body
   *  text into that message's envelope so offline search can find words that
   *  only appear inside the message. */
  async function storeBody(ref, msg, { inlined }) {
    const key = bodyKey(ref.account, ref.folder, ref.uid);
    const record = {
      key, user: currentUser(), account: ref.account, folder: ref.folder, uid: ref.uid,
      date: dateMs(msg.date),
      at: Date.now(), inlined: !!inlined, msg,
    };
    record.bytes = OfflineDb.sizeOf(record);
    await OfflineDb.putBody(record);
    await mergeBodyText(key, msg);
    await maybeEvict(record.bytes);
  }

  // Eviction has to look at every cached body to decide anything, so it must
  // not run on every single write — a prefetch pass storing three hundred
  // messages would otherwise scan the whole index three hundred times. Instead
  // the bytes written since the last check are counted, and the real check runs
  // when enough have accumulated to be worth it (or when a pass ends, with
  // force). The cap is a ceiling to stay under, not a byte-exact budget, so a
  // few megabytes of slack between checks costs nothing.
  const EVICT_CHECK_BYTES = 5 * 1024 * 1024;
  let bytesSinceEvictCheck = 0;

  async function maybeEvict(added = 0, { force = false } = {}) {
    bytesSinceEvictCheck += added;
    if (!force && bytesSinceEvictCheck < EVICT_CHECK_BYTES) return;
    bytesSinceEvictCheck = 0;
    const cap = Math.max(8, Number(deviceSettings().offlineMaxMb) || DEFAULTS.offlineMaxMb) * 1024 * 1024;
    await OfflineDb.evictTo(cap);
  }

  /** The searchable text of a message that has a body: subject and people, plus
   *  a bounded slice of the body itself. Bounded because this is loaded whole
   *  into memory on every offline search — a 400 KB newsletter would put its
   *  entire boilerplate in the way of every keystroke. */
  async function mergeBodyText(key, msg) {
    const env = await OfflineDb.get('envelopes', key);
    if (!env) return;
    const text = String(msg.text || '').slice(0, 4000).toLowerCase();
    if (!text) return;
    const next = `${searchTextOf(env.msg)} ${text}`;
    if (next === env.search) return;
    await OfflineDb.put('envelopes', { ...env, search: next });
    envSnapshot = null;
  }

  /* ---------- recall (the offline path) ---------- */

  /**
   * Called by api.js when a GET could not reach the server. Returns the cached
   * answer, stamped with `_cachedAt` so the UI can say how old it is, or null —
   * and null means api.js throws exactly the error it threw before offline mode
   * existed.
   */
  async function recall(url) {
    try {
      if (!await usable()) return null;
      const kind = route(url);
      if (!kind) return null;
      if (kind === 'body') {
        const ref = bodyRef(url);
        if (!ref) return null;
        const rec = await OfflineDb.get('bodies', bodyKey(ref.account, ref.folder, ref.uid));
        if (!rec) return null;
        const msg = { ...rec.msg, html: replaceUninlined(rec.msg.html), _cachedAt: rec.at };
        return window.Outbox?.decorateMessage?.(msg, ref) ?? msg;
      }
      const rec = await OfflineDb.get(kind === 'list' ? 'lists' : 'kv', urlKey(url));
      if (!rec) return null;
      return decorate(url, rec.data, rec.at);
    } catch { return null; }
  }

  /** Apply anything queued in the Outbox on top of a cached answer, so an
   *  action taken offline is not undone on screen by the very cache it was
   *  taken against (see outbox.js). */
  function decorate(url, data, at) {
    const p = path(url);
    let out = data;
    if (IS_LIST.test(p)) out = window.Outbox?.decorateList?.(data, listCtx(url)) ?? data;
    // A conversation is a list of messages too, and the stacked reading pane
    // draws it from exactly this — so a message deleted offline has to leave
    // the thread as well, or it reappears the moment its conversation is
    // reopened. Its own folder is named per row where the thread spans several;
    // the request's is the fallback, as everywhere else.
    else if (p.startsWith('/api/thread/')) {
      out = window.Outbox?.decorateList?.(data, {
        account: query(url).get('account') || '', folder: query(url).get('folder') || '',
      }) ?? data;
    } else if (p === '/api/unread') out = window.Outbox?.decorateUnread?.(data) ?? data;
    else if (p === '/api/folders') out = window.Outbox?.decorateFolders?.(data, query(url).get('account') || '') ?? data;
    // Arrays are objects: stamping one is harmless, and every consumer of these
    // reads named fields rather than iterating keys.
    return Object.assign(Array.isArray(out) ? out.slice() : { ...out }, { _cachedAt: at });
  }

  /** The account/folder a single-account list URL is about — the context a row
   *  in it inherits when it doesn't name its own (see harvest()). */
  function listCtx(url) {
    const m = path(url).match(/^\/api\/messages\/([^/]+)$/);
    return { account: query(url).get('account') || '', folder: m ? decodeURIComponent(m[1]) : '' };
  }

  /** The session this device last booted with — what lets boot() open the app
   *  offline instead of showing the "can't reach the server" screen. */
  async function cachedSession() {
    try {
      if (!await usable()) return null;
      const rec = await OfflineDb.get('kv', urlKey('/api/session'));
      return rec?.data?.loggedIn ? rec.data : null;
    } catch { return null; }
  }

  /** connection.js probes /api/session with a raw fetch (deliberately — it must
   *  bypass every layer that could make a dead server look alive), so the one
   *  read that matters most for booting offline never passes through api.js.
   *  boot() hands it over explicitly instead. */
  async function rememberSession(session) {
    try {
      if (!await usable() || !session) return;
      await OfflineDb.put('kv', { key: urlKey('/api/session'), url: '/api/session', at: Date.now(), data: session });
    } catch {}
  }

  /* ---------- building a list locally ---------- */

  /**
   * A search string, as much of it as can be answered from envelopes.
   *
   * The server's own query language (server/searchQuery.js) is richer than
   * this, and pretending otherwise would be the wrong kind of clever: what is
   * supported here is the handful of terms that carry most searches —
   * from:/to:/subject:, is:unread, is:starred, has:attachment — plus bare words
   * matched against subject, correspondents and (where the body is cached) the
   * message text. Everything is AND-ed, quotes group.
   */
  function parseQuery(q) {
    const terms = [];
    const re = /"([^"]+)"|(\S+)/g;
    let m;
    while ((m = re.exec(q || '')) !== null) {
      const raw = (m[1] ?? m[2]).trim();
      if (!raw) continue;
      const f = raw.match(/^(from|to|subject|is|has):(.*)$/i);
      if (f) terms.push({ field: f[1].toLowerCase(), value: f[2].replace(/^"|"$/g, '').toLowerCase() });
      else terms.push({ field: 'any', value: raw.toLowerCase() });
    }
    return terms;
  }

  function matches(env, terms) {
    const msg = env.msg || {};
    const people = (list) => (list || []).map((p) => `${p?.name || ''} ${p?.address || ''}`).join(' ').toLowerCase();
    for (const t of terms) {
      switch (t.field) {
        case 'from':
          if (!people(msg.from ? [msg.from] : []).includes(t.value)) return false;
          break;
        case 'to':
          if (!people(msg.to).includes(t.value)) return false;
          break;
        case 'subject':
          if (!String(msg.subject || '').toLowerCase().includes(t.value)) return false;
          break;
        case 'is':
          if (t.value === 'unread' && msg.seen) return false;
          if (t.value === 'read' && !msg.seen) return false;
          if ((t.value === 'starred' || t.value === 'flagged') && !isFlagged(msg)) return false;
          break;
        case 'has':
          if (t.value === 'attachment' && !msg.hasAttachment) return false;
          break;
        default:
          if (!env.search.includes(t.value)) return false;
      }
    }
    return true;
  }

  const isFlagged = (m) => (m.flags || []).some((f) => String(f).toLowerCase() === '\\flagged');

  /**
   * Build a message list out of cached envelopes.
   *
   * Used when the exact request URL was never cached — page 3 of a folder, a
   * search typed while offline — so the alternative is an error, not a better
   * answer. Flat by design: conversation grouping is the server's
   * (cache.js#getThread), and a locally-invented approximation of it would
   * disagree with the real one the moment the connection came back. Rows carry
   * no threadCount, which app.js's isThreadRow() already reads as "open this
   * one message".
   *
   * `scopes` is [{account, folder}] — the caller resolves which mailboxes the
   * current view covers, because only it knows what "all inboxes" means for
   * this user's accounts.
   */
  async function buildList({ scopes, page = 1, pageSize = 50, q = '', unread = false, flagged = false }) {
    if (!await usable()) return null;
    const all = await envelopes();
    if (!all.length) return null;
    const want = scopes?.length ? new Set(scopes.map((s) => `${s.account}\u0000${s.folder}`)) : null;
    const terms = parseQuery(q);
    const hits = all.filter((e) => {
      if (want && !want.has(`${e.account}\u0000${e.folder}`)) return false;
      if (unread && e.msg.seen) return false;
      if (flagged && !isFlagged(e.msg)) return false;
      return matches(e, terms);
    });
    hits.sort((a, b) => (b.date || 0) - (a.date || 0));
    // The queue is applied HERE rather than to the finished list, because only
    // the envelope knows which account its row belongs to — a locally-built
    // listing has neither a row-level account (that only exists in the unified
    // view) nor a request URL to read one off. A row a queued delete or move
    // has taken out of this mailbox drops out entirely.
    const live = [];
    for (const e of hits) {
      const row = window.Outbox?.decorateRow?.(e.msg, e.account, e.folder) ?? e.msg;
      if (!row) continue;
      // A local row must always name its own mailbox: it may be shown in a view
      // that spans several, and unlike the server's answer there is no request
      // URL standing behind it to fall back on.
      live.push({ ...row, folder: row.folder || e.folder });
    }
    const start = (page - 1) * pageSize;
    return {
      total: live.length, page, pageSize,
      messages: live.slice(start, start + pageSize),
      scope: 'offline', _local: true, _cachedAt: Date.now(),
    };
  }

  /* ---------- prefetch ---------- */

  let prefetching = false;
  let prefetchTimer = null;
  let lastPassAt = 0;
  let standDownUntil = 0;

  /** Data-saver mode is a direct instruction from the user of this device: do
   *  not use my bandwidth on things I did not ask for. A prefetch is exactly
   *  that. (Reading a message still fetches it, and still caches it.) */
  function saveDataOn() {
    try { return navigator.connection?.saveData === true; } catch { return false; }
  }

  /**
   * Fill the cache with the newest mail, in the background.
   *
   * Serialised — one pass at a time, one batch at a time, with a pause between
   * batches. This runs while somebody is using the app, and a prefetch that
   * makes the list feel slow has defeated itself.
   */
  async function prefetch({ force = false } = {}) {
    if (prefetching || !await usable()) return;
    if (!window.Connection?.isOnline?.()) return;
    if (saveDataOn() && !force) return;
    if (!force && Date.now() < standDownUntil) return;
    if (!force && Date.now() - lastPassAt < PASS_MIN_GAP_MS) return;
    prefetching = true;
    lastPassAt = Date.now();
    try {
      const s = deviceSettings();
      const keep = Math.max(0, Number(s.offlineMessages) || 0);
      if (!keep) return;
      const accounts = (await accountsForPrefetch()).filter((a) => !a.disabled);
      for (const acct of accounts) {
        if (!window.Connection?.isOnline?.()) return;
        await primeEnvelopes(acct.id, keep);
        await fetchMissingBodies(acct.id, keep);
        // A separate pass, not part of the body loop: a message whose body was
        // cached by simply reading it online never went through that loop, and
        // turning the setting on later has to reach back over everything
        // already saved rather than only what is downloaded from now on.
        if (s.offlineAttachments) await fetchMissingAttachments(acct.id, keep);
        // Lowering "messages kept per account" has to mean something. Bodies
        // are otherwise only ever removed by the size cap, so a device that ran
        // at 300 and was turned down to 150 would sit on 300 until it happened
        // to fill up — the setting would look ignored, because for that device
        // it was.
        await pruneBodiesBeyond(acct.id, keep);
      }
      // End of a pass is the natural moment to settle up with the size cap,
      // whatever the running counter says.
      await maybeEvict(0, { force: true });
      await OfflineDb.put('meta', { key: 'lastPrefetch', value: Date.now() });
      return true;
    } catch { /* nothing here is worth a toast; the next pass tries again */ }
    finally { prefetching = false; }
    return false;
  }

  /**
   * Stop, and stay stopped for a while.
   *
   * Called when a prefetch request fails or times out. Both mean the same
   * thing in practice — the server is busy, quite possibly with this very
   * prefetch — and the worst available response is to try again immediately.
   */
  function standDown() { standDownUntil = Date.now() + STAND_DOWN_MS; }

  /**
   * Wait for the app to stop asking for things.
   *
   * The prefetcher shares a small pool of connections with everything the user
   * is actually waiting for, so it starts a batch in a gap rather than on top
   * of a folder switch. Bounded: on a device someone is using continuously it
   * eventually proceeds anyway, slowly, rather than never running at all.
   */
  async function waitForQuiet() {
    const until = Date.now() + QUIET_MAX_WAIT_MS;
    while (Date.now() < until) {
      const idleFor = Date.now() - (window.API?.lastUserRequestAt || 0);
      if (idleFor >= QUIET_MS) return;
      await sleep(500);
    }
  }

  /** Drop the bodies of everything past the newest `keep` for one account. The
   *  envelopes stay: they are tiny, they are what offline search reads, and a
   *  row whose body is gone still opens to an honest card. */
  async function pruneBodiesBeyond(accountId, keep) {
    const ranked = (await envelopes())
      .filter((e) => e.account === accountId)
      .sort((a, b) => (b.date || 0) - (a.date || 0));
    const doomed = new Set(ranked.slice(keep).map((e) => e.key));
    if (!doomed.size) return;
    for (const row of await OfflineDb.getAll('bodyIndex')) {
      if (doomed.has(row.key)) await OfflineDb.deleteBody(row.key);
    }
  }

  /** The accounts to prefetch for. Read from the cache rather than app.js's
   *  `state` so this module stays usable from message.html and from a pass that
   *  starts before boot() has finished. */
  async function accountsForPrefetch() {
    const rec = await OfflineDb.get('kv', urlKey('/api/accounts'));
    const list = rec?.data;
    return Array.isArray(list) ? list : [];
  }

  /**
   * Make sure we know about the newest `keep` messages of an account's INBOX,
   * by walking its pages. Without this, offline mode would only ever cover the
   * folders and pages somebody happened to browse — the first page of the inbox
   * is what "my email, offline" actually means.
   */
  async function primeEnvelopes(accountId, keep) {
    const pageSize = 50;
    const pages = Math.min(10, Math.ceil(keep / pageSize));
    for (let page = 1; page <= pages; page++) {
      if (!window.Connection?.isOnline?.()) return;
      await waitForQuiet();
      let data;
      try {
        // Through API.get, so the response lands in the `lists` cache and its
        // rows in `envelopes` by exactly the same path a real page view takes.
        // `background` keeps it out of the reachability decision, and the
        // timeout keeps a slow answer from holding a connection — see api.js.
        data = await API.get(`/api/messages/INBOX?page=${page}&account=${encodeURIComponent(accountId)}`,
          { background: true, timeoutMs: BODIES_TIMEOUT_MS });
      } catch (e) {
        if (e?.timedOut) standDown();
        return; // offline again, slow, or this account can't be listed
      }
      if (!data?.messages?.length || data.messages.length < pageSize) return;
      await sleep(PREFETCH_PAUSE_MS);
    }
  }

  /**
   * Download the bodies this account is missing, newest first, in batches.
   *
   * Newest first matters: a pass that is interrupted (the phone leaves wifi,
   * the tab closes) has then cached the mail most likely to be wanted, rather
   * than a random prefix of it.
   */
  async function fetchMissingBodies(accountId, keep) {
    const envs = (await envelopes())
      .filter((e) => e.account === accountId)
      .sort((a, b) => (b.date || 0) - (a.date || 0))
      .slice(0, keep);
    // "Which of these do we already have" answered with ONE read of the small
    // index, rather than a lookup per message — at three hundred messages an
    // account that is three hundred transactions, every pass, to discover that
    // nothing needs doing.
    const have = new Set((await OfflineDb.getAll('bodyIndex')).map((r) => r.key));
    // Group by folder: the batch route is folder-scoped, like every other
    // message route in this API.
    const byFolder = new Map();
    for (const e of envs) {
      if (have.has(e.key)) continue;
      if (!byFolder.has(e.folder)) byFolder.set(e.folder, []);
      byFolder.get(e.folder).push(e);
    }
    for (const [folder, list] of byFolder) {
      for (let i = 0; i < list.length; i += BODY_BATCH) {
        if (!window.Connection?.isOnline?.() || !enabled()) return;
        if (Date.now() < standDownUntil) return;
        await waitForQuiet();
        const slice = list.slice(i, i + BODY_BATCH);
        let res;
        try {
          res = await API.post(
            `/api/messages/${encodeURIComponent(folder)}/bodies?account=${encodeURIComponent(accountId)}`,
            { uids: slice.map((e) => e.uid) },
            { background: true, timeoutMs: BODIES_TIMEOUT_MS },
          );
        } catch (e) {
          // Timed out, or the server refused: either way it is busy, and the
          // one thing that must not happen next is another request from here.
          standDown();
          return;
        }
        for (const msg of res?.messages || []) {
          const ref = { account: accountId, folder, uid: String(msg.uid) };
          const html = await inlineCids(msg.html);
          await storeBody(ref, html ? { ...msg, html } : msg, { inlined: true });
        }
        // Messages the server says are not there any more (moved or deleted
        // from another client). Their list entries go too: keeping them would
        // show rows that cannot be opened, and would have this pass ask for
        // exactly the same dead uids again on every future pass.
        await forget(accountId, folder, res?.gone || []);
        await sleep(PREFETCH_PAUSE_MS);
      }
    }
  }

  /** The attachment half of a prefetch pass, over the messages whose bodies are
   *  already saved. Newest first, like everything else here, and it stops the
   *  moment the connection does. */
  async function fetchMissingAttachments(accountId, keep) {
    const envs = (await envelopes())
      .filter((e) => e.account === accountId)
      .sort((a, b) => (b.date || 0) - (a.date || 0))
      .slice(0, keep);
    for (const e of envs) {
      if (!window.Connection?.isOnline?.() || !enabled()) return;
      if (Date.now() < standDownUntil) return;
      const rec = await OfflineDb.get('bodies', e.key);
      if (!rec || rec.msg?.__attachmentsDone) continue;
      if (!(rec.msg?.attachments || []).length) continue;
      await waitForQuiet();
      await saveAttachmentsFor(rec);
      await sleep(PREFETCH_PAUSE_MS);
    }
  }

  /** Drop what is no longer on the server: the message list entry and any body
   *  saved for it. Also used when a queued action comes back "gone" — the two
   *  are the same fact arriving by different routes. */
  async function forget(account, folder, uids) {
    if (!uids?.length || !await usable()) return;
    for (const uid of uids) {
      const key = bodyKey(account, folder, uid);
      await OfflineDb.deleteBody(key);
      await OfflineDb.del('envelopes', key);
    }
    envSnapshot = null;
  }

  /** Kick a pass shortly from now, collapsing a burst of callers into one. */
  function schedulePrefetch(delayMs = 5000) {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => {
      const run = () => prefetch();
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 10000 });
      else run();
    }, delayMs);
  }

  /* ---------- storage figures, for Settings ---------- */

  async function usage() {
    if (!currentUser()) return { bytes: 0, counts: { bodies: 0, envelopes: 0, outbox: 0 }, quota: null, used: null };
    return OfflineDb.usage();
  }

  return {
    init, wipe, usable, enabled,
    remember, recall, cachedSession, rememberSession,
    buildList, envelopes, attachment, forget,
    loadFonts, fontUrl, cacheFonts,
    prefetch, schedulePrefetch,
    usage,
  };
})();
if (typeof window !== 'undefined') window.Offline = Offline;
