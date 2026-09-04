// Hmelj — the background poll that makes contact sync "live".
//
// Modelled on server/sync.js, and deliberately much smaller, because contact
// sync is cheap in a way mail sync is not: a poll that finds nothing costs ONE
// request per book (the CTag, or a delta that comes back empty), no bodies, no
// connection to hold open. So there is no per-source scheduling, no IDLE, no
// adaptive interval — one chained timer walks every user's sources in turn.
//
// The three things it does copy from sync.js, because they are what keep a
// background loop from becoming a problem:
//
//   - a CHAINED setTimeout, never setInterval: the next run is scheduled once
//     the previous one has finished, so a slow server can never stack up runs;
//   - per-source failure BACKOFF, so a server that is down (or credentials that
//     have been revoked) is not hammered every five minutes forever;
//   - an in-flight guard, so an interactive "Sync now" and the timer cannot run
//     the same source twice at once and write the same book file from both.
//
// Runs independently of login sessions, for the same reason sync.js does:
// credentials are encrypted with a server-wide secret, not with anything tied to
// a login, so session.js#runAsUser can build a valid context for any user at any
// time — logged in or not.
import { config } from './config.js';
import { listUsers, userKey, runAsUser } from './session.js';
import * as sources from './contactSources.js';
import * as contactsSync from './contactsSync/index.js';
import * as events from './events.js';
import * as userLog from './userLog.js';
import { log } from './log.js';

const rlog = log.scope('contact-sync-run');

/** How long to wait after each consecutive failure. A server that is down and a
 *  password that has been changed look identical from here, and the second one
 *  is not going to fix itself — so the interval grows to hours rather than
 *  retrying every five minutes until somebody notices the log. */
const BACKOFF_MS = [60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3, 3 * 3600e3, 6 * 3600e3];

const inFlight = new Set();               // sourceId
const backoff = new Map();                // sourceId -> { failures, nextAttemptAt }

let timer = null;
let started = false;

function shouldSkip(sourceId) {
  const b = backoff.get(sourceId);
  return !!b && b.nextAttemptAt > Date.now();
}

function recordFailure(sourceId, message) {
  const b = backoff.get(sourceId) || { failures: 0, nextAttemptAt: 0 };
  b.failures++;
  const wait = BACKOFF_MS[Math.min(b.failures - 1, BACKOFF_MS.length - 1)];
  b.nextAttemptAt = Date.now() + wait;
  backoff.set(sourceId, b);
  rlog.warn(`${sourceId}: ${message} — next attempt in ${Math.round(wait / 60000)} min`);
}

function recordSuccess(sourceId) {
  backoff.delete(sourceId);
}

/**
 * One source, brought up to date.
 *
 * Exported so the interactive "Sync now" button goes through exactly this path,
 * in-flight guard included. Two code paths that both write the same book file
 * is precisely the kind of thing that works in testing and corrupts an address
 * book under a double-click.
 */
export async function syncSourceNow(uKey, sourceId, { force = false, interactive = false } = {}) {
  if (inFlight.has(sourceId)) {
    return { busy: true, books: [] };
  }
  inFlight.add(sourceId);
  try {
    const result = await contactsSync.syncSourceFor(uKey, sourceId, { force });
    const changed = result.books.some((b) => b.added || b.updated || b.removed);
    const failed = result.books.find((b) => b.error);
    if (failed) {
      recordFailure(sourceId, failed.error);
      // The log is where a user finds out that sync stopped working. Without
      // this, revoked credentials are visible only in the server's own log,
      // which a self-hoster reads roughly never — and the symptom (an address
      // book that quietly stops updating) gives no hint to go looking.
      userLog.record(uKey, {
        level: 'warn', category: 'contacts',
        message: `Contact sync failed for ${failed.displayName || 'a book'}`,
        detail: failed.error,
      });
    } else recordSuccess(sourceId);

    if (changed) {
      // Same signal the mail layer uses: every other open tab and device
      // re-reads rather than waiting for its own next poll. Coarse on purpose —
      // see server/events.js's header.
      events.broadcastSettings(uKey);
      const totals = result.books.reduce((a, b) => ({
        added: a.added + (b.added || 0), updated: a.updated + (b.updated || 0), removed: a.removed + (b.removed || 0),
      }), { added: 0, updated: 0, removed: 0 });
      // Visible in Settings → Log, where somebody looking for "why did that
      // contact change" can actually find it.
      userLog.record(uKey, {
        level: 'info', category: 'contacts',
        message: `Contact sync: ${totals.added} added, ${totals.updated} updated, ${totals.removed} removed`,
      });
    }
    return result;
  } catch (e) {
    recordFailure(sourceId, e.message);
    if (interactive) throw e;
    return { error: e.message, books: [] };
  } finally {
    inFlight.delete(sourceId);
  }
}

/** Every user's every enabled source, once. Failures are per source: one
 *  unreachable server must not stop the others from syncing. */
async function tick() {
  for (const user of listUsers()) {
    if (user.disabled) continue;
    const uKey = userKey(user.username);
    let list;
    try { list = sources.rawSourcesFor(uKey); } catch { continue; }
    for (const src of list) {
      if (src.enabled === false) continue;
      if (!(src.books || []).some((b) => b.enabled)) continue;
      if (shouldSkip(src.id)) continue;
      // runAsUser so anything downstream that reads the ambient user (the
      // account lookup for a provider-backed source, store.js's per-user files)
      // resolves to this one — the same wrapper sync.js's poll loop uses.
      await runAsUser(user, () => syncSourceNow(uKey, src.id)).catch((e) => {
        rlog.debug(`${uKey}/${src.id}: ${e.message}`);
      });
    }
  }
}

function loop() {
  timer = setTimeout(async () => {
    try { await tick(); } catch (e) { rlog.warn('Contact sync tick failed:', e.message); }
    if (started) loop();
  }, config.contactSyncIntervalMs);
  // Never the reason the process stays alive: the mail poller and the HTTP
  // server already are, and a timer that holds the loop open turns a clean
  // shutdown into a five-minute wait.
  timer.unref?.();
}

export function start() {
  if (started) return;
  started = true;
  rlog.info(`Contact sync polling every ${Math.round(config.contactSyncIntervalMs / 1000)}s`);
  loop();
}

export function stop() {
  started = false;
  clearTimeout(timer);
  timer = null;
}

/** For the tests, and for a Settings save that has just disabled a source and
 *  should not have to wait out its backoff to try again. */
export function clearBackoff(sourceId) {
  if (sourceId) backoff.delete(sourceId);
  else backoff.clear();
}
