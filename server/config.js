import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const bool = (v, d = false) => (v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

function readVersion() {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; }
  catch { return '0.0.0'; }
}

const dataDir = process.env.DATA_DIR || new URL('../data', import.meta.url).pathname;

export const config = {
  version: readVersion(),
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  // The SQLite message cache (server/cache.js) writes constantly — every
  // background sync tick. better-sqlite3 writes are SYNCHRONOUS, so if this
  // file sits on slow storage (a network mount/NAS share), those writes can
  // block Node's entire event loop, stalling completely unrelated work
  // (interactive IMAP requests, HTTP responses) for as long as the write
  // takes. Defaults to living alongside the rest of DATA_DIR, but can be
  // pointed at fast local disk independently if DATA_DIR itself is on
  // network storage.
  cacheDir: process.env.CACHE_DIR || dataDir,
  // Allow new Hmelj users to register themselves. Set to false once your
  // household/team has their accounts.
  allowSignup: bool(process.env.ALLOW_SIGNUP, true),
  // How often the background poller checks each mail account for new
  // messages (ms). Keep >= 30s to stay a good IMAP citizen.
  syncIntervalMs: Math.max(30e3, int(process.env.SYNC_INTERVAL_MS, 120e3)),
  // How often the background poller asks each contact source what has changed
  // (server/contactSyncRunner.js). Much cheaper than the mail poll — a run that
  // finds nothing costs one request per address book, no bodies transferred —
  // so the default is longer only because contacts change far less often than
  // mail arrives, not because it is expensive. Floor of 60s to stay a good
  // citizen against somebody else's server.
  contactSyncIntervalMs: Math.max(60e3, int(process.env.CONTACT_SYNC_INTERVAL_MS, 300e3)),

  // How often the background poller checks each synced calendar (milliseconds,
  // minimum 60000). Default 300000 (5 minutes).
  calendarSyncIntervalMs: Math.max(60e3, int(process.env.CALENDAR_SYNC_INTERVAL_MS, 300e3)),
  // How far back and ahead a calendar is kept.
  //
  // These only affect Microsoft 365 and Exchange. Those two expand their own
  // recurrence over a window rather than handing over the rules (see
  // server/calendar/graphCalendar.js for why asking them to is both less code
  // and more correct), so their calendars are known over exactly this range and
  // no further. A CalDAV or Google calendar stores the rules themselves and is
  // known for all time regardless of what these say.
  //
  // Widening them costs a slightly larger response per poll, not more requests.
  calendarWindowPastDays: Math.max(1, int(process.env.CALENDAR_WINDOW_PAST_DAYS, 120)),
  calendarWindowFutureDays: Math.max(1, int(process.env.CALENDAR_WINDOW_FUTURE_DAYS, 550)),
  // Kill switch for the background sync poller + SQLite cache (server/sync.js,
  // server/cache.js). When false, the poller never starts and the unified
  // Inbox/Sent views fall back to live per-account IMAP fetches merged in
  // memory (slower, but a smaller/simpler surface — no cache to go stale or
  // drift from what's actually on the mail server). Per-account folder
  // browsing (/api/messages/:folder) always hits IMAP directly regardless of
  // this setting; it never depended on the cache.
  cacheEnabled: bool(process.env.CACHE_ENABLED, true),
  // How much memory (MB) may be spent holding already-extracted attachment
  // bytes, so that clicking a second attachment on the same message — or the
  // same one again after the browser has forgotten it — doesn't re-download
  // and re-parse the whole message (server/attachmentCache.js). RAM only, and
  // never written to disk. 0 turns it off entirely.
  attachmentCacheBytes: Math.max(0, int(process.env.ATTACHMENT_CACHE_MB, 32)) * 1024 * 1024,
  // error | warn | info | debug — see server/log.js
  logLevel: (process.env.LOG || 'info').toLowerCase(),
  // Public base URL of this instance, e.g. https://mail.example.com — no
  // trailing slash. Only OAuth needs it (server/oauth.js): the redirect_uri
  // sent to Microsoft has to match the one registered with them byte for byte,
  // and it is also what the Admin UI shows you to copy into the app
  // registration. Left empty, it's derived per request from
  // X-Forwarded-Proto/X-Forwarded-Host/Host, which is right for the common
  // nginx/Caddy setup — set it explicitly if that guess ever comes out wrong.
  publicUrl: (process.env.HMELJ_PUBLIC_URL || '').replace(/\/+$/, ''),
  // Web Push (server/push.js) — background "new mail" notifications, even
  // with Hmelj fully closed. Generate a keypair once with `npm run
  // vapid-keys` and set both here; changing them later invalidates every
  // device's existing push subscription (they'd need to re-enable
  // notifications). vapidSubject must be a mailto: or https: URL — some
  // push services (FCM in particular) use it to contact you if your server
  // is misbehaving, and reject requests without one.
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@localhost',
  // How long a push service may keep holding a new-mail notification for a
  // device it can't currently reach (seconds). This is the whole answer to
  // "I turned my laptop on and Firefox popped a wall of notifications for
  // mail I read on my phone hours ago": a browser only talks to its push
  // service while it is RUNNING, so everything sent in the meantime sits in
  // that service's queue and is delivered in one burst at startup. Mozilla's
  // autopush, FCM and Apple all honour this TTL and simply drop what has
  // outlived it.
  //
  // 15 minutes is deliberately short: it still covers a suspended laptop, a
  // dropped Wi-Fi link or a Doze window, while anything older has stopped
  // being news — the mail is in the mailbox, and the app shows it correctly
  // the moment it's opened. Set PUSH_TTL_SECONDS higher if you'd rather see
  // late notifications than miss them; 0 means "deliver now or not at all".
  pushTtlSeconds: Math.max(0, int(process.env.PUSH_TTL_SECONDS, 900)),
  // CodexaPush (the native Android app shell wrapping Hmelj in a WebView —
  // see public/js/app.js's codexaPushSupported()) delivers push through FCM
  // directly rather than Web Push, since a WebView has no Service Worker
  // Push API at all. Needs a Firebase service-account JSON key (Firebase
  // console → Project settings → Service accounts → Generate new private
  // key) — same treatment as HMELJ_SECRET/secret.key: a file living in
  // DATA_DIR, never under public/, never committed. Defaults to the
  // conventional filename right there so the common case needs no env var
  // at all; set FCM_SERVICE_ACCOUNT_PATH to point elsewhere instead.
  fcmServiceAccountPath: process.env.FCM_SERVICE_ACCOUNT_PATH
    ? path.resolve(process.env.FCM_SERVICE_ACCOUNT_PATH)
    : path.join(dataDir, 'fcm-service-account.json'),
  // A RELATIVE FCM_SERVICE_ACCOUNT_PATH resolves against process.cwd(), so
  // whether Android push works at all silently depends on which directory
  // the process was started from: the same .env that works when launched by
  // hand from the repo disables push entirely under a systemd unit with a
  // different WorkingDirectory, saying nothing about it beyond one info line
  // that reads like ordinary "not configured". This is the sensible second
  // place to look — alongside the rest of DATA_DIR, where the file is
  // documented to live — tried only if the primary path doesn't exist.
  // Only meaningful for a relative setting — an absolute one means exactly
  // what it says and has nothing to fall back to.
  fcmServiceAccountFallback: process.env.FCM_SERVICE_ACCOUNT_PATH && !path.isAbsolute(process.env.FCM_SERVICE_ACCOUNT_PATH)
    ? path.resolve(dataDir, process.env.FCM_SERVICE_ACCOUNT_PATH.replace(/^\.?\/?(data\/)?/, ''))
    : null,
};
