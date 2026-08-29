# Changelog

All notable changes to Hmelj are recorded here. Versions follow
[semantic versioning](https://semver.org/): the major number changes when an upgrade needs
manual work, the minor when features are added, the patch for fixes.

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
