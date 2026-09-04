// Hmelj — snoozing a message: take it out of the Inbox now, put it back later.
//
// ── Why the message really MOVES ───────────────────────────────────────────
// A snoozed message is moved into a real folder on the mail server (Snoozed by
// default, created on first use), not merely hidden from Hmelj's list. Hiding it
// locally would mean it still sits in the Inbox on the phone's stock client, in
// Thunderbird, and in the web UI of whoever provides the mailbox — so "snoozed"
// would only be true in one of the places the person reads their mail. The cost
// is a real move: the message gets a new uid, and other clients see the folder.
//
// ── Why the queue is files in DATA_DIR, not a table in cache.sqlite ────────
// Same rule as the scheduled-send queue, and for the same reason (see that
// file's header): cache.sqlite is disposable by contract, and the two facts
// here — WHEN this comes back and WHERE it came from — exist nowhere else. The
// message itself is safe on the server either way; losing this file would strand
// it in the Snoozed folder with nothing to say it was ever meant to return.
//
// That is also what separates a mail snooze from a CALENDAR snooze
// (calendarReminders.js), whose ledger lives in the cache precisely because it
// is rebuildable and losing it costs at most one forgotten reminder.
//
// ── "The server was down past the wake time" needs no code ─────────────────
// The tick asks one question: is anything due (wakeAt <= now)? Something that
// came due while the process was dead is simply due at boot. That IS the
// catch-up mechanism.
//
// Note this is the OPPOSITE of the choice calendarReminders.js makes, and
// deliberately: a reminder that fired into an empty room while the server was
// off is stale and is dropped, but a message that should have come back to the
// Inbox at 08:00 still needs to come back — the point was never the
// notification, it was where the mail lives.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';
import { log } from './log.js';
import { listUsers, runAsAccount, userKey } from './session.js';
import * as userLog from './userLog.js';
import * as push from './push.js';

const snlog = log.scope('snooze');

/** Furthest ahead a message may be snoozed — the same guard, and the same
 *  number, as the scheduled-send queue: not a technical limit, just a stop on a
 *  bad client-side date computation parking mail in the year 3000. */
const MAX_AHEAD_MS = 366 * 24 * 3600e3;

/** Default name for the folder snoozed mail waits in. Only used when the
 *  account has no `snoozeFolder` of its own — see ensureFolder in index.js. */
export const DEFAULT_SNOOZE_FOLDER = 'Snoozed';

/**
 * A wake time, or a 400.
 *
 * `Number()` is not enough on its own: it maps null and '' to 0, which is
 * perfectly finite, so a request carrying `wakeAt: null` would sail through the
 * obvious Number.isFinite check and be clamped to "now" — turning a malformed
 * request into an immediate wake instead of an error. Rejected explicitly here.
 */
export function validTime(value, what = 'time') {
  if (value === null || value === undefined || value === '') {
    throw Object.assign(new Error(`That is not a valid ${what}`), { status: 400 });
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw Object.assign(new Error(`That is not a valid ${what}`), { status: 400 });
  if (n > Date.now() + MAX_AHEAD_MS) throw Object.assign(new Error('That is more than a year away'), { status: 400 });
  return n;
}

const TICK_MS = 60e3;
const MAX_SLEEP_MS = 60e3; // never sleep longer, so a clock jump can't strand the queue

// A wake is a folder move against a mail server, so it fails the same ways a
// send does: unreachable, mid-reconnect, rate-limited. Retried on the same
// shape of backoff, and far more forgivingly than a send — nothing is lost by
// trying again in an hour, the message is sitting safely in a folder either way.
const BACKOFF_MS = [60e3, 5 * 60e3, 15 * 60e3, 3600e3, 6 * 3600e3];
const MAX_ATTEMPTS = 12;

/* ---------- storage ---------- */

function dirFor(uKey) {
  const dir = path.join(config.dataDir, 'users', uKey, 'snoozed');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Ids are minted here and never taken from a request — but they come back as a
 * route parameter, so the path is built from user input regardless of who made
 * it. Its own step rather than inside readRecord(), whose catch would otherwise
 * turn a rejected id into an indistinguishable "not found" and hide a probe.
 */
export function assertId(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw Object.assign(new Error('Bad snooze id'), { status: 400 });
  return id;
}

function fileFor(uKey, id) {
  return path.join(dirFor(uKey), `${assertId(id)}.json`);
}

function writeRecord(uKey, rec) {
  const file = fileFor(uKey, rec.id);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec));
  fs.renameSync(tmp, file); // atomic — a crash mid-write leaves the previous version, never half of one
  return rec;
}

function readRecord(uKey, id) {
  try { return JSON.parse(fs.readFileSync(fileFor(uKey, id), 'utf8')); }
  catch { return null; }
}

function removeRecord(uKey, id) {
  try { fs.unlinkSync(fileFor(uKey, id)); } catch { /* already gone */ }
}

/** Every record for one user, soonest wake first. */
function allRecords(uKey) {
  let names;
  try { names = fs.readdirSync(dirFor(uKey)); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue; // skips a leftover .tmp from a crash mid-write
    try { out.push(JSON.parse(fs.readFileSync(path.join(dirFor(uKey), n), 'utf8'))); }
    catch (e) { snlog.warn(`Unreadable snooze record ${n}:`, e.message); }
  }
  return out.sort((a, b) => a.wakeAt - b.wakeAt);
}

/** What the browser gets. Everything already, in fact — unlike a scheduled
 *  message there is no bulky payload here, only a pointer to mail that lives on
 *  the server. Kept as its own function anyway so the wire shape is one
 *  decision in one place. */
function summarize(rec) {
  return {
    id: rec.id,
    wakeAt: rec.wakeAt,
    createdAt: rec.createdAt,
    accountId: rec.accountId,
    folder: rec.snoozeFolder,
    uid: rec.uid,
    from: rec.fromFolder,
    subject: rec.subject || '',
    fromAddr: rec.fromAddr || '',
    fromName: rec.fromName || '',
    calendarUid: rec.calendarUid || null,
    attempts: rec.attempts || 0,
    lastError: rec.lastError || null,
  };
}

/* ---------- public API (the routes in index.js) ---------- */

/**
 * Records an already-moved message as snoozed until `wakeAt`.
 *
 * The MOVE is the caller's job, not this module's: it happens in a request
 * context where the account is resolved and the cache mirroring is already
 * written (index.js#moveAndMirror), and doing it here would mean a second copy
 * of all of that. This owns the promise to bring it back, which is the part
 * that has to outlive the request.
 */
export function remember(uKey, {
  accountId, ownerUsername, fromFolder, snoozeFolder, uid, messageId,
  subject, fromAddr, fromName, wakeAt, calendarId, calendarUid,
}) {
  const when = validTime(wakeAt);
  const rec = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    // A time already past means "bring it back on the next tick" rather than an
    // error, exactly as the send queue treats a send time that has just passed.
    wakeAt: Math.max(when, Date.now()),
    accountId,
    // Stored rather than looked up later: for a SHARED account the mailbox
    // belongs to someone other than whoever snoozed the message, and the wake
    // has to run as the owner (whose stored credentials reach the mailbox), not
    // as the person whose queue this is.
    ownerUsername,
    fromFolder,
    snoozeFolder,
    // The fast way back, and the reliable one. A uid is only meaningful inside
    // one folder and a server may hand out a different one than we expect if
    // another client has been moving things around; the Message-ID is stable
    // across folders, servers and restarts, so it is what the wake falls back
    // to when the uid turns out not to be there any more.
    uid,
    messageId: messageId || null,
    subject: subject || '',
    fromAddr: fromAddr || '',
    fromName: fromName || '',
    // Set when the snooze dialog's "also add to my calendar" was ticked, so
    // un-snoozing early can take the event away again rather than leaving a
    // reminder for something already dealt with.
    calendarId: calendarId || null,
    calendarUid: calendarUid || null,
    attempts: 0,
    lastError: null,
  };
  writeRecord(uKey, rec);
  snlog.info(`Snoozed "${rec.subject || '(no subject)'}" until ${new Date(rec.wakeAt).toISOString()}`);
  wake();
  return summarize(rec);
}

export function list(uKey) {
  return allRecords(uKey).map(summarize);
}

export function get(uKey, id) {
  assertId(id);
  const rec = readRecord(uKey, id);
  if (!rec) throw Object.assign(new Error('That snoozed message is no longer there'), { status: 404 });
  return rec;
}

/** Forgets a snooze without moving anything — for the caller that has just
 *  brought the message back itself (the "un-snooze now" route), and for a
 *  record whose message has vanished from the server. */
export function forget(uKey, id) {
  assertId(id);
  removeRecord(uKey, id);
}

/** Moves a snooze to a new time, leaving the message where it is. */
export function resnooze(uKey, id, wakeAt) {
  assertId(id);
  const when = validTime(wakeAt);
  const rec = readRecord(uKey, id);
  if (!rec) throw Object.assign(new Error('That snoozed message is no longer there'), { status: 404 });
  rec.wakeAt = Math.max(when, Date.now());
  // A new time is a fresh start, same reasoning as rescheduling a send: keeping
  // the attempt count would let something that had already failed twice give up
  // early, and the old error would sit in the UI describing a run since moved past.
  rec.attempts = 0;
  rec.lastError = null;
  writeRecord(uKey, rec);
  wake();
  return summarize(rec);
}

/** Is this message snoozed? Answered by (account, folder, uid) — what the
 *  message list has — so a row can be drawn as snoozed and offer "un-snooze"
 *  instead of "snooze". */
export function findByMessage(uKey, accountId, folder, uid) {
  return allRecords(uKey).find((r) => r.accountId === accountId
    && r.snoozeFolder === folder && String(r.uid) === String(uid)) || null;
}

/* ---------- hooks (set by index.js at boot) ----------
 * index.js owns the move-and-mirror-the-cache routine, the folder lookup and
 * the calendar write, and importing it from here would be a cycle. Injected
 * instead, exactly the way scheduledSend.js is handed saveFailedDraft. */
let hooks = { wakeMove: null, dropCalendarEvent: null };
export function setHooks(h) { hooks = { ...hooks, ...h }; }

/* ---------- the runner ---------- */

let started = false;
let timer = null;
let busy = false; // one wake at a time, process-wide

/** Users whose queue might hold something. Driven off the auth list, not off
 *  directories, so a deleted user's leftover files are never picked up. */
function queues() {
  return listUsers().map((u) => ({ user: { id: u.id, username: u.username }, uKey: userKey(u.username) }));
}

/** The account owner's user record, for runAsAccount. Null when that person has
 *  since been deleted, which strands the record rather than crashing the tick —
 *  reported once, then left alone. */
function ownerOf(rec) {
  const u = listUsers().find((x) => x.username === rec.ownerUsername);
  return u ? { id: u.id, username: u.username } : null;
}

async function attemptWake(uKey, rec, now = Date.now()) {
  const owner = ownerOf(rec);
  if (!owner) {
    snlog.warn(`Snoozed message ${rec.id} belongs to a user that no longer exists — dropping the record`);
    removeRecord(uKey, rec.id);
    return;
  }
  try {
    // Everything that touches the mailbox and the cache happens in there, under
    // the OWNER's context — see the hook's own comment in index.js.
    const moved = await runAsAccount(owner, rec.accountId, () => hooks.wakeMove(uKey, rec), { purpose: 'snooze' });
    removeRecord(uKey, rec.id);
    if (moved?.gone) {
      // The message is not in the snooze folder any more: somebody filed it by
      // hand, or deleted it. That is a decision, not a failure — the promise is
      // simply moot, and re-creating it somewhere would be worse than dropping it.
      snlog.info(`Snoozed message ${rec.id} was no longer in ${rec.snoozeFolder} — nothing to bring back`);
      return;
    }
    snlog.info(`Woke "${rec.subject || '(no subject)'}" back into ${rec.fromFolder}`);
    await push.sendPushToUser(uKey, {
      title: rec.subject || '(no subject)',
      body: rec.fromName || rec.fromAddr || '',
      icon: '/icons/icon-192.png',
      // Per snooze, so two coming back at once do not replace each other.
      tag: `hmelj-snooze-${rec.id}`,
      data: { accountId: rec.accountId, folder: rec.fromFolder, uid: moved?.uid ?? null, kind: 'snooze' },
    }).catch(() => {});
  } catch (e) {
    rec.attempts = (rec.attempts || 0) + 1;
    rec.lastError = e.message;
    if (rec.attempts >= MAX_ATTEMPTS) {
      // Out of retries. The message is NOT lost — it is still sitting in the
      // snooze folder — so the honest outcome is to stop promising and say
      // where it is, rather than to keep a record that will never resolve.
      removeRecord(uKey, rec.id);
      snlog.error(`Gave up bringing "${rec.subject}" back after ${rec.attempts} attempts:`, e.message);
      userLog.record(uKey, {
        level: 'error',
        category: 'snooze',
        message: `"${rec.subject || '(no subject)'}" could not be moved back out of ${rec.snoozeFolder}`,
        detail: `Hmelj tried ${rec.attempts} times over about three days and the mail server refused each time: ${e.message}\n`
          + `The message is safe — it is still in ${rec.snoozeFolder}, and you can move it back yourself.`,
      });
      await push.sendPushToUser(uKey, {
        title: 'A snoozed message could not come back',
        body: `${rec.subject || '(no subject)'} — it is still in ${rec.snoozeFolder}`,
        icon: '/icons/icon-192.png',
        tag: `hmelj-snooze-fail-${rec.id}`,
        data: {},
      }).catch(() => {});
      return;
    }
    // Next attempt on the backoff, holding at the last step.
    const step = BACKOFF_MS[Math.min(rec.attempts - 1, BACKOFF_MS.length - 1)];
    rec.wakeAt = now + step;
    writeRecord(uKey, rec);
    snlog.warn(`Could not wake ${rec.id} (attempt ${rec.attempts}): ${e.message} — retrying in ${Math.round(step / 1000)}s`);
  }
}

/**
 * Everything due for one user, brought back.
 *
 * Exported and taking an explicit `now` so the runner can be driven from a test
 * without a timer — same shape, and the same reason, as
 * calendarReminders.js#runFor: a test that could not choose the moment would be
 * testing nothing. Returns the ids it acted on.
 */
export async function runFor(uKey, { now = Date.now() } = {}) {
  const acted = [];
  for (const rec of allRecords(uKey)) {
    if (rec.wakeAt > now) break; // sorted by wakeAt — nothing later in this queue is due either
    // Re-read: this loop awaits, and an un-snooze may have landed in between.
    const fresh = readRecord(uKey, rec.id);
    if (!fresh || fresh.wakeAt > now) continue;
    await attemptWake(uKey, fresh, now);
    acted.push(fresh.id);
  }
  return acted;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    for (const { uKey } of queues()) await runFor(uKey, { now });
  } catch (e) {
    snlog.error('Snooze tick failed:', e.stack || e.message);
  } finally {
    busy = false;
  }
}

/** When the next thing is due, clamped so a bad clock cannot park the timer. */
function nextDelay() {
  let soonest = Infinity;
  try {
    for (const { uKey } of queues()) {
      for (const rec of allRecords(uKey)) {
        soonest = Math.min(soonest, rec.wakeAt);
        break; // sorted
      }
    }
  } catch { /* fall through to the default tick */ }
  if (!Number.isFinite(soonest)) return TICK_MS;
  return Math.max(1000, Math.min(soonest - Date.now(), MAX_SLEEP_MS));
}

function loop() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await tick();
    if (started) loop();
  }, nextDelay());
  timer.unref?.();
}

/** Something was just snoozed or re-snoozed — re-plan rather than wait out the
 *  current sleep. */
function wake() { if (started) loop(); }

export function start() {
  if (started) return;
  started = true;
  snlog.info('Snooze runner started');
  // No resolveInterrupted() counterpart to the send queue's: a move either
  // happened on the server or it did not, and the next tick re-reads the folder
  // to find out. There is no state here that a restart can leave ambiguous.
  loop();
}

export function stop() {
  started = false;
  clearTimeout(timer);
}
