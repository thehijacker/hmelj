// Hmelj — reading the Authentication-Results header (RFC 8601): did this
// message really come from where it says it came from?
//
// This is the honest answer to the question encryption does not address. Almost
// all real-world mail harm is impersonation, not interception — and unlike a
// signature, this evidence is already in essentially every message that reaches
// a modern mailbox, because the receiving server put it there.
//
// ── Only the TOPMOST header is evidence ────────────────────────────────────
// Authentication-Results is added by the receiving mail server, at the top,
// above whatever was already in the message. A sender can therefore put a
// perfectly convincing `Authentication-Results: ... dmarc=pass` into the
// message they send, and it will arrive sitting just below the real one. Every
// header below the first is written by someone whose honesty is exactly what is
// being tested, so this reads the first and ignores the rest.
//
// That rule is only as good as "the first one is ours", which is true when
// Hmelj is reading a mailbox on the server that did the checking — the normal
// case. An account may set `authservId` to name its own mail server explicitly,
// in which case the topmost header BEARING THAT NAME is used instead, which is
// what RFC 8601 §5 actually recommends.
//
// No imports and no I/O: same reasoning as unsubscribe.js and refile.js — the
// part worth being sure about is the parsing, and it is pure (see
// test/auth-results-test.mjs).

/** Results a method can report, in the order of how much they should worry
 *  somebody. Anything unrecognised is treated as 'none' — an unknown word is
 *  not evidence of anything, in either direction. */
const KNOWN = new Set(['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'policy', 'bestguesspass']);

/**
 * Strips RFC 5322 comments — `(everything in parentheses)`, nestable.
 *
 * Real headers are full of them: `dkim=pass (1024-bit key)` and
 * `spf=pass (google.com: domain of x designates 1.2.3.4 as permitted sender)`.
 * A comment can legally contain a semicolon or an equals sign, so it has to go
 * before anything is split, or `spf=pass (a; b)` parses as two methods.
 */
export function stripComments(s) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && depth > 0) { i++; continue; } // quoted pair inside a comment
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { if (depth) depth--; continue; }
    if (!depth) out += ch;
  }
  return out;
}

/** `key=value` pairs from one method's segment, lower-cased keys, quotes off. */
function propsOf(rest) {
  const out = {};
  for (const m of rest.matchAll(/([a-z0-9_.-]+)\s*=\s*("([^"]*)"|[^\s;]+)/gi)) {
    out[m[1].toLowerCase()] = (m[3] !== undefined ? m[3] : m[2]).trim();
  }
  return out;
}

/**
 * One Authentication-Results header value → what it says.
 *
 * Returns `{ authserv, methods: { spf: {result, ...props}, … } }`. A header this
 * cannot make sense of yields no methods rather than a guess.
 */
export function parseAuthResultsHeader(value) {
  const clean = stripComments(String(value || '')).trim();
  if (!clean) return { authserv: '', methods: {} };
  const parts = clean.split(';').map((p) => p.trim()).filter(Boolean);
  // The first segment is the authserv-id — the name of the server making these
  // claims. It may carry a version number after whitespace, which is not part
  // of the name.
  const authserv = (parts.shift() || '').split(/\s+/)[0].toLowerCase();
  const methods = {};
  for (const part of parts) {
    const m = part.match(/^([a-z][a-z0-9-]*)\s*=\s*([a-z]+)/i);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const result = m[2].toLowerCase();
    // First occurrence wins: a header repeating a method is malformed, and the
    // later copy is the more suspicious one to trust.
    if (methods[name]) continue;
    methods[name] = { result: KNOWN.has(result) ? result : 'none', ...propsOf(part.slice(m[0].length)) };
  }
  return { authserv, methods };
}

/** Every Authentication-Results header, top first, as raw values. mailparser
 *  preserves header order in `headerLines`, which is the whole reason this can
 *  tell "ours" from "the sender's". */
export function authResultsHeaders(headerLines) {
  return (headerLines || [])
    .filter((l) => String(l.key).toLowerCase() === 'authentication-results')
    .map((l) => String(l.line).slice(String(l.line).indexOf(':') + 1).replace(/\r?\n\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * `Received-SPF:` — the older, SPF-only header, used when there is no
 * Authentication-Results at all. Its value starts with the result word.
 */
export function parseReceivedSpf(headerLines) {
  const line = (headerLines || []).find((l) => String(l.key).toLowerCase() === 'received-spf');
  if (!line) return null;
  const v = stripComments(String(line.line).slice(String(line.line).indexOf(':') + 1)).trim();
  const word = (v.split(/[\s;]/)[0] || '').toLowerCase();
  if (!word) return null;
  return { result: KNOWN.has(word) ? word : 'none', ...propsOf(v) };
}

/**
 * What to tell the reader about this message's provenance.
 *
 * `verdict` is one of:
 *   'pass'  — DMARC passed, or (with no DMARC result) SPF or DKIM did. The
 *             From address is as claimed, as far as the receiving server could
 *             establish.
 *   'fail'  — DMARC explicitly failed. This is the one that matters: it means
 *             the message claims a From domain it is not authorised to use,
 *             which is what impersonation looks like.
 *   'partial' — something authenticated but something else failed. Common and
 *             usually benign (a mailing list breaks SPF by design, which is
 *             exactly what DMARC alignment exists to survive), so it is worth
 *             showing in detail and not worth alarming anybody about.
 *   'none'  — nothing checked, or nothing we could read. Most mail from a
 *             server that does no checking, and all locally-appended mail.
 *
 * Deliberately NOT a score. Every one of these maps to a sentence a person can
 * act on, and a number would invite treating 0.7 as meaningful.
 */
export function summarize({ methods }) {
  const r = (name) => methods?.[name]?.result || null;
  const spf = r('spf');
  const dkim = r('dkim');
  const dmarc = r('dmarc');
  const passed = [spf, dkim].filter((x) => x === 'pass').length;
  const failed = [spf, dkim].filter((x) => x === 'fail').length;
  let verdict = 'none';
  if (dmarc === 'fail') verdict = 'fail';
  // DMARC passing is the strongest single statement there is: it means an
  // authenticated identifier ALIGNED with the From domain. Only an explicit
  // failure alongside it downgrades that — the mere ABSENCE of an spf= or
  // dkim= line does not, and treating it as a downgrade marked perfectly
  // ordinary mail as merely partial.
  else if (dmarc === 'pass') verdict = failed ? 'partial' : 'pass';
  else if (passed && !failed) verdict = 'pass';
  else if (passed && failed) verdict = 'partial';
  else if (failed) verdict = 'partial'; // a lone SPF fail is not a DMARC fail; say so quietly
  return {
    verdict,
    spf, dkim, dmarc,
    // What each check was actually about, for the details view — the domain
    // that signed, and the envelope sender SPF was evaluated against. These are
    // the two things that make a "pass" mean anything: a message can be
    // perfectly signed by a domain that is not the one it claims to be from.
    dkimDomain: methods?.dkim?.['header.d'] || '',
    spfDomain: methods?.spf?.['smtp.mailfrom'] || methods?.spf?.['smtp.helo'] || '',
    fromDomain: methods?.dmarc?.['header.from'] || '',
  };
}

/**
 * The whole reading, from a parsed message's header lines.
 *
 * `authservId` (per account, optional) names the mail server whose verdict to
 * trust. Without it the topmost header is used, which is right whenever Hmelj
 * is reading a mailbox on the server that did the checking.
 */
export function readAuthResults(headerLines, { authservId = '' } = {}) {
  const headers = authResultsHeaders(headerLines);
  let chosen = null;
  if (authservId) {
    const want = String(authservId).toLowerCase();
    chosen = headers.map(parseAuthResultsHeader).find((h) => h.authserv === want) || null;
  }
  if (!chosen && headers.length) chosen = parseAuthResultsHeader(headers[0]);
  if (chosen && Object.keys(chosen.methods).length) {
    return { ...summarize(chosen), authserv: chosen.authserv, headerCount: headers.length };
  }
  // No usable Authentication-Results — fall back to the SPF-only header some
  // servers still write on its own.
  const spf = parseReceivedSpf(headerLines);
  if (spf) {
    return {
      ...summarize({ methods: { spf } }),
      authserv: '', headerCount: headers.length, receivedSpfOnly: true,
    };
  }
  return { verdict: 'none', spf: null, dkim: null, dmarc: null, dkimDomain: '', spfDomain: '', fromDomain: '', authserv: '', headerCount: headers.length };
}

/**
 * Does this sender's DISPLAY NAME impersonate somebody already known, while the
 * address does not match?
 *
 * The attack DMARC cannot see: "Andrej Kralj <random@gmail.com>" passes every
 * authentication check there is, because gmail.com really did authorise it. The
 * only thing wrong with it is the name — and the only way to know the name is
 * wrong is to have seen the real one before.
 *
 * `known` is [{name, email}] (the address book). Returns the address the name
 * usually belongs to, or null. Deliberately conservative:
 *   - the name must match a contact's name exactly, ignoring case and spacing;
 *   - that contact must have a DIFFERENT address;
 *   - a name that is itself an email address is skipped (many senders put the
 *     address in both fields, and "it does not match itself" is not spoofing);
 *   - a display name shorter than four characters is skipped — initials and
 *     "IT" collide by accident, and a false alarm here teaches people to ignore
 *     the real one.
 */
export function spoofedDisplayName({ name, address }, known) {
  const shown = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const addr = String(address || '').trim().toLowerCase();
  if (shown.length < 4 || !addr || shown.includes('@')) return null;
  for (const c of known || []) {
    const cname = String(c?.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const cmail = String(c?.email || '').trim().toLowerCase();
    if (!cname || !cmail || cname !== shown) continue;
    if (cmail !== addr) return cmail;
  }
  return null;
}
