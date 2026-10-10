// Hmelj — which identity (and which address) a message is written from.
//
// The browser half of server/catchAll.js; read that file's header for what a
// catch-all identity is and what the server will and will not accept. Pure
// functions over the identity list, so the composer, the reading pane and a
// node test all ask the same questions the same way.
//
// With no identity carrying a `catchAllDomain`, pickForMessage can only ever
// return a plain identity id and isOwn is the exact-address test it replaced.
(function (root) {
  const lc = (s) => String(s ?? '').trim().toLowerCase();
  const addrOf = (a) => String(a?.address ?? a ?? '').trim();

  /** Same rule as server/catchAll.js#normalizeDomain. */
  function domainOf(identity) {
    const d = lc(identity?.catchAllDomain).replace(/^@/, '');
    return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d) ? d : '';
  }

  // Same rule as server/catchAll.js#LOCAL.
  const LOCAL = /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9_%+-])?$/;
  const validLocal = (local) => LOCAL.test(String(local ?? '')) && !String(local).includes('..');

  function atDomain(address, domain) {
    const a = addrOf(address);
    const at = a.lastIndexOf('@');
    return !!domain && at > 0 && lc(a.slice(at + 1)) === domain && validLocal(a.slice(0, at));
  }

  const localPart = (address) => { const a = addrOf(address); const at = a.lastIndexOf('@'); return at > 0 ? a.slice(0, at) : ''; };

  /** A catch-all only means something on an account that will send it: not
   *  Exchange, not Microsoft 365 (server/catchAll.js#allowsCatchAll). */
  function allows(identity, accounts) {
    if (!domainOf(identity)) return false;
    const acc = (accounts || []).find((a) => a.id === identity.accountId);
    return !(acc && (acc.type === 'ews' || acc.type === 'graph'));
  }

  /** Today's rule, unchanged: the account's default identity, else its
   *  auto-created main one (id === accountId), else its first. */
  function forAccount(identities, accountId) {
    if (!accountId) return null;
    const mine = (identities || []).filter((i) => i.accountId === accountId);
    return mine.find((i) => i.default) || mine.find((i) => i.id === accountId) || mine[0] || null;
  }

  /**
   * Who a reply to (or a forward of, or a reopened draft of) a message is
   * written as. `addresses` are tried in order — To then Cc for a received
   * message, the From line for a draft.
   *
   *   1. an identity of that account whose own address is one of them;
   *   2. else a catch-all identity of that account with one of them at its
   *      domain — that identity, sending as that address;
   *   3. else the account's usual identity, as before.
   *
   * Only that account's identities: an alias that happens to be configured on
   * another mailbox must not quietly route the reply through a different server.
   */
  function pickForMessage({ identities = [], accounts = [], accountId = null, addresses = [] } = {}) {
    const mine = identities.filter((i) => i.accountId === accountId);
    const list = addresses.map(addrOf).filter(Boolean);
    for (const a of list) {
      const exact = mine.find((i) => lc(i.email) === lc(a));
      if (exact) return { identityId: exact.id };
    }
    for (const a of list) {
      const wild = mine.find((i) => allows(i, accounts) && atDomain(a, domainOf(i)));
      if (wild) return { identityId: wild.id, fromAddress: a };
    }
    const usual = forAccount(identities, accountId);
    return { identityId: usual ? usual.id : null };
  }

  /** Is this one of the user's own addresses — an identity's, an account's, or
   *  anything at a catch-all domain? */
  function isOwn(address, identities = [], accounts = []) {
    const a = lc(addrOf(address));
    if (!a) return false;
    if (identities.some((i) => lc(i.email) === a) || accounts.some((x) => lc(x.email) === a)) return true;
    return identities.some((i) => allows(i, accounts) && atDomain(a, domainOf(i)));
  }

  root.FromAddress = { domainOf, validLocal, atDomain, localPart, allows, forAccount, pickForMessage, isOwn };
})(typeof window !== 'undefined' ? window : globalThis);
