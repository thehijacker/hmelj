// Hmelj — the HTTP half of CalDAV and CardDAV.
//
// One transport for both protocols, because they ARE one protocol: RFC 4918
// WebDAV, with RFC 4791 adding calendar collections and RFC 6352 address books.
// The only thing that differs between them is which XML elements go in the body,
// so nothing above this file needs a second client.
//
// ── Why not reuse an existing transport ──────────────────────────────────────
// ewsClient.js goes through `httpntlm` because Exchange needs NTLM; graphClient.js
// uses `fetch` but hard-codes Graph's base URL, its OAuth refresh and its error
// shapes. DAV needs neither NTLM nor Graph, and it needs three things neither of
// them has: request methods `fetch` will happily send but nothing here used
// before (PROPFIND, REPORT, MKCALENDAR), a `Depth` header, and 207 Multi-Status —
// a success code carrying a per-resource result, where an ordinary client sees
// one status and stops.
//
// ── Namespace prefixes ───────────────────────────────────────────────────────
// Every server picks its own: `<D:multistatus>`, `<d:multistatus>`,
// `<multistatus xmlns="DAV:">`. Matching on the prefix is how DAV clients break
// on the third server they meet, so this strips prefixes entirely
// (`removeNSPrefix`, the same setting ewsClient.js already uses) and matches on
// local names. The trade is real and worth stating: two different namespaces
// with the same local name would collide. Across everything Hmelj reads —
// DAV:, CalDAV, CardDAV, calendarserver.org (getctag) and apple.com/ns/ical
// (calendar-color) — no local name is used by two of them, and a new one must be
// checked against that list before it is read here.
//
// ── Values are never coerced ─────────────────────────────────────────────────
// `parseTagValue: false`. An ETag of `"12345"`, a sync-token that happens to be
// all digits, an href — every one of them is an opaque string that must come
// back exactly as sent, and a parser that helpfully turns it into a number
// produces a conditional request the server rejects with 412 and no explanation.
import { XMLParser } from 'fast-xml-parser';
import { log } from '../log.js';

const dlog = log.scope('dav');

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // A collection with exactly one child would otherwise parse as an object and
  // one with two as an array, and every caller would need to handle both. These
  // are the elements that legitimately repeat.
  isArray: (name) => ['response', 'propstat', 'href'].includes(name),
});

/** XML text escaping. `'` and `"` included: a href or a filter value goes into
 *  an attribute often enough that leaving them out is a bug waiting for the
 *  first contact whose name has an apostrophe in it. */
export function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Every element in a parsed subtree, whether it came back as one object, an
 *  array, or nothing at all. Same helper ewsClient.js needs for the same reason. */
export function asArray(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }

/** The text of a parsed node, which fast-xml-parser gives as a bare string when
 *  the element has no attributes and as `{'#text': …}` when it has. */
export function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && '#text' in v) return String(v['#text']);
  return '';
}

/** `HTTP/1.1 200 OK` → 200. A propstat's status is the only thing that says
 *  whether the property beside it was actually returned or merely asked for:
 *  every server answers a PROPFIND for a property it does not have with a 404
 *  propstat rather than by omitting it. */
export function statusCode(s) {
  const m = /\s(\d{3})\s/.exec(' ' + String(s ?? '') + ' ');
  return m ? Number(m[1]) : 0;
}

/**
 * An error carrying the HTTP status, so callers can tell the three cases apart
 * that matter: 401 (credentials), 403/404 (this collection, right now) and
 * 412 (somebody else changed the item — a real conflict, never something to
 * retry over).
 */
export class DavError extends Error {
  constructor(message, { status = 0, method = '', url = '', body = '' } = {}) {
    super(message);
    this.name = 'DavError';
    this.status = status;
    this.method = method;
    this.url = url;
    this.responseBody = body;
    // Surfaced by server/index.js's `wrap()` as the response status when it is
    // one a client can act on; anything else becomes a 502, since a failure
    // talking to somebody else's server is not this request being malformed.
    this.httpStatus = status === 401 || status === 403 || status === 404 || status === 409 || status === 412 ? status : 502;
  }
}

const DEFAULT_TIMEOUT_MS = 30e3;
const MAX_REDIRECTS = 5;

/**
 * A client bound to one account's credentials.
 *
 * `auth` is a function returning the Authorization header value, called per
 * request rather than once, so an OAuth token that expires mid-sync is picked up
 * on the next call instead of failing every remaining request. `reauth`, when
 * given, is invoked once on a 401 to refresh and the request is retried — which
 * is the only case where retrying a 401 is right, and exactly why it is opt-in.
 */
export function createClient({ auth, reauth = null, timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = 'Hmelj' } = {}) {
  async function raw(method, url, { body = null, headers = {}, retried = false, redirects = 0 } = {}) {
    const h = {
      'User-Agent': userAgent,
      ...(body ? { 'Content-Type': 'application/xml; charset=utf-8' } : {}),
      ...headers,
    };
    const authValue = await auth?.();
    if (authValue) h.Authorization = authValue;

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: h,
        body,
        // Followed by hand below. `fetch`'s own following turns a 301/302 on a
        // PROPFIND into a GET (per the Fetch spec's method rewrite), which a DAV
        // server answers with the collection's HTML index page — a 200 carrying
        // something that will never parse, instead of a redirect we could see.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const why = e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : (e?.cause?.message || e.message);
      throw new DavError(`${method} ${url} failed — ${why}`, { method, url });
    }

    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get('location');
      if (!to) throw new DavError(`${method} ${url} redirected with no Location header`, { status: res.status, method, url });
      if (redirects >= MAX_REDIRECTS) throw new DavError(`${method} ${url} redirected more than ${MAX_REDIRECTS} times`, { status: res.status, method, url });
      const next = new URL(to, url).href;
      dlog.debug(`${method} ${url} → ${res.status} ${next}`);
      // The METHOD is preserved. That is the whole point of following these by
      // hand — .well-known bootstrap (RFC 6764) is a 301 onto the real principal
      // path, and it has to stay a PROPFIND to be worth following.
      return raw(method, next, { body, headers, retried, redirects: redirects + 1 });
    }

    if (res.status === 401 && reauth && !retried) {
      dlog.debug(`${method} ${url} → 401, refreshing credentials and retrying once`);
      if (await reauth()) return raw(method, url, { body, headers, retried: true, redirects });
    }

    const text = await res.text().catch(() => '');
    if (res.status >= 400) {
      throw new DavError(explain(res.status, method, url, text), { status: res.status, method, url, body: text });
    }
    return { status: res.status, headers: res.headers, text, url };
  }

  /**
   * PROPFIND with a body naming the properties wanted. `depth` is 0 for the
   * resource itself and 1 for its immediate children — never `infinity`, which
   * several servers refuse outright and the rest answer slowly enough to time
   * out on a large address book.
   */
  async function propfind(url, propsXml, depth = 0) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CR="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/" xmlns:IC="http://apple.com/ns/ical/">
  <prop>${propsXml}</prop>
</propfind>`;
    const res = await raw('PROPFIND', url, { body, headers: { Depth: String(depth) } });
    return parseMultistatus(res.text, res.url);
  }

  /**
   * REPORT — the query verb. Its body is entirely protocol-specific, so it is
   * passed through whole and only the multistatus handling is shared.
   *
   * Returns `{ rows, syncToken }` rather than bare rows because a
   * `sync-collection` REPORT carries its answer in TWO places: the per-resource
   * rows, and a `<sync-token>` on the multistatus itself that is the handle for
   * the next run. A client that reads only the rows re-syncs everything, every
   * time, forever.
   */
  async function report(url, bodyXml, depth = 1) {
    const res = await raw('REPORT', url, { body: bodyXml, headers: { Depth: String(depth) } });
    return { rows: parseMultistatus(res.text, res.url), syncToken: parseSyncToken(res.text) };
  }

  /** OPTIONS — what this server supports, from the `DAV:` header
   *  (`calendar-access`, `addressbook`) and `Allow`. Never fatal: some servers
   *  answer OPTIONS on a collection with 405 and work perfectly otherwise, so
   *  discovery treats an empty answer as "unknown", not "unsupported". */
  async function options(url) {
    try {
      const res = await raw('OPTIONS', url);
      const compliance = (res.headers.get('dav') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const allow = (res.headers.get('allow') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      return { compliance, allow };
    } catch (e) {
      dlog.debug(`OPTIONS ${url} failed (${e.status || '-'}) — treating support as unknown`);
      return { compliance: [], allow: [] };
    }
  }

  /** One item's body plus its ETag. The ETag is what every later conditional
   *  write is built on, so a server that omits it is worth knowing about. */
  async function get(url) {
    const res = await raw('GET', url, { headers: { Accept: '*/*' } });
    return { body: res.text, etag: normalizeEtag(res.headers.get('etag')) };
  }

  /**
   * Writes one item. `etag` makes it conditional:
   *   - a string → `If-Match`, i.e. "only if it is still what I read". A 412
   *     means somebody else changed it, and is surfaced as such rather than
   *     retried, because retrying a conditional write is how the other person's
   *     edit gets destroyed.
   *   - `null` → `If-None-Match: *`, i.e. "only if it does not exist yet". This
   *     is what makes creating a contact safe against a second client that
   *     happened to pick the same UID.
   *   - `undefined` → unconditional. Only for a caller that has already decided
   *     to overwrite.
   */
  async function put(url, body, { etag, contentType } = {}) {
    const headers = { 'Content-Type': contentType || 'text/plain; charset=utf-8' };
    if (typeof etag === 'string' && etag) headers['If-Match'] = etag;
    else if (etag === null) headers['If-None-Match'] = '*';
    const res = await raw('PUT', url, { body, headers });
    // A server MAY answer a PUT with the new ETag and MAY not. When it doesn't,
    // the caller has to re-read the item to learn it — reporting null here is
    // what tells it to, rather than storing an empty string that would silently
    // turn the next conditional write into an unconditional one.
    return { etag: normalizeEtag(res.headers.get('etag')), status: res.status };
  }

  async function del(url, { etag } = {}) {
    const headers = {};
    if (typeof etag === 'string' && etag) headers['If-Match'] = etag;
    await raw('DELETE', url, { headers });
    return true;
  }

  return { raw, propfind, report, options, get, put, del };
}

/** Basic auth for a username/password source. Built once per request by the
 *  `auth` callback above rather than stored as a header, so a password changed
 *  in Settings takes effect on the next call. */
export function basicAuth(username, password) {
  return () => 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

/** Bearer auth for an OAuth source. `getToken` is async because the token may
 *  need refreshing first — see server/oauth.js. */
export function bearerAuth(getToken) {
  return async () => {
    const t = await getToken();
    return t ? `Bearer ${t}` : '';
  };
}

/** ETags are compared as opaque strings, so the only normalisation is dropping
 *  the weak-comparison marker: a server that answers `W/"abc"` on GET and
 *  `"abc"` on PROPFIND (several do) would otherwise look like it had changed
 *  every item on every sync. */
export function normalizeEtag(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return s.replace(/^W\//i, '');
}

/**
 * A 207 Multi-Status into flat rows.
 *
 * The shape that matters: each `<response>` carries one `<href>` and one or more
 * `<propstat>`, and each propstat has its OWN status. A property that came back
 * 404 is one this server does not have — which is not an error, it is the answer
 * — so only 2xx propstats contribute to `props`, and the rest are recorded in
 * `missing` for a caller that wants to know the difference between "empty" and
 * "not supported here".
 *
 * `href` is kept as sent AND resolved against the request URL: the raw one is
 * what a later multiget must quote back verbatim, the resolved one is what a
 * GET needs. Servers send both absolute URLs and bare paths, and quoting the
 * wrong one back is a 404 on half of them.
 */
export function parseMultistatus(text, baseUrl = '') {
  const doc = xml.parse(text || '');
  const ms = doc?.multistatus;
  if (!ms) return [];
  const out = [];
  for (const r of asArray(ms.response)) {
    const rawHref = textOf(asArray(r.href)[0]);
    if (!rawHref) continue;
    const row = {
      href: rawHref,
      url: baseUrl ? safeResolve(rawHref, baseUrl) : rawHref,
      status: statusCode(r.status),
      props: {},
      missing: [],
    };
    for (const ps of asArray(r.propstat)) {
      const code = statusCode(ps.status);
      const prop = ps.prop || {};
      if (code >= 200 && code < 300) Object.assign(row.props, prop);
      else row.missing.push(...Object.keys(prop));
    }
    out.push(row);
  }
  return out;
}

/** The `<sync-token>` a sync-collection REPORT returns on the multistatus
 *  element itself (RFC 6578 §3.2) — opaque, and to be handed straight back on
 *  the next run. */
export function parseSyncToken(text) {
  const doc = xml.parse(text || '');
  return textOf(doc?.multistatus?.['sync-token']) || '';
}

function safeResolve(href, base) {
  try { return new URL(href, base).href; } catch { return href; }
}

/**
 * What went wrong, in words a self-hoster can act on.
 *
 * The generic version of this ("Request failed with status 403") is the reason
 * DAV setup is miserable: every one of these has exactly one likely cause and
 * naming it is the difference between a two-minute fix and giving up.
 */
function explain(status, method, url, body) {
  // `full` is for RECOGNISING what happened, `detail` for quoting it back. They
  // are different lengths on purpose: Google's 403 runs well past 200
  // characters, and matching against the truncated copy means the giveaway
  // word can fall off the end of the string that decides the answer.
  const full = String(body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const detail = full.slice(0, 200);
  const tail = detail ? ` — ${detail}` : '';
  switch (status) {
    case 401:
      return `The server rejected the credentials for ${url}. For a provider with two-factor authentication (iCloud, Fastmail, a Nextcloud with 2FA on) the account password will always be refused here — those need an app-specific password generated in that provider's own settings.${tail}`;
    case 403: {
      // Google answers a 403 for a cause that has nothing to do with the
      // principal: the DAV API is not switched on in the Cloud project the
      // OAuth client belongs to. It is one click to fix and impossible to guess
      // from "refused access", so it gets its own answer — including the
      // project number Google itself names, which is what the console URL needs.
      const proj = /project (\d+)/.exec(full)?.[1] || '';
      // Google has said this several ways over the years — "accessNotConfigured",
      // "Access Not Configured.", "has not been used in project … before or it
      // is disabled", "is not enabled for project". All four mean the same one
      // click, so all four are recognised; each is specific enough that no
      // other server's 403 wanders in here.
      if (/accessNotConfigured|access not configured|has not been used in project|is disabled|is not enabled for project/i.test(full)) {
        // CalDAV and CardDAV are two SEPARATE APIs in the Cloud console, each
        // enabled on its own. This used to name CalDAV whatever had failed,
        // which sent anyone adding an address book to enable the calendar API
        // and then watch contacts fail in exactly the same way — the report
        // that prompted this said "a caldav api is enabled".
        //
        // Google names the API in its own message ("Google Contacts CardDAV
        // API has not been used in project …"), and the request URL says the
        // same thing independently (contacts go to /carddav/v1/, calendars to
        // /caldav/v2/), so a reworded message still lands on the right one.
        const card = /carddav/i.test(full) || /\/carddav\//i.test(url);
        const api = card ? 'CardDAV API' : 'CalDAV API';
        const host = card ? 'carddav.googleapis.com' : 'caldav.googleapis.com';
        return `Google refused this because the ${api} is switched off in the Google Cloud project your OAuth client belongs to${proj ? ` (project ${proj})` : ''}. `
          + `Enable "${api}" at https://console.cloud.google.com/apis/library/${host}`
          + `${proj ? `?project=${proj}` : ''}, wait a minute for it to take effect, and add the `
          + `${card ? 'address book' : 'calendar'} again. `
          + 'CalDAV and CardDAV are separate APIs there — enabling one does not enable the other. '
          // No `tail` here, deliberately: Google's own sentence ends in the
          // same advice, and quoting 200 characters of it chops its console URL
          // in half ("…/apis/a"), which reads like the message itself is broken.
          + 'This is a setting on your own Google project, not on the account.';
      }
      return `The server accepted the sign-in but refused access to ${url}. Usually the wrong principal: the collection belongs to another account on the same server.${tail}`;
    }
    case 404:
      return `${url} does not exist on the server. If this was discovered automatically it has since been deleted or renamed; if it was typed in, the path is usually the collection itself, not the account's home page.${tail}`;
    case 405:
      return `The server does not allow ${method} on ${url}. This is what a plain web server answers when the address points at an ordinary web page rather than a CalDAV/CardDAV endpoint.${tail}`;
    case 412:
      return `${url} was changed by somebody else since Hmelj last read it, so this write was refused rather than overwriting theirs.${tail}`;
    case 507:
      return `The server is out of storage for ${url}.${tail}`;
    default:
      return `${method} ${url} failed with HTTP ${status}.${tail}`;
  }
}
