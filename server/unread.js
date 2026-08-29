// Hmelj — the authoritative unread count.
//
// This used to be a purely client-side sum: public/js/app.js fetched
// /api/folders once per account, filtered with its own copy of the scope
// rule, and added the numbers up in two independent places (the "All
// inboxes" sidebar row and updateUnreadIndicator, which drives the tab
// title, the favicon dot and the Android launcher badge). That had four
// distinct failure modes, all of them user-visible:
//
//   - Accounts other than the selected one were never refreshed, so the
//     total sat frozen at whatever those accounts were when last visited —
//     and counted as 0 for an account never visited in that session.
//   - A failed per-account fetch set that account's count to null, silently
//     dropping it from the total rather than keeping the last known value.
//   - The client's scope rule and the server's could disagree (see scope.js).
//   - Nothing could produce a total with no page open at all — which is
//     exactly what a push notification needs in order to carry a correct
//     badge to a closed app (see push.js/sync.js's unreadTotal).
//
// One function, server-side, fixes all four. It reads the SQLite folder
// cache only (no IMAP round trip), so it's cheap enough to call on every
// mutation and to embed in every SSE broadcast.
import * as cache from './cache.js';
import * as accounts from './accounts.js';
import * as accountOverrides from './accountOverrides.js';
import { userKey, currentUser, runAsUser, listUsers } from './session.js';
import * as scope from './scope.js';
import * as schedule from './schedule.js';
import { store } from './store.js';

/** The userKey whose cache namespace an account's rows live in — its owner's,
 * always, including for an account shared in to someone else (see
 * session.js#requireAuth's ownership swap: every cache.js table is keyed by
 * owner, never by viewer). */
function ownerKeyFor(account, viewerKey) {
  return account.shared && account.ownerUsername ? userKey(account.ownerUsername) : viewerKey;
}

/**
 * The viewer's "🔔 Show muted" preference, plus everything needed to evaluate
 * a schedule against it — or null when nothing has to be evaluated at all
 * (the toggle is on, or this viewer never configured a schedule anywhere).
 *
 * Read with the explicit-userKey store variants rather than off ALS: this runs
 * for a shared-in account too, where ALS may already be swapped into that
 * account's OWNER (session.js#requireAuth), and it's the viewer's own
 * preference and holiday calendar that decide what THEIR badge shows.
 */
function muteContextFor(viewerKey, accountList) {
  if (store.getSettingsFor(viewerKey).showMuted) return null;
  if (!accountList.some(schedule.hasAnySchedule)) return null;
  const now = new Date();
  return {
    now,
    workFreeDateSet: schedule.workFreeDateSetFor(
      now.getFullYear(),
      store.getHolidayOverridesFor(viewerKey),
      store.getCustomHolidaysFor(viewerKey),
    ),
  };
}

/**
 * Per-account and total unread for one viewer.
 *
 * `viewerKey`/`viewerId` identify who's asking — needed both to resolve
 * shared-in accounts and to apply that viewer's own per-account hidden-folder
 * overrides, since a folder this viewer hid shouldn't contribute to the badge
 * they see even though the owner still syncs and counts it.
 *
 * Folders the notification scheduler has quiet right now are left out unless
 * the viewer's "Show muted" toggle is on — the same rule the unified "All
 * inboxes" LIST applies (server/index.js's hideMuted → cache.js#queryUnified),
 * so the badge can't count mail that list is hiding. Time-dependent by nature:
 * a 'scheduled' account's unread leaves the badge outside its notify window
 * and comes back inside it, with no mail having moved.
 *
 * Disabled accounts are excluded, matching activeAccounts() on the client.
 */
export function unreadFor(viewerKey, accountList) {
  const byAccount = {};
  let total = 0;
  const mute = muteContextFor(viewerKey, accountList);
  for (const account of accountList) {
    if (account.disabled) continue;
    const oKey = ownerKeyFor(account, viewerKey);
    let folders = cache.getFolders(oKey, account.id);
    // A grantee's own extra hidden folders never touch the owner's cached
    // `hidden` flag (cache.js#setFoldersHidden keeps that as the owner's
    // list), so they're applied per-viewer here — same union /api/folders
    // does for the folder list itself.
    if (account.shared) {
      const mine = new Set(accountOverrides.getOverride(viewerKey, account.id)?.hiddenFolders || []);
      if (mine.size) folders = folders.map((f) => (mine.has(f.path) ? { ...f, hidden: true } : f));
    }
    if (mute && schedule.hasAnySchedule(account)) {
      folders = folders.filter((f) => !schedule.isFolderMutedNow(account, f.path, mute));
    }
    const n = scope.unreadTotalFor(folders, account);
    byAccount[account.id] = n;
    total += n;
  }
  return { total, accounts: byAccount };
}

/** Same thing for whoever's ALS context we're already in — what the routes in
 * index.js want. Must run under a viewer context (not swapped into an
 * account owner's), since listAccounts() resolves shared-in accounts from
 * currentUser().viewerKey. */
export function unreadForCurrentUser() {
  const viewerKey = currentUser().viewerKey || currentUser().userKey;
  return unreadFor(viewerKey, accounts.listAccounts());
}

/**
 * Total for a user we're NOT currently running as — the background poller's
 * case (server/sync.js builds push payloads for an account's owner AND every
 * grantee, none of whom have a request context). Establishes that user's own
 * ALS context first so listAccounts() resolves their shared-in accounts too,
 * exactly as it would for a live request from them.
 *
 * Cheap: reads the folder cache only, no IMAP.
 */
export function unreadTotalForUser(user) {
  try {
    return runAsUser(user, () => unreadFor(userKey(user.username), accounts.listAccounts()).total);
  } catch {
    return null; // never let a badge number break a notification
  }
}

// userKey is a one-way derivation of the username (session.js#userKey), and
// the callers below (SSE broadcasts, push payloads) only ever hold the key —
// so this reverses it by scanning the small, rarely-changing user list.
// Memoized because a broadcast happens on every mutating route.
const userByKey = new Map();

/** unreadTotalForUser for a caller that only has the userKey. */
export function unreadTotalForKey(key) {
  let u = userByKey.get(key);
  if (!u) {
    u = listUsers().find((x) => userKey(x.username) === key) || null;
    if (u) userByKey.set(key, u);
  }
  return u ? unreadTotalForUser(u) : null;
}
