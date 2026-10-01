// Hmelj — "remind me if nobody answers".
//
// When a message is sent with a follow-up (the ⏰ button in the composer), a
// small record is kept here. A slow loop checks each one: if a reply has
// arrived it is simply removed, and if the time is up with none, it is marked
// due and a push goes out. Due records are what the Follow up entry in the
// sidebar lists.
//
// ── The mailbox is never touched ────────────────────────────────────────────
// A reminder could have been delivered by copying the sent message back into
// the Inbox. It is not: that writes a duplicate into the user's real mailbox,
// which then has to be cleaned up on every device. The reminder is Hmelj's own
// and lives on Hmelj's own surfaces — the sidebar and a notification.
//
// ── How a reply is recognised ───────────────────────────────────────────────
// By conversation, in the local cache, without asking any mail server. The
// composer's message is sent with a Message-ID minted in /api/send, so it is
// known in advance; once the sent copy has been synced its thread key is read
// back off it (cache.js#findThreadKeyFor), and a reply is anything else in that
// thread that arrived later and is not from one of the user's own addresses.
// Reading the key off our own copy is what makes Exchange and Graph work: their
// thread key is a ConversationId, which only the server can assign.
//
// ── Storage ─────────────────────────────────────────────────────────────────
// One JSON file per record, the same layout and the same id guard as snooze.js:
// small, independent, and nothing to reconcile after a crash.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';
import { log } from './log.js';
import { listUsers, userKey } from './session.js';
import * as cache from './cache.js';
import { myAddressesFor } from './contacts.js';
import { listOwnedAccountsFor } from './accounts.js';
import { normalizeId, threadKeyFrom } from './threading.js';
import * as push from './push.js';
import { t as tr } from './pushI18n.js';
import { store } from './store.js';

const flog = log.scope('follow-up');

// Every 15 minutes. A follow-up is measured in days; an extra quarter of an
// hour before it surfaces is invisible, and it keeps the loop to a handful of
// cheap indexed lookups per hour however many are waiting.
const TICK_MS = 15 * 60e3;
// A minute after boot rather than at once, so the first pass reads a cache the
// sync has had a chance to bring up to date — otherwise a reply that arrived
// while the server was down would be missed for one round and the reminder
// would fire on a conversation that had in fact been answered.
const FIRST_RUN_MS = 60e3;
// The choices the composer offers. Anything else from a request is refused.
export const ALLOWED_DAYS = [1, 2, 3, 5, 7];
const DAY_MS = 24 * 3600e3;

/* ---------- storage ---------- */

function dirFor(uKey) {
  const dir = path.join(config.dataDir, 'users', uKey, 'follow-ups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Ids are minted here, but come back as a route parameter — so the path is
 *  built from user input regardless, and is checked before it is used. */
export function assertId(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw Object.assign(new Error('Bad follow-up id'), { status: 400 });
  return id;
}

function fileFor(uKey, id) {
  return path.join(dirFor(uKey), `${assertId(id)}.json`);
}

function writeRecord(uKey, rec) {
  const file = fileFor(uKey, rec.id);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, file);
}

function readRecord(uKey, id) {
  try { return JSON.parse(fs.readFileSync(fileFor(uKey, id), 'utf8')); } catch { return null; }
}

function removeRecord(uKey, id) {
  try { fs.unlinkSync(fileFor(uKey, id)); } catch { /* already gone */ }
}

function listRecords(uKey) {
  let names;
  try { names = fs.readdirSync(dirFor(uKey)); } catch { return []; }
  return names.filter((n) => n.endsWith('.json'))
    .map((n) => { try { return JSON.parse(fs.readFileSync(path.join(dirFor(uKey), n), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

/* ---------- registering ---------- */

/** The first recipient, for "No reply yet — to Ana". Enough to recognise the
 *  message by; the full list is in the message itself. */
function firstRecipient(to) {
  const s = String(to || '').split(',')[0].trim();
  const named = s.match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>/);
  return named ? named[1].trim() : s;
}

/**
 * Keep a follow-up for a message that has just gone out.
 *
 * Called where a send actually COMPLETES — the immediate path in index.js and
 * the scheduled/undo queue — never when Send is pressed: a message held back by
 * undo-send and then recalled must leave no reminder behind.
 *
 * `viewerKey` is whose list it appears in (the person who pressed Send);
 * `ownerKey` is whose cache the sent copy and any reply land in — different on
 * a shared account. Both are needed, and they are not interchangeable.
 */
export function register(viewerKey, ownerKey, payload, accountId) {
  const days = Number(payload?.followUpDays);
  if (!ALLOWED_DAYS.includes(days) || !payload.messageId || !accountId) return null;
  const messageId = normalizeId(payload.messageId);
  const sentAt = Date.now();
  const rec = {
    id: crypto.randomUUID(),
    accountId,
    ownerKey: ownerKey || viewerKey,
    messageId,
    // A fallback only. The authoritative key is read off the synced sent copy
    // (see checkOne), because on Exchange and Graph this header-derived guess
    // will not match what the cache stores.
    threadKey: threadKeyFrom({ messageId: payload.messageId, inReplyTo: payload.inReplyTo, references: payload.references }),
    subject: String(payload.subject || ''),
    to: firstRecipient(payload.to),
    sentAt,
    dueAt: sentAt + days * DAY_MS,
    state: 'waiting',
  };
  writeRecord(viewerKey, rec);
  flog.debug(`Follow-up in ${days} day(s) for "${rec.subject}" (${accountId})`);
  return rec;
}

/* ---------- checking ---------- */

/**
 * One record. Returns 'answered' (and removes it), 'due' (newly), or null.
 *
 * Checked for a reply EVEN once it is due: if the answer arrives after the
 * reminder fired, the reminder has done its job and must not keep sitting in
 * the sidebar asking about a conversation that has since been answered.
 */
function checkOne(viewerKey, rec, own) {
  const ownerKey = rec.ownerKey || viewerKey;
  const account = listOwnedAccountsFor(ownerKey).find((a) => a.id === rec.accountId);
  // The account was removed: nothing left to watch, and nowhere to open the
  // message from. Drop it quietly rather than reminding about nothing.
  if (!account) { removeRecord(viewerKey, rec.id); return 'answered'; }

  const threadKey = cache.findThreadKeyFor(ownerKey, rec.accountId, rec.messageId) || rec.threadKey;
  const answered = cache.hasReplyInThread(ownerKey, rec.accountId, threadKey, rec.sentAt, {
    ownAddresses: [...own],
    excludeFolders: [account.sentFolder, account.draftsFolder],
  });
  if (answered) {
    removeRecord(viewerKey, rec.id);
    flog.debug(`"${rec.subject}" was answered — follow-up dropped`);
    return 'answered';
  }
  if (rec.state === 'waiting' && Date.now() >= rec.dueAt) {
    writeRecord(viewerKey, { ...rec, state: 'due', dueSince: Date.now() });
    return 'due';
  }
  return null;
}

let timer = null;
let started = false;
let running = false;

async function pass() {
  if (running) return;
  running = true;
  try {
    for (const u of listUsers().filter((x) => !x.disabled)) {
      const viewerKey = userKey(u.username);
      const records = listRecords(viewerKey);
      if (!records.length) continue;
      const own = myAddressesFor(viewerKey);
      let newlyDue = 0;
      let lastDue = null;
      for (const rec of records) {
        try {
          if (checkOne(viewerKey, rec, own) === 'due') { newlyDue++; lastDue = rec; }
        } catch (e) {
          flog.warn(`Could not check follow-up "${rec.subject}":`, e.message);
        }
      }
      if (newlyDue) {
        // One notification per pass, not per message: three reminders coming
        // due at 09:00 is one tap to open the list, not three. Translated HERE,
        // in the user's own language — the OS renders this from the payload,
        // with nothing of Hmelj's running on the device to translate it after
        // (same reason as sync.js#notificationActions).
        const lang = store.getSettingsFor(viewerKey).language || 'en';
        const title = newlyDue === 1
          ? tr(lang, 'No reply yet')
          : tr(lang, 'No reply to {n} messages').replace('{n}', newlyDue);
        const body = newlyDue === 1
          ? `${lastDue.subject || tr(lang, '(no subject)')} — ${lastDue.to}`
          : tr(lang, 'Open Follow up to see them');
        // `kind` twice, as calendarReminders.js#payloadFor does: the Android
        // shell reads it at the top level (to keep this off the mail channel and
        // out of the unread badge), sw.js and the tap handler read it in `data`.
        push.sendPushToUser(viewerKey, { title, body, icon: '/icons/icon-192.png', tag: 'hmelj-followup', kind: 'followup', data: { kind: 'followup' } })
          .catch((e) => flog.debug('Follow-up push failed:', e.message));
      }
    }
  } finally {
    running = false;
  }
}

/* ---------- what the routes need ---------- */

/** Due ones, newest first — what the sidebar lists. Waiting ones are counted
 *  too, so the composer's ⏰ can be confirmed as having taken. */
export function listFor(viewerKey) {
  const all = listRecords(viewerKey);
  const due = all.filter((r) => r.state === 'due')
    .sort((a, b) => (b.dueSince || b.dueAt) - (a.dueSince || a.dueAt))
    // Where the sent message is now, so the row can open it. Looked up per
    // request rather than stored: the copy's uid is only known once the Sent
    // folder has synced, which is after the record was made.
    .map((r) => ({ ...r, ...(cache.locateByMessageId(r.ownerKey || viewerKey, r.accountId, r.messageId) || {}) }));
  return { due, waiting: all.filter((r) => r.state === 'waiting').length };
}

/** "Remind me again": back to waiting, due again in `days`. */
export function snooze(viewerKey, id, days) {
  const d = Number(days);
  if (!ALLOWED_DAYS.includes(d)) throw Object.assign(new Error('Pick 1, 2, 3, 5 or 7 days'), { status: 400 });
  const rec = readRecord(viewerKey, id);
  if (!rec) throw Object.assign(new Error('That reminder is gone'), { status: 404 });
  const next = { ...rec, state: 'waiting', dueAt: Date.now() + d * DAY_MS };
  delete next.dueSince;
  writeRecord(viewerKey, next);
  return next;
}

/** "Done": the user has dealt with it, however they did. */
export function dismiss(viewerKey, id) {
  assertId(id);
  removeRecord(viewerKey, id);
}

export function start() {
  if (started) return;
  started = true;
  flog.info('Follow-up runner started');
  timer = setTimeout(function loop() {
    pass().finally(() => { if (started) timer = setTimeout(loop, TICK_MS); });
  }, FIRST_RUN_MS);
  timer.unref?.();
}

export function stop() {
  started = false;
  clearTimeout(timer);
}

/** For the tests and for an on-demand check. */
export const __test = { checkOne, register, listRecords, pass };
