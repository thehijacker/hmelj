// Hmelj — conversation (thread) keys.
//
// One value per message, computed once when it is cached and never
// recomputed: every message of one conversation must independently derive the
// SAME key, in whatever order they happen to be fetched (a folder backfills
// newest-first, so a reply is routinely cached before the message it replies
// to). That rules out "look up my parent's thread and join it", and is why the
// key is the conversation's ROOT message-id rather than anything relational:
//
//   References: <root> <reply1> <reply2>
//
// RFC 5322 defines References as the parent's References plus the parent's own
// Message-ID, in order — so element [0] is the root for every message in the
// chain, and each one can answer "which conversation am I in?" alone.
//
// Deliberately header-only. Merging by normalized subject ("Re: Račun" ==
// "Račun") would rescue chains from clients that strip References, at the cost
// of grouping genuinely unrelated mail that happens to share a subject — the
// single most common way threading in a mail client goes visibly wrong. Not
// worth it.
//
// No imports, and nothing here touches the database or the network: the same
// reasoning as searchQuery.js and unifiedMerge.js, so it can be unit-tested on
// its own (see test/threading-key-test.mjs).

/** `<Foo@Bar.com>` → `foo@bar.com`. Message ids are compared case-insensitively
 *  here; the RFC's local part is technically case-sensitive, but no mail client
 *  in the wild generates two ids differing only in case, and a sender that
 *  quotes the id back with different casing is a real (if rare) occurrence. */
export function normalizeId(id) {
  if (!id) return '';
  const s = String(id).trim().replace(/^<+|>+$/g, '').trim();
  return s ? s.toLowerCase() : '';
}

const REF_RE = /<[^<>]+>/;

/**
 * The FIRST message id in a `References:` header value — the conversation
 * root. Takes the header VALUE, not the whole header block.
 *
 * The no-angle-brackets fallback covers two real cases with one line: a
 * malformed References header from a sloppy client (they exist), and a caller
 * that has already extracted and normalized the root and is passing that
 * straight back in (imapClient.js does exactly this).
 */
export function firstReferenceIn(value) {
  if (!value) return '';
  const s = String(value).trim();
  const m = s.match(REF_RE);
  if (m) return normalizeId(m[0]);
  return normalizeId(s.split(/[\s,]+/)[0]);
}

/**
 * Pulls `References:` out of a raw header block (what IMAP's
 * BODY.PEEK[HEADER.FIELDS (…)] hands back) and returns the root id.
 *
 * Handles folding: RFC 5322 lets a long References header — and they are
 * always long — continue on any number of lines that begin with whitespace,
 * which is the normal case rather than the exception here.
 */
export function firstReference(headers) {
  if (!headers) return '';
  const text = Buffer.isBuffer(headers) ? headers.toString('utf8') : String(headers);
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^references\s*:/i.test(lines[i])) continue;
    let value = lines[i].slice(lines[i].indexOf(':') + 1);
    // Only the FIRST id is wanted, but it can be split across the fold — so
    // gather continuation lines until one of them yields a complete <…>.
    for (let j = i + 1; j < lines.length && /^[ \t]/.test(lines[j]) && !REF_RE.test(value); j++) {
      value += ' ' + lines[j].trim();
    }
    return firstReferenceIn(value);
  }
  return '';
}

/**
 * The conversation key for one message.
 *
 * `conversationId` short-circuits everything else: Exchange and Graph do their
 * own server-side conversation grouping, which is strictly better than
 * anything reconstructed from headers (it survives subject changes, stripped
 * References and messages moved between folders). Prefixed so it can never
 * collide with a message id.
 *
 * Otherwise, in order: the References root, the parent's id (a direct reply
 * whose sender dropped References — still correct for a two-message
 * conversation, which is most of them), and finally the message's own id,
 * which makes a message with no relations a conversation of one.
 *
 * Returns '' when there is nothing at all to key on — the caller stores NULL
 * and the query layer treats that as a thread of one (see cache.js).
 */
export function threadKeyFrom({ messageId, inReplyTo, references, conversationId } = {}) {
  if (conversationId) return 'c:' + String(conversationId).trim();
  return firstReferenceIn(references) || normalizeId(inReplyTo) || normalizeId(messageId);
}
