// Hmelj — turning a provider's own contact shape into a vCard, and back.
//
// Graph and EWS hand over structured JSON/XML, not vCards. Everything Hmelj
// stores is a vCard (see server/contactSources.js's header for why), so those
// two need a translation and this is it — one file rather than two, because
// the two shapes differ only in field names and the mapping decisions are
// identical.
//
// ── The asymmetry is deliberate ──────────────────────────────────────────────
// The vCard direction is lossy and that is fine: the provider's copy is
// authoritative, the vCard is a local mirror, and a field Hmelj does not model
// is simply re-read on the next sync.
//
// The OTHER direction is not a conversion at all — it is a PATCH of the two or
// three fields the user actually changed. That is the same non-destructive rule
// server/vcard.js follows for CardDAV, enforced here by only ever producing a
// partial object: building a whole contact from a vCard and sending it would
// erase the birthday, the photo and the postal address that were never in the
// vCard to begin with.
import { newCard, setProps, escapeText, cardName, cardEmails } from '../vcard.js';

const prop = (name, value, params = {}) => ({ group: null, name, rawName: name, params, value });

/**
 * A provider contact → a vCard.
 *
 * `uid` is the provider's own item id, kept as the card's UID: it is stable
 * across syncs, which is what lets an edit on the other side update the card
 * here instead of arriving as a second contact with the same name.
 */
export function cardFromProvider({ uid, name, givenName, surname, emails = [], org, title, phones = [] }) {
  const card = newCard({
    name: name || [givenName, surname].filter(Boolean).join(' ') || (emails[0]?.email || emails[0] || ''),
    emails: emails.map((e) => (typeof e === 'string' ? { email: e } : e)).filter((e) => String(e.email || '').includes('@')),
    uid,
  });

  // N, only when the provider actually broke the name apart. vcard.js
  // deliberately refuses to invent one from a display name, and guessing here
  // would be the same guess in a different file.
  if (givenName || surname) {
    setProps(card, 'N', [prop('N', [surname, givenName, '', '', ''].map(escapeText).join(';'))]);
  }
  if (org) setProps(card, 'ORG', [prop('ORG', escapeText(org))]);
  if (title) setProps(card, 'TITLE', [prop('TITLE', escapeText(title))]);
  const tels = phones
    .map((p) => (typeof p === 'string' ? { number: p } : p))
    .filter((p) => String(p.number || '').trim());
  if (tels.length) {
    setProps(card, 'TEL', tels.map((p) => prop('TEL', escapeText(p.number), p.type ? { TYPE: [String(p.type).toUpperCase()] } : {})));
  }
  return card;
}

/**
 * The other direction: the PARTIAL provider object for what Hmelj can change.
 *
 * Exactly two fields, because exactly two are editable in Hmelj's address book.
 * Anything else the provider holds is left alone by not being mentioned — which
 * only works because the caller sends this as a PATCH (Graph) or a targeted
 * field update (EWS), never as a replacement.
 */
export function graphFieldsFromCard(card) {
  return {
    displayName: cardName(card),
    emailAddresses: cardEmails(card).map((e) => ({ address: e.email, name: cardName(card) })),
  };
}

/** A Graph contact object → the arguments `cardFromProvider` wants. */
export function fromGraphContact(c) {
  return {
    uid: String(c.id),
    name: c.displayName || '',
    givenName: c.givenName || '',
    surname: c.surname || '',
    org: c.companyName || '',
    title: c.jobTitle || '',
    emails: (c.emailAddresses || []).map((e) => ({ email: String(e.address || '').trim() })),
    phones: [
      ...(c.businessPhones || []).map((n) => ({ number: n, type: 'WORK' })),
      ...(c.mobilePhone ? [{ number: c.mobilePhone, type: 'CELL' }] : []),
    ],
  };
}

/** An EWS contact item (ewsClient.js#listContactItems) → the same. */
export function fromEwsContact(c) {
  return {
    uid: String(c.id),
    name: c.displayName || c.company || '',
    givenName: c.givenName || '',
    surname: c.surname || '',
    org: c.company || '',
    emails: (c.emails || []).map((email) => ({ email })),
  };
}
