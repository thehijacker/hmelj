# Hmelj 🌿 — Project Summary & Handoff

Self-hosted, Gmail-style **universal webmail client** (Slovenian: *hmelj* = hops).
Node 20+ ES modules, Express, vanilla-JS SPA, **no build step**. Developed conversationally
with Claude; this file is the handoff for continuing in Claude Code.

## What it is now

Users sign in with a **standalone Hmelj account** (username + password, created on the
login page), then attach **any number of IMAP/SMTP mailboxes** (home server, GMX, Gmail
via app password, …) through an in-app wizard. Mail is read per account or in a unified
**All inboxes / Vsi nabiralniki** view (merged Inbox + merged Sent) where each message
carries a colored chip of its source account. Full i18n: English + Slovenščina.

## Architecture — the important decisions

- **Per-request context via `AsyncLocalStorage`** (`server/session.js`): the auth
  middleware runs each request inside `{ userId, username, userKey, accountId }`.
  `store.js`, `imapClient.js`, `smtpClient.js` read the current user/account from ALS,
  so their function signatures never carry user/account parameters. When code must act
  on a *specific* account outside the request's own (unified fan-out, Sent-copy append),
  use `runWithAccount(accountId, fn)`.
- **`userKey` vs `viewerKey` — the shared-account trust boundary.** `requireAuth`
  re-points ALS's `userKey` at the account's *owner* whenever a request names a shared
  account in `?account=`; that swap is what makes a shared account resolve to one real
  mailbox and one cache, with no changes anywhere in the mail layer. `viewerKey` is
  always the real requesting login. **Which key a piece of state uses is a security
  decision, not a style one**, because `requireAuth` is mounted `app.use('/api', …)`
  and keys off the query string alone — so the swap reaches every route, not just mail
  ones. The rule:
  - *`viewerKey` — a property of the person*: settings, identities, contacts, filters,
    holidays (`store.js#userDir`), the user's own accounts list and account creation
    (`accounts.js#loadOwn/saveOwn`), the activity log, push devices, search-suggest,
    the OAuth *flow* state.
  - *`userKey` — a property of the mailbox being operated on*: `getAccount()` (a
    grantee's own `accounts.json` has no row for the shared mailbox), every cache and
    IMAP/EWS/Graph pool key, `oauth.accessTokenFor`'s `ownerKey` (a *rotated refresh
    token* must be written back to the owner's record), and `store.getOwnerSettings()`
    — `deleteBehavior`/`markReadOnDelete`, so a grantee can't turn the owner's "move to
    Trash" into "destroy permanently" by editing their own settings page.

  This was got wrong originally and was a real privilege escalation: per-user config
  followed the swap, so a grantee adding `?account=<a shared account>` to otherwise
  unrelated routes read and overwrote the owner's settings, identities, contacts,
  activity log, push devices — and **filters**, which run server-side under the owner
  across *every* account the owner has and can forward to an arbitrary address, so the
  share became silent permanent exfiltration of mailboxes never shared, surviving
  revocation. `test/share-isolation-test.mjs` (17 assertions) pins the whole boundary;
  10 of them fail if the key choice is reverted.
- **Mail routes take `?account=<id>`** (appended automatically by `API._acct()` in
  `public/js/api.js` from `API.account`). Missing param → 400. Unified endpoints
  `GET /api/unified/inbox|sent` fan out server-side over all accounts in parallel,
  tolerate unreachable accounts, merge by date, paginate in memory.
- **Auth**: Hmelj users in `DATA_DIR/auth.json` (scrypt, timingSafeEqual). Sessions:
  in-memory Map, httpOnly cookie `hmelj_session`, sliding 7-day TTL (restart = everyone
  logged out). Per-IP login rate limit (5 fails → 60 s). First user can always sign up;
  afterwards `ALLOW_SIGNUP` (default true) governs.
- **Mail account storage** (`server/accounts.js`): per user in
  `DATA_DIR/users/<userKey>/accounts.json`, passwords **AES-256-GCM** encrypted with a
  key from `GOLOB_SECRET` env or auto-generated `DATA_DIR/secret.key` (0600). Blank
  password on edit keeps the previous one. `testConnection()` verifies IMAP+SMTP and
  auto-detects Sent/Drafts/Trash via IMAP SPECIAL-USE (handles Gmail's `[Gmail]/…`).
- **Per-account state lives on the account object**: `sentFolder`, `draftsFolder`,
  `trashFolder`, `hiddenFolders`, `color`, `label`. Light edits go through
  `PATCH /api/accounts/:id`. Per-user global settings stay in `settings.json`
  (theme, language, deleteBehavior, column widths, …).
- **Identities are bound to a sending account** (`identity.accountId`): sending and
  draft autosave use that account's SMTP + Sent/Drafts folders. One identity is
  auto-created per new mail account.
- **IMAP connection pool** keyed `${userKey}:${accountId}`, closed after 10 min idle.
- **HTML sanitization** (`sanitizeMessageHtml` + `sanitizeCssText` in `server/index.js`):
  sanitize-html with `<style>` kept for newsletter fidelity (`allowVulnerableTags: true`
  — accounted for). All CSS `url(...)` in `<style>` blocks *and* inline `style=""`
  attributes follow the same external-image policy as `<img>`; `@import`,
  `expression()`, `behavior:` always stripped. `cid:` images rewritten to
  `/api/message/:folder/:uid/cid/:cid?account=…`.
- **External-image trust semantics**: `trustedDomains` entries match the **sender's
  domain** (→ all images in their mail load, wherever hosted — what the
  "Always trust X" button promises) *or* an image-host domain (global CDN trust).
  Blocked count feeds the client banner.
- **Dialogs** (`public/js/dialog.js`): promise-based `Dialog.prompt/confirm/alert/form`
  replacing browser prompts; i18n'd automatically by the MutationObserver. Also exports
  `uid()` — UUID fallback because `crypto.randomUUID` is unavailable on plain-HTTP origins.
- **i18n** (`public/js/i18n.js`): dictionary keyed by English source strings +
  MutationObserver DOM walker (skips message bodies/editors). Keep UI strings as single
  translatable units — don't split text nodes with inline tags like `<b>`.
- **A string with a value in it needs a `regexes` or `prefixes` entry**, not just a
  `strings` key. The observer matches whole trimmed text nodes exactly, so
  `` toast(`Marked ${n} message(s) as read`) `` can never hit the dictionary; it needs
  `^Marked (\d+) message\(s\) as read$`. Likewise `toast('Mute failed: ' + e.message)`
  needs the prefix `Mute failed: `. This is the failure mode that shipped a batch of
  English toasts into an otherwise Slovenian UI — reported from a phone, 2026-08-23:
  the battery-saving prompt, the mark-as-read failures, the push self-test, the blocked
  pop-up. Note that wrapping in `I18n.t()` does NOT help by itself: `t()` returns its
  argument unchanged when the key is missing, so the battery prompt was already wrapped
  and still came out English.
- **`en.json`'s `prefixes`/`regexes` are identity mappings.** `t()` returns early for
  English and never consults them, so a Slovenian replacement pasted in there is
  invisible until someone switches language. It happened while fixing the above.
- **`scratchpad/i18n-coverage-test.mjs` runs the real `t()` over every
  English-looking literal in `public/js`** and fails on anything it hands back
  unchanged — the general form of the bug, not a list of the specific strings. Two
  allowlisted: `'Not authenticated'` in `api.js`, thrown only to abort the promise
  chain after `location.replace('/login.html')` has already navigated away.
- **The Android shell has its own catalog** (`values-sl/strings.xml` and five other
  locales). Every string the Kotlin actually calls `getString()` on is translated;
  `eink_mode_label` is missing from all six, and is dead — no Kotlin references it.
- **The Contacts tab draws only the first `CT_RENDER_CAP` (200) rows.** Anything
  that adds a contact must put it where that cap can't hide it: "+ Add contact"
  `unshift`s rather than `push`es, because appending to a 212-contact list added
  it to the array and rendered nothing at all — the button looked dead
  (reported 2026-08-23). It then focuses the new row's name field and scrolls it
  into view; focus is right on mobile here, unlike a page that merely opened,
  because pressing "+ Add contact" IS a request to type. Note `collectContacts()`
  ends with `contacts = contacts.filter((c) => c.email)` — a row with a name but
  no address is dropped silently on the next collect, which is the other way
  this tab can look like it did nothing.
  `scratchpad/contacts-add-test.mjs` (14 assertions; pre-fix file fails 6).
- **A sub-page opened from a long list must start at its own top.** The
  Settings body is one scroll container reused by every tab, so replacing its
  `innerHTML` keeps whatever offset was there — press "+ Add account" from the
  bottom of eight accounts and the wizard opens with the type selector
  off-screen above. Three places set `body().scrollTop = 0` for this:
  `switchTab()` (every tab change), `renderAccountWizard()` and
  `renderFilterEditor()`. The two-level views save the list position on the way
  in (`accountsListScrollTop` / `filtersListScrollTop`) and restore it on the
  way back, which is why they don't go through `switchTab`. Focus goes to the
  first field only off-mobile — on a phone it throws the keyboard, or a
  `<select>`'s own picker, over the form before anyone asked to type.
  Reported for Accounts on 2026-08-23; Filters had the same bug earlier.
  `scratchpad/settings-scroll-test.mjs` drives the real settings.js in jsdom
  (13 assertions; the pre-fix file fails 5).
- **Login page language**: selector on login.html, defaults to browser language, stored
  in `localStorage['hmelj-lang']`, adopted into user settings at first app boot.
- **Wide messages** (`public/js/messageFrame.js`): a message body renders in a sandboxed
  srcdoc iframe whose height always equals its content (the reading pane does the
  vertical scrolling); anything too wide scrolls sideways *inside* that frame
  (`overflow-x:auto`). Touch gets that drag natively; desktop gets **Ctrl-drag**: hand
  cursor the moment Ctrl goes down (only when the content really is too wide), pans from
  anywhere including links, `preventDefault` on mousedown so no selection ever starts,
  and the click ending an actual drag is swallowed in the capture phase so it can't also
  open the link underneath. A plain drag is left alone — it selects text, like anywhere
  else; the earlier plain drag-to-pan couldn't do both and is gone. Ctrl state is
  forwarded in from the parent document (`broadcastCtrl`) because the frame only sees
  key events when it has focus, and every mouse event's `ctrlKey` corrects a keyup lost
  to alt-tab. The drag moves both axes: sideways inside the frame, vertically by posting
  `hmelj-pan` deltas to the parent, which scrolls the nearest overflowing ancestor
  (`verticalScrollerFor` — `.reading-pane` in the app, the window in the popout), since
  the frame has no vertical scroll of its own. Vertical deltas are measured with
  `screenY`, not `clientY`: the parent scrolling slides the iframe under a stationary
  cursor, and `clientY` would climb by exactly what was just scrolled — a runaway.
- **Filters tab is two levels** (`public/js/settings.js`): a list of every filter grouped
  by the account it runs for (`filterGroups()` — "All accounts" first, then accounts in
  `allAccounts()` order, then any whose account is gone; by name inside a group, with the
  UI language's collation), and an editor for one filter reached by clicking a row. The
  list shows name + enabled only — no rules/actions — and never fetches folder trees;
  `loadFilterFolders()` runs once per Settings session, on first entry to an editor.
  Both levels have their own **Save**, which writes filters alone and leaves the dialog
  open (the dialog-wide Save closed it, so adding filters one after another meant
  reopening Settings each time); `← Back to filters` keeps edits in memory like every
  other tab, and the list marks them *Not saved yet* until a Save. `collectFilters()` is
  a no-op unless an editor is open, so the dialog-wide Save still collects it.
  `Settings.collapseOneLevel()` gives the hardware/browser back key the same
  editor→list step before it closes the dialog (app.js `navCollapseOneLevel`).
  A rule/action is one flex line on desktop (`#settings-body .rule-row > …`), stacked
  again under 900px; `.f-rules`/`.f-actions` are flex columns with an 8px gap, since
  the rows are plain divs with no margin and `input:focus` draws its 2px outline 1px
  OUTSIDE the box — flush rows put that ring on the row below. The ID scope is required, not stylistic: it has to outrank
  `.card input:not(…)×5`, which scores (0,6,1) and was putting `width:100%` on every
  select and input — one control per line, so three rules read as nine lines.
  `folderOptions()` writes an explicit `value=""` on every `<option>`: without one an
  option's value IS its text, and i18n.js's observer translates text nodes — `INBOX` is
  a catalogue key (Prejeto / Inbox), so a move-to-INBOX action read back as
  move-to-"Prejeto". That made an untouched filter look edited AND wrote a folder path
  that doesn't exist. A target not in the account's tree is carried as its own option
  so it is never silently swapped for the first folder in the list — except when the
  account picker itself just changed, where the point is to pick again.
  Leaving the editor is a decision, not a silent copy-back: unchanged (including a
  filter added and immediately backed out of) leaves nothing behind at all, otherwise
  `Dialog.choose` offers Discard/Save with Cancel = keep editing — the same three-way
  compose uses on an unsaved draft. `editorPristine`/`editorIsNew` are what "unchanged"
  is measured against and what a discard restores (for a new filter, by removing it);
  `leavingEditor` stops a second back press stacking a second prompt. The editor also
  resets `body().scrollTop` and focuses the name field (selecting it for a new filter),
  skipped on a mobile viewport so the on-screen keyboard doesn't cover the form.
  Both bars have their own flex rules (`.f-footer`, `.f-editor-bar`) — this tab
  renders straight into `.modal-body`, and the rule that lays a `.row` out is
  scoped to `.card .row`, so a bare `.row` here gets no layout and its `.spacer`
  spaces nothing. Save sits bottom-right below the list and the hints.
  **Order matters**: server/filters.js runs them in stored array order and stops at the
  first one that moves or deletes a message, so the list is in array order (never
  sorted by name — that would show an order the engine doesn't use) and is
  **rearranged by hand**: a `.f-drag` handle with pointer events (not HTML5
  drag-and-drop, which touch browsers never fire), plus Alt+↑/↓ on a focused row.
  `readFilterOrderFromDom()` rebuilds the array from document order after a move,
  which works because group order is fixed. A drag stays inside its own account group:
  the account is a property of the filter, set in its editor. `touch-action: none` on
  the handle alone is what lets a finger drag the row while the list still scrolls
  everywhere else. Swapping triggers at the neighbour's midpoint, with the two
  direction tests exact mirrors so a row that just moved never bounces back; the
  transform is re-based on each swap (measure, move, measure) so the row doesn't jump
  out from under the pointer. Move/up listeners go on `document`, never on the handle:
  the swap's `insertBefore` MOVES the row, and moving an element releases the pointer
  capture it holds (touch's implicit capture included), so a handle-bound listener goes
  deaf after the first swap — that is what limited a drag to one place. Holding near
  either edge auto-scrolls the list (`filterDragScroll`, rAF): the scroll re-bases
  `startY` by exactly what moved and re-runs the crossing test, since a stationary
  finger fires no pointermove. A lost pointerup (alt-tab) is caught by a window `blur`
  handler so the animation loop can't outlive the drag. A reorder is marked
  *Not saved yet* like any other change. All-accounts filters render first and
  therefore run first.
- **A filter never moves or copies a message into the folder it is already in**
  (`samePath()` in `server/filters.js`). This looks like a pointless no-op guard and
  is anything but. IMAP MOVE is COPY + EXPUNGE, so moving a message into its own
  mailbox hands the copy a **brand new, higher UID**; sync.js polls that folder in
  its own right, sees a UID above the folder's high-water mark, calls it new mail,
  runs the filters, moves it again. Every cycle burns a UID, replaces the cached
  row with a fresh one and fires a push notification — while the mail server itself
  correctly holds exactly one message, so nothing looks wrong there. **Every**
  `to: contains x@host` → `move to INBOX.X` rule falls into this the moment its own
  target folder gets polled, which is to say immediately. It self-terminates only
  after ~2 days, when the message's Date header falls out of sync.js's
  "genuinely new mail" window. Reported 2026-08-24: one overnight message in
  INBOX.Nintendo, ten-plus identical notifications by morning, UID crept 2155 → 2158.
  `samePath()` compares trimmed paths with trailing separators stripped, and treats
  INBOX case-insensitively (RFC 3501 makes that one name case-insensitive and every
  other mailbox name case-sensitive). The skip deliberately leaves `moved = false`,
  so the filter's remaining actions and any later filters still run — the uid is
  still valid in this folder precisely because nothing moved. Stale duplicate rows
  left in the cache by a loop that already happened are cleaned up by
  `cache.pruneMissing()` on the next full scan (every 10th tick, or a forced
  sync-now). Covered by `test/filter-selfmove-test.mjs` (6 assertions, end-to-end
  against a real hoodiecrow IMAP server and a real Hmelj process; with the guard
  reverted the destination folder holds two copies of the same message after four
  more sync cycles).
- **A rule fires once per delivered message, not once per folder the message passes
  through** (`noteFiled`/`claimFiled` in `server/filters.js`, consumed by `sync.js`
  just before `runFilters`). Same root cause as the bullet above, one step along: a
  filter that *legitimately* moves a message — INBOX → INBOX.Nintendo — mints a new
  uid in the destination, and sync.js polls that folder in its own right seconds
  later in the same cycle. The message is new *there*, the rule matches it again,
  and every action runs a second time. move/markRead/star are idempotent so nobody
  notices; `redirect` and `reply` are not — the forward goes out twice, the
  auto-reply fires twice, and the recipient gets both. Measured before the fix:
  a rule with actions `[redirect, move]` sent **two** forwards, seconds apart.
  So `moveMessages()` now hands its `uidMap` (IMAP COPYUID via UIDPLUS; Graph and
  EWS always return the moved item's new id) to `noteFiled()`, which records
  `(userKey, accountId, destination, newUid)`; `pollFolder` asks `claimFiled()` for
  each newly-arrived uid and drops the ones it put there itself. Asking **consumes**
  the note, so only the single poll that first sees our copy is suppressed — a
  genuinely new message that later reuses that uid is filtered normally.
  Deliberately narrow: only the *filter run* skips these messages. `contentCache`
  and `notifyNewMail` still receive the full `fresh` set, so caching and
  notifications are unchanged. Deliberately in-memory (Map, 6h TTL, 5000-entry cap
  swept on insert because a hidden or out-of-scope destination is never polled and
  never comes to claim its notes): a restart between the move and the destination's
  next poll loses the note and the message is filtered twice, which is exactly the
  old behaviour and no worse. An IMAP server without UIDPLUS returns no `uidMap` and
  gets the old behaviour too — there is no way to tell which copy is ours. Covered
  by `test/filter-forward-once-test.mjs` (12 assertions; with only `claimFiled`
  reverted the same test reports the message forwarded 2×).
- **The compose body has two structural wrappers** (`compose.js`): `.compose-body` around
  what the user writes, `.quoted-block` around the quoted original (a forward's
  `---------- Forwarded message ----------` divider included). Both go out in the sent
  HTML, like `.signature-wrap`/`.quote-header` already did. They exist because two
  features need to know where the user's own text ends. **The signature** is inserted at
  the end of `.compose-body`, not the end of the editor — appended to the editor it
  landed *below* the quoted message on every reply and forward, which is nowhere anyone
  signs a letter (the reported bug). In plain-text mode there is no DOM to insert into,
  so `quotedTailText()` recomputes the quote's rendered text and the signature is spliced
  in ahead of that suffix; if the user has edited down in the quote the `endsWith` misses
  and it falls back to appending at the very end, exactly as before. A draft saved before
  these wrappers existed has neither, and `editDraft()` reopening it also falls back to
  appending. `forward()` passes `pos: 'below'` explicitly — "do not quote" is an answer
  about replies, and a forward with nothing forwarded is not a message.
- **Default compose font** (`settings.composeFont`, Settings › Compose) is written as a
  `font-family` on `.compose-body`, so it styles the user's own writing and leaves the
  quoted original alone. Deliberately NOT the generic-keyword list `uiFont`/`messageFont`
  use (`GENERIC_FONTS` in app.js): those render on *this* device, where a specific name
  can't be trusted to resolve, while this one is read by somebody else's mail client,
  where `Georgia` is the convention and `serif` would be answered arbitrarily.
  `FONT_STACK` maps each name to face-plus-fallback; `system-ui` maps to no
  `font-family` at all, which is what makes "System default" mean the reader's default
  rather than the sender's. `#c-editor.style.fontFamily` is display-only — it lives on
  the element, so it never appears in the `innerHTML` `payload()` sends — and `open()`
  now resets both it and the toolbar `<select>` (they are reused between compose windows,
  so a font picked in one message used to visibly carry into the next without being in
  that message's HTML).
- **Filters gate on arrival time, not the `Date:` header** (`sync.js#pollFolder`). A "new"
  UID isn't necessarily new mail — Gmail relabelling resurfaces old messages under fresh
  UIDs — so a 2-day recency guard has always stood in front of the filter run. It used the
  `Date:` header, which answers "how old is this" rather than the question actually being
  asked, "when did this arrive here". The two come apart in exactly the cases that matter:
  a sender with a wrong clock, or mail delayed days in transit, is genuinely new but was
  silently never filtered; a Gmail relabel has BOTH dates old, so switching to
  INTERNALDATE keeps that guard intact and loses nothing. Exchange and Graph have no such
  split (`DateTimeReceived`/`receivedDateTime` already *are* the received time) and report
  it under the same `internalDate` name, so the gate needs no per-backend case. Not cached
  — it is only ever read during the poll that fetched it, so no column and no migration.
- **Scheduled sending** ("send later", `server/scheduledSend.js`). The compose Send
  button is a split control; the caret offers presets or a `datetime-local` picker, and
  `/api/send` diverts to a queue when the payload carries `sendAt`. Validation still runs
  first on purpose — a message with no usable identity, or aimed at an account the caller
  can't send from, is refused **now**, while a compose window is open to show the error
  in, rather than silently at 07:00 tomorrow with nobody watching.
  - **The queue is files in `DATA_DIR`, not a table in `cache.sqlite`.** That database is
    disposable by contract (see `addColumn`), and a message not yet sent is the only
    thing in Hmelj that exists *nowhere else*. One file per message
    (`users/<viewerKey>/scheduled/<id>.json`, atomic write-then-rename): payloads carry
    base64 attachments, so flipping a status field must not rewrite tens of MB, and a
    partial write can then damage only one message.
  - **Its own ticker**, not the sync supervisor — `sync.start()` returns early when
    `CACHE_ENABLED=false`, and scheduled mail must still go out on a cache-less instance.
  - **"Server was down past the send time" needed no code.** The tick asks only
    `sendAt <= now`, so a message that came due while the process was dead is simply due
    at boot. That *is* the catch-up mechanism.
  - **Revalidation is free.** The runner sends inside `runAsUser(sender)`, so `sendMail`
    resolves through `resolveAccountForSending()` — a share revoked between scheduling
    and sending fails at send time instead of sending.
  - **Retry** walks `1m → 5m → 15m → 1h → 3h → 6h` to ~72 h, but **only for transient
    failures**: an SMTP 5xx skips the table entirely, because retrying "no such
    recipient" sixteen times only delays the bad news by three days. Giving up saves the
    message back to Drafts through the same `saveDraft()` an immediate failure uses, then
    logs and pushes.
  - **The crash case is not automated.** `sending` is written *before* the SMTP
    handshake, so a record found in that state at boot is flagged `unresolved` and never
    auto-retried — from outside there is no way to tell whether the mail went out, and
    retrying risks a duplicate while dropping risks a lost message. It surfaces in the
    Scheduled view and the Log for a person to decide. Same rule `withMailbox` already
    states about mutating commands that lost their connection.
  - Cancel returns the **full payload**, which `Compose.reopen()` restores — so "cancel",
    "reschedule" and "send it now" are one path, and a cancelled message is never dropped
    on the floor. `reopen()` also clears `pristinePayload` *after* `open()`'s deferred
    snapshot, or closing the window untouched would decide "nothing to save" about a
    message that no longer exists anywhere else.
  - `scheduledSend.js` can't import `index.js` (cycle), so `saveDraft` and `markOriginal`
    are injected via `setHooks()` at boot — the arrangement `sync.js` already uses for
    `idle.js`. The reply/forward marker is therefore applied when the mail actually goes
    out, not when it was queued.
  - **Reschedule moves the time only** (`PATCH /api/scheduled/:id`), never reopening the
    composer: re-sending a body through it to change one timestamp risks the message
    coming back subtly different from the one that was approved. A new time resets
    `attempts`/`lastError`, so a message that had already failed twice doesn't give up
    two tries early with a stale error still on screen.
  - The when?-menu is `Compose.pickSendTime(x, y, {current})`, a promise of a timestamp
    shared by compose's Send ▾ and the Scheduled view's Reschedule — one preset list, one
    parser. Reschedule passes the time already set: it heads the menu and seeds the date
    picker, which otherwise opened on tomorrow 08:00 — a suggestion presented as if it
    were the message's current setting, in the one place the user came to read that
    setting off the screen.
    It needed `openCtxMenu(..., {onClose})`, which fires on dismissal so an awaiting
    caller can't hang; picking an item clears the callback *first*, or close-then-click
    ordering would resolve "cancelled" ahead of the choice.
  - The Scheduled view hides select mode, layout, the unread/starred/muted filters and
    the sortable column header — they act on mail that exists in a mailbox, and offering
    controls that silently do nothing is worse than not offering them.
  - **A queued row reads like a message row.** It carries the account badge for the
    account it will go out through (resolved client-side from its identity, the same way
    `smtpClient.js#accountForIdentity` resolves it at send time, so the list stays one
    cheap JSON array), and its send time is drawn in `.m-date` — the cell all five list
    layouts already reserve for a time, which is the Date column in the table layout and
    the bottom-right corner of the card in the other four. Before that it had a class of
    its own with no grid placement at all and auto-flowed into a row above the subject.
  - **Click opens it, right-click acts on it** — the same gesture split as every other
    list in the app (it used to be the other way round, with a plain click going straight
    to a menu). `GET /api/scheduled/:id` returns the body and the attachment *names* —
    still never the bytes, which stay in the queue file. The preview reuses the reading
    pane's `.mv-*` chrome and the sandboxed `MessageFrame`, including the `#mv-body-slot`
    id, so a theme change rebuilds its iframe in place for free. It is always the pane,
    whatever `readingPane` is set to: the 'window' and 'off' modes address a message by
    folder + UID through `message.html`, and an unsent message has neither.
  - `renderList()` short-circuits to `paintScheduled()` in this view. It has to: the
    queue isn't backed by `state.messages`, and `renderList()` is what every open and
    close of the reading pane calls — without it, opening a queued message replaced the
    list underneath with "No messages here".
  - Covered by `test/scheduled-send-test.mjs` (41 assertions: persistence location,
    payload-free listing, preview (body yes, bytes no, decoded attachment size), cancel
    round-trip, id validation on every id-taking route, the year-ahead and already-past
    guards, interrupted-mid-send). It does **not** stub SMTP — the
    retry/backoff/give-up paths are verified on a real instance, not against a seam added
    only for a test. The retry *policy* is pinned directly, though: `nextBackoffMs`,
    `isPermanent` and `isExhausted` are exported as named pure functions, so the rules
    can be read and tested as three lines instead of inferred from `onFailure`.
- **The address book keeps itself** (`server/contacts.js`). Two rules, deliberately
  asymmetric, both opt-out from Settings › Contacts:
  - **Writing to someone adds them — if the user chose them.** Every To/Cc/Bcc recipient
    of a successful send becomes a contact, minus the ones Hmelj itself filled in: a
    reply's (and reply-all's) prefilled addresses ride along as
    `payload.prefilledRecipients` and are subtracted server-side. Answering somebody is
    not the same act as deciding to write to them, and an address book that collected
    everyone who has ever mailed you is exactly what the receiving rule below exists to
    prevent. Anyone added *on top of* a reply's own recipients still counts — that is the
    user choosing. Matched by parsed address, not by string, since the field can be
    reordered or respelled (`a@b` → `Name <a@b>`) between opening and sending. A draft's
    recipients are deliberately not marked prefilled: the user typed those, just earlier.
    After the send, never before — a message that bounced at the handshake is no evidence
    the address was typed right. Runs in the *sender's* ALS context, so a message sent
    through a shared mailbox lands in the sender's address book, not the owner's, and
    their own account/identity addresses are excluded.
  - **Receiving from someone never adds them.** An inbox is full of addresses nobody
    chose. Incoming mail may do exactly one thing: fill in the display name of a contact
    that is already there and hasn't got one — which is how `new_user@domain.com`, added
    the first time it was written to, becomes "Marko Okorn" when he replies. A name
    already stored is never replaced (the user's own spelling outranks whatever that
    person configured in their client this week), and a "name" that is just the address
    again is ignored so it can't permanently block the real one.
  - Cost is one small JSON read per folder poll that found new mail, and it exits on that
    read alone once the address book has no nameless entries left — the messages are
    never scanned at all in that case. Called from `sync.js` with an explicit `uKey`
    (background poll loop, no ALS), hence `store.getContactsFor`/`saveContactsFor`.
  - `addContacts()` moved here out of `index.js`: it is now shared by the vCard/CSV
    paste, the Exchange and Graph imports, the mail-history picker *and* the automatic
    add, so they cannot drift apart on what counts as a duplicate (lowercased address).
  - Covered by `test/contacts-learn-test.mjs` (18 assertions), including the two that
    matter most — a stored name is never overwritten, and a sender we have never written
    to is never added.
- **Your own addresses autocomplete too.** Every identity, plus any mail account whose
  address no identity already covers, is offered in To/Cc/Bcc — listed first (a small,
  fixed, high-signal set; CC'ing yourself shouldn't be below twenty contacts) and badged
  *you*. Never written into Contacts: they are not people you know, and an address book
  you have to keep deleting yourself out of is worse than one that simply knows. An
  address of yours that also ended up in Contacts via an import is listed once, as yours.
  Read live from `state`, so adding an account shows up in an already-open composer.
- **Pruning a contact from the composer.** The address book fills up on its own now, so
  the place it needs pruning is the place you notice the dead address: the recipient
  autocomplete, mid-compose. `Delete` arms the highlighted row (it turns into a confirm
  in place of the label) and `Delete` again removes it — one keystroke in a text field
  must not be able to delete stored data. Right-click, or long-press on a phone, opens a
  one-item menu instead, where choosing it *is* the confirmation; both are the same
  `contextmenu` handler, which unlike `bindLongPress` (`{passive:true}`) can suppress the
  native selection popup. `DELETE /api/contacts/:id` answers with the list that's left —
  not a PUT of the whole list, which would have deleted everything not matching whatever
  was typed in the field at the time. The contact name is escaped before it reaches
  `openCtxMenu`, which injects its labels as HTML.
- **Replied-to / forwarded markers** — the ↩ / ↪ every other mail client draws. Not
  Hmelj bookkeeping: it is the IMAP `\Answered` system flag and the `$Forwarded`
  keyword (RFC 5788), so a reply sent from Thunderbird or a phone lights up in Hmelj
  and vice versa. Most of the pipeline already existed — `\Answered` was read,
  cached and shipped to the browser, just never drawn and never *set*. What was added:
  `/api/send` marks the original after a successful send (`markOriginal`), resolving it
  through `resolveAccountForSending()` because the original needn't live in the account
  being sent *from*, and failing soft — a server that rejects keywords costs a missing
  arrow, never a failed-looking send. Compose carries `original: {accountId, folder,
  uid, kind}`; a forward sends that but deliberately *not* In-Reply-To/References, since
  a forward starts its own thread.
  - **Exchange**: EWS has no `\Answered`. `PidTagLastVerbExecuted` (MAPI `0x1081`,
    102/103 = reply, 104 = forward) is the equivalent and is what Outlook itself reads;
    `ewsClient.js` reads and writes it as an `ExtendedFieldURI`, plus
    `PidTagLastVerbExecutionTime` (`0x1082`) so Outlook can show "You replied on …".
    Tags are compared **numerically** — EWS may echo `0x1081` back as decimal `4225`,
    and a string compare would read that as "never replied to". Graph is the one
    backend still without this, documented in `toGraphEnvelope`.
  - The marker renders **inside** `.m-subject`, not as a sibling: the four grid layouts
    have no spare cell, and the row's trailing edge is where `text-overflow` clips —
    a marker there would vanish on exactly the long subjects that need one.
  - Two things that would have made it silently not work, both fixed here:
    `messagesSignature()` had to learn the new bits or `reconcileMessages()` returns
    early and never repaints; and `patchList()` had to patch the marker on rows already
    on screen (it only ever patched the star), which is the case that matters most —
    you reply to the message you are looking at.
  - `cache.js` gained its **first migration**, `addColumn()`: the schema is all
    `CREATE TABLE IF NOT EXISTS`, which does nothing to an existing database, so the new
    `forwarded` column would otherwise have reached new installs only. Additive-only by
    design — this cache is rebuilt from the mail servers, so anything needing more than
    a nullable column should delete the file instead of growing a migration framework.
  - Covered by `test/answered-marker-test.mjs` (cache round-trip, case-insensitive
    keyword matching, reconcile-doesn't-wipe) and `test/ews-verb-test.mjs` (the MAPI
    read/write mapping against realistic response XML, both tag spellings).
- **Conversation view** (`server/threading.js`, `cache.js#pageThreads`, `app.js#openThread`)
  — Settings › General, **off by default**. A folder's messages group into one row per
  conversation, with a count chip on the subject; opening it stacks the conversation in the
  reading pane, newest last and scrolled to, everything older collapsed to a clickable line.
  - **The thread key is the conversation's ROOT Message-ID** — `references[0] ||
    in-reply-to || message-id`, computed once on the way into the cache
    (`messages.thread_id`, added via `addColumn()`). RFC 5322 makes element [0] of
    `References` the root for every message in a chain, so each one derives the same key
    ALONE: no union-find, and no fix-up when a reply is cached before what it replies to,
    which is the normal case (a folder backfills newest-first). Exchange and Graph skip all
    of that and use their own `ConversationId`, which also survives changed subjects and
    moved messages. `Message-ID`/`In-Reply-To` were already in the IMAP ENVELOPE being
    fetched; only `references` was added to the HEADER.FIELDS list.
  - **Deliberately no subject-based merging.** It rescues chains from clients that strip
    `References`, at the cost of merging unrelated mail that shares a subject — the single
    most common way threading goes visibly wrong.
  - **Scope is the LISTED folder + that account's Sent** (and, when the listing IS Sent, the
    inbox instead — a conversation read from Sent shouldn't be a monologue either). One
    function answers that question, `index.js#threadScopeFolders`, and both the count and the
    stack go through it, so a row saying "7" and the stack it opens cannot disagree.
    Emphatically NOT the folder the row's newest message lives in: a thread whose newest
    message is a reply you sent is represented by a row carrying `folder: 'Sent'`, and
    scoping to that asked for [Sent, Sent] — a stack of nothing but your own messages, in a
    conversation that plainly had both sides. That bug survived two rounds of reports, so
    `app.js#listedFolderFor` and the test around it both spell out why. Only threads with a message in the listed folder are listed
    (`pageThreads`'s `homeSql`), and `threadUids` — everything a row's actions may touch —
    excludes the Sent members, so deleting an Inbox conversation never deletes your reply.
    In the unified view a row's actions are narrowed further, to the folder its newest
    message is in: `batchOpInner` resolves a batch action's folder from the ROW, and uids
    from a sibling folder would act on whatever carries those uids in the row's folder.
  - **Cache-only, unfiltered lists only.** A live IMAP listing cannot group (it sees one
    folder's page, not a thread), and with a search or an unread/starred filter active a
    count would mean "matching messages", not "messages" — both fall back to the flat list.
  - **Collapsed by default because each expanded message is an iframe plus its own body
    fetch.** Opening a twenty-message thread costs one envelope request and one body, not
    twenty of each. Each message marks itself read as it is expanded (its own timer —
    `state.markReadTimers` is a Map for exactly this), rather than a glance at the end of a
    thread marking twenty messages read.
  - `renderMessage` was split into **`buildMessageCard(msg, listEntry)`**, which returns an
    element and uses no ids (there is no longer "the" body slot or "the" ⋯ button). A single
    open message is one card and is byte-for-byte what it was; the theme rebuild
    (`refreshOpenMessageTheme`) walks every card's own `__frameOpts`.
  - **Opens in one paint.** The newest message's body is fetched BEFORE the pane is
    touched, so the stack is drawn already sitting on the bottom message — rendering the
    collapsed lines first and filling the last one in afterwards flashed. It is then pinned
    to the top of the pane while the stack settles (`stickCardToTop`), which reserves a
    pane's worth of `min-height` under it until its iframe reports a real height: until then
    the stack is barely taller than the pane, so the scroll clamps short and the card visibly
    jumps into place a moment later. The pin is abandoned on the first user scroll.
  - **Message headers collapse** to a two-line summary (subject + "who · when"), toggled by
    the ▾ in the header and remembered in `messageHeaderCollapsed` — a persisted POSITION,
    not a Settings checkbox, so the next message opens the way you left the last one. Inside
    a conversation every message above the newest always starts collapsed regardless.
    Banners (blocked images, read receipt) stay visible collapsed: they are actions, not
    detail. Optional **"Expand every message in a conversation"** opens the rest too, oldest
    first, sequentially — after the newest is on screen, so the pane is readable immediately.
  - **A conversation only ever spans what is cached**, which is each folder's newest
    `syncBackfillLimit` messages PER FOLDER. A mailbox whose Inbox is huge and whose Sent is
    small will show every message you sent in an old thread and only the recent replies —
    correct, and confusing enough to be worth knowing.
  - Covered by `test/threading-key-test.mjs` — including the property that matters most:
    a 4-deep chain collapses to one key regardless of the order the messages are seen in.
- **A reply's quoted history is collapsed** behind a ⋯ button — `server/quoteCollapse.js`
  for HTML, `MessageFrame.splitQuotedText` for plain text.
  - **The HTML half runs on the SERVER, and that is the interesting part.** It started inside
    the message frame, where the browser's own DOM is — which looks obviously right, since
    finding a quote means walking a parsed document. It was verified against 377 real cached
    messages and still did nothing in an actual browser, twice, with no way to see why: the
    frame is sandboxed, so there is no console to read from outside and no DOM to inspect
    from the parent. Moving it here changed nothing about the algorithm and everything about
    whether it could be trusted — the parse is the same parse (htmlparser2, already present
    via sanitize-html), the HTML is already being processed on this side, and the result can
    be run over the whole mailbox and diffed.
  - **Outlook is why the naive version failed.** Gmail/Thunderbird/Apple mark their quote
    with a class, an id or a `blockquote[type=cite]`. Outlook — most corporate mail — marks
    it with NOTHING: a divider div wrapping "From: … Sent: … To: …". So a header block is
    recognised by its TEXT (Slovenian, German and French label sets included), then hoisted
    to the outermost wrapper containing only the quote, since hiding the inner divider alone
    leaves its shell and border behind.
  - **Hidden with an inline `display:none!important`**, not a class alone: a message brings
    its own stylesheet, which loads after Hmelj's, and an inline important is the one thing
    it cannot outrank.
  - Conservative, and checked after marking rather than guessed at: it needs real text above
    the quote (else a bare forward collapses to an empty message) and a real quote below
    (else the button costs more than it saves). A collapsed quote is `display:none`, so
    find-in-message skips it too — you search what you can see.
  - **The round-trip trap:** htmlparser2 decodes entities, so `&lt;a@b.si&gt;` in a quoted
    header becomes the text `<a@b.si>`; serializing that back raw makes the browser eat it as
    a tag. `renderDom(doc, { decodeEntities: true })` re-escapes on output — the option name
    reads backwards. Found by diffing the text of 377 real messages before and after.
  - Measured over the live cache: 37/377 messages collapse (36 of 47 replies), 0 errors,
    0 text lost, ~8ms per message. `test/quote-collapse-html-test.mjs` covers the shapes and,
    just as importantly, the four cases that must NOT collapse.
- **One-click unsubscribe** (`server/unsubscribe.js`, `POST /api/message/:folder/:uid/unsubscribe`,
  Settings › Reading, default on). A newsletter says how to leave it in `List-Unsubscribe`;
  RFC 8058's `List-Unsubscribe-Post: List-Unsubscribe=One-Click` is what makes it genuinely
  one click, and the two are offered differently — a one-click header is SENT for you, a
  mailto is sent as a message, and a plain link is OPENED for you to finish. Preference order
  post → mail → open, same as Gmail: a mailto finishes without leaving the app, while a plain
  https link is as likely to be a preferences page behind a login as a one-step confirmation.
  - **Read from `parsed.headerLines`, not `headers.get('list-unsubscribe')`** — mailparser
    folds every `List-*` header into one `list` object, so that key does not exist and the
    feature shipped showing on nothing. The raw line is the better source regardless:
    mailparser's `list.unsubscribe` drops the mailto's `?subject=`, and some list managers
    unsubscribe you only if the mail carries the exact one they asked for. Folding is undone
    and repeated headers joined, both of which occur in the wild.
  - **The destination comes from the message, never from the request.** A client that could
    name it could make this server POST anywhere, or mail anyone.
  - **This is the only outbound HTTP request in Hmelj whose address is chosen by a message,**
    so the POST is https-only and refuses hosts that resolve into the server's own network
    (`isSafePostTarget`) — otherwise a crafted newsletter turns the mail server into a proxy
    into whatever it can reach. A one-click header pointing at a private address is
    downgraded to a plain link, not honoured; `javascript:`/`data:` targets are dropped.
  - **The link case is opened by the browser, inside the click handler** — a `window.open`
    after an `await` is the classic way to have a pop-up blocker eat it.
  - **The fallback: the link at the bottom.** Most newsletters publish no header at all —
    measured on the live mailbox, 1 of 291 cached HTML messages had one while 105 had a
    findable link, and one sender had 305 messages and not a single header. So when there is
    no header the body's links are scored (`pickUnsubscribeAnchor`): link TEXT saying it
    (English, Slovenian, German, French, Italian) outweighs a URL merely containing the word,
    since tracking URLs are full of stray words, and between equals the LAST one wins because
    an unsubscribe link lives in the footer. It is a GUESS and treated as one — only ever
    OPENED, never posted to or mailed, labelled differently in the banner, and links inside a
    collapsed quote are ignored (an unsubscribe link in mail somebody forwarded you is not
    your way out of anything).
  - Never automatic, and never on merely opening a message: unsubscribing tells a sender the
    address is live and read, which for genuine mail is fine and for spam is exactly what the
    sender wants to learn. Hence the setting, and hence a confirm dialog naming the
    destination before anything is sent. `test/unsubscribe-test.mjs` is mostly refusals.
  - **The banner is compact by default** (`unsubscribeBannerCompact`, Settings › Reading,
    2026-08-27). It is the one banner that appears on every message of a kind, directly above
    the first line of it, so at a large UI scale a full sentence of explanation cost more room
    than the message it introduced. Folded it is the 📭 icon and the button, shrink-wrapped
    (`display:inline-flex`) rather than a full-width strip; the icon unfolds the explanation
    for that message only, not remembered — unfolding one banner says what this sender offers,
    not that the setting was wrong. Nothing actionable is hidden: the confirm dialog names the
    address or host either way. Its own font size (11.5px × ui-scale), a size below the other
    banners, which are left alone.
- **Meeting invitations** (2026-08-27, `server/icalendar.js`). Two things, and the first is
  a plain bug worth remembering.
  - **Every EWS read said `Items.Message`.** Exchange returns a meeting request as
    `<t:MeetingRequest>`, an accept/decline as `<t:MeetingResponse>`, a withdrawal as
    `<t:MeetingCancellation>` — none of them a `<t:Message>`. The folder's own UnreadCount
    counts them all, so the symptom was precise and baffling: **the badge said 1 unread and
    the list was empty**, and a meeting invitation had never once been visible in Hmelj.
    `itemsOf()` takes every message-like element now; the listing re-sorts by date, because
    grouping by element name loses the document order Exchange sorted them into.
  - **Read once, for all three protocols.** The invitation is a `text/calendar` part
    (RFC 6047) parsed in `messageParse`, so EWS, Graph and IMAP all get it from the same
    place — both API backends hand over the whole raw MIME anyway.
  - **Answering needs no calendar of our own**, which is what makes this shippable well
    before v2's calendaring. EWS's AcceptItem/TentativelyAcceptItem/DeclineItem and Graph's
    `/accept` each do the whole job server-side: the calendar entry and the reply to the
    organizer, together. An optional comment rides along as the reply's body — that is the
    "answer with a message" case, and ticking *Add a message* is what opens the editor first.
  - **Answering is two decisions, not one**, and the first version only offered the verb.
    Each of Accept / Maybe / Decline now opens the three choices Outlook gives: *Send the
    response now*, *Edit the response first*, *Do not send a response*. Somebody who does not
    want to tell the organizer must not have that decided for them, which is what shipping
    only the first two amounted to.
  - **That needed a correction, not a workaround.** The first version asserted EWS could not
    record an answer without sending one. It can: the same CreateItem with
    `MessageDisposition="SaveOnly"` instead of `SendAndSaveCopy` — creating the response item
    is what drives the server-side processing, and the disposition only decides whether it is
    also put in the post. It is the mapping the EWS Managed API's own
    `MeetingRequest.Accept(sendResponse)` uses. Graph had `sendResponse:false` all along.
  - **Times are never guessed.** Exchange writes Windows zone names ("W. Europe Standard
    Time") that no `Intl` knows. The common ones are mapped; anything left is reported as
    FLOATING with its zone name carried through, and the pane shows the wall clock the sender
    wrote with the zone beside it. A meeting silently moved by an hour is much worse than one
    that says which clock it is on.
  - **Answering CONSUMES the invitation, and that has to be handled.** Both Exchange and
    Graph file a handled request into Deleted Items by default, exactly as Outlook does — so
    after an accept the message is simply gone. The first version assumed a folder re-sync
    would sort it out; it does not, because the incremental pass adds what is NEW and never
    notices what has gone. The row stayed in the list and clicking it produced the protocol's
    own words: "ErrorItemNotFound — The specified object was not found in the store."
    - Both backends now ASK rather than assume (one IdOnly GetItem, one `$select=id` GET) and
      report `consumed`, because both wrong answers are visible: a row for an item that is
      gone is what got reported, and deleting a row for one that is still there would lose it
      until the next full reconcile. The mailbox setting that keeps answered requests is real.
  - **A vanished message is now an ordinary outcome anywhere**, not just here. Both backends
    mark a not-found error as `notFound` (EWS's ErrorItemNotFound family, Graph's 404), the
    message route drops the stale cached row and answers **410** with a sentence a person can
    act on, and the client takes the row off the list instead of leaving one that fails on
    every click. Moved elsewhere, deleted from another client, answered — same thing.
  - Not built: answering from an IMAP account, which means composing an iTIP `METHOD:REPLY`
    by hand. The route says so rather than appearing to work.
- **Undecoded quoted-printable, and the detector that nearly corrupted 20 messages**
  (2026-08-27, `server/transferEncoding.js`). mailparser decodes each part by its own
  Content-Transfer-Encoding; a sender that writes quoted-printable into a part it labelled
  7bit leaves nothing to decode, and the body arrives as literal `=C5=A0e ne poznate`.
  - **Scope, measured first:** 14 of 2256 cached messages, always the text/plain half of a
    multipart/alternative whose HTML half decoded perfectly. Since every consumer prefers
    HTML (`msg.html || msg.text` — the pane, reply quoting, printing), **the reading pane was
    never showing this.** It reached notification previews, and would reach the pane and a
    reply's quoted text the moment such a message arrived with no HTML part. Repaired anyway,
    at parse time and again in `contentCache.normalize` — the latter so the 14 already in the
    cache come right on the next read, rather than bumping CONTENT_VERSION and re-fetching
    2256 messages to fix fourteen.
  - **The lesson is in the detector.** The first rule — three `=XX` tokens, or a soft line
    break — looked reasonable and was catastrophic: over the real cache it fired on 54 texts
    and CORRUPTED 20 of them. A debug log's `pid=517` became `pidQ7`, `git_sha=2940f9…`
    became `git_sha)40f9…`, a bank's `?doc=24030&SeS=19320…` gained a `$` and a control
    character, and base64 padding at a line end was eaten as a soft break.
  - What fixed it was not a longer pattern but the encoding's own defining property:
    **a quoted-printable body is 7-bit ASCII.** Escaping the bytes above 0x7F is the entire
    reason it exists, so any text already containing an accented character was already
    decoded. Every one of those 20 was Slovenian or emoji-bearing text with its accents in
    place. Plus: at least three tokens for bytes >= 0x80, and a post-decode rejection if the
    result contains stray control characters. Final sweep: fires on exactly 14, repairs 14,
    zero false positives, zero missed.
  - Never applied to HTML, where `bgcolor=FF0000` matches the same pattern — and where, over
    all 2256 messages, not one part needed it.
- **A message's text/plain part is not plain text** (2026-08-27, `server/notifyText.js`).
  The notification preview was `msg.text || sanitizeHtml(html, { allowedTags: [] })`, and
  every way it failed came from that one assumption. Counted over 793 real cached messages:
  36 previews were raw HTML (a Mailchimp template verbatim), 113 carried `[bracket]` markers
  (`[image: Logo]`, `[Vitapur](https://…)`, html-to-text's `<url>` suffix), 13 were
  quoted-printable that was never decoded, 45 were padded with the invisible characters
  newsletters use to control an inbox preview line, 5 showed `&amp;` (sanitize-html ESCAPES
  its text output, so stripping tags is not enough), and 3 showed Outlook's conditional-
  comment scaffolding. After: **0 of each, none newly empty, 0.33ms per message.**
  - The fix is structural, not a longer regex: the text part is a CANDIDATE. It is cleaned,
    and if what comes out still looks like markup the HTML is used instead — with the
    stripped text as a last resort so a preview is never lost entirely.
  - **A real ReDoS turned up on the way.** The first CSS-detection regex,
    `[^{}]*\{[^{}]*:[^{}]*`, has nested unbounded quantifiers; on a long brace-free body it
    backtracked so badly that this one function cost **7 seconds across 793 messages**. Every
    quantifier is bounded now, the cheap `includes('{')` guard runs first, and the input is
    capped before any of it. Worth remembering as the reason to sweep new parsing code over
    real data with a stopwatch, not only for correctness.
- **An unsubscribe you cannot verify is barely better than none** (2026-08-27). The banner
  said "Unsubscribe request sent (0rhmo.mjt.lu)" whichever of the three things had happened,
  which answered none of the questions worth asking — sent how, to whom, and did it work.
  Each method now says what only it knows: a one-click POST reports the host and the HTTP
  status the sender's own server answered with (any non-2xx is already an error, so a status
  reaching the banner IS the confirmation); a mailto names the address it went to and the
  identity it went from, which is what a list manager matches on; an opened page never claims
  you unsubscribed, because nothing here can know.
  - And it is written down, under the SENDER's address
    (`store.getUnsubscribes`, `users/<key>/unsubscribed.json`), with the message route
    shipping it back as `msg.unsubscribed`. Pressing Unsubscribe, opening another message and
    coming back showed the same untouched offer — now every message from that newsletter says
    "Unsubscribed 27.08.2026 — …" and the button reads *Unsubscribe again*, which is exactly
    what you want when a sender keeps mailing you.
  - Keyed by sender, not by unsubscribe target, because that is what a person means by "this
    newsletter". A sender running several lists off one address reads as unsubscribed after
    the first — a deliberate trade, and the button is still there.
- **Links in a message leave the app** (2026-08-27, `MessageFrame.openLink`). It lives in
  messageFrame.js because that file already owns the link protocol and is loaded by the
  message popout too.
  - **In the APK this was not a preference but a bug**: that WebView never calls
    `setSupportMultipleWindows(true)`, so `window.open()` is silently INERT — a link in a
    message body did nothing whatsoever, with no error to see. A new `AndroidApp.openLink`
    bridge method hands it to the system default browser (`ACTION_VIEW`, http/https only —
    it must not become a general-purpose intent launcher). Kept separate from `openExternal`,
    which prefers a Custom Tab because OAuth has to come back here; a link is somewhere the
    reader is going. Older APKs fall back to `openExternal` (https only).
  - Everywhere else `window.open('_blank')` is the whole of what is possible. **A web page
    cannot choose which application opens a URL**: Hmelj open in Firefox opens links in
    Firefox, and there is no API that hands one to a different default browser. Only a native
    wrapper can. In a standalone PWA `_blank` does leave the app's own window, which is the
    achievable half of what was asked.
- **The message list does not hold text** (2026-08-27). It is a grid of rows you click, so
  `user-select: none` — dragging across it selected subjects and senders instead of doing
  nothing, and on a phone the selection handles were racing `bindLongPress` for the same
  press. That frees the drag gesture's space for **Ctrl+click** to start a selection (Cmd on
  a Mac, where Ctrl+click IS the right-click gesture and would fire the row menu at the same
  time). The selection is added BEFORE `setSelectMode(true)`, since that is what re-renders
  the list — it clears the set only when turning select mode off. Desktop only. Everything
  in the reading pane stays selectable except the address chips, which have their own Copy.
- **The chip is drawn once; the stack is fetched on the click** (2026-08-27). Reported as
  "the list says 2 and the pane shows 4" — and both numbers were right when they were
  computed. A conversation that grows while the list sits on screen keeps its old count until
  a silent reconcile happens to run; opening it reads the truth at that instant. Opening is
  also the one moment the true count is free, so `correctThreadCount` teaches the row then
  rather than waiting. Only the count — `threadUids` still means "the messages in the folder
  you are looking at", which is all any action on the row may touch.
  - Worth keeping straight, because the same two numbers disagreed for a completely different
    reason a few hours earlier (scope, not staleness). Checked against the live cache before
    changing anything: both views were internally consistent (single-account INBOX 2/2, All
    inboxes 4/4), which is what ruled scope out and left timing.
- **A conversation is a conversation, whatever view you are in** (2026-08-27,
  `cache.conversationFolders`). The count on a row and the stack that opens from it disagreed
  three separate times in one day, each for a different reason, and every one of them came
  from the same mistake: taking one of the two numbers over the LISTING's folder set instead
  of the conversation's.
  1. The stack was scoped to `[the row's folder, Sent]` while the unified count spanned every
     folder — a thread half-filed into a filed subfolder opened as a single message under a chip
     saying 2.
  2. Fixing that left the same thread reading 2 in a single-account Inbox and 4 in All
     inboxes.
  3. And it dropped back to 2 whenever that folder was **muted** and the list was hiding muted
     folders — a notification schedule quietly deciding how many messages a conversation has.
  - The fix is to stop having two notions. `conversationFolders` is the single definition:
    every folder of the account except Trash/Junk/Drafts and the ones hidden from the sidebar,
    plus Sent. **Mutes are ignored on purpose** — muting silences a folder's alerts, it does
    not take its messages out of a conversation they are part of. Hidden folders stay out:
    that one really is "do not show me this folder's mail".
  - **The listing is still filtered; only the count is not.** An Inbox listing reads this
    folder plus Sent (widening it further would put other folders' mail in the Inbox), a
    thread appears only if it has a message in the folder being listed, and a muted folder
    contributes no rows of its own. `pageThreads` takes a separate `convoWhere` for the count
    alone.
  - **`threadUids` deliberately did NOT widen.** An action on a row still touches only the
    messages in the folder being listed, and `threadUnseen` stays over those too, so the
    unread mark matches what clicking actually marks read. The count is the one thing that
    means "the whole conversation".
- **The chip is drawn once; the stack is fetched on the click** (2026-08-27). Reported as
  "the list says 2 and the pane shows 4" — and both numbers were right when they were
  computed. A conversation that grows while the list sits on screen keeps its old count until
  a silent reconcile happens to run; opening it reads the truth at that instant. Opening is
  also the one moment the true count is free, so `correctThreadCount` teaches the row then
  rather than waiting. Only the count — `threadUids` still means "the messages in the folder
  you are looking at", which is all any action on the row may touch.
  - Worth keeping straight, because the same two numbers disagreed for a completely different
    reason a few hours earlier (scope, not staleness). Checked against the live cache before
    changing anything: both views were internally consistent (single-account INBOX 2/2, All
    inboxes 4/4), which is what ruled scope out and left timing.
- **The count and the stack have to be taken over the same folders** (2026-08-27). This is
  the same bug as the "conversation of nothing but my own replies" one, in its second
  disguise: a row in **All inboxes** showed a chip saying 2 and opened as a single message.
  The unified list is not one folder — it spans every folder of an account except
  Sent/Trash/Junk/Drafts and the hidden ones — so its count is taken over all of them, while
  `/api/thread` was still scoping the stack to `[the row's folder, Sent]`. On the live
  instance the conversation's earlier half had been filed into a folder called
  a filed subfolder, which is in neither.
  - `cache.unifiedScopeFolders` is now that set, expressed as paths, and the route takes
    `scope=unified` from the client (`app.js#threadScopeParam`). Sent is appended on the way
    out: the listing excludes it, but a conversation is not a conversation without your half.
  - The invariant worth remembering, since it has now been broken twice in two different
    places: **whatever set the chip's number was counted over is the set the stack must be
    read from.** `test/threading-key-test.mjs` asserts both directions for both listings.
- **Addresses in a message header are actionable** (2026-08-27, `app.js#addrChip`). They are
  chips carrying name AND address — the To line printed `name || address`, so a recipient
  with a display name showed as "NOC Services" and its address appeared nowhere in the app,
  while Cc on the very same header printed the bare address. Right-click or long-press gives
  Copy address / New message. The menu is delegated per card, not per address, and the chip
  is `user-select: none` with the iOS callout suppressed — otherwise the browser's own
  selection handles win the same 550ms gesture that bindLongPress is waiting on, which is
  also why Copy is in the menu at all (selecting the text by hand is what it replaces).
- **Safe areas are four insets, not one** (2026-08-27). Only `--sat` was ever really
  honoured, which is invisible until a phone is turned on its side: the camera cutout moves
  to one edge and the navigation bar to the other (or along the bottom), and the message
  list, the reading pane and the sidebar footer all ran underneath the buttons.
  - The side insets go on the CONTAINER (`.main`, plus every element fixed to the screen
    rather than to a pane — the mobile sidebar, the sheet backdrop, the find bar, the FAB,
    the floating composer), so the app background is what sits beside the bars. The bottom
    inset goes on each SCROLL container (`.msg-list`, `.reading-pane`, `.sidebar-footer`),
    so content scrolls clear of the bar while backgrounds still run to the screen edge.
  - **The same bug existed twice**, because the native Android shell doesn't let the page
    see insets at all — it shrinks its own WebView by margins instead (a bare WebView never
    computes `env(safe-area-inset-*)`). Its listener took `navigationBars().bottom` and
    nothing else, and in landscape that bar is on a SIDE. Now all four sides, `maxOf` per
    side against the cutout — adding them would inset twice as far as either needs. So the
    APK needs a rebuild for its half; the CSS half covers the PWA and the browser.
- **A menu that doesn't fit has to scroll** (2026-08-27). `.ctx-menu` and `.bottom-sheet`
  both cap at the safe area and scroll. The interesting half was `openCtxMenu`'s
  positioning: `Math.min(y, innerHeight - height - 8)` goes NEGATIVE for a menu taller than
  the screen, so the reading pane's twelve-entry ⋯ menu on a landscape phone put its first
  items above the top edge with no way to reach them. Clamped from both directions now, and
  into the insets rather than merely into the viewport.
  - Insets are read from the inline style index.html's probe writes onto `<html>`
    (`app.js#safeInsets`), never `getComputedStyle` — an unregistered custom property whose
    value is an `env()` expression comes back unresolved from there, so `parseFloat` would
    quietly answer 0 on exactly the devices this is for.
- **Keep the screen on** (2026-08-27, Settings › General, device-local, default on). The
  Android app has always set `FLAG_KEEP_SCREEN_ON` unconditionally; this is the way to turn
  it off. Two mechanisms because there are two kinds of install: the native shell holds the
  window flag through a new `AndroidApp.setKeepScreenOn` bridge method (Android's WebView
  implements no Wake Lock API at all, so the web path simply does nothing there), and
  everything else uses the Screen Wake Lock API — re-taken on `visibilitychange`, since the
  browser drops the lock whenever the page is hidden. Device-local for the same reason the
  font size is: it is a property of the thing with the screen. The web path is gated on
  `(any-pointer: coarse)` — a desktop tab quietly stopping the display from ever sleeping is
  not what this setting means.
- **Spam and Archive are one route with a memory** (`server/refile.js`,
  `POST /api/messages/:folder/refile`, 2026-08-27). "Mark as spam" and "Archive" are
  ordinary folder moves; what needed thinking about is the way BACK, because a moved
  message has a new uid in a different folder and nothing about it points home.
  - **The destination is the account's, never the request's.** `box` is `'junk'` or
    `'archive'` and names a per-account setting (`junkFolder`/`archiveFolder`); the folder
    path is resolved server-side. So this route can never be talked into moving mail
    somewhere `/move` wouldn't already allow, and an account with no such folder is a 400.
  - **A ledger, not a source of truth.** Filing writes down `{account, destination folder,
    the uid it landed under} → the folder it left` (`users/<key>/refile-origins.json`,
    pruned by age and capped, both inside `noteOrigins` — the only thing that ever grows
    it). Coming back, that decides the destination, one move per remembered folder. Anything
    unrecorded goes to `INBOX`, which is the COMMON case rather than the sad one: most spam
    was filed by the server's own filter and was never anywhere else. An entry is dropped
    the moment its message comes back, so a reused uid can never resolve to a stale answer.
  - **Both menu entries hide themselves** when the account has no such folder, and one
    function decides that for both the menu and the move (`index.js#refileFolderFor`). It
    resolves the stored name against the account's cached folder list, standing in the
    server's own `\Junk`/`\Archive` folder when the name is stale, and answering '' when
    there is none. `/api/accounts` ships the result as `hasJunk`/`hasArchive`.
    - It has to be the SERVER's answer: the first version checked `state.folders` in the
      browser, which holds the folders of the one account in the sidebar and is empty in the
      unified view — so "All inboxes" offered Move to Archive on every account while each
      account's own Inbox got it right. Reported, and obvious in hindsight.
    - Measured on the live instance before and after: of 13 accounts, 2 have an Archive
      folder (the other 11 carried the invented name), 9 have a junk folder, and one had a
      mapping pointing at "Junk" where the server's is "Spam" — which the special-use
      fallback now heals. Three Gmail accounts expose no junk folder over IMAP at all, and
      correctly offer nothing.
    - Two supporting fixes: `(None)` in Settings › Folders now survives an account edit
      (`??`, not `||` — `''` is a real answer for these two), and auto-detect on a new
      account only ever picks a folder that EXISTS, by special-use flag or by name, rather
      than falling back to the literal string 'Junk'.
  - Optimistic like delete — the row leaves the list before the round trip and is put back
    if it fails — and the Undo is the same route run the other way, on the uids from
    `uidMap`. `test/refile-test.mjs` covers the ledger; the move itself is `/move`'s code
    (`moveAndMirror`, factored out so the cache mirroring exists once).
- **Read receipts are answered by hand, never automatically** (`server/readReceipt.js`,
  `POST /api/message/:folder/:uid/receipt`). A sender asks with `Disposition-Notification-To:`;
  the reading pane says who asked and offers a button, and nothing is sent until it is
  pressed — an automatic receipt tells a stranger the address is live and read. The MIME is
  written by hand: a receipt is a `multipart/report; report-type=disposition-notification`
  whose second part is a `message/disposition-notification`, a structure MailComposer has no
  notion of, and getting it wrong means sending an ordinary email no client recognises as a
  receipt. Destination read off the MESSAGE, header values CRLF-stripped, `Auto-Submitted:
  auto-replied`, and no receipt requested of its own — that is how mail loops start.
  `$MDNSent` (RFC 3503) is set best-effort so other clients don't offer it again.
- **The content cache carries a version stamp** (`contentCache.js#CONTENT_VERSION`). Cached
  message JSON is written by whatever messageParse.js was running at the time and is never
  re-parsed, so a message read often enough to matter is exactly the one that never picks up
  a newly added field — the read-receipt banner shipped depending on a field every cached
  message lacked, and looked simply broken. A stamp mismatch is now treated as a miss: one
  live fetch, then it is current. Bump it whenever the parsed shape gains something the UI
  relies on.
- **Attachment bytes are immutable, and are finally treated that way**
  (`server/attachmentCache.js`, the two attachment routes, `public/js/attachmentViewer.js`).
  Reading one part is expensive out of all proportion to its size: every backend answers by
  pulling the message's ENTIRE raw source (base64, ~1.33x everything attached) and running
  mailparser over all of it to cut out one part. Three attachments cost three of those; an
  HTML body with six inline images cost twelve, because the `cid` route parses once to find
  the part and once to extract it — and it re-did that every time the reading pane rebuilt
  its frame, which a theme change alone triggers. Nothing about a given (account, folder,
  uid, part) can ever change, so: a strong `ETag` + `Cache-Control: private, max-age=86400,
  immutable` (the browser's own cache is the only layer that costs the server nothing),
  behind it a byte-bounded in-memory LRU (`ATTACHMENT_CACHE_MB`, default 32) — **RAM only**,
  because attachment bytes are the one thing the SQLite cache deliberately refuses to hold,
  and a bound in bytes rather than entries because 64 thumbnails and 64 videos are not the
  same risk. `immutable` is load-bearing, not decoration: without it a plain reload
  revalidates, and answering "still fresh?" honestly needs the bytes in hand, which is the
  work being avoided. The length is baked into the ETag for the only case where a uid could
  point at different bytes (a server reusing uids after an expunge). The viewer fetches
  rather than assigning `<img src>`, so the several seconds it can still take the first time
  are spent behind a real progress bar with a real total instead of an empty black overlay,
  Esc actually aborts the transfer, and the Blob it ends up with is reused by Download and
  Share — Download asks for `?download=1`, a different URL, so the HTTP cache never helped
  it. Video is exempt from all of it and plays from the live URL: buffering a film into a
  Blob to show it in one go is strictly worse than letting it start.
- **Search says what it searched, and offers the rest** (`app.js#searchScopeRow`,
  `?scope=account`). The default search is a cache read: each folder's newest
  `syncBackfillLimit` messages, matched on subject/from/to only, and it used to fall through
  to the server only when it found NOTHING — so two cached hits looked like the whole truth
  on a 19 000-message mailbox. The footer now says so and links to the real thing: every
  folder of the account, asked live, matching bodies too (`fullText` → IMAP `TEXT`, EWS with
  `item:Body` added, KQL without a field prefix). Gmail is the case that forces it to exist:
  label-overlap protection keeps sync inside the INBOX tree, so `[Gmail]/All Mail` — where
  every archived message lives — is in no cache and was searched by nothing. `searchFolderPaths`
  prefers that one folder for exactly that reason: complete, and no duplicates. The sweep
  itself is the `is:starred` machinery generalized (`sweepLive`).
- **Find in message** (`public/js/messageFind.js` + a find block inside `messageFrame.js`'s
  frame script) — Ctrl/Cmd+F over an open message, or ⋯ › Search in message. Split across
  two files because the body frame is sandboxed **without** `allow-same-origin`: the parent
  cannot read a character of it (and loosening that would hand a message's own scripts a
  same-origin handle on the app), so the search and the highlighting run inside the frame
  and the UI, keyboard and scrolling live outside, talking over the existing postMessage
  channel. Highlighting uses the **CSS Custom Highlight API** — no `<mark>` wrappers spliced
  into a stranger's HTML, so nothing reflows and clearing is one call. The frame is always
  exactly as tall as its content, so the PANE does the scrolling: the frame reports where a
  hit landed and the parent parks it below the floating bar, which is what makes "the bar
  never covers the current hit" keepable rather than aspirational.
- **Save as EML** — the View-headers dialog, next to Copy raw headers.
  `GET /api/message/:folder/:uid/eml` serves the raw source through the existing
  `contentDisposition()` helper; the client clicks a temporary anchor rather than building a
  Blob, so the full source never sits in memory and the Android shell's `DownloadListener`
  sees an ordinary cookie-carrying download.
- **Plain-text bodies are linkified** (`MessageFrame.linkifyText`, exported and reused by
  compose.js's `quoteBlock`): a `text/plain` part has no markup, so `<pre>${esc(text)}</pre>`
  rendered bare URLs as inert characters. Matches `http(s)://`, `www.`, `mailto:` and bare
  addresses only — never a scheme-less host in running text, and never a scheme outside
  that set, so `javascript:`/`data:` can't become an anchor. Trailing sentence punctuation
  is trimmed back off the match (`…povezavo: https://host/x.`), with bracket counting so
  Wikipedia's `…/Foo_(bar)` survives. Escaping is done per segment, and the href gets an
  extra `"`→`&quot;` pass `esc()` doesn't do (textContent/innerHTML leaves quotes alone).
  Links reach the outside world through the frame's existing click → `hmelj-link`
  postMessage → parent `window.open` path, the same one HTML mail uses. `editDraft()` is
  deliberately NOT linkified — that's the user's own draft, kept as written.
- **Resizable columns**: `--folder-col` / `--list-col` CSS vars + pointer-capture drag
  handles (`#resizer-sidebar`, `#resizer-list`), persisted debounced to settings
  (`folderColWidth`, `listColWidth`). Hidden on mobile.
- **Unified-view frontend rules** (`public/js/app.js`): each message row carries
  `m.account` + `m.folder`; every per-row/batch action wraps in `withMsgCtx(m, fn)` or
  `batchOp(uids, fn)` which temporarily bind `API.account` to the message's own account.
  `state.currentAccount` is `'all'` or an account id; smart folders `INBOX` / `__SENT__`.
- **Assets are version-stamped, because there is no build step** (`server/index.js`, the
  handler above `express.static`). The three HTML entry points are read and served with
  `?v=<newest mtime across public/js and public/css>` appended to every local script and
  stylesheet URL. Without content-hashed filenames every deploy depended on the browser
  revalidating each file, and the failure mode when it didn't was the nastiest kind: a page
  running a MIXTURE of old and new files, which reads as a feature being broken rather than
  stale — it cost two rounds of debugging a message-frame change that was provably correct.
  A changed file changes the URL, and a URL nothing has ever requested cannot be stale in a
  browser cache, a service worker or a proxy. The SW's offline fallback uses
  `ignoreSearch: true` so a versioned URL still finds its pre-cached copy.
- **PWA**: manifest + `sw.js` (network-first app shell, never caches `/api`), SW cache
  name currently `hmelj-20260826014` — **bump on shell changes**.
- **The app was called Hmail until 2026-08-23** and is now **Hmelj**. The rename
  went through everything — UI strings and both translations, docs, package and
  container names, CSS classes, `postMessage` types, the `hmelj_session` cookie,
  the Android flavor (`com.hmail.app` → `com.hmelj.app`, source set moved to
  `Android/app/src/hmelj/`), and the dove emoji became 🌿 — the dove was a
  pun on *golob*/pigeon and says nothing under a name that means hops. (Unicode
  has no hops emoji; 🌿 is the usual stand-in.) The app icon was redrawn to
  match: `public/icons/icon.svg` and the Android adaptive-icon foreground are
  both **generated** by `scripts/gen-icon.py` from one set of geometry — a hop
  cone of shingled bracts clipped to a single silhouette, its tip resting in an
  open envelope (the pigeon carried one; the mark should still say *mail*), on
  the same brand blue. Edit the generator, never the two outputs, then re-run it
  and `npm run icons`; hand-editing one of them silently desynchronises the
  phone icon from the web one.

  The envelope is drawn **before** the cone and that ordering is load-bearing,
  not incidental: in front it cuts the taper off flat, and a dome above a box
  below is a hot-air balloon in a basket. Behind, the flap's two diagonals come
  out either side of the tip and the pair reads as one object. `rename-test.mjs`
  asserts the order in both files, and fails if either is regenerated the other
  way round.

  **Env vars are `HMELJ_*` and nothing else.** `HMELJ_SECRET`,
  `HMELJ_PUBLIC_URL`, `HMELJ_GRAPH_BASE` — the `HMAIL_*` / `GOLOB_*` fallbacks
  were carried for one commit and then dropped once this install's `.env` had
  been moved over (same value, verified byte-for-byte). `HMELJ_SECRET` decrypts
  stored mailbox passwords, so an older `.env` restored from backup must have
  its key **renamed**, not left to fall through: there is nothing to fall
  through to but a freshly generated `secret.key`, and the passwords are then
  unrecoverable. `scratchpad/secret-fallback-test.mjs` pins both halves — the
  variable is read, and the old names are not.

  Three compatibility shims stayed behind, each protecting something a device or
  an install already holds:
    - `app.js#migrateRenamedStorageKeys` moves every device-local key to its
      `hmelj-` name once and clears the old one — `device-settings`, `lang`,
      `settings-tab`, `last-account`, `notif-prompted`, `battery-prompted`,
      `codexa-push-token`. Add any new key to that list *and* to the rename
      test: dropping `last-account` resets the sidebar to All inboxes, and
      dropping either `*-prompted` flag re-asks a question already answered.
      `index.html` and `message.html` additionally read the old key as a
      fallback in their pre-paint theme snippets, so the first load after the
      rename doesn't flash the wrong theme before app.js gets to run.
    - `window.__hmailHandleBack` / `__hmailNetworkRestore` / `__hmailNetworkLost`
      stay aliased to the `__hmelj*` hooks, because the pre-rename APK is a
      *different* Android app (new applicationId) and is still installed on
      phones, still talking to this same server.
    - `Android/app/google-services.json` is untouched: only the Firebase console
      can reissue it. Until a `com.hmelj.app` client is added to the project, the
      google-services plugin fails that flavor's build outright (see the comment
      at the top of `app/build.gradle`). The console procedure is written up in
      `Android/TEMPLATE_README.md` → *Registering the app in the Firebase
      console*, with a pointer from README's *Android app and push
      notifications* — reuse project `hmail-b26b3` rather than making a new one,
      or `DATA_DIR/fcm-service-account.json` stops being able to send.
  `scratchpad/rename-test.mjs` pins all of the above (34 assertions); with the
  shims stripped out it drops to 9 failures.

## File map

```
server/
  index.js       Express app, REST routes, auth routes, sanitizer (HTML + CSS policy)
  session.js     Hmelj users (scrypt), sessions, rate limit, ALS context, runWithAccount
  accounts.js    mail accounts CRUD, AES-256-GCM at rest, testConnection + folder detect
  mailClient.js  protocol dispatch on acc.type: imap | ews | graph (21 proxied names)
  imapClient.js  per-(user,account) pool, folders/list/fetch/flags/move/delete/append,
                 hardDelete (draft replacement), envelope fallback parsing
  ewsClient.js   Exchange SOAP/NTLM; same 21 names; pull subscriptions for Live
  graphClient.js Microsoft Graph REST; same 21 names; $batch, $value raw MIME in/out
  oauth.js       OAuth2 sign-in, DATA_DIR/oauth.json, token refresh+rotation; two
                 providers: microsoft (public client + PKCE -> Graph) and google
                 (confidential client + secret -> XOAUTH2 on ordinary IMAP/SMTP)
  idle.js        Live watchers: IMAP IDLE / EWS pull (~15s) / Graph count poll (~30s)
  smtpClient.js  per-account transport, identity→account resolution, Sent APPEND;
                 branches to ewsClient.sendRaw / graphClient.sendRaw by account type
  filters.js     filter engine (move/copy/redirect/reply/delete/markRead/star)
  store.js       per-user JSON store (settings/identities/contacts/filters), defaults
  threading.js   conversation keys (References root / provider ConversationId); pure
  quoteCollapse.js  marks the quoted half of an HTML reply (server-side; see its header)
  readReceipt.js    RFC 3798 MDN builder + the address parsing; pure
  unsubscribe.js    List-Unsubscribe parsing, and what it refuses; pure
  refile.js         Junk/Archive filing and the ledger that sends a message back; pure
  attachmentCache.js  byte-bounded LRU for extracted attachment parts + the ETag; pure
  config.js      PORT, HOST, DATA_DIR, ALLOW_SIGNUP, HMELJ_PUBLIC_URL,
                 ATTACHMENT_CACHE_MB
public/
  index.html     app shell (sidebar: account list + folders; resizers; dialogs script)
  login.html     sign-in/sign-up, language selector, firstRun welcome
  message.html   standalone reading window; hash = folder/uid/accountId
  sw.js          PWA service worker (VERSION = 'hmelj-20260828002')
  js/app.js      state, accounts sidebar, unified view, withMsgCtx/batchOp, resizers, boot
  js/api.js      fetch wrapper; API.account + _acct() appends ?account=; 401 → login
  js/compose.js  compose window, identity-aware send/drafts, editor, autosave
  js/settings.js Accounts tab + wizard (Test & save), identities (Send via account),
                 folders (per-account hidden), filters, contacts, general
  js/oauth.js    sign-in popup / Android Custom Tab + status polling (never sees a token)
  js/dialog.js   Dialog.prompt/confirm/alert/form + uid()
  js/i18n.js     EN→SL dictionary + observer
  js/messageFrame.js  sandboxed body iframe: srcdoc builder, pinch/pan, in-frame find
  js/messageFind.js   the floating Ctrl+F bar (drives the in-frame find over postMessage)
  js/attachmentViewer.js  full-screen image/PDF/video viewer: progress-reporting fetch,
                          Blob cache reused by Download/Share, OS hand-off on mobile
test/
  mock-mail-server.js   hoodiecrow IMAP :1143 (testuser/testpass) + SMTP :1025
  mock-oauth-server.js  stub /authorize + /token: PKCE verified, refresh tokens rotated,
                        a client_secret is REJECTED (Hmelj is a public client)
  mock-graph-server.js  stub Graph mail API: folders, messages, $value, $batch, sendMail
Dockerfile, docker-compose.yml, .github/workflows/docker.yml (multi-arch → GHCR)
```

## Dev & test workflow

```bash
npm install
printf 'PORT=3000\n' > .env
node test/mock-mail-server.js &        # IMAP 127.0.0.1:1143, SMTP :1025
npm start                              # http://localhost:3000
# sign up any user → wizard: IMAP 127.0.0.1:1143, SMTP 127.0.0.1:1025,
# user testuser / pass testpass, TLS OFF, "allow self-signed" ON
```
- Mock quirks: hoodiecrow only accepts testuser/testpass; add the same account twice
  with different labels to exercise the unified view. Its TLS cert is expired →
  wizard's "allow self-signed" or `tlsRejectUnauthorized:false`.
- Syntax sweep: `for f in server/*.js public/js/*.js; do node --check "$f"; done`
- Frontend smoke tests were done with jsdom (devDependency): note `window.eval` of the
  scripts needs an explicit `window.X = X` suffix since top-level `const` doesn't attach.
- Regenerate icons after editing `public/icons/icon.svg`: `npm i -D sharp && npm run icons`.

## Test status

Everything above is **e2e-tested against the mock** (auth incl. rate limiting & 400/401
paths, wizard test/save/edit-with-blank-password/delete, encryption at rest, unified
inbox/sent merge with chips, identity-routed send + Sent copy, drafts autosave/replace
via hardDelete, PATCH hiddenFolders, filters incl. unified fan-out, CSS/image policy
matrix, sender-trust fix). The **user has additionally verified in a real browser**:
multi-account flow, dialogs, resizing, language selector, image trust flow.
**Not yet tested**: real Gmail/GMX/Outlook servers, real mobile devices, HTTPS/PWA
install in production, concurrent multi-user load.

## Known limitations / gotchas

- Sessions are memory-only → server restart logs everyone out (by design, documented).
- `secret.key` loss ⇒ stored mailbox passwords undecryptable (users re-enter them).
- Unified view paginates in memory (fetches `page × pageSize` per account) — fine for
  family scale, not for huge mailboxes.
- Unified Sent dedupes nothing: same message appears once per account that has it (only
  matters when two attached accounts are actually the same mailbox, as in mock testing).
- Trusting a sender also loads their tracking pixels (inherent to the semantic; same as
  Gmail/Thunderbird).
- Mobile layout is functional (overlay sidebar, stacked panes, resizers hidden) but
  desktop-first; expect density issues, not breakage.
- **Microsoft accounts are a third account type**, `type:'graph'` — OAuth2 sign-in
  (`server/oauth.js`, public client + PKCE, admin-managed client ID only, no secret) and
  then Microsoft Graph for everything else (`server/graphClient.js`). An earlier version
  spent the token on IMAP/SMTP over XOAUTH2 and was abandoned: IMAP must be enabled on
  the mailbox and is off by default on personal Outlook.com accounts, giving a sign-in
  that succeeds followed by `User is authenticated but not connected`. Graph avoids that
  entirely. In Azure the redirect URI must sit under **Mobile and desktop applications**;
  under Web it demands a secret, under SPA it caps refresh tokens at 24h.
  Known Graph-specific gaps: `answered` is always false (it is an extended MAPI property
  only), `size` is 0 (not in the v1.0 message resource), Live is a 30s count poll rather
  than push (real push needs a public webhook), and `listNewMessages` re-reads the newest
  50 rather than using `/messages/delta` — same shape as the EWS client, for the same
  reason (opaque ids make `cache.getMaxUid()` meaningless).
  Legacy `authType:'oauth2'` records are migrated to `type:'graph'` on load and flagged
  `needsReauth` (their old Exchange scopes are useless to Graph).
- **Gmail can sign in instead of using an app password**, and unlike Microsoft it stays
  an ordinary `type:'imap'` account — the token is spent as XOAUTH2 on imap.gmail.com /
  smtp.gmail.com, so nothing about fetching, caching, IDLE or sending changes. The
  account simply carries an `oauth` block where `imap.pass` would be (`accounts.js`:
  `oauthRecordFor`, `updateOAuthTokens`, `stripSecrets`), and `imapClient`/`smtpClient`/
  `idle` swap `pass` for `accessToken` when they see it. App passwords still work; this
  is an alternative, not a replacement.
  Google-specific traps, all surfaced in the UI and in `explainProviderError`:
  its only server-side redirect flow is the **"Web application"** client, which is
  confidential and *requires* the client secret (the opposite of Azure's public client —
  hence `usesSecret` and an encrypted `clientSecret` back in `oauth.json`); the redirect
  URI must be https (or localhost), same as Azure; `https://mail.google.com/` is a
  restricted scope, so an unverified app shows a warning screen users click through
  (no CASA assessment needed to sign in your own accounts — that gates *publishing* to
  the public); and a consent screen left in **Testing** expires refresh tokens every
  7 days, so publishing status must be "In production". Google also never rotates
  refresh tokens and omits them from refresh responses, which the existing
  keep-the-previous-one fallback already covers.
  **Migration is in place, both ways**, and deliberately not "remove and add
  again": `POST /api/oauth/attach` on an existing password account swaps the
  credential and wipes the stored password (`accounts.js#attachOAuthSignIn`),
  while the wizard's "Use an app password instead" sends `oauth: null` to drop the
  block. The account id is what the message cache, analytics index, identities,
  filters, folder settings and share grants are keyed by, so deleting the account
  loses the first two outright and orphans the rest. Attaching is refused unless
  the account already points at that provider's own IMAP host
  (`canAttachToImapHost`), since a Google token authenticates nothing else.
- **Quick, repeated mark-read/unread clicks are explicitly coordinated**, because
  reads and writes of mail state race each other in two independent places.
  *Server*: a flag write takes 1.5-2s on Gmail, and Hmelj's own `\Seen` change wakes
  the account's IDLE watcher (`flags` events carry no author), so a sync could read
  the mailbox between two clicks and write that stale reading back — reverting the
  click in SQLite and stamping the pre-change unread number over an already-adjusted
  counter. Every mutating route now records the write (`sync.js#noteLocalWrite`), and
  the sync paths refuse any write-back whose reading predates it: a flags-only IDLE
  wake inside `SELF_WAKE_WINDOW_MS` is dropped as self-inflicted, `applyFlagsSnapshot`
  and `setFolderCounts` are skipped, and a full scan's re-upsert keeps the cached flags
  (`cache.js#upsertMessages({preserveFlags})`) since it still has to take in new mail.
  *Counts*: the badge reads `folders.unseen` (a delta counter) while the list reads
  `messages.seen`, so the two can disagree; `cache.js#reconcileFolderCounts` makes them
  agree after a flag write, but only where the cache provably covers the whole folder
  (one row per message the server reports, no `\Deleted` rows) — counting rows on a
  bigger folder is the old bug that shrank large badges on every click.
  *Client*: `app.js`'s reconcile scheduling (`pendingMutations` / `trackMutation` /
  `scheduleReconcile`) never reads server state while one of its own writes is in
  flight, discards superseded or pre-click responses via per-function seq guards, and
  coalesces a burst — each click used to cost a list refresh plus two identical
  `/api/unread` calls, since the acting tab receives its own SSE broadcast.
- **A push device belongs to exactly one login.** A Web Push endpoint (and an FCM
  token) identifies a *browser profile at an origin*, not a person — the browser
  hands back the same subscription whoever is signed in. So a second household
  member signing in on a shared browser used to leave that endpoint registered
  under BOTH logins (`app.js#ensurePushRegistered` finds it missing from *their*
  device list, re-subscribes, gets the same endpoint, posts it under their
  login; nothing removed the first user's copy, since `addSubscription` only
  de-duplicated within one user). `sync.js` then delivered both people's
  new-mail notifications — sender, subject and a body preview — to that one
  browser. Registering is now a CLAIM (`push.js#claimSubscription`: the
  endpoint is removed from every other user first, most recent sign-in wins,
  logged as the security event it is), and `reconcileSubscriptionOwners()` runs
  at startup to repair installs already in that state, since a duplicate is
  exactly what stops the page noticing its own endpoint is missing.
- **New-mail notifications carry "Mark as read" and "Delete" buttons**, handled
  where the notification is — no window has to open. `sync.js#notifyNewMail`
  attaches `actions: [{action:'read'},{action:'delete'}]` alongside the
  `data:{accountId, folder, uid}` each button acts on (the "N more" summary gets
  none — it stands for several messages, so there is no uid to act on). Three
  renderers, one vocabulary: `sw.js#notificationclick` POSTs the flag change or
  the delete and then re-reads `/api/unread` to correct the app badge (nothing
  else would, with no window open) and tells any open tab to reconcile; the
  native Android shell builds the same two buttons itself in
  `CodexaFirebaseMessagingService`, since **Firefox and iOS Safari never
  implemented Web Push actions** and a WebView has no service worker at all.
  On Android the tap fires `NotificationActionReceiver` → `MailActionWorker`
  (WorkManager, authenticated with the WebView's own session cookie exactly like
  `PushTokenWorker`) rather than doing the call in the receiver: an action must
  survive being offline or the process dying, and when it finally can't be
  applied it says so with a notification instead of leaving the user believing
  the mail was read. Button titles are localised per RECIPIENT server-side
  (`pushI18n.js` reads the same `public/i18n/<lang>.json` the frontend uses) —
  they're rendered by the OS from the payload, so nothing on the device can
  translate them later, and a shared account's grantee may read Hmelj in another
  language than its owner.
- **A push that arrives late is not replayed as news.** A browser only holds a
  connection to its push service while it is RUNNING, so everything sent while
  it was closed is queued there and handed over in one burst at startup — the
  reported "switched the laptop on and Firefox popped a wall of notifications
  for mail I read on my phone hours ago". Three layers answer it. Web Push now
  goes out with `TTL: config.pushTtlSeconds` (15 min by default,
  `PUSH_TTL_SECONDS`, down from a day) so the push service simply drops what has
  outlived it, and with a `Topic` (`push.js#pushTopic`, hashed to the 32
  url-safe-base64 characters RFC 8030 allows) so whatever it still holds
  collapses to the newest per account — the exact counterpart of the FCM
  `collapseKey` the native path already used. Every payload is stamped with
  `sentAt` plus the server's own `staleAfterMs`, and `sw.js` shows anything
  older as ONE "while you were away" line (fixed `hmelj-away` tag, silent, no
  action buttons — a Delete on hours-old mail is the one action you can't take
  back), re-reading `/api/unread` for the badge rather than trusting a count
  composed before any of it was read. The line itself is localised per
  recipient the same way the action titles are.
- **Settings' device list marks the device you're on** (`app.js#currentPushDeviceId`,
  matched against the endpoint/FCM token of each row) and says so plainly when
  it isn't listed at all. Two laptops running the same browser version produce
  two rows that read identically, and the Notifications checkbox is ONE setting
  for the whole login — so a browser that never registered, or that quietly lost
  its registration (push services expire endpoints, browsers rotate them, the
  server prunes what comes back dead), looked exactly like a working one. For
  Both strings live in the catalogs rather than in the markup: i18n translates
  whole trimmed TEXT NODES (`public/js/i18n.js`'s MutationObserver walker), so
  the marker sits in its own `<span>` — glued onto the date it would have been
  one node no catalog could ever match, and would have stayed English in an
  otherwise Slovenian UI. For
  the same reason `ensurePushRegistered()` no longer runs only at boot:
  `recheckPushRegistration()` re-checks on `visibilitychange`, at most every 6
  hours, since a machine where Hmelj lives in a pinned tab for weeks would
  otherwise never repair itself.
- **Swipe-to-act on a message row** (`app.js#bindSwipe`) tracks the finger all the
  way across the row rather than stopping at a fixed 140px, and commits at
  `COMMIT_FRACTION = 0.3` of the row's own width — the boundary is marked by the
  action background going from dim to solid plus one `navigator.vibrate(12)` as
  it crosses. It was half the row until 2026-08-23: having to haul a row past
  the middle before anything would take read as unresponsive in daily use, and
  30% is still far enough out that a stray horizontal nudge during a scroll
  can't fire it. The Settings hint names the fraction, so moving it means moving
  that string (and its Slovenian translation) too. A
  reversible delete then flies the row off in the direction it was already going
  and the request waits ~180ms for it to get there (`renderList()` rebuilds the
  whole `<ul>`, so deleting immediately would destroy the element mid-animation);
  everything else springs back first.
- **`.msg-list` clips horizontally** (`overflow-x: hidden`). A transformed box
  still contributes to its scroller's scrollable overflow, and `overflow-y: auto`
  makes a sibling `overflow-x: visible` compute to `auto` — so dragging a row
  right gave the list a scrollbar along its bottom edge the instant the gesture
  started. Only right: in LTR, overflow past the left edge is unreachable and
  never scrolls, which is why swiping left to mark read looked clean and swiping
  right to delete did not (reported from a phone, 2026-08-23). Clipping also
  keeps a flung-away row inside the list instead of sliding past the viewport.
  `scratchpad/swipe-overflow-test.mjs` resolves the real cascade over the real
  stylesheet; jsdom has no layout, so it cannot measure `scrollWidth` — what it
  pins is that the rule wins and that nothing (including the mobile `@media`
  block) re-opens the axis.
- **Every row tracks its own finger** (`bindSwipe`'s `touchId`): `e.touches[0]` is
  the first touch on the SCREEN, not the one on that row, so two fingers on two
  rows made both rows mirror the first finger — and both messages were deleted
  when only one had been dragged past the line. Each row now records the
  identifier of the touch that landed on it and ignores every other, so swiping
  two messages away at once is simply two independent swipes. `touchcancel`
  (system edge-swipe, an incoming call) resets the row instead of leaving it
  sitting half-open.
- **A swipe-delete offers an undo instead of a confirmation** — and only where
  the delete really is reversible (`app.js#deleteIsReversible`: not `expunge`
  mode, not from inside Trash), otherwise the confirm dialog stays exactly as it
  was. The mechanism is that a move mints a NEW uid in the destination, so
  `deleteMessages` now answers `{destination, uidMap}` — IMAP from the server's
  COPYUID (`imapClient.js#uidMapOf`), Graph/EWS from the ids their move responses
  return — and `offerUndoDelete` moves that exact message back, clearing `\Seen`
  again afterwards if `markReadOnDelete` had marked it on the way out. `flagged`
  mode undoes by clearing `\Deleted` on the uid the row already had. No `uidMap`
  (a server without UIDPLUS) means no undo is offered at all: an undo that might
  not work is worse than none. Nothing is re-inserted locally on the way back —
  the restored message has a new uid again, so the list is reconciled from the
  server rather than from the dead row object. Deletes in quick succession share
  ONE offer (`undoBatch`, 6s): a toast per row would mean each new one replacing
  the last, so every message but the final one would silently lose its undo —
  instead the offer counts them ("Messages deleted (3)") and one tap restores
  them all, each attempted on its own so one failure doesn't sink the rest.
  `offerUndoDelete` is called OUTSIDE quickDelete's try/catch: a fault while
  offering the undo must not be reported as the delete having failed, which
  would put back a row that is really gone.
- **A toast can carry a named action** — `toast(msg, ms, onTap, actionLabel)`
  renders "UNDO" as its own affordance beside a short message instead of
  underlining the whole sentence, which on a phone (and in a language with
  longer words than English) was three centred underlined lines and unreadable.
  Tappable toasts without a label keep the underline.
- **A folder can be muted temporarily** from its sidebar right-click / long-press
  menu (Mute → 30 min … 24 h, "until tomorrow morning", or a chosen time), which
  stores `account.folderMutes[path] = <epoch ms it ends>` via
  `POST /api/accounts/:id/folder-mute`. Deliberately NOT written as a
  `folderNotificationSchedules` entry: a folder override *replaces* the account
  schedule, so a mute would destroy an existing override and expiry would have to
  restore it. It layers on top instead (`schedule.js#folderMutedUntil`, checked
  ahead of the schedule in `isFolderMutedNow`/`mutedFolderPairsFor` and in
  `sync.js#notifyNewMail`), so when the instant passes the folder simply follows its
  schedule again with nothing to undo — an entry in the past is ignored everywhere
  and pruned on the next write. Same consequences as a scheduled quiet period, not a
  weaker flag: no push, the sidebar 🔕 marker (tooltip names the end time), and its
  unread out of the unified list and the badges unless "Show muted" is on. Owner-only,
  like the schedules it layers over, since gating is evaluated once per folder for the
  owner *and* every grantee. Visible and liftable in Settings → Scheduler too. The
  menu offers Mute only when the folder is actually audible: if its effective schedule
  already has it quiet at that moment, the row becomes a disabled note ("Silenced by
  schedule") rather than an offer to silence something already silent — `openCtxMenu`
  grew a `disabled` item type for exactly this.
- **The message list scrolls back to the top when you navigate**, not when it
  refreshes: the container is reused across loads, so paging while scrolled down used
  to leave the reader parked mid-page in a page they'd never seen (`app.js`'s
  `messageViewKey`/`scrollListToTopOnNavigation` — account, folder, page, query and
  the unread/starred filters form the key; a repaint of the same view never moves the scroll
  out from under someone reading it).
- `deleteBehavior`/`markReadOnDelete` are global settings applied per current account's
  `trashFolder`.
- **A failed filter action aborts the rest of that rule, and the rest of the rules for that
  message.** It used to log a warning and carry on, which was actively dangerous: the actions
  of one rule are a sequence the user meant to happen together, so continuing past a failure
  produces a state they never asked for — worst case a `move` that failed followed by a
  `delete` that succeeded, destroying the message instead of filing it. With the mailbox
  already in an unintended state, letting the next rule act on the same message only compounds
  the guess, so `actionFailed` breaks the outer loop too.
- **`server/userLog.js` is the user's own log (Settings → Log / Dnevnik), distinct from
  `server/log.js`'s stdout.** Different audience: the person whose mail it is, who has no
  terminal. It exists because the failures that matter most are exactly the ones with nothing
  to show them — a filter action swallowed in a `catch` inside the background poller, an
  account unreachable for hours, a `/api/send` that answered `{queued:true}` and only failed
  afterwards, when the response was already gone and `wrap()` could no longer touch `res`.
  Keeps its table in cache.js's SQLite handle (the arrangement analytics.js uses — one
  connection per process). Three things make it usable rather than a firehose:
  **collapsing** (a repeat of the same (account, category, message) within 6h bumps a `count`
  and timestamp instead of inserting, so two hours of a dead host is one row reading ×41, not
  sixty rows), a **500-row cap** per user, and **`record()` never throwing** — it is always
  called from inside somebody else's error path, where a logging failure that masked the
  original error would be worse than no log. Recording sites: `filters.js` (action failed),
  `sync.js` (account sync failed, filter run failed), `index.js`'s backgrounded send, and
  `wrap()` itself, which catches every mutation route's 5xx at once — that last hook is what
  covers marking read/unread, moves and deletes without touching fifty routes. 4xx is
  deliberately excluded: a validation complaint is already on screen as a toast.
- **Filter `redirect`/`reply` fire exactly once per delivered message, guaranteed on disk.**
  `cache.js#claimFilterSend` is an `INSERT OR IGNORE` against a `filter_sends` table keyed
  on `(user, account, Message-ID, filter id)` — the decision and the record are one atomic
  statement, so a manual run racing a poll can't both read "not sent yet". Message-ID, not
  uid: a uid is per-folder and a MOVE mints a new one, so the same delivered mail has several
  over its life. On disk, not in memory, because surviving a restart is the point. This is
  what closes the hole `claimFiled` could not: `/api/filters/run` re-reads the newest 200
  messages and runs every rule over ALL of them regardless of age, so a redirect rule whose
  message was still in INBOX forwarded it again on every manual run — and on every Inbox load
  with `runFiltersOnLoad` on. A failed send calls `releaseFilterSend`, or a transient SMTP
  error would leave the claim standing and the mail would never be forwarded at all.
- **Filter action order no longer changes what happens.** `move`/`delete` end the message's
  business in the folder (its uid stops being valid), so the loop breaks after them —
  which meant a rule written as `[move, redirect]` sent *nothing*. `orderedActions()` now
  sorts those two last; `Array#sort` is stable, so everything else keeps its relative order.
  Note `departed` is tracked separately from the loop's `moved` flag: they differ for
  `delete` under `deleteBehavior:'flag'`, which adds `\\Deleted` and leaves the message right
  where it is — that row must NOT be dropped from the cache, which is why
  `imapClient#deleteMessages` reports which of move/flag/expunge actually happened.
- **A filter's `redirect`/`reply` sends from the matched account's own identity.** It used to
  pass no `identityId`, so smtpClient fell back to the GLOBAL default identity and *that*
  identity's account — a rule matching in account B auto-replied as account A, over A's SMTP.
  `identityIdForCurrentAccount()` mirrors the same "account's default, else any of its own"
  pick accounts.js and compose.js already use, falling back to the old behaviour only when
  the account has no identity at all.
- **`redirect` carries attachments**, capped at 10 files / 15MB per forward (each one is a
  separate `getAttachment` round trip, and most SMTP servers would reject more anyway).
  Inline images keep their `cid` — `smtpClient#sendMail` now passes it through to nodemailer
  — so the forwarded HTML's `cid:` references still resolve instead of rendering broken. The
  composer never sets `cid`, so ordinary sends are unchanged.
- **`imapClient#copyMessages` returns its COPYUID map** the way `moveMessages` always did, so
  a filter's `copy` can be recorded with `noteFiled` and isn't re-filtered when the poller
  finds it in the destination. Graph and EWS return no map for a copy; there the send ledger
  above is the backstop, which is why the ledger — not the uid note — is the actual
  correctness guarantee.
- **A filter that moves a message must have its cache reconciled by the CALLER**, and both
  callers do it (`sync.js#pollFolder` and `/api/filters/run`). `filters.js` does the IMAP work
  but deliberately owns no cache — it can't import `sync.js` without a cycle — so `runFilters`
  returns `{departed, targets}` and the caller drops the rows. Without that step the source
  folder keeps a row for a message that has left it, and since `queryUnified` spans every
  folder, **the unified list shows the message twice** — once from the stale source row, once
  from the real one in the folder it was filed into. Three things conspired to make it
  long-lived rather than momentary: `pollFolder` fetches BEFORE running filters, so that
  tick's `pruneMissing` still sees the message as present; an incremental poll can never
  notice a uid that simply vanished; and `pruneMissing` only runs on a **full** scan (every
  10th tick, ~20 min). Worse, the refresh button cannot clear it either —
  `ON_DEMAND_SYNC_LIMIT` (200) is below the default `syncBackfillLimit` (250), and
  `pruneMissing` is deliberately skipped whenever the scan is narrower than the configured
  depth. Observed: `INBOX` uid 19712 and `INBOX.Nintendo` uid 2162, same message.
  Note `departed` is tracked separately from the loop's `moved` flag: they differ for
  `delete` under `deleteBehavior:'flag'`, which adds `\\Deleted` and leaves the message right
  where it is — that row must NOT be dropped, which is why `imapClient#deleteMessages`
  reports which of move/flag/expunge actually happened.
- **Composer spell checking is SPELLING ONLY — there is no grammar checking.** No a/an, no
  missing article, no agreement, no word order. That was the deliberate trade for running
  in-process (`nspell` + `dictionary-en` + `dictionary-sl`) instead of standing up a
  LanguageTool container. Worth recording for anyone who revisits it: self-hosted
  LanguageTool would not have delivered missing-article detection either — that rule is
  cloud-only — but it would have brought ~6,100 other English rules for a second service
  and ~1 GB of RAM. `/api/proofread`'s contract (`{words, language}` in,
  `{language, bad:{word:[…]}}` out) says nothing about how the checking is done, so a
  grammar backend could answer the same route later with **no client change**.
- **The spell checker never touches the editor's DOM**, and that is the constraint the whole
  design turns on. `compose.js#payload()` serializes `#c-editor.innerHTML` for sending,
  autosaving *and* the pristine-diff, so a `<span>` wrapped round a misspelled word would be
  emailed, written into every draft, and make each autosave tick think the draft had changed.
  Underlines are drawn with the **CSS Custom Highlight API** (`CSS.highlights.set` over live
  `Range` objects) — `getBody()` stays byte-identical to what it returns with the feature
  off. Where `CSS.highlights` is missing, the composer is handed back to the browser's own
  spellchecker (`spellcheck="true"`) rather than half-working; the two are never both on.
- **The proofread API is word-level, not document-level.** The client tokenises (it needs the
  offsets to place Ranges anyway), posts only the DISTINCT words it has no verdict for, and
  caches every answer per language — so after the first pass a keystroke usually asks about
  one word, and the message body never leaves the browser. Two consequences worth knowing:
  verdicts are cached per *language* (`the` is a word in one and a typo in the other) and
  case-sensitively (Hunspell is). Positions are re-measured *after* the round trip
  — the user keeps typing while it is in flight, and the `seq` guard only catches a competing
  check, not a keystroke whose own debounce has not fired yet.
- **Language detection is asked once, then told.** The client sends `language:'auto'` only
  while detection is *unsettled*, and while unsettled it sends the WHOLE distinct word list,
  not the typed delta — the server needs a real sample to score, and full coverage means a
  change of mind never needs a repair round trip. `detect()` returns `{lang, confident}`;
  confident needs ≥8 usable words and a ≥0.12 score margin. Once confident the client sends
  the concrete code, and the server then echoes it back without detecting at all.
  **This shape is load-bearing, not incidental.** The first version sent `'auto'` every time,
  so the server re-detected from whatever two-word delta had just been typed; a delta that
  short always came back `en` (the `< 3 words` fallback), which read as a language change,
  which cleared the cache, which resent the whole document, which detected `sl`, which read
  as a change… an unbounded loop at roughly ten requests a second, and visibly a chip
  flip-flopping EN/SL. Two guards keep it dead: detection is never re-asked once settled, and
  a language change no longer triggers a re-run. The one escape hatch — >60% of a ≥8-word
  document suddenly misspelled, i.e. a draft cleared and rewritten in the other language —
  is capped at 2 uses per compose window, because text that *is* in the detected language but
  full of proper nouns satisfies the same trigger and would otherwise re-fire forever.
  Measured after the fix: typing a full Slovenian sentence costs 21 requests / 63 words
  total; switching the whole document to English costs 2 extra; idle checks cost none.
- **Dictionary cost, measured**: English ~140 ms to index and ~18 MB resident; Slovenian
  ~1.6 s and ~130 MB. Both are why nothing loads at boot, and why a loaded dictionary is then
  kept for the life of the process rather than idle-unloaded — `nspell()`'s indexing pass is
  synchronous, so every reload would freeze the whole server (IMAP polling included) for that
  second and a half. The composer pings `/api/proofread` with `{warm:true}` the moment it
  opens so that cost lands while the user is still filling in recipients.
- `dictionary-sl` is `(GPL-3.0 OR LGPL-2.1)` — the strongest-copyleft dependency in the tree.
  It is the Amebis/Lugos `sl_SI` dictionary that LibreOffice and Firefox also use, consumed
  unmodified as data under the LGPL option, so it does not reach Hmelj's own licensing.
- Not spell-checked: the subject line and plain-text mode (both are form controls, and the
  Highlight API cannot reach inside one) and the Settings signature editor.
- **The toolbar's ★ "starred only" filter is the one filter that also WIDENS scope**,
  and it is answered from the cache, never live. All-inbox → every account and every
  folder that view already spans; an account's INBOX → INBOX *and everything nested
  under it*; any subfolder → that folder and its own descendants (`flagged=1` on
  `/api/messages/:folder`, which passes `subtreeDelimiter` — the account's real
  hierarchy separator, read from the folders table, not assumed — into
  `cache.queryFolder`). A live listing is one mailbox at a time and so cannot answer
  the subtree question at all, which is why the cache branch deliberately does *not*
  fall through to IMAP while the filter is on: reporting only what the cache holds
  beats silently narrowing the scope the user asked for. Consequences: a starred
  message older than `syncBackfillLimit` in its folder is not listed, and rows now
  span folders in a single-account view — which is why `queryFolder` returns `folder`
  on every row and `batchOpInner` groups by (account, folder) in *every* view rather
  than short-circuiting to `state.currentFolder`. Per-tab state (`state.starredOnly`),
  not a stored setting: nothing computed server-side (badges, push) depends on it.
  Uid collisions across a subtree are possible in select mode — the same pre-existing
  exposure the unified view has, since uids are not namespaced per folder.
- **`is:starred` in the search box is the deep counterpart to the ★ button**: same
  question, answered LIVE from every mailbox instead of from the cache, so it finds
  stars on mail far older than `syncBackfillLimit`. `searchQuery.js#extractStarredTerm`
  splits the term off the raw query *before* `parseSearchQuery` runs, so the IMAP/EWS/
  Graph criteria builders and cache.js's SQL builder never learn it exists and anything
  typed alongside it (`is:starred invoice`) still applies normally. `index.js#starredLive`
  then fans out — accounts in parallel, folders sequentially within an account (one
  shared connection each) — with `flaggedOnly: true`, and merges by date. Scope: All
  inbox → every folder of every account; an account's INBOX → the *whole* account (not
  just the INBOX tree — old starred mail is usually in siblings of INBOX, and on Gmail
  only the `\Flagged` virtual folder has it at all); a subfolder → that subtree. Trash
  and Junk are the only exclusions — Archive and Drafts are dropped from sync/badge
  scope for reasons that don't apply to a search. Where the server reports a `\Flagged`
  virtual folder (Gmail's "Starred") that single folder *is* the answer for the whole
  account, so the sweep collapses to one SELECT. Cost scales with folder count, which
  is why `reconcileMessages` (app.js) refuses to run it on background events — a star
  toggled in the results would otherwise re-sweep the mailbox. Only the unnegated form
  is recognized; `-is:starred` stays literal text rather than silently widening scope.

## Roadmap (from README)

Web Push for new mail (IMAP IDLE + VAPID) · "Remember me" with encrypted session
persistence · incremental Graph sync via `/messages/delta` · Live CardDAV contact
sync · conversation threading · mobile polish.

## Deployment

**`DATA_DIR` is not `./data` on the live box** — it is set in `.env`, and the `./data`
folder in the repo is a stale leftover. Read `.env`
before inspecting any real state; the two disagree completely on accounts, contacts
and filters.

`.env`: `PORT`, `HOST`, `DATA_DIR`, `ALLOW_SIGNUP`, `HMELJ_SECRET` (no mail servers!),
`HMELJ_PUBLIC_URL` (only needed behind a proxy, for the OAuth redirect URI).
Docker: non-root node:20-alpine image, `/data` volume, `/healthz` healthcheck;
GitHub Actions builds multi-arch to GHCR on push. **Run behind a TLS reverse proxy**
(passwords in transit; PWA install requires HTTPS). Back up `DATA_DIR` including
`secret.key` and `auth.json`.
