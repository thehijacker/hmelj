// Hmelj — the address book's automatic half.
//
// Everything here is bookkeeping ON TOP of the contact list the user edits by
// hand in Settings. It never deletes anything and never overwrites anything
// they typed. Two rules, deliberately asymmetric:
//
//   - Writing to someone ADDS them — but only an address the USER put in the
//     field. A reply's prefilled recipients are excluded (compose.js hands them
//     over as payload.prefilledRecipients): answering somebody is not the same
//     act as deciding to write to them, and an address book that filled up with
//     everyone who has ever mailed you is precisely what the second rule below
//     exists to prevent. Anyone added on top of a reply's own recipients still
//     counts, because that IS the user choosing.
//   - Receiving from someone NEVER adds them. An inbox is full of addresses
//     nobody chose — newsletters, notifications, spam, one-off senders — and an
//     address book that collected all of them would be worse than an empty one.
//     Incoming mail may do exactly one thing: fill in the display name of a
//     contact that is ALREADY there and hasn't got one yet. That is how
//     new_user@domain.com, added the first time it was written to, becomes
//     "Marko Okorn" as soon as he replies.
//
// A name already stored is never replaced. The user's own spelling of somebody's
// name outranks whatever that person has configured in their mail client this
// week, and a contact whose name keeps changing under them is a bug, not a
// feature.
//
// Both halves are opt-out (settings.autoAddContacts / settings.learnContactNames)
// because both write to the user's own data without being asked each time.
import crypto from 'node:crypto';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { store } from './store.js';
import { listOwnedAccounts } from './accounts.js';
import { log } from './log.js';

const clog = log.scope('contacts');

/** The addresses in one or more To/Cc/Bcc field values, as {name, email}.
 *  Uses nodemailer's own parser — the same one the send path hands these
 *  strings to — so "who got a copy" and "who we learned" cannot disagree about
 *  where one address ends and the next begins. */
export function parseRecipients(...fields) {
  const out = [];
  for (const f of fields) {
    if (!f) continue;
    for (const a of addressparser(String(f), { flatten: true })) {
      const email = String(a.address || '').trim();
      if (email.includes('@')) out.push({ name: String(a.name || '').trim(), email });
    }
  }
  return out;
}

/**
 * Adds `rows` ({name, email}) to the stored contact list, skipping any address
 * already there. One function for every path that can add a contact — pasted
 * vCard/CSV, the Exchange and Graph imports, the mail-history suggestions, and
 * the automatic add on send — so they cannot drift apart on what counts as a
 * duplicate (the lowercased address, always).
 */
export function addContacts(rows) {
  const contacts = store.getContacts();
  const existing = new Set(contacts.map((c) => String(c.email || '').toLowerCase()));
  let added = 0;
  for (const { name, email } of rows) {
    const addr = String(email || '').trim();
    const key = addr.toLowerCase();
    if (!addr.includes('@') || existing.has(key)) continue;
    contacts.push({ id: crypto.randomUUID(), name: String(name || '').trim(), email: addr });
    existing.add(key);
    added++;
  }
  if (added) store.saveContacts(contacts);
  return { added, total: contacts.length };
}

/** Every address that is the user's own — their accounts and their identities.
 *  Both are viewerKey-scoped reads (the person's own, never a shared mailbox
 *  owner's), which is what makes "don't add me to my own address book" mean the
 *  right thing when sending from an account somebody shared in. */
function myAddresses() {
  return new Set([
    ...listOwnedAccounts().map((a) => String(a.email || '').toLowerCase()),
    ...store.getIdentities().map((i) => String(i.email || '').toLowerCase()),
  ].filter(Boolean));
}

/**
 * Everyone the USER addressed a just-sent message to becomes a contact.
 * `payload.prefilledRecipients` — the fields Hmelj itself filled in on a reply —
 * is subtracted first; see this file's header.
 *
 * Called after the send SUCCEEDED, never before: a message that bounced at the
 * SMTP handshake is not evidence of anything, least of all that the address was
 * typed correctly. Runs in the sender's own ALS context, so it writes to the
 * sender's address book even when the message went out through a shared mailbox.
 *
 * Best-effort by construction — the caller has already delivered the mail, and
 * nothing here is allowed to turn a successful send into a visible failure.
 */
export function learnRecipients(payload) {
  try {
    if (store.getSettings().autoAddContacts === false) return { added: 0 };
    const mine = myAddresses();
    // Parsed, not string-compared: the composer hands over the field values it
    // filled in, and by send time the user may have reordered them, changed the
    // spacing, or turned "a@b" into "Name <a@b>" — only the addresses match
    // reliably.
    const prefilled = new Set(
      parseRecipients(...(payload.prefilledRecipients || [])).map((r) => r.email.toLowerCase()));
    const rows = parseRecipients(payload.to, payload.cc, payload.bcc)
      .filter((r) => !mine.has(r.email.toLowerCase()) && !prefilled.has(r.email.toLowerCase()));
    if (!rows.length) return { added: 0 };
    const r = addContacts(rows);
    if (r.added) clog.info(`Added ${r.added} new contact(s) from a sent message`);
    return r;
  } catch (e) {
    clog.warn('Could not add recipients to contacts:', e.message);
    return { added: 0 };
  }
}

/**
 * Fills in missing display names on contacts we already have, from mail that
 * just arrived. Never adds a contact and never changes a name that is already
 * stored — see this file's header for why both of those are the point.
 *
 * Explicit uKey rather than ALS: the only caller is server/sync.js's background
 * poll loop, which carries its own key end-to-end (same reasoning as
 * store.getSettingsFor / getPushSubscriptionsFor).
 *
 * Cost is one small JSON read per folder poll that found new mail, and it exits
 * on that read alone in the ordinary case — a fully named address book has
 * nothing here to do, so there is nothing to scan the messages against.
 */
export function learnSenderNames(uKey, messages) {
  try {
    if (store.getSettingsFor(uKey).learnContactNames === false) return 0;
    const contacts = store.getContactsFor(uKey);
    // Only the nameless ones can be answered, so they are the whole index —
    // and if there are none, the messages are never looked at at all.
    const nameless = new Map();
    for (const c of contacts) {
      if (!String(c.name || '').trim()) nameless.set(String(c.email || '').toLowerCase(), c);
    }
    if (!nameless.size) return 0;
    let filled = 0;
    for (const m of messages) {
      const email = String(m.from?.address || '').trim().toLowerCase();
      const name = String(m.from?.name || '').trim();
      // A "name" that is just the address again (plenty of servers do this)
      // tells us nothing and would permanently block the real one from ever
      // being learned, since a stored name is never replaced.
      if (!email || !name || name.toLowerCase() === email) continue;
      const c = nameless.get(email);
      if (!c) continue;
      c.name = name;
      nameless.delete(email); // first one wins within a burst; it is now named
      filled++;
    }
    if (filled) {
      store.saveContactsFor(uKey, contacts);
      clog.info(`Learned ${filled} contact name(s) from incoming mail`);
    }
    return filled;
  } catch (e) {
    clog.warn('Could not learn contact names from incoming mail:', e.message);
    return 0;
  }
}
