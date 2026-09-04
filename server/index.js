import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import sanitizeHtml from 'sanitize-html';
import multer from 'multer';
import { config } from './config.js';
import { store } from './store.js';
import * as imap from './mailClient.js';
import { sendMail, buildRaw, resolveIdentityAndAccount, sendRawMessage } from './smtpClient.js';
import { buildMdn, receiptAddressOf } from './readReceipt.js';
import { collapseQuotedHtml, anchorsIn } from './quoteCollapse.js';
import { isSafePostTarget, parseMailto, pickUnsubscribeAnchor, ONE_CLICK_BODY } from './unsubscribe.js';
import { BOX_FOLDER, isBox, HOME_FALLBACK, noteOrigins, recallOrigin, dropOrigins, planReturn, originKey } from './refile.js';
import { isActionable } from './icalendar.js';
import { createByteLru, attachmentKey, etagFor, etagMatches } from './attachmentCache.js';
import { zipSync, safeEntryName } from './zip.js';
import { runFilters } from './filters.js';
import {
  requireAuth, createSession, destroySession, sessionFromRequest,
  setSessionCookie, clearSessionCookie, parseCookies, COOKIE_NAME,
  createUser, verifyUser, hasAnyUser,
  loginAllowed, loginFailed, loginSucceeded,
  isAdminUser, listUsers, setUserDisabled, deleteUser, getAllowSignup, setAllowSignup,
  changePassword, renameUser,
} from './session.js';
import * as accounts from './accounts.js';
import { addContacts, learnRecipients } from './contacts.js';
import * as contactSources from './contactSources.js';
import * as vcard from './vcard.js';
import * as contactsSync from './contactsSync/index.js';
import * as contactSyncRunner from './contactSyncRunner.js';
import * as calendarStore from './calendarStore.js';
import * as calendarBackends from './calendar/index.js';
import * as calendarEvents from './calendarEvents.js';
import * as calendarSync from './calendarSync.js';
import * as calendarReminders from './calendarReminders.js';
import * as calendarWrite from './calendarWrite.js';
import * as appPasswords from './appPasswords.js';
import * as davPublish from './davPublish.js';
import { davRouter, wellKnownRedirects } from './davServer.js';
import * as oauth from './oauth.js';
import * as idle from './idle.js';
// Imported directly, not through mailClient's protocol dispatch: contacts have
// no IMAP counterpart to dispatch to, so the routes using these check the
// account type themselves instead.
import * as ewsClient from './ewsClient.js';
import * as graphClient from './graphClient.js';
// Direct (not via mailClient's type dispatch) — dropping pooled connections is
// IMAP-specific plumbing, not one of the protocol-agnostic mail operations.
import * as imapClient from './imapClient.js';
import * as scheduledSend from './scheduledSend.js';
import * as snooze from './snooze.js';
import * as exportLib from './export.js';
import * as accountOverrides from './accountOverrides.js';
import { currentUser, runAsAccount, runWithAccount, userKey } from './session.js';
import { listPresets, savePreset, deletePreset } from './presets.js';
import * as fonts from './fonts.js';
import * as cache from './cache.js';
import * as sync from './sync.js';
import * as push from './push.js';
import * as contentCache from './contentCache.js';
import * as events from './events.js';
import * as scope from './scope.js';
import * as unread from './unread.js';
import * as holidays from './holidays.js';
import * as schedule from './schedule.js';
import * as analytics from './analytics.js';
import * as proofread from './proofread.js';
import * as userLog from './userLog.js';
import { queryNeedsBodySearch, extractStarredTerm } from './searchQuery.js';
import * as subjectRules from './subjectRules.js';
import { groupByKey, mergeGroupResults } from './unifiedMerge.js';
import { log } from './log.js';
import * as pushI18n from './pushI18n.js';

const reqLog = log.scope('http');
const htmlLog = log.scope('html');
const currentUserAccountId = () => currentUser().accountId || '';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true); // req.secure behind a reverse proxy
app.use(express.json({ limit: '50mb' })); // attachments come base64 in JSON
/**
 * Serves the three HTML entry points with a version stamp on every local
 * script/stylesheet URL: `/js/app.js` → `/js/app.js?v=<newest asset mtime>`.
 *
 * Why this exists: this app has no build step and therefore no content-hashed
 * filenames, so every deploy relied on the browser revalidating each file. It
 * mostly does — but "mostly" produced the worst possible failure mode, a page
 * running a MIXTURE of old and new files, which looks exactly like a feature
 * being broken rather than stale. (Symptom that found it: a message-frame
 * change that provably worked against 377 real messages offline did nothing in
 * the browser, while an app.js change from the same deploy was live.) A changed
 * file changes the URL, and a URL that has never been requested cannot be
 * stale — in the browser cache, in a service worker, or in a proxy.
 *
 * The stamp is the newest mtime among public/js and public/css, cached for a
 * few seconds so this costs one stat sweep per burst of requests rather than
 * one per file.
 */
const HTML_ENTRY_POINTS = { '/': 'index.html', '/index.html': 'index.html', '/login.html': 'login.html', '/message.html': 'message.html' };
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
let assetStamp = { value: '0', at: 0 };
function currentAssetStamp() {
  if (Date.now() - assetStamp.at < 5000) return assetStamp.value;
  let newest = 0;
  for (const dir of ['js', 'css']) {
    let names = [];
    try { names = fs.readdirSync(path.join(PUBLIC_DIR, dir)); } catch { continue; }
    for (const n of names) {
      try { newest = Math.max(newest, fs.statSync(path.join(PUBLIC_DIR, dir, n)).mtimeMs); } catch { /* vanished mid-sweep */ }
    }
  }
  assetStamp = { value: Math.round(newest).toString(36), at: Date.now() };
  return assetStamp.value;
}
app.get(Object.keys(HTML_ENTRY_POINTS), (req, res, next) => {
  const file = path.join(PUBLIC_DIR, HTML_ENTRY_POINTS[req.path]);
  let html;
  try { html = fs.readFileSync(file, 'utf8'); } catch { return next(); }
  const v = currentAssetStamp();
  // Local /js and /css only — never a URL with a query of its own, and never
  // anything off-site.
  html = html.replace(/(<(?:script|link)[^>]*\s(?:src|href)=")(\/(?:js|css)\/[^"?]+)(")/g, `$1$2?v=${v}$3`);
  res.set('Cache-Control', 'no-cache'); // the shell itself must always be revalidated — it names the versions
  res.type('html').send(html);
});
// The CalDAV/CardDAV server, and RFC 6764's auto-discovery for it. Both are
// registered BEFORE the static handler: `/.well-known/*` would otherwise be a
// 404 from the file server before it ever reached the redirect, and every
// client's auto-discovery would fail on a path the user cannot see.
//
// Its own authentication, deliberately outside `app.use('/api', requireAuth)`
// below — a DAV client speaks HTTP Basic and has no cookie. See
// server/appPasswords.js for why the login password is not accepted there.
wellKnownRedirects(app, '/dav');
app.use('/dav', davRouter());

/**
 * The web app manifest, translated.
 *
 * Everything else visible in this app goes through public/js/i18n.js at
 * runtime. The manifest cannot: the OS reads it at INSTALL time and builds the
 * window title and the taskbar right-click jump list from it, long before any
 * of our JavaScript exists. A Slovenian user pinning Hmelj to the taskbar got
 * an English "Compose" in the jump list for exactly that reason — the same
 * class of bug as the push-notification buttons, and fixed the same way
 * (server/pushI18n.js reads the frontend's own catalogs).
 *
 * The language comes from the query string rather than the session, because a
 * manifest is fetched with credentials omitted by default — there is no cookie
 * on this request to read a user's settings from. public/js/i18n.js points the
 * <link> at ?lang=<current> once it knows, which is also what makes the OS
 * notice a language change: the URL changes, so the manifest is re-read.
 *
 * Registered BEFORE express.static, or the file on disk wins.
 */
app.get('/manifest.webmanifest', (req, res) => {
  const lang = /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(String(req.query.lang || '')) ? String(req.query.lang) : 'en';
  const t = (k) => pushI18n.t(lang, k);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'));
  } catch (e) {
    log.warn(`Could not read the manifest: ${e.message}`);
    return res.status(500).json({ error: 'No manifest' });
  }
  manifest.lang = lang;
  manifest.description = t(manifest.description);
  manifest.shortcuts = (manifest.shortcuts || []).map((sc) => ({ ...sc, name: t(sc.name) }));
  // `name` and `short_name` stay as they are on purpose: "Hmelj" is the
  // application's name, not a word, and translating it would rename the app in
  // the launcher.
  res.type('application/manifest+json');
  // Re-read when the language changes — which it does by changing the URL —
  // but not on every load: an installed PWA re-fetches this periodically.
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(manifest);
});

app.use(express.static(path.join(__dirname, '..', 'public')));
// Admin-uploaded custom fonts (see server/fonts.js) — unauthenticated, same
// as the public/ mount above: font files aren't sensitive, and gating this
// would only complicate the CSS @font-face/iframe fetch path for no real
// benefit (every filename actually reachable here is one the fonts.json
// manifest itself put there).
app.use('/fonts/custom', express.static(path.join(config.dataDir, 'fonts'), { index: false, dotfiles: 'deny' }));
const uploadFont = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
// multer's own middleware calls next(err) on failure (oversized file, bad
// field) rather than throwing — this app has no global 4-arg Express error
// handler anywhere (nothing else needed one before this, the first real
// multipart upload), so an unwrapped multer error would otherwise fall
// through to Express's default HTML error page instead of a clean JSON 400.
const uploadFontMw = (req, res, next) => {
  uploadFont.single('font')(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Font file is too large (5MB max)' : err.message });
  });
};

// One line per request at debug level: method, path, status, duration, and
// (for mail routes) which account — the fastest way to see what the
// frontend is actually asking for when something looks wrong.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    reqLog.debug(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (!e.status || e.status >= 500) {
    log.error(`${req.method} ${req.originalUrl}:`, e.stack || e.message);
    // Also into the user's own log (Settings → Log). Only real failures, never
    // a 4xx: a validation complaint is already on screen as a toast and would
    // just be noise here. This one hook covers every mutation route at once —
    // marking read/unread, moving, deleting, folder operations — which is what
    // the user asked to be able to see without reading a terminal.
    try {
      userLog.record(currentUser().viewerKey, {
        level: 'error',
        category: userLogCategory(req.originalUrl || ''),
        message: e.message,
        detail: `${req.method} ${(req.originalUrl || '').split('?')[0]}`,
        accountId: currentUser().accountId || null,
      });
    } catch { /* no session context (an unauthenticated route) — nothing to attribute it to */ }
  }
  res.status(e.status || 500).json({ error: e.message });
});

/** A rough bucket for the Log tab's grouping, from the route that failed. The
 *  client turns these into translated labels; anything unrecognised falls back
 *  to being shown as-is next to the method+path in the entry's detail. */
function userLogCategory(url) {
  const p = url.split('?')[0];
  if (p.includes('/flags')) return 'flags';
  if (p.includes('/move') || p.includes('/copy')) return 'move';
  if (p.includes('/delete') || p.includes('/empty')) return 'delete';
  if (p.includes('/send') || p.includes('/drafts')) return 'send';
  if (p.includes('/filters')) return 'filter';
  if (p.includes('/folders')) return 'folder';
  if (p.includes('/accounts')) return 'account';
  if (p.includes('/sync')) return 'sync';
  if (p.includes('/message')) return 'message';
  return 'general';
}

// ---------- status ----------
// Lightweight liveness probe for Docker/K8s — no IMAP round-trip.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------- auth (public routes) ----------
// Hmelj users are local accounts (see session.js); mail accounts are attached
// per user afterwards through the account wizard.
app.post('/api/signup', wrap(async (req, res) => {
  // First user can always register (initial setup); afterwards allowSignup rules.
  if (!getAllowSignup() && hasAnyUser()) return res.status(403).json({ error: 'Sign-up is disabled on this Hmelj instance' });
  const { username, password, remember } = req.body || {};
  try {
    const user = createUser(username, password);
    const token = createSession(user, remember !== false);
    setSessionCookie(res, token, req, remember !== false);
    log.info(`Signed up: ${user.username}${user.isAdmin ? ' (admin)' : ''}`);
    res.json({ ok: true, username: user.username, displayUsername: user.displayUsername || user.username });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/login', wrap(async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!loginAllowed(ip)) return res.status(429).json({ error: 'Too many attempts — try again in a minute' });
  const { username, password, remember } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = verifyUser(username, password);
  if (!user || user.disabled) {
    loginFailed(ip);
    log.warn(`Login failed for "${username}" from ${ip}${user?.disabled ? ' (account disabled)' : ''}`);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  loginSucceeded(ip);
  const token = createSession(user, remember !== false);
  setSessionCookie(res, token, req, remember !== false);
  log.info(`Logged in: ${user.username}`);
  res.json({ ok: true, username: user.username, displayUsername: user.displayUsername || user.username });
}));

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) destroySession(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  const s = sessionFromRequest(req);
  res.json(s
    ? {
        loggedIn: true, username: s.username, displayUsername: s.displayUsername || s.username,
        isAdmin: isAdminUser(s.username), version: config.version,
        // '' when VAPID isn't configured server-side — the client feature-detects
        // on this to know push notifications aren't available at all right now,
        // same as it already does for `'PushManager' in window`.
        vapidPublicKey: push.vapidConfigured ? config.vapidPublicKey : '',
      }
    : { loggedIn: false, allowSignup: getAllowSignup() || !hasAnyUser(), firstRun: !hasAnyUser() });
});

// ---------- OAuth redirect landing (see server/oauth.js) ----------
// Deliberately NOT under /api, and deliberately unauthenticated. The browser
// that lands here is very often not the one holding the Hmelj session cookie:
// on Android the sign-in runs in a Chrome Custom Tab, a completely separate
// cookie jar from the app's WebView. What authenticates this request is the
// one-time `state` nonce minted by POST /api/oauth/start, which is bound
// server-side to the user who started the flow. No token ever reaches this
// page — it only reports success or failure; the waiting Hmelj tab picks the
// result up from GET /api/oauth/status.
app.get('/oauth/callback', wrap(async (req, res) => {
  const result = await oauth.handleCallback({
    code: req.query.code,
    state: req.query.state,
    error: req.query.error,
    errorDescription: req.query.error_description,
  });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const title = result.ok ? 'Signed in' : 'Sign-in failed';
  const body = result.ok
    ? `<p class="ok">✅ Signed in as <strong>${esc(result.email)}</strong></p>
       <p>You can close this window and go back to Hmelj — it has already picked this up.</p>`
    : `<p class="err">⚠️ ${esc(result.error)}</p>
       <p>Close this window and try again from Hmelj.</p>`;
  res
    .status(result.ok ? 200 : 400)
    .type('html')
    .send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hmelj — ${title}</title>
<style>
 :root{color-scheme:light dark}
 body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;
      min-height:100vh;display:grid;place-items:center;padding:24px;
      background:#f6f8fc;color:#202124}
 @media(prefers-color-scheme:dark){body{background:#16181c;color:#e8eaed}}
 .card{max-width:26rem;text-align:center}
 .ok{font-size:1.15rem}
 .err{font-size:1.05rem;color:#d93025}
 @media(prefers-color-scheme:dark){.err{color:#f28b82}}
</style></head><body><div class="card">${body}</div>
<script>
 // Instant hand-back when this is a desktop popup opened by the Hmelj tab.
 // Same-origin, so postMessage is safe and targeted. Purely an optimisation:
 // the opener is also polling /api/oauth/status, which is what makes the
 // Android Custom Tab and blocked-popup cases work at all.
 try { window.opener && window.opener.postMessage(
   { type: 'hmelj-oauth-done', state: ${JSON.stringify(String(req.query.state || ''))} },
   window.location.origin); } catch (e) {}
 try { window.close(); } catch (e) {}
</script></body></html>`);
}));

// Everything below /api requires a valid session.
app.use('/api', requireAuth);

// ---------- admin (Hmelj login-account management; distinct from mail accounts) ----------
function requireAdmin(req, res, next) {
  if (!isAdminUser(currentUser().username)) return res.status(403).json({ error: 'Admin only' });
  next();
}
app.get('/api/admin/users', requireAdmin, (req, res) => res.json(listUsers()));
app.patch('/api/admin/users/:id', requireAdmin, wrap(async (req, res) => {
  try {
    res.json(setUserDisabled(req.params.id, !!req.body?.disabled, currentUser().userId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.delete('/api/admin/users/:id', requireAdmin, wrap(async (req, res) => {
  try {
    deleteUser(req.params.id, currentUser().userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.get('/api/admin/settings', requireAdmin, (req, res) => res.json({ allowSignup: getAllowSignup() }));
app.patch('/api/admin/settings', requireAdmin, (req, res) => {
  if (typeof req.body?.allowSignup === 'boolean') setAllowSignup(req.body.allowSignup);
  res.json({ allowSignup: getAllowSignup() });
});

// ---------- current user's own login (username + password — distinct from mail accounts) ----------
app.post('/api/account/password', wrap(async (req, res) => {
  try {
    changePassword(currentUser().userId, req.body?.currentPassword || '', req.body?.newPassword || '');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.post('/api/account/username', wrap(async (req, res) => {
  try {
    const { oldKey, newKey, unchanged } = renameUser(currentUser().userId, req.body?.newUsername || '');
    if (!unchanged) {
      if (config.cacheEnabled) cache.renameUserKey(oldKey, newKey);
      // The rename just invalidated every session for this user (including
      // this request's) — send them back to the login screen instead of
      // leaving the client holding a cookie the server no longer recognizes.
      clearSessionCookie(res);
    }
    // `unchanged` (same normalized login name, e.g. only the display case
    // changed) — the client uses this to decide whether it actually needs to
    // redirect to login, since that path above didn't touch the session at all.
    res.json({ ok: true, unchanged });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// ---------- OAuth sign-in (see server/oauth.js) ----------
// Which providers this instance can actually sign in with — the wizard uses
// `configured` to decide between offering the button and telling the user an
// admin still has to set the client up.
app.get('/api/oauth/providers', (req, res) => res.json(oauth.listProviders()));

app.post('/api/oauth/start', wrap(async (req, res) => {
  const { provider, email, accountId, features } = req.body || {};
  try {
    res.json(oauth.startFlow({
      // The sign-in belongs to whoever is doing it. viewerKey, so a request that
      // happens to carry ?account=<a shared account> can't file its flow under the
      // owner's key (see session.js's ownership swap). Pairs with /status and
      // /attach below, and with accounts.js#oauthRecordFor, which all take it back
      // out under the same key. NOT the same thing as oauth.js#accessTokenFor's
      // `ownerKey`, which must stay the owner — that one is where a ROTATED
      // refresh token gets written back, into the owner's own account record.
      userKey: currentUser().viewerKey,
      provider,
      email,
      // Set when re-signing in to an existing account whose refresh token
      // died, rather than creating a new one.
      accountId: accountId || null,
      // Optional extra scopes this sign-in should also ask for — 'contacts',
      // 'calendar' (see oauth.js#FEATURE_SCOPES). Filtered against what the
      // provider actually offers rather than passed through, so a crafted
      // request cannot widen the scope string with anything not on that list.
      features: (Array.isArray(features) ? features : [])
        .filter((f) => oauth.featuresAvailable(provider).includes(f)),
      redirectUri: oauth.redirectUriFrom(req),
    }));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
}));

// Polled by the page waiting on the popup/Custom Tab. This — not postMessage —
// is the load-bearing completion signal, because on Android the sign-in
// finishes in a different browser entirely and there is no opener to message.
app.get('/api/oauth/status', (req, res) => {
  res.json(oauth.flowStatus(String(req.query.state || ''), currentUser().viewerKey));
});

// Attach a fresh sign-in to an account that already exists, without going back
// through the whole wizard. Two jobs, same mechanics (see
// accounts.js#attachOAuthSignIn):
//   - re-auth, when a refresh token died (revoked consent, aged out, or a Google
//     consent screen left in "Testing")
//   - migration, when a password account moves onto OAuth — the account keeps
//     its id, so its cache, analytics index, identities, filters, folder
//     settings and share grants all survive, which "remove and add again" would
//     not.
app.post('/api/oauth/attach', requireOwnAccountBody, wrap(async (req, res) => {
  const { state, accountId } = req.body || {};
  try {
    const uKey = currentUser().viewerKey; // matches /api/oauth/start's key above
    const t = oauth.takeFlowTokens(state, uKey);
    const acc = accounts.listAccounts().find((a) => a.id === accountId);
    if (!acc) return res.status(404).json({ error: 'Mail account not found' });
    if (acc.email && t.email && acc.email.toLowerCase() !== t.email.toLowerCase()) {
      return res.status(400).json({ error: `You signed in as ${t.email}, but this account is ${acc.email}.` });
    }
    const { migrating } = accounts.attachOAuthSignIn(uKey, accountId, t);
    oauth.markFlowConsumed(state);
    // The cached access token and the live watcher are both still bound to the
    // previous credential; without dropping them the account keeps using (or
    // failing on) it until they happen to be rebuilt. Same reasoning for the
    // pooled IMAP connection, which is still logged in with the app password
    // this may have just replaced.
    oauth.forgetTokens(uKey, accountId);
    imapClient.dropAccountConnections(uKey, accountId);
    idle.stopWatching(accountId);
    sync.reschedule();
    res.json({ ok: true, email: t.email, migrated: migrating });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
}));

// Admin: the OAuth client registered with the provider. There is no secret to
// manage — Hmelj signs in as a public client and PKCE is what proves the code
// exchange belongs to the flow that started it (see server/oauth.js).
app.get('/api/admin/oauth', requireAdmin, (req, res) =>
  res.json(oauth.adminListProviders(oauth.redirectUriFrom(req))));
app.put('/api/admin/oauth/:provider', requireAdmin, wrap(async (req, res) => {
  try {
    oauth.adminSaveProvider(req.params.provider, req.body || {});
    res.json(oauth.adminListProviders(oauth.redirectUriFrom(req)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// ---------- account presets (Gmail, T-2, GMX, …) ----------
// Readable by any signed-in user (the wizard needs them); only admins edit the list.
app.get('/api/presets', (req, res) => res.json(listPresets()));
app.post('/api/admin/presets', requireAdmin, (req, res) => res.json(savePreset(req.body)));
app.put('/api/admin/presets/:id', requireAdmin, (req, res) => res.json(savePreset(req.body, req.params.id)));
app.delete('/api/admin/presets/:id', requireAdmin, (req, res) => { deletePreset(req.params.id); res.json({ ok: true }); });

// ---------- custom fonts (App font / Message font, see server/fonts.js) ----------
// Readable by any signed-in user (both font pickers need the list); only admins upload/delete.
app.get('/api/fonts', (req, res) => res.json(fonts.listFonts()));
app.post('/api/admin/fonts', requireAdmin, uploadFontMw, wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No font file uploaded' });
  try {
    const entry = fonts.uploadFontStyle({
      familyId: req.body?.familyId || null,
      family: req.body?.family || '',
      style: req.body?.style || '',
    }, req.file);
    res.json(entry);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.delete('/api/admin/fonts/:id', requireAdmin, (req, res) => { fonts.deleteFontFamily(req.params.id); res.json({ ok: true }); });
app.delete('/api/admin/fonts/:id/:style', requireAdmin, (req, res) => {
  try { fonts.deleteFontStyle(req.params.id, req.params.style); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- mail accounts ----------
// Owner-only guard for the account-mutating routes below — a non-owner
// (even one this account is shared with) gets a 403 now, not the "silently
// can't even address it" guarantee storage alone used to provide for free
// when every account was strictly one-owner-per-file — sharing is exactly
// what ends that free guarantee. viewerKey, not the
// possibly ownership-swapped userKey (see session.js's requireAuth), is
// always the actual requesting login regardless of which account's data
// they're currently operating against.
function requireOwnAccount(req, res, next) {
  if (!accounts.isOwnAccount(currentUser().viewerKey, req.params.id)) {
    return res.status(403).json({ error: "Only this account's owner can do that" });
  }
  next();
}

/** Same guard for routes that name the account in the body rather than the
 *  path (POST /api/oauth/attach). Re-signing in rewrites a stored credential,
 *  so it's owner-only — a grantee of a shared account must not be able to
 *  swap out the mailbox it points at. */
function requireOwnAccountBody(req, res, next) {
  if (!accounts.isOwnAccount(currentUser().viewerKey, req.body?.accountId)) {
    return res.status(403).json({ error: "Only this account's owner can do that" });
  }
  next();
}

/**
 * Does this account really have the Junk/Archive folder its settings name?
 *
 * Answered here rather than in the browser because the browser cannot answer it
 * everywhere: the unified "All inboxes" view holds no folder list at all, so it
 * had no way to tell an account that genuinely has an Archive folder from one
 * merely carrying the default NAME of one — and offered "Move to Archive" on
 * every account's mail. Reported: the option showed up in All inboxes for
 * accounts that have no such folder, while each account's own Inbox got it
 * right.
 *
 * Read from the cached folder list, which is the same list the sidebar draws.
 * An account with no cached folders yet (never synced, or the cache off) falls
 * back to trusting its setting — there is nothing to check against, and an
 * unsynced account has no messages in the list to act on anyway.
 */
function withRefileBoxes(a) {
  const ownerKey = a.shared && a.ownerUsername ? userKey(a.ownerUsername) : currentUser().viewerKey;
  return { ...a, hasJunk: !!refileFolderFor(a, 'junk', ownerKey), hasArchive: !!refileFolderFor(a, 'archive', ownerKey) };
}

/**
 * The folder an account's Junk/Archive box REALLY means, or '' for "it has none".
 *
 * Not simply `acc.junkFolder`, because that name can be wrong in a way nothing
 * ever corrected: accounts added before this existed had the name guessed
 * ('Junk', 'Archive') whether or not such a folder was there. On the live
 * instance that left one account pointing at "Junk" while the server's actual
 * junk folder is called "Spam", and six accounts naming an "Archive" that does
 * not exist.
 *
 * So the stored name is used when it names a real folder, and otherwise the
 * folder the SERVER flags as \Junk / \Archive stands in for it. Resolved at
 * read time rather than written back — a grantee's request must not rewrite the
 * owner's account file, and the folder list is where the truth already is.
 *
 * Both callers below must use this, not the raw setting: the route decides
 * where mail goes, and /api/accounts decides whether the menu entry appears.
 * If those two disagreed, the entry would be offered and then fail.
 */
function refileFolderFor(acc, box, ownerKey) {
  const named = acc?.[BOX_FOLDER[box]];
  if (!named) return ''; // (None) in Settings › Folders — the owner said so
  if (!config.cacheEnabled) return named;
  const folders = cache.getFolders(ownerKey, acc.id);
  if (!folders.length) return named; // never synced: nothing to check against
  if (folders.some((f) => f.path === named)) return named;
  return folders.find((f) => f.specialUse === (box === 'junk' ? '\\Junk' : '\\Archive'))?.path || '';
}

app.get('/api/accounts', (req, res) => res.json(accounts.listAccounts().map(withRefileBoxes)));
// Each of these changes what the scheduler should be running — a new account
// to start watching, changed monitoring settings, or one that's gone — so the
// timer/IDLE-watcher set is re-planned right away instead of waiting for the
// supervisor's next pass (see sync.js#reschedule).
app.post('/api/accounts', wrap(async (req, res) => { const a = accounts.saveAccount(req.body); sync.reschedule(); res.json(a); }));
app.put('/api/accounts/:id', requireOwnAccount, wrap(async (req, res) => { const a = accounts.saveAccount(req.body, req.params.id); sync.reschedule(); res.json(a); }));
app.delete('/api/accounts/:id', requireOwnAccount, (req, res) => { accounts.deleteAccount(req.params.id); sync.reschedule(); res.json({ ok: true }); });
// Owner writes go straight to the account record, same as always. A
// non-owner who's actually been granted access instead writes to their own
// personalization (server/accountOverrides.js):
// label/color/hiddenFolders only, and hiddenFolders there means "MY own
// additional hidden folders," unioned with the owner's at read time
// (accounts.js#listSharedInAccounts) — never a replacement for the owner's
// list. Deliberately NOT behind requireOwnAccount (that would 403 every
// grantee outright) — the branch below does its own permission check.
app.patch('/api/accounts/:id', (req, res) => {
  const id = req.params.id;
  const viewerKey = currentUser().viewerKey;
  if (accounts.isOwnAccount(viewerKey, id)) {
    const allowed = ['label', 'color', 'sentFolder', 'draftsFolder', 'trashFolder', 'junkFolder', 'archiveFolder', 'hiddenFolders', 'disabled', 'monitorMode', 'pollIntervalMs', 'notificationSchedule', 'folderNotificationSchedules', 'searchIndex', 'snoozeFolder', 'authservId'];
    const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
    const wasIndexed = !!accounts.getAccount(id)?.searchIndex;
    accounts.updateAccountFields(id, patch);
    // Turning full-text search OFF takes effect at once, and means it: the
    // index rows go now rather than lingering until something happens to prune
    // the content they shadow. Turning it ON only sets the flag — the indexing
    // itself is the sync loop's backfill pass (server/contentCache.js), which
    // fills it in over the next few ticks without blocking this request.
    if (config.cacheEnabled && 'searchIndex' in patch && wasIndexed && !patch.searchIndex) {
      const dropped = cache.dropSearchIndex(currentUser().userKey, id);
      log.info(`Search index for account ${id} turned off — dropped ${dropped} indexed message(s)`);
    }
    // How often (or how) this account is watched just changed — re-plan its
    // timer/watcher now instead of letting the change take effect only after
    // the current interval happens to elapse.
    if ('monitorMode' in patch || 'pollIntervalMs' in patch || 'disabled' in patch) sync.reschedule();
    // hiddenFolders otherwise only takes effect in the folder list on the
    // next background sync tick (see cache.js#setFoldersHidden) — apply it to
    // the cache immediately so "Show in sidebar" reflects instantly.
    if (config.cacheEnabled && patch.hiddenFolders) {
      cache.setFoldersHidden(currentUser().userKey, id, patch.hiddenFolders);
    }
    return res.json({ ok: true });
  }
  if (!accounts.resolveSharedOwnerKey(id, currentUser().userId)) {
    return res.status(403).json({ error: "Only this account's owner can do that" });
  }
  const allowed = ['label', 'color', 'hiddenFolders'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  accountOverrides.setOverride(viewerKey, id, patch);
  res.json({ ok: true });
});

/**
 * What the full-text index currently costs, for Settings > Accounts.
 *
 * `bytes` is the whole index — FTS5 keeps one set of shadow tables for every
 * indexed message regardless of which account it came from, and there is no
 * per-account attribution short of the dbstat virtual table, which is not
 * compiled in. Each account therefore gets a `share` estimated from its row
 * count, which the UI labels as approximate rather than dressing up as exact.
 *
 * Owned accounts only: the flag is the owner's to set (see accounts.js), and a
 * grantee has no business being told how big someone else's index is.
 */
app.get('/api/search-index', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!config.cacheEnabled) return res.json({ enabled: false, accounts: {} });
  const uKey = currentUser().userKey;
  const viewerKey = currentUser().viewerKey;
  const out = {};
  for (const a of accounts.listAccounts()) {
    if (!accounts.isOwnAccount(viewerKey, a.id)) continue;
    out[a.id] = { on: !!a.searchIndex, ...cache.searchIndexStats(uKey, a.id) };
  }
  res.json({ enabled: true, maxMb: store.getSettings().searchIndexMaxMb, ...cache.searchIndexStats(uKey), accounts: out });
});

/**
 * Temporary per-folder Mute (folder right-click → Mute in the sidebar) — silences
 * notifications for ONE folder until an absolute instant, then it lapses on its own.
 *
 * `until` is epoch ms, computed by the client (absolute, so no timezone question arises
 * — unlike the Scheduler's wall-clock grid, which is the server's local time). Null/0
 * lifts the mute. Capped at 30 days so a bad client can't silence a folder essentially
 * forever by accident — "quiet indefinitely" already exists and belongs in the
 * Scheduler ('Never notify'), where it's visible as a setting rather than hidden in a
 * timestamp.
 *
 * Owner-only, like the schedules it layers over: a shared account's notification gating
 * is evaluated once per folder for the owner AND every grantee (see
 * sync.js#notifyNewMail), so there is no per-viewer mute to write here.
 */
const MAX_MUTE_MS = 30 * 24 * 60 * 60e3;
app.post('/api/accounts/:id/folder-mute', requireOwnAccount, (req, res) => {
  const folder = req.body?.folder;
  if (!folder || typeof folder !== 'string') return res.status(400).json({ error: 'folder is required' });
  const raw = req.body?.until;
  const until = raw == null ? 0 : Number(raw);
  if (!Number.isFinite(until) || until < 0) return res.status(400).json({ error: 'until must be a timestamp in ms' });
  const capped = Math.min(until, Date.now() + MAX_MUTE_MS);
  const folderMutes = accounts.setFolderMute(req.params.id, folder, capped);
  log.debug(capped
    ? `Folder ${folder} muted until ${new Date(capped).toISOString()}`
    : `Folder ${folder} unmuted`);
  res.json({ folderMutes });
});

// ---------- account sharing ----------
app.post('/api/accounts/:id/share', requireOwnAccount, wrap(async (req, res) => {
  const sharedWith = accounts.shareAccount(currentUser().viewerKey, req.params.id, req.body.username);
  res.json({ sharedWith });
}));
app.delete('/api/accounts/:id/share/:userId', requireOwnAccount, (req, res) => {
  const sharedWith = accounts.unshareAccount(currentUser().viewerKey, req.params.id, req.params.userId);
  res.json({ sharedWith });
});
// Grantee-initiated, not owner-only (deliberately no requireOwnAccount here
// — the whole point is a grantee removing THEMSELVES, which they could
// never pass that check for).
app.post('/api/accounts/:id/leave', (req, res) => {
  const left = accounts.leaveSharedAccount(req.params.id, currentUser().userId);
  if (!left) return res.status(404).json({ error: 'Not a shared account you have access to' });
  res.json({ ok: true });
});

app.post('/api/accounts/test', wrap(async (req, res) => {
  try {
    res.json(await accounts.testConnection(req.body));
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}));

app.get('/api/status', wrap(async (req, res) => {
  const status = await imap.imapStatus();
  res.json({ configured: true, ...status });
}));

// ---------- unified views (all accounts merged) ----------
// Normally reads from the local SQLite cache (cache.js), kept warm by the
// background poller (sync.js) — instant, and paginates in O(page size)
// instead of re-fetching page*pageSize live from every account on every
// page. See /api/sync/status below for the "still syncing" signal the client
// uses to know when to quietly refresh after a background update lands.
//
// With CACHE_ENABLED=false (config.cacheEnabled), falls back to fetching
// live from every account and merging in memory — slower and its "total" is
// a best-effort sum of each account's own folder total, but has no cache to
// go stale or drift from what's actually on the mail server.
async function unifiedLive(user, list, { box, page, pageSize, q, unreadOnly, flaggedOnly = false, mutedPairs = null }) {
  const need = page * pageSize;
  const perAccount = await Promise.all(list.map(async (a) => {
    const folder = box === 'sent' ? (a.sentFolder || 'Sent') : 'INBOX';
    // Notification scheduler (server/schedule.js) — skip this account's fetch
    // entirely rather than fetching then filtering: keeps `total` correct by
    // construction (nothing muted is ever counted in the first place, so there's
    // no risk of the pager reporting a stale total after the fact) and saves a
    // live IMAP round-trip for an account we're about to hide anyway.
    if (mutedPairs?.has(schedule.pairKey(a.id, folder))) return { total: 0, messages: [] };
    // A shared account (a.shared) must run under its OWNER's identity, not
    // the viewer's own — same reasoning as /api/unified/mark-read below:
    // imapClient.js's connection pool and every cache.js table key off
    // userKey, and the viewer's own accounts.json has no such account to
    // resolve credentials from at all.
    const runUser = a.shared ? { id: a.ownerId, username: a.ownerUsername } : user;
    try {
      const r = await runAsAccount(runUser, a.id, () => imap.listMessages(folder, { page: 1, pageSize: need, query: q, unreadOnly, flaggedOnly }));
      return { total: r.total, messages: r.messages.map((m) => ({ ...m, folder, account: { id: a.id, label: a.label, color: a.color } })) };
    } catch (e) {
      log.scope('unified').warn(`Live fetch failed for ${a.label}/${folder}:`, e.message);
      return { total: 0, messages: [] };
    }
  }));
  const merged = perAccount.flatMap((r) => r.messages).sort((x, y) => new Date(y.date || 0) - new Date(x.date || 0));
  const total = perAccount.reduce((s, r) => s + r.total, 0);
  return { total, messages: merged.slice((page - 1) * pageSize, page * pageSize) };
}

/**
 * Should this listing be grouped into conversations?
 *
 * Only ever from the cache: grouping needs every message of a thread in one
 * place, which a live per-folder IMAP listing cannot offer. And only for an
 * unfiltered list — with a search or an unread/starred filter active, a
 * thread's count would mean "matching messages in it", not "messages in it",
 * and the row would promise a stack the view then contradicts. Both cases fall
 * back to the flat list, the same honest degradation the ★ filter already
 * relies on.
 */
function conversationsOn({ q, unreadOnly, flaggedOnly } = {}) {
  return !!store.getSettings().conversationView && !q && !unreadOnly && !flaggedOnly;
}

// cache.queryUnified, correct when `groups` spans multiple real owner keys.
// cache.queryUnified assumes one uniform userKey for its whole `accounts`
// list — true only within one owner's cache namespace. This calls it once
// per group (each group's own owner key + account subset) and merges via
// unifiedMerge.js, mirroring unifiedLive's own merge-multiple-sources shape
// above. With one group (the common no-shared-accounts case) this issues
// exactly the one query the old code always issued — no behavior change.
function queryUnifiedGrouped(groups, { box, page, pageSize, q, unreadOnly, flaggedOnly, mutedPairs }) {
  const need = page * pageSize;
  const threaded = conversationsOn({ q, unreadOnly, flaggedOnly });
  const groupResults = [];
  for (const [groupKey, groupAccounts] of groups) {
    groupResults.push(
      cache.queryUnified(groupKey, groupAccounts, { box, page: 1, pageSize: need, q, unreadOnly, flaggedOnly, mutedPairs, threaded })
    );
  }
  return mergeGroupResults(groupResults, page, pageSize);
}

// schedule.mutedFolderPairsFor, correct across owner-key groups — same
// reasoning as queryUnifiedGrouped above, but no merge/slice needed since a
// Set union is trivially correct regardless of which group a pair came from.
function mutedPairsForGroups(groups) {
  const opts = { holidayOverrides: store.getHolidayOverrides(), customHolidays: store.getCustomHolidays() };
  const pairs = new Set();
  for (const [groupKey, groupAccounts] of groups) {
    for (const p of schedule.mutedFolderPairsFor(groupKey, groupAccounts, opts)) pairs.add(p);
  }
  return pairs;
}


// ---------- is:starred — the live, whole-mailbox starred search ----------
//
// Trash and Junk only. Archive and Drafts are excluded from sync and badge scope
// (scope.js#EXCLUDED_SPECIAL_USE) for reasons that don't apply to a search — archiving
// a starred thread is the normal thing to do with one, so a "find my starred mail"
// search that skipped Archive would miss exactly the mail it exists to find. Something
// deliberately thrown away is a different matter.
const STARRED_SEARCH_EXCLUDED_USE = new Set(['\\Trash', '\\Junk']);

/** Which of one account's folders `is:starred` sweeps. `folders` is a
 *  cache.getFolders() (or imap.listFolders()) result. */
function starredFolderPaths(folders, account) {
  // Gmail and anything else reporting \Flagged exposes the starred set as its own
  // virtual folder — one SELECT then answers for the WHOLE account, including mail
  // that was archived out of every real folder years ago. It's kept out of sync and
  // badge scope for good reason (it double-counts against the folders it mirrors);
  // for this search it's not just an optimization but the only complete answer, since
  // isLabelOverlapProne accounts otherwise only ever sync their INBOX tree.
  const flaggedVirtual = folders.find((f) => f.specialUse === '\\Flagged');
  if (flaggedVirtual) return [flaggedVirtual.path];
  const hiddenPaths = new Set(account.hiddenFolders || []);
  return folders
    .filter((f) => !f.hidden && !hiddenPaths.has(f.path)
      && !STARRED_SEARCH_EXCLUDED_USE.has(f.specialUse)
      // specialUse isn't reported by every server (some Gmail locales, plenty of
      // self-hosted setups) — the account's own folder mapping is the reliable one.
      && f.path !== account.trashFolder && f.path !== account.junkFolder)
    .map((f) => f.path);
}

/**
 * The folders one conversation is allowed to span, for the list being shown.
 *
 * The folder being LISTED plus that account's Sent, so your own replies appear
 * between the incoming ones — and, when the list IS Sent, the inbox instead, so
 * a conversation read from Sent isn't a monologue either.
 *
 * The listed folder, emphatically not the folder the row's newest message
 * happens to live in. That distinction is the whole bug this function exists to
 * prevent: an Inbox conversation whose newest message is a reply YOU sent is
 * represented by a row whose `folder` is Sent, and scoping the thread to that
 * gave [Sent, Sent] — a stack containing only your own messages, in a
 * conversation that visibly had both sides. Reported twice before it was found.
 *
 * Used by both the listing (so the count is over this set) and /api/thread (so
 * the stack is), which is what keeps the number on a row and what opens from it
 * the same.
 */
/**
 * What a single-folder LISTING reads: this folder plus the account's Sent, so a
 * conversation's own replies are there to draw the row from.
 *
 * Deliberately NOT the whole conversation scope, even though the count is: an
 * Inbox listing that read every folder would put other folders' mail in the
 * Inbox. The count widens (see cache.js#pageThreads' convoWhere), the listing
 * does not.
 */
function listScopeFolders(acc, ownerKey, listedFolder) {
  const paths = [listedFolder];
  const sent = acc.sentFolder;
  if (sent && sent !== listedFolder) paths.push(sent);
  else if (sent === listedFolder) {
    // Listing Sent itself: pair it with the Inbox, or a conversation read from
    // there is a monologue.
    const folders = cache.getFolders(ownerKey, acc.id);
    const inbox = folders.find((f) => f.specialUse === '\\Inbox')?.path
      || folders.find((f) => f.path.toUpperCase() === 'INBOX')?.path;
    if (inbox) paths.push(inbox);
  }
  return [...new Set(paths.filter(Boolean))];
}

function threadScopeFolders(acc, ownerKey, listedFolder) {
  // One answer for every view: a conversation is a conversation. This used to
  // depend on which list you arrived from — [the folder, Sent] here, a wider set
  // for All inboxes — and the two disagreed about the same thread often enough
  // to be reported three times. cache.js#conversationFolders is the single
  // definition now, and says what is deliberately in and out of it.
  const paths = cache.conversationFolders(ownerKey, acc);
  // The listed folder always belongs, even when it would otherwise be left out
  // — reading a conversation from inside Trash, or from a folder hidden from
  // the sidebar, must still show the message being looked at.
  if (listedFolder && !paths.includes(listedFolder)) paths.push(listedFolder);
  return paths.filter(Boolean);
}

/**
 * Which of one account's folders a whole-account search sweeps.
 *
 * Gmail's "All Mail" (\\All) is the whole point of this existing: on an account
 * whose labels overlap, sync only ever covers the INBOX tree (scope.js#
 * isLabelOverlapProne), so everything archived — which on a ten-year-old
 * account is most of it — is in NO cached folder and in no folder this would
 * otherwise sweep. One SELECT of \\All answers for the entire mailbox, and
 * avoids the duplicates that sweeping every label would produce, since it
 * contains each message exactly once.
 *
 * Everything else sweeps its real folders, minus Trash and Junk: the same set
 * (and the same reasoning) as the starred sweep above.
 */
function searchFolderPaths(folders, account) {
  const all = folders.find((f) => f.specialUse === '\\All');
  if (all) {
    // Sent is not inside All Mail on every provider (it is on Gmail), and it is
    // cheap to be sure — one extra SELECT rather than silently missing your own
    // half of every conversation.
    const sent = folders.find((f) => f.path === account.sentFolder && f.path !== all.path);
    return sent ? [all.path, sent.path] : [all.path];
  }
  return starredFolderPaths(folders, account);
}

/**
 * "Starred anywhere", answered LIVE from every mailbox instead of from the cache —
 * what the search box's `is:starred` means (searchQuery.js#extractStarredTerm).
 *
 * The ★ toolbar filter reads the cache, which only ever holds each folder's newest
 * syncBackfillLimit messages (250 by default), so it cannot see a star put on a
 * two-year-old thread. This asks each folder directly — IMAP SEARCH FLAGGED, or the
 * Graph/EWS equivalent (each client's `flaggedOnly`) — which the server evaluates over
 * the whole mailbox, cache window or not.
 *
 * The cost is a SELECT + SEARCH per folder per account, which is exactly why this is a
 * term you type rather than what the ★ button does by default. Folders run
 * sequentially within an account (they share one connection) while accounts run in
 * parallel — the same shape unifiedLive uses.
 *
 * `targets` is [{ account, run, folders }], where `run` wraps each call in whatever
 * identity that account needs: runAsAccount for the unified view (whose request
 * context carries no account at all), a plain pass-through for a single-account route
 * where requireAuth already resolved the right one — including the owner-key swap for
 * a shared account, which re-wrapping in the VIEWER's identity would undo.
 */
async function sweepLive(targets, { page, pageSize, q, unreadOnly, flaggedOnly = false, fullText = false, label = 'sweep' }) {
  const need = page * pageSize;
  const stlog = log.scope('search');
  const t0 = Date.now();
  const sweptFolders = targets.reduce((n, t) => n + t.folders.length, 0);
  const perAccount = await Promise.all(targets.map(async ({ account, run, folders }) => {
    const messages = [];
    let total = 0;
    for (const path of folders) {
      try {
        const r = await run(() => imap.listMessages(path, { page: 1, pageSize: need, query: q, unreadOnly, flaggedOnly, fullText }));
        total += r.total;
        // Every row carries its own folder and account: the results genuinely span
        // both, and the client opens/stars/moves by exactly these (app.js#withMsgCtx,
        // batchOpInner). Without them a click would act on whatever folder the list
        // happened to be showing before the search.
        for (const m of r.messages) {
          messages.push({ ...m, folder: path, account: { id: account.id, label: account.label, color: account.color } });
        }
      } catch (e) {
        // One unreadable folder (gone mid-search, permissions, a server that refuses
        // SEARCH on it) must not lose the other twenty — the same per-source tolerance
        // unifiedLive applies, one level further in.
        stlog.warn(`${label} failed for ${account.label}/${path}:`, e.message);
      }
    }
    return { total, messages };
  }));
  // Each folder was asked for its own top `need` by date, so the true global page can
  // be sliced out of the merge — same k-way-merge argument as mergeGroupResults.
  const merged = perAccount.flatMap((r) => r.messages).sort((x, y) => new Date(y.date || 0) - new Date(x.date || 0));
  const total = perAccount.reduce((s, r) => s + r.total, 0);
  // Worth a line in the log: this is the one search whose cost scales with how many
  // folders you have, so a "search felt slow" report can be checked against the real
  // number rather than guessed at.
  stlog.debug(`${label} swept ${sweptFolders} folder(s) across ${targets.length} account(s) in ${Date.now() - t0}ms — ${total} hit(s)`);
  return { total, messages: merged.slice((page - 1) * pageSize, page * pageSize) };
}

/** The folder list to sweep for one account, preferring the cached folder tree and
 *  asking the server only when there isn't one (CACHE_ENABLED=false, or an account
 *  that has never finished a sync) — better one extra LIST round-trip than silently
 *  searching nothing. */
async function starredFoldersFor(account, ownerKey, run, pick = starredFolderPaths) {
  let folders = cache.getFolders(ownerKey, account.id);
  if (!folders.length) folders = await run(() => imap.listFolders()).catch(() => []);
  return pick(folders, account);
}

/**
 * The subject each row of a LIST shows, per Settings > Subject
 * (server/subjectRules.js). Response shaping and nothing else: the cache still
 * holds the real subject, so search goes on matching what the sender actually
 * wrote; /api/message and /api/thread are deliberately NOT run through this, so
 * opening a message shows the truth and a Reply's subject is the real one.
 *
 * A row whose subject actually changed carries `subjectOriginal` alongside it,
 * which is what lets the list still put the full thing in a row's tooltip.
 *
 * `fallbackAccountId` is for the single-account routes, whose rows carry no
 * account of their own; a unified row does (cache.js#queryUnified, sweepLive)
 * and uses its own, since one list can span accounts with different rules.
 */
function shortenSubjects(messages, fallbackAccountId = null) {
  // The overwhelmingly common case — nobody has written a rule — costs one
  // small JSON read and nothing per message.
  const rules = store.getSubjectRules();
  if (!rules.length || !Array.isArray(messages) || !messages.length) return messages;
  return messages.map((m) => {
    const shown = subjectRules.applyRules(m.subject, rules, m.account?.id || fallbackAccountId);
    return shown === m.subject ? m : { ...m, subject: shown, subjectOriginal: m.subject };
  });
}

app.get('/api/unified/:box', wrap(async (req, res) => {
  // Express's default weak-ETag/conditional-GET handling can otherwise let the browser
  // go on trusting a previous answer for the same URL+query without even asking the
  // server again — the exact bug already found and fixed for /api/search-suggest above
  // (see that route's own comment); this endpoint changes on every new/read/deleted
  // message just as often and had no such protection.
  res.set('Cache-Control', 'no-store');
  const box = req.params.box; // inbox | sent
  const page = +(req.query.page || 1);
  const list = accounts.listAccounts().filter((a) => !a.disabled);
  const pageSize = store.getSettings().messagesPerPage;
  // `is:starred` is a flag predicate, not text — split it off so everything below
  // (the cache SQL builder, the IMAP/EWS criteria builders, queryNeedsBodySearch) only
  // ever sees the text part of what was typed. See searchQuery.js#extractStarredTerm.
  const { starred: starredSearch, rest: q } = extractStarredTerm(req.query.q || '');
  const unreadOnly = req.query.unread === '1';
  // Toolbar's ★ filter (public/js/app.js's #btn-starred-only). In the unified view
  // it needs no scope of its own: this route already spans every account and every
  // non-excluded folder, so starred here means starred anywhere.
  const flaggedOnly = req.query.flagged === '1';
  // groups: real-owner-key -> that owner's accounts among `list`. A shared-in
  // account's cache rows/schedule live under its OWNER's userKey, not this
  // viewer's own (see accounts.js's listSharedInAccounts / session.js's
  // requireAuth) -- same grouping /api/sync/status below already does.
  const groups = groupByKey(list, (a) => (a.shared ? userKey(a.ownerUsername) : currentUser().userKey));
  // Notification scheduler (server/schedule.js) — computed once here, shared by both
  // the cache and live-fallback branches below, so they stay consistent with each
  // other. Only actually evaluated when the client's "Hide muted" toggle asked for it
  // (opt-in, off by default — see public/js/app.js's state.hideMuted) to avoid the
  // per-folder schedule evaluation cost for the common case of nobody using this
  // feature at all. Grouped by owner key (mutedPairsForGroups) so a schedule
  // configured on a shared account is correctly seen too — see that function.
  const hideMuted = req.query.hideMuted === '1';
  const mutedPairs = hideMuted ? mutedPairsForGroups(groups) : null;
  // `is:starred` takes over the whole route: it is answered live, from every folder of
  // every account, which is the one thing neither the cache path nor unifiedLive (INBOX
  // only, per account) can do. The Sent box keeps its own scope — searching every
  // folder from there would answer a question nobody asked.
  if (starredSearch) {
    const me = { id: currentUser().userId, username: currentUser().username };
    const targets = await Promise.all(list.map(async (a) => {
      const ownerKey = a.shared ? userKey(a.ownerUsername) : currentUser().userKey;
      const runUser = a.shared ? { id: a.ownerId, username: a.ownerUsername } : me;
      const run = (fn) => runAsAccount(runUser, a.id, fn);
      const folders = box === 'sent'
        ? [a.sentFolder || 'Sent']
        : await starredFoldersFor(a, ownerKey, run);
      return { account: a, run, folders: folders.filter((p) => !mutedPairs?.has(schedule.pairKey(a.id, p))) };
    }));
    const starredResult = await sweepLive(targets, { page, pageSize, q, unreadOnly, flaggedOnly: true, label: 'is:starred' });
    return res.json({ total: starredResult.total, page, pageSize, unified: true, messages: shortenSubjects(starredResult.messages), scope: 'starred' });
  }
  // "Search everywhere", the unified view's own version of the per-folder route's
  // scope=account branch: every account, every folder, live, header and body.
  if (q && req.query.scope === 'account') {
    const me = { id: currentUser().userId, username: currentUser().username };
    const targets = await Promise.all(list.map(async (a) => {
      const ownerKey = a.shared ? userKey(a.ownerUsername) : currentUser().userKey;
      const runUser = a.shared ? { id: a.ownerId, username: a.ownerUsername } : me;
      const run = (fn) => runAsAccount(runUser, a.id, fn);
      // The Sent box keeps its own scope even here — widening it would answer a
      // question nobody asked, exactly as the is:starred branch above reasons.
      const folders = box === 'sent' ? [a.sentFolder || 'Sent'] : await starredFoldersFor(a, ownerKey, run, searchFolderPaths);
      return { account: a, run, folders: folders.filter((p) => !mutedPairs?.has(schedule.pairKey(a.id, p))) };
    }));
    const swept = await sweepLive(targets, { page, pageSize, q, unreadOnly, fullText: true, label: 'search-everywhere' });
    return res.json({
      total: swept.total, page, pageSize, unified: true, messages: shortenSubjects(swept.messages),
      scope: 'account', foldersSwept: targets.reduce((n, t) => n + t.folders.length, 0),
    });
  }

  // Cached search covers subject/from/to (see cache.js's buildCacheSearchClause) — the
  // same scope an unscoped live-search term uses (server/searchQuery.js). Only an
  // explicit body:/-body: term needs live IMAP/EWS, since message bodies are never
  // cached at all — same as the "folder never synced yet" fallback already does below.
  //
  // A shared-in account's cache rows live under its OWNER's userKey, not this
  // viewer's — queryUnifiedGrouped (above) handles that by querying once per
  // owner-key group and merging, rather than disabling the cache path outright
  // whenever any shared account is present (as this route used to).
  //
  // …unless the accounts in scope have a full-text index, in which case the
  // body IS cached and the cache answers the whole query. bodySearchServable
  // insists on ALL of them being indexed: answering a body: term from the
  // indexed half of a unified view would look like a complete result and be a
  // partial one, so a mixed set still goes live. (An UNSCOPED term needs no
  // such care — see cache.js#buildCacheSearchClause.)
  const needsLive = q ? !cache.bodySearchServable(q, list) : false;
  const cacheEligible = config.cacheEnabled && !needsLive;
  // True only when the index actually contributed — a body: term answered from
  // it. Reported separately from 'cache' so the line under the results can say
  // the whole message was searched rather than repeating the subject/sender
  // caveat, which would now be wrong.
  const indexAnswered = cacheEligible && !!q && queryNeedsBodySearch(q);
  // Which of the two actually answered, reported to the client so the line under
  // the results can say so (public/js/app.js#searchScopeRow). It used to claim
  // "only recently cached mail was searched" for EVERY unescalated search, which
  // is a flat lie for a body: term — that one is already live and covers the
  // folder's whole history — and it sent a real "why didn't it find yesterday's
  // mail?" hunt looking at the cache when the actual limit was folder scope.
  let scopeUsed = indexAnswered ? 'index' : (cacheEligible ? 'cache' : 'inboxes');
  let result = cacheEligible
    ? queryUnifiedGrouped(groups, { box, page, pageSize, q, unreadOnly, flaggedOnly, mutedPairs })
    : await unifiedLive({ id: currentUser().userId, username: currentUser().username }, list, { box, page, pageSize, q, unreadOnly, flaggedOnly, mutedPairs });
  // The cache only ever holds each folder's newest syncBackfillLimit messages (see
  // store.js — 250 by default), not full history. A real search that comes up
  // completely empty there might just be older mail the cache never kept, not a
  // genuine "no such message" — fall back to a live fetch rather than silently
  // reporting nothing found for something that actually exists further back in the
  // mailbox. Only for an actual empty result (not just "fewer than a page"), so a
  // normal small-but-real result set doesn't pay this cost on top of the cache read.
  if (q && result.total === 0 && cacheEligible) {
    result = await unifiedLive({ id: currentUser().userId, username: currentUser().username }, list, { box, page, pageSize, q, unreadOnly, flaggedOnly, mutedPairs });
    scopeUsed = 'inboxes';
  }
  res.json({ total: result.total, page, pageSize, unified: true, messages: shortenSubjects(result.messages), scope: scopeUsed });
}));

// ---------- background sync status ----------
app.get('/api/sync/status', (req, res) => {
  const list = accounts.listAccounts().filter((a) => !a.disabled);
  // A shared account's sync_state rows live under its OWNER's userKey (the
  // background poller always runs it there — see sync.js#reschedule), not
  // this viewer's own — group ids by whichever key actually holds them
  // instead of one getSyncSummary call assuming a single uniform key (same
  // fix as cache.queryUnified needed for /api/unified/:box above).
  const idsByKey = new Map();
  for (const a of list) {
    const key = a.shared ? userKey(a.ownerUsername) : currentUser().userKey;
    if (!idsByKey.has(key)) idsByKey.set(key, []);
    idsByKey.get(key).push(a.id);
  }
  const byId = {};
  for (const [key, ids] of idsByKey) {
    for (const s of cache.getSyncSummary(key, ids)) byId[s.account_id] = s;
  }
  res.json(list.map((a) => ({
    accountId: a.id,
    lastSyncedAt: byId[a.id]?.last_synced_at || null,
    lastError: byId[a.id]?.last_error || null,
    syncing: sync.isSyncing(a.id),
  })));
});

// ---------- live event stream (SSE) ----------
// "Something changed, go check" — makes cross-device sync (mark read/delete/
// move on one device, see it on another almost instantly) not depend on the
// existing 15s poll's own cadence. See server/events.js for the broadcast
// side (called from every mutating route below, and from sync.js when the
// background poller finds new mail). SSE rather than a WebSocket because this
// channel is one-directional only — there is no reason for a heavier,
// bidirectional protocol. Deliberately not wrapped in wrap() — that helper
// assumes a single res.json()/error response, not a stream that outlives
// the request.
app.get('/api/events', (req, res) => {
  // Captured once, synchronously, up front — session.js's ALS context isn't
  // guaranteed to still resolve correctly inside a req.on('close', ...)
  // callback fired much later (same reasoning /api/send's own backgrounded
  // continuation already follows for its userKey).
  const uKey = currentUser().userKey;
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    // nginx-specific: disables response buffering for just this route
    // without needing to touch any reverse-proxy config — this repo ships
    // none (see README), so self-hosters behind nginx would otherwise see
    // events arrive in delayed bursts instead of immediately.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders(); // so the client's EventSource.onopen fires right away, not after the first event
  events.addClient(uKey, res);
  // Keeps the connection alive through any intermediate proxy's idle
  // timeout — a ": "-prefixed line is a comment per the SSE spec, silently
  // ignored by EventSource, never surfaced as a message event.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* connection already gone — req.on('close') below handles cleanup */ }
  }, 20000);
  req.on('close', () => {
    clearInterval(heartbeat);
    events.removeClient(uKey, res);
  });
});

// ---------- settings ----------
app.get('/api/settings', (req, res) => res.json(store.getSettings()));
app.put('/api/settings', (req, res) => {
  const next = store.saveSettings(req.body || {});
  // Two "same everywhere" settings that other open devices should pick up
  // without waiting for a reload: the sidebar's account order, and the muted
  // toggle (which changes what every badge counts, not just this tab's list).
  // Every other setting here is either device-local anyway or fine to pick up
  // on next boot.
  const body = req.body || {};
  if ('accountOrder' in body || 'showMuted' in body) events.broadcastSettings(currentUser().viewerKey);
  res.json(next);
});

// ---------- spell checking (see server/proofread.js) ----------
//
// Word-level and stateless by design: the browser tokenises the composer (it
// needs the offsets to draw underlines anyway) and sends only the DISTINCT
// words it hasn't already got a verdict for, so after the first pass a
// keystroke usually asks about one word. Nothing about the message body, its
// markup, or the draft ever reaches this route.
//
// Spelling only — no grammar. See the header of server/proofread.js.

// One dictionary lookup is microseconds, but nspell's suggest() is an
// edit-distance search per word, so a client stuck in a loop could pin a core.
// Same in-memory-Map shape as session.js's login lockout — the only rate
// limiting precedent in this codebase — keyed per user rather than per IP so
// one busy tab can't lock out a housemate on the same connection.
const PROOFREAD_WINDOW_MS = 10e3;
const PROOFREAD_MAX_WORDS = 2000;      // per request
const PROOFREAD_BUDGET = 20000;        // words per window, per user
const proofreadUse = new Map();        // userKey -> {until, used}

function proofreadAllowed(uKey, words) {
  const now = Date.now();
  const rec = proofreadUse.get(uKey);
  if (!rec || rec.until < now) {
    proofreadUse.set(uKey, { until: now + PROOFREAD_WINDOW_MS, used: words });
    return true;
  }
  rec.used += words;
  return rec.used <= PROOFREAD_BUDGET;
}

app.post('/api/proofread', wrap(async (req, res) => {
  const { words, language = 'auto', warm } = req.body || {};
  // The composer pings this with {warm:true} the moment it opens, so the
  // synchronous dictionary indexing pass (~1.6s for Slovenian) happens while
  // the user is still filling in recipients instead of mid-sentence.
  if (warm) { proofread.warm(language); return res.json({ ok: true }); }

  if (!Array.isArray(words)) { const e = new Error('words must be an array'); e.status = 400; throw e; }
  if (!proofread.available()) {
    // Degraded, not broken: the client disables itself and falls back to the
    // browser's own spellchecker rather than showing an error nobody can act on.
    return res.status(503).json({ error: 'No dictionaries available', unavailable: true });
  }
  const uKey = currentUser().viewerKey;
  if (!proofreadAllowed(uKey, words.length)) {
    const e = new Error('Too many words checked — slow down'); e.status = 429; throw e;
  }
  // express.json's limit is 50mb, which is nowhere near a sane bound for this.
  const list = words.slice(0, PROOFREAD_MAX_WORDS).filter((w) => typeof w === 'string' && w);
  const custom = new Set((store.getSettings().customDictionary || []).map((w) => String(w).toLowerCase()));
  res.json(await proofread.check(list, language, custom));
}));

// ---------- the user's own log (see server/userLog.js) ----------
// Not account-scoped: it spans every account this login can see, which is the
// whole point — "is anything wrong with my mail?" is one question, not one per
// account.
app.get('/api/log', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(userLog.list(currentUser().viewerKey, {
    limit: req.query.limit,
    offset: req.query.offset,
    level: req.query.level || null,
  }));
});
app.delete('/api/log', (req, res) => res.json(userLog.clear(currentUser().viewerKey)));

// ---------- push notification subscriptions (see server/push.js) ----------
app.get('/api/push/subscriptions', (req, res) => res.json(push.listSubscriptions(currentUser().viewerKey)));
app.post('/api/push/subscribe', (req, res) => {
  const { subscription, ua } = req.body || {};
  // Two valid shapes (see push.js#addSubscription): the standard Web Push
  // `{endpoint, keys}`, or `{type: 'fcm', token}` from the native Android
  // app shell's CodexaPush bridge (public/js/app.js).
  const valid = subscription?.type === 'fcm' ? !!subscription.token : !!(subscription?.endpoint && subscription?.keys);
  if (!valid) return res.status(400).json({ error: 'Missing subscription' });
  push.addSubscription(currentUser().viewerKey, subscription, ua);
  res.json({ ok: true });
});
// :endpoint (not a body — DELETE requests don't carry one anywhere else in
// this app either, see deleteFolder/deleteAccount) is the subscription's
// full push-service URL for a webpush entry, or its FCM token for a
// CodexaPush one (push.js#removeSubscription checks either field) —
// encodeURIComponent'd by the caller either way; Express decodes req.params
// for us.
app.delete('/api/push/subscribe/:endpoint', (req, res) => {
  push.removeSubscription(currentUser().viewerKey, decodeURIComponent(req.params.endpoint));
  res.json({ ok: true });
});
// On-demand test push to every device registered for the current user —
// bypasses mail sync entirely (no need to wait for/send real email), so it
// isolates "does a push actually leave this server and get accepted by the
// push service" from "did sync.js correctly detect new mail." See
// server/push.js#sendPushToUser's own comment for what a success here does
// and doesn't guarantee.
app.post('/api/push/test', wrap(async (req, res) => {
  const uKey = currentUser().viewerKey;
  const deviceCount = push.listSubscriptions(uKey).length;
  await push.sendPushToUser(uKey, {
    title: 'Hmelj test notification',
    body: 'If you see this, push is working on this device.',
    icon: '/icons/icon-192.png',
    tag: 'hmelj-test',
    test: true, // top-level, NOT inside `data` — see sw.js's push handler; `data` there is reserved for notificationclick's accountId/folder/uid
    data: {},
  });
  res.json({ ok: true, deviceCount });
}));

// ---------- identities ----------
app.get('/api/identities', (req, res) => {
  let ids = store.getIdentities();
  const accts = accounts.listAccounts();
  if (!accts.length) {
    // Brand-new user, zero mail accounts yet — no account e-mail to default to.
    if (!ids.length) {
      ids = [{ id: 'default', name: '', email: '', organization: '', replyTo: '', signature: '', signatureOn: 'new-reply', default: true }];
      store.saveIdentities(ids);
    }
  } else {
    // Normally every account gets its identity via accounts.js#saveAccount;
    // this reconciles accounts that predate that guarantee, or somehow lost
    // theirs, so the Identities tab never shows an account with zero.
    let changed = false;
    for (const a of accts) {
      if (!ids.some((i) => i.accountId === a.id)) {
        ids.push({ id: a.id, name: '', email: a.email, organization: '', replyTo: '', signature: '', signatureOn: 'new-reply', accountId: a.id, default: !ids.some((i) => i.default) });
        changed = true;
      }
    }
    if (changed) store.saveIdentities(ids);
  }
  res.json(ids);
});
app.put('/api/identities', (req, res) => res.json(store.saveIdentities(req.body || [])));

// ---------- contacts ----------
/**
 * The address book: what the user typed, plus everything synced in.
 *
 * One flat list, because every consumer (the compose recipient picker, the
 * Settings editor) wants "people I can write to" and does not care where a row
 * came from. Synced rows carry `synced: true` and a composite id — see
 * contactSources.js#allRows — which is what lets the editor mark them and the
 * routes below tell the two kinds apart.
 */
app.get('/api/contacts', (req, res) => res.json([...store.getContacts(), ...contactSources.allRows()]));

/**
 * Replaces the LOCAL address book.
 *
 * Synced rows are stripped rather than trusted, even though no Hmelj client
 * sends them back. This route takes a whole list and overwrites contacts.json
 * with it, and contacts.json is the only copy of the hand-typed address book
 * that exists anywhere — so "the client would not do that" is not a good enough
 * guarantee. A synced contact is edited through
 * PUT /api/contact-sources/rows/:id, which writes to the server it came from.
 */
app.put('/api/contacts', (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body : [];
  const local = incoming.filter((c) => !c?.synced);
  res.json([...store.saveContacts(local), ...contactSources.allRows()]);
});
/** Removes one contact by id, answering with the list that's left so the caller
 * can adopt it wholesale. A dedicated route rather than a PUT of the whole list:
 * this is reachable straight from compose's recipient autocomplete, where the
 * client holds a filtered VIEW of the contacts and PUTting that back would
 * delete everything not currently matching what was typed. */
app.delete('/api/contacts/:id', wrap(async (req, res) => {
  // A synced row's id is composite (contactSources.js#allRows). Deleting one
  // means deleting the CARD on the server it came from — removing only the
  // local mirror would put it straight back on the next poll, which reads as
  // "delete does nothing".
  const target = contactSources.resolveRow(req.params.id);
  if (target) {
    await contactsSync.deleteCardFor(myKey(), target.source, target.book,
      { href: target.card.href, url: target.card.url, etag: target.card.etag });
    return res.json({ contacts: [...store.getContacts(), ...contactSources.allRows()] });
  }
  const contacts = store.getContacts();
  const next = contacts.filter((c) => c.id !== req.params.id);
  if (next.length === contacts.length) return res.status(404).json({ error: 'No such contact' });
  res.json({ contacts: [...store.saveContacts(next), ...contactSources.allRows()] });
}));

/**
 * People this user actually corresponds with, harvested from the local message
 * cache (server/cache.js#correspondents) and offered as contacts to add — the
 * address book most users never got around to typing in.
 *
 * Excluded: addresses already saved as contacts, and the user's own (every
 * account address plus every identity, or "you" would top your own list).
 * Ranked by messages SENT to that address first — writing to someone is a far
 * stronger signal of "this is a contact" than merely receiving from them, which
 * is equally true of every newsletter you've never replied to.
 *
 * A shared-in account's rows live in its OWNER's cache namespace, so the scan
 * is grouped by owner key exactly like the unread total is (see
 * mutedPairsForGroups above and server/unread.js's own note on this).
 */
app.get('/api/contacts/suggestions', (req, res) => {
  if (!config.cacheEnabled) return res.json({ suggestions: [], cacheDisabled: true });
  const list = accounts.listAccounts().filter((a) => !a.disabled);
  const groups = groupByKey(list, (a) => (a.shared ? userKey(a.ownerUsername) : currentUser().userKey));
  const merged = new Map();
  for (const [groupKey, groupAccounts] of groups) {
    for (const c of cache.correspondents(groupKey, groupAccounts.map((a) => ({ id: a.id, sentFolder: a.sentFolder })))) {
      const prev = merged.get(c.email);
      if (!prev) { merged.set(c.email, { ...c }); continue; }
      prev.received += c.received;
      prev.sent += c.sent;
      prev.last = Math.max(prev.last, c.last);
      if (c.name.length > prev.name.length) prev.name = c.name;
    }
  }
  const mine = new Set([
    ...list.map((a) => String(a.email || '').toLowerCase()),
    ...store.getIdentities().map((i) => String(i.email || '').toLowerCase()),
  ].filter(Boolean));
  // Synced contacts count as known too: offering to "add" somebody who is
  // already in the address book would create a second, local copy of them that
  // then never goes away.
  const known = new Set([...store.getContacts(), ...contactSources.allRows()]
    .map((c) => String(c.email || '').toLowerCase()));
  const suggestions = [...merged.values()]
    .filter((c) => !known.has(c.email) && !mine.has(c.email))
    .sort((a, b) => (b.sent - a.sent) || (b.received - a.received) || (b.last - a.last))
    .slice(0, 200); // a mailbox can hold thousands of one-off addresses; this is a picker, not an export
  res.json({ suggestions });
});

/**
 * Imports the Contacts folder of one Exchange account (`?account=<id>`) into
 * the local contact list. Read-only on the Exchange side — see
 * ewsClient.js#listContacts, which reads the personal Contacts folder only,
 * never the company-wide GAL.
 */
app.post('/api/contacts/import/ews', wrap(async (req, res) => {
  const acc = accounts.currentAccount();
  if (acc.type !== 'ews') return res.status(400).json({ error: 'Not an Exchange account' });
  const rows = await ewsClient.listContacts();
  res.json({ ...addContacts(rows), found: rows.length });
}));

/**
 * The same for a Microsoft Graph account (`?account=<id>`). Separate route
 * rather than a branch inside the EWS one: the two read different APIs and
 * only the account type decides which, so making the path say so keeps the
 * client's own "which button do I show" logic honest. Personal contacts only —
 * see graphClient.js#listContacts.
 */
app.post('/api/contacts/import/graph', wrap(async (req, res) => {
  const acc = accounts.currentAccount();
  if (acc.type !== 'graph') return res.status(400).json({ error: 'Not a Microsoft account' });
  const rows = await graphClient.listContacts();
  res.json({ ...addContacts(rows), found: rows.length });
}));

app.post('/api/contacts/import', (req, res) => {
  // Accepts Google Contacts CSV export or vCard text in body.text. Parsing is
  // all this does now — the de-dupe/save half is addContacts() in
  // server/contacts.js, shared with the Exchange/Graph imports, the
  // mail-history suggestions and the automatic add on send.
  //
  // body.rows ([{name, email}]) skips the parsing entirely: that's what the
  // mail-history picker sends, having already been handed structured rows by
  // GET /api/contacts/suggestions.
  const { text } = req.body || {};
  if (Array.isArray(req.body?.rows)) return res.json(addContacts(req.body.rows));
  const rows = [];
  if (text && text.trimStart().startsWith('BEGIN:VCARD')) {
    for (const card of text.split(/END:VCARD/i)) {
      rows.push({
        name: /FN[^:]*:(.+)/i.exec(card)?.[1]?.trim() || '',
        email: /EMAIL[^:]*:(.+)/i.exec(card)?.[1]?.trim() || '',
      });
    }
  } else if (text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    const header = lines.shift()?.split(',') || [];
    const nameIdx = header.findIndex((h) => /^name$|first name/i.test(h));
    const emailIdx = header.findIndex((h) => /e-?mail/i.test(h));
    for (const line of lines) {
      const cols = line.split(',');
      rows.push({ name: cols[nameIdx]?.trim() || '', email: cols[emailIdx]?.trim() || '' });
    }
  }
  res.json(addContacts(rows));
});

// ---------- contact sources (live CardDAV / Google / Microsoft / Exchange sync) ----------
//
// Everything here is viewerKey-scoped through contactSources.js, like the rest
// of a person's own configuration — see store.js's userDir() comment for why
// that must never follow the shared-mail-account ownership swap.

const myKey = () => currentUser().viewerKey;

app.get('/api/contact-sources', (req, res) => res.json({
  sources: contactSources.listSources(),
  kinds: contactSources.SOURCE_KINDS,
}));

/**
 * Ask a server what it has, WITHOUT saving anything.
 *
 * Its own route because the alternative — save first, then discover — leaves a
 * broken source behind every time a password is mistyped, which is the common
 * case when adding one. The credentials are used for this one request and
 * dropped unless the caller goes on to save.
 */
app.post('/api/contact-sources/discover', wrap(async (req, res) => {
  const draft = { ...(req.body || {}) };
  // A saved source re-discovering itself sends no password (the UI never has
  // it); fall back to the stored one rather than making the user retype it.
  if (draft.id && !draft.password) {
    const stored = contactSources.rawSource(draft.id);
    if (stored) { draft.password = contactSources.passwordOf(stored); draft.kind ||= stored.kind; }
  }
  const probe = {
    id: draft.id || 'probe', kind: draft.kind || 'carddav', label: draft.label || '',
    url: draft.url || '', username: draft.username || '',
    // buildContext decrypts what it finds here, so a plaintext probe password
    // has to arrive already encrypted — the same shape a stored one has.
    password: draft.password ? accounts.encrypt(String(draft.password)) : '',
    accountId: draft.accountId || '', direction: 'pull', books: [],
  };
  res.json(await contactsSync.discoverFor(myKey(), probe));
}));

app.post('/api/contact-sources', wrap(async (req, res) => {
  const saved = contactSources.saveSource(req.body || {});
  contactSyncRunner.clearBackoff(saved.id);
  res.json(saved);
}));

app.put('/api/contact-sources/:id', wrap(async (req, res) => {
  const saved = contactSources.saveSource(req.body || {}, req.params.id);
  // A source that was just fixed should try again now, not sit out the backoff
  // its broken credentials earned it.
  contactSyncRunner.clearBackoff(saved.id);
  res.json(saved);
}));

app.delete('/api/contact-sources/:id', (req, res) => {
  contactSources.deleteSource(req.params.id);
  contactSyncRunner.clearBackoff(req.params.id);
  res.json({ ok: true });
});

/**
 * Edits one synced contact — writing to the server it came from.
 *
 * The vCard is rebuilt from the STORED one (see server/vcard.js's header):
 * Hmelj replaces the name and the addresses and puts every other property back
 * exactly as it arrived, so an edit here cannot delete somebody's birthday,
 * photo or postal address.
 *
 * A 412 from the server means it changed under us and is passed through as a
 * 412 rather than retried unconditionally — the unconditional retry is how the
 * other person's edit gets destroyed.
 */
app.put('/api/contact-sources/rows/:id', wrap(async (req, res) => {
  const target = contactSources.resolveRow(req.params.id);
  if (!target) return res.status(404).json({ error: 'No such contact' });
  const { name, email } = req.body || {};

  const card = vcard.parseCard(target.card.vcard);
  if (!card) return res.status(409).json({ error: 'That contact could not be read back — sync it again first.' });
  const patch = {};
  if (name !== undefined) patch.name = String(name);
  if (email !== undefined) {
    // Only the address this ROW stands for changes. A card with a work and a
    // private address shows as two rows, and editing one of them must not
    // collapse the card down to a single address.
    const emails = vcard.cardEmails(card).map((e) => ({ email: e.email, types: e.types }));
    if (emails[target.emailIndex]) emails[target.emailIndex] = { ...emails[target.emailIndex], email: String(email) };
    else emails.push({ email: String(email) });
    patch.emails = emails;
  }
  const updated = vcard.serializeCard(vcard.applyContact(card, patch));

  await contactsSync.updateCardFor(myKey(), target.source, target.book,
    { href: target.card.href, url: target.card.url, etag: target.card.etag }, updated);
  res.json({ contacts: [...store.getContacts(), ...contactSources.allRows()] });
}));

/** Creates a contact in one synced book. */
app.post('/api/contact-sources/:id/books/:bookId/cards', wrap(async (req, res) => {
  const source = contactSources.rawSource(req.params.id);
  const book = source?.books?.find((b) => b.id === contactSources.assertId(req.params.bookId));
  if (!source || !book) return res.status(404).json({ error: 'No such address book' });
  const { name = '', email = '' } = req.body || {};
  if (!String(email).includes('@')) return res.status(400).json({ error: 'A contact needs an e-mail address' });
  const uid = crypto.randomUUID();
  const card = vcard.newCard({ name: String(name), emails: [{ email: String(email) }], uid });
  await contactsSync.createCardFor(myKey(), source, book, { uid, vcard: vcard.serializeCard(card) });
  res.json({ contacts: [...store.getContacts(), ...contactSources.allRows()] });
}));

/** Sync one source now. Goes through the runner, not the engine directly, so
 *  the in-flight guard is shared with the background poll — a double-click and
 *  a timer tick must not both write the same book file. */
app.post('/api/contact-sources/:id/sync', wrap(async (req, res) => {
  contactSources.assertId(req.params.id);
  contactSyncRunner.clearBackoff(req.params.id);
  const result = await contactSyncRunner.syncSourceNow(myKey(), req.params.id, {
    force: !!req.body?.force, interactive: true,
  });
  res.json({ ...result, sources: contactSources.listSources() });
}));

// ---------- calendars ----------
//
// viewerKey-scoped throughout (calendarStore.js), like the rest of a person's
// own configuration — see store.js's userDir() comment for why that must never
// follow the shared-mail-account ownership swap.

/** The viewer's zone, which decides two things and no others: which day a timed
 *  event belongs to, and how a floating event is read. Falls back to the
 *  server's own zone when the setting is empty, which is what a client that has
 *  not sent one yet gets. */
function viewerTimezone(req) {
  const asked = String(req.query.tz || '').trim();
  // Validated by trying it, not by pattern: the set of valid zone names is
  // whatever this Node's ICU knows, and a query parameter is user input.
  if (asked) {
    try { new Intl.DateTimeFormat('en', { timeZone: asked }); return asked; } catch { /* fall through */ }
  }
  return store.getSettings().timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

app.get('/api/calendars', (req, res) => res.json({
  sources: calendarStore.listSources(),
  calendars: calendarStore.listCalendars(),
  kinds: calendarStore.SOURCE_KINDS,
  // Microsoft and Exchange calendars are only known over a rolling window, and
  // the UI has to be able to say so — "my appointment in 2031 is missing"
  // deserves a better answer than silence.
  window: calendarSync.currentWindow(),
  timezone: viewerTimezone(req),
}));

/** Probe a server and list its calendars WITHOUT saving anything — same
 *  reasoning as the contact-source probe: save-then-discover leaves a broken
 *  source behind every time a password is mistyped. */
app.post('/api/calendars/discover', wrap(async (req, res) => {
  const draft = { ...(req.body || {}) };
  if (draft.id && !draft.password) {
    const stored = calendarStore.rawSource(draft.id);
    if (stored) { draft.password = calendarStore.passwordOf(stored); draft.kind ||= stored.kind; }
  }
  const probe = {
    id: draft.id || 'probe', kind: draft.kind || 'caldav', label: draft.label || '',
    url: draft.url || '', username: draft.username || '',
    // buildContext decrypts what it finds here, so a plaintext probe password
    // has to arrive already encrypted — the same shape a stored one has.
    password: draft.password ? accounts.encrypt(String(draft.password)) : '',
    accountId: draft.accountId || '', calendars: [],
  };
  res.json(await calendarBackends.discoverFor(currentUser().viewerKey, probe));
}));

app.post('/api/calendars/sources', wrap(async (req, res) => {
  const saved = calendarStore.saveSource(req.body || {});
  calendarSync.clearBackoff(saved.id);
  res.json(saved);
}));

app.put('/api/calendars/sources/:id', wrap(async (req, res) => {
  const saved = calendarStore.saveSource(req.body || {}, req.params.id);
  // A source that was just fixed should try again now rather than sit out the
  // backoff its broken credentials earned it.
  calendarSync.clearBackoff(saved.id);
  res.json(saved);
}));

app.delete('/api/calendars/sources/:id', (req, res) => {
  calendarStore.deleteSource(req.params.id);
  calendarSync.clearBackoff(req.params.id);
  res.json({ ok: true });
});

/** Sync one source now. Through the runner, not the backend directly, so the
 *  in-flight guard is shared with the background poll. */
app.post('/api/calendars/sources/:id/sync', wrap(async (req, res) => {
  calendarStore.assertId(req.params.id);
  calendarSync.clearBackoff(req.params.id);
  const result = await calendarSync.syncSourceNow(currentUser().viewerKey, req.params.id, {
    force: !!req.body?.force, interactive: true,
  });
  res.json({ ...result, sources: calendarStore.listSources(), calendars: calendarStore.listCalendars() });
}));

/**
 * A NEW calendar in this source, created on whatever server it talks to.
 *
 * Two steps that must stay in this order: create it remotely, and only then
 * store it. A local record written first would survive a refusal and leave a
 * calendar in the list that does not exist anywhere — the same reasoning the
 * discover-then-save flow already follows.
 */
app.post('/api/calendars/sources/:id/calendars', wrap(async (req, res) => {
  const uKey = currentUser().viewerKey;
  const source = calendarStore.rawSourceFor(uKey, calendarStore.assertId(req.params.id));
  if (!source) return res.status(404).json({ error: 'No such calendar source' });
  const collection = await calendarBackends.createCalendarFor(uKey, source, {
    displayName: req.body?.displayName,
    color: calendarWrite.normalizeEventColor(req.body?.color) || '',
  });
  const stored = calendarStore.addCalendarFor(uKey, source.id, collection);
  // Straight into a sync, so the new calendar is not sitting there looking
  // broken (no events, never synced) until the poller next comes round.
  try { await calendarSync.syncSourceNow(uKey, source.id, { interactive: true }); }
  catch (e) { log.scope('calendar').warn(`Created ${stored.displayName} but could not sync it yet: ${e.message}`); }
  res.json({ calendar: stored, sources: calendarStore.listSources(), calendars: calendarStore.listCalendars() });
}));

/** Show or hide one calendar, or give it a colour of your own. Its own route
 *  rather than a source PUT: these are one-click changes in the sidebar and in
 *  Settings, and round-tripping the whole source record through the browser for
 *  them would be both slower and one more chance to send back stale sync
 *  state. */
app.patch('/api/calendars/:id', (req, res) => {
  const found = calendarStore.resolveCalendar(calendarStore.assertId(req.params.id));
  if (!found) return res.status(404).json({ error: 'No such calendar' });
  const uKey = currentUser().viewerKey;
  if (req.body?.visible !== undefined) {
    calendarStore.updateSyncStateFor(uKey, found.source.id, found.calendar.id, { visible: !!req.body.visible });
  }
  if (req.body?.color !== undefined) {
    // Validated, because this value is interpolated into a style attribute in
    // the browser — same reasoning and same function as an event's own colour.
    const asked = String(req.body.color ?? '');
    const color = calendarWrite.normalizeEventColor(asked);
    // A value that was MEANT as a colour and is not one is refused, not quietly
    // treated as "clear" — which is what the first cut did, so a bad request
    // wiped the colour of the calendar it was aimed at. Only a genuinely empty
    // string means clear.
    if (asked.trim() && !color) return res.status(400).json({ error: 'That is not a colour' });
    // A colour the USER chose has to survive the next discovery, which reports
    // the server's own again — calendarStore.js#mergeCalendars checks the lock
    // this sets. Clearing hands it back to the automatic colour rather than to
    // no colour at all; see setCalendarColorFor.
    calendarStore.setCalendarColorFor(uKey, found.source.id, found.calendar.id, color);
  }
  res.json({ calendars: calendarStore.listCalendars() });
});

/**
 * The occurrences in a window — everything the calendar views draw.
 *
 * `from` and `to` are epoch milliseconds. The window is capped rather than
 * trusted: an unbounded one would expand every recurring event since 1970, and
 * the request is reachable by anyone with a session.
 */
const MAX_CALENDAR_SPAN_MS = 400 * 86400000;
app.get('/api/calendar/events', (req, res) => {
  const from = Number(req.query.from);
  const to = Number(req.query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return res.status(400).json({ error: 'from and to must be epoch milliseconds, with to after from' });
  }
  const uKey = currentUser().viewerKey;
  const timezone = viewerTimezone(req);
  const ids = req.query.calendars
    ? String(req.query.calendars).split(',').filter(Boolean)
    : calendarStore.visibleCalendarIdsFor(uKey);
  res.json({
    events: calendarEvents.occurrencesIn(uKey, ids, from, Math.min(to, from + MAX_CALENDAR_SPAN_MS), { timezone }),
    timezone,
  });
});

/** One event. `start` names which occurrence of a series is meant; without it
 *  the series itself is described. */
app.get('/api/calendar/event/:calendarId/:uid', wrap(async (req, res) => {
  const uKey = currentUser().viewerKey;
  const calendarId = calendarStore.assertId(req.params.calendarId);
  const detail = calendarEvents.eventDetail(uKey, calendarId, req.params.uid, {
    occurrenceStart: req.query.start ? Number(req.query.start) : null,
    timezone: viewerTimezone(req),
  });
  if (!detail) return res.status(404).json({ error: 'No such event' });

  // Microsoft and Exchange list events without their bodies — Graph truncates
  // at 255 characters and EWS's FindItem returns none at all — so the notes,
  // the attendee list and the "join the call" link are fetched here, for the
  // one event being opened. A failure is not an error: the event still opens
  // with everything the last sync knew.
  if (detail.partialDescription) {
    const found = calendarStore.resolveCalendarFor(uKey, calendarId);
    const backend = found && calendarBackends.backendFor(found.source.kind);
    if (backend?.fetchDetail) {
      try {
        const extra = await calendarBackends.withSource(uKey, found.source,
          (ctx) => backend.fetchDetail(ctx, { ...detail, providerId: detail.providerId, itemId: detail.itemId }));
        if (extra) Object.assign(detail, extra, { partialDescription: false });
      } catch (e) {
        log.scope('calendar').debug(`Could not read the full event: ${e.message}`);
      }
    }
  }

  // The raw iCalendar stays on the server: nothing in the UI reads it, and it
  // routinely carries every attendee's address. The provider's own opaque ids
  // go with it — they are how a write would be addressed, and the browser has
  // no use for them.
  const { ical, providerId, itemId, ...safe } = detail;
  res.json(safe);
}));

/**
 * Who Hmelj is writing as, on an event it creates or changes.
 *
 * The default identity, which is the address this person sends everything else
 * from and therefore the one an attendee's reply has to come back to. Falls
 * back to the first mail account, and to nothing at all — a calendar-only user
 * has no address, and an event with no ORGANIZER is perfectly valid.
 */
function calendarOrganizer() {
  const identities = store.getIdentities();
  const identity = identities.find((i) => i.default) || identities[0];
  if (identity?.email) return { name: identity.name || '', address: identity.email };
  const acc = accounts.listAccounts().find((a) => !a.disabled);
  return acc?.email ? { name: acc.label || '', address: acc.email } : null;
}

/** The arguments every write shares. `withSource` and `backendFor` come from
 *  the dispatcher rather than being rebuilt here, so the write path resolves
 *  credentials exactly the way the sync path does. */
const writeDeps = () => ({
  backendFor: calendarBackends.backendFor,
  withSource: calendarBackends.withSource,
  organizer: calendarOrganizer(),
});

/** Re-reads the one calendar a write touched, so the new state is visible
 *  immediately rather than at the next poll — up to five minutes of a screen
 *  that looks like nothing happened. */
async function afterCalendarWrite(uKey, calendarId) {
  const found = calendarStore.resolveCalendarFor(uKey, calendarId);
  if (!found) return;
  try {
    await calendarBackends.refreshCalendarFor(uKey, found.source.id, found.calendar.id, { window: calendarSync.currentWindow() });
  } catch (e) {
    // The write itself succeeded; a failed re-read is a stale screen, not a
    // lost event, and the next poll fixes it.
    log.scope('calendar').debug(`Post-write refresh failed: ${e.message}`);
  }
  events.broadcastSettings(uKey);
}

/**
 * An event's colour, stored by Hmelj rather than written into the event.
 *
 * Applied AFTER the write, and only if the write succeeded: a colour recorded
 * for an event that failed to save would point at nothing, and would then
 * quietly colour whatever later took that uid.
 *
 * See calendarStore.js's per-event colours section for why this is not the
 * iCalendar COLOR property any more — Google's CalDAV drops it, and Microsoft
 * and Exchange never stored iCalendar in the first place.
 */
function applyEventColor(uKey, calendarId, uid, input) {
  if (input?.color === undefined || !uid) return;
  calendarStore.setEventColorFor(uKey, calendarId, uid, calendarWrite.normalizeEventColor(input.color) || '');
}

app.post('/api/calendar/events', wrap(async (req, res) => {
  const uKey = currentUser().viewerKey;
  const { calendarId, ...input } = req.body || {};
  const result = await calendarWrite.createEventFor(uKey, calendarId, input, writeDeps());
  applyEventColor(uKey, calendarId, result?.uid, input);
  await afterCalendarWrite(uKey, calendarId);
  res.json(result);
}));

/**
 * Changes one event.
 *
 * `scope` is the whole reason this route is not a plain PUT: on a repeating
 * event, "one", "future" and "all" write three genuinely different documents
 * (see server/calendarWrite.js). It is required from the client rather than
 * defaulted, so a UI that forgot to ask cannot silently pick the most
 * destructive one.
 */
app.put('/api/calendar/event/:calendarId/:uid', wrap(async (req, res) => {
  const uKey = currentUser().viewerKey;
  const calendarId = calendarStore.assertId(req.params.calendarId);
  const { scope = 'all', occurrenceStart = null, ...input } = req.body || {};
  if (!calendarWrite.SCOPES.includes(scope)) {
    return res.status(400).json({ error: `scope must be one of ${calendarWrite.SCOPES.join(', ')}` });
  }
  const result = await calendarWrite.updateEventFor(uKey, calendarId, req.params.uid, input, {
    scope, occurrenceStart, ...writeDeps(),
  });
  // `result.uid` rather than the one in the URL: a "this and following" split
  // writes a NEW series under a new uid, and the colour belongs to the half the
  // edit produced.
  applyEventColor(uKey, calendarId, result?.uid || req.params.uid, input);
  await afterCalendarWrite(uKey, calendarId);
  res.json(result);
}));

app.delete('/api/calendar/event/:calendarId/:uid', wrap(async (req, res) => {
  const uKey = currentUser().viewerKey;
  const calendarId = calendarStore.assertId(req.params.calendarId);
  const scope = String(req.query.scope || 'all');
  if (!calendarWrite.SCOPES.includes(scope)) {
    return res.status(400).json({ error: `scope must be one of ${calendarWrite.SCOPES.join(', ')}` });
  }
  const result = await calendarWrite.deleteEventFor(uKey, calendarId, req.params.uid, {
    scope,
    occurrenceStart: req.query.start ? Number(req.query.start) : null,
    ...writeDeps(),
  });
  // Only when the whole event went. Deleting ONE occurrence, or capping a
  // series, leaves the rest of it on the calendar still wanting its colour.
  if (scope === 'all') calendarStore.forgetEventColorFor(uKey, calendarId, req.params.uid);
  await afterCalendarWrite(uKey, calendarId);
  res.json(result);
}));

/**
 * Snoozes one reminder, from the notification's own Snooze button.
 *
 * Reached from the service worker with no page open, which is why it takes the
 * occurrence by value rather than by any id the page would have had to look up.
 * Deliberately not subject to the staleness guards the runner applies: the user
 * asked for this one, at this time, explicitly.
 */
app.post('/api/calendar/snooze', wrap(async (req, res) => {
  const { calendarId, uid, start, minutes } = req.body || {};
  if (!calendarId || !uid || !Number.isFinite(Number(start))) {
    return res.status(400).json({ error: 'calendarId, uid and start are required' });
  }
  const found = calendarStore.resolveCalendar(calendarStore.assertId(String(calendarId)));
  if (!found) return res.status(404).json({ error: 'No such calendar' });
  res.json(calendarReminders.snooze(currentUser().viewerKey, {
    calendarId: found.calendar.id, uid: String(uid), start: Number(start),
    minutes: Number(minutes) || 5,
  }));
}));

// ---------- app passwords and published collections (the DAV server) ----------

app.get('/api/app-passwords', (req, res) => res.json({
  passwords: appPasswords.list(),
  scopes: appPasswords.SCOPES,
}));

/**
 * Creates one and returns the secret.
 *
 * The ONLY time it exists in readable form — it is scrypt-hashed on the way in
 * and there is deliberately no route that can produce it again. The UI has to
 * show it once and say so.
 */
app.post('/api/app-passwords', wrap(async (req, res) => {
  const { label, scopes } = req.body || {};
  res.json(appPasswords.create({ label, scopes }));
}));

app.delete('/api/app-passwords/:id', (req, res) => {
  appPasswords.remove(String(req.params.id));
  res.json({ passwords: appPasswords.list() });
});

app.get('/api/dav/published', (req, res) => {
  const uKey = currentUser().viewerKey;
  res.json({
    published: davPublish.listFor(uKey).map((p) => ({ ...p, writable: davPublish.isWritable(uKey, p) })),
    publishable: davPublish.publishable(),
    // The URL a subscriber types in. Built from the request rather than stored,
    // so it is right behind a reverse proxy and right on a LAN, and correct
    // again the day the instance moves.
    baseUrl: `${oauth.publicBaseFrom(req)}/dav/`,
    userKey: uKey,
    hasPassword: appPasswords.hasAnyFor(uKey),
  });
});

app.post('/api/dav/published', wrap(async (req, res) => {
  res.json(davPublish.upsert(req.body || {}));
}));

app.put('/api/dav/published/:id', wrap(async (req, res) => {
  res.json(davPublish.upsert(req.body || {}, req.params.id));
}));

app.delete('/api/dav/published/:id', (req, res) => {
  davPublish.remove(req.params.id);
  res.json({ ok: true });
});

// ---------- subject rules (Settings > Subject) ----------
//
// Rewrites the subject SHOWN in a list and in a push notification, per person
// and per account. server/subjectRules.js owns the engine, why this is
// display-only, and the regex-safety reasoning behind the save-time refusal
// below; shortenSubjects() (above, with the list routes) is where the read
// path uses it.
app.get('/api/subject-rules', (req, res) => res.json(store.getSubjectRules()));
app.put('/api/subject-rules', (req, res) => {
  const list = req.body || [];
  // All-or-nothing on purpose: the rules CHAIN, so half a chain isn't a
  // smaller version of the same thing, it's a different rewrite. Better to
  // refuse the save and name the rule than to store something that reads
  // wrong.
  const check = subjectRules.validateAll(list);
  if (!check.ok) return res.status(400).json({ error: check.error, index: check.index });
  res.json(store.saveSubjectRules(list));
});
// The Test panel in Settings. Takes the rules from the REQUEST rather than from
// disk, which is the whole point of it: you test the regex you are in the
// middle of writing, not the one you last saved.
app.post('/api/subject-rules/test', (req, res) => {
  const { subject = '', accountId = null, rules = null } = req.body || {};
  const list = Array.isArray(rules) ? rules : store.getSubjectRules();
  res.json(subjectRules.explain(subject, list, accountId));
});

/* ---------- export (server/export.js) ----------
 *
 * Two different shapes, because the two kinds of data are nothing alike: the
 * settings are a handful of small JSON files and fit in one zip; the mail is
 * unbounded and is streamed as mbox, one folder at a time.
 */

/** The address book as one vCard file. Rows sharing a name become one card
 *  with several addresses, which is what a vCard is for and what every other
 *  address book expects to import. */
function vcardFor(contacts) {
  const byName = new Map();
  for (const c of contacts) {
    const key = String(c.name || c.email || '').trim().toLowerCase();
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, { name: c.name || '', emails: [] });
    if (c.email) byName.get(key).emails.push({ email: c.email });
  }
  return [...byName.values()].map((p) => vcard.serializeCard(vcard.newCard(p))).join('');
}

/** Everything except the mail: settings, identities, filters, subject rules,
 *  saved searches, templates, contacts (JSON and vCard), local calendars.
 *  Mail ACCOUNTS are deliberately excluded — see export.js#settingsArchive. */
app.get('/api/export/settings', wrap(async (req, res) => {
  const viewerKey = currentUser().viewerKey;
  const contacts = store.getContacts();
  const calendars = {};
  for (const cal of calendarStore.listCalendarsFor(viewerKey)) {
    if (cal.sourceKind !== 'local') continue; // the rest live on somebody else's server and are re-syncable
    try {
      const events = calendarStore.listLocalEvents(viewerKey, cal.id);
      // One .ics per event, under a directory per calendar. Concatenating them
      // into a single VCALENDAR would need the components unwrapped and
      // re-wrapped, and every one of these files is already a complete,
      // importable calendar on its own — which is also how they are stored.
      for (const e of events) calendars[`${cal.id}/${e.file}`] = e.ical;
    } catch (e) { log.debug(`Export: could not read calendar ${cal.id}: ${e.message}`); }
  }
  const files = exportLib.settingsArchive({
    settings: store.getSettings(),
    identities: store.getIdentities(),
    filters: store.getFilters(),
    subjectRules: store.getSubjectRules(),
    savedSearches: store.getSavedSearches(),
    templates: store.getTemplates(),
    contacts,
    // A contact ROW is one name + one address (server/contacts.js); a vCard
    // holds all of a person's addresses, so the rows are regrouped by name on
    // the way out rather than emitting one card per address.
    contactsVcf: contacts.length ? vcardFor(contacts) : '',
    calendars,
  });
  const buf = zipSync(files);
  const name = exportLib.exportFilename(['hmelj', 'settings', new Date().toISOString().slice(0, 10)], 'zip');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDisposition('attachment', name));
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Cache-Control', 'no-store');
  res.end(buf);
}));

/**
 * One folder as mbox, streamed.
 *
 * Streamed rather than assembled: a folder can be gigabytes, and buffering it
 * would mean the export succeeds on small mailboxes and takes the server down
 * on the ones that actually needed exporting. Written straight to the response
 * a message at a time, so memory use is one message regardless of folder size.
 *
 * No Content-Length for the same reason — the size is not known until the last
 * message has been fetched, and finding out would mean doing the whole job
 * twice. The browser shows an indeterminate download; that is the honest state.
 *
 * A message that cannot be fetched is SKIPPED and counted, never fatal: one
 * unreadable message must not cost somebody the other twenty thousand. The
 * count goes in a trailer comment at the end of the file, where an importer
 * ignores it and a person reading the file can see it.
 */
app.get('/api/export/mail', wrap(async (req, res) => {
  const folder = decodeURIComponent(req.query.folder || 'INBOX');
  const acc = accounts.currentAccount();
  const since = req.query.since ? Date.parse(req.query.since) : null;
  const name = exportLib.exportFilename([acc.label, folder], 'mbox');
  res.setHeader('Content-Type', 'application/mbox');
  res.setHeader('Content-Disposition', contentDisposition('attachment', name));
  res.setHeader('Cache-Control', 'no-store');

  const PAGE = 100;
  let page = 1, written = 0, skipped = 0;
  for (;;) {
    const batch = await imap.listMessages(folder, { page, pageSize: PAGE });
    const list = batch?.messages || [];
    if (!list.length) break;
    for (const m of list) {
      if (since && m.date && new Date(m.date).getTime() < since) continue;
      try {
        const raw = await imap.getMessageSource(folder, m.uid);
        // Backpressure: without awaiting drain, a fast mailbox and a slow
        // connection buffer the whole folder in memory anyway, which is the one
        // thing streaming was for.
        if (!res.write(exportLib.mboxEntry(raw, { from: m.from?.address, date: m.date }))) {
          await new Promise((r) => res.once('drain', r));
        }
        written++;
      } catch (e) {
        skipped++;
        log.warn(`Export: skipping ${folder}/${m.uid}: ${e.message}`);
      }
    }
    if (list.length < PAGE) break;
    page++;
  }
  res.end(`\n# Hmelj export: ${written} message(s) from ${folder}${skipped ? `, ${skipped} skipped (unreadable)` : ''}\n`);
  log.info(`Exported ${written} message(s) from ${acc.label}/${folder}${skipped ? ` (${skipped} skipped)` : ''}`);
}));

// ---------- templates ----------
// Whole-list read and write, like identities and saved searches: a handful of
// them, edited together in one pane, and a PUT of the array is the only write
// that cannot leave two of them disagreeing about their order.
app.get('/api/templates', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(store.getTemplates());
});
app.put('/api/templates', (req, res) => res.json(store.saveTemplates(req.body)));

// ---------- saved searches ----------
//
// Stored and returned as a whole list, like identities and filters: there are a
// handful of them, the settings pane edits them together, and a PUT of the
// whole array is the only write that cannot leave two of them disagreeing about
// their order.
app.get('/api/saved-searches', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(store.getSavedSearches());
});
// The list is normalised by the store rather than here — see store.js's
// normalizeSavedSearches for what it repairs and what it drops.
app.put('/api/saved-searches', (req, res) => res.json(store.saveSavedSearches(req.body)));

// ---------- filters ----------
app.get('/api/filters', (req, res) => res.json(store.getFilters()));
app.put('/api/filters', (req, res) => res.json(store.saveFilters(req.body || [])));
app.post('/api/filters/run', wrap(async (req, res) => {
  const { folder = 'INBOX' } = req.body || {};
  const result = await runFilters(folder);
  // Same cache maintenance the interactive move route does, for the same
  // reason: filters.js moves messages on the mail server but owns no cache, so
  // without this the source folder keeps a row for a message that has left it
  // — and the unified list shows that message twice until the next full sync.
  if (config.cacheEnabled && (result.departed?.length || result.targets?.length)) {
    const uKey = currentUser().userKey;
    const acctId = currentUser().accountId;
    if (result.departed?.length) {
      sync.noteLocalWrite(uKey, acctId, folder);
      cache.adjustFolderCounts(uKey, acctId, folder, cache.removeMessages(uKey, acctId, folder, result.departed));
    }
    // Destinations don't self-heal until their own next poll, which is what
    // made a moved message look like it had simply disappeared for a couple of
    // minutes after running filters by hand.
    for (const target of result.targets || []) {
      sync.noteLocalWrite(uKey, acctId, target);
      try { await sync.syncFolderNow(uKey, accounts.currentAccount(), target); }
      catch (e) { log.warn(`Could not sync destination folder "${target}" after a filter run:`, e.message); }
    }
  }
  res.json(result);
}));

// ---------- notification scheduler: holiday calendar ----------
// Built-in Slovenian calendar (server/holidays.js, hardcoded — a full country selector
// is a bigger feature this doesn't attempt) merged with this login's own per-date
// work-free overrides for those AND their own custom holidays (recurring every year,
// month/day only — see holidays.js#resolveHolidaysForYear and store.js's
// getCustomHolidays/getHolidayOverrides). See server/schedule.js for how a schedule's
// skipHolidays option consumes the result.
app.get('/api/holidays', (req, res) => {
  const year = +(req.query.year) || new Date().getFullYear();
  const overrides = store.getHolidayOverrides();
  const list = holidays.resolveHolidaysForYear(year, store.getCustomHolidays()).map((h) => ({
    ...h,
    // A custom entry's own workFree field is authoritative — no separate override layer
    // for those (see holidays.js's doc comment on resolveHolidaysForYear).
    workFree: h.custom ? h.workFreeDefault : (overrides[h.date] ?? h.workFreeDefault),
  }));
  res.json(list);
});
app.patch('/api/holidays', (req, res) => res.json(store.saveHolidayOverrides(req.body || {})));

// Custom (user-added, non-Slovenian-specific) holidays — {month, day, name, workFree},
// no year: recurs every year automatically, same as the built-in entries.
app.post('/api/holidays/custom', (req, res) => {
  const { month, day, name, workFree } = req.body || {};
  const m = +month, d = +day;
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31) || !String(name || '').trim()) {
    return res.status(400).json({ error: 'A valid month, day and name are required' });
  }
  const list = store.getCustomHolidays();
  list.push({ id: crypto.randomUUID(), month: m, day: d, name: String(name).trim(), workFree: workFree !== false });
  res.json(store.saveCustomHolidays(list));
});
// Only workFree is ever patched today (the Scheduler UI's per-holiday checkbox — a
// custom entry's own field, not the separate holiday-overrides map the built-in
// Slovenian entries use, see holidays.js#resolveHolidaysForYear), but takes a generic
// patch object for the same reason server/accounts.js's updateAccountFields does.
app.patch('/api/holidays/custom/:id', (req, res) => {
  const list = store.getCustomHolidays();
  const h = list.find((x) => x.id === req.params.id);
  if (!h) return res.status(404).json({ error: 'Not found' });
  const allowed = ['month', 'day', 'name', 'workFree'];
  for (const k of allowed) if (k in (req.body || {})) h[k] = req.body[k];
  res.json(store.saveCustomHolidays(list));
});
app.delete('/api/holidays/custom/:id', (req, res) => {
  const list = store.getCustomHolidays().filter((h) => h.id !== req.params.id);
  res.json(store.saveCustomHolidays(list));
});

// ---------- folders ----------
// Cached the same way as messages: the background poller already fetches
// the full folder list (with total/unseen counts) every cycle to decide
// what's in sync scope, so reuse that instead of every folder-list open
// (sidebar render, unread-count refresh timers, account switches — all
// fairly frequent) paying for its own live IMAP LIST+STATUS call. That
// repeated live cost, especially competing with the sync poller for the
// same shared connection, was what made a heavily-loaded account feel slow
// to even open, separately from the message-list slowness fixed earlier.
app.get('/api/folders', wrap(async (req, res) => {
  // See /api/unified/:box's own comment on why this is needed — same class of
  // browser-side staleness risk, this endpoint's counts change just as often.
  res.set('Cache-Control', 'no-store');
  // `?live=1` bypasses the cache and asks the IMAP server directly — used by
  // the Settings › Folders picker's refresh button so a folder just exposed
  // over IMAP (e.g. Gmail's "Show in IMAP" for Sent/Drafts/Trash) shows up
  // immediately instead of waiting for the next background sync tick.
  const live = req.query.live === '1';
  const acc = accounts.currentAccount();
  // A grantee's own additional hidden folders (server/accountOverrides.js)
  // never touch the owner's cached `hidden` flag (that stays whatever the
  // owner's own hiddenFolders says — see cache.js#setFoldersHidden) — they're
  // unioned in here, per response, for whoever's actually asking. `userKey`
  // !== `viewerKey` means requireAuth swapped us into the owner's namespace
  // for this request, i.e. we're not the owner.
  const isOwner = currentUser().userKey === currentUser().viewerKey;
  const myHiddenSet = new Set(isOwner ? [] : (accountOverrides.getOverride(currentUser().viewerKey, acc.id)?.hiddenFolders || []));
  // Folders the scheduler has quiet right now don't feed the badge either,
  // unless this viewer's "Show muted" toggle is on — GET /api/unread applies
  // exactly the same rule (server/unread.js#muteContextFor), and countsUnread
  // exists precisely so the client's optimistic ±1 never disagrees with it.
  const viewerKey = currentUser().viewerKey;
  const muteCtx = (!store.getSettingsFor(viewerKey).showMuted && schedule.hasAnySchedule(acc))
    ? {
      now: new Date(),
      workFreeDateSet: schedule.workFreeDateSetFor(
        new Date().getFullYear(),
        store.getHolidayOverridesFor(viewerKey),
        store.getCustomHolidaysFor(viewerKey),
      ),
    }
    : null;
  // Hmelj's own machinery rather than a mailbox the reader keeps: the Snoozed
  // folder exists so a snoozed message really leaves the Inbox everywhere —
  // on the phone, in Outlook, in the provider's own webmail — but inside Hmelj
  // the 🕰️ Snoozed view is the better face of the same thing, because it also
  // says WHEN each message comes back. Showing both is two entries for one
  // idea, and the worse one is the folder.
  //
  // Deliberately NOT the `hidden` flag: that is the reader's own choice, saved
  // in the account, and a folder they never chose to hide should not start
  // appearing in their hidden list. This is a property of what the folder IS.
  const systemFolders = new Set([acc.snoozeFolder].filter(Boolean));
  const decorate = (list) => list.map((f) => {
    const hidden = f.hidden || myHiddenSet.has(f.path);
    const system = systemFolders.has(f.path);
    return {
      ...f,
      hiddenByOwner: f.hidden,
      hiddenByMe: myHiddenSet.has(f.path),
      hidden,
      system,
      // Does this folder's unread feed the account/All-inboxes badge? Decided
      // here, by the same predicate GET /api/unread sums over, so the client
      // can do optimistic ±1 badge math without keeping its own copy of the
      // rule — which is exactly how the badge and the unified list ended up
      // disagreeing about Drafts and Gmail labels (see server/scope.js).
      countsUnread: scope.isUnreadScope({ ...f, hidden }, acc)
        && !(muteCtx && schedule.isFolderMutedNow(acc, f.path, muteCtx)),
    };
  });
  if (config.cacheEnabled && !live) {
    const uKey = currentUser().userKey;
    if (cache.hasSyncedBefore(uKey, acc.id, 'INBOX')) {
      return res.json(decorate(cache.getFolders(uKey, acc.id)));
    }
  }
  const folders = await imap.listFolders();
  if (config.cacheEnabled) cache.upsertFolders(currentUser().userKey, acc.id, folders);
  res.json(decorate(folders));
}));
// The one authoritative unread number — per account and summed across all of
// them ("All inboxes"). Everything that displays a count now reads this
// instead of re-deriving its own: the sidebar, the tab title, the PWA app
// badge (navigator.setAppBadge) and the Android launcher badge. See
// server/unread.js for the four separate bugs the old client-side sum had,
// and server/scope.js for which folders count.
//
// Deliberately not account-scoped (no ?account=) — it always answers for
// every account this login can see, which is the whole point: the old code
// could only ever refresh the account you happened to be looking at.
app.get('/api/unread', wrap(async (req, res) => {
  // See /api/unified/:box's own comment on why this is needed — polled every couple
  // seconds by the client specifically because it changes constantly.
  res.set('Cache-Control', 'no-store');
  res.json({ ...unread.unreadForCurrentUser(), at: new Date().toISOString() });
}));
/**
 * Re-reads the folder tree from the server and writes it over the cached one.
 *
 * GET /api/folders answers from `cache.getFolders()` for any account that has
 * synced before, so a folder that only exists on the server is invisible until
 * the next background poll refreshes that table — which is how a freshly
 * created folder (including the Snoozed one, made on first use) could be real,
 * hold mail, and still not appear in the sidebar.
 *
 * A full re-list rather than inserting one row: `listFolders()` is what decides
 * a folder's parent, delimiter, special-use role and server counts, and
 * `upsertFolders()` also PRUNES paths the server no longer reports — which is
 * what makes this correct for a rename, where the old path has to disappear and
 * every path beneath it changes. Same two calls GET /api/folders?live=1 makes.
 *
 * Only ever called from a deliberate, rare folder mutation, so the extra
 * round-trip costs nothing that matters.
 */
async function refreshFolderCache() {
  if (!config.cacheEnabled) return;
  const uKey = currentUser().userKey;
  const acctId = currentUserAccountId();
  try {
    cache.upsertFolders(uKey, acctId, await imap.listFolders());
  } catch (e) {
    // The mutation itself already succeeded; a stale sidebar until the next
    // poll is worth far less than turning a completed create into an error.
    log.debug(`Could not refresh the folder cache for account ${acctId}: ${e.message}`);
  }
}

app.post('/api/folders', wrap(async (req, res) => {
  const result = await imap.createFolder(req.body.path);
  await refreshFolderCache(); // or it stays invisible in the sidebar until the next poll
  events.broadcastForAccount(currentUser().userKey, currentUserAccountId());
  res.json(result);
}));
app.delete('/api/folders/:path', wrap(async (req, res) => {
  const path = decodeURIComponent(req.params.path);
  const result = await imap.deleteFolder(path);
  // Otherwise the deleted folder lingers in the sidebar/settings as a ghost
  // entry (and its cached messages with it) until the next background sync.
  if (config.cacheEnabled) cache.removeFolder(currentUser().userKey, currentUserAccountId(), path);
  events.broadcastForAccount(currentUser().userKey, currentUserAccountId());
  res.json(result);
}));
app.post('/api/folders/:path/rename', wrap(async (req, res) => {
  const path = decodeURIComponent(req.params.path);
  const result = await imap.renameFolder(path, req.body.newPath);
  // The messages cached under the OLD path are keyed by it, so the rename
  // orphans them: refreshFolderCache() prunes the folder row, which would
  // otherwise leave rows nothing can ever reach or clean up. Dropping them
  // first means the renamed folder simply re-syncs, which it has to do anyway.
  if (config.cacheEnabled) cache.removeFolder(currentUser().userKey, currentUserAccountId(), path);
  await refreshFolderCache();
  events.broadcastForAccount(currentUser().userKey, currentUserAccountId());
  res.json(result);
}));
app.post('/api/folders/:path/empty', wrap(async (req, res) => {
  const path = decodeURIComponent(req.params.path);
  const result = await imap.emptyFolder(path);
  // Otherwise the emptied messages and stale total/unseen counts linger in
  // the message list and folder badges until the next background sync tick.
  if (config.cacheEnabled) {
    const uKey = currentUser().userKey;
    const acctId = currentUserAccountId();
    sync.noteLocalWrite(uKey, acctId, path);
    cache.clearFolder(uKey, acctId, path); // zeroes this folder's counts itself — nothing left to count
  }
  events.broadcastForAccount(currentUser().userKey, currentUserAccountId());
  res.json(result);
}));
app.post('/api/folders/:path/mark-read', wrap(async (req, res) => {
  const path = decodeURIComponent(req.params.path);
  const result = await imap.markAllRead(path);
  // Same reasoning as /empty above — without this the folder-list/account
  // unread badges and any already-cached rows for these uids stay stale
  // until the next background sync tick.
  if (config.cacheEnabled && result.uids?.length) {
    const uKey = currentUser().userKey;
    const acctId = currentUserAccountId();
    // Especially important here: this route zeroes the counter outright, so a
    // STATUS read a moment earlier landing on top of it would put the whole
    // "984 unread" back (see sync.js#noteLocalWrite).
    sync.noteLocalWrite(uKey, acctId, path);
    cache.applyFlags(uKey, acctId, path, result.uids, { add: ['\\Seen'] });
    // Zeroed outright rather than nudged by applyFlags' delta: markAllRead just
    // marked EVERY unseen message in the folder server-side, so the correct
    // count is 0. The delta only sees uids inside the cached window, which on a
    // big folder is a tiny slice — that mismatch is what left the badge stuck
    // at "984 unread" right after successfully marking 984 messages read.
    cache.clearFolderUnseen(uKey, acctId, path);
  }
  if (result.marked) events.broadcastForAccount(currentUser().userKey, currentUserAccountId());
  res.json(result);
}));

// "Mark all as read" for a folder is per-folder above; these two cover the
// account-name and "All inboxes" right-click entries — every folder that
// would actually count toward that account's (or, for the second one, every
// active account's) unread badge. That's exactly scope.js#isUnreadScope, the
// same predicate GET /api/unread sums over, so "mark all as read" can never
// clear a different set of folders than the badge was counting (it used to
// re-derive its own version of that rule here).
//
// Folders run in parallel (Promise.allSettled), not one-at-a-time — imapflow's
// own per-connection mailbox lock (see withMailbox in imapClient.js) already
// safely queues concurrent commands against the one shared connection, so
// this is safe, and meaningfully faster (overlaps round-trip latency instead
// of paying it serially per folder). Independent per folder too: one folder
// erroring out (a slow/broken subfolder) no longer aborts every other folder
// in the same account the way a single unguarded `await` in a loop used to —
// failedFolders/accountFailed below is what lets the client know exactly
// what to revert to unread rather than silently under-counting `marked`.
async function markAccountRead(uKey, account) {
  let folders;
  try {
    folders = await imap.listFolders();
  } catch (e) {
    log.warn(`mark-read: could not list folders for ${account.label}:`, e.message);
    return { marked: 0, failedFolders: [], accountFailed: true };
  }
  const hidden = new Set(account.hiddenFolders || []);
  const inScope = folders.filter((f) => !hidden.has(f.path) && scope.isUnreadScope(f, account));
  const results = await Promise.allSettled(inScope.map((f) => imap.markAllRead(f.path)));
  let marked = 0;
  const failedFolders = [];
  results.forEach((r, i) => {
    const path = inScope[i].path;
    if (r.status === 'rejected') {
      failedFolders.push(path);
      log.warn(`mark-read failed for ${account.label}/${path}:`, r.reason?.message || r.reason);
      return;
    }
    marked += r.value.marked;
    if (config.cacheEnabled && r.value.uids?.length) {
      sync.noteLocalWrite(uKey, account.id, path);
      cache.applyFlags(uKey, account.id, path, r.value.uids, { add: ['\\Seen'] });
      cache.clearFolderUnseen(uKey, account.id, path); // same reasoning as the per-folder route above
    }
  });
  // Covers both callers below (account-level and "All inboxes" mark-read)
  // with one line — uses the uKey already threaded through as an explicit
  // param (always the account's OWNER key — see both callers below), rather
  // than reaching for ambient currentUser(). Reaches every grantee too, not
  // just the owner's own open tabs.
  if (marked) events.broadcastForAccount(uKey, account.id);
  return { marked, failedFolders, accountFailed: false };
}
app.post('/api/account/mark-read', wrap(async (req, res) => {
  const account = accounts.currentAccount();
  const { marked, failedFolders, accountFailed } = await markAccountRead(currentUser().userKey, account);
  res.json({
    marked,
    failedFolders: failedFolders.map((folder) => ({ accountId: account.id, folder })),
    failedAccounts: accountFailed ? [account.id] : [],
  });
}));
app.post('/api/unified/mark-read', wrap(async (req, res) => {
  const activeAccounts = accounts.listAccounts().filter((a) => !a.disabled);
  // Parallel across accounts too — each uses its own connection-pool entry
  // (keyed by userKey:accountId, see imapClient.js), so unlike the per-folder
  // case above this isn't even sharing a connection to queue behind.
  const results = await Promise.allSettled(activeAccounts.map((account) => {
    // A shared account must run under its OWNER's identity, not the
    // viewer's own — imapClient.js's connection pool and every cache.js
    // table key off userKey, and the viewer's own accounts.json has no such
    // account to even resolve credentials from (see accounts.js#getAccount).
    // Without this, "All inboxes" mark-read silently skipped every shared
    // account (caught by the try/catch below as a swallowed "not found").
    const runUser = account.shared ? { id: account.ownerId, username: account.ownerUsername } : { id: currentUser().userId, username: currentUser().username };
    const uKey = userKey(runUser.username);
    return runAsAccount(runUser, account.id, () => markAccountRead(uKey, account));
  }));
  let marked = 0;
  const failedFolders = [];
  const failedAccounts = [];
  results.forEach((r, i) => {
    const account = activeAccounts[i];
    if (r.status === 'rejected') {
      log.warn(`mark-read failed for account ${account.label}:`, r.reason?.message || r.reason);
      failedAccounts.push(account.id);
      return;
    }
    marked += r.value.marked;
    for (const folder of r.value.failedFolders) failedFolders.push({ accountId: account.id, folder });
    if (r.value.accountFailed) failedAccounts.push(account.id);
  });
  res.json({ marked, failedFolders, failedAccounts });
}));

// ---------- analytics (see server/analytics.js) ----------
// All of these are per-account and read the analytics index, which is built
// only by an explicit scan the user starts — never implicitly, since a first
// scan of a large mailbox is minutes of mail-server traffic.

/** Everything the page's overview needs: index totals, per-folder rows, space
 * by year, the bulk-mail subtotal — plus live folder counts straight from the
 * server (STATUS via listFolders, no scan required), so per-folder message
 * counts are correct and current even before anything has been indexed. */
app.get('/api/analytics/summary', wrap(async (req, res) => {
  const acc = accounts.currentAccount();
  const uKey = currentUser().userKey;
  let folders = [];
  try {
    folders = (await imap.listFolders()).map((f) => ({ path: f.path, name: f.name, specialUse: f.specialUse, total: f.total, unseen: f.unseen }));
  } catch (e) {
    log.warn(`analytics: could not list folders for ${acc.label}:`, e.message);
  }
  res.json({
    accountId: acc.id,
    label: acc.label,
    // Graph has no per-message size at all (see graphClient.js#scanMessages) —
    // the UI hides every size-derived panel for such an account rather than
    // charting zeros.
    sizesAvailable: acc.type !== 'graph',
    // Which folders a scan would walk, so the page can say "All Mail" out loud
    // on Gmail instead of leaving the scope a mystery.
    scanScope: analytics.scanScope(acc, folders).map((f) => f.path),
    liveFolders: folders,
    scan: analytics.scanProgress(acc.id),
    ...analytics.summary(uKey, acc.id),
  });
}));

app.post('/api/analytics/scan', wrap(async (req, res) => {
  const acc = accounts.currentAccount();
  const uKey = currentUser().userKey;
  const full = !!req.body?.full;
  if (analytics.scanProgress(acc.id).running) return res.status(409).json({ error: 'A scan is already running for this account' });
  // Answers immediately and keeps scanning in the background — a first scan of
  // a 100k-message mailbox is minutes long, far past any browser or proxy
  // timeout. Progress comes from /api/analytics/scan-status.
  res.json({ started: true });
  // Bound synchronously, before any await, so it captures this request's user
  // (including requireAuth's shared-account ownership swap) while that context
  // is still current — the scan itself then runs long after the response.
  runWithAccount(acc.id, () => analytics.scanAccount(uKey, acc, { full }), { purpose: 'sync' })
    // Announced over SSE rather than in this response, because the scan
    // outlives the request by minutes — and outlives the page that started it,
    // which is exactly the case this has to work for.
    .then((r) => events.broadcastAnalytics(uKey, acc.id, { done: true, scanned: r?.scanned || 0, cancelled: !!r?.cancelled }))
    .catch((e) => {
      log.warn(`analytics scan failed for ${acc.label}:`, e.message);
      events.broadcastAnalytics(uKey, acc.id, { done: true, error: e.message });
    });
}));

app.get('/api/analytics/scan-status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(analytics.scanProgress(accounts.currentAccount().id));
});

app.post('/api/analytics/scan-cancel', (req, res) => {
  res.json({ cancelling: analytics.cancelScan(accounts.currentAccount().id) });
});

// `sort`/`dir` are validated against a per-table whitelist inside
// analytics.js (see SENDER_SORTS/MESSAGE_SORTS) — nothing from the query
// string reaches the ORDER BY.
app.get('/api/analytics/senders', (req, res) => {
  const acc = accounts.currentAccount();
  res.json(analytics.topSenders(currentUser().userKey, acc.id, {
    sort: req.query.sort, dir: req.query.dir,
    limit: Math.min(500, Number(req.query.limit) || 100),
    offset: Math.max(0, Number(req.query.offset) || 0),
  }));
});

app.get('/api/analytics/largest', (req, res) => {
  const acc = accounts.currentAccount();
  res.json(analytics.largest(currentUser().userKey, acc.id, {
    sort: req.query.sort, dir: req.query.dir,
    limit: Math.min(1000, Number(req.query.limit) || 200),
    offset: Math.max(0, Number(req.query.offset) || 0),
  }));
});

/** The "+must include / -must not include" search. POST because the filter is
 * a structured object, not because it changes anything. */
app.post('/api/analytics/query', (req, res) => {
  const acc = accounts.currentAccount();
  const { filter = {}, limit, offset, sort, dir } = req.body || {};
  res.json(analytics.query(currentUser().userKey, acc.id, filter, {
    limit: Math.min(2000, Number(limit) || 500), offset: Number(offset) || 0, sort, dir,
  }));
});

/**
 * Mass delete. Two-step by contract: call it with dryRun first, show the user
 * the count and size that came back, and only then call it for real. The
 * filter path re-resolves the match set server-side (see
 * analytics.js#deleteMatching) so what gets deleted is what the reviewed query
 * matches, not a list a stale page happened to be holding.
 */
app.post('/api/analytics/delete', wrap(async (req, res) => {
  const acc = accounts.currentAccount();
  const uKey = currentUser().userKey;
  const { filter, selection, dryRun } = req.body || {};
  const result = await analytics.deleteMatching(uKey, acc, { filter, selection, dryRun: !!dryRun });
  if (!dryRun) events.broadcastForAccount(uKey, acc.id);
  res.json(result);
}));

app.post('/api/analytics/clear', (req, res) => {
  analytics.clear(currentUser().userKey, accounts.currentAccount().id);
  res.json({ ok: true });
});

// On-demand full reconciliation of one folder — the list pane's refresh
// button uses this. The regular background poller only checks "anything
// newer?" most ticks (see sync.js#pollFolder), so flag changes made on
// another mail client sit invisible in the cache until the next scheduled
// full pass (up to ~20 minutes by default); this forces that pass right now.
app.post('/api/folders/:path/sync-now', wrap(async (req, res) => {
  if (!config.cacheEnabled) return res.json({ ok: true }); // nothing to reconcile — every read already goes live to IMAP
  const path = decodeURIComponent(req.params.path);
  const acc = accounts.currentAccount();
  const uKey = currentUser().userKey;
  await runWithAccount(acc.id, () => sync.syncFolderNow(uKey, acc, path), { purpose: 'sync' });
  res.json({ ok: true });
}));
// Same, but every in-scope folder for the account (INBOX, its subfolders,
// and Sent) — the unified "All inbox" view's refresh uses this so a
// server-side rule filing new mail straight into a custom subfolder gets
// picked up immediately too, not just literal INBOX.
app.post('/api/sync-now', wrap(async (req, res) => {
  if (!config.cacheEnabled) return res.json({ ok: true });
  const acc = accounts.currentAccount();
  const uKey = currentUser().userKey;
  await runWithAccount(acc.id, () => sync.syncAccountNow(uKey, acc), { purpose: 'sync' });
  res.json({ ok: true });
}));

// Inline search-box autocomplete (see cache.js#suggestWord) — a local
// SQLite prefix lookup against words seen across all synced mail, not a
// live IMAP search, so it's safe to call on every keystroke (client-side
// debounced regardless — see app.js). No local index without the cache, so
// this degrades to "no suggestions" rather than erroring when it's off.
app.get('/api/search-suggest', (req, res) => {
  // The index changes over time (new mail, the one-time backfill on
  // deploy) — Express's default weak-ETag/conditional-GET handling would
  // otherwise let the browser go on trusting a "no match" answer for the
  // same prefix long after the index actually gained one.
  res.set('Cache-Control', 'no-store');
  const q = (req.query.q || '').trim().toLowerCase();
  if (!config.cacheEnabled || q.length < 2) return res.json({ completion: null });
  res.json({ completion: cache.suggestWord(currentUser().viewerKey, q) });
});

// ---------- messages ----------
// For INBOX/Sent (the folders the background poller keeps warm — see
// sync.js#isInScope), reads from the SQLite cache instead of live IMAP once
// that folder has synced at least once: an instant SQL read instead of
// repeating the multi-second candidate/date-sort pass on every open. Any
// other folder (Drafts, Trash, custom labels, or before the first sync
// completes) still goes straight to IMAP, exactly as before caching existed.
app.get('/api/messages/:folder', wrap(async (req, res) => {
  // See /api/unified/:box's own comment on why this is needed — same class of
  // browser-side staleness risk, this endpoint's contents change just as often.
  res.set('Cache-Control', 'no-store');
  const folder = decodeURIComponent(req.params.folder);
  const settings = store.getSettings();
  const page = parseInt(req.query.page || '1', 10);
  const pageSize = parseInt(req.query.pageSize || String(settings.messagesPerPage), 10);
  // See /api/unified/:box above — the flag predicate is split off before anything
  // else looks at the query text.
  const { starred: starredSearch, rest: q } = extractStarredTerm(req.query.q || '');
  const unreadOnly = req.query.unread === '1';
  // Toolbar's ★ filter (public/js/app.js's #btn-starred-only). Unlike every other
  // filter on this route it also WIDENS the scope: "starred in Work" means the whole
  // Work tree, not just its top level, so INBOX answers for its subfolders too. Only
  // the cache can do that — a live listing is one mailbox at a time — which is why
  // the cache branch below never falls through to IMAP while it's on.
  const flaggedOnly = req.query.flagged === '1';

  // `is:starred` from a single account's folder view keeps that view's scope — this
  // folder and everything under it, the same subtree the ★ button covers — but sweeps
  // it live, so it finds stars on mail older than the cache window. No runAsAccount
  // wrapper: requireAuth already put this request in the right identity, including the
  // owner-key swap for a shared account, which re-wrapping would undo.
  if (starredSearch) {
    const acc = accounts.currentAccount();
    const all = cache.getFolders(currentUser().userKey, acc.id);
    const delimiter = all.find((f) => f.path === folder)?.delimiter || '/';
    // At the account's INBOX you are at the top of that account, so `is:starred` covers
    // the WHOLE account rather than just the INBOX tree. On plenty of servers the
    // folders holding old starred mail are SIBLINGS of INBOX rather than children of
    // it (and on Gmail the only complete answer is the \Flagged virtual folder, which
    // is nowhere near INBOX), so sweeping the tree alone would miss precisely the mail
    // this search exists to find. Inside a specific subfolder it stays scoped to that
    // subtree, matching the ★ button.
    const atAccountRoot = folder.toUpperCase() === 'INBOX';
    const subtree = atAccountRoot ? all : all.filter((f) => f.path === folder || f.path.startsWith(folder + delimiter));
    // No cached folder tree to expand (never synced) — search the one folder asked for
    // rather than nothing at all.
    const folders = subtree.length ? starredFolderPaths(subtree, acc) : [folder];
    const starredResult = await sweepLive([{ account: acc, run: (fn) => fn(), folders }], { page, pageSize, q, unreadOnly, flaggedOnly: true, label: 'is:starred' });
    return res.json({ total: starredResult.total, page, pageSize, messages: shortenSubjects(starredResult.messages, acc.id), scope: 'starred' });
  }

  // "Search everywhere" (the list's own footer link — see app.js#searchScopeRow).
  // The ordinary search reads the cache, which is this folder's newest
  // syncBackfillLimit messages and their subject/from/to only. This is the
  // explicit escalation: every folder of the account (All Mail where the
  // provider has one), asked live, matching header AND body. Costs a SELECT +
  // SEARCH per folder, which is why it is a link you click and not the default.
  if (q && req.query.scope === 'account') {
    const acc = accounts.currentAccount();
    const folders = await starredFoldersFor(acc, currentUser().userKey, (fn) => fn(), searchFolderPaths);
    const swept = await sweepLive([{ account: acc, run: (fn) => fn(), folders }],
      { page, pageSize, q, unreadOnly, fullText: true, label: 'search-everywhere' });
    return res.json({ total: swept.total, page, pageSize, messages: shortenSubjects(swept.messages, acc.id), scope: 'account', foldersSwept: folders.length });
  }

  // See /api/unified/:box above: only an explicit body:/-body: term needs a live
  // fetch — everything else (subject/from/to, including the new +/-/"phrase"/field:
  // syntax) is servable from the cache once this folder has synced at least once.
  // On an account with a full-text index the body is servable from here too, so
  // that term stops being the thing that forces a live search.
  const searchAcc = accounts.currentAccount();
  const needsLive = q ? !cache.bodySearchServable(q, [searchAcc]) : false;
  const indexAnswered = !needsLive && !!q && queryNeedsBodySearch(q);
  if (config.cacheEnabled && !needsLive) {
    const acc = searchAcc;
    const uKey = currentUser().userKey;
    if (cache.hasSyncedBefore(uKey, acc.id, folder)) {
      // One lookup, two uses: the account's real hierarchy separator (for the
      // starred view's subtree read) and this folder's server STATUS unread count
      // (for the completeness check further down).
      const folderRow = cache.getFolders(uKey, acc.id).find((f) => f.path === folder);
      const cached = cache.queryFolder(uKey, acc.id, folder, {
        page, pageSize, q, unreadOnly, flaggedOnly,
        subtreeDelimiter: flaggedOnly ? (folderRow?.delimiter || '/') : null,
        showDeleted: settings.showDeleted,
        // Two different sets, on purpose. The LISTING reads this folder plus
        // Sent, so a row can be drawn from the reply you sent; only threads
        // with a message in THIS folder are listed (cache.js#pageThreads).
        // The COUNT is over the whole conversation, so the number on a row is
        // the number of messages that open from it — wherever they are filed.
        threaded: conversationsOn({ q, unreadOnly, flaggedOnly }),
        threadFolders: listScopeFolders(acc, uKey, folder),
        convoFolders: threadScopeFolders(acc, uKey, folder),
        indexed: !!acc.searchIndex,
      });
      // The cache only ever holds this folder's newest syncBackfillLimit messages (see
      // store.js — 250 by default), not full history. A real search that comes up
      // completely empty here might just be older mail the cache never kept, not a
      // genuine "no such message" — fall through to a live fetch instead of silently
      // reporting nothing found for something that actually exists further back.
      const searchCameUpEmpty = q && cached.total === 0;
      // The same reasoning, for "unread only" — and here it bites even when the
      // cache DOES return rows. The unread badge is the folder's server STATUS
      // count, covering the whole mailbox; the cache holds a window of it. So a
      // folder with unread mail older than that window shows a badge the list
      // cannot account for, and filtering to unread inside the cache reports
      // fewer (or none), which reads as the badge being broken. Observed: 1000
      // unread by STATUS, 16 of them cached, "unread only" answering with 0
      // after those 16 were read. Go live whenever the server says there is
      // more unread here than the cache can see.
      const statusUnseen = folderRow?.unseen;
      const unreadIncomplete = unreadOnly && statusUnseen != null && statusUnseen > cached.total;
      // Neither fallback applies to the starred view: going live would silently drop
      // the subfolders it just searched, answering a narrower question than the one
      // asked. Better to report only what the cache holds (this folder tree's newest
      // syncBackfillLimit messages per folder) than to change the scope underfoot.
      if (flaggedOnly || (!searchCameUpEmpty && !unreadIncomplete)) {
        return res.json({ ...cached, messages: shortenSubjects(cached.messages, acc.id), scope: indexAnswered ? 'index' : 'cache' });
      }
    }
  }

  const result = await imap.listMessages(folder, { page, pageSize, query: q, unreadOnly, flaggedOnly });
  res.json({ ...result, messages: shortenSubjects(result.messages, accounts.currentAccount().id), scope: 'folder' });
}));

/**
 * CSS gets the same external-resource policy as <img> tags: remote url(...)
 * loads are allowed only per the user's image settings, @import and legacy
 * scriptable constructs are stripped. This closes the "tracking pixel as a
 * CSS background" bypass while keeping newsletter styling intact.
 */
function sanitizeCssText(css, allowRemote, onBlocked) {
  let out = String(css)
    .replace(/@import[^;]*(;|$)/gi, '')
    .replace(/expression\s*\(/gi, 'blocked(')
    .replace(/-moz-binding\s*:[^;]*(;|$)/gi, '')
    .replace(/behavior\s*:[^;]*(;|$)/gi, '');
  out = out.replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (m, _q, target) => {
    const t = target.replace(/&quot;|&#39;|&amp;/g, '').trim();
    if (/^data:image\//i.test(t)) return m;           // embedded images are fine
    if (/^cid:/i.test(t)) return m;                    // inert in CSS, harmless
    if (/^https?:/i.test(t)) {
      let host = '';
      try { host = new URL(t).hostname; } catch { /* unparsable → block */ }
      if (allowRemote === true || (Array.isArray(allowRemote) && allowRemote.some((d) => host === d || host.endsWith('.' + d)))) {
        return m;
      }
      onBlocked();
      return 'none';
    }
    return 'none'; // javascript:, relative, anything odd → drop
  });
  return out;
}

/**
 * Applies the same host-trust check as a plain <img src> to each URL in a
 * srcset (responsive images — "url descriptor, url descriptor, …"): common
 * in marketing/newsletter templates (AliExpress's among them), and easy to
 * miss because a blocked srcset doesn't show the "N external images
 * blocked" banner-triggering path the same way an outright-dropped <img>
 * does — the browser just silently has nothing loadable to pick from.
 * Untrusted entries are dropped individually rather than nuking the whole
 * attribute, so a mixed trusted/untrusted srcset still renders whatever it
 * can.
 */
function sanitizeSrcset(srcset, allowRemote, onBlocked) {
  const kept = [];
  for (const entry of String(srcset).split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [url, descriptor] = trimmed.split(/\s+/, 2);
    let host = '';
    try { host = new URL(url).hostname; } catch { continue; } // unparsable → drop this entry
    if (allowRemote === true || (Array.isArray(allowRemote) && allowRemote.some((d) => host === d || host.endsWith('.' + d)))) {
      kept.push(descriptor ? `${url} ${descriptor}` : url);
    } else {
      onBlocked();
    }
  }
  return kept.join(', ');
}

// Pulls out ONLY the sizing declarations (width/height/max-width/max-height)
// from an <img>'s original inline style, for carrying onto a blocked-image
// placeholder — see its call site's own comment for why the size needs to
// survive. Deliberately NOT the whole style string: an inline style always
// beats a non-!important stylesheet rule, so keeping the original's other
// declarations too (border:0 is extremely common on <img> specifically, to
// strip the browser's default image border) silently cancelled the
// placeholder's own dashed-border/padding/color styling — the earlier
// attempt at this fix produced blank, borderless gray boxes instead of a
// visible placeholder.
const SIZE_STYLE_PROPS = new Set(['width', 'height', 'max-width', 'max-height']);
function extractSizeStyle(style) {
  if (!style) return '';
  const kept = [];
  for (const decl of String(style).split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (SIZE_STYLE_PROPS.has(prop) && value) kept.push(`${prop}:${value}`);
  }
  return kept.join(';');
}

function sanitizeMessageHtml(html, { allowRemote, folder, uid }) {
  let blockedRemote = 0;
  const onBlocked = () => { blockedRemote++; };
  let clean = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'style', 'center', 'font', 'u']),
    // We deliberately keep <style> for HTML e-mail fidelity and account for the
    // risk ourselves: sanitizeCssText() below strips imports/expressions and
    // applies the external-image policy to every url(...) in stylesheets and
    // inline style attributes.
    allowVulnerableTags: true,
    allowedAttributes: {
      '*': ['style', 'class', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'dir', 'background'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'style', 'srcset'],
      font: ['face', 'size', 'color'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data'],
    // A disallowed tag normally has its TEXT kept and only the tag itself
    // dropped — right for <div>/<span>, wrong for <title>. Nearly every HTML
    // mail carries <head><title>Your order is on the way</title></head>, and
    // without this that line was re-emitted as a bare text node at the very
    // top of the body: a stray sentence floating above the design, in the
    // page's default font, looking like part of the message. Same for the
    // <xml><o:OfficeDocumentSettings> block Outlook-generated mail sometimes
    // carries outside its conditional comment.
    // NOTE: supplying this REPLACES sanitize-html's default list, so the
    // defaults are repeated here. <style> among them is inert while it stays
    // in allowedTags above (this branch only ever runs for disallowed tags) —
    // kept so removing it from allowedTags can't silently dump a stylesheet
    // into the body as text.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'xmp', 'title', 'xml'],
    transformTags: {
      // The legacy HTML `background="..."` attribute (still used by some
      // table-based email templates for a cell/table background image —
      // AliExpress's promotional emails, confirmed from a real sample: a
      // whole product-grid cell's image delivered this way, not as an
      // <img> at all) — a completely separate mechanism from both <img src>
      // (its own transform below) and the CSS background-image property
      // (already policed by sanitizeCssText() on every style="..." and
      // <style> block, below). Without this, sanitize-html had nothing
      // telling it to keep `background` at all — it was silently dropped
      // with no fallback, leaving just the cell's own bgcolor (a neutral
      // rgba(0,0,0,.2) in the sample) showing, easy to mistake for "no
      // image loaded" rather than "the image was never even considered."
      // `'*'` here only ever runs for tags with no MORE specific transform
      // of their own (a and img keep their existing ones below, untouched).
      '*': (tag, attribs) => {
        const bg = attribs.background;
        if (!bg || !/^https?:/i.test(bg)) return { tagName: tag, attribs };
        let host = '';
        try { host = new URL(bg).hostname; } catch { /* ignore */ }
        if (allowRemote === true || (Array.isArray(allowRemote) && allowRemote.some((d) => host === d || host.endsWith('.' + d)))) {
          return { tagName: tag, attribs };
        }
        blockedRemote++;
        const { background, ...rest } = attribs; // the element's own bgcolor/style (if any) stays as a reasonable placeholder look — same spirit as the <img> blocked-image placeholder
        return { tagName: tag, attribs: { ...rest, 'data-blocked-src': bg } };
      },
      a: (tag, attribs) => ({ tagName: 'a', attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }),
      img: (tag, attribs) => {
        const src = attribs.src || '';
        if (src.startsWith('cid:')) {
          const cid = src.slice(4).replace(/[<>]/g, '');
          const acct = encodeURIComponent(currentUserAccountId());
          const out = { ...attribs, src: `/api/message/${encodeURIComponent(folder)}/${encodeURIComponent(uid)}/cid/${encodeURIComponent(cid)}?account=${acct}` };
          delete out.srcset; // its entries are original remote/cid refs we haven't rewritten — drop rather than serve a broken one
          return { tagName: 'img', attribs: out };
        }
        if (/^https?:/i.test(src)) {
          let host = '';
          try { host = new URL(src).hostname; } catch { /* ignore */ }
          if (allowRemote === true || (Array.isArray(allowRemote) && allowRemote.some((d) => host === d || host.endsWith('.' + d)))) {
            const out = { ...attribs };
            if (out.srcset) out.srcset = sanitizeSrcset(out.srcset, allowRemote, onBlocked);
            return { tagName: 'img', attribs: out };
          }
          blockedRemote++;
          // Carry the original width/height/style over onto the placeholder
          // — some templates (AliExpress's promotional emails, confirmed
          // from real samples) use images as actual structural layout
          // anchors, not just decoration: a whole row of product-grid table
          // cells sized only by their <img width="192" height="108">, or a
          // nav icon whose width is deliberately "auto" (style="height:
          // 50px;width:auto") relying on the image's own aspect ratio.
          // Dropping every sizing hint (as this used to) left the
          // surrounding table with nothing to size those cells by at all —
          // collapsing/reflowing the whole layout unpredictably instead of
          // just showing an appropriately-sized placeholder box, same as
          // real email clients (Gmail included) do for a blocked image.
          const preserved = {};
          if (attribs.width) preserved.width = attribs.width;
          if (attribs.height) preserved.height = attribs.height;
          const sizeStyle = extractSizeStyle(attribs.style);
          if (sizeStyle) preserved.style = sizeStyle;
          return { tagName: 'img', attribs: { ...preserved, alt: attribs.alt || '[blocked image]', 'data-blocked-src': src, class: 'blocked-image' } };
        }
        const out = { ...attribs };
        delete out.srcset; // src has no http(s) scheme to anchor trust on — don't trust an unrelated srcset either
        return { tagName: 'img', attribs: out };
      },
    },
  });

  // <style> blocks
  clean = clean.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (m, open, css, close) => open + sanitizeCssText(css, allowRemote, onBlocked) + close);
  // inline style="..." attributes (sanitize-html serializes them double-quoted)
  clean = clean.replace(/style="([^"]*)"/gi,
    (m, css) => 'style="' + sanitizeCssText(css, allowRemote, onBlocked) + '"');

  return { clean, blockedRemote };
}

app.get('/api/message/:folder/:uid', wrap(async (req, res) => {
  const folder = decodeURIComponent(req.params.folder);
  const uid = decodeURIComponent(req.params.uid); // opaque per-account-type id — an IMAP integer UID or (e.g.) an Exchange ItemId, not necessarily numeric
  const settings = store.getSettings();
  let msg;
  try {
    msg = await contentCache.getMessage(currentUser().userKey, currentUserAccountId(), folder, uid);
  } catch (e) {
    // The message is not there any more: moved, deleted, or consumed by
    // answering it (a meeting invitation). Ordinary, not exceptional — the
    // cached row is simply stale, so drop it and say so in a sentence a person
    // can act on. Without this the reader got the protocol's own words:
    // "Exchange GetItem failed: ErrorItemNotFound — The specified object was
    // not found in the store."
    if (!e?.notFound) throw e;
    if (config.cacheEnabled) {
      const uKey = currentUser().userKey, acctId = currentUserAccountId();
      cache.removeMessageContent(uKey, acctId, folder, uid);
      cache.adjustFolderCounts(uKey, acctId, folder, cache.removeMessages(uKey, acctId, folder, [uid]));
    }
    events.broadcastForAccount(currentUser().userKey, currentUserAccountId());
    return res.status(410).json({ error: 'This message is no longer on the server — it was moved, deleted, or already answered.', gone: true });
  }

  let allowRemote;
  const senderDomain = msg.from?.[0]?.address?.split('@')[1] || '';
  if (req.query.allowImages === '1' || settings.externalImages === 'always') allowRemote = true;
  else if (settings.externalImages === 'never') allowRemote = false;
  else {
    // 'trusted' and 'ask' modes: a trusted entry can be a SENDER domain
    // ("Always trust garmin.com" → all images in mail from garmin.com load,
    // wherever they're hosted — newsletters use CDNs) or an image-host domain
    // (matched per image below).
    const trusted = settings.trustedDomains || [];
    const senderTrusted = senderDomain &&
      trusted.some((d) => senderDomain === d || senderDomain.endsWith('.' + d));
    allowRemote = senderTrusted ? true : trusted;
  }

  let html = null, blockedRemote = 0;
  if (msg.html) {
    const r = sanitizeMessageHtml(msg.html, { allowRemote, folder, uid });
    html = r.clean; blockedRemote = r.blockedRemote;
    // Mark the quoted half of a reply, so the reading pane can show what was
    // written this time and keep the rest behind its ⋯ button. Done here rather
    // than in the message frame — see the header of server/quoteCollapse.js for
    // why that moved. Never fatal: a message that can't be analysed is served
    // exactly as it was.
    try {
      const q = collapseQuotedHtml(html);
      if (q.collapsed) html = q.html;
    } catch (e) {
      htmlLog.warn(`${folder}/${uid}: quote collapse failed:`, e.message);
    }
    // No List-Unsubscribe header? Look for the link in the footer instead —
    // plenty of real newsletters publish no header at all and put the only way
    // out at the bottom of the message (see server/unsubscribe.js). A guess, so
    // it is only ever OPENED, never posted to or mailed, and the banner says
    // where it came from.
    if (!msg.headers?.listUnsubscribe && settings.unsubscribeButton !== false) {
      try {
        const guess = pickUnsubscribeAnchor(anchorsIn(html));
        // Mutating the message read out of the content cache is safe: every
        // read parses its own object out of SQLite, so this is a copy.
        if (guess) msg.headers = { ...msg.headers, listUnsubscribe: guess };
      } catch (e) {
        htmlLog.debug(`${folder}/${uid}: unsubscribe-link scan failed: ${e.message}`);
      }
    }
    // Diagnostic, not a policy: an <img> that isn't our own "blocked by
    // external-image policy" placeholder (that case is already covered by
    // blockedRemote above) but still has no usable src after sanitizing
    // didn't lose it to Hmelj's trust check — it never had a plain src to
    // begin with. The most common real cause is a marketing-template <img>
    // that relies on JS-driven lazy-loading (a data-src/data-original
    // attribute swapped in on scroll), which a sandboxed, static message
    // view can't run. Nothing to act on automatically here; logged so a
    // "images still don't show even with the policy set to always load"
    // report can be confirmed instead of guessed at.
    const emptyImgs = (html.match(/<img(?![^>]*\bclass="blocked-image")(?![^>]*\ssrc=)[^>]*>/gi) || []).length;
    if (emptyImgs) htmlLog.warn(`${folder}/${uid}: ${emptyImgs} <img> tag(s) with no usable src survived sanitizing (not policy-blocked — likely JS/data-src lazy-loading)`);
  }
  // Already unsubscribed from this sender? The reading pane says so instead of
  // offering the button as though nothing had happened — which is exactly what
  // it did: press Unsubscribe, open another message, come back, and the same
  // button was sitting there with no record of anything.
  const unsubscribed = store.getUnsubscribes()[senderKeyOf(msg)] || null;
  res.json({ ...msg, html, blockedRemote, senderDomain, unsubscribed });
}));

/** The address that identifies "this newsletter" — see store.getUnsubscribes. */
function senderKeyOf(msg) {
  const from = msg?.from?.[0];
  const address = typeof from === 'string' ? from : from?.address;
  return String(address || '').trim().toLowerCase();
}

/**
 * Every message of one conversation, oldest first — the stacked reading pane
 * (app.js#openThread). Envelopes only, straight from the cache: each message's
 * body is fetched on expand through the ordinary message route, which is
 * already content-cached, so a long thread costs one request here and one per
 * message the user actually opens.
 *
 * `:threadId` is exactly the opaque key the listing handed out (a root
 * Message-ID, a provider conversation id, or the synthetic per-message key a
 * lone message gets) — never parsed here, only matched.
 */
app.get('/api/thread/:threadId', wrap(async (req, res) => {
  const threadId = decodeURIComponent(req.params.threadId);
  const folder = decodeURIComponent(req.query.folder || '');
  if (!folder) return res.status(400).json({ error: 'folder is required' });
  if (!config.cacheEnabled) return res.json({ messages: [] });
  const acc = accounts.currentAccount();
  const uKey = currentUser().userKey;
  const messages = cache.getThread(uKey, acc.id, threadId, threadScopeFolders(acc, uKey, folder));
  res.json({ messages });
}));

/**
 * Unsubscribe from the newsletter a message came from (RFC 2369 / RFC 8058).
 *
 * Three shapes, and which one applies is decided HERE, from the message's own
 * headers — never from the request body. A client that could name the
 * destination could make this server POST anywhere, or send mail to anyone:
 *
 *   post — the sender published `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
 *          so an https POST is the whole transaction. Done here because a
 *          browser cannot POST cross-origin without the sender's permission.
 *   mail — a `mailto:` target: an unsubscribe mail sent from this account.
 *   open — an ordinary link, which the BROWSER opens (see app.js); this route
 *          never fetches it, since it is a page for a person to finish.
 *
 * Never automatic: only ever reached by pressing the button (see the banner in
 * app.js#buildMessageCard, and server/unsubscribe.js on why that matters).
 */
app.post('/api/message/:folder/:uid/unsubscribe', wrap(async (req, res) => {
  const folder = decodeURIComponent(req.params.folder);
  const uid = decodeURIComponent(req.params.uid);
  const acc = accounts.currentAccount();
  const msg = await contentCache.getMessage(currentUser().userKey, acc.id, folder, uid);
  // Same fallback the reading pane was given, recomputed rather than trusted
  // from the request — a body link is method 'open', which the browser handles
  // itself, so this is only reached if something asks anyway.
  const info = msg.headers?.listUnsubscribe
    || (msg.html ? pickUnsubscribeAnchor(anchorsIn(msg.html)) : null);
  if (!info) return res.status(400).json({ error: 'This message offers no way to unsubscribe' });

  const sender = senderKeyOf(msg);
  // Written down under the SENDER, so every message from this newsletter says
  // so afterwards — not just the one the button was on. `extra` carries what
  // actually happened (the HTTP status, the address the mail went from), which
  // is what "it said it sent something, no idea what" was missing.
  const done = (method, detail, extra = {}) => {
    userLog.record(currentUser().viewerKey, {
      level: 'info', category: 'send', message: `Unsubscribed from ${detail}`,
      detail: msg.subject || null, accountId: acc.id, accountLabel: acc.label,
    });
    const entry = { at: Date.now(), method, target: detail, sender, ...extra };
    if (sender) store.saveUnsubscribes({ ...store.getUnsubscribes(), [sender]: entry });
    res.json({ ok: true, ...entry });
  };

  if (info.method === 'post') {
    // Re-checked rather than trusted from the parse: this is the one outbound
    // request in the app whose address comes out of a message.
    if (!isSafePostTarget(info.http)) return res.status(400).json({ error: 'Unsubscribe address refused' });
    const r = await fetch(info.http, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: ONE_CLICK_BODY,
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    // A 2xx is the sender saying it is done. Anything else is reported as-is
    // rather than dressed up: "unsubscribed" when nothing happened is worse
    // than an error, because nobody checks twice.
    if (!r.ok) return res.status(502).json({ error: `The sender's server answered ${r.status}` });
    return done('post', new URL(info.http).hostname, { status: r.status, url: info.http });
  }

  if (info.method === 'mail') {
    const parts = parseMailto(info.mailto);
    if (!parts) return res.status(400).json({ error: 'Unsubscribe address refused' });
    const identity = store.getIdentities().find((i) => i.accountId === acc.id) || null;
    await sendMail({
      identityId: identity?.id,
      to: parts.to,
      subject: parts.subject,
      text: parts.body,
    });
    return done('mail', parts.to, { from: identity?.email || acc.email || '', subject: parts.subject });
  }

  // 'open' — the client opens the link itself, synchronously in the click, so
  // no pop-up blocker eats it. Recorded all the same: it is the only kind whose
  // outcome nobody here can know, and saying "you opened this on the 27th" is
  // still better than offering the button as though nothing had happened.
  return done('open', info.http, { url: info.http, source: info.source || 'header' });
}));

/**
 * Answer a meeting invitation — accept, tentatively accept, or decline, with an
 * optional message to the organizer.
 *
 * The verb is the whole request; WHICH meeting is read off the message itself,
 * never taken from the caller, exactly like the unsubscribe and receipt routes
 * above. Exchange and Graph each perform the entire operation server-side (the
 * calendar entry and the reply to the organizer, together), which is what makes
 * this possible with no calendar of our own — full calendaring is a separate,
 * later thing.
 *
 * An IMAP account has no such server-side operation: answering there means
 * composing an iTIP METHOD:REPLY message by hand. Not built yet, and this says
 * so plainly rather than appearing to work.
 */
app.post('/api/message/:folder/:uid/invitation', wrap(async (req, res) => {
  const folder = decodeURIComponent(req.params.folder);
  const uid = decodeURIComponent(req.params.uid);
  const { action, comment = '', sendResponse = true } = req.body || {};
  if (!['accept', 'tentative', 'decline'].includes(action)) {
    return res.status(400).json({ error: 'Unknown response' });
  }
  const acc = accounts.currentAccount();
  const uKey = currentUser().userKey;
  const msg = await contentCache.getMessage(uKey, acc.id, folder, uid);
  // Re-read from the message rather than trusted from the request: the same
  // reasoning as the unsubscribe route, and it is also what stops an accept
  // being sent for something that is not an invitation at all.
  if (!isActionable(msg.invitation)) {
    return res.status(400).json({ error: 'This message is not a meeting invitation that can be answered' });
  }
  const result = await imap.respondToMeeting(folder, uid, { action, comment: String(comment || '').slice(0, 4000), sendResponse: sendResponse !== false });

  userLog.record(currentUser().viewerKey, {
    level: 'info', category: 'send',
    message: `Meeting ${action}: ${msg.invitation.summary || msg.subject || ''}`.trim(),
    detail: msg.invitation.organizer?.address || null, accountId: acc.id, accountLabel: acc.label,
  });
  // Answering an invitation usually CONSUMES it — both Exchange and Graph move
  // the handled request to Deleted Items by default, the way Outlook does. The
  // backend reports which actually happened (`consumed`), because assuming it
  // is what got reported: the row stayed in the list, and opening it produced a
  // raw "ErrorItemNotFound — The specified object was not found in the store".
  //
  // A plain re-sync is not enough on its own either: the incremental pass adds
  // what is new, it does not notice what has gone. So the row is removed here,
  // exactly as a delete removes one.
  if (config.cacheEnabled) {
    const acctId = currentUserAccountId();
    cache.removeMessageContent(uKey, acctId, folder, uid);
    sync.noteLocalWrite(uKey, acctId, folder);
    if (result.consumed) {
      cache.adjustFolderCounts(uKey, acctId, folder, cache.removeMessages(uKey, acctId, folder, [uid]));
    }
    try { await sync.syncFolderNow(uKey, acc, folder); }
    catch (e) { log.warn(`Could not re-sync "${folder}" after answering an invitation:`, e.message); }
  }
  events.broadcastForAccount(uKey, currentUserAccountId());
  res.json({ ok: true, ...result });
}));

/**
 * Send a read receipt for one message (RFC 3798).
 *
 * Never automatic and never silent — the reading pane says who asked for it and
 * this only runs when the reader presses the button. That is a deliberate
 * position, not an omission: an automatic receipt tells a stranger who mailed
 * you that your address is live and being read, which is exactly what a sender
 * fishing for that would want.
 *
 * The receipt goes out from the account the message arrived in, addressed to
 * whatever the message's own Disposition-Notification-To header names — read
 * back off the message here rather than taken from the request, so a client
 * can't be talked into mailing an arbitrary third party.
 */
app.post('/api/message/:folder/:uid/receipt', wrap(async (req, res) => {
  const folder = decodeURIComponent(req.params.folder);
  const uid = decodeURIComponent(req.params.uid);
  const acc = accounts.currentAccount();
  const msg = await contentCache.getMessage(currentUser().userKey, acc.id, folder, uid);
  const to = receiptAddressOf(msg.headers?.dispositionNotificationTo);
  if (!to) return res.status(400).json({ error: 'This message did not ask for a read receipt' });

  // The identity that owns this account, so the receipt comes from the address
  // the sender actually wrote to rather than whichever identity happens to be
  // the default.
  const identity = store.getIdentities().find((i) => i.accountId === acc.id) || null;
  const raw = buildMdn({
    to,
    from: identity?.email || acc.email,
    fromName: identity?.name || '',
    originalSubject: msg.subject,
    originalMessageId: msg.messageId,
    originalDate: msg.date ? new Date(msg.date).toUTCString() : '',
    originalTo: identity?.email || acc.email,
    messageId: `<mdn-${Date.now()}-${Math.random().toString(36).slice(2)}@hmelj>`,
  });
  await sendRawMessage({ accountId: acc.id, raw, to });

  // RFC 3503's marker, so every other client that opens this mailbox knows a
  // receipt has already gone out and doesn't offer to send a second one. Purely
  // best-effort: plenty of servers refuse custom keywords, and failing to
  // record it must not make a sent receipt look like a failure.
  try {
    await imap.setFlags(folder, [uid], { add: ['$MDNSent'] });
  } catch (e) {
    log.scope('receipt').debug(`Could not set $MDNSent on ${folder}/${uid}: ${e.message}`);
  }
  userLog.record(currentUser().viewerKey, {
    level: 'info', category: 'send', message: `Read receipt sent to ${to}`,
    detail: msg.subject || null, accountId: acc.id, accountLabel: acc.label,
  });
  res.json({ ok: true, to });
}));

app.get('/api/message/:folder/:uid/headers', wrap(async (req, res) => {
  const folder = decodeURIComponent(req.params.folder);
  const uid = decodeURIComponent(req.params.uid);
  res.json(await imap.getMessageHeaders(folder, uid));
}));

/** "Save as EML" (the View-headers dialog) — the message's own raw source,
 * byte for byte as the server delivered it, so the saved file opens in any
 * mail client and stays a valid forensic copy of what arrived.
 *
 * `?name=` is the subject the client is already showing, used only for the
 * download's filename (contentDisposition() sanitizes it); no header parsing
 * happens here, and a missing/blank name just falls back to the uid. */
app.get('/api/message/:folder/:uid/eml', wrap(async (req, res) => {
  const folder = decodeURIComponent(req.params.folder);
  const uid = decodeURIComponent(req.params.uid);
  const { source } = await imap.getMessageSource(folder, uid);
  const base = String(req.query.name || '').trim().replace(/[\r\n\/\\]+/g, ' ').trim().slice(0, 120) || `message-${uid}`;
  res.setHeader('Content-Type', 'message/rfc822');
  res.setHeader('Content-Disposition', contentDisposition('attachment', base + '.eml'));
  res.send(Buffer.isBuffer(source) ? source : Buffer.from(source));
}));

/** RFC 6266/5987 Content-Disposition value. The plain `filename=` parameter can
 * only carry ASCII, so a name with e.g. Slovenian diacritics needs the
 * `filename*=UTF-8''…` form alongside an ASCII-safe fallback for anything that
 * doesn't understand it. (This used to percent-encode into the plain parameter,
 * which every client took literally — "račun.pdf" saved as "ra%C4%8Dun.pdf".) */
function contentDisposition(kind, filename) {
  const name = filename || 'attachment';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/* ---------- attachment bytes ----------
 *
 * Both routes below hand back the bytes of one MIME part, and both used to pay
 * the full price for every single request: `imap.getAttachment` pulls the
 * message's ENTIRE raw source (base64, so ~1.33x everything attached) and runs
 * mailparser over all of it to pick out one part. Three attachments on one
 * message meant three of those; an HTML body with six inline images meant
 * twelve, because the cid route parses once to find the part and once to
 * extract it — and it re-did all of that every time the reading pane rebuilt
 * its frame, which a theme change alone is enough to cause.
 *
 * Two layers now stand in front of that work, both resting on the same fact:
 * for a given (account, folder, uid, part) these bytes are immutable.
 *
 *  1. The browser's own cache, via a strong ETag and a long private max-age —
 *     the only version of this that costs the server nothing at all.
 *  2. A bounded in-memory LRU (server/attachmentCache.js) behind it, for the
 *     second device, the emptied browser cache, and the Download button.
 *
 * `immutable` is not decoration here: without it a plain reload revalidates,
 * and answering "still fresh?" honestly needs the bytes in hand, which is the
 * expensive thing we are trying not to do. The length baked into the ETag
 * covers the one case where a uid could ever point at different bytes (a
 * server reusing uids after an expunge, which UIDVALIDITY exists to prevent).
 */
const attachBytes = createByteLru({ maxBytes: config.attachmentCacheBytes, maxEntries: 64 });

/** `produce()` only runs on a miss. Nothing is cached when the LRU is switched
 *  off (ATTACHMENT_CACHE_MB=0) or when a part somehow has no Buffer. */
async function cachedAttachment(key, produce) {
  if (!config.attachmentCacheBytes) return produce();
  const hit = attachBytes.get(key);
  if (hit) return hit;
  const a = await produce();
  if (Buffer.isBuffer(a?.content)) attachBytes.set(key, a, a.content.length);
  return a;
}

/** Sends one part, with the validator and freshness headers that let the next
 *  request never arrive. `inline: null` means "don't say" — the cid route
 *  serves into an <img> and has no filename worth offering. */
function sendAttachment(req, res, key, a, inline) {
  const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content || '');
  const etag = etagFor(key, content.length);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  res.setHeader('Content-Type', a.contentType || 'application/octet-stream');
  if (inline !== null) res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', a.filename));
  if (etagMatches(req.headers['if-none-match'], etag)) return res.status(304).end();
  // Explicit, so the viewer's progress bar has a total to count towards —
  // res.send would set it anyway, but this is load-bearing now, not incidental.
  res.setHeader('Content-Length', String(content.length));
  res.send(content);
}

app.get('/api/message/:folder/:uid/attachment/:index', wrap(async (req, res) => {
  const folder = decodeURIComponent(req.params.folder);
  const uid = decodeURIComponent(req.params.uid);
  const index = parseInt(req.params.index, 10);
  const { userKey: uKey, accountId } = currentUser();
  const key = attachmentKey(uKey, accountId, folder, uid, index);
  const a = await cachedAttachment(key, () => imap.getAttachment(folder, uid, index));
  const type = a.contentType || 'application/octet-stream';
  // "inline" for anything the attachment viewer can actually preview
  // (image/video/audio/pdf) — Chrome's <embed type="application/pdf">
  // (and <img>/<video> in general) will otherwise be forced to download by
  // the browser regardless of what the element asks for.
  //
  // `?download=1` is the opposite intent, asked for explicitly: the viewer's
  // Download button and the mobile "hand it to the OS" path (see
  // attachmentViewer.js), where an inline PDF is exactly what we DON'T want —
  // a mobile browser would try to render it itself, and Android's WebView
  // renders it as a blank page.
  const previewable = /^(image|video|audio)\//.test(type) || type === 'application/pdf';
  sendAttachment(req, res, key, a, previewable && req.query.download !== '1');
}));

/**
 * Every attachment on one message, as a single .zip.
 *
 * Zipped on the server rather than in the browser because the parts are only
 * on the server: each one is a separate IMAP/Graph/EWS fetch, and doing that
 * from the client would mean N requests, N copies in the tab's memory, and a
 * zip built in JavaScript on a phone. Here they are fetched through the same
 * cache a single download uses, so a second "download all" after opening a few
 * of them costs nothing extra.
 *
 * Embedded images are excluded. A newsletter is routinely twenty of them — the
 * logo, the spacer gifs, the social icons — and nobody asking for "the
 * attachments" means those; they are part of the message body, and the chips
 * this button sits beside do not list them either.
 */
app.get('/api/message/:folder/:uid/attachments.zip', wrap(async (req, res) => {
  const folder = decodeURIComponent(req.params.folder);
  const uid = decodeURIComponent(req.params.uid);
  const { userKey: uKey, accountId } = currentUser();
  const msg = await contentCache.getMessage(uKey, accountId, folder, uid);
  // EXACTLY the set the reading pane shows as chips, which is `inlineUsed` and
  // not `inline` — see messageParse.js for why those differ: some senders
  // (Gmail's own Sent copies among them) fail to mark an embedded image
  // inline, so `inline` alone both misses real embeds and can exclude a
  // genuine attachment. Using the other one here would put files in the
  // archive that the message does not list, or leave out ones it does.
  const wanted = (msg?.attachments || []).filter((a) => !a.inlineUsed);
  if (!wanted.length) return res.status(404).json({ error: 'That message has no attachments' });

  const files = [];
  for (const a of wanted) {
    const key = attachmentKey(uKey, accountId, folder, uid, a.index);
    // Sequential, sharing the account's one connection — the same reason
    // sweepLive walks folders one at a time rather than in parallel.
    const got = await cachedAttachment(key, () => imap.getAttachment(folder, uid, a.index));
    files.push({
      name: a.filename || `attachment-${a.index}`,
      data: Buffer.isBuffer(got.content) ? got.content : Buffer.from(got.content || ''),
      date: msg.date ? new Date(msg.date) : new Date(),
    });
  }

  const archive = zipSync(files);
  // Named after the message, so a folder full of these is still navigable —
  // "attachments.zip" five times over is not. safeEntryName is doing filename
  // duty here rather than entry duty, which is the same job.
  const stem = safeEntryName(msg?.subject || 'attachments', 'attachments').slice(0, 80).trim() || 'attachments';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDisposition('attachment', `${stem}.zip`));
  res.setHeader('Content-Length', String(archive.length));
  // Deliberately not cached: it is built from parts that are, and an archive
  // is a one-off download rather than something a page re-requests.
  res.setHeader('Cache-Control', 'no-store');
  res.send(archive);
}));

app.get('/api/message/:folder/:uid/cid/:cid', wrap(async (req, res) => {
  const folder = decodeURIComponent(req.params.folder);
  const uid = decodeURIComponent(req.params.uid);
  const cid = decodeURIComponent(req.params.cid);
  const { userKey: uKey, accountId } = currentUser();
  const key = attachmentKey(uKey, accountId, folder, uid, cid, 'cid');
  let missing = false;
  const a = await cachedAttachment(key, async () => {
    const msg = await imap.getMessage(folder, uid);
    const target = msg.attachments.find((x) => x.cid === cid);
    if (!target) { missing = true; return { content: null }; }
    return imap.getAttachment(folder, uid, target.index);
  });
  if (missing) return res.status(404).end();
  sendAttachment(req, res, key, a, null);
}));

// flags / actions on messages
//
// Each handler mirrors its change into the cache right after the IMAP call
// succeeds (guarded by cacheEnabled) — otherwise the very next read of this
// folder comes straight back from the cache, which the background poller
// only refreshes every ~2min (incrementally) or ~20min (full reconcile),
// making writes look reverted/ignored in the UI even though they landed on
// the server. The poller remains authoritative for drift from OTHER clients
// (Roundcube, phone apps, etc.) — this is only for writes made through here.
app.post('/api/messages/:folder/flags', wrap(async (req, res) => {
  const folder = decodeURIComponent(req.params.folder);
  const { uids, add = [], remove = [] } = req.body;
  const result = await imap.setFlags(folder, uids, { add, remove });
  if (config.cacheEnabled) {
    const uKey = currentUser().userKey, acctId = currentUser().accountId;
    // Before anything else: this folder now has a change of OURS in it, which
    // is what stops a background sync reading around us from writing a stale
    // flag set or unread count back over it (see sync.js#noteLocalWrite).
    sync.noteLocalWrite(uKey, acctId, folder);
    // \Seen changes shift the folder's unread badge — apply that shift now
    // instead of leaving the sidebar/folder-list count stale until the next
    // full poll (up to ~20min). applyFlags reports how many messages actually
    // changed read state (see there); a no-op re-mark returns a zero delta.
    cache.adjustFolderCounts(uKey, acctId, folder, cache.applyFlags(uKey, acctId, folder, uids, { add, remove }));
    // The badge counter and the rows it's meant to describe live in different
    // tables, so where the cache provably covers the whole folder, make them
    // agree rather than trusting the running delta. Almost always a no-op —
    // and a no-op by design where the folder is bigger than the cache window.
    const fixed = cache.reconcileFolderCounts(uKey, acctId, folder);
    if (fixed) log.debug(`Unread counter for ${folder} disagreed with the cached rows (${fixed.from} → ${fixed.to}) — corrected`);
  }
  events.broadcastForAccount(currentUser().userKey, currentUserAccountId()); // tells this user's (and every shared-account grantee's) other open tabs/devices to reconcile now, instead of waiting on their own next poll
  res.json(result);
}));
/**
 * One folder move, mirrored into the cache. Shared by the plain /move route and
 * the Junk/Archive filing below, which is several moves in a row and must not
 * re-implement any of this.
 */
async function moveAndMirror(folder, uids, target) {
  const result = await imap.moveMessages(folder, uids, target);
  if (config.cacheEnabled) {
    const uKey = currentUser().userKey, acctId = currentUser().accountId;
    sync.noteLocalWrite(uKey, acctId, folder);
    sync.noteLocalWrite(uKey, acctId, target);
    cache.adjustFolderCounts(uKey, acctId, folder, cache.removeMessages(uKey, acctId, folder, uids));
    // The destination doesn't self-heal until the next background sync tick
    // otherwise — a moved message gets a new UID there, which the poller's
    // incremental "anything newer?" pass would eventually pick up, but
    // "eventually" (up to config.syncIntervalMs later) is exactly the bug
    // this fixes: opening the destination folder right after moving showed
    // it as still not there. Force that folder's sync now instead of
    // waiting on the next tick.
    try {
      await sync.syncFolderNow(uKey, accounts.currentAccount(), target);
    } catch (e) { log.warn(`Could not sync destination folder "${target}" after move:`, e.message); }
  }
  return result;
}

app.post('/api/messages/:folder/move', wrap(async (req, res) => {
  const folder = decodeURIComponent(req.params.folder);
  const result = await moveAndMirror(folder, req.body.uids, req.body.target);
  events.broadcastForAccount(currentUser().userKey, currentUserAccountId());
  res.json(result);
}));

/**
 * Mark as spam / not spam, archive / unarchive — one route, because they are
 * the same operation with a different destination.
 *
 * `box` is 'junk' or 'archive' and names a PER-ACCOUNT folder setting; the
 * destination is never taken from the request, so this cannot be talked into
 * moving mail somewhere of the caller's choosing that /move wouldn't already
 * allow. An account with no such folder configured is a 400 — the client hides
 * the menu entries in that case, and this is the backstop.
 *
 * Going out, where each message came from is written down (server/refile.js);
 * coming back, that is what decides the destination, one move per remembered
 * folder, with the Inbox for anything unrecorded. So "not spam" on a message
 * the server's own filter put in Junk — never in the ledger, and the common
 * case — still does the obvious thing.
 */
app.post('/api/messages/:folder/refile', wrap(async (req, res) => {
  const folder = decodeURIComponent(req.params.folder);
  const { uids = [], box, revert = false } = req.body || {};
  if (!isBox(box)) return res.status(400).json({ error: 'Unknown destination' });
  if (!Array.isArray(uids) || !uids.length) return res.status(400).json({ error: 'No messages given' });

  const acc = accounts.currentAccount();
  // currentUser().userKey is already the owner's, for a shared account — the
  // same key the cached folder list is stored under.
  const home = refileFolderFor(acc, box, currentUser().userKey);
  if (!home) {
    return res.status(400).json({ error: box === 'junk' ? 'No Junk folder is set for this account' : 'No Archive folder is set for this account' });
  }
  const acctId = currentUserAccountId();

  let plan;
  if (revert) {
    const ledger = store.getRefileOrigins();
    plan = planReturn(uids, (uid) => recallOrigin(ledger, acctId, folder, uid), HOME_FALLBACK)
      // Whatever a stale entry claims, a message cannot be moved to the folder
      // it is already in — that is an IMAP error, not a no-op.
      .filter((g) => g.target !== folder);
    if (!plan.length) return res.status(400).json({ error: 'These messages are already there' });
  } else {
    if (folder === home) return res.status(400).json({ error: 'These messages are already there' });
    plan = [{ target: home, uids }];
  }

  const moves = [];
  for (const g of plan) {
    const r = await moveAndMirror(folder, g.uids, g.target);
    moves.push({ target: g.target, uids: g.uids, uidMap: r.uidMap || null });
  }

  // The ledger, after the fact: only messages that really moved are recorded,
  // and a message that has come back is forgotten outright so a uid the server
  // reuses later can never resolve to a stale answer.
  if (revert) {
    store.saveRefileOrigins(dropOrigins(store.getRefileOrigins(), uids.map((u) => originKey(acctId, folder, u))));
  } else {
    const entries = [];
    for (const m of moves) {
      for (const u of m.uids) {
        // No uidMap means nothing can be written down for that message, and it
        // comes back to the Inbox instead. All three backends do return one
        // (IMAP's COPYUID, EWS's new ItemIds, Graph's moved message) — an IMAP
        // server without UIDPLUS is the case that doesn't.
        const landed = m.uidMap?.[u];
        if (landed !== undefined) entries.push({ accountId: acctId, folder: m.target, uid: landed, from: folder });
      }
    }
    if (entries.length) store.saveRefileOrigins(noteOrigins(store.getRefileOrigins(), entries));
  }

  events.broadcastForAccount(currentUser().userKey, currentUserAccountId());
  res.json({ ok: true, box, revert: !!revert, moves });
}));
/* ---------- snooze (server/snooze.js) ----------
 *
 * "Take this out of my Inbox and bring it back at 08:00 on Monday." The message
 * really moves, into a per-account folder created on first use — see snooze.js's
 * header for why hiding it locally was not good enough.
 */

/**
 * The account's snooze folder, created if it is not there yet.
 *
 * The name is written back onto the account the first time one is made, so a
 * server that reports the folder under a different path than we asked for
 * (namespace prefixes like `INBOX.Snoozed` are normal on Courier and older
 * Dovecot setups) is recorded as IT sees it, not as we guessed. Everything
 * afterwards — the move, the wake, the sidebar — uses the stored name.
 */
async function ensureSnoozeFolder(acc, uKey) {
  if (acc.snoozeFolder) return acc.snoozeFolder;
  const existing = (config.cacheEnabled ? cache.getFolders(uKey, acc.id) : [])
    // Someone may already have a folder by that name from another client. Match
    // case-insensitively and on the LAST path segment, so `INBOX.Snoozed` and
    // `Snoozed` both count as one rather than producing a second.
    .find((f) => (f.path || '').split(/[./\\]/).pop().toLowerCase() === snooze.DEFAULT_SNOOZE_FOLDER.toLowerCase());
  let name = existing?.path;
  if (!name) {
    const created = await imap.createFolder(snooze.DEFAULT_SNOOZE_FOLDER);
    // ImapFlow reports the path the server actually used; EWS/Graph echo the
    // name back. Fall back to what we asked for if a backend says nothing.
    name = created?.path || created?.name || snooze.DEFAULT_SNOOZE_FOLDER;
    // Same reason as POST /api/folders: without this the folder is real and
    // holds the snoozed mail, but the sidebar cannot see it until the next
    // background poll.
    await refreshFolderCache();
    log.info(`Created snooze folder "${name}" for account ${acc.id}`);
  }
  accounts.updateAccountFields(acc.id, { snoozeFolder: name });
  return name;
}

/**
 * Snoozes one or more messages: move them out, then write down the promise.
 *
 * The move happens here rather than in snooze.js because this is where the
 * account is resolved and where moveAndMirror already keeps the cache honest —
 * doing it there would mean a second copy of all of that.
 */
app.post('/api/messages/:folder/snooze', wrap(async (req, res) => {
  const folder = decodeURIComponent(req.params.folder);
  const { uids = [], wakeAt, addCalendar = false } = req.body || {};
  if (!Array.isArray(uids) || !uids.length) return res.status(400).json({ error: 'No messages given' });
  // Validated with snooze.js's own check, and BEFORE anything moves. Two
  // separate mistakes were possible here and this closes both: `Number(null)`
  // is 0, which is finite, so a null time passed a bare Number.isFinite test —
  // and because the move happened first, a request that snooze.remember() then
  // refused had ALREADY taken the message out of the Inbox, leaving it parked
  // in the snooze folder with nothing recorded to bring it back.
  let when;
  try { when = snooze.validTime(wakeAt); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  const acc = accounts.currentAccount();
  const uKey = currentUser().userKey;
  const viewerKey = currentUser().viewerKey;
  const target = await ensureSnoozeFolder(acc, uKey);
  if (folder === target) return res.status(400).json({ error: 'These messages are already snoozed' });

  // Read the envelopes BEFORE the move: afterwards these uids name nothing, and
  // the record needs a subject to show in the list and a Message-ID to find the
  // message by if its uid turns out to have changed under us.
  const before = new Map();
  if (config.cacheEnabled) {
    for (const m of cache.getMessagesByUids(uKey, acc.id, folder, uids)) before.set(String(m.uid), m);
  }

  const moved = await moveAndMirror(folder, uids, target);
  const out = [];
  for (const uid of uids) {
    const env = before.get(String(uid)) || {};
    // No uidMap means the server has no UIDPLUS: the record still gets written,
    // with a null uid, and the wake finds the message by Message-ID instead.
    const landed = moved.uidMap?.[uid];
    let calendar = { calendarId: null, calendarUid: null };
    if (addCalendar) {
      try { calendar = await addSnoozeReminderEvent(viewerKey, env, when); }
      catch (e) { log.warn('Could not add the calendar reminder for a snoozed message:', e.message); }
    }
    out.push(snooze.remember(viewerKey, {
      accountId: acc.id,
      // For a shared account the mailbox is someone else's, and the wake has to
      // run as its owner — see the field's comment in snooze.js.
      ownerUsername: acc.shared ? acc.ownerUsername : currentUser().username,
      fromFolder: folder,
      snoozeFolder: target,
      uid: landed !== undefined ? landed : null,
      messageId: env.messageId || null,
      subject: env.subject || '',
      fromAddr: env.from?.address || '',
      fromName: env.from?.name || '',
      wakeAt: when,
      ...calendar,
    }));
  }
  events.broadcastForAccount(uKey, acc.id);
  res.json({ ok: true, folder: target, snoozed: out });
}));

/**
 * The optional calendar entry: an event at the wake time, with an alarm at zero
 * minutes so the existing reminder ticker (server/calendarReminders.js) delivers
 * the notification without this needing a second timer of its own.
 *
 * Targets the first writable calendar. Deliberately does NOT auto-create a local
 * calendar source: that would be a surprising side effect of ticking a checkbox
 * on a mail message, and a person with no calendar configured is better told
 * than quietly given one.
 */
async function addSnoozeReminderEvent(viewerKey, env, when) {
  const cal = calendarStore.listCalendarsFor(viewerKey)
    .find((c) => c.writable && !c.readOnly && c.enabled && c.sourceEnabled);
  if (!cal) throw Object.assign(new Error('No writable calendar is configured'), { status: 400 });
  const summary = env.subject ? `Follow up: ${env.subject}` : 'Follow up on a message';
  const who = env.from?.name || env.from?.address || '';
  const result = await calendarWrite.createEventFor(viewerKey, cal.id, {
    summary,
    start: when,
    end: when + 30 * 60000,
    description: who ? `Snoozed message from ${who}.` : 'Snoozed message.',
    reminders: [0],
  }, writeDeps());
  await afterCalendarWrite(viewerKey, cal.id);
  return { calendarId: cal.id, calendarUid: result?.uid || null };
}

app.get('/api/snoozed', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(snooze.list(currentUser().viewerKey));
});

/** Bring one back NOW, ahead of its time. */
app.post('/api/snoozed/:id/wake', wrap(async (req, res) => {
  const viewerKey = currentUser().viewerKey;
  const rec = snooze.get(viewerKey, req.params.id);
  const owner = listUsers().find((u) => u.username === rec.ownerUsername);
  if (!owner) return res.status(410).json({ error: 'The owner of that mailbox no longer exists' });
  const moved = await runAsAccount({ id: owner.id, username: owner.username }, rec.accountId,
    () => snoozeWakeMove(viewerKey, rec), { purpose: 'snooze' });
  snooze.forget(viewerKey, rec.id);
  await dropSnoozeCalendarEvent(viewerKey, rec);
  res.json({ ok: true, ...moved });
}));

/** Move one to a different time, leaving the message where it is. */
app.patch('/api/snoozed/:id', wrap(async (req, res) => {
  res.json(snooze.resnooze(currentUser().viewerKey, req.params.id, req.body?.wakeAt));
}));

/**
 * The move back. Runs under the account OWNER's context, both from the tick and
 * from the route above — everything it touches (the mailbox, the cache) is the
 * owner's, not the snoozer's.
 *
 * Returns `{gone:true}` when the message is not in the snooze folder any more:
 * somebody filed it by hand or deleted it, which is a decision rather than a
 * failure, and putting a copy back in the Inbox would undo it.
 */
async function snoozeWakeMove(uKey, rec) {
  const ownerKey = currentUser().userKey;
  let uid = rec.uid;
  // Confirm the uid is still what the record thinks. A snooze can sit for
  // months, and in that time another client may have moved things around the
  // folder; the Message-ID is what survives that, so it is the fallback.
  const stillThere = uid != null && config.cacheEnabled
    && cache.getMessagesByUids(ownerKey, rec.accountId, rec.snoozeFolder, [uid]).length > 0;
  if (!stillThere && rec.messageId && config.cacheEnabled) {
    // Re-sync first: the cache may simply never have seen the folder, which is
    // not the same as the message being gone.
    try { await sync.syncFolderNow(ownerKey, accounts.getAccount(rec.accountId), rec.snoozeFolder); }
    catch (e) { log.debug(`Could not re-sync ${rec.snoozeFolder} before waking: ${e.message}`); }
    const found = cache.findByMessageId(ownerKey, rec.accountId, rec.snoozeFolder, rec.messageId);
    uid = found?.uid ?? uid;
  }
  if (uid == null) return { gone: true };

  const moved = await moveAndMirror(rec.snoozeFolder, [uid], rec.fromFolder);
  const landed = moved.uidMap?.[uid];
  // Back as UNREAD: the whole point of a snooze is that it asks for attention
  // again at the chosen time, and a message that reappears already-read is one
  // nothing will draw the eye to.
  if (landed !== undefined) {
    try { await imap.setFlags(rec.fromFolder, [landed], { remove: ['\\Seen'] }); }
    catch (e) { log.debug(`Could not mark a woken message unread: ${e.message}`); }
    if (config.cacheEnabled) cache.applyFlags(ownerKey, rec.accountId, rec.fromFolder, [landed], { remove: ['\\Seen'] });
  }
  events.broadcastForAccount(ownerKey, rec.accountId);
  return { uid: landed ?? null, folder: rec.fromFolder };
}

/** Takes the calendar entry away again when a snooze ends early — the reminder
 *  was for something already dealt with. Never fatal. */
async function dropSnoozeCalendarEvent(viewerKey, rec) {
  if (!rec.calendarId || !rec.calendarUid) return;
  try {
    await calendarWrite.deleteEventFor(viewerKey, rec.calendarId, rec.calendarUid, writeDeps());
    await afterCalendarWrite(viewerKey, rec.calendarId);
  } catch (e) {
    log.debug(`Could not remove the calendar reminder for an un-snoozed message: ${e.message}`);
  }
}

app.post('/api/messages/:folder/copy', wrap(async (req, res) => {
  const result = await imap.copyMessages(decodeURIComponent(req.params.folder), req.body.uids, req.body.target);
  events.broadcastForAccount(currentUser().userKey, currentUserAccountId()); // no cache mirror for copy today, but the destination folder still needs other tabs to know to refetch it
  res.json(result);
}));
app.post('/api/messages/:folder/delete', wrap(async (req, res) => {
  const folder = decodeURIComponent(req.params.folder);
  const result = await imap.deleteMessages(folder, req.body.uids);
  if (config.cacheEnabled) {
    const uKey = currentUser().userKey, acctId = currentUser().accountId;
    sync.noteLocalWrite(uKey, acctId, folder);
    // A \Deleted-flagged message is still IN the folder (and still unread if
    // it was) — only the "gone from this folder" branch shifts the counts.
    if (result.action === 'flagged') cache.applyFlags(uKey, acctId, folder, req.body.uids, { add: ['\\Deleted'] });
    else cache.adjustFolderCounts(uKey, acctId, folder, cache.removeMessages(uKey, acctId, folder, req.body.uids)); // moved to trash or expunged — either way, gone from this folder
  }
  events.broadcastForAccount(currentUser().userKey, currentUserAccountId());
  res.json(result);
}));

// ---------- send & drafts ----------

/** Builds+appends a draft from a compose payload, replacing `previousUid`'s
 * autosave in place if given — used by both /api/drafts (autosave/manual
 * save, unchanged behavior) and /api/send's background failure path below
 * (so a failed send is recoverable exactly the same way an autosave already
 * is, not a second parallel mechanism). Caller is responsible for already
 * being in `acc`'s ALS context (ambient for /api/drafts; explicit
 * runWithAccount for the backgrounded failure path, since that runs after
 * the request's own ambient context may no longer reliably line up — see
 * sendMail()'s own identity-resolved account, which isn't necessarily the
 * same account `?account=` on the URL pointed at). */
async function saveDraft(payload, acc, previousUid) {
  const identities = store.getIdentities();
  const identity = identities.find((i) => i.id === payload.identityId) || identities[0] || { email: acc.email };
  const raw = await buildRaw({
    from: identity.name ? { name: identity.name, address: identity.email } : identity.email,
    to: payload.to || undefined,
    cc: payload.cc || undefined,
    bcc: payload.bcc || undefined,
    subject: payload.subject || '',
    html: payload.html || undefined,
    text: payload.text || undefined,
    attachments: (payload.attachments || []).map((a) => ({ filename: a.filename, content: Buffer.from(a.contentBase64, 'base64'), contentType: a.contentType })),
  });
  if (previousUid) {
    await imap.hardDelete(acc.draftsFolder, [previousUid]).catch(() => {});
  }
  let uid;
  try {
    ({ uid } = await imap.appendMessage(acc.draftsFolder, raw, ['\\Draft', '\\Seen']));
  } catch (e) {
    // Most common cause: acc.draftsFolder was auto-detected wrong (or the
    // server doesn't advertise IMAP SPECIAL-USE at all) and points at a
    // folder path that doesn't actually exist — fixable in Settings ›
    // Folders › Special folders without touching code.
    e.message = `Could not save to the Drafts folder ("${acc.draftsFolder}"). Check Settings → Folders → Special folders for this account. (${e.message})`;
    throw e;
  }
  // appendMessage() resolves the new uid itself (server UIDPLUS response, or
  // an exact SEARCH-by-sequence when the server lacks that extension) — only
  // fall back to "assume it's whatever sorts newest" on the rare server
  // where neither of those worked.
  if (!uid) {
    const { messages } = await imap.listMessages(acc.draftsFolder, { page: 1, pageSize: 1 });
    uid = messages[0]?.uid || null;
  }
  // Covers both callers below (manual/autosave via /api/drafts, and a
  // failed send's recovery copy via /api/send) with one line — currentUser()
  // resolves correctly either way: the /api/drafts route's ambient context
  // is already correct (?account= drives requireAuth's ownership swap), and
  // the /api/send failure path below now explicitly runs this under the
  // account's owner (runAsAccount), not just accountId-overridden
  // (runWithAccount used to leave userKey wrong for a shared account).
  events.broadcastForAccount(currentUser().userKey, acc.id);
  return uid;
}

// ---------- scheduled send (see server/scheduledSend.js) ----------
// Per-person, keyed on viewerKey: a queued message belongs to whoever wrote it,
// not to whichever mailbox it will go out through.
app.get('/api/scheduled', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(scheduledSend.list(currentUser().viewerKey));
});

// Body + attachment names for ONE queued message, so a row can be read in the
// reading pane before it goes out. Not the bytes — see scheduledSend#preview.
app.get('/api/scheduled/:id', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(scheduledSend.preview(currentUser().viewerKey, req.params.id));
}));

// Answers with the full payload so the composer can reopen it — "cancel" means
// "give it back to me", and a cancel that dropped the message would be a
// data-loss button wearing a friendly label.
// Move it, without going back through the composer — the payload is left
// untouched on purpose (see scheduledSend#reschedule).
app.patch('/api/scheduled/:id', wrap(async (req, res) => {
  res.json(scheduledSend.reschedule(currentUser().viewerKey, req.params.id, req.body?.sendAt));
}));

app.delete('/api/scheduled/:id', wrap(async (req, res) => {
  const payload = scheduledSend.cancel(currentUser().viewerKey, req.params.id);
  res.json({ ok: true, payload });
}));

// scheduledSend.js can't import this file (cycle), so the two things it needs
// from here are handed over at boot — the same arrangement sync.js uses for
// idle.js's activity callback. Both run inside runAsUser(sender).
scheduledSend.setHooks({
  saveFailedDraft: async (payload) => {
    const { acc, ownerUser } = resolveIdentityAndAccount(payload);
    return runAsAccount(ownerUser, acc.id, () => saveDraft(payload, acc, null));
  },
  markOriginal: async (original) => {
    const target = resolveOriginalTarget(original);
    if (target) await markOriginal(target);
  },
});

app.post('/api/drafts', wrap(async (req, res) => {
  const acc = accounts.currentAccount(); // route is called with ?account=<identity's account>
  const uid = await saveDraft(req.body, acc, req.body.previousUid);
  res.json({ ok: true, uid });
}));

// Deliberately NOT a plain `await sendMail(...)` — a send is 2-3 sequential
// network round trips (see smtpClient.js), which used to block the compose
// window for the entire time. Instead: cheap synchronous validation only,
// respond immediately, and keep running in the background — same "quick
// action, reconcile or recover after the fact" shape as quickToggleRead/
// quickDelete in app.js. Legal in Express (a handler may keep awaiting
// after res.json()); the continuation below handles its own errors — by the
// time it could fail, the response is already gone, so wrap()'s catch can't
// touch `res` anymore.
/**
 * "This one was replied to / forwarded", written back onto the ORIGINAL message
 * so every client — Hmelj, Thunderbird, Outlook, the phone — draws the same
 * ↩ / ↪ next to it. `\Answered` is the IMAP system flag for it; `$Forwarded`
 * the RFC 5788 keyword; ewsClient.js maps both onto Exchange's
 * PidTagLastVerbExecuted.
 *
 * Resolved through resolveAccountForSending() rather than trusting the payload,
 * because the original needn't live in the account being sent FROM (replying to
 * mail in one account while sending from another identity is ordinary), and that
 * function is the one place that re-checks the caller may actually touch a given
 * account. A `null` return means "not flaggable" — never a reason to refuse a
 * send.
 */
function resolveOriginalTarget(original) {
  if (!original?.accountId || !original.folder || original.uid == null) return null;
  const kind = original.kind === 'forward' ? 'forward' : 'reply';
  try {
    const { acc, ownerUser } = accounts.resolveAccountForSending(original.accountId);
    return { acc, ownerUser, folder: String(original.folder), uid: original.uid, kind };
  } catch {
    return null; // not ours, or gone — silently skip the marker
  }
}

async function markOriginal(target) {
  const flag = target.kind === 'forward' ? '$Forwarded' : '\\Answered';
  const ownerKey = userKey(target.ownerUser.username);
  await runAsAccount(target.ownerUser, target.acc.id, () =>
    imap.setFlags(target.folder, [target.uid], { add: [flag] }));
  if (config.cacheEnabled) cache.applyFlags(ownerKey, target.acc.id, target.folder, [target.uid], { add: [flag] });
  events.broadcastForAccount(ownerKey, target.acc.id);
}

app.post('/api/send', wrap(async (req, res) => {
  const payload = req.body;
  if (!payload?.to) return res.status(400).json({ error: 'Add at least one recipient' });
  let acc, ownerUser;
  try {
    ({ acc, ownerUser } = resolveIdentityAndAccount(payload));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  // Resolved here, while the request's own ALS context is still the caller's —
  // resolveAccountForSending checks access against currentUser().
  const originalTarget = resolveOriginalTarget(payload.original);

  // Send later. Everything above still runs first on purpose: a message with no
  // usable identity, or aimed at an account the caller can't send from, should
  // be refused NOW, while there is a compose window open to show the error in —
  // not silently at 07:00 tomorrow with nobody watching.
  // "Undo send" is a scheduled send with a very short delay — the same queue,
  // the same cancel route, the same boot catch-up. Applied here rather than in
  // the browser so the window is honoured even when the tab is closed a second
  // after Send: the message is already on the server's queue, and closing the
  // tab simply means nobody takes the offer.
  const undoSeconds = payload.sendAt ? 0 : Math.max(0, Math.min(120, Number(store.getSettings().undoSendSeconds) || 0));
  if (undoSeconds > 0) {
    const rec = scheduledSend.schedule(currentUser().viewerKey, { ...payload, undo: true }, Date.now() + undoSeconds * 1000);
    if (payload.previousUid) {
      await runAsAccount(ownerUser, acc.id, () => imap.hardDelete(acc.draftsFolder, [payload.previousUid])).catch(() => {});
      events.broadcastForAccount(userKey(ownerUser.username), acc.id);
    }
    // `undo` rather than `scheduled` so the composer knows to show a countdown
    // toast instead of the "queued for later" one — same record either way.
    return res.json({ undo: rec, undoSeconds });
  }

  if (payload.sendAt) {
    const rec = scheduledSend.schedule(currentUser().viewerKey, payload, payload.sendAt);
    // The draft this was composed from is finished with, exactly as it would be
    // after an immediate send.
    if (payload.previousUid) {
      await runAsAccount(ownerUser, acc.id, () => imap.hardDelete(acc.draftsFolder, [payload.previousUid])).catch(() => {});
      events.broadcastForAccount(userKey(ownerUser.username), acc.id);
    }
    return res.json({ scheduled: rec });
  }

  res.json({ queued: true });

  // The account's OWNER (not necessarily whoever's sending — see
  // smtpClient.js#resolveIdentityAndAccount and accounts.js#
  // resolveAccountForSending) is who every IMAP-touching call below must run
  // under, and whose (+ every grantee's, via broadcastForAccount) open tabs
  // get told the Sent folder changed. The failure-push at the bottom is
  // different: that's a personal "your send failed" nudge, always to the
  // actual sender, never the owner.
  const senderKey = currentUser().userKey;
  const ownerKey = userKey(ownerUser.username);
  try {
    await sendMail(payload);
    // Everyone it went to becomes a contact (opt-out: settings.autoAddContacts).
    // After the send, not before — a message that bounced at the handshake is no
    // evidence the address was typed right. See server/contacts.js.
    learnRecipients(payload);
    // After the send, and never allowed to break it: a server that refuses the
    // $Forwarded keyword (they exist — keywords need PERMANENTFLAGS \*) must
    // cost the user a missing arrow, not a message that looks like it failed.
    if (originalTarget) {
      await markOriginal(originalTarget).catch((e) =>
        log.debug(`Could not mark ${originalTarget.folder}/${originalTarget.uid} as ${originalTarget.kind}:`, e.message));
    }
    if (payload.previousUid) {
      await runAsAccount(ownerUser, acc.id, () => imap.hardDelete(acc.draftsFolder, [payload.previousUid])).catch(() => {});
    }
    events.broadcastForAccount(ownerKey, acc.id); // Sent folder (and the now-gone draft, if any) changed — let other open tabs (owner's and every grantee's) know
  } catch (e) {
    log.warn(`Background send failed for ${acc.label}:`, e.message);
    // This one is invisible by construction: /api/send answers {queued:true}
    // immediately and the real work happens after the response, so there is no
    // request left to fail. The push notification below only reaches devices
    // that set push up at all — the log is the reliable record.
    userLog.record(senderKey, {
      level: 'error',
      category: 'send',
      message: `Could not send "${payload.subject || '(no subject)'}"`,
      detail: `${e.message}\nTo: ${payload.to}\nSaved back to Drafts.`,
      accountId: acc.id,
      accountLabel: acc.label,
    });
    // Preserved exactly like a failed autosave would be — replacing the
    // compose window's own draft copy in place if it had one, never both a
    // stale draft AND a lost message.
    let draftUid = null;
    try {
      draftUid = await runAsAccount(ownerUser, acc.id, () => saveDraft(payload, acc, payload.previousUid));
    } catch (e2) {
      log.error('Also failed to save the failed send as a draft:', e2.message);
    }
    // Reaches you even if the compose window (and the whole tab/device) is
    // long gone by the time this resolves — reuses the Web Push
    // infrastructure rather than a second, foreground-only notification
    // mechanism. If push isn't set up anywhere, the draft is still sitting
    // in Drafts either way — never silent data loss, just less immediate.
    // Always to the person who actually clicked send, not the account owner.
    await push.sendPushToUser(senderKey, {
      title: 'Message failed to send',
      body: `${payload.subject || '(no subject)'} — ${e.message}`,
      icon: '/icons/icon-192.png',
      tag: `hmelj-send-fail-${Date.now()}`,
      data: draftUid ? { accountId: acc.id, folder: acc.draftsFolder, uid: draftUid } : {},
    }).catch(() => {});
  }
}));

// Before anything can be delivered: make sure no device is registered for push
// under two different logins (see push.js#reconcileSubscriptionOwners). Such a
// device receives BOTH users' new-mail notifications — sender, subject and a
// body preview — which is why this runs at startup rather than waiting for
// whichever page happens to re-register next.
push.reconcileSubscriptionOwners();

app.listen(config.port, config.host, () => {
  console.log(`\n  🌿  Hmelj webmail running at http://${config.host}:${config.port}`);
  console.log('  🔐 Multi-account mode: sign in with your Hmelj account, then attach any IMAP/SMTP mailboxes\n');
});

sync.start();
// Deliberately not inside sync.start(), which returns early when the cache is
// disabled — a scheduled message must still go out on a cache-less instance.
scheduledSend.start();
// Snoozed mail comes back on its own timer, for the same reason scheduled
// sending has one: it must work whether or not the cache is enabled, so it does
// not hang off the sync supervisor. The hook is what lets snooze.js move a
// message without importing this file (a cycle) — see setHooks there.
snooze.setHooks({ wakeMove: snoozeWakeMove });
snooze.start();
// Same reasoning again: contact sync writes to DATA_DIR, not to the message
// cache, so it has nothing to do with whether the cache is on.
contactSyncRunner.start();
// Calendars DO live in cache.sqlite, so this one genuinely needs it.
if (config.cacheEnabled) {
  calendarSync.start();
  // Reminders read from the same cache the sync writes to, so they go together.
  calendarReminders.start();
} else {
  log.scope('calendar').info('CACHE_ENABLED=false — calendar sync and reminders are off, since calendars are stored in the message cache');
}
