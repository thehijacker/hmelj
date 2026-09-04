// Hmelj — notification scheduler: evaluates whether an account/folder should be
// notified RIGHT NOW, per the per-account/per-folder schedule config added to
// server/accounts.js (notificationSchedule, folderNotificationSchedules) and the
// Slovenian holiday calendar in server/holidays.js. Consumed by server/sync.js (gates
// actual push delivery) and server/index.js (gates what the unified "All inbox" view
// shows, via mutedFolderPairsFor → server/cache.js's queryUnified).
//
// Also holds the temporary per-folder Mute (account.folderMutes — see folderMutedUntil
// below), which layers on top of whatever schedule applies rather than replacing it.
//
// Grid polarity (confirmed with the user, not guessed): the day/time grid defines the
// NOTIFY window. A day left inactive, or a time outside its from–to range, is muted.
// mode:'always'/'never' bypass the grid entirely for the simple whole-account
// enable/disable case.
//
// No timezone concept exists anywhere in Hmelj — every time comparison here uses the
// server process's own local wall-clock time (plain Date, no TZ conversion). Documented
// in the Scheduler UI's copy, not silently assumed away.
import * as cache from './cache.js';
import { resolveHolidaysForYear } from './holidays.js';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // matches Date#getDay()'s 0–6 index order

/** Joins an accountId/folderPath into one of mutedFolderPairsFor()'s Set keys. Exported
 *  so every caller that needs to test membership (server/index.js's unifiedLive) builds
 *  the exact same key instead of each re-typing the join logic separately. U+0000, not a
 *  plain space or slash — folder paths routinely contain both of those themselves, a
 *  null character does not. */
const PAIR_SEP = String.fromCharCode(0); // U+0000, built at runtime
export function pairKey(accountId, folderPath) {
  return accountId + PAIR_SEP + folderPath;
}

/** Temporary "Mute" — the folder context menu's Mute item (public/js/app.js's
 *  showFolderMenu). Stored as account.folderMutes: { [folderPath]: epochMs } — the
 *  instant the silence ENDS, absolute (epoch ms, so it means the same thing on the
 *  server, in the browser and on a phone regardless of anyone's timezone, unlike the
 *  wall-clock grid above).
 *
 *  Deliberately NOT a folderNotificationSchedules entry: a folder override REPLACES the
 *  account schedule (see resolveEffectiveSchedule), so writing one would silently
 *  destroy whatever override that folder already had, and expiry would then have to
 *  restore it. This is a separate layer that sits ON TOP of whatever schedule applies —
 *  muted while it lasts, and when it lapses the folder simply goes back to following its
 *  schedule, with nothing to undo.
 *
 *  Returns the end instant (truthy) while the mute is live, 0 once it has lapsed — an
 *  expired entry is simply ignored, never an error, so nothing has to sweep the map on a
 *  timer (accounts.js#setFolderMute prunes lapsed entries on the next write). */
export function folderMutedUntil(account, folderPath, nowMs = Date.now()) {
  const until = account?.folderMutes?.[folderPath];
  return typeof until === 'number' && until > nowMs ? until : 0;
}

/** Does this account have ANY folder muted by the temporary Mute right now? */
function hasLiveFolderMute(account, nowMs = Date.now()) {
  const mutes = account?.folderMutes;
  if (!mutes) return false;
  for (const until of Object.values(mutes)) if (until > nowMs) return true;
  return false;
}

function ymdLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function hhmmLocal(date) {
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

/** Whether `now` (as 'HH:MM') falls within [from, to). Handles a range that spans
 *  midnight (from > to, e.g. '22:00'–'06:00') by treating it as "on either side" of the
 *  wraparound. A degenerate from===to is treated as a zero-width (never active) window
 *  rather than misreading it as "all day," which is what the wraparound formula alone
 *  would otherwise produce. */
function inNotifyRange(nowHHMM, from, to) {
  if (!from || !to) return false;
  if (from === to) return false;
  if (from < to) return nowHHMM >= from && nowHHMM < to;
  return nowHHMM >= from || nowHHMM < to;
}

/** The set of this-year's dates (YYYY-MM-DD) currently resolved as work-free: the
 *  built-in Slovenian calendar (server/holidays.js) with the user's per-date overrides
 *  applied (only entries that differ from the default are ever stored — see store.js's
 *  getHolidayOverrides()), PLUS the user's own custom holidays (store.js's
 *  getCustomHolidays() — a custom entry's own `workFree` field is authoritative, no
 *  separate override layer for those, see holidays.js#resolveHolidaysForYear). */
export function workFreeDateSetFor(year, holidayOverrides = {}, customHolidays = []) {
  const set = new Set();
  for (const h of resolveHolidaysForYear(year, customHolidays)) {
    const workFree = h.custom ? h.workFreeDefault : (holidayOverrides[h.date] ?? h.workFreeDefault);
    if (workFree) set.add(h.date);
  }
  return set;
}

/** Given an effective schedule (already resolved — see resolveEffectiveSchedule below),
 *  is notification delivery muted right now? `workFreeDateSet` is required only when
 *  `skipHolidays` might apply — callers that know it can't (mode !== 'scheduled') may
 *  omit it. */
export function isMutedNow(effectiveSchedule, { now = new Date(), workFreeDateSet } = {}) {
  if (!effectiveSchedule || effectiveSchedule.mode === 'always') return false;
  if (effectiveSchedule.mode === 'never') return true;
  // mode === 'scheduled'
  if (effectiveSchedule.skipHolidays && workFreeDateSet?.has(ymdLocal(now))) return true;
  const dayCfg = effectiveSchedule.days?.[DAY_KEYS[now.getDay()]];
  if (!dayCfg?.active) return true; // day not in the notify set → muted
  return !inNotifyRange(hhmmLocal(now), dayCfg.from, dayCfg.to); // outside today's notify window → muted
}

/** A folder's own schedule override, if one was configured for it, else falls back to
 *  the account-level schedule, else undefined (no schedule configured at all — the
 *  fully-backward-compatible "always notify, exactly like before this feature existed"
 *  default). NOT a merge — a folder override REPLACES the account-level schedule for
 *  that folder, it doesn't combine with it. */
export function resolveEffectiveSchedule(account, folderPath) {
  return account.folderNotificationSchedules?.[folderPath] ?? account.notificationSchedule ?? undefined;
}

/** Could ANYTHING silence this account right now — a configured schedule, or a live
 *  temporary folder Mute? The overwhelming common case is "no" — and then nothing it
 *  owns can be muted, so every caller can skip the whole per-folder evaluation
 *  (including the holiday-set computation) outright. */
export function hasAnySchedule(account) {
  return !!(account?.notificationSchedule
    || (account?.folderNotificationSchedules && Object.keys(account.folderNotificationSchedules).length)
    || hasLiveFolderMute(account));
}

/** Is notification delivery for one specific (account, folder) muted right now?
 *  The resolve + evaluate pair every caller outside this file was writing by hand.
 *  `workFreeDateSet` only matters for a schedule with skipHolidays — see isMutedNow. */
export function isFolderMutedNow(account, folderPath, { now = new Date(), workFreeDateSet } = {}) {
  if (!hasAnySchedule(account)) return false;
  if (folderMutedUntil(account, folderPath, now.getTime())) return true; // temporary Mute wins over any schedule, for as long as it lasts
  return isMutedNow(resolveEffectiveSchedule(account, folderPath), { now, workFreeDateSet });
}

/** Which (account, folder) pairs are muted RIGHT NOW across a list of accounts —
 *  powers the unified "All inbox" list's "Hide muted" filter only (server/cache.js's
 *  queryUnified and server/index.js's unifiedLive, both handed the resulting Set by the
 *  route handler that computes it once). NOT used by notification gating —
 *  server/sync.js calls resolveEffectiveSchedule() directly per message, without going
 *  through this folder-enumeration step at all, so the caveat below doesn't affect
 *  whether a push actually gets sent, only what the "Hide muted" toggle can see.
 *
 *  Enumerates each account's already-cached folder list (cache.getFolders(userKey, ...) —
 *  SQLite read, no IMAP call). This takes ONE userKey for the whole accountList, which
 *  only holds within one owner's cache namespace — a SHARED-IN account's folder rows
 *  live under its OWNER's userKey, not the viewer's. Callers spanning multiple real
 *  owner keys (a mix of the viewer's own accounts and shared-in accounts from
 *  different owners — the unified "All inbox" view) must call this once per
 *  owner-key group and union the resulting Sets, not pass one uniform userKey for a
 *  mixed accountList — see server/index.js's mutedPairsForGroups, which does exactly
 *  that.
 *
 *  Fast-paths accounts that never touched the scheduler at all (the overwhelming common
 *  case — no notificationSchedule and no folderNotificationSchedules entries) to zero
 *  extra cost beyond the initial filter. Keys join accountId/folderPath with U+0000 (not
 *  a plain space or slash) — folder paths routinely contain spaces and slashes
 *  themselves, a null character does not. */
export function mutedFolderPairsFor(userKey, accountList, { now = new Date(), holidayOverrides = {}, customHolidays = [] } = {}) {
  const pairs = new Set();
  const relevant = accountList.filter(hasAnySchedule);
  if (!relevant.length) return pairs;
  const workFreeDateSet = workFreeDateSetFor(now.getFullYear(), holidayOverrides, customHolidays);
  for (const account of relevant) {
    const folders = cache.getFolders(userKey, account.id);
    for (const f of folders) {
      const effective = resolveEffectiveSchedule(account, f.path);
      const muted = folderMutedUntil(account, f.path, now.getTime())
        || (effective && isMutedNow(effective, { now, workFreeDateSet }));
      if (muted) pairs.add(pairKey(account.id, f.path));
    }
  }
  return pairs;
}
