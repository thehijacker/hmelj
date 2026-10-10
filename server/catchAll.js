// Hmelj — catch-all identities: sending from any address at a domain you own.
//
// An identity may name one domain as a catch-all (`catchAllDomain`). The
// composer can then ask for a different sender address at that domain
// (`payload.fromAddress`) — the address a message was delivered to, or one the
// user typed — while the name, signature, Reply-To and the account it is sent
// through all still come from the identity.
//
// ── Opt-in, and nothing changes without it ─────────────────────────────────
// An identity with no catch-all domain never has its address replaced, whatever
// a request says. That is the whole safety property of this file: every caller
// asks effectiveFrom() for the sender, and with no domain set it returns
// `identity.email`, exactly what the code used before this existed.
//
// ── What is refused ─────────────────────────────────────────────────────────
// An address at any other domain, including a sub-domain: a catch-all for
// example.com says nothing about mail.example.com, and "any address you like"
// is how a webmail becomes a tool for forging mail. And any address at all on
// an Exchange or Microsoft 365 account — those servers decide who you may send
// as and refuse the rest, so offering it there would only produce bounces.
// Gmail does not refuse; it rewrites the sender to the account's own. That
// cannot be detected from here, so the setting's hint says so instead.

/** `Example.com`, `@example.com`, ` example.com ` → `example.com`. Anything
 *  that is not a plain domain → '' (which is "no catch-all"). */
export function normalizeDomain(value) {
  const d = String(value ?? '').trim().toLowerCase().replace(/^@/, '');
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d) ? d : '';
}

// The part before the @. Deliberately narrower than RFC 5322 allows: no
// quotes, no spaces, nothing that could smuggle a second address or a header
// into the From line.
const LOCAL = /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9_%+-])?$/;

/** Is `address` a single, plain address at exactly `domain`? */
export function addressAtDomain(address, domain) {
  const d = normalizeDomain(domain);
  const a = String(address ?? '').trim();
  if (!d || !a) return false;
  const at = a.lastIndexOf('@');
  if (at < 1) return false;
  const local = a.slice(0, at);
  return a.slice(at + 1).toLowerCase() === d && LOCAL.test(local) && !local.includes('..');
}

/** Can this identity send from another address at all? */
const serverDecides = (acc) => acc?.type === 'ews' || acc?.type === 'graph';

export function allowsCatchAll(identity, acc) {
  return !!normalizeDomain(identity?.catchAllDomain) && !serverDecides(acc);
}

/**
 * The address a message goes out from. `fromAddress` when it is allowed,
 * otherwise the identity's own — never an error, because this is also what the
 * background senders call (the scheduled queue, undo-send), where there is
 * nobody left to show one to.
 */
export function effectiveFrom(identity, acc, fromAddress) {
  const own = identity?.email || acc?.email || '';
  if (!fromAddress || !allowsCatchAll(identity, acc)) return own;
  return addressAtDomain(fromAddress, identity.catchAllDomain) ? String(fromAddress).trim() : own;
}

/**
 * The same decision for a request a person is waiting on: an address that
 * would be ignored is refused out loud instead, so nobody presses Send
 * believing a message goes out as one address while it goes out as another.
 */
export function assertFrom(identity, acc, fromAddress) {
  if (!fromAddress) return;
  const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!normalizeDomain(identity?.catchAllDomain)) fail('This identity cannot send from another address');
  if (serverDecides(acc)) fail('This account cannot send from another address');
  if (!addressAtDomain(fromAddress, identity.catchAllDomain)) {
    fail(`The sender must be an address at ${normalizeDomain(identity.catchAllDomain)}`);
  }
}

/** The catch-all domains among a list of identities, for "is this address
 *  mine?" (contacts.js#myCatchAllDomains). */
export function domainsOf(identities) {
  return [...new Set((identities || []).map((i) => normalizeDomain(i?.catchAllDomain)).filter(Boolean))];
}

/** Is `address` one of `addresses` (a Set of lower-cased ones), or at one of
 *  `domains`? */
export function isOwn(address, addresses, domains) {
  const a = String(address ?? '').trim().toLowerCase();
  if (!a) return false;
  if (addresses?.has(a)) return true;
  const at = a.lastIndexOf('@');
  return at > 0 && (domains || []).includes(a.slice(at + 1));
}

/**
 * "My addresses" as a Set that also says yes to anything at a catch-all domain.
 *
 * A Set subclass so that every existing `mine.has(address)` — the contact
 * learner, out of office, contact suggestions — becomes catch-all aware
 * without being rewritten, and so that with no domains it IS the plain Set
 * those callers always had. Iterating it still yields only the exact
 * addresses; a caller that needs the domains too (a SQL filter cannot call
 * has()) reads `.domains`.
 */
export class OwnAddresses extends Set {
  constructor(addresses = [], domains = []) {
    super([...addresses].map((a) => String(a || '').toLowerCase()).filter(Boolean));
    this.domains = [...domains];
  }

  has(address) {
    const a = String(address ?? '').trim().toLowerCase();
    if (super.has(a)) return true;
    if (!this.domains.length) return false;
    const at = a.lastIndexOf('@');
    return at > 0 && this.domains.includes(a.slice(at + 1));
  }
}
