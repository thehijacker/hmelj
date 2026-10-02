// Hmelj — Microsoft Graph mail client, mirroring imapClient.js's flat
// function-module shape so server/mailClient.js can dispatch to it
// transparently (see that file). Talks REST/JSON over HTTPS with an OAuth2
// bearer token from server/oauth.js — no IMAP, no SMTP, no EWS.
//
// Why Graph and not IMAP-with-an-OAuth-token: IMAP has to be switched on for
// the mailbox itself, it is off by default on personal Outlook.com accounts,
// and Exchange's refusal ("User is authenticated but not connected.") is
// indistinguishable from half a dozen other failures. Graph never touches that
// stack. temp/office365_graph_pkce.js proved the whole thing works on this
// deployment's target mailbox with just Mail.ReadWrite + Mail.Send +
// offline_access.
//
// Three structural differences from IMAP this file bridges on its own,
// invisibly to every caller (sync.js/index.js/filters.js just see `path`s and
// `uid`s, exactly as with IMAP and EWS):
//
//  - Graph folders are an id/parentFolderId tree with a displayName, not a
//    delimited path string. listFolders() synthesizes Hmelj-style
//    {path, name, parent} records (delimiter '/') and keeps an internal
//    path -> id map (folderCache) so every other function can resolve a path
//    back to a real folder id. The well-known folders get their path forced to
//    the fixed, capitalized convention ('INBOX'/'Sent'/'Drafts'/'Trash'/
//    'Junk'/'Archive') regardless of the mailbox's actual (possibly localized)
//    displayName — same as ewsClient.js does, and for the same reason: app.js,
//    sync.js and scope.js hardcode the literal 'INBOX'.
//
//  - A message's `uid` here is its Graph message id — a long opaque string,
//    not an integer. cache.js already stores uid as TEXT and already routes
//    non-numeric id spaces to its exact-set-difference prune, so nothing there
//    needed changing. What it does mean is that cache.getMaxUid()'s
//    "highest uid so far" is meaningless, hence listNewMessages() below.
//
//  - There is no MIME parser here, and deliberately so.
//    GET /me/messages/{id}/$value returns the entire raw RFC822 message, so
//    getMessage/getMessageHeaders/getAttachment stay thin wrappers over
//    messageParse.js exactly as they are for IMAP and EWS — no second
//    JSON-to-message translation to keep in sync. The send path is the mirror
//    image: POST /me/sendMail accepts base64-encoded MIME, so smtpClient.js's
//    existing nodemailer MailComposer output goes out unchanged.
import { currentUser } from './session.js';
import { currentAccount } from './accounts.js';
import { sortFolderTree } from './folderTree.js';
import { parseMessage, parseHeadersBlock, parseAttachment } from './messageParse.js';
import { threadKeyFrom, normalizeId } from './threading.js';
import { store } from './store.js';
import { log } from './log.js';
import { parseSearchQuery } from './searchQuery.js';
import * as oauth from './oauth.js';

const glog = log.scope('graph');

// Overridable only so the test suite can point at test/mock-graph-server.js.
// Never set in normal operation.
const BASE = () => (process.env.HMELJ_GRAPH_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '');

const REQUEST_TIMEOUT_MS = 30e3;   // matches imapClient's socketTimeout and ewsClient's own
const MAX_RETRIES = 3;             // for 429/5xx only
const BATCH_SIZE = 20;             // Graph's hard limit for $batch, and one batch counts as one request

function acctKey(acc) {
  return `${currentUser().userKey}:${acc.id}`;
}

/**
 * Graph ids are base64-ish and routinely contain '/', '+' and '=' — dropping
 * one into a URL path unescaped silently changes the path's shape, and the
 * request then 404s or, worse, addresses a different resource. Every id that
 * goes into a URL below goes through here.
 */
const eid = (id) => encodeURIComponent(String(id));

// ---------- transport ----------

/**
 * Turns a Graph error body into something a self-hoster can act on. A 403 here
 * is nearly always a missing delegated permission on the app registration, and
 * Graph's own wording ("Access is denied. Check credentials and try again.")
 * sends people off to re-check the sign-in, which is the one thing that is
 * working.
 */
function graphError(status, json, text, url) {
  const detail = json?.error?.message || text?.slice(0, 300) || `HTTP ${status}`;
  const code = json?.error?.code || '';
  if (status === 403) {
    const e = new Error(
      `Microsoft refused this request (${detail}). That is almost always a missing permission rather than a bad sign-in: in Azure → your app registration → API permissions, add the Microsoft Graph DELEGATED permissions Mail.ReadWrite, Mail.Send and Contacts.Read, then sign in again from Settings → Accounts so the new permissions are consented to. Live contact sync additionally needs Contacts.ReadWrite, which is requested only for accounts where you turn it on.`
    );
    e.status = 400;
    e.graphCode = code;
    return e;
  }
  if (status === 404) {
    const e = new Error(`Not found on the server (${detail}).`);
    e.status = 404;
    e.graphCode = code;
    e.notFound = true;
    return e;
  }
  const e = new Error(`Microsoft Graph ${status}: ${detail}`);
  e.status = status >= 400 && status < 500 ? 400 : 502;
  e.graphCode = code;
  return e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Seconds from a Retry-After header (Graph always sends one on 429), with a
 *  sane cap so a hostile/garbled value can't park a request for an hour. */
function retryAfterMs(res, attempt) {
  const raw = Number(res.headers.get('retry-after'));
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 60) * 1000;
  return Math.min(1000 * 2 ** attempt, 8000);
}

/**
 * One Graph call. `path` is relative to /v1.0 (e.g. '/me/messages'), or an
 * absolute URL when following an @odata.nextLink.
 *
 * Handles the two failure modes that are normal rather than exceptional:
 *   429/503/504 — back off per Retry-After and retry
 *   401         — the cached access token died before its expiry said it would
 *                 (consent revoked, password changed, token revoked). Drop it,
 *                 force one refresh, retry once. A second 401 is real.
 */
async function gfetch(path, { method = 'GET', body, headers = {}, raw = false, contentType = 'application/json' } = {}) {
  const acc = currentAccount();
  const uKey = currentUser().userKey;
  const url = /^https?:/i.test(path) ? path : BASE() + path;

  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const token = await oauth.accessTokenFor(acc, uKey);
    const ctl = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method,
        signal: ctl,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': contentType } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`Microsoft Graph timed out after ${REQUEST_TIMEOUT_MS / 1000}s (${method} ${path})`);
      throw e;
    }

    if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < MAX_RETRIES) {
      const wait = retryAfterMs(res, attempt);
      glog.debug(`${res.status} on ${method} ${path} — retrying in ${wait}ms`);
      await sleep(wait);
      continue;
    }

    if (res.status === 401 && !refreshed) {
      // Not a permissions problem — the token itself is dead early. One forced
      // refresh, then believe the second answer.
      refreshed = true;
      oauth.forgetTokens(uKey, acc.id);
      await oauth.refresh(acc, uKey).catch(() => {});
      continue;
    }

    if (res.status === 204 || res.status === 202) return null;

    if (raw) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) throw graphError(res.status, null, buf.toString('utf8'), url);
      return buf;
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
    if (!res.ok) throw graphError(res.status, json, text, url);
    return json;
  }
}

/**
 * $batch — up to 20 operations per HTTP request, and the whole batch counts as
 * one against Graph's throttle. Requests carry ids; responses come back in
 * arbitrary order, so this re-associates them and returns an array aligned
 * with the input.
 *
 * `tolerate` lists per-item HTTP statuses that are NOT errors for the caller
 * (404 for refreshFlags, where a message legitimately vanished between the
 * listing and the flag refresh).
 */
async function gbatch(requests, { tolerate = [] } = {}) {
  const out = [];
  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    const chunk = requests.slice(i, i + BATCH_SIZE);
    const payload = {
      requests: chunk.map((r, n) => {
        const req = { id: String(n), method: r.method || 'GET', url: r.url };
        // A $batch sub-request with a body MUST declare its content type
        // inside the batch — the outer request's header does not apply to it.
        if (r.body !== undefined) {
          req.body = r.body;
          req.headers = { 'Content-Type': 'application/json', ...(r.headers || {}) };
        } else if (r.headers) {
          req.headers = r.headers;
        }
        return req;
      }),
    };
    const res = await gfetch('/$batch', { method: 'POST', body: payload });
    const byId = new Map((res?.responses || []).map((r) => [String(r.id), r]));
    for (let n = 0; n < chunk.length; n++) {
      const r = byId.get(String(n));
      if (!r) throw new Error('Microsoft Graph $batch: missing response for one of the requests');
      if (r.status >= 400 && !tolerate.includes(r.status)) {
        throw graphError(r.status, r.body, JSON.stringify(r.body || {}), chunk[n].url);
      }
      out.push(r.status >= 400 ? null : (r.body ?? null));
    }
  }
  return out;
}

/** Pages an OData collection through @odata.nextLink. */
async function gpage(firstPath, { maxPages = 50, headers } = {}) {
  const items = [];
  let next = firstPath;
  for (let page = 0; page < maxPages && next; page++) {
    const res = await gfetch(next, { headers });
    items.push(...(res?.value || []));
    next = res?.['@odata.nextLink'] || null;
  }
  return items;
}

// ---------- folder tree + path resolution ----------

// Graph addresses the well-known folders by these fixed names, exactly as EWS
// does with DistinguishedFolderId — they are protocol constants, not something
// to auto-detect the way IMAP's specialUse flags are.
const WELL_KNOWN = ['inbox', 'sentitems', 'drafts', 'deleteditems', 'junkemail', 'archive'];
// Forced to this fixed, capitalized convention regardless of the mailbox's
// real (possibly localized) displayName — see the file-level comment. 'INBOX'
// specifically (not 'Inbox') is not a style choice: app.js and sync.js hardcode
// the literal all-caps string as THE inbox path for every account regardless of
// protocol, so this is the one name that has to match exactly.
const WELL_KNOWN_PATH = {
  inbox: 'INBOX', sentitems: 'Sent', drafts: 'Drafts',
  deleteditems: 'Trash', junkemail: 'Junk', archive: 'Archive',
};
const WELL_KNOWN_SPECIAL_USE = {
  inbox: '\\Inbox', sentitems: '\\Sent', drafts: '\\Drafts',
  deleteditems: '\\Trash', junkemail: '\\Junk', archive: '\\Archive',
};

const FOLDER_SELECT = 'id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount';

const folderCache = new Map();     // `${userKey}:${accountId}` -> { byPath: Map<path,id>, byId: Map<id,path> }
const wellKnownCache = new Map();  // `${userKey}:${accountId}` -> { [name]: id }

/** The six well-known folder ids, in one $batch. Cached for the process: a
 *  mailbox's Inbox does not get a new id. */
async function resolveWellKnown(acc) {
  const key = acctKey(acc);
  const hit = wellKnownCache.get(key);
  if (hit) return hit;
  const bodies = await gbatch(
    WELL_KNOWN.map((n) => ({ url: `/me/mailFolders/${n}?$select=id` })),
    // Archive does not exist on every mailbox, and a personal account without
    // it should not fail the entire folder listing.
    { tolerate: [404] },
  );
  const map = {};
  WELL_KNOWN.forEach((n, i) => { if (bodies[i]?.id) map[n] = bodies[i].id; });
  wellKnownCache.set(key, map);
  return map;
}

/**
 * The whole mail folder tree, flattened into Hmelj's {path,...} records.
 *
 * Graph only returns one level at a time (there is no $expand that walks the
 * whole hierarchy), so this descends level by level, asking for every folder
 * that reported childFolderCount > 0 in a single $batch per level. A normal
 * mailbox is one or two levels deep, so that is two or three HTTP requests.
 * Hidden/system folders (Sync Issues and friends) are excluded by Graph itself
 * unless includeHiddenFolders=true is asked for, which is why there is no
 * PR_ATTR_HIDDEN dance here like ewsClient.js needs.
 */
export async function listFolders() {
  const acc = currentAccount();
  const t0 = Date.now();
  const wellKnown = await resolveWellKnown(acc);
  const idToWellKnownName = new Map(Object.entries(wellKnown).map(([name, id]) => [id, name]));

  const raw = await gpage(`/me/mailFolders?$top=100&$select=${FOLDER_SELECT}`);
  const all = [...raw];
  const seen = new Set(all.map((f) => f.id));
  let frontier = all.filter((f) => (f.childFolderCount || 0) > 0);
  for (let depth = 0; depth < 10 && frontier.length; depth++) {
    const results = await gbatch(frontier.map((f) => ({
      url: `/me/mailFolders/${eid(f.id)}/childFolders?$top=100&$select=${FOLDER_SELECT}`,
    })));
    const children = results.flatMap((r) => r?.value || []).filter((f) => f.id && !seen.has(f.id));
    for (const c of children) { seen.add(c.id); all.push(c); }
    frontier = children.filter((f) => (f.childFolderCount || 0) > 0);
  }

  const byId = new Map();
  for (const f of all) {
    const wk = idToWellKnownName.get(f.id);
    byId.set(f.id, {
      id: f.id,
      parentId: f.parentFolderId || null,
      displayName: wk ? WELL_KNOWN_PATH[wk] : (f.displayName || 'Untitled'),
      specialUse: wk ? WELL_KNOWN_SPECIAL_USE[wk] : null,
      total: Number(f.totalItemCount) || 0,
      unseen: Number(f.unreadItemCount) || 0,
    });
  }

  const hidden = new Set(acc.hiddenFolders || []);
  function pathFor(id, guard = new Set()) {
    const f = byId.get(id);
    if (!f || guard.has(id)) return null; // orphaned parent, or a cycle — treat as top-level rather than loop
    guard.add(id);
    const parentPath = f.parentId ? pathFor(f.parentId, guard) : null;
    return parentPath ? `${parentPath}/${f.displayName}` : f.displayName;
  }

  const byPath = new Map();
  const byIdPath = new Map();
  const folders = [...byId.values()].map((f) => {
    const path = pathFor(f.id);
    byPath.set(path, f.id);
    byIdPath.set(f.id, path);
    const parentPath = f.parentId ? pathFor(f.parentId) : null;
    return {
      path, name: f.displayName, delimiter: '/', parent: parentPath,
      specialUse: f.specialUse, subscribed: true, hidden: hidden.has(path),
      total: f.total, unseen: f.unseen,
    };
  });

  folderCache.set(acctKey(acc), { byPath, byId: byIdPath });
  const result = sortFolderTree(folders);
  glog.debug(`listFolders: ${result.length} folders (${Date.now() - t0}ms)`);
  return result;
}

/** Resolves a Hmelj path string back to a real Graph folder id — the
 *  counterpart to listFolders()'s path synthesis. Falls back to a fresh
 *  listFolders() when the path isn't cached yet (first call this process, or a
 *  folder created since the last refresh). */
async function resolveFolderId(path) {
  const acc = currentAccount();
  let entry = folderCache.get(acctKey(acc));
  if (!entry || !entry.byPath.has(path)) {
    await listFolders();
    entry = folderCache.get(acctKey(acc));
  }
  const id = entry?.byPath.get(path);
  if (!id) throw new Error(`Mailbox folder not found: ${path}`);
  return id;
}

function invalidateFolders(acc) {
  folderCache.delete(acctKey(acc));
}

export async function folderStatus(path) {
  const id = await resolveFolderId(path);
  const f = await gfetch(`/me/mailFolders/${eid(id)}?$select=totalItemCount,unreadItemCount`);
  return { total: Number(f?.totalItemCount) || 0, unseen: Number(f?.unreadItemCount) || 0 };
}

export async function createFolder(path) {
  const acc = currentAccount();
  const parts = String(path).split('/');
  const name = parts.pop();
  const parentPath = parts.join('/');
  const url = parentPath ? `/me/mailFolders/${eid(await resolveFolderId(parentPath))}/childFolders` : '/me/mailFolders';
  const created = await gfetch(url, { method: 'POST', body: { displayName: name } });
  invalidateFolders(acc);
  return created;
}

export async function deleteFolder(path) {
  const acc = currentAccount();
  const id = await resolveFolderId(path);
  await gfetch(`/me/mailFolders/${eid(id)}`, { method: 'DELETE' });
  invalidateFolders(acc);
  return { ok: true };
}

export async function renameFolder(path, newPath) {
  const acc = currentAccount();
  const id = await resolveFolderId(path);
  const oldParent = String(path).split('/').slice(0, -1).join('/');
  const parts = String(newPath).split('/');
  const name = parts.pop();
  const newParent = parts.join('/');
  const result = await gfetch(`/me/mailFolders/${eid(id)}`, { method: 'PATCH', body: { displayName: name } });
  // Unlike IMAP's single RENAME, moving between parents is a separate call in
  // Graph — but the Hmelj UI expresses both as "rename to this new path", so
  // both have to happen here or moving a folder elsewhere would silently only
  // change its name. 'msgfolderroot' is Graph's name for the mailbox root.
  if (newParent !== oldParent) {
    const destinationId = newParent ? await resolveFolderId(newParent) : 'msgfolderroot';
    await gfetch(`/me/mailFolders/${eid(id)}/move`, { method: 'POST', body: { destinationId } });
  }
  invalidateFolders(acc);
  return result;
}

/** Every message id in a folder, up to `cap`. Ids only — deliberately not
 *  routed through listMessages(), which would pull full envelopes for every
 *  message just to read the ids back off them. */
async function idsIn(folderId, { filter = '', cap = 5000 } = {}) {
  const q = `/me/mailFolders/${eid(folderId)}/messages?$top=100&$select=id${filter ? `&$filter=${encodeURIComponent(filter)}` : ''}`;
  const items = await gpage(q, { maxPages: Math.ceil(cap / 100) });
  return items.map((m) => m.id).filter(Boolean).slice(0, cap);
}

/**
 * imapClient.js#findOlderThan on Graph. idsIn already takes a $filter and
 * already pages, so this is that one filter.
 *
 * `receivedDateTime lt` against an ISO instant — Graph compares the full
 * timestamp, where IMAP's BEFORE compares only the date. The caller passes
 * midnight of the chosen day, which makes the two agree: everything delivered
 * before that day starts.
 */
export async function findOlderThan(path, before) {
  const id = await resolveFolderId(path);
  return idsIn(id, { filter: `receivedDateTime lt ${new Date(before).toISOString()}` });
}

export async function emptyFolder(path) {
  const id = await resolveFolderId(path);
  const ids = await idsIn(id);
  if (!ids.length) return { deleted: 0 };
  await gbatch(ids.map((mid) => ({ method: 'DELETE', url: `/me/messages/${eid(mid)}` })), { tolerate: [404] });
  return { deleted: ids.length };
}

export async function markAllRead(path) {
  const id = await resolveFolderId(path);
  // Capped like ewsClient.js's own markAllRead: a mailbox with 50k unread
  // messages should mark what it reasonably can rather than spend minutes
  // paging before doing anything at all.
  const uids = await idsIn(id, { filter: 'isRead eq false', cap: 1000 });
  if (!uids.length) return { marked: 0, uids: [] };
  await setFlags(path, uids, { add: ['\\Seen'] });
  return { marked: uids.length, uids };
}

// ---------- search ----------

// KQL property restrictions for searchQuery.js's four scoped fields. Note the
// unscoped list deliberately EXCLUDES body, matching imapClient.js's
// termToSearchObject and ewsClient.js's UNSCOPED_EWS_FIELDS: only an explicit
// body:/-body: term searches message text, and that is precisely the query
// shape searchQuery.js#queryNeedsBodySearch uses to decide a live round-trip is
// needed at all instead of answering from the SQLite cache.
const KQL_FIELD = { from: 'from', to: 'to', subject: 'subject', body: 'body' };
const UNSCOPED_KQL_FIELDS = ['subject', 'from', 'to'];

/** KQL needs quotes around anything with a space, and has no escape for a
 *  double quote inside a quoted phrase — so drop those rather than emit a
 *  query string the service will reject outright. */
function kqlValue(text) {
  return `"${String(text).replace(/"/g, ' ').trim()}"`;
}

function termToKql({ field, text }, fullText = false) {
  const v = kqlValue(text);
  if (!v || v === '""') return '';
  if (field && KQL_FIELD[field]) return `${KQL_FIELD[field]}:${v}`;
  // "Search everywhere" (server/index.js's scope=account branch): a bare KQL
  // term with no field prefix is matched against the whole item, body included
  // — which is exactly what the user asked for there. See imapClient.js's own
  // termToSearchObject for the same distinction.
  if (fullText) return v;
  return `(${UNSCOPED_KQL_FIELDS.map((f) => `${f}:${v}`).join(' OR ')})`;
}

/** searchQuery.js's +/-/"..."/field: syntax → one KQL string, or '' for an
 *  empty query. */
function buildKqlSearch(query, fullText = false) {
  const { required, excluded } = parseSearchQuery(query);
  const parts = [
    ...required.map((t) => termToKql(t, fullText)).filter(Boolean),
    ...excluded.map((t) => { const k = termToKql(t, fullText); return k ? `NOT ${k}` : ''; }).filter(Boolean),
  ];
  return parts.join(' AND ');
}

// ---------- message list ----------

const MESSAGE_SELECT = 'id,subject,from,toRecipients,receivedDateTime,isRead,flag,isDraft,hasAttachments,conversationId,internetMessageId';

function toGraphEnvelope(m) {
  const from = m.from?.emailAddress || m.sender?.emailAddress || null;
  return {
    uid: m.id,
    subject: m.subject || '(no subject)',
    from: from ? { name: from.name || '', address: from.address || '' } : null,
    to: (m.toRecipients || []).map((r) => ({ name: r.emailAddress?.name || '', address: r.emailAddress?.address || '' })),
    date: m.receivedDateTime || null,
    internalDate: m.receivedDateTime || null, // already the received time — see ewsClient's note
    seen: !!m.isRead,
    flagged: (m.flag?.flagStatus || '') === 'flagged',
    // Graph exposes "was replied to" only as the MAPI PidTagLastVerbExecuted
    // extended property, which would cost an extra $expand on every listing for
    // a flag nothing in Hmelj acts on — left false, exactly as ewsClient.js
    // does, rather than paying for it speculatively.
    answered: false,
    // Graph exposes no reply/forward marker on the message resource. Exchange
    // itself has one — PidTagLastVerbExecuted, which ewsClient.js reads and
    // writes — reachable here only through singleValueExtendedProperties on
    // every request. Not wired up: this codebase has no Graph account to verify
    // it against, and guessing at it would be worse than plainly not having it.
    forwarded: false,
    // Being *in* Deleted Items is Exchange's "deleted" state; there is no
    // per-message deleted flag equivalent to IMAP's \Deleted.
    deleted: false,
    draft: !!m.isDraft,
    // Graph's v1.0 message resource has no size property. 0 is the documented
    // fallback the envelope contract already allows (imapClient.js uses it too
    // when the server omits RFC822.SIZE).
    size: 0,
    hasAttachment: !!m.hasAttachments,
    // Conversation grouping (see server/threading.js). Graph does the
    // threading itself and hands back a stable conversationId, which beats
    // anything reconstructed from References: it survives a changed subject,
    // a client that strips headers, and messages moved between folders.
    messageId: normalizeId(m.internetMessageId),
    threadKey: threadKeyFrom({ conversationId: m.conversationId, messageId: m.internetMessageId }),
  };
}

/**
 * A page of a folder, newest first.
 *
 * Two request shapes, because Graph will not combine them:
 *  - no query → $filter (for unreadOnly) + $orderby=receivedDateTime desc,
 *    which is a true chronological page, and $count for an exact total.
 *  - a query → $search with a KQL string. Graph rejects $orderby and $filter
 *    alongside $search and returns results in RELEVANCE order, so the page is
 *    re-sorted by date here and unreadOnly is applied in process. Within a page
 *    that is exactly right; across a deep search paging the set can differ from
 *    a strict date ordering. That is a real limitation, and an acceptable one:
 *    Hmelj answers every non-body search from the SQLite cache already (see
 *    searchQuery.js#queryNeedsBodySearch), so this path is reached almost only
 *    for explicit body: searches.
 */
export async function listMessages(path, { page = 1, pageSize = 50, query = '', unreadOnly = false, flaggedOnly = false, fullText = false } = {}) {
  const t0 = Date.now();
  const folderId = await resolveFolderId(path);
  const offset = Math.max(0, (page - 1) * pageSize);
  const search = buildKqlSearch(query, fullText);

  let messages;
  let total;

  if (search) {
    const url = `/me/mailFolders/${eid(folderId)}/messages`
      + `?$top=${pageSize}&$skip=${offset}&$select=${MESSAGE_SELECT}`
      + `&$search=${encodeURIComponent(`"${search.replace(/"/g, '\\"')}"`)}`;
    const res = await gfetch(url, { headers: { ConsistencyLevel: 'eventual' } });
    let items = res?.value || [];
    if (unreadOnly) items = items.filter((m) => !m.isRead);
    if (flaggedOnly) items = items.filter((m) => (m.flag?.flagStatus || '') === 'flagged');
    items.sort((a, b) => new Date(b.receivedDateTime || 0) - new Date(a.receivedDateTime || 0));
    messages = items.map(toGraphEnvelope);
    // $search gives no usable count. Report "at least this many", which is what
    // the pager needs to decide whether a next page exists.
    total = offset + messages.length + (res?.['@odata.nextLink'] ? pageSize : 0);
  } else {
    // $filter is a single parameter, so two active filters have to be ANDed into
    // one expression rather than appended twice (Graph 400s on a repeated $filter).
    const filterParts = [];
    if (unreadOnly) filterParts.push('isRead eq false');
    if (flaggedOnly) filterParts.push("flag/flagStatus eq 'flagged'");
    const filter = filterParts.length ? '&$filter=' + encodeURIComponent(filterParts.join(' and ')) : '';
    const base = `/me/mailFolders/${eid(folderId)}/messages`
      + `?$top=${pageSize}&$skip=${offset}&$orderby=receivedDateTime%20desc`
      + `&$select=${MESSAGE_SELECT}${filter}`;
    // $count gives an exact total in the same round trip. It is documented for
    // Outlook resources but rejected by some mailbox configurations, and a
    // pager total is not worth failing the whole listing over — so ask for it,
    // and fall back to the folder's own counts if the request is refused.
    let res;
    try {
      res = await gfetch(`${base}&$count=true`, { headers: { ConsistencyLevel: 'eventual' } });
    } catch (e) {
      if (e.status !== 400) throw e;
      glog.debug(`listMessages ${path}: server refused $count (${e.message}) — falling back to folder counts`);
      res = await gfetch(base);
    }
    messages = (res?.value || []).map(toGraphEnvelope);
    total = Number(res?.['@odata.count']);
    if (!Number.isFinite(total)) {
      // The folder's own counts know about read/unread but nothing about flags, so
      // they can't stand in for a starred listing's total — fall back to "at least
      // what we're holding", which is all the pager actually needs.
      const st = flaggedOnly ? null : await folderStatus(path).catch(() => null);
      total = st ? (unreadOnly ? st.unseen : st.total) : offset + messages.length;
    }
  }

  // Same convention as ewsClient.js: the Drafts folder IS draft-ness for
  // anything Graph didn't already mark.
  if (path === currentAccount().draftsFolder) for (const m of messages) m.draft = true;

  glog.debug(`listMessages ${path} page ${page}: ${messages.length}/${total} (${Date.now() - t0}ms)`);
  return { total, page, pageSize, messages };
}

// How many of the newest messages listNewMessages re-reads. Same size and same
// reasoning as ewsClient.js's RECENT_WINDOW_SIZE.
const RECENT_WINDOW_SIZE = 50;

/**
 * `sinceUid` is accepted for signature parity with imapClient.js and ignored,
 * exactly as ewsClient.js does — and for the same reason. Hmelj derives it from
 * cache.getMaxUid(), which is MAX(CAST(uid AS INTEGER)); over opaque Graph
 * message ids that is meaningless. So this re-reads the newest window and lets
 * cache.upsertMessages() dedupe, which it does by primary key anyway.
 *
 * Graph's real answer to this is /messages/delta with a persisted deltaLink per
 * folder. That is a worthwhile follow-up and deliberately not done here: it
 * needs its own durable state (and its own "the cursor expired, resync from
 * scratch" recovery), which is a bigger change than the sync loop needs today.
 */
export async function listNewMessages(path, _sinceUid) {
  const { messages } = await listMessages(path, { page: 1, pageSize: RECENT_WINDOW_SIZE });
  return messages;
}

/**
 * Analytics full-folder scan — imapClient.js#scanMessages' contract on Graph,
 * over this module's own listMessages paging.
 *
 * IMPORTANT: every row comes back with size 0, because Graph's v1.0 message
 * resource has no size property at all (see the mapping in listMessages).
 * Counts, senders, dates and subjects are all real; anything size-derived is
 * not available for a Graph account, and the UI says so rather than drawing a
 * chart of zeros.
 */
export async function scanMessages(path, { sinceUid = 0, batchSize = 250, onBatch } = {}) {
  let scanned = 0;
  let total = null;
  for (let page = 1; ; page++) {
    const res = await listMessages(path, { page, pageSize: batchSize });
    const items = res?.messages || [];
    if (total === null) total = res?.total ?? items.length;
    if (!items.length) break;
    const rows = items.map((m) => ({
      uid: m.uid,
      emailId: null,
      fromAddr: (m.from?.address || '').toLowerCase(),
      fromName: m.from?.name || '',
      subject: m.subject || '',
      date: m.date ? new Date(m.date).getTime() : 0,
      size: 0,
      seen: !!m.seen,
      bulk: false,
    }));
    scanned += rows.length;
    if (onBatch) await onBatch(rows, scanned, total);
    if (scanned >= total || items.length < batchSize) break;
  }
  return { scanned, total: total || scanned };
}

export async function refreshFlags(path, uids) {
  if (!uids.length) return [];
  const bodies = await gbatch(
    uids.map((uid) => ({ url: `/me/messages/${eid(uid)}?$select=id,isRead,flag` })),
    // A message deleted between the listing and this refresh is normal, not an
    // error — the row simply doesn't come back, which is exactly the contract
    // imapClient.js and ewsClient.js already have.
    { tolerate: [404] },
  );
  const out = [];
  bodies.forEach((m, i) => {
    if (!m) return;
    out.push({
      uid: m.id || uids[i],
      seen: !!m.isRead,
      flagged: (m.flag?.flagStatus || '') === 'flagged',
      answered: false,
    // Graph exposes no reply/forward marker on the message resource. Exchange
    // itself has one — PidTagLastVerbExecuted, which ewsClient.js reads and
    // writes — reachable here only through singleValueExtendedProperties on
    // every request. Not wired up: this codebase has no Graph account to verify
    // it against, and guessing at it would be worse than plainly not having it.
    forwarded: false,
      deleted: false,
    });
  });
  return out;
}

// ---------- single message ----------

// Same short-TTL cache imapClient.js keeps, and for the same reason: opening a
// message with a few inline images makes the browser request each /cid/ image
// separately, and every one of those goes through getMessageSource. Without
// this the full MIME — base64 images and all — is re-downloaded once per
// image. (ewsClient.js still lacks this; worth lifting somewhere shared one
// day.)
const sourceCache = new Map(); // "userKey:accountId:path:uid" -> { source, flags, at }
const SOURCE_CACHE_TTL_MS = 5 * 60e3;
const SOURCE_CACHE_MAX = 30;

function flagsFrom(m) {
  const flags = [];
  if (m?.isRead) flags.push('\\Seen');
  if ((m?.flag?.flagStatus || '') === 'flagged') flags.push('\\Flagged');
  if (m?.isDraft) flags.push('\\Draft');
  return flags;
}

export async function getMessageSource(path, uid) {
  const { userKey, accountId } = currentUser();
  const key = `${userKey}:${accountId}:${path}:${uid}`;
  const cached = sourceCache.get(key);
  if (cached && Date.now() - cached.at < SOURCE_CACHE_TTL_MS) return cached;

  // $value is the whole RFC822 message — the same bytes IMAP's BODY[] returns,
  // which is what lets messageParse.js stay the single MIME implementation.
  // Two plain requests rather than one $batch: a $batch wraps non-JSON bodies
  // in base64 with their own content-type, and decoding that is more moving
  // parts than one extra HTTP request is worth.
  const [source, meta] = await Promise.all([
    gfetch(`/me/messages/${eid(uid)}/$value`, { raw: true, headers: { Accept: '*/*' } }),
    gfetch(`/me/messages/${eid(uid)}?$select=id,isRead,flag,isDraft`).catch(() => null),
  ]);
  if (!source || !source.length) throw new Error('Message not found');
  const result = { source, flags: flagsFrom(meta) };

  sourceCache.set(key, { ...result, at: Date.now() });
  if (sourceCache.size > SOURCE_CACHE_MAX) {
    const oldestKey = [...sourceCache.entries()].reduce((a, b) => (b[1].at < a[1].at ? b : a))[0];
    sourceCache.delete(oldestKey);
  }
  return result;
}

export async function getMessage(path, uid) {
  const { source, flags } = await getMessageSource(path, uid);
  // The account's own authserv-id, so the Authentication-Results reading knows
  // which server's verdict is the trustworthy one (server/authResults.js).
  return { uid, ...(await parseMessage(source, flags, { authservId: currentAccount()?.authservId })) };
}

export async function getMessageHeaders(path, uid) {
  const { source } = await getMessageSource(path, uid);
  return parseHeadersBlock(source);
}

export async function getAttachment(path, uid, index) {
  const { source } = await getMessageSource(path, uid);
  return parseAttachment(source, index);
}

// ---------- mutations ----------

/** Which of imapflow's flag strings Graph can actually represent. \Answered,
 *  $Forwarded, \Deleted and \Draft have no settable Graph equivalent here and
 *  are silently ignored. Note ewsClient.js no longer drops the first two — it
 *  maps them onto PidTagLastVerbExecuted — so this is now the one backend
 *  without a reply/forward marker; see the note in toGraphEnvelope. */
function flagPatch({ add = [], remove = [] }) {
  const patch = {};
  if (add.includes('\\Seen')) patch.isRead = true;
  if (remove.includes('\\Seen')) patch.isRead = false;
  if (add.includes('\\Flagged')) patch.flag = { flagStatus: 'flagged' };
  if (remove.includes('\\Flagged')) patch.flag = { flagStatus: 'notFlagged' };
  return patch;
}

export async function setFlags(path, uids, { add = [], remove = [] } = {}) {
  if (!uids.length) return { ok: true };
  const patch = flagPatch({ add, remove });
  if (!Object.keys(patch).length) {
    glog.debug(`${path}: setFlags(${[...add, ...remove].join(',')}) has no Graph equivalent — ignored`);
    return { ok: true };
  }
  await gbatch(uids.map((uid) => ({ method: 'PATCH', url: `/me/messages/${eid(uid)}`, body: patch })), { tolerate: [404] });
  invalidateSources(path, uids);
  return { ok: true };
}

function invalidateSources(path, uids) {
  const { userKey, accountId } = currentUser();
  for (const uid of uids) sourceCache.delete(`${userKey}:${accountId}:${path}:${uid}`);
}

/**
 * Answer a meeting invitation: accept, tentatively accept, or decline.
 *
 * Graph exposes each verb as an action on the MESSAGE, and does the whole job
 * behind it — writes the event into the calendar with the right response state
 * and mails the organizer. No calendar permission of our own is involved, which
 * is what lets an invitation be answered properly before Hmelj has a calendar.
 *
 * Unlike EWS (see its own respondToMeeting), Graph really can record an answer
 * without telling the organizer — `sendResponse: false`. Exposed, because it is
 * free here and some invitations genuinely do not want a reply; the EWS path
 * always sends, and the reading pane says which it is doing either way.
 */
const RESPOND_ACTION = { accept: 'accept', tentative: 'tentativelyAccept', decline: 'decline' };

export async function respondToMeeting(path, uid, { action, comment = '', sendResponse = true } = {}) {
  const verb = RESPOND_ACTION[action];
  if (!verb) throw new Error(`Unknown meeting response "${action}"`);
  await gfetch(`/me/messages/${eid(uid)}/${verb}`, {
    method: 'POST',
    body: { comment: comment || '', sendResponse: !!sendResponse },
  });
  invalidateSources(path, [uid]);
  // Graph normally moves the handled invitation to Deleted Items, but that is a
  // mailbox setting, not a guarantee — so the cache is told what actually
  // happened rather than what usually does. See the EWS twin for what the wrong
  // answer looks like from the outside.
  let consumed = false;
  try {
    await gfetch(`/me/messages/${eid(uid)}?$select=id`);
  } catch (e) {
    consumed = !!e?.notFound; // graphError() marks a 404 as such
  }
  return { ok: true, action, sent: !!sendResponse, consumed };
}

export async function moveMessages(path, uids, target) {
  if (!uids.length) return { ok: true };
  const destinationId = await resolveFolderId(target);
  // 404 tolerated, as hardDelete does: a message already gone server-side (a
  // recalled one, say) is already out of this folder — see ewsClient.js#
  // checkResponseCodesAllowingGone.
  const moved = await gbatch(uids.map((uid) => ({ method: 'POST', url: `/me/messages/${eid(uid)}/move`, body: { destinationId } })), { tolerate: [404] });
  // A move gives the message a NEW id in the destination folder, so anything
  // cached under the old (path, uid) is stale by definition.
  invalidateSources(path, uids);
  // That new id is also the only way to name the relocated copy afterwards —
  // what lets a delete be undone (see imapClient.js#uidMapOf for the same
  // idea over IMAP's COPYUID). Graph returns the moved message itself.
  const uidMap = {};
  uids.forEach((uid, i) => { if (moved[i]?.id) uidMap[uid] = moved[i].id; });
  return { ok: true, destination: target, uidMap: Object.keys(uidMap).length ? uidMap : null };
}

export async function copyMessages(path, uids, target) {
  if (!uids.length) return { ok: true };
  const destinationId = await resolveFolderId(target);
  await gbatch(uids.map((uid) => ({ method: 'POST', url: `/me/messages/${eid(uid)}/copy`, body: { destinationId } })));
  return { ok: true }; // the source item is untouched by a copy
}

export async function hardDelete(path, uids) {
  if (!uids.length) return { ok: true };
  await gbatch(uids.map((uid) => ({ method: 'DELETE', url: `/me/messages/${eid(uid)}` })), { tolerate: [404] });
  invalidateSources(path, uids);
  return { ok: true };
}

/**
 * Mirrors imapClient.js#deleteMessages' contract (same deleteBehavior/
 * markReadOnDelete settings, same {ok, mode, action} return shape) with the
 * same single gap ewsClient.js has: there is no equivalent of IMAP's 'flag'
 * mode (mark \Deleted, leave the message where it is), because Exchange has no
 * per-message "deleted but still here" state. Falls back to the soft move
 * 'trash' already does — the less surprising mismatch, since the message
 * relocates instead of the delete silently doing nothing, and nothing is
 * destroyed that the user's own setting asked to keep recoverable.
 */
export async function deleteMessages(path, uids) {
  const acc = currentAccount();
  // Owner-scoped, not viewer-scoped — see store.js#getOwnerSettings.
  const settings = store.getOwnerSettings();
  const mode = settings.deleteBehavior;
  if (!uids.length) return { ok: true, mode, action: 'expunged' };

  if (settings.markReadOnDelete) {
    await setFlags(path, uids, { add: ['\\Seen'] }).catch(() => {}); // best-effort, same as imapClient.js
  }

  let action;
  let destination = null;
  let uidMap = null;
  if ((mode === 'trash' || mode === 'flag') && path !== acc.trashFolder) {
    if (mode === 'flag') glog.debug(`${path}: deleteBehavior 'flag' has no Graph equivalent (no in-place \\Deleted state) — moving to Trash instead`);
    const res = await moveMessages(path, uids, acc.trashFolder);
    action = 'moved';
    destination = acc.trashFolder;
    uidMap = res.uidMap;
  } else {
    await hardDelete(path, uids);
    action = 'expunged';
  }
  return { ok: true, mode, action, destination, uidMap };
}

// ---------- sending & saving raw messages ----------

/**
 * nodemailer's MailComposer omits Bcc from the compiled MIME (the same thing
 * ewsClient.js#sendRaw has to work around by passing recipients explicitly).
 * Graph has no separate recipient list when sending MIME — the headers ARE the
 * envelope — so the header has to be there or Bcc recipients silently never
 * receive anything. Exchange strips it from the delivered copies itself.
 */
function ensureBccHeader(raw, bcc = []) {
  if (!bcc.length) return raw;
  const text = raw.toString('binary');
  const headerEnd = text.search(/\r?\n\r?\n/);
  const headers = headerEnd === -1 ? text : text.slice(0, headerEnd);
  if (/^bcc:/im.test(headers)) return raw;
  const line = 'Bcc: ' + bcc.map((a) => (a.name ? `"${a.name.replace(/"/g, '')}" <${a.address}>` : a.address)).join(', ') + '\r\n';
  return Buffer.concat([Buffer.from(line, 'binary'), raw]);
}

function messageIdOf(raw) {
  const m = /^message-id:\s*(<[^>]+>)/im.exec(raw.toString('binary').slice(0, 8192));
  return m ? m[1] : null;
}

/**
 * Send a fully composed RFC822 message. Graph takes base64-encoded MIME when
 * the request is Content-Type: text/plain, and saves the Sent Items copy
 * itself — so, exactly like EWS's SendAndSaveCopy, there is no separate append
 * step and no Gmail-style duplicate-copy special case (see smtpClient.js).
 */
export async function sendRaw(raw, { to = [], cc = [], bcc = [] } = {}) {
  const mime = ensureBccHeader(raw, bcc);
  await gfetch('/me/sendMail', {
    method: 'POST',
    contentType: 'text/plain',
    body: mime.toString('base64'),
  });
  const recipients = [...to, ...cc, ...bcc].map((a) => a.address).filter(Boolean);
  glog.debug(`sendMail: ${recipients.length} recipient(s)`);
  return { uid: messageIdOf(mime), accepted: recipients };
}

/**
 * Save a raw message into a folder — used for drafts (server/index.js's
 * saveDraft) and, for other account types, for Sent copies. Same MIME-in
 * shape as sendRaw. Graph imports MIME as unread, so \Seen is applied
 * afterwards when asked for; \Draft needs nothing, since being in the Drafts
 * folder IS draft-ness.
 */
export async function appendMessage(path, raw, flags = []) {
  const folderId = await resolveFolderId(path);
  const created = await gfetch(`/me/mailFolders/${eid(folderId)}/messages`, {
    method: 'POST',
    contentType: 'text/plain',
    body: Buffer.from(raw).toString('base64'),
  });
  const uid = created?.id || null;
  if (uid && flags.includes('\\Seen')) {
    await gfetch(`/me/messages/${eid(uid)}`, { method: 'PATCH', body: { isRead: true } }).catch(() => {});
  }
  return { uid };
}

// ---------- calendars ----------

/** Every calendar in the mailbox. `canEdit` is Microsoft's own answer about
 *  write access, so a colleague's shared calendar is reported read-only rather
 *  than guessed at. */
export async function listCalendars() {
  const items = await gpage('/me/calendars?$select=id,name,color,hexColor,canEdit,isDefaultCalendar,owner', { maxPages: 10 });
  return items.map((c) => ({
    id: c.id,
    displayName: c.name || 'Calendar',
    // hexColor is the real one when Outlook has been given a custom colour;
    // `color` is a small enum ("lightBlue") that would need its own table.
    color: /^#[0-9a-f]{6}$/i.test(c.hexColor || '') ? c.hexColor.toLowerCase() : '',
    readOnly: c.canEdit === false,
    isDefault: !!c.isDefaultCalendar,
    owner: c.owner?.address || '',
  }));
}

/**
 * A new calendar in the signed-in mailbox.
 *
 * Graph takes only a name here; `hexColor` is settable but is a MAILBOX-side
 * preference that Outlook shows in its own sidebar, and Hmelj keeps its own
 * per-calendar colour anyway (see calendarStore.js), so it is deliberately not
 * sent — one colour to change, not two that can disagree.
 */
export async function createCalendar(name) {
  const created = await gfetch('/me/calendars', { method: 'POST', body: { name: String(name || '').trim() } });
  return {
    id: created?.id || '',
    displayName: created?.name || name,
    color: /^#[0-9a-f]{6}$/i.test(created?.hexColor || '') ? created.hexColor.toLowerCase() : '',
    readOnly: created?.canEdit === false,
  };
}

const EVENT_SELECT = 'id,iCalUId,subject,bodyPreview,start,end,isAllDay,location,organizer,attendees,'
  + 'showAs,sensitivity,seriesMasterId,type,webLink,isCancelled,reminderMinutesBeforeStart,isReminderOn,lastModifiedDateTime'
  // The join link, which is the single most useful thing about a meeting and
  // the one thing bodyPreview reliably cuts off: it truncates at 255
  // characters and a Teams invitation puts several paragraphs of boilerplate
  // above the URL.
  + ',isOnlineMeeting,onlineMeeting,onlineMeetingUrl';

/**
 * Occurrences in a window, with recurrence ALREADY EXPANDED by Microsoft.
 *
 * `calendarView` rather than `/events`, deliberately. `/events` returns series
 * masters carrying Microsoft's own recurrence object, which would then have to
 * be translated into an RRULE — and a mistranslation of "the last working
 * Friday of every second month" is invisible until somebody misses a meeting.
 * Exchange knows its own recurrence semantics; asking it to apply them is both
 * less code and more correct. The cost is that the calendar is only known over
 * the window that was asked for, which is why server/calendarSync.js syncs a
 * rolling one and says so.
 *
 * Cancelled occurrences of a series come back with `isCancelled` — they are
 * holes in the series, and are dropped here rather than shown as events.
 */
export async function calendarView(calendarId, fromIso, toIso, { maxPages = 40, pageSize = 200 } = {}) {
  const base = calendarId
    ? `/me/calendars/${eid(calendarId)}/calendarView`
    : '/me/calendarView';
  const url = `${base}?startDateTime=${encodeURIComponent(fromIso)}&endDateTime=${encodeURIComponent(toIso)}`
    + `&$select=${EVENT_SELECT}&$top=${pageSize}&$orderby=start/dateTime`;
  // Prefer the raw UTC values rather than the mailbox's own display zone: every
  // start below is converted to an instant, and a zone Hmelj has to guess at is
  // exactly what this avoids.
  const items = await gpage(url, { maxPages, headers: { Prefer: 'outlook.timezone="UTC"' } });
  return items.filter((e) => !e.isCancelled);
}

/**
 * One event in full, including its HTML body.
 *
 * Separate from calendarView on purpose: `body` is the whole invitation —
 * boilerplate, dial-in numbers, legal footers — and asking for it across a
 * year of a busy calendar would multiply every sync's payload for something
 * only ever read one event at a time. Fetched when somebody opens an event.
 */
export async function getEvent(id) {
  return gfetch(`/me/events/${eid(id)}?$select=${EVENT_SELECT},body`,
    { headers: { Prefer: 'outlook.timezone="UTC"' } });
}

/* ---------- calendar writes ----------
 *
 * Three ids, and using the wrong one is the whole difficulty:
 *
 *   the OCCURRENCE id   addresses one instance. PATCHing it makes Microsoft
 *                       create the exception itself, which is exactly right and
 *                       is why Hmelj does not build one.
 *   the SERIES MASTER   addresses the rule. The only id a recurrence can be
 *                       changed through.
 *   a plain event id    a one-off, where the two above are the same thing.
 *
 * `seriesMasterId` on an occurrence is how the second is reached from the
 * first; an occurrence of a series that has none is a data error, not a
 * one-off, and is reported rather than silently edited as a single event.
 */

export async function createCalendarEvent(calendarId, event) {
  const path = calendarId ? `/me/calendars/${eid(calendarId)}/events` : '/me/events';
  return gfetch(path, { method: 'POST', body: event });
}

export async function updateCalendarEvent(id, patch) {
  return gfetch(`/me/events/${eid(id)}`, { method: 'PATCH', body: patch });
}

export async function deleteCalendarEvent(id) {
  await gfetch(`/me/events/${eid(id)}`, { method: 'DELETE', raw: true });
  return true;
}

/** The series master behind an occurrence, with its recurrence — the shape a
 *  "change the whole series" edit has to be applied to. */
export async function getSeriesMaster(occurrenceId) {
  const occ = await gfetch(`/me/events/${eid(occurrenceId)}?$select=id,seriesMasterId,type`);
  const masterId = occ?.seriesMasterId || (occ?.type === 'seriesMaster' ? occ.id : '');
  if (!masterId) return null;
  return gfetch(`/me/events/${eid(masterId)}?$select=${EVENT_SELECT},recurrence,body`,
    { headers: { Prefer: 'outlook.timezone="UTC"' } });
}

// ---------- status, probes, contacts ----------

export async function imapStatus() {
  const acc = currentAccount();
  try {
    await gfetch('/me/mailFolders/inbox?$select=id');
    return { connected: true, user: acc.email, host: 'graph.microsoft.com' };
  } catch (e) {
    return { connected: false, error: e.message, host: 'graph.microsoft.com' };
  }
}

/** Inbox counts, for idle.js's GraphWatcher — one tiny request per tick, which
 *  is what makes 30-second polling affordable against Graph's ~10,000 requests
 *  per 10 minutes per mailbox. */
export async function folderCounts() {
  const f = await gfetch('/me/mailFolders/inbox?$select=totalItemCount,unreadItemCount');
  return { total: Number(f?.totalItemCount) || 0, unseen: Number(f?.unreadItemCount) || 0 };
}

/**
 * The account wizard's probe — deliberately standalone, taking a bare access
 * token rather than going through currentAccount(), because at this point in
 * saveAccount() there IS no stored account yet (same shape and same reason as
 * ewsClient.js#testConnection).
 *
 * Graph's well-known folder names are fixed protocol constants, not something
 * to auto-detect the way IMAP's specialUse flags are — so this returns Hmelj's
 * own fixed default special-folder names, matching WELL_KNOWN_PATH.
 */
export async function testConnection(accessToken) {
  const res = await fetch(`${BASE()}/me/mailFolders/inbox?$select=id,displayName,totalItemCount`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok) throw graphError(res.status, json, text, 'testConnection');
  if (!json?.id) throw new Error('Microsoft Graph did not return an Inbox for this mailbox.');
  return { sentFolder: 'Sent', draftsFolder: 'Drafts', trashFolder: 'Trash', junkFolder: 'Junk' };
}

/**
 * Every contact in the account's personal Contacts folder, as {name, email}
 * rows ready for the shared import path in server/index.js — the same shape
 * ewsClient.js#listContacts produces.
 *
 * Personal contacts only (/me/contacts), never the organization's directory:
 * that is the whole company address book, is not the user's to copy, and would
 * swamp a personal address list. A contact with several addresses yields
 * several rows; the caller de-dupes by address anyway, and collapsing them
 * would silently lose the work address of everyone whose personal one happens
 * to be listed first.
 */
/** The fields live contact sync reads. Deliberately a fixed list rather than
 *  the whole contact: a Graph contact carries a photo, a manager, a birthday and
 *  three postal addresses, and asking for all of it makes every delta page an
 *  order of magnitude larger for data Hmelj neither shows nor stores. */
const CONTACT_SELECT = 'id,displayName,givenName,surname,companyName,jobTitle,emailAddresses,businessPhones,mobilePhone';

/**
 * Contacts as a DELTA — what changed since the token, including deletions.
 *
 * The Graph equivalent of CardDAV's sync-collection, and it matters for exactly
 * the same reason: without it, keeping an address book current means
 * re-downloading all of it on every poll, forever.
 *
 * `token` is the opaque `@odata.deltaLink` from the previous run, or '' for a
 * first sync (which returns everything and is reported as `full`). A token
 * Graph no longer accepts comes back as 410 with `resyncRequired`, which means
 * "start over" and not "this failed" — a client that treats it as an error stops
 * syncing permanently and silently, days after being set up.
 *
 * A removed contact arrives as `{id, '@removed': …}` with no other fields, which
 * is the only signal that says an item is gone rather than merely unchanged.
 */
export async function listContactsDelta(token = '', { maxPages = 50 } = {}) {
  const start = token || `/me/contacts/delta?$select=${CONTACT_SELECT}`;
  const changed = [];
  const removed = [];
  let next = start;
  let deltaLink = '';

  for (let page = 0; page < maxPages && next; page++) {
    let res;
    try {
      res = await gfetch(next);
    } catch (e) {
      // Only a stale token gets a second chance, and only by starting over.
      // NOT `e.status === 410`: graphError() maps every 4xx onto 400 for the
      // API layer, so the original code is gone by the time it reaches here.
      // `graphCode` is the field that survives, and the message carries the
      // wire status for the servers that answer with a bare 410.
      const resync = /resyncRequired|SyncStateNotFound/i.test(String(e?.graphCode || ''))
        || /resyncRequired|SyncStateNotFound|Graph 410/i.test(String(e?.message || ''));
      if (!resync || !token) throw e;
      glog.info('Contact delta token is no longer accepted — re-reading every contact');
      return listContactsDelta('', { maxPages });
    }
    for (const c of res?.value || []) {
      if (c['@removed']) { removed.push(String(c.id)); continue; }
      changed.push(c);
    }
    deltaLink = res?.['@odata.deltaLink'] || '';
    next = res?.['@odata.nextLink'] || null;
  }
  return { changed, removed, token: deltaLink, full: !token };
}

/** One contact, by id — for a caller that holds an id and needs the fields back
 *  (a write that has to be re-read to learn its new ETag). */
export async function getContact(id) {
  return gfetch(`/me/contacts/${eid(id)}?$select=${CONTACT_SELECT}`);
}

/**
 * Creates a contact. Returns the whole created object, because Graph mints the
 * id and the ETag and neither can be predicted.
 */
export async function createContact(fields) {
  return gfetch('/me/contacts', { method: 'POST', body: fields });
}

/**
 * Updates a contact — PATCH, never PUT.
 *
 * Partial by construction, which is what keeps this non-destructive: Hmelj
 * models a name and some addresses, and a PUT would replace the birthday, the
 * photo and the postal address with nothing. Same rule server/vcard.js follows
 * on the CardDAV side, enforced here by the verb instead of by hand.
 *
 * `etag` makes it conditional. A 412 means somebody else changed the contact
 * first and is surfaced as such rather than retried unconditionally — the
 * unconditional retry is exactly how the other edit gets destroyed.
 */
export async function updateContact(id, fields, etag = '') {
  return gfetch(`/me/contacts/${eid(id)}`, {
    method: 'PATCH',
    body: fields,
    headers: etag ? { 'If-Match': etag } : {},
  });
}

export async function deleteContact(id, etag = '') {
  await gfetch(`/me/contacts/${eid(id)}`, { method: 'DELETE', headers: etag ? { 'If-Match': etag } : {} });
  return true;
}

export async function listContacts({ pageSize = 200, maxPages = 25 } = {}) {
  const items = await gpage(`/me/contacts?$top=${pageSize}&$select=displayName,emailAddresses`, { maxPages });
  const out = [];
  for (const c of items) {
    for (const e of c.emailAddresses || []) {
      const address = String(e.address || '').trim();
      if (address.includes('@')) out.push({ name: c.displayName || e.name || '', email: address });
    }
  }
  return out;
}
