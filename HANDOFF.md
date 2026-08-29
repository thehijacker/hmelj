# Handoff — 2026-08-26

Everything below is **written, syntax-clean, tested and documented in `summary.md`**.
Nothing is half-built. What is left is verification that only a real instance can do.

To resume in a fresh session: read this file, then start at *Needs verification*.
Do not re-audit or rebuild the shipped work.

## Before anything else

```
restart the server, then hard-refresh the browser   # service worker: hmelj-20260826014
```

The maintainer's live instance serves real mail from this folder on its own port, with a
`DATA_DIR` set in `.env` (not `./data`, which is a stale leftover). Never restart it without being asked, never write
to its data directories, and test on a spare port with a temp `DATA_DIR` instead — an
explicit env var does beat `.env`, verified.

## Shipped

| # | Feature | Notes |
|---|---|---|
| 1 | **Shared-account privilege fix** | Per-user config keyed on `viewerKey`, not the ownership-swapped `userKey`. Closed a real escalation: a grantee could overwrite the owner's filters — which run server-side across every account the owner has and can forward anywhere. |
| 2 | **Signature above the quote** | Reply and forward. `.compose-body` / `.quoted-block` wrappers. |
| 3 | **Default compose font** | Settings › Compose. Also fixed the font leaking between compose windows. |
| 4 | **Replied-to / forwarded markers** | IMAP `\Answered` + `$Forwarded`; EWS `PidTagLastVerbExecuted`. Graph deliberately not wired. |
| 5 | **Scheduled sending, Phases 1 + 2** | Queue in `DATA_DIR`, own ticker, retry with backoff, reschedule, Scheduled view. |
| 6 | **Scheduled view polish** (2026-08-26) | Send time in the `.m-date` cell, account badge, click-to-read in the reading pane (`GET /api/scheduled/:id`), actions moved to right-click / long-press. |
| 7 | **Self-maintaining address book** (2026-08-26) | Sending adds recipients the USER typed (a reply's prefilled ones ride along as `payload.prefilledRecipients` and are subtracted); receiving only ever fills in a missing name, never adds. Delete a contact from compose's autocomplete (Del twice / long-press). Your own identity+account addresses autocomplete, badged *you*, but are never stored as contacts. Both halves opt-out in Settings › Contacts. |
| 8 | **Save as EML** (2026-08-26) | View headers → next to Copy raw headers. `GET /api/message/:folder/:uid/eml`, raw source, filename from the subject. |
| 9 | **Find in message** (2026-08-26) | Ctrl/Cmd+F over an open message, or ⋯ › Search in message. Live count, ↑/↓ (Enter / Shift+Enter), scrolls each hit clear of the floating bar. The search runs INSIDE the sandboxed frame (no `allow-same-origin`, deliberately) and highlights with the CSS Custom Highlight API — no DOM mutation of the message. |
| 10 | **Conversation view** (2026-08-26) | Off by default (Settings › General). Opens in ONE paint on the newest message (its body is fetched before the pane is touched) and pins it to the top of the pane while the stack settles. Message headers collapse to a two-line summary — the position is remembered (`messageHeaderCollapsed`), and inside a conversation every message above the newest always starts collapsed. Optional "Expand every message in a conversation". Thread key = the References root, computed once per message on the way into the cache (`server/threading.js`, `messages.thread_id`); Exchange/Graph use their own ConversationId. A row is one conversation with a count chip; opening it stacks the thread, newest last and scrolled to, older messages collapsed to a clickable line. Scope: the listed folder **+ Sent**; actions never touch the Sent members. Cache-only, and never while a search/unread/starred filter is on. |
| 11 | **Stale-folder prune** (2026-08-26) | Cached rows for folders the server no longer lists are swept on every sync (`cache.pruneMissingFolders`), from the FULL listing so hidden folders survive. Fixes the `Inbox`/`INBOX` duplicate rows found below. |
| 12 | **Collapsed quotes** (2026-08-26) | A reply shows what was written this time; the quoted conversation under it is behind a ⋯ button. **Detection runs on the SERVER** (`server/quoteCollapse.js`, called from the message route after sanitizing) — it started in the message frame, was verified against 377 real messages, and still did nothing in a browser twice with no way to see why, so it moved somewhere testable. The frame keeps only the click handler; plain text still splits in `buildDoc`. Hidden with an inline `display:none!important` a message's own stylesheet cannot outrank. Verified end-to-end over the live cache: 37/377 messages collapse, 36 of 47 replies (77%), 0 errors, 0 text lost, ~8ms each. |
| 16 | **One-click unsubscribe** (2026-08-26) | Newsletters that publish `List-Unsubscribe` get a button under the header, next to where the read-receipt banner sits. Three ways out, preferred in this order (as Gmail does): RFC 8058 one-click POST (sent by the server — a browser can't POST cross-origin), a `mailto:` unsubscribe message, or opening the sender's page (opened by the BROWSER, inside the click, so no pop-up blocker eats it). Which one applies is decided from the message's own headers server-side, never from the request. On/off in Settings › Reading, default on. `server/unsubscribe.js` + `test/unsubscribe-test.mjs`. **Falls back to the link in the footer** when a sender publishes no header at all — which is most of them: of 291 cached HTML messages on the live instance, 1 had the header and 105 had a findable link. A body link is a guess, so it is only ever OPENED (never posted to, never mailed), the banner says where it came from, and links inside a collapsed quote are ignored. **2026-08-27:** the banner is a size smaller than the others and, by default (`Compact unsubscribe banner`, Settings › Reading), folded to just the 📭 icon and the button — clicking the icon unfolds the explanation for that message. |
| 17 | **Spam and Archive** (2026-08-27) | Right-click / long-press a row, or ⋯ in the reading pane: **Mark as spam** / **Move to Archive**, and from inside those folders the same entries read **Not spam** / **Move out of Archive**. Neither appears unless the account really HAS that folder — answered server-side (`index.js#refileFolderFor`, from the cached folder list) and shipped on `/api/accounts` as `hasJunk`/`hasArchive`, because the unified "All inboxes" view holds no folder list and so offered both on every account's mail. The same resolver decides where the route moves mail, so the menu can never offer something that then fails, and it stands in the server's own `\Junk`/`\Archive` folder when the stored name is stale (live instance: one account pointed at "Junk" where the server's is "Spam"). Also: `(None)` in Settings › Folders genuinely means none now (`saveAccount` used to re-invent 'Junk'/'Archive' on the next edit), and auto-detect on a new account only picks a folder that exists. One route, `POST /api/messages/:folder/refile` with `{uids, box, revert}`: the destination is always the ACCOUNT's own setting, never a folder named by the request. Going out, where each message came from is written down (`server/refile.js` + `users/<key>/refile-origins.json`, pruned by age and capped); coming back, that decides the destination — one move per remembered folder, INBOX for anything unrecorded, which is the common case since most spam was filed by the server and was never anywhere else. Optimistic like delete, with an Undo that runs the same route the other way. `test/refile-test.mjs`. |
| 18 | **Mobile landscape, scrollable menus, keep-screen-on** (2026-08-27) | Four phone fixes. **(a) Safe areas beyond the top:** `--sal`/`--sar` now pad `.main` (and the fixed sidebar, sheet backdrop, find bar and FAB), `--sab` pads the scroll containers (`.msg-list`, `.reading-pane`, `.sidebar-footer`) — in landscape the cutout moves to one side and the nav bar to the other, and only `--sat` was ever honoured. In the **APK** the page sees 0 insets (the shell shrinks its own WebView), so the same bug was fixed again in `MainActivity.setupNativeSafeAreaPadding`: it took only `navigationBars().bottom`, and in landscape the 3-button bar is on a SIDE — now all four sides, `maxOf` per side against the cutout. **(b)** `.ctx-menu` scrolls (`max-height` over the safe area) and `openCtxMenu` clamps into the insets — a menu taller than the screen used to get a NEGATIVE top, putting its first items out of reach. **(c)** `.bottom-sheet` (the user menu) likewise. **(d) Keep the screen on** — Settings › General, device-local, default on (what the APK always did unconditionally). Native shells get `AndroidApp.setKeepScreenOn`; everything else uses the Screen Wake Lock API, re-taken on `visibilitychange` and only on touch devices. **The APK must be rebuilt for (a) and (d) to take effect there.** |
| 19 | **Addresses are actionable; unified threads open whole** (2026-08-27) | **(a)** Every person in a message header (From, To, Cc) is a chip carrying name AND address — the To line used to print `name || address`, so a recipient with a display name showed as "NOC Services" and its address appeared nowhere, while Cc on the same header showed the bare address. Right-click / long-press for **Copy address** and **New message** (opens the composer with them filled in). **(b)** A conversation opened from **All inboxes** showed one message under a chip saying 2. The unified list spans every folder of an account except Sent/Trash/Junk/Drafts, so its COUNT does — but the stack was still asked for `[the row's folder, Sent]`, and on the live instance the conversation's earlier half had been filed into a filed subfolder. `/api/thread?scope=unified` → `cache.unifiedScopeFolders`, the same set the listing spans, plus Sent. Verified against the live cache (1 → 2 messages) and pinned by 7 new assertions. |
| 20 | **List selection** (2026-08-27) | The message list is `user-select: none` — nothing in it is text you read, and dragging the mouse across it used to select subjects instead of doing nothing. That gesture's space now belongs to **Ctrl+click** (Cmd on a Mac, where Ctrl+click is the right-click gesture), which turns select mode on and ticks the row you started from; once in select mode an ordinary click keeps toggling as before. Desktop only — a touch screen has no modifier key and long-press already means something on these rows. The reading pane's header and body stay fully selectable; only the address chips don't, and those have their own Copy. |
| 21 | **Unsubscribe: say what happened, and remember it** (2026-08-27) | The banner said "Unsubscribe request sent (host)" for all three kinds, which answered none of *sent how, to whom, did it work*. Now: **post** → "Unsubscribed — one-click request accepted by <host> (HTTP 200)" (a non-2xx was already an error, so the status IS the confirmation); **mail** → names the address it went to and the identity it went from; **open** → never claims you unsubscribed, only that a page was opened. All three are recorded under the SENDER's address (`users/<key>/unsubscribed.json`), and the message route ships it back as `msg.unsubscribed`, so every message from that newsletter shows "Unsubscribed 27.08.2026 — …" with the button reworded to *Unsubscribe again* — pressing it, opening another message and coming back used to show the offer as if nothing had happened. |
| 22 | **Links open outside the app** (2026-08-27) | `MessageFrame.openLink` — used for message bodies and the unsubscribe 'open' path. **In the APK this was a real bug**: that WebView never enables `setSupportMultipleWindows`, so `window.open()` is silently inert and links in a message body did nothing at all. It now goes through a new `AndroidApp.openLink` bridge method (http/https, `ACTION_VIEW` → the system default browser; the Custom Tab stays for OAuth, which has to come back). Older APKs fall back to `openExternal` (https only). PWA/browser use `window.open('_blank')`, which leaves the app's own window. **A page cannot hand a URL to a different browser** — Hmelj open in Firefox opens links in Firefox; only a native shell can choose. |
| 23 | **Notification previews are plain text now** (2026-08-27) | `server/notifyText.js` + `test/notify-text-test.mjs`. The old preview was `msg.text || sanitizeHtml(html, {allowedTags: []})`, which assumes a text/plain part is plain text — often false. Measured over 793 real cached messages: **36 previews were raw HTML** (`<tr> <td valign="top"…`), **113 carried `[bracket]` markers**, 13 were undecoded quoted-printable (`=C5=A0e ne poznate`), 45 were padded with invisible characters, 5 had `&amp;`, 3 showed Outlook conditional-comment scaffolding. **After: 0 of each**, none newly empty, 0.33ms per message. The text part is now a *candidate*: cleaned, and if it still looks like markup the HTML is used instead. Also fixed a real ReDoS on the way — the first CSS-detection regex had nested unbounded quantifiers and cost 7 SECONDS across those 793 messages; every quantifier is bounded now and the input capped. |
| 24 | **Undecoded quoted-printable** (2026-08-27) | `server/transferEncoding.js` + `test/transfer-encoding-test.mjs`. A sender that writes quoted-printable into a part it labelled 7bit leaves mailparser nothing to decode, and the text arrives as literal `=C5=A0e ne poznate`. **The reading pane was never affected** — 14 of 2256 cached messages have this, all 14 have a clean HTML part, and every consumer prefers HTML. It reached notification previews, and would reach a reply's quoted text or the pane itself the moment such a message arrived without HTML. Repaired at parse time (`messageParse.js`) and again in `contentCache.normalize` so the 14 already cached come right on the next read without bumping CONTENT_VERSION (which would re-fetch all 2256 to fix 14). **The detector is the whole story**: a first version — three `=XX` tokens or a soft line break — fired on 54 texts and CORRUPTED 20 (`pid=517`→`pidQ7`, `git_sha=2940f9…`→`git_sha)40f9…`, a bank URL's `=24`→`$`). The rule that works is the encoding's defining property: a QP body is 7-bit ASCII, so text already containing an accent was already decoded. Final: fires on exactly 14, repairs 14, zero false positives, zero missed. |
| 25 | **Meeting invitations** (2026-08-27) | **The bug first:** every EWS read said `Items.Message`, and Exchange returns an invitation as `<t:MeetingRequest>` — a different element. The folder's UnreadCount counts it, so the badge said 1 unread and the list was empty; a meeting request was invisible in Hmelj altogether. `itemsOf()` now takes every message-like element (Message / MeetingRequest / MeetingMessage / MeetingResponse / MeetingCancellation / Item), and the listing re-sorts by date since grouping by element name loses document order. **Reading:** `server/icalendar.js` parses the `text/calendar` part in `messageParse`, so one implementation serves all three protocols. The reading pane shows When / Where / Organizer / Attendees above the body. **Answering:** Accept / Maybe / Decline; each opens the same three choices Outlook gives — *Send the response now*, *Edit the response first*, *Do not send a response*. The third needed a correction: EWS **can** do it, as the same CreateItem with `MessageDisposition="SaveOnly"` instead of `SendAndSaveCopy` (the mapping the EWS Managed API's own `Accept(sendResponse)` uses) — the first version claimed it couldn't and mailed the organizer every time. `POST /api/message/:folder/:uid/invitation`; EWS uses CreateItem AcceptItem/TentativelyAcceptItem/DeclineItem, Graph uses `/accept` etc. Each backend does the calendar write AND the organizer's reply itself, which is why this works with no calendar of our own. **Times never guessed:** Exchange writes Windows zone names; the common ones are mapped to IANA, and anything unresolved is shown as the wall clock the sender wrote with its zone named rather than converted. **IMAP accounts show the invitation but cannot answer it** (that needs an iTIP METHOD:REPLY composer) — the route says so. CONTENT_VERSION → 2, so cached messages re-parse once on next open. **Follow-up (same day):** answering CONSUMES the invitation — Exchange and Graph both file the handled request into Deleted Items by default — so the row had to go too. The backend now asks whether the item still exists (one IdOnly GetItem / a `$select=id` GET) and reports `consumed`; the route removes the cached row, and the client takes it off the list. A re-sync alone could not fix it: the incremental pass adds what is new, it never notices what has gone. **And generally:** a message that has vanished server-side now answers **410** with a plain sentence instead of surfacing `ErrorItemNotFound — The specified object was not found in the store`; both backends mark a not-found error as `notFound`, the route drops the stale row, and the client removes it from the list. |
| 26 | **A conversation row learns its real count when opened** (2026-08-27) | The chip is painted once and repainted only by a reconcile; the stack is fetched at the moment of the click. A conversation that grew in between showed the old number — reported as "the list says 2, the pane shows 4", with both right when computed. `correctThreadCount` updates the row from what opening it actually found. Only the count: `threadUids` still means the messages in the folder being listed, which is all an action on the row may touch. **Note the scope difference this is NOT**: in a single-account folder view a conversation is counted over `[that folder, Sent]`, so one spanning a filed folder legitimately reads lower there than in All inboxes (verified on the live cache: the same thread is 2/2 in a second account's INBOX and 4/4 in All inboxes). |
| 28 | **Attachments: progress, and not fetching them twice** (2026-08-28) | Clicking an image or PDF put up a black, empty overlay and left it there for several seconds. Two separate problems, both fixed. **The wait was invisible:** the viewer now fetches the bytes itself (`fetchWithProgress`) instead of handing the URL to `<img src>`, so it shows a spinner, a determinate bar and a `1.2 MB / 3.4 MB` counter from the first frame, and Esc / clicking away actually aborts the transfer. Video is deliberately exempt — it plays from the live URL so it can start before it has finished arriving. **The wait was repeated:** the bytes are immutable for a given (account, folder, uid, part), so the routes now send a strong `ETag` + `Cache-Control: private, max-age=86400, immutable` (verified: Express leaves our ETag alone and answers a conditional request 304 with no body), backed by a bounded in-memory LRU (`server/attachmentCache.js`, `ATTACHMENT_CACHE_MB`, default 32, RAM only — never SQLite, per that cache's own rule). This matters more than it looks: `imap.getAttachment` pulls the message's ENTIRE raw source (base64, ~1.33x) and runs mailparser over all of it to cut out one part — three attachments meant three of those, and an HTML body with six inline images meant **twelve**, because the `cid` route parsed once to find the part and once to extract it, and re-did it every time the reading pane rebuilt its frame (a theme change is enough). The viewer also keeps a 64 MB Blob cache so re-opening is instant and **Download and Share reuse the bytes already on screen** — Download asks for `?download=1`, a different URL, so the HTTP cache never helped it. |
| 30 | **A dead pooled IMAP connection cost 30s per click** (2026-08-28) | Reported as "it takes a long time to open messages" on a Gmail account, with four opens at **29.5s / 34.1s / 35.7s / 29.7s**. Not the attachment work — the live cache settles that: all four were content-cache MISSES (`cached_at` equals the instant each request finished), so each was a real Gmail fetch. The number that gives it away is 29.5s ≈ `SOCKET_TIMEOUT_MS` (30s). The pool's keepalive did `c.noop().catch((e) => ilog.debug(...))` — **it swallowed the one signal it exists to produce**. A dead connection stayed in the pool until somebody's click took the mailbox lock on it and waited out the full 30s inactivity timeout before `withMailbox`'s read-only retry rescued it. Worse, a NOOP that HUNG rather than failed left `currentRequest` set forever, and the sweep skips a connection with a request in flight — so that connection could never be keepalived again. Now: a failed *or* unanswered (10s deadline) NOOP drops the connection from the pool and closes it, so the next request dials fresh instead of discovering the corpse. **The other three opens were never slow** — 2–5s of real work each, queued behind the first on the account's one shared connection (deliberately one; see the pool comment on Gmail throttling concurrent sessions harder than sequential ones). |
| 29 | **Attachment links that carried no account** (2026-08-28) | Reported as `HTTP 400` on a JPG right after row 28 shipped — and it turned out to be the *original* bug, not a new one. `msg.__account` is `entry.account?.id`, which only exists in the unified view; every fetch survived that because `API._acct` falls back to the ambient account, but the attachment chip's href was **assembled by hand** at three call sites and had no such fallback. Opening a **conversation** inside a single account (`openThread`, both paths) and the `message.html` popout (which passed no account at all) therefore produced `/attachment/1` with no `?account=`, which the server correctly refuses: *"No mail account selected"*. Before row 28 the viewer set `img.src` and a refused request drew nothing — **the black empty preview the whole attachment task started from was partly this, not latency**; making the viewer fetch is what turned it into a legible error. Fixed at the class level: `API.attachmentUrl()` so every chip goes through `_acct` like every other call, plus `accountOf(entry)` giving the two `openThread` paths the fallback `showSingleMessage` already had. The viewer now also shows the server's own `{error}` sentence instead of a bare status. The `cid:` route was never affected — those URLs are rewritten server-side from the request's own account. |
| 27 | **One conversation scope** (2026-08-27) | `cache.conversationFolders` — every folder of the account except Trash/Junk/Drafts and the sidebar-hidden ones, plus Sent. Used by the count AND the stack, in every view. This replaces three separate ad-hoc scopes that disagreed with each other three times in a day: the stack scoped to `[folder, Sent]` vs a unified count over everything; the same thread reading 2 in a second account's Inbox and 4 in All inboxes; and the count dropping to 2 when the folder was **muted** and muted folders were hidden. **Mutes are ignored** now — muting silences alerts, it does not remove messages from a conversation. The LISTING is still filtered (Inbox + Sent only, hidden/muted folders contribute no rows); only the count widened, via `pageThreads`' new `convoWhere`. `threadUids` and `threadUnseen` deliberately stayed on the listed folder, so actions and the unread mark still mean what they did. Verified on the live cache: the thread in question now reads 4 in every view. |
| 15 | **Version-stamped assets** (2026-08-26) | The three HTML entry points are served with `?v=<newest js/css mtime>` on every local script/stylesheet URL (`server/index.js`, above `express.static`). No build step means no content-hashed filenames, so every deploy relied on the browser revalidating — and "mostly revalidates" produced the worst failure mode: a page running a MIXTURE of old and new files. That is what made the quote collapser look broken (its messageFrame.js was stale while app.js from the same deploy was live). A changed file now changes the URL. The SW's offline fallback matches with `ignoreSearch: true` so versioned URLs still resolve to the pre-cached copies. |
| 14 | **Read receipts, sending** (2026-08-26) | The banner used to render mailparser's address OBJECT as "[object Object]" and did nothing. Now it names the address and carries a **Send receipt** button: `POST /api/message/:folder/:uid/receipt` builds a real RFC 3798 multipart/report (`server/readReceipt.js`, hand-written — MailComposer has no notion of that structure) and sends it from the receiving account. Never automatic, never silent. Marks `$MDNSent` best-effort so other clients don't offer it again. |
| 13 | **Search everywhere** (2026-08-26) | The list's search footer now says what was actually searched (the cache: recent mail, subject/sender only) and offers the rest: `?scope=account` sweeps every folder of the account live, header AND body, preferring Gmail's All Mail where it exists. Reuses the `is:starred` sweep, generalized to `sweepLive`. |

## Public release preparation — 2026-08-29

The repository is now shaped for its first public push to
`https://github.com/thehijacker/hmelj.git`. Nothing in `server/` changed except one stale
UI string; the rest is licensing, packaging, CI, the Android rebrand and documentation.

| Area | What changed |
|---|---|
| **License** | AGPL-3.0. `LICENSE` holds the verbatim FSF text (downloaded, not reconstructed); `package.json` says `AGPL-3.0-only`, version `1.0.0`, with author/repository/homepage/bugs/engines. |
| **`npm test`** | Was `exit 1`. Now `node scripts/run-tests.mjs`, which runs each `test/*-test.mjs` in its own process. 19/19 green. |
| **`package-lock.json`** | Was **out of sync**: `packages[""]` was missing `dom-serializer`, `domutils` and `htmlparser2`, so `npm ci` would have failed. Regenerated with `npm install --package-lock-only` (node_modules untouched — the live instance runs from this folder). `npm ci --dry-run` now passes, which is what let the Dockerfile move off `npm install`. |
| **`.gitignore`** | `test/` un-ignored (the suites should be public). `Android/app/google-services.json` and `Android/.kotlin/` newly ignored. Verified by simulation: 195 files would be tracked, and no `.env`, `data/`, keystore, `local.properties` or `google-services.json` among them. |
| **Dockerfile** | `npm ci --omit=dev`, OCI labels. `--openssl-legacy-provider` and its comment kept — that is a real NTLM/EWS constraint. |
| **CI** | `docker.yml` rewritten: a test job gates the build, auth is the built-in `GITHUB_TOKEN` (no secret to create), amd64+arm64, `:dev` on main and `:latest`/`:X.Y.Z`/`:X.Y` on a tag. Both Android workflows renamed to `hmelj-*` artifacts and given a step that writes `google-services.json` from a `GOOGLE_SERVICES_JSON` secret. The DEV-vs-Play keystore separation and the comment explaining it are preserved verbatim. |
| **Android rebrand** | `com.codexa.reader` → `com.hmelj.app` (package, directory, namespace, `Theme.Hmelj`, `rootProject.name`, `HmeljApplication`, `HmeljFirebaseMessagingService`). The `codexa` product flavor and the whole flavor dimension are gone — `applicationId`/version/`resValue` moved to `defaultConfig`, which is what makes the copied CI output paths correct. **`proguard-rules.pro` still named the old package**; with `minifyEnabled true` that would have stripped the JS bridge and `PushTokenWorker` in release builds only. Fixed, and `MailActionWorker` added. |
| **Deliberately NOT renamed** | The JS bridge names (`AndroidCodexa`, `window.CodexaPush`, `window.__codexa*`) — a wire contract with a web app that updates independently of the APK — and the `codexa_prefs` / `codexa_mail_v2` / `codexa_unread_badge` persistence keys. Each now carries a comment saying why. |
| **`TEMPLATE_README.md`** | Replaced by `Android/README.md`. It named the real Firebase project id and documented a template this no longer is; its Firebase console walkthrough moved into the docs site, generalised. |
| **Docs** | `docs/` is a GitHub Pages site reusing Codexa's engine (`docs.css`/`docs.js`, with `hmelj-docs-*` storage keys and the Codeberg branch removed): 29 sections, in-page search, per-section TOC, pager, lightbox. Plus `docs/privacy.html`, a rewritten `README.md`, and `CHANGELOG.md`. `docs/.nojekyll` so Pages serves it verbatim. |
| **Screenshots** | 22 blank placeholder PNGs at the exact paths the README and docs reference, written by `scripts/gen-placeholder.mjs` (zlib + CRC32, no dependency). `docs/screenshots/README.md` says what each should show. |
| **One app-code fix** | The account wizard told users *"Sending, moving, deleting and searching Exchange mail … are still being built — this account will show up read-only for now."* `ewsClient.js` has had `sendRaw`, `moveMessages`, `copyMessages`, `deleteMessages`, `setFlags`, query support in `listMessages` and `respondToMeeting` for some time, so that string was false. Replaced in `settings.js` + `en.json` + `sl.json` (the Slovenian is mine and worth a native check). |
| **`.env.example`** | Gained `HMELJ_PUBLIC_URL`, `MS_OAUTH_CLIENT_ID`/`MS_OAUTH_TENANT` and `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` — all read by `config.js`/`oauth.js` and all previously undocumented. |

**Real data scrubbed from `test/` (2026-08-29, after the first commit was made).** The
fixtures had been built from real mail and still carried it — 21 occurrences across 7 files:
the owner's own domain, four real colleagues by name and work address (one of them the
owner), a fifth person in a `notify-text` fixture, a real company newsletter captured
verbatim including its unsubscribe header, and a real bank's URL. Deliberately not repeated
here, for the same reason they were removed. All replaced with `example` /
`acme.example` equivalents that preserve whatever each test actually asserts on — the Slovenian words the
unsubscribe and notify-text suites detect (`odjava`, `Akcija`) are untouched, and the
Outlook GlobalObjectId prefix in the iCalendar fixture is kept because it is a
protocol constant, not theirs. 19/19 still green. Also scrubbed:
`scripts/restore-sent-labels.mjs` (the usage example held two of the user's real addresses)
and two comment examples in `server/notifyText.js`. The T-2 entry in `server/presets.js`
stays — that is a shipped ISP preset, not personal data.

`test/` is published rather than ignored because `npm test` gates the Docker workflow and
`npm run mock` is documented in both the README and the docs site.

**Workflow base64 tolerance.** The existing `Android/keystore/keystore_b64.txt` is Windows
`certutil -encode` output, wrapped in `-----BEGIN/END CERTIFICATE-----` lines. Only the
DEV-keystore step stripped those; the Play-keystore and `GOOGLE_SERVICES_JSON` steps did
not. All three now run `grep -v '^-' | tr -d '\r\n ' | base64 -d`, so a secret pasted from
`base64 -w0`, `base64 -i` or `certutil` works everywhere.

**`filter-e2e-harness.mjs` startup budget.** The two suites that spawn a real server
(`filter-selfmove`, `filter-forward-once`) waited 20s for `/healthz` and then reported
"Hmelj did not come up" with an EMPTY server log — which reads exactly like a crash and is
nothing of the kind. The server was in `State: D`, uninterruptible disk sleep, still
importing `node_modules` one file at a time off the USB disk. Budget is now 120s
(`HMELJ_TEST_STARTUP_MS` to override), the loop breaks early if the child actually exits,
and the message distinguishes "exited with code N" from "still starting after Ns". Verified:
both suites pass, 19/19 green.

Worth knowing: `/dev/sdb1` (this repo's disk) was measuring **280-510 ms average read
latency** with I/O pressure at `some avg300=61%`. `dmesg` showed no resets or I/O errors, so
it reads as a slow/contended USB disk rather than failing hardware — but any single heavy
walk of `node_modules` will stall unrelated work on this box for minutes, including the live
instance.

**The signing alias is `codexa-release`.** `Android/keystore/release.jks` (PKCS12, one
entry) is what has signed the local release builds, and Android only allows an in-place
update from the same certificate — so `DEV_KEY_ALIAS` must be `codexa-release`, not the
`hmelj-release` a fresh keystore would use. The docs' "Android signing keys" section now
leads with that as a warning instead of assuming a new project.

Not done, on purpose: no `docker build` and no `gradlew` were run (GitHub builds the images;
the APK is built in Android Studio). `exchange.md` was left in place rather than deleted — it
is real EWS protocol documentation, and deleting it while keeping `summary.md` and this file
would have been inconsistent.

## Docker hardening, Node 24, i18n — 2026-08-29 (after the first public push)

| Area | What changed |
|---|---|
| **Bind-mounted `/data`** | Reported: the container died with `SQLITE_CANTOPEN` against a bind mount. Cause: the image ran as `USER node` (uid 1000) while the host directory was root-owned; the Dockerfile's `chown /data` applies to the IMAGE's `/data`, which a bind mount replaces wholesale. A named volume never hits this because Docker seeds it from the image. Fixed properly: `docker-entrypoint.sh` starts as root **only** to `chown` `$DATA_DIR` (and only when it is actually wrong — no recursive chown on every start), then `su-exec`s down to `PUID:PGID`, default `1000:1000`. An explicit `--user` skips the whole thing. All four paths tested with a stubbed `su-exec`. |
| **`server/cache.js`** | Also gives that failure a real message now — the actual uid, and the `chown` to run — instead of a raw better-sqlite3 stack trace naming a path inside the container. Covers `SQLITE_CANTOPEN` on open and `EACCES/EPERM/EROFS` on the mkdir. Verified against both shapes. |
| **Node 24** | **Node 20 and 18 are end-of-life** (checked against nodejs/Release `schedule.json`: 20 ended 2026-04, 22 runs to 2027-04, 24 to 2028-04). Image is `node:24-alpine`, CI's test job is Node 24, `engines` is `>=24.0.0`. `better-sqlite3@11.10.0` has no prebuild for ABI 137 but compiles cleanly from source and works — verified by an isolated install, then by a full `npm ci` + `npm test` of the working tree on Node 24 (20/20). |
| **i18n prefix rule** | Reported: `"Pošiljanje ni bilo mogoče: No mail account configured"` — half translated. `i18n.js`'s prefix rule returned `translatedPrefix + rawRemainder` by design, because most suffixes are variable (a hostname, an SMTP reply). Now the remainder gets its own `t()` pass, which is a no-op for anything unknown, so nothing that worked before changes. 21 user-facing server error strings added to `en.json`/`sl.json`. **The Slovenian is mine and wants a native read.** `test/i18n-prefix-test.mjs` drives the real `i18n.js` against the real dictionaries and asserts both halves: known messages translate, unknown suffixes still pass through. |

**No-mailbox empty state (decided: empty state, not a blocked dialog).** `hasNoAccounts()`
is `!state.accounts.length`, and `/api/accounts` returns owned **plus** shared-in
(`accounts.js#listAccounts`), so a grantee who owns nothing is correctly treated as having a
mailbox. `applyAccountGate()` sets `body.no-accounts` (app.css hides compose, search,
refresh, select-mode, the column heads, the account and folder lists) and paints an empty
state offering the wizard. Every mail action additionally calls `requireAccount()` —
hiding a control is not disabling it, and Enter-in-the-search-box is a separate path from
the search button. `loadMessages()` returns early and `renderList()`'s empty branch defers,
so nothing repaints over it. **Settings → Mail accounts is deliberately NOT gated** — it is
the way out. `test/no-account-gate-test.mjs` (24 assertions, source-level on purpose; the
comment says why) pins all of it.

**better-sqlite3 11 → 13, and the Docker build got much faster.** Read from the Codexa
project at the user's request: 13.x ships prebuilt N-API binaries including
`linuxmusl-x64` and `linuxmusl-arm64`, which is exactly what this Alpine image needs on both
published architectures. On 11.x there was no Node 24 prebuild, so npm fell back to node-gyp
and the **arm64 leg compiled SQLite under QEMU — about twenty minutes of every build**.
Codexa's Dockerfile also records that the same combination produced an intermittent native
crash (an assertion in better-sqlite3's `Statement` destructor), i.e. a source build against
an ABI the version predates is not merely slow but can be subtly wrong — worth knowing,
because a passing test suite does not rule that out. Upgrade verified: install drops from a
minute-plus to 1.4s, `node-gyp` leaves the lockfile entirely, and the full suite passes on
Node 24 with 13.0.3. `python3/make/g++` are consequently **gone** from the Dockerfile; the
only remaining prod packages with install scripts (`@firebase/util`, `protobufjs`) run plain
`node`. Hmelj uses only `db.prepare/exec/transaction/pragma`, none of which changed.

## Needs verification (on the real instance)

1. **Scheduled send, failure path.** The only genuinely untested code. Schedule a message
   ~2 min out, break the SMTP host in Settings, watch it back off in the log
   (`[schedule-send]`), fix the host, confirm it goes. Then confirm a permanent rejection
   (bad recipient domain) does **not** retry and lands back in Drafts.
2. **EWS reply arrow.** Reply from Hmelj to a message in the Exchange account, then check
   Outlook draws its ↩. Verified against realistic XML in `test/ews-verb-test.mjs`, but the
   real round trip needs your server.
3. **`$Forwarded` keyword.** Some IMAP servers reject keywords. Forward something, confirm
   the ↪ appears and no error shows in Settings › Log.
4. **The address book's automatic half.** Send to a new address, confirm it appears in
   Settings › Contacts with no name. When that person replies, confirm the name fills
   in — and that a second reply under a different name does NOT change it. Confirm a
   newsletter you have never written to is still not added.
5. **Reply exclusion.** Reply to someone new and confirm they do NOT appear in Contacts;
   add a second recipient to that same reply and confirm only that one does.
6. **Shared-account fix, no regression.** Confirm a shared account still reads, sends and
   deletes normally, and that its grantee's own settings/filters are untouched.

7. **Conversation view** (new, 2026-08-26 — the largest untested-in-a-browser piece).
   Turn it on in Settings › General. Sync has to run once first: the two new columns are
   NULL for everything already cached, and a NULL thread key reads as a thread of one, so
   a folder looks unchanged until its next full pass fills them in. Then: a thread with a
   reply you sent should count the Sent copy; opening it should land on the newest message
   with the older ones above; clicking an older line should expand it in place; deleting
   the row should delete only the Inbox messages, and the undo should bring all of them
   back. Turning the setting off must restore today's flat list exactly.
8. **Unsubscribe.** Two kinds now: senders that publish `List-Unsubscribe` (Müller, verified
   working) and senders that only put a link in the footer (Fantastic Fiction, Vitapur,
   Ubisoft, Cineplexx — 305 Fantastic Fiction messages carry no header at all). The second
   kind opens a page and says "Unsubscribe link found in this message" rather than claiming
   the sender published it. Worth checking one of each, and that a genuinely
   non-newsletter (a Garmin report, a ticket notification) shows no banner.
9. **Read receipts.** Open a message that asked for one, press Send receipt, and check the
   sender actually gets a receipt their client recognises (Outlook shows it as a tracking
   response, Thunderbird as a return receipt). The MIME is verified by test but no real
   client has seen one yet. Confirm the banner then reads "sent", and that reopening the
   message doesn't offer it again (that part depends on the server accepting the `$MDNSent`
   keyword — plenty don't, and it fails quietly by design).
10. **Search everywhere.** Search "dino" in the Gmail account: the footer should say only
   cached mail was searched, and the link should then find the 2011 message (it lives in
   `[Gmail]/Vsa pošta`, which nothing searched before). Expect it to take seconds — it is a
   live SEARCH per folder. Also confirm a new search resets back to the cheap scope.
11. **Collapsed quotes.** A reply should show only what was written this time, with a ⋯
   button; a forward with no comment of its own must NOT collapse to nothing. Check both a
   plain-text reply and an HTML one (Gmail, Outlook and Thunderbird mark their quotes
   differently and all three are matched).
12. **Header collapse.** ▾ on a message header, open another message, confirm it opens the
   same way; inside a conversation confirm the older messages always open collapsed.
13. **The Scheduled badge** no longer needs the 90s sidebar rebuild to correct itself —
   confirm the count drops within ~20s of a queued message going out, with the Scheduled
   view both open and closed.

## Worth knowing (found 2026-08-26 while verifying conversation view)

- **mailparser does not keep `List-*` headers under their own names.** It folds every one of
  them into a single `list` object (`{ unsubscribe: { url, mail }, 'unsubscribe-post': …}`),
  so `headers.get('list-unsubscribe')` is `undefined` and the unsubscribe banner shipped
  showing on nothing at all. Read from `parsed.headerLines` instead (`rawHeaderValue`), which
  is the better source anyway: mailparser's own `list.unsubscribe` drops the mailto's
  `?subject=`, which some list managers require. Same class as the `[object Object]` receipt
  bug — assuming mailparser's shape instead of checking it — so both features now have a test
  that goes through the REAL parser, which is the only kind that could have caught either.
- **A conversation showed only your own messages — the row's folder was the wrong scope.**
  A thread whose newest message is a reply YOU sent is represented by a row carrying
  `folder: 'Sent'` (the row IS that message). The stack was fetched against that folder, so
  the server scoped it to [Sent, Sent] and returned nothing but your side. Reported twice
  before it was found — first as "the count is 7 but I only see my own", where the cache
  window was a real second cause and masked it. Fixed by scoping to the folder being LISTED
  (`app.js#listedFolderFor` → `index.js#threadScopeFolders`), used by the count and the stack
  alike so they cannot disagree; a Sent listing now reaches into the inbox for the same
  reason. Pinned by `test/threading-key-test.mjs`.
- **A parse/serialize round trip ate addresses, silently.** htmlparser2 DECODES entities, so
  an Outlook header block's `&lt;tina@example.com&gt;` becomes the text `<tina@example.com>`
  — and serializing that back with `decodeEntities: false` writes it as raw markup, which the
  browser then parses as a tag and swallows. Every quoted "From:" line lost its sender.
  Caught by diffing the text of 377 real messages before and after; pinned by a test.
- **"The feature does nothing" was a stale-asset mix, twice.** The quote collapser was
  verified offline against 377 real cached messages (38 of 48 replies collapse, including the
  exact one reported as broken) while doing nothing in the browser. The served file was
  byte-identical to the repo's and `Cache-Control: public, max-age=0`, so the page was simply
  holding an older messageFrame.js than the app.js loaded beside it. #15 above makes that
  impossible; the first load after deploying it still needs one hard refresh. If a
  frame-side feature ever looks dead again, the frame now reports what it did —
  `[hmelj] quote: {found, marked, hidden, left}` on the console, once per opened message.

- **A conversation can look one-sided, and be correct.** Each folder caches only its newest
  `syncBackfillLimit` messages (250 by default). On the Work (EWS) account that is the
  newest 250 of INBOX's 19 025 — back to 3 Aug — while Sent's 243 reach back to April. So an
  older thread shows every message you sent and only the replies that fall inside the INBOX
  window. Nothing to fix in the threading; raising "Messages kept per folder" is the lever.
- ~~Stale `Inbox` rows on that same account~~ — **fixed 2026-08-26** (#11 above). 250 rows
  were cached under folder `Inbox`, last synced 2026-08-06, while the live folder (and the
  only row in `folders`) was `INBOX`: the path spelling changed and the old rows were
  orphaned — invisible to every folder listing, but still inside `queryUnified`'s scope, so
  All inboxes could show a few of them twice. The prune runs on the next sync cycle after a
  restart; watch for `pruned N cached message(s)` in the log.
- **Search is narrow by default, and now says so.** An ordinary search reads the cache:
  each folder's newest `syncBackfillLimit` messages, matched on subject/from/to only, and it
  never fell through to the server unless it found NOTHING. On the Gmail accounts that means
  `[Gmail]/Vsa pošta` (All Mail — 9 950 and 33 420 messages) is searched by nothing at all,
  because label-overlap protection keeps sync inside the INBOX tree. Hence "dino" finding two
  results and a 2011 message being unreachable. The footer link is the answer; see #13.

## Tests

`npm test` runs all 21 suites (`scripts/run-tests.mjs`, one process each). Individually:

```
node test/threading-key-test.mjs      43   thread keys, the grouped list query, and thread scope (single-folder AND unified)
node test/quote-collapse-test.mjs     16   where a plain-text reply stops and its quote begins
node test/quote-collapse-html-test.mjs 23  the same for HTML (server-side), plus reading a body's links
node test/read-receipt-test.mjs       28   the MDN's MIME structure, header encoding, injection
node test/icalendar-test.mjs          46   reading a meeting invitation: content lines, zones, and the four METHODs
node test/refile-test.mjs             34   the spam/archive origin ledger: remembering, pruning, and the plan back
node test/notify-text-test.mjs        34   what a notification preview has to strip, and which body to trust
node test/transfer-encoding-test.mjs  19   repairing undecoded quoted-printable — mostly the false positives it must refuse
node test/unsubscribe-test.mjs        49   List-Unsubscribe through the real parser, the body fallback, and mostly what they refuse
node test/search-scope-test.mjs       10   what the search box asks IMAP for, with and without "Search everywhere"
node test/scheduled-send-test.mjs     41   queue, preview, reschedule, retry policy
node test/contacts-learn-test.mjs     22   auto-add on send, name learning, the never-overwrite rules
node test/share-isolation-test.mjs    17   the whole viewerKey/userKey boundary
node test/answered-marker-test.mjs     8   cache round-trip for the markers
node test/ews-verb-test.mjs           12   MAPI mapping, both tag spellings
node test/filter-forward-once-test.mjs 12   pre-existing, real IMAP/SMTP mocks
node test/filter-selfmove-test.mjs      6   pre-existing
node test/attachment-cache-test.mjs   37   the attachment byte LRU, its keys, and the ETag/If-None-Match rules
node test/client-scripts-load-test.mjs 22   every client script EVALUATES, in index.html order
```

**`client-scripts-load-test.mjs` exists because `node --check` is not enough.** A function
declared in the wrong scope parses perfectly; the shipped 20260825005 build had
`pickSendTime` nested inside `init()` while the IIFE's return statement exported it, which
threw during evaluation, left `const Compose` permanently in the temporal dead zone, and
took the whole app down at boot. Run it after touching any `public/js/*.js`.

All green as of this handoff. `share-isolation-test.mjs` is the important one: 10 of its 17
assertions fail if the `viewerKey` decision is ever reverted.

## Deferred — do not start unprompted

- ~~Threading / conversation view~~ — **shipped 2026-08-26** (see the table above). Two
  columns via `addColumn()`, no backfill: an un-threaded row reads as a conversation of one
  and the next full sync pass fills it in. Deliberately left out of it: search results stay
  flat, chains with headers too broken to thread are NOT merged by subject, and the
  `message.html` popout still shows the single message it was opened for.
- **Graph reply/forward marker.** No Graph account here to verify against; documented in
  `graphClient.js#toGraphEnvelope`.
- ~~Filter surprise 6 (2-day date cutoff)~~ — **fixed 2026-08-25**: the gate now keys off
  IMAP INTERNALDATE (arrival) instead of the Date: header, so delayed mail and mail from a
  sender with a wrong clock is filtered, while the Gmail-relabel guard still holds.
- **Filter surprises 7–8** — scope limits (hidden folders, Gmail INBOX-tree-only, first-sync
  skip), and no rollback of already-succeeded actions when a later one fails.
- The **iOS bottom safe-area inset** (home indicator) should now be covered by the 2026-08-27 `--sab` padding on the scroll containers, but no iPhone has confirmed it — it was fixed for Android landscape and iOS gets it from the same variable.
- Dark-theme contrast guard in `messageFrame.js`;
  subject line and plain-text mode are unspellchecked; the Settings signature editor
  (`.sig-rich`) is unspellchecked.

## Plan document

Scheduled-send design rationale, including the rejected alternatives:
https://claude.ai/code/artifact/345b8bdf-d5b9-4ded-b32e-976374c2b337
