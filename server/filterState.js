// Hmelj — how far the filters have got, per folder.
//
// ── The problem this replaces ─────────────────────────────────────────────
// sync.js used to decide "is this new enough to filter?" with a fixed
// two-day window on the message's arrival time. That number was doing two
// unrelated jobs at once, and could only be right for one of them:
//
//   - excluding OLD mail that merely looks new (a Gmail relabel resurfaces a
//     years-old message under a fresh uid), which wants a SHORT window;
//   - including mail that arrived while Hmelj was not running, which wants a
//     window as long as the outage.
//
// Two days is a reasonable guess at the first and a wrong answer to the second:
// an outage longer than two days — a holiday, a NAS that did not come back, a
// server moved between flats — left every message that arrived in it
// permanently unfiltered. Nothing ever went back for them.
//
// ── What replaces it ──────────────────────────────────────────────────────
// A per-folder mark: "filters have been applied to everything that arrived in
// this folder up to time T". The window is then T..now, whatever that turns out
// to be — five minutes on a healthy server, nine days after a holiday — and
// resurfaced old mail is still excluded, because its arrival time is far below
// T. One number, one job.
//
// ── Why DATA_DIR and not the cache ────────────────────────────────────────
// cache.sqlite is disposable by contract; delete it and every message looks new
// again. If the mark lived there it would be deleted with it, and the first
// sync afterwards would re-run filters over months of mail — moving and
// deleting things on the strength of a file that was explicitly disposable.
// Beside the settings it is safe: a wiped cache re-presents old mail as new,
// the mark says it was already filtered, and nothing happens.
//
// The mark is a promise not to re-filter. cache.js#claimFilterApplied is the
// backstop for when it is missing anyway, and neither is trusted alone.
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { log } from './log.js';

const flog = log.scope('filter-state');

/**
 * How far back a catch-up may ever reach, however old the mark is.
 *
 * A server that has been off for six months should file the last month of mail
 * and leave the rest alone: the rules have probably changed, the folders have
 * probably changed, and quietly moving half a year of mail on the strength of a
 * timestamp is not a thing anyone asked for. What it does not do is silently
 * skip them — see catchUpFrom's return, which says how much it declined to
 * reach back over so the caller can log it.
 */
export const MAX_CATCHUP_MS = 30 * 24 * 3600e3;

/**
 * The window used when there is NO mark yet — a fresh install, a new folder, or
 * an account that predates this file. Deliberately the old two-day number: with
 * no record of what has been filtered, the conservative answer is the one Hmelj
 * has always given, not a month of retroactive filing on first run.
 */
export const COLD_START_MS = 2 * 24 * 3600e3;

function fileFor(uKey) {
  const dir = path.join(config.dataDir, 'users', uKey);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'filter-state.json');
}

function load(uKey) {
  try { return JSON.parse(fs.readFileSync(fileFor(uKey), 'utf8')); } catch { return {}; }
}

function save(uKey, data) {
  const file = fileFor(uKey);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file); // atomic — a crash mid-write leaves the previous mark, never half of one
  } catch (e) {
    // Not fatal. A mark that cannot be written means the next run treats this
    // folder as cold, which filters a two-day window instead of the right one —
    // worse, but not wrong, and far better than failing the sync.
    flog.warn(`Could not record filter progress for ${uKey}:`, e.message);
  }
}

/** A folder path made safe as a JSON key. It already is one — any string is —
 *  but account and folder have to be combined without colliding, and a NUL
 *  separator is what cache.js uses for the same reason: a folder path may
 *  legally contain almost every other character. */
const keyFor = (accountId, folder) => `${accountId || ''}\u0000${folder}`;

/** When filters last covered this folder, or null if they never have. */
export function markFor(uKey, accountId, folder) {
  const v = load(uKey)[keyFor(accountId, folder)];
  return Number.isFinite(v) ? v : null;
}

/**
 * The arrival time to filter from, and why.
 *
 * Returns `{ from, cold, skippedMs }`:
 *   from      — filter messages that arrived at or after this;
 *   cold      — there was no mark, so this is the conservative first-run window;
 *   skippedMs — how far back the mark reached BEYOND the cap, i.e. how much
 *               history is deliberately not being filtered. Zero in normal
 *               operation; large after a long outage, and worth saying out loud
 *               rather than letting it look like everything was covered.
 */
export function catchUpFrom(uKey, accountId, folder, now = Date.now()) {
  const mark = markFor(uKey, accountId, folder);
  if (mark == null) return { from: now - COLD_START_MS, cold: true, skippedMs: 0 };
  const floor = now - MAX_CATCHUP_MS;
  if (mark < floor) return { from: floor, cold: false, skippedMs: floor - mark };
  return { from: mark, cold: false, skippedMs: 0 };
}

/**
 * Records that filters have now covered this folder up to `upTo`.
 *
 * Only ever moves FORWARD. A poll that happens to see nothing newer than the
 * last one must not drag the mark backwards — that would re-open a window
 * already closed and re-filter whatever was in it.
 */
export function advance(uKey, accountId, folder, upTo) {
  const at = Number(upTo);
  if (!Number.isFinite(at)) return;
  const data = load(uKey);
  const key = keyFor(accountId, folder);
  if (Number.isFinite(data[key]) && data[key] >= at) return; // never backwards
  data[key] = at;
  save(uKey, data);
}

/** Drops an account's marks — for an account being removed, so a folder path
 *  reused by a later account with the same id cannot inherit a stale promise. */
export function forgetAccount(uKey, accountId) {
  const data = load(uKey);
  const prefix = `${accountId || ''}\u0000`;
  let changed = false;
  for (const k of Object.keys(data)) {
    if (k.startsWith(prefix)) { delete data[k]; changed = true; }
  }
  if (changed) save(uKey, data);
}
