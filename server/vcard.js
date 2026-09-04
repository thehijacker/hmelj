// Hmelj — vCard 3.0/4.0, read and write.
//
// The address book has only ever been able to IMPORT: a Google CSV, a pasted
// .vcf, or a one-shot pull from Exchange/Graph (server/index.js's
// /api/contacts/import*). All three are snapshots — nothing syncs back, and a
// contact edited on the other side stays stale here forever. Live CardDAV sync
// needs the other half of the format, so this file both parses and serializes.
//
// ── The one rule that shapes everything below ────────────────────────────────
// A vCard on somebody's server carries far more than Hmelj models: postal
// addresses, birthdays, photos, ringtones, a dozen X-APPLE-* fields. Hmelj
// understands a name and some e-mail addresses. If a write-back rebuilt the
// card from what Hmelj understands, every sync would silently destroy the rest.
//
// So a card is kept as its ORDERED LIST OF PROPERTIES, exactly as it arrived,
// and an update REPLACES only the properties Hmelj manages (FN, N, EMAIL),
// leaving every other line untouched and in place. Round-tripping a card Hmelj
// never edited must produce byte-identical semantics — see test/vcard-test.mjs,
// which asserts exactly that against real cards from four different servers.
//
// ── Why this has its own line parser ─────────────────────────────────────────
// server/icalendar.js#parseLine implements the same content-line grammar and is
// deliberately NOT reused for the head of the line: it drops a parameter with
// no `=` (`if (eq === -1) continue`), which is correct for iCalendar and wrong
// here. vCard 2.1's bare-parameter form — `TEL;WORK;VOICE:...`, `EMAIL;INTERNET:`
// — is still emitted today by Apple Contacts, older Outlook exports and most
// phones, and dropping it loses the type of every address on such a card.
// vCard also has property groups (`item1.EMAIL:…`), which iCalendar has not.
//
// All four shared halves of the grammar — unfold, unescapeText, escapeText and
// foldLine — now live in server/contentLine.js, extracted there when the
// iCalendar serializer arrived and needed the identical set. Re-exported below,
// since they have been part of this module's surface since it was written.
//
// Pure, two imports, both themselves pure — see test/vcard-test.mjs.
import { unfold, unescapeText, escapeText, foldLine } from './contentLine.js';
import { decodeQuotedPrintable } from './transferEncoding.js';

/* ---------------- content lines ---------------- */

/** Splits on `sep`, ignoring separators inside a double-quoted run. Quotes are
 *  KEPT in the output — a parameter value is only unquoted once it has been
 *  split down to a single value, or `TYPE="work,home"` (one value containing a
 *  comma) would be indistinguishable from `TYPE=work,home` (two values). */
function splitUnquoted(s, sep) {
  const out = [];
  let cur = '', q = false;
  for (const c of s) {
    if (c === '"') { q = !q; cur += c; continue; }
    if (c === sep && !q) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

const unquote = (v) => (v.length > 1 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

/**
 * One unfolded content line → `{ group, name, rawName, params, value }`, or null
 * if it isn't one. `params` maps an UPPERCASED parameter name to an array of
 * values, always an array even for one — `TYPE` legitimately repeats, and a
 * caller that had to check which shape it got would get it wrong somewhere.
 *
 * `name` is uppercased for matching (property names ARE case-insensitive);
 * `rawName` keeps the spelling the card used, and is what gets written back.
 * Apple's `X-ABShowAs` and `X-ABLabel` are conventionally mixed-case and some
 * clients match them that way — but the real reason is that re-casing every
 * property makes our PUT differ from what the server stored, which reads as a
 * change on every single sync.
 *
 * The value is everything after the first unquoted colon and is returned RAW:
 * unescaping happens per component, after the structured split, because `\;`
 * has to survive long enough to not be mistaken for a component boundary.
 */
export function parseContentLine(line) {
  let i = 0, q = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) break;
  }
  if (i >= line.length) return null;

  const segs = splitUnquoted(line.slice(0, i), ';');
  const value = line.slice(i + 1);

  let nameSeg = (segs.shift() || '').trim();
  let group = null;
  const dot = nameSeg.indexOf('.');
  if (dot > 0) { group = nameSeg.slice(0, dot); nameSeg = nameSeg.slice(dot + 1); }
  const name = nameSeg.toUpperCase();
  if (!name) return null;

  const params = {};
  const push = (k, v) => { (params[k] ||= []).push(v); };
  for (const seg of segs) {
    const s = seg.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    // No '=' at all: vCard 2.1's bare parameter. Every one of these that
    // matters in practice is a TYPE (WORK/HOME/CELL/VOICE/FAX/PREF/INTERNET),
    // and ENCODING/CHARSET are the two exceptions that name themselves.
    if (eq === -1) {
      const u = unquote(s).toUpperCase();
      if (u === 'QUOTED-PRINTABLE' || u === 'BASE64' || u === 'B') push('ENCODING', u);
      else push('TYPE', u);
      continue;
    }
    const k = s.slice(0, eq).trim().toUpperCase();
    for (const v of splitUnquoted(s.slice(eq + 1), ',')) push(k, unquote(v.trim()));
  }
  return { group, name, rawName: nameSeg, params, value };
}

/** Splits a property value on unescaped `sep`. A `\;` inside a component is a
 *  literal semicolon, not a boundary — which is the entire reason this can't be
 *  `value.split(';')`, and the reason `unescapeText` runs after it, not before. */
function splitValue(v, sep) {
  const out = [];
  let cur = '';
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '\\') { cur += c + (v[i + 1] ?? ''); i++; continue; }
    if (c === sep) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** A structured value (`N`, `ADR`, `ORG`) as components, each already unescaped.
 *  A component that is itself a comma-list stays one string here — callers that
 *  care (nobody yet) can split it with `listOf`. */
export function components(value) {
  return splitValue(String(value ?? ''), ';').map(unescapeText);
}

/** A comma-list value (`CATEGORIES`, `NICKNAME`) as unescaped strings. */
export function listOf(value) {
  return splitValue(String(value ?? ''), ',').map(unescapeText).filter(Boolean);
}

// escapeText and foldLine now live in server/contentLine.js, shared with the
// iCalendar serializer that arrived with the calendar — which is exactly what
// this file's header said would happen. Re-exported because they have been part
// of this module's surface since it was written.
export { escapeText, foldLine };

/* ---------------- cards ---------------- */

/** Properties that describe the envelope rather than the person. Kept out of
 *  `card.props` so serialization can put them back in the required order
 *  without having to find and skip them. */
const ENVELOPE = new Set(['BEGIN', 'END', 'VERSION']);

/**
 * Every vCard in a stream. A CardDAV multiget returns one card per response
 * href, but a pasted .vcf or an exported address book is routinely hundreds in
 * one file, and the existing paste import already relies on that.
 *
 * Malformed cards are skipped, not thrown on: one bad card in an import of 800
 * must not cost the other 799. Callers that need to know get the count back
 * from `parseCards`' second return value.
 */
export function parseCards(text) {
  const src = unfold(text);
  const cards = [];
  let cur = null;
  let skipped = 0;
  for (const raw of src.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const p = parseContentLine(line);
    if (!p) { if (cur) skipped++; continue; }
    if (p.name === 'BEGIN' && p.value.trim().toUpperCase() === 'VCARD') {
      cur = { version: '3.0', props: [] };
      continue;
    }
    if (!cur) continue; // junk before the first BEGIN
    if (p.name === 'END' && p.value.trim().toUpperCase() === 'VCARD') {
      cards.push(cur);
      cur = null;
      continue;
    }
    if (p.name === 'VERSION') { cur.version = p.value.trim() || '3.0'; continue; }
    // Declared, not guessed: unlike a mail body (see transferEncoding.js's
    // header, which exists because guessing there damages real messages), the
    // property says outright that it is quoted-printable, so the heuristic gate
    // that module wraps around this decoder is neither needed nor wanted.
    if (p.params.ENCODING?.some((e) => e.toUpperCase() === 'QUOTED-PRINTABLE')) {
      // decodeQuotedPrintable only recognises UPPERCASE hex; plenty of phones
      // emit `=c5=a0`. Only the two characters after an `=` are touched, and in
      // a value declared quoted-printable those are hex digits by definition.
      p.value = decodeQuotedPrintable(p.value.replace(/=([0-9a-fA-F]{2})/g, (m, h) => '=' + h.toUpperCase()));
    }
    cur.props.push(p);
  }
  // An unterminated final card is kept: a truncated .vcf is far more often a
  // missing trailing newline than a genuinely broken card, and dropping the
  // last contact of every such import is the worse failure.
  if (cur?.props.length) cards.push(cur);
  return { cards, skipped };
}

/** The single card in `text`, or null. */
export function parseCard(text) {
  return parseCards(text).cards[0] || null;
}

/** Every property with this name, in document order. */
export function propsOf(card, name) {
  const n = name.toUpperCase();
  return (card?.props || []).filter((p) => p.name === n);
}

/** The first value of a property, unescaped, or ''. */
export function valueOf(card, name) {
  const p = propsOf(card, name)[0];
  return p ? unescapeText(p.value) : '';
}

/** Replaces every property called `name` with the ones given, keeping the
 *  position of the first one it replaced. Position matters more than it looks:
 *  a server that re-serializes what we PUT can reorder, but a diff a human
 *  reads should not shuffle a card's lines on every name change. */
export function setProps(card, name, replacements) {
  const n = name.toUpperCase();
  const at = card.props.findIndex((p) => p.name === n);
  const kept = card.props.filter((p) => p.name !== n);
  const insertAt = at === -1 ? kept.length : Math.min(at, kept.length);
  card.props = [...kept.slice(0, insertAt), ...replacements, ...kept.slice(insertAt)];
  return card;
}

const prop = (name, value, params = {}) => ({ group: null, name: name.toUpperCase(), rawName: name, params, value });

/* ---------------- the fields Hmelj models ---------------- */

/**
 * The display name. FN is the authoritative one in every vCard version — N is
 * the structured breakdown and is optional in 4.0 — so it is tried first, and
 * the fallbacks exist only for cards that omit it (some CRM exports do).
 */
export function cardName(card) {
  const fn = valueOf(card, 'FN').trim();
  if (fn) return fn;
  const n = components(propsOf(card, 'N')[0]?.value || '');
  // N is family;given;additional;prefix;suffix — rendered the way a person
  // reads it, not the way it is stored.
  const built = [n[3], n[1], n[2], n[0], n[4]].map((x) => (x || '').trim()).filter(Boolean).join(' ');
  if (built) return built;
  return valueOf(card, 'ORG').split(';')[0].trim();
}

/** `PREF` in either dialect: `TYPE=PREF` (3.0) or `PREF=1..100` (4.0, lower is
 *  more preferred). Returns a sort key — smaller sorts first. */
function prefRank(p) {
  const pref = p.params.PREF?.[0];
  if (pref !== undefined) {
    const n = parseInt(pref, 10);
    return Number.isFinite(n) ? n : 1;
  }
  return p.params.TYPE?.some((t) => t.toUpperCase() === 'PREF') ? 1 : 100;
}

/**
 * Every e-mail address on the card, preferred first, as
 * `{ email, types, pref }`. Document order breaks ties, so a card with no
 * preference at all keeps the order its author chose.
 *
 * Anything without an `@` is dropped rather than carried: an EMAIL property
 * holding a note or an empty string is common in exported cards, and the whole
 * point of this list is that it can be written to.
 */
export function cardEmails(card) {
  return propsOf(card, 'EMAIL')
    .map((p, i) => ({
      email: unescapeText(p.value).trim(),
      // INTERNET is a transport, not a place — it says nothing a user wants to
      // see beside an address, and it is on virtually every 2.1-era card.
      types: (p.params.TYPE || []).map((t) => t.toUpperCase()).filter((t) => t !== 'INTERNET' && t !== 'PREF'),
      pref: prefRank(p),
      order: i,
    }))
    .filter((e) => e.email.includes('@'))
    .sort((a, b) => a.pref - b.pref || a.order - b.order)
    .map(({ email, types, pref }) => ({ email, types, pref }));
}

/** The card's own stable identity. A CardDAV server guarantees a UID on
 *  everything it stores; a hand-written .vcf routinely has none, and the caller
 *  mints one — which is why this reports the absence instead of inventing it. */
export function cardUid(card) {
  return valueOf(card, 'UID').replace(/^urn:uuid:/i, '').trim();
}

/**
 * A card flattened into the `{name, email}` rows the rest of Hmelj speaks —
 * ONE PER ADDRESS, not one per card.
 *
 * A contact with a work and a private address is two things you can write to,
 * and an address book that offers only the first is the address book people
 * keep a second copy of. `meta` (source id, href, etag, uid) rides along on
 * every row so a row can be written back to the right card, and `emailIndex`
 * says which of that card's addresses this row is.
 */
export function cardToRows(card, meta = {}) {
  const name = cardName(card);
  return cardEmails(card).map((e, i) => ({
    ...meta,
    name,
    email: e.email,
    emailTypes: e.types,
    emailIndex: i,
  }));
}

/* ---------------- writing ---------------- */

/** REV, in the dialect the card is written in. 4.0 wants a basic-format
 *  timestamp, 3.0 an extended one; a server that validates will reject the
 *  other, and several do. */
function revValue(version, now = new Date()) {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return String(version).startsWith('4') ? iso.replace(/[-:]/g, '') : iso;
}

/**
 * Writes `{name, emails}` onto a card, replacing ONLY the properties Hmelj
 * manages and leaving every other line exactly where it was — see this file's
 * header for why that is the whole design.
 *
 * `emails` is `[{email, types}]` in preference order; the first becomes the
 * preferred one, expressed in the card's own dialect so a 3.0 server does not
 * receive a 4.0 `PREF=1` it will not understand.
 *
 * N is rewritten only when the card HAS one — a 4.0 card that omits it is
 * valid, and adding one would mean guessing where a one-word name splits.
 */
export function applyContact(card, { name, emails } = {}, now = new Date()) {
  const v4 = String(card.version).startsWith('4');

  if (name !== undefined) {
    setProps(card, 'FN', [prop('FN', escapeText(name))]);
    const existing = propsOf(card, 'N')[0];
    if (existing) {
      const parts = components(existing.value);
      // Only the given/family halves are touched; a stored prefix, suffix or
      // middle name is not something a single-field rename knows how to change.
      const words = String(name).trim().split(/\s+/);
      const given = words.slice(0, -1).join(' ') || (words.length === 1 ? words[0] : '');
      const family = words.length > 1 ? words.at(-1) : '';
      const next = [family, given, parts[2] || '', parts[3] || '', parts[4] || ''];
      setProps(card, 'N', [prop('N', next.map(escapeText).join(';'), existing.params)]);
    }
  }

  if (emails !== undefined) {
    const rows = emails.filter((e) => String(e?.email || '').includes('@'));
    setProps(card, 'EMAIL', rows.map((e, i) => {
      const types = (e.types || []).map((t) => String(t).toUpperCase()).filter(Boolean);
      const params = {};
      if (types.length) params.TYPE = types;
      if (i === 0 && rows.length > 1) {
        if (v4) params.PREF = ['1'];
        else params.TYPE = [...types, 'PREF'];
      }
      return prop('EMAIL', escapeText(e.email), params);
    }));
  }

  setProps(card, 'REV', [prop('REV', revValue(card.version, now))]);
  return card;
}

/** A brand-new card for a contact Hmelj is creating. 3.0 by default: it is what
 *  every CardDAV server accepts, whereas 4.0 is still refused outright by some
 *  (Google's CardDAV among them). */
export function newCard({ name = '', emails = [], uid, version = '3.0' } = {}, now = new Date()) {
  const card = { version, props: [prop('UID', uid || crypto.randomUUID())] };
  return applyContact(card, { name, emails }, now);
}

/**
 * The card back to text, CRLF-terminated as RFC 6350 requires (a bare LF is
 * rejected by strict servers, and the ones that accept it store it and hand it
 * back folded differently, which then looks like a change on every sync).
 */
export function serializeCard(card) {
  const lines = ['BEGIN:VCARD', `VERSION:${card.version || '3.0'}`];
  for (const p of card.props || []) {
    if (ENVELOPE.has(p.name)) continue;
    let head = (p.group ? p.group + '.' : '') + (p.rawName || p.name);
    for (const [k, vals] of Object.entries(p.params || {})) {
      for (const v of vals) {
        // A parameter value containing any of these must be quoted, or the
        // reader on the other side splits the line in the wrong place.
        head += `;${k}=` + (/[,;:]/.test(v) ? `"${v}"` : v);
      }
    }
    lines.push(foldLine(`${head}:${p.value}`));
  }
  lines.push('END:VCARD');
  return lines.join('\r\n') + '\r\n';
}
