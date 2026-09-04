// Hmelj — OAuth2 sign-in for Microsoft and Google accounts.
//
// Why this exists: Microsoft has been switching Outlook.com and Microsoft 365
// off Basic Auth. The first version of this file went the XOAUTH2 route —
// OAuth to get a bearer token, then ordinary IMAP/SMTP with that token instead
// of a password. It works on paper and failed in practice, because IMAP has to
// be enabled on the mailbox itself and Exchange answers "User is authenticated
// but not connected." when it isn't. That switch is out of our hands and
// Microsoft keeps tightening it.
//
// So the token is now spent on Microsoft Graph instead (server/graphClient.js),
// which never touches the IMAP stack. That also removed the client secret: a
// Graph client can register as a PUBLIC client, where PKCE — not a shared
// secret — is what proves the code came back to whoever started the flow.
//
// The Azure app registration this expects:
//
//   Authentication → Add a platform → "Mobile and desktop applications"
//                    → Custom redirect URIs → https://<your-hmelj>/oauth/callback
//   Certificates & secrets → nothing. There is no secret.
//   API permissions → Microsoft Graph, delegated:
//                     Mail.ReadWrite, Mail.Send, Contacts.Read, offline_access
//
// The platform matters more than it looks. The same URI registered under "Web"
// makes the app a CONFIDENTIAL client and the token endpoint then demands a
// secret (AADSTS7000218). Registered under "Single-page application" it demands
// a cross-origin redemption we can't do from a server (AADSTS9002327) and caps
// refresh tokens at 24 hours. Only the public-client registration gives a
// server-side PKCE exchange with no secret and the normal 90-day sliding
// refresh token. See explainProviderError() below, which says exactly this to
// whoever gets it wrong.
//
// Three external constraints shaped the interactive flow, and none of them are
// negotiable:
//
//  1. The sign-in page cannot be framed. login.microsoftonline.com sends
//     X-Frame-Options/CSP frame-ancestors, so an <iframe> inside Hmelj is out.
//  2. It cannot run in an Android WebView either (Google returns
//     403 disallowed_useragent; Microsoft is heading the same way), so the
//     Android shell hands off to a Chrome Custom Tab.
//  3. Therefore the browser that receives the redirect is frequently NOT the
//     one holding the Hmelj session cookie — a Custom Tab is a different
//     cookie jar from the WebView entirely. So /oauth/callback authenticates
//     itself with the one-time `state` nonce and nothing else. Treat `state`
//     as a secret: it is the only thing standing between a stranger and the
//     token exchange. It is never logged.
//
// Google works out differently, and the difference is worth stating plainly
// because it decides most of the branching below:
//
//   Microsoft  →  OAuth token spent on Microsoft GRAPH (type:'graph' account)
//   Google     →  OAuth token spent on ordinary IMAP/SMTP via XOAUTH2
//                 (type:'imap' account carrying an `oauth` block instead of a
//                  password — see accounts.js#saveAccount)
//
// Gmail keeps IMAP/SMTP working with XOAUTH2 and doesn't gate it behind a
// per-mailbox switch the way Exchange does, so there is no reason to reach for
// the Gmail API and re-implement the mail stack for it. The token simply
// replaces the app password everywhere the IMAP one used to be typed.
//
// The Google Cloud OAuth client this expects:
//
//   APIs & Services → Credentials → Create credentials → OAuth client ID
//                     → Application type: "Web application"
//                     → Authorized redirect URIs: https://<your-hmelj>/oauth/callback
//   OAuth consent screen → scope https://mail.google.com/
//
// Two Google-specific traps, both surfaced to the admin in the UI and in
// explainProviderError() below:
//
//  a) A "Web application" client is a CONFIDENTIAL client and its token
//     endpoint DOES require the client secret — the exact opposite of Azure's
//     public-client registration. Google's alternative ("Desktop app") only
//     accepts http://localhost or a custom-scheme redirect, which a server-side
//     callback on a real hostname cannot use. Hence usesSecret below, and hence
//     oauth.json can again hold a secret (encrypted).
//  b) https://mail.google.com/ is a RESTRICTED scope, so an unverified app
//     shows the "Google hasn't verified this app" screen (fine — Advanced →
//     Continue), and while the consent screen's publishing status is left at
//     "Testing" Google expires the refresh token after 7 DAYS. Setting the
//     publishing status to "In production" removes the 7-day expiry without
//     needing verification; the warning screen stays. Anyone who leaves it in
//     Testing gets an invalid_grant every week and a "sign in again" badge.
//
// No new npm dependencies: Node 22 has global fetch, and node:crypto covers
// PKCE. Deliberately NOT using @azure/msal-node (as temp/office365_graph_pkce.js
// does) — it isn't installed, and it wants to own token storage, which here is
// the encrypted accounts.json.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';
import { log } from './log.js';
// Circular with accounts.js (it calls takeFlowTokens/accessTokenFor from inside
// saveAccount/testConnection). Same reasoning as the ewsClient cycle documented
// in accounts.js: both sides only touch the other's exports from inside a
// function body at call time, never at module top level, so ESM's live bindings
// have both modules fully evaluated before either is actually invoked.
import { encrypt, decrypt, updateOAuthTokens } from './accounts.js';

const olog = log.scope('oauth');

/* ---------------- providers ---------------- */

// Data-only on purpose, so a provider is a config addition rather than a
// redesign. `kind` is the load-bearing field: 'graph' means the token is spent
// on Microsoft Graph and produces a type:'graph' account; 'imap' means it is
// spent as an XOAUTH2 credential on the provider's ordinary IMAP/SMTP servers
// and produces a normal type:'imap' account whose password is replaced by an
// `oauth` block (imapDefaults below is what fills in the server fields the
// wizard therefore never asks for).
export const PROVIDERS = {
  microsoft: {
    label: 'Microsoft / Outlook',
    kind: 'graph',
    // Azure's registration for this is a PUBLIC client — PKCE only, no secret.
    usesSecret: false,
    usesTenant: true,
    // `common` accepts both personal Microsoft accounts (outlook.com,
    // hotmail.com, live.com) and work/school ones. Overridable per instance
    // for a single-tenant app registration.
    defaultTenant: 'common',
    authorizeUrl: (t) => `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`,
    tokenUrl: (t) => `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
    authorizeParams: {
      response_mode: 'query',
      // Without this a browser already signed into some other Microsoft account
      // silently reuses it, and you end up attaching the wrong mailbox.
      prompt: 'select_account',
    },
    // Mail.ReadWrite covers reading, flagging, moving, deleting and drafts;
    // Mail.Send covers /me/sendMail; Contacts.Read feeds the compose-window
    // address picker. offline_access is what gets us a refresh token at all,
    // and openid/email are only so the token response carries an id_token we
    // can read the signed-in address out of (to catch "you typed one address
    // and signed in as another"). These are exactly the delegated permissions
    // temp/office365_graph_pkce.js proved out, plus contacts.
    scopes: [
      'openid',
      'email',
      'offline_access',
      'https://graph.microsoft.com/Mail.ReadWrite',
      'https://graph.microsoft.com/Mail.Send',
      'https://graph.microsoft.com/Contacts.Read',
    ],
  },
  google: {
    label: 'Google / Gmail',
    kind: 'imap',
    // See trap (a) in the header comment: Google's server-side redirect flow
    // only exists for "Web application" clients, which are confidential.
    usesSecret: true,
    usesTenant: false,
    defaultTenant: '',
    authorizeUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    authorizeParams: {
      // Google issues a refresh token ONLY for access_type=offline, and only
      // re-issues one when consent is actually shown again — a second sign-in
      // without prompt=consent comes back with an access token and no refresh
      // token, which reads as "OAuth worked but stops in an hour".
      access_type: 'offline',
      prompt: 'select_account consent',
      // Don't quietly widen this account's grant to every scope the same Google
      // client was ever consented to for this user; ask for exactly `scopes`.
      include_granted_scopes: 'false',
    },
    // https://mail.google.com/ is full IMAP/SMTP access — Google has no
    // narrower scope that permits IMAP at all (the read-only Gmail API scopes
    // are a different API this doesn't use). openid+email are only so the token
    // response carries an id_token to read the signed-in address out of.
    scopes: [
      'openid',
      'email',
      'https://mail.google.com/',
    ],
    imapDefaults: {
      host: 'imap.gmail.com', port: 993, secure: true,
      smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true,
    },
    // Which EXISTING password accounts this sign-in can be attached to in place
    // (see accounts.js#attachOAuthSignIn). A Google token is useless against
    // anyone else's IMAP server, so offering the switch there would only produce
    // a broken account — imap.googlemail.com is the same mailbox under Google's
    // older hostname, so it counts too.
    imapHostPattern: /(^|\.)(gmail|googlemail)\.com$/i,
  },
};

/**
 * Scopes that are NOT requested by default, keyed by the feature that needs them.
 *
 * ── Why these are not simply added to `scopes` above ─────────────────────────
 * A token is issued for the scopes that were consented to. Widening the list
 * every account asks for would mean every EXISTING Google and Microsoft account
 * is suddenly holding a token that no longer matches, and the honest thing to do
 * about that is mark them all `needsReauth` — including the accounts of people
 * who will never open a calendar. That is a whole-instance disruption in
 * exchange for a feature nobody has asked for yet.
 *
 * So they are opt-in, per account: enabling contact or calendar sync on an
 * account runs one fresh sign-in for the union of base + the features it now
 * needs, and every other account is untouched.
 *
 * Google's `include_granted_scopes: 'false'` stays exactly as it is. That
 * setting exists so an account gets what it explicitly asked for and not every
 * scope this client was ever granted — and the union below IS the explicit ask.
 */
export const FEATURE_SCOPES = {
  microsoft: {
    // Contacts.Read is in the base list already; sync needs to write back.
    contacts: ['https://graph.microsoft.com/Contacts.ReadWrite'],
    calendar: ['https://graph.microsoft.com/Calendars.ReadWrite'],
  },
  google: {
    // Google's contacts are reached over CardDAV (see
    // server/contactsSync/googleContacts.js), which is what this scope covers —
    // the People API scopes are a different interface and buy nothing here.
    contacts: ['https://www.googleapis.com/auth/carddav'],
    calendar: ['https://www.googleapis.com/auth/calendar'],
  },
};

/** Which extra features a stored sign-in was consented to. Always an array,
 *  empty for every account that predates this — which is what makes those
 *  accounts behave exactly as they did before. */
export function featuresOf(acc) {
  const tok = acc?.oauth || acc?.graph || null;
  return Array.isArray(tok?.features) ? tok.features : [];
}

/**
 * The scopes to request for a provider, given the extra features wanted.
 *
 * De-duplicated and order-stable: a provider that echoes the scope string back
 * on refresh should see the same list it granted, and a duplicate entry makes
 * at least one provider (Microsoft, on some tenants) reject the request.
 */
export function scopesFor(providerId, features = []) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error(`Unknown OAuth provider: ${providerId}`);
  const extra = FEATURE_SCOPES[providerId] || {};
  const out = [...p.scopes];
  for (const f of features) for (const sc of extra[f] || []) if (!out.includes(sc)) out.push(sc);
  return out;
}

/** Which features this provider can offer at all — so the UI only shows the
 *  toggle where enabling it would actually do something. */
export function featuresAvailable(providerId) {
  return Object.keys(FEATURE_SCOPES[providerId] || {});
}

/** 'graph' | 'imap' | '' — which credential shape a provider's token takes. */
export function kindOf(providerId) {
  return PROVIDERS[providerId]?.kind || '';
}

/**
 * Can this provider's sign-in replace the password on an account that already
 * exists? True only for an IMAP account already pointed at that provider's own
 * servers. The imapDefaults host counts as well as the pattern, so an instance
 * that has overridden the endpoints (the test suite) stays consistent.
 */
export function canAttachToImapHost(providerId, host) {
  const p = PROVIDERS[providerId];
  if (!p || p.kind !== 'imap') return false;
  const h = String(host || '').trim().toLowerCase();
  if (!h) return false;
  return h === (imapDefaultsFor(providerId)?.host || '').toLowerCase() || !!p.imapHostPattern?.test(h);
}

/** Where an account keeps its OAuth credential. Microsoft accounts have used
 *  `graph` since the XOAUTH2-era migration (accounts.js#migrateLegacyOAuth) and
 *  keep it — there is no upside to rewriting every existing record — so both
 *  names are read here rather than migrating one into the other. */
function tokenBlock(acc) {
  return acc?.oauth || acc?.graph || null;
}

/** Server fields for an account whose whole configuration is the sign-in
 *  (Gmail): the wizard shows no host/port/TLS inputs for it, so these are what
 *  accounts.js writes instead of empty strings. Overridable from oauth.json for
 *  the same reason the authorize/token endpoints are — so the test suite can
 *  point a whole sign-in at test/mock-mail-server.js. Never set in normal
 *  operation. */
export function imapDefaultsFor(providerId) {
  return loadStore()[providerId]?.imapDefaults || PROVIDERS[providerId]?.imapDefaults || null;
}

/* ---------------- provider credentials (admin-managed) ---------------- */

// DATA_DIR/oauth.json, mode 600. A client ID is not secret — it's published in
// every authorize URL it ever builds — but Google's confidential-client secret
// genuinely is, so it is stored ENCRYPTED here (same AES-256-GCM key as
// accounts.json) rather than in the clear, and never leaves the server: the
// admin UI only ever learns whether one is set. Env vars win over the file,
// mirroring how config.js treats VAPID/FCM, so a containerised deploy can
// inject them without writing a file.
const FILE = () => path.join(config.dataDir, 'oauth.json');

const ENV_KEYS = {
  microsoft: { clientId: 'MS_OAUTH_CLIENT_ID', tenant: 'MS_OAUTH_TENANT' },
  google: { clientId: 'GOOGLE_OAUTH_CLIENT_ID', clientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET' },
};

function loadStore() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return {}; }
}

function saveStore(obj) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
}

/** Resolved settings for a provider, env-first. */
function credsFor(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error(`Unknown OAuth provider: ${providerId}`);
  const env = ENV_KEYS[providerId] || {};
  const row = loadStore()[providerId] || {};
  return {
    clientId: process.env[env.clientId] || row.clientId || '',
    // A secret written before the encryption key changed can no longer be decrypted;
    // treat that as "not configured" (the admin re-pastes it) rather than
    // throwing out of every provider listing.
    clientSecret: process.env[env.clientSecret]
      || (row.clientSecret ? (() => { try { return decrypt(row.clientSecret); } catch { return ''; } })() : ''),
    tenant: process.env[env.tenant] || row.tenant || p.defaultTenant,
    // Endpoint overrides exist purely so the test suite can point a flow at
    // test/mock-oauth-server.js. Never set in normal operation.
    authorizeUrl: row.authorizeUrl || '',
    tokenUrl: row.tokenUrl || '',
  };
}

function endpoints(providerId) {
  const p = PROVIDERS[providerId];
  const c = credsFor(providerId);
  return {
    authorize: c.authorizeUrl || p.authorizeUrl(c.tenant),
    token: c.tokenUrl || p.tokenUrl(c.tenant),
  };
}

/** A public client is configured as soon as it has an ID; a confidential one
 *  (Google) is useless without its secret too, and saying so here is what makes
 *  the wizard offer "an admin still has to set this up" instead of a sign-in
 *  button that would fail at the token exchange. */
export function isConfigured(providerId) {
  const c = credsFor(providerId);
  if (!c.clientId) return false;
  return PROVIDERS[providerId].usesSecret ? !!c.clientSecret : true;
}

/** Safe for the account wizard. `kind` tells it which account type this
 *  provider belongs under (see PROVIDERS). */
export function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    kind: p.kind,
    configured: isConfigured(id),
    // So the accounts list can offer "switch this password account to signing
    // in" on exactly the accounts where it would actually work — mirrors
    // canAttachToImapHost(), which is what the server enforces regardless.
    ...(p.kind === 'imap' ? {
      attachHostPattern: [imapDefaultsFor(id)?.host, p.imapHostPattern?.source]
        .filter(Boolean)
        .map((s, i) => (i === 0 ? '^' + String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$' : s))
        .join('|'),
    } : {}),
  }));
}

/** Admin view: adds clientId/tenant and which values are pinned by env (and so
 *  cannot be changed from the UI). The client secret itself is never sent —
 *  only whether one is stored. */
export function adminListProviders(redirectUri) {
  const store = loadStore();
  return Object.entries(PROVIDERS).map(([id, p]) => {
    const c = credsFor(id);
    const env = ENV_KEYS[id] || {};
    return {
      id,
      label: p.label,
      kind: p.kind,
      clientId: c.clientId,
      tenant: c.tenant,
      usesSecret: !!p.usesSecret,
      usesTenant: !!p.usesTenant,
      hasSecret: !!c.clientSecret,
      configured: isConfigured(id),
      redirectUri,
      envManaged: !!process.env[env.clientId],
      scopes: p.scopes,
      savedAt: store[id]?.savedAt || null,
    };
  });
}

export function adminSaveProvider(providerId, { clientId, tenant, clientSecret }) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error(`Unknown OAuth provider: ${providerId}`);
  const store = loadStore();
  const row = { ...(store[providerId] || {}) };
  // Microsoft is a public client: any secret left over from the pre-PKCE era is
  // dropped on the next save rather than sitting in the file forever, since
  // nothing reads it. Google's IS read, and follows the same "blank means keep
  // what's there" idiom as every password field in the account wizard — the
  // admin form can't prefill it, because it never receives it.
  if (!p.usesSecret) delete row.clientSecret;
  else if (clientSecret) row.clientSecret = encrypt(String(clientSecret).trim());
  if (clientId !== undefined) row.clientId = String(clientId).trim();
  if (tenant !== undefined) row.tenant = String(tenant).trim() || PROVIDERS[providerId].defaultTenant;
  row.savedAt = new Date().toISOString();
  store[providerId] = row;
  saveStore(store);
  olog.info(`${providerId}: OAuth client settings saved (configured=${isConfigured(providerId)})`);
  return adminListProviders('').find((p) => p.id === providerId);
}

/* ---------------- redirect URI ---------------- */

/**
 * The redirect_uri has to match what's registered with the provider BYTE FOR
 * BYTE, so getting it wrong is the single most likely setup failure. Prefer an
 * explicitly configured public URL; otherwise derive it from the request,
 * honouring the reverse-proxy headers a self-hosted instance behind
 * nginx/Caddy will actually be carrying.
 */
export function redirectUriFrom(req) {
  return publicBaseFrom(req) + '/oauth/callback';
}

/**
 * The public origin this instance is reachable at, with no trailing slash.
 *
 * Extracted from redirectUriFrom because OAuth is no longer the only thing that
 * needs it: the DAV server has to tell a user which URL to type into their
 * phone, and deriving that by string-surgery on a redirect URI was one rename
 * away from producing something subtly wrong.
 */
export function publicBaseFrom(req) {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, '');
  const proto = (req?.headers['x-forwarded-proto'] || req?.protocol || 'http').split(',')[0].trim();
  const host = (req?.headers['x-forwarded-host'] || req?.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

/* ---------------- pending flows ---------------- */

// state -> { userKey, provider, loginHint, codeVerifier, redirectUri,
//            accountId?, createdAt, status, tokens?, email?, error? }
// In memory on purpose: a flow is a 15-minute affair and a server restart
// mid-sign-in should invalidate it rather than resurrect it.
const flows = new Map();
const FLOW_TTL_MS = 15 * 60e3;

setInterval(() => {
  const cutoff = Date.now() - FLOW_TTL_MS;
  for (const [state, f] of flows) if (f.createdAt < cutoff) flows.delete(state);
}, 60e3).unref();

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function startFlow({ userKey: uKey, provider, email, accountId = null, redirectUri, features = [] }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown OAuth provider: ${provider}`);
  const c = credsFor(provider);
  if (!c.clientId) {
    const e = new Error('This Hmelj server has no OAuth client configured for ' + p.label + '. An admin needs to set it up under Settings → Admin → OAuth providers first.');
    e.status = 400;
    throw e;
  }

  const state = b64url(crypto.randomBytes(32));
  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());

  flows.set(state, {
    userKey: uKey,
    provider,
    loginHint: String(email || '').trim().toLowerCase(),
    codeVerifier,
    redirectUri,
    accountId,
    // Carried on the flow rather than re-derived at the callback: the token
    // exchange must request the SAME scope string the authorize step did, and
    // the account record may not exist yet to read it back off.
    features: Array.isArray(features) ? features : [],
    createdAt: Date.now(),
    status: 'pending',
  });

  const url = new URL(endpoints(provider).authorize);
  url.searchParams.set('client_id', c.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopesFor(provider, features).join(' '));
  url.searchParams.set('state', state);
  // PKCE is sent to Google too, even though its Web-application client also
  // requires the secret — it costs nothing and binds the code to this flow.
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (email) url.searchParams.set('login_hint', email);
  for (const [k, v] of Object.entries(p.authorizeParams || {})) url.searchParams.set(k, v);

  olog.info(`${provider}: sign-in started for ${email || '(no hint)'}`);
  return { authUrl: url.toString(), state };
}

async function postToken(provider, params) {
  const c = credsFor(provider);
  // Microsoft: no client_secret — it's a public client and PKCE is what binds
  // the code to the flow that started it, and sending a secret anyway against a
  // public-client registration is an error rather than a harmless extra.
  // Google: the "Web application" client is confidential and the secret is
  // mandatory (see trap (a) at the top).
  const body = new URLSearchParams({
    client_id: c.clientId,
    ...(PROVIDERS[provider].usesSecret && c.clientSecret ? { client_secret: c.clientSecret } : {}),
    ...params,
  });
  const res = await fetch(endpoints(provider).token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok || !json) {
    // The provider's own error codes are the only useful diagnostic here, and
    // they are not secret — surface them rather than a generic "failed".
    const raw = json?.error_description || json?.error || `Token endpoint returned HTTP ${res.status}`;
    const err = new Error(explainProviderError(raw));
    err.oauthError = json?.error || `http_${res.status}`;
    throw err;
  }
  return json;
}

/**
 * Microsoft's AADSTS messages are accurate but describe the Azure portal, not
 * what you do about it here. Each of these is a setup mistake that otherwise
 * costs a round trip through a browser sign-in to discover, so the fix goes
 * next to the diagnosis. The original text is kept — it carries the trace IDs
 * Microsoft support asks for.
 */
const AADSTS_HELP = [
  // The one that matters now: the right URI under the wrong platform. Azure
  // decides confidential-vs-public from which platform bucket the redirect URI
  // sits in, so this looks like "I registered it, why doesn't it work".
  [/AADSTS7000218|client_assertion.*client_secret|AADSTS7000215/,
    'Hmelj signs in as a public client, with no secret — but this redirect URI is registered under the "Web" platform, which requires one. In Azure → Authentication, delete the URI from the Web platform, then Add a platform → "Mobile and desktop applications" → Custom redirect URIs → paste the URI shown in Settings → Admin → OAuth providers. You can also delete the client secret afterwards; Hmelj never sends one.'],
  [/AADSTS9002327/,
    'This redirect URI is registered as a "Single-page application", which only accepts tokens redeemed from a browser. Hmelj redeems them on the server. In Azure → Authentication, move the URI to the "Mobile and desktop applications" platform instead.'],
  [/AADSTS700016|AADSTS900023/,
    'Azure does not recognise that Application (client) ID for this tenant. Check the client ID, and the Tenant setting (use "common" unless you registered a single-tenant app).'],
  [/AADSTS50011|AADSTS500113/,
    'The redirect URI does not match the app registration. Copy the exact URI shown in Settings → Admin → OAuth providers into Azure → Authentication → Add a platform → Mobile and desktop applications → Custom redirect URIs. It has to match byte for byte, including https:// and any trailing path.'],
  [/AADSTS65001|AADSTS900144.*scope/,
    'The app has not been granted the permissions it asked for. In Azure → API permissions add the Microsoft Graph delegated permissions Mail.ReadWrite, Mail.Send, Contacts.Read and offline_access, then sign in again so they are consented to.'],

  // ---- Google. Same idea: its errors are accurate but describe the Cloud
  // console, and every one of these costs a browser round trip to discover.
  [/redirect_uri_mismatch/,
    'Google does not recognise this redirect URI. Copy the exact URI shown in Settings → Admin → OAuth providers into Google Cloud console → APIs & Services → Credentials → your OAuth client → Authorized redirect URIs. It has to match byte for byte, including https:// and the /oauth/callback path.'],
  [/client_secret is missing|Client secret is missing|invalid_client/,
    'Google rejected the client credentials. A Gmail sign-in needs an OAuth client of type "Web application" AND its client secret pasted into Settings → Admin → OAuth providers — unlike Microsoft, Google\'s server-side flow has no secret-less variant. Check both values, and that the client has not been deleted in the Cloud console.'],
  [/access_denied/,
    'The sign-in was refused. If Google showed the "Google hasn\'t verified this app" screen, choose Advanced → "Go to … (unsafe)" to continue — Hmelj is your own app registration, not a third party. If the consent screen is still in "Testing", your address also has to be listed under Audience → Test users.'],
  [/admin_policy_enforced|org_internal/,
    'A Google Workspace administrator has blocked this app for the account. In the Workspace admin console the app has to be trusted (Security → API controls → App access control), or the account has to be in a group allowed to grant the https://mail.google.com/ scope.'],
  [/invalid_scope/,
    'Google would not grant https://mail.google.com/. Add that scope on the OAuth consent screen (it is listed as a restricted scope — that is expected and does not need verification for your own use), then sign in again.'],
];

/** invalid_grant on a REFRESH is provider-specific in the one way that matters:
 *  for Google it is most often the 7-day refresh-token expiry that a consent
 *  screen left in "Testing" imposes, which has a one-click fix nobody guesses. */
function reauthAdvice(provider) {
  if (provider === 'google') {
    return ' If this keeps happening every week, the Google OAuth consent screen is still in "Testing" — Google expires those refresh tokens after 7 days. Set its publishing status to "In production" in the Google Cloud console; it does not need verification for your own use.';
  }
  return '';
}

function explainProviderError(raw) {
  const hit = AADSTS_HELP.find(([re]) => re.test(raw));
  return hit ? `${hit[1]}\n\n(Provider said: ${raw})` : raw;
}

/** The `email` claim out of an id_token. Read without verifying the signature
 *  on purpose: this came straight back from the provider's token endpoint over
 *  TLS on a connection we opened, so it is not attacker-supplied — the usual
 *  reason to verify (accepting a token handed to you by a client) does not
 *  apply. Used only to display and cross-check the address, never for authz. */
function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return String(payload.email || payload.preferred_username || payload.upn || '').toLowerCase();
  } catch { return ''; }
}

function tokensFromResponse(json, prevRefresh = '') {
  return {
    accessToken: json.access_token,
    // Microsoft rotates the refresh token on EVERY refresh. Dropping the new
    // one leaves the account authenticating with a token that stops working
    // within the hour, which looks exactly like "OAuth randomly broke".
    // Google is the opposite — it returns no refresh_token on a refresh at all
    // and expects the original to be reused indefinitely — which is exactly
    // what the fallback below does, so one code path covers both.
    refreshToken: json.refresh_token || prevRefresh,
    expiresAt: Date.now() + Math.max(60, Number(json.expires_in) || 3600) * 1000,
    scope: json.scope || '',
  };
}

/** The /oauth/callback handler's whole job. Never throws for an ordinary
 *  provider-side failure — the outcome is recorded on the flow so the waiting
 *  page can display it. */
export async function handleCallback({ code, state, error, errorDescription }) {
  const f = flows.get(state);
  if (!f) return { ok: false, error: 'This sign-in link has expired or was already used. Start again from Hmelj.' };
  if (f.status !== 'pending') return { ok: false, error: 'This sign-in was already completed.' };

  if (error) {
    f.status = 'error';
    f.error = explainProviderError(errorDescription || error);
    olog.warn(`${f.provider}: sign-in rejected by provider — ${error}`);
    return { ok: false, error: f.error };
  }
  if (!code) {
    f.status = 'error';
    f.error = 'The provider did not return an authorization code.';
    return { ok: false, error: f.error };
  }

  try {
    const json = await postToken(f.provider, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: f.redirectUri,
      code_verifier: f.codeVerifier,
      scope: scopesFor(f.provider, f.features || []).join(' '),
    });
    const tokens = tokensFromResponse(json);
    if (!tokens.refreshToken) {
      f.status = 'error';
      f.error = f.provider === 'google'
        ? 'Google did not return a refresh token, so Hmelj could not stay signed in past the first hour. That happens when the authorization request is not marked offline or consent was not re-shown — sign in again, and if it repeats, remove Hmelj from myaccount.google.com/permissions first so Google asks for consent from scratch.'
        : 'The provider did not return a refresh token, so Hmelj could not stay signed in. Check that the offline_access scope is granted to the app registration.';
      return { ok: false, error: f.error };
    }
    const email = emailFromIdToken(json.id_token) || f.loginHint;
    // Signing in as a different mailbox than the one being configured would
    // silently attach the wrong account — Graph would work fine and simply
    // show someone else's mail.
    if (f.loginHint && email && email !== f.loginHint) {
      f.status = 'error';
      f.error = `You signed in as ${email}, but this account is being set up for ${f.loginHint}. Start again and pick the right account.`;
      olog.warn(`${f.provider}: address mismatch on sign-in`);
      return { ok: false, error: f.error };
    }

    f.tokens = tokens;
    f.email = email;
    f.status = 'ok';
    olog.info(`${f.provider}: sign-in completed for ${email}`);
    return { ok: true, email };
  } catch (e) {
    f.status = 'error';
    f.error = e.message;
    olog.warn(`${f.provider}: token exchange failed — ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** Polled by the page waiting on the popup/Custom Tab. Owner-checked so one
 *  Hmelj user cannot watch (or steal the result of) another's sign-in. */
export function flowStatus(state, uKey) {
  const f = flows.get(state);
  if (!f || f.userKey !== uKey) return { status: 'unknown' };
  return { status: f.status, email: f.email || '', error: f.error || '', accountId: f.accountId || null };
}

/**
 * Hand the tokens over to whoever is writing the account record.
 * Deliberately NOT single-use: the wizard runs "Test & save", which reads this
 * twice (once for the connection probe, once for the actual save). The flow is
 * marked used only once an account has been written, via markFlowConsumed().
 */
export function takeFlowTokens(state, uKey) {
  // status 400, not an unhandled 500: an expired or already-spent sign-in is
  // an ordinary thing for a user to run into (they left the wizard open over
  // lunch), and index.js's wrap() turns a status-carrying error into a clean
  // message instead of a logged stack trace.
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  const f = flows.get(state);
  if (!f || f.userKey !== uKey) throw bad('That sign-in has expired or was already used — please sign in again.');
  if (f.status !== 'ok') throw bad(f.error || 'Sign-in has not completed yet.');
  // `features` rides along so whoever writes the account record stores WHICH
  // extra scopes this sign-in was consented to. Without it, the next refresh
  // asks for the base set again (see refresh()) and quietly drops calendar or
  // contact access an hour later.
  return { provider: f.provider, email: f.email, accountId: f.accountId, features: f.features || [], ...f.tokens };
}

export function markFlowConsumed(state) {
  flows.delete(state);
}

/* ---------------- access tokens ---------------- */

// `${ownerKey}:${accountId}` -> { accessToken, expiresAt, inflight }
// An access token lives ~1h; without this cache every Graph request would burn
// a token request alongside it.
const tokenCache = new Map();
const REFRESH_SKEW_MS = 120e3;

export class OAuthReauthRequired extends Error {
  constructor(message) {
    super(message);
    this.name = 'OAuthReauthRequired';
    this.needsReauth = true;
    this.status = 401;
  }
}

/**
 * A usable access token for a decrypted account record (accounts.js#getAccount
 * has already turned graph.refreshToken/accessToken back into plaintext).
 *
 * `ownerKey` is where the rotated refresh token gets written back. For a
 * SHARED account that is the owner's key, not the viewer's — which is exactly
 * what currentUser().userKey already holds, because requireAuth swaps the ALS
 * context to the owner for shared accounts.
 */
export async function accessTokenFor(acc, ownerKey) {
  const tok = tokenBlock(acc);
  if (tok?.needsReauth) {
    // The advice belongs here too, not only on the refresh that first failed:
    // that one happens in the background (a sync tick, usually), so its message
    // lands in the log, and THIS is the error the user actually reads.
    throw new OAuthReauthRequired(`${acc.label || acc.email}: sign-in has expired. Open Settings → Accounts and sign in again.${reauthAdvice(tok.provider)}`);
  }
  const key = `${ownerKey}:${acc.id}`;
  const entry = tokenCache.get(key);
  const now = Date.now();

  if (entry?.accessToken && entry.expiresAt - REFRESH_SKEW_MS > now) return entry.accessToken;
  // A burst of requests (interactive load + sync tick + the inbox watcher all
  // landing together) must produce exactly one token request, not three.
  if (entry?.inflight) return entry.inflight;

  // The token the account was created/refreshed with is often still good —
  // no need to spend a round trip before the first use.
  if (tok?.accessToken && tok.expiresAt - REFRESH_SKEW_MS > now) {
    tokenCache.set(key, { accessToken: tok.accessToken, expiresAt: tok.expiresAt });
    return tok.accessToken;
  }

  const inflight = (async () => {
    try {
      const tokens = await refresh(acc, ownerKey);
      tokenCache.set(key, { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt });
      return tokens.accessToken;
    } catch (e) {
      tokenCache.delete(key);
      throw e;
    }
  })();
  tokenCache.set(key, { ...(entry || {}), inflight });
  return inflight;
}

/** Trade the refresh token for a new access token, persisting the rotated
 *  refresh token. Exported for tests, and called by graphClient.js when Graph
 *  answers 401 on a token the cache still believed in. */
export async function refresh(acc, ownerKey) {
  const tok = tokenBlock(acc);
  const provider = tok?.provider;
  const prevRefresh = tok?.refreshToken;
  if (!provider || !prevRefresh) {
    throw new OAuthReauthRequired(`${acc.label || acc.email}: no stored sign-in. Open Settings → Accounts and sign in again.`);
  }
  let json;
  try {
    json = await postToken(provider, {
      grant_type: 'refresh_token',
      refresh_token: prevRefresh,
      // This account's own scopes, not the provider's base list. An account
      // that consented to calendar or contact access would otherwise be
      // narrowed back to the base set on its next refresh — an hour after it
      // was set up, silently, with the feature simply starting to 403.
      scope: scopesFor(provider, featuresOf(acc)).join(' '),
    });
  } catch (e) {
    // invalid_grant is terminal: the user revoked consent, changed their
    // password, or the token simply aged out. Retrying forever would hammer
    // the provider, so flag it and make the UI ask for a fresh sign-in.
    if (e.oauthError === 'invalid_grant') {
      updateOAuthTokens(ownerKey, acc.id, { needsReauth: true });
      olog.warn(`${acc.label || acc.email}: refresh token rejected (${e.message}) — re-authentication required`);
      throw new OAuthReauthRequired(`${acc.label || acc.email}: sign-in has expired. Open Settings → Accounts and sign in again.${reauthAdvice(provider)}`);
    }
    throw e;
  }
  const tokens = tokensFromResponse(json, prevRefresh);
  updateOAuthTokens(ownerKey, acc.id, {
    accessToken: encrypt(tokens.accessToken),
    refreshToken: encrypt(tokens.refreshToken),
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
    needsReauth: false,
  });
  olog.debug(`${acc.label || acc.email}: access token refreshed`);
  return tokens;
}

/** Drop cached tokens for an account — after a re-auth, a delete, or a 401
 *  that means the cached token died early (revoked, password changed). */
export function forgetTokens(ownerKey, accountId) {
  tokenCache.delete(`${ownerKey}:${accountId}`);
}
