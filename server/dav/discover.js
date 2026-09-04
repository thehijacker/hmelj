// Hmelj — finding somebody's calendars and address books from what they typed.
//
// RFC 6764's bootstrap, which exists because nobody knows their own collection
// URL. What a person can be expected to produce is the server's address —
// `https://cloud.example.com`, or whatever their provider put on a help page —
// and the chain from there to "these are your four calendars" is four requests:
//
//   /.well-known/{caldav,carddav}   →  current-user-principal
//   the principal                   →  {calendar,addressbook}-home-set
//   the home set, Depth 1           →  the collections themselves
//
// Every step is allowed to fail and be worked around, because in practice every
// step does, on somebody's server:
//
//   - `.well-known` is missing on most self-hosted setups that live under a
//     path (`https://host/nextcloud/`), so the typed URL is tried directly.
//   - Google answers `.well-known` with a 301 that MUST keep the method; a
//     client that lets `fetch` follow it sends a GET and gets an HTML page.
//     Handled in client.js, which is why redirects are followed by hand there.
//   - iCloud will not answer a principal PROPFIND at the service root at all;
//     the principal path has to come back from the well-known redirect first.
//   - Plenty of people paste the collection URL itself, having found it in
//     another client. That short-circuits the whole chain and must work.
//
// So this returns what it managed to find and says which step it got to, rather
// than throwing on the first thing that did not go to plan.
import { asArray, textOf, xmlEscape } from './client.js';
import { log } from '../log.js';

const dlog = log.scope('dav-discover');

/** Namespace prefixes as declared in client.js's PROPFIND envelope. Kept here as
 *  names rather than repeated as literals so the two cannot drift. */
const NS = { caldav: 'C', carddav: 'CR' };

/** The resourcetype element that identifies a collection of each kind, and the
 *  home-set property that lists them. */
const KINDS = {
  caldav: { resource: 'calendar', homeSet: 'calendar-home-set', ns: NS.caldav, wellKnown: '/.well-known/caldav' },
  carddav: { resource: 'addressbook', homeSet: 'addressbook-home-set', ns: NS.carddav, wellKnown: '/.well-known/carddav' },
};

const PRINCIPAL_PROPS = '<current-user-principal/><principal-URL/><resourcetype/>';

const homeProps = (kind) => `<${KINDS[kind].ns}:${KINDS[kind].homeSet}/><current-user-principal/><displayname/>`;

/** Everything worth knowing about a collection, asked for in one round trip.
 *  `getctag` and `sync-token` are the two incremental-sync handles; a server
 *  that has neither is polled by comparing ETags, which works and is slower. */
function collectionProps(kind) {
  const common = '<resourcetype/><displayname/><current-user-privilege-set/><sync-token/><CS:getctag/>';
  return kind === 'caldav'
    ? `${common}<C:supported-calendar-component-set/><C:calendar-description/><IC:calendar-color/><IC:calendar-order/>`
    : `${common}<CR:addressbook-description/>`;
}

/** The privileges that mean "this account may change things in here". DAV
 *  reports a set, and a collection can be readable but not writable — a
 *  colleague's shared calendar, a subscribed holiday feed — so this decides
 *  whether Hmelj offers to edit at all. Read from the server rather than
 *  guessed: offering an edit that will be refused is worse than not offering it. */
const WRITE_PRIVILEGES = new Set(['write', 'write-content', 'bind', 'unbind', 'all']);

function privilegesOf(prop) {
  const set = new Set();
  for (const p of asArray(prop?.['current-user-privilege-set']?.privilege)) {
    // <privilege><write/></privilege> — the granted right is the child element's
    // NAME, so the keys are what is being read, not the values.
    for (const name of Object.keys(p || {})) set.add(name.toLowerCase());
  }
  return set;
}

/** An href out of a property that holds one. */
function hrefOf(prop, name, base) {
  const h = textOf(asArray(prop?.[name]?.href)[0]);
  if (!h) return '';
  try { return new URL(h, base).href; } catch { return ''; }
}

/** Does this resourcetype say it is a collection of the kind we are looking
 *  for? `resourcetype` parses to an object whose KEYS are the child elements —
 *  `{collection: '', calendar: ''}` — so membership is a key test. */
function isKind(prop, kind) {
  const rt = prop?.resourcetype;
  if (!rt || typeof rt !== 'object') return false;
  return KINDS[kind].resource in rt;
}

/** A calendar collection may declare which component types it accepts. One that
 *  takes only VTODO is a task list, and showing it as a calendar that never has
 *  anything in it is worse than leaving it out. */
function componentsOf(prop) {
  const comps = asArray(prop?.['supported-calendar-component-set']?.comp)
    .map((c) => String(c?.['@_name'] || '').toUpperCase())
    .filter(Boolean);
  return comps.length ? comps : ['VEVENT']; // undeclared means "the usual", per RFC 4791
}

/** Apple writes `#RRGGBBAA`; CSS wants at most `#RRGGBB` for the palette Hmelj
 *  uses elsewhere, and the alpha is always FF in practice. */
function colorOf(prop) {
  const raw = textOf(prop?.['calendar-color']).trim();
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(raw);
  return m ? '#' + m[1].toLowerCase() : '';
}

/**
 * The principal URL for these credentials, or ''.
 *
 * Tried against several candidate URLs in turn because which one works is a
 * property of the server, not something a user could be expected to know.
 */
async function findPrincipal(client, candidates) {
  for (const url of candidates) {
    try {
      const rows = await client.propfind(url, PRINCIPAL_PROPS, 0);
      for (const r of rows) {
        const p = hrefOf(r.props, 'current-user-principal', r.url)
          || hrefOf(r.props, 'principal-URL', r.url);
        if (p) { dlog.debug(`principal ${p} (from ${url})`); return p; }
        // Some servers answer a PROPFIND on the principal itself without
        // echoing current-user-principal back. If what came back IS a
        // principal, that is the answer.
        if (r.props?.resourcetype && typeof r.props.resourcetype === 'object' && 'principal' in r.props.resourcetype) {
          dlog.debug(`principal ${r.url} (it was the URL given)`);
          return r.url;
        }
      }
    } catch (e) {
      dlog.debug(`no principal at ${url}: ${e.message}`);
    }
  }
  return '';
}

/** The home-set URL, given a principal. */
async function findHome(client, principalUrl, kind) {
  try {
    const rows = await client.propfind(principalUrl, homeProps(kind), 0);
    for (const r of rows) {
      const h = hrefOf(r.props, KINDS[kind].homeSet, r.url);
      if (h) return h;
    }
  } catch (e) {
    dlog.debug(`no ${kind} home set at ${principalUrl}: ${e.message}`);
  }
  return '';
}

/** One multistatus row → a collection, or null if it is not one of ours (the
 *  home set itself, an inbox/outbox, a task list, a notification collection). */
function toCollection(row, kind) {
  if (!isKind(row.props, kind)) return null;
  const priv = privilegesOf(row.props);
  const comps = kind === 'caldav' ? componentsOf(row.props) : null;
  if (comps && !comps.includes('VEVENT')) return null; // a VTODO-only list is not a calendar
  return {
    url: row.url,
    href: row.href,
    displayName: textOf(row.props.displayname) || decodeURIComponent(row.href.replace(/\/$/, '').split('/').pop() || '') || row.href,
    description: textOf(row.props['calendar-description'] || row.props['addressbook-description']),
    color: kind === 'caldav' ? colorOf(row.props) : '',
    order: Number(textOf(row.props['calendar-order'])) || 0,
    ctag: textOf(row.props.getctag),
    syncToken: textOf(row.props['sync-token']),
    components: comps,
    // An empty privilege set means the server did not report one. Assuming
    // writable there is the forgiving reading — the write itself will be
    // refused with a 403 that says so — and assuming read-only would make
    // several servers that simply omit this property permanently uneditable.
    readOnly: priv.size > 0 && ![...priv].some((p) => WRITE_PRIVILEGES.has(p)),
  };
}

/**
 * Everything these credentials can see, from whatever the user typed.
 *
 * Returns `{ principalUrl, homeUrl, collections, via }`. `via` names the step
 * that actually produced the answer ('well-known' | 'url' | 'direct'), which is
 * the one piece of diagnostic worth showing in Settings when a server only
 * half-works.
 *
 * Never partially throws: a server that answers the collection listing but not
 * the principal still yields collections, because that listing is the only part
 * anybody needs.
 */
export async function discover(client, { url, kind }) {
  if (!KINDS[kind]) throw new Error(`Unknown DAV kind: ${kind}`);
  const base = normalizeBase(url);
  const origin = new URL(base).origin;
  const wellKnown = origin + KINDS[kind].wellKnown;

  // Order matters. The typed URL comes first because a person who pasted the
  // collection or the principal directly gets the right answer in one request,
  // and because on a server hosted under a path (`https://host/nextcloud/`) the
  // origin's `.well-known` belongs to a different application entirely.
  let via = 'url';
  let principalUrl = await findPrincipal(client, [base]);
  if (!principalUrl) {
    principalUrl = await findPrincipal(client, [wellKnown]);
    if (principalUrl) via = 'well-known';
  }

  let homeUrl = principalUrl ? await findHome(client, principalUrl, kind) : '';

  // Neither worked, or the principal has no home set of this kind: the URL the
  // user gave may itself be the home set, or a single collection. Both are
  // common enough to be worth one more request rather than an error.
  if (!homeUrl) { homeUrl = base; via = principalUrl ? via : 'direct'; }

  let rows = [];
  try {
    rows = await client.propfind(homeUrl, collectionProps(kind), 1);
  } catch (e) {
    // A Depth:1 refusal on what turned out to be a single collection is the
    // usual cause; ask about that one resource instead before giving up.
    dlog.debug(`Depth:1 on ${homeUrl} failed (${e.message}) — trying it as a single collection`);
    rows = await client.propfind(homeUrl, collectionProps(kind), 0);
    via = 'direct';
  }

  let found = rows.map((r) => toCollection(r, kind)).filter(Boolean);

  // Nothing matched, but the request itself succeeded. The usual cause is that
  // `homeUrl` IS a collection and this server answers a Depth:1 listing of it
  // with minimal properties for the collection itself (only its children get
  // the full set). Asking about that one resource directly is one more request
  // and the difference between "your address book is empty" and it working.
  if (!found.length && rows.length) {
    try {
      const self = await client.propfind(homeUrl, collectionProps(kind), 0);
      found = self.map((r) => toCollection(r, kind)).filter(Boolean);
      if (found.length) via = 'direct';
    } catch (e) {
      dlog.debug(`Depth:0 retry on ${homeUrl} failed: ${e.message}`);
    }
  }

  const collections = found
    .sort((a, b) => (a.order || 0) - (b.order || 0) || a.displayName.localeCompare(b.displayName));

  dlog.info(`${kind}: ${collections.length} collection(s) at ${homeUrl} (via ${via})`);
  return { principalUrl, homeUrl, collections, via };
}

/** What the user typed, made into something `new URL()` will accept. A bare
 *  host is overwhelmingly meant as https — DAV over plain http would send the
 *  password in the clear, so it is never assumed. */
export function normalizeBase(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('No server address given');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (!u.pathname) u.pathname = '/';
  return u.href;
}

/** A `calendar-multiget` / `addressbook-multiget` body for specific hrefs.
 *  Lives here rather than in the per-protocol files because the two differ only
 *  in the element and namespace names, and having written it twice once is
 *  exactly how they drift. */
export function multigetBody(kind, hrefs, extraProps = '') {
  const k = kind === 'caldav'
    ? { ns: 'urn:ietf:params:xml:ns:caldav', report: 'calendar-multiget', data: 'calendar-data' }
    : { ns: 'urn:ietf:params:xml:ns:carddav', report: 'addressbook-multiget', data: 'address-data' };
  return `<?xml version="1.0" encoding="utf-8"?>
<X:${k.report} xmlns="DAV:" xmlns:X="${k.ns}">
  <prop><getetag/>${extraProps}<X:${k.data}/></prop>
${hrefs.map((h) => `  <href>${xmlEscape(h)}</href>`).join('\n')}
</X:${k.report}>`;
}
