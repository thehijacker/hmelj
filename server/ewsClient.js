// Hmelj — Exchange Web Services (EWS) client, mirroring imapClient.js's flat
// function-module shape so server/mailClient.js can dispatch to either one
// transparently (see that file). Talks SOAP over HTTP with NTLM auth via
// `httpntlm` — the transport confirmed working against this deployment's
// on-prem Exchange 2013 server (see exchange.md; other EWS libraries fail
// the NTLM handshake on modern Node).
//
// Two structural differences from IMAP this file has to bridge on its own,
// invisibly to every caller (sync.js/index.js/filters.js just see `path`s
// and `uid`s, same as with IMAP):
//
//  - EWS folders are a FolderId/ParentFolderId tree with a DisplayName, not
//    a delimited path string. listFolders() below synthesizes Hmelj-style
//    {path, name, parent} records (path delimiter '/') and keeps an
//    internal path -> {id, changeKey} map (folderCache) so every other
//    exported function can resolve a path back to a real FolderId. The five
//    well-known folders (Inbox/Sent/Drafts/Trash/Junk) get their path forced
//    to that fixed, capitalized convention regardless of the mailbox's
//    actual (possibly localized) DisplayName — matching how IMAP's own
//    specialUse-based folders already work, and matching the defaults
//    accounts.js#saveAccount() already assumes account-type-agnostically.
//
//  - A message's `uid` here is its EWS ItemId string (opaque, often
//    containing '/', '+', '=') — not an IMAP integer UID. Mutations that
//    actually need to know "which version of this item am I changing"
//    (UpdateItem, i.e. setFlags) also need its current ChangeKey — that's
//    NOT part of message identity, it changes on every server-side edit.
//    changeKeyCache below tracks the newest one seen per (account, folder,
//    id), refreshed on every list/get/mutate and re-fetched on demand (one
//    GetItem call) whenever it's missing — e.g. after a server restart, or
//    for a message never listed this process's lifetime. Purely an
//    in-memory, self-healing cache, not persisted — Move/Copy/Delete don't
//    need a ChangeKey at all (no "which version" ambiguity for removing or
//    relocating an object, only for editing its fields), so only setFlags
//    pays for this.
import httpntlm from 'httpntlm';
import { XMLParser } from 'fast-xml-parser';
import { currentUser } from './session.js';
import { currentAccount } from './accounts.js';
import { sortFolderTree } from './folderTree.js';
import { parseMessage, parseHeadersBlock, parseAttachment } from './messageParse.js';
import { threadKeyFrom, normalizeId } from './threading.js';
import { store } from './store.js';
import { log } from './log.js';
import { parseSearchQuery } from './searchQuery.js';

const ilog = log.scope('ews');

// ---------- SOAP transport ----------

// NTLM's handshake (Type1/Type2/Type3 message exchange) is per-TCP-connection,
// so connection reuse matters — but it turns out there's nothing for THIS
// file to manage: httpntlm@1.4.1 builds its own keep-alive agent internally
// on every call (via the `agentkeepalive` package, unconditionally — it
// never reads any `agent` option a caller passes in), so a per-account pool
// here would just be dead code sitting next to the one httpntlm actually
// uses. Confirmed against a real server, the hard way: an earlier version of
// this file DID try to pass its own https.Agent through, which crashed the
// whole process with `ERR_INVALID_PROTOCOL: Protocol "https:" not supported.
// Expected "http:"` — not because of anything passed in, but because
// httpntlm's OWN internal agent (agentkeepalive ~0.1.5, pinned by httpntlm's
// package.json since ~2013) predates Node's https.Agent.protocol convention
// and fails Node 22's stricter agent/protocol validation. Fixed at the
// dependency level instead — see package.json's "overrides": forces
// agentkeepalive to a modern 4.x tree-wide, which httpntlm's own
// `require('agentkeepalive').HttpsAgent` picks up transparently (that
// top-level shape has stayed stable across agentkeepalive's majors
// specifically for old consumers like this one) — no code here needed to
// change once that's in place.
//
// One real consequence of not controlling httpntlm's request options
// ourselves: it does not forward a rejectUnauthorized/cert-validation
// override anywhere in its public API (confirmed by reading its source —
// neither of its two internal httpreq calls receives one). The wizard's
// "Allow self-signed certificate" checkbox is therefore not wired to
// anything real yet; it's stored on the account but has no effect on
// requests. If a self-signed Exchange cert turns out to matter here, this
// needs either patching httpntlm/httpreq's call sites directly or replacing
// the transport, not a caller-side option — flagging rather than silently
// pretending it works.
function acctKey(acc) {
  return `${currentUser().userKey}:${acc.id}`;
}

function soapEnvelope(body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2013" />
  </soap:Header>
  <soap:Body>
    ${body}
  </soap:Body>
</soap:Envelope>`;
}

// Same reasoning as imapClient.js's own socketTimeout: httpntlm has no
// built-in timeout, and a silently-hanging request against an unreachable or
// misbehaving Exchange server would otherwise block the caller (and, for an
// interactive request, the user) indefinitely instead of failing visibly.
const REQUEST_TIMEOUT_MS = 30000;

// Takes plain credentials ({url,user,pass,domain}) rather than a full stored
// account object — so the same function serves both the normal per-account
// calls throughout this file (pass acc.ews) AND accounts.js's wizard "test
// connection" probe, which runs before any account row (or ALS accountId)
// exists at all.
function soapRequest(creds, soapAction, soapBody) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Exchange request timed out after ${REQUEST_TIMEOUT_MS / 1000}s (${soapAction})`));
    }, REQUEST_TIMEOUT_MS);
    httpntlm.post({
      url: creds.url,
      username: creds.user,
      password: creds.pass,
      domain: creds.domain || '',
      workstation: '',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': `http://schemas.microsoft.com/exchange/services/2006/messages/${soapAction}`,
      },
      body: soapEnvelope(soapBody),
    }, (err, res) => {
      if (settled) return; // timer already fired and rejected — ignore a late callback
      settled = true;
      clearTimeout(timer);
      if (err) return reject(err);
      if (res.statusCode !== 200) return reject(new Error(`Exchange HTTP ${res.statusCode}: ${(res.body || '').slice(0, 500)}`));
      resolve(res.body);
    });
  });
}

// removeNSPrefix strips the m:/t:/soap: namespace prefixes EWS's XML uses
// throughout, so response-walking code below can write parsed.Envelope.Body
// instead of parsed['soap:Envelope']['soap:Body'] — EWS's schema never
// collides same-named elements across namespaces in a way that would make
// this ambiguous. isArray forces every element that can legitimately repeat
// to always parse as an array (even when a response happens to contain
// exactly one), which sidesteps the classic single-vs-array XML parsing bug
// class entirely, at the minor cost of a stray `[0]` on fields that are
// only ever singular in practice (e.g. From's one Mailbox).
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  isArray: (name) => [
    'Folder', 'Message', 'Mailbox', 'ExtendedProperty',
    'FindFolderResponseMessage', 'GetFolderResponseMessage',
    'FindItemResponseMessage', 'GetItemResponseMessage',
    'CreateFolderResponseMessage', 'DeleteFolderResponseMessage',
    'UpdateFolderResponseMessage', 'MoveFolderResponseMessage',
    'EmptyFolderResponseMessage',
  ].includes(name),
});

function asArray(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }
function numOr(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
/** PR_ATTR_HIDDEN (MAPI tag 0x10F4), requested as an ExtendedFieldURI on
 * listFolders()'s FindFolder call — see the filter there for why. */
function isHiddenFolder(f) {
  const prop = asArray(f.ExtendedProperty)[0];
  return boolOf(prop?.Value);
}

// PidTagLastVerbExecuted (MAPI tag 0x1081) — Exchange's answer to IMAP's
// \Answered flag and the $Forwarded keyword, and what makes Outlook draw its
// little reply/forward arrow. There is no plain FieldURI for it; it has to be
// requested and written as an ExtendedFieldURI, the same idiom PR_ATTR_HIDDEN
// (0x10F4) and FlagStatus (0x1090) already use in this file.
//
// The values are the MAPI NOTEIVERB_* constants. Outlook writes the reply-all
// one for a reply-all; Hmelj folds that into REPLY, since the distinction has
// no counterpart on the IMAP side and nothing in the UI would show it.
const VERB_TAG = '0x1081';
const VERB_TIME_TAG = '0x1082'; // PidTagLastVerbExecutionTime — the "You replied on …" date
const VERB = { REPLY: 102, REPLY_ALL: 103, FORWARD: 104 };
const VERB_PROP = `<t:ExtendedFieldURI PropertyTag="${VERB_TAG}" PropertyType="Integer"/>`;

/**
 * UpdateItem SetItemField fragments recording that `verb` was performed on a
 * message, now. Both properties, because Outlook wants the timestamp too — with
 * only the verb it shows the arrow but no "You replied on ..." line.
 *
 * The doubled ExtendedFieldURI (once naming the field being set, once inside the
 * value) is EWS's required shape for writing an extended property, not a typo.
 */
function verbSetFields(verb) {
  const uri = (tag, type) => `<t:ExtendedFieldURI PropertyTag="${tag}" PropertyType="${type}"/>`;
  const field = (tag, type, value) =>
    `<t:SetItemField>${uri(tag, type)}<t:Message><t:ExtendedProperty>${uri(tag, type)}<t:Value>${escXml(value)}</t:Value></t:ExtendedProperty></t:Message></t:SetItemField>`;
  return field(VERB_TAG, 'Integer', verb)
    + field(VERB_TIME_TAG, 'SystemTime', new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
}

/**
 * Picks one ExtendedProperty out of an item's list by its PropertyTag — by tag
 * rather than by position, since an item may carry several.
 *
 * Compared NUMERICALLY. A property tag is a number, and EWS is not consistent
 * about how it spells one back at you: the request says PropertyTag="0x1081",
 * responses may echo that or the decimal 4225, depending on server version. Both
 * are the same property, and a string compare would silently see only one of
 * them — an empty result that looks exactly like "never replied to".
 */
function extendedProp(item, tag) {
  const want = Number(tag);
  for (const p of asArray(item?.ExtendedProperty)) {
    if (Number(p?.ExtendedFieldURI?.['@_PropertyTag']) === want) return p.Value;
  }
  return undefined;
}

/** {answered, forwarded} from an item's PidTagLastVerbExecuted. Absent (the
 *  common case — the property only exists once something has been done to the
 *  message) reads as neither. */
function verbState(item) {
  const v = Number(extendedProp(item, VERB_TAG));
  return {
    answered: v === VERB.REPLY || v === VERB.REPLY_ALL,
    forwarded: v === VERB.FORWARD,
  };
}
function boolOf(v) { return v === true || v === 'true'; }
function escXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// FieldURI for each of searchQuery.js's four scoped fields. item:Subject is the only
// one of these actually exercised against a real server so far (see this file's own
// header comment on the confirmed-working deployment) — message:From/ToRecipients and
// item:Body below are the documented EWS schema FieldURIs for Contains restrictions on
// those properties, but unverified here specifically. From/To are structured
// EmailAddressType fields rather than plain strings; Exchange is documented to still
// accept a Contains restriction against them (matching on the underlying address/
// display-name text), but if a real server ever rejects it, scope search to
// subject/body only as the fallback rather than trying to fix this blind.
const EWS_FIELD_URI = { from: 'message:From', to: 'message:ToRecipients', subject: 'item:Subject', body: 'item:Body' };

function ewsContains(fieldURI, text) {
  return `<t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase"><t:FieldURI FieldURI="${fieldURI}"/><t:Constant Value="${escXml(text)}"/></t:Contains>`;
}

// Unscoped-term field list — deliberately excludes body (EWS_FIELD_URI.body) even
// though that key still exists for the explicit body: branch below. Only an explicit
// body:/-body: term searches message text; that's the one thing that forces a live EWS
// round-trip instead of being answerable from the cache — same reasoning and same
// unscoped scope as imapClient.js's own termToSearchObject, for parity between account
// types (see server/searchQuery.js's queryNeedsBodySearch).
const UNSCOPED_EWS_FIELDS = [EWS_FIELD_URI.from, EWS_FIELD_URI.to, EWS_FIELD_URI.subject];

/** One search term (see searchQuery.js) → an EWS restriction XML fragment matching it. */
function termToEwsRestriction({ field, text }, fullText = false) {
  if (field && EWS_FIELD_URI[field]) return ewsContains(EWS_FIELD_URI[field], text);
  // See imapClient.js#termToSearchObject: with "search everywhere" the user has
  // asked the server to look inside the messages too.
  const fields = fullText ? [...UNSCOPED_EWS_FIELDS, EWS_FIELD_URI.body] : UNSCOPED_EWS_FIELDS;
  return `<t:Or>${fields.map((uri) => ewsContains(uri, text)).join('')}</t:Or>`;
}

/** ANDs a list of restriction XML fragments. Unlike imapflow's JS-object DSL (see
 *  imapClient.js's own andAll — same purpose, needs a De Morgan trick there because two
 *  OR-shaped/NOT-shaped JS objects can't share one key), EWS restrictions are XML
 *  elements, not object keys, so <t:And> can just take arbitrarily many sibling
 *  restrictions directly — no such trick needed here. */
function andXml(parts) {
  const list = parts.filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  return `<t:And>${list.join('')}</t:And>`;
}

/** Parses the search box's raw query text (searchQuery.js's +/-/"..."/field: syntax)
 *  into one EWS restriction XML fragment, or '' for an empty/whitespace-only query. */
function buildEwsSearchRestriction(query, fullText = false) {
  const { required, excluded } = parseSearchQuery(query);
  const parts = [
    ...required.map((t) => termToEwsRestriction(t, fullText)),
    ...excluded.map((t) => `<t:Not>${termToEwsRestriction(t, fullText)}</t:Not>`),
  ];
  return andXml(parts);
}

/** Item-level EWS errors (e.g. a stale ChangeKey, a folder that no longer
 * exists) come back as HTTP 200 with a ResponseCode inside the SOAP body,
 * not an HTTP error — soapRequest() alone can't catch those, every call site
 * that parses a ResponseMessage needs to check this. */
const NOT_FOUND_CODES = new Set(['ErrorItemNotFound', 'ErrorFolderNotFound', 'ErrorNonExistentMailbox']);

function checkResponseCode(m, op) {
  if (!m) throw new Error(`Exchange ${op}: empty response`);
  if (m.ResponseCode && m.ResponseCode !== 'NoError') {
    const err = new Error(`Exchange ${op} failed: ${m.ResponseCode}${m.MessageText ? ' — ' + m.MessageText : ''}`);
    err.ewsResponseCode = m.ResponseCode;
    // Marked the same way graphClient.js marks its 404s, so callers can handle
    // "this is gone" without knowing which protocol said so. A message that has
    // vanished server-side is ordinary — it was moved, deleted, or (a meeting
    // invitation) consumed by answering it — and the caller's job is to drop
    // the stale row, not to show the reader a SOAP response code.
    if (NOT_FOUND_CODES.has(m.ResponseCode)) err.notFound = true;
    throw err;
  }
}

// ---------- folder tree + path resolution ----------

const WELL_KNOWN = ['inbox', 'sentitems', 'drafts', 'deleteditems', 'junkemail'];
// Forced to this fixed, capitalized convention regardless of the mailbox's
// real (possibly localized) DisplayName — see the file-level comment above.
// 'INBOX' specifically (not 'Inbox') is not just a style choice: app.js and
// sync.js hardcode the literal all-caps string 'INBOX' as THE inbox path for
// every account regardless of protocol (state.currentFolder default,
// switchAccount()'s openFolder('INBOX'), isInScope()'s comparison, the
// unified-view "All inbox" route in index.js, …) — this is the one path
// name that has to match that exactly, not just be internally consistent.
const WELL_KNOWN_PATH = { inbox: 'INBOX', sentitems: 'Sent', drafts: 'Drafts', deleteditems: 'Trash', junkemail: 'Junk' };
const WELL_KNOWN_SPECIAL_USE = { inbox: '\\Inbox', sentitems: '\\Sent', drafts: '\\Drafts', deleteditems: '\\Trash', junkemail: '\\Junk' };

const folderCache = new Map(); // `${userKey}:${accountId}` -> { byPath: Map<path,{id,changeKey}> }
const changeKeyCache = new Map(); // `${userKey}:${accountId}:${folder}:${id}` -> changeKey

function cacheKey(acc) { return acctKey(acc); }

function rememberChangeKey(acc, folder, id, changeKey) {
  if (id && changeKey) changeKeyCache.set(`${cacheKey(acc)}:${folder}:${id}`, changeKey);
}

async function resolveWellKnown(acc) {
  const body = `<m:GetFolder>
    <m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape>
    <m:FolderIds>${WELL_KNOWN.map((n) => `<t:DistinguishedFolderId Id="${n}"/>`).join('')}</m:FolderIds>
  </m:GetFolder>`;
  const xml = await soapRequest(acc.ews, 'GetFolder', body);
  const parsed = xmlParser.parse(xml);
  const messages = asArray(parsed?.Envelope?.Body?.GetFolderResponse?.ResponseMessages?.GetFolderResponseMessage);
  const result = {};
  // EWS batch responses come back in the same order as the request's own
  // FolderIds list, so index i here really does correspond to WELL_KNOWN[i].
  messages.forEach((m, i) => {
    checkResponseCode(m, 'GetFolder');
    const folder = asArray(m.Folders?.Folder)[0];
    const idAttr = folder?.FolderId;
    if (idAttr) result[WELL_KNOWN[i]] = { id: idAttr['@_Id'], changeKey: idAttr['@_ChangeKey'] };
  });
  return result;
}

export async function listFolders() {
  const acc = currentAccount();
  const t0 = Date.now();
  const wellKnown = await resolveWellKnown(acc);
  const idToWellKnownName = new Map(Object.entries(wellKnown).map(([name, v]) => [v.id, name]));

  const body = `<m:FindFolder Traversal="Deep">
    <m:FolderShape>
      <t:BaseShape>Default</t:BaseShape>
      <t:AdditionalProperties>
        <t:FieldURI FieldURI="folder:TotalCount"/>
        <t:FieldURI FieldURI="folder:UnreadCount"/>
        <t:ExtendedFieldURI PropertyTag="0x10F4" PropertyType="Boolean"/>
      </t:AdditionalProperties>
    </m:FolderShape>
    <m:ParentFolderIds><t:DistinguishedFolderId Id="msgfolderroot"/></m:ParentFolderIds>
  </m:FindFolder>`;
  const xml = await soapRequest(acc.ews, 'FindFolder', body);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.FindFolderResponse?.ResponseMessages?.FindFolderResponseMessage)[0];
  checkResponseCode(msg, 'FindFolder');
  const mailClassFolders = asArray(msg?.RootFolder?.Folders?.Folder)
    // Mail folders only — msgfolderroot's own Deep subtree shouldn't include
    // Calendar/Contacts/Tasks (those live under a different root), but odd
    // system folders (Sync Issues, Conversation Action Settings, …) can show
    // up with a non-mail FolderClass on some mailboxes; skip them.
    .filter((f) => (f.FolderClass || 'IPF.Note') === 'IPF.Note');

  // Outlook doesn't show Sync Issues (or its children Conflicts/Local
  // Failures/Server Failures), Conversation Action Settings, Quick Step
  // Settings, Journal, RSS Feeds, Notes, Yammer Root, and a handful of other
  // client-internal bookkeeping folders either — they genuinely live in the
  // same msgfolderroot subtree this Deep traversal walks, not a different
  // FolderClass, they're just flagged hidden via the standard MAPI
  // PR_ATTR_HIDDEN property (tag 0x10F4), which Outlook itself respects to
  // keep them out of the folder list. Confirmed against a real mailbox that
  // a per-folder check alone isn't enough, though: only the Sync Issues
  // container itself carries the flag — its children apparently don't each
  // repeat it, and rely entirely on their hidden parent for Outlook's own UI
  // to keep the whole subtree out of view. So this checks every ancestor,
  // not just the folder's own flag — hidden-ness inherits down the tree the
  // same way Outlook's rendering already does.
  const byRawId = new Map(mailClassFolders.map((f) => [f.FolderId?.['@_Id'], f]));
  function isHiddenOrDescendantOfHidden(f, seen = new Set()) {
    const id = f.FolderId?.['@_Id'];
    if (!id || seen.has(id)) return false; // no id to key on, or a cycle — treat as visible rather than loop forever
    seen.add(id);
    if (isHiddenFolder(f)) return true;
    const parent = byRawId.get(f.ParentFolderId?.['@_Id']);
    return parent ? isHiddenOrDescendantOfHidden(parent, seen) : false;
  }
  const rawFolders = mailClassFolders.filter((f) => !isHiddenOrDescendantOfHidden(f));

  const byId = new Map();
  for (const f of rawFolders) {
    const id = f.FolderId?.['@_Id'];
    if (!id) continue;
    const wk = idToWellKnownName.get(id);
    byId.set(id, {
      id, changeKey: f.FolderId?.['@_ChangeKey'],
      parentId: f.ParentFolderId?.['@_Id'] || null,
      displayName: wk ? WELL_KNOWN_PATH[wk] : (f.DisplayName || 'Untitled'),
      specialUse: wk ? WELL_KNOWN_SPECIAL_USE[wk] : null,
      total: numOr(f.TotalCount, 0),
      unseen: numOr(f.UnreadCount, 0),
    });
  }

  const hidden = new Set(acc.hiddenFolders || []);
  function pathFor(id, seen = new Set()) {
    const f = byId.get(id);
    if (!f || seen.has(id)) return null; // orphaned parent or a cycle — treat as top-level rather than loop forever
    seen.add(id);
    const parentPath = f.parentId ? pathFor(f.parentId, seen) : null;
    return parentPath ? `${parentPath}/${f.displayName}` : f.displayName;
  }

  const byPath = new Map();
  const folders = [...byId.values()].map((f) => {
    const path = pathFor(f.id);
    byPath.set(path, { id: f.id, changeKey: f.changeKey });
    const parentPath = f.parentId ? pathFor(f.parentId) : null;
    return {
      path, name: f.displayName, delimiter: '/', parent: parentPath,
      specialUse: f.specialUse, subscribed: true, hidden: hidden.has(path),
      total: f.total, unseen: f.unseen,
    };
  });

  folderCache.set(cacheKey(acc), { byPath });
  const result = sortFolderTree(folders);
  ilog.debug(`listFolders: ${result.length} folders (${Date.now() - t0}ms)`);
  return result;
}

/** Resolves a Hmelj path string back to its real EWS FolderId — the
 * counterpart to listFolders()'s path synthesis above. Falls back to a
 * fresh listFolders() call if the path isn't cached yet (first call this
 * process, or a folder created since the last refresh). */
async function resolveFolderId(path) {
  const acc = currentAccount();
  let entry = folderCache.get(cacheKey(acc));
  if (!entry || !entry.byPath.has(path)) {
    await listFolders();
    entry = folderCache.get(cacheKey(acc));
  }
  const f = entry?.byPath.get(path);
  if (!f) throw new Error(`Exchange folder not found: ${path}`);
  return f;
}

export async function folderStatus(path) {
  const acc = currentAccount();
  const { id } = await resolveFolderId(path);
  const body = `<m:GetFolder>
    <m:FolderShape>
      <t:BaseShape>IdOnly</t:BaseShape>
      <t:AdditionalProperties>
        <t:FieldURI FieldURI="folder:TotalCount"/>
        <t:FieldURI FieldURI="folder:UnreadCount"/>
      </t:AdditionalProperties>
    </m:FolderShape>
    <m:FolderIds><t:FolderId Id="${escXml(id)}"/></m:FolderIds>
  </m:GetFolder>`;
  const xml = await soapRequest(acc.ews, 'GetFolder', body);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.GetFolderResponse?.ResponseMessages?.GetFolderResponseMessage)[0];
  checkResponseCode(msg, 'GetFolder');
  const folder = asArray(msg?.Folders?.Folder)[0];
  return { total: numOr(folder?.TotalCount, 0), unseen: numOr(folder?.UnreadCount, 0) };
}

// ---------- message list ----------

/**
 * Every message-like item in an EWS <Items> container, whatever element name
 * Exchange chose for it.
 *
 * This exists because reading `Items.Message` — which every call here used to
 * do — silently drops a meeting invitation. Exchange returns one as
 * <t:MeetingRequest>, an accept/decline as <t:MeetingResponse> and a withdrawal
 * as <t:MeetingCancellation>; none of them is a <t:Message>. The folder's own
 * UnreadCount counts them all, so the symptom is precise and baffling: the
 * badge says 1 unread and the list is empty. Reported on a live account
 * ("check programi", an invitation that was never visible in Hmelj at all).
 *
 * `Item` is included because some servers fall back to the generic element for
 * a message class they have no specific one for; anything genuinely not
 * mail-like (Contact, Task, CalendarItem) is left out — a mail folder listing
 * is not the place for those, and CalendarItem is v2's business.
 */
const MESSAGE_ITEM_KINDS = ['Message', 'MeetingRequest', 'MeetingMessage', 'MeetingResponse', 'MeetingCancellation', 'Item'];

function itemsOf(container) {
  const out = [];
  for (const kind of MESSAGE_ITEM_KINDS) {
    for (const it of asArray(container?.[kind])) out.push(it);
  }
  return out;
}

function toEwsEnvelope(it, acc, path) {
  const idAttr = it.ItemId;
  const id = idAttr?.['@_Id'];
  rememberChangeKey(acc, path, id, idAttr?.['@_ChangeKey']);
  const from = asArray(it.From?.Mailbox)[0];
  const to = asArray(it.ToRecipients?.Mailbox).map((m) => ({ name: m.Name || '', address: m.EmailAddress || '' }));
  return {
    uid: id,
    subject: it.Subject || '(no subject)',
    from: from ? { name: from.Name || '', address: from.EmailAddress || '' } : null,
    to,
    date: it.DateTimeReceived || null,
    // Exchange has no Date:-header/received-time split to worry about here —
    // DateTimeReceived already IS when the server took delivery. Named the same
    // as the IMAP backend's so sync.js's filter gate needs no per-backend case.
    internalDate: it.DateTimeReceived || null,
    seen: boolOf(it.IsRead),
    flagged: (it.Flag?.FlagStatus || '') === 'Flagged',
    // EWS has no \Answered flag; PidTagLastVerbExecuted is the equivalent, and
    // is what Outlook itself reads to draw its reply/forward arrow. Requested as
    // an ExtendedFieldURI by listMessages/refreshFlags — see verbState().
    ...verbState(it),
    // Being *in* the Deleted Items folder already IS Exchange's "deleted"
    // state for a message — there's no separate per-message deleted flag to
    // check the way IMAP's \Deleted works.
    deleted: false,
    // Set by the caller when it already knows it's listing the Drafts
    // folder (mirrors how imapClient.js's own \Draft flag is used) — not
    // determinable from this response shape alone.
    draft: false,
    size: numOr(it.Size, 0),
    hasAttachment: boolOf(it.HasAttachments),
    // See the ConversationId note in listMessages' ItemShape above. An older
    // Exchange (or a message class that carries neither property) simply
    // yields no key, and the cache then treats the message as a thread of one.
    messageId: normalizeId(it.InternetMessageId),
    threadKey: threadKeyFrom({
      conversationId: it.ConversationId?.['@_Id'],
      messageId: it.InternetMessageId,
    }),
  };
}

export async function listMessages(path, { page = 1, pageSize = 50, query = '', unreadOnly = false, flaggedOnly = false, fullText = false } = {}) {
  const acc = currentAccount();
  const t0 = Date.now();
  const { id } = await resolveFolderId(path);
  const offset = (page - 1) * pageSize;

  const restrictionParts = [];
  if (unreadOnly) {
    restrictionParts.push(`<t:IsEqualTo><t:FieldURI FieldURI="message:IsRead"/><t:FieldURIOrConstant><t:Constant Value="false"/></t:FieldURIOrConstant></t:IsEqualTo>`);
  }
  // Flag state has no plain FieldURI to restrict on (item:Flag is a complex
  // property), so this goes through the underlying MAPI property instead:
  // PR_FLAG_STATUS (0x1090), where 2 = followUp — the same state toEwsEnvelope
  // above reads back as Flag/FlagStatus="Flagged". Same ExtendedFieldURI idiom
  // the PR_ATTR_HIDDEN folder check already uses.
  if (flaggedOnly) {
    restrictionParts.push(`<t:IsEqualTo><t:ExtendedFieldURI PropertyTag="0x1090" PropertyType="Integer"/><t:FieldURIOrConstant><t:Constant Value="2"/></t:FieldURIOrConstant></t:IsEqualTo>`);
  }
  const searchRestriction = query ? buildEwsSearchRestriction(query, fullText) : '';
  if (searchRestriction) restrictionParts.push(searchRestriction);
  const restriction = restrictionParts.length
    ? `<m:Restriction>${restrictionParts.length > 1 ? `<t:And>${restrictionParts.join('')}</t:And>` : restrictionParts[0]}</m:Restriction>`
    : '';

  const body = `<m:FindItem Traversal="Shallow">
    <m:ItemShape>
      <t:BaseShape>IdOnly</t:BaseShape>
      <t:AdditionalProperties>
        <t:FieldURI FieldURI="item:Subject"/>
        <t:FieldURI FieldURI="message:From"/>
        <t:FieldURI FieldURI="message:ToRecipients"/>
        <t:FieldURI FieldURI="item:DateTimeReceived"/>
        <t:FieldURI FieldURI="item:Size"/>
        <t:FieldURI FieldURI="message:IsRead"/>
        <t:FieldURI FieldURI="item:HasAttachments"/>
        <t:FieldURI FieldURI="item:Flag"/>
        <!-- Conversation grouping (see server/threading.js). Exchange threads
             server-side and hands back a stable ConversationId, which beats
             anything reconstructed from References. -->
        <t:FieldURI FieldURI="item:ConversationId"/>
        <t:FieldURI FieldURI="message:InternetMessageId"/>
        ${VERB_PROP}
      </t:AdditionalProperties>
    </m:ItemShape>
    <m:IndexedPageItemView MaxEntriesReturned="${pageSize}" Offset="${offset}" BasePoint="Beginning"/>
    ${restriction}
    <m:SortOrder><t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived"/></t:FieldOrder></m:SortOrder>
    <m:ParentFolderIds><t:FolderId Id="${escXml(id)}"/></m:ParentFolderIds>
  </m:FindItem>`;

  const xml = await soapRequest(acc.ews, 'FindItem', body);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.FindItemResponse?.ResponseMessages?.FindItemResponseMessage)[0];
  checkResponseCode(msg, 'FindItem');
  const root = msg?.RootFolder;
  const total = numOr(root?.['@_TotalItemsInView'], 0);
  // Re-sorted after mapping: grouping by element name (itemsOf) loses the
  // document order Exchange returned them in, and this listing asked for
  // newest-first. A stable answer matters — the cache pages on it.
  const messages = itemsOf(root?.Items).map((it) => toEwsEnvelope(it, acc, path))
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  ilog.debug(`listMessages ${path}: total=${total} page=${page}/${Math.ceil(total / pageSize) || 1} returned=${messages.length} (${Date.now() - t0}ms)`);
  return { total, page, pageSize, messages };
}

// Used by listNewMessages below in place of a real incremental check — see
// its own comment for why. Small enough to be cheap every poll tick, large
// enough that ordinary mail volume between ticks doesn't outrun it.
const RECENT_WINDOW_SIZE = 50;

/**
 * imapClient.js's own listNewMessages(path, sinceUid) is a genuinely cheap
 * incremental check because IMAP UIDs are guaranteed to increase with
 * arrival order — "anything with a uid above this one?" is a precise,
 * near-free query. EWS ItemIds carry no such ordering signal at all, so
 * `sinceUid` is accepted only for signature parity with the dispatcher and
 * otherwise ignored here. Instead, this just re-checks the same bounded
 * recent-by-date window every tick (a cheap FindItem, same shape as a
 * shallow listMessages page) and lets cache.js's own upsertMessages() do
 * the actual dedup — it already computes "genuinely new" by checking what's
 * already cached, so re-including some already-known messages here is
 * harmless, not a bug. The real cost difference from IMAP: a small fixed
 * per-tick fetch instead of near-zero when nothing changed, not a
 * correctness gap. A proper EWS-native incremental primitive
 * (SyncFolderItems, with its own persisted per-folder sync-state token) is
 * the right long-term replacement for this — deliberately deferred (see the
 * EWS plan): Exchange 2013 specifically has known SyncFolderItems
 * sync-state edge cases, and this simpler version is already covered by
 * sync.js's own periodic full-reconcile pass for anything it might miss.
 */
export async function listNewMessages(path, sinceUid) {
  const { messages } = await listMessages(path, { page: 1, pageSize: RECENT_WINDOW_SIZE });
  return messages;
}

// ---------- single message ----------

/**
 * Fetches item:MimeContent — Exchange's base64-encoded raw RFC822 blob —
 * so the shared parsing in messageParse.js (built around a raw Buffer, same
 * as imapClient.js's own IMAP BODY[] fetch) can be reused as-is instead of
 * a second full MIME-parsing implementation. The blob is whatever Exchange
 * stored, so anything messageParse.js handles for IMAP it handles here too.
 */
export async function getMessageSource(path, uid) {
  const acc = currentAccount();
  const body = `<m:GetItem>
    <m:ItemShape>
      <t:BaseShape>IdOnly</t:BaseShape>
      <t:AdditionalProperties>
        <t:FieldURI FieldURI="item:MimeContent"/>
        <t:FieldURI FieldURI="message:IsRead"/>
        <t:FieldURI FieldURI="item:Flag"/>
        ${VERB_PROP}
      </t:AdditionalProperties>
    </m:ItemShape>
    <m:ItemIds><t:ItemId Id="${escXml(uid)}"/></m:ItemIds>
  </m:GetItem>`;
  const xml = await soapRequest(acc.ews, 'GetItem', body);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.GetItemResponse?.ResponseMessages?.GetItemResponseMessage)[0];
  checkResponseCode(msg, 'GetItem');
  const item = itemsOf(msg?.Items)[0];
  if (!item) throw new Error('Message not found');
  // fast-xml-parser represents an attribute-bearing text node (MimeContent
  // carries a CharacterSet attribute) as {'@_CharacterSet': ..., '#text': ...}
  // rather than a plain string.
  const mime = item.MimeContent;
  const base64 = typeof mime === 'object' ? mime?.['#text'] : mime;
  if (!base64) throw new Error('Exchange did not return message content (MimeContent)');
  rememberChangeKey(acc, path, uid, item.ItemId?.['@_ChangeKey']);
  const flags = [];
  if (boolOf(item.IsRead)) flags.push('\\Seen');
  if ((item.Flag?.FlagStatus || '') === 'Flagged') flags.push('\\Flagged');
  // Named the way the IMAP backend names them, so anything reading these two
  // doesn't have to know which kind of account it is looking at.
  const verb = verbState(item);
  if (verb.answered) flags.push('\\Answered');
  if (verb.forwarded) flags.push('$Forwarded');
  return { source: Buffer.from(base64, 'base64'), flags };
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

// ---------- status ----------

export async function imapStatus() {
  const acc = currentAccount();
  try {
    await resolveWellKnown(acc);
    return { connected: true, user: acc.email, host: acc.ews.url };
  } catch (e) {
    return { connected: false, error: e.message, host: acc.ews.url };
  }
}

/**
 * One-off probe for accounts.js#testConnection — the wizard's "Test & save"
 * step, which runs on raw form input before any account row (or ALS
 * accountId) exists at all, so it can't go through currentAccount() the
 * rest of this file uses. Takes plain credentials ({url, domain, user,
 * pass, tlsRejectUnauthorized}) and does a single throwaway GetFolder call —
 * same one resolveWellKnown() itself makes, just for one folder instead of
 * five, enough to prove the URL/NTLM credentials actually work (not the
 * cert setting — see the file-level comment on why that isn't wired up).
 * Exchange's well-known folder ids are fixed protocol constants, not
 * something to auto-detect the way IMAP's specialUse flags are — so this
 * returns Hmelj's own fixed default special-folder names (matching
 * WELL_KNOWN_PATH) rather than inspecting anything server-side for them.
 */
export async function testConnection(ewsCreds) {
  const xml = await soapRequest(ewsCreds, 'GetFolder', `<m:GetFolder>
    <m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape>
    <m:FolderIds><t:DistinguishedFolderId Id="inbox"/></m:FolderIds>
  </m:GetFolder>`);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.GetFolderResponse?.ResponseMessages?.GetFolderResponseMessage)[0];
  checkResponseCode(msg, 'GetFolder');
  return { sentFolder: 'Sent', draftsFolder: 'Drafts', trashFolder: 'Trash', junkFolder: 'Junk' };
}

// ---------- contacts ----------

/** One EWS contact's e-mail entries, normalized to plain SMTP addresses.
 *
 * Exchange stores up to three per contact (EmailAddress1..3) and the value is
 * not always a bare address: an internal recipient can come back as an X500/EX
 * path (`/o=ExchangeLabs/ou=…/cn=…`) with no @ in it at all, and some entries
 * arrive SMTP-prefixed or in `Display Name <addr>` form. Anything that doesn't
 * reduce to something with an @ is dropped rather than imported as a contact
 * nothing can actually be sent to. */
function contactEmails(entryOrEntries) {
  const out = [];
  for (const e of asArray(entryOrEntries)) {
    let v = String(typeof e === 'object' ? (e['#text'] ?? '') : e).trim();
    if (!v) continue;
    const angled = /<([^>]+)>/.exec(v);           // "Marko Novak <marko@firma.si>"
    if (angled) v = angled[1].trim();
    v = v.replace(/^smtp:/i, '').trim();          // "SMTP:marko@firma.si"
    if (v.includes('@')) out.push(v);
  }
  return out;
}

/**
 * Every contact in the account's own Contacts folder, as `{name, email}` rows
 * ready for the shared import path in server/index.js.
 *
 * Deliberately the PERSONAL Contacts folder only (`DistinguishedFolderId
 * Id="contacts"`), never the Global Address List — the GAL is the whole
 * company directory, is not the user's to copy, and would swamp a personal
 * address book. (Looking someone up in the GAL on demand is ResolveNames, a
 * different feature.)
 *
 * Read-only: FindItem with an explicit property list, paged through with
 * IndexedPageItemView until Exchange says it's the last page. The properties
 * are requested as IndexedFieldURI per slot rather than asking for the whole
 * `contacts:EmailAddresses` collection, which FindItem refuses. A contact with
 * several addresses yields several rows — the caller de-dupes by address
 * anyway, and dropping the extras would silently lose the work address of
 * everyone whose personal one happens to be listed first.
 */
export async function listContacts({ pageSize = 200, maxPages = 25 } = {}) {
  const acc = currentAccount();
  const out = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const body = `<m:FindItem Traversal="Shallow">
    <m:ItemShape>
      <t:BaseShape>IdOnly</t:BaseShape>
      <t:AdditionalProperties>
        <t:FieldURI FieldURI="contacts:DisplayName"/>
        <t:FieldURI FieldURI="contacts:CompanyName"/>
        <t:IndexedFieldURI FieldURI="contacts:EmailAddress" FieldIndex="EmailAddress1"/>
        <t:IndexedFieldURI FieldURI="contacts:EmailAddress" FieldIndex="EmailAddress2"/>
        <t:IndexedFieldURI FieldURI="contacts:EmailAddress" FieldIndex="EmailAddress3"/>
      </t:AdditionalProperties>
    </m:ItemShape>
    <m:IndexedPageItemView MaxEntriesReturned="${pageSize}" Offset="${offset}" BasePoint="Beginning"/>
    <m:ParentFolderIds><t:DistinguishedFolderId Id="contacts"/></m:ParentFolderIds>
  </m:FindItem>`;
    const xml = await soapRequest(acc.ews, 'FindItem', body);
    const parsed = xmlParser.parse(xml);
    const msg = asArray(parsed?.Envelope?.Body?.FindItemResponse?.ResponseMessages?.FindItemResponseMessage)[0];
    checkResponseCode(msg, 'FindItem');
    const root = msg?.RootFolder;
    for (const c of asArray(root?.Items?.Contact)) {
      const name = String(c?.DisplayName || '').trim();
      const company = String(c?.CompanyName || '').trim();
      for (const email of contactEmails(c?.EmailAddresses?.Entry)) {
        out.push({ name: name || company, email });
      }
    }
    // Exchange reports the end of the range itself; trusting the returned count
    // instead would loop forever on a server that pads or trims a page.
    if (boolOf(root?.['@_IncludesLastItemInRange']) || !asArray(root?.Items?.Contact).length) break;
    offset += pageSize;
  }
  return out;
}

/**
 * The same Contacts folder, as whole ITEMS rather than flattened `{name, email}`
 * rows — for live sync (server/contactsSync/ewsContacts.js), which needs three
 * things the import path never did.
 *
 *   - the `ItemId`, so a contact can be followed across syncs rather than
 *     re-imported as a duplicate every time;
 *   - the `ChangeKey`, which is EWS's ETag: it changes whenever the item does,
 *     so comparing it is how "what changed" is answered without re-reading
 *     every contact's contents;
 *   - one row per CONTACT, not per address, because a card is the unit that
 *     gets created, updated and deleted.
 *
 * Kept separate from listContacts() rather than replacing it: that one feeds the
 * one-shot import and the compose picker, its shape is what half a dozen call
 * sites expect, and widening it to carry sync metadata would make every one of
 * them handle fields they have no use for.
 *
 * Read-only, personal Contacts folder only — for why never the GAL, see
 * listContacts above.
 */
export async function listContactItems({ pageSize = 200, maxPages = 25 } = {}) {
  const acc = currentAccount();
  const out = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const body = `<m:FindItem Traversal="Shallow">
    <m:ItemShape>
      <t:BaseShape>IdOnly</t:BaseShape>
      <t:AdditionalProperties>
        <t:FieldURI FieldURI="contacts:DisplayName"/>
        <t:FieldURI FieldURI="contacts:CompanyName"/>
        <t:FieldURI FieldURI="contacts:GivenName"/>
        <t:FieldURI FieldURI="contacts:Surname"/>
        <t:FieldURI FieldURI="item:LastModifiedTime"/>
        <t:IndexedFieldURI FieldURI="contacts:EmailAddress" FieldIndex="EmailAddress1"/>
        <t:IndexedFieldURI FieldURI="contacts:EmailAddress" FieldIndex="EmailAddress2"/>
        <t:IndexedFieldURI FieldURI="contacts:EmailAddress" FieldIndex="EmailAddress3"/>
      </t:AdditionalProperties>
    </m:ItemShape>
    <m:IndexedPageItemView MaxEntriesReturned="${pageSize}" Offset="${offset}" BasePoint="Beginning"/>
    <m:ParentFolderIds><t:DistinguishedFolderId Id="contacts"/></m:ParentFolderIds>
  </m:FindItem>`;
    const xml = await soapRequest(acc.ews, 'FindItem', body);
    const parsed = xmlParser.parse(xml);
    const msg = asArray(parsed?.Envelope?.Body?.FindItemResponse?.ResponseMessages?.FindItemResponseMessage)[0];
    checkResponseCode(msg, 'FindItem');
    const root = msg?.RootFolder;
    const items = asArray(root?.Items?.Contact);
    for (const c of items) {
      const id = c?.ItemId?.['@_Id'];
      if (!id) continue;
      out.push({
        id,
        // EWS's ETag. An item whose ChangeKey is unchanged is byte-for-byte the
        // item we already hold, so nothing needs re-reading.
        changeKey: c?.ItemId?.['@_ChangeKey'] || '',
        displayName: String(c?.DisplayName || '').trim(),
        company: String(c?.CompanyName || '').trim(),
        givenName: String(c?.GivenName || '').trim(),
        surname: String(c?.Surname || '').trim(),
        lastModified: String(c?.LastModifiedTime || ''),
        emails: contactEmails(c?.EmailAddresses?.Entry),
      });
    }
    if (boolOf(root?.['@_IncludesLastItemInRange']) || !items.length) break;
    offset += pageSize;
  }
  return out;
}

// ---------- calendars ----------

/**
 * The mailbox's calendar folders. The default one is a DistinguishedFolderId,
 * so it is listed explicitly rather than searched for — its display name is
 * localised ("Koledar" on a Slovenian mailbox) and matching on that would work
 * on exactly one language.
 */
export async function listCalendarFolders({ pageSize = 100 } = {}) {
  const acc = currentAccount();

  // The default calendar, kept under its DISTINGUISHED id — that id is stable
  // where the opaque FolderId is not, and calendarView() takes it back.
  //
  // Its real name and real id are asked for separately, and both matter:
  //
  //   the NAME, because Exchange localizes it (a Slovenian mailbox calls it
  //   "Koledar") and the account's own label — "Služba" — is what the user
  //   called the mailbox, not what the server calls the folder;
  //
  //   the ID, because it is the only sound way to recognize the same folder in
  //   the FindFolder listing below. Display names are localized, renameable and
  //   not unique, so matching on them let the default calendar through a second
  //   time under its opaque id, and the mailbox appeared to have two identical
  //   calendars.
  const def = { id: 'calendar', displayName: 'Calendar', distinguished: true, readOnly: false };
  let defaultRealId = '';
  try {
    const xml = await soapRequest(acc.ews, 'GetFolder', `<m:GetFolder>
      <m:FolderShape><t:BaseShape>Default</t:BaseShape></m:FolderShape>
      <m:FolderIds><t:DistinguishedFolderId Id="calendar"/></m:FolderIds>
    </m:GetFolder>`);
    const parsed = xmlParser.parse(xml);
    const msg = asArray(parsed?.Envelope?.Body?.GetFolderResponse?.ResponseMessages?.GetFolderResponseMessage)[0];
    checkResponseCode(msg, 'GetFolder');
    const f = asArray(msg?.Folders?.CalendarFolder)[0];
    if (f?.DisplayName) def.displayName = String(f.DisplayName);
    defaultRealId = f?.FolderId?.['@_Id'] || '';
  } catch (e) {
    // Not fatal: without it the name falls back to "Calendar" and the dedupe
    // below falls back to comparing names, which is what it did before.
    ilog.debug(`Could not read the default calendar folder (${e.message})`);
  }

  const out = [def];
  const body = `<m:FindFolder Traversal="Deep">
    <m:FolderShape>
      <t:BaseShape>IdOnly</t:BaseShape>
      <t:AdditionalProperties>
        <t:FieldURI FieldURI="folder:DisplayName"/>
        <t:FieldURI FieldURI="folder:FolderClass"/>
      </t:AdditionalProperties>
    </m:FolderShape>
    <m:IndexedPageFolderView MaxEntriesReturned="${pageSize}" Offset="0" BasePoint="Beginning"/>
    <m:ParentFolderIds><t:DistinguishedFolderId Id="msgfolderroot"/></m:ParentFolderIds>
  </m:FindFolder>`;
  try {
    const xml = await soapRequest(acc.ews, 'FindFolder', body);
    const parsed = xmlParser.parse(xml);
    const msg = asArray(parsed?.Envelope?.Body?.FindFolderResponse?.ResponseMessages?.FindFolderResponseMessage)[0];
    checkResponseCode(msg, 'FindFolder');
    for (const f of asArray(msg?.RootFolder?.Folders?.CalendarFolder)) {
      const id = f?.FolderId?.['@_Id'];
      if (!id) continue;
      // The default calendar is already in the list under its distinguished id;
      // adding it again under its opaque one would sync everything twice.
      if (defaultRealId ? id === defaultRealId : String(f.DisplayName || '') === def.displayName) continue;
      out.push({ id, displayName: String(f.DisplayName || 'Calendar'), distinguished: false, readOnly: false });
    }
  } catch (e) {
    // A mailbox that will not enumerate its folders still has the default
    // calendar, and that is the one anybody actually wants.
    ilog.debug(`Could not list calendar folders (${e.message}) — offering the default calendar only`);
  }
  return out;
}

/**
 * Occurrences in a window, with recurrence ALREADY EXPANDED by Exchange.
 *
 * `CalendarView` is what makes that happen: with it, FindItem returns each
 * occurrence of a recurring series separately, at its real time, with Exchange
 * applying its own recurrence and timezone rules. The alternative — reading the
 * series master's Recurrence element and re-implementing those rules here — is
 * both more code and less correct, and the same reasoning applies as for Graph
 * (see graphClient.js#calendarView).
 *
 * Exchange caps a CalendarView at 1000 items per request regardless of what is
 * asked for, so the window is walked in slices rather than paged.
 */
export async function calendarView(folderId, fromIso, toIso, { maxItems = 1000 } = {}) {
  const acc = currentAccount();
  const parent = folderId && folderId !== 'calendar'
    ? `<t:FolderId Id="${escXml(folderId)}"/>`
    : '<t:DistinguishedFolderId Id="calendar"/>';
  const body = `<m:FindItem Traversal="Shallow">
    <m:ItemShape>
      <t:BaseShape>IdOnly</t:BaseShape>
      <t:AdditionalProperties>
        <t:FieldURI FieldURI="item:Subject"/>
        <t:FieldURI FieldURI="calendar:Start"/>
        <t:FieldURI FieldURI="calendar:End"/>
        <t:FieldURI FieldURI="calendar:IsAllDayEvent"/>
        <t:FieldURI FieldURI="calendar:Location"/>
        <t:FieldURI FieldURI="calendar:Organizer"/>
        <t:FieldURI FieldURI="calendar:LegacyFreeBusyStatus"/>
        <t:FieldURI FieldURI="calendar:CalendarItemType"/>
        <t:FieldURI FieldURI="calendar:UID"/>
        <t:FieldURI FieldURI="item:LastModifiedTime"/>
      </t:AdditionalProperties>
    </m:ItemShape>
    <m:CalendarView StartDate="${escXml(fromIso)}" EndDate="${escXml(toIso)}" MaxEntriesReturned="${maxItems}"/>
    <m:ParentFolderIds>${parent}</m:ParentFolderIds>
  </m:FindItem>`;
  const xml = await soapRequest(acc.ews, 'FindItem', body);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.FindItemResponse?.ResponseMessages?.FindItemResponseMessage)[0];
  checkResponseCode(msg, 'FindItem');
  const out = [];
  for (const it of asArray(msg?.RootFolder?.Items?.CalendarItem)) {
    const id = it?.ItemId?.['@_Id'];
    if (!id || !it?.Start) continue;
    out.push({
      id,
      changeKey: it?.ItemId?.['@_ChangeKey'] || '',
      // Exchange's UID is the iCalendar UID of the series. Every occurrence of
      // a series shares it, which is why the occurrence's own start has to be
      // part of its identity here.
      uid: String(it.UID || id),
      subject: String(it.Subject || ''),
      start: String(it.Start),
      end: String(it.End || it.Start),
      allDay: boolOf(it.IsAllDayEvent),
      location: String(it.Location || ''),
      organizerName: String(it.Organizer?.Mailbox?.Name || ''),
      organizerEmail: String(it.Organizer?.Mailbox?.EmailAddress || ''),
      // OOF/Tentative/Busy block the time; Free does not — the same distinction
      // iCalendar makes with TRANSP.
      free: String(it.LegacyFreeBusyStatus || 'Busy') === 'Free',
      itemType: String(it.CalendarItemType || 'Single'),
      lastModified: String(it.LastModifiedTime || ''),
    });
  }
  return out;
}

/**
 * One calendar item in full: its body, its attendees, and the online-meeting
 * link Exchange keeps in a field of its own.
 *
 * FindItem never returns a body — that is an EWS rule, not an omission in
 * calendarView above — so the month grid is built without one and this fills it
 * in when somebody opens an event. One round trip, on demand, rather than
 * hundreds on every sync.
 *
 * `calendar:JoinOnlineMeetingUrl` is Exchange 2013 and later, and an older
 * server rejects the WHOLE request for naming a property it does not know. So
 * it is tried once and retried without, rather than costing every pre-2013
 * mailbox its event details.
 */
async function getCalendarItemWith(acc, itemId, extraProps) {
  const body = `<m:GetItem>
    <m:ItemShape>
      <t:BaseShape>IdOnly</t:BaseShape>
      <t:BodyType>Text</t:BodyType>
      <t:AdditionalProperties>
        <t:FieldURI FieldURI="item:Subject"/>
        <t:FieldURI FieldURI="item:Body"/>
        <t:FieldURI FieldURI="calendar:Location"/>
        <t:FieldURI FieldURI="calendar:Organizer"/>
        <t:FieldURI FieldURI="calendar:RequiredAttendees"/>
        <t:FieldURI FieldURI="calendar:OptionalAttendees"/>
        ${extraProps}
      </t:AdditionalProperties>
    </m:ItemShape>
    <m:ItemIds><t:ItemId Id="${escXml(itemId)}"/></m:ItemIds>
  </m:GetItem>`;
  const xml = await soapRequest(acc.ews, 'GetItem', body);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.GetItemResponse?.ResponseMessages?.GetItemResponseMessage)[0];
  checkResponseCode(msg, 'GetItem');
  return asArray(msg?.Items?.CalendarItem)[0] || null;
}

const ONLINE_MEETING_PROPS =
  '<t:FieldURI FieldURI="calendar:IsOnlineMeeting"/><t:FieldURI FieldURI="calendar:JoinOnlineMeetingUrl"/>';

export async function getCalendarItem(itemId) {
  const acc = currentAccount();
  let item = null;
  try {
    item = await getCalendarItemWith(acc, itemId, ONLINE_MEETING_PROPS);
  } catch (e) {
    ilog.debug(`GetItem with the online-meeting properties failed (${e.message}) — retrying without them`);
    item = await getCalendarItemWith(acc, itemId, '');
  }
  if (!item) return null;

  const people = (node) => asArray(node?.Attendee).map((a) => ({
    name: String(a?.Mailbox?.Name || ''),
    address: String(a?.Mailbox?.EmailAddress || ''),
    status: String(a?.ResponseType || ''),
  })).filter((p) => p.address);

  // Text was asked for, but a server that ignores BodyType still answers HTML,
  // and it says which in the attribute rather than in the value.
  const bodyNode = item.Body;
  const bodyText = bodyNode && typeof bodyNode === 'object' ? String(bodyNode['#text'] ?? '') : String(bodyNode ?? '');
  const isHtml = String(bodyNode?.['@_BodyType'] || '').toLowerCase() === 'html';

  return {
    description: bodyText,
    descriptionIsHtml: isHtml,
    location: String(item.Location || ''),
    joinUrl: String(item.JoinOnlineMeetingUrl || ''),
    organizer: item.Organizer?.Mailbox?.EmailAddress
      ? { name: String(item.Organizer.Mailbox.Name || ''), address: String(item.Organizer.Mailbox.EmailAddress) }
      : null,
    attendees: [
      ...people(item.RequiredAttendees),
      ...people(item.OptionalAttendees).map((p) => ({ ...p, optional: true })),
    ],
  };
}

/* ---------- calendar writes ----------
 *
 * EWS updates are stated PROPERTY BY PROPERTY: a `SetItemField` naming the
 * FieldURI, the type, and the new value — or a `DeleteItemField` to clear one.
 * There is no "here is the new item" form, so an update is assembled from the
 * fields that actually changed. That is a feature rather than a chore: an
 * untouched property is never sent, so an edit cannot clobber something Hmelj
 * does not model.
 *
 * The order of SetItemFields matters to Exchange for a few properties (a
 * recurrence must follow the start), so the caller builds the list.
 *
 * ── Which id addresses what ────────────────────────────────────────────────
 *   an occurrence's own ItemId   one instance; Exchange makes the exception
 *   a RecurringMasterItemId      the series and its rule
 * The second is reached from the first with `<t:RecurringMasterItemId>`, which
 * is an ID SHAPE rather than a request of its own — GetItem accepts it in
 * place of an ItemId and answers with the master.
 */

/** `SendMeetingInvitations` is required on every calendar Create/Update, and
 *  Exchange rejects the request without it. Hmelj asks Exchange to send them:
 *  ewsCalendar declares sendsInvitationsItself, so nothing else will. */
const SEND_TO_ALL = 'SendToAllAndSaveCopy';
const SEND_TO_CHANGED = 'SendToAllAndSaveCopy';

/** One SetItemField for a calendar property. */
export const calField = (uri, xml) =>
  `<t:SetItemField><t:FieldURI FieldURI="${uri}"/><t:CalendarItem>${xml}</t:CalendarItem></t:SetItemField>`;
export const calDelete = (uri) => `<t:DeleteItemField><t:FieldURI FieldURI="${uri}"/></t:DeleteItemField>`;

export async function createCalendarItem(folderId, itemXml) {
  const acc = currentAccount();
  const parent = folderId && folderId !== 'calendar'
    ? `<t:FolderId Id="${escXml(folderId)}"/>`
    : '<t:DistinguishedFolderId Id="calendar"/>';
  const body = `<m:CreateItem SendMeetingInvitations="${SEND_TO_ALL}">
    <m:SavedItemFolderId>${parent}</m:SavedItemFolderId>
    <m:Items><t:CalendarItem>${itemXml}</t:CalendarItem></m:Items>
  </m:CreateItem>`;
  const xml = await soapRequest(acc.ews, 'CreateItem', body);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.CreateItemResponse?.ResponseMessages?.CreateItemResponseMessage)[0];
  checkResponseCode(msg, 'CreateItem');
  const item = asArray(msg?.Items?.CalendarItem)[0];
  return { id: item?.ItemId?.['@_Id'] || '', changeKey: item?.ItemId?.['@_ChangeKey'] || '' };
}

/** The ChangeKey Exchange demands alongside an ItemId on every write. Fetched
 *  rather than remembered: a stale one is a rejected update, and the item may
 *  have been touched in Outlook since the last sync. */
async function changeKeyOf(acc, itemId) {
  const xml = await soapRequest(acc.ews, 'GetItem', `<m:GetItem>
    <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>
    <m:ItemIds><t:ItemId Id="${escXml(itemId)}"/></m:ItemIds>
  </m:GetItem>`);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.GetItemResponse?.ResponseMessages?.GetItemResponseMessage)[0];
  checkResponseCode(msg, 'GetItem');
  return asArray(msg?.Items?.CalendarItem)[0]?.ItemId?.['@_ChangeKey'] || '';
}

export async function updateCalendarItem(itemId, fieldsXml) {
  if (!fieldsXml) return true;
  const acc = currentAccount();
  const ck = await changeKeyOf(acc, itemId);
  const body = `<m:UpdateItem ConflictResolution="AutoResolve"
      MessageDisposition="SaveOnly" SendMeetingInvitationsOrCancellations="${SEND_TO_CHANGED}">
    <m:ItemChanges>
      <t:ItemChange>
        <t:ItemId Id="${escXml(itemId)}" ChangeKey="${escXml(ck)}"/>
        <t:Updates>${fieldsXml}</t:Updates>
      </t:ItemChange>
    </m:ItemChanges>
  </m:UpdateItem>`;
  const xml = await soapRequest(acc.ews, 'UpdateItem', body);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.UpdateItemResponse?.ResponseMessages?.UpdateItemResponseMessage)[0];
  checkResponseCode(msg, 'UpdateItem');
  return true;
}

export async function deleteCalendarItem(itemId) {
  const acc = currentAccount();
  // MoveToDeletedItems, not HardDelete: an event removed by accident should be
  // recoverable from Deleted Items the same way a message is.
  const body = `<m:DeleteItem DeleteType="MoveToDeletedItems" SendMeetingCancellations="SendToAllAndSaveCopy">
    <m:ItemIds><t:ItemId Id="${escXml(itemId)}"/></m:ItemIds>
  </m:DeleteItem>`;
  const xml = await soapRequest(acc.ews, 'DeleteItem', body);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.DeleteItemResponse?.ResponseMessages?.DeleteItemResponseMessage)[0];
  checkResponseCode(msg, 'DeleteItem');
  return true;
}

/**
 * The series master behind an occurrence: its ItemId and its Recurrence.
 *
 * `<t:RecurringMasterItemId OccurrenceId="…"/>` is an ID SHAPE — it goes where
 * an ItemId goes and Exchange resolves it to the master. Returns null when the
 * item is not part of a series, which is how a one-off is recognized.
 */
export async function recurringMasterOf(occurrenceId) {
  const acc = currentAccount();
  const body = `<m:GetItem>
    <m:ItemShape>
      <t:BaseShape>IdOnly</t:BaseShape>
      <t:AdditionalProperties>
        <t:FieldURI FieldURI="calendar:Recurrence"/>
        <t:FieldURI FieldURI="calendar:Start"/>
      </t:AdditionalProperties>
    </m:ItemShape>
    <m:ItemIds><t:RecurringMasterItemId OccurrenceId="${escXml(occurrenceId)}"/></m:ItemIds>
  </m:GetItem>`;
  try {
    const xml = await soapRequest(acc.ews, 'GetItem', body);
    const parsed = xmlParser.parse(xml);
    const msg = asArray(parsed?.Envelope?.Body?.GetItemResponse?.ResponseMessages?.GetItemResponseMessage)[0];
    checkResponseCode(msg, 'GetItem');
    const item = asArray(msg?.Items?.CalendarItem)[0];
    if (!item?.ItemId?.['@_Id']) return null;
    return {
      id: item.ItemId['@_Id'],
      changeKey: item.ItemId['@_ChangeKey'] || '',
      recurrence: item.Recurrence || null,
      start: String(item.Start || ''),
    };
  } catch (e) {
    // Exchange answers ErrorInvalidIdMalformed for an id that is not an
    // occurrence — which is the ordinary "this is a one-off" case, not a fault.
    ilog.debug(`No recurring master for that item (${e.message})`);
    return null;
  }
}

// ---------- flags & actions ----------

// ChangeKey conflict faults — EWS's way of saying "this item changed since
// you last looked at it" (another client edited it, or our cache was just
// stale/cold). updateItems() below catches exactly these and retries once
// with a freshly-resolved ChangeKey; anything else is a real failure.
const CHANGEKEY_CONFLICT_CODES = new Set([
  'ErrorChangeKeyMismatch', 'ErrorInvalidChangeKey', 'ErrorStaleObject', 'ErrorIrresolvableConflict',
]);

/** Resolves each uid's current ChangeKey — from the in-memory cache when
 * available, or a single batched GetItem for whichever ones aren't (cold
 * cache, or `forceRefresh` after a conflict). Only setFlags (via
 * updateItems) needs this; Move/Copy/Delete don't require a ChangeKey at
 * all. Returns a Map(uid -> changeKey); a uid EWS itself couldn't resolve
 * (e.g. deleted server-side) simply won't have an entry — callers building
 * ItemChange XML fall back to an empty ChangeKey, which EWS will itself
 * reject with a clear error rather than silently doing the wrong thing. */
async function resolveChangeKeys(acc, folder, uids, { forceRefresh = false } = {}) {
  const result = new Map();
  const need = [];
  for (const uid of uids) {
    const cached = !forceRefresh && changeKeyCache.get(`${cacheKey(acc)}:${folder}:${uid}`);
    if (cached) result.set(uid, cached);
    else need.push(uid);
  }
  if (need.length) {
    const body = `<m:GetItem>
      <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>
      <m:ItemIds>${need.map((uid) => `<t:ItemId Id="${escXml(uid)}"/>`).join('')}</m:ItemIds>
    </m:GetItem>`;
    const xml = await soapRequest(acc.ews, 'GetItem', body);
    const parsed = xmlParser.parse(xml);
    const messages = asArray(parsed?.Envelope?.Body?.GetItemResponse?.ResponseMessages?.GetItemResponseMessage);
    messages.forEach((m, i) => {
      if (m.ResponseCode !== 'NoError') return; // leave unresolved — the caller's own batch call surfaces a proper error for this id
      const uid = need[i];
      const ck = itemsOf(m.Items)[0]?.ItemId?.['@_ChangeKey'];
      if (ck) { rememberChangeKey(acc, folder, uid, ck); result.set(uid, ck); }
    });
  }
  return result;
}

/**
 * Answer a meeting invitation: accept, tentatively accept, or decline.
 *
 * EWS models the answer as a NEW item created against the invitation —
 * AcceptItem / TentativelyAcceptItem / DeclineItem, each carrying a
 * ReferenceItemId pointing back at the request. Exchange does the rest itself:
 * it writes the event into the calendar with the right response state and mails
 * the organizer. There is no separate "put it in my calendar" call to make, and
 * none of this needs calendar access of our own — which is why an invitation
 * can be answered properly long before Hmelj has any calendar of its own.
 *
 * `comment` becomes the body of the reply that goes to the organizer, which is
 * the "optional message" in the reading pane. Empty means the plain response
 * every mail client sends.
 *
 * `sendResponse: false` is Outlook's "Do not send a response": the answer is
 * recorded — the meeting still lands in the calendar with the right response
 * state — and the organizer is told nothing. In EWS that is the SAME CreateItem
 * with MessageDisposition="SaveOnly" instead of "SendAndSaveCopy"; creating the
 * response item is what drives the server-side processing, and the disposition
 * only decides whether it is also put in the post. It is the mapping the EWS
 * Managed API's own `MeetingRequest.Accept(sendResponse)` uses.
 */
const RESPOND_ITEM = { accept: 'AcceptItem', tentative: 'TentativelyAcceptItem', decline: 'DeclineItem' };

export async function respondToMeeting(path, uid, { action, comment = '', sendResponse = true } = {}) {
  const item = RESPOND_ITEM[action];
  if (!item) throw new Error(`Unknown meeting response "${action}"`);
  const acc = currentAccount();
  const disposition = sendResponse ? 'SendAndSaveCopy' : 'SaveOnly';
  // A stale ChangeKey is the one predictable failure here — the invitation was
  // very likely just marked read, which mints a new one. Resolved through the
  // same cache every other write uses, and refreshed once on conflict below.
  const send = async (forceRefresh) => {
    const ck = (await resolveChangeKeys(acc, path, [uid], { forceRefresh })).get(uid) || '';
    const body = `<m:CreateItem MessageDisposition="${disposition}">
      <m:Items>
        <t:${item}>
          ${comment && sendResponse ? `<t:Body BodyType="Text">${escXml(comment)}</t:Body>` : ''}
          <t:ReferenceItemId Id="${escXml(uid)}" ChangeKey="${escXml(ck)}"/>
        </t:${item}>
      </m:Items>
    </m:CreateItem>`;
    const xml = await soapRequest(acc.ews, 'CreateItem', body);
    const parsed = xmlParser.parse(xml);
    return asArray(parsed?.Envelope?.Body?.CreateItemResponse?.ResponseMessages?.CreateItemResponseMessage)[0];
  };

  let res = await send(false);
  if (res && res.ResponseCode !== 'NoError' && CHANGEKEY_CONFLICT_CODES.has(res.ResponseCode)) {
    res = await send(true);
  }
  checkResponseCode(res, 'CreateItem');
  changeKeyCache.delete(`${cacheKey(acc)}:${path}:${uid}`);
  // Exchange usually CONSUMES the invitation when it is answered — the default
  // mailbox setting moves the request to Deleted Items, which is what Outlook
  // does too. Usually, not always: the setting can be off, and then it stays.
  //
  // Asked rather than assumed, because both wrong answers are bad and visible.
  // Leaving a row for an item that is gone is what got reported: the list still
  // showed the invitation and opening it produced a raw
  // "ErrorItemNotFound — The specified object was not found in the store".
  // Deleting a row for an item that is still there would lose it from the list
  // until the next full reconcile. One IdOnly GetItem settles it.
  return { ok: true, action, sent: !!sendResponse, consumed: !(await itemExists(acc, uid)) };
}

/** Is this item still in the store? An IdOnly GetItem — the cheapest question
 *  EWS answers. Any error other than "not found" is reported as "still there",
 *  since dropping a message from the cache on a network blip would be worse. */
async function itemExists(acc, uid) {
  try {
    const xml = await soapRequest(acc.ews, 'GetItem', `<m:GetItem>
      <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>
      <m:ItemIds><t:ItemId Id="${escXml(uid)}"/></m:ItemIds>
    </m:GetItem>`);
    const parsed = xmlParser.parse(xml);
    const m = asArray(parsed?.Envelope?.Body?.GetItemResponse?.ResponseMessages?.GetItemResponseMessage)[0];
    return m?.ResponseCode === 'NoError';
  } catch (e) {
    ilog.debug(`itemExists(${uid}) could not be answered: ${e.message}`);
    return true;
  }
}

/** Batched UpdateItem — every uid gets the same field changes (e.g. "mark
 * these N messages read") in ONE SOAP round trip. Retries once, for just
 * the subset that came back with a ChangeKey conflict, after re-resolving
 * their ChangeKeys fresh from the server. */
async function updateItems(acc, folder, uids, fieldXml) {
  if (!uids.length) return;
  const runBatch = async (batchUids, changeKeys) => {
    const itemChanges = batchUids.map((uid) =>
      `<t:ItemChange><t:ItemId Id="${escXml(uid)}" ChangeKey="${escXml(changeKeys.get(uid) || '')}"/><t:Updates>${fieldXml}</t:Updates></t:ItemChange>`
    ).join('');
    const xml = await soapRequest(acc.ews, 'UpdateItem', `<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AlwaysOverwrite">
      <m:ItemChanges>${itemChanges}</m:ItemChanges>
    </m:UpdateItem>`);
    const parsed = xmlParser.parse(xml);
    return asArray(parsed?.Envelope?.Body?.UpdateItemResponse?.ResponseMessages?.UpdateItemResponseMessage);
  };

  const changeKeys = await resolveChangeKeys(acc, folder, uids);
  const responses = await runBatch(uids, changeKeys);
  const conflicted = [];
  responses.forEach((m, i) => {
    const uid = uids[i];
    if (m.ResponseCode === 'NoError') {
      const newCk = itemsOf(m.Items)[0]?.ItemId?.['@_ChangeKey'];
      if (newCk) rememberChangeKey(acc, folder, uid, newCk);
    } else if (CHANGEKEY_CONFLICT_CODES.has(m.ResponseCode)) {
      conflicted.push(uid);
    } else {
      throw new Error(`Exchange UpdateItem failed for one message: ${m.ResponseCode}${m.MessageText ? ' — ' + m.MessageText : ''}`);
    }
  });

  if (conflicted.length) {
    const freshKeys = await resolveChangeKeys(acc, folder, conflicted, { forceRefresh: true });
    const retryResponses = await runBatch(conflicted, freshKeys);
    retryResponses.forEach((m, i) => {
      const uid = conflicted[i];
      if (m.ResponseCode === 'NoError') {
        const newCk = itemsOf(m.Items)[0]?.ItemId?.['@_ChangeKey'];
        if (newCk) rememberChangeKey(acc, folder, uid, newCk);
      } else {
        throw new Error(`Exchange UpdateItem failed after ChangeKey retry: ${m.ResponseCode}${m.MessageText ? ' — ' + m.MessageText : ''}`);
      }
    });
  }
}

/** \Seen -> IsRead, \Flagged -> Flag.FlagStatus — the only two flags the UI
 * actually sends through this route (see app.js's quickToggleRead and the
 * star toggle). \Deleted/\Answered/\Draft have no direct EWS per-message
 * field the way IMAP's flags do; silently ignored here rather than erroring
 * on something nothing currently sends. */
export async function setFlags(path, uids, { add = [], remove = [] } = {}) {
  const acc = currentAccount();
  const sets = [];
  if (add.includes('\\Seen')) sets.push(`<t:SetItemField><t:FieldURI FieldURI="message:IsRead"/><t:Message><t:IsRead>true</t:IsRead></t:Message></t:SetItemField>`);
  if (remove.includes('\\Seen')) sets.push(`<t:SetItemField><t:FieldURI FieldURI="message:IsRead"/><t:Message><t:IsRead>false</t:IsRead></t:Message></t:SetItemField>`);
  if (add.includes('\\Flagged')) sets.push(`<t:SetItemField><t:FieldURI FieldURI="item:Flag"/><t:Message><t:Flag><t:FlagStatus>Flagged</t:FlagStatus></t:Flag></t:Message></t:SetItemField>`);
  if (remove.includes('\\Flagged')) sets.push(`<t:SetItemField><t:FieldURI FieldURI="item:Flag"/><t:Message><t:Flag><t:FlagStatus>NotFlagged</t:FlagStatus></t:Flag></t:Message></t:SetItemField>`);
  // "This was replied to / forwarded". One MAPI property holds both states, so
  // they are mutually exclusive here in a way IMAP's separate flag and keyword
  // are not — last action wins, which is also how Outlook behaves. There is no
  // removal case: nothing in Hmelj un-replies a message, and DeleteItemField on
  // this property is not something Exchange reliably honours.
  const verb = add.includes('\\Answered') ? VERB.REPLY
    : (add.some((f) => String(f).toLowerCase() === '$forwarded') ? VERB.FORWARD : null);
  if (verb !== null) sets.push(verbSetFields(verb));
  if (sets.length) await updateItems(acc, path, uids, sets.join(''));
  return { ok: true };
}

/** "Mark all as read" for a whole folder — a lean IdOnly FindItem restricted
 * to unread items (no envelope fields requested, unlike listMessages, which
 * would be wasted work here) followed by the same setFlags() every other
 * mark-read path already uses. MaxEntriesReturned caps how many unread
 * items one call can mark — 1000 covers any realistic personal-mailbox
 * backlog; a folder with more than that just needs the action run again to
 * catch the rest, same trade-off imapClient.js's search-based version
 * doesn't have to make (a real IMAP SEARCH has no such cap) but EWS's
 * paged FindItem does.
 */
export async function markAllRead(path) {
  const acc = currentAccount();
  const { id } = await resolveFolderId(path);
  const body = `<m:FindItem Traversal="Shallow">
    <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>
    <m:IndexedPageItemView MaxEntriesReturned="1000" Offset="0" BasePoint="Beginning"/>
    <m:Restriction><t:IsEqualTo><t:FieldURI FieldURI="message:IsRead"/><t:FieldURIOrConstant><t:Constant Value="false"/></t:FieldURIOrConstant></t:IsEqualTo></m:Restriction>
    <m:ParentFolderIds><t:FolderId Id="${escXml(id)}"/></m:ParentFolderIds>
  </m:FindItem>`;
  const xml = await soapRequest(acc.ews, 'FindItem', body);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.FindItemResponse?.ResponseMessages?.FindItemResponseMessage)[0];
  checkResponseCode(msg, 'FindItem');
  const items = itemsOf(msg?.RootFolder?.Items);
  const uids = items.map((it) => {
    const id2 = it.ItemId?.['@_Id'];
    rememberChangeKey(acc, path, id2, it.ItemId?.['@_ChangeKey']); // prime the cache — setFlags below would otherwise re-fetch each one's ChangeKey individually
    return id2;
  }).filter(Boolean);
  if (!uids.length) return { marked: 0, uids: [] };
  await setFlags(path, uids, { add: ['\\Seen'] });
  return { marked: uids.length, uids };
}

/** Cheap flags-only refresh for the background poller's reconciliation pass
 * (see sync.js#pollFolder) — same shape as imapClient.js's own refreshFlags:
 * one batched GetItem, IdOnly + just the two fields that matter. */
/**
 * Analytics full-folder scan — imapClient.js#scanMessages' contract on
 * Exchange. Built on this module's own listMessages paging rather than a
 * dedicated FindItem walk: EWS pages server-side anyway, and its item shape
 * already carries the one field analytics can't get any other way (Size, see
 * the mapping in listMessages).
 *
 * Two documented gaps vs the IMAP path, both intrinsic rather than shortcuts:
 * no `emailId` (Exchange ItemIds are already unique per message, and there are
 * no labels to dedupe across), and no List-Unsubscribe (it isn't in the
 * item summary, and one GetItem per message to read a header would cost far
 * more than the signal is worth).
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
      size: m.size || 0,
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
  const acc = currentAccount();
  const body = `<m:GetItem>
    <m:ItemShape>
      <t:BaseShape>IdOnly</t:BaseShape>
      <t:AdditionalProperties>
        <t:FieldURI FieldURI="message:IsRead"/>
        <t:FieldURI FieldURI="item:Flag"/>
        ${VERB_PROP}
      </t:AdditionalProperties>
    </m:ItemShape>
    <m:ItemIds>${uids.map((uid) => `<t:ItemId Id="${escXml(uid)}"/>`).join('')}</m:ItemIds>
  </m:GetItem>`;
  const xml = await soapRequest(acc.ews, 'GetItem', body);
  const parsed = xmlParser.parse(xml);
  const messages = asArray(parsed?.Envelope?.Body?.GetItemResponse?.ResponseMessages?.GetItemResponseMessage);
  const rows = [];
  messages.forEach((m, i) => {
    if (m.ResponseCode !== 'NoError') return; // e.g. ErrorItemNotFound — gone server-side; a full listMessages pass prunes that, not this
    const uid = uids[i];
    const item = itemsOf(m.Items)[0];
    if (item?.ItemId?.['@_ChangeKey']) rememberChangeKey(acc, path, uid, item.ItemId['@_ChangeKey']);
    // verbState(), not a hardcoded false — this row is written straight over the
    // cached one (cache.js#reconcileFlags), so `answered: false` here would wipe
    // the reply marker on every single poll.
    rows.push({ uid, seen: boolOf(item?.IsRead), flagged: (item?.Flag?.FlagStatus || '') === 'Flagged', ...verbState(item), deleted: false });
  });
  return rows;
}

/** Neither Move nor Copy nor Delete need a ChangeKey — that's only for
 * UpdateItem's "which version am I editing" optimistic-concurrency check;
 * relocating or removing an object has no equivalent ambiguity. */
export async function moveMessages(path, uids, target) {
  const acc = currentAccount();
  if (!uids.length) return { ok: true };
  const { id: targetId } = await resolveFolderId(target);
  const itemIds = uids.map((uid) => `<t:ItemId Id="${escXml(uid)}"/>`).join('');
  const xml = await soapRequest(acc.ews, 'MoveItem', `<m:MoveItem>
    <m:ToFolderId><t:FolderId Id="${escXml(targetId)}"/></m:ToFolderId>
    <m:ItemIds>${itemIds}</m:ItemIds>
  </m:MoveItem>`);
  const parsed = xmlParser.parse(xml);
  const messages = asArray(parsed?.Envelope?.Body?.MoveItemResponse?.ResponseMessages?.MoveItemResponseMessage);
  for (const m of messages) checkResponseCode(m, 'MoveItem');
  // A move mints a brand-new ItemId for the relocated copy — whatever was
  // cached for the old one is dead regardless of whether it's still there.
  for (const uid of uids) changeKeyCache.delete(`${cacheKey(acc)}:${path}:${uid}`);
  // Exchange returns those new ids in request order, and they are the only
  // handle on the relocated copy afterwards — what lets a delete be undone
  // (see imapClient.js#uidMapOf for the same idea over IMAP's COPYUID).
  const uidMap = {};
  uids.forEach((uid, i) => {
    const id = itemsOf(messages[i]?.Items)[0]?.ItemId?.['@_Id'];
    if (id) uidMap[uid] = id;
  });
  return { ok: true, destination: target, uidMap: Object.keys(uidMap).length ? uidMap : null };
}

export async function copyMessages(path, uids, target) {
  const acc = currentAccount();
  if (!uids.length) return { ok: true };
  const { id: targetId } = await resolveFolderId(target);
  const itemIds = uids.map((uid) => `<t:ItemId Id="${escXml(uid)}"/>`).join('');
  const xml = await soapRequest(acc.ews, 'CopyItem', `<m:CopyItem>
    <m:ToFolderId><t:FolderId Id="${escXml(targetId)}"/></m:ToFolderId>
    <m:ItemIds>${itemIds}</m:ItemIds>
  </m:CopyItem>`);
  const parsed = xmlParser.parse(xml);
  const messages = asArray(parsed?.Envelope?.Body?.CopyItemResponse?.ResponseMessages?.CopyItemResponseMessage);
  for (const m of messages) checkResponseCode(m, 'CopyItem');
  return { ok: true }; // the source item is untouched by a copy — nothing to invalidate in changeKeyCache
}

export async function hardDelete(path, uids) {
  const acc = currentAccount();
  if (!uids.length) return { ok: true };
  const itemIds = uids.map((uid) => `<t:ItemId Id="${escXml(uid)}"/>`).join('');
  const xml = await soapRequest(acc.ews, 'DeleteItem', `<m:DeleteItem DeleteType="HardDelete">
    <m:ItemIds>${itemIds}</m:ItemIds>
  </m:DeleteItem>`);
  const parsed = xmlParser.parse(xml);
  const messages = asArray(parsed?.Envelope?.Body?.DeleteItemResponse?.ResponseMessages?.DeleteItemResponseMessage);
  for (const m of messages) checkResponseCode(m, 'DeleteItem');
  for (const uid of uids) changeKeyCache.delete(`${cacheKey(acc)}:${path}:${uid}`);
  return { ok: true };
}

/**
 * Mirrors imapClient.js#deleteMessages' contract (same deleteBehavior/
 * markReadOnDelete settings, same {ok, mode, action} return shape) with one
 * real gap: Exchange has no equivalent of IMAP's 'flag' mode (mark
 * \Deleted, leave the message sitting right where it is) — there's no
 * per-message "deleted but still in this folder" state to set. Falls back
 * to the same soft move 'trash' mode already does, which is the
 * less-surprising mismatch: the message relocates instead of the delete
 * silently doing nothing, but nothing is destroyed that the user's own
 * setting didn't ask to keep recoverable.
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
    if (mode === 'flag') ilog.debug(`${path}: deleteBehavior 'flag' has no Exchange equivalent (no in-place \\Deleted state) — moving to Trash instead`);
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

function mailboxXml(addr) {
  return `<t:Mailbox>${addr.name ? `<t:Name>${escXml(addr.name)}</t:Name>` : ''}<t:EmailAddress>${escXml(addr.address)}</t:EmailAddress></t:Mailbox>`;
}
function recipientsXml(tag, list) {
  return list && list.length ? `<t:${tag}>${list.map(mailboxXml).join('')}</t:${tag}>` : '';
}

async function createItem(raw, { disposition, savedFolderId, extraXml = '' }) {
  const acc = currentAccount();
  const body = `<m:CreateItem MessageDisposition="${disposition}">
    ${savedFolderId ? `<m:SavedItemFolderId><t:FolderId Id="${escXml(savedFolderId)}"/></m:SavedItemFolderId>` : ''}
    <m:Items>
      <t:Message>
        <t:MimeContent>${raw.toString('base64')}</t:MimeContent>
        ${extraXml}
      </t:Message>
    </m:Items>
  </m:CreateItem>`;
  const xml = await soapRequest(acc.ews, 'CreateItem', body);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.CreateItemResponse?.ResponseMessages?.CreateItemResponseMessage)[0];
  checkResponseCode(msg, 'CreateItem');
  const item = itemsOf(msg?.Items)[0];
  return { uid: item?.ItemId?.['@_Id'] || null };
}

/**
 * Sends via CreateItem(MessageDisposition="SendAndSaveCopy") — one call
 * both delivers the message AND saves the Sent-folder copy, unlike SMTP
 * (submit) + a separate IMAP APPEND. `raw` is the exact same MIME buffer
 * SMTP would have sent (smtpClient.js#buildRaw — protocol-agnostic), kept
 * for body/attachment/header fidelity. Explicit to/cc/bcc Mailbox elements
 * are supplied ALONGSIDE it because they're not optional for correctness
 * here: Bcc addresses are never present in the MIME source itself (that's
 * the definition of a blind copy — buildRaw's output has no Bcc header for
 * Exchange to discover), so without telling it separately who to deliver
 * to, Bcc would silently not go out at all. Resolves the account's own
 * (possibly user-customized in Settings) sentFolder the same way
 * appendMessage below does — not the literal "sentitems" keyword, which
 * would need a <t:DistinguishedFolderId> element, not the real-FolderId
 * <t:FolderId> createItem() builds here.
 */
export async function sendRaw(raw, { to = [], cc = [], bcc = [] } = {}) {
  const acc = currentAccount();
  const { id: folderId } = await resolveFolderId(acc.sentFolder);
  const recipientsBlock = recipientsXml('ToRecipients', to) + recipientsXml('CcRecipients', cc) + recipientsXml('BccRecipients', bcc);
  return createItem(raw, { disposition: 'SendAndSaveCopy', savedFolderId: folderId, extraXml: recipientsBlock });
}

/**
 * Generic "create this raw message in this folder" — used for drafts
 * (index.js's /api/drafts route calls this exactly like it calls
 * imapClient.js's own appendMessage). No explicit recipients needed here
 * unlike sendRaw: MessageDisposition="SaveOnly" never attempts delivery, so
 * there's no envelope-routing concern — Exchange just stores the MIME
 * content as given, and Hmelj reads recipients back out of it later the
 * same way it reads any other message (messageParse.js, protocol-agnostic).
 * `flags` mirrors imapClient.js's own signature; only \Seen maps onto
 * anything EWS tracks per-message (IsRead) — \Draft needs no separate
 * flag of its own, saving into the Drafts folder already IS what makes an
 * Exchange item a draft.
 */
export async function appendMessage(path, raw, flags = []) {
  const { id: folderId } = await resolveFolderId(path);
  const isRead = flags.includes('\\Seen');
  return createItem(raw, { disposition: 'SaveOnly', savedFolderId: folderId, extraXml: `<t:IsRead>${isRead}</t:IsRead>` });
}

// ---------- change notifications (live monitoring) ----------
//
// The Exchange counterpart to IMAP IDLE, driving an account's "Monitoring:
// Live" mode (see server/idle.js). Before this, an Exchange account had
// nothing but the interval poll — and listNewMessages below deliberately
// ignores its `sinceUid` and re-reads a fixed newest-50 window each cycle, so
// a busy mailbox could genuinely outrun detection between two ticks. A
// subscription removes that guesswork: Exchange reports exactly what changed.
//
// PULL, not streaming, and that choice is forced rather than preferred.
// StreamingSubscription + GetStreamingEvents is the true push equivalent of
// IDLE, and it was implemented that way first — but it cannot work through
// this file's transport. httpntlm builds its own agentkeepalive agent
// internally (see the long comment at the top of this file: it ignores any
// agent a caller passes), and agentkeepalive hard-floors socket inactivity at
// 8 seconds — `options.timeout = Math.max(options.freeSocketTimeout * 2, 8000)`
// in its agent.js. A streaming long-poll is an idle socket by definition, so
// it was killed after exactly 8s, every time, against a real server.
//
// A pull subscription instead hands back a watermark and lets us ask "what's
// changed since?" on our own schedule. Each GetEvents returns immediately, so
// no socket ever sits idle. Latency is therefore the pull interval (seconds)
// rather than IMAP IDLE's ~1s — still far better than the old 2-minute poll,
// and unlike that poll it detects changes exactly instead of inferring them
// from a fixed newest-N window.

/** Open a pull subscription over the given folder paths.
 *  `timeoutMinutes` is how long Exchange keeps the subscription alive with no
 *  GetEvents call (1-1440); we poll far more often than this, so it only
 *  matters if the process stalls. */
export async function subscribePull(paths = ['INBOX'], timeoutMinutes = 30) {
  const acc = currentAccount();
  const ids = [];
  for (const p of paths) {
    try {
      const { id } = await resolveFolderId(p);
      ids.push(id);
    } catch (e) {
      ilog.debug(`subscribePull: skipping unknown folder ${p}: ${e.message}`);
    }
  }
  if (!ids.length) throw new Error('No folders to subscribe to');
  const body = `<m:Subscribe>
    <m:PullSubscriptionRequest>
      <t:FolderIds>${ids.map((id) => `<t:FolderId Id="${escXml(id)}"/>`).join('')}</t:FolderIds>
      <t:EventTypes>
        <t:EventType>NewMailEvent</t:EventType>
        <t:EventType>CreatedEvent</t:EventType>
        <t:EventType>DeletedEvent</t:EventType>
        <t:EventType>ModifiedEvent</t:EventType>
        <t:EventType>MovedEvent</t:EventType>
      </t:EventTypes>
      <t:Timeout>${timeoutMinutes}</t:Timeout>
    </m:PullSubscriptionRequest>
  </m:Subscribe>`;
  const xml = await soapRequest(acc.ews, 'Subscribe', body);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.SubscribeResponse?.ResponseMessages?.SubscribeResponseMessage)[0];
  checkResponseCode(msg, 'Subscribe');
  return { subscriptionId: msg?.SubscriptionId, watermark: msg?.Watermark };
}

// Response codes meaning "this subscription is finished, get a new one" —
// normal operation (it expires, or the server was restarted), not an error
// worth backing off over.
const SUBSCRIPTION_GONE = new Set([
  'ErrorInvalidSubscription',
  'ErrorSubscriptionUnsubscribed',
  'ErrorInvalidWatermark',
  'ErrorSubscriptionNotFound',
]);

/**
 * Ask what's changed since `watermark`.
 *
 * Returns `{ changed, watermark, expired }` — deliberately coarse on purpose:
 * idle.js only needs "something happened, go look", because the actual
 * reconciliation is the same pollFolder path a scheduled cycle uses. Exchange's
 * own keep-alive StatusEvent is filtered out so it can't trigger pointless
 * syncs.
 */
export async function getEvents(subscriptionId, watermark) {
  const acc = currentAccount();
  const body = `<m:GetEvents>
    <m:SubscriptionId>${escXml(subscriptionId)}</m:SubscriptionId>
    <m:Watermark>${escXml(watermark)}</m:Watermark>
  </m:GetEvents>`;
  const xml = await soapRequest(acc.ews, 'GetEvents', body);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.GetEventsResponse?.ResponseMessages?.GetEventsResponseMessage)[0];
  const code = msg?.ResponseCode;
  if (code && code !== 'NoError') {
    if (SUBSCRIPTION_GONE.has(code)) return { changed: false, watermark, expired: true };
    throw new Error(`GetEvents: ${code}`);
  }
  const notification = asArray(msg?.Notification)[0];
  // Every event element carries its own Watermark; the newest one is what the
  // next call must ask from. Falls back to the notification-level one.
  let newWatermark = notification?.Watermark || watermark;
  let changed = false;
  for (const [key, value] of Object.entries(notification || {})) {
    if (!key.endsWith('Event')) continue;
    for (const ev of asArray(value)) {
      if (ev?.Watermark) newWatermark = ev.Watermark;
      // StatusEvent is Exchange's "still here, nothing to report" heartbeat.
      if (key !== 'StatusEvent') changed = true;
    }
  }
  return { changed, watermark: newWatermark, expired: false };
}

// ---------- folder management ----------
//
// All four take and return Hmelj's own path strings ("Projects/2026"), because
// that is the only folder identity the rest of the app has. EWS works in opaque
// FolderIds instead, so each one resolves the path first (resolveFolderId, which
// re-lists if the path is not cached yet) and then invalidates the cache, since
// the synthesised paths in it are now wrong for the whole affected subtree —
// renaming "Projects" changes the path of every folder beneath it.
//
// A note on where the mailbox root is: a top-level folder's parent is the
// DistinguishedFolderId `msgfolderroot`, which is also what listFolders()
// traverses from, so "top level" means the same thing in both directions.

/** The <t:FolderId> element for a path, or msgfolderroot for the empty path. */
async function folderIdXml(path, { withChangeKey = false } = {}) {
  if (!path) return '<t:DistinguishedFolderId Id="msgfolderroot"/>';
  const { id, changeKey } = await resolveFolderId(path);
  const ck = withChangeKey && changeKey ? ` ChangeKey="${escXml(changeKey)}"` : '';
  return `<t:FolderId Id="${escXml(id)}"${ck}/>`;
}

/** Drops the synthesised path map so the next resolveFolderId re-reads the
 *  tree from the server. Cheaper than trying to patch the map in place, and
 *  correct for the subtree cases where patching would not be. */
function invalidateFolderCache() {
  folderCache.delete(cacheKey(currentAccount()));
}

/** Splits "a/b/c" into the parent path and the leaf display name. */
function splitPath(path) {
  const parts = String(path).split('/');
  const name = parts.pop();
  return { parentPath: parts.join('/'), name };
}

export async function createFolder(path) {
  const acc = currentAccount();
  const { parentPath, name } = splitPath(path);
  if (!name) throw new Error('A folder needs a name');
  const body = `<m:CreateFolder>
    <m:ParentFolderId>${await folderIdXml(parentPath)}</m:ParentFolderId>
    <m:Folders>
      <t:Folder>
        <t:FolderClass>IPF.Note</t:FolderClass>
        <t:DisplayName>${escXml(name)}</t:DisplayName>
      </t:Folder>
    </m:Folders>
  </m:CreateFolder>`;
  const xml = await soapRequest(acc.ews, 'CreateFolder', body);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.CreateFolderResponse?.ResponseMessages?.CreateFolderResponseMessage)[0];
  checkResponseCode(msg, 'CreateFolder');
  invalidateFolderCache();
  const folder = asArray(msg?.Folders?.Folder)[0];
  // `path` is what the caller asked for and what every other backend echoes
  // back; the id is returned alongside because CreateFolder is the one place
  // it is known without a second round-trip.
  return { path, name, id: folder?.FolderId?.['@_Id'] || null };
}

export async function deleteFolder(path) {
  const acc = currentAccount();
  // MoveToDeletedItems rather than HardDelete: this is the same choice Outlook
  // makes, and the same one Hmelj already makes for messages (Settings >
  // General > Delete behavior defaults to Trash). A folder deleted by accident
  // is then still recoverable from Deleted Items — where it does reappear in
  // the folder tree, which is honest about what happened rather than looking
  // like the delete failed.
  const body = `<m:DeleteFolder DeleteType="MoveToDeletedItems">
    <m:FolderIds>${await folderIdXml(path, { withChangeKey: true })}</m:FolderIds>
  </m:DeleteFolder>`;
  const xml = await soapRequest(acc.ews, 'DeleteFolder', body);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.DeleteFolderResponse?.ResponseMessages?.DeleteFolderResponseMessage)[0];
  checkResponseCode(msg, 'DeleteFolder');
  invalidateFolderCache();
  return { ok: true };
}

export async function renameFolder(path, newPath) {
  const acc = currentAccount();
  const { parentPath: oldParent } = splitPath(path);
  const { parentPath: newParent, name } = splitPath(newPath);
  if (!name) throw new Error('A folder needs a name');

  // The Hmelj UI expresses both "rename" and "move somewhere else" as one new
  // path, but EWS splits them across two operations — the same split Graph has.
  // Both have to run, or dragging a folder to a new parent would silently only
  // change its name.
  if (name !== splitPath(path).name) {
    const body = `<m:UpdateFolder>
      <m:FolderChanges>
        <t:FolderChange>
          ${await folderIdXml(path, { withChangeKey: true })}
          <t:Updates>
            <t:SetFolderField>
              <t:FieldURI FieldURI="folder:DisplayName"/>
              <t:Folder><t:DisplayName>${escXml(name)}</t:DisplayName></t:Folder>
            </t:SetFolderField>
          </t:Updates>
        </t:FolderChange>
      </m:FolderChanges>
    </m:UpdateFolder>`;
    const xml = await soapRequest(acc.ews, 'UpdateFolder', body);
    const parsed = xmlParser.parse(xml);
    const msg = asArray(parsed?.Envelope?.Body?.UpdateFolderResponse?.ResponseMessages?.UpdateFolderResponseMessage)[0];
    checkResponseCode(msg, 'UpdateFolder');
    // Before resolving anything else: the rename changed both this folder's
    // ChangeKey and the cached path of every folder under it.
    invalidateFolderCache();
  }

  if (newParent !== oldParent) {
    // Resolved through the NEW path — the rename above already moved it there
    // as far as path synthesis is concerned.
    const movingPath = oldParent ? `${oldParent}/${name}` : name;
    const body = `<m:MoveFolder>
      <m:ToFolderId>${await folderIdXml(newParent)}</m:ToFolderId>
      <m:FolderIds>${await folderIdXml(movingPath, { withChangeKey: true })}</m:FolderIds>
    </m:MoveFolder>`;
    const xml = await soapRequest(acc.ews, 'MoveFolder', body);
    const parsed = xmlParser.parse(xml);
    const msg = asArray(parsed?.Envelope?.Body?.MoveFolderResponse?.ResponseMessages?.MoveFolderResponseMessage)[0];
    checkResponseCode(msg, 'MoveFolder');
    invalidateFolderCache();
  }
  return { path: newPath, name };
}

export async function emptyFolder(path) {
  const acc = currentAccount();
  // Counted first: EWS's EmptyFolder reports no count of its own, and every
  // other backend's emptyFolder returns one for the toast.
  const { total } = await folderStatus(path);
  if (!total) return { deleted: 0 };
  // HardDelete, and subfolders left alone. "Empty this folder" on Trash has to
  // actually reclaim the space or it has not emptied anything — moving its
  // contents to Deleted Items when the folder IS Deleted Items is a no-op. The
  // same reasoning is why imapClient.js expunges rather than flagging. Deleting
  // subfolders is deliberately not part of "empty": they are folders, not
  // contents, and losing them to a menu item named Empty would be a surprise.
  const body = `<m:EmptyFolder DeleteType="HardDelete" DeleteSubFolders="false">
    <m:FolderIds>${await folderIdXml(path)}</m:FolderIds>
  </m:EmptyFolder>`;
  const xml = await soapRequest(acc.ews, 'EmptyFolder', body);
  const parsed = xmlParser.parse(xml);
  const msg = asArray(parsed?.Envelope?.Body?.EmptyFolderResponse?.ResponseMessages?.EmptyFolderResponseMessage)[0];
  checkResponseCode(msg, 'EmptyFolder');
  return { deleted: total };
}
