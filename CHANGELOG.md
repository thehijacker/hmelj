# Changelog

All notable changes to Hmelj are recorded here. Versions follow
[semantic versioning](https://semver.org/): the major number changes when an upgrade needs
manual work, the minor when features are added, the patch for fixes.

## 1.0.9 — 2026-09-05

### Contact groups
A group is a name for a set of addresses — "the board", "the team". Type its name into
To, Cc or Bcc, pick it from the suggestions, and the field holds one token (`👥 Team`)
instead of eight addresses.

- The expansion happens on the **server**, once, when the message is actually handed over.
  Nothing downstream — the scheduled-send queue, the SMTP/EWS/Graph send paths, the
  address book's own "learn who I write to" — ever sees a group; they all see ordinary
  recipients. A message held back by undo-send or queued for later keeps the membership
  the group had when Send was pressed.
- Sending to a group that no longer exists, or to one with nobody in it, is **refused**
  with a sentence naming it, rather than quietly going to fewer people than intended.
  Saving a draft is not refused — that happens automatically, so the token simply stays in
  the field.
- Edited in **Settings › Contacts**: name a group, tick contacts and *Add to group*, or
  open one and search the address book for people to put in it. A group may also hold an
  address that is not a contact at all. `✉` starts a message to one.
- Members are stored as addresses rather than as contact ids, so a group can mix
  hand-typed and synced contacts and survives a synced card being re-fetched. Groups are
  per Hmelj user, like filters and saved searches, and are included in the settings export.

### Backspace deletes a whole recipient
In To, Cc and Bcc, Backspace at a recipient boundary now selects that whole recipient —
address or group — the way Outlook selects a chip; a second press removes it. Previously
unpicking a group meant one press per letter of its name. Backspace in the middle of an
address still deletes a character, so fixing a typo works as before, and Delete keeps its
own meaning (remove this contact from the address book).

### Unread counts on saved searches
Every pinned search in the sidebar now carries the same unread badge the folders beside it
do. Counted server-side off the local cache, in the request that already feeds the folder
badges — no extra round trip and no IMAP. A search the cache cannot answer on its own (a
`body:` term over an account with no full-text index) shows no badge rather than a wrong
one.

## 1.0.8 — 2026-09-04

### Offline mode
Hmelj now works with no server. Previously `/api/*` was network-only, so losing the
connection left an app that could say only that it had lost the connection.

- **Reading.** The newest messages of each account are downloaded in the background —
  bodies, their inline images, and the custom font the mail is read in — so mail can be
  opened offline that was never opened online, and it looks the way it does online.
  Message lists, folders, contacts, identities, settings and the calendar windows you
  have viewed are cached alongside, so the app boots and works with the server switched
  off. A message that was not saved says so, rather than erroring.
- **Search.** Offline, the search box searches the saved message headers (and the text of
  saved bodies) on the device, supporting `from:`, `to:`, `subject:`, `is:unread`,
  `is:starred` and `has:attachment`. Such results are labelled as local.
- **Writing.** Marking read/unread, starring, deleting, moving, archiving, spam, saving a
  draft and sending are queued in a new **Outbox** and go out in order on reconnect. The
  list reflects them immediately and keeps doing so across reloads. Actions the server
  later refuses — the message was moved or deleted from another client meanwhile — are
  reported once rather than retried forever.
- **Settings › Offline** (per device): on/off, how many messages to keep per account,
  whether to include attachments, a storage cap, what is currently stored, and a button
  to delete it. Saved mail is removed on logout and when a different user signs in.
- **Android.** With no network the shell now loads the app from the WebView's own HTTP
  cache instead of the bundled offline page, so offline mode is available on a plain-http
  LAN address too — where there is no service worker at all. The bundled page remains the
  fallback for a device that has never loaded the app.
- `POST /api/messages/:folder/bodies` (new): several message bodies in one request, for
  the prefetcher. `/api/*` is now `Cache-Control: no-store` by default, and `?v=`-stamped
  scripts and stylesheets are immutable.

## 1.0.0 — 2026-08-29

First public release. Hmelj had been developed privately for months before this; this entry
describes what that first public version contains rather than pretending it all arrived at
once.

### Accounts
- IMAP + SMTP against any server, with TLS and self-signed-certificate options
- Gmail, either with an app password or by signing in with Google (OAuth2 / XOAUTH2)
- Microsoft 365 and Outlook.com over Microsoft Graph, with OAuth2 + PKCE
- On-premises Exchange over EWS with NTLM
- Multi-user, with per-user mailboxes, settings, identities, contacts and filters
- Unified "All inboxes" and "All sent" views with per-account colour chips
- Per-account monitoring: IMAP IDLE, an EWS pull subscription, a Graph poll, or a fixed timer
- Admin-editable account presets; account sharing between Hmelj users

### Reading and writing
- Conversation view, grouped on the References root (or the provider's own conversation id)
- Server-side HTML sanitising, rendered in a sandboxed iframe
- External-image policy with per-domain trust, applied to CSS `url()` as well as `<img>`
- Collapsed quotes, one-click unsubscribe, attachment preview with progress, find in message
- Calendar invitations, read receipts, print, view headers, save as EML
- Rich or plain composing, multiple identities and signatures, scheduled sending, draft
  autosave, Slovenian and English spell checking

### Organising
- Server-side filters with six condition fields and eight actions
- Spam and Archive with a remembered return path, select mode, swipe gestures, undo
- Gmail-style search syntax, cached-first, with a one-click server-wide sweep
- Mailbox analytics that counts Gmail labels honestly rather than double-counting
- Contacts learned from sent mail, with CSV/vCard import and a Microsoft/Exchange pull

### Platform
- Web Push (VAPID) notifications, Firebase push for the Android app
- Notification scheduler with quiet hours, per-folder overrides, folder mute and holidays
- PWA install, and a native Android WebView shell
- Multi-architecture Docker image (`linux/amd64`, `linux/arm64`)
- English and Slovenščina
