// Hmelj — per-user mail accounts (multi-account support).
//
// Each Hmelj user can attach any number of IMAP/SMTP accounts. They are stored
// in DATA_DIR/users/<userKey>/accounts.json with passwords encrypted at rest
// using AES-256-GCM. The key comes from HMELJ_SECRET in .env — the only name
// read; the pre-rename HMAIL_SECRET and GOLOB_SECRET were dropped once this
// install's .env had been moved over. If you ever restore an older .env,
// rename its key to HMELJ_SECRET rather than letting it fall through, or the
// stored passwords decrypt against the wrong key and are lost. Otherwise, by
// default, an auto-generated
// DATA_DIR/secret.key (mode 600). Keep that file safe — it is what protects
// the stored mailbox passwords.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { currentUser, listUsers, userKey } from './session.js';
import * as accountOverrides from './accountOverrides.js';
import { store } from './store.js';
import { deleteAccountCache } from './cache.js';
import * as filterState from './filterState.js';
import { log } from './log.js';
// Circular with ewsClient.js (it imports currentAccount from here) — safe:
// both sides only touch the other's export from inside a function body, at
// call time, never at module-top-level, so ESM's live-binding resolution
// has both modules fully evaluated by the time either is actually invoked.
import { testConnection as ewsTestConnection } from './ewsClient.js';
import { testConnection as graphTestConnection } from './graphClient.js';
// Same deliberate cycle, for the same reason — oauth.js imports encrypt/decrypt
// and updateOAuthTokens from here, and everything below only touches it from
// inside a function body.
import * as oauth from './oauth.js';

const alog = log.scope('accounts');

/* ---------------- encryption ---------------- */

let _key = null;
function secretKey() {
  if (_key) return _key;
  const secret = process.env.HMELJ_SECRET;
  if (secret) {
    _key = crypto.createHash('sha256').update(secret).digest();
    return _key;
  }
  const file = path.join(config.dataDir, 'secret.key');
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  _key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  return _key;
}

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decrypt(blob) {
  const [v, iv, tag, data] = String(blob).split(':');
  if (v !== 'v1') throw new Error('Unknown cipher version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/* ---------------- storage ---------------- */

const ACCOUNT_COLORS = ['#0b57d0', '#0f9d58', '#e37400', '#a142f4', '#d93025', '#00897b', '#f6bf26', '#5f6368'];

// Explicit-userKey variants — same reasoning as store.js's push-subscription
// pair (see server/push.js): shared-account resolution and sync.js both need
// to read/write a SPECIFIC user's accounts.json, not necessarily whoever the
// live ALS context currently says "the current user" is. The ambient
// currentUser()-based functions below are thin wrappers over these for
// every existing call site that's always operated on "my own" accounts.
function accountsFileFor(uKey) {
  const dir = path.join(config.dataDir, 'users', uKey);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'accounts.json');
}
function loadRawFor(uKey) {
  let list;
  try { list = JSON.parse(fs.readFileSync(accountsFileFor(uKey), 'utf8')); } catch { return []; }
  return migrateLegacyOAuth(uKey, list);
}

/**
 * One-shot rewrite of accounts from the short-lived XOAUTH2 era, where signing
 * in with Microsoft produced a type:'imap' record carrying authType:'oauth2'
 * and an `oauth` block. Those now talk to Microsoft Graph instead, as
 * type:'graph'.
 *
 * The stored tokens are dropped rather than carried over: they were issued for
 * the outlook.office.com IMAP/SMTP scopes, which buy nothing on Graph, and the
 * refresh token cannot be traded for Graph scopes it was never consented to.
 * So the account is marked needsReauth and the UI offers "Sign in again",
 * which is the honest outcome. Leaving the record untouched would be worse: it
 * would load as an ordinary IMAP account whose password is the empty string.
 *
 * Idempotent, and writes only when something actually changed — this runs on
 * every single account read.
 */
function migrateLegacyOAuth(uKey, list) {
  if (!Array.isArray(list) || !list.some((a) => a && a.authType === 'oauth2')) return list;
  const migrated = list.map((a) => {
    if (a?.authType !== 'oauth2') return a;
    const { authType, oauth: oa, imap, smtp, ...rest } = a;
    alog.warn(`${a.label || a.email}: migrating from IMAP/XOAUTH2 to Microsoft Graph — sign in again to finish`);
    return {
      ...rest,
      type: 'graph',
      graph: {
        provider: oa?.provider || 'microsoft',
        signedInAs: oa?.signedInAs || a.email,
        needsReauth: true,
      },
    };
  });
  saveRawFor(uKey, migrated);
  return migrated;
}
function saveRawFor(uKey, list) {
  const tmp = accountsFileFor(uKey) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, accountsFileFor(uKey));
}

// TWO different questions, and they get different keys. Getting this backwards
// either breaks shared accounts outright or leaks the owner's account list, so the
// distinction is worth stating plainly:
//
//   loadRaw/saveRaw — "the file the account I am OPERATING ON lives in". userKey,
//   which requireAuth (session.js) has already re-pointed at the owner for a shared
//   account. getAccount() depends on this: a grantee's own accounts.json contains no
//   row for the shared mailbox, so resolving it there would fail.
//
//   loadOwn/saveOwn — "MY OWN accounts". viewerKey, always the real requesting
//   login, so it never follows that swap. Listing and creating are these: with
//   userKey, a request carrying `?account=<a shared account>` listed the OWNER's
//   whole account list (labels, addresses, IMAP hosts and usernames, for accounts
//   never shared) and created new accounts inside it.
//
// Callers that need a THIRD user's file say so explicitly with loadRawFor/saveRawFor
// and a key they resolved themselves (shareAccount, resolveAccountForSending,
// listSharedInAccounts). See test/share-isolation-test.mjs.
function loadRaw() { return loadRawFor(currentUser().userKey); }
function saveRaw(list) { saveRawFor(currentUser().userKey, list); }
function loadOwn() { return loadRawFor(currentUser().viewerKey); }
function saveOwn(list) { saveRawFor(currentUser().viewerKey, list); }

/**
 * SMTP host/port/TLS and user can each independently "follow" IMAP's own
 * values live (sameServer / sameCredentials flags on the stored smtp
 * object), rather than being a one-time copy — so if the user later changes
 * their IMAP password and SMTP is marked "same credentials", SMTP keeps
 * working without a separate edit. Older accounts predating this feature
 * have neither flag set, so they just keep using their own stored values
 * exactly as before (no migration needed).
 */
function effectiveSmtp(a) {
  const { imap, smtp } = a;
  return {
    sameServer: !!smtp.sameServer,
    sameCredentials: !!smtp.sameCredentials,
    host: smtp.sameServer ? imap.host : smtp.host,
    port: smtp.sameServer ? imap.port : smtp.port,
    secure: smtp.sameServer ? imap.secure : smtp.secure,
    user: smtp.sameCredentials ? imap.user : smtp.user,
  };
}

/** One account, without secrets — safe to send to the frontend. Shared by
 * every listing function below. */
function stripSecrets(a) {
  // Every branch below ends in `...rest`, so anything NOT explicitly
  // destructured away is sent straight to the browser by GET /api/accounts.
  // For a Graph account the whole credential is the token pair, and a refresh
  // token is a longer-lived credential than the password this function exists
  // to hide — so `graph` is rebuilt from scratch here rather than filtered,
  // and what's left is display-only.
  if (a.type === 'graph') {
    const { graph, ...rest } = a;
    return {
      ...rest,
      graph: {
        provider: graph?.provider || 'microsoft',
        signedInAs: graph?.signedInAs || a.email,
        needsReauth: !!graph?.needsReauth,
        scope: graph?.scope || '',
        // Which optional scopes this sign-in holds. Safe to send — it is a list
        // of feature names, not a credential — and Settings needs it to show
        // whether contact or calendar sync can be turned on without another
        // sign-in.
        features: Array.isArray(graph?.features) ? graph.features : [],
      },
    };
  }
  if (a.type === 'ews') {
    const { ews, ...rest } = a;
    return { ...rest, ews: { url: ews.url, domain: ews.domain, user: ews.user, tlsRejectUnauthorized: ews.tlsRejectUnauthorized } };
  }
  // An IMAP account signed in with OAuth (Gmail) keeps a refresh token where
  // the password would be — rebuilt display-only here for the same reason the
  // graph block above is, since `...rest` would otherwise ship it to the
  // browser.
  const { imap, smtp, oauth: oa, ...rest } = a;
  return {
    ...rest,
    ...(oa ? {
      oauth: {
        provider: oa.provider || '',
        signedInAs: oa.signedInAs || a.email,
        needsReauth: !!oa.needsReauth,
        scope: oa.scope || '',
        features: Array.isArray(oa.features) ? oa.features : [],
      },
    } : {}),
    imap: { host: imap.host, port: imap.port, secure: imap.secure, user: imap.user, tlsRejectUnauthorized: imap.tlsRejectUnauthorized },
    smtp: effectiveSmtp({ imap, smtp }),
  };
}

/** This viewer's own accounts only — no shared-in ones. Used by sync.js so a
 * shared account is only ever background-polled once, via its owner's own
 * iteration: merging shared-in accounts into the general sync loop would
 * double-poll (and double-connect) every shared mailbox. Everything else that
 * wants "everything I can see" uses listAccounts() below instead. */
export function listOwnedAccounts() {
  return loadOwn().map(stripSecrets);
}

/** The same, for a caller outside any request's ALS context — the background
 *  reminder runner (server/calendarReminders.js), which walks every user in
 *  turn and carries its own key end to end. Same reasoning, and the same
 *  naming, as store.js's `getSettingsFor` and contactSources.js's
 *  `listSourcesFor`: the ambient version above stays the one every request
 *  uses, and a loop over users says whose accounts it means. */
export function listOwnedAccountsFor(uKey) {
  return loadRawFor(uKey).map(stripSecrets);
}

/** Accounts owned by OTHER Hmelj users but shared to this viewer — scans
 * every other user's own accounts.json (cheap at self-hosted scale; this
 * runs once per accounts-list fetch, never per mail operation) rather than
 * needing a separate shares index that could drift from the source of
 * truth (each owner's own file). */
// listSharedInAccounts() below does a full scan of EVERY Hmelj user's own accounts.json
// looking for a sharedWith entry naming this viewer — called (via listAccounts()) by
// essentially every polling route (sync status, unread count, unified inbox, folder
// list, ...), which in practice means it re-ran many times per second even though the
// answer — who has shared an account with this viewer — changes only on an explicit
// share/unshare action. Display-only value: every REAL permission check
// (isOwnAccount/resolveSharedOwnerKey/accessorKeysFor above) reads accounts.json
// directly and independently, uncached — a briefly-stale entry here can never grant or
// withhold real access, only make the account LIST momentarily lag an actual share
// change by up to SHARED_IN_CACHE_MS. Every known mutation path that could change the
// answer (shareAccount/unshareAccount/leaveSharedAccount/deleteAccount below) clears
// this outright, so the TTL is a safety net for anything not explicitly covered, not
// something normal usage actually waits out.
const sharedInCache = new Map(); // viewerUserId -> { value, expiresAt }
const SHARED_IN_CACHE_MS = 5000;

function listSharedInAccounts(viewerUserId, viewerKey) {
  const cached = sharedInCache.get(viewerUserId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const out = [];
  for (const u of listUsers()) {
    if (u.id === viewerUserId) continue;
    for (const a of loadRawFor(userKey(u.username))) {
      if ((a.sharedWith || []).some((s) => grantId(s) === viewerUserId)) {
        // sharedWith itself is dropped here (not just credentials) — the
        // full grantee list is only the owner's business; a grantee just
        // needs to know THIS account is shared and by whom.
        const { sharedWith, ...rest } = stripSecrets(a);
        // Per-viewer personalization (server/accountOverrides.js) — label/
        // color let this viewer rename/recolor the account in their own
        // sidebar only; hiddenFolders is unioned with the owner's own (never
        // replaces it — a grantee can hide more, never un-hide something the
        // owner excluded from sync). `myHiddenFolders` is the viewer's own
        // raw list, exposed separately so the folder-visibility screen can
        // tell "I hid this" apart from "the owner hid this" (and PATCH back
        // just their own list, not the merged one).
        const override = accountOverrides.getOverride(viewerKey, a.id) || {};
        out.push({
          ...rest,
          label: override.label || rest.label,
          color: override.color || rest.color,
          hiddenFolders: [...new Set([...(rest.hiddenFolders || []), ...(override.hiddenFolders || [])])],
          myHiddenFolders: override.hiddenFolders || [],
          shared: true, ownerId: u.id, ownerUsername: u.username,
        });
      }
    }
  }
  alog.debug(`listSharedInAccounts(${viewerUserId}): found ${out.length} shared-in account(s)`);
  sharedInCache.set(viewerUserId, { value: out, expiresAt: Date.now() + SHARED_IN_CACHE_MS });
  return out;
}

/** Everything this viewer can see: their own accounts plus anything shared
 * to them. Safe to send to the frontend (stripSecrets strips credentials
 * from both halves identically). */
export function listAccounts() {
  return [...listOwnedAccounts(), ...listSharedInAccounts(currentUser().userId, currentUser().viewerKey)];
}

/** userKeys of everyone with live access to a mail account (its owner plus
 * every grantee) — used to fan out SSE reconcile signals (events.js) and Web
 * Push new-mail notifications (sync.js) to every viewer of a shared account,
 * not just its owner. `ownerUserKey` must already be the account's real
 * owner (callers already have this: it's whatever ALS's userKey resolved to
 * for an account-scoped request, post ownership-swap). */
export function accessorKeysFor(ownerUserKey, accountId) {
  const acc = loadRawFor(ownerUserKey).find((a) => a.id === accountId);
  if (!acc) return [ownerUserKey];
  return [ownerUserKey, ...(acc.sharedWith || []).map((s) => userKey(s.username))];
}

/** Does `viewerUserKey`'s own accounts.json contain this accountId? The
 * cheap, common-case check — used both as the first step of the shared-
 * account resolution below and as the "is this caller actually the owner"
 * permission check server routes use for owner-only operations. */
export function isOwnAccount(viewerUserKey, accountId) {
  return loadRawFor(viewerUserKey).some((a) => a.id === accountId);
}

/** If accountId isn't the viewer's own (caller should already have checked
 * isOwnAccount first — this always does the full scan, so isn't the cheap
 * path itself), find which OTHER user owns it AND has actually shared it
 * with viewerUserId — returns that owner's userKey, or null. Called from
 * session.js's requireAuth to build the "operate under the owner's
 * namespace" ALS context for a shared account. */
export function resolveSharedOwnerKey(accountId, viewerUserId) {
  for (const u of listUsers()) {
    const uKey = userKey(u.username);
    const acc = loadRawFor(uKey).find((a) => a.id === accountId);
    if (acc && (acc.sharedWith || []).some((s) => grantId(s) === viewerUserId)) return uKey;
  }
  return null;
}

/** Username -> {userId, username}, or null. Used by the "share by username"
 * flow — deliberately returns nothing beyond confirming the username
 * exists and what it resolves to. */
function findUserByUsername(username) {
  const u = listUsers().find((x) => x.username.toLowerCase() === String(username || '').trim().toLowerCase());
  return u ? { userId: u.id, username: u.username } : null;
}

/** A stored sharedWith entry's id, tolerant of a legacy `{id}` shape that a
 * pre-fix build could have written to disk (see git history) — lets any
 * already-corrupted entry still be found/removed instead of getting stuck. */
function grantId(s) {
  return s.userId || s.id;
}

/** Owner-only (caller must already have checked isOwnAccount) — grants
 * `targetUsername` view/use access to accountId, idempotent (sharing with
 * someone already on the list is a no-op, not a duplicate entry). */
export function shareAccount(ownerUserKey, accountId, targetUsername) {
  const target = findUserByUsername(targetUsername);
  if (!target) throw new Error(`No Hmelj user named "${targetUsername}"`);
  const list = loadRawFor(ownerUserKey);
  const acc = list.find((a) => a.id === accountId);
  if (!acc) throw new Error('Mail account not found');
  if (!acc.sharedWith) acc.sharedWith = [];
  if (!acc.sharedWith.some((s) => grantId(s) === target.userId)) {
    acc.sharedWith.push(target);
    saveRawFor(ownerUserKey, list);
    sharedInCache.delete(target.userId); // this grantee's account list just changed
    alog.info(`Shared mail account "${acc.label}" (${acc.id}) with ${target.username} (${target.userId})`);
  } else {
    alog.info(`"${acc.label}" (${acc.id}) was already shared with ${target.username}`);
  }
  return acc.sharedWith;
}

/** A former grantee's own identities (store.js's per-user identities.json)
 * that sent via this account are dead weight the moment their access is
 * gone — nothing left to send through, and they'd otherwise sit there
 * forever as a mysterious "Other" group in Settings › Identities (no
 * account left to group them under). Called from both revocation paths
 * below; client-side "Leave" already does the equivalent for its own
 * browser's state (settings.js), but only the owner-initiated unshare path
 * genuinely needs this done server-side — the affected user isn't the one
 * making that request. */
function dropGranteeIdentities(granteeUserKey, accountId) {
  const ids = store.getIdentitiesFor(granteeUserKey);
  const next = ids.filter((i) => i.accountId !== accountId);
  if (next.length !== ids.length) store.saveIdentitiesFor(granteeUserKey, next);
}

/** Owner-only — revokes one grantee's access. */
export function unshareAccount(ownerUserKey, accountId, targetUserId) {
  const list = loadRawFor(ownerUserKey);
  const acc = list.find((a) => a.id === accountId);
  if (!acc) throw new Error('Mail account not found');
  const removed = (acc.sharedWith || []).find((s) => grantId(s) === targetUserId);
  acc.sharedWith = (acc.sharedWith || []).filter((s) => grantId(s) !== targetUserId);
  saveRawFor(ownerUserKey, list);
  if (removed) {
    const removedKey = userKey(removed.username);
    // No point leaving a personalization (accountOverrides.js) or dangling
    // identities behind for an account this person can no longer see.
    accountOverrides.clearOverride(removedKey, accountId);
    dropGranteeIdentities(removedKey, accountId);
    sharedInCache.delete(targetUserId); // this grantee's account list just changed
  }
  return acc.sharedWith;
}

/** Grantee-initiated "remove myself from this share" — needs to reach into
 * the OWNER's file (found the same way resolveSharedOwnerKey does) since a
 * grantee has no write access to it otherwise. Returns whether anything was
 * actually removed. */
export function leaveSharedAccount(accountId, viewerUserId) {
  for (const u of listUsers()) {
    const uKey = userKey(u.username);
    const list = loadRawFor(uKey);
    const acc = list.find((a) => a.id === accountId);
    if (acc && (acc.sharedWith || []).some((s) => grantId(s) === viewerUserId)) {
      acc.sharedWith = acc.sharedWith.filter((s) => grantId(s) !== viewerUserId);
      saveRawFor(uKey, list);
      const viewer = listUsers().find((x) => x.id === viewerUserId);
      if (viewer) {
        const viewerKeyStr = userKey(viewer.username);
        accountOverrides.clearOverride(viewerKeyStr, accountId);
        dropGranteeIdentities(viewerKeyStr, accountId);
      }
      sharedInCache.delete(viewerUserId); // this grantee's own account list just changed
      return true;
    }
  }
  return false;
}

function getAccountFrom(list, accountId) {
  const a = list.find((x) => x.id === accountId);
  if (!a) throw new Error('Mail account not found');
  // A Graph account has no password at all — its whole credential is the token
  // pair, decrypted here so oauth.js#accessTokenFor can spend it.
  if (a.type === 'graph') {
    return {
      ...a,
      graph: {
        ...a.graph,
        refreshToken: a.graph?.refreshToken ? decrypt(a.graph.refreshToken) : '',
        accessToken: a.graph?.accessToken ? decrypt(a.graph.accessToken) : '',
      },
    };
  }
  if (a.type === 'ews') {
    return { ...a, ews: { ...a.ews, pass: decrypt(a.ews.pass) } };
  }
  const imapPass = decrypt(a.imap.pass);
  return {
    ...a,
    // XOAUTH2 account (Gmail): imap.pass is a stored empty string and the real
    // credential is this token pair, decrypted here so oauth.js#accessTokenFor
    // can spend it — imapClient/smtpClient then authenticate with a bearer
    // token instead of a password.
    ...(a.oauth ? {
      oauth: {
        ...a.oauth,
        refreshToken: a.oauth.refreshToken ? decrypt(a.oauth.refreshToken) : '',
        accessToken: a.oauth.accessToken ? decrypt(a.oauth.accessToken) : '',
      },
    } : {}),
    imap: { ...a.imap, pass: imapPass },
    smtp: {
      ...effectiveSmtp(a),
      pass: a.smtp.sameCredentials ? imapPass : (a.smtp.pass ? decrypt(a.smtp.pass) : ''),
    },
  };
}

/** Full account incl. decrypted passwords — server-side use only. */
export function getAccount(accountId) {
  return getAccountFrom(loadRaw(), accountId);
}

/**
 * Is full-text indexing on for this account? Answered from an explicit owner
 * key rather than the ambient request user, because the caller
 * (server/contentCache.js) is often running under a shared account's OWNER —
 * and the flag that governs what gets written into that owner's cache is the
 * owner's, not the viewer's. Reads no credentials, so it is cheap enough to
 * ask once per cached message.
 */
export function isSearchIndexed(ownerUserKey, accountId) {
  return !!loadRawFor(ownerUserKey).find((a) => a.id === accountId)?.searchIndex;
}

/** Account for the current request (ALS accountId). */
export function currentAccount() {
  const { accountId } = currentUser();
  if (!accountId) {
    const e = new Error('No mail account selected (missing ?account= parameter)');
    e.status = 400;
    throw e;
  }
  return getAccount(accountId);
}

/**
 * Full account (incl. decrypted credentials) for accountId, resolving
 * ownership on its own rather than trusting ALS's accountId-driven swap
 * (session.js's requireAuth) to already have happened — needed because
 * identity-based sending (smtpClient.js#resolveIdentityAndAccount) picks its
 * account from the compose payload's identityId, not a `?account=` query
 * param, so the normal per-request ownership swap never triggers for it.
 * Without this, a grantee sending mail through a shared account's identity
 * got "Mail account not found" (their own accounts.json, which has no such
 * account) the moment their OWN send attempt tried to resolve it.
 * Returns { acc, ownerUser } — ownerUser ({id, username}) is whose ALS
 * context callers must actually run the connection under
 * (session.js#runAsAccount), since IMAP/EWS pooling and every cache table
 * key off userKey.
 */
export function resolveAccountForSending(accountId) {
  const { userId, username } = currentUser();
  if (isOwnAccount(userKey(username), accountId)) {
    return { acc: getAccount(accountId), ownerUser: { id: userId, username } };
  }
  const ownerKey = resolveSharedOwnerKey(accountId, userId);
  if (!ownerKey) throw new Error('Mail account not found');
  const owner = listUsers().find((u) => userKey(u.username) === ownerKey);
  if (!owner) throw new Error('Mail account not found');
  return { acc: getAccountFrom(loadRawFor(ownerKey), accountId), ownerUser: { id: owner.id, username: owner.username } };
}

/**
 * The stored sign-in block — the entire credential for an account that has no
 * password: `graph` for a Microsoft account, `oauth` for one that spends the
 * token on IMAP/SMTP via XOAUTH2 (Gmail). A completed sign-in hands its tokens
 * over here via its one-time `state`; an edit that doesn't re-sign-in keeps the
 * previous tokens verbatim, the same "blank means keep what's there" idiom the
 * password fields use.
 */
function oauthRecordFor(input, prev, field) {
  const state = input[field]?.state;
  if (!state) {
    if (!prev?.[field]) {
      throw Object.assign(new Error('This account has no completed sign-in. Press the sign-in button first.'), { status: 400 });
    }
    return prev[field];
  }
  // viewerKey: the sign-in flow was filed under whoever started it (see
  // index.js's /api/oauth/start). oauth.accessTokenFor() below is the opposite
  // case and deliberately still uses userKey — it writes a rotated refresh token
  // back, which for a shared account has to land in the OWNER's record.
  const t = oauth.takeFlowTokens(state, currentUser().viewerKey);
  return {
    provider: t.provider,
    signedInAs: t.email,
    refreshToken: encrypt(t.refreshToken),
    accessToken: encrypt(t.accessToken),
    expiresAt: t.expiresAt,
    scope: t.scope,
    // See attachOAuthSignIn for what this is and why it has to be stored.
    features: Array.isArray(t.features) ? t.features : [],
    needsReauth: false,
  };
}

export function saveAccount(input, existingId = null) {
  // saveOwn: creating goes into the caller's OWN list, and every edit path is
  // requireOwnAccount-guarded (index.js), so the viewer is the owner there anyway.
  const list = loadOwn();
  const idx = existingId ? list.findIndex((a) => a.id === existingId) : -1;
  const prev = idx >= 0 ? list[idx] : null;
  // Editing never sends `type` again (the wizard doesn't let you change an
  // account's type after creation — the two field sets share nothing), so
  // it has to come from the existing row then; only a genuinely new account
  // supplies it fresh, defaulting to 'imap' so old callers/stored accounts
  // (every account that predates EWS support) keep working unchanged.
  const type = input.type || prev?.type || 'imap';

  // An IMAP account can authenticate with an OAuth sign-in instead of a
  // password (Gmail — see server/oauth.js). It stays type:'imap' because that
  // is genuinely what it is: same imapClient, same smtpClient, same folders and
  // caching, with a bearer token where the password used to be. What it does NOT
  // have is server fields for the user to fill in — the wizard hides them and
  // the provider's own known endpoints are stored instead.
  // An explicit `oauth: null` is the wizard's "use an app password instead"
  // escape hatch: the account keeps its id and everything keyed to it, and the
  // whole record is rebuilt below from the IMAP fields, so simply resolving no
  // provider here is what drops the sign-in block.
  const oauthProvider = type === 'imap' && input.oauth !== null
    ? (input.oauth?.provider || prev?.oauth?.provider || '')
    : '';
  const d = oauthProvider ? (oauth.imapDefaultsFor(oauthProvider) || {}) : null;
  const imapIn = d
    ? {
      host: prev?.imap?.host || d.host,
      port: prev?.imap?.port || d.port,
      secure: prev?.imap?.secure ?? d.secure,
      user: input.email || prev?.imap?.user,
      pass: '', // never used: the credential is the token
      tlsRejectUnauthorized: true,
    }
    : (input.imap || {});
  const smtpIn = d
    ? {
      // Gmail's SMTP host differs from its IMAP host, so "same server" is
      // wrong here — but the credential is shared (one token authenticates
      // both), which is what sameCredentials means to effectiveSmtp().
      sameServer: false,
      sameCredentials: true,
      host: prev?.smtp?.host || d.smtpHost,
      port: prev?.smtp?.port || d.smtpPort,
      secure: prev?.smtp?.secure ?? d.smtpSecure,
    }
    : (input.smtp || {});

  const acc = {
    id: prev?.id || crypto.randomUUID(),
    type,
    label: input.label || input.email || 'Mail',
    email: input.email,
    // Shown alongside the e-mail address as the display name on outgoing
    // mail (kept in sync with the default identity's `name` field below).
    senderName: input.senderName ?? prev?.senderName ?? '',
    color: input.color || prev?.color || ACCOUNT_COLORS[list.length % ACCOUNT_COLORS.length],
    // A Graph account has no host, port, TLS or password to store at all —
    // the OAuth token pair IS the account. That is also why it needs its own
    // branch rather than riding along on the imap one.
    ...(type === 'graph' ? {
      graph: oauthRecordFor(input, prev, 'graph'),
    } : type === 'ews' ? {
      ews: {
        url: input.ews.url,
        domain: input.ews.domain || '',
        user: input.ews.user || input.email,
        // keep previous password when the edit form leaves it blank
        pass: input.ews.pass ? encrypt(input.ews.pass) : (prev?.ews ? prev.ews.pass : encrypt('')),
        tlsRejectUnauthorized: input.ews.tlsRejectUnauthorized !== false,
      },
    } : {
      // Only present for an OAuth-signed-in IMAP account; a password account
      // never grows this key, so `a.oauth` is also how every other code path
      // tells the two apart (getAccountFrom, stripSecrets, updateOAuthTokens).
      ...(oauthProvider ? { oauth: oauthRecordFor(input, prev, 'oauth') } : {}),
      imap: {
        host: imapIn.host,
        port: +imapIn.port || 993,
        secure: imapIn.secure !== false,
        user: imapIn.user || input.email,
        // keep previous password when the edit form leaves it blank
        pass: imapIn.pass ? encrypt(imapIn.pass) : (prev?.imap ? prev.imap.pass : encrypt('')),
        tlsRejectUnauthorized: imapIn.tlsRejectUnauthorized !== false,
      },
      smtp: (() => {
        const sameServer = !!smtpIn.sameServer;
        const sameCredentials = !!smtpIn.sameCredentials;
        return {
          sameServer,
          sameCredentials,
          // When "same as IMAP" is on, don't bother storing a value at all —
          // effectiveSmtp() always resolves from imap.* live, so a stale copy
          // here would just be confusing (and wrong after an IMAP-only edit).
          host: sameServer ? '' : (smtpIn.host || imapIn.host),
          port: sameServer ? null : (+smtpIn.port || 465),
          secure: sameServer ? null : (smtpIn.secure !== false),
          user: sameCredentials ? '' : (smtpIn.user || imapIn.user || input.email),
          pass: sameCredentials ? '' : (
            smtpIn.pass ? encrypt(smtpIn.pass)
              // keep the previous password when the edit form leaves it blank
              : (prev && !prev.smtp?.sameCredentials && prev.smtp?.pass ? prev.smtp.pass : encrypt(''))
          ),
        };
      })(),
    }),
    sentFolder: input.sentFolder || prev?.sentFolder || 'Sent',
    draftsFolder: input.draftsFolder || prev?.draftsFolder || 'Drafts',
    trashFolder: input.trashFolder || prev?.trashFolder || 'Trash',
    // ?? rather than ||, unlike the three above: '' is a real answer here — it
    // means "this account has no Junk/Archive folder", which is a thing the
    // owner can choose in Settings › Folders ((None) in those two pickers).
    // With || that choice was silently undone by the next account edit.
    junkFolder: input.junkFolder ?? prev?.junkFolder ?? '',
    archiveFolder: input.archiveFolder ?? prev?.archiveFolder ?? '',
    hiddenFolders: input.hiddenFolders || prev?.hiddenFolders || [],
    // Where snoozed mail waits (server/snooze.js). Empty means "not chosen
    // yet" — the folder is created on the first snooze and the name written
    // back here then, rather than being conjured at account-creation time on
    // every account whether or not anyone ever snoozes anything.
    snoozeFolder: input.snoozeFolder ?? prev?.snoozeFolder ?? '',
    // Which mail server's Authentication-Results verdict to trust
    // (server/authResults.js). Empty means "the topmost header", which is right
    // whenever Hmelj reads a mailbox on the server that did the checking — the
    // normal case. Set it to your own MX's authserv-id if mail reaches this
    // mailbox through a relay that adds its own header on top of the real one.
    authservId: input.authservId ?? prev?.authservId ?? '',
    // Notification scheduler (server/schedule.js) — null/{} mean "no schedule
    // configured," which resolveEffectiveSchedule() treats identically to today's
    // behavior (always notify), so every existing account is unaffected until its
    // owner actually visits the new Scheduler settings tab. notificationSchedule is
    // account-wide; folderNotificationSchedules holds per-folder overrides that
    // REPLACE (not combine with) the account-wide one for that folder path.
    notificationSchedule: input.notificationSchedule ?? prev?.notificationSchedule ?? null,
    folderNotificationSchedules: input.folderNotificationSchedules ?? prev?.folderNotificationSchedules ?? {},
    // Temporary per-folder "Mute for a while" (folder right-click → Mute): folder path →
    // the epoch-ms instant the silence ends. Separate from the schedules above on
    // purpose — see server/schedule.js#folderMutedUntil — and written only through
    // setFolderMute() below, never through the settings form.
    folderMutes: input.folderMutes ?? prev?.folderMutes ?? {},
    // IMAP only — off by default: one shared connection for everything, same
    // as always. On: background sync gets its own dedicated connection
    // instead of sharing the one interactive requests use (see
    // imapClient.js's pool) — opening a message no longer queues behind an
    // in-flight sync. Meaningless for an EWS account (ewsClient.js pools a
    // keep-alive HTTP agent instead, there's no comparable "second
    // connection" concept) — harmless to carry the field regardless.
    allowSecondConnection: input.allowSecondConnection ?? prev?.allowSecondConnection ?? false,
    // Full-text search over this account's message bodies (cache.js#message_fts).
    // Off by default and opt-in per account, because it is the one cached
    // structure whose size tracks how much TEXT a mailbox holds rather than how
    // many messages — most people want it on the one or two mailboxes they
    // actually search, not on all of them. Owner-only: it decides what gets
    // written to disk, so it is not something a grantee may flip
    // (accountOverrides.js is for a viewer's own presentation of a shared
    // account — label, colour, which folders they see).
    searchIndex: input.searchIndex ?? prev?.searchIndex ?? false,
    // How this account is watched for new mail (see server/idle.js and
    // sync.js's scheduler):
    //   'poll' — check every pollIntervalMs (the original behavior, and still
    //            the default: nothing changes for an existing account)
    //   'idle' — hold an IMAP IDLE connection (or, for an Exchange account, an
    //            EWS streaming subscription) so new mail shows up in about a
    //            second instead of up to a full poll interval later. Costs one
    //            persistent connection per account, which is why it's opt-in
    //            per account rather than global: a mailbox you care about
    //            instantly and one you're happy to hear about every 15 minutes
    //            shouldn't cost the same.
    // An 'idle' account still polls too, on its own (longer) interval — IDLE
    // is a trigger, not a replacement, so a dropped watcher degrades to the
    // old behavior instead of going silent.
    monitorMode: input.monitorMode === 'idle' ? 'idle' : (input.monitorMode === 'poll' ? 'poll' : (prev?.monitorMode ?? 'poll')),
    // null = use the server-wide config.syncIntervalMs.
    pollIntervalMs: input.pollIntervalMs === undefined
      ? (prev?.pollIntervalMs ?? null)
      : (input.pollIntervalMs === null ? null : Math.max(30e3, +input.pollIntervalMs || 0) || null),
    disabled: prev?.disabled || false,
    createdAt: prev?.createdAt || new Date().toISOString(),
    // Never touched by the general edit form (input never carries this) —
    // only shareAccount()/unshareAccount() write it, so a routine credential
    // edit can't accidentally clobber who this account is shared with.
    sharedWith: prev?.sharedWith || [],
  };

  const isNew = idx < 0;
  if (idx >= 0) list[idx] = acc; else list.push(acc);
  saveOwn(list); // pairs with the loadOwn() this function opened with

  // Only now that the tokens are safely on disk is the sign-in spent — the
  // wizard's "Test & save" reads the same flow twice (probe, then save), and
  // a save that threw would otherwise leave the user with no way back except
  // signing in again.
  const usedState = type === 'graph' ? input.graph?.state : (oauthProvider ? input.oauth?.state : '');
  if (usedState) {
    oauth.markFlowConsumed(usedState);
    oauth.forgetTokens(currentUser().userKey, acc.id);
  }
  const connSummary = type === 'graph'
    ? `graph=${acc.graph.provider}/${acc.graph.signedInAs || acc.email}`
    : type === 'ews'
      ? `ews=${acc.ews.url}`
      : `imap=${acc.imap.host}:${acc.imap.port} smtp=${acc.smtp.sameServer ? 'same as imap' : acc.smtp.host + ':' + acc.smtp.port}`
        + (acc.oauth ? ` auth=xoauth2/${acc.oauth.provider}` : '');
  alog.info(`${isNew ? 'Created' : 'Updated'} mail account "${acc.label}" (${acc.id}) ${connSummary}`);

  // Every mail account gets at least one identity, guaranteed here — not
  // just when the account is first created (accounts saved before this
  // check existed could otherwise stay identity-less forever, since editing
  // never re-checked) — and its display name stays in sync with the
  // account's "Sender name" field on every save, new or edited.
  const ids = store.getIdentities();
  let defaultIdentity = ids.find((i) => i.accountId === acc.id && i.default) || ids.find((i) => i.accountId === acc.id);
  if (!defaultIdentity) {
    defaultIdentity = {
      id: acc.id, name: acc.senderName || '', email: acc.email, organization: '', replyTo: '',
      signature: defaultSignature(acc.senderName || acc.label), signatureOn: 'new-reply',
      accountId: acc.id, default: !ids.some((i) => i.default),
    };
    ids.push(defaultIdentity);
    store.saveIdentities(ids);
  } else if (input.senderName !== undefined && defaultIdentity.name !== acc.senderName) {
    defaultIdentity.name = acc.senderName;
    store.saveIdentities(ids);
  }

  return listAccounts().find((a) => a.id === acc.id);
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Starting signature for a brand-new account's default identity. */
function defaultSignature(name) {
  return name ? `-- <br>${escHtml(name)}` : '';
}

export function deleteAccount(accountId) {
  // Own-file helpers here and in the two updaters below: every one of these routes
  // is requireOwnAccount-guarded (index.js), so the viewer already IS the owner —
  // keying off viewerKey just means that guard is no longer the only thing keeping
  // the write out of somebody else's file.
  saveOwn(loadOwn().filter((a) => a.id !== accountId));
  deleteAccountCache(currentUser().userKey, accountId);
  // The filter high-water marks too: a folder path under a REUSED account id
  // would otherwise inherit a promise that filters had already covered it.
  try { filterState.forgetAccount(currentUser().userKey, accountId); } catch { /* nothing recorded yet */ }
  // Cached bearer token for an account that no longer exists — harmless, but
  // it would otherwise be handed to a brand-new account that happened to
  // reuse the id, and it's a live credential sitting in memory for nothing.
  oauth.forgetTokens(currentUser().userKey, accountId);
  // Don't know here who (if anyone) this account was shared with without an extra
  // lookup — clearing the whole (small, per-process) cache outright is simpler and
  // just as cheap as figuring out precisely who's affected for a mutation this rare.
  sharedInCache.clear();
  alog.info(`Deleted mail account ${accountId}`);
}

/**
 * Silence one folder's notifications until `untilMs` (epoch ms), or lift the silence
 * when `untilMs` is falsy or already in the past. Returns the account's resulting folderMutes map.
 *
 * Re-reads and writes the whole file like updateAccountFields, but touches only this one
 * folder's entry, and prunes any entry that has already lapsed while it's here — that
 * sweep is why nothing needs a timer to clean expired mutes up (readers ignore a past
 * instant anyway, see schedule.js#folderMutedUntil).
 */
export function setFolderMute(accountId, folderPath, untilMs) {
  const list = loadOwn();
  const a = list.find((x) => x.id === accountId);
  if (!a) throw new Error('Mail account not found');
  const now = Date.now();
  const next = {};
  for (const [path, until] of Object.entries(a.folderMutes || {})) {
    if (typeof until === 'number' && until > now) next[path] = until;
  }
  if (untilMs && untilMs > now) next[folderPath] = untilMs;
  else delete next[folderPath];
  a.folderMutes = next;
  saveOwn(list);
  return next;
}

export function updateAccountFields(accountId, patch) {
  const list = loadOwn();
  const a = list.find((x) => x.id === accountId);
  if (!a) throw new Error('Mail account not found');
  Object.assign(a, patch);
  saveOwn(list);
}

/**
 * Merge a patch into one account's `graph` block, for a specific user.
 *
 * Deliberately not updateAccountFields(): that one runs in the ambient ALS
 * context (wrong for a shared account, whose tokens live in the OWNER's
 * accounts.json) and rewrites the whole record from an in-memory copy, so a
 * token refresh landing while the user was editing settings would quietly
 * revert the edit. This re-reads the file, touches only `graph`, and writes
 * back — the window in which a refresh can clobber anything is a few
 * microseconds of synchronous code.
 *
 * Called from oauth.js on every refresh, which is why it must stay cheap and
 * must never throw for a deleted account (a background refresh racing a
 * delete is a normal thing to happen, not an error worth surfacing).
 */
/**
 * Attach a completed sign-in to an account that ALREADY EXISTS, in place —
 * either refreshing the credential of an account that already signs in, or
 * migrating a password account onto OAuth without recreating it.
 *
 * Keeping the same account id is the whole point of doing it this way rather
 * than "remove and add again": the id is what identities/signatures, filters,
 * the message cache, the analytics index, folder visibility, special-folder
 * mappings, notification schedules and share grants are all keyed by. Deleting
 * the account drops the cache and the analytics index outright and leaves the
 * rest pointing at an id that no longer exists.
 *
 * Which block the tokens land in is decided by the PROVIDER, not by what the
 * record happens to have already — a Google sign-in is an XOAUTH2 IMAP
 * credential (`oauth`) and a Microsoft one is a Graph credential (`graph`), and
 * a password account has neither yet.
 */
export function attachOAuthSignIn(uKey, accountId, t) {
  const list = loadRawFor(uKey);
  const a = list.find((x) => x.id === accountId);
  if (!a) throw Object.assign(new Error('Mail account not found'), { status: 404 });
  const field = oauth.kindOf(t.provider) === 'imap' ? 'oauth' : 'graph';

  // Migrating a password account: only ever onto its own provider's servers.
  const migrating = field === 'oauth' && !a.oauth;
  if (migrating) {
    if (a.type && a.type !== 'imap') {
      throw Object.assign(new Error(`This sign-in replaces an IMAP password, but ${a.label || a.email} is not an IMAP account.`), { status: 400 });
    }
    if (!oauth.canAttachToImapHost(t.provider, a.imap?.host)) {
      throw Object.assign(new Error(`${a.label || a.email} connects to ${a.imap?.host || 'another server'}, which this sign-in cannot authenticate against.`), { status: 400 });
    }
  }

  a[field] = {
    provider: t.provider,
    signedInAs: t.email,
    refreshToken: encrypt(t.refreshToken),
    accessToken: encrypt(t.accessToken),
    expiresAt: t.expiresAt,
    scope: t.scope,
    // Which OPTIONAL scopes this sign-in was consented to (see
    // oauth.js#FEATURE_SCOPES) — 'contacts', 'calendar'. Absent on every
    // account that predates the feature, which is what keeps those asking for
    // exactly the scopes they always did.
    features: Array.isArray(t.features) ? t.features : [],
    needsReauth: false,
  };

  if (migrating) {
    // The app password is dead weight the moment the token takes over, and
    // leaving a live credential encrypted on disk for no reason is worse than
    // pointless — nothing reads it again unless the user deliberately switches
    // back, which re-asks for it anyway.
    a.imap.pass = encrypt('');
    if (a.smtp) {
      // One token authenticates both legs, which is exactly what
      // sameCredentials means to effectiveSmtp() — so any separately stored
      // SMTP password goes too, rather than sitting there being ignored.
      a.smtp.sameCredentials = true;
      a.smtp.user = '';
      a.smtp.pass = '';
    }
  }
  saveRawFor(uKey, list);
  alog.info(`${a.label || a.email}: ${migrating ? 'switched from a password to' : 'refreshed'} ${t.provider} sign-in (${field})`);
  return { migrating, field };
}

export function updateOAuthTokens(uKey, accountId, patch) {
  const list = loadRawFor(uKey);
  const a = list.find((x) => x.id === accountId);
  if (!a) return;
  // Whichever block this account actually keeps its sign-in in: `graph` for a
  // Microsoft account, `oauth` for one that spends the token on IMAP/SMTP
  // instead (Gmail). Writing to the wrong one would leave the live credential
  // untouched and quietly stop rotation.
  const field = a.oauth ? 'oauth' : 'graph';
  a[field] = { ...(a[field] || {}), ...patch };
  saveRawFor(uKey, list);
}

/* ---------------- connection testing & folder detection ---------------- */

/**
 * ImapFlow's Error.message for any rejected command is the flat string
 * "Command failed" — the server's actual reply lives on `.responseText`, and an
 * authentication rejection additionally sets `.authenticationFailed`. Passing
 * `.message` straight through is what put "Connection test failed: Command
 * failed" in front of the user, which says nothing about what to change.
 */
function describeImapError(e) {
  const detail = e.responseText || e.message || 'unknown error';
  if (!e.authenticationFailed) return detail;
  return `The mail server rejected these credentials (${detail}).`;
}

/**
 * The same rejection, for a connection authenticating with an OAuth token
 * instead of a password. Gmail answers a token it doesn't like with a flat
 * "Invalid credentials", which sends people hunting for a typo in a password
 * they never typed — the actual cause is nearly always the app registration
 * (missing mail scope, or a token minted before the scope was added), so say so.
 */
function describeXoauthError(e, providerId) {
  const detail = e.responseText || e.message || 'unknown error';
  const label = providerId === 'google' ? 'Google' : providerId;
  // Only an actual credential rejection earns the advice below. A refused
  // connection or a DNS failure has nothing to do with scopes, and saying so
  // would send the reader off to the Cloud console for no reason.
  const rejected = e.authenticationFailed || /invalid credentials|authenticationfailed|\b535\b|\bAUTH\b/i.test(detail);
  if (!rejected) return detail;
  if (providerId === 'google') {
    return `${label} accepted the sign-in but rejected it for mail access (${detail}). `
      + 'That normally means the OAuth client is missing the https://mail.google.com/ scope on its consent screen — add it, then remove Hmelj at myaccount.google.com/permissions and sign in again so a new token is issued with it.';
  }
  return `${label} rejected the sign-in for mail access (${detail}).`;
}

/**
 * Verifies IMAP + SMTP credentials and auto-detects special-use folders
 * (works with Gmail's "[Gmail]/Sent Mail" style names) — or, for an Exchange
 * account, verifies EWS/NTLM credentials via ewsClient.js's own one-off probe
 * (no SMTP check needed there; EWS sends and saves in one call), or, for a
 * Microsoft Graph account, spends the bearer token on one Graph request.
 *
 * Runs on raw wizard input before any account row exists, so this branches on
 * `input.type` directly rather than an account's own stored type — and, for
 * Graph, resolves the token from the just-completed sign-in flow rather than
 * from a stored record that doesn't exist yet.
 */
export async function testConnection(input) {
  if (input.type === 'graph') {
    let accessToken;
    if (input.graph?.state) {
      accessToken = oauth.takeFlowTokens(input.graph.state, currentUser().viewerKey).accessToken;
    } else if (input.id) {
      // Editing an existing account without signing in again — spend the
      // stored refresh token instead.
      accessToken = await oauth.accessTokenFor(getAccount(input.id), currentUser().userKey);
    } else {
      throw Object.assign(new Error('This account has no completed sign-in. Press "Sign in with Microsoft" first.'), { status: 400 });
    }
    alog.debug(`Testing connection: graph=${input.email}`);
    try {
      const special = await graphTestConnection(accessToken);
      alog.debug(`Graph test OK for ${input.email}`);
      return { ok: true, ...special };
    } catch (e) {
      alog.warn(`Graph test failed for ${input.email}:`, e.message);
      if (!e.status) e.status = 400;
      throw e;
    }
  }

  if (input.type === 'ews') {
    alog.debug(`Testing connection: ews=${input.ews.url} user=${input.ews.user || input.email} domain=${input.ews.domain || '(none)'}`);
    try {
      const special = await ewsTestConnection(input.ews);
      alog.debug(`EWS test OK for ${input.ews.url}`);
      return { ok: true, ...special };
    } catch (e) {
      alog.warn(`EWS test failed for ${input.ews.url}:`, e.message);
      throw e;
    }
  }

  // An IMAP account signed in with OAuth (Gmail) has no server fields in the
  // wizard at all, so they come from the provider's own known endpoints — and
  // its credential is a bearer token resolved the same two ways the Graph
  // branch above resolves one: from the sign-in that just completed, or from
  // what's already stored when re-testing an edit.
  const oauthProvider = input.oauth?.provider || '';
  const d = oauthProvider ? (oauth.imapDefaultsFor(oauthProvider) || {}) : null;
  let accessToken = '';
  if (oauthProvider) {
    if (input.oauth?.state) {
      accessToken = oauth.takeFlowTokens(input.oauth.state, currentUser().viewerKey).accessToken;
    } else if (input.id) {
      accessToken = await oauth.accessTokenFor(getAccount(input.id), currentUser().userKey);
    } else {
      throw Object.assign(new Error('This account has no completed sign-in. Press the sign-in button first.'), { status: 400 });
    }
  }
  const imapIn = d
    ? { host: d.host, port: d.port, secure: d.secure, user: input.email, tlsRejectUnauthorized: true }
    : (input.imap || {});

  alog.debug(`Testing connection: imap=${imapIn.host}:${imapIn.port} user=${imapIn.user || input.email} auth=${oauthProvider ? 'xoauth2/' + oauthProvider : 'password'} smtp.sameServer=${!!input.smtp?.sameServer} smtp.sameCredentials=${!!input.smtp?.sameCredentials}`);
  const imapOpts = {
    host: imapIn.host,
    port: +imapIn.port || 993,
    secure: imapIn.secure !== false,
    // imapflow picks XOAUTH2 over LOGIN purely from `accessToken` being present.
    auth: accessToken
      ? { user: imapIn.user || input.email, accessToken }
      : { user: imapIn.user || input.email, pass: imapIn.pass },
    logger: false,
    tls: { rejectUnauthorized: imapIn.tlsRejectUnauthorized !== false },
    socketTimeout: 30000, // same reasoning as imapClient.js's pooled connections — don't hang the wizard for 5 minutes on a dead server
  };
  const c = new ImapFlow(imapOpts);
  let special = {};
  try {
    await c.connect();
    const folders = await c.list();
    const byUse = (use) => folders.find((f) => f.specialUse === use)?.path;
    // Only ever a folder that REALLY exists on this server, matched by name
    // when SPECIAL-USE isn't reported. Junk and Archive end up empty rather
    // than guessed, unlike the three above them: nothing breaks without them
    // (sending needs a Sent folder, these are conveniences), and empty is what
    // the reading pane reads as "this account has no such folder", which is why
    // its Mark-as-spam / Archive entries don't appear. The owner can always
    // name one in Settings › Folders.
    const byName = (names) => folders.find((f) => names.includes(String(f.name || '').toLowerCase())
      || names.includes(String(f.path || '').toLowerCase()))?.path;
    special = {
      sentFolder: byUse('\\Sent') || 'Sent',
      draftsFolder: byUse('\\Drafts') || 'Drafts',
      trashFolder: byUse('\\Trash') || 'Trash',
      junkFolder: byUse('\\Junk') || byName(['junk', 'spam', 'junk e-mail', 'junk email', 'neželena pošta']) || '',
      archiveFolder: byUse('\\Archive') || byName(['archive', 'archives', 'arhiv']) || '',
    };
    alog.debug(`IMAP test OK: ${folders.length} folders, special=`, special);
    await c.logout().catch(() => {});
  } catch (e) {
    const why = oauthProvider ? describeXoauthError(e, oauthProvider) : describeImapError(e);
    alog.warn(`IMAP test failed for ${imapIn.host}: ${why}`);
    throw Object.assign(new Error(why), { status: 400 });
  } finally {
    try { c.close(); } catch { /* closed */ }
  }

  const smtpIn = d ? { host: d.smtpHost, port: d.smtpPort, secure: d.smtpSecure } : (input.smtp || {});
  const smtp = nodemailer.createTransport({
    host: smtpIn.sameServer ? imapIn.host : (smtpIn.host || imapIn.host),
    port: smtpIn.sameServer ? (+imapIn.port || 993) : (+smtpIn.port || 465),
    secure: smtpIn.sameServer ? (imapIn.secure !== false) : (smtpIn.secure !== false),
    auth: accessToken
      // nodemailer needs type:'OAuth2' spelled out (unlike imapflow, which
      // infers it) and, given an accessToken, will not try to mint one itself.
      ? { type: 'OAuth2', user: imapIn.user || input.email, accessToken }
      : {
        user: smtpIn.sameCredentials ? (imapIn.user || input.email) : (smtpIn.user || imapIn.user || input.email),
        pass: smtpIn.sameCredentials ? imapIn.pass : (smtpIn.pass || imapIn.pass),
      },
    tls: { rejectUnauthorized: imapIn.tlsRejectUnauthorized !== false },
  });
  try {
    await smtp.verify();
  } catch (e) {
    const why = oauthProvider
      ? describeXoauthError(e, oauthProvider)
      : (/invalid|auth|535|credential/i.test(e.message)
        ? describeImapError({ ...e, message: e.message, authenticationFailed: true })
        : e.message);
    alog.warn(`SMTP test failed: ${why}`);
    throw Object.assign(new Error(why), { status: 400 });
  }
  smtp.close();
  alog.debug('SMTP test OK');

  return { ok: true, ...special };
}
