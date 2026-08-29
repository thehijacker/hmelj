// Hmelj — one-click unsubscribe (RFC 2369's List-Unsubscribe, RFC 8058's
// one-click POST).
//
// A newsletter says how to leave it in a header:
//
//   List-Unsubscribe: <https://host/u/abc>, <mailto:leave@host?subject=unsub>
//   List-Unsubscribe-Post: List-Unsubscribe=One-Click
//
// The second header is the one that makes it ONE click: it promises the URL
// accepts a POST and will unsubscribe on the spot, with no landing page and no
// confirmation form. Without it, an https link is just a link — it may lead to
// a page that asks which lists, or (with some senders) to a page that needs a
// login. So the two are offered differently: a one-click header is sent for
// you, anything else is opened for you to finish.
//
// ── What this deliberately does NOT do ───────────────────────────────────────
// It never unsubscribes automatically, and never on merely opening a message.
// Unsubscribing tells the sender the address is live and read — which for
// genuine mail is fine and for spam is exactly what the sender wants to learn.
// That is a decision for the person reading, so this is always a button, and
// the reading pane says where the request will go before it goes.
//
// No imports, nothing here does I/O: same reasoning as searchQuery.js and
// threading.js, and it is what makes the parsing testable (see
// test/unsubscribe-test.mjs).

/** Hosts a server-side POST must never be talked into reaching. */
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|\[?::1\]?|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;

/**
 * Is this a URL the SERVER may POST to on the user's behalf?
 *
 * The one-click flow is the only thing in Hmelj that makes an outbound HTTP
 * request to an address chosen by a message, so it gets the strictest reading:
 * https only (a plaintext unsubscribe carries an identifying token in the
 * clear), and never a host that resolves into this machine's own network —
 * otherwise a crafted newsletter could use the mail server as a proxy into
 * whatever it can reach. Hostname-based, so it does not stop a public name
 * deliberately pointed at a private address; the same check is worth having
 * regardless, and anything stricter needs DNS resolution at request time.
 */
export function isSafePostTarget(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return !PRIVATE_HOST.test(u.hostname);
}

/** `mailto:` target split into what actually has to be sent. */
export function parseMailto(value) {
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'mailto:') return null;
  const to = decodeURIComponent(u.pathname || '').trim();
  if (!to || !to.includes('@')) return null;
  const q = u.searchParams;
  // Senders overwhelmingly want a specific subject or body — some mailing-list
  // managers key the unsubscribe entirely off one of them.
  return { to, subject: q.get('subject') || 'unsubscribe', body: q.get('body') || 'unsubscribe' };
}

/**
 * The raw value of one header, straight out of mailparser's `headerLines`.
 *
 * NOT `parsed.headers.get('list-unsubscribe')` — that key does not exist.
 * mailparser folds every `List-*` header into a single `list` object
 * (`{ unsubscribe: { url, mail }, 'unsubscribe-post': { name } }`), so reading
 * it by name silently returns undefined and the whole feature does nothing.
 * That is exactly how the read-receipt banner shipped broken too: assuming
 * mailparser's shape instead of checking it.
 *
 * The raw line is the better source anyway. mailparser's `list.unsubscribe`
 * drops the mailto's query string, and some list managers unsubscribe you only
 * if the mail carries the exact `?subject=` they asked for.
 *
 * Folding is undone here (a continuation line begins with whitespace), and
 * repeated headers are joined — both are legal and both occur.
 */
export function rawHeaderValue(headerLines, name) {
  const want = String(name).toLowerCase();
  return (headerLines || [])
    .filter((l) => String(l.key).toLowerCase() === want)
    .map((l) => String(l.line).slice(String(l.line).indexOf(':') + 1).replace(/\r?\n\s+/g, ' ').trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * What a message offers as ways to unsubscribe.
 *
 * Returns null when there is nothing usable — no header, or a header naming
 * only schemes this refuses to touch. Anything that isn't https/http/mailto is
 * dropped without comment: `javascript:` and `data:` in a header from a
 * stranger have exactly one purpose.
 */
export function parseListUnsubscribe(header, postHeader) {
  const raw = typeof header === 'string' ? header : (header?.text || '');
  if (!raw) return null;
  const targets = [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  // A sender that forgot the angle brackets still meant a URL.
  if (!targets.length && /^\s*(https?|mailto):/i.test(raw)) targets.push(raw.trim());

  let http = null, mailto = null;
  for (const t of targets) {
    if (/^https?:/i.test(t) && !http) http = t;
    // Validated, not just recognised: `mailto:` followed by something that
    // isn't an address is not a way to unsubscribe, and offering a button that
    // can only fail is worse than offering none.
    else if (/^mailto:/i.test(t) && !mailto && parseMailto(t)) mailto = t;
  }
  if (!http && !mailto) return null;

  // RFC 8058: the POST is only allowed — and only meaningful — when the sender
  // says so in this exact form.
  const postRaw = typeof postHeader === 'string' ? postHeader : (postHeader?.text || '');
  const oneClick = /List-Unsubscribe\s*=\s*One-Click/i.test(postRaw || '') && !!http && isSafePostTarget(http);

  // 'post' — sent for you, RFC 8058 one-click.
  // 'mail' — an unsubscribe mail sent for you.
  // 'open' — a page opened for you to finish yourself.
  //
  // In that order of preference, which is also what Gmail does. A mailto is
  // preferred over an ordinary link because it finishes without leaving the
  // app and without the user having to do anything else — a plain https
  // unsubscribe link is as likely to be a preferences page behind a login as
  // it is to be a one-step confirmation. The one-click POST beats both: the
  // sender has explicitly promised it needs nothing more.
  const method = oneClick ? 'post' : (mailto ? 'mail' : 'open');
  let host = '';
  if (http) { try { host = new URL(http).hostname; } catch { /* keep '' */ } }
  return {
    http,
    mailto,
    oneClick,
    method,
    // Where the request will actually go, for the reading pane to say out loud
    // BEFORE anything is sent — the address for a mail, the host for the other
    // two. Naming the mailto while POSTing somewhere else would be a lie.
    label: method === 'mail' ? (parseMailto(mailto)?.to || '') : host,
  };
}

/** The body RFC 8058 requires; a bare constant, but the spec is exact about it. */
export const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click';

// ── The fallback: the link at the bottom of the message ──────────────────────
//
// Plenty of real newsletters publish no List-Unsubscribe header at all and put
// the only way out in the footer — measured on a live mailbox, one sender had
// 305 messages and not one header, while another carried it on 9 of 23
// campaigns. Refusing to help there would make the button look broken on
// exactly the mail people most want rid of.
//
// This is a GUESS, and treated as one: a body link is only ever OPENED in the
// browser, never POSTed to and never mailed. The worst case is a page that
// turns out to be "manage preferences", which is a page the user asked to see.

const LINK_TEXT = /\b(unsubscribe|unsubscribing|opt[-\s]?out|odjav\w*|odhlásit|abmelden|abbestellen|se\s+d[ée]sabonner|d[ée]sabonnement|cancella(re)?\s+iscrizione|disiscriv\w*|darse\s+de\s+baja)\b/i;
const LINK_HREF = /(unsubscribe|unsub|opt[-_]?out|odjava|odjavi|abmeld|desabon|d%C3%A9sabon)/i;

/**
 * The most likely "unsubscribe" link in a message body.
 *
 * Scored rather than first-match: link TEXT saying it is worth more than a URL
 * merely containing the word, since tracking URLs are full of stray words. Ties
 * go to the last one in the document — an unsubscribe link lives in the footer,
 * under everything else.
 *
 * `anchors` is [{ href, text }]; the caller does the parsing (server/index.js
 * already has the message's HTML parsed at that point).
 */
export function pickUnsubscribeAnchor(anchors) {
  let best = null, bestScore = 0;
  for (const a of anchors || []) {
    const href = String(a.href || '').trim();
    if (!/^https?:\/\//i.test(href)) continue; // a body link is only ever opened; nothing else is a link
    const text = String(a.text || '').replace(/\s+/g, ' ').trim();
    let score = 0;
    if (LINK_TEXT.test(text)) score = 2;
    else if (LINK_HREF.test(href)) score = 1;
    // >= so a later candidate of equal score wins: the footer, not the header.
    if (score && score >= bestScore) { best = href; bestScore = score; }
  }
  if (!best) return null;
  let host = '';
  try { host = new URL(best).hostname; } catch { return null; }
  return {
    http: best,
    mailto: null,
    oneClick: false,
    method: 'open',
    label: host,
    // What separates this from a header: the sender did not say this is how to
    // leave, we worked it out. The reading pane says so.
    source: 'body',
  };
}
