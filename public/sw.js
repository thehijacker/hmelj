// Hmelj — service worker
// Strategy:
//  - App shell (HTML/CSS/JS/icons): network-first, fall back to cache when offline.
//    Network-first keeps self-hosted tweaking painless (edit a file, refresh, see it).
//  - /api/*: network only — mail data must always be fresh. When offline, list/read
//    requests get a JSON error the UI shows as a normal error toast.
const VERSION = 'hmelj-20260829002';
const SHELL = [
  '/',
  '/index.html',
  '/message.html',
  '/login.html',
  '/css/app.css',
  '/js/i18n.js',
  '/js/connection.js',
  '/i18n/en.json',
  '/i18n/sl.json',
  '/js/api.js',
  '/js/dialog.js',
  '/js/messageFrame.js',
  '/js/messageFind.js',
  '/js/attachmentViewer.js',
  '/js/oauth.js',
  '/js/settings.js',
  '/js/analytics.js',
  '/js/proofread.js',
  '/js/compose.js',
  '/js/app.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;

  // Mail data: network only, structured offline error.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'No connection to the Hmelj server' }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            // Marks this as "nothing answered", not "the server said 503".
            // public/js/api.js keys the app's whole offline state off it — a
            // real 503 from a live server must NOT be read as being offline.
            'X-Hmelj-Offline': '1',
          },
        }))
    );
    return;
  }

  // Shell & static: network-first with cache fallback.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(async () => {
        // ignoreSearch for everything, not just '/': the app shell now loads its
        // scripts with a ?v= version stamp (see server/index.js), and the URLs
        // pre-cached in SHELL carry no query. Without this, going offline would
        // find no cached match for a versioned URL and the app would fail to
        // load at all — from a cache that has the file.
        const cached = await caches.match(e.request, { ignoreSearch: true });
        return cached || (e.request.mode === 'navigate' ? caches.match('/index.html') : Response.error());
      })
  );
});

/** App-icon badge (dock/taskbar/home screen). Nothing in this app used the
 * Badging API before, which is why an installed PWA's icon never showed a
 * count at all — and why the count could never be corrected while the app was
 * closed, since only a live page was updating anything. `total` comes from the
 * push payload (server/push.js); a non-number means the sender didn't include
 * one, so leave whatever's there rather than wrongly clearing it. */
async function setBadge(total) {
  if (typeof total !== 'number') return;
  try {
    if (total > 0) await self.navigator.setAppBadge?.(total);
    else await self.navigator.clearAppBadge?.();
  } catch { /* unsupported, or not installed — never worth failing a push over */ }
}

// ---------- Web Push (new-mail notifications, see server/push.js) ----------
// Delivered here independent of whether any Hmelj window/tab is even open —
// that's the entire point over the older foreground-only notifier in
// app.js. Payload shape: {title, body, icon, tag, test, data:{accountId, folder, uid}}
// — `test` (top-level, separate from `data`) marks Settings' "Send test
// notification", see the focused-check below. `sentAt`/`staleAfterMs`/
// `staleBody` are the late-delivery handling immediately below.

// How late a push has to be before it's treated as a replay of something
// that happened while this device was away rather than as news. The server
// sends its own answer (its push TTL plus slack, so raising that one knob
// moves both ends — see config.pushTtlSeconds); this is only the fallback
// for a push from a server predating that. Rough by nature either way: the
// browser and the server each stamp their own clock here, which is why the
// slack exists, and the only thing it decides between is the real
// notification or a single "while you were away" line.
const STALE_PUSH_MS = 20 * 60e3;

self.addEventListener('push', (e) => {
  let data = {};
  // A payload that won't parse still has to end in a visible notification —
  // see the userVisibleOnly note below.
  try { data = e.data ? e.data.json() : {}; } catch { data = {}; }
  e.waitUntil((async () => {
    // Any open Hmelj window/tab — focused or just sitting in a background
    // tab — gets told to quietly refresh its own counts/badges right now
    // (reconcileMessages/reconcileFolders, see the 'hmelj-refresh' listener
    // in app.js) instead of waiting on its own ~15s poll to eventually
    // notice.
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clientsList) c.postMessage({ type: 'hmelj-refresh' });

    // A push the push service was holding for us while this browser wasn't
    // running (see server/push.js's TTL/topic) can still arrive minutes
    // late, and when several were queued they all land at once — the
    // "switched the laptop on and Firefox replayed everything I already
    // read on my phone" report. Those are answered with ONE collapsed
    // entry (fixed tag, so the whole burst folds into a single tray item,
    // silent, no repeated alert) rather than a wall of stale mail, and the
    // badge is re-read from the server rather than trusted from a payload
    // that was composed before any of it was read. `test` pushes are never
    // treated this way — the whole point of that button is to see the real
    // thing arrive.
    const sentAt = Number(data.sentAt) || 0;
    const staleAfter = Number(data.staleAfterMs) || STALE_PUSH_MS;
    const stale = !data.test && !data.badgeOnly && sentAt > 0 && Date.now() - sentAt > staleAfter;

    // The launcher/dock/home-screen badge, straight from the payload — this
    // is the only thing that can keep it correct while the app is CLOSED
    // (nothing else runs then), and it's what lets the badge go DOWN after
    // mail is read somewhere else, not just up when mail arrives.
    await setBadge(data.unreadTotal);
    if (stale) {
      await refreshBadgeFromServerThrottled();
      // No action buttons here deliberately: this stands for an unknown
      // number of messages the way the "N more" summary does, and a Delete
      // on a notification that may be hours old and already dealt with
      // elsewhere is the one action you can't take back.
      return self.registration.showNotification('Hmelj', {
        body: data.staleBody || 'New mail arrived while you were away',
        icon: data.icon || '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: 'hmelj-away',
        renotify: false,
        silent: true,
        data: { accountId: data.data?.accountId },
      });
    }

    // IMPORTANT: every path out of this handler from here on must call
    // showNotification(). Chrome enforces userVisibleOnly — a push that
    // shows nothing burns budget, surfaces the "This site has been updated
    // in the background" notification instead, and after repeated offences
    // REVOKES the subscription outright. That is a real candidate for
    // "notifications worked for a while and then silently stopped."
    //
    // This used to return early whenever any client reported .focused, to
    // avoid a redundant popup over a window you're already looking at. Two
    // problems: it was by far the most frequent path (so it burned budget
    // constantly), and `focused` is unreliable on Android — a PWA the user
    // isn't actually looking at can still report focused after a resume, so
    // real mail was silently swallowed. Now a focused client only makes the
    // notification silent rather than suppressing it.
    const focused = !data.test && clientsList.some((c) => c.focused);
    await self.registration.showNotification(data.title || 'Hmelj', {
      body: data.body || '',
      icon: data.icon || '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag,
      silent: focused,
      // Without this, a second notification reusing the same `tag` (the
      // test button always does — 'hmelj-test' every time; real mail never
      // does, each message has its own uid-based tag) silently replaces the
      // first in the tray with no new alert/heads-up, so repeat presses
      // after the first one can look like they simply stopped arriving.
      // Pointless (and contradictory) when we've deliberately gone silent.
      renotify: !focused,
      data: data.data || {},
      // Mark as read / Delete — see the notificationclick handler below.
      // Titles arrive already translated into the recipient's own Hmelj
      // language (server/sync.js#notificationActions): nothing of ours is
      // running on this device to translate them afterwards, and I18n isn't
      // loaded in a service worker anyway.
      //
      // Rendered as real buttons by Chrome/Edge (desktop and Android, tab or
      // installed PWA). Firefox and iOS Safari have never implemented
      // notification actions — they ignore this array silently, leaving the
      // default tap-to-open there, which is why the native Android app builds
      // its own buttons from the same payload instead of relying on this.
      actions: data.actions || [],
    });
  })());
});

/**
 * The browser rotated this device's push subscription out from under us.
 *
 * This happens on its own — certificate/quota churn in the push service, a
 * profile restore, a browser update — and there was no handler at all, so the
 * server kept its now-dead endpoint, every notification to it failed, it got
 * pruned as gone, and this device silently never received another one. The
 * page-side ensurePushRegistered() repairs it on the next load; this repairs
 * it immediately, without needing the app to be opened.
 *
 * `newSubscription` is populated by some browsers and not others, so
 * re-subscribing with the old subscription's own applicationServerKey is the
 * portable path (we can't read /api/session's VAPID key without a session).
 */
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    try {
      const key = e.oldSubscription?.options?.applicationServerKey;
      const sub = e.newSubscription
        || (key && await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      if (!sub) return;
      await apiPost('/api/push/subscribe', { subscription: sub.toJSON(), ua: self.navigator.userAgent });
    } catch { /* no session, or offline — ensurePushRegistered() catches it on the next page load */ }
  })());
});

/** Same request shape public/js/api.js's flags()/deleteMsgs() build —
 * same-origin fetch sends the session cookie automatically, no auth
 * plumbing needed here. */
async function apiPost(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
}

async function refreshOpenClients() {
  const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clientsList) c.postMessage({ type: 'hmelj-refresh' });
}

/** As refreshBadgeFromServer, but at most once every half minute: a queued
 * burst of stale pushes is delivered all at once, and they all want the same
 * one number. */
let lastBadgeRefresh = 0;
async function refreshBadgeFromServerThrottled() {
  if (Date.now() - lastBadgeRefresh < 30e3) return;
  lastBadgeRefresh = Date.now();
  return refreshBadgeFromServer();
}

/** Re-read the authoritative unread total and apply it to the app badge. */
async function refreshBadgeFromServer() {
  try {
    const res = await fetch('/api/unread');
    if (!res.ok) return;
    await setBadge((await res.json()).total);
  } catch { /* offline — the next push or page load fixes it */ }
}

/** Focus an already-open Hmelj window and hand it the message to open, or
 * open a fresh one that'll do the same once it boots (see the
 * msgAccount/msgFolder/msgUid handling at the bottom of app.js). This is
 * the default tap behavior, and — on platforms without action-button
 * support (notably iOS Safari, see the plan doc) — the ONLY behavior. */
async function openOrFocusMessage(accountId, folder, uid) {
  const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const target = clientsList[0];
  if (target) {
    target.postMessage({ type: 'hmelj-open-message', accountId, folder, uid });
    return target.focus();
  }
  const params = new URLSearchParams();
  if (accountId) params.set('msgAccount', accountId);
  if (folder) params.set('msgFolder', folder);
  if (uid) params.set('msgUid', uid);
  return self.clients.openWindow('/?' + params.toString());
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { accountId, folder, uid } = e.notification.data || {};
  const action = e.action; // '' for a plain tap; 'read'/'delete' for the action buttons above (Android/desktop only)
  e.waitUntil((async () => {
    if ((action === 'read' || action === 'delete') && folder && uid !== undefined) {
      try {
        // Only when we actually have one: '?account=undefined' is not the same
        // as leaving it off (the server would look for an account by that id
        // and 400), and the "N more" summary push carries no accountId.
        const acct = accountId ? '?account=' + encodeURIComponent(accountId) : '';
        if (action === 'read') {
          await apiPost(`/api/messages/${encodeURIComponent(folder)}/flags${acct}`, { uids: [uid], add: ['\\Seen'], remove: [] });
        } else {
          await apiPost(`/api/messages/${encodeURIComponent(folder)}/delete${acct}`, { uids: [uid] });
        }
        // Handling the action from the tray changed the unread count, and
        // with no window open nothing else would correct the badge — it would
        // sit one too high until the app was next opened. /api/unread is the
        // same authoritative number the page uses (server/unread.js).
        await refreshBadgeFromServer();
        return refreshOpenClients(); // done entirely in the background — no window needs to open for this to work
      } catch (err) {
        // Most likely this device is offline right now (same-origin fetch
        // already carries the session cookie automatically, so auth isn't
        // the likely failure). Rather than silently lose the action, fall
        // through to opening/focusing the app instead — its own
        // online/offline handling can pick this up once connectivity is
        // back, instead of the tap just doing nothing with no feedback.
      }
    }
    return openOrFocusMessage(accountId, folder, uid);
  })());
});
