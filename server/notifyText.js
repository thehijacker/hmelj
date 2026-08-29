// Hmelj — turning a message into the one line of plain text a notification
// shows under its subject.
//
// This is not "strip the tags". Measured over 793 real cached messages on a
// live instance, the old one-liner (`msg.text || sanitizeHtml(html, {
// allowedTags: [] })`) produced:
//
//   36  previews of raw HTML       — "<tr> <td valign="top" id="templateHeader"…"
//   42  with [bracket] markers     — "[https://…/logo.png]", "[Vitapur](https://…)"
//    5  with undecoded entities    — "stationery supplies &amp; more"
//        plus CSS rule blocks, quoted-printable that was never decoded
//        ("=C5=A0e ne poznate"), and walls of zero-width padding characters
//        that newsletters use to control the inbox preview line.
//
// Every one of those comes from the SAME wrong assumption: that a message's
// text/plain part is plain text. Often it isn't — a mailer's "text alternative"
// is regularly the HTML template verbatim, a markdown-ish rendering, or a
// stylesheet. So the plain part is a candidate here, not the answer: it is
// cleaned, and if what comes out still looks like markup the HTML is used
// instead.
//
// Pure apart from one import (server/transferEncoding.js, itself pure) — same
// reasoning as searchQuery.js / threading.js / refile.js:
// the point is to be able to run it over a few hundred real messages and count
// what comes out (test/notify-text-test.mjs).

import { repairQuotedPrintable } from './transferEncoding.js';

/** Zero-width and bidi characters. Newsletters pad their preheader with
 *  hundreds of these to control what an inbox list shows; they are invisible in
 *  the mail and a wall of nothing in a notification. */
const INVISIBLE = /[\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g;

/** How much of a body is worth looking at for a 140-character preview. */
const MAX_SCAN = 20000;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  bull: '•', middot: '·', euro: '€', pound: '£', copy: '©', reg: '®', trade: '™',
  zwnj: '', zwj: '', ensp: ' ', emsp: ' ', thinsp: ' ',
};

/** `&amp;` → `&`. Needed even on the HTML path: sanitize-html ESCAPES its text
 *  output, so stripping tags hands back `&amp;` where the mail said `&`. */
export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      // Anything outside Unicode, or a control character, is not something a
      // person meant to read.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      if (code < 32 && code !== 9 && code !== 10) return '';
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? m : named;
  });
}


/** Does this still look like markup rather than something to read? */
export function looksLikeMarkup(s) {
  // Only the opening: a body that starts as prose and quotes a tag further down
  // is prose. Bounding the input also bounds the regexes below, which matters —
  // an earlier version of the CSS test was `[^{}]*\{[^{}]*:[^{}]*`, whose
  // nested unbounded quantifiers backtracked so badly on a long brace-free body
  // that this one function cost 7 SECONDS across 793 messages. Every quantifier
  // here is bounded, and the cheap `includes` guard runs first.
  const str = String(s).slice(0, 2000);
  if (/<\/?(html|body|table|tr|td|div|span|p|img|a|style|head|meta|font)\b[^>]*>/i.test(str)) return true;
  // A CSS rule block: a selector, then declarations. Mailers put their whole
  // stylesheet in the "plain text" part more often than seems believable.
  if (!str.includes('{')) return false;
  return /\{[^{}]{0,300}(padding|margin|font|color|width|display)\s*:[^{}]{0,300}\}/i.test(str);
}

/**
 * The link and image markers a text-alternative generator leaves behind.
 *
 * Three separate conventions, all seen in one mailbox:
 *   [image: Logo] / [https://host/logo.png]   an image, standing in for nothing
 *   [Akcije](https://akcije.example/)         markdown — the label is the text
 *   Best Regards<https://www.example.net/>    html-to-text's link suffix
 */
export function stripLinkMarkers(s) {
  return String(s)
    // Markdown link: keep the label, drop the target.
    .replace(/\[([^\]]{1,80})\]\((?:https?|mailto):[^)\s]*\)/gi, '$1')
    // A bracketed URL or cid/image marker is a picture, not a sentence.
    .replace(/\[\s*(?:image|cid)\s*:[^\]]*\]/gi, ' ')
    .replace(/\[\s*(?:https?|cid|data):[^\]]*\]/gi, ' ')
    // html-to-text's <https://…> suffix after the link's own text.
    .replace(/<\s*(?:https?|mailto):[^>\s]*\s*>/gi, ' ')
    // What the two above leave behind: a bracket pair with nothing in it any
    // more, and the placeholder for an image that had no alt text at all.
    .replace(/\[\s*[?]?\s*\]/g, ' ');
}

/**
 * HTML comments, and the conditional-comment scaffolding Outlook templates are
 * built out of. These turn up in TEXT parts too, not just HTML — which is how
 * "<! [if !mso]><!" ended up in real notifications.
 */
export function stripComments(s) {
  return String(s)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[[^\]]*\]\s*(?:-->)?/g, ' ')
    .replace(/<!--?\s*>?/g, ' ');
}

/** CSS rule blocks that leaked into a text part. */
export function stripCssBlocks(s) {
  const str = String(s);
  if (!str.includes('{')) return str; // the overwhelmingly common case, and free
  // Every quantifier bounded — see looksLikeMarkup for what an unbounded one
  // cost here.
  return str.replace(/(^|[\s>])[^{}<>]{0,160}\{[^{}]{0,300}:[^{}]{0,300}\}/g, '$1 ');
}

/**
 * One candidate string, cleaned as far as it goes. Order matters: tags come off
 * before entities are decoded (or `&lt;b&gt;` would become a tag nobody wrote),
 * and markers come off before whitespace is collapsed.
 */
export function cleanCandidate(raw, { stripTags = false } = {}) {
  let s = String(raw || '');
  if (!s) return '';
  // A preview is 140 characters; nothing past the first few thousand can reach
  // it. Capped before the expensive passes below rather than after, because
  // some of these bodies are 100KB+ and this runs per new message. Generous
  // enough to survive a newsletter's preheader padding, which really can be a
  // thousand invisible characters before the first real word.
  if (s.length > MAX_SCAN) s = s.slice(0, MAX_SCAN);
  // Gated (repairQuotedPrintable, not the raw decode): the same false positives
  // that would corrupt a stored message would corrupt its preview.
  s = repairQuotedPrintable(s);
  s = stripComments(s);
  if (stripTags) s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(INVISIBLE, '').replace(/\u00a0/g, ' ');
  // Collapsed HERE, before the markers are matched, not only at the end: a
  // markdown link or a bracketed URL that the sender wrapped across two lines
  // would otherwise never match its own pattern.
  s = s.replace(/\s+/g, ' ');
  s = stripCssBlocks(s);
  s = stripLinkMarkers(s);
  // A run of punctuation left behind by everything removed above reads as
  // damage; a single separator does not.
  s = s.replace(/([|·•>-]\s*){2,}/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * The preview line for a notification.
 *
 * `htmlToText` is passed in rather than imported so this module stays pure —
 * server/sync.js hands it sanitize-html, which is already a dependency there.
 * Without one, only the text part is considered.
 */
export function previewText(msg, { maxLen = 140, htmlToText = null } = {}) {
  const fromText = cleanCandidate(msg?.text, { stripTags: false });
  let best = looksLikeMarkup(fromText) ? '' : fromText;
  // Either the text part was unusable, or there wasn't one. The HTML is the
  // better source often enough that it is worth the conversion.
  if (!best && msg?.html && htmlToText) {
    best = cleanCandidate(htmlToText(msg.html), { stripTags: true });
  }
  // Last resort: the text part was markup, and there is no HTML to fall back on
  // (or converting it produced nothing). Strip its tags and take what is left
  // rather than showing the subject alone.
  if (!best && fromText) best = cleanCandidate(msg.text, { stripTags: true });
  if (!best) return '';
  if (best.length <= maxLen) return best;
  // Cut at a word boundary when there is one nearby, so a preview never ends
  // mid-word for the sake of four characters.
  const cut = best.slice(0, maxLen);
  const space = cut.lastIndexOf(' ');
  return (space > maxLen - 24 ? cut.slice(0, space) : cut).trimEnd() + '…';
}
