# Changelog

All notable changes to Hmelj are recorded here. Versions follow
[semantic versioning](https://semver.org/): the major number changes when an upgrade needs
manual work, the minor when features are added, the patch for fixes.

Work that has not been released yet collects under **Unreleased**. The version number is
set when the release is tagged — entries are never given one in advance.

## Unreleased

### A forwarded message is no longer hidden behind a ⋯
The quoted half of a reply is collapsed behind a small ⋯ button, which is right in a
conversation — everything it hides is on screen above it as its own message — and wrong
everywhere else. Forward something with a line of comment on top and the reader got the
line and the button, with the mail that was the whole point of the message as the one
thing not shown. The collapsing is now the conversation view's alone; a message read on
its own opens with its quote already open, and the button stays, so a long one can still
be folded away by hand.

Two related places where that hiding never belonged at all. **Printing** a reply left out
the mail it was replying to and put a dead ⋯ on the paper. And **quoting** a collapsed
message into a new one carried the hiding into outgoing mail — the recipient's client has
no such button, so a message forwarded on from Hmelj could arrive with its contents
permanently invisible.

### The unread stripe is thicker
The line down the left of an unread row went from 3px to 5px. With the App font set to
Bold it is not one of two signals but the only one — every row is bold then, so the stripe
carries the whole job on its own, and 3px of a muted accent (sepia's is a brown barely
darker than the row behind it) was not enough for that.

### The message list is no longer adrift between a tight edge and a loose one
The gap to the reading pane was 30px against 14px on the sidebar side, because the 6px
drag handle sits inside it and the flex gap was being counted twice. Both sides are 14px
now.

### Priority is a button now
Three choices are worth *seeing*, and a dropdown can only show them as words. The footer
carries one button whose glyph and colour say what is set: **↑ red** for high, **↓ green**
for low, and a plain dim **≡** for normal — the default nearly every message goes out at,
and a default that colours itself is one that keeps asking to be looked at. Clicking it
offers the three.

### On a phone the composer fills the screen
Full page meant full page for the window but not for its contents: on a short message the
writing area stopped a few hundred pixels down and the **Send row sat stranded in the
middle of the screen** with blank space beneath it. The message now stretches to meet the
footer, and the footer sits on the bottom edge where it belongs — and both can still give
way when the on-screen keyboard opens.

### Dark mode: mail you could not read
A message that writes `color:#000` on its own text kept doing so after the background
became the dark theme's, leaving black on near-black. The reading frame now checks each
piece of text against **what it actually sits on** and replaces the colour only where the
contrast genuinely fails — so it fixes white-on-white in the light theme by the same test,
and leaves alone every message that was already legible. Inside a link the theme's link
colour is used, so a repaired link still reads as one. This is the other half of the
background pass that was already there.

### The toolbar says what the caret is inside
**Bold, italic, underline, strikethrough, the lists and the alignments now light up** when
the cursor is inside that formatting. Before, the bar was write-only: the only way to find
out whether a word was italic was to press the button and watch what happened.

### The Bold button un-bolded
With the App font weight set to 500 or 700, the composer inherited it — so the browser read
what you typed as already bold and **Bold** turned it off. The editor now writes at normal
weight regardless of the interface, which is also more honest: that weight came from the
app's own stylesheet and never travelled with the mail. The editor's font family is reset
for the same reason.

### Templates are edited with the composer's toolbar
The template editor was a plain box with no formatting controls at all, so a template could
hold formatting there was no way to produce. Templates and signatures now use **the same
toolbar as the composer** — one definition, built once and used in all three places, plus
the two buttons only Settings needs (insert an image, edit the HTML source).

## 1.1.0 — 2026-09-05

### A real formatting toolbar
The composer had bold, italic, underline, two list buttons, a link and a font dropdown.
It now has what a mail composer is expected to have.

- **Font and size** as pickers rather than a native dropdown — the font list draws each
  name in its own face. **Text colour and highlight** from one swatch panel.
  **Strikethrough** beside B/I/U.
- **⋯** holds what is used less often: **quote**, **code block**, **indent / outdent**,
  **alignment**, a **horizontal line**, clear formatting, templates, and which signature
  the message uses.
- An **emoji picker** with categories and a *Recent* row that fills with the ones you
  actually use. It stays available in **plain-text** mode, where the rest of the bar greys
  out — an emoji is a character, not formatting.
- What comes out is deliberately the old presentational markup (`<font size>`,
  `<font color>`, `<b>`) rather than CSS: it is what Outlook renders without argument.
  Quotes and code blocks carry their styling inline, because the person reading has none
  of Hmelj's stylesheets. A quote you make by hand and the quote on a reply are now
  styled from one definition, so they look identical.
- **On a phone the toolbar scrolls sideways** instead of wrapping onto three rows — the
  message area is what matters on a small screen. The spell-check language and the *Plain*
  switch stay outside the scrolling part, since they are state rather than actions.

### Several signatures per identity
An identity can have more than one — a full sign-off for new mail, a short one for
replies. Named and edited in **Settings › Identities**, one marked *Default*.

- Pick which one a message uses from **⋯ → Signature** while writing; the one already in
  the message is replaced rather than added to, and *None* removes it. The choice applies
  to that message only.
- An explicit pick works even when the identity is set not to add a signature
  automatically — that setting answers "should Hmelj add one by itself", and being asked
  is not by itself.
- Existing single signatures migrate on their own, as one entry named *Signature*.

### The composer remembers its size
On a desktop, whether you keep it enlarged. On a phone it stays full-page always — never
remembered, since a 560px floating panel is unusable there.

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
