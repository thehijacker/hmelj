// Hmelj — client-side mirror of server/schedule.js's pure evaluation logic
// (isMutedNow, resolveEffectiveSchedule). Can't share a module across the Node/browser
// boundary in this codebase (no bundler, no shared-import mechanism, every file here is
// a plain global <script> tag) — kept small and deliberately parallel in structure
// (same function names, same argument shapes) to server/schedule.js so a change to one
// is easy to notice needs mirroring in the other.
//
// Used by app.js's checkNewMailNotifications() foreground-notification fallback gate,
// and by settings.js's Scheduler tab to preview a folder's effective mute state. NOT
// authoritative for actual push delivery — that's server/schedule.js's job, running
// server-side in server/sync.js — this is a best-effort client-side echo of the same
// rules, evaluated against the DEVICE's own local time (a second, independent
// timezone-consistency caveat on top of server/schedule.js's own — see that file's
// header comment).
//
// Grid polarity: the day/time grid defines the NOTIFY window (matches server/schedule.js
// exactly, confirmed with the user, not guessed) — a day left inactive, or a time outside
// its from–to range, is muted.
(function () {
  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // matches Date#getDay()'s 0–6 index order

  function ymdLocal(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function hhmmLocal(date) {
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }

  function inNotifyRange(nowHHMM, from, to) {
    if (!from || !to) return false;
    if (from === to) return false;
    if (from < to) return nowHHMM >= from && nowHHMM < to;
    return nowHHMM >= from || nowHHMM < to; // spans midnight
  }

  /** Same signature/behavior as server/schedule.js's isMutedNow. */
  function isMutedNow(effectiveSchedule, { now = new Date(), workFreeDateSet } = {}) {
    if (!effectiveSchedule || effectiveSchedule.mode === 'always') return false;
    if (effectiveSchedule.mode === 'never') return true;
    if (effectiveSchedule.skipHolidays && workFreeDateSet?.has(ymdLocal(now))) return true;
    const dayCfg = effectiveSchedule.days?.[DAY_KEYS[now.getDay()]];
    if (!dayCfg?.active) return true;
    return !inNotifyRange(hhmmLocal(now), dayCfg.from, dayCfg.to);
  }

  /** Same as server/schedule.js's folderMutedUntil — the temporary per-folder Mute
   * (sidebar folder right-click → Mute), stored as account.folderMutes[path] = the
   * epoch-ms instant the silence ends. Returns that instant while it's live, 0 once it
   * has lapsed, so a lapsed mute needs no cleanup anywhere. Absolute time, so this
   * device's clock and the server's agree on it regardless of timezone. */
  function folderMutedUntil(account, folderPath, nowMs = Date.now()) {
    const until = account?.folderMutes?.[folderPath];
    return typeof until === 'number' && until > nowMs ? until : 0;
  }

  /** Same as server/schedule.js's resolveEffectiveSchedule. */
  function resolveEffectiveSchedule(account, folderPath) {
    return account.folderNotificationSchedules?.[folderPath] ?? account.notificationSchedule ?? undefined;
  }

  // Lazy per-calendar-year holiday cache, fetched from GET /api/holidays (the
  // authoritative server-computed list — this file has no Easter-calculation logic of
  // its own, unlike server/holidays.js). Re-fetched automatically when the year changes
  // (e.g. a tab left open across New Year's). Not persisted across page loads — a fresh
  // fetch each boot is cheap and keeps this from silently going stale relative to a
  // holiday-override edit made in Settings.
  let cachedYear = null;
  let cachedSet = null;
  let pending = null;
  async function ensureHolidaysLoaded(now) {
    const year = (now || new Date()).getFullYear();
    if (cachedYear === year) return cachedSet;
    if (pending?.year === year) return pending.promise;
    const promise = (async () => {
      let list = [];
      try { list = await API.holidays(year); }
      catch { /* offline or logged out — treat as no known holidays this session rather than throw */ }
      const set = new Set(list.filter((h) => h.workFree).map((h) => h.date));
      cachedYear = year;
      cachedSet = set;
      return set;
    })();
    pending = { year, promise };
    return promise;
  }

  window.ScheduleUtil = { isMutedNow, resolveEffectiveSchedule, folderMutedUntil, ensureHolidaysLoaded };
})();
