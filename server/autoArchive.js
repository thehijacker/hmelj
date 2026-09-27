// Hmelj — "keep the last N days in the Inbox", run once a day per account.
//
// The setting is one number on the account (accounts.js#autoArchiveDays, next
// to archiveFolder, 0 = off). Everything it means is here; the sweep itself is
// shared with the manual "Archive before…" action (server/archive.js).
//
// ── Shape, and why it is this one ───────────────────────────────────────────
// A slow interval that asks "is anything due?", not a timer per account. The
// same reasoning as server/snooze.js: one timer the process owns is something
// a restart can rebuild from disk in full, where a timer per account is state
// that has to be reconciled against a changing account list on every edit.
//
// It sweeps at most once per account per day, and the last sweep is recorded
// ON DISK (store.js#getAutoArchiveRunsFor). That is the important part: a
// sweep is dozens of folder moves against somebody's live mailbox, and a
// server that restarts every few minutes — a bad config, a crash loop — would
// otherwise re-run them every time it came up.
//
// ── Why it does not just hook into the sync loop ────────────────────────────
// It could: sync.js already walks every user and account on a timer. But a
// sync tick is what keeps mail current, it runs every two to five minutes, and
// nothing that moves thousands of messages belongs inside the thing a reader
// is waiting on. Separate loop, its own cadence, its own failure handling —
// and an account whose archive sweep fails still syncs.
import { listUsers, userKey, runAsAccount, runAsUser } from './session.js';
import * as accountsStore from './accounts.js';
import { store } from './store.js';
import * as archive from './archive.js';
import * as cache from './cache.js';
import * as sync from './sync.js';
import { config } from './config.js';
import * as userLog from './userLog.js';
import { log } from './log.js';

const alog = log.scope('auto-archive');

// Hourly. The work is daily, so this is only "how soon after midnight, or
// after a restart, does a due account get picked up" — and an hour of latency
// on a job about mail three months old is not latency anybody can perceive.
const TICK_MS = 60 * 60e3;
const DAY_MS = 24 * 60 * 60e3;
// First pass a minute after boot rather than immediately: let the folder lists
// sync first, so the very first sweep of a fresh install is not deciding what
// to move from an empty cache.
const FIRST_RUN_MS = 60e3;

let timer = null;
let started = false;
let running = false;

/** Which of this account's folders the sweep covers: the Inbox and everything
 *  nested under it, minus everything with a job of its own
 *  (archive.js#isArchivableFolder). Read from the CACHED folder list — the
 *  sweep is not a reason to go and list folders on twelve mail servers. */
function foldersToSweep(uKey, account, target) {
  if (!config.cacheEnabled) return ['INBOX'];
  const hidden = new Set(account.hiddenFolders || []);
  return cache.getFolders(uKey, account.id)
    .map((f) => f.path)
    .filter((p) => p === 'INBOX' || /^INBOX[./]/i.test(p))
    .filter((p) => !hidden.has(p) && archive.isArchivableFolder(account, p, target));
}

/** One account, if it is due. Returns how many messages moved. */
async function sweepAccount(user, uKey, account) {
  const days = Number(account.autoArchiveDays) || 0;
  if (days <= 0 || account.disabled) return 0;

  const runs = store.getAutoArchiveRunsFor(uKey);
  if (Date.now() - (runs[account.id] || 0) < DAY_MS) return 0;

  // Recorded BEFORE the work, not after. A sweep that dies half way through —
  // the mail server goes away, the process is killed — has still moved
  // whatever it moved, and the right answer is to try again tomorrow rather
  // than to retry immediately in a loop. Nothing is lost: tomorrow's sweep
  // picks up exactly what this one did not.
  store.saveAutoArchiveRunsFor(uKey, { ...runs, [account.id]: Date.now() });

  const target = account.archiveFolder;
  if (!target) {
    alog.debug(`${account.label}: auto-archive is on but no Archive folder is set — skipping`);
    return 0;
  }

  const before = archive.cutoffForDays(days);
  let moved = 0;
  await runAsAccount(user, account.id, async () => {
    for (const folder of foldersToSweep(uKey, account, target)) {
      try {
        const r = await archive.sweepFolder({ uKey, acctId: account.id, folder, target, before });
        moved += r.moved;
      } catch (e) {
        // One unreadable folder must not lose the rest of the account — the
        // same per-folder tolerance sync.js applies.
        alog.warn(`${account.label}/${folder}: auto-archive failed:`, e.message);
      }
    }
    if (moved && config.cacheEnabled) {
      try { await sync.syncFolderNow(uKey, account, target); }
      catch (e) { alog.debug(`${account.label}: could not re-sync ${target}:`, e.message); }
    }
  }, { purpose: 'sync' });

  if (moved) {
    // Said out loud, in the place the user can see: mail moving on its own is
    // exactly the kind of thing that must never happen silently.
    userLog.record(uKey, {
      level: 'info',
      category: 'archive',
      message: `Archived ${moved} message(s) older than ${days} days`,
      detail: `Moved to "${target}" in ${account.label}.`,
      accountId: account.id,
      accountLabel: account.label,
    });
    alog.info(`${account.label}: archived ${moved} message(s) older than ${days} days`);
  }
  return moved;
}

async function pass() {
  if (running) return;
  running = true;
  try {
    for (const u of listUsers().filter((x) => !x.disabled)) {
      const uKey = userKey(u.username);
      const user = { id: u.id, username: u.username };
      let owned;
      try {
        // listOwnedAccounts, like sync.js: a shared-in account is swept once,
        // by its owner's pass, never again by every grantee's.
        owned = await runAsUser(user, () => accountsStore.listOwnedAccounts());
      } catch (e) {
        alog.warn(`Could not list accounts for ${u.username}:`, e.message);
        continue;
      }
      for (const account of owned) {
        try { await sweepAccount(user, uKey, account); }
        catch (e) { alog.warn(`${account.label}: auto-archive pass failed:`, e.message); }
      }
    }
  } finally {
    running = false;
  }
}

export function start() {
  if (started) return;
  started = true;
  alog.info('Auto-archive runner started');
  timer = setTimeout(function loop() {
    pass().finally(() => { if (started) timer = setTimeout(loop, TICK_MS); });
  }, FIRST_RUN_MS);
  timer.unref?.();
}

export function stop() {
  started = false;
  clearTimeout(timer);
}

/** Exported for the tests and for an on-demand run. */
export const __test = { sweepAccount, foldersToSweep, pass };
