# Changelog

All notable changes to Hmelj are recorded here. Versions follow
[semantic versioning](https://semver.org/): the major number changes when an upgrade needs
manual work, the minor when features are added, the patch for fixes.

Work that has not been released yet collects under **Unreleased**. The version number is
set when the release is tagged — entries are never given one in advance.

## Unreleased

### Opening a message no longer waits for a refresh to finish

### Fixed: on an iOS PWA the calendar toolbar and the attachment viewer's buttons sat under the status bar

## 1.1.2 — 2026-09-21

### Fixed: the account list no longer shifts when the reorder arrows appear

### Translated the To placeholder and the reply/forward quote lines into Slovenian

### A new message's attachments stay visible above the Send bar instead of under the whole message

### A conversation with "expand every message" on loads four messages at a time instead of one

### Fixed: scrolling a long conversation while it was still loading kept jumping back to the newest message

### Forwarding a message starts in the To field

### Fixed: an Exchange account's Sent folder showed "To: —" for every message

### A Sent row lists the first three recipients, then …

### Fixed: in All inboxes, acting on a message could act on a different account's message with the same uid

### Fixed: marking a message read failed with "No mail account selected" when the list came from this device's cache

### Sending a message with no subject asks first

### Fixed: a draft's or a forwarded message's attachments failed to load with HTTP 400

### An app password can be limited to particular shared collections

### A shared calendar keeps its colour instead of arriving in the default blue

### Per-event colours now travel to whoever subscribes to a shared calendar

### Attendees in the event editor autocomplete from contacts, like To/Cc/Bcc do

### Fixed: accepting a contact suggestion inside a dialog submitted the dialog

### Fixed: Escape closes a dialog again when focus has moved outside it

### Fixed: a field's hint in a dialog form ran into the next field's label

### The ? beside a setting is right-aligned, so the badges line up in a column

### Translated six settings and error strings that were still showing in English

### Settings → Accounts now shows whether live monitoring is actually connected

### Added content wrapping in To, Cc and Bcc fields

### Snoozing: the reminder says what it is about, and the list stays the list
**The calendar reminder is named after the message.** It read "Follow up on a message" with a
body of "Snoozed message." — a reminder you cannot act on without going to look for what it
meant. The event is now titled with the subject, and its notes carry the subject, the sender,
and where the message actually is: *waiting in "Snoozed" (Služba) until then, when it moves
back to "INBOX"*. Both folders and both tenses, because the event gets read at two very
different moments — open it today and the message is not in the inbox at all, it is asleep.

**A snooze no longer forgets what it is about.** The subject and sender were read from the
cache, which does not always have the message — most reliably right after a wake, when the
move gives it a brand-new uid nothing has synced yet. The record then held nothing, showing
as "(no subject)" from "—" in the Snoozed list and reaching the calendar as a bare "Snoozed
message." The browser now sends the envelope it is looking at as a fallback.

**"Bring it back now" leaves the message read.** The timed wake still marks it unread — that
is the point of a snooze, to ask again later — but bringing one back by hand, while looking
at it, having decided to deal with it, is the opposite case, and marking it unread there is
the app arguing with you.

**The Snoozed list stopped turning into the inbox.** Background reconciliation knows the
Scheduled view, the Outbox and the Calendar are not mailboxes, but not that Snoozed is one
too — so a poll fetched the unified inbox and patched it straight over the list. Sit on that
screen for a minute and it quietly became your inbox.

### Snoozing: opening one no longer cancels it
**Clicking a snoozed message brought it back instead of opening it.** One click, no
confirmation, and the snooze was gone — which is a hard thing to guess at, since a click on a
message row means "read this" everywhere else in the app. It was deliberate, on the reasoning
that the message "is not in a folder this view can read"; that premise was simply wrong, as
the record carries the account, the folder and the uid. A click opens it now, read where it
is sleeping, and *Bring it back now* stays on the row's own menu where a deliberate action
belongs. Looking at it does not mark it read either — it comes back as you left it.

**A woken message could leave the inbox saying "1 unread" with nothing to show for it.** The
move gives the message a new uid, so the cache's unread COUNT moved while the row it counts
was not in the cache yet. The folder it lands in is re-read after a wake now, the same way
the Sent folder is re-read after a send.

### Snoozing: the row that did not appear, and the reminder that went to the wrong calendar
**The Snoozed row only showed up after a reload.** It is drawn from `state.snoozed`, and
snoozing never refreshed that list — so the sidebar was rebuilt from a copy that still said
nothing was snoozed. Un-snoozing had always refreshed it; only the other direction was
missing.

**A calendar reminder now goes to the calendar belonging to the account the message is in.**
It used to take the first writable calendar in the list, which is an arbitrary answer — a
follow-up on a work message could land in a personal calendar purely by list order. A
calendar source already records which mail account it signs in through, so the two are simply
matched. Where the account has no calendar of its own — which is the normal case for a plain
IMAP mailbox — it asks which calendar to use instead of guessing, and the confirmation says
where the reminder went.

**The reminder is also offered more often than it was.** Whether to offer it at all was read
from a count that only exists once the Calendar view has been opened in that session, so
somebody who lives in their inbox was never asked. The list is fetched at startup and when
you snooze — which also restores **Add to calendar** to the ⋯ menu, missing for the same
reason and with nothing to suggest why.

**A woken message now leaves the Snoozed count.** The wake happens on the server, on its own
timer, and nothing in the browser was watching for it: the background reconcile walks the
account's real folders, and Snoozed is not one of them, so the badge kept saying 2 until the
page was reloaded. It is refreshed alongside the folder counts now — only while something is
actually snoozed, since with an empty list there is nothing that can expire — and the row
itself goes when the last one wakes, instead of staying behind to open an empty list.

## 1.1.1 — 2026-09-09

### Telling the name check it is wrong about a sender
A ticketing system sends as **`Name Surname <service-desk@firma.si>`** — whoever touched the
ticket in the display name, over the system's own address. That is character for character
the shape the spoofed-name warning exists to catch, so a Jira folder ends up with a red
"the sender's name does not match their address" on every single notification, and the
warning stops meaning anything.

The warning now carries a **This sender is fine** button, and an address's right-click /
long-press menu offers the same thing. Either one silences the name check for that address
and clears the banners already on screen — all of them for that sender, not just the message
you clicked, since a folder full of them would otherwise still be wearing a warning that has
just been overruled.

Keyed on the **address alone**, deliberately: the point of a ticketing system is that the
name changes with every message while the address does not, so one action covers every
colleague who will ever touch a ticket. And **only the name check** is skipped — a failed
SPF/DKIM/DMARC check still warns, because this says "that name is not a lie", not "this mail
is beyond question". An impersonation of the same person from a *different* address is still
caught.

The list lives in **Settings → Reading**, at the bottom, where it can be read and any entry
taken back.

### Plain text files preview too
A `.txt` was one of the last ordinary attachments that still had to be downloaded to be
read. It opens in the viewer now — as do `.log`, `.md` and a few of the other extensions
that are plain text by any reasonable reading — with the same zoom, and full-screen on a
phone like the rest.

Its **encoding is honoured** rather than assumed. A text file written on Windows in Slovene
is very often cp1250, and decoded as UTF-8 every š, č and ž turns into a replacement
character: "Številka čisto" arrives as "�tevilka �isto". The part's own Content-Type usually
says which encoding it is, so that is what is used, falling back to UTF-8 where it does not.
A very long file is cut with a note rather than freezing the tab.

**`.csv` was already covered** — it opens as a table, the same grid an `.xlsx` gets, rather
than a screen of commas. One thing did improve there: a `.csv` that its sender labelled
`text/plain` (which happens often) used to fall through to a plain-text reading. The
filename now outranks a type that vague, so it lands in the grid where it belongs.

### Search by attachment type — `filetype:pdf`
Two new search terms: **`filetype:pdf`** (also `docx`, `xlsx`, or anything else) finds
messages carrying an attachment with that extension, and **`has:attachment`** finds messages
with any file on them at all. Both compose like every other term — `racun filetype:xlsx`,
`-filetype:pdf`, `from:ana filetype:docx`.

Matched on the extension rather than as a substring, so `filetype:doc` does not also return
every `.docx`, and a file called `pdf-notes.txt` is not a PDF.

This costs nothing to run. Attachment filenames arrive free with the message summary already
fetched from IMAP — the same structure that decides whether to draw a 📎 — so they are simply
kept now instead of thrown away, and the search is a local query.

Two limits, both stated rather than hidden:

- **No mail server can answer this**, so it is the mirror of `is:starred`: that one is
  always live, this one always local. Combining them, or combining `filetype:` with `body:`
  on an account without a search index, is refused with a sentence saying why rather than
  half-answered.
- **Microsoft and Exchange accounts report only *that* a message has attachments**, never
  their names. A `filetype:` search names those accounts under the results — *"Not searched
  by filename: Služba"* — instead of quietly leaving them out. `has:attachment` covers every
  account, since that boolean is cached for all of them.

Existing cached mail fills in its filenames as the poller next sweeps each folder, so the
answers get more complete over the first cycle rather than all at once.

### The document viewer, finished off
**Escape closes a preview even after you have clicked into the document.** It always worked
until you touched the page — at which point the keystroke belonged to the frame, and the
viewer around it never heard it. Which is exactly when someone reaches for Escape.

**Pinch, and Ctrl/⌘+wheel, now zoom a document or a spreadsheet** — not just the ± buttons.
This needed a small change of approach: events inside a frame never reach the page around
it, so the preview forwards the gesture out instead. The frame is allowed to run scripts for
that, which is only honest if the document cannot bring its own — so a rendered `.docx` is
now stripped of anything executable before it goes in, and embedded raw-HTML parts are not
rendered at all. It still has no access to this page, its cookies or the server: the frame's
origin is opaque, exactly as the message reading pane's has always been. What crosses the
boundary is an intent — a direction, or "close" — never a command; the page decides what
either means.

**A document fills the screen on a phone.** The top bar stays — it is the way out, and the
zoom — and everything under it is the document, rather than a panel with wasted margin
around it.

**And it is centred again on a desktop.** Fixing the phone bug (a page wider than the screen
overflowed at both ends, and the left half could not be scrolled to) had left every document
flush against the left of its grey surround. Auto margins do both jobs: centred when the
page fits, flush left when it does not, so nothing is ever out of reach.

**On Android, an Office file's Download button is gone** — it was the same button as
*Open with…* twice over. A WebView cannot save a `blob:` URL, so Download already routed
through the same hand-off, which saves the file and then offers to open it.

### Three things that only went wrong on a phone
**The message header's buttons were microscopic.** `.icon-btn` is a fixed 36px box and
everything in this app is `border-box`, so the generous padding meant to make them
finger-sized on mobile was taken *out* of the content box instead — leaving about eight
pixels for the icon, which then shrank to fit because nothing stopped it. They are sized by
the box now (34px on a desktop, 44px on a phone) and the icon inside is pinned against
shrinking.

**With an unsubscribe offer beside them the four buttons crowded the row.** They travel
together as a group now and drop to a line of their own when there is not room for both.

**A .docx was cut off down the left on a phone, with no way to scroll to it.** docx-preview
centres the page inside its wrapper, and a page that is wider than the screen — A4 is about
816px against a phone's 380 — overflows equally at *both* ends, where the left overflow
cannot be reached. On a narrow screen the page is now rendered without its fixed width so
the text reflows to the screen, and its Word margins are cut back (2.5cm at each edge leaves
under half a phone's width for the words). A desktop still gets the document laid out as the
document.

**And downloading it failed silently.** A WebView's DownloadListener only sees real
navigations, so the Download button — which points at a `blob:` URL whenever the preview has
already fetched the bytes — clicked and did nothing at all. In the Android app it now goes
through the same hand-off the *Open with…* button uses, which re-fetches with the session
cookie, saves the file, and then offers to open it.

### Reply all shows you who else is on it
Reply-all to a message with people copied put them in Cc — and left the Cc row collapsed. The
composer said "To: Simona" while it was about to write to four people, at exactly the moment
that field is worth seeing. Cc and Bcc are now open whenever the message being composed has
a Cc, and closed when it does not.

It looked like a remembered preference, and it was not: the compose window is shown and
hidden rather than rebuilt, so whatever state the Cc row was left in carried into the next
message — reveal it once by hand and it stayed open on every unrelated mail afterwards.
Nothing was remembering anything. Each opening now decides for itself.

### Real icons instead of unicode glyphs
Twenty icons now come from SVG files in `public/images` rather than from characters like
☑ ▤ ● ★ ✉ 📩 🗑 ⚙ ◐ ⏻ ↕, which every platform renders differently, some render in colour
whether you wanted it or not, and some render as a box:

- the message list's toolbar — select, layout, unread-only, show-muted, starred-only;
- select mode's toolbar — mark read, mark unread, delete, close;
- the message header's actions — reply, reply all, forward, delete;
- the user menu — mail accounts, manage folders, contacts, run filters, analytics, theme,
  settings, log out;
- and the sidebar's *Reorder accounts* button.

The toolbars and the message header are painted with a CSS mask, so a single file follows the
theme, the hover state and a toggle's pressed colour instead of needing a variant for each —
the filter toggles turn accent-blue when pressed, and the two delete buttons turn red on
hover. The **user menu** keeps its icons in colour instead: those are illustrations rather
than symbols, and the colour is most of what tells them apart at a glance.

All of them are precached by the service worker and served with a day-long cache header, so
an offline app still has its buttons.

### The message header does more, in less space
Two changes to the message header, both about the same thing: what you can tell, and what you
can do, without leaving it.

**Four actions** — Reply, Reply all, Forward and Delete — are icon buttons on their own row
under the recipients, right-aligned, and on a newsletter the **Unsubscribe** offer shares
that row on the left instead of taking a line of its own between the recipients and the
message. They are what anyone actually does with an open message, and they were two
clicks deep in the ⋯ menu — where none of them appears any more, because offering them in
both places would only make that menu longer to say the same thing twice. They stay put when the
header is collapsed (less header must not mean no way to reply) and get bigger tap targets
on a phone. <kbd>r</kbd>, <kbd>a</kbd> and <kbd>f</kbd> are unchanged.

The icons come from **`public/images`** as real SVG files rather than unicode arrows, which
render differently on every platform and at every font. They are drawn with a CSS mask, not
an `<img>`: the files are authored with `fill="currentColor"`, and an `<img>` resolves that
against the image's own document — black — so each one would have stayed black in dark mode.
A mask paints the shape in whatever colour it sits in, so one file covers both themes and
hover. They are precached by the service worker for offline use, and served with a day-long
cache header for the Android shell, which has no service worker and reads the app out of the
WebView's own cache when there is no network.

**Where a message lives** now shows beside the date as a small `📁 Arhiv` chip. In *All
inboxes* the one thing the view could not tell you was which folder a message had been filed
into; a search across folders and a conversation drawing in replies from Sent had the same
gap. It appears only where it adds something — never for the folder you are already looking
at, and never for INBOX, which is where mail is unless stated otherwise, so the usual All
inboxes row is exactly as clean as it was.

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
