import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from './config.js';
import { store } from './store.js';
import { currentUser } from './session.js';
import { currentAccount } from './accounts.js';
// Only for an IMAP account that signs in instead of storing a password (Gmail):
// accessTokenFor() hands back a bearer token to authenticate with via XOAUTH2.
import * as oauth from './oauth.js';
import { log } from './log.js';
import { parseMessage, parseHeadersBlock, parseAttachment } from './messageParse.js';
import { threadKeyFrom, firstReference, normalizeId } from './threading.js';
import { sortFolderTree } from './folderTree.js';
import { parseSearchQuery } from './searchQuery.js';

const ilog = log.scope('imap');

/** One search term (see searchQuery.js) → an imapflow SearchObject matching it.
 *  Unscoped (field===null) deliberately excludes body — only an explicit body: term
 *  searches message text, since that's the one thing that forces this whole call live
 *  instead of being answerable from the cache (see server/index.js's queryNeedsBodySearch
 *  gate and server/cache.js's own mirrored search-clause builder). */
function termToSearchObject({ field, text }, fullText = false) {
  if (field === 'from') return { from: text };
  if (field === 'to') return { to: text };
  if (field === 'subject') return { subject: text };
  if (field === 'body') return { body: text };
  // `fullText` is "search everywhere" (server/index.js's scope=account branch):
  // there the user has explicitly asked the SERVER to look, so an unscoped term
  // means the whole message. TEXT is exactly that in one key — headers and body
  // — rather than an OR of the three header fields.
  return fullText ? { text } : { or: [{ subject: text }, { from: text }, { to: text }] };
}

/**
 * ANDs an arbitrary list of SearchObjects. imapflow has no direct "and" key — RFC 3501
 * ANDs same-level search keys implicitly, which only works when every part uses a
 * DIFFERENT key name; several OR-shaped or NOT-shaped parts collide on the same `or`/
 * `not` key if just spread into one object. NOT(OR(NOT q1, NOT q2, ...)) = q1 AND q2
 * AND ... (De Morgan) sidesteps that using only the not/or primitives imapflow does
 * support arbitrary nesting of. Lists of 0/1 items skip the wrapping entirely — by far
 * the common case (a single search term needs no double-negation noise in the actual
 * IMAP command sent).
 */
function andAll(parts) {
  const list = parts.filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  return { not: { or: list.map((q) => ({ not: q })) } };
}

/** Parses the search box's raw query text (searchQuery.js's +/-/"..."/field: syntax)
 *  into one imapflow SearchObject, or null for an empty/whitespace-only query. Required
 *  terms are ANDed together; excluded terms are ANDed in as NOT. */
export function buildImapSearchCriteria(query, fullText = false) {
  const { required, excluded } = parseSearchQuery(query);
  const parts = [
    ...required.map((t) => termToSearchObject(t, fullText)),
    ...excluded.map((t) => ({ not: termToSearchObject(t, fullText) })),
  ];
  return andAll(parts);
}

// One pooled IMAP connection per (user, mail account), closed after 10 min
// idle — SHARED between interactive requests and the background poller
// (server/sync.js). This used to give the poller its own separate
// connection (key suffixed `:sync`), on the theory that a big sync fetch
// shouldn't block an interactive click. In practice, for Gmail specifically,
// that made things much worse: Gmail throttles accounts showing multiple
// concurrent IMAP sessions doing heavy work far more aggressively than it
// throttles a single session doing the same work sequentially — confirmed
// by the same Gmail account being fast before the background poller existed
// at all, and by ordinary sequential contention (queueing on one shared
// connection's mailbox lock) being a much smaller cost than what was
// actually observed (10-30s+ per call). One connection per account matches
// how a normal mail client behaves and avoids that penalty; interactive
// requests simply queue briefly behind an in-progress sync fetch instead.
const pool = new Map(); // `${userKey}:${accountId}` -> { client, connecting, lastUsed, lastPing }
const IDLE_CLOSE_MS = 10 * 60e3;
const SOCKET_TIMEOUT_MS = 30000;
// Keepalive interval for pooled connections, comfortably under
// SOCKET_TIMEOUT_MS so a NOOP always lands before the socket's inactivity
// timer can fire. This is what a normal mail client does with a connection it
// intends to reuse; without it, every pooled connection whose last command
// didn't select a mailbox died after 30 idle seconds, logged a warning, and
// cost a full TLS+LOGIN round trip (~1s against Gmail) on the next request.
const KEEPALIVE_AFTER_MS = 20e3;
// How often the pool is swept for both jobs (keepalive and idle-close). Has to
// be well under KEEPALIVE_AFTER_MS's headroom, so 5s rather than the 60s this
// used to run at — a 60s sweep could never have kept a 30s timeout alive.
const POOL_SWEEP_MS = 5e3;

/**
 * Runs `fn` with this connection's inactivity timeout temporarily raised, for
 * a command known to go quiet for a long time on a big mailbox (see
 * emptyFolder). Restores the normal bound afterwards, including on failure —
 * the 30s default exists so a stuck command can't hold the shared connection
 * hostage, and that must not be permanently traded away for one slow call.
 */
async function withLongTimeout(c, ms, fn) {
  const sock = c.socket;
  try { sock?.setTimeout?.(ms); } catch { /* not a socket we can retune — proceed as-is */ }
  try {
    return await fn();
  } finally {
    try { sock?.setTimeout?.(SOCKET_TIMEOUT_MS); } catch { /* noop */ }
  }
}

/**
 * `ownerKey` is where a rotated refresh token gets written back, so it must be
 * the ACCOUNT'S OWNER's key, not the viewer's — for a shared account those
 * differ, and currentUser().userKey is already the owner's (requireAuth swaps
 * the ALS context for a shared account). Async only for the OAuth case: an
 * account with an `oauth` block authenticates with a bearer token instead of a
 * password (Gmail — see server/oauth.js), and the token has to be minted or
 * refreshed before the socket is opened. Every reconnect therefore picks up a
 * fresh token automatically, which is what keeps a pooled connection working
 * across the token's 1-hour lifetime.
 */
async function newImapConnection(acc, ownerKey) {
  const auth = acc.oauth
    ? { user: acc.imap.user, accessToken: await oauth.accessTokenFor(acc, ownerKey) }
    : { user: acc.imap.user, pass: acc.imap.pass };
  return new ImapFlow({
    host: acc.imap.host,
    port: acc.imap.port,
    secure: acc.imap.secure,
    auth,
    logger: false,
    tls: { rejectUnauthorized: acc.imap.tlsRejectUnauthorized },
    // ImapFlow's own default is 300000 (5 minutes) — reasonable for a
    // long-lived background worker, much too long for a connection that
    // interactive requests (opening a message) also share. If a server
    // goes fully silent mid-command (not just slow — this only fires on
    // true inactivity, it resets on any data received, so a genuinely slow
    // but still-responding fetch is unaffected), the whole shared
    // connection was hanging for up to 5 minutes, blocking every other
    // request for that account behind it — including ones with nothing to
    // do with whatever got stuck. 30s bounds that to something a user
    // won't mistake for the app having frozen.
    //
    // Two consequences of this number, both seen in the wild, both handled
    // elsewhere rather than by raising it:
    //  - It is an OS-level socket inactivity timeout, so it also fires on an
    //    IDLE POOLED CONNECTION, not just mid-command. ImapFlow recovers
    //    gracefully while a connection is in IMAP IDLE (NOOP + re-IDLE), but it
    //    only auto-IDLEs in SELECTED state — a connection whose last command
    //    was a LIST or STATUS (listFolders/folderStatus select nothing) sits in
    //    AUTHENTICATED state, sends nothing, and gets killed at 30s with an
    //    emitted error. Hence the pool keepalive above.
    //  - A single command that is legitimately silent for longer than this gets
    //    cut off. Emptying a large Gmail Trash is the real case: one observed
    //    run took 26.3s, inside this window only by luck. Hence withLongTimeout.
    socketTimeout: SOCKET_TIMEOUT_MS,
  });
}

async function getClient() {
  const { userKey, accountId, purpose } = currentUser();
  const acc = currentAccount();
  // Same shared connection as always, UNLESS this account opted in
  // (Settings > that account > "Allow a second connection") AND the current
  // call is tagged purpose:'sync' (the background poller, and on-demand
  // syncs like the refresh button — see session.js#runAsAccount/
  // runWithAccount). Then background sync gets its own connection instead
  // of contending with interactive requests for the one shared one — an
  // opened message no longer queues behind an in-flight sync on accounts
  // that turn this on. Off (default) is byte-for-byte the old behavior.
  const useSecondConnection = purpose === 'sync' && acc.allowSecondConnection;
  const key = useSecondConnection ? `${userKey}:${accountId}:sync` : `${userKey}:${accountId}`;
  let entry = pool.get(key);
  if (!entry) { entry = { client: null, connecting: null, lastUsed: Date.now() }; pool.set(key, entry); }
  entry.lastUsed = Date.now();
  if (entry.client && entry.client.usable) return entry.client;
  if (entry.connecting) return entry.connecting;
  entry.connecting = (async () => {
    ilog.debug(`Connecting ${key} (${acc.imap.host}:${acc.imap.port}${acc.oauth ? ', xoauth2' : ''})`);
    const c = await newImapConnection(acc, userKey);
    c.on('error', (e) => { ilog.warn(`Connection error ${key}:`, e.message); if (entry.client === c) entry.client = null; });
    c.on('close', () => { ilog.debug(`Connection closed ${key}`); if (entry.client === c) entry.client = null; });
    await c.connect();
    ilog.debug(`Connected ${key}`);
    entry.client = c;
    entry.connecting = null;
    return c;
  })();
  try {
    return await entry.connecting;
  } catch (e) {
    entry.connecting = null;
    ilog.warn(`Connect failed ${key}:`, e.message);
    throw e;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pool) {
    // Long unused: close it deliberately (a clean LOGOUT) rather than leaving
    // it to be killed by a timeout.
    if (now - entry.lastUsed > IDLE_CLOSE_MS) {
      ilog.debug(`Closing idle connection ${key}`);
      try { entry.client?.logout().catch(() => {}); } catch { /* noop */ }
      pool.delete(key);
      continue;
    }
    const c = entry.client;
    if (!c || !c.usable) continue;
    // In IMAP IDLE, imapflow keeps the socket alive itself and handles a
    // timeout by recovering rather than erroring — leave those alone.
    if (c.idling) continue;
    // A command is already in flight, so either data is flowing or it's the
    // long-silent-command case, which a queued NOOP cannot help with anyway.
    if (c.currentRequest) continue;
    const quietSince = Math.max(entry.lastUsed, entry.lastPing || 0);
    if (now - quietSince < KEEPALIVE_AFTER_MS) continue;
    entry.lastPing = now;
    keepalive(key, c);
  }
}, POOL_SWEEP_MS).unref();

/** How long a keepalive NOOP — one round trip on an idle connection — may take
 *  before the connection is presumed dead. Deliberately far below
 *  SOCKET_TIMEOUT_MS: the whole point is to find out BEFORE a click does. */
const KEEPALIVE_DEADLINE_MS = 10e3;

/**
 * One keepalive round trip, and the pool's only chance to notice a dead
 * connection on its own.
 *
 * A NOOP that fails is the most useful signal this pool ever gets, and it used
 * to be logged at debug and thrown away — the corpse stayed in the pool until
 * somebody's click took the mailbox lock on it and waited out the full
 * SOCKET_TIMEOUT_MS (30s) before withMailbox's retry rescued it. That is a
 * thirty-second message open, and it was reported as one: four opens on a Gmail
 * account at 29.5s / 34.1s / 35.7s / 29.7s, where the first spent ~29.5s
 * discovering a dead socket and the other three merely queued behind it on the
 * account's single shared connection (2–5s of real work each).
 *
 * A NOOP that never answers at all is the same thing wearing a disguise, and
 * was worse: the sweep skips a connection with `currentRequest` set, so a hung
 * NOOP made the connection permanently exempt from further keepalives — it
 * could never be noticed again.
 */
function keepalive(key, c) {
  let settled = false;
  const giveUp = (why) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    ilog.debug(`Keepalive failed ${key} (${why}) — dropping it so the next request dials a fresh one`);
    dropPooled(c);
    try { c.close?.(); } catch { /* already gone */ }
  };
  const timer = setTimeout(() => giveUp(`no answer in ${KEEPALIVE_DEADLINE_MS}ms`), KEEPALIVE_DEADLINE_MS);
  timer.unref?.();
  c.noop().then(
    () => { settled = true; clearTimeout(timer); },
    (e) => giveUp(e.message),
  );
}

/** True for a failure that means "the connection went away underneath us", as
 * opposed to the server refusing the command. ImapFlow tags the first kind
 * with code 'NoConnection' (see createNoConnectionError) or 'ETIMEOUT'; the
 * message match is a belt-and-braces fallback for socket-level errors that
 * arrive without one. */
function isConnectionGone(e) {
  const code = e?.code;
  if (code === 'NoConnection' || code === 'ETIMEOUT' || code === 'ECONNRESET' || code === 'EPIPE') return true;
  return /connection (not available|closed|ended)|socket (timeout|closed|hang up)|not connected/i.test(e?.message || '');
}

/** Forgets a specific client so the next getClient() dials a fresh one. Matched
 * by identity, so a connection that has already been replaced isn't disturbed. */
function dropPooled(client) {
  for (const entry of pool.values()) {
    if (entry.client === client) entry.client = null;
  }
}

/**
 * Close and forget every pooled connection for one account, so the next request
 * dials a fresh one. Called after the account's credential changes underneath
 * us (switching an app password to an OAuth sign-in, re-signing in): the open
 * connection is still authenticated with the OLD credential and would keep
 * working until it happened to drop, which is confusing when the user has just
 * revoked what it authenticated with.
 */
export function dropAccountConnections(uKey, accountId) {
  for (const [key, entry] of [...pool]) {
    if (key !== `${uKey}:${accountId}` && key !== `${uKey}:${accountId}:sync`) continue;
    ilog.debug(`Dropping pooled connection ${key} (credential changed)`);
    try { entry.client?.logout().catch(() => {}); } catch { /* already gone */ }
    pool.delete(key);
  }
}

async function withMailbox(path, fn, readOnly = false) {
  // One retry on a fresh connection, and ONLY for a read-only operation.
  //
  // Why this exists: every caller queues on the account's single shared
  // connection via getMailboxLock, and when that connection dies, ImapFlow
  // rejects every waiting lock with 'Connection not available'. Observed with
  // Gmail: emptying a 3000-message Trash took 58s, Gmail sent FIN the moment
  // the EXPUNGE completed, and the three ordinary list requests that had piled
  // up behind it all failed with a 500 — even though the very next request,
  // on the reconnected socket, succeeded in 684ms. Retrying turns that into
  // three successes instead of three errors the user sees for no reason.
  //
  // Read-only only, on purpose: the mailbox was opened with EXAMINE, so nothing
  // can have been half-applied server-side and re-running costs only time. A
  // mutating command that lost its connection must NOT be blind-retried —
  // there is no way to tell from here whether the server applied it before the
  // socket died, and "delete/move it twice" is worse than one honest error.
  for (let attempt = 0; ; attempt++) {
    const c = await getClient();
    try {
      const lock = await c.getMailboxLock(path, { readOnly });
      try {
        return await fn(c);
      } finally {
        lock.release();
      }
    } catch (e) {
      if (attempt === 0 && readOnly && isConnectionGone(e)) {
        ilog.debug(`${path}: connection went away (${e.message}) — retrying on a fresh one`);
        dropPooled(c);
        continue;
      }
      throw e;
    }
  }
}

// ---------- folders ----------

export async function listFolders() {
  const c = await getClient();
  const t0 = Date.now();
  const list = await c.list({ statusQuery: { messages: true, unseen: true } });
  const hidden = new Set(currentAccount().hiddenFolders || []);
  const result = sortFolderTree(list
    .filter((f) => !f.flags?.has('\\Noselect'))
    .map((f) => ({
      path: f.path,
      name: f.name,
      delimiter: f.delimiter,
      parent: f.parentPath || null,
      specialUse: f.specialUse || null,
      subscribed: f.subscribed !== false,
      hidden: hidden.has(f.path),
      total: f.status?.messages ?? null,
      unseen: f.status?.unseen ?? null,
    })));
  ilog.debug(`listFolders: ${result.length} folders (${Date.now() - t0}ms)`);
  return result;
}

/**
 * Real total/unseen for a single folder, straight from the server — no
 * mailbox select needed, STATUS works on any folder regardless of what's
 * currently open. Used instead of approximating from cache row counts
 * (cache.js#recomputeFolderCounts), which under-counts whenever the cache
 * doesn't hold every message in that folder (only the newest
 * syncBackfillLimit are kept) — an older unread message outside that
 * window would silently vanish from the badge even though it's still
 * genuinely unread on the server.
 */
export async function folderStatus(path) {
  const c = await getClient();
  const status = await c.status(path, { messages: true, unseen: true });
  return { total: status?.messages ?? 0, unseen: status?.unseen ?? 0 };
}

export async function createFolder(path) {
  const c = await getClient();
  return c.mailboxCreate(path);
}

export async function deleteFolder(path) {
  const c = await getClient();
  return c.mailboxDelete(path);
}

export async function renameFolder(path, newPath) {
  const c = await getClient();
  return c.mailboxRename(path, newPath);
}

// Emptying a folder is one bulk store + one EXPUNGE over everything in it, and
// the server answers nothing at all until it's finished — 26.3s for a Gmail
// Trash in one observed run, which is inside the normal 30s inactivity bound
// only by luck. A bigger Trash would have been cut off mid-expunge, so this
// one call gets a much longer leash (see withLongTimeout).
const EMPTY_FOLDER_TIMEOUT_MS = 10 * 60e3;

export async function emptyFolder(path) {
  return withMailbox(path, async (c) => {
    const uids = await c.search({ all: true }, { uid: true });
    if (!uids || !uids.length) return { deleted: 0 };
    await withLongTimeout(c, EMPTY_FOLDER_TIMEOUT_MS, () => c.messageDelete(uids, { uid: true })); // flags \Deleted + expunge
    return { deleted: uids.length };
  });
}

/** "Mark all as read" for a whole folder — same cheap search-then-act shape
 * as emptyFolder above (a real IMAP SEARCH for the full matching UID set,
 * not a paginated envelope fetch just to read off uids) rather than routing
 * through listMessages, which would pull full envelopes for every unread
 * message for no reason here. */
export async function markAllRead(path) {
  return withMailbox(path, async (c) => {
    const uids = await c.search({ seen: false }, { uid: true });
    if (!uids || !uids.length) return { marked: 0, uids: [] };
    await c.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
    return { marked: uids.length, uids };
  });
}

// ---------- message list ----------

async function parseHeaderFallback(headersBuf) {
  try {
    const parsed = await simpleParser(headersBuf.toString() + '\r\n\r\n');
    return {
      subject: parsed.subject,
      from: parsed.from?.value,
      to: parsed.to?.value,
      date: parsed.date,
    };
  } catch {
    return {};
  }
}

function addrList(a) {
  if (!a) return [];
  const values = Array.isArray(a) ? a : (Array.isArray(a.values) ? a.values : []);
  return values.map((x) => ({ name: x.name || '', address: x.address || '' }));
}

// Cap on how many of a folder's newest messages are considered when figuring
// out true date order (see listMessages below) — fetching envelope+date for
// every candidate is the expensive part (a Gmail INBOX with ~35k messages
// took 20-30s PER CALL doing that for the whole mailbox), so large folders
// need the candidate pool bounded well below their real size.
// DATE_SORT_FULL_SCAN_LIMIT is the total below which that's cheap enough to
// just check every message's real date and skip candidate-selection
// entirely.
//
// Above that, candidates used to be picked by raw UID order (highest UID =
// assumed newest). IMAP UIDs ARE strictly increasing with arrival time by
// protocol guarantee for a real folder — but that guarantee does NOT hold
// for Gmail's virtual label folders (INBOX included, not just Sent/label
// views): a message's UID there reflects when Gmail's indexer attached that
// label to it, not its Date header, so a years-old thread that gets
// relabeled or gets a fresh reply can surface with a brand-new UID despite
// an old Date header. Slicing candidates by raw UID order before checking
// dates therefore both (a) let old resurfaced mail sneak into "newest N"
// (a stray 2011 message turning up on page 2 of a 2026 inbox) and (b) could
// silently exclude genuinely recent messages that happened to land on a
// numerically lower UID (this is what once caused a Sent view to appear
// truncated at a fixed date, with newer mail never deleted, just never
// looked at).
//
// candidatesBySinceWindow replaces that guess with a real one: IMAP SEARCH
// SINCE filters by the message's actual internal date (assigned once, at
// original receipt — Gmail does not rewrite it on relabel), so asking "what
// arrived in the last N days" is an accurate temporal query, not a
// UID-order assumption. Widening progressively keeps the common case (an
// active mailbox) to one or two cheap SEARCH round trips before it has
// enough candidates, without ever fetching envelopes for more than
// `needed` of them.
const DATE_SORT_CANDIDATE_CAP = 400;
/*
 * These two numbers encode which of the two costs here is the expensive one,
 * and an earlier revision of this file got that backwards. Setting the record
 * straight, from measurements on real Gmail accounts:
 *
 *   - A date FETCH is CHEAP: ~1ms per message. Evidence: a 2598-message Gmail
 *     INBOX date-scanned in full, plus its SEARCH and page fetch, in 2441ms.
 *   - A SEARCH is EXPENSIVE: ~1-1.5s each, and All Mail is worse. Evidence:
 *     [Gmail]/Vsa pošta, 2182 messages, narrowed to 418 candidates by the
 *     window walk — 11.8s, and 11.5s again on the next call with the mailbox
 *     already selected, so it wasn't connect or SELECT cost. Only ~0.4s of
 *     that was the 418 date fetches; the rest was the walk's own SEARCHes.
 *
 * The previous values (limit 1500, windows starting at 7 days) traded cheap
 * fetches for expensive searches and made a 2182-message folder take 11.8s
 * where dating all of it takes ~2s. So: date-scan outright up to a generous
 * size, and when a folder IS big enough to need narrowing, get there in as few
 * SEARCH round trips as possible rather than creeping up in small steps.
 */
/*
 * 2000, not 5000. This number has moved twice, so the reasoning for where it
 * sits now matters:
 *
 *   - It was 5000, then briefly 1500. At 1500 a 2182-message Gmail folder took
 *     11.8s, because the window ladder was SEVEN fine steps (7/14/30/90/180/
 *     365/730) and each miss cost a ~1s Gmail SEARCH. So it went back to 5000.
 *   - The ladder is now three coarse steps plus one proportional narrowing
 *     pass, so the windowed path costs at most 2-3 SEARCHes rather than up to
 *     eight. That is what makes a lower bar safe again.
 *   - And the per-phase timings added since then show what the full scan
 *     actually costs on real folders in this band: a 4741-message Gmail Sent
 *     spent `dates 3347` (0.71ms/message) and a 4443-message INBOX spent
 *     `dates 5989` (1.35ms/message) — ~9.3s across two folders, on every full
 *     pass, to pick the newest 250 of each. Windowing those costs 1-3s.
 *
 * Anything above this narrows first; below it, the full date scan stays,
 * because it is both cheap at that size and exact.
 */
const DATE_SORT_FULL_SCAN_LIMIT = 2000;
// Three coarse steps, not seven fine ones: each miss costs a full SEARCH, and
// overshooting the candidate count costs almost nothing by comparison (see
// above). 30 days covers any active mailbox on the first try; 180 and 730 are
// there for quiet ones, and anything still short falls through to the exact
// path below.
const SINCE_WINDOW_DAYS = [30, 180, 730];

// A search query changes the calculus above: a broad term easily matches hundreds of
// messages well under DATE_SORT_FULL_SCAN_LIMIT (519, in the report that prompted this),
// which used to mean "cheap enough, fetch envelope+date for every one of them" — except
// that's the exact multi-second-per-account cost this was all trying to avoid; a search
// result set doesn't get the same "usually small" assumption a folder-browse total does.
// listMessages() below only skips candidatesBySinceWindow when total<=needed (genuinely
// few matches — the common case for a distinctive term, where full-scan was never
// expensive anyway) OR there's no query at all (folder browsing keeps its exact
// behavior, unchanged). This still uses real IMAP SEARCH SINCE queries, not a UID-order
// guess — the Gmail-relabeling risk described above applies equally to search results,
// so this deliberately does NOT fall back to assuming UID order approximates date order.

// A window that answers with more than this multiple of `needed` is worth one
// extra SEARCH to tighten, since the surplus is paid for one envelope date
// fetch at a time. 4x keeps ordinary overshoot alone.
const OVERSHOOT_FACTOR = 4;

async function candidatesBySinceWindow(c, baseSearch, needed, allUidsDesc) {
  const searchSince = async (days) =>
    (await c.search({ ...baseSearch, since: new Date(Date.now() - days * 86400e3) }, { uid: true })) || [];

  for (const days of SINCE_WINDOW_DAYS) {
    const found = await searchSince(days);
    if (found.length < needed) continue; // too few — widen
    // Enough candidates. But a busy mailbox can answer even the narrowest step
    // with far more than needed: a 5200-message folder where everything arrived
    // in the last 25 days returned ALL 5200 for the 30-day window, and then
    // spent 2.2s dating every one of them to pick 50. So when the overshoot is
    // large, narrow once, proportionally — a single extra SEARCH in exchange for
    // thousands of fetches. Deliberately one pass, not another ladder: two
    // SEARCHes is the budget, and the estimate only has to land in the right
    // order of magnitude.
    if (found.length > needed * OVERSHOOT_FACTOR) {
      const narrower = Math.max(1, Math.ceil((days * needed * 2) / found.length));
      if (narrower < days) {
        const tighter = await searchSince(narrower);
        // Only if it still covers what we need — if the narrowing overshot the
        // other way, the wider result is known-good and already in hand.
        if (tighter.length >= needed) return tighter;
      }
    }
    return found;
  }
  // Even ~2 years of SINCE-window search didn't turn up `needed` messages, and
  // anything reaching this function is already bigger than
  // DATE_SORT_FULL_SCAN_LIMIT — so this is a genuinely huge AND dormant folder.
  // Fall back to the UID-order guess rather than fetching envelopes for the
  // whole mailbox, which is exactly the slowness this cap exists to avoid; a
  // fully accurate answer isn't worth a 20-30s call for this edge case.
  return allUidsDesc.slice(0, needed);
}

export async function listMessages(path, { page = 1, pageSize = 50, query = '', unreadOnly = false, flaggedOnly = false, fullText = false } = {}) {
  const settings = store.getSettings();
  const t0 = Date.now();
  return withMailbox(path, async (c) => {
    const search = {};
    if (!settings.showDeleted) search.deleted = false;
    if (unreadOnly) search.seen = false;
    if (flaggedOnly) search.flagged = true;
    const criteria = query ? buildImapSearchCriteria(query, fullText) : null;
    if (criteria) Object.assign(search, criteria);
    const found = await c.search(Object.keys(search).length ? search : { all: true }, { uid: true });
    const tSearch = Date.now();
    const uids = found || [];
    const total = uids.length;
    if (!total) return { total: 0, page, pageSize, messages: [] };

    // IMAP UIDs are usually assigned roughly in date order, but that's not
    // guaranteed (a migrated/imported mailbox is the common case where it
    // isn't) — slicing the page by UID first can silently hide the true
    // newest message from page 1. So: cheaply fetch just each candidate's
    // date first, sort those, THEN fetch full envelopes only for the
    // actual page — two round trips, but the first carries far less data
    // than a full envelope+bodyStructure fetch would for the same count.
    uids.sort((a, b) => b - a);
    // The needed count is a floor on correctness, not a ceiling on how much
    // a caller asked for — otherwise a request for pageSize/page beyond the
    // cap (the sync poller asking for up to the user's configured backfill depth)
    // would silently get truncated to whatever the cap is. Skip candidate
    // selection (fetch every real match's date) only when that's cheap regardless
    // of why — genuinely few matches, or plain folder browsing with no query at
    // all — see the comment on the constants above for why a search specifically
    // can't just reuse the plain DATE_SORT_FULL_SCAN_LIMIT check on its own.
    const needed = Math.max(DATE_SORT_CANDIDATE_CAP, page * pageSize);
    const skipWindowing = total <= needed || (!query && total <= DATE_SORT_FULL_SCAN_LIMIT);
    const candidates = skipWindowing
      ? uids
      : await candidatesBySinceWindow(c, search, needed, uids);
    const tWindow = Date.now();
    const dated = [];
    for await (const msg of c.fetch(candidates, { uid: true, envelope: true, internalDate: true }, { uid: true })) {
      // A message's own Date: header (envelope.date) can be missing or
      // unparseable (malformed/spam mail) — falling back straight to 0
      // in that case sank it to the very bottom of a DESC sort, off page 1
      // entirely, regardless of how recently it actually arrived. INTERNALDATE
      // is server-assigned on arrival and always present, so it's a far
      // better fallback than 0 — this is what caused a genuinely new, unread
      // message to be invisible in the normal list (only showing up once the
      // "unread only" filter reduced the candidate set to just itself).
      const date = msg.envelope?.date ? new Date(msg.envelope.date).getTime() : (msg.internalDate ? new Date(msg.internalDate).getTime() : 0);
      dated.push({ uid: msg.uid, date });
    }
    const tDates = Date.now();
    dated.sort((a, b) => b.date - a.date);
    const pageUids = dated.slice((page - 1) * pageSize, page * pageSize).map((d) => d.uid);

    const messages = [];
    if (pageUids.length) {
      for await (const msg of c.fetch(pageUids, { uid: true, envelope: true, flags: true, size: true, bodyStructure: true, internalDate: true, headers: ['from', 'to', 'subject', 'date', 'references'] }, { uid: true })) {
        messages.push(await toEnvelope(msg));
      }
    }
    messages.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    // Broken down by phase on purpose: "11.8s" alone can't tell you whether the
    // time went on SEARCHes or on fetches, and those two want opposite fixes
    // (see the note on DATE_SORT_FULL_SCAN_LIMIT).
    ilog.debug(`listMessages ${path}: total=${total} candidates=${candidates.length} page=${page}/${Math.ceil(total / pageSize)} returned=${messages.length}`
      + ` (${Date.now() - t0}ms: search ${tSearch - t0}, window ${tWindow - tSearch}, dates ${tDates - tWindow}, page ${Date.now() - tDates})`);
    return { total, page, pageSize, messages };
  }, true);
}

async function toEnvelope(msg) {
  const hasAttachment = hasAttachments(msg.bodyStructure);
  // Some minimal servers return an empty ENVELOPE — fall back to raw headers
  let env = msg.envelope || {};
  if (!env.subject && !env.from && msg.headers) {
    env = await parseHeaderFallback(msg.headers);
  }
  return {
    uid: msg.uid,
    subject: env.subject || '(no subject)',
    from: addrList(env.from)[0] || null,
    to: addrList(env.to),
    // Same INTERNALDATE fallback as the phase-1 date-fetch above — a
    // missing/unparseable Date: header must not make a message sort to the
    // very bottom (effectively invisible on page 1) when it just arrived.
    date: env.date || msg.internalDate || null,
    // When the SERVER received it, separate from the Date: header above. The two
    // differ in exactly the cases that matter for "is this actually new mail?" —
    // a sender with a wrong clock, mail delayed in transit, and a Gmail relabel
    // resurfacing an old message under a fresh UID. See sync.js's filter gate.
    // Not cached: it is only ever consulted during the poll that fetched it.
    internalDate: msg.internalDate || null,
    seen: msg.flags?.has('\\Seen') || false,
    flagged: msg.flags?.has('\\Flagged') || false,
    answered: msg.flags?.has('\\Answered') || false,
    forwarded: hasKeyword(msg.flags, '$Forwarded'),
    deleted: msg.flags?.has('\\Deleted') || false,
    draft: msg.flags?.has('\\Draft') || false,
    size: msg.size || 0,
    hasAttachment,
    // Conversation grouping (see server/threading.js). messageId and inReplyTo
    // come free with the ENVELOPE that is already fetched; only `references`
    // was added to the HEADER.FIELDS list above, and only its first entry —
    // the conversation's root — is ever looked at.
    messageId: normalizeId(env.messageId || msg.envelope?.messageId),
    threadKey: threadKeyFrom({
      messageId: env.messageId || msg.envelope?.messageId,
      inReplyTo: env.inReplyTo || msg.envelope?.inReplyTo,
      references: firstReference(msg.headers),
    }),
  };
}

/**
 * Cheap incremental check for mail newer than the highest UID already
 * cached — used by the background poller on every tick after a folder's
 * first full sync. Unlike listMessages, this never needs the two-phase
 * date-verification pass: a genuinely new message is guaranteed by the IMAP
 * protocol to get a UID higher than anything the server has issued before,
 * regardless of the historical UID/date mismatches that affect old mail
 * (see the DATE_SORT_* comments above). Does not see flag changes or
 * deletions on already-cached messages — sync.js periodically runs a full
 * listMessages pass instead to reconcile those.
 */
export async function listNewMessages(path, sinceUid) {
  const settings = store.getSettings();
  const t0 = Date.now();
  return withMailbox(path, async (c) => {
    if (sinceUid <= 0) return [];
    const search = { uid: `${sinceUid + 1}:*` };
    if (!settings.showDeleted) search.deleted = false;
    const found = await c.search(search, { uid: true });
    const uids = (found || []).filter((u) => u > sinceUid); // some servers include sinceUid itself when it's the last UID in the mailbox
    if (!uids.length) return [];
    const messages = [];
    for await (const msg of c.fetch(uids, { uid: true, envelope: true, flags: true, size: true, bodyStructure: true, internalDate: true, headers: ['from', 'to', 'subject', 'date', 'references'] }, { uid: true })) {
      messages.push(await toEnvelope(msg));
    }
    ilog.debug(`listNewMessages ${path}: sinceUid=${sinceUid} found=${messages.length} (${Date.now() - t0}ms)`);
    return messages;
  }, true);
}

// How many messages one analytics-scan FETCH covers. Big enough that a 100k
// folder isn't 1000 round trips, small enough that each batch commits to
// SQLite (and reports progress) promptly and nothing buffers a whole mailbox
// of envelopes in memory at once.
const SCAN_BATCH = 500;

/**
 * Walks a folder's ENTIRE contents for the analytics index (see
 * server/analytics.js) — deliberately not reusing listMessages, whose
 * date-ranked candidate windowing exists to avoid ever looking at a whole
 * mailbox, which is exactly what this has to do. Yields batches so the caller
 * can persist and report progress as it goes rather than accumulating
 * everything.
 *
 * Fetches only what the analytics tables store: no bodies, no bodyStructure.
 * `emailId` comes back for free (imapflow always asks for OBJECTID's EMAILID
 * or Gmail's X-GM-MSGID when the server advertises it), and it's what lets the
 * same physical Gmail message be recognised across labels instead of counted
 * once per label. List-Unsubscribe rides along in the same round trip, and is
 * the single most reliable "this is bulk/commercial mail" signal there is.
 *
 * `sinceUid` makes a rescan incremental: 0 scans everything. `onBatch(rows,
 * scannedSoFar, total)` is awaited per batch — a callback rather than an async
 * generator specifically so the whole walk stays inside one withMailbox lock,
 * the same connection discipline every other call here follows (a generator's
 * consumer could park indefinitely mid-iteration while holding it).
 */
export async function scanMessages(path, { sinceUid = 0, batchSize = SCAN_BATCH, onBatch } = {}) {
  return withMailbox(path, async (c) => {
    const t0 = Date.now();
    const found = await c.search(sinceUid > 0 ? { uid: `${sinceUid + 1}:*` } : { all: true }, { uid: true });
    // Some servers answer `uid: n+1:*` with the last UID even when it's <= n.
    const uids = (found || []).filter((u) => u > sinceUid).sort((a, b) => a - b);
    let scanned = 0;
    for (let i = 0; i < uids.length; i += batchSize) {
      const chunk = uids.slice(i, i + batchSize);
      const rows = [];
      for await (const msg of c.fetch(chunk, {
        uid: true, envelope: true, size: true, flags: true, internalDate: true,
        headers: ['list-unsubscribe'],
      }, { uid: true })) {
        const from = msg.envelope?.from?.[0] || {};
        rows.push({
          uid: msg.uid,
          emailId: msg.emailId || null,
          fromAddr: (from.address || '').toLowerCase(),
          fromName: from.name || '',
          subject: msg.envelope?.subject || '',
          date: msg.envelope?.date ? new Date(msg.envelope.date).getTime()
            : (msg.internalDate ? new Date(msg.internalDate).getTime() : 0),
          size: msg.size || 0,
          seen: msg.flags?.has('\\Seen') || false,
          // Presence only — the URL itself is of no use to this feature.
          bulk: /list-unsubscribe/i.test(msg.headers?.toString() || ''),
        });
      }
      scanned += rows.length;
      if (onBatch) await onBatch(rows, scanned, uids.length);
    }
    ilog.debug(`scanMessages ${path}: sinceUid=${sinceUid} scanned=${scanned}/${uids.length} (${Date.now() - t0}ms)`);
    return { scanned, total: uids.length };
  }, true);
}

/**
 * Cheap flag-only refresh for a specific set of already-cached UIDs — no
 * envelope, no bodystructure, just \Seen/\Flagged/\Answered/\Deleted, which
 * is a tiny fetch regardless of how many UIDs. This is what actually
 * catches "I marked it read on my phone" for mail that isn't near the top
 * of the folder: listNewMessages only looks at UIDs it hasn't seen before,
 * and a full listMessages backfill only re-fetches flags for whichever
 * messages currently rank in the newest `limit` by date — a message that's
 * aged past that window keeps whatever flags it had the last time it WAS
 * in range, forever, since nothing else ever asks the server about it
 * again. Called with every UID already in the cache for a folder (see
 * sync.js#pollFolder), independent of the date-based candidate selection
 * that only listMessages needs to worry about.
 */
export async function refreshFlags(path, uids) {
  if (!uids.length) return [];
  return withMailbox(path, async (c) => {
    const rows = [];
    for await (const msg of c.fetch(uids, { uid: true, flags: true }, { uid: true })) {
      rows.push({
        uid: msg.uid,
        seen: msg.flags?.has('\\Seen') || false,
        flagged: msg.flags?.has('\\Flagged') || false,
        answered: msg.flags?.has('\\Answered') || false,
        forwarded: hasKeyword(msg.flags, '$Forwarded'),
        deleted: msg.flags?.has('\\Deleted') || false,
      });
    }
    return rows;
  }, true);
}

/**
 * Is this IMAP keyword set? Keywords aren't system flags: RFC 3501 makes them
 * case-insensitive, and servers echo back whatever case the client that set them
 * used — Thunderbird writes $Forwarded, some others $forwarded — so a plain
 * flags.has('$Forwarded') misses half the mail that actually has it. System flags
 * (\Seen, \Answered) don't need this: every server normalises those.
 */
function hasKeyword(flags, keyword) {
  if (!flags) return false;
  const want = keyword.toLowerCase();
  for (const f of flags) if (String(f).toLowerCase() === want) return true;
  return false;
}

function hasAttachments(node) {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  if (node.childNodes) return node.childNodes.some(hasAttachments);
  return false;
}

// ---------- single message ----------

// Opening a message fetches its full raw source over IMAP; viewing each of
// its attachments used to fetch that *same* source over IMAP again from
// scratch (getMessage and getAttachment both called this independently,
// with nothing shared between them) — for a message with a few embedded
// images that meant re-downloading the whole thing, base64 images and all,
// on every single click. Short-lived cache instead: a message is realistically
// only opened and clicked through within the same minute or two, not
// revisited hours later, so a small TTL'd cache covers the actual usage
// pattern without holding onto memory indefinitely.
const sourceCache = new Map(); // "userKey:accountId:path:uid" -> { source, flags, at }
const SOURCE_CACHE_TTL_MS = 5 * 60e3;
const SOURCE_CACHE_MAX = 30;

export async function getMessageSource(path, uid) {
  const { userKey, accountId } = currentUser();
  const key = `${userKey}:${accountId}:${path}:${uid}`;
  const cached = sourceCache.get(key);
  if (cached && Date.now() - cached.at < SOURCE_CACHE_TTL_MS) return cached;
  const result = await withMailbox(path, async (c) => {
    const msg = await c.fetchOne(uid, { uid: true, source: true, flags: true }, { uid: true });
    if (!msg || !msg.source) throw new Error('Message not found');
    return { source: msg.source, flags: msg.flags };
  }, true);
  sourceCache.set(key, { ...result, at: Date.now() });
  if (sourceCache.size > SOURCE_CACHE_MAX) {
    const oldestKey = [...sourceCache.entries()].reduce((a, b) => (b[1].at < a[1].at ? b : a))[0];
    sourceCache.delete(oldestKey);
  }
  return result;
}

/**
 * Raw headers for the "View headers" dialog — pulled straight from the
 * message source (everything before the first blank line) rather than from
 * mailparser's parsed representation, since that restructures addresses
 * etc. into objects and isn't what a "copy raw headers" button should
 * produce. `raw` keeps the original folded-line formatting exactly as the
 * server sent it (for copy-to-clipboard); `list` unfolds continuation
 * lines (RFC 5322: a line starting with whitespace continues the previous
 * header) into simple {name, value} pairs for the table view.
 */
export async function getMessageHeaders(path, uid) {
  const { source } = await getMessageSource(path, uid);
  return parseHeadersBlock(source);
}

export async function getMessage(path, uid) {
  const { source, flags } = await getMessageSource(path, uid);
  return { uid, ...(await parseMessage(source, flags)) };
}

export async function getAttachment(path, uid, index) {
  const { source } = await getMessageSource(path, uid);
  return parseAttachment(source, index);
}

// ---------- flags & actions ----------

export async function setFlags(path, uids, { add = [], remove = [] }) {
  return withMailbox(path, async (c) => {
    if (add.length) await c.messageFlagsAdd(uids, add, { uid: true });
    if (remove.length) await c.messageFlagsRemove(uids, remove, { uid: true });
    return { ok: true };
  });
}

/**
 * What the moved copy is called in the folder it landed in.
 *
 * A move mints a NEW uid in the destination, and nothing else can tell you
 * which one — so without this, a move is a one-way trip as far as any caller
 * is concerned. ImapFlow resolves it from the server's COPYUID response
 * (UIDPLUS, which every server worth the name has had for twenty years) and
 * hands back a Map of source uid -> destination uid; a server that doesn't
 * answer with one leaves this null, and callers fall back to not offering
 * whatever they wanted the new uid for (see the undo in public/js/app.js).
 */
function uidMapOf(res) {
  const map = res?.uidMap;
  if (!map) return null;
  const out = {};
  for (const [from, to] of (map instanceof Map ? map.entries() : Object.entries(map))) out[from] = to;
  return Object.keys(out).length ? out : null;
}

export async function moveMessages(path, uids, target) {
  return withMailbox(path, async (c) => {
    const res = await c.messageMove(uids, target, { uid: true });
    return { ok: true, destination: target, uidMap: uidMapOf(res) };
  });
}

export async function copyMessages(path, uids, target) {
  return withMailbox(path, async (c) => {
    const res = await c.messageCopy(uids, target, { uid: true });
    // Same COPYUID map moveMessages returns, and for the same reason: a filter's
    // copy lands in a folder the poller also watches, where it looks like new
    // mail and would be run through the filters again. filters.js#noteFiled
    // needs the new uid to recognise its own copy there. (Null on a server
    // without UIDPLUS — the send ledger in cache.js is the backstop.)
    return { ok: true, destination: target, uidMap: uidMapOf(res) };
  });
}

export async function deleteMessages(path, uids) {
  // Owner-scoped, not viewer-scoped — see store.js#getOwnerSettings. How
  // destructive Delete is in a mailbox is the mailbox owner's call.
  const settings = store.getOwnerSettings();
  const acc = currentAccount();
  const mode = settings.deleteBehavior;
  return withMailbox(path, async (c) => {
    if (settings.markReadOnDelete) {
      await c.messageFlagsAdd(uids, ['\\Seen'], { uid: true }).catch(() => {});
    }
    // `action` reflects what actually happened (not just the raw setting) —
    // e.g. mode 'trash' but deleting from the trash folder itself falls
    // through to a hard expunge, not a move. Callers (index.js) need this to
    // mirror the change into the cache correctly.
    let action;
    // `destination`/`uidMap` are what make the delete reversible: they name
    // the copy now sitting in Trash, so the client can offer "undo" and move
    // exactly that message back (see quickDelete/undoDelete in app.js).
    let destination = null;
    let uidMap = null;
    if (mode === 'trash' && path !== acc.trashFolder) {
      const res = await c.messageMove(uids, acc.trashFolder, { uid: true });
      action = 'moved';
      destination = acc.trashFolder;
      uidMap = uidMapOf(res);
    } else if (mode === 'flag') {
      await c.messageFlagsAdd(uids, ['\\Deleted'], { uid: true });
      action = 'flagged';
    } else {
      await c.messageDelete(uids, { uid: true });
      action = 'expunged';
    }
    return { ok: true, mode, action, destination, uidMap };
  });
}

/** Permanently remove messages (used for replacing draft autosaves). */
export async function hardDelete(path, uids) {
  return withMailbox(path, async (c) => {
    await c.messageDelete(uids, { uid: true });
    return { ok: true };
  });
}

/**
 * Save a raw message into a folder (Sent-copy after SMTP send, draft
 * autosave, …) — returns { uid } for the newly-appended message when the
 * protocol can tell us directly, so callers (index.js's drafts route,
 * smtpClient.js) don't have to guess by re-listing the folder afterward.
 * ImapFlow's own append() already resolves this itself: via the server's
 * APPENDUID response code (UIDPLUS extension) when available, or — if the
 * server doesn't support UIDPLUS — by doing a SEARCH for the sequence
 * number it just saw appear, which is exact, not a "probably the newest
 * one" guess.
 */
export async function appendMessage(path, raw, flags = []) {
  const c = await getClient();
  const result = await c.append(path, raw, flags);
  return { uid: result?.uid ?? null };
}

export async function imapStatus() {
  const acc = currentAccount();
  try {
    const c = await getClient();
    return { connected: c.usable, user: acc.email, host: acc.imap.host };
  } catch (e) {
    return { connected: false, error: e.message, host: acc.imap.host };
  }
}
