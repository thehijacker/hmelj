// Hmelj — shared raw-MIME parsing, used by every mail protocol client.
//
// Everything here operates on a raw RFC822 Buffer (mailparser's job) plus,
// for the full-message case, whatever flags the protocol already resolved —
// nothing IMAP-specific. imapClient.js's getMessageSource() fetches that
// buffer via BODY[]; ewsClient.js's own getMessageSource() fetches the same
// shape via GetItem's item:MimeContent field. Both clients' getMessage/
// getMessageHeaders/getAttachment are thin wrappers: fetch the source, hand
// it to the functions below. Keeping this in one place means a fix to, say,
// the inline-image cid detection benefits both protocols at once instead of
// drifting between two copies.
import { simpleParser } from 'mailparser';
import { receiptAddressOf } from './readReceipt.js';
import { parseListUnsubscribe, rawHeaderValue } from './unsubscribe.js';
import { repairQuotedPrintable } from './transferEncoding.js';
import { parseInvitation } from './icalendar.js';
import { readAuthResults } from './authResults.js';

/**
 * Full parsed message (subject/from/to/body/attachments/…) from a raw
 * source buffer plus whatever flags (\Seen, \Flagged, …) the caller already
 * has — callers add their own `uid` to the result themselves, since this
 * module has no notion of message identity, only content.
 *
 * `authservId` is the optional per-account name of the mail server whose
 * authentication verdict to trust; without it the topmost one is used, which is
 * right whenever Hmelj reads a mailbox on the server that did the checking.
 */
export async function parseMessage(source, flags, { authservId = '' } = {}) {
  const parsed = await simpleParser(source);
  // Content-Disposition:inline + a Content-ID header is the usual signal
  // for "this is an embedded image, not a real attachment," but some
  // senders (Gmail's own Sent-folder copies of composed mail among them)
  // don't set that combination consistently even when the image really is
  // referenced inline in the body. `inlineUsed` instead trusts two things
  // that actually reflect reality: mailparser's own `related` flag (true
  // when this part's parent MIME node is multipart/related — the correct
  // structural signal for "embedded content," independent of whatever
  // disposition/id headers this particular sender did or didn't set) OR —
  // belt and suspenders — the message HTML literally referencing this
  // exact cid.
  const htmlLower = (parsed.html || '').toLowerCase();
  const attachments = (parsed.attachments || []).map((a, i) => {
    const cid = a.cid || null;
    const referencedInHtml = !!(cid && htmlLower.includes('cid:' + cid.toLowerCase()));
    return {
      index: i,
      filename: a.filename || `attachment-${i}`,
      contentType: a.contentType,
      size: a.size,
      cid,
      inline: a.contentDisposition === 'inline',
      inlineUsed: !!a.related || referencedInHtml,
    };
  });
  // A meeting invitation is an ordinary message carrying a text/calendar part
  // (RFC 6047). Read here so all three protocols get it from one place — EWS
  // and Graph both hand over the whole raw MIME, exactly like IMAP does.
  // Never fatal: a calendar part this can't read is still an attachment, and
  // the message still opens.
  let invitation = null;
  const calPart = (parsed.attachments || []).find((a) => /^text\/calendar/i.test(a.contentType || ''));
  if (calPart?.content) {
    try { invitation = parseInvitation(calPart.content.toString('utf8')); }
    catch { invitation = null; }
  }

  return {
    invitation,
    subject: parsed.subject || '(no subject)',
    from: parsed.from?.value || [],
    to: parsed.to?.value || [],
    cc: parsed.cc?.value || [],
    replyTo: parsed.replyTo?.value || [],
    date: parsed.date || null,
    messageId: parsed.messageId || null,
    inReplyTo: parsed.inReplyTo || null,
    references: parsed.references || null,
    priority: parsed.priority || 'normal',
    html: parsed.html || null,
    // Repaired, not just passed through: a sender that writes quoted-printable
    // into a part it labelled 7bit leaves mailparser nothing to decode, and the
    // body arrives as literal "=C5=A0e ne poznate". Gated hard — see
    // server/transferEncoding.js for what a false positive costs. Only the text
    // part; the same pattern in HTML is ordinary markup.
    text: repairQuotedPrintable(parsed.text || '') || null,
    headers: {
      // Flattened to a plain address here, not left as mailparser's address
      // OBJECT ({value:[…], text, html}): this goes to the browser, which put it
      // straight into the read-receipt banner and rendered "[object Object]".
      dispositionNotificationTo: receiptAddressOf(parsed.headers.get('disposition-notification-to')) || null,
      // How to leave a newsletter (RFC 2369 / RFC 8058) — parsed here so the
      // reading pane gets one clean shape and never has to read a raw header.
      // See server/unsubscribe.js for what the shape means and what is refused.
      listUnsubscribe: parseListUnsubscribe(
        rawHeaderValue(parsed.headerLines, 'list-unsubscribe'),
        rawHeaderValue(parsed.headerLines, 'list-unsubscribe-post'),
      ),
      // Did this really come from where it says? (server/authResults.js.)
      // Fed headerLines rather than the parsed header map on purpose: that map
      // collapses repeated headers, and WHICH Authentication-Results came first
      // is the entire basis for trusting one of them — the receiving server
      // writes its verdict on top of whatever the sender already put there.
      auth: readAuthResults(parsed.headerLines, { authservId }),
      // What an auto-responder must check before answering (RFC 3834) — read
      // by server/outOfOffice.js#mayAnswer, never shown.
      autoSubmitted: rawHeaderValue(parsed.headerLines, 'auto-submitted') || null,
      precedence: rawHeaderValue(parsed.headerLines, 'precedence') || null,
      listId: rawHeaderValue(parsed.headerLines, 'list-id') || null,
      listUnsubscribeRaw: rawHeaderValue(parsed.headerLines, 'list-unsubscribe') || null,
      xAutoResponseSuppress: rawHeaderValue(parsed.headerLines, 'x-auto-response-suppress') || null,
      returnPathEmpty: /^\s*<\s*>\s*$/.test(rawHeaderValue(parsed.headerLines, 'return-path') || ''),
    },
    attachments,
    flags: [...(flags || [])],
  };
}

/**
 * Raw headers for the "View headers" dialog — pulled straight from the
 * message source (everything before the first blank line) rather than from
 * mailparser's parsed representation, since that restructures addresses
 * etc. into objects and isn't what a "copy raw headers" button should
 * produce. `raw` keeps the original folded-line formatting exactly as the
 * server sent it (for copy-to-clipboard); `list` unfolds continuation
 * lines (RFC 5322: a line starting with whitespace continues the previous
 * header) into simple {name, value} pairs for the table view.
 */
export function parseHeadersBlock(source) {
  const buf = Buffer.isBuffer(source) ? source : Buffer.from(source);
  const text = buf.toString('utf8');
  const boundary = text.indexOf('\r\n\r\n');
  const altBoundary = text.indexOf('\n\n');
  const end = boundary !== -1 ? boundary : (altBoundary !== -1 ? altBoundary : text.length);
  const raw = text.slice(0, end);
  const list = [];
  for (const line of raw.split(/\r\n|\n/)) {
    if (/^[ \t]/.test(line) && list.length) {
      list[list.length - 1].value += ' ' + line.trim();
    } else {
      const i = line.indexOf(':');
      if (i === -1) continue;
      list.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
    }
  }
  return { raw, list };
}

/** One attachment's content, by its index into parseMessage()'s `attachments` array. */
export async function parseAttachment(source, index) {
  const parsed = await simpleParser(source);
  const a = (parsed.attachments || [])[index];
  if (!a) throw new Error('Attachment not found');
  return { filename: a.filename || `attachment-${index}`, contentType: a.contentType, content: a.content };
}
