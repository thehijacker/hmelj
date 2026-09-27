// Hmelj — moving old mail out of a folder and into the account's Archive.
//
// One sweep, two callers: the "Archive before…" entry on a folder's right-click
// menu (server/index.js's route), and the nightly per-account pass
// (server/autoArchive.js). They differ only in how the cut-off date is decided
// — a date somebody picked, or "today minus N days" — so everything after that
// point lives here rather than being written twice and drifting.
//
// ── Why this is not "list the folder and filter by date" ─────────────────────
// The messages this looks for are, by definition, the ones the local cache does
// NOT have: cache.js keeps only the newest syncBackfillLimit per folder, so
// anything old enough to archive has usually aged out of it. The question can
// only be answered by the mail server, which is what findOlderThan is for (one
// IMAP SEARCH / one restricted FindItem / one $filter — see the three clients).
//
// ── Why no undo ledger ───────────────────────────────────────────────────────
// A single "Archive" writes down where the message came from so "unarchive" can
// put it back (server/refile.js). A sweep deliberately does not: it moves
// thousands at a time, the ledger is a per-user JSON file, and nobody undoes a
// sweep one message at a time. The messages are in the Archive folder, intact
// and searchable — they were moved, not deleted — and moving a selection back
// is the ordinary Move action.
import * as imap from './mailClient.js';
import * as cache from './cache.js';
import * as sync from './sync.js';
import { config } from './config.js';
import { log } from './log.js';

const alog = log.scope('archive');

/** Moved per round trip. Big enough that a ten-thousand-message sweep is fifty
 *  calls and not ten thousand; small enough that one slow batch does not hold
 *  the account's connection for minutes (see imapClient.js's pool comment —
 *  interactive requests queue behind this on an account without a second
 *  connection). */
export const ARCHIVE_BATCH = 200;

/**
 * Midnight, local time, at the start of the given day.
 *
 * The boundary has to be stated somewhere or the three backends disagree: IMAP
 * BEFORE compares dates with no time part, Graph and EWS compare full instants.
 * Normalising to the start of the day makes all three mean the same thing —
 * "everything that arrived before this day began" — so a message that arrived
 * ON the chosen date is kept, by every backend, which is what a person picking
 * a date in a "before" field expects.
 */
export function startOfDay(input) {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error('That is not a valid date');
  d.setHours(0, 0, 0, 0);
  return d;
}

/** The cut-off for an age in days, as a date. */
export function cutoffForDays(days) {
  const d = new Date();
  d.setDate(d.getDate() - Number(days));
  return startOfDay(d);
}

/** How many messages a sweep WOULD move, without moving any. What the
 *  confirmation dialog asks for: "this many" before "are you sure". */
export async function countOlderThan(folder, before) {
  return (await imap.findOlderThan(folder, startOfDay(before))).length;
}

/** `uids` split into move-sized chunks, in order. Its own function because it
 *  is the one part of the sweep below that can be reasoned about — and tested
 *  — without a mail server on the other end. */
export function batches(uids, size = ARCHIVE_BATCH) {
  const out = [];
  for (let i = 0; i < uids.length; i += size) out.push(uids.slice(i, i + size));
  return out;
}

/**
 * Move everything in `folder` older than `before` into `target`.
 *
 * Must be called inside the account's ALS context (session.js#runAsAccount) —
 * every mail call below resolves the account from it, exactly as the routes do.
 * `uKey`/`acctId` are passed rather than read from that context because the
 * caller already has them and because for a shared account they are the
 * OWNER's, which is what the cache is keyed by.
 *
 * Returns `{ moved, batches }`. Never throws for "nothing to do".
 */
export async function sweepFolder({ uKey, acctId, folder, target, before }) {
  if (!target) throw new Error('No Archive folder is set for this account');
  if (folder === target) return { moved: 0, batches: 0 };
  const cutoff = startOfDay(before);
  const uids = await imap.findOlderThan(folder, cutoff);
  if (!uids.length) return { moved: 0, batches: 0 };

  let moved = 0;
  const chunks = batches(uids);
  for (const chunk of chunks) {
    await imap.moveMessages(folder, chunk, target);
    moved += chunk.length;
    if (config.cacheEnabled) {
      // Per batch, not once at the end: a sweep of ten thousand takes a while,
      // and a sidebar count that stays wrong for all of it — or worse, a poll
      // landing mid-sweep and writing back a count from before it started — is
      // what noteLocalWrite exists to prevent.
      sync.noteLocalWrite(uKey, acctId, folder);
      sync.noteLocalWrite(uKey, acctId, target);
      cache.adjustFolderCounts(uKey, acctId, folder, cache.removeMessages(uKey, acctId, folder, chunk));
    }
  }
  alog.info(`${folder} → ${target}: archived ${moved} message(s) older than ${cutoff.toISOString().slice(0, 10)}`);
  return { moved, batches: chunks.length };
}

/**
 * The folders a sweep is allowed to touch.
 *
 * Everything the account uses for a PURPOSE is excluded, and each for its own
 * reason rather than as a blanket rule: Sent and Drafts are not incoming mail
 * and ageing them out would scatter a user's own writing; Trash and Junk are
 * already where mail goes to be forgotten, and moving their contents to the
 * Archive would rescue it instead; Snoozed is mail with a wake-up time on it,
 * and moving it breaks server/snooze.js's own bookkeeping; and the Archive
 * itself is the destination.
 */
export function isArchivableFolder(account, path, target) {
  if (!path || path === target) return false;
  const off = [account.sentFolder, account.draftsFolder, account.trashFolder,
    account.junkFolder, account.archiveFolder, account.snoozeFolder].filter(Boolean);
  return !off.includes(path);
}
