// Hmelj — credentials for the CalDAV/CardDAV server.
//
// ── Why the login password is not accepted at /dav ──────────────────────────
// A DAV client speaks HTTP Basic: it stores the credential in plain form on the
// device, sends it on every single request, and has no concept of signing out.
// A phone configured with a Hmelj account password would therefore be carrying
// something that unlocks the whole app — mail, settings, every mailbox
// credential the account can reach — for one calendar subscription. So /dav
// accepts ONLY an app password, and never falls back to the login one. A
// credential handed to a device can be revoked from Settings without changing
// anything else, and cannot be used to sign in to Hmelj itself.
//
// Scoped as well as separate: a password issued for calendars cannot read the
// address book. Two clients, two credentials, two independent revocations.
//
// ── Stored the way a password is stored ─────────────────────────────────────
// scrypt with a per-record salt, compared in constant time — the same treatment
// server/session.js gives a login password, and for the same reason. The secret
// itself is shown once, at creation, and is not recoverable afterwards: if it
// were, this file would be a list of live credentials in plaintext.
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { currentUser, findUser, userKey } from './session.js';
import { log } from './log.js';

const alog = log.scope('app-passwords');

/** What a credential may reach. Deliberately not a single "dav" scope: a
 *  household calendar shared onto a partner's phone should not also hand over
 *  the address book. */
export const SCOPES = ['caldav', 'carddav'];

/** Long enough that guessing is not a strategy, short enough to type once into
 *  a phone's account form. 20 base32-ish characters ≈ 100 bits. */
const SECRET_BYTES = 15;

function userDirFor(uKey) {
  const dir = path.join(config.dataDir, 'users', uKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const fileFor = (uKey) => path.join(userDirFor(uKey), 'app-passwords.json');

function loadFor(uKey) {
  try { return JSON.parse(fs.readFileSync(fileFor(uKey), 'utf8')); } catch { return []; }
}

function saveFor(uKey, list) {
  const file = fileFor(uKey);
  const tmp = file + '.tmp';
  // 600: this file holds password hashes, and DATA_DIR is routinely a
  // bind-mounted host directory somebody browses.
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return list;
}

const hash = (secret, salt) => crypto.scryptSync(secret, salt, 64).toString('hex');

/** Base32 without the characters that get misread when somebody copies one off
 *  a screen onto a phone: no 0/O, no 1/I/L. Grouped in fours for the same
 *  reason — a 20-character run of letters is transcribed wrong. */
function mintSecret() {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(SECRET_BYTES * 2);
  let out = '';
  for (let i = 0; i < SECRET_BYTES * 2 && out.length < 20; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out.replace(/(.{5})(?=.)/g, '$1-');
}

/* ---------------- managing them ---------------- */

const uk = () => currentUser().viewerKey;

/** The list a UI may see: everything except the hash. */
export function listFor(uKey) {
  return loadFor(uKey).map(({ hash: _h, salt: _s, ...rest }) => rest);
}
export const list = () => listFor(uk());

/**
 * Creates one, and returns the secret — the ONLY time it exists in readable
 * form. The caller shows it once; there is deliberately no way to ask for it
 * again.
 */
export function create({ label, scopes, pubIds } = {}) {
  const uKey = uk();
  const wanted = (Array.isArray(scopes) ? scopes : SCOPES).filter((s) => SCOPES.includes(s));
  if (!wanted.length) throw Object.assign(new Error('An app password needs at least one scope'), { status: 400 });
  // Which published collections this password may reach. EMPTY MEANS ALL — both
  // because that is what every password created before this existed meant, and
  // because "a device of mine, subscribed to everything I publish" is still the
  // common case. A non-empty list is the other one: a password handed to
  // somebody else, which should reach exactly what it was made for and nothing
  // published later.
  const pubs = Array.isArray(pubIds) ? [...new Set(pubIds.map(String).filter(Boolean))] : [];
  const secret = mintSecret();
  const salt = crypto.randomBytes(16).toString('hex');
  const record = {
    id: crypto.randomUUID(),
    label: String(label || '').trim().slice(0, 60) || 'Device',
    scopes: wanted,
    pubIds: pubs,
    createdAt: Date.now(),
    lastUsedAt: 0,
    salt,
    hash: hash(secret, salt),
  };
  saveFor(uKey, [...loadFor(uKey), record]);
  alog.info(`${uKey}: app password "${record.label}" created for ${wanted.join(', ')}`);
  const { hash: _h, salt: _s, ...safe } = record;
  return { record: safe, secret };
}

export function remove(id) {
  const uKey = uk();
  const list_ = loadFor(uKey);
  const next = list_.filter((r) => r.id !== id);
  if (next.length === list_.length) throw Object.assign(new Error('No such app password'), { status: 404 });
  saveFor(uKey, next);
  alog.info(`${uKey}: app password removed`);
  return true;
}

/* ---------------- using them ---------------- */

/**
 * Resolves a Basic-auth pair to a user and the credential that matched.
 *
 * Every stored record for that username is checked rather than stopping at the
 * first mismatch, so the time taken does not depend on WHICH credential was
 * given — the comparison itself is already constant-time, and short-circuiting
 * the loop would put the information back.
 *
 * Returns null for an unknown user, a disabled one, or a secret that matches
 * nothing. The caller cannot tell those apart, which is the point.
 */
export function verify(username, secret) {
  if (!username || !secret) return null;
  const user = findUser(username);
  if (!user || user.disabled) return null;
  const uKey = userKey(user.username);
  const records = loadFor(uKey);
  let matched = null;
  for (const r of records) {
    if (!r?.hash || !r?.salt) continue;
    const candidate = hash(secret, r.salt);
    // timingSafeEqual throws on a length mismatch, which is itself a signal —
    // both sides are fixed-length scrypt output here, so it never happens, and
    // the length check keeps it that way rather than trusting the file.
    if (candidate.length !== r.hash.length) continue;
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(r.hash))) matched = r;
  }
  if (!matched) return null;
  return {
    user,
    uKey,
    credential: {
      id: matched.id, label: matched.label, scopes: matched.scopes,
      pubIds: Array.isArray(matched.pubIds) ? matched.pubIds : [],
    },
  };
}

/** Records that a credential was used. Written at most once a minute per
 *  credential: a DAV client polls every few minutes forever, and rewriting the
 *  file on every request would be a synchronous disk write on the hot path for
 *  a field nobody reads more than once a month. */
const lastWrite = new Map();
export function touch(uKey, credentialId) {
  const now = Date.now();
  if (now - (lastWrite.get(credentialId) || 0) < 60e3) return;
  lastWrite.set(credentialId, now);
  const list_ = loadFor(uKey);
  const r = list_.find((x) => x.id === credentialId);
  if (!r) return;
  r.lastUsedAt = now;
  try { saveFor(uKey, list_); } catch (e) { alog.debug(`Could not record last use: ${e.message}`); }
}

/** Does this credential cover what is being asked for? */
export const allows = (credential, scope) => !!credential?.scopes?.includes(scope);

/**
 * May this credential see that published collection?
 *
 * An empty `pubIds` means all of them — see create(). This is what makes a
 * password shareable with one person: without it, every DAV password reached
 * everything the account had ever published, so handing someone a credential
 * for one shared calendar also handed them every other one.
 */
export const allowsPublication = (credential, pubId) =>
  !credential?.pubIds?.length || credential.pubIds.includes(String(pubId));

/** Whether this user has any credential at all — so Settings can say "no
 *  device is set up yet" rather than showing an empty box with no explanation. */
export function hasAnyFor(uKey) {
  return loadFor(uKey).length > 0;
}
