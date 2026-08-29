// Hmelj — mailbox analytics: "where is my quota actually going, and what can
// I safely delete?"
//
// Why this needs its own index instead of reusing cache.js's `messages`:
// that table deliberately holds only the newest syncBackfillLimit (default
// 250) rows PER FOLDER, and only for folders in the sync scope (INBOX + its
// subfolders + Sent). A 35,000-message Gmail INBOX therefore has ~250 rows
// there. Every question this feature answers — total counts, biggest
// messages, who sends the most, how much space a sender costs — needs the
// complete picture, so analytics keeps a second, complete-but-thin index
// (no bodies, no bodystructure: id, sender, subject, date, size, two flags)
// built by an explicit background scan the user starts.
//
// Gmail scope, and why it matters for honesty:
// on Gmail the same physical message appears under INBOX and under every
// label it carries, so summing per-folder counts double-counts. Worse,
// deleting a message from INBOX only removes that label — the message stays
// in All Mail and keeps consuming quota, so a "space freed" number derived
// from per-label deletion would be a lie. So for Gmail the scan indexes
// [Gmail]/All Mail (plus Trash and Spam, which hold quota of their own and
// are NOT in All Mail) and treats that as the truth. Everywhere else folders
// are a non-overlapping tree, so the scan simply walks all of them.
// Deduplication is belt-and-braces on top of that: rows carry the server's
// own unique message id when it offers one (RFC 8474 OBJECTID / Gmail's
// X-GM-MSGID, which imapflow returns on every fetch), and every aggregate
// counts each distinct id once.
import * as imap from './mailClient.js';
import { db } from './cache.js';
import * as cache from './cache.js';
import { isLabelOverlapProne } from './scope.js';
import { log } from './log.js';

const alog = log.scope('analytics');

db.exec(`
CREATE TABLE IF NOT EXISTS analytics_messages (
  user_key TEXT NOT NULL,
  account_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  -- Same opaque-id contract as cache.js's messages.uid: an IMAP integer UID or
  -- another protocol's own id shape, stored TEXT so it round-trips as given.
  uid TEXT NOT NULL,
  -- Server-assigned unique message id (X-GM-MSGID / EMAILID) when available,
  -- else NULL. What makes "one physical message" countable exactly once even
  -- when it shows up under several Gmail labels.
  email_id TEXT,
  from_addr TEXT,
  from_name TEXT,
  subject TEXT,
  date INTEGER,
  size INTEGER,
  seen INTEGER,
  -- Had a List-Unsubscribe header: the most reliable "bulk/commercial mail"
  -- signal there is, and the best axis for "delete this whole category".
  bulk INTEGER,
  PRIMARY KEY (user_key, account_id, folder, uid)
);
CREATE INDEX IF NOT EXISTS idx_an_size ON analytics_messages(user_key, account_id, size DESC);
CREATE INDEX IF NOT EXISTS idx_an_from ON analytics_messages(user_key, account_id, from_addr);
CREATE INDEX IF NOT EXISTS idx_an_date ON analytics_messages(user_key, account_id, date);

CREATE TABLE IF NOT EXISTS analytics_scan_state (
  user_key TEXT NOT NULL,
  account_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  -- Highest UID this folder has been scanned up to, so a rescan only fetches
  -- what arrived since. Meaningless (and left at 0) for protocols whose ids
  -- aren't monotonic integers, which just rescan the folder.
  max_uid INTEGER,
  scanned_at INTEGER,
  PRIMARY KEY (user_key, account_id, folder)
);
`);

const insertStmt = db.prepare(`
  INSERT INTO analytics_messages
    (user_key, account_id, folder, uid, email_id, from_addr, from_name, subject, date, size, seen, bulk)
  VALUES (@userKey, @accountId, @folder, @uid, @emailId, @fromAddr, @fromName, @subject, @date, @size, @seen, @bulk)
  ON CONFLICT(user_key, account_id, folder, uid) DO UPDATE SET
    email_id=excluded.email_id, from_addr=excluded.from_addr, from_name=excluded.from_name,
    subject=excluded.subject, date=excluded.date, size=excluded.size, seen=excluded.seen, bulk=excluded.bulk
`);

const insertBatch = db.transaction((rows) => {
  for (const r of rows) insertStmt.run(r);
});

/* ---------------------------------------------------------------------------
 * Scanning
 * ------------------------------------------------------------------------- */

// accountId -> live progress. In memory on purpose: a scan belongs to the
// process running it, and a restart mid-scan should leave no "still scanning"
// ghost that nothing will ever finish. What survives a restart is the actual
// indexed rows plus each folder's high-water mark, so a rescan resumes cheaply.
const scans = new Map();

export function scanProgress(accountId) {
  const s = scans.get(accountId);
  if (!s) return { running: false };
  return {
    running: true, folder: s.folder, foldersDone: s.foldersDone, foldersTotal: s.foldersTotal,
    scanned: s.scanned, folderScanned: s.folderScanned, folderTotal: s.folderTotal,
    startedAt: s.startedAt, cancelling: s.cancel,
  };
}

export function cancelScan(accountId) {
  const s = scans.get(accountId);
  if (!s) return false;
  s.cancel = true;
  return true;
}

/**
 * Which folders a deep scan walks. See this file's header for why Gmail is
 * different: All Mail is the one place every message exists exactly once, and
 * Trash/Spam sit outside it while still costing quota.
 */
export function scanScope(account, folders) {
  if (!isLabelOverlapProne(account)) return folders.filter((f) => f.total !== 0);
  const keep = new Set(['\\All', '\\Trash', '\\Junk']);
  const byUse = folders.filter((f) => keep.has(f.specialUse));
  // A Gmail account whose server didn't report \All (localised label names
  // mean the path can't be pattern-matched reliably either) would otherwise
  // scan nothing at all — fall back to everything rather than silently
  // producing an empty report, and let dedup-by-email_id keep the totals
  // honest.
  return byUse.length ? byUse : folders.filter((f) => f.total !== 0);
}

// Chunked so a folder that lost thousands of messages can't build one
// enormous SQL statement.
const PRUNE_CHUNK = 400;

/** Drops indexed rows for `folder` that a just-completed FULL scan of it
 * didn't return — i.e. messages that no longer exist there. */
function pruneFolder(uKey, accountId, folder, seenUids) {
  const cached = db.prepare('SELECT uid FROM analytics_messages WHERE user_key=? AND account_id=? AND folder=?')
    .all(uKey, accountId, folder).map((r) => cache.uidKey(r.uid));
  const gone = cached.filter((u) => !seenUids.has(u));
  for (let i = 0; i < gone.length; i += PRUNE_CHUNK) {
    const chunk = gone.slice(i, i + PRUNE_CHUNK);
    db.prepare(`DELETE FROM analytics_messages WHERE user_key=? AND account_id=? AND folder=? AND uid IN (${chunk.map(() => '?').join(',')})`)
      .run(uKey, accountId, folder, ...chunk);
  }
  if (gone.length) alog.debug(`${folder}: dropped ${gone.length} row(s) no longer on the server`);
}

/**
 * Indexes an account. `full` re-reads every folder from scratch; otherwise
 * each folder resumes from its stored high-water mark. Must run inside the
 * account's ALS context (runAsAccount/runWithAccount), same as any other
 * mail-touching call.
 */
export async function scanAccount(uKey, account, { full = false } = {}) {
  if (scans.has(account.id)) throw new Error('A scan is already running for this account');
  const state = {
    folder: null, foldersDone: 0, foldersTotal: 0, scanned: 0,
    folderScanned: 0, folderTotal: 0, startedAt: Date.now(), cancel: false,
  };
  scans.set(account.id, state);
  const t0 = Date.now();
  try {
    const folders = await imap.listFolders();
    const scope = scanScope(account, folders);
    state.foldersTotal = scope.length;
    alog.debug(`${account.label}: scanning ${scope.length}/${folders.length} folders (${scope.map((f) => f.path).join(', ')})`);
    // NOTE: a full rescan deliberately does NOT wipe the table up front. It
    // used to, and stopping a rebuild then left you with nothing — a genuinely
    // bad trade when the rebuild is a multi-minute Gmail scan and Stop is right
    // there. Rows are upserted by primary key instead, and each folder drops
    // only its own now-missing rows once that folder has finished, so a cancel
    // costs at most the folder in progress.

    for (const f of scope) {
      if (state.cancel) break;
      state.folder = f.path;
      state.folderScanned = 0;
      state.folderTotal = f.total ?? 0;
      const prev = full ? null : db.prepare('SELECT max_uid FROM analytics_scan_state WHERE user_key=? AND account_id=? AND folder=?')
        .get(uKey, account.id, f.path);
      let maxUid = Number(prev?.max_uid) || 0;
      // Only tracked for a full pass, which is the only one that can conclude
      // anything about what's NO LONGER there (an incremental pass looks at
      // new UIDs only, so "not seen" means nothing to it).
      const seen = full ? new Set() : null;
      try {
        await imap.scanMessages(f.path, {
          sinceUid: maxUid,
          onBatch: async (rows, scanned, total) => {
            if (state.cancel) throw new Error('cancelled');
            if (seen) for (const r of rows) seen.add(cache.uidKey(r.uid));
            insertBatch(rows.map((r) => ({
              userKey: uKey, accountId: account.id, folder: f.path,
              uid: cache.uidKey(r.uid), emailId: r.emailId || null,
              fromAddr: r.fromAddr || '', fromName: r.fromName || '', subject: r.subject || '',
              date: r.date || 0, size: r.size || 0, seen: r.seen ? 1 : 0, bulk: r.bulk ? 1 : 0,
            })));
            for (const r of rows) {
              const n = Number(r.uid);
              if (Number.isFinite(n) && n > maxUid) maxUid = n;
            }
            state.folderScanned = scanned;
            state.folderTotal = total;
            state.scanned += rows.length;
          },
        });
        // This folder is fully re-read, so anything still indexed for it that
        // the server didn't return is gone (deleted elsewhere, moved, expunged)
        // — drop exactly those, and only now that the folder actually finished.
        if (seen) pruneFolder(uKey, account.id, f.path, seen);
        db.prepare(`INSERT INTO analytics_scan_state (user_key, account_id, folder, max_uid, scanned_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(user_key, account_id, folder) DO UPDATE SET max_uid=excluded.max_uid, scanned_at=excluded.scanned_at`)
          .run(uKey, account.id, f.path, maxUid, Date.now());
      } catch (e) {
        if (state.cancel) break;
        // One unreadable folder must not lose the whole scan — the rest of the
        // account is still worth indexing, and the summary reports what it has.
        alog.warn(`${account.label}/${f.path}: scan failed:`, e.message);
      }
      state.foldersDone += 1;
    }
    // Folders that dropped out of scope entirely (renamed, deleted, or Gmail's
    // scope narrowing to All Mail after an earlier per-label scan) would
    // otherwise keep contributing stale rows to every total forever. Only
    // after a COMPLETE full pass, where "not scanned" is trustworthy.
    if (full && !state.cancel) {
      const keep = new Set(scope.map((f) => f.path));
      for (const row of db.prepare('SELECT DISTINCT folder FROM analytics_messages WHERE user_key=? AND account_id=?').all(uKey, account.id)) {
        if (keep.has(row.folder)) continue;
        db.prepare('DELETE FROM analytics_messages WHERE user_key=? AND account_id=? AND folder=?').run(uKey, account.id, row.folder);
        db.prepare('DELETE FROM analytics_scan_state WHERE user_key=? AND account_id=? AND folder=?').run(uKey, account.id, row.folder);
        alog.debug(`${account.label}/${row.folder}: dropped — no longer in scan scope`);
      }
    }
    alog.debug(`${account.label}: scan ${state.cancel ? 'cancelled' : 'done'} — ${state.scanned} messages (${Date.now() - t0}ms)`);
    return { scanned: state.scanned, cancelled: state.cancel };
  } finally {
    scans.delete(account.id);
  }
}

/* ---------------------------------------------------------------------------
 * Aggregates
 *
 * Every total goes through this subquery rather than reading the table
 * directly: one row per DISTINCT physical message (the server's unique id when
 * it has one, else folder+uid), so a Gmail message carrying five labels counts
 * once, with one size, no matter how the scan scope changes later.
 * ------------------------------------------------------------------------- */
const DEDUPED = `
  SELECT COALESCE(email_id, folder || char(0) || uid) AS k,
         MAX(size) AS size, MIN(date) AS date, MIN(from_addr) AS from_addr,
         MIN(from_name) AS from_name, MIN(subject) AS subject,
         MAX(bulk) AS bulk, MIN(seen) AS seen, MIN(folder) AS folder
    FROM analytics_messages WHERE user_key=? AND account_id=? GROUP BY k`;

/**
 * Sortable columns, per table. A whitelist, not a passthrough: these names go
 * straight into an ORDER BY, so nothing a client sends can reach the SQL —
 * an unknown key falls back to the table's default rather than erroring, since
 * a stale page asking for a column that no longer exists should still render.
 * Every clause ends with a stable tiebreak, or rows with equal values would
 * shuffle between pages of the same sort.
 */
const SENDER_SORTS = {
  sender: 'from_addr', messages: 'messages', bytes: 'bytes', bulk: 'bulk', latest: 'lastDate',
};
const MESSAGE_SORTS = {
  size: 'size', date: 'date', sender: 'from_addr', subject: 'subject', folder: 'folder', bulk: 'bulk',
};
function orderBy(sorts, key, dir, fallback, tiebreak) {
  const col = sorts[key] || sorts[fallback];
  return `${col} ${dir === 'asc' ? 'ASC' : 'DESC'}, ${tiebreak}`;
}

/**
 * Everything the overview needs, in TWO passes over the index rather than five.
 *
 * It used to run one grouped scan over the deduped set for the totals, another
 * for by-year, another for the bulk subtotal and another for unread — four full
 * GROUP BY passes over every message in the account, which is 1.9s on a
 * ~150k-message mailbox. All four answers come from the same deduped rows, so
 * grouping by year ONCE and folding the per-year numbers together in JS gives
 * the totals, the bulk subtotal and the unread count for free.
 *
 * The per-folder table is deliberately NOT deduped (a folder listing should say
 * what is in that folder) so it stays its own cheap pass over the raw table.
 */
export function summary(uKey, accountId) {
  const years = db.prepare(`
    SELECT CAST(strftime('%Y', date/1000, 'unixepoch') AS INTEGER) AS year,
           COUNT(*) AS messages, COALESCE(SUM(size),0) AS bytes,
           SUM(CASE WHEN bulk=1 THEN 1 ELSE 0 END) AS bulkMessages,
           COALESCE(SUM(CASE WHEN bulk=1 THEN size ELSE 0 END),0) AS bulkBytes,
           SUM(CASE WHEN seen=0 THEN 1 ELSE 0 END) AS unread
      FROM (${DEDUPED}) GROUP BY year ORDER BY year DESC`).all(uKey, accountId);

  const totals = { messages: 0, bytes: 0 };
  const bulk = { messages: 0, bytes: 0 };
  let unread = 0;
  for (const y of years) {
    totals.messages += y.messages;
    totals.bytes += y.bytes;
    bulk.messages += y.bulkMessages;
    bulk.bytes += y.bulkBytes;
    unread += y.unread;
  }
  // Messages with no usable date at all group under a null year. They count
  // towards every total above (they are real messages), but there is nothing to
  // show them against on a by-year chart.
  const byYear = years.filter((y) => y.year)
    .map(({ year, messages, bytes }) => ({ year, messages, bytes }));

  const perFolder = db.prepare(`
    SELECT folder, COUNT(*) AS messages, COALESCE(SUM(size),0) AS bytes, SUM(CASE WHEN seen=0 THEN 1 ELSE 0 END) AS unread
      FROM analytics_messages WHERE user_key=? AND account_id=?
     GROUP BY folder ORDER BY bytes DESC`).all(uKey, accountId);
  const scannedAt = db.prepare('SELECT MAX(scanned_at) AS at FROM analytics_scan_state WHERE user_key=? AND account_id=?')
    .get(uKey, accountId)?.at || null;
  return { ...totals, perFolder, byYear, bulk, unread, scannedAt };
}

/** Who costs the most — by message count or by bytes, the caller's choice.
 * `bulk` counts how many of that sender's messages carry List-Unsubscribe,
 * which is what separates "a forum notifier" from "a person". */
export function topSenders(uKey, accountId, { sort = 'bytes', dir = 'desc', limit = 100, offset = 0 } = {}) {
  // Sorted in SQL rather than in the browser on purpose: LIMIT applies after
  // ORDER BY, so "the 200 worst offenders by bulk count" really is that, not
  // the 200 biggest re-shuffled by bulk.
  const order = orderBy(SENDER_SORTS, sort, dir, 'bytes', 'from_addr ASC');
  const rows = db.prepare(`
    SELECT from_addr, MIN(from_name) AS from_name, COUNT(*) AS messages,
           COALESCE(SUM(size),0) AS bytes, SUM(bulk) AS bulk, MAX(date) AS lastDate
      FROM (${DEDUPED}) WHERE from_addr <> ''
     GROUP BY from_addr ORDER BY ${order} LIMIT ? OFFSET ?`).all(uKey, accountId, limit, offset);
  const { total } = db.prepare(`
    SELECT COUNT(DISTINCT from_addr) AS total FROM analytics_messages
     WHERE user_key=? AND account_id=? AND from_addr <> ''`).get(uKey, accountId);
  return { rows, total };
}

/**
 * The heaviest messages, paged.
 *
 * ONE grouped query with bare `folder`/`uid` columns, rather than the deduped
 * subquery plus a location lookup per row that this used to do. That lookup was
 * O(rows x table): its `email_id = ? OR (email_id IS NULL AND folder ||
 * char(0) || uid = ?)` predicate is unindexable, so each of 300 rows
 * full-scanned the table — measured at 14,992ms for 300 rows over 120k
 * messages, versus 226ms for the grouped query itself. And because
 * better-sqlite3 is synchronous, those 15 seconds blocked the whole process:
 * IMAP calls, the sync cycle and both IDLE watchers stalled along with it (seen
 * in the wild as a 24.7s listFolders and a 49s sync cycle in the same window).
 *
 * `folder`/`uid` are sound as bare columns here because exactly one min/max
 * aggregate is present: SQLite then takes bare columns from the row that
 * produced it, so they name the specific copy this row's size refers to — which
 * is exactly the copy a delete should target. `copies` says how many places the
 * message exists in, replacing the old full location list (of which the UI only
 * ever used the first element anyway).
 */
export function largest(uKey, accountId, { sort = 'size', dir = 'desc', limit = 200, offset = 0 } = {}) {
  const order = orderBy(MESSAGE_SORTS, sort, dir, 'size', 'k ASC');
  const rows = db.prepare(`
    SELECT COALESCE(email_id, folder || char(0) || uid) AS k,
           MAX(size) AS size, folder, uid, date, from_addr, from_name, subject, bulk, seen,
           COUNT(*) AS copies
      FROM analytics_messages
     WHERE user_key=? AND account_id=? AND size > 0
     GROUP BY k ORDER BY ${order} LIMIT ? OFFSET ?`).all(uKey, accountId, limit, offset);
  const { total } = db.prepare(`
    SELECT COUNT(*) AS total FROM (
      SELECT 1 FROM analytics_messages WHERE user_key=? AND account_id=? AND size > 0
       GROUP BY COALESCE(email_id, folder || char(0) || uid))`).get(uKey, accountId);
  return { rows, total };
}

/* ---------------------------------------------------------------------------
 * Filtered query — the "+must include / -must not include" search
 * ------------------------------------------------------------------------- */

/**
 * Parses a query string into include/exclude terms. `+word` and a bare `word`
 * must appear; `-word` must not. Quotes group a phrase ("order successful"),
 * which is the difference between deleting AliExpress adverts and deleting
 * your receipts. Terms match subject, sender address or sender display name —
 * that's what makes `+aliexpress` work regardless of which of those carries
 * the brand.
 */
export function parseTerms(q) {
  const include = [];
  const exclude = [];
  const re = /([+-]?)(?:"([^"]*)"|(\S+))/g;
  let m;
  while ((m = re.exec(q || '')) !== null) {
    const term = (m[2] ?? m[3] ?? '').trim().toLowerCase();
    if (!term) continue;
    (m[1] === '-' ? exclude : include).push(term);
  }
  return { include, exclude };
}

function buildWhere(uKey, accountId, filter = {}) {
  const { include, exclude } = parseTerms(filter.q || '');
  const where = ['user_key=?', 'account_id=?'];
  const params = [uKey, accountId];
  const anyField = '(LOWER(subject) LIKE ? OR from_addr LIKE ? OR LOWER(from_name) LIKE ?)';
  for (const t of include) { where.push(anyField); params.push(`%${t}%`, `%${t}%`, `%${t}%`); }
  for (const t of exclude) { where.push(`NOT ${anyField}`); params.push(`%${t}%`, `%${t}%`, `%${t}%`); }
  if (filter.from) { where.push('from_addr = ?'); params.push(String(filter.from).toLowerCase()); }
  if (filter.folder) { where.push('folder = ?'); params.push(filter.folder); }
  if (filter.minSize) { where.push('size >= ?'); params.push(Number(filter.minSize)); }
  if (filter.olderThanDays) { where.push('date > 0 AND date < ?'); params.push(Date.now() - Number(filter.olderThanDays) * 86400e3); }
  if (filter.unreadOnly) where.push('seen = 0');
  if (filter.bulkOnly) where.push('bulk = 1');
  return { sql: where.join(' AND '), params };
}

/** Rows for the table, plus the totals for the WHOLE match set (not just the
 * page) — a mass delete is decided on those totals, so they must not be a
 * count of what happens to be visible. */
export function query(uKey, accountId, filter = {}, { limit = 500, offset = 0, sort = 'size', dir = 'desc' } = {}) {
  const { sql, params } = buildWhere(uKey, accountId, filter);
  const order = orderBy(MESSAGE_SORTS, sort, dir, 'size', 'folder ASC, uid ASC');
  const rows = db.prepare(`
    SELECT folder, uid, email_id, from_addr, from_name, subject, date, size, seen, bulk
      FROM analytics_messages WHERE ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  const totals = db.prepare(`
    SELECT COUNT(*) AS messages, COALESCE(SUM(size),0) AS bytes
      FROM analytics_messages WHERE ${sql}`).get(...params);
  return { rows, ...totals };
}

/* ---------------------------------------------------------------------------
 * Deleting
 * ------------------------------------------------------------------------- */

// One mail-server call per this many messages. Large enough to keep a
// thousand-message cleanup to a handful of round trips, small enough that a
// mid-run failure has only just started and that a UID set stays well inside
// any server's command-length limits.
const DELETE_CHUNK = 200;

/**
 * Deletes either an explicit list of {folder, uid} or everything matching a
 * filter, honouring the account's own deleteBehavior (Trash by default — see
 * imapClient.js#deleteMessages), and mirrors the removal into BOTH indexes so
 * the normal mail UI and this page agree immediately.
 *
 * `dryRun` returns exactly what would happen and touches nothing. The
 * filter path deliberately RE-RESOLVES the match set here rather than
 * trusting a list the browser built: the same query the user reviewed is what
 * gets deleted, and a client that fell behind (a stale page, an edited filter)
 * can't turn "delete 40 adverts" into "delete something else". That's also why
 * the caller should show the dryRun totals first.
 */
export async function deleteMatching(uKey, account, { filter, selection, dryRun = false } = {}) {
  let targets;
  if (Array.isArray(selection) && selection.length) {
    targets = selection.map((s) => ({ folder: String(s.folder), uid: cache.uidKey(s.uid) }));
  } else if (filter) {
    const { sql, params } = buildWhere(uKey, account.id, filter);
    targets = db.prepare(`SELECT folder, uid FROM analytics_messages WHERE ${sql}`).all(...params);
  } else {
    throw new Error('Nothing selected');
  }

  const byFolder = new Map();
  for (const t of targets) {
    if (!byFolder.has(t.folder)) byFolder.set(t.folder, []);
    byFolder.get(t.folder).push(t.uid);
  }
  const sizeOf = db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM analytics_messages WHERE user_key=? AND account_id=? AND folder=? AND uid=?');
  let bytes = 0;
  for (const [folder, uids] of byFolder) {
    for (const uid of uids) bytes += sizeOf.get(uKey, account.id, folder, uid).bytes;
  }
  const plan = { messages: targets.length, bytes, folders: [...byFolder].map(([folder, uids]) => ({ folder, messages: uids.length })) };
  if (dryRun) return { dryRun: true, ...plan };

  let deleted = 0;
  let action = null;
  for (const [folder, uids] of byFolder) {
    for (let i = 0; i < uids.length; i += DELETE_CHUNK) {
      const chunk = uids.slice(i, i + DELETE_CHUNK);
      // uidOut, because the mail layer wants ids in the shape it handed out
      // (numbers for IMAP), not this table's TEXT storage form.
      const result = await imap.deleteMessages(folder, chunk.map((u) => cache.uidOut(u)));
      action = result?.action || action;
      // Mirror into the normal message cache exactly as the ordinary delete
      // route does, so open mail views don't keep showing what's now gone.
      if (result?.action === 'flagged') cache.applyFlags(uKey, account.id, folder, chunk.map((u) => cache.uidOut(u)), { add: ['\\Deleted'] });
      else cache.adjustFolderCounts(uKey, account.id, folder, cache.removeMessages(uKey, account.id, folder, chunk.map((u) => cache.uidOut(u))));
      // ...and out of this index. A 'flagged' delete leaves the message in
      // place on the server, so it stays indexed — it genuinely still occupies
      // space, which is the whole point of this page.
      if (result?.action !== 'flagged') {
        const del = db.prepare(`DELETE FROM analytics_messages WHERE user_key=? AND account_id=? AND folder=? AND uid IN (${chunk.map(() => '?').join(',')})`);
        del.run(uKey, account.id, folder, ...chunk);
      }
      deleted += chunk.length;
    }
  }
  alog.debug(`${account.label}: deleted ${deleted} message(s), ${Math.round(bytes / 1024)}KB (${action})`);
  return { ...plan, deleted, action };
}

/** Forgets an account's index — used when an account is removed, and offered
 * in the UI as "start over" for a scan that indexed the wrong scope. */
export function clear(uKey, accountId) {
  db.prepare('DELETE FROM analytics_messages WHERE user_key=? AND account_id=?').run(uKey, accountId);
  db.prepare('DELETE FROM analytics_scan_state WHERE user_key=? AND account_id=?').run(uKey, accountId);
}
