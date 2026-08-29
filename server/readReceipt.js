// Hmelj — read receipts (RFC 3798 message disposition notifications).
//
// Only the SENDING half. A sender asks to be told when their message is read by
// putting a `Disposition-Notification-To:` header on it; every client then does
// as it pleases, because the RFC is explicit that a receipt is a courtesy, not
// an obligation. Hmelj's answer: never automatic, never silent — the message
// says who asked, and a button sends it.
//
// The MIME is written out by hand rather than composed with nodemailer. A
// receipt is a `multipart/report; report-type=disposition-notification`, whose
// second part is a `message/disposition-notification` — a structure
// MailComposer has no notion of, and the reason older attempts at this feature
// in other clients end up sending a plain email that no recipient recognises as
// a receipt. Hand-written also means it is a pure string function, and
// therefore testable (see test/read-receipt-test.mjs).
//
// No imports on purpose — same reasoning as searchQuery.js and threading.js.

/** RFC 2047 encoded-word, for a header value that isn't plain ASCII. */
export function encodeHeaderWord(value) {
  const s = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  if (!s || /^[\x20-\x7e]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

/** `Name <addr>` with the display name encoded if it needs it. */
export function formatAddress(address, name) {
  if (!name) return address;
  return `${encodeHeaderWord(name)} <${address}>`;
}

/** Anything that could smuggle a second header into one (CRLF injection). */
function headerSafe(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

/** base64 in 76-character lines, as MIME requires. */
function base64Lines(text) {
  return (Buffer.from(String(text), 'utf8').toString('base64').match(/.{1,76}/g) || []).join('\r\n');
}

/**
 * The receipt for one message, as a complete raw MIME string.
 *
 * `disposition` is deliberately fixed at manual-action/MDN-sent-manually:
 * nothing here is ever sent without the reader pressing the button, and saying
 * otherwise in a machine-readable field would be a lie about how this works.
 */
export function buildMdn({
  to,                 // where the sender asked the receipt to go
  from,               // the reading account's own address
  fromName = '',
  originalSubject = '',
  originalMessageId = '',
  originalDate = '',
  originalTo = '',    // the address the original was addressed to — the Final-Recipient
  messageId,          // this receipt's own Message-ID
  date = new Date(),
} = {}) {
  const boundary = '=_hmelj_mdn_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const subject = `Read: ${headerSafe(originalSubject) || '(no subject)'}`;
  const human = [
    `Your message was displayed on ${date.toUTCString()}.`,
    '',
    `  To:      ${headerSafe(originalTo) || headerSafe(from)}`,
    `  Subject: ${headerSafe(originalSubject) || '(no subject)'}`,
    originalDate ? `  Sent:    ${headerSafe(originalDate)}` : '',
    '',
    'This is a receipt for the message you sent. It says only that the message',
    'was opened — not that it was read, understood, or acted on.',
  ].filter((l) => l !== null).join('\r\n');

  // Note the deliberate absence of Disposition-Notification-To on the receipt
  // itself: a receipt that asks for a receipt is how mail loops start.
  const headers = [
    `From: ${formatAddress(headerSafe(from), headerSafe(fromName))}`,
    `To: ${headerSafe(to)}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${headerSafe(messageId)}`,
    originalMessageId ? `In-Reply-To: ${headerSafe(originalMessageId)}` : '',
    originalMessageId ? `References: ${headerSafe(originalMessageId)}` : '',
    'Auto-Submitted: auto-replied',
    'MIME-Version: 1.0',
    `Content-Type: multipart/report; report-type=disposition-notification;\r\n\tboundary="${boundary}"`,
  ].filter(Boolean);

  const notification = [
    'Reporting-UA: Hmelj; Hmelj webmail',
    `Final-Recipient: rfc822;${headerSafe(originalTo) || headerSafe(from)}`,
    originalMessageId ? `Original-Message-ID: ${headerSafe(originalMessageId)}` : '',
    'Disposition: manual-action/MDN-sent-manually; displayed',
  ].filter(Boolean);

  return [
    ...headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(human),
    '',
    `--${boundary}`,
    'Content-Type: message/disposition-notification',
    'Content-Transfer-Encoding: 7bit',
    '',
    ...notification,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/**
 * The address a `Disposition-Notification-To:` header actually names.
 *
 * mailparser hands address headers back as an object ({value:[{address,name}],
 * text, html}), not a string — printing one straight into the UI is where the
 * "[object Object]" in the read-receipt banner came from. Kept here rather than
 * in messageParse.js so both the display and the send agree on one answer.
 */
export function receiptAddressOf(header) {
  if (!header) return '';
  if (typeof header === 'string') {
    const m = header.match(/<([^>]+)>/);
    return (m ? m[1] : header).trim();
  }
  const first = header.value?.[0];
  if (first?.address) return String(first.address).trim();
  if (typeof header.text === 'string') return receiptAddressOf(header.text);
  return '';
}
