// Hmelj — repairing a transfer encoding a sender declared but did not apply.
//
// mailparser decodes each MIME part according to its own
// Content-Transfer-Encoding header. When a sender writes quoted-printable into
// a part it labelled 7bit or 8bit, nothing decodes it and the body arrives as
// literal "=C5=A0e ne poznate" — which is not a parser bug anybody can fix
// upstream, only compensate for.
//
// Found on a live instance: 14 of 2256 cached messages, always the text/plain
// half of a multipart/alternative whose HTML half decoded perfectly. All from
// bulk mailers. It never reached the reading pane (which prefers the HTML) but
// it did reach notification previews, and would reach a reply's quoted text or
// the pane itself the moment such a message arrived without an HTML part.
//
// The whole risk here is a FALSE positive: mangling a message that merely
// contains "=A1" would be much worse than leaving an artefact alone, so
// looksQuotedPrintable is deliberately hard to satisfy and every caller gates
// on it. Pure, no imports — see test/notify-text-test.mjs.

/**
 * Undoes quoted-printable that reached us still encoded.
 *
 * `=C5=A0e ne poznate` in a live preview is a text part whose transfer encoding
 * was never applied — the sender declared one thing and did another, which no
 * parser can fix for it. Only attempted when there are at least two of these
 * AND they decode to valid UTF-8: a lone `=20` in ordinary prose (a price, a
 * formula) must not be mangled into a stray byte.
 */
export function decodeQuotedPrintable(s) {
  // A line ending in a bare '=' is a quoted-printable soft break in essentially
  // every real case, so those are joined even when the byte decoding below is
  // declined — leaving one turns "soft=\nbreak" into "soft= break".
  const unfolded = String(s).replace(/=\r?\n/g, '');
  const hits = unfolded.match(/=[0-9A-F]{2}/g);
  if (!hits || hits.length < 2) return unfolded;
  try {
    // Chunk-wise rather than character-wise: the whole text part goes through
    // here on every notification, and a per-character slice+regex over 100KB
    // was most of what this module cost.
    const parts = [];
    let last = 0;
    for (const m of unfolded.matchAll(/=([0-9A-F]{2})/g)) {
      if (m.index > last) parts.push(Buffer.from(unfolded.slice(last, m.index), 'utf8'));
      parts.push(Buffer.from([parseInt(m[1], 16)]));
      last = m.index + 3;
    }
    if (last < unfolded.length) parts.push(Buffer.from(unfolded.slice(last), 'utf8'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
  } catch {
    return unfolded; // not valid UTF-8 once decoded — it wasn't quoted-printable after all
  }
}

/**
 * Is this text a quoted-printable body that was never decoded?
 *
 * Built to be hard to satisfy, because a false positive DAMAGES a real message
 * — and the first version of this test proved that the hard way. Checked
 * against 2256 cached messages, a rule of "three =XX tokens, or a soft line
 * break" fired on 54 texts and corrupted 20 of them: a debug log's `pid=517`
 * became `pidQ7`, `git_sha=2940f9…` became `git_sha)40f9…`, and a bank's URL
 * `?doc=24030&SeS=19320…` picked up a `$` and a control character.
 *
 * What separates the real thing from all of those is the encoding's own
 * defining property: **a quoted-printable body is 7-bit ASCII.** Escaping the
 * bytes above 0x7F is the entire reason it exists, so a text that already
 * contains one is a text that was already decoded and merely happens to
 * contain something shaped like `=A1`. Every one of those 20 was Slovenian or
 * emoji-carrying text with its accents already in place.
 *
 * On top of that: at least three tokens standing for bytes >= 0x80, since
 * carrying those is the point. `=3D` and `=20` alone are how documentation
 * writes an escape.
 *
 * Never applied to HTML. There the same pattern is ordinary markup — an
 * unquoted attribute like `bgcolor=FF0000` matches `=FF` — and across those
 * 2256 messages not one HTML part needed it anyway.
 */
export function looksQuotedPrintable(s) {
  if (typeof s !== 'string' || !s) return false;
  if (/[^\x00-\x7f]/.test(s)) return false;
  const tokens = s.match(/=[0-9A-F]{2}/g);
  if (!tokens || tokens.length < 3) return false;
  return tokens.filter((t) => parseInt(t.slice(1), 16) >= 0x80).length >= 3;
}

/** C0 control characters that no decoded body should contain. Their appearance
 *  means the bytes were never quoted-printable — see the URL case above, where
 *  `=19` decoded to a control character in the middle of a query string. */
const STRAY_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

/**
 * The repair itself: decoded text, or the input untouched when this isn't
 * quoted-printable after all (including when the bytes don't form valid UTF-8,
 * which decodeQuotedPrintable checks).
 */
export function repairQuotedPrintable(s) {
  if (!looksQuotedPrintable(s)) return s;
  const out = decodeQuotedPrintable(s);
  if (typeof out !== 'string' || !out) return s;
  // Last check, after the fact: a decode that produced control characters
  // decoded something that was never encoded.
  if (STRAY_CONTROL.test(out)) return s;
  return out;
}
