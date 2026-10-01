import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { config } from './config.js';
import { store } from './store.js';
import { appendMessage } from './mailClient.js';
import { sendRaw as ewsSendRaw } from './ewsClient.js';
import { sendRaw as graphSendRaw } from './graphClient.js';
import { runAsAccount, userKey } from './session.js';
import { resolveAccountForSending, listAccounts } from './accounts.js';
import * as sync from './sync.js';
import * as cache from './cache.js';
import * as events from './events.js';
// Only for an account that signs in instead of storing a password (Gmail).
import * as oauth from './oauth.js';

/* When to re-check the Sent folder after a send, in ms from the moment the
 * send finished — follow-ups to refreshSentFolder's own immediate pass. Ends
 * well inside the background poll's default 120s interval, which is the
 * backstop if every one of these still comes up empty. */
const SENT_REFRESH_RETRY_DELAYS = [3000, 8000, 20000];
/** How deep each retry re-lists the Sent folder (the first pass keeps
 * syncFolderNow's own default) — see the call site for why the top 50 by date
 * is enough for "did the copy appear yet?". */
const SENT_REFRESH_RETRY_LIMIT = 50;

/**
 * Makes the message that was just sent actually appear in Sent, instead of
 * only showing up whenever the next background poll happens to run (up to
 * ~2 min later).
 *
 * A single immediate sync — which is all this used to do — assumes the copy is
 * already fetchable the instant the send call returns. Observed in practice
 * (real IMAP account, 2026-08-17): it often isn't. The sync ran ~0.6s after
 * submit, listed the folder, and reported "200 fetched, 0 new" — the copy
 * simply wasn't in that listing yet — and Sent then stayed stale until the
 * next background poll minutes later. Several mechanisms produce that same
 * shape, and this doesn't need to distinguish between them: an APPEND the
 * server hasn't made visible to a SEARCH yet, a submission service that files
 * the copy itself a beat later, or a provider that saves it entirely on its
 * own schedule (Gmail's SMTP relay — see the isGmailSmtp note in sendMail —
 * plus EWS's SendAndSaveCopy and Graph's sendMail, none of which we append
 * for at all).
 *
 * So the immediate pass is followed by a few more on a backoff, stopping as
 * soon as the folder actually gains a cached message row. Open tabs are told
 * to reconcile when that happens, so the message appears by itself without
 * anyone reloading.
 *
 * The follow-ups are deliberately NOT awaited: the sender already has their
 * response (/api/send answers as soon as the request validates), and the
 * route's own post-send broadcast must not sit and wait ~30s for retries that
 * usually turn out to be unnecessary.
 */
async function refreshSentFolder(ownerUser, acc) {
  if (!config.cacheEnabled) return;
  const uKey = userKey(ownerUser.username);
  // Cached ROWS, not the folder's server-side total. The total comes from a
  // STATUS that syncFolderNow issues *after* its message fetch, so it can
  // already count a copy the fetch a moment earlier didn't return — which
  // would read as "landed", end the retries, and leave the message invisible
  // in exactly the case these retries exist for. The row count is what the
  // list actually renders from, so it can't lie in that direction.
  const rows = () => cache.countRows(uKey, acc.id, acc.sentFolder);
  const before = rows();
  const syncOnce = async (limit) => {
    try {
      await runAsAccount(ownerUser, acc.id, () => sync.syncFolderNow(uKey, acc, acc.sentFolder, limit ? { limit } : {}), { purpose: 'sync' });
    } catch (e) {
      // Never fails the send — a Sent copy that can't be *shown* yet is a
      // cosmetic problem; the message itself is already delivered.
      console.warn('Could not refresh Sent folder cache:', e.message);
    }
  };
  const landed = () => rows() > before;

  await syncOnce();
  if (landed()) return;

  (async () => {
    let waited = 0;
    for (const at of SENT_REFRESH_RETRY_DELAYS) {
      await new Promise((r) => setTimeout(r, at - waited));
      waited = at;
      // A narrower window than the first pass: the copy we're waiting for is
      // by definition the newest message in the folder, so re-listing the top
      // 50 by date is enough, and each retry then costs a fraction of a full
      // 200-envelope re-fetch. pollFolder skips its prune below the configured
      // depth (see its own note), so a truncated pass like this is safe.
      await syncOnce(SENT_REFRESH_RETRY_LIMIT);
      if (landed()) {
        // Reaches the account's owner AND everyone it's shared with, same as
        // /api/send's own broadcast (see events.js#broadcastForAccount).
        events.broadcastForAccount(uKey, acc.id);
        return;
      }
    }
  })().catch((e) => console.warn('Sent folder re-check failed:', e.message));
}

/**
 * `ownerUser` is the account's owner (not necessarily the sender — a grantee can
 * send through a shared account's identity), because that's whose stored tokens
 * get spent and rotated. Async only for the OAuth case: an account with an
 * `oauth` block authenticates with a bearer token instead of a password (Gmail),
 * and unlike a password that token has to be minted/refreshed per send.
 */
async function transporter(acc, ownerUser) {
  const auth = acc.oauth
    ? {
      // nodemailer needs type:'OAuth2' spelled out; handed an accessToken it
      // uses XOAUTH2 and never tries to run a refresh of its own (which it
      // couldn't — it has no client credentials here).
      type: 'OAuth2',
      user: acc.smtp.user,
      accessToken: await oauth.accessTokenFor(acc, userKey(ownerUser.username)),
    }
    : { user: acc.smtp.user, pass: acc.smtp.pass };
  return nodemailer.createTransport({
    host: acc.smtp.host,
    port: acc.smtp.port,
    secure: acc.smtp.secure,
    auth,
    tls: { rejectUnauthorized: acc.imap.tlsRejectUnauthorized },
  });
}

/** Which mail account an identity sends through (falls back to the first
 * enabled account) — resolveAccountForSending handles a shared account's
 * identity transparently (see its own comment in accounts.js): the sending
 * account here is picked by identityId, not a `?account=` query param, so
 * the usual per-request ownership swap (session.js's requireAuth) never
 * gets a chance to run for it. */
function accountForIdentity(identity) {
  if (identity?.accountId) return resolveAccountForSending(identity.accountId);
  const first = listAccounts().find((a) => !a.disabled);
  if (!first) throw new Error('No mail account configured');
  return resolveAccountForSending(first.id);
}

/** No I/O beyond decrypting an already-loaded local record — cheap enough to
 * run synchronously in a request handler before deciding to respond. Split
 * out of sendMail() so server/index.js's /api/send route can resolve (and
 * validate) the account up front, before backgrounding the actual send.
 * `ownerUser` ({id, username}) must be threaded through to
 * every IMAP/EWS-touching call below (runAsAccount, not runWithAccount) —
 * for a shared account it's its owner, not whoever's sending. */
export function resolveIdentityAndAccount(payload) {
  const identities = store.getIdentities();
  const identity =
    identities.find((i) => i.id === payload.identityId) ||
    identities.find((i) => i.default) ||
    identities[0];
  const { acc, ownerUser } = accountForIdentity(identity);
  return { identity, acc, ownerUser };
}

/**
 * payload: { identityId, to, cc, bcc, subject, html, text, priority, readReceipt,
 *            inReplyTo, references, attachments: [{filename, contentBase64, contentType}] }
 */
export async function sendMail(payload) {
  const { identity, acc, ownerUser } = resolveIdentityAndAccount(payload);
  const from = identity || { name: '', email: acc.email, replyTo: '', organization: '' };

  const mail = {
    from: from.name ? { name: from.name, address: from.email } : from.email,
    to: payload.to,
    cc: payload.cc || undefined,
    bcc: payload.bcc || undefined,
    subject: payload.subject || '',
    replyTo: from.replyTo || undefined,
    inReplyTo: payload.inReplyTo || undefined,
    references: payload.references || undefined,
    // Minted by /api/send (index.js) rather than left to nodemailer, so the id
    // is known BEFORE the message goes out — and the same on all three
    // backends, since EWS and Graph build their MIME from this same object
    // (buildRaw) yet hand back an item id, not a Message-ID. A follow-up
    // reminder (server/followUps.js) finds the reply by it.
    messageId: payload.messageId || undefined,
    headers: {},
    attachments: (payload.attachments || []).map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.contentBase64, 'base64'),
      contentType: a.contentType || undefined,
      // Set by an image pasted or dropped into the composer body, and by a
      // filter's `redirect` (see filters.js), which carries the original inline
      // image's Content-ID through so the forwarded HTML's `cid:` references
      // still resolve. Undefined for an ordinary file attachment, which is what
      // makes nodemailer treat that one as a normal attached file.
      cid: a.cid || undefined,
    })),
  };

  if (payload.html) {
    mail.html = payload.html;
    mail.text = payload.text || undefined;
  } else {
    mail.text = payload.text || '';
  }

  if (from.organization) mail.headers['Organization'] = from.organization;

  const prio = payload.priority || 'normal';
  if (prio !== 'normal') {
    mail.priority = prio; // nodemailer sets X-Priority / Importance
  }

  if (payload.readReceipt) {
    mail.headers['Disposition-Notification-To'] = from.email;
    mail.headers['Return-Receipt-To'] = from.email;
  }

  // Every exit says whose CACHE the sent copy lands in: for a shared account
  // that is the owner's, not the sender's, and a follow-up reminder has to look
  // for the reply there (server/followUps.js).
  const tag = (r) => ({ ...r, ownerKey: userKey(ownerUser.username) });
  if (acc.type === 'ews') return tag(await sendMailEws(acc, mail, payload, ownerUser));
  if (acc.type === 'graph') return tag(await sendMailGraph(acc, mail, payload, ownerUser));

  const t = await transporter(acc, ownerUser);
  const info = await t.sendMail(mail);

  // Save a copy to the sending account's Sent folder via IMAP APPEND — but
  // NOT for Gmail's own SMTP relay. Gmail auto-saves (and labels \Sent) a
  // copy itself whenever a message is submitted through smtp.gmail.com by
  // the same account, so also manually appending here creates a second,
  // content-identical copy (same Message-ID) landing in the same label at
  // nearly the same time. Gmail's server-side dedup for that situation can
  // merge the two objects and drop the \Sent label from the result — this
  // is what caused real sent mail to vanish from the Sent view while still
  // being visible in the conversation thread (the message itself was never
  // deleted, just unlabeled). Providers other than Gmail don't auto-save a
  // Sent copy at all, so they still need the manual append below.
  const isGmailSmtp = /(^|\.)gmail\.com$/i.test(acc.smtp.host || '');
  if (!isGmailSmtp) try {
    const raw = await buildRaw(mail);
    await runAsAccount(ownerUser, acc.id, () => appendMessage(acc.sentFolder, raw, ['\\Seen']));
  } catch (e) {
    // Sent-copy failure should not fail the send
    console.warn('Could not save to Sent:', e.message);
  }

  // Covers both the manual append above (non-Gmail) and Gmail's own
  // server-side auto-save-to-Sent, which has no synchronous hook at all —
  // Gmail does it itself after SMTP submission, not via anything this code
  // calls, which is exactly the case refreshSentFolder's retries exist for.
  await refreshSentFolder(ownerUser, acc);

  return tag({ messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, accountId: acc.id });
}

/**
 * Exchange path: one EWS CreateItem(SendAndSaveCopy) call both delivers the
 * message and saves the Sent-folder copy — no separate transporter, no
 * Gmail-dedup-style special case, no manual append (see ewsClient.js#sendRaw
 * for why explicit to/cc/bcc are also required, not just the raw MIME).
 * `payload.to/cc/bcc` are the same comma-separated address strings the SMTP
 * path hands straight to nodemailer — reusing nodemailer's own address
 * parser here instead of writing a second one keeps quoted names/multiple
 * addresses/etc. behaving identically between both send paths.
 */
async function sendMailEws(acc, mail, payload, ownerUser) {
  const raw = await buildRaw(mail);
  const parseAddrs = (str) => (str ? addressparser(str, { flatten: true }).filter((a) => a.address) : []);
  const recipients = { to: parseAddrs(payload.to), cc: parseAddrs(payload.cc), bcc: parseAddrs(payload.bcc) };
  const result = await runAsAccount(ownerUser, acc.id, () => ewsSendRaw(raw, recipients));

  // The Sent-folder copy is saved by SendAndSaveCopy above, but on Exchange's
  // own schedule — so this needs the same refresh-with-retries as the other
  // provider-saves-it-itself paths (see refreshSentFolder).
  await refreshSentFolder(ownerUser, acc);

  const accepted = [...recipients.to, ...recipients.cc, ...recipients.bcc].map((a) => a.address);
  return { messageId: result.uid, accepted, rejected: [], accountId: acc.id };
}

/**
 * Microsoft Graph path: one POST /me/sendMail carrying the base64-encoded MIME
 * both delivers the message and saves the Sent Items copy — structurally the
 * same deal as EWS's SendAndSaveCopy, so again no transporter, no manual
 * append, no Gmail-style duplicate-copy special case. The explicit recipient
 * lists are passed through for the same reason they are on the EWS path: Bcc
 * is not in the compiled MIME, and graphClient.js#sendRaw has to put it back
 * as a header or Bcc recipients silently never receive anything.
 */
async function sendMailGraph(acc, mail, payload, ownerUser) {
  const raw = await buildRaw(mail);
  const parseAddrs = (str) => (str ? addressparser(str, { flatten: true }).filter((a) => a.address) : []);
  const recipients = { to: parseAddrs(payload.to), cc: parseAddrs(payload.cc), bcc: parseAddrs(payload.bcc) };
  const result = await runAsAccount(ownerUser, acc.id, () => graphSendRaw(raw, recipients));

  // Same as the EWS path: Graph saves the Sent copy itself, whenever it gets
  // to it — see refreshSentFolder for why one immediate sync isn't enough.
  await refreshSentFolder(ownerUser, acc);

  return { messageId: result.uid, accepted: result.accepted, rejected: [], accountId: acc.id };
}

/**
 * Sends an already-composed raw MIME message from one specific account.
 *
 * sendMail() above builds its MIME from a friendly payload; a read receipt is
 * the opposite case — a multipart/report whose exact structure IS the point
 * (see readReceipt.js), so it arrives here already written. Everything else is
 * the same three-way branch by account type, minus the Sent copy: a receipt is
 * a protocol acknowledgement, not correspondence, and filing it under Sent
 * would put a message the user never wrote in among the ones they did.
 */
export async function sendRawMessage({ accountId, ownerUser, raw, to }) {
  const acc = resolveAccountForSending(accountId).acc;
  const owner = ownerUser || resolveAccountForSending(accountId).ownerUser;
  const recipients = { to: [{ address: to }], cc: [], bcc: [] };
  if (acc.type === 'ews') return runAsAccount(owner, acc.id, () => ewsSendRaw(Buffer.from(raw), recipients));
  if (acc.type === 'graph') return runAsAccount(owner, acc.id, () => graphSendRaw(Buffer.from(raw), recipients));
  const t = await transporter(acc, owner);
  return t.sendMail({ envelope: { from: acc.email, to: [to] }, raw });
}

export async function buildRaw(mail) {
  const { default: MailComposer } = await import('nodemailer/lib/mail-composer/index.js');
  return new Promise((resolve, reject) => {
    new MailComposer(mail).compile().build((err, message) => (err ? reject(err) : resolve(message)));
  });
}
