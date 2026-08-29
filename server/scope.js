// Hmelj — which of an account's folders "count" for what.
//
// Two closely-related but genuinely different questions used to be answered
// in three places that could disagree with each other:
//
//   1. "Which folders does the background poller sync?"  — was sync.js#isInScope
//   2. "Which folders' unread adds up to this account's badge?"
//                                          — was public/js/app.js#isUnifiedInboxScope
//   3. isLabelOverlapProne — copy-pasted verbatim into BOTH of the above
//
// Keeping (1) and (2) in different files (one server, one browser) meant they
// drifted: the server keyed its decision on `specialUse` + sentFolder, the
// client on `hidden` + sentFolder + draftsFolder. A server that doesn't report
// \Drafts therefore counted drafts in the badge while the unified list hid
// them — the badge and the list disagreeing about the same mailbox. Both now
// come from here, and the client no longer has an opinion at all (it reads
// GET /api/unread, see index.js).
//
// The two scopes are still deliberately different, just in one place where
// the difference is visible: syncing INCLUDES Sent (the unified Sent view
// needs it cached), counting EXCLUDES it (nobody wants a Sent badge).

// Folders that are never synced and never counted, under any provider.
const EXCLUDED_SPECIAL_USE = new Set(['\\Trash', '\\Junk', '\\Drafts', '\\All', '\\Flagged', '\\Important', '\\Archive']);

/**
 * Gmail specifically can show the SAME physical message under more than one
 * folder at once — a custom label doesn't remove a message from INBOX the
 * way filing it into a real folder does elsewhere, so summing unread across
 * "every folder" double-counts it (this is exactly what caused the "Gmail
 * Andrej: 4 unread, only 2 real" bug). No other provider we've seen does
 * this: a well-behaved IMAP server's folders are a strict, non-overlapping
 * tree, and so is Exchange's EWS folder tree — a message rule-filed into a
 * custom top-level folder (not nested under INBOX at all, which is the
 * normal place Outlook/Exchange puts them) has genuinely left INBOX, nothing
 * to double-count. Gated on this instead of applying the conservative
 * INBOX-only scope to everyone, which is what silently hid an Exchange
 * account's rule-filed subfolder (and would do the same on a plain
 * self-hosted IMAP server) even though nothing there was ambiguous.
 *
 * An EWS account has no `imap` block at all, so this is always false for one.
 */
export function isLabelOverlapProne(account) {
  return /(^|\.)gmail\.com$/i.test(account?.imap?.host || '');
}

/** INBOX itself, or one of its children — the conservative scope applied only
 * to label-overlap-prone providers (see above). */
function isInboxTree(folder) {
  const upper = (folder.path || '').toUpperCase();
  if (upper === 'INBOX') return true;
  const delim = (folder.delimiter || '/').toUpperCase();
  return upper.startsWith('INBOX' + delim);
}

/**
 * Does the background poller sync this folder? Sent IS included — the
 * unified Sent view reads from the same cache.
 *
 * NOTE: callers additionally filter out the account's own hiddenFolders
 * (sync.js does this before calling), which is a user preference rather than
 * a property of the folder, and isn't visible from `folder` alone for an
 * account whose cached rows haven't been written yet.
 */
export function isSyncScope(folder, account) {
  if (EXCLUDED_SPECIAL_USE.has(folder.specialUse)) return false;
  if (folder.path === account?.sentFolder) return true;
  if (!isLabelOverlapProne(account)) return true; // no known overlap risk — every remaining folder is safe to sync
  return isInboxTree(folder);
}

/**
 * Does this folder's unread count contribute to the account's badge (and
 * therefore to the "All inboxes" total, the tab title, the PWA app badge and
 * the Android launcher badge)?
 *
 * Differs from isSyncScope in exactly three ways, all of them "this is synced
 * but shouldn't show up as unread mail":
 *   - hidden folders (the user turned them off in the sidebar)
 *   - Sent (synced for the unified Sent view; never unread mail)
 *   - Drafts (a draft is never actually unread — it's just APPENDed without
 *     \Seen, which was inflating the badge by however many drafts happened to
 *     be sitting there). Path-based rather than specialUse-based because
 *     specialUse isn't reliably reported for either by every server, e.g.
 *     some Gmail locales.
 */
export function isUnreadScope(folder, account) {
  if (folder.hidden) return false;
  if (folder.path === account?.sentFolder) return false;
  if (folder.path === account?.draftsFolder) return false;
  if (EXCLUDED_SPECIAL_USE.has(folder.specialUse)) return false;
  if (!isLabelOverlapProne(account)) return true;
  return isInboxTree(folder);
}

/** Sum of unread across every folder that counts for one account — the single
 * definition every unread number in Hmelj now derives from. `folders` is a
 * cache.getFolders() result (or anything with the same {path, unseen, hidden,
 * specialUse, delimiter} shape). */
export function unreadTotalFor(folders, account) {
  return (folders || [])
    .filter((f) => isUnreadScope(f, account))
    .reduce((sum, f) => sum + (f.unseen || 0), 0);
}
