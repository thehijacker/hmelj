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

  async _req(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw API._offlineError();
    }
    if (res.headers.get('X-Hmelj-Offline')) throw API._offlineError();
    // The server answered, whatever it said — that alone proves the connection
    // is back, which is what ends an outage without waiting for the next probe.
    window.Connection?.noteSuccess();
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
  get: (u) => API._req('GET', u),
  put: (u, b) => API._req('PUT', u, b),
  post: (u, b) => API._req('POST', u, b),
  del: (u) => API._req('DELETE', u),

  status: () => API.get(API._acct('/api/status')),
  accounts: () => API.get('/api/accounts'),
  saveAccount: (a, id) => (id ? API.put('/api/accounts/' + id, a) : API.post('/api/accounts', a)),
  deleteAccount: (id) => API.del('/api/accounts/' + id),
  patchAccount: (id, patch) => API._req('PATCH', '/api/accounts/' + id, patch),
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
  importContactsFromEws: (accountId) => API.post(API._acct('/api/contacts/import/ews', accountId)),
  importContactsFromGraph: (accountId) => API.post(API._acct('/api/contacts/import/graph', accountId)),
  filters: () => API.get('/api/filters'),
  saveFilters: (l) => API.put('/api/filters', l),

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
  flags: (folder, uids, add, remove, accountId) => API.post(API._acct('/api/messages/' + encodeURIComponent(folder) + '/flags', accountId), { uids, add, remove }),
  move: (folder, uids, target, accountId) => API.post(API._acct('/api/messages/' + encodeURIComponent(folder) + '/move', accountId), { uids, target }),
  copy: (folder, uids, target, accountId) => API.post(API._acct('/api/messages/' + encodeURIComponent(folder) + '/copy', accountId), { uids, target }),
  deleteMsgs: (folder, uids, accountId) => API.post(API._acct('/api/messages/' + encodeURIComponent(folder) + '/delete', accountId), { uids }),
  /** Mark as spam / not spam, archive / unarchive. `box` is 'junk' or
   * 'archive'; the destination folder is the account's own setting and is
   * resolved server-side, never sent from here (see server/refile.js). */
  /** Answer a meeting invitation. `action` is accept | tentative | decline;
   *  the meeting itself is read off the message server-side. */
  respondToInvitation: (folder, uid, action, comment, sendResponse, accountId) =>
    API.post(API._acct('/api/message/' + encodeURIComponent(folder) + '/' + encodeURIComponent(uid) + '/invitation', accountId),
      { action, comment, sendResponse }),
  refile: (folder, uids, box, revert, accountId) =>
    API.post(API._acct('/api/messages/' + encodeURIComponent(folder) + '/refile', accountId), { uids, box, revert: !!revert }),
  send: (payload, accountId) => API.post('/api/send' + (accountId ? '?account=' + accountId : ''), payload),
  saveDraft: (payload, accountId) => API.post('/api/drafts' + (accountId ? '?account=' + accountId : ''), payload),
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
  oauthStart: ({ provider, email, accountId }) => API.post('/api/oauth/start', { provider, email, accountId }),
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
