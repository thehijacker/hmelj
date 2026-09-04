// Hmelj — scheduled sending ("send later").
//
// ── Why the queue is files in DATA_DIR, not a table in cache.sqlite ─────────
// cache.sqlite is disposable by contract: it is rebuilt from the mail servers on
// the next sync, and cache.js#addColumn says outright that a migration needing
// more than an added nullable column should delete the file and start over. A
// message that has not been sent yet is the ONLY thing in Hmelj that exists
// nowhere else — losing it means the mail never goes out and nobody finds out.
// So it lives beside settings and identities, in the directory a backup covers.
//
// One file per message rather than one array file: payloads carry base64
// attachments (tens of MB), so flipping one status field must not rewrite all of
// them, and a partial write can then only ever damage a single message.
//
// ── Why it has its own ticker ──────────────────────────────────────────────
// sync.js#start() returns early when CACHE_ENABLED=false. Scheduled sending has
// to work regardless of whether the cache is on, so it does not hang off the
// sync supervisor. Chained setTimeout, not setInterval — same reason sync.js
// gives: the next run is scheduled only once the previous one has finished.
//
// ── "The server was down past the send time" needs no code ─────────────────
// The tick asks one question: is anything due (sendAt <= now)? A message that
// came due while the process was dead is simply due at boot. That IS the
// catch-up mechanism; there is deliberately no separate path for it.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';
import { log } from './log.js';
import { listUsers, runAsUser, userKey } from './session.js';
import { sendMail } from './smtpClient.js';
import { learnRecipients } from './contacts.js';
import * as userLog from './userLog.js';
import * as push from './push.js';

const sslog = log.scope('schedule-send');

/** Furthest ahead a message may be scheduled. Not a technical limit — a guard
 *  against a bad client-side date computation parking mail in the year 3000. */
const MAX_AHEAD_MS = 366 * 24 * 3600e3;

// How long after each failed attempt to try again. A rejection and an
// unreachable server are different problems: only transient failures walk this
// table (see isPermanent), and running off the end of it is what "give up"
// means. Totals about 72h.
const BACKOFF_MS = [60e3, 5 * 60e3, 15 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3];
const MAX_ATTEMPTS = 16;

/**
 * A send time, or a 400.
 *
 * `Number()` alone is not enough: it maps null and '' to 0, which is perfectly
 * finite, so `PATCH /api/scheduled/:id` with `{"sendAt": null}` passed the
 * obvious Number.isFinite check, got clamped to "now" by the Math.max below,
 * and sent the queued message on the next tick — a malformed request turning
 * into an immediate send of mail the user had deliberately delayed. Rejected
 * explicitly here, for both schedule() and reschedule().
 */
function validSendAt(value) {
  if (value === null || value === undefined || value === '') {
    throw Object.assign(new Error('That send time is not a valid date'), { status: 400 });
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw Object.assign(new Error('That send time is not a valid date'), { status: 400 });
  if (n > Date.now() + MAX_AHEAD_MS) throw Object.assign(new Error('That is more than a year away'), { status: 400 });
  return n;
}

const TICK_MS = 30e3;
const MAX_SLEEP_MS = 60e3; // never sleep longer than this, so a clock jump can't strand the queue

/* ---------- storage ---------- */

function dirFor(uKey) {
  const dir = path.join(config.dataDir, 'users', uKey, 'scheduled');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Ids are generated here and never taken from a request — but they arrive back
 * as a route parameter, so the path is built from user input regardless of who
 * minted it. Validated as its own step rather than inside readRecord(), whose
 * catch would otherwise turn a rejected id into an indistinguishable "not
 * found" and hide a probe.
 */
function assertId(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw Object.assign(new Error('Bad scheduled id'), { status: 400 });
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

/** Every record for one user, oldest send time first. */
function allRecords(uKey) {
  let names;
  try { names = fs.readdirSync(dirFor(uKey)); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue; // skips a leftover .tmp from a crash mid-write
    try { out.push(JSON.parse(fs.readFileSync(path.join(dirFor(uKey), n), 'utf8'))); }
    catch (e) { sslog.warn(`Unreadable scheduled message ${n}:`, e.message); }
  }
  return out.sort((a, b) => a.sendAt - b.sendAt);
}

/**
 * What the browser gets: everything except the payload's bulk. Attachments can
 * be tens of megabytes and the Scheduled list needs to know only that they
 * exist — shipping them back would make opening the list cost more than sending
 * the message did.
 */
function summarize(rec) {
  const p = rec.payload || {};
  return {
    id: rec.id,
    sendAt: rec.sendAt,
    createdAt: rec.createdAt,
    state: rec.unresolved ? 'unresolved' : rec.state,
    attempts: rec.attempts || 0,
    lastError: rec.lastError || null,
    lastAttemptAt: rec.lastAttemptAt || null,
    subject: p.subject || '',
    to: p.to || '',
    cc: p.cc || '',
    identityId: p.identityId || null,
    attachmentCount: (p.attachments || []).length,
    // An "undo send" hold rather than a message someone deliberately scheduled.
    // Same record, same queue, same runner — but the Scheduled view filters
    // these out (see list()), because a ten-second row that appears and
    // disappears on every single send is noise, not a queue.
    undo: !!p.undo,
  };
}

/* ---------- public API (the routes in index.js) ---------- */

/**
 * Queues `payload` for `sendAt`. Returns the summary, not the record — the
 * caller is answering an HTTP request and has no use for the payload it just
 * sent us.
 */
export function schedule(uKey, payload, sendAt) {
  const when = validSendAt(sendAt);
  const rec = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    // A time already past means "send now" rather than an error: the browser
    // computed it a moment ago, and a user who picked 09:00 at 09:00:01 meant
    // now, not a rejection.
    sendAt: Math.max(when, Date.now()),
    state: 'pending',
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    unresolved: false,
    payload,
  };
  writeRecord(uKey, rec);
  sslog.info(`Scheduled "${payload.subject || '(no subject)'}" for ${new Date(rec.sendAt).toISOString()}`);
  wake();
  return summarize(rec);
}

/**
 * The Scheduled view's list. Undo-send holds are left out by default: they are
 * the same kind of record, but a row that exists for ten seconds after every
 * send would make the queue unreadable. `includeUndo` is for anything that
 * genuinely needs the whole queue.
 */
export function list(uKey, { includeUndo = false } = {}) {
  const all = allRecords(uKey).map(summarize);
  return includeUndo ? all : all.filter((r) => !r.undo);
}

/**
 * One queued message, with enough of the payload to READ it — the body and the
 * attachment names, but still not the attachment bytes. Fetched only when a row
 * is actually opened, so the list stays as cheap as it was; `summarize` remains
 * the thing the list itself is built from.
 *
 * Deliberately not the same shape as GET /api/message: nothing here has a UID,
 * a folder or flags, because none of it exists on a mail server yet.
 */
export function preview(uKey, id) {
  assertId(id); // before readRecord, whose catch would mask it as a 404
  const rec = readRecord(uKey, id);
  if (!rec) throw Object.assign(new Error('That scheduled message is no longer there'), { status: 404 });
  const p = rec.payload || {};
  return {
    ...summarize(rec),
    bcc: p.bcc || '',
    priority: p.priority || 'normal',
    html: p.html || null,
    text: p.text || '',
    attachments: (p.attachments || []).map((a) => ({
      filename: a.filename || '',
      contentType: a.contentType || '',
      size: base64Size(a.contentBase64),
    })),
  };
}

/** Decoded byte length of a base64 string, without decoding it — the payload
 *  can hold tens of megabytes and this is only ever used to print "142 KB". */
function base64Size(b64) {
  const s = String(b64 || '');
  if (!s) return 0;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(s.length * 3 / 4) - pad);
}

/**
 * Cancels one, and hands the full payload back so the caller can reopen it in
 * the composer — "cancel" in the UI means "put it back in my hands", and a
 * cancel that dropped the message on the floor would be a data-loss button.
 */
export function cancel(uKey, id) {
  assertId(id); // before readRecord, whose catch would mask it as a 404
  const rec = readRecord(uKey, id);
  if (!rec) throw Object.assign(new Error('That scheduled message is no longer there'), { status: 404 });
  if (rec.state === 'sending' && !rec.unresolved) {
    // Mid-flight right now: the SMTP conversation is open and there is no way
    // to recall it. Refusing is honest; pretending to cancel would not be.
    throw Object.assign(new Error('That message is being sent right now'), { status: 409 });
  }
  removeRecord(uKey, id);
  sslog.info(`Cancelled scheduled message ${id}`);
  return rec.payload;
}

/**
 * Moves a queued message to a new time. Separate from cancel-and-recompose
 * because it must NOT touch the payload: re-sending the body through the
 * composer to change one timestamp risks the message coming back subtly
 * different from the one that was approved.
 */
export function reschedule(uKey, id, sendAt) {
  assertId(id);
  const when = validSendAt(sendAt);
  const rec = readRecord(uKey, id);
  if (!rec) throw Object.assign(new Error('That scheduled message is no longer there'), { status: 404 });
  if (rec.state === 'sending' && !rec.unresolved) {
    throw Object.assign(new Error('That message is being sent right now'), { status: 409 });
  }
  rec.sendAt = Math.max(when, Date.now());
  // A new time is a fresh start: keeping the attempt count would let a message
  // that had already failed twice give up two tries early, and the old error
  // would sit in the UI describing a run the user has explicitly moved past.
  rec.attempts = 0;
  rec.lastError = null;
  rec.state = 'pending';
  rec.unresolved = false;
  writeRecord(uKey, rec);
  wake();
  return summarize(rec);
}

/* ---------- hooks (set by index.js at boot) ----------
 * index.js owns saveDraft() and markOriginal(), and importing it from here
 * would be a cycle. Injected instead, the same way sync.js hands idle.js its
 * activity callback. Both are best-effort: a failure in either must not turn a
 * sent message into a retry. */
let hooks = { saveFailedDraft: null, markOriginal: null };
export function setHooks(h) { hooks = { ...hooks, ...h }; }

/* ---------- the runner ---------- */

let started = false;
let timer = null;
let busy = false; // one send at a time, process-wide

/** Users whose queue might have something in it. Driven off the auth list, not
 *  off directories, so a deleted user's leftover files are never picked up. */
function queues() {
  return listUsers().map((u) => ({ user: { id: u.id, username: u.username }, uKey: userKey(u.username) }));
}

/**
 * A permanent failure must not walk the backoff table. Retrying "550 no such
 * recipient" sixteen times only delays the bad news by three days.
 * nodemailer surfaces the SMTP reply code as `responseCode`.
 *
 * Only 5xx counts. A 4xx is SMTP's own "try again later" and is exactly what the
 * backoff exists for; a socket error carries no code at all and is the most
 * transient thing there is.
 */
export function isPermanent(e) {
  const code = Number(e?.responseCode);
  return Number.isFinite(code) && code >= 500 && code < 600;
}

/** How long to wait before attempt N+1, given N attempts have been made. Holds
 *  at the last step rather than running off the end — MAX_ATTEMPTS is what
 *  decides when to stop, not the length of the table. */
export function nextBackoffMs(attempts) {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1) - 1, BACKOFF_MS.length - 1)];
}

/** Whether this failure ends the road: nothing left to try, or nothing worth
 *  trying. Exported alongside the two above so the retry policy can be read as
 *  three lines rather than inferred from onFailure's control flow. */
export function isExhausted(attempts, e) {
  return isPermanent(e) || attempts >= MAX_ATTEMPTS;
}

async function attemptSend(uKey, user, rec) {
  // Written BEFORE the SMTP handshake, on purpose. If the process dies between
  // here and the delete below, the record is found in 'sending' at boot and is
  // NOT retried (see resolveInterrupted) — because from the outside there is no
  // way to tell whether the mail went out. Retrying risks a duplicate, dropping
  // risks a lost message, and that is not a decision to make automatically.
  rec.state = 'sending';
  rec.lastAttemptAt = Date.now();
  rec.attempts = (rec.attempts || 0) + 1;
  writeRecord(uKey, rec);

  try {
    // runAsUser rebuilds the context a request would have had. It is also what
    // re-validates access for free: sendMail resolves through
    // resolveAccountForSending(), which re-checks that THIS user may still use
    // that account — so a share revoked between scheduling and sending fails
    // here rather than sending.
    await runAsUser(user, () => sendMail(rec.payload));
  } catch (e) {
    return void onFailure(uKey, user, rec, e);
  }

  // Same as an immediate send: everyone it went to becomes a contact, in the
  // SENDER's address book (runAsUser, not the mailbox owner's context) and only
  // now that it has actually gone out. See server/contacts.js.
  runAsUser(user, () => learnRecipients(rec.payload));

  // Sent. Drop the queue entry first: everything below is a nicety, and none of
  // it is worth risking a second send over if it throws.
  removeRecord(uKey, rec.id);
  sslog.info(`Sent scheduled message "${rec.payload.subject || '(no subject)'}" (${rec.attempts} attempt(s))`);

  // The reply/forward marker belongs to the moment the mail actually went out,
  // not to when it was scheduled — which is why `original` rides along in the
  // stored payload rather than being applied up front.
  if (rec.payload.original && hooks.markOriginal) {
    await runAsUser(user, () => hooks.markOriginal(rec.payload.original))
      .catch((e) => sslog.debug('Could not mark the original:', e.message));
  }
}

function onFailure(uKey, user, rec, e) {
  const permanent = isPermanent(e);
  rec.state = 'pending';
  rec.lastError = e.message;
  const backoff = nextBackoffMs(rec.attempts);

  if (!isExhausted(rec.attempts, e)) {
    rec.sendAt = Date.now() + backoff;
    writeRecord(uKey, rec);
    sslog.warn(`Scheduled send failed (attempt ${rec.attempts}), retrying in ${Math.round(backoff / 1000)}s:`, e.message);
    return;
  }

  sslog.warn(`Giving up on scheduled message ${rec.id} after ${rec.attempts} attempt(s):`, e.message);
  removeRecord(uKey, rec.id);
  giveUp(uKey, user, rec, e, permanent);
}

/**
 * Out of retries. The message must not evaporate — it goes back to Drafts, the
 * same place an immediate send failure already puts it, and the user is told in
 * both places they might be looking (the Log, and a push notification for when
 * no tab is open at all, which for a scheduled send is the likely case).
 */
async function giveUp(uKey, user, rec, e, permanent) {
  const subject = rec.payload.subject || '(no subject)';
  try {
    if (hooks.saveFailedDraft) await runAsUser(user, () => hooks.saveFailedDraft(rec.payload));
  } catch (e2) {
    sslog.error('Also failed to save the abandoned scheduled message as a draft:', e2.message);
  }
  userLog.record(uKey, {
    level: 'error',
    category: 'send',
    message: `Scheduled message "${subject}" could not be sent`,
    detail: `${permanent ? 'Rejected by the mail server' : `Gave up after ${rec.attempts} attempts`}: ${e.message}\n`
      + `To: ${rec.payload.to}\nWas due ${new Date(rec.createdAt).toLocaleString()}. Saved back to Drafts.`,
  });
  await push.sendPushToUser(uKey, {
    title: 'Scheduled message failed',
    body: `${subject} — ${e.message}`,
    icon: '/icons/icon-192.png',
    tag: `hmelj-sched-fail-${rec.id}`,
    data: {},
  }).catch(() => {});
}

/**
 * At boot, anything still marked 'sending' was interrupted by a restart while
 * the SMTP conversation was open. Flagged for a person, never auto-retried —
 * see the comment in attemptSend.
 */
function resolveInterrupted() {
  for (const { uKey } of queues()) {
    for (const rec of allRecords(uKey)) {
      if (rec.state !== 'sending' || rec.unresolved) continue;
      rec.unresolved = true;
      writeRecord(uKey, rec);
      sslog.warn(`Scheduled message ${rec.id} was interrupted mid-send — needs a decision`);
      userLog.record(uKey, {
        level: 'warn',
        category: 'send',
        message: `"${rec.payload.subject || '(no subject)'}" may or may not have been sent`,
        detail: 'Hmelj restarted while this scheduled message was being sent, so there is no way to tell whether it went out.'
          + ' Open Scheduled to send it again or discard it.',
      });
    }
  }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    for (const { user, uKey } of queues()) {
      for (const rec of allRecords(uKey)) {
        if (rec.unresolved || rec.state === 'sending') continue;
        if (rec.sendAt > now) break; // sorted by sendAt — nothing later in this queue is due either
        // Re-read: this loop awaits, and a cancel may have landed in between.
        const fresh = readRecord(uKey, rec.id);
        if (!fresh || fresh.unresolved || fresh.state === 'sending' || fresh.sendAt > Date.now()) continue;
        await attemptSend(uKey, user, fresh);
      }
    }
  } catch (e) {
    sslog.error('Scheduled-send tick failed:', e.stack || e.message);
  } finally {
    busy = false;
  }
}

/** When the next thing is due, clamped so a bad clock can't park the timer. */
function nextDelay() {
  let soonest = Infinity;
  try {
    for (const { uKey } of queues()) {
      for (const rec of allRecords(uKey)) {
        if (rec.unresolved || rec.state === 'sending') continue;
        soonest = Math.min(soonest, rec.sendAt);
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

/** Something was just queued — re-plan rather than wait out the current sleep. */
function wake() { if (started) loop(); }

export function start() {
  if (started) return;
  started = true;
  resolveInterrupted();
  sslog.info('Scheduled sending started');
  loop();
}

export function stop() {
  started = false;
  clearTimeout(timer);
}
