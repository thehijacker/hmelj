// Hmelj — out-of-office replies, per account.
//
// ── Two ways of sending, chosen by backend ──────────────────────────────────
// Exchange (EWS) has automatic replies of its own, and they are better than
// anything Hmelj could do: they go out while Hmelj is down, they answer mail
// read on a phone, and Outlook shows the same setting. So for an EWS account
// the form is simply written to Exchange (ewsClient.js#setOof) and Exchange
// does the rest. The JSON file here only remembers what the form said.
//
// IMAP (Gmail included) and Microsoft Graph accounts get replies Hmelj sends
// itself, from the sync loop's new-mail path (sync.js → maybeReply). Graph has
// automatic replies too, but reaching them needs the MailboxSettings.ReadWrite
// permission, which would mean every such account signing in again — so it is
// handled like IMAP instead (the maintainer's choice).
//
// ── Who is never answered ───────────────────────────────────────────────────
// Each sender at most once per out-of-office period (the list resets whenever
// the settings are saved), never yourself, never a mailing list, a newsletter
// or another robot. The header tests are the ones RFC 3834 asks an
// auto-responder to make; the address tests catch the robots that do not set
// those headers. An auto-reply loop with another auto-responder is the one
// failure that would be truly embarrassing, and every one of these rules is
// there to make it impossible.
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { log } from './log.js';
import { myAddressesFor } from './contacts.js';
import { getMessage } from './mailClient.js';
import { sendMail } from './smtpClient.js';
import { store } from './store.js';
import * as userLog from './userLog.js';

const olog = log.scope('out-of-office');

function assertAccountId(id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) throw Object.assign(new Error('Bad account id'), { status: 400 });
  return id;
}

function fileFor(uKey, accountId) {
  const dir = path.join(config.dataDir, 'users', uKey, 'out-of-office');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${assertAccountId(accountId)}.json`);
}

const EMPTY = { enabled: false, start: null, end: null, subject: '', message: '', repliedTo: [] };

export function load(uKey, accountId) {
  const file = fileFor(uKey, accountId); // throws on a bad id — outside the catch on purpose
  try { return { ...EMPTY, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { ...EMPTY }; }
}

function write(uKey, accountId, rec) {
  const file = fileFor(uKey, accountId);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(rec, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

/** What the form sends, checked. Times are epoch ms or null (open-ended). */
export function clean(body) {
  const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const rec = {
    enabled: !!body?.enabled,
    start: num(body?.start),
    end: num(body?.end),
    subject: String(body?.subject || '').slice(0, 200),
    message: String(body?.message || '').slice(0, 10000),
  };
  if (rec.enabled && !rec.message.trim()) throw Object.assign(new Error('Write the reply first'), { status: 400 });
  if (rec.start && rec.end && rec.end <= rec.start) throw Object.assign(new Error('The end must be after the start'), { status: 400 });
  return rec;
}

/** Saving starts a new period: everyone may be answered once again. */
export function save(uKey, accountId, rec) {
  const next = { ...clean(rec), repliedTo: [], savedAt: Date.now() };
  write(uKey, accountId, next);
  return next;
}

export function isActive(rec, now = Date.now()) {
  if (!rec?.enabled || !String(rec.message || '').trim()) return false;
  if (rec.start && now < rec.start) return false;
  if (rec.end && now >= rec.end) return false;
  return true;
}

// Addresses that are robots whatever their headers say.
const ROBOT = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounce[s]?|notifications?|newsletter|news|info-noreply|listserv|majordomo|root|daemon)([+._-].*)?@/i;

/**
 * Whether a fetched message may be answered — RFC 3834's tests, plus the ones
 * mailing lists actually rely on. Exported for the tests.
 */
export function mayAnswer(headers = {}) {
  const auto = String(headers.autoSubmitted || '').trim().toLowerCase();
  if (auto && auto !== 'no') return false;
  if (/^(bulk|list|junk|auto_reply)$/i.test(String(headers.precedence || '').trim())) return false;
  if (headers.listId || headers.listUnsubscribeRaw || headers.listUnsubscribe) return false;
  if (headers.xAutoResponseSuppress && /all|oof|autoreply/i.test(headers.xAutoResponseSuppress)) return false;
  if (headers.returnPathEmpty) return false; // a bounce: "<>"
  return true;
}

export const isRobotAddress = (address) => ROBOT.test(String(address || ''));

/**
 * Called from sync.js for genuinely new mail in an IMAP or Graph account's
 * INBOX, inside that account's context. Never throws into the sync loop.
 */
export async function maybeReply(uKey, account, folder, messages) {
  if (account.ews || folder !== 'INBOX' || !messages?.length) return;
  const rec = load(uKey, account.id);
  if (!isActive(rec)) return;
  const mine = myAddressesFor(uKey);
  const replied = new Set((rec.repliedTo || []).map((a) => a.toLowerCase()));
  let changed = false;
  for (const m of messages) {
    const address = String(m.from?.address || '').toLowerCase();
    if (!address || replied.has(address) || mine.has(address) || isRobotAddress(address)) continue;
    // Arrived before the period began (a catch-up after downtime): it was
    // written to someone who was not away yet.
    const at = new Date(m.internalDate || m.date || 0).getTime();
    if (rec.start && at < rec.start) continue;
    try {
      const full = await getMessage(folder, m.uid);
      // Recorded BEFORE the header test too: a list that mails twice a day is
      // fetched once, not every time.
      replied.add(address); changed = true;
      if (!mayAnswer(full.headers || {})) continue;
      const replyTo = full.replyTo?.[0]?.address || address;
      if (mine.has(replyTo.toLowerCase()) || isRobotAddress(replyTo)) continue;
      const subject = rec.subject.trim() || `${/^re:/i.test(full.subject || '') ? '' : 'Re: '}${full.subject || ''}`;
      await sendMail({
        identityId: identityFor(account.id),
        to: replyTo,
        subject,
        text: rec.message,
        inReplyTo: full.messageId,
        references: full.messageId,
        autoReply: true,
      });
      olog.info(`${account.label}: out-of-office reply sent to ${replyTo}`);
    } catch (e) {
      olog.warn(`${account.label}: out-of-office reply to ${address} failed:`, e.message);
      userLog.record(uKey, { level: 'error', category: 'out-of-office', message: `Out-of-office reply to ${address} failed`, detail: e.message, accountId: account.id });
    }
  }
  if (changed) write(uKey, account.id, { ...load(uKey, account.id), repliedTo: [...replied] });
}

/** The account's default identity, so the reply goes out under the same name
 *  the user writes from (filters.js#identityIdForCurrentAccount, same rule). */
function identityFor(accountId) {
  const ids = store.getIdentities();
  return (ids.find((i) => i.accountId === accountId && i.default) || ids.find((i) => i.accountId === accountId))?.id;
}
