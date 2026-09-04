// Hmelj — local user accounts + sessions + per-request context.
//
// Hmelj users are standalone (username + password, scrypt-hashed in
// DATA_DIR/auth.json). Mail accounts are attached per user (see accounts.js).
// The auth middleware runs each request inside an AsyncLocalStorage context:
//   { userId, username, userKey, accountId? }
// store.js / imapClient.js / smtpClient.js read the current user/account from
// here, so their function signatures stay unchanged.
import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
// Circular with accounts.js (it imports currentUser from here) — safe for
// the same reason the existing ewsClient.js/accounts.js circular pair
// already documented is: both sides only touch the other's export from
// inside a function body, at call time (requireAuth runs per-request, long
// after both modules have finished loading), never at module-top-level.
import { isOwnAccount, resolveSharedOwnerKey } from './accounts.js';

const als = new AsyncLocalStorage();
const sessions = new Map(); // token -> { userId, username, userKey, createdAt, lastSeen, ttlMs }

export const COOKIE_NAME = 'hmelj_session';

// Sessions used to live only in this Map, so every server restart (even a
// plain `git pull` + restart, not just a crash) silently logged everyone
// out — "remember me" only survived as long as the process did. Persisted
// here the same way auth.json/admin.json are: plain JSON, atomic
// write-then-rename. Not flushed on every request (getSession()'s lastSeen
// bump would mean a disk write per API call) — see persistSessionsSoon().
const SESSIONS_FILE = () => path.join(config.dataDir, 'sessions.json');

function loadSessionsFromDisk() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(SESSIONS_FILE(), 'utf8')); } catch { return; }
  const now = Date.now();
  for (const [token, s] of Object.entries(raw)) {
    if (now - s.lastSeen <= s.ttlMs) sessions.set(token, s);
  }
}
function persistSessionsNow() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = SESSIONS_FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
    fs.renameSync(tmp, SESSIONS_FILE());
  } catch { /* best-effort — worst case is an extra login prompt after a crash */ }
}
loadSessionsFromDisk();

// Debounced flush for the high-frequency path (lastSeen bumped on every
// authenticated request): coalesce into at most one write per few seconds
// instead of one per request. Immediate/synchronous flush still happens on
// login and logout (see createSession/destroySession*), where "reliably
// persisted before we respond" actually matters.
let flushTimer = null;
function persistSessionsSoon() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; persistSessionsNow(); }, 5000).unref();
}
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { persistSessionsNow(); process.exit(0); });
}

/* ---------------- user registry (auth.json) ---------------- */

const AUTH_FILE = () => path.join(config.dataDir, 'auth.json');

// Upgrade path for instances created before the admin flag existed: if no
// user has isAdmin set, treat the earliest-created one as admin (virtual —
// only persisted to disk once an admin action actually writes the list back).
function withAdminFallback(users) {
  if (!users.length || users.some((u) => u.isAdmin)) return users;
  const first = users.reduce((a, b) => (new Date(a.createdAt) <= new Date(b.createdAt) ? a : b));
  return users.map((u) => (u === first ? { ...u, isAdmin: true } : u));
}

function loadUsers() {
  try { return withAdminFallback(JSON.parse(fs.readFileSync(AUTH_FILE(), 'utf8'))); } catch { return []; }
}
function saveUsers(users) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = AUTH_FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, AUTH_FILE());
}

function scryptHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

export function userKey(username) {
  const norm = String(username).trim().toLowerCase();
  const hash = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 8);
  return norm.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) + '-' + hash;
}

export function findUser(username) {
  const norm = String(username).trim().toLowerCase();
  return loadUsers().find((u) => u.username === norm) || null;
}

export function hasAnyUser() {
  return loadUsers().length > 0;
}

export function createUser(username, password) {
  const norm = String(username).trim().toLowerCase();
  if (!/^[^\s]{2,}$/.test(norm)) throw new Error('Invalid username');
  if (String(password).length < 6) throw new Error('Password must be at least 6 characters');
  const users = loadUsers();
  if (users.some((u) => u.username === norm)) throw new Error('User already exists');
  const salt = crypto.randomBytes(16).toString('hex');
  // The very first Hmelj user on an instance is admin; later users get the
  // flag only via promotion (see withAdminFallback for the upgrade path,
  // where an instance that predates this feature had no isAdmin at all).
  const user = {
    id: crypto.randomUUID(), username: norm, displayUsername: String(username).trim(),
    salt, hash: scryptHash(password, salt),
    createdAt: new Date().toISOString(), isAdmin: users.length === 0, disabled: false,
  };
  users.push(user);
  saveUsers(users);
  return user;
}

export function verifyUser(username, password) {
  const u = findUser(username);
  if (!u) return null;
  const hash = scryptHash(password, u.salt);
  const ok = hash.length === u.hash.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.hash));
  return ok ? u : null;
}

export function changePassword(userId, currentPassword, newPassword) {
  const users = loadUsers();
  const target = users.find((u) => u.id === userId);
  if (!target) throw new Error('User not found');
  const hash = scryptHash(currentPassword, target.salt);
  const ok = hash.length === target.hash.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(target.hash));
  if (!ok) throw new Error('Current password is incorrect');
  if (String(newPassword).length < 6) throw new Error('Password must be at least 6 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  target.salt = salt;
  target.hash = scryptHash(newPassword, salt);
  saveUsers(users);
}

/**
 * Renames a user's login username. userKey is derived from username (see
 * userKey() above) and doubles as the on-disk/SQLite storage key for
 * everything that belongs to them (settings, mail accounts, cached
 * messages) — so this isn't just an auth.json field edit, it also moves
 * their DATA_DIR/users/<oldKey> directory to the new key. The caller
 * (server/index.js) still owns migrating the SQLite side (cache.js's
 * user_key column) since that module already owns the config.cacheEnabled
 * conditional and session.js otherwise has no reason to import cache.js.
 * Every active session for this user gets destroyed (like disabling them
 * does) rather than patched in place — a live ALS request context can't be
 * rewritten mid-flight, and a persisted session with a stale username would
 * fail sessionFromRequest's own findUser lookup on its very next request
 * anyway, so there's no in-place state worth trying to preserve.
 *
 * `newUsername`'s original case is kept as displayUsername (shown in the UI)
 * while `username`/userKey() stay lowercase-normalized as always — login,
 * uniqueness, and every on-disk/cache partition key are unaffected by case.
 * A pure case change (e.g. "andrej" -> "Andrej", same normalized login name)
 * only updates displayUsername — no userKey change, no directory rename, no
 * need to sign out every other session over it.
 */
export function renameUser(userId, newUsername) {
  const trimmed = String(newUsername).trim();
  const norm = trimmed.toLowerCase();
  if (!/^[^\s]{2,}$/.test(norm)) throw new Error('Invalid username');
  const users = loadUsers();
  const target = users.find((u) => u.id === userId);
  if (!target) throw new Error('User not found');
  if (target.username === norm) {
    if (target.displayUsername !== trimmed) { target.displayUsername = trimmed; saveUsers(users); }
    return { oldKey: userKey(target.username), newKey: userKey(norm), unchanged: true };
  }
  if (users.some((u) => u.username === norm)) throw new Error('User already exists');
  const oldKey = userKey(target.username);
  const newKey = userKey(norm);
  target.username = norm;
  target.displayUsername = trimmed;
  saveUsers(users);
  const oldDir = path.join(config.dataDir, 'users', oldKey);
  const newDir = path.join(config.dataDir, 'users', newKey);
  if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) fs.renameSync(oldDir, newDir);
  destroySessionsForUser(userId);
  return { oldKey, newKey, unchanged: false };
}

export function isAdminUser(username) {
  const u = findUser(username);
  return !!(u && u.isAdmin && !u.disabled);
}

/** Admin-facing user list (never includes salt/hash). */
export function listUsers() {
  return loadUsers().map((u) => ({
    id: u.id, username: u.username, displayUsername: u.displayUsername || u.username, createdAt: u.createdAt,
    isAdmin: !!u.isAdmin, disabled: !!u.disabled,
  }));
}

function destroySessionsForUser(userId) {
  for (const [t, s] of sessions) if (s.userId === userId) sessions.delete(t);
  persistSessionsNow();
}

export function setUserDisabled(id, disabled, actingUserId) {
  const users = loadUsers();
  const target = users.find((u) => u.id === id);
  if (!target) throw new Error('User not found');
  if (id === actingUserId && disabled) throw new Error('Cannot disable your own account');
  if (disabled && target.isAdmin) {
    const otherActiveAdmins = users.filter((u) => u.isAdmin && u.id !== id && !u.disabled);
    if (!otherActiveAdmins.length) throw new Error('Cannot disable the only admin');
  }
  target.disabled = !!disabled;
  saveUsers(users);
  if (disabled) destroySessionsForUser(id);
  return { id: target.id, username: target.username, disabled: target.disabled };
}

export function deleteUser(id, actingUserId) {
  const users = loadUsers();
  const target = users.find((u) => u.id === id);
  if (!target) throw new Error('User not found');
  if (id === actingUserId) throw new Error('Cannot delete your own account');
  if (target.isAdmin) {
    const otherAdmins = users.filter((u) => u.isAdmin && u.id !== id);
    if (!otherAdmins.length) throw new Error('Cannot delete the only admin');
  }
  saveUsers(users.filter((u) => u.id !== id));
  destroySessionsForUser(id);
}

/* ---------------- signup toggle (admin-mutable, env is just the default) ---------------- */

const ADMIN_FILE = () => path.join(config.dataDir, 'admin.json');
function loadAdminState() {
  try { return JSON.parse(fs.readFileSync(ADMIN_FILE(), 'utf8')); } catch { return {}; }
}
export function getAllowSignup() {
  const s = loadAdminState();
  return typeof s.allowSignup === 'boolean' ? s.allowSignup : config.allowSignup;
}
export function setAllowSignup(value) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = ADMIN_FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ allowSignup: !!value }, null, 2));
  fs.renameSync(tmp, ADMIN_FILE());
}

/* ---------------- sessions ---------------- */

// "Stay signed in" (remember=true): long sliding window, persistent cookie.
// Otherwise: short window, session-only cookie (dropped when the browser closes).
const REMEMBER_TTL_MS = 90 * 24 * 3600e3;
const SESSION_TTL_MS = 24 * 3600e3;

export function createSession(user, remember = true) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttlMs = remember ? REMEMBER_TTL_MS : SESSION_TTL_MS;
  sessions.set(token, { userId: user.id, username: user.username, userKey: userKey(user.username), createdAt: Date.now(), lastSeen: Date.now(), ttlMs });
  persistSessionsNow();
  return token;
}

export function destroySession(token) { sessions.delete(token); persistSessionsNow(); }

function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.lastSeen > s.ttlMs) { sessions.delete(token); persistSessionsNow(); return null; }
  s.lastSeen = Date.now();
  persistSessionsSoon();
  return s;
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [t, s] of sessions) if (now - s.lastSeen > s.ttlMs) { sessions.delete(t); changed = true; }
  if (changed) persistSessionsNow();
}, 3600e3).unref();

/* ---------------- request context ---------------- */

/** Current request's user ({ userId, username, userKey, accountId? }); throws when unauthenticated. */
export function currentUser() {
  const u = als.getStore();
  if (!u) throw new Error('Not authenticated');
  return u;
}

/** Run fn inside the current user's context but bound to a specific mail
 * account. `purpose` (currently only 'sync' means anything) lets
 * imapClient.js's connection pool pick a per-account second connection when
 * the account has opted into one (see accounts.js#allowSecondConnection) —
 * omitted/anything else keeps whatever purpose was already in the ambient
 * context (undefined for a normal interactive request). */
export function runWithAccount(accountId, fn, { purpose } = {}) {
  const u = currentUser();
  return als.run({ ...u, accountId, ...(purpose ? { purpose } : {}) }, fn);
}

/**
 * Build a request-shaped context from a user record directly, for code that
 * runs outside any HTTP request — the background sync poller (sync.js) is
 * the only caller. Needs no session/login: userKey is a pure function of the
 * username, and mail account passwords are encrypted with a server-wide
 * secret (accounts.js), not anything derived from the user's login session —
 * so this works identically whether or not that user currently has a
 * browser open.
 */
export function runAsUser(user, fn) {
  const uKey = userKey(user.username);
  return als.run({ userId: user.id, username: user.username, userKey: uKey, viewerKey: uKey }, fn);
}
export function runAsAccount(user, accountId, fn, { purpose } = {}) {
  const uKey = userKey(user.username);
  return als.run({ userId: user.id, username: user.username, userKey: uKey, viewerKey: uKey, accountId, purpose: purpose || null }, fn);
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    // Some OTHER cookie on this domain (a different app, a browser
    // extension, a stale leftover from before) can carry a value with a
    // stray "%" that isn't valid percent-encoding — decodeURIComponent
    // throws URIError on that, which crashed every single request
    // (including /api/session itself, making login impossible) since this
    // parses ALL cookies just to pick out our one. Our own session cookie
    // is always a plain base64url token (crypto.randomBytes(...).
    // toString('base64url') in createSession — never needs decoding at
    // all), so a bad OTHER cookie should never be able to take the whole
    // app down over a value we don't even use.
    try { out[part.slice(0, i).trim()] = decodeURIComponent(raw); }
    catch { out[part.slice(0, i).trim()] = raw; }
  }
  return out;
}

export function sessionFromRequest(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  const s = token ? getSession(token) : null;
  if (!s) return null;
  // Re-checked live (not baked into the token) so an admin disabling/deleting
  // a user takes effect on that user's very next request.
  const u = findUser(s.username);
  if (!u || u.disabled) return null;
  // displayUsername isn't part of the persisted session record (only
  // username/userKey are, set once at login) — always read fresh off the
  // live user record instead, same reasoning as the disabled-check above:
  // a username-case change (see renameUser) should show up on this user's
  // very next request without needing a fresh login.
  return { ...s, displayUsername: u.displayUsername || u.username };
}

/** Express middleware: 401 unless a valid session; runs handler in user context. */
export function requireAuth(req, res, next) {
  const s = sessionFromRequest(req);
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  req.user = s;
  const accountId = req.query.account || null; // mail routes pass ?account=<id>
  // Ownership swap for a shared mail account (see server/accounts.js):
  // if `accountId` isn't this login's own, but was shared TO
  // them, every mail-layer function downstream (imapClient.js's connection
  // pool, every cache.js table) already trusts `userKey` uniformly for
  // partitioning — so operating this one request under the OWNER's userKey
  // instead is what makes a shared account transparently resolve to the
  // one real mailbox/cache, with zero changes needed in any of those
  // layers. `viewerKey` preserves who's ACTUALLY asking, for permission
  // checks and personal-preference storage that must never follow the swap.
  // The isOwnAccount check first keeps this free for the overwhelming
  // common case (no accountId, or the caller's own) — the cross-user scan
  // in resolveSharedOwnerKey only ever runs for a genuine shared-account
  // request.
  let effectiveUserKey = s.userKey;
  if (accountId && !isOwnAccount(s.userKey, accountId)) {
    const ownerKey = resolveSharedOwnerKey(accountId, s.userId);
    if (ownerKey) effectiveUserKey = ownerKey;
  }
  als.run({ userId: s.userId, username: s.username, displayUsername: s.displayUsername, userKey: effectiveUserKey, viewerKey: s.userKey, accountId }, () => next());
}

export function setSessionCookie(res, token, req, remember = true) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  // No Max-Age when not "remembering" -> a session cookie the browser drops on close.
  const maxAge = remember ? `; Max-Age=${REMEMBER_TTL_MS / 1000}` : '';
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax${maxAge}${secure ? '; Secure' : ''}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

/* ---------- login rate limiting (per IP, in memory) ---------- */
const attempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60e3;

export function loginAllowed(ip) {
  const a = attempts.get(ip);
  return !a || !a.until || Date.now() >= a.until;
}
export function loginFailed(ip) {
  const a = attempts.get(ip) || { count: 0, until: 0 };
  a.count += 1;
  if (a.count >= MAX_ATTEMPTS) { a.until = Date.now() + LOCKOUT_MS; a.count = 0; }
  attempts.set(ip, a);
}
export function loginSucceeded(ip) { attempts.delete(ip); }
