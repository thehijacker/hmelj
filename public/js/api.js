// Hmelj — thin fetch wrapper around the REST API.
// Mail routes need to know which mail account they target. Most calls use
// the ambient `API.account` (the account the user is currently viewing,
// set by switchAccount()) — but several call sites need a DIFFERENT,
// specific account for one call without disturbing the ambient value (a
// scheduled mark-read on a unified-view message, a batch action, Settings
// reading a different account's folders, …). Every method below that's
// account-scoped takes an optional trailing `accountId` for exactly that —
// pass it and it's used instead of `API.account`, ambient value untouched.
//
// This used to be done by temporarily overwriting API.account and restoring
// it after the await, which is unsafe: since any single IMAP call can now
// take several seconds (a slow Gmail connection), a real user-driven
// switchAccount() can happen WHILE such a temporary swap is still in
// flight, and the swap's "restore previous value" then stomps the user's
// new selection back to the stale one — which is exactly how "No mail
// account selected" / wrong-folder 400s started appearing. Passing the
// account explicitly per-call sidesteps the shared-mutable-state race
// entirely rather than trying to serialize around it.
const API = {
  account: null, // current mail account id ('all' handled by the app via unified endpoints)
  _acct(url, accountId) {
    // null/undefined both mean "no override" -> fall back to the ambient
    // account. Only a real (truthy) id counts as an explicit override.
    const acct = accountId != null ? accountId : API.account;
    if (!acct) return url;
    return url + (url.includes('?') ? '&' : '?') + 'account=' + encodeURIComponent(acct);
  },

  /** Every failure that means "the Hmelj server is not reachable" — as opposed
   * to "the server answered, with bad news" — is raised as this, and reported to
   * Connection so the whole app can say so once instead of each call site
   * showing its own "Failed to fetch". Two shapes to catch, because which one
   * happens depends on whether the service worker is running: with it, an
   * offline /api/* request comes back as its 503 stand-in (X-Hmelj-Offline);
   * without it (any plain-HTTP origin — no secure context, no service worker,
   * which is exactly the LAN setup the Android app usually points at), fetch
   * rejects outright. */
  _offlineError() {
    window.Connection?.noteFailure();
    return Object.assign(new Error('No connection to the Hmelj server'), { offline: true });
  },

  /** Nothing answered. For a GET that is a question the offline cache may be
   * able to answer instead (see public/js/offline.js) — a cached listing, a
   * cached message, the settings this device booted with. For anything else,
   * and for a GET the cache has never seen, this is exactly the error that was
   * thrown before offline mode existed, so every call site's own handling of it
   * is unchanged.
   *
   * Deliberately NOT applied to writes: those are queued instead, one layer up
   * in _write, where the call site's own arguments are still in hand. */
  async _offlineAnswer(method, url, background) {
    // A BACKGROUND request never gets a vote on whether the server is
    // reachable. The offline prefetcher makes a great many of them, they are
    // the first thing a struggling server drops, and letting each one report an
    // outage is how a slow link turned into a connection state that flipped
    // every few seconds — with a full reconnect refresh on every flip. What the
    // app itself asks for, and connection.js's own probe, decide this.
    const err = background
      ? Object.assign(new Error('No connection to the Hmelj server'), { offline: true })
      : API._offlineError();
    if (method !== 'GET') throw err;
    const hit = await window.Offline?.recall?.(url);
    if (hit === null || hit === undefined) throw err;
    return hit;
  },

  /** When the app last asked for something on the user's behalf. The prefetcher
   *  waits for a quiet moment rather than competing with it (see offline.js). */
  lastUserRequestAt: 0,

  async _req(method, url, body, { background = false, timeoutMs = 0 } = {}) {
    if (!background) API.lastUserRequestAt = Date.now();
    // A background request that hangs holds one of the browser's handful of
    // connections to this host — and the SSE stream is already holding another.
    // Giving up is strictly better than starving the requests the user is
    // actually waiting for.
    const ctl = timeoutMs ? new AbortController() : null;
    const bail = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl?.signal,
      });
    } catch (e) {
      // Our own timeout, not the network's answer: it says the server is slow,
      // which is not the same as unreachable and must not be reported as one.
      if (e?.name === 'AbortError') throw Object.assign(new Error('Timed out'), { timedOut: true });
      return API._offlineAnswer(method, url, background);
    } finally {
      clearTimeout(bail);
    }
    // The service worker's stand-in, OR a proxy answering for a server that
    // isn't there. The second one is not a transport failure — Cloudflare's
    // 52x/530 and nginx's 502/504 arrive as real responses with HTML bodies —
    // so without this check the app read "the origin is unreachable" as proof
    // the server was UP, called noteSuccess(), and never opened the offline
    // store at all. This matters most where there is NO service worker to
    // translate it first: the Android shell on a plain-http LAN address.
    if (res.headers.get('X-Hmelj-Offline') || API._notFromHmelj(res)) {
      return API._offlineAnswer(method, url, background);
    }
    // The server answered, whatever it said — that alone proves the connection
    // is back, which is what ends an outage without waiting for the next probe.
    if (!background) window.Connection?.noteSuccess();
    if (res.status === 401 && !location.pathname.startsWith('/login')) {
      location.replace('/login.html');
      throw new Error('Not authenticated');
    }
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error || msg; } catch {}
      // Carry the HTTP status on the Error. Callers that only read .message are
      // unaffected; the ones that need to tell "the server cannot do this at
      // all" from "not right now" have no other way to know — proofread.js
      // treats a 503 as permanent (stand down, hand the composer back to the
      // browser's spellchecker) and a 429 as transient (try again next check).
      throw Object.assign(new Error(msg), { status: res.status });
    }
    const data = await res.json();
    // Remember it, so the same question can be answered with no server. Not
    // awaited: a cache write must never add latency to a response somebody is
    // waiting for, and offline.js swallows its own failures.
    if (method === 'GET') window.Offline?.remember?.(url, data);
    return data;
  },

  /**
   * A 5xx that did not come from Hmelj.
   *
   * Every error this app produces is JSON — `res.status(...).json({error})`,
   * without exception, including the meaningful 503 the spell checker returns
   * when it has no dictionaries installed. A proxy standing in for a dead
   * origin serves an HTML page instead. So the content type, not the status,
   * is what tells them apart, and it needs no list of proxy status codes that
   * would go stale the moment somebody put a different one in front.
   */
  _notFromHmelj(res) {
    if (res.status < 500) return false;
    return !(res.headers.get('Content-Type') || '').includes('json');
  },

  /** The resolved account for a call — the explicit argument if there is one,
   *  otherwise the ambient one. Same rule as _acct, factored out because the
   *  outbox needs the ANSWER (to key a queued action by account) rather than a
   *  URL with it appended. */
  _acctId(accountId) {
    const acct = accountId != null ? accountId : API.account;
    return acct || '';
  },

  /**
   * One mail write, which the Outbox takes over when the server is unreachable.
   *
   * `run` is the request exactly as it would have gone out; `type`/`payload`
   * are what the queue needs to replay it later and to state what it did to
   * which message in the meantime (outbox.js's overlay). The caller gets a
   * synthetic acknowledgement shaped like the real response, so the optimistic
   * update it has already painted stands, and none of the ~20 mutation call
   * sites in app.js needed to learn about any of this.
   *
   * The check happens twice: before trying (we already know we're offline —
   * don't spend a request finding out) and, for most writes, again after a
   * transport failure (we thought we were online and weren't).
   *
   * `queueOnFailure: false` turns that second check off, and SEND uses it. A
   * fetch that rejects proves only that no answer came back — the request may
   * have been received and acted on in full. For a flag, a move or a delete
   * that ambiguity is harmless: replaying one either repeats something
   * idempotent or names a uid that is no longer there, which the replay drops.
   * Replaying a send delivers the message twice, to real people, and there is
   * no taking it back. So a send that fails mid-flight is reported to the
   * composer exactly as it always was, and the person who wrote it decides.
   */
  async _write(type, account, payload, run, { queueOnFailure = true } = {}) {
    const meta = { account, payload };
    if (window.Outbox?.shouldQueue?.()) return window.Outbox.enqueue(type, meta);
    try {
      return await run();
    } catch (e) {
      if (queueOnFailure && e?.offline && window.Outbox?.isReady?.() && !window.Outbox.isReplaying()) {
        return window.Outbox.enqueue(type, meta);
      }
      throw e;
    }
  },

  // `opts` is only ever passed by the offline prefetcher — {background, timeoutMs}.
  get: (u, opts) => API._req('GET', u, undefined, opts),
  put: (u, b) => API._req('PUT', u, b),
  post: (u, b, opts) => API._req('POST', u, b, opts),
  del: (u) => API._req('DELETE', u),

  status: () => API.get(API._acct('/api/status')),
  accounts: () => API.get('/api/accounts'),
  saveAccount: (a, id) => (id ? API.put('/api/accounts/' + id, a) : API.post('/api/accounts', a)),
  deleteAccount: (id) => API.del('/api/accounts/' + id),
  patchAccount: (id, patch) => API._req('PATCH', '/api/accounts/' + id, patch),
  // Per-account full-text index: how many messages are indexed, how much of the
  // index each account accounts for, and whether it has hit its size ceiling.
  searchIndex: () => API.get('/api/search-index'),
  // Sidebar-pinned searches. Written as a whole list (like identities), and the
  // server returns its own normalised version — always adopt THAT, not the list
  // that was sent, or the client and server disagree about ids and trimming.
  // Reusable message boilerplate. Same whole-list contract as identities: adopt
  // the server's normalised response, not the list that was sent.
  // Export URLs, not fetches: both are plain anchor navigations, so nothing has
  // to hold a mailbox in memory and the Android shell's DownloadListener sees a
  // normal download with the session cookie attached (a Blob built in the page
  // would reach neither).
  exportSettingsUrl: () => '/api/export/settings',
  exportMailUrl: (folder, accountId, since) => API._acct(
    '/api/export/mail?folder=' + encodeURIComponent(folder) + (since ? '&since=' + encodeURIComponent(since) : ''),
    accountId,
  ),
  templates: () => API.get('/api/templates'),
  saveTemplates: (list) => API.put('/api/templates', list),
  savedSearches: () => API.get('/api/saved-searches'),
  saveSavedSearches: (list) => API.put('/api/saved-searches', list),
  // Named sets of addresses the composer can address as one token (see
  // server/contactGroups.js). Same whole-list contract as saved searches, and
  // the response matters more than usual: the server disambiguates duplicate
  // names, and the token resolves BY NAME.
  contactGroups: () => API.get('/api/contact-groups'),
  saveContactGroups: (list) => API.put('/api/contact-groups', list),
  // Snooze (server/snooze.js). The message really moves into the account's
  // snooze folder — `wakeAt` is when it comes back, `addCalendar` also puts a
  // reminder in the first writable calendar.
  // `accountId` is explicit, like refile's, and is not optional in practice: in
  // the unified view there IS no ambient account, and every row can belong to a
  // different one, so falling back to API.account sends the request with no
  // account at all and the server answers "No mail account selected".
  snooze: (folder, uids, wakeAt, addCalendar = false, accountId) =>
    API.post(API._acct(`/api/messages/${encodeURIComponent(folder)}/snooze`, accountId), { uids, wakeAt, addCalendar }),
  snoozed: () => API.get('/api/snoozed'),
  wakeSnoozed: (id) => API.post(`/api/snoozed/${encodeURIComponent(id)}/wake`, {}),
  resnooze: (id, wakeAt) => API._req('PATCH', `/api/snoozed/${encodeURIComponent(id)}`, { wakeAt }),
  // Temporary per-folder Mute (sidebar folder right-click → Mute). `until` is epoch ms
  // — absolute, so the phone's and the server's clocks agree on when it lapses without
  // any timezone conversion; null/0 lifts it. Owner-only (the server 403s a grantee).
  setFolderMute: (id, folder, until) => API.post('/api/accounts/' + id + '/folder-mute', { folder, until }),
  testAccount: (a) => API.post('/api/accounts/test', a),
  shareAccount: (id, username) => API.post('/api/accounts/' + id + '/share', { username }),
  unshareAccount: (id, userId) => API.del('/api/accounts/' + id + '/share/' + encodeURIComponent(userId)),
  leaveAccount: (id) => API.post('/api/accounts/' + id + '/leave'),
  syncStatus: () => API.get('/api/sync/status'),
  // The authoritative unread count: {total, accounts:{<id>: n}}. Not
  // account-scoped on purpose — it always answers for every account this
  // login can see, which is what the sidebar total, the tab title and both
  // app badges need (see server/unread.js).
  unread: () => API.get('/api/unread'),
  unified: (box, opts = {}) => {
    const q = new URLSearchParams();
    if (opts.page) q.set('page', opts.page);
    if (opts.q) q.set('q', opts.q);
    if (opts.unread) q.set('unread', '1');
    if (opts.flagged) q.set('flagged', '1');
    if (opts.hideMuted) q.set('hideMuted', '1');
    // "Search everywhere" — every folder of every account, asked live, header and
    // body (see server/index.js). Only ever set from the search footer's link.
    if (opts.scope) q.set('scope', opts.scope);
    return API.get('/api/unified/' + box + '?' + q);
  },
  // Composer spell checking (server/proofread.js). Word-level, not
  // document-level: {words:[...], language} in, {language, bad:{word:[…]}} out.
  // {warm:true} instead of `words` just asks the server to start loading its
  // dictionaries. Not account-scoped — it's the user's own vocabulary, and the
  // message body never leaves the browser.
  proofread: (body) => API.post('/api/proofread', body),
  // The user's own activity log (Settings → Log; server/userLog.js). Paginated
  // server-side — entries carry full error text and this is read on a phone as
  // often as not. Not account-scoped: it spans every account this login sees.
  userLog: ({ page = 1, pageSize = 25, level = null } = {}) => {
    const q = new URLSearchParams({ limit: pageSize, offset: (page - 1) * pageSize });
    if (level) q.set('level', level);
    return API.get('/api/log?' + q);
  },
  clearUserLog: () => API.del('/api/log'),
  settings: () => API.get('/api/settings'),
  saveSettings: (s) => API.put('/api/settings', s),
  identities: () => API.get('/api/identities'),
  saveIdentities: (l) => API.put('/api/identities', l),
  contacts: () => API.get('/api/contacts'),
  saveContacts: (l) => API.put('/api/contacts', l),
  // One contact by id, answering with the list that's left. Not a PUT of the
  // whole list: compose's autocomplete only ever holds a filtered view of the
  // contacts, and PUTting that back would delete everything not matching what
  // was typed.
  deleteContact: (id) => API.del('/api/contacts/' + encodeURIComponent(id)),
  importContacts: (text) => API.post('/api/contacts/import', { text }),
  // People you've corresponded with who aren't contacts yet, from the local
  // message cache (server/index.js) — {suggestions:[{email,name,sent,received,last}]}.
  contactSuggestions: () => API.get('/api/contacts/suggestions'),
  // Same route as the file import, handed structured rows instead of text.
  addContacts: (rows) => API.post('/api/contacts/import', { rows }),
  // Imports one Exchange account's own Contacts folder. Account-scoped, so it
  // takes the id explicitly rather than following the ambient API.account —
  // Settings can import from an account other than the one being viewed.
  // ---- app passwords and the DAV server ----
  // A created password's secret comes back exactly once — there is no route
  // that can produce it again, by design, so the UI has to show it there and
  // then and say so.
  appPasswords: () => API.get('/api/app-passwords'),
  createAppPassword: (label, scopes) => API.post('/api/app-passwords', { label, scopes }),
  deleteAppPassword: (id) => API.del('/api/app-passwords/' + encodeURIComponent(id)),
  davPublished: () => API.get('/api/dav/published'),
  saveDavPublished: (draft, id) => (id
    ? API.put('/api/dav/published/' + encodeURIComponent(id), draft)
    : API.post('/api/dav/published', draft)),
  deleteDavPublished: (id) => API.del('/api/dav/published/' + encodeURIComponent(id)),

  // ---- calendars ----
  // Per PERSON, like contacts and for the same reason, so none of these take a
  // mail account id — a source that borrows one names it inside its own record.
  calendars: () => API.get('/api/calendars'),
  discoverCalendarSource: (draft) => API.post('/api/calendars/discover', draft),
  saveCalendarSource: (draft, id) => (id
    ? API.put('/api/calendars/sources/' + encodeURIComponent(id), draft)
    : API.post('/api/calendars/sources', draft)),
  deleteCalendarSource: (id) => API.del('/api/calendars/sources/' + encodeURIComponent(id)),
  syncCalendarSource: (id, force = false) => API.post('/api/calendars/sources/' + encodeURIComponent(id) + '/sync', { force }),
  // Show/hide is its own route rather than a source PUT: it is a one-click
  // sidebar toggle, and round-tripping the whole source record for it would be
  // one more chance to send stale sync state back.
  setCalendarVisible: (id, visible) => API._req('PATCH', '/api/calendars/' + encodeURIComponent(id), { visible }),
  // A colour of your own for one calendar. An empty string hands it back to the
  // server's (see the PATCH route's colorLocked note).
  setCalendarColor: (id, color) => API._req('PATCH', '/api/calendars/' + encodeURIComponent(id), { color }),
  // Creates the calendar on the source's own server first, then stores it — so
  // a refusal leaves nothing behind locally. Answers with the whole refreshed
  // source and calendar lists, since a create also triggers a sync.
  createCalendar: (sourceId, displayName, color = '') =>
    API.post('/api/calendars/sources/' + encodeURIComponent(sourceId) + '/calendars', { displayName, color }),
  // The browser's own zone rides along so the server can resolve floating
  // events and decide which DAY each occurrence belongs to — neither of which
  // the browser should be doing for itself (see server/calendarEvents.js).
  calendarEvents: (from, to, calendarIds = null) => API.get('/api/calendar/events?from=' + from + '&to=' + to
    + '&tz=' + encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || '')
    + (calendarIds?.length ? '&calendars=' + encodeURIComponent(calendarIds.join(',')) : '')),
  // ---- writing ----
  // `scope` is required rather than defaulted on both of these: on a repeating
  // event 'one', 'future' and 'all' write three genuinely different documents,
  // and a caller that forgot to ask must not silently get the most destructive
  // one. The server refuses anything else.
  createCalendarEvent: (calendarId, event) => API.post('/api/calendar/events', { calendarId, ...event }),
  updateCalendarEvent: (calendarId, uid, event, { scope = 'all', occurrenceStart = null } = {}) =>
    API.put(`/api/calendar/event/${encodeURIComponent(calendarId)}/${encodeURIComponent(uid)}`,
      { ...event, scope, occurrenceStart }),
  deleteCalendarEvent: (calendarId, uid, { scope = 'all', occurrenceStart = null } = {}) =>
    API.del(`/api/calendar/event/${encodeURIComponent(calendarId)}/${encodeURIComponent(uid)}`
      + `?scope=${encodeURIComponent(scope)}${occurrenceStart ? '&start=' + occurrenceStart : ''}`),

  calendarEvent: (calendarId, uid, start = null) => API.get(
    `/api/calendar/event/${encodeURIComponent(calendarId)}/${encodeURIComponent(uid)}`
    + (start ? '?start=' + start : '')),

  // ---- live contact sync (CardDAV / Google / Microsoft / Exchange) ----
  // Sources are per PERSON, not per mail account, so none of these take an
  // account id — a provider-backed source names the account it borrows a
  // sign-in from inside its own record instead.
  contactSources: () => API.get('/api/contact-sources'),
  // Probes a server and lists what is there WITHOUT saving anything, so a
  // mistyped password does not leave a broken source behind.
  discoverContactSource: (draft) => API.post('/api/contact-sources/discover', draft),
  saveContactSource: (draft, id) => (id
    ? API.put('/api/contact-sources/' + encodeURIComponent(id), draft)
    : API.post('/api/contact-sources', draft)),
  deleteContactSource: (id) => API.del('/api/contact-sources/' + encodeURIComponent(id)),
  syncContactSource: (id, force = false) => API.post('/api/contact-sources/' + encodeURIComponent(id) + '/sync', { force }),
  // A synced contact is edited on the server it came from, never through the
  // bulk PUT of /api/contacts — that route replaces the LOCAL address book and
  // strips synced rows on purpose.
  updateSyncedContact: (rowId, patch) => API.put('/api/contact-sources/rows/' + encodeURIComponent(rowId), patch),
  createSyncedContact: (sourceId, bookId, row) => API.post(
    `/api/contact-sources/${encodeURIComponent(sourceId)}/books/${encodeURIComponent(bookId)}/cards`, row),

  importContactsFromEws: (accountId) => API.post(API._acct('/api/contacts/import/ews', accountId)),
  importContactsFromGraph: (accountId) => API.post(API._acct('/api/contacts/import/graph', accountId)),
  filters: () => API.get('/api/filters'),
  saveFilters: (l) => API.put('/api/filters', l),

  // Settings > Subject — how a subject is rewritten FOR DISPLAY in the list and
  // in push notifications (server/subjectRules.js). Not account-scoped: one set
  // per person, each rule naming the accounts it applies to.
  subjectRules: () => API.get('/api/subject-rules'),
  saveSubjectRules: (l) => API.put('/api/subject-rules', l),
  // `rules` is sent along rather than read from disk so the Test panel tests
  // what is on screen, including edits that have not been saved yet.
  testSubjectRules: (subject, accountId, rules) => API.post('/api/subject-rules/test', { subject, accountId, rules }),

  // Notification scheduler's holiday calendar — built-in Slovenian entries
  // (server/holidays.js) plus the user's own custom ones (server/schedule.js) — see
  // Settings' Scheduler tab.
  holidays: (year) => API.get('/api/holidays?year=' + year),
  saveHolidayOverrides: (map) => API._req('PATCH', '/api/holidays', map),
  addCustomHoliday: (data) => API.post('/api/holidays/custom', data),
  patchCustomHoliday: (id, patch) => API._req('PATCH', '/api/holidays/custom/' + encodeURIComponent(id), patch),
  deleteCustomHoliday: (id) => API.del('/api/holidays/custom/' + encodeURIComponent(id)),
  runFilters: (folder, accountId) => API.post(API._acct('/api/filters/run', accountId), { folder }),

  // Not account-scoped (see cache.js#suggestWord — one word index per Hmelj
  // login user, across every account) — no ?account= needed.
  searchSuggest: (q) => API.get('/api/search-suggest?q=' + encodeURIComponent(q)),

  folders: (accountId, { live = false } = {}) => API.get(API._acct('/api/folders' + (live ? '?live=1' : ''), accountId)),
  createFolder: (path, accountId) => API.post(API._acct('/api/folders', accountId), { path }),
  deleteFolder: (path, accountId) => API.del(API._acct('/api/folders/' + encodeURIComponent(path), accountId)),
  renameFolder: (path, newPath, accountId) => API.post(API._acct('/api/folders/' + encodeURIComponent(path) + '/rename', accountId), { newPath }),
  emptyFolder: (path, accountId) => API.post(API._acct('/api/folders/' + encodeURIComponent(path) + '/empty', accountId)),
  markFolderRead: (path, accountId) => API.post(API._acct('/api/folders/' + encodeURIComponent(path) + '/mark-read', accountId)),
  markAccountRead: (accountId) => API.post(API._acct('/api/account/mark-read', accountId)),
  markAllAccountsRead: () => API.post('/api/unified/mark-read'),
  syncFolderNow: (path, accountId) => API.post(API._acct('/api/folders/' + encodeURIComponent(path) + '/sync-now', accountId)),
  syncAccountNow: (accountId) => API.post(API._acct('/api/sync-now', accountId)),

  // Mailbox analytics (see server/analytics.js and js/analytics.js)
  anSummary: (accountId) => API.get(API._acct('/api/analytics/summary', accountId)),
  anScan: (accountId, full) => API.post(API._acct('/api/analytics/scan', accountId), { full: !!full }),
  anScanStatus: (accountId) => API.get(API._acct('/api/analytics/scan-status', accountId)),
  anScanCancel: (accountId) => API.post(API._acct('/api/analytics/scan-cancel', accountId)),
  anSenders: (accountId, sort, dir, limit, offset) => API.get(API._acct('/api/analytics/senders?sort=' + encodeURIComponent(sort || 'bytes') + '&dir=' + encodeURIComponent(dir || 'desc') + '&limit=' + (limit || 100) + '&offset=' + (offset || 0), accountId)),
  anLargest: (accountId, sort, dir, limit, offset) => API.get(API._acct('/api/analytics/largest?sort=' + encodeURIComponent(sort || 'size') + '&dir=' + encodeURIComponent(dir || 'desc') + '&limit=' + (limit || 200) + '&offset=' + (offset || 0), accountId)),
  anQuery: (accountId, body) => API.post(API._acct('/api/analytics/query', accountId), body),
  anDelete: (accountId, body) => API.post(API._acct('/api/analytics/delete', accountId), body),
  anClear: (accountId) => API.post(API._acct('/api/analytics/clear', accountId)),

  messages: (folder, opts = {}, accountId) => {
    const q = new URLSearchParams();
    if (opts.page) q.set('page', opts.page);
    if (opts.q) q.set('q', opts.q);
    if (opts.unread) q.set('unread', '1');
    // Starred-only also widens this to the folder's subtree, server-side — see
    // /api/messages/:folder. Nothing to pass for that: the folder in the path is
    // the root of it.
    if (opts.flagged) q.set('flagged', '1');
    if (opts.scope) q.set('scope', opts.scope); // see API.unified
    return API.get(API._acct('/api/messages/' + encodeURIComponent(folder) + '?' + q, accountId));
  },
  /** Unfinished mail, both halves at once: `links` — every message with an
   *  unsent reply/forward waiting for it (see server/draftLinks.js), one flat
   *  list because the unified view mixes accounts in one list of rows — and
   *  `counts` — {accountId: {folder, total}} for each account whose Drafts
   *  folder is not empty. One request, so the two can never disagree. */
  draftState: () => API.get('/api/draft-state'),
  /** Addresses the "sender's name does not match" check must leave alone — a
   *  ticketing system sends as `Whoever Touched It <service-desk@firma.si>`,
   *  which is the same shape as an impersonation and is not one. */
  trustedSenders: () => API.get('/api/trusted-senders'),
  trustSender: (address) => API.post('/api/trusted-senders', { address }),
  untrustSender: (address) => API.del('/api/trusted-senders/' + encodeURIComponent(address)),
  message: (folder, uid, allowImages, accountId) =>
    API.get(API._acct('/api/message/' + encodeURIComponent(folder) + '/' + encodeURIComponent(uid) + (allowImages ? '?allowImages=1' : ''), accountId)),
  /** Every message of one conversation, oldest first (envelopes only — bodies
   *  are fetched per message, on expand, through API.message). */
  thread: (threadId, folder, accountId) =>
    API.get(API._acct('/api/thread/' + encodeURIComponent(threadId) + '?folder=' + encodeURIComponent(folder), accountId)),
  /** Unsubscribes from the newsletter a message came from. The server decides
   *  HOW from the message's own headers — see /api/message/:folder/:uid/unsubscribe. */
  unsubscribe: (folder, uid, accountId) =>
    API.post(API._acct('/api/message/' + encodeURIComponent(folder) + '/' + encodeURIComponent(uid) + '/unsubscribe', accountId)),
  /** Sends a read receipt for one message (RFC 3798) — see the banner in
   *  app.js#buildMessageCard. Never automatic: this is only ever the button. */
  sendReceipt: (folder, uid, accountId) =>
    API.post(API._acct('/api/message/' + encodeURIComponent(folder) + '/' + encodeURIComponent(uid) + '/receipt', accountId)),
  messageHeaders: (folder, uid, accountId) =>
    API.get(API._acct('/api/message/' + encodeURIComponent(folder) + '/' + encodeURIComponent(uid) + '/headers', accountId)),
  /** URL, not a fetch: the .eml download is a plain navigation so the browser
   * (and the Android shell's DownloadListener) handles the save itself.
   * `subject` only names the downloaded file. */
  messageEmlUrl: (folder, uid, subject, accountId) =>
    API._acct('/api/message/' + encodeURIComponent(folder) + '/' + encodeURIComponent(uid) + '/eml'
      + '?name=' + encodeURIComponent(subject || ''), accountId),
  /** URL, not a fetch: an attachment chip is an <a href> the viewer takes over.
   *
   * It exists so the chip goes through `_acct` like every other call instead of
   * being assembled by hand at three call sites. Two of them got it wrong and
   * emitted no `?account=` at all, which the server answers — correctly — with
   * "No mail account selected", and which showed up as an attachment that
   * simply never appeared. */
  attachmentUrl: (folder, uid, index, accountId) =>
    API._acct('/api/message/' + encodeURIComponent(folder) + '/' + encodeURIComponent(uid)
      + '/attachment/' + encodeURIComponent(index), accountId),
  /** All of one message's attachments as a single .zip, built server-side —
   *  the parts live there, one fetch each. A plain link, like the single
   *  attachment above: the browser's own download machinery handles it. */
  attachmentsZipUrl: (folder, uid, accountId) =>
    API._acct('/api/message/' + encodeURIComponent(folder) + '/' + encodeURIComponent(uid)
      + '/attachments.zip', accountId),
  // The five mailbox writes, each wrapped in _write so an unreachable server
  // queues them instead of failing them — see public/js/outbox.js. `run` is
  // byte-for-byte the request that always went out; nothing about the online
  // path changed.
  flags: (folder, uids, add, remove, accountId) => API._write(
    'flags', API._acctId(accountId), { folder, uids, add, remove },
    () => API.post(API._acct('/api/messages/' + encodeURIComponent(folder) + '/flags', accountId), { uids, add, remove })),
  move: (folder, uids, target, accountId) => API._write(
    'move', API._acctId(accountId), { folder, uids, target },
    () => API.post(API._acct('/api/messages/' + encodeURIComponent(folder) + '/move', accountId), { uids, target })),
  copy: (folder, uids, target, accountId) => API._write(
    'copy', API._acctId(accountId), { folder, uids, target },
    () => API.post(API._acct('/api/messages/' + encodeURIComponent(folder) + '/copy', accountId), { uids, target })),
  deleteMsgs: (folder, uids, accountId) => API._write(
    'delete', API._acctId(accountId), { folder, uids },
    () => API.post(API._acct('/api/messages/' + encodeURIComponent(folder) + '/delete', accountId), { uids })),
  /** Mark as spam / not spam, archive / unarchive. `box` is 'junk' or
   * 'archive'; the destination folder is the account's own setting and is
   * resolved server-side, never sent from here (see server/refile.js). */
  /** Answer a meeting invitation. `action` is accept | tentative | decline;
   *  the meeting itself is read off the message server-side. */
  respondToInvitation: (folder, uid, action, comment, sendResponse, accountId) =>
    API.post(API._acct('/api/message/' + encodeURIComponent(folder) + '/' + encodeURIComponent(uid) + '/invitation', accountId),
      { action, comment, sendResponse }),
  refile: (folder, uids, box, revert, accountId) => API._write(
    'refile', API._acctId(accountId), { folder, uids, box, revert: !!revert },
    () => API.post(API._acct('/api/messages/' + encodeURIComponent(folder) + '/refile', accountId), { uids, box, revert: !!revert })),
  // Queued rather than failed when there is no server: the composed message is
  // kept whole (recipients, body, attachments) and goes out on reconnect. The
  // response carries `queued: true` — compose.js says so instead of "Sending…",
  // which offline would be a promise nothing was keeping.
  send: (payload, accountId) => API._write(
    'send', accountId || '', { payload },
    () => API.post('/api/send' + (accountId ? '?account=' + accountId : ''), payload),
    // Queued only when we KNEW there was no connection before trying — never
    // after a request that may already have gone out. See _write.
    { queueOnFailure: false }),
  saveDraft: (payload, accountId) => API._write(
    'draft', accountId || '', { payload },
    () => API.post('/api/drafts' + (accountId ? '?account=' + accountId : ''), payload)),
  // Queued messages are per-person, not per-account, so no ?account= on these
  // two (see the /api/scheduled routes' own note).
  scheduled: () => API.get('/api/scheduled'),
  scheduledItem: (id) => API.get('/api/scheduled/' + encodeURIComponent(id)),
  cancelScheduled: (id) => API.del('/api/scheduled/' + encodeURIComponent(id)),
  rescheduleScheduled: (id, sendAt) => API._req('PATCH', '/api/scheduled/' + encodeURIComponent(id), { sendAt }),

  changePassword: (currentPassword, newPassword) => API.post('/api/account/password', { currentPassword, newPassword }),
  changeUsername: (newUsername) => API.post('/api/account/username', { newUsername }),

  // OAuth2 sign-in (public/js/oauth.js drives these; server/oauth.js does the
  // actual token work). Note what is NOT here: nothing that returns a token.
  // The browser only ever learns that a sign-in succeeded and for which
  // address — the tokens go straight from the provider into the account
  // record, server-side.
  oauthProviders: () => API.get('/api/oauth/providers'),
  // `features` asks for OPTIONAL extra permissions alongside the mail ones —
  // 'calendar', 'contacts' (see server/oauth.js#FEATURE_SCOPES). Left out, the
  // sign-in requests exactly what it always did, which is what keeps every
  // existing account from being told it needs to sign in again.
  oauthStart: ({ provider, email, accountId, features }) =>
    API.post('/api/oauth/start', { provider, email, accountId, features }),
  oauthStatus: (state) => API.get('/api/oauth/status?state=' + encodeURIComponent(state)),
  oauthAttach: (state, accountId) => API.post('/api/oauth/attach', { state, accountId }),
  adminOAuth: () => API.get('/api/admin/oauth'),
  adminSaveOAuth: (provider, body) => API.put('/api/admin/oauth/' + encodeURIComponent(provider), body),

  presets: () => API.get('/api/presets'),
  adminSavePreset: (p, id) => (id ? API.put('/api/admin/presets/' + id, p) : API.post('/api/admin/presets', p)),
  adminDeletePreset: (id) => API.del('/api/admin/presets/' + id),

  fonts: () => API.get('/api/fonts'),
  // Multipart, not JSON like every other write here — _req always sets
  // Content-Type: application/json, so this does its own fetch and lets the
  // browser set the multipart boundary itself.
  async adminUploadFont(familyId, family, style, file) {
    const fd = new FormData();
    if (familyId) fd.append('familyId', familyId);
    fd.append('family', family);
    fd.append('style', style);
    fd.append('font', file);
    const res = await fetch('/api/admin/fonts', { method: 'POST', body: fd });
    if (res.status === 401 && !location.pathname.startsWith('/login')) {
      location.replace('/login.html');
      throw new Error('Not authenticated');
    }
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error || msg; } catch {}
      // Carry the HTTP status on the Error. Callers that only read .message are
      // unaffected; the ones that need to tell "the server cannot do this at
      // all" from "not right now" have no other way to know — proofread.js
      // treats a 503 as permanent (stand down, hand the composer back to the
      // browser's spellchecker) and a 429 as transient (try again next check).
      throw Object.assign(new Error(msg), { status: res.status });
    }
    return res.json();
  },
  adminDeleteFontFamily: (id) => API.del('/api/admin/fonts/' + id),
  adminDeleteFontStyle: (id, style) => API.del('/api/admin/fonts/' + id + '/' + style),

  pushSubscriptions: () => API.get('/api/push/subscriptions'),
  pushSubscribe: (subscription, ua) => API.post('/api/push/subscribe', { subscription, ua }),
  pushUnsubscribe: (endpoint) => API.del('/api/push/subscribe/' + encodeURIComponent(endpoint)),
  pushTest: () => API.post('/api/push/test'),

  adminUsers: () => API.get('/api/admin/users'),
  adminSetUserDisabled: (id, disabled) => API._req('PATCH', '/api/admin/users/' + id, { disabled }),
  adminDeleteUser: (id) => API.del('/api/admin/users/' + id),
  adminSettings: () => API.get('/api/admin/settings'),
  adminSetAllowSignup: (allowSignup) => API._req('PATCH', '/api/admin/settings', { allowSignup }),
};
