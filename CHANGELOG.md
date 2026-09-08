# Changelog

All notable changes to Hmelj are recorded here. Versions follow
[semantic versioning](https://semver.org/): the major number changes when an upgrade needs
manual work, the minor when features are added, the patch for fixes.

Work that has not been released yet collects under **Unreleased**. The version number is
set when the release is tagged — entries are never given one in advance.

## Unreleased

### A reply you started and left is now visible from the message it answers
Reply to something, type half of it, close the window. The draft is saved — and until now
the only trace of it was a row in the Drafts folder, to be found again by subject.

The message you were answering now carries a **✎** in the list, and its right-click /
long-press menu offers **Continue unsent reply** and **Discard unsent draft** (or
*Continue unsent forward*, for a forward). The mark goes as soon as the draft is sent or
discarded, and the link cleans itself up if the draft is deleted somewhere else entirely.

Continuing a reply this way also fixes something that was quietly wrong before: a draft is
written to the mail server from its body and recipients alone, with no In-Reply-To and no
References, so a reply saved yesterday and sent today arrived as the start of a **new
thread** and left the original unmarked. The link carries that threading, so continuing a
reply produces a reply. Opening the same draft from the Drafts folder behaves as it always
did — there is nothing there to recover the linkage from.

Only drafts Hmelj wrote are linked; one composed in another client is an ordinary draft,
with nothing to say which message it answers.

One thing this uncovered along the way: the **Drafts folder's message count was never
maintained**. That folder is deliberately excluded from background syncing, so nothing was
watching it — adding, sending or discarding a draft left the number where it was, in the
sidebar as well as in the new menu entry. The three places that change it now say so
themselves.

### "Open drafts" on an account
Right-click (long-press) an account in the sidebar: alongside *Mark all as read* there is
now **Open drafts**, with the count, which switches to that account and opens its Drafts
folder. It appears only when that account has drafts, and not on *All inboxes* — which is
not one account and has no single Drafts folder to open. The count comes from the folder
list already cached, so the menu costs nothing to draw.

### A reply opens where you write it
Hitting Reply could open the composer part-way down the quoted original, at whatever spot
the *previous* message happened to be left at — which reads exactly like the window
remembering a scroll position, because that is what it was doing.

Two containers scroll in the composer: the panel, and the editor itself. The window is shown
and hidden rather than rebuilt, so both kept the offset the last message left behind, and
replacing the editor's contents does not clear that — a browser only clamps a scroll
position when the new content is shorter than the old one. Both are now reset when a
composer opens.

The caret was the other half of the same complaint. A reply and a forward arrive with their
recipients and their subject already filled in, so the only thing left to do is write — and
focus went to the Subject field, one Tab short of where the message actually gets typed. It
now starts on the first line of the writing area, above the signature and above the quote.
With *quote above the reply* the view follows the caret rather than the top of the message.

A new message is unchanged: it still opens at To, or at Subject when the recipient is
already known. There, the empty field is the next thing to do.

### Going through the contacts list is no longer a chore
Three things aimed at the same afternoon: several hundred freshly imported contacts, and
the job of throwing away the ones you do not want.

**Quick delete.** A checkbox above the list. With it ticked, ✕ removes the row at once
instead of asking — and the focus moves to the row that takes its place, so the rest of the
pass is a keypress each rather than a click, a dialog and a re-aim. It is safe because it
is not yet real: deleting a local contact edits the draft, and **Save** is what writes it,
so closing Settings without saving brings everything back. A *synced* contact's ✕ still
asks every time, because that one is an immediate write to somebody else's server with no
draft in front of it and no undo behind it.

**Paging.** The list used to draw the first 200 matches and tell you to search for the
rest. Now there is a pager above and below it — ‹ Previous, Next ›, "201–400 of 843" — and
a **Per page** choice of 50, 100, 200, 500 or All. Changing the size keeps you where you
were reading rather than snapping back to the top, and *Select all matching* still covers
every page, not just the one on screen.

**Both are remembered per browser**, in local storage, rather than with the rest of your
settings — 500 rows a page is comfortable on a desktop and miserable on a phone, and "do
not ask me to confirm" is a promise about the machine you are sitting at, not one that
should follow you onto the device where ✕ is a fat-finger away from the e-mail field.

### Google contacts sync sent you to enable the wrong API
Adding a Google address book and having it refused produced an error naming the **CalDAV**
API and linking to the CalDAV page in the Cloud console — advice that is correct for
calendars and useless for contacts, since those are two separate APIs. Enabling the one the
message asked for changed nothing, and the next attempt failed identically.

Google's own reply says which it means ("Google Contacts CardDAV API has not been used in
project …"), and the request URL says it independently, so the message now reads both and
names **CardDAV API** with the matching console link when it is contacts that were refused.
It also says outright that CalDAV and CardDAV are enabled separately, which is the part that
was actually costing the time.

Two smaller things in the same message. Google's reply is longer than the 200 characters
that were quoted back, so the giveaway word could fall off the end of the string the
detection ran against — recognition now reads the whole reply and only the quote is
trimmed. And that trimmed quote is dropped entirely for this case, because cutting Google's
sentence mid-URL ("…/apis/a") made the answer look broken at precisely the moment it was
telling you what to do.

The docs gained the matching warning under Contacts, and the calendar one now points at it.

### Settings uses the screen it is given
The dialog was a fixed 920×760, which is a sensible size on a laptop and a third of the
screen on a 2560px display — with Contacts, Filters and Accounts, the tabs built out of
side-by-side inputs, squeezed into about 676px of it (190px of the width is the nav column)
while two thirds of the desktop sat empty. It now grows with the viewport, up to 1400×900.

Nothing changes below a viewport of about 1480px: the old size is the floor, not the
starting point. And the form tabs deliberately do not sprawl to match — a row of label and
control stays capped at a readable width, so the extra room goes to the lists, which are
what wanted it.

### The contacts list can be sorted, filtered, and imported from anyone's CSV
Three things that were all the same complaint: going through a few hundred contacts to throw
the useless ones away was slower than it should be, and getting the company address book in
was not possible at all.

**Sorting.** *Name A–Z* is the new default, with *E-mail A–Z* and *As added* beside it —
contacts.json's own order is the order things were added, which is no order at all once "Add
people I send to" has been on for a year. Sorting is by what the row shows, so a contact with
no name sorts under its address rather than joining a block of blanks at the top, and Slovene
collation is used where the interface is Slovene: Č, Š and Ž after C, S and Z.

**Filtering.** A *Show* dropdown beside the search box. **Without a name** is the one that
matters for pruning — it is where addresses picked up automatically end up. **Same name,
several addresses** finds both real duplicates and the legitimate case of one person's work
address beside their private one. **Local only** and **Synced only** separate the rows you
can bulk-delete from the ones that live on somebody else's server. All of it composes with
the search box and with *Select all matching*, so "everything with no name, selected,
deleted" is three clicks.

**CSV imports name their own columns.** Picking a `.csv` now opens a dialog with three
dropdowns — *Name*, *Surname*, *E-mail* — listing that file's columns with a sample value
beside each, over a live preview of the first few contacts exactly as they would be saved.
Name and Surname are joined with a space, or leave one empty if the whole name is in one
column. Nothing is sent until the preview reads correctly.

Before this, a CSV was handed to the server, which looked for a column called something like
"Name" and something like "E-mail" — so anything not shaped like a Google export reported
success and added nothing. Now the guess is only a starting point, and it is right far more
often: English and Slovene headers alike, the address column found by looking for the one
that actually contains an `@` where the header gives nothing away, and the same trick for a
file with no header row. Commas, semicolons and tabs are all recognised — a CSV out of a
European Excel needs nothing done to it first — as are quoted fields with commas or line
breaks in them and the byte-order mark Excel writes in front of the first column name. Rows
with no address are skipped and counted, and the result says how many addresses were already
in the book rather than only how many were added.

### Add to contacts, from the message header
The right-click / long-press menu on a name in a header had *Copy address* and *New message*.
It has **Add to contacts** now, which saves that person with the display name spelled exactly
as the header spells it.

That spelling is the point. The warning that a sender's name does not match their address
compares the two character for character, so mail from a colleague's *second* address — the
work one next to the private one already in your address book — is flagged every time. The
fix was a trip to Settings; it is now one gesture away from the warning itself, and the
warning on the open message disappears the moment the contact exists rather than standing
there until the message is reopened.

Where there is nothing to add, the entry says so instead of quietly disappearing: *Already in
contacts*, or *This is your own address*.

### Word and Excel attachments can be read without leaving Hmelj
A `.docx` invoice or an `.xlsx` price list used to be the one common attachment the viewer
could say nothing about: a paperclip, a filename, and a download you then had to open
somewhere else. Both open in the preview overlay now, from the same bytes the progress bar
already fetched.

A **Word** document is rendered with its own page layout — margins, fonts, tables, embedded
images, headers and footers — rather than flattened into plain HTML. A **spreadsheet**
(`.xlsx`, `.xlsm`, `.xlsb`, `.xls`, `.csv`, `.ods`) opens as a scrollable grid with a tab per
sheet, row numbers and column letters that stay put while you scroll, and every value
formatted the way Excel formats it — 1.234,50 €, not 1234.5. Both have zoom buttons in the
top bar. A very large sheet is capped at the first few thousand rows and says so, rather
than locking the tab while it builds a grid nobody was going to scroll to the end of.

Legacy **`.doc`** (Word 97–2003) is shown as text only, with a note saying as much. It is an
OLE compound document, not a zip of XML, and the alternative to a text extraction is half a
gigabyte of LibreOffice in the image — a heavy price for a preview. The text is pulled out
on the server, from the bytes already in the attachment cache. Reading `.doc` needs a new
dependency, so an existing install wants an `npm install`; without it that one format falls
back to the download it does today, and nothing else is affected.

Two things about how it is done. The rendering libraries are **served from your own
instance**, not a CDN: an install reachable only over a LAN still previews, and opening an
attachment does not become a request to somebody else's server. They are loaded the first
time such a file is opened and never at startup, and the service worker caches them from
there, so the second one works offline. And the rendered document goes into the same kind
of sandboxed frame a message body does — it cannot run scripts, and its styles cannot reach
the app around it.

On a **phone** these now open in the overlay instead of being handed straight to the
operating system, which is what a WebView can actually draw. The hand-off is still there,
as an **Open with…** button in the top bar, for when the real Excel is what you wanted.

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
