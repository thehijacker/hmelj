// Hmelj — shared search-query parser: turns the search box's raw text into structured
// required/excluded terms, each optionally scoped to one field. Consumed by both
// server/imapClient.js (IMAP SEARCH) and server/ewsClient.js (EWS Restriction XML) so
// both backends understand the exact same syntax, and by public/js/app.js's search
// input for the placeholder/hint text (kept in sync manually, see that file).
//
// Supported syntax:
//   word              - required: must appear in subject/from/to (NOT body — see below)
//   +word             - required, explicit (same as a bare word — some people just
//                       like typing the + for symmetry with -)
//   -word             - excluded: must NOT appear
//   "exact phrase"    - required, matched as one literal phrase (spaces included,
//                       not split into separate words)
//   -"exact phrase"   - excluded phrase
//   field:word        - scoped to exactly one field instead of "anywhere": from, to,
//                       subject, or body. Composes with +/- and quoting, e.g.
//                       -from:newsletter, subject:"weekly report", -subject:"out of office"
//   is:starred        - flag predicate, not text: starred/flagged mail only, searched
//                       LIVE across every folder rather than from the cache. Handled by
//                       extractStarredTerm below, not by parseSearchQuery.
//
// Bare/unscoped terms are implicitly ANDed together (Gmail-style): "hello world" now
// means "contains hello AND contains world" (anywhere in subject/from/to), not the
// single literal substring "hello world" the previous implementation treated the whole
// query as — wrap it in quotes ("hello world") to get that literal-phrase behavior back.
//
// Unscoped terms deliberately do NOT search message bodies — only field:'body' does
// (body:word / -body:word). Bodies are never cached (see cache.js), so a body: term is
// the one thing that always forces a slow live IMAP/EWS round-trip; everything else can
// be answered from the local cache. queryNeedsBodySearch() below is how a caller checks
// whether a given query needs that live path at all.
//
// An unrecognized "word:" prefix (anything other than from/to/subject/body — e.g. a URL
// like http://example.com, or a literal time like 10:30) is NOT treated as a field
// scope at all; it's kept as plain text exactly as typed, so it still matches literally
// rather than silently losing everything before its colon.

const FIELD_NAMES = new Set(['from', 'to', 'subject', 'body']);

// `is:starred` (alias `is:flagged`) — not a text term at all but a flag predicate, and
// the one search term answered LIVE from every mailbox rather than from the local
// cache (server/index.js#starredLive). The cache only ever holds each folder's newest
// syncBackfillLimit messages, so the ★ toolbar filter that reads it cannot see a star
// put on a two-year-old thread; this term exists precisely to find those.
//
// It's split off the raw query BEFORE parseSearchQuery ever sees it, so every existing
// consumer — the IMAP/EWS/Graph criteria builders and cache.js's SQL builder — goes on
// receiving only the text part and needs to know nothing about it. Whatever else was
// typed alongside still applies normally, so `is:starred invoice` means "starred AND
// mentions invoice".
//
// Only the unnegated form is recognized: the character before `is:` has to be
// whitespace or start-of-string, so `-is:starred` never matches here and falls through
// to parseSearchQuery as an unrecognized "word:" prefix, staying literal text exactly
// like http:// or 10:30 do. Excluding starred mail isn't supported — better that it
// visibly matches nothing than that it silently widen the search back out.
const STARRED_TERM_RE = /(^|\s)is:(starred|flagged)(?=\s|$)/gi;

/**
 * Splits any `is:starred` term off a raw query.
 * @returns {{starred: boolean, rest: string}} `rest` is the query with those terms
 *   removed (and whitespace tidied), ready to hand to parseSearchQuery as usual.
 */
export function extractStarredTerm(raw) {
  const s = String(raw || '');
  if (!s) return { starred: false, rest: '' };
  let starred = false;
  // The leading (^|\s) is part of the match, so it has to be put back — otherwise
  // `alpha is:starred beta` would come out as `alphabeta`.
  const rest = s.replace(STARRED_TERM_RE, (_m, pre) => { starred = true; return pre; })
    .replace(/\s+/g, ' ').trim();
  return { starred, rest };
}

// [+-]?            optional leading sign
// (?:([a-zA-Z]+):)? optional "word:" prefix — letters only, so "10:30"/URLs never even
//                    look like a field candidate to the regex in the first place
// (?:"([^"]*)"|(\S+)) the term itself: a "quoted phrase" (no escaping supported — keep
//                    it simple, matches this project's existing string-handling style
//                    elsewhere) or a run of non-whitespace
const TOKEN_RE = /([+-]?)(?:([a-zA-Z]+):)?(?:"([^"]*)"|(\S+))/g;

/** @returns {{required: {field: string|null, text: string}[], excluded: {field: string|null, text: string}[]}} */
export function parseSearchQuery(raw) {
  const required = [];
  const excluded = [];
  if (!raw || !raw.trim()) return { required, excluded };

  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(raw))) {
    const [, sign, fieldRaw, quoted, bare] = m;
    const rawText = quoted !== undefined ? quoted : bare;
    if (!rawText) continue; // a lone "+"/"-" with nothing after it, or empty ""
    const field = fieldRaw && FIELD_NAMES.has(fieldRaw.toLowerCase()) ? fieldRaw.toLowerCase() : null;
    // Recognized field prefix consumed the "field:" part already; an unrecognized one
    // (fieldRaw set but not a known field) needs putting back together with its colon.
    const text = field || !fieldRaw ? rawText : `${fieldRaw}:${rawText}`;
    (sign === '-' ? excluded : required).push({ field, text });
  }
  return { required, excluded };
}

/** True if `raw` contains any explicit body:/-body: term — the only thing that still
 *  needs a live IMAP/EWS round-trip, since message bodies are never cached (see
 *  cache.js). Checking `field === 'body'` alone is correct and complete here — NOT
 *  `|| field === null` — since an unscoped term no longer implies body search at all
 *  (see the header comment above). */
export function queryNeedsBodySearch(raw) {
  const { required, excluded } = parseSearchQuery(raw);
  return required.some((t) => t.field === 'body') || excluded.some((t) => t.field === 'body');
}
