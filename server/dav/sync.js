// Hmelj — "what changed in this collection since last time", for CalDAV and
// CardDAV alike.
//
// Two mechanisms exist, and which one a server offers is not something a user
// can be asked about, so both are implemented and the better one is used when
// it is there:
//
//   sync-collection (RFC 6578)  One REPORT carrying the token from last run.
//                               The server answers with only what changed —
//                               including DELETIONS, as 404 responses, which is
//                               the part nothing else can tell you — plus a new
//                               token. Costs one small request per poll no
//                               matter how large the collection is.
//
//   ETag diff                   PROPFIND Depth:1 for every href and ETag, then
//                               compare against what we hold. Correct, and
//                               costs a listing of the whole collection each
//                               time. Deletions fall out of the comparison:
//                               anything we know about that is no longer listed
//                               is gone.
//
// CTag (`calendarserver.org:getctag`) is the cheap gate in front of the second:
// one value for the whole collection that changes whenever anything in it does.
// Unchanged CTag means the ETag listing can be skipped entirely, which is what
// makes a five-minute poll over a dozen collections nearly free.
//
// ── The failure that has to be handled, not just logged ──────────────────────
// A sync token EXPIRES. Servers keep a bounded change history — hours on some,
// a fixed number of changes on others — and once a token falls off the end the
// REPORT comes back 403 with a `valid-sync-token` precondition. That is not an
// error: it means "start over", and a client that treats it as a failure stops
// syncing permanently, silently, days after it was set up. Handled below by
// falling through to a full listing and reporting `full: true` so the caller
// knows to treat what it got as the complete truth rather than a delta.
import { multigetBody } from './discover.js';
import { normalizeEtag, statusCode, textOf, asArray, xmlEscape } from './client.js';
import { log } from '../log.js';

const slog = log.scope('dav-sync');

/** How many hrefs go into one multiget. Bodies are cheap but not free, and
 *  several servers cap either the request size or the number of hrefs; 50 is
 *  below every documented limit and still turns a 900-contact first sync into
 *  18 requests rather than 900. */
const MULTIGET_BATCH = 50;

const KIND = {
  caldav: { ns: 'urn:ietf:params:xml:ns:caldav', data: 'calendar-data' },
  carddav: { ns: 'urn:ietf:params:xml:ns:carddav', data: 'address-data' },
};

/** A collection listing: every item's href and ETag, and nothing else. The
 *  cheapest question DAV can be asked about a whole collection. */
async function listEtags(client, url) {
  const rows = await client.propfind(url, '<getetag/><resourcetype/>', 1);
  const out = new Map();
  for (const r of rows) {
    // The collection itself comes back in its own Depth:1 listing. It has a
    // resourcetype and no ETag; an item has the opposite.
    const rt = r.props?.resourcetype;
    if (rt && typeof rt === 'object' && ('collection' in rt)) continue;
    const etag = normalizeEtag(textOf(r.props?.getetag));
    if (!etag) continue;
    out.set(r.href, etag);
  }
  return out;
}

/** The collection's CTag, or ''. One value for the whole collection: unchanged
 *  means nothing inside it changed, and the poll can stop here. */
export async function readCtag(client, url) {
  try {
    const rows = await client.propfind(url, '<CS:getctag/><sync-token/>', 0);
    const p = rows[0]?.props || {};
    return { ctag: textOf(p.getctag), syncToken: textOf(p['sync-token']) };
  } catch (e) {
    slog.debug(`ctag read failed for ${url}: ${e.message}`);
    return { ctag: '', syncToken: '' };
  }
}

/** Does this 403 mean "your sync token is too old", rather than "you may not do
 *  that"? RFC 6578 names the precondition; servers report it with wildly
 *  different wording around it, so the element name is what is matched. */
function isExpiredToken(e) {
  return e?.status === 403 && /valid-sync-token/i.test(String(e.responseBody || ''));
}

async function syncCollectionReport(client, url, token) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<sync-collection xmlns="DAV:">
  <sync-token>${xmlEscape(token || '')}</sync-token>
  <sync-level>1</sync-level>
  <prop><getetag/></prop>
</sync-collection>`;
  const { rows, syncToken } = await client.report(url, body, 1);
  const changed = [];
  const removed = [];
  for (const r of rows) {
    // A response with a 404 status and no propstat is a deletion. This is the
    // only signal in either protocol that says an item is GONE as opposed to
    // simply not matching a query, which is why sync-collection is worth
    // preferring wherever it exists.
    if (r.status === 404 || r.status === 410) { removed.push(r.href); continue; }
    const etag = normalizeEtag(textOf(r.props?.getetag));
    if (etag) changed.push({ href: r.href, etag });
  }
  return { changed, removed, syncToken };
}

/**
 * What changed in one collection.
 *
 * `known` is the caller's current view — an href → ETag map — and is used only
 * by the ETag-diff path. Pass what you hold; the sync-collection path ignores
 * it, and on a `full` result the caller must reconcile against the returned
 * listing rather than trusting its own.
 *
 * Returns `{ changed, removed, syncToken, ctag, method, full, unchanged }`.
 * `changed` is `[{href, etag}]` — bodies are NOT fetched here, because on a
 * poll that found nothing there is nothing to fetch, and on a first sync the
 * caller wants to batch them (see `fetchItems`).
 */
export async function syncCollection(client, {
  url, kind = 'carddav', syncToken = '', ctag = '', known = new Map(), force = false,
} = {}) {
  const head = await readCtag(client, url);

  // The cheap gate. Only trusted when we have BOTH a previous ctag and a
  // previous token/listing to be consistent with — a ctag that matches but no
  // token means the last run never completed, and skipping would strand the
  // collection empty forever.
  if (!force && ctag && head.ctag && head.ctag === ctag && (syncToken || known.size)) {
    return { changed: [], removed: [], syncToken, ctag, method: 'ctag', full: false, unchanged: true };
  }

  if (syncToken) {
    try {
      const r = await syncCollectionReport(client, url, syncToken);
      // A server that answers the REPORT but returns no new token has given us
      // no way to continue incrementally; keep the ctag so the gate above still
      // works, and the next run starts a fresh token.
      return {
        ...r, ctag: head.ctag, method: 'sync-collection', full: false, unchanged: !r.changed.length && !r.removed.length,
      };
    } catch (e) {
      if (!isExpiredToken(e)) throw e;
      slog.info(`${url}: sync token expired — re-reading the whole collection`);
    }
  }

  // No usable token: either the first sync, a server without RFC 6578, or a
  // token that just expired. Ask for a fresh token at the same time, so the
  // NEXT run can be incremental even though this one could not be.
  if (head.syncToken || !syncToken) {
    try {
      const r = await syncCollectionReport(client, url, '');
      if (r.syncToken) {
        // An initial sync-collection returns every item, so this IS the full
        // truth — the caller must drop anything it holds that is not here.
        return { ...r, ctag: head.ctag, method: 'sync-collection', full: true, unchanged: false };
      }
    } catch (e) {
      if (!isExpiredToken(e)) slog.debug(`${url}: no sync-collection support (${e.message}) — falling back to ETag comparison`);
    }
  }

  const listing = await listEtags(client, url);
  const changed = [];
  for (const [href, etag] of listing) {
    if (known.get(href) !== etag) changed.push({ href, etag });
  }
  const removed = [...known.keys()].filter((href) => !listing.has(href));
  // `full: false`, deliberately, even though this DID read the whole collection.
  // `full` does not mean "a complete listing" — it means "`changed` is every
  // item that exists, so anything absent from it is deleted". Here `removed` is
  // computed directly and is authoritative, and `changed` holds only what
  // differs; a caller that also swept everything absent from `changed` would
  // delete every unchanged contact in the book on the first quiet poll.
  return {
    changed, removed, syncToken: head.syncToken || '', ctag: head.ctag,
    method: 'etag-diff', full: false, unchanged: !changed.length && !removed.length,
  };
}

/**
 * The bodies for a list of hrefs, in batches, as `[{href, etag, data}]`.
 *
 * multiget rather than one GET per item: 900 contacts is 900 round trips the
 * other way, and on a first sync over a slow link that is the difference
 * between twenty seconds and ten minutes.
 *
 * A batch that fails does not take the run down with it — the remaining items
 * are still fetched and the failure is counted. A collection with one item the
 * server cannot serialize (it happens; a corrupted card on a Nextcloud) would
 * otherwise block every sync of that collection forever.
 */
export async function fetchItems(client, url, kind, hrefs, { batchSize = MULTIGET_BATCH } = {}) {
  const k = KIND[kind];
  if (!k) throw new Error(`Unknown DAV kind: ${kind}`);
  const out = [];
  let failed = 0;
  for (let i = 0; i < hrefs.length; i += batchSize) {
    const batch = hrefs.slice(i, i + batchSize);
    let rows;
    try {
      ({ rows } = await client.report(url, multigetBody(kind, batch), 1));
    } catch (e) {
      failed += batch.length;
      slog.warn(`${url}: multiget of ${batch.length} item(s) failed — ${e.message}`);
      continue;
    }
    for (const r of rows) {
      const data = textOf(r.props?.[k.data]);
      if (!data) { failed++; continue; }
      out.push({ href: r.href, url: r.url, etag: normalizeEtag(textOf(r.props?.getetag)), data });
    }
  }
  return { items: out, failed };
}

/** Everything in a collection, for a caller that has nothing yet. Kept separate
 *  from syncCollection so a "re-download this collection from scratch" action in
 *  Settings has something to call that cannot accidentally be incremental. */
export async function fetchAll(client, url, kind) {
  const listing = await listEtags(client, url);
  const { items, failed } = await fetchItems(client, url, kind, [...listing.keys()]);
  const head = await readCtag(client, url);
  return { items, failed, ctag: head.ctag, syncToken: head.syncToken };
}

/** Exported for the test suite, which drives the two paths against a mock
 *  server and needs to assert which one ran. */
export const _internals = { listEtags, isExpiredToken, statusCode, asArray };
