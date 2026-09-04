// Hmelj — the background poll that keeps calendars current.
//
// Same shape as server/contactSyncRunner.js, and small for the same reason: a
// poll that finds nothing costs one request per calendar (a CTag, or a windowed
// query that comes back with what we already have). Chained setTimeout rather
// than setInterval, per-source backoff, and an in-flight guard shared with the
// interactive "Sync now" — all three for the reasons server/sync.js gives.
//
// ── The rolling window ───────────────────────────────────────────────────────
// Graph and EWS are only known over a window, because that is how they expand
// their own recurrence (see server/calendar/graphCalendar.js). The window moves
// with `now`, so an instance left running for a year keeps a year ahead of
// itself without anybody re-syncing anything. CalDAV and Google are unaffected:
// they store rules rather than occurrences and are known for all time.
//
// The window is generous on purpose. Somebody looking at next spring should not
// have to wait for a fetch, and the cost of a wider one is a slightly larger
// response every five minutes — not a larger number of requests.
import { config } from './config.js';
import { listUsers, userKey, runAsUser } from './session.js';
import * as store from './calendarStore.js';
import * as calendar from './calendar/index.js';
import * as events from './events.js';
import * as userLog from './userLog.js';
import { log } from './log.js';

const rlog = log.scope('calendar-run');

const BACKOFF_MS = [60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3, 3 * 3600e3, 6 * 3600e3];

const inFlight = new Set();
const backoff = new Map();

let timer = null;
let started = false;

/** The rolling window, relative to now. */
export function currentWindow(now = Date.now()) {
  return {
    from: now - config.calendarWindowPastDays * 86400000,
    to: now + config.calendarWindowFutureDays * 86400000,
  };
}

function shouldSkip(id) {
  const b = backoff.get(id);
  return !!b && b.nextAttemptAt > Date.now();
}

function recordFailure(id, message) {
  const b = backoff.get(id) || { failures: 0, nextAttemptAt: 0 };
  b.failures++;
  const wait = BACKOFF_MS[Math.min(b.failures - 1, BACKOFF_MS.length - 1)];
  b.nextAttemptAt = Date.now() + wait;
  backoff.set(id, b);
  rlog.warn(`${id}: ${message} — next attempt in ${Math.round(wait / 60000)} min`);
}

/**
 * One source, brought up to date.
 *
 * Exported so the interactive "Sync now" goes through exactly this path,
 * in-flight guard included: a double-click and a timer tick must not both be
 * writing the same calendar's rows.
 */
export async function syncSourceNow(uKey, sourceId, { force = false, interactive = false, window } = {}) {
  if (inFlight.has(sourceId)) return { busy: true, calendars: [] };
  inFlight.add(sourceId);
  try {
    const result = await calendar.syncSourceFor(uKey, sourceId, { force, interactive, window: window || currentWindow() });
    const failed = result.calendars.find((c) => c.error);
    if (failed) {
      recordFailure(sourceId, failed.error);
      // Without this, revoked credentials are visible only in the server's own
      // log — and the symptom, a calendar that quietly stops updating, gives no
      // hint to go looking there.
      userLog.record(uKey, {
        level: 'warn', category: 'calendar',
        message: `Calendar sync failed for ${failed.displayName || 'a calendar'}`,
        detail: failed.error,
      });
    } else backoff.delete(sourceId);

    if (result.calendars.some((c) => c.added || c.removed)) {
      // Same coarse signal the mail layer uses: other tabs re-read rather than
      // waiting for their own next poll.
      events.broadcastSettings(uKey);
    }
    return result;
  } catch (e) {
    recordFailure(sourceId, e.message);
    if (interactive) throw e;
    return { error: e.message, calendars: [] };
  } finally {
    inFlight.delete(sourceId);
  }
}

async function tick() {
  const window = currentWindow();
  for (const user of listUsers()) {
    if (user.disabled) continue;
    const uKey = userKey(user.username);
    let list;
    try { list = store.rawSourcesFor(uKey); } catch { continue; }
    for (const src of list) {
      if (src.enabled === false) continue;
      if (!(src.calendars || []).some((c) => c.enabled)) continue;
      if (shouldSkip(src.id)) continue;
      await runAsUser(user, () => syncSourceNow(uKey, src.id, { window })).catch((e) => {
        rlog.debug(`${uKey}/${src.id}: ${e.message}`);
      });
    }
  }
}

function loop() {
  timer = setTimeout(async () => {
    try { await tick(); } catch (e) { rlog.warn('Calendar sync tick failed:', e.message); }
    if (started) loop();
  }, config.calendarSyncIntervalMs);
  // Never the reason the process stays alive — the HTTP server already is.
  timer.unref?.();
}

export function start() {
  if (started) return;
  started = true;
  rlog.info(`Calendar sync polling every ${Math.round(config.calendarSyncIntervalMs / 1000)}s`
    + ` over ${config.calendarWindowPastDays}d back / ${config.calendarWindowFutureDays}d ahead`);
  loop();
}

export function stop() {
  started = false;
  clearTimeout(timer);
  timer = null;
}

/** For the tests, and for a Settings save that has just fixed a source and
 *  should not have to wait out the backoff its broken credentials earned. */
export function clearBackoff(sourceId) {
  if (sourceId) backoff.delete(sourceId);
  else backoff.clear();
}
