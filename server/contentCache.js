// Hmelj — cache-first message content reads. The one place all "give me a
// parsed message" calls go through (the message-open route, and sync.js's
// proactive new-mail/backfill caching and push-notification preview) — on a
// cache hit this is a plain SQLite read, no IMAP/EWS round trip at all; on a
// miss it does the exact same live fetch as before and opportunistically
// populates the cache for next time. imapClient.js/ewsClient.js are
// untouched by this — matches this codebase's existing convention of
// keeping cache orchestration in callers (index.js, sync.js), not inside
// the protocol clients themselves.
import sanitizeHtml from 'sanitize-html';
import { config } from './config.js';
import { store } from './store.js';
import * as cache from './cache.js';
import * as accounts from './accounts.js';
import * as mailClient from './mailClient.js';
import { log } from './log.js';
import { receiptAddressOf } from './readReceipt.js';
import { repairQuotedPrintable } from './transferEncoding.js';

const slog = log.scope('contentCache');

/* ---------------- full-text index (cache.js#message_fts) ----------------
 *
 * Indexing lives here rather than in cache.js because this is where a parsed
 * message actually exists: cache.js stores JSON and knows nothing about which
 * of its fields are words a person would search for. It is also where the
 * per-account opt-in is checked, once, for both the on-write and backfill
 * paths.
 */

/** How much of one message's body to index. A newsletter can be hundreds of
 *  kilobytes of boilerplate, and nobody searches page nine of a marketing mail
 *  — but they do search the first screen of a long thread. Generous enough to
 *  cover any real correspondence, and it keeps one outlier from dominating the
 *  index the way it would otherwise dominate the content cache. */
const MAX_INDEX_CHARS = 64 * 1024;

/** How many already-cached-but-unindexed messages to index per folder per tick.
 *  Much larger than BACKFILL_BUDGET_PER_TICK below because this costs no
 *  network at all — the text is already in SQLite, and this is only tokenising
 *  it. Turning the flag on for an account with a warm cache should be a matter
 *  of a minute or two, not an afternoon. */
const INDEX_BUDGET_PER_TICK = 200;

const flatten = (html) => sanitizeHtml(html, {
  allowedTags: [], allowedAttributes: {},
  // Same list as the notification preview (server/sync.js) and for the same
  // reason: without it a message's <title> and its <style> sheet get indexed
  // as if they were body text, and every HTML mail matches on its CSS.
  nonTextTags: ['script', 'style', 'textarea', 'option', 'xmp', 'title', 'xml'],
});

const addrText = (list) => (list || []).map((a) => `${a.name || ''} ${a.address || ''}`).join(' ').trim();

/** The four indexable fields of a parsed message. Prefers the text/plain part
 *  and falls back to the HTML with its tags stripped — the same order the
 *  reading pane and the notification preview both use. */
function indexFieldsFor(msg) {
  const body = (msg?.text || (msg?.html ? flatten(msg.html) : '') || '').slice(0, MAX_INDEX_CHARS);
  return {
    body,
    subject: msg?.subject || '',
    sender: addrText(msg?.from),
    recipients: `${addrText(msg?.to)} ${addrText(msg?.cc)}`.trim(),
  };
}

/** Index one just-cached message, if its account asked for that. `rowid` is
 *  saveMessageContent()'s return. Never fatal: an index write that fails leaves
 *  indexed_at NULL, so the backfill pass below simply picks it up again. */
function indexIfEnabled(uKey, accountId, rowid, msg) {
  if (!rowid || !accounts.isSearchIndexed(uKey, accountId)) return;
  if (cache.searchIndexOverBudget(store.getSettingsFor(uKey).searchIndexMaxMb)) return;
  try { cache.indexMessageContent(rowid, indexFieldsFor(msg)); }
  catch (e) { slog.warn(`Could not index ${accountId}/${rowid}:`, e.message); }
}

// Not a user-facing setting (contentCacheLimit — "how many" — is; see
// store.js) — a safety valve so one unusually large HTML newsletter (embedded
// base64 images inline in the markup, not real attachments — those are never
// part of this cache, see cache.js's table comment) can't bloat the cache
// unbounded.
//
// It was 2MB, and that turned out to be exactly the wrong place to draw the
// line: the messages over it are the slowest to fetch and parse, so refusing to
// cache them meant the worst case was also the PERMANENT case. A 2.9MB
// newsletter cost a full Gmail round trip and a re-parse on every single open —
// about a second each time, and far worse whenever it landed behind a sync —
// forever, while a 20KB message opened instantly the second time. The valve was
// protecting a few megabytes of disk at the cost of the one thing the cache
// exists for.
//
// So the per-message ceiling is generous now, and the real bound is the one
// that was always doing the work: contentCacheLimit keeps only the newest N
// messages per folder. A second guard stops a pathological run of huge messages
// from filling the disk anyway — checked only for a message over BIG_BYTES, so
// ordinary mail never pays for the query.
const MAX_CACHE_BYTES = 12 * 1024 * 1024;         // 12MB of parsed JSON
const BIG_BYTES = 2 * 1024 * 1024;                // above this, check the total too
// A backstop against a pathological run of huge messages, NOT a working limit:
// contentCacheLimit is what actually sizes this cache, and on a real mailbox of
// twelve accounts it settles well under this. Set above what such an install
// uses, so it never refuses anything in ordinary service — if it ever does
// fire, the cache has grown in a way worth looking at rather than trimming
// silently.
const TOTAL_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Bump whenever messageParse.js starts producing a field the UI relies on.
 * Everything cached under an older stamp is re-fetched once, on next open.
 *
 *   1 — listUnsubscribe (2026-08-26)
 */
// 2 (2026-08-27): messages gained `invitation` — a meeting request parsed out
// of its text/calendar part. Nothing can synthesise that from an already-cached
// object the way normalize() repairs a shape, so this is the case the stamp
// exists for: every message re-parses once, on its next open.
// 3 (2026-09-03): messages gained `headers.auth` — the Authentication-Results
// reading (server/authResults.js). Nothing can synthesise it from an
// already-cached object the way normalize() repairs a shape: the evidence is in
// the raw headers, which the cache does not keep. So every message re-parses
// once, on its next open, rather than the trust badge being silently absent on
// exactly the messages read most often.
const CONTENT_VERSION = 3;

/**
 * Cache-first parsed-message read. Returns the exact same shape
 * mailClient.getMessage() always has (`{uid, subject, from, to, html,
 * text, attachments, ...}`) whether served from cache or fetched live.
 */
export async function getMessage(uKey, accountId, folder, uid) {
  if (config.cacheEnabled) {
    const cached = cache.getMessageContent(uKey, accountId, folder, uid);
    // A cached message is JSON written by whatever messageParse.js was running
    // at the time, and nothing ever re-parses it — so a message read often
    // enough to matter is exactly the one that never picks up a new field. That
    // is not theoretical: the read-receipt banner shipped reading a field that
    // every cached message lacked, and looked simply broken. A stamp mismatch
    // is treated as a miss: one live fetch, then it is current again.
    if (cached && cached.__v === CONTENT_VERSION) return normalize(cached);
  }
  const msg = await mailClient.getMessage(folder, uid);
  msg.__v = CONTENT_VERSION;
  if (config.cacheEnabled) {
    try {
      const json = JSON.stringify(msg);
      const tooBig = json.length > MAX_CACHE_BYTES
        || (json.length > BIG_BYTES && cache.messageContentBytes() + json.length > TOTAL_BUDGET_BYTES);
      const rowid = cache.saveMessageContent(uKey, accountId, folder, uid, tooBig ? null : msg, json.length);
      // Deliberately NOT indexed when it was too big to cache. The text is in
      // hand right here so it could be, but the row that would carry it has a
      // NULL content_json — nothing the backfill pass could ever re-read. It
      // would index once, on whichever open happened to fetch it, and then be
      // unreproducible: drop and rebuild the index and that one message
      // silently stops matching. An index that covers exactly what
      // message_content holds is one anybody can reason about; this would make
      // it "that, plus whatever was opened while the flag was on".
      if (!tooBig) indexIfEnabled(uKey, accountId, rowid, msg);
      if (tooBig) slog.debug(`${folder}/${uid}: parsed content is ${(json.length / 1024 / 1024).toFixed(1)}MB, over the cache cap — will stay live on every open`);
    } catch (e) {
      slog.warn(`Could not cache content for ${folder}/${uid}:`, e.message); // never let a caching failure break the actual read
    }
  }
  return normalize(msg);
}

/**
 * Fixes up a parsed message on the way out, for fields whose SHAPE has changed
 * since it might have been cached. Cached content is JSON written by whatever
 * version of messageParse.js was running at the time, and it is never
 * re-parsed on its own — so a parse-time fix reaches old rows only when they
 * happen to be evicted, which for a read-often message is never.
 *
 * Two things so far, both idempotent — running either on already-fixed content
 * gives back what it was handed:
 *
 *  - Disposition-Notification-To used to be stored as mailparser's address
 *    OBJECT, which the reading pane rendered as "[object Object]" in the
 *    read-receipt banner.
 *  - A text part that arrived as undecoded quoted-printable
 *    (server/transferEncoding.js). Repaired here as well as at parse time so
 *    the messages already in the cache — 14 of 2256 on the live instance —
 *    come right on the next read, rather than only if they are ever evicted.
 *    Cheaper than bumping CONTENT_VERSION, which would re-fetch every message
 *    in the cache to fix fourteen.
 */
function normalize(msg) {
  let out = msg;
  const dnt = out?.headers?.dispositionNotificationTo;
  if (dnt && typeof dnt !== 'string') {
    out = { ...out, headers: { ...out.headers, dispositionNotificationTo: receiptAddressOf(dnt) || null } };
  }
  if (out?.text) {
    const fixed = repairQuotedPrintable(out.text);
    if (fixed !== out.text) out = { ...out, text: fixed };
  }
  return out;
}

// Small, fixed per-tick budget for the backfill pass (catching up already-
// cached-envelope messages that don't have content cached yet) — same
// "never do it all at once" reasoning as sync.js's own
// FULL_RESYNC_EVERY_N_TICKS/DATE_SORT_CANDIDATE_CAP: a large backfill (a
// freshly-raised contentCacheLimit, or a folder that just entered scope)
// trickles in over several minutes of ticks instead of bursting a wall of
// fetches at once, which is exactly the kind of concurrent-load spike
// Gmail throttles hardest (see imapClient.js's connection pool comment).
// Genuinely NEW mail (see cacheNewMail below) is never subject to this —
// it's naturally small per tick and should never wait behind a backlog.
const BACKFILL_BUDGET_PER_TICK = 8;

/** Proactively cache content for every message in `messages` (already
 * envelope-cached elsewhere by the caller) — used for genuinely new mail,
 * uncapped since that set is naturally small (a handful of messages per
 * folder per tick, not a backlog). Errors on one message never abort the
 * rest — a slow/broken fetch for one shouldn't cost the others their cache
 * warm-up. */
export async function cacheMessages(uKey, accountId, folder, messages) {
  if (!config.cacheEnabled) return;
  for (const m of messages) {
    try { await getMessage(uKey, accountId, folder, m.uid); }
    catch (e) { slog.debug(`${folder}/${m.uid}: proactive cache fetch failed:`, e.message); }
  }
}

/**
 * Throttled catch-up pass: content-cache whichever of the newest
 * `contentCacheLimit` (Settings > General) envelope-cached messages in this
 * folder don't have it yet, up to BACKFILL_BUDGET_PER_TICK per call, then
 * prune anything that's fallen out of that window. Safe to call every poll
 * tick regardless of whether this folder had any new mail this time.
 */
export async function backfillAndPrune(uKey, accountId, folder) {
  if (!config.cacheEnabled) return;
  const limit = store.getSettings().contentCacheLimit;
  if (!limit) { cache.pruneMessageContent(uKey, accountId, folder, []); return; } // disabled — don't keep a stale cache around either
  const recentUids = cache.getRecentUids(uKey, accountId, folder, limit);
  const already = new Set(cache.getCachedContentUids(uKey, accountId, folder, recentUids));
  const missing = recentUids.filter((u) => !already.has(u)).slice(0, BACKFILL_BUDGET_PER_TICK);
  for (const uid of missing) {
    try {
      await getMessage(uKey, accountId, folder, uid);
    } catch (e) {
      slog.debug(`${folder}/${uid}: backfill cache fetch failed:`, e.message);
      // "Message not found" means the server no longer has it — the envelope
      // row is stale. Most common cause: a message deleted through Gmail's All
      // Mail (or any other label view), which removes it from every label,
      // while the cache only ever cleaned the folder the delete was aimed at.
      //
      // Dropping the row now rather than waiting for the next full scan to
      // prune it matters for more than tidiness: a dead uid stays in
      // getRecentUids and so keeps consuming this tick's backfill budget, which
      // means genuinely cacheable messages don't get pre-fetched for as long as
      // it lingers (up to ~20 minutes at the default full-scan cadence).
      //
      // Deliberately narrow — only this one error, never a generic failure. A
      // timeout or a dropped connection says nothing about whether the message
      // still exists, and evicting on those would remove rows that are fine.
      if (/message not found/i.test(e.message || '')) {
        const delta = cache.removeMessages(uKey, accountId, folder, [uid]);
        cache.adjustFolderCounts(uKey, accountId, folder, delta);
        slog.debug(`${folder}/${uid}: gone from the server — dropped the stale cache row`);
      }
    }
  }
  cache.pruneMessageContent(uKey, accountId, folder, recentUids);
  indexBackfill(uKey, accountId, folder);
}

/**
 * Indexes whatever content is cached for this ACCOUNT but not yet in the
 * full-text index. Runs last in the tick, after the prune, so it never spends
 * its budget on rows that are about to be thrown away.
 *
 * Account-wide, not folder-wide: see cache.js#unindexedContent. Called once per
 * polled folder, which is redundant only until the backlog drains — after that
 * it is one indexed query returning nothing.
 *
 * This is what makes turning the flag on retroactive: the bodies are already in
 * message_content for the newest contentCacheLimit messages of every synced
 * folder, so enabling the setting does not need to re-fetch anything from the
 * mail server — it just has to tokenise what is already on disk. A cache warmed
 * over normal use is therefore searchable within a couple of poll ticks.
 *
 * Synchronous and unawaited-looking on purpose: there is no I/O here beyond
 * SQLite, so there is nothing to await, and the whole budget is a few tens of
 * milliseconds of tokenising.
 */
function indexBackfill(uKey, accountId, folder) {
  if (!accounts.isSearchIndexed(uKey, accountId)) return;
  if (cache.searchIndexOverBudget(store.getSettingsFor(uKey).searchIndexMaxMb)) {
    slog.debug(`${folder}: search index is at its size limit — not indexing further for now`);
    return;
  }
  let pending;
  try { pending = cache.unindexedContent(uKey, accountId, INDEX_BUDGET_PER_TICK); }
  catch (e) { slog.warn(`Could not read the index worklist for ${folder}:`, e.message); return; }
  if (!pending.length) return;
  let done = 0;
  for (const row of pending) {
    try {
      // The stored JSON, not a re-fetch — that is the whole point of this pass.
      // A row that will not parse is corrupt rather than merely stale, so mark
      // it indexed-as-empty instead of leaving it to be retried every tick
      // forever; the next re-cache of that message replaces it properly.
      let msg = null;
      try { msg = JSON.parse(row.contentJson); } catch { msg = null; }
      cache.indexMessageContent(row.rowid, msg ? indexFieldsFor(msg) : {});
      done++;
    } catch (e) {
      slog.warn(`Could not index ${row.folder}/${row.uid}:`, e.message);
    }
  }
  if (done) slog.debug(`${folder}: indexed ${done} cached message(s) for search`);
}
