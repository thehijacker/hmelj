import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { currentUser } from './session.js';

fs.mkdirSync(config.dataDir, { recursive: true });

// Every user gets their own directory: DATA_DIR/users/<userKey>/*.json
//
// viewerKey, NOT userKey. Everything in here — settings, identities, contacts,
// filters, holidays — is a property of the PERSON, not of any mail account, so it
// must never follow requireAuth's shared-account ownership swap (session.js). That
// swap re-points userKey at the account's owner so the mail layer resolves to the
// one real mailbox and cache; a request carrying `?account=<a shared account>` was
// therefore reading and writing the OWNER's personal config on any route that came
// through here — an authenticated grantee could replace the owner's whole filter
// set (which runs server-side, across every account the owner has, and can forward
// to an arbitrary address), their settings, identities and contacts, none of which
// the share was ever meant to hand over. viewerKey is always the actual requesting
// login, and every als.run() site sets it — runAsUser/runAsAccount set it equal to
// userKey, so the background sync poller and filter runs are unaffected.
//
// See test/share-isolation-test.mjs, which fails on the userKey version.
function userDir() {
  const dir = path.join(config.dataDir, 'users', currentUser().viewerKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function load(name, fallback) {
  const file = path.join(userDir(), name + '.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

function save(name, data) {
  const file = path.join(userDir(), name + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Explicit-userKey variants, for the one caller that isn't inside a live
// request's ALS context in the usual way it still needs to be threaded
// through explicitly: server/sync.js's background poll loop, which already
// carries its own `uKey` string end-to-end (see cache.js's functions, which
// all take it as a plain argument rather than reading it off ALS) rather
// than relying on currentUser(). Kept separate from load/save above instead
// of changing those, since every other caller (settings/identities/
// contacts/filters, all from live requests) is fine reading it from ALS.
function userDirFor(uKey) {
  const dir = path.join(config.dataDir, 'users', uKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
/**
 * Every user key that has a directory on disk.
 *
 * Deliberately derived from the layout userDirFor() creates rather than from
 * the auth user list: this is used to sweep per-user FILES (see
 * push.js#claimSubscription), so what matters is which directories exist,
 * including one belonging to a user who has since been removed.
 */
function listUserKeys() {
  try {
    return fs.readdirSync(path.join(config.dataDir, 'users'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // no users dir yet (fresh install)
  }
}

function loadFor(uKey, name, fallback) {
  const file = path.join(userDirFor(uKey), name + '.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}
function saveFor(uKey, name, data) {
  const file = path.join(userDirFor(uKey), name + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}



export const DEFAULT_SETTINGS = {
  language: 'en',
  theme: 'system', // light | dark | system
  timeFormat: '24', // 24 | 12
  dateFormat: 'DD.MM.YYYY', // DD.MM.YYYY | MM/DD/YYYY | YYYY-MM-DD | D MMM YYYY
  autoMarkRead: 'delay', // never | immediate | delay | manual (icon click only)
  autoMarkReadDelay: 2, // seconds
  readingPane: 'right', // right | bottom | window | off
  composeFormat: 'html', // html | plain
  composeFont: 'system-ui', // default font for the rich composer (Settings > Compose). One of compose.js's FONTS — SPECIFIC named faces, not the generic keywords uiFont/messageFont use: this one is written into mail somebody else's client renders. 'system-ui' means no font-family at all, i.e. the reader's own default.
  // Address-book upkeep, both opt-out — see server/contacts.js for why they are
  // deliberately asymmetric (sending adds someone, receiving only ever fills in
  // a name we are missing).
  autoAddContacts: true,   // people you send to are added to Contacts
  learnContactNames: true, // incoming mail fills in a contact's missing display name
  externalImages: 'trusted', // always | trusted | ask | never
  trustedDomains: [],
  replyQuotePosition: 'below', // below | above | none
  messageFont: 'system-ui',
  messageFontSize: 15,
  autosaveDraftSeconds: 20,
  deleteBehavior: 'trash', // trash (move) | flag (mark \Deleted) | expunge (permanent)
  showDeleted: false, // show messages flagged \Deleted
  // Offer an Unsubscribe button on newsletters that publish a List-Unsubscribe
  // header (see server/unsubscribe.js). Only ever a button — nothing is sent
  // without pressing it — but the OFFER is a setting because unsubscribing
  // tells a sender the address is live and read, and on unsolicited mail that
  // is a decision, not a convenience.
  unsubscribeButton: true,
  // Show that banner at its smallest — the 📭 icon and the button, without the
  // sentence explaining what pressing it will do. Default on: the banner sits
  // between the header and the first line of every newsletter, and the
  // confirmation dialog still names the address or host before anything is
  // sent, so nothing is lost by folding the explanation away until asked for.
  unsubscribeBannerCompact: true,
  markReadOnDelete: true,
  requestReadReceipt: false,
  messagesPerPage: 50,
  runFiltersOnLoad: false,
  folderColWidth: 232,   // px, user-resizable
  listColWidth: 420,     // px, user-resizable (right reading pane mode)
  sortBy: 'date',        // date | sender | subject
  sortDir: 'desc',       // asc | desc
  listColFrom: 170,      // px, in-row "sender" column width, user-resizable
  listColDate: 92,       // px, in-row "date" column width, user-resizable
  listLayout: 'table',   // table | small | compact | comfort | wide
  // Group a folder's messages into conversations: one row per thread, opened
  // as a stack of its messages (see server/threading.js, cache.js#pageThreads,
  // app.js#openThread). Off by default — it changes what a list row MEANS, and
  // a chain with headers too broken to thread is better shown flat than
  // silently mis-grouped. Cache-only: with CACHE_ENABLED=false, or in a
  // search/unread/starred-filtered list, the list stays flat regardless.
  conversationView: false,
  // Conversation view: expand every message in a thread on open, not just the
  // newest. Off by default because each expanded message is its own body fetch
  // and its own sandboxed iframe — see app.js#openThread.
  conversationExpandAll: false,
  // Whether a message's header block (subject, full from/to lines, date) opens
  // collapsed to its two-line summary. Not a Settings checkbox: it's the
  // remembered position of the ⌄ toggle in the reading pane itself, saved so
  // the next message you open comes up the way you left the last one.
  messageHeaderCollapsed: false,
  // Stop the screen dimming/locking while Hmelj is open. Device-local in
  // practice (DEVICE_SETTINGS_KEYS in app.js) — this is only the default a new
  // device starts from. On by default because that is what the Android app has
  // always done unconditionally; the setting is the way to stop it.
  keepScreenOn: true,
  desktopNotifications: false, // browser Notification popups for new mail (needs OS/browser permission too)
  uiFont: 'system-ui',       // whole-app chrome font — separate from messageFont, which only styles message content
  uiFontSize: 14,            // px, base size everything else scales from (see --ui-scale in app.css)
  uiFontWeight: 400,         // 400 | 500 | 700 — lands on the base body rule only, not headers/badges that set their own weight
  swipeGestures: true,       // mobile: swipe a message row to mark read/unread or delete (see bindSwipe in app.js)
  swipeSwapDirection: false, // false: swipe left = read/unread, swipe right = delete. true: swapped.
  syncBackfillLimit: 250,    // newest N messages per folder kept in the local cache (see sync.js) — not full mailbox history
  contentCacheLimit: 50,     // newest N messages per folder kept ready to open instantly (full parsed content, not just envelope — see server/contentCache.js). 0 disables proactive pre-caching; opening a message still caches it for next time regardless.
  searchAutocomplete: true,  // inline ghost-text word completion in the search box, from your own mail history (see cache.js's search_words table)
  showMuted: false,          // the unified list's 🔔 toggle. false (default) = mail whose notification schedule has it quiet right now is hidden from the "All inboxes" list AND left out of every unread badge (see server/unread.js); true = everything is shown and counted. Persisted per user rather than kept per tab, because the same answer has to be reachable from places with no page open at all — the SSE badge payload, push notifications, the Android launcher badge.
  spellcheck: true,          // composer spell checking (see server/proofread.js + public/js/proofread.js). Slovenian and English, SPELLING ONLY — no grammar. Off falls the composer back to the browser's own spellchecker, which only knows the languages the device happens to have installed.
  customDictionary: [],      // words "Add to dictionary" has accepted, lowercased on compare. Per Hmelj user rather than per account: it's your vocabulary (names, jargon, project code names), not a property of any one mailbox.
  accountOrder: [],          // account ids, in the order the sidebar should list them (Compose row's ↕ button — see app.js#orderedAccounts). Ids missing from this list keep their natural order and go last, so a newly added (or newly shared-in) account never disappears. Lives here, per Hmelj user, rather than as a field on the account record: the sidebar also lists SHARED-IN accounts, which live in their owner's accounts.json and can't carry this viewer's ordering.
};

export const store = {
  getSettings: () => ({ ...DEFAULT_SETTINGS, ...load('settings', {}) }),
  /**
   * The settings of the OWNER of the mail account this request is operating on —
   * for a shared account, deliberately NOT the caller's own.
   *
   * getSettings() above is viewer-scoped, which is right for everything that
   * describes a person's own view. This is the short list that instead describes
   * what may be done TO a mailbox: deleteBehavior and markReadOnDelete (see
   * imapClient/ewsClient/graphClient's delete paths). Those have to follow the
   * owner, or a grantee whose own preference is 'expunge' would permanently destroy
   * mail in a mailbox whose owner had chosen 'trash' — escalating how destructive
   * somebody else's Delete button is, by editing their own settings page.
   *
   * currentUser().userKey is already the owner's key here: that is exactly what
   * requireAuth's ownership swap (session.js) put there.
   */
  getOwnerSettings: () => ({ ...DEFAULT_SETTINGS, ...loadFor(currentUser().userKey, 'settings', {}) }),

  // Explicit-userKey variant, for callers that must read the VIEWER's own
  // settings while ALS may be swapped into a mail account owner's context
  // (requireAuth's ownership swap on a shared account) — server/unread.js and
  // the /api/folders decoration, both of which apply the viewer's `showMuted`
  // to accounts they may not own. Same reasoning as getPushSubscriptionsFor.
  getSettingsFor: (uKey) => ({ ...DEFAULT_SETTINGS, ...loadFor(uKey, 'settings', {}) }),
  saveSettings(patch) {
    const next = { ...this.getSettings(), ...patch };
    save('settings', next);
    return next;
  },

  getIdentities: () => load('identities', []),
  saveIdentities(list) { save('identities', list); return list; },
  // Explicit-userKey pair — accounts.js needs to drop a GRANTEE's own
  // identities for a mail account when the OWNER revokes their access
  // (unshareAccount), which runs in the owner's own ALS context, not the
  // grantee's — same reasoning as getPushSubscriptionsFor below.
  getIdentitiesFor: (uKey) => loadFor(uKey, 'identities', []),
  saveIdentitiesFor(uKey, list) { saveFor(uKey, 'identities', list); return list; },

  getContacts: () => load('contacts', []),
  saveContacts(list) { save('contacts', list); return list; },
  // Explicit-userKey pair — server/contacts.js#learnSenderNames runs inside
  // sync.js's background poll loop, which carries its own key end-to-end
  // instead of an ALS context. Same reasoning as getIdentitiesFor above.
  getContactsFor: (uKey) => loadFor(uKey, 'contacts', []),
  saveContactsFor(uKey, list) { saveFor(uKey, 'contacts', list); return list; },

  getFilters: () => load('filters', []),
  saveFilters(list) { save('filters', list); return list; },

  // Where a message was before it was filed into Junk or Archive, so "Not spam"
  // and "Unarchive" can put it back rather than dumping everything in the Inbox
  // (see server/refile.js, which owns the shape and the pruning). Keyed by the
  // uid the message landed under, which is the only handle that exists after a
  // move.
  //
  // viewerKey-scoped like everything else here, which has one visible
  // consequence on a SHARED account: if one person marks a message as spam and
  // another marks it not-spam, the second one has no record of where it came
  // from and it goes back to the Inbox. That is the documented fallback rather
  // than a failure, and it is much preferable to a grantee writing into the
  // owner's directory — see the userDir() comment above.
  getRefileOrigins: () => load('refile-origins', {}),
  saveRefileOrigins(map) { save('refile-origins', map); return map; },

  // Newsletters this person has unsubscribed from, keyed by the SENDER's
  // address — so every message from that newsletter says so, not just the one
  // the button was pressed on, which is the thing that was actually confusing:
  // opening another message from the same sender offered the button again with
  // no sign anything had happened.
  //
  // Keyed by sender rather than by unsubscribe target because that is what a
  // person means by "this newsletter"; a sender that runs several distinct
  // lists off one address will therefore read as unsubscribed after the first,
  // which is a deliberate trade for the common case. The button is still there
  // either way — this only changes what the banner SAYS.
  getUnsubscribes: () => load('unsubscribed', {}),
  saveUnsubscribes(map) { save('unsubscribed', map); return map; },

  // One Hmelj login can have several registered devices (phone, desktop,
  // tablet...) — see server/push.js for the add/remove/send logic built on
  // top of these. Explicit-userKey versions (not ALS-implicit like the rest
  // of this file) since server/sync.js's background poll loop is the other
  // caller — see the userDirFor/loadFor/saveFor comment above.
  listUserKeys,
  getPushSubscriptionsFor: (uKey) => loadFor(uKey, 'push-subscriptions', []),
  savePushSubscriptionsFor(uKey, list) { saveFor(uKey, 'push-subscriptions', list); return list; },
  // viewerKey, like userDir() above — a registered browser/phone belongs to the
  // person, not to any mail account they can see.
  getPushSubscriptions() { return this.getPushSubscriptionsFor(currentUser().viewerKey); },
  savePushSubscriptions(list) { return this.savePushSubscriptionsFor(currentUser().viewerKey, list); },

  // Per-date work-free overrides for the notification scheduler's holiday-skip option
  // (see server/schedule.js, server/holidays.js) — {'YYYY-MM-DD': true|false}, only
  // entries that differ from holidays.js's computed default are ever stored. Not
  // account-scoped (holidays are calendar facts, not tied to any one mail account).
  // Explicit-userKey pair needed since server/sync.js's background poll loop calls this
  // outside live-request ALS — same reasoning as getPushSubscriptionsFor above.
  getHolidayOverridesFor: (uKey) => loadFor(uKey, 'holiday-overrides', {}),
  saveHolidayOverridesFor(uKey, map) { saveFor(uKey, 'holiday-overrides', map); return map; },
  getHolidayOverrides() { return this.getHolidayOverridesFor(currentUser().viewerKey); },
  saveHolidayOverrides(map) { return this.saveHolidayOverridesFor(currentUser().viewerKey, map); },

  // A user's own holidays, on top of (not instead of) server/holidays.js's hardcoded
  // Slovenian calendar — see holidays.js#resolveHolidaysForYear. [{id, month, day, name,
  // workFree}], no year: recurs every year automatically, same as the built-in entries.
  // Lets a non-Slovenian user (this project being open-source and self-hosted — see the
  // plan doc) build their own country's holiday list without editing any code.
  // Explicit-userKey pair for the same reason as getHolidayOverridesFor above.
  getCustomHolidaysFor: (uKey) => loadFor(uKey, 'custom-holidays', []),
  saveCustomHolidaysFor(uKey, list) { saveFor(uKey, 'custom-holidays', list); return list; },
  getCustomHolidays() { return this.getCustomHolidaysFor(currentUser().viewerKey); },
  saveCustomHolidays(list) { return this.saveCustomHolidaysFor(currentUser().viewerKey, list); },
};
