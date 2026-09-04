// Hmelj — Web Push (VAPID). Sends a real system notification to a user's
// registered devices for new mail, delivered through the OS/browser's own
// push infrastructure (FCM, APNs-via-Safari) so it arrives even with Hmelj
// fully closed — not just while a tab/installed PWA happens to be running
// (that's the older, foreground-only notifier in public/js/app.js).
//
// Subscriptions are stored per Hmelj login user (store.js, plain JSON —
// see the comment there for why this isn't SQLite), keyed by the
// PushSubscription's own `endpoint` URL, which is unique per
// browser+device+origin registration.
import fs from 'fs';
import crypto from 'crypto';
import webpush from 'web-push';
import { initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { config } from './config.js';
import { store } from './store.js';
import * as pushI18n from './pushI18n.js';
import { log } from './log.js';

const slog = log.scope('push');

export const vapidConfigured = !!(config.vapidPublicKey && config.vapidPrivateKey);
if (vapidConfigured) {
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  // Confirms at a glance (LOG=info is the default) that the keys in .env
  // were actually picked up and accepted by web-push — setVapidDetails
  // throws synchronously on a malformed key, so reaching this line at all
  // already means they're well-formed; this just makes that visible without
  // needing LOG=debug or a test push.
  slog.info(`VAPID configured (public key starts ${config.vapidPublicKey.slice(0, 12)}…, subject ${config.vapidSubject}) — push notifications enabled`);
} else {
  slog.info('VAPID keys not set (see .env.example) — push notifications disabled, foreground-only notifications still work');
}

// FCM (CodexaPush — the native Android app shell wrapping Hmelj in a
// WebView, no Service Worker Push API there at all — see public/js/app.js's
// codexaPushSupported()). Absent-file is the ordinary "not using this"
// case, logged the same low-key way VAPID's own "not set" is — this is a
// fully optional, additive second delivery path. A file that exists but
// won't parse/init is a real misconfiguration worth a louder warning,
// distinct from "not set up yet."
let fcmMessaging = null;
// Both candidates, always logged as ABSOLUTE paths — a relative
// FCM_SERVICE_ACCOUNT_PATH resolves against the process's working directory,
// so "not found" here is far more often a launcher difference than a genuinely
// missing file, and the old message ("No FCM service account file found") gave
// no way to tell those apart. See config.js.
const fcmCandidates = [config.fcmServiceAccountPath, config.fcmServiceAccountFallback].filter(Boolean);
const fcmPath = fcmCandidates.find((p) => fs.existsSync(p));
if (fcmPath) {
  try {
    const serviceAccount = JSON.parse(fs.readFileSync(fcmPath, 'utf8'));
    const app = initializeApp({ credential: cert(serviceAccount) }, 'hmelj-fcm');
    fcmMessaging = getMessaging(app);
    slog.info(`FCM configured from ${fcmPath} (service account: ${serviceAccount.client_email || 'unknown'}) — CodexaPush app notifications enabled`);
  } catch (e) {
    slog.warn(`FCM service account at ${fcmPath} could not be loaded — CodexaPush app notifications disabled:`, e.message);
  }
} else {
  slog.info(`No FCM service account file found (looked in: ${fcmCandidates.join(', ')}; cwd is ${process.cwd()}) — CodexaPush app notifications disabled, everything else unaffected`);
}
export const fcmConfigured = !!fcmMessaging;

/**
 * Add or refresh one device's subscription for the given user. Two shapes
 * share this same store: the original `{endpoint, keys}` browser Web Push
 * subscription (implicit `type: 'webpush'` — every entry predating this
 * still has no `type` field at all, so it's treated as the default rather
 * than requiring a one-time migration), and `{type: 'fcm', token}` for the
 * native Android app shell's CodexaPush bridge (no Service Worker Push API
 * in a WebView — see public/js/app.js's codexaPushSupported()). A user can
 * have both simultaneously — a browser tab AND the installed app are two
 * independent devices, same as any two browser devices already are.
 * Re-subscribing with the same endpoint/token (e.g. re-enabling
 * notifications on a device that already had them) replaces the old entry
 * rather than duplicating it.
 */
export function addSubscription(userKey, sub, ua) {
  const isFcm = sub.type === 'fcm';
  const id = isFcm ? sub.token : sub.endpoint;
  // BEFORE storing it: this device now belongs to this login and to no other.
  claimSubscription(userKey, id);
  const list = store.getPushSubscriptionsFor(userKey)
    .filter((s) => (isFcm ? s.token !== sub.token : s.endpoint !== sub.endpoint));
  list.push(isFcm
    ? { type: 'fcm', token: sub.token, ua: ua || '', createdAt: new Date().toISOString() }
    : { type: 'webpush', endpoint: sub.endpoint, keys: sub.keys, ua: ua || '', createdAt: new Date().toISOString() });
  store.savePushSubscriptionsFor(userKey, list);
  resetBadgeDedupe(userKey); // a new device hasn't been told any count yet
  slog.info(`${userKey}: registered a ${isFcm ? 'CodexaPush (FCM)' : 'Web Push'} subscription (${ua || 'unknown device'}) — ${list.length} total for this user`);
}

/**
 * One device, one owner.
 *
 * A Web Push endpoint (and an FCM token) identifies a BROWSER PROFILE at an
 * origin, not a person — the browser hands back the same subscription
 * regardless of who is logged into Hmelj at the time. So when a second Hmelj
 * user signs in on a device that already had push registered, the page's
 * boot-time repair (app.js#ensurePushRegistered) sees the endpoint missing
 * from *their* device list, re-subscribes, gets that same endpoint back, and
 * posts it under their login. Nothing removed it from the first user's list,
 * because addSubscription only ever de-duplicated WITHIN one user.
 *
 * The result was a genuine privacy leak, not just clutter: server/sync.js
 * sends each user's new-mail notifications to every endpoint registered to
 * them, so that one shared browser received notifications — sender, subject
 * and a body preview — for both people's private mailboxes. Observed in the
 * wild: one Firefox profile registered under two household logins, nine days
 * apart.
 *
 * Registering is therefore a CLAIM: the endpoint is taken away from every
 * other user first. The most recent sign-in on a device wins, which is the
 * only answer that can be right — it is the person actually using it.
 */
function claimSubscription(userKey, id) {
  if (!id) return;
  for (const other of store.listUserKeys()) {
    if (other === userKey) continue;
    const list = store.getPushSubscriptionsFor(other);
    const kept = list.filter((s) => s.endpoint !== id && s.token !== id);
    if (kept.length === list.length) continue;
    store.savePushSubscriptionsFor(other, kept);
    resetBadgeDedupe(other);
    slog.warn(`Device re-registered under ${userKey} — removed it from ${other}, which would otherwise have kept receiving that user's mail notifications on it`);
  }
}

/**
 * Boot-time repair for devices that are already registered under more than one
 * user, from before registering became a claim (see claimSubscription).
 *
 * Those users' notifications are ALL being delivered to that one device right
 * now, and nothing self-corrects: the page only re-registers when it finds its
 * own endpoint missing, which is exactly what a duplicate stops it noticing.
 * Newest registration wins — the last person to sign in there. Runs once at
 * startup, costs one small JSON read per user, and normally finds nothing.
 */
export function reconcileSubscriptionOwners() {
  const owners = new Map(); // endpoint/token -> [{ key, createdAt }]
  for (const key of store.listUserKeys()) {
    for (const s of store.getPushSubscriptionsFor(key)) {
      const id = s.endpoint || s.token;
      if (!id) continue;
      if (!owners.has(id)) owners.set(id, []);
      owners.get(id).push({ key, createdAt: s.createdAt || '' });
    }
  }
  let fixed = 0;
  for (const [id, claims] of owners) {
    if (claims.length < 2) continue;
    // Undated entries lose to dated ones; among undated, the first seen wins.
    const winner = claims.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    for (const c of claims) {
      if (c.key === winner.key) continue;
      store.savePushSubscriptionsFor(c.key, store.getPushSubscriptionsFor(c.key).filter((s) => s.endpoint !== id && s.token !== id));
      resetBadgeDedupe(c.key);
      fixed++;
      slog.warn(`One device was registered for push under both ${c.key} and ${winner.key} — it was receiving BOTH users' mail notifications. Kept the newer registration (${winner.key}); removed ${c.key}'s.`);
    }
  }
  if (fixed) slog.warn(`Push device ownership repaired: ${fixed} stale registration(s) removed. Affected users may need to re-enable notifications on that device.`);
  return fixed;
}

// `id` is either a webpush endpoint URL or an FCM token — public/js/api.js's
// pushUnsubscribe() (and the DELETE /api/push/subscribe/:endpoint route)
// share one call shape for both, so this just checks whichever field a
// given stored entry actually has.
export function removeSubscription(userKey, id) {
  const list = store.getPushSubscriptionsFor(userKey).filter((s) => s.endpoint !== id && s.token !== id);
  store.savePushSubscriptionsFor(userKey, list);
  slog.info(`${userKey}: removed a push subscription — ${list.length} remaining for this user`);
}

/** Devices registered for `userKey` — safe to expose to the client minus the raw keys. */
export function listSubscriptions(userKey) {
  return store.getPushSubscriptionsFor(userKey).map(({ type, endpoint, token, ua, createdAt }) => ({ type: type || 'webpush', endpoint, token, ua, createdAt }));
}

/** Cheap early-out for sync.js: skip building a notification payload entirely
 * (incl. the per-message getMessage() fetch for a preview — see Phase 2) for
 * a user who has never enabled push, or when neither delivery path is
 * configured at all. */
export function hasSubscriptions(userKey) {
  return (vapidConfigured || fcmConfigured) && store.getPushSubscriptionsFor(userKey).length > 0;
}

// Short "Chrome/Android (…8f3a2c1d)" label for log lines — the raw endpoint/
// token is long and mostly noise, but its last few characters are enough to
// tell two devices with an identical UA string apart across log lines.
function deviceLabel(s) {
  const ua = s.ua || '';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'device';
  const browser = s.type === 'fcm' ? 'CodexaPush app'
    : /Firefox/.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'browser';
  const id = s.type === 'fcm' ? s.token : s.endpoint;
  return `${browser}/${os} (…${(id || '').slice(-8)})`;
}

/**
 * Push `payload` (plain object, JSON-serialized here) to every device
 * registered for `userKey`. Must be called from inside that user's ALS
 * context (store.js reads currentUser().userKey) — true both for a live
 * request and for sync.js's background poll context (runAsAccount sets one
 * up either way).
 *
 * Logged at info level deliberately (not debug) — this is the one place
 * that can tell you whether a notification actually left the server at
 * all, and for which device. IMPORTANT: a successful send here only means
 * the push SERVICE (Google FCM for Chrome, Mozilla's autopush for Firefox,
 * Apple's relay for Safari) accepted the message for delivery — whether it
 * then actually reaches and wakes that specific device is entirely between
 * that service and the OS/browser, invisible to this server. If this logs
 * success for a device but nothing shows up there, the problem is on the
 * device/OS side (background restrictions, battery optimization, network
 * reachability of the push service from that device, etc.), not here.
 *
 * A dead endpoint (device uninstalled the PWA, revoked permission, or the
 * push service itself expired the registration) comes back as a 404/410 —
 * the standard signal to stop trying it; pruned here so a stale device
 * doesn't cost a failed request on every future notification forever.
 */
/** One retry pass with backoff for the errors that are worth retrying.
 *
 * Everything that wasn't a dead-subscription signal used to be logged once
 * and dropped, so a single transient (FCM `server-unavailable`/`internal`, a
 * push service 429/500, a momentary DNS blip) silently cost that message its
 * notification entirely — indistinguishable, from the user's side, from push
 * being broken. */
async function withRetries(label, attempt, isPermanent, tries = 3) {
  let delay = 400;
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (isPermanent(e) || i >= tries) throw e;
      slog.debug(`  -> ${label}: attempt ${i} failed (${e.code || e.statusCode || ''}), retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      delay *= 3;
    }
  }
}

// Read-modify-write of one user's subscriptions file, serialized per user.
// Accounts are polled concurrently (sync.js), so two pushes for the same user
// could each read the list, each drop their own dead entry, and the second
// write would resurrect what the first removed.
const pruneQueues = new Map();
function queuePrune(userKey, dead) {
  const prev = pruneQueues.get(userKey) || Promise.resolve();
  const next = prev.then(() => {
    const kept = store.getPushSubscriptionsFor(userKey).filter((s) => !dead.includes(s.endpoint) && !dead.includes(s.token));
    store.savePushSubscriptionsFor(userKey, kept);
  }).catch((e) => slog.warn(`${userKey}: pruning dead subscriptions failed:`, e.message));
  pruneQueues.set(userKey, next);
  return next;
}

/**
 * The Web Push `Topic` header — the direct counterpart of the FCM
 * collapseKey below, and half the answer to "my laptop was off all evening
 * and Firefox opened with a wall of notifications".
 *
 * A browser only holds a connection to its push service while it is
 * RUNNING, so everything sent while it was closed sits in that service's
 * queue and arrives in one burst at startup. A Topic makes each new push
 * REPLACE the queued one it shares a topic with (RFC 8030 §5.4), so that
 * burst collapses to the newest notification per account — one "you have
 * mail", not forty. Nothing changes for a device that's actually online:
 * there's never anything queued to replace.
 *
 * The header is limited to 32 url-safe-base64 characters, which an account
 * id is not, hence the hash.
 */
function pushTopic(payload) {
  // Web Push's `topic` collapses whatever the push service is still holding for
  // an unreachable device down to the newest one per topic. For mail that is the
  // point — a laptop switched on after hours should not replay every message.
  // For a calendar reminder it would be a bug: two different meetings are not
  // two versions of the same news, and collapsing them means waking up to
  // exactly one of the three appointments you were reminded about.
  const key = payload.badgeOnly
    ? `badge-${payload.accountId || 'all'}`
    : payload.kind === 'calendar'
      ? `cal-${payload.tag || 'all'}`
      : `mail-${payload.data?.accountId || 'all'}`;
  return crypto.createHash('sha256').update(key).digest('base64url').slice(0, 24);
}

/**
 * `opts.fcmOnly` skips Web Push entirely. Used for badge-only updates (see
 * sync.js): the native Android shell can act on a data message without
 * showing anything, but a browser Service Worker can't — Chrome's
 * userVisibleOnly contract requires a visible notification for every push it
 * delivers, and silently violating it burns budget and eventually gets the
 * subscription revoked.
 */
export async function sendPushToUser(userKey, payload, opts = {}) {
  if (!vapidConfigured && !fcmConfigured) { slog.debug(`Not sending to ${userKey} — no push delivery path configured`); return; }
  let subs = store.getPushSubscriptionsFor(userKey);
  if (opts.fcmOnly) subs = subs.filter((s) => s.type === 'fcm');
  if (!subs.length) { slog.debug(`Not sending to ${userKey} — no registered devices`); return; }
  slog.info(`${userKey}: sending "${payload.title || (payload.badgeOnly ? `badge ${payload.unreadTotal}` : 'push')}" to ${subs.length} device(s)`);
  // `sentAt` lets the receiving end tell a live notification from one that
  // was queued by the push service while the device was off and handed over
  // late (sw.js collapses those into a single "while you were away" entry
  // instead of replaying a stale tray). `staleBody` is the text for it,
  // resolved here because that's the last place that knows which language
  // this particular recipient reads Hmelj in — same reasoning as the action
  // titles in sync.js#notificationActions.
  const body = JSON.stringify(payload.badgeOnly ? { ...payload, sentAt: Date.now() } : {
    ...payload,
    sentAt: Date.now(),
    // The receiving end can't know this server's TTL, and hard-coding a
    // matching number there would silently stop matching the moment
    // PUSH_TTL_SECONDS is changed. The slack covers the clock difference
    // between this machine and the device, which is the only reason both
    // ends need to agree at all.
    staleAfterMs: (config.pushTtlSeconds + 300) * 1000,
    // Mail only. A calendar reminder is never collapsed into a "while you were
    // away" line (see public/sw.js): there is never a burst of them, and one
    // folded into a sentence about mail would be actively wrong. Sending the
    // string anyway would be harmless but misleading to read in a payload dump.
    ...(payload.kind === 'calendar' ? {} : {
      staleBody: pushI18n.t(store.getSettingsFor(userKey).language || 'en', 'New mail arrived while you were away'),
    }),
  });
  const dead = [];
  await Promise.all(subs.map(async (s) => {
    const label = deviceLabel(s);
    if (s.type === 'fcm') {
      if (!fcmMessaging) { slog.debug(`  -> ${label}: FCM not configured — skipping`); return; }
      try {
        // Data-only message (no top-level `notification` key) — same
        // reasoning as sw.js's own push handler building its own
        // showNotification() call from the raw payload rather than letting
        // the push service auto-display something: the native app shell
        // gets to fully control rendering (its own channel, icon, Mark as
        // read/Delete actions) instead of Google's generic auto-display,
        // which doesn't support action buttons at all. `payload` here is
        // JSON.stringify'd whole (FCM data values must all be strings) —
        // the SAME shape sw.js already parses on the Web Push side
        // ({title, body, icon, tag, test, data:{accountId,folder,uid},
        // actions}), so the native app's own handler can parse it
        // identically. android.priority:'high' is FCM's equivalent of
        // web-push's urgency:'high' above — same Doze-deferral reasoning.
        await withRetries(label, () => fcmMessaging.send({
          token: s.token,
          data: { payload: body },
          android: {
            priority: 'high',
            // Without an explicit TTL, FCM keeps an undelivered message for
            // its 4-WEEK default — a push deferred while the phone was off
            // could surface days later announcing "new mail" that's long
            // since been read. An hour is well past any normal Doze window
            // and short enough that a late one is never nonsense.
            ttl: 3600 * 1000,
            // Collapse per account+kind, so a device that was offline through
            // a burst wakes to the latest state rather than a queue of
            // superseded messages. Badge updates especially: only the newest
            // number means anything.
            // Per KIND, and for a calendar reminder per occurrence: collapsing
            // every reminder into one key would mean a phone that was off for
            // an hour woke to exactly one of the meetings it missed, which is
            // the opposite of what a reminder is for.
            collapseKey: payload.badgeOnly
              ? `hmelj-badge-${payload.accountId || 'all'}`
              : payload.kind === 'calendar'
                ? (payload.tag || 'hmelj-cal')
                : `hmelj-mail-${payload.data?.accountId || 'all'}`,
          },
        }), (e) => e.code === 'messaging/registration-token-not-registered'
              || e.code === 'messaging/invalid-registration-token'
              || e.code === 'messaging/invalid-argument');
        slog.info(`  -> ${label}: accepted by FCM`);
      } catch (e) {
        if (e.code === 'messaging/registration-token-not-registered' || e.code === 'messaging/invalid-registration-token') {
          dead.push(s.token);
          slog.info(`  -> ${label}: token gone (${e.code}) — pruning it`);
        } else {
          slog.warn(`  -> ${label}: FCM send failed after retries — ${e.code || ''} ${e.message || e}`);
        }
      }
      return;
    }
    try {
      // urgency:'high' matters specifically for Android: FCM defers
      // normal-priority messages to the device's next Doze/App-Standby
      // maintenance window (this is almost certainly the real explanation
      // for "delivered once with a long delay, then nothing" — the server
      // handing off to FCM successfully every time says nothing about when
      // Android actually wakes Chrome for a NORMAL-priority one). 'high'
      // tells FCM this is allowed to wake the device immediately, same
      // priority class a messaging app's incoming-message push would use.
      // TTL (seconds) bounds how long the push service keeps holding this if
      // the device can't be reached, and `topic` collapses whatever it is
      // still holding for that device down to the newest one per account —
      // together, what stops a laptop that was switched off for hours from
      // opening onto a replay of every notification it missed. See
      // config.pushTtlSeconds and pushTopic above.
      await withRetries(label,
        () => webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body,
          // A calendar reminder is worth less the later it lands, and past its
          // event it is worth nothing — so it is held for much less time than
          // mail, which stays useful because the message is in the mailbox
          // regardless of when the notification shows up.
          { urgency: 'high',
            TTL: payload.kind === 'calendar' ? Math.min(config.pushTtlSeconds, 600) : config.pushTtlSeconds,
            topic: pushTopic(payload) }),
        (e) => e.statusCode === 404 || e.statusCode === 410 || e.statusCode === 400 || e.statusCode === 403);
      slog.info(`  -> ${label}: accepted by push service`);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        dead.push(s.endpoint);
        slog.info(`  -> ${label}: subscription gone (${e.statusCode}) — pruning it`);
      } else {
        slog.warn(`  -> ${label}: push failed after retries — ${e.statusCode || ''} ${e.body || e.message || e}`);
      }
    }
  }));
  // `dead` holds a mix of webpush endpoints and FCM tokens — checking both
  // fields is safe either way, since a given entry only ever has the one that
  // applies to its own type.
  if (dead.length) await queuePrune(userKey, dead);
}

/**
 * A push whose only job is to correct a device's unread badge — no title, no
 * body, nothing shown. Sent when the total goes DOWN (mail read on another
 * device), which nothing else could communicate to a closed app: the badge
 * could previously only ever be nudged upward by an arriving notification,
 * so once it was wrong it stayed wrong until the app was next opened.
 *
 * FCM only, deliberately — see sendPushToUser's `fcmOnly`.
 */
const lastBadgeSent = new Map(); // userKey -> the last total we pushed

export async function sendBadgeUpdate(userKey, unreadTotal, accountId) {
  if (!fcmConfigured) return;
  if (typeof unreadTotal !== 'number') return;
  // One push per actual change in the number, not per folder that noticed it.
  // Drift is detected per folder, so a bulk "mark all read" across five
  // in-scope folders would otherwise fire five identical silent pushes at a
  // phone in the same cycle — same battery and data cost as five real
  // notifications, for one badge value.
  if (lastBadgeSent.get(userKey) === unreadTotal) return;
  lastBadgeSent.set(userKey, unreadTotal);
  await sendPushToUser(userKey, { badgeOnly: true, unreadTotal, accountId }, { fcmOnly: true });
}

/** Forget the deduplication state for a user — called when their device list
 * changes, so a newly-registered device gets the current count rather than
 * being skipped because the number happens to match what the LAST device was
 * already told. */
function resetBadgeDedupe(userKey) { lastBadgeSent.delete(userKey); }
