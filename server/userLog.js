// Hmelj — the user's own activity log (Settings → Log).
//
// Distinct from server/log.js, which writes to stdout for whoever runs the
// server. This is the other audience: the person whose mail it is, who has no
// terminal and until now had no way at all to find out that a filter action
// failed, that an account had been unreachable for two hours, or that a
// backgrounded send never actually went out. Those all happen away from any
// request — swallowed in a catch, or after the response was already sent — so
// there was nothing for the UI to show and nothing for the user to act on.
//
// Only things a user could plausibly do something about belong here. Debug
// noise, per-poll timings and internal state stay in server/log.js.
//
// Keeps its tables in cache.js's SQLite handle rather than opening a second one
// — the same arrangement server/analytics.js uses, and for the same reason
// (one connection per process).
import { db } from './cache.js';

export const LEVELS = ['error', 'warn', 'info'];

db.exec(`
CREATE TABLE IF NOT EXISTS user_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key TEXT NOT NULL,
  account_id TEXT,
  account_label TEXT,
  level TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  -- How many times this same thing has happened in the current run, and when
  -- it started. See the collapsing note on record() — without these, one
  -- unreachable host writes a row every two minutes forever and buries
  -- everything else worth reading.
  count INTEGER NOT NULL DEFAULT 1,
  first_at INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_log_user ON user_log (user_key, at DESC);
`);

// A repeat of the same problem within this window updates the existing row
// instead of adding another. Generous, because the things that repeat here
// repeat on a poll interval (~2 min) and a user looking at this list wants
// "IMAP host unreachable ×37, last seen 14:20", not 37 identical lines.
const COLLAPSE_MS = 6 * 3600e3;
// Per user. Old entries are worth very little — this is "what went wrong
// lately", not an audit trail — and an unbounded table on a self-hosted box
// nobody is watching is its own problem.
const MAX_ROWS = 500;
const PRUNE_EVERY_MS = 3600e3;
let lastPrune = 0;

const findRecent = db.prepare(`
  SELECT id, count FROM user_log
   WHERE user_key=? AND IFNULL(account_id,'')=? AND category=? AND message=? AND at > ?
   ORDER BY at DESC LIMIT 1
`);
const bumpRow = db.prepare('UPDATE user_log SET count=count+1, at=?, detail=? WHERE id=?');
const insertRow = db.prepare(`
  INSERT INTO user_log (user_key, account_id, account_label, level, category, message, detail, count, first_at, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
`);

function prune(userKey, now) {
  if (now - lastPrune < PRUNE_EVERY_MS) return;
  lastPrune = now;
  db.prepare(`
    DELETE FROM user_log WHERE user_key=? AND id NOT IN (
      SELECT id FROM user_log WHERE user_key=? ORDER BY at DESC LIMIT ?
    )
  `).run(userKey, userKey, MAX_ROWS);
}

/**
 * Records something the user should be able to see. Never throws: this is
 * always called from inside somebody else's error path, and a logging failure
 * that masked the original error would be worse than no log at all.
 *
 * @param {string} userKey whose log — passed explicitly rather than read from
 *   the ALS context, because the background poller records against the account
 *   OWNER's key while running under it, and a route may not have one at all.
 * @param {object} entry {level, category, message, detail, accountId, accountLabel}
 */
export function record(userKey, { level = 'error', category = 'general', message, detail = null, accountId = null, accountLabel = null } = {}) {
  if (!userKey || !message) return;
  try {
    const now = Date.now();
    const existing = findRecent.get(userKey, accountId || '', category, String(message), now - COLLAPSE_MS);
    if (existing) {
      bumpRow.run(now, detail == null ? null : String(detail), existing.id);
      return;
    }
    insertRow.run(
      userKey, accountId, accountLabel,
      LEVELS.includes(level) ? level : 'error',
      String(category), String(message),
      detail == null ? null : String(detail),
      now, now,
    );
    prune(userKey, now);
  } catch { /* the log must never be the thing that breaks a request */ }
}

/**
 * One page, newest first. Paginated server-side rather than handing the client
 * all 500 and letting it slice: the rows carry full error text and the phone is
 * the likeliest place this gets read.
 *
 * @returns {{total: number, page: number, pageSize: number, entries: object[]}}
 */
export function list(userKey, { limit = 25, offset = 0, level = null } = {}) {
  const pageSize = Math.min(Math.max(1, Number(limit) || 25), 100);
  const from = Math.max(0, Number(offset) || 0);
  const filtered = level && LEVELS.includes(level);
  const where = filtered ? 'user_key=? AND level=?' : 'user_key=?';
  const params = filtered ? [userKey, level] : [userKey];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM user_log WHERE ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM user_log WHERE ${where} ORDER BY at DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, from);
  const entries = rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    accountLabel: r.account_label,
    level: r.level,
    category: r.category,
    message: r.message,
    detail: r.detail,
    count: r.count,
    firstAt: r.first_at,
    at: r.at,
  }));
  return { total, page: Math.floor(from / pageSize) + 1, pageSize, entries };
}

/** How many entries, and how many of them are errors — for the tab's badge. */
export function summary(userKey) {
  const row = db.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN level='error' THEN 1 ELSE 0 END) AS errors FROM user_log WHERE user_key=?"
  ).get(userKey);
  return { total: row?.total || 0, errors: row?.errors || 0 };
}

export function clear(userKey) {
  const r = db.prepare('DELETE FROM user_log WHERE user_key=?').run(userKey);
  return { cleared: r.changes };
}
