// Hmelj — local SQLite cache of message envelopes/flags, used to make the
// unified Inbox/Sent view instant (read from disk, no live IMAP round-trip)
// and to let the background poller (sync.js) detect new mail. This is a
// cache, not a source of truth: IMAP is always authoritative, and any
// account/folder can be re-synced from scratch just by polling again.
//
// Scope, deliberately kept simple for a first pass: envelope fields only (no
// message bodies, no full-text search — that's a possible future addition).
// Populated only for folders the poller decided to sync (see sync.js) — the
// most recent BACKFILL_LIMIT messages per folder, not full history.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { parseSearchQuery, queryNeedsBodySearch } from './searchQuery.js';
import { log } from './log.js';

const clog = log.scope('cache');

fs.mkdirSync(config.cacheDir, { recursive: true });
const db = new Database(path.join(config.cacheDir, 'cache.sqlite'));
db.pragma('journal_mode = WAL');
// Shared with analytics.js, which keeps its own tables in this same file (one
// SQLite connection per process, so it must not open a second handle to it).
// Nothing else should reach in here — the rest of the app goes through the
// functions below.
export { db };

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  user_key TEXT NOT NULL,
  account_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  -- Opaque per-(account,folder) message id, not necessarily numeric: an IMAP
  -- integer UID, or for another protocol client its own id shape (e.g. an
  -- Exchange account's opaque ItemId string). Declared TEXT so a non-numeric
  -- id round-trips exactly as given rather than inviting an implicit
  -- coercion attempt.
  --
  -- Because it's TEXT, everything crossing this boundary MUST go through
  -- uidKey()/uidOut() below — binding a raw JS number here stores '7.0', and
  -- ordering/comparing raw text puts '9' after '1200'. Note databases created
  -- before this column became TEXT have it as INTEGER and CREATE TABLE IF NOT
  -- EXISTS never migrates them, so both shapes are live in the wild; the two
  -- helpers are what make that difference invisible to every caller.
  uid TEXT NOT NULL,
  subject TEXT,
  from_name TEXT,
  from_addr TEXT,
  to_json TEXT,
  date INTEGER,
  size INTEGER,
  seen INTEGER,
  flagged INTEGER,
  answered INTEGER,
  -- The $Forwarded IMAP keyword (RFC 5788), and Exchange's equivalent —
  -- PidTagLastVerbExecuted == 104. Its own column rather than reusing the
  -- answered one: mail clients draw a different arrow for each, and marking a
  -- forward as \Answered would make every other client claim you replied.
  -- Added after this table shipped — see addColumn() below.
  forwarded INTEGER,
  deleted INTEGER,
  draft INTEGER,
  has_attachment INTEGER,
  special_use TEXT,
  -- Conversation grouping (Settings > "Conversation view"). message_id is this
  -- message's own Message-ID; thread_id is the conversation it belongs to —
  -- the root Message-ID of its References chain, or the provider's own
  -- conversation id for Exchange/Graph. Both are computed once, on the way in,
  -- by server/threading.js: every message of one conversation derives the same
  -- thread_id independently, so nothing here ever has to re-thread or fix up
  -- rows inserted out of order (a folder backfills newest-first, so replies
  -- routinely land before what they reply to).
  --
  -- NULL means "not threaded" — a row cached before these columns existed, or
  -- a message with no usable ids. Every query COALESCEs that to a per-message
  -- key, i.e. a conversation of one, and the next full sync pass fills it in.
  -- Added after this table shipped — see addColumn() below.
  message_id TEXT,
  thread_id TEXT,
  PRIMARY KEY (user_key, account_id, folder, uid)
);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages (user_key, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_scope ON messages (user_key, account_id, folder);
-- idx_messages_thread is NOT here: this whole block is a no-op on a database
-- that already exists, whose messages table has no thread_id column yet, and
-- CREATE INDEX over a missing column throws. It is created just below instead,
-- after addColumn() has had its say. See there.

CREATE TABLE IF NOT EXISTS sync_state (
  user_key TEXT NOT NULL,
  account_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  last_synced_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (user_key, account_id, folder)
);

CREATE TABLE IF NOT EXISTS folders (
  user_key TEXT NOT NULL,
  account_id TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT,
  delimiter TEXT,
  parent TEXT,
  special_use TEXT,
  subscribed INTEGER,
  hidden INTEGER,
  total INTEGER,
  unseen INTEGER,
  sort_rank INTEGER,
  PRIMARY KEY (user_key, account_id, path)
);

-- Proactively-populated cache of PARSED message content (see
-- server/contentCache.js) — deliberately separate from the messages table
-- above, which is envelope-only and covers every synced message; this only covers
-- however many of the newest per folder the user's contentCacheLimit
-- setting asks for, kept warm by sync.js so opening one is a read here
-- instead of a live IMAP/EWS round trip. content_json is
-- messageParse.js#parseMessage()'s output (subject/from/to/html/text/
-- attachment METADATA — never attachment bytes, kept separately fetched
-- on-demand as today) — NULL means "fetched once, too big to cache" (over
-- the size cap), a marker so the backfill pass in sync.js doesn't keep
-- retrying the same oversized message every tick forever; still a real row,
-- so it still counts as "handled" for that purpose.
CREATE TABLE IF NOT EXISTS message_content (
  user_key TEXT NOT NULL,
  account_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  uid TEXT NOT NULL,
  content_json TEXT,
  size INTEGER,
  cached_at INTEGER,
  PRIMARY KEY (user_key, account_id, folder, uid)
);

-- Word index behind the search box's inline autocomplete (see
-- upsertMessages()'s indexing hook below and suggestWord()). One row per
-- distinct word ever seen in a subject/sender name/sender address across
-- ALL of a user's accounts and folders — count is how many DISTINCT
-- messages contained it (not raw occurrences), used to rank the most
-- plausible completion first. Deliberately growth-only: nothing ever
-- decrements or removes a row when its source message is later deleted —
-- see upsertMessages()'s comment for why that's an accepted trade-off here,
-- not an oversight.
CREATE TABLE IF NOT EXISTS search_words (
  user_key TEXT NOT NULL,
  word TEXT NOT NULL,
  count INTEGER NOT NULL,
  last_seen INTEGER,
  PRIMARY KEY (user_key, word)
);
`);

/**
 * Adds a column to an existing table, if it isn't already there.
 *
 * The schema above is all `CREATE TABLE IF NOT EXISTS`, which does exactly
 * nothing to a database that already exists — so a column added to one of those
 * definitions after the fact reaches new installs only, and every existing cache
 * silently keeps the old shape (the `uid TEXT` note in the messages table is the
 * scar from the last time this bit). This is the first migration in the project;
 * anything added to a shipped table from here on needs a line below.
 *
 * Deliberately additive-only. SQLite's ALTER TABLE can't drop or retype a column
 * without rebuilding the table, and this cache is disposable anyway — it is
 * rebuilt from the mail servers on the next sync — so a migration that can't be
 * expressed as "add a nullable column" should delete the file and start over
 * rather than grow into a migration framework.
 */
function addColumn(table, column, decl) {
  const has = db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name=?`).get(table, column);
  if (has) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  clog.info(`Cache schema: added ${table}.${column}`);
}

// $Forwarded / PidTagLastVerbExecuted — see the column's comment in the schema.
addColumn('messages', 'forwarded', 'INTEGER');
// Conversation grouping — see the columns' comment in the schema, and the note
// there on why this index can't live in the schema block with the others.
addColumn('messages', 'message_id', 'TEXT');
addColumn('messages', 'thread_id', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (user_key, account_id, thread_id)');

/**
 * Canonical JS-side form of a message id, for BOTH binding into a query and
 * comparing two ids in JavaScript. Always call this on anything that will be
 * compared, Set-membership-tested, or used as a Map key.
 *
 * Why this is needed at all: the `uid` column is declared TEXT (so an
 * Exchange ItemId round-trips exactly — see the schema comment above), and
 * binding a JS *number* into a TEXT-affinity column makes SQLite stringify it
 * through its float formatter: 7 goes in and '7.0' comes back out. So
 * `existing.has(m.uid)` compared '7.0' against 7 and was false for every
 * message, every poll — meaning on any database created with this schema,
 * upsertMessages reported the entire folder as brand new on every single
 * tick, re-running filters and re-firing new-mail push notifications for mail
 * that had been sitting there for weeks. (Databases created before the column
 * became TEXT are INTEGER and don't hit this, which is the only reason it
 * wasn't obvious: the bug only appears on a fresh install.)
 *
 * Normalizing to a string on both sides fixes it for either column type —
 * binding '7' stores integer 7 in an old INTEGER column and text '7' in a new
 * TEXT one, and reads go through here either way. The `.0` strip is the
 * compatibility shim for rows an already-running fresh install wrote before
 * this fix; it can't affect an EWS ItemId, which never matches that shape.
 */
export function uidKey(u) {
  const s = String(u);
  return /^\d+\.0$/.test(s) ? s.slice(0, -2) : s;
}

/**
 * The counterpart to uidKey, for ids leaving this module: back to a NUMBER
 * when the id is a plain IMAP UID, left as a string otherwise (an Exchange
 * ItemId).
 *
 * uidKey's string form is right for SQL binds and JS comparisons, but it must
 * not leak outward. Two consumers care about the difference:
 *   - imapClient.js#refreshFlags/fetch, which builds an IMAP sequence set
 *     from these and wants numbers for a numeric UID space;
 *   - the browser, which mixes cached rows (this module) with live IMAP
 *     results (numbers) in one message list and compares uids with ===, so
 *     handing it '1234' for a message it already knows as 1234 would silently
 *     break selection, mark-read and open-message.
 * Keeping the outward shape byte-identical to what live IMAP returns means
 * nothing downstream has to know the cache normalizes anything.
 */
export function uidOut(u) {
  const s = uidKey(u);
  return /^\d+$/.test(s) ? Number(s) : s;
}

const upsertStmt = db.prepare(`
  INSERT INTO messages (user_key, account_id, folder, uid, subject, from_name, from_addr, to_json, date, size, seen, flagged, answered, forwarded, deleted, draft, has_attachment, special_use, message_id, thread_id)
  VALUES (@userKey, @accountId, @folder, @uid, @subject, @fromName, @fromAddr, @toJson, @date, @size, @seen, @flagged, @answered, @forwarded, @deleted, @draft, @hasAttachment, @specialUse, @messageId, @threadId)
  ON CONFLICT (user_key, account_id, folder, uid) DO UPDATE SET
    subject=excluded.subject, from_name=excluded.from_name, from_addr=excluded.from_addr, to_json=excluded.to_json,
    date=excluded.date, size=excluded.size, seen=excluded.seen, flagged=excluded.flagged, answered=excluded.answered, forwarded=excluded.forwarded,
    deleted=excluded.deleted, draft=excluded.draft, has_attachment=excluded.has_attachment, special_use=excluded.special_use,
    message_id=excluded.message_id, thread_id=excluded.thread_id
`);

/**
 * Same insert, but a message we already hold keeps the flags the cache has
 * rather than taking the fetched ones.
 *
 * For the case where a fetch's answer is known to be older than a flag change
 * this server made itself: the envelope list carries each message's flags AS
 * THEY WERE when the server answered, so re-upserting it puts the pre-change
 * read state back and the click the user just made appears to undo itself.
 * Only the conflict path differs — a genuinely new message still gets the
 * flags it arrived with, since the cache has no opinion about those yet.
 * See sync.js#pollFolder's `preserveFlags`.
 */
const upsertKeepFlagsStmt = db.prepare(`
  INSERT INTO messages (user_key, account_id, folder, uid, subject, from_name, from_addr, to_json, date, size, seen, flagged, answered, forwarded, deleted, draft, has_attachment, special_use, message_id, thread_id)
  VALUES (@userKey, @accountId, @folder, @uid, @subject, @fromName, @fromAddr, @toJson, @date, @size, @seen, @flagged, @answered, @forwarded, @deleted, @draft, @hasAttachment, @specialUse, @messageId, @threadId)
  ON CONFLICT (user_key, account_id, folder, uid) DO UPDATE SET
    subject=excluded.subject, from_name=excluded.from_name, from_addr=excluded.from_addr, to_json=excluded.to_json,
    date=excluded.date, size=excluded.size, has_attachment=excluded.has_attachment, special_use=excluded.special_use,
    message_id=excluded.message_id, thread_id=excluded.thread_id
`);

// ---------- search-box word index (see suggestWord() below) ----------

const WORD_RE = /[\p{L}\p{N}]+/gu;
/** Plain words from free text — lowercased, 2-40 chars, not purely numeric
 * (order numbers/tracking ids aren't useful completions). */
function tokenizeWords(text) {
  if (!text) return [];
  const out = [];
  for (const m of text.toLowerCase().matchAll(WORD_RE)) {
    const w = m[0];
    if (w.length >= 2 && w.length <= 40 && !/^\d+$/.test(w)) out.push(w);
  }
  return out;
}
/** One message's indexable words, deduped (a Set, not an array) so a word
 * appearing in both the subject and the sender name only counts once per
 * message — count below means "how many messages," not raw occurrences.
 * from_addr is tokenized differently than free text — split only on '@',
 * keeping each side (including dots) intact — so "newsletter@
 * booknotifications.com" indexes as the two tokens "newsletter" and
 * "booknotifications.com" rather than being shredded further by punctuation,
 * which is what lets a search-box completion finish a whole sender domain. */
function tokenizeMessage(m) {
  const words = new Set(tokenizeWords(m.subject));
  for (const w of tokenizeWords(m.from?.name)) words.add(w);
  const addr = m.from?.address || '';
  const at = addr.indexOf('@');
  if (at > 0) {
    const local = addr.slice(0, at).toLowerCase();
    const domain = addr.slice(at + 1).toLowerCase();
    if (local.length >= 2 && local.length <= 40) words.add(local);
    if (domain.length >= 2 && domain.length <= 40) words.add(domain);
  }
  return words;
}
const wordUpsertStmt = db.prepare(`
  INSERT INTO search_words (user_key, word, count, last_seen)
  VALUES (@userKey, @word, 1, @lastSeen)
  ON CONFLICT (user_key, word) DO UPDATE SET
    count = count + 1,
    last_seen = MAX(IFNULL(last_seen, 0), excluded.last_seen)
`);

/** Upsert a folder's freshly-fetched envelope list; returns the UIDs that weren't cached before (i.e. genuinely new mail).
 *  `preserveFlags` keeps existing rows' flag columns — see upsertKeepFlagsStmt. */
export function upsertMessages(userKey, accountId, folder, specialUse, messages, { preserveFlags = false } = {}) {
  const stmt = preserveFlags ? upsertKeepFlagsStmt : upsertStmt;
  const existing = new Set(
    db.prepare('SELECT uid FROM messages WHERE user_key=? AND account_id=? AND folder=?').all(userKey, accountId, folder).map((r) => uidKey(r.uid))
  );
  const tx = db.transaction((rows) => {
    for (const m of rows) {
      stmt.run({
        userKey, accountId, folder, uid: uidKey(m.uid),
        subject: m.subject || '', fromName: m.from?.name || '', fromAddr: m.from?.address || '',
        toJson: JSON.stringify(m.to || []), date: m.date ? new Date(m.date).getTime() : 0, size: m.size || 0,
        seen: m.seen ? 1 : 0, flagged: m.flagged ? 1 : 0, answered: m.answered ? 1 : 0, forwarded: m.forwarded ? 1 : 0,
        deleted: m.deleted ? 1 : 0, draft: m.draft ? 1 : 0, hasAttachment: m.hasAttachment ? 1 : 0,
        specialUse: specialUse || null,
        // Computed by each protocol client's envelope mapper (server/threading.js).
        // A client that doesn't supply them — or a message with no usable ids —
        // stores NULL, which every read below treats as a conversation of one.
        messageId: m.messageId || null, threadId: m.threadKey || null,
      });
      // Only for genuinely new-to-cache messages — not on every re-upsert
      // of an already-cached row (sync.js's periodic full rescan re-fetches
      // and re-upserts the SAME messages regularly; indexing those again
      // every time would inflate popular words' counts forever instead of
      // reflecting "how many distinct messages actually contain this").
      if (!existing.has(uidKey(m.uid))) {
        const lastSeen = m.date ? new Date(m.date).getTime() : Date.now();
        for (const word of tokenizeMessage(m)) {
          wordUpsertStmt.run({ userKey, word, lastSeen });
        }
      }
    }
  });
  tx(messages);
  // The ORIGINAL uid values, not the normalized keys — callers match these
  // back against their own freshly-fetched message objects (sync.js does
  // `newUids.includes(m.uid)`), so what goes out has to be what came in.
  return messages.filter((m) => !existing.has(uidKey(m.uid))).map((m) => m.uid);
}

/** True once this user has ANY search-word index at all — used to gate the
 * one-time backfill below so it runs exactly once (cheap `LIMIT 1` check on
 * every subsequent tick after that, not a real cost). */
export function hasSearchWords(userKey) {
  return !!db.prepare('SELECT 1 FROM search_words WHERE user_key=? LIMIT 1').get(userKey);
}

/** One-time bootstrap: indexes every message ALREADY sitting in the
 * envelope cache (potentially months/years of mail, across every account
 * and folder this user has) — upsertMessages()'s own indexing hook only
 * ever sees messages that are new-to-cache from here on, so without this a
 * mailbox that was fully synced before this feature existed would start
 * with an empty index and only slowly grow it from whatever mail happens
 * to arrive next, which is exactly backwards from "suggest things I
 * already have lots of mail from." Pure local read+write, no network I/O
 * (the data's already cached) — cheap even for a few thousand rows.
 * Returns how many rows it processed, for a one-line log at the call site. */
export function backfillSearchWords(userKey) {
  const rows = db.prepare('SELECT subject, from_name, from_addr, date FROM messages WHERE user_key=?').all(userKey);
  const tx = db.transaction((rs) => {
    for (const r of rs) {
      const m = { subject: r.subject, from: { name: r.from_name, address: r.from_addr } };
      const lastSeen = r.date || Date.now();
      for (const word of tokenizeMessage(m)) {
        wordUpsertStmt.run({ userKey, word, lastSeen });
      }
    }
  });
  tx(rows);
  return rows.length;
}

/**
 * Everyone this user has actually corresponded with, straight out of the
 * envelope cache — the raw material for "suggest contacts from my mail"
 * (server/index.js's GET /api/contacts/suggestions).
 *
 * Both directions count, and they're counted separately on purpose: `sent` is
 * how many messages went TO that address (read out of each row's to_json),
 * `received` is how many came FROM it. Someone you've written to is almost
 * certainly a real contact; someone who has only ever written to you might
 * equally be a newsletter, so the caller ranks on `sent` first. Nothing is
 * filtered here beyond needing an @ in the address — deciding what counts as
 * a contact is the caller's job, and this stays a plain projection of what's
 * in the cache.
 *
 * `accountIds` scopes the scan to accounts the caller actually means, since a
 * userKey's namespace holds an owner's own accounts AND anything they've
 * shared out (see unread.js's owner-key grouping for the same problem).
 *
 * A full-table scan by design, same as backfillSearchWords above: this runs
 * when someone opens the Contacts tab, not on any hot path, and it reads
 * cached rows only — no network I/O.
 */
export function correspondents(userKey, accountList = []) {
  if (!accountList.length) return [];
  const placeholders = accountList.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT account_id, folder, special_use, from_name, from_addr, to_json, date
       FROM messages WHERE user_key=? AND account_id IN (${placeholders})`
  ).all(userKey, ...accountList.map((a) => a.id));
  const sentFolderOf = new Map(accountList.map((a) => [a.id, a.sentFolder]));

  const byEmail = new Map();
  const note = (name, address, date, direction) => {
    const email = String(address || '').trim().toLowerCase();
    if (!email.includes('@')) return;
    let e = byEmail.get(email);
    if (!e) { e = { email, name: '', received: 0, sent: 0, last: 0 }; byEmail.set(email, e); }
    e[direction]++;
    if (date && date > e.last) e.last = date;
    // Keep the longest display name seen for this address: "Marko Novak" beats
    // "marko", and both beat the empty string a bare header gives you.
    const n = String(name || '').trim();
    if (n && !n.includes('@') && n.length > e.name.length) e.name = n;
  };

  for (const r of rows) {
    // Direction is decided by the FOLDER, not by the header: in a message
    // sitting in your inbox the From is the correspondent and the To is you
    // (plus whoever else was copied), and only in your own Sent folder does
    // the To list mean "people I wrote to". Counting every To as sent — the
    // first cut of this — credited you with having written to yourself once
    // per received message, and to every stranger CC'd alongside you.
    const isSent = r.special_use === '\\Sent' || (r.folder && r.folder === sentFolderOf.get(r.account_id));
    if (!isSent) { note(r.from_name, r.from_addr, r.date, 'received'); continue; }
    let to = [];
    try { to = JSON.parse(r.to_json || '[]') || []; } catch { continue; } // a malformed row shouldn't sink the whole scan
    for (const t of Array.isArray(to) ? to : []) note(t?.name, t?.address, r.date, 'sent');
  }
  return [...byEmail.values()];
}

// % and _ are real (if rare) LIKE wildcards — escaping them (paired with ESCAPE '\'
// on every LIKE clause that uses this) keeps arbitrary user-typed search text matching
// only as a literal substring, not silently matching more broadly than intended.
function likeEscape(s) { return String(s).replace(/[%_\\]/g, '\\$&'); }

/** Best single completion for the search box's inline autocomplete — the
 * highest-count (tie-broken by most recent) word starting with `prefix`.
 * null if nothing matches (including an empty index — a brand-new install
 * just hasn't synced enough to have vocabulary yet, not an error). */
export function suggestWord(userKey, prefix) {
  const row = db.prepare("SELECT word FROM search_words WHERE user_key=? AND word LIKE ? ESCAPE '\\' ORDER BY count DESC, last_seen DESC LIMIT 1")
    .get(userKey, likeEscape(prefix) + '%');
  return row ? row.word : null;
}

/** One parsed search term (server/searchQuery.js) → a WHERE fragment + its bound
 *  params. Unscoped (field=null) covers subject/from/to — the exact same scope the
 *  live IMAP/EWS search backends use for an unscoped term (see imapClient.js's
 *  termToSearchObject) — never body, which isn't cached at all; callers MUST route a
 *  body-needing query elsewhere first (see buildCacheSearchClause below). */
function termToLikeClause({ field, text }) {
  const like = `%${likeEscape(text)}%`;
  if (field === 'subject') return { sql: "subject LIKE ? ESCAPE '\\'", params: [like] };
  if (field === 'from') return { sql: "(from_name LIKE ? ESCAPE '\\' OR from_addr LIKE ? ESCAPE '\\')", params: [like, like] };
  if (field === 'to') return { sql: "to_json LIKE ? ESCAPE '\\'", params: [like] };
  return {
    sql: "(subject LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\' OR from_addr LIKE ? ESCAPE '\\' OR to_json LIKE ? ESCAPE '\\')",
    params: [like, like, like, like],
  };
}

/** Builds the WHERE-fragment + bound params for a parsed search query — required
 *  terms ANDed together, excluded terms NOT-wrapped. Plain SQL AND/NOT/OR composes
 *  directly here (no De Morgan trick needed, unlike imapClient.js's andAll — a SQL
 *  text fragment has no JS-object-key-collision problem to work around).
 *
 *  Throws if the query needs body search (server/searchQuery.js's
 *  queryNeedsBodySearch) — callers MUST check that first and route a body-needing
 *  query to a live IMAP/EWS fetch instead (message bodies are never cached at all).
 *  Failing loudly here catches a routing mistake at the source instead of silently
 *  returning results that are missing whatever the body: term would have matched. */
function buildCacheSearchClause(q) {
  if (queryNeedsBodySearch(q)) throw new Error('cache: query needs body search, not servable from cache');
  const { required, excluded } = parseSearchQuery(q);
  const parts = [];
  const params = [];
  for (const t of required) {
    const { sql, params: p } = termToLikeClause(t);
    parts.push(sql);
    params.push(...p);
  }
  for (const t of excluded) {
    const { sql, params: p } = termToLikeClause(t);
    parts.push(`NOT ${sql}`);
    params.push(...p);
  }
  return { sql: parts.length ? parts.join(' AND ') : '1=1', params };
}

/** Every UID currently cached for a folder — used to drive the flags-only
 * reconciliation pass (see imapClient.js#refreshFlags), which needs the
 * complete cached set regardless of where each message ranks in a
 * date-based "newest N" selection. */
export function getCachedUids(userKey, accountId, folder) {
  return db.prepare('SELECT uid FROM messages WHERE user_key=? AND account_id=? AND folder=?')
    .all(userKey, accountId, folder).map((r) => uidOut(r.uid));
}

/** How many cached rows in this folder are currently unread. Used by the
 * poller to notice that a folder's read state moved during a cycle — see
 * sync.js#pollFolder, which samples it before and after. */
export function countUnseenRows(userKey, accountId, folder) {
  return db.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_key=? AND account_id=? AND folder=? AND deleted=0 AND seen=0')
    .get(userKey, accountId, folder).n;
}

/** How many messages this folder currently has IN THE CACHE — i.e. how many
 * the UI would actually list, which is deliberately not the same question as
 * the folder's server-side total (see getFolders' `total`, filled from a real
 * STATUS). smtpClient.js#refreshSentFolder samples this before and after a
 * post-send sync: the server total can already include the just-sent copy
 * while the fetch that ran a moment earlier didn't return it yet, so only the
 * row count answers "is it actually visible to the user now?". */
export function countRows(userKey, accountId, folder) {
  return db.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_key=? AND account_id=? AND folder=?')
    .get(userKey, accountId, folder).n;
}

const flagsOnlyStmt = db.prepare(
  'UPDATE messages SET seen=?, flagged=?, answered=?, forwarded=?, deleted=? WHERE user_key=? AND account_id=? AND folder=? AND uid=?'
);
/**
 * Applies a flags-only snapshot from refreshFlags — updates just the flag
 * columns for whichever UIDs the server actually returned (deleted-and-gone
 * UIDs simply won't appear in `rows`, and are left alone here; a full
 * listMessages pass is what prunes those, not this).
 *
 * Returns `{ changed, unseenDelta }` describing what this snapshot actually
 * moved, which is what makes cross-client read state work: this is the ONLY
 * place Hmelj ever notices that a message was read (or un-read, or starred)
 * on a completely different client — a phone IMAP app, Outlook, Roundcube.
 * It used to write these silently, so a mark-read on your phone updated
 * SQLite and told nobody: no SSE event, no count refresh, and the browser
 * only found out via the next accidental reconcile. sync.js now broadcasts
 * on a non-zero `changed`. See the caller.
 */
export function applyFlagsSnapshot(userKey, accountId, folder, rows) {
  if (!rows.length) return { changed: 0, unseenDelta: 0 };
  // The pre-state for exactly the UIDs in this snapshot, so "changed" means
  // genuinely different rather than "we ran an UPDATE" (SQLite counts a
  // no-op write as a change, so statement.changes can't answer this).
  const prev = new Map();
  const stmt = db.prepare('SELECT uid, seen, flagged, answered, forwarded, deleted FROM messages WHERE user_key=? AND account_id=? AND folder=?');
  for (const r of stmt.all(userKey, accountId, folder)) prev.set(uidKey(r.uid), r);

  let changed = 0;
  let unseenDelta = 0;
  for (const r of rows) {
    const p = prev.get(uidKey(r.uid));
    if (!p) continue; // not cached (yet) — upsertMessages owns that row, not us
    const seen = r.seen ? 1 : 0;
    if (p.seen !== seen) unseenDelta += seen ? -1 : 1;
    if (p.seen !== seen || p.flagged !== (r.flagged ? 1 : 0)
      || p.answered !== (r.answered ? 1 : 0) || p.forwarded !== (r.forwarded ? 1 : 0)
      || p.deleted !== (r.deleted ? 1 : 0)) changed++;
  }

  const tx = db.transaction((rs) => {
    for (const r of rs) flagsOnlyStmt.run(r.seen ? 1 : 0, r.flagged ? 1 : 0, r.answered ? 1 : 0, r.forwarded ? 1 : 0, r.deleted ? 1 : 0, userKey, accountId, folder, uidKey(r.uid));
  });
  tx(rows);
  return { changed, unseenDelta };
}

/**
 * Drop cached rows that are no longer present in a fresh fetch — but only
 * within the fetched window (>= the lowest UID just fetched), since the
 * cache intentionally only covers the newest BACKFILL_LIMIT messages per
 * folder; older, never-fetched UIDs must not be touched.
 */
export function pruneMissing(userKey, accountId, folder, fetchedUids) {
  if (!fetchedUids.length) return;
  const minUid = Math.min(...fetchedUids.map(Number));
  // A non-numeric id set (an EWS account's opaque ItemIds) makes that floor
  // NaN, and every comparison against NaN is false — so this used to delete
  // nothing at all for Exchange, leaving messages deleted on the server
  // cached forever and inflating that account's unread count. That case has
  // its own function; route to it rather than running a no-op query.
  if (!Number.isFinite(minUid)) return pruneMissingExact(userKey, accountId, folder, fetchedUids);
  const keys = fetchedUids.map(uidKey);
  const placeholders = keys.map(() => '?').join(',');
  // CAST because the column is TEXT (see uidKey): an unqualified `uid>=?`
  // would compare '9' against '1200' lexicographically.
  db.prepare(
    `DELETE FROM messages WHERE user_key=? AND account_id=? AND folder=? AND CAST(uid AS INTEGER)>=? AND uid NOT IN (${placeholders})`
  ).run(userKey, accountId, folder, minUid, ...keys);
}

/**
 * Same purpose as pruneMissing() above (drop cached rows a fresh fetch no
 * longer reports), but a pure set-difference delete with no "at or above the
 * lowest id just fetched" floor — pruneMissing's floor only makes sense
 * because IMAP UIDs are monotonically increasing with arrival order, a
 * guarantee message ids from other protocols (e.g. an Exchange account's
 * opaque ItemId) don't carry at all; applying pruneMissing's floor logic to
 * those would prune by accidental string-lexicographic comparison instead of
 * anything meaningful. Same safety caveat applies here as there: only call
 * this when `fetchedIds` is a *complete* fetch of the folder's tracked
 * window, never a truncated on-demand scan — otherwise this would delete
 * legitimately-cached messages the narrower fetch simply didn't ask about.
 */
export function pruneMissingExact(userKey, accountId, folder, fetchedIds) {
  if (!fetchedIds.length) return;
  const keys = fetchedIds.map(uidKey);
  const placeholders = keys.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM messages WHERE user_key=? AND account_id=? AND folder=? AND uid NOT IN (${placeholders})`
  ).run(userKey, accountId, folder, ...keys);
}

/** True if this (account, folder) has ever been synced before — used to
 * suppress running filters against a folder's very first backfill (that
 * backlog isn't "new mail," and blindly running delete/move filter actions
 * against a user's entire pre-existing mailbox the first time we see it
 * would be destructive). */
export function hasSyncedBefore(userKey, accountId, folder) {
  return !!db.prepare('SELECT 1 FROM sync_state WHERE user_key=? AND account_id=? AND folder=?').get(userKey, accountId, folder);
}

// ---------- filter send ledger (see server/filters.js) ----------
//
// "Has this filter already sent something about this message?" — the record
// that makes `redirect` and `reply` fire exactly once per delivered message,
// for good, across every path that can run a filter.
//
// filters.js#claimFiled already stops the ONE case the background poller
// creates (our own copy landing in a folder that is itself polled). It cannot
// help with the others: /api/filters/run re-reads the newest 200 messages and
// runs every rule over all of them regardless of age, so a redirect rule whose
// message is still sitting in INBOX forwarded it again on every single manual
// run — and again on every Inbox load with `runFiltersOnLoad` on. A restart
// also empties claimFiled's in-memory map.
//
// Keyed on the Message-ID rather than a uid, deliberately: a uid is per-folder
// and a MOVE mints a new one, so the same delivered mail has several over its
// life, while its Message-ID is stable across folders, servers and restarts —
// which is exactly the identity "once per delivered message" is about. On disk
// rather than in memory for the same reason: surviving a restart is the point.
db.exec(`
CREATE TABLE IF NOT EXISTS filter_sends (
  user_key TEXT NOT NULL,
  account_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  filter_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (user_key, account_id, message_key, filter_id)
);
`);

const claimSendStmt = db.prepare(
  'INSERT OR IGNORE INTO filter_sends (user_key, account_id, message_key, filter_id, sent_at) VALUES (?, ?, ?, ?, ?)'
);
// Long enough that no plausible re-run window reaches past it, short enough
// that the table stays small. Swept on the way in, like filters.js's own map.
const FILTER_SEND_TTL_MS = 90 * 24 * 3600e3;
let lastSendSweep = 0;

/**
 * Claims the right to send for (message, filter). Returns true exactly once —
 * the caller may send — and false every time after, forever.
 *
 * INSERT OR IGNORE plus a `changes` check rather than SELECT-then-INSERT: the
 * decision and the record are then one atomic statement, so two filter runs
 * racing on the same message (a manual run landing on top of a poll) can't
 * both read "not sent yet" and both send.
 *
 * @param messageKey the message's Message-ID, or a folder/uid fallback for the
 *   rare message that has none — see filters.js.
 */
export function claimFilterSend(userKey, accountId, messageKey, filterId) {
  const now = Date.now();
  if (now - lastSendSweep > 3600e3) {
    lastSendSweep = now;
    db.prepare('DELETE FROM filter_sends WHERE sent_at < ?').run(now - FILTER_SEND_TTL_MS);
  }
  return claimSendStmt.run(userKey, accountId || '', String(messageKey), String(filterId), now).changes > 0;
}

/** Undoes a claim whose send then failed, so a later run can retry it. Without
 *  this a transient SMTP error would silently mean the forward never happens at
 *  all — the claim would stand as if it had been delivered. */
export function releaseFilterSend(userKey, accountId, messageKey, filterId) {
  db.prepare('DELETE FROM filter_sends WHERE user_key=? AND account_id=? AND message_key=? AND filter_id=?')
    .run(userKey, accountId || '', String(messageKey), String(filterId));
}

// ---------- message content cache (see server/contentCache.js) ----------

/** Parsed message content for uid, or null on a cache miss OR the "known
 * too big, don't cache" marker row (content_json NULL either way — the
 * caller can't tell the difference and doesn't need to, both mean "go live
 * for this one"). */
export function getMessageContent(userKey, accountId, folder, uid) {
  const row = db.prepare('SELECT content_json FROM message_content WHERE user_key=? AND account_id=? AND folder=? AND uid=?')
    .get(userKey, accountId, folder, uidKey(uid));
  if (!row || row.content_json == null) return null;
  try { return JSON.parse(row.content_json); } catch { return null; } // corrupt row — treat as a miss, next open just re-fetches live
}

/** `msg` null means "fetched, but over the size cap" — see the table comment above. */
export function saveMessageContent(userKey, accountId, folder, uid, msg, size) {
  db.prepare(`
    INSERT INTO message_content (user_key, account_id, folder, uid, content_json, size, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_key, account_id, folder, uid) DO UPDATE SET
      content_json=excluded.content_json, size=excluded.size, cached_at=excluded.cached_at
  `).run(userKey, accountId, folder, uidKey(uid), msg == null ? null : JSON.stringify(msg), size, Date.now());
}

/** Drops one message's cached content — for a write that made it stale on its
 *  own (answering a meeting invitation: Exchange rewrites the item and usually
 *  files it elsewhere). The envelope row is left to the folder re-sync. */
export function removeMessageContent(userKey, accountId, folder, uid) {
  db.prepare('DELETE FROM message_content WHERE user_key=? AND account_id=? AND folder=? AND uid=?')
    .run(userKey, accountId, folder, uidKey(uid));
}

/** The newest `limit` cached envelopes' uids for a folder, by date — the
 * proactive-caching window sync.js's backfill pass fills content in for. */
export function getRecentUids(userKey, accountId, folder, limit) {
  return db.prepare('SELECT uid FROM messages WHERE user_key=? AND account_id=? AND folder=? AND deleted=0 ORDER BY date DESC LIMIT ?')
    .all(userKey, accountId, folder, limit).map((r) => uidOut(r.uid));
}

/** Which of `uids` already have a message_content row (cached content OR the
 * "too big" marker — either way, already handled, nothing to fetch). */
export function getCachedContentUids(userKey, accountId, folder, uids) {
  if (!uids.length) return [];
  const keys = uids.map(uidKey);
  const placeholders = keys.map(() => '?').join(',');
  return db.prepare(`SELECT uid FROM message_content WHERE user_key=? AND account_id=? AND folder=? AND uid IN (${placeholders})`)
    .all(userKey, accountId, folder, ...keys).map((r) => uidOut(r.uid));
}

/** Drop cached content for anything that's fallen out of the current
 * top-`contentCacheLimit` window (aged out, or genuinely gone from the
 * folder) — keeps this table bounded to the configured size instead of
 * growing forever. `keepUids` is the folder's current recent-window list
 * (getRecentUids's own return), so this is safe to call every tick. */
export function pruneMessageContent(userKey, accountId, folder, keepUids) {
  if (!keepUids.length) {
    db.prepare('DELETE FROM message_content WHERE user_key=? AND account_id=? AND folder=?').run(userKey, accountId, folder);
    return;
  }
  const keys = keepUids.map(uidKey);
  const placeholders = keys.map(() => '?').join(',');
  db.prepare(`DELETE FROM message_content WHERE user_key=? AND account_id=? AND folder=? AND uid NOT IN (${placeholders})`)
    .run(userKey, accountId, folder, ...keys);
}

/** Highest cached UID for a folder — the boundary for the poller's cheap incremental "anything newer?" check. */
export function getMaxUid(userKey, accountId, folder) {
  // CAST because the column is TEXT (see uidKey) — MAX() on text would
  // compare lexicographically and answer '9' > '1200', handing the poller's
  // incremental "anything newer than this?" search a UID far below the real
  // high-water mark and making it re-fetch (and re-notify for) old mail.
  const row = db.prepare('SELECT MAX(CAST(uid AS INTEGER)) AS maxUid FROM messages WHERE user_key=? AND account_id=? AND folder=?').get(userKey, accountId, folder);
  return row?.maxUid || 0;
}

// $Forwarded is an IMAP KEYWORD, not a system flag — lowercase here and matched
// case-insensitively in applyFlags, because keywords are case-insensitive per
// RFC 3501 and servers differ on the case they echo back ($Forwarded/$forwarded).
const FLAG_COLUMN = { '\\seen': 'seen', '\\flagged': 'flagged', '\\answered': 'answered', '$forwarded': 'forwarded', '\\deleted': 'deleted', '\\draft': 'draft' };

/**
 * Mirror a flag change made through Hmelj (flags/delete routes in index.js)
 * into the cache immediately, so the very next read of this folder — a
 * reload, a folder switch — reflects it instead of waiting for the next
 * background poll (up to ~20 minutes for a full reconcile). The poller
 * remains the source of truth for drift from OTHER clients; this is only
 * for writes that went through this server.
 */
export function applyFlags(userKey, accountId, folder, uids, { add = [], remove = [] } = {}) {
  if (!uids.length) return { unseenDelta: 0 };
  const assignments = [];
  const col = (f) => FLAG_COLUMN[String(f).toLowerCase()];
  for (const f of add) if (col(f)) assignments.push(`${col(f)}=1`);
  for (const f of remove) if (col(f)) assignments.push(`${col(f)}=0`);
  if (!assignments.length) return { unseenDelta: 0 };
  const keys = uids.map(uidKey);
  const placeholders = keys.map(() => '?').join(',');

  // How many of these messages are ACTUALLY about to change read state —
  // measured before the write, because that's the only moment the old value
  // still exists. This is what lets callers nudge the folder's unread count
  // by a delta (adjustFolderCounts) instead of recounting the whole cached
  // window afterwards: recounting silently replaced the accurate server
  // STATUS number with one bounded by syncBackfillLimit, which under-counted
  // every folder holding more unread mail than the cache keeps rows for.
  //
  // Counted rather than assumed to be uids.length: re-marking an already-read
  // message as read is a no-op for the badge, and both the list UI and
  // "mark all as read" routinely pass mixed sets.
  let unseenDelta = 0;
  const marksSeen = add.includes('\\Seen');
  const marksUnseen = remove.includes('\\Seen');
  if (marksSeen || marksUnseen) {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE user_key=? AND account_id=? AND folder=? AND deleted=0 AND seen=? AND uid IN (${placeholders})`
    ).get(userKey, accountId, folder, marksSeen ? 0 : 1, ...keys);
    unseenDelta = marksSeen ? -(row?.n || 0) : (row?.n || 0);
  }

  db.prepare(
    `UPDATE messages SET ${assignments.join(', ')} WHERE user_key=? AND account_id=? AND folder=? AND uid IN (${placeholders})`
  ).run(userKey, accountId, folder, ...keys);
  return { unseenDelta };
}

/** Drop cached rows for messages that moved away or were expunged through
 * Hmelj (move/delete routes). Returns the same {unseenDelta, totalDelta}
 * shape applyFlags does, for the same reason — how much of this folder's
 * badge just went away, measured before the rows are gone. */
export function removeMessages(userKey, accountId, folder, uids) {
  if (!uids.length) return { unseenDelta: 0, totalDelta: 0 };
  const keys = uids.map(uidKey);
  const placeholders = keys.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN seen=0 THEN 1 ELSE 0 END) AS unseen
       FROM messages WHERE user_key=? AND account_id=? AND folder=? AND deleted=0 AND uid IN (${placeholders})`
  ).get(userKey, accountId, folder, ...keys);
  db.prepare(
    `DELETE FROM messages WHERE user_key=? AND account_id=? AND folder=? AND uid IN (${placeholders})`
  ).run(userKey, accountId, folder, ...keys);
  return { unseenDelta: -(row?.unseen || 0), totalDelta: -(row?.total || 0) };
}

/** Drop every cached row for a folder at once (the "Empty folder" action) —
 * same reasoning as removeMessages, just for the whole folder instead of a
 * uid list, so the message list and folder counts reflect it immediately
 * instead of only after the next background sync tick. */
export function clearFolder(userKey, accountId, folder) {
  db.prepare('DELETE FROM messages WHERE user_key=? AND account_id=? AND folder=?').run(userKey, accountId, folder);
  // Emptying a folder is the one mutation whose resulting counts are known
  // exactly without measuring anything: nothing is left in it.
  db.prepare('UPDATE folders SET total=0, unseen=0 WHERE user_key=? AND account_id=? AND path=?')
    .run(userKey, accountId, folder);
}

/** Same idea as clearFolder, for the "Delete folder" action — drops the
 * folder's own row too so a just-deleted folder doesn't linger as a ghost
 * entry in the sidebar/settings until the next background sync tick. */
export function removeFolder(userKey, accountId, path) {
  db.prepare('DELETE FROM messages WHERE user_key=? AND account_id=? AND folder=?').run(userKey, accountId, path);
  db.prepare('DELETE FROM message_content WHERE user_key=? AND account_id=? AND folder=?').run(userKey, accountId, path);
  db.prepare('DELETE FROM sync_state WHERE user_key=? AND account_id=? AND folder=?').run(userKey, accountId, path);
  db.prepare('DELETE FROM folders WHERE user_key=? AND account_id=? AND path=?').run(userKey, accountId, path);
}

/**
 * Drops everything cached under folder paths the server no longer lists.
 *
 * A folder deleted or renamed in another client leaves its rows behind: nothing
 * ever swept them, because every read is scoped to a path that came FROM the
 * folder listing, so orphaned rows are invisible — right up until the unified
 * view, which spans folders by special_use rather than by name and happily
 * lists them. Observed on a live Exchange account whose inbox path changed
 * spelling from `Inbox` to `INBOX`: 250 stale rows, last synced weeks earlier,
 * showing up as duplicates in All inboxes wherever the two windows overlapped.
 *
 * `keepPaths` must be the account's FULL folder listing — including hidden
 * folders, which are excluded from syncing but very much still exist. The
 * caller is responsible for not passing an empty/partial listing: this deletes.
 */
export function pruneMissingFolders(userKey, accountId, keepPaths) {
  const keep = new Set(keepPaths || []);
  if (!keep.size) return { folders: [], messages: 0 };
  const seen = new Set([
    ...db.prepare('SELECT DISTINCT folder AS p FROM messages WHERE user_key=? AND account_id=?').all(userKey, accountId).map((r) => r.p),
    ...db.prepare('SELECT path AS p FROM folders WHERE user_key=? AND account_id=?').all(userKey, accountId).map((r) => r.p),
    ...db.prepare('SELECT DISTINCT folder AS p FROM sync_state WHERE user_key=? AND account_id=?').all(userKey, accountId).map((r) => r.p),
  ]);
  const gone = [...seen].filter((p) => p != null && !keep.has(p));
  if (!gone.length) return { folders: [], messages: 0 };
  let messages = 0;
  const tx = db.transaction((paths) => {
    for (const p of paths) {
      messages += db.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_key=? AND account_id=? AND folder=?').get(userKey, accountId, p).n;
      removeFolder(userKey, accountId, p);
    }
  });
  tx(gone);
  clog.info(`Pruned ${messages} cached message(s) from ${gone.length} folder(s) no longer on the server: ${gone.join(', ')}`);
  return { folders: gone, messages };
}

/**
 * Nudge a folder's cached badge counts by a delta, right after a mutation
 * whose exact effect we just measured (applyFlags/removeMessages return it).
 *
 * This replaced recomputeFolderCounts on every mutation path, and the
 * difference matters: recomputing counted the cached ROWS, which only ever
 * cover the newest syncBackfillLimit (default 250) messages per folder. On a
 * folder holding more unread than that, every single click silently
 * overwrote the accurate server STATUS number written by upsertFolders with
 * a smaller one, and it stayed wrong until the next poll cycle. A delta
 * leaves STATUS authoritative and only applies the change we actually made.
 *
 * Clamped at zero: the cache can legitimately not know about an unread
 * message (it's outside the window), so a delta must never be able to drive
 * a count negative.
 */
export function adjustFolderCounts(userKey, accountId, folder, { unseenDelta = 0, totalDelta = 0 } = {}) {
  if (!unseenDelta && !totalDelta) return;
  db.prepare(
    `UPDATE folders SET total = MAX(0, total + ?), unseen = MAX(0, unseen + ?)
       WHERE user_key=? AND account_id=? AND path=?`
  ).run(totalDelta, unseenDelta, userKey, accountId, folder);
}

/**
 * Recompute a folder's unseen/total badge counts from the cached messages
 * themselves. Bounded to the cached window (the newest syncBackfillLimit
 * messages per folder, not full mailbox history), so it UNDER-COUNTS any
 * folder with unread mail older than that window.
 *
 * Because of that this is now a last-resort fallback only, used where a real
 * server STATUS was attempted and failed (see sync.js#syncFolderNow) — an
 * approximation beats leaving a visibly stale number. Mutation paths must use
 * adjustFolderCounts above instead; they know their own exact delta and have
 * no reason to throw away the accurate STATUS baseline to get it.
 */
export function recomputeFolderCounts(userKey, accountId, folder) {
  const row = db.prepare(
    'SELECT COUNT(*) AS total, SUM(CASE WHEN seen=0 THEN 1 ELSE 0 END) AS unseen FROM messages WHERE user_key=? AND account_id=? AND folder=? AND deleted=0'
  ).get(userKey, accountId, folder);
  db.prepare('UPDATE folders SET total=?, unseen=? WHERE user_key=? AND account_id=? AND path=?')
    .run(row.total || 0, row.unseen || 0, userKey, accountId, folder);
}

/**
 * Cross-check a folder's stored unread counter against the cached message rows
 * and correct it — but only when the cache demonstrably holds every message in
 * the folder.
 *
 * The badge and the message list read from two different places: rows carry
 * `messages.seen`, while every unread number (server/unread.js, the sidebar,
 * the tab title, the launcher badge) comes from `folders.unseen`, a counter
 * nudged by deltas and periodically overwritten by a server STATUS. Those two
 * can end up disagreeing — that's the drift the guards in sync.js now prevent
 * at the source — and when they do, nothing noticed until the next full poll
 * cycle rewrote the counter from a fresh STATUS. This is the check that
 * notices, so a mutation can leave the two provably consistent instead of
 * hoping they are.
 *
 * Deliberately narrow, and it must stay that way. recomputeFolderCounts'
 * warning applies in full: counting cached rows UNDER-counts any folder
 * holding unread mail older than the cache window, which is exactly the bug
 * that made every click quietly shrink a large folder's badge. So this refuses
 * to touch anything unless it can prove the window isn't a window at all:
 *
 *   - one cached row per message the server says the folder holds, and
 *   - no \Deleted-but-unexpunged rows, since those count toward the server's
 *     STATUS numbers but are excluded from every unread total here, so the two
 *     definitions are only provably comparable when there are none.
 *
 * Returns `{from, to}` when it corrected something, null when it didn't (no
 * coverage, or the counter was already right — the overwhelmingly common case).
 */
export function reconcileFolderCounts(userKey, accountId, folder) {
  const f = db.prepare('SELECT total, unseen FROM folders WHERE user_key=? AND account_id=? AND path=?')
    .get(userKey, accountId, folder);
  if (!f || typeof f.total !== 'number') return null;
  const row = db.prepare(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN deleted=1 THEN 1 ELSE 0 END) AS gone,
            SUM(CASE WHEN seen=0 AND deleted=0 THEN 1 ELSE 0 END) AS unseen
       FROM messages WHERE user_key=? AND account_id=? AND folder=?`
  ).get(userKey, accountId, folder);
  if (!row || row.n !== f.total || row.gone) return null; // cache doesn't provably cover the folder — the delta counter stays authoritative
  const unseen = row.unseen || 0;
  if (unseen === f.unseen) return null;
  db.prepare('UPDATE folders SET unseen=? WHERE user_key=? AND account_id=? AND path=?')
    .run(unseen, userKey, accountId, folder);
  return { from: f.unseen, to: unseen };
}

/** Same shape as recomputeFolderCounts, but with real server-reported
 * counts (see imapClient.js#folderStatus) instead of approximating from
 * cache rows — the cache only ever holds the newest syncBackfillLimit
 * messages per folder, so a row-count approximation under-counts unseen
 * whenever an older unread message falls outside that window. Used anywhere
 * the count needs to actually match the server; together with upsertFolders
 * this is the authoritative baseline that adjustFolderCounts nudges between
 * polls. */
export function setFolderCounts(userKey, accountId, folder, { total, unseen }) {
  db.prepare('UPDATE folders SET total=?, unseen=? WHERE user_key=? AND account_id=? AND path=?')
    .run(total || 0, unseen || 0, userKey, accountId, folder);
}

/**
 * Force a folder's cached unread count to zero, leaving its total alone.
 *
 * For "mark all as read", which is the one operation that knows the answer
 * outright: it SEARCHes the server for every unseen message and marks all of
 * them, so afterwards the folder has none left — whatever this cache happens to
 * hold rows for. The delta path (applyFlags + adjustFolderCounts) cannot express
 * that: it counts only the uids present in the cached window, so on a folder
 * with more unread mail than the window keeps (75k messages, ~250 cached) it
 * computes a delta of 0 and the badge stays stuck at its old value even though
 * the server now reports nothing unread.
 */
export function clearFolderUnseen(userKey, accountId, folder) {
  db.prepare('UPDATE folders SET unseen=0 WHERE user_key=? AND account_id=? AND path=?')
    .run(userKey, accountId, folder);
}

/**
 * Flip the cached `hidden` flag for an account's folders to match a freshly
 * saved hiddenFolders list — without this, toggling "Show in sidebar" in
 * Settings only took effect on the next full background sync tick (up to
 * config.syncIntervalMs later, since `hidden` otherwise only gets written by
 * upsertFolders, run once per poll), which read as the sidebar/settings
 * checkbox silently ignoring the change until some unrelated "hard refresh."
 * No-op for folders not yet cached; they'll get the right value the first
 * time upsertFolders sees them.
 */
export function setFoldersHidden(userKey, accountId, hiddenPaths) {
  const hidden = new Set(hiddenPaths || []);
  const rows = db.prepare('SELECT path FROM folders WHERE user_key=? AND account_id=?').all(userKey, accountId);
  const stmt = db.prepare('UPDATE folders SET hidden=? WHERE user_key=? AND account_id=? AND path=?');
  const tx = db.transaction(() => {
    for (const r of rows) stmt.run(hidden.has(r.path) ? 1 : 0, userKey, accountId, r.path);
  });
  tx();
}

/** Re-keys every cached row after a Hmelj login username change (see session.js#renameUser). */
export function renameUserKey(oldKey, newKey) {
  const tx = db.transaction(() => {
    db.prepare('UPDATE messages SET user_key=? WHERE user_key=?').run(newKey, oldKey);
    db.prepare('UPDATE folders SET user_key=? WHERE user_key=?').run(newKey, oldKey);
    db.prepare('UPDATE sync_state SET user_key=? WHERE user_key=?').run(newKey, oldKey);
  });
  tx();
}

const upsertFolderStmt = db.prepare(`
  INSERT INTO folders (user_key, account_id, path, name, delimiter, parent, special_use, subscribed, hidden, total, unseen, sort_rank)
  VALUES (@userKey, @accountId, @path, @name, @delimiter, @parent, @specialUse, @subscribed, @hidden, @total, @unseen, @sortRank)
  ON CONFLICT (user_key, account_id, path) DO UPDATE SET
    name=excluded.name, delimiter=excluded.delimiter, parent=excluded.parent, special_use=excluded.special_use,
    subscribed=excluded.subscribed, hidden=excluded.hidden, total=excluded.total, unseen=excluded.unseen, sort_rank=excluded.sort_rank
`);

/**
 * Snapshot an account's full folder list (as returned by
 * imapClient.js#listFolders, including per-folder total/unseen counts) —
 * the background poller already fetches this every cycle to decide what's
 * in sync scope, so this just persists that result for interactive reads
 * (see queryFolders below) instead of letting every folder-list open pay
 * for its own live IMAP LIST+STATUS call, which is what was making a
 * heavily-loaded account feel slow to even open.
 */
export function upsertFolders(userKey, accountId, folders) {
  const tx = db.transaction((rows) => {
    // Delete only folders the server no longer reports — NOT "delete
    // everything, then re-insert". The wholesale version dropped and
    // recreated every row each cycle, which threw away any delta a mutation
    // had applied since the poll started (adjustFolderCounts) and reset the
    // rows' identity for no reason. Now a folder that's simply still there
    // gets UPDATEd in place by the UPSERT below.
    const keep = new Set(rows.map((f) => f.path));
    const existing = db.prepare('SELECT path FROM folders WHERE user_key=? AND account_id=?').all(userKey, accountId);
    const gone = existing.filter((r) => !keep.has(r.path)).map((r) => r.path);
    if (gone.length) {
      const placeholders = gone.map(() => '?').join(',');
      db.prepare(`DELETE FROM folders WHERE user_key=? AND account_id=? AND path IN (${placeholders})`)
        .run(userKey, accountId, ...gone);
    }
    rows.forEach((f, i) => {
      upsertFolderStmt.run({
        userKey, accountId, path: f.path, name: f.name, delimiter: f.delimiter, parent: f.parent,
        specialUse: f.specialUse || null, subscribed: f.subscribed ? 1 : 0, hidden: f.hidden ? 1 : 0,
        total: f.total, unseen: f.unseen, sortRank: i,
      });
    });
  });
  tx(folders);
}

export function getFolders(userKey, accountId) {
  const rows = db.prepare('SELECT * FROM folders WHERE user_key=? AND account_id=? ORDER BY sort_rank').all(userKey, accountId);
  return rows.map((r) => ({
    path: r.path, name: r.name, delimiter: r.delimiter, parent: r.parent,
    specialUse: r.special_use, subscribed: !!r.subscribed, hidden: !!r.hidden,
    total: r.total, unseen: r.unseen,
  }));
}

export function setSyncState(userKey, accountId, folder, { lastError = null } = {}) {
  db.prepare(`
    INSERT INTO sync_state (user_key, account_id, folder, last_synced_at, last_error)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_key, account_id, folder) DO UPDATE SET last_synced_at=excluded.last_synced_at, last_error=excluded.last_error
  `).run(userKey, accountId, folder, Date.now(), lastError);
}

/** Per-account status for the client's "syncing…" indicator (see sync.js for the in-memory `syncing` flag). */
export function getSyncSummary(userKey, accountIds) {
  if (!accountIds.length) return [];
  const placeholders = accountIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT account_id, MAX(last_synced_at) AS last_synced_at,
      MAX(CASE WHEN last_error IS NOT NULL THEN last_error END) AS last_error
    FROM sync_state WHERE user_key=? AND account_id IN (${placeholders}) GROUP BY account_id
  `).all(userKey, ...accountIds);
  return rows;
}

/* ---------- shared list-query machinery (queryUnified / queryFolder) ---------- */

/**
 * One cached row in the shape the browser expects. Both list queries return
 * exactly this — they differ only in what they select, never in how a row is
 * presented — and live IMAP results have the same shape, which is the contract
 * uidOut() exists to protect (see its comment).
 */
function rowToMessage(r) {
  return {
    uid: uidOut(r.uid),
    subject: r.subject,
    from: { name: r.from_name, address: r.from_addr },
    to: JSON.parse(r.to_json || '[]'),
    date: r.date ? new Date(r.date).toISOString() : null,
    size: r.size,
    seen: !!r.seen, flagged: !!r.flagged, answered: !!r.answered, forwarded: !!r.forwarded, deleted: !!r.deleted, draft: !!r.draft,
    hasAttachment: !!r.has_attachment,
    // Always present, not just for a subtree read: with subtreeDelimiter (or a
    // conversation spanning Sent) the rows genuinely span folders and the
    // client has no other way to know which one a message came from (it
    // opens/stars/moves by this — see app.js#withMsgCtx), and without it this
    // is simply the folder that was asked for, which is what that same
    // client-side fallback would have produced anyway.
    folder: r.folder,
  };
}

/**
 * The conversation a row belongs to. NULL/'' thread_id — a row cached before
 * the column existed, or a message with no usable Message-ID — falls back to a
 * key unique to that one message, i.e. a conversation of one. char(0) is a
 * separator that cannot occur in either a folder name or a uid.
 */
const TID_EXPR = `COALESCE(NULLIF(thread_id, ''), 'u:' || folder || char(0) || uid)`;

/** Flat (one row per message) page — what both list queries have always done. */
function pageMessages({ where, params, page, pageSize }) {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM messages WHERE ${where} ORDER BY date DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  return { total, rows };
}

/**
 * Grouped (one row per conversation) page.
 *
 * Three statements rather than one clever join, because a page of threads is
 * genuinely two questions: WHICH conversations belong on this page (grouped,
 * ordered by their newest message, paged), and then everything in them.
 *
 * `homeSql` is what makes a conversation belong to the folder being listed at
 * all: the scoped set deliberately reaches beyond that folder (an Inbox thread
 * includes the replies you sent, which live in Sent), but a thread made ONLY of
 * Sent messages is not an Inbox thread and must not appear in an Inbox listing.
 * Omitting it means "every scoped row counts", which is what the unified view
 * wants — it has no single home folder.
 *
 * Parameter order is textual, so: `where` params (inside the CTE), then
 * `homeParams`, then LIMIT/OFFSET.
 */
function pageThreads({ where, params, page, pageSize, tidExpr = TID_EXPR, homeSql = null, homeParams = [],
  convoWhere = null, convoParams = [] }) {
  const scoped = `WITH scoped AS (SELECT *, ${tidExpr} AS tid FROM messages WHERE ${where})`;
  const homeCount = homeSql ? `SUM(CASE WHEN ${homeSql} THEN 1 ELSE 0 END)` : 'COUNT(*)';
  const having = homeSql ? `HAVING ${homeCount} > 0` : '';

  const total = db.prepare(
    `${scoped} SELECT COUNT(*) AS n FROM (SELECT tid FROM scoped GROUP BY tid ${having})`
  ).get(...params, ...homeParams).n;

  const heads = db.prepare(
    `${scoped} SELECT tid, MAX(date) AS d FROM scoped GROUP BY tid ${having} ORDER BY d DESC, tid LIMIT ? OFFSET ?`
  ).all(...params, ...homeParams, pageSize, (page - 1) * pageSize);
  if (!heads.length) return { total, rows: [] };

  const holes = heads.map(() => '?').join(',');
  const members = db.prepare(
    `${scoped} SELECT * FROM scoped WHERE tid IN (${holes}) ORDER BY date ASC`
  ).all(...params, ...heads.map((h) => h.tid));

  const byTid = new Map();
  for (const m of members) {
    if (!byTid.has(m.tid)) byTid.set(m.tid, []);
    byTid.get(m.tid).push(m);
  }

  // HOW MANY messages the conversation really has, counted over the whole
  // conversation (cache.js#conversationFolders) rather than over whatever this
  // listing happens to show. `members` above stays the listing's own rows —
  // they are what the row is drawn from and what an action on it may touch —
  // so only the number widens.
  //
  // This is the fix for a count that kept disagreeing with the stack: a thread
  // half-filed into another folder read 2 in one view and 4 in another, and
  // dropped back to 2 whenever that folder was muted and muted folders were
  // hidden. What a conversation IS cannot depend on the view it is seen from.
  let convoCounts = null;
  if (convoWhere) {
    convoCounts = new Map(db.prepare(
      `WITH convo AS (SELECT *, ${tidExpr} AS tid FROM messages WHERE ${convoWhere})
       SELECT tid, COUNT(*) AS n FROM convo WHERE tid IN (${holes}) GROUP BY tid`
    ).all(...convoParams, ...heads.map((h) => h.tid)).map((r) => [r.tid, r.n]));
  }
  // Head order, not member order: `heads` is already the correct page, sorted
  // by each conversation's newest message.
  const rows = [];
  for (const h of heads) {
    const group = byTid.get(h.tid) || [];
    if (!group.length) continue;
    rows.push({ ...group[group.length - 1], __thread: group, __tid: h.tid, __convoCount: convoCounts?.get(h.tid) || group.length });
  }
  return { total, rows };
}

/**
 * Turns a grouped row into a list entry: the conversation's NEWEST message,
 * annotated with what the row has to draw and what an action on it may touch.
 *
 * threadUids covers only the messages in `homeFolders` — the folder the user is
 * actually looking at. Deleting an Inbox conversation must not delete the
 * replies you sent from your own Sent folder, and every batch action in the
 * client works from this list (see app.js#buildRow).
 */
function threadRowToMessage(r, homeFolders) {
  const group = r.__thread;
  const msg = rowToMessage(r);
  msg.threadId = r.__tid;
  // The whole conversation, not just the part this listing shows (see
  // pageThreads' convoWhere). Everything BELOW stays over the listing's own
  // members: the unread mark has to match what clicking the row will mark read,
  // and threadUids is what an action on it is allowed to touch.
  msg.threadCount = r.__convoCount || group.length;
  // Aggregates: a conversation is unread if anything in it is, starred if
  // anything in it is — the same way every other mail client reads a thread.
  msg.threadUnseen = group.filter((m) => !m.seen).length;
  msg.threadFlagged = group.some((m) => !!m.flagged);
  msg.hasAttachment = group.some((m) => !!m.has_attachment);
  msg.threadUids = group
    .filter((m) => !homeFolders || homeFolders.has(m.folder))
    .map((m) => uidOut(m.uid));
  return msg;
}

const EXCLUDED_INBOX_USE = ['\\Trash', '\\Junk', '\\Drafts', '\\Sent'];

/**
 * Unified Inbox/Sent, pure SQLite read — replaces the old "fan out live IMAP
 * calls to every account, re-fetching page*pageSize each time" approach.
 * `accounts` is [{id, label, color, sentFolder}] for the requesting user's
 * mail accounts (cache.js has no notion of accounts on its own).
 */
export function queryUnified(userKey, accounts, { box, page = 1, pageSize = 50, q = '', unreadOnly = false, flaggedOnly = false, mutedPairs = null, threaded = false }) {
  if (!accounts.length) return { total: 0, messages: [] };
  const ids = accounts.map((a) => a.id);
  const placeholders = ids.map(() => '?').join(',');
  const params = [userKey, ...ids];
  let where = `user_key=? AND account_id IN (${placeholders}) AND deleted=0`;

  if (box === 'sent') {
    const clauses = accounts.map((a) => { params.push(a.id, a.sentFolder || 'Sent'); return '(account_id=? AND folder=?)'; });
    where += ` AND (${clauses.join(' OR ')})`;
  } else {
    where += ` AND (${EXCLUDED_INBOX_USE.map(() => 'special_use IS NOT ?').join(' AND ')})`;
    params.push(...EXCLUDED_INBOX_USE);
    // Belt-and-suspenders alongside the specialUse check above: specialUse
    // detection isn't always reliable (a self-hosted server or an unusual
    // Gmail locale can fail to report \Sent on the real Sent folder), but
    // each account's own sentFolder mapping is — it's the same one used to
    // actually save outgoing mail, so exclude by that path too, not just
    // the specialUse flag.
    const sentClauses = accounts.filter((a) => a.sentFolder).map((a) => { params.push(a.id, a.sentFolder); return '(account_id=? AND folder=?)'; });
    if (sentClauses.length) where += ` AND NOT (${sentClauses.join(' OR ')})`;
  }
  // A folder hidden via the per-account "Show in sidebar" toggle shouldn't
  // surface here either — mirrors sync.js's own hidden-folder skip (which
  // only stops future syncing; messages already cached from before a folder
  // was hidden, or synced by some other path, stick around in this table
  // otherwise). Without this, those rows were always included in "All
  // inbox" — normally just buried by newer mail and easy not to notice, but
  // impossible to miss once unreadOnly shrinks the pool down to them.
  const hiddenClauses = [];
  for (const a of accounts) {
    for (const path of a.hiddenFolders || []) { hiddenClauses.push('(account_id=? AND folder=?)'); params.push(a.id, path); }
  }
  if (hiddenClauses.length) where += ` AND NOT (${hiddenClauses.join(' OR ')})`;
  // Notification scheduler's "Hide muted" toggle (server/schedule.js's
  // mutedFolderPairsFor, computed once by the caller in server/index.js and handed in
  // here — cache.js deliberately has no import dependency on schedule.js itself, to
  // keep this a plain "exclude these precomputed pairs" filter like hiddenClauses
  // above, not a second place that knows how to evaluate a schedule). Same
  // pairKey(accountId, folderPath) join format as schedule.js — split back apart here
  // rather than importing that helper, for the same reason.
  if (mutedPairs?.size) {
    const mutedClauses = [];
    for (const key of mutedPairs) {
      const sepIdx = key.indexOf(String.fromCharCode(0));
      mutedClauses.push('(account_id=? AND folder=?)');
      params.push(key.slice(0, sepIdx), key.slice(sepIdx + 1));
    }
    where += ` AND NOT (${mutedClauses.join(' OR ')})`;
  }
  if (unreadOnly) where += ' AND seen=0';
  // "Starred only" (the toolbar's ★ — see public/js/app.js's #btn-starred-only).
  // Nothing else narrows the folder set: in the unified view starred means every
  // account and every folder this query already spans, which is the whole point
  // of asking for it from here rather than folder by folder.
  if (flaggedOnly) where += ' AND flagged=1';
  if (q) {
    const built = buildCacheSearchClause(q);
    where += ` AND (${built.sql})`;
    params.push(...built.params);
  }

  // Grouped per ACCOUNT as well as per conversation: a Message-ID is globally
  // unique, so the same mail delivered to two of the user's accounts would
  // otherwise merge into one row belonging to neither, and every action on it
  // would have to guess which account it meant.
  // Same reasoning as queryFolder's: the LISTING is filtered (hidden folders,
  // muted ones while "show muted" is off, unread/starred, a search), the COUNT
  // is over the conversation. A folder being muted silences its notifications;
  // it does not take its messages out of a conversation they belong to — which
  // is exactly what made this thread read 2 with muted folders hidden and 4
  // with them shown.
  const convoClauses = [];
  const convoParams = [userKey];
  for (const a of accounts) {
    for (const path of conversationFolders(userKey, a)) {
      convoClauses.push('(account_id=? AND folder=?)');
      convoParams.push(a.id, path);
    }
  }
  const convo = convoClauses.length
    ? { convoWhere: `user_key=? AND deleted=0 AND (${convoClauses.join(' OR ')})`, convoParams }
    : {};
  const { total, rows } = threaded
    ? pageThreads({ where, params, page, pageSize, tidExpr: `account_id || char(0) || ${TID_EXPR}`, ...convo })
    : pageMessages({ where, params, page, pageSize });

  const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
  const messages = rows.map((r) => {
    // Actions on a unified row are scoped to the folder its newest message is
    // in, even though the count spans more: this view lists several folders per
    // account, and the client resolves a batch action's target folder from the
    // ROW (app.js#batchOpInner). Handing it uids from a sibling folder would
    // have it delete whatever happens to carry those uids in the row's folder.
    const m = threaded ? threadRowToMessage(r, new Set([r.folder])) : rowToMessage(r);
    // Strip the account_id this view grouped by (see tidExpr above) back off
    // the key it hands the client: `account` already carries that, and
    // getThread() is asked for one account's conversation by its bare key.
    if (threaded) m.threadId = m.threadId.slice(m.threadId.indexOf('\0') + 1);
    m.account = byId[r.account_id] ? { id: r.account_id, label: byId[r.account_id].label, color: byId[r.account_id].color } : { id: r.account_id };
    return m;
  });
  return { total, messages };
}

/**
 * Single-account, single-folder read from cache — used for interactively
 * browsing a specific account's INBOX or Sent folder (the two folders the
 * background poller keeps warm) instead of hitting live IMAP on every page
 * load. On a large, long-lived Sent folder this is what avoids repeating the
 * multi-second full-envelope date scan (see imapClient.js#listMessages) on
 * every open — the poller already pays that cost once in the background,
 * on its own schedule, instead of blocking whoever's waiting on a click.
 */
export function queryFolder(userKey, accountId, folder, { page = 1, pageSize = 50, q = '', unreadOnly = false, flaggedOnly = false, subtreeDelimiter = null, showDeleted = false, threaded = false, threadFolders = [], convoFolders = [] } = {}) {
  // `subtreeDelimiter` widens the read to this folder AND everything nested under
  // it — what the starred view (flaggedOnly, from /api/messages/:folder's
  // `flagged=1`) means by "starred in Work": the whole Work tree, not just its top
  // level. It's the account's real hierarchy separator ('/', '.', '\\'), passed in
  // from the folders table rather than assumed, since it differs per provider.
  // Rows can then span several folders, so each one carries its own `folder` below.
  // `threadFolders` widens the read the other way: with conversation view on,
  // an Inbox listing also has to SEE this account's Sent folder, or a thread's
  // count and its stacked view would silently leave out your own replies. Only
  // threads with at least one message in `folder` itself are listed, though —
  // see pageThreads' homeSql.
  const extraFolders = threaded ? (threadFolders || []).filter((f) => f && f !== folder) : [];
  let where = 'user_key=? AND account_id=? AND folder=?';
  const params = [userKey, accountId, folder];
  if (subtreeDelimiter) {
    where = `user_key=? AND account_id=? AND (folder=? OR folder LIKE ? ESCAPE '\\')`;
    params.push(likeEscape(folder + subtreeDelimiter) + '%');
  } else if (extraFolders.length) {
    where = `user_key=? AND account_id=? AND folder IN (${['?', ...extraFolders.map(() => '?')].join(',')})`;
    params.push(...extraFolders);
  }
  if (!showDeleted) where += ' AND deleted=0';
  if (unreadOnly) where += ' AND seen=0';
  if (flaggedOnly) where += ' AND flagged=1';
  if (q) {
    const built = buildCacheSearchClause(q);
    where += ` AND (${built.sql})`;
    params.push(...built.params);
  }

  const homeFolders = new Set([folder]);
  // `threadFolders` is what the LISTING reads (this folder + Sent);
  // `convoFolders` is what a CONVERSATION spans (index.js#threadScopeFolders →
  // conversationFolders). Widening the listing to the second set would put
  // other folders' mail in an Inbox, so only the COUNT uses it — which is what
  // makes the number on a row equal the stack that opens from it.
  // Falls back to the LISTING's own folders (this one plus whatever
  // threadFolders widened it to), never to threadFolders alone — that set does
  // not contain `folder` itself, so counting over it would answer "how many of
  // this conversation are in Sent".
  const convoScope = (convoFolders || []).length ? convoFolders : [folder, ...extraFolders];
  const convo = threaded && (convoScope || []).length
    ? {
      convoWhere: `user_key=? AND account_id=? AND deleted=0 AND folder IN (${convoScope.map(() => '?').join(',')})`,
      convoParams: [userKey, accountId, ...convoScope],
    }
    : {};
  const { total, rows } = threaded
    ? pageThreads({ where, params, page, pageSize, homeSql: 'folder=?', homeParams: [folder], ...convo })
    : pageMessages({ where, params, page, pageSize });
  const messages = threaded ? rows.map((r) => threadRowToMessage(r, homeFolders)) : rows.map(rowToMessage);
  // `total` above is how many rows are actually cached and pageable — for a
  // folder bigger than BACKFILL_LIMIT that's NOT the same as the real
  // mailbox size, and showing it bare as "1-50 of 1038" reads as "this
  // folder has 1038 messages," which would just be wrong. realTotal is the
  // server-reported count from the folders table (populated from IMAP
  // STATUS, not this cache) — only meaningful without a search/unread
  // filter active, since it doesn't know about either.
  // Never alongside threading: `total` is then a count of CONVERSATIONS, and
  // pairing it with the server's message count would render as "1-50 of 1038"
  // over a list where 50 rows are not 50 messages.
  let realTotal = null;
  if (!q && !unreadOnly && !flaggedOnly && !subtreeDelimiter && !threaded) {
    const row = db.prepare('SELECT total FROM folders WHERE user_key=? AND account_id=? AND path=?').get(userKey, accountId, folder);
    if (row && row.total != null) realTotal = row.total;
  }
  return { total, realTotal, page, pageSize, messages };
}

/**
 * Every message of one conversation, oldest first — what the stacked reading
 * pane draws (see app.js#openThread).
 *
 * `folders` is the same scope the listing used (the folder being read plus that
 * account's Sent), so the stack contains exactly the messages the row's count
 * promised. Envelopes only: bodies are fetched per message, on expand, through
 * the ordinary message route, which is already content-cached.
 *
 * A conversation of one — a message with no usable thread_id — is addressed by
 * the same synthetic key the list handed out, so the client never needs a
 * special case for "this row wasn't really a thread".
 */
/**
 * What a CONVERSATION spans, for one account: every folder except Trash, Junk
 * and Drafts, plus Sent, minus the ones hidden from the sidebar.
 *
 * One definition used by the count, by the stack, and by every view — because
 * the count and the stack disagreeing has now been reported three times, each
 * time for a different reason, and each time because one of them was taken over
 * the LISTING's folder set instead of the conversation's:
 *
 *   1. the stack was scoped to [the row's folder, Sent] while the unified count
 *      spanned everything — a conversation filed into "Tickets" opened as
 *      a single message under a chip saying 2;
 *   2. the same thread read 2 in a single-account Inbox and 4 in All inboxes;
 *   3. the count dropped to 2 again because that folder is MUTED and the list
 *      was hiding muted folders.
 *
 * So: what a conversation IS does not depend on what is being listed, on a
 * notification schedule, or on a view toggle. Mutes are deliberately ignored
 * here — muting a folder silences its alerts, it does not remove its messages
 * from a conversation they are part of. Hidden folders are still excluded: that
 * one really is a statement about not wanting to see a folder's mail.
 *
 * Sent is included even though no listing shows it as rows: a conversation is
 * not a conversation without your own half of it.
 */
export function conversationFolders(userKey, account) {
  const hidden = new Set(account.hiddenFolders || []);
  const sent = account.sentFolder;
  const paths = getFolders(userKey, account.id)
    .filter((f) => !EXCLUDED_INBOX_USE.includes(f.specialUse) && f.path !== sent && !hidden.has(f.path) && !f.hidden)
    .map((f) => f.path);
  if (sent) paths.push(sent);
  return [...new Set(paths)];
}

export function getThread(userKey, accountId, threadId, folders) {
  const list = (folders || []).filter(Boolean);
  if (!list.length || !threadId) return [];
  const holes = list.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM messages
     WHERE user_key=? AND account_id=? AND folder IN (${holes}) AND deleted=0 AND ${TID_EXPR} = ?
     ORDER BY date ASC`
  ).all(userKey, accountId, ...list, threadId);
  return rows.map(rowToMessage);
}

export function deleteAccountCache(userKey, accountId) {
  db.prepare('DELETE FROM messages WHERE user_key=? AND account_id=?').run(userKey, accountId);
  db.prepare('DELETE FROM sync_state WHERE user_key=? AND account_id=?').run(userKey, accountId);
}
