// Hmelj — collapsing the quoted half of an HTML reply, server-side.
//
// A reply carries the whole conversation under it. Everything from the quote
// marker down is marked here and hidden behind a "⋯" button in the reading
// pane, so a message shows what was actually written this time — and a threaded
// conversation reads as a conversation instead of the same text N times.
//
// ── Why this runs on the server ──────────────────────────────────────────────
// It didn't, at first. The detection lived inside the message frame, where the
// browser's own DOM is — which seemed obviously right, since finding a quote
// means walking a parsed document. It was verified against 377 real cached
// messages (79% of replies) and still did nothing in an actual browser, twice,
// with no way to see why: the frame is sandboxed, so there is no console to
// read from the outside and no DOM to inspect from the parent.
//
// So it moved here. The parse is the same parse (htmlparser2, already a
// dependency via sanitize-html), the message HTML is already being processed on
// this side anyway (sanitizeMessageHtml), and — the point — the result can be
// tested exhaustively against real mail instead of hoped about. What is left in
// the frame is a click handler.
//
// ── Why the hiding is an inline style ────────────────────────────────────────
// A message arrives with its own stylesheet, which loads after Hmelj's. An
// inline `display:none !important` is the one thing it cannot outrank.
import { parseDocument } from 'htmlparser2';
import renderDom from 'dom-serializer';
import * as du from 'domutils';

/** Class on every hidden element. The frame's toggle looks for exactly this. */
export const QUOTE_CLASS = 'hmelj-quoted';
/** The button the frame's toggle listens on. */
export const TOGGLE_CLASS = 'hmelj-quote-toggle';

const HIDE_STYLE = 'display:none!important';

// Outlook — by far the most common shape in real corporate mail, and the one
// with nothing to select on: no blockquote, no class, no id, just a divider div
// wrapping "From: … Sent: … To: …". So it is recognised by its TEXT. Slovenian,
// German and French label sets alongside English, because that is what an
// Outlook in another locale writes.
const HDR_FIRST = /^(from|od|von|de|da|sender|pošiljatelj)\s*:/i;
const HDR_SECOND = /\b(sent|poslano|to|za|cc|subject|zadeva|gesendet|an|betreff|envoyé|date|datum)\s*:/i;

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const attr = (el, name) => (el.attribs && el.attribs[name]) || '';
const classesOf = (el) => attr(el, 'class').split(/\s+/).filter(Boolean);
const isTag = (n) => n && n.type === 'tag';

// Tags that put a visual break between what is on either side of them. Without
// this, `From: X<br><b>Sent:</b>` extracts as "From: XSent:" — one word — and
// the header-block test below stops matching, because \bsent has no word
// boundary in the middle of "XSent". Real Outlook happens to put newlines in
// its markup, which is the only reason that was not caught sooner.
const BREAKS = new Set(['br', 'p', 'div', 'tr', 'td', 'th', 'li', 'ul', 'ol', 'table', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'pre']);

function textOf(el) {
  // Script and style text is not text a reader sees, and a mail's own <style>
  // block survives sanitizing — counting 40KB of CSS as "visible content" would
  // wreck every size check below.
  if (el.name === 'script' || el.name === 'style') return '';
  if (el.type === 'text') return el.data || '';
  let out = '';
  for (const c of el.children || []) out += textOf(c);
  return BREAKS.has(el.name) ? ` ${out} ` : out;
}

function headerBlock(el) {
  const t = norm(textOf(el));
  if (!HDR_FIRST.test(t)) return false;
  // A second header label right after it — otherwise a message that merely
  // BEGINS with the word "From:" would take its own body with it.
  return HDR_SECOND.test(t.slice(0, 400));
}

/** 0 = not a quote start. Lower is a stronger signal. */
function quoteRank(el) {
  const id = attr(el, 'id');
  const cls = classesOf(el);
  if (cls.some((c) => ['gmail_quote', 'moz-cite-prefix', 'yahoo_quoted', 'protonmail_quote'].includes(c))) return 1;
  if (['divRplyFwdMsg', 'appendonsend', 'OLK_SRC_BODY_SECTION'].includes(id)) return 1;
  if (id.startsWith('mail-editor-reference-message')) return 1;
  if (el.name === 'blockquote' && attr(el, 'type').toLowerCase() === 'cite') return 1;
  if (headerBlock(el)) return 2;
  if (el.name === 'blockquote') return 3;
  return 0;
}

/** The outermost wrapper that contains the quote and nothing before it —
 *  Outlook nests its divider div inside another div, and hiding only the inner
 *  one leaves its shell (and its border) behind. */
function hoist(el, root) {
  let cur = el;
  while (cur.parent && cur.parent !== root && isTag(cur.parent)) {
    const parentText = norm(textOf(cur.parent));
    const ownText = norm(textOf(cur));
    if (!ownText || !parentText.startsWith(ownText)) break;
    cur = cur.parent;
  }
  return cur;
}

function hide(el) {
  el.attribs = el.attribs || {};
  const cls = classesOf(el);
  if (!cls.includes(QUOTE_CLASS)) cls.push(QUOTE_CLASS);
  el.attribs.class = cls.join(' ');
  const style = el.attribs.style ? el.attribs.style.replace(/;\s*$/, '') + ';' : '';
  el.attribs.style = style + HIDE_STYLE;
}

/** `start` and everything after it in document order — its own following
 *  siblings, then its parent's, and so on up to the root. */
function markFrom(start, root) {
  const marked = [start];
  for (let cur = start; cur && cur !== root; cur = cur.parent) {
    for (let sib = cur.next; sib; sib = sib.next) if (isTag(sib)) marked.push(sib);
    if (!cur.parent) break;
  }
  // The rule Outlook on the web draws above its quote belongs to the quote.
  for (let prev = start.prev; prev; prev = prev.prev) {
    if (!isTag(prev)) continue;
    if (prev.name === 'hr') { marked.push(prev); continue; }
    if (norm(textOf(prev)) === '' && du.getElementsByTagName('img', prev).length === 0) continue;
    break;
  }
  for (const el of marked) hide(el);
  return marked;
}

/**
 * Every link in a message body, as `{ href, text }` — for the unsubscribe
 * fallback (server/unsubscribe.js#pickUnsubscribeAnchor). Here rather than
 * there because this module already has htmlparser2 wired up and the same
 * parse shape; `unsubscribe.js` stays free of imports and therefore testable.
 *
 * Links inside a collapsed quote are skipped: an unsubscribe link belonging to
 * a message somebody forwarded to you is not YOUR way out of anything.
 */
export function anchorsIn(html) {
  if (!html || typeof html !== 'string') return [];
  let doc;
  try { doc = parseDocument(html); } catch { return []; }
  return du.getElementsByTagName('a', doc, true)
    .filter((el) => !classesOf(el).includes(QUOTE_CLASS) && !hasQuotedAncestor(el))
    .map((el) => ({ href: attr(el, 'href'), text: norm(textOf(el)) }))
    .filter((a) => a.href);
}

function hasQuotedAncestor(el) {
  for (let p = el.parent; p; p = p.parent) if (isTag(p) && classesOf(p).includes(QUOTE_CLASS)) return true;
  return false;
}

/**
 * Marks the quoted half of `html` and inserts the toggle button before it.
 *
 * Returns `{ html, collapsed, hidden, left }` — `collapsed:false` (and the
 * input unchanged) whenever there is no quote, or hiding it would leave
 * nothing to read, or the quote is too short for the button to be worth it.
 * Both of those are checked after marking, because "how much is left" is the
 * only measure that means anything.
 */
export function collapseQuotedHtml(html) {
  if (!html || typeof html !== 'string') return { html, collapsed: false };
  let doc;
  try {
    doc = parseDocument(html);
  } catch {
    return { html, collapsed: false }; // unparsable is the mail's problem, not a reason to fail the read
  }

  const all = du.getElementsByTagName('*', doc, true);
  let start = null, bestRank = 99;
  for (const el of all) {
    const r = quoteRank(el);
    // Strictly lower only: a tie keeps the FIRST match, which in document order
    // is the outermost one.
    if (r && r < bestRank) { start = el; bestRank = r; }
  }
  if (!start) return { html, collapsed: false };
  start = hoist(start, doc);

  const whole = norm(textOf(doc)).length;
  const marked = markFrom(start, doc);
  const hidden = marked.reduce((n, el) => n + norm(textOf(el)).length, 0);
  const left = whole - hidden;
  // Two ways this would make a message worse: a forward with no comment of its
  // own (nothing above the quote, so collapsing empties the message), and a
  // quote so short the button costs more than it saves.
  if (left < 20 || hidden < 120) return { html, collapsed: false, refused: true, hidden, left };

  const button = parseDocument(`<button type="button" class="${TOGGLE_CLASS}" title="Show trimmed content">&#8943;</button>`).children[0];
  du.prepend(start, button);
  // decodeEntities on OUTPUT means "re-escape what the parser decoded" (the
  // option name reads backwards). It is not optional: the parser turns
  // `&lt;tina@example.com&gt;` in an Outlook header block into the text
  // `<tina@example.com>`, and writing that back raw makes the browser parse it
  // as a tag and swallow the address. Every quoted "From:" line loses its
  // sender that way — found by diffing the text of 377 real messages before and
  // after this round trip.
  return { html: renderDom(doc, { decodeEntities: true }), collapsed: true, hidden, left };
}
