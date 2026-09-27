// Hmelj — time-based one-time passwords (RFC 6238), for the optional second
// factor on the web login.
//
// Written out rather than taken from a package, because the whole of it is one
// HMAC and a truncation, node:crypto has the HMAC, and a dependency that sits
// in the login path is a dependency worth not having. The parts that are easy
// to get subtly wrong — the base32 alphabet, the counter's byte order, the
// dynamic-truncation offset, the drift window — are exactly the parts RFC 6238
// publishes test vectors for, and test/totp-test.mjs runs them.
//
// ── What this does NOT do ────────────────────────────────────────────────────
// SHA-1 only, 6 digits, 30-second steps. Not a limitation worth fixing: it is
// what every authenticator app defaults to, and an otpauth:// URI that names
// anything else is quietly ignored by several of them. Offering a choice here
// would mean offering a choice that silently does not work.
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 §6, no padding on the way out
const STEP_SECONDS = 30;
const DIGITS = 6;

/** Bytes → base32. What the user types into their authenticator by hand, and
 *  what goes in the otpauth:// URI, so it is upper case and unpadded. */
export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * base32 → bytes, forgiving of how a person retypes a secret: lower case,
 * the spaces authenticator apps insert every four characters, and the `=`
 * padding some generators add are all accepted. Anything else is a real
 * mistake and throws rather than silently decoding to the wrong key.
 */
export function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('That is not a valid secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh secret, as base32. 20 bytes = 160 bits, which is the length RFC 4226
 *  recommends and the length every authenticator expects for SHA-1. */
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** The code for one counter value — HMAC-SHA1, then RFC 4226's dynamic
 *  truncation: the low nibble of the last byte picks where the 4-byte window
 *  starts, the top bit is masked off so the result is unsigned on every
 *  platform, and the last DIGITS decimal places are the code. */
export function codeAt(secret, counter) {
  const msg = Buffer.alloc(8);
  // Big-endian, and written as two 32-bit halves because the counter outgrows
  // a 32-bit integer in 2038 and writeUInt32BE would silently wrap.
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The counter for a moment in time. */
function counterAt(ms) {
  return Math.floor(ms / 1000 / STEP_SECONDS);
}

/**
 * Is `code` right for `secret` now?
 *
 * `window` is how many 30-second steps either side are accepted — one by
 * default, so a phone whose clock is up to half a minute out still works and a
 * code typed as the step rolls over is not rejected for being a second late.
 * Every candidate is compared, and compared in constant time, so the answer
 * leaks neither which step matched nor how much of the code was right.
 */
export function verify(secret, code, { at = Date.now(), window = 1 } = {}) {
  const given = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  const now = counterAt(at);
  let ok = false;
  for (let i = -window; i <= window; i++) {
    // No early return: a loop that stops at the first match takes measurably
    // longer for a code in the last step than one in the first.
    if (timingSafeEqual(codeAt(secret, now + i), given)) ok = true;
  }
  return ok;
}

/** crypto.timingSafeEqual throws on a length mismatch, which would itself be a
 *  signal — both sides here are always 6 ASCII digits, and the regex above is
 *  what guarantees it, but this stays total rather than relying on that. */
function timingSafeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * The otpauth:// URI an authenticator app reads out of the QR code.
 *
 * The label is "Issuer:account" AND `issuer` is repeated as a parameter: older
 * apps read one, newer ones read the other, and an app that finds neither files
 * the entry under a blank name — which, in a list of six-digit codes that all
 * look alike, is the difference between usable and not.
 */
export function otpauthUri(secret, { issuer = 'Hmelj', account = '' } = {}) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

/**
 * One-time codes for the day the phone is lost or wiped.
 *
 * Without these, losing the authenticator means losing every mail account
 * behind this login, with no way back in that does not involve editing
 * auth.json by hand on the server. Ten is the usual number; the format is
 * deliberately unambiguous to read off paper — no vowels, so nothing in a code
 * can be misread as a word, and no 0/O or 1/I.
 */
const CODE_CHARS = '23456789BCDFGHJKMNPQRSTVWXYZ';
export function generateRecoveryCodes(n = 10) {
  const one = () => {
    const bytes = crypto.randomBytes(10);
    // % is a slight modulo bias over 256 into 28 symbols. It is fine here and
    // only here: these are 10 symbols of ~4.8 bits each drawn fresh, used once,
    // and rate-limited on the way in — the bias costs a fraction of a bit.
    const s = [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  };
  return Array.from({ length: n }, one);
}

/** How a typed recovery code is compared with a stored one: case and the dash
 *  are presentation, not secret. */
export function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}
