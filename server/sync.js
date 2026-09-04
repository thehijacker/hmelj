// Hmelj — background mail sync. Nothing polled IMAP on its own before this;
// every fetch was strictly on-demand from a browser request. This adds a
// server-side interval poller (config.syncIntervalMs, default 120s) that
// keeps the SQLite cache (cache.js) warm so the unified Inbox/Sent view is
// instant, so "new mail arrived" can be detected without the user having a
// tab open, and so filters run automatically as mail arrives rather than
// only when a client explicitly asks.
//
// Runs independently of login sessions: mail account passwords are
// encrypted with a server-wide secret (accounts.js), not anything tied to a
// user's login, and userKey is a pure function of the username — so
// session.js#runAsUser/runAsAccount can build a valid request-shaped context
// for any user at any time, logged in or not.
import { config } from './config.js';
import { listUsers, runAsUser, runAsAccount, userKey } from './session.js';
import * as accountsStore from './accounts.js';
import * as imap from './mailClient.js';
import * as cache from './cache.js';
import { store } from './store.js';
import { runFilters, claimFiled } from './filters.js';
import { learnSenderNames } from './contacts.js';
import * as userLog from './userLog.js';
import * as push from './push.js';
import * as contentCache from './contentCache.js';
import * as filterState from './filterState.js';
import * as events from './events.js';
import { isSyncScope } from './scope.js';
import * as unread from './unread.js';
import * as schedule from './schedule.js';
import * as pushI18n from './pushI18n.js';
import * as subjectRules from './subjectRules.js';
import * as idle from './idle.js';
import sanitizeHtml from 'sanitize-html';
import { previewText } from './notifyText.js';
import { log } from './log.js';

const slog = log.scope('sync');

// Fallback only — the real value is the user's own syncBackfillLimit setting
// (Settings > General > "Messages kept per folder", default 250). Read live
// per call (via store.getSettings(), inside the caller's ALS user context)
// rather than cached once, so changing it takes effect on the very next
// sync tick instead of requiring a restart.
const DEFAULT_BACKFILL_LIMIT = 250;

// Only sync what the unified view / new-mail detection actually need — NOT
// every folder/label the account has. This matters a lot for Gmail: besides
// INBOX it exposes [Gmail]/All Mail (contains literally every message),
// Starred, Important, Spam, Trash, plus any custom labels, all as top-level
// "folders" alongside INBOX. The rule itself lives in server/scope.js now,
// shared with the unread-count route so the two can't drift apart — see the
// comment at the top of that file for why they used to.

const inFlightAccounts = new Set();
const backoff = new Map(); // accountId -> { failCount, nextAttemptAt }

// After a folder's first full sync, most ticks only need to ask "anything
// newer?" (cheap — see imapClient.js#listNewMessages) instead of re-running
// the full candidate/date-verification pass on every single poll forever.
// That incremental check can't see flag changes or deletions made on
// already-cached messages by another client (webmail, phone, Roundcube...),
// so every Nth tick still does a full pass to reconcile drift — infrequent
// enough that the recurring cost stays low, frequent enough that drift
// doesn't linger for too long.
const FULL_RESYNC_EVERY_N_TICKS = 10; // ~20 minutes at the default 120s interval
const tickCounts = new Map(); // accountId -> how many cycles this account has run

// Individual new-mail notifications per folder per tick. Anything past this
// is folded into one "N more" summary rather than dropped (see notifyNewMail)
// — a tray full of 30 notifications is its own kind of broken, but so is
// silently telling you about 3 of them.
const NOTIFY_MAX_PER_FOLDER = 5;

/** Used by the /api/sync/status route to show a "syncing…" indicator. */
export function isSyncing(accountId) {
  return inFlightAccounts.has(accountId);
}

// On-demand syncs in progress (the refresh button, the post-send Sent
// re-check) — deliberately SEPARATE from inFlightAccounts rather than
// reusing it:
//  - the scheduler must treat both the same, so it never starts a second
//    concurrent pass over a mailbox that's already being read (both would
//    queue on that account's one IMAP connection anyway, so the extra pass
//    buys nothing and just makes everything finish later — the reported
//    symptom of a manual refresh that the background poll piles onto);
//  - but /api/sync/status must NOT report an on-demand sync as a background
//    cycle. The client's refresh button refuses to fire while that status
//    says "syncing" and only re-reads it every 15s, so folding the two
//    together would leave the button ignoring clicks for up to 15s after
//    each manual refresh.
const onDemandAccounts = new Set();

/** True if ANY sync is touching this account right now — scheduled or
 * on-demand. What the scheduler and the IDLE watcher gate on. */
function isBusy(accountId) {
  return inFlightAccounts.has(accountId) || onDemandAccounts.has(accountId);
}

/* ---------- writes this server made itself ----------
 *
 * inFlightAccounts above guards sync against sync. Nothing guarded sync
 * against an INTERACTIVE write, and that gap is what corrupted unread counts
 * when messages were marked read/unread quickly:
 *
 *   - Marking a message read wakes the account's own IDLE watcher (the IMAP
 *     `flags` event can't say who made the change), which after a 1s debounce
 *     runs a full folder sync — landing right on top of the NEXT clicks, since
 *     a Gmail STORE round trip takes 1.5-2s.
 *   - That sync reads flags and a STATUS from the server at some instant T and
 *     writes both back afterwards, unconditionally. If one of our own writes
 *     landed after T, the write-back reverts it in SQLite: applyFlagsSnapshot
 *     puts the old read state back on the row, and setFolderCounts stamps the
 *     pre-change unread number over a counter that had already been correctly
 *     adjusted. Badge and rows then disagreed until the next full poll cycle
 *     (up to the account's poll interval, 120s by default) corrected it — the
 *     reported "All inbox says 1 unread but nothing is unread".
 *
 * So: every route that changes mail state records when it did, per folder, and
 * the sync paths below refuse to write back a reading that predates it. The
 * cost of skipping is one cycle's worth of latency on a flag change made by a
 * genuinely different client inside the same few seconds — the next poll picks
 * it up. The cost of NOT skipping was silent, persistent, visible drift.
 */
const localWrites = new Map(); // `${uKey}:${accountId}:${folder}` -> ms timestamp of our last write there
const LOCAL_WRITE_TTL_MS = 60e3;
// How long after one of our own writes a flags-only IDLE wake is assumed to be
// that write coming back to us. Covers the watcher's 1s debounce plus the
// slowest round trip actually measured here (~2s), with room to spare.
const SELF_WAKE_WINDOW_MS = 5000;

/** Called by the mutating routes in index.js right after the change lands on
 * the server (see the comment above). Folder-level granularity is enough:
 * every guard below either applies or skips a whole folder's write-back. */
export function noteLocalWrite(uKey, accountId, folder) {
  const now = Date.now();
  // Bounded without a timer: entries only matter for seconds, so a sweep
  // whenever the map grows is plenty.
  if (localWrites.size > 200) {
    for (const [k, t] of localWrites) if (now - t > LOCAL_WRITE_TTL_MS) localWrites.delete(k);
  }
  localWrites.set(`${uKey}:${accountId}:${folder}`, now);
}

/** Did this server change that folder at or after `since`? */
function localWriteSince(uKey, accountId, folder, since) {
  return (localWrites.get(`${uKey}:${accountId}:${folder}`) || 0) >= since;
}

/** Marks an on-demand sync for the duration of `fn`. Re-entrant: nested
 * on-demand syncs (syncAccountNow is not one today, but refreshSentFolder
 * retries are repeated calls) must not clear an outer one's mark. */
async function withOnDemandMark(accountId, fn) {
  const held = onDemandAccounts.has(accountId);
  if (!held) onDemandAccounts.add(accountId);
  try {
    return await fn();
  } finally {
    if (!held) onDemandAccounts.delete(accountId);
  }
}

function shouldSkip(accountId) {
  const b = backoff.get(accountId);
  return !!(b && Date.now() < b.nextAttemptAt);
}
function recordFailure(accountId) {
  const b = backoff.get(accountId) || { failCount: 0 };
  b.failCount += 1;
  b.nextAttemptAt = Date.now() + Math.min(10 * 60e3, 30e3 * 2 ** (b.failCount - 1)); // capped exponential backoff
  backoff.set(accountId, b);
}
function recordSuccess(accountId) {
  backoff.delete(accountId);
}

const PREVIEW_LEN = 150;

/** Plain-text snippet for a notification body — mailparser's `.text` when the
 * message has one, else `.html` with every tag stripped (reusing
 * sanitize-html rather than a hand-rolled regex against arbitrary,
 * untrusted-formed HTML). '' if the message has no body at all to speak of
 * (e.g. attachment-only), in which case the caller falls back to the subject
 * alone. */
function textPreview(msg) {
  // The cleaning itself lives in server/notifyText.js — see its header for what
  // a mail's "text/plain part" actually turns out to contain in practice, and
  // the counts over 793 real messages that put it there. This is only the two
  // pieces that need a dependency: the HTML→text conversion, and the length.
  //
  // nonTextTags for the same reason sanitizeMessageHtml sets it (see
  // index.js): without it every notification for an HTML mail opened with
  // that mail's <title> instead of its first real line.
  return previewText(msg, {
    maxLen: PREVIEW_LEN,
    htmlToText: (html) => sanitizeHtml(html, {
      allowedTags: [], allowedAttributes: {},
      nonTextTags: ['script', 'style', 'textarea', 'option', 'xmp', 'title', 'xml'],
    }),
  });
}

/**
 * Web Push (server/push.js) for genuinely new unread mail — the same
 * "fresh" set pollFolder already computes for filters (new-to-cache,
 * recently dated, not first sync, not Sent), narrowed to actually unread
 * (a new-to-cache message that already arrived \Seen — a server-side rule,
 * or already read on another client before this cache ever saw it —
 * shouldn't pop a notification). Capped at NOTIFY_MAX_PER_FOLDER individual
 * notifications per folder per tick, with anything beyond that folded into a
 * single "N more" summary rather than silently dropped — a burst of 12 used
 * to produce 3 notifications and no indication the other 9 existed.
 */
/**
 * The two tray buttons on a new-mail notification — handled by public/sw.js's
 * notificationclick listener on the browser/PWA side, and by the Android
 * app's NotificationActionReceiver on the native side. Both act on the
 * `data: {accountId, folder, uid}` carried alongside them.
 *
 * Titles are resolved per RECIPIENT, not per account: a shared account's
 * grantee reads Hmelj in their own language (server/store.js's per-user
 * `language` setting), and these strings are rendered by the OS from the
 * payload — nothing of ours is running on that device to translate them
 * afterwards. See server/pushI18n.js.
 *
 * Omitted deliberately from the "N more" summary below: it stands for several
 * messages, so there is no single uid for a button to act on.
 */
function notificationActions(uKey) {
  const lang = store.getSettingsFor(uKey).language || 'en';
  return [
    { action: 'read', title: pushI18n.t(lang, 'Mark as read') },
    { action: 'delete', title: pushI18n.t(lang, 'Delete') },
  ];
}

async function notifyNewMail(uKey, account, folder, freshMessages) {
  // A shared account's grantees (server/accountOverrides.js) deserve their
  // own new-mail push too, not just whoever
  // owns the credentials — `account` here already carries sharedWith (see
  // listOwnedAccounts/stripSecrets, which only strips imap/smtp/ews, not
  // this). Resolved once per call, not per recipient below.
  const targets = [uKey, ...(account.sharedWith || []).map((s) => userKey(s.username))];
  const active = targets.filter((k) => push.hasSubscriptions(k));
  if (!active.length) return; // no device registered anywhere — nothing to do, and skips the per-message getMessage() fetch below
  // Notification scheduler (server/schedule.js) — after the no-devices early return
  // above, so a schedule is never even evaluated when there's nothing to notify
  // anyway. Explicit-uKey store read: this runs in the background poll loop, not a
  // live request's ALS, so store.getHolidayOverrides()'s ALS-implicit form isn't
  // usable here.
  // Temporary Mute first (folder right-click → Mute): it's a plain timestamp
  // comparison, needs no holiday calendar, and outranks whatever schedule the
  // folder otherwise follows for as long as it lasts.
  const mutedUntil = schedule.folderMutedUntil(account, folder.path);
  if (mutedUntil) {
    slog.debug(`${account.label}/${folder.path}: muted until ${new Date(mutedUntil).toISOString()} — skipping push for ${freshMessages.length} message(s)`);
    return;
  }
  const effective = schedule.resolveEffectiveSchedule(account, folder.path);
  if (effective) {
    const holidayOverrides = store.getHolidayOverridesFor(uKey);
    const customHolidays = store.getCustomHolidaysFor(uKey);
    const workFreeDateSet = schedule.workFreeDateSetFor(new Date().getFullYear(), holidayOverrides, customHolidays);
    if (schedule.isMutedNow(effective, { now: new Date(), workFreeDateSet })) {
      slog.debug(`${account.label}/${folder.path}: notification muted by schedule — skipping push for ${freshMessages.length} message(s)`);
      return;
    }
  }
  // Resolved once for the whole burst rather than per message: `active` is
  // fixed by this point, and each of these is a small per-user JSON read.
  const actionsByKey = new Map(active.map((k) => [k, notificationActions(k)]));
  // Settings > Subject, per RECIPIENT rather than per account — the rules
  // belong to the person, not to the mailbox (server/store.js), so on a shared
  // account the owner's shortenings must not be applied to a grantee's
  // notification. Same "resolve once for the whole burst" reasoning as the
  // actions above: a small per-user JSON read, not one per message.
  const subjectRulesByKey = new Map(active.map((k) => [k, store.getSubjectRulesFor(k)]));
  // NB: not named `unread` — that's the unread-total module imported above,
  // used further down for each recipient's badge count.
  const unreadMessages = freshMessages.filter((m) => !m.seen);
  const notifiable = unreadMessages.slice(0, NOTIFY_MAX_PER_FOLDER);
  for (const m of notifiable) {
    const from = m.from?.name || m.from?.address || '';
    const subject = m.subject || '(no subject)';
    // Best-effort: goes through the same cache-first read the message-open
    // route and the proactive caching below use (server/contentCache.js) —
    // if cacheNewMail (called right before this in pollFolder) already
    // warmed this exact uid this tick, this is a free SQLite read, not a
    // second live fetch of the same message. A failure here (huge
    // attachment timing out, a flaky connection) just falls back to
    // subject-only, never blocks or drops the notification itself.
    //
    // Fetched ONCE, outside the per-recipient loop below: this is the only
    // expensive part here, and it is the same message for everyone. Only the
    // subject in front of it is per person (subjectRulesByKey above), so the
    // body is composed per recipient and the snippet is not re-read.
    let snippet = '';
    try {
      const full = await contentCache.getMessage(uKey, account.id, folder.path, m.uid);
      snippet = textPreview(full) || '';
    } catch (e) {
      slog.debug(`${account.label}/${folder.path}: couldn't fetch preview for uid ${m.uid}:`, e.message);
    }
    const payload = {
      title: from ? `${from} — ${account.label}` : account.label,
      icon: '/icons/icon-192.png',
      tag: `hmelj-${account.id}-${m.uid}`,
      data: { accountId: account.id, folder: folder.path, uid: m.uid },
    };
    // Per RECIPIENT, not per account: the badge shows that user's total
    // across everything they can see, and a shared account's grantee has a
    // different total than its owner. This is what lets a closed app show the
    // right number — nothing else runs there to work it out (see sw.js's
    // setBadge and the Android service's setNumber).
    for (const key of active) {
      // The shown subject is this recipient's own — see subjectRulesByKey.
      const shown = subjectRules.applyRules(subject, subjectRulesByKey.get(key), account.id);
      await push.sendPushToUser(key, {
        ...payload,
        body: snippet ? `${shown}\n${snippet}` : shown,
        actions: actionsByKey.get(key),
        unreadTotal: unread.unreadTotalForKey(key),
      });
    }
  }

  // A burst bigger than the cap used to just lose the remainder silently —
  // 12 messages arriving in one tick produced 3 notifications and no sign
  // that anything else had come. One summary covers the rest.
  const extra = unreadMessages.length - notifiable.length;
  if (extra > 0) {
    const summary = {
      title: account.label,
      body: `${extra} more new message${extra === 1 ? '' : 's'} in ${folder.path}`,
      icon: '/icons/icon-192.png',
      tag: `hmelj-${account.id}-more`,
      data: { accountId: account.id, folder: folder.path },
    };
    for (const key of active) {
      await push.sendPushToUser(key, { ...summary, unreadTotal: unread.unreadTotalForKey(key) });
    }
  }
}

export async function pollFolder(uKey, account, folder, { force = false, limit = null, tick = null } = {}) {
  // The user's own choice (Settings > General), not a fixed constant — read
  // fresh each call (cheap: local JSON file, no network) so a change takes
  // effect on the very next tick.
  const configuredLimit = store.getSettings().syncBackfillLimit || DEFAULT_BACKFILL_LIMIT;
  const path = folder.path;
  const t0 = Date.now();
  // Must be read BEFORE upsertMessages (which writes sync_state via the
  // caller below) — this is how we know whether this is the folder's very
  // first sync, i.e. whether "new" below means "just arrived" or "this
  // account's entire pre-existing backlog, seen for the first time."
  const isFirstSyncOfFolder = !cache.hasSyncedBefore(uKey, account.id, path);
  // Also always full-scan on the very first tick after a process restart
  // (tickCount hits 1 exactly once, right at boot), not just every Nth tick
  // — otherwise a restart gets up to FULL_RESYNC_EVERY_N_TICKS of trusting
  // the on-disk cache as-is before its first reconciliation. Two concrete
  // cases that matters for: (1) drift accumulated from other clients while
  // this process was down (missed the incremental "anything newer?" checks
  // entirely during that window), and (2) a code fix that changes how
  // messages are cached — a stale row written by a since-fixed bug (e.g. a
  // bad envelope-date fallback) only gets corrected when something re-fetches
  // and re-upserts that message, which the cheap incremental path won't do
  // for anything it already considers "seen."
  // `force` is the on-demand escape hatch for the same gap: the cheap
  // incremental path only asks "anything newer?", so flag changes made on
  // another client (phone app, another webmail) against already-cached
  // messages sit invisible here until the next scheduled full pass — up to
  // FULL_RESYNC_EVERY_N_TICKS ticks away. The list pane's refresh button
  // passes force:true (see /api/folders/:path/sync-now) to reconcile that
  // immediately instead of making the user wait for the next scheduled one.
  // `tick` is this ACCOUNT's own cycle number (see pollAccount). null means the
  // caller isn't part of the scheduled rotation (an on-demand sync), where
  // `force` already says whether a full scan is wanted.
  const doFullScan = force || isFirstSyncOfFolder || tick === 1 || (tick != null && tick % FULL_RESYNC_EVERY_N_TICKS === 0);
  // A first-ever sync always backfills up to the user's full configured
  // depth regardless of what an on-demand caller asked for — `limit` caps
  // how deep a "catch up what changed" rescan of an already-cached folder
  // goes (see syncFolderNow), not someone's actual mailbox history the
  // first time it's seen.
  const effectiveLimit = isFirstSyncOfFolder ? configuredLimit : (limit ?? configuredLimit);

  // Sampled before anything writes, and again at the end of the cycle. A
  // full-scan tick re-upserts every message it fetched INCLUDING its current
  // flags, so a "read on another client" change is silently absorbed by
  // upsertMessages before the dedicated flags pass below ever gets to compare
  // anything — which is why detecting the drift only in applyFlagsSnapshot
  // wasn't enough on its own: on every 10th tick (and on every manual
  // refresh, which forces a full scan) the change landed with nobody told.
  const unseenBefore = cache.countUnseenRows(uKey, account.id, path);

  let messages;
  const fetchedAt = Date.now();
  if (doFullScan) {
    ({ messages } = await imap.listMessages(path, { page: 1, pageSize: effectiveLimit }));
  } else {
    messages = await imap.listNewMessages(path, cache.getMaxUid(uKey, account.id, path));
  }

  // A full scan re-upserts every message it fetched INCLUDING its flags, so if
  // we changed this folder ourselves after the fetch went out, that answer is
  // older than the change and would put the old read state back — the click
  // undoing itself a second later. Keep the cache's flags for rows it already
  // has; new mail in the same batch is still taken in full. (The same
  // reasoning as the two skips further down, but this one can't just be
  // dropped: it's also how new messages arrive.)
  const preserveFlags = localWriteSince(uKey, account.id, path, fetchedAt);
  if (preserveFlags) slog.debug(`${account.label}/${path}: fetch predates our own write — keeping cached flags`);
  const newUids = cache.upsertMessages(uKey, account.id, path, folder.specialUse, messages, { preserveFlags });
  // Only safe when this fetch actually covers the user's full configured
  // backfill depth — pruneMissing deletes anything cached at or above the
  // *lowest* UID in `messages`, on the assumption that set is the complete
  // picture for that range. A truncated on-demand scan (limit < configured,
  // see syncFolderNow) is deliberately NOT that: it only returns the top
  // `limit` by date out of however many candidates exist, so pruning against
  // it would wrongly delete legitimately-cached messages beyond that
  // narrower window whose UID happens to fall in range. Skipping the prune
  // there just means a message deleted server-side during that narrower
  // window waits for the next full-depth scan to be cleaned up — never
  // wrongly evicts something that's still real.
  if (doFullScan && effectiveLimit >= configuredLimit) cache.pruneMissing(uKey, account.id, path, messages.map((m) => m.uid));
  cache.setSyncState(uKey, account.id, path, { lastError: null });
  slog.debug(`${account.label}/${path}: ${doFullScan ? 'full' : 'incremental'} — ${messages.length} fetched, ${newUids.length} new (${Date.now() - t0}ms)`);

  // Flag changes (read/unread, starred, …) made on another client — every
  // tick, not just full-scan ones, and independent of doFullScan's own
  // date-based candidate selection: a full listMessages pass only re-checks
  // flags for whichever messages currently rank in the newest
  // `effectiveLimit` by date, so a message that's aged past that window
  // never gets asked about again by anything else. This covers the
  // complete cached set regardless, cheaply (flags only, no envelope —
  // see imapClient.js#refreshFlags). This was the actual cause of "I marked
  // 5 as read on my phone and Hmelj still shows them unread, even after
  // pressing refresh" — refresh forces exactly the same date-ranked
  // listMessages pass, which has the identical blind spot.
  //
  // When this snapshot actually moves something, everyone gets told — this
  // is the fix for "I marked it read on my phone and the other client kept
  // showing it unread until I hit refresh." The write above landed in SQLite
  // and notified nobody: no SSE event (broadcastForAccount was reached only
  // from the `newUids.length` branch above, i.e. new mail ONLY), and no count
  // update, so an open tab kept its stale badge until some unrelated
  // reconcile happened to run. The unread delta is applied to the folder's
  // cached count the same way an in-app mutation's is (adjustFolderCounts),
  // rather than waiting for the next cycle's STATUS to correct it.
  let flagsChanged = 0;
  try {
    const cachedUids = cache.getCachedUids(uKey, account.id, path);
    // ...but not when the scan above ALREADY covered every cached message.
    // upsertMessages writes each fetched message's current flags, so for a
    // full scan whose result is a superset of the cache there is nothing left
    // for this pass to discover — it's a whole extra FETCH round trip per
    // folder per tick for a guaranteed no-op. That's the common case for any
    // folder small enough to fit inside one scan, and it's what made a
    // 25-folder Exchange account spend ~0.9s per folder on top of a ~0.2s
    // listing. The blind spot this pass exists for is still covered: a
    // truncated scan (on-demand syncs pass a smaller limit than the cache
    // depth) doesn't cover the cache, so it still runs there.
    const fetchedKeys = doFullScan ? new Set(messages.map((m) => cache.uidKey(m.uid))) : null;
    const scanCoveredCache = !!fetchedKeys && cachedUids.every((u) => fetchedKeys.has(cache.uidKey(u)));
    if (cachedUids.length && !scanCoveredCache) {
      const readAt = Date.now();
      const flagRows = await imap.refreshFlags(path, cachedUids);
      // Stale by the time it arrived — we changed this folder ourselves after
      // the fetch started, and these rows predate that. Writing them would
      // silently revert it (see the localWrites comment above). Dropped whole
      // rather than merged: the snapshot has no per-message timestamp to merge
      // on, and the next cycle re-reads it anyway.
      if (localWriteSince(uKey, account.id, path, readAt)) {
        slog.debug(`${account.label}/${path}: flag snapshot predates our own write — skipping this pass`);
      } else {
        const r = cache.applyFlagsSnapshot(uKey, account.id, path, flagRows);
        flagsChanged = r.changed;
        if (r.changed) cache.adjustFolderCounts(uKey, account.id, path, { unseenDelta: r.unseenDelta });
      }
    }
  } catch (e) {
    slog.warn(`${account.label}/${path}: flag refresh failed:`, e.message);
  }

  // Did anything about this folder actually change this cycle — new mail, or
  // read/star state moved by some other client? Drift is detected two ways,
  // because a foreign change can arrive by either route: the flags-only pass
  // above, and a full scan's own re-upsert (see unseenBefore).
  const unseenAfter = cache.countUnseenRows(uKey, account.id, path);
  // "Drift" specifically means a change this server didn't make and didn't
  // already know about — read/starred elsewhere. New mail moves the unread
  // count too, but that's not drift and it has its own handling (notifications
  // above, and no badge-only push below), so it's excluded here rather than
  // being lumped in and mislabelled.
  const drifted = !newUids.length && (flagsChanged || unseenAfter !== unseenBefore);
  if (newUids.length || drifted) {
    // Re-read the real count from the server before telling anyone. The
    // broadcast carries the new unread total (server/events.js), and the
    // numbers written so far are either a delta or a cached-row count —
    // neither is authoritative for a folder holding more unread than the
    // cache keeps rows for. Without this the event announced the PREVIOUS
    // total and clients briefly painted the old number before their own
    // reconcile corrected it. Only on an actual change, so a quiet tick
    // still costs nothing extra.
    try {
      const readAt = Date.now();
      const status = await imap.folderStatus(path);
      // Same rule as the flag snapshot above: setFolderCounts is an outright
      // overwrite, so a count read before our own write must not land after it.
      if (status && localWriteSince(uKey, account.id, path, readAt)) {
        slog.debug(`${account.label}/${path}: STATUS predates our own write — keeping the adjusted count`);
      } else if (status) {
        cache.setFolderCounts(uKey, account.id, path, status);
      }
    } catch (e) {
      slog.debug(`${account.label}/${path}: STATUS after change failed, using cached counts:`, e.message);
    }
    if (drifted) slog.debug(`${account.label}/${path}: flag drift from another client (unread ${unseenBefore} → ${unseenAfter})`);
    // Every grantee of a shared account gets nudged too
    // (broadcastForAccount), not just its owner.
    events.broadcastForAccount(uKey, account.id);

    // Drift with no new mail means the count moved WITHOUT a notification
    // being sent — mail read (or marked unread) somewhere else. An app that
    // isn't running learns about that from nothing at all, so its badge just
    // keeps whatever the last new-mail push left: correct only ever going up.
    // A silent badge-only push is the one way to bring it back down.
    if (drifted) {
      for (const key of accountsStore.accessorKeysFor(uKey, account.id)) {
        if (!push.hasSubscriptions(key)) continue;
        try {
          await push.sendBadgeUpdate(key, unread.unreadTotalForKey(key), account.id);
        } catch (e) {
          slog.debug(`${account.label}: badge update push failed for ${key}:`, e.message);
        }
      }
    }
  }

  // Filters are an inbox-organizing feature, never applied to outgoing mail
  // — and never against a folder's first backfill, where "new" just means
  // "existing mail we've never cached before," not mail that actually just
  // arrived. Running delete/move filter actions against either of those
  // would silently destroy real mail (this is exactly how a broad filter
  // wiped out a Sent folder during an account's first sync before this fix).
  const isSentFolder = path === account.sentFolder;
  if (newUids.length && !isSentFolder && !isFirstSyncOfFolder) {
    // A "new" UID isn't necessarily new mail: Gmail assigns UIDs per label,
    // so an old thread that gets relabeled, moved, or simply gets a fresh
    // reply resurfaces its old messages under brand-new UIDs in this
    // folder's UID space — and running "new mail" filter actions
    // (move/delete/etc.) against a message that isn't actually new would be
    // wrong. Only messages the server took delivery of recently count.
    //
    // INTERNALDATE, not the Date: header. Both answer "how old is this", but
    // only INTERNALDATE answers the question actually being asked — WHEN DID
    // THIS ARRIVE HERE — and the two come apart in exactly the cases that
    // matter:
    //   - a sender with a wrong clock, or mail delayed days in transit: Date is
    //     old, INTERNALDATE is now. It really is new, and filtering it is right.
    //     Keying off Date silently never filtered these (the reported surprise).
    //   - a Gmail relabel resurfacing an old message: BOTH are old, so the guard
    //     this replaces still holds. Nothing is lost by the switch.
    // Exchange and Graph have no such split — their date already is the received
    // time — so both simply report it under this name too.
    //
    // The cutoff used to be a fixed two days. That one number was doing two
    // unrelated jobs — excluding resurfaced old mail (wants a SHORT window) and
    // including mail that arrived while Hmelj was off (wants a window as long
    // as the outage) — and could only be right for one of them. An outage
    // longer than two days left everything that arrived in it permanently
    // unfiltered, with nothing ever going back for it.
    //
    // It is now a per-folder mark: "filters have covered this folder up to time
    // T" (server/filterState.js). The window is T..now, which is five minutes
    // on a healthy server and nine days after a holiday, while a relabelled
    // years-old message is still far below T and still excluded.
    const { from: cutoff, cold, skippedMs } = filterState.catchUpFrom(uKey, account.id, path);
    const arrivedAt = (m) => new Date(m.internalDate || m.date || 0).getTime();
    const fresh = messages.filter((m) => newUids.includes(m.uid) && arrivedAt(m) >= cutoff);
    const staleCount = newUids.length - fresh.length;
    if (staleCount) slog.debug(`${account.label}/${path}: skipping filters for ${staleCount} "new" UID(s) the server received before ${new Date(cutoff).toISOString()} (resurfaced mail, or already filtered)`);
    if (skippedMs > 0) {
      // Said out loud rather than left to look like full coverage: the mark was
      // older than the cap, so some history is deliberately not being filtered.
      slog.info(`${account.label}/${path}: catching up filters, but only over the last ${Math.round(filterState.MAX_CATCHUP_MS / 86400e3)} days — `
        + `${Math.round(skippedMs / 86400e3)} day(s) of older mail are left as they are`);
    } else if (!cold && fresh.length && Date.now() - cutoff > 6 * 3600e3) {
      slog.info(`${account.label}/${path}: catching up filters on ${fresh.length} message(s) that arrived since ${new Date(cutoff).toISOString()}`);
    }
    // Mail a filter of ours moved here a moment ago has already been through
    // the filters once, in the folder it arrived in. Running them again would
    // fire `redirect`/`reply` a second time (see filters.js#claimFiled) —
    // the forward goes out twice, seconds apart. Only the filter run skips
    // these: they are still genuinely new mail as far as the content cache
    // and the new-mail notification are concerned, and both keep the full
    // `fresh` set.
    // Which of these OUR OWN filters put here a moment ago. claimFiled consumes
    // the note, so this is the one chance to know — hence collecting the uids
    // rather than asking again further down.
    const filedUids = new Set();
    const filterable = fresh.filter((m) => {
      if (!claimFiled(uKey, account.id, path, m.uid)) return true;
      filedUids.add(m.uid);
      return false;
    });
    const filedHere = filedUids.size;
    if (filedHere) slog.debug(`${account.label}/${path}: skipping filters for ${filedHere} message(s) a filter of ours moved here`);
    if (fresh.length) {
      // Proactively cache genuinely new mail's content BEFORE filters run
      // (see server/contentCache.js) — so it's already warm if a filter
      // below moves/deletes it (still fine — that's a live message, this
      // is just priming a cache entry), and so notifyNewMail right after
      // gets a free cache hit instead of fetching the same message twice.
      try {
        await contentCache.cacheMessages(uKey, account.id, path, fresh);
      } catch (e) {
        slog.warn(`Content cache warm-up failed for ${account.label}/${path}:`, e.message);
      }
      try {
        // `once` makes the run idempotent (cache.js#claimFilterApplied): a
        // message this filter has already been applied to is skipped, so a
        // catch-up window that overlaps a previous one — or a wiped cache
        // re-presenting old mail as new — cannot file anything twice.
        const r = await runFilters(path, { messages: filterable, once: true });
        if (r.matched) slog.info(`${account.label}/${path}: filters matched ${r.matched} of ${filterable.length} new message(s)`);
        // Only AFTER the run, and only to the newest thing actually seen: a
        // mark advanced before the work would skip that work forever if it then
        // failed, and one advanced to `now` would skip mail that arrives during
        // the run and lands under a uid this pass never looked at.
        const newest = Math.max(0, ...fresh.map(arrivedAt).filter(Number.isFinite));
        if (newest) filterState.advance(uKey, account.id, path, newest);
        // A filter that moved (or expunged) a message leaves this folder's
        // cached row behind. The fetch above happened BEFORE the filters ran, so
        // pruneMissing saw the message as still present and kept it, and an
        // incremental poll can never notice a uid that simply vanished — the
        // row therefore survives until the next FULL scan, up to ~20 minutes
        // later. For all that time the unified list shows the message twice:
        // once from this stale row, once from the real one in the folder the
        // filter filed it into. (This is what /api/messages/:folder/move has
        // always done for an interactive move; the filter path never did.)
        if (r.departed?.length) {
          noteLocalWrite(uKey, account.id, path);
          cache.adjustFolderCounts(uKey, account.id, path, cache.removeMessages(uKey, account.id, path, r.departed));
          slog.debug(`${account.label}/${path}: dropped ${r.departed.length} cached row(s) a filter moved out`);
        }
        // …and the OTHER half of the same problem, which dropping the source row
        // alone made worse rather than better. A destination folder does not
        // self-heal until its own next poll, so between a filter moving a
        // message and that poll the message is in NO cached folder at all: gone
        // from the source, not yet in the target. The notification for it has
        // already gone out and the unread badge already counts it, so what the
        // user sees is a notification about mail that is nowhere in the list —
        // and then, minutes later, it appears by itself.
        //
        // /api/filters/run has always done this for a filter run started by
        // hand (see server/index.js); the background run, which is how filters
        // actually fire, never did.
        //
        // Safe against running the filters a second time on the moved message:
        // filters.js#claimFiled already notes where our own moves went, and the
        // filter block above consumes that note — which is the guard that stops
        // a `redirect` firing twice.
        for (const target of r.targets || []) {
          if (target === path) continue; // a self-move; already reconciled above
          noteLocalWrite(uKey, account.id, target);
          try { await syncFolderNow(uKey, account, target); }
          catch (e) { slog.warn(`${account.label}: could not sync "${target}" after a filter moved mail into it: ${e.message}`); }
        }
      } catch (e) {
        slog.warn(`Filter run failed for ${account.label}/${path}:`, e.message);
        userLog.record(uKey, {
          level: 'error',
          category: 'filter',
          message: `Filters could not run on ${account.label}/${path}`,
          detail: e.message,
          accountId: account.id,
          accountLabel: account.label,
        });
      }
      // Same "genuinely new, not backlog/resurfaced" set filters just used —
      // a filter above may have already moved/deleted some of these, which
      // this doesn't account for (no cheap way to tell which without a
      // second cache read per message); same blind spot the older
      // foreground-only notifier already has, not a regression.
      //
      // Minus the ones a filter of OURS moved in here, though. Those were
      // notified when they arrived in the folder they were delivered to; a
      // second notification for the same message, from the folder it was filed
      // into, is the same mail announced twice. This used to be hidden by
      // timing — the destination was not polled until minutes later, by which
      // point the note had expired — and syncing destinations straight after a
      // filter run (below) would have made it a reliable double-buzz instead.
      try {
        await notifyNewMail(uKey, account, folder, fresh.filter((m) => !filedUids.has(m.uid)));
      } catch (e) {
        slog.warn(`Push notify failed for ${account.label}/${path}:`, e.message);
      }
      // Fills in the display name of a contact we already have but have no
      // name for — never adds anyone. See server/contacts.js for why receiving
      // is allowed so much less than sending. One small JSON read per poll that
      // found new mail, and it exits on that read alone once the address book
      // has no nameless entries left.
      learnSenderNames(uKey, fresh);
    }
  } else if (newUids.length && isFirstSyncOfFolder) {
    slog.debug(`${account.label}/${path}: skipping filters on first sync (${newUids.length} pre-existing message(s), not new mail)`);
  }

  // Throttled catch-up: content-cache whatever's in the current top-
  // contentCacheLimit window that isn't cached yet (bounded per tick — see
  // contentCache.js), then drop anything that's fallen out of that window.
  // Runs every tick regardless of whether this one found new mail — a
  // freshly-raised limit, a newly-in-scope folder, or the very first ticks
  // after this feature is turned on all need this to make progress.
  try {
    await contentCache.backfillAndPrune(uKey, account.id, path);
  } catch (e) {
    slog.warn(`Content cache backfill failed for ${account.label}/${path}:`, e.message);
  }
}

// Deliberately smaller than the user's configured backfill depth: all IMAP
// traffic for an account — interactive requests and background sync alike —
// shares one connection (see imapClient.js's pool comment; a second
// concurrent one throttles much harder on Gmail specifically, confirmed the
// hard way), so anything queued behind a slow fetch on that connection
// blocks. A user clicking refresh and immediately opening another message
// was measuring that queue, not IMAP itself — this is the fetch on the
// other end of it. Full reconciliation depth was never really the point of
// an on-demand "catch up what changed" scan anyway; the regular scheduled
// poll (still at the user's full configured depth) already does that deep
// reconciliation periodically in the background where nothing is waiting
// on it.
const ON_DEMAND_SYNC_LIMIT = 200;

/**
 * On-demand sync of a single folder, outside the regular poll cycle — used
 * right after sending a message (smtpClient.js) so the new Sent-folder copy
 * shows up immediately instead of waiting for the next tick, and by the
 * list pane's refresh button (server/index.js's /sync-now route) to
 * reconcile flag changes made on another client right now instead of
 * waiting for the next scheduled full pass. Must be called inside that
 * account's ALS context (see runWithAccount in session.js) — same
 * requirement as pollFolder, since imapClient.js's connection pool keys
 * off it. Defaults to force:true — "sync this folder now" means the truth
 * right now, not another cheap incremental peek.
 */
export async function syncFolderNow(uKey, account, folderPath, { force = true, limit = ON_DEMAND_SYNC_LIMIT } = {}) {
  // The folder's REAL record, because pollFolder feeds folder.specialUse into
  // upsertMessages and that column is overwritten on conflict. Deriving it
  // here as "\\Sent if this is the sent folder, else null" blanked it for
  // everything else — and since queryUnified excludes Trash/Junk/Drafts from
  // the unified inbox BY special_use, hitting the refresh button while
  // looking at Junk quietly made that junk eligible for the unified inbox
  // until the next full poll restored the flag.
  const cached = cache.getFolders(uKey, account.id).find((f) => f.path === folderPath);
  const specialUse = cached?.specialUse ?? (folderPath === account.sentFolder ? '\\Sent' : null);
  return withOnDemandMark(account.id, async () => {
    await pollFolder(uKey, account, { path: folderPath, specialUse }, { force, limit });
    // Real server counts, not a cache-row approximation (see
    // cache.js#setFolderCounts) — this folder's cache may only hold its
    // newest `limit` messages, which would under-count unseen if an older
    // unread one falls outside that window.
    const readAt = Date.now();
    const status = await imap.folderStatus(folderPath).catch(() => null);
    if (status && localWriteSince(uKey, account.id, folderPath, readAt)) {
      slog.debug(`${account.label}/${folderPath}: STATUS predates our own write — keeping the adjusted count`);
    } else if (status) cache.setFolderCounts(uKey, account.id, folderPath, status);
    else cache.recomputeFolderCounts(uKey, account.id, folderPath); // STATUS failed — approximate rather than leave it stale
  });
}

/**
 * On-demand sync of every in-scope folder for one account (INBOX, its
 * subfolders, and Sent — same scope as the regular background poll, see
 * isInScope) — the unified "All inbox" view's refresh button uses this
 * instead of syncFolderNow('INBOX') alone, which used to leave mail a
 * server-side rule filed straight into a custom subfolder undiscovered
 * until the next scheduled poll: it shows up in the unified list either way
 * (queryUnified doesn't filter by folder name), but the account's own
 * connection hadn't actually looked at that subfolder yet. Folders still go
 * one at a time on the account's single shared connection regardless of
 * this being "one call" — no additional concurrency risk over calling
 * syncFolderNow per folder yourself, just less to wire up per caller.
 */
/**
 * Sweeps cached rows for folders this account no longer has — a folder deleted
 * or renamed elsewhere, or a path whose spelling changed under us (an Exchange
 * account's inbox went from `Inbox` to `INBOX` and left 250 rows behind, which
 * the unified view then listed as duplicates; see cache.js#pruneMissingFolders).
 *
 * Runs off the FULL listing, hidden folders included — those are skipped for
 * syncing but still exist, and pruning them would delete cached mail every poll
 * and re-fetch it the moment they were unhidden. A listing that came back empty
 * is treated as a failed answer rather than "the account has no folders": this
 * deletes, so it never acts on a result that could be a transient error.
 */
function pruneVanishedFolders(uKey, account, folders) {
  if (!config.cacheEnabled || !folders?.length) return;
  try {
    const { messages, folders: gone } = cache.pruneMissingFolders(uKey, account.id, folders.map((f) => f.path));
    if (gone.length) slog.info(`${account.label}: pruned ${messages} cached message(s) from ${gone.length} folder(s) no longer on the server (${gone.join(', ')})`);
  } catch (e) {
    // Never worth failing a sync cycle over — the rows it would have removed
    // are stale, not dangerous.
    slog.warn(`${account.label}: folder prune failed:`, e.message);
  }
}

export async function syncAccountNow(uKey, account, { limit = ON_DEMAND_SYNC_LIMIT } = {}) {
  return withOnDemandMark(account.id, async () => {
    // listFolders already fetches real STATUS (total/unseen) for every folder
    // in one call and upsertFolders writes it — that's the accurate count.
    // Deliberately NOT following each pollFolder below with a recompute from
    // cache rows (like syncFolderNow does when it can't get a fresh STATUS
    // cheaply): that would just overwrite this correct value with a worse
    // under-counting approximation for no reason, since we already have the
    // real number from seconds ago.
    const folders = await imap.listFolders();
    cache.upsertFolders(uKey, account.id, folders);
    pruneVanishedFolders(uKey, account, folders);
    const hidden = new Set(account.hiddenFolders || []);
    const inScope = folders.filter((f) => !hidden.has(f.path) && isSyncScope(f, account));
    for (const f of inScope) {
      await pollFolder(uKey, account, f, { force: true, limit });
    }
  });
}

export async function pollAccount(user, account) {
  if (shouldSkip(account.id)) { slog.debug(`Skipping ${account.label} — backing off after recent failure`); return; }
  const uKey = userKey(user.username);
  // Per account, not global: each account now runs on its own schedule (see
  // scheduleAccount), so "every 10th tick does a full reconcile" has to mean
  // every 10th tick OF THIS ACCOUNT. A single shared counter would have made
  // the full-scan cadence depend on how many other accounts exist and how
  // often they happen to run.
  const tick = (tickCounts.get(account.id) || 0) + 1;
  tickCounts.set(account.id, tick);
  inFlightAccounts.add(account.id);
  const t0 = Date.now();
  try {
    // Shares the account's one IMAP connection with interactive requests
    // (imapClient.js) by default — see the comment there. purpose:'sync'
    // routes onto a dedicated second connection instead, for accounts that
    // opted into allowSecondConnection.
    await runAsAccount(user, account.id, async () => {
      const folders = await imap.listFolders();
      cache.upsertFolders(uKey, account.id, folders);
      pruneVanishedFolders(uKey, account, folders);
      const hidden = new Set(account.hiddenFolders || []);
      const inScope = folders.filter((f) => !hidden.has(f.path) && isSyncScope(f, account));
      slog.debug(`${account.label}: syncing ${inScope.length}/${folders.length} folders (${inScope.map((f) => f.path).join(', ')})`);
      for (const f of inScope) {
        await pollFolder(uKey, account, f, { tick });
      }
    }, { purpose: 'sync' });
    recordSuccess(account.id);
    slog.debug(`${account.label}: sync cycle done (${Date.now() - t0}ms)`);
  } catch (e) {
    recordFailure(account.id);
    cache.setSyncState(uKey, account.id, 'INBOX', { lastError: e.message });
    slog.warn(`${account.label}: sync failed:`, e.message);
    // The one the user most needs and could least see: an account that has
    // silently stopped receiving mail because its host is unreachable, its
    // password expired, or its certificate went bad. userLog collapses the
    // repeats, so two hours of this is one row with a count, not sixty rows.
    userLog.record(uKey, {
      level: 'error',
      category: 'sync',
      message: `Could not sync ${account.label}`,
      detail: e.message,
      accountId: account.id,
      accountLabel: account.label,
    });
  } finally {
    inFlightAccounts.delete(account.id);
  }
}

/** One-time bootstrap for the search-box autocomplete's word index (see
 * cache.js#backfillSearchWords) — a mailbox that was already synced before
 * that feature existed would otherwise only ever index mail arriving from
 * here on, starting from an empty index. hasSearchWords is a cheap check. */
function bootstrapUser(uKey, username) {
  if (cache.hasSearchWords(uKey)) return;
  try {
    const n = cache.backfillSearchWords(uKey);
    if (n) slog.info(`${username}: backfilled search-word index from ${n} already-cached message(s)`);
  } catch (e) {
    slog.warn(`${username}: search-word backfill failed:`, e.message);
  }
}

// ---------------------------------------------------------------------------
// Scheduler
//
// Each account runs on ITS OWN timer, at its own interval, instead of every
// account being polled together on one global setInterval. That's what makes
// "check this mailbox every 30s and that one every 15 minutes" expressible at
// all — and it's the same mechanism that lets an account opt into live IDLE
// (server/idle.js) while its neighbours keep polling.
//
// A chained setTimeout rather than setInterval: the next run is scheduled only
// once the previous one has finished, so a slow account can't pile cycles up
// on itself. The per-account inFlight guard stays as a second line of defence
// for on-demand syncs racing a scheduled one.
// ---------------------------------------------------------------------------

const timers = new Map();     // accountId -> Timeout
const supervised = new Map(); // accountId -> { user, account }

/** How often this account gets polled. Live accounts still poll — as a safety
 * net for anything the watcher misses or sleeps through — just less often,
 * since they're not relying on it for new-mail latency. */
function intervalFor(account) {
  const base = Math.max(30e3, account.pollIntervalMs || config.syncIntervalMs);
  return account.monitorMode === 'idle' ? Math.max(base, IDLE_FALLBACK_POLL_MS) : base;
}
// Deliberately not much longer than the default poll. New mail is what IDLE
// reliably reports (an EXISTS is unambiguous); FLAG changes made by another
// client depend on the server volunteering an unsolicited FETCH during IDLE,
// which most do but not all — the bundled hoodiecrow mock, for one, doesn't.
// On a server that doesn't, this interval IS how quickly "I read it on my
// phone" reaches your other clients, so it must not be set so high that
// choosing Live makes cross-client read state worse than plain polling would.
const IDLE_FALLBACK_POLL_MS = 5 * 60e3;

function scheduleAccount(user, account, delay = intervalFor(account)) {
  clearTimeout(timers.get(account.id));
  const t = setTimeout(async () => {
    const current = supervised.get(account.id);
    if (!current) return; // removed/disabled while we were waiting
    try {
      if (!isBusy(account.id)) await pollAccount(current.user, current.account);
      else slog.debug(`${account.label}: already syncing (previous cycle or an on-demand refresh), skipping this one`);
    } catch (e) {
      slog.warn(`Account ${account.label} (${user.username}) failed:`, e.message);
    } finally {
      if (supervised.has(account.id)) scheduleAccount(current.user, current.account);
    }
  }, delay);
  t.unref?.();
  timers.set(account.id, t);
}

function stopAccount(accountId) {
  clearTimeout(timers.get(accountId));
  timers.delete(accountId);
  supervised.delete(accountId);
  idle.stopWatching(accountId);
}

/**
 * Reconcile the running timers/watchers against what's actually configured.
 * Runs on a slow supervisor tick and immediately whenever an account is added,
 * removed, disabled or has its monitoring settings changed (see the account
 * routes in index.js), so a change takes effect without a restart.
 *
 * Never throws. The route handlers call it as a fire-and-forget side effect of
 * saving an account — an unhandled rejection there would be an unrelated
 * scheduling problem crashing (or at best noisily logging over) a request that
 * had already succeeded.
 */
export async function reschedule() {
  try {
    await rescheduleInner();
  } catch (e) {
    slog.warn('Reschedule failed:', e.message);
  }
}

async function rescheduleInner() {
  if (!started) return;
  const seen = new Set();
  for (const u of listUsers().filter((x) => !x.disabled)) {
    const uKey = userKey(u.username);
    bootstrapUser(uKey, u.username);
    let accountList;
    try {
      // listOwnedAccounts(), not listAccounts() — a shared-in account must be
      // synced exactly once, via its OWNER's own iteration here, never via a
      // grantee's too (which would double-poll and double-connect the same
      // real mailbox). Every grantee still benefits from this same sync,
      // transparently, via the ALS ownership swap in requireAuth.
      accountList = await runAsUser(u, () => accountsStore.listOwnedAccounts());
    } catch (e) {
      slog.warn(`Could not list accounts for ${u.username}:`, e.message);
      continue;
    }
    for (const account of accountList) {
      if (account.disabled) continue;
      seen.add(account.id);
      const prev = supervised.get(account.id);
      supervised.set(account.id, { user: u, account }); // always refresh: label/folders/intervals may have changed
      const changedCadence = !prev
        || prev.account.monitorMode !== account.monitorMode
        || intervalFor(prev.account) !== intervalFor(account);
      if (!prev) {
        // First time we've seen this account — sync it now rather than making
        // it wait a full interval.
        scheduleAccount(u, account, 0);
      } else if (changedCadence) {
        scheduleAccount(u, account);
      }
      if (account.monitorMode === 'idle') idle.startWatching(u, account);
      else idle.stopWatching(account.id);
    }
  }
  for (const id of [...supervised.keys()]) if (!seen.has(id)) stopAccount(id);
}

let started = false;
export function start() {
  if (started) return;
  if (!config.cacheEnabled) { slog.info('Background sync disabled (CACHE_ENABLED=false) — running live IMAP only'); return; }
  started = true;
  slog.info(`Background sync starting (default interval ${config.syncIntervalMs / 1000}s; each account can override it, and can opt into live IDLE)`);
  // Tells idle.js how to act on a watcher event without importing sync.js back
  // (which would be a cycle) — see idle.js's own comment.
  idle.setOnActivity((user, account, folderPath, kind) => onWatcherActivity(user, account, folderPath, kind));
  reschedule().catch((e) => slog.warn('Initial schedule failed:', e.message));
  setInterval(() => reschedule().catch((e) => slog.warn('Reschedule failed:', e.message)), 60e3).unref();
}

/**
 * An IDLE/streaming watcher saw something change. Polls just that folder,
 * right now — deliberately reusing the ordinary pollFolder path so new mail,
 * filters, notifications, counts and broadcasts all behave identically to a
 * scheduled cycle. The watcher is only a trigger; it never becomes a second
 * implementation of "what to do about new mail".
 */
async function onWatcherActivity(user, account, folderPath, kind = 'mail') {
  const uKey = userKey(user.username);
  if (isBusy(account.id)) return; // a cycle or an on-demand refresh is already running; it'll see this too
  // Our own mark-read coming back to us. The IMAP `flags` event carries no
  // author, so this is the only way to tell — and running the sync anyway is
  // what corrupted counts during quick clicking (see the localWrites comment
  // above). Nothing is lost by skipping: the route that made the change
  // already mirrored it into the cache and broadcast to every open tab. Only
  // a flags-only wake is ever dropped; anything involving actual mail
  // movement ('mail') always syncs.
  if (kind === 'flags' && localWriteSince(uKey, account.id, folderPath, Date.now() - SELF_WAKE_WINDOW_MS)) {
    slog.debug(`${account.label}/${folderPath}: flag change is our own — not syncing`);
    return;
  }
  inFlightAccounts.add(account.id);
  try {
    await runAsAccount(user, account.id, async () => {
      // The REAL folder record, not a synthesized {path} — pollFolder passes
      // folder.specialUse straight into upsertMessages, and that column is
      // overwritten on conflict, so a stand-in without it would blank
      // special_use for every message in the folder on every single
      // IDLE-triggered sync. Falls back to a live LIST for a folder the cache
      // hasn't seen yet (first run).
      let folder = cache.getFolders(uKey, account.id).find((f) => f.path === folderPath);
      if (!folder) folder = (await imap.listFolders()).find((f) => f.path === folderPath);
      if (!folder) { slog.debug(`${account.label}: ${folderPath} not found, skipping IDLE-triggered sync`); return; }
      const readAt = Date.now();
      const status = await imap.folderStatus(folderPath).catch(() => null);
      if (status && localWriteSince(uKey, account.id, folderPath, readAt)) {
        slog.debug(`${account.label}/${folderPath}: STATUS predates our own write — keeping the adjusted count`);
      } else if (status) cache.setFolderCounts(uKey, account.id, folderPath, status);
      await pollFolder(uKey, account, folder);
    }, { purpose: 'sync' });
  } catch (e) {
    slog.warn(`${account.label}/${folderPath}: IDLE-triggered sync failed:`, e.message);
  } finally {
    inFlightAccounts.delete(account.id);
  }
}
