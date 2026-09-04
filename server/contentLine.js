// Hmelj — the content-line grammar iCalendar and vCard share.
//
// RFC 5545 (iCalendar) and RFC 6350 (vCard) are the same syntax with different
// vocabularies: folded lines of `NAME;PARAM=value:value`, the same four TEXT
// escapes, the same 75-octet fold. Both halves of Hmelj that speak those
// formats need all four functions below, and server/vcard.js's header has said
// since it was written that the arrival of an iCalendar SERIALIZER would be the
// moment to extract them. This is that moment.
//
// What is deliberately NOT here: parsing a line's HEAD. The two formats differ
// there — vCard 2.1 allows a bare parameter (`TEL;WORK;VOICE:`) and property groups
// (`item1.EMAIL:`), iCalendar allows neither — and pretending otherwise would
// mean one parser that is slightly wrong for both. Each keeps its own; see
// vcard.js#parseContentLine and icalendar.js#parseLine.
//
// Pure, no imports.

/** Unfolds RFC 5545 §3.1 / RFC 6350 §3.2 line folding: a CRLF followed by one
 *  space or tab is a continuation, not a new line. Done before anything else,
 *  or a long LOCATION arrives in pieces. */
export function unfold(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

/** `\,` `\;` `\n` `\\` — the TEXT escaping both specs define identically. */
export function unescapeText(v) {
  return String(v || '').replace(/\\([\\;,nN])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** The inverse. Backslash FIRST, or every escape this adds gets escaped again
 *  by the passes after it. */
export function escapeText(v) {
  return String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

/**
 * Folds a line to at most 75 OCTETS, continuations prefixed with one space.
 *
 * Octets, not characters, and the split must never land inside a UTF-8
 * sequence — a summary reading "Sestanek z Jožefo" folded by character count
 * arrives at the other end with a replacement character in the middle of it,
 * and servers do reject the malformed result. The backtrack below walks off any
 * continuation byte (`10xxxxxx`) before cutting.
 */
export function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  while (start < bytes.length) {
    // 75 octets per physical line — a continuation spends one of them on its
    // leading space.
    const limit = parts.length === 0 ? 75 : 74;
    let end = Math.min(start + limit, bytes.length);
    while (end > start + 1 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push((parts.length ? ' ' : '') + bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return parts.join('\r\n');
}
