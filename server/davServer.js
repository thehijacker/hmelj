// Hmelj — the other direction: Hmelj as a CalDAV and CardDAV server.
//
// Everything else in server/dav/ talks TO somebody's server. This answers. A
// phone, Thunderbird or Apple Calendar can subscribe to a Hmelj calendar or
// address book the same way it subscribes to a Nextcloud one.
//
// ── The URL layout ──────────────────────────────────────────────────────────
//   /dav/                               the service root
//   /dav/p/<uKey>/                      the principal
//   /dav/p/<uKey>/cal/                  calendar home set
//   /dav/p/<uKey>/cal/<pubId>/          one published calendar
//   /dav/p/<uKey>/cal/<pubId>/<n>.ics   one event
//   /dav/p/<uKey>/card/…                the same for address books
//
// The user key is in the path so a client has a stable URL to store, and it is
// not a secret — it is a slug of the username with a hash suffix. Authorisation
// is entirely separate: the credential decides, and a credential for one user
// cannot read another's path however it is spelled.
//
// ── Authentication ──────────────────────────────────────────────────────────
// HTTP Basic against an APP PASSWORD only (server/appPasswords.js). The Hmelj
// login password is never accepted here — see that file's header for why that
// distinction is the whole point rather than a nicety.
//
// ── What is deliberately not implemented ────────────────────────────────────
// `sync-collection` (RFC 6578). Serving it correctly needs a per-collection
// change log with tombstones, and answering it INCORRECTLY is worse than not
// offering it: a client that trusts a token which silently skipped a deletion
// keeps showing a cancelled meeting forever. It is therefore left out of
// `supported-report-set`, and clients fall back to comparing the CTag and then
// ETags — which is exactly what Hmelj's own client does against servers that
// lack it (see server/dav/sync.js), and which is correct, just chattier.
//
// Also absent: locking (no client requires it), MKCALENDAR (a calendar is
// created in Hmelj, not by a subscriber), and free/busy scheduling.
import crypto from 'node:crypto';
import express from 'express';
import * as appPasswords from './appPasswords.js';
import * as davPublish from './davPublish.js';
import * as calendarStore from './calendarStore.js';
import * as contactSources from './contactSources.js';
import * as calendarBackends from './calendar/index.js';
import * as cache from './cache.js';
import { store } from './store.js';
import { xmlEscape } from './dav/client.js';
import { parseCalendar, patchEvent } from './icalendar.js';
import { newCard, serializeCard } from './vcard.js';
import { userKey, runAsUser, listUsers, loginAllowed, loginFailed, loginSucceeded } from './session.js';
import { log } from './log.js';

const dlog = log.scope('dav-server');

const NS = 'xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CR="urn:ietf:params:xml:ns:carddav"'
  + ' xmlns:CS="http://calendarserver.org/ns/" xmlns:IC="http://apple.com/ns/ical/"';

const etagOf = (text) => `"${crypto.createHash('sha1').update(text).digest('hex').slice(0, 24)}"`;

/* ---------------- what a published collection contains ---------------- */

/**
 * Masks an event down to the fact that the time is taken.
 *
 * The "partly joined" half of the feature: a household calendar can show that
 * Thursday afternoon is busy without showing who you are seeing. Done by
 * PATCHING the stored document rather than rebuilding it, so nothing depends on
 * this file understanding every property an event might carry — anything not
 * named here is removed outright, which is the safe direction for a mask.
 */
function maskBusy(ical) {
  return patchEvent(ical, {
    SUMMARY: 'SUMMARY:Busy',
    LOCATION: null,
    DESCRIPTION: null,
    ATTENDEE: null,
    ORGANIZER: null,
    URL: null,
    ATTACH: null,
    CATEGORIES: null,
    'X-ALT-DESC': null,
  });
}

/** Members of a published CALENDAR, as `{name, ical, etag, calendarId, uid}`. */
function calendarMembers(uKey, pub) {
  const sources = davPublish.resolveSourcesFor(uKey, pub);
  const out = [];
  for (const src of sources) {
    const calId = src.calendar.calendar.id;
    // Everything the calendar holds, which for a subscriber is the right answer:
    // a client asks for a time range with a REPORT, and PROPFIND enumerates.
    const rows = cache.calendarCandidates(uKey, [calId], -8.64e15, 8.64e15);
    for (const row of rows) {
      // Only masters and their exceptions that carry a document. A Graph or EWS
      // row has no iCalendar of its own (see graphCalendar.js), so a
      // publication of one has nothing to serve — it is skipped rather than
      // serving an empty file.
      if (!row.ical) continue;
      const ical = src.detail === 'busy' ? maskBusy(row.ical) : row.ical;
      // An aggregate can hold two calendars with colliding UIDs, so the member
      // name carries which calendar it came from. A single publication does not
      // need that and keeps the plain uid, which is what a client expects to
      // find after it PUTs one.
      const name = pub.mode === 'aggregate'
        ? `${encodeURIComponent(`${calId.slice(0, 8)}~${row.uid}`)}.ics`
        : `${encodeURIComponent(row.uid)}.ics`;
      if (out.some((m) => m.name === name)) continue; // a master and its exceptions share one document
      out.push({ name, ical, etag: etagOf(ical), calendarId: calId, uid: row.uid, sourceId: row.source_id });
    }
  }
  return out;
}

/** Members of a published ADDRESS BOOK. */
function addressbookMembers(uKey, pub) {
  const out = [];
  for (const src of pub.sources) {
    if (src.sourceId === 'local-contacts') {
      // contacts.json is `{id, name, email}` and has no vCard of its own, so
      // one is synthesised. Its UID is the stored contact id, which is stable,
      // so a subscriber sees the same card across polls rather than a new one
      // every time.
      for (const c of store.getContactsFor(uKey)) {
        if (!String(c.email || '').includes('@')) continue;
        const vcf = serializeCard(newCard({ name: c.name || '', emails: [{ email: c.email }], uid: c.id }));
        out.push({ name: `${encodeURIComponent(c.id)}.vcf`, vcf, etag: etagOf(vcf), uid: c.id });
      }
      continue;
    }
    for (const source of contactSources.rawSourcesFor(uKey)) {
      const book = (source.books || []).find((b) => b.id === src.bookId);
      if (!book) continue;
      const stored = contactSources.readBookFor(uKey, source.id, book.id);
      for (const card of Object.values(stored.cards || {})) {
        if (!card.vcard) continue;
        const uid = card.uid || card.href;
        const name = pub.mode === 'aggregate'
          ? `${encodeURIComponent(`${book.id.slice(0, 8)}~${uid}`)}.vcf`
          : `${encodeURIComponent(uid)}.vcf`;
        if (out.some((m) => m.name === name)) continue;
        out.push({ name, vcf: card.vcard, etag: etagOf(card.vcard), uid });
      }
    }
  }
  return out;
}

const membersOf = (uKey, pub) => (pub.kind === 'calendar' ? calendarMembers(uKey, pub) : addressbookMembers(uKey, pub));

/**
 * One member by the name in the URL.
 *
 * Compared DECODED on both sides. A member's stored name is percent-encoded
 * (a UID routinely contains an `@`, and may contain a `/`), while parsePath
 * decodes every path segment — comparing the two as they stand made every GET
 * of an event 404 while PROPFIND listed it perfectly.
 */
function findMember(members, name) {
  const wanted = decodeURIComponent(String(name || ''));
  return members.find((m) => decodeURIComponent(m.name) === wanted) || null;
}

/** The CTag: one value for the whole collection that changes whenever anything
 *  in it does. Derived from the members rather than stored, so it cannot drift
 *  from what is actually served — and it is what makes a subscriber's poll one
 *  cheap request when nothing has changed. */
function ctagOf(members) {
  const h = crypto.createHash('sha1');
  for (const m of [...members].sort((a, b) => a.name.localeCompare(b.name))) h.update(`${m.name}:${m.etag}\n`);
  return `"${h.digest('hex').slice(0, 24)}"`;
}

/* ---------------- XML ---------------- */

const ok200 = (props) => `<propstat><prop>${props.join('')}</prop><status>HTTP/1.1 200 OK</status></propstat>`;
const missing404 = (names) => (names.length
  ? `<propstat><prop>${names.map((n) => `<${n}/>`).join('')}</prop><status>HTTP/1.1 404 Not Found</status></propstat>`
  : '');

const responseXml = (href, found, missing) =>
  `<response><href>${xmlEscape(href)}</href>${ok200(found)}${missing404(missing)}</response>`;

const multistatus = (body) => `<?xml version="1.0" encoding="utf-8"?>\n<multistatus ${NS}>\n${body}\n</multistatus>`;

/** Which properties a PROPFIND asked for. An empty result means `allprop` (or a
 *  body we could not read), and the caller supplies its own default set. */
function requestedProps(body) {
  const inner = /<[^>]*\bprop\b[^>]*>([\s\S]*?)<\/[^>]*\bprop\b[^>]*>/i.exec(String(body || ''));
  if (!inner) return null;
  return [...inner[1].matchAll(/<([A-Za-z0-9-]+:)?([A-Za-z0-9-]+)\s*\/?>/g)].map((m) => m[2].toLowerCase());
}

/** Builds a response for one resource: the props it has, and 404 for the rest.
 *  Answering "not found" for a property rather than omitting it is what lets a
 *  client tell "this server has no colour for that calendar" from "the request
 *  did not arrive". */
function resourceResponse(href, available, wanted) {
  const names = wanted || Object.keys(available);
  const found = [];
  const missing = [];
  for (const name of names) {
    const value = available[name];
    if (value === undefined || value === null) missing.push(name);
    else found.push(value);
  }
  return responseXml(href, found, missing);
}

/* ---------------- the handler ---------------- */

/** Everything under /dav, parsed. Rejects anything that is not one of the six
 *  shapes the layout defines — including, by construction, any path that tried
 *  to escape it. */
function parsePath(p) {
  const parts = String(p).split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return { type: 'root' };
  if (parts[0] === '.well-known') return { type: 'root' };
  if (parts[0] !== 'p' || !parts[1]) return null;
  const uKey = parts[1];
  if (parts.length === 2) return { type: 'principal', uKey };
  const area = parts[2];
  if (area !== 'cal' && area !== 'card') return null;
  const kind = area === 'cal' ? 'calendar' : 'addressbook';
  if (parts.length === 3) return { type: 'home', uKey, kind };
  const pubId = parts[3];
  if (parts.length === 4) return { type: 'collection', uKey, kind, pubId };
  if (parts.length === 5) return { type: 'item', uKey, kind, pubId, name: parts[4] };
  return null;
}

const base = (req) => `${req.baseUrl}`;
const hrefFor = (req, ...segments) => `${base(req)}/${segments.map(encodeURIComponent).join('/')}`;

export function davRouter() {
  const router = express.Router();

  // Bodies arrive as text: XML for the DAV verbs, iCalendar or vCard for a PUT.
  // Scoped to this router — the global express.json() only handles JSON and
  // lets everything here through untouched.
  router.use(express.text({ type: () => true, limit: '10mb' }));

  router.use((req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    // The same lockout a login gets. A DAV endpoint is the obvious place to try
    // a password list against, precisely because it answers every request with
    // a yes or a no and never shows a form.
    if (!loginAllowed(ip)) {
      res.set('Retry-After', '900');
      return res.status(429).type('text/plain').send('Too many attempts');
    }
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (!/^basic$/i.test(scheme || '') || !encoded) return unauthorized(res);
    let username = '', secret = '';
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const at = decoded.indexOf(':');
      username = decoded.slice(0, at);
      secret = decoded.slice(at + 1);
    } catch { return unauthorized(res); }

    const auth = appPasswords.verify(username, secret);
    if (!auth) {
      loginFailed(ip);
      dlog.info(`Rejected a ${req.method} from ${ip} for "${username}"`);
      return unauthorized(res);
    }
    loginSucceeded(ip);
    appPasswords.touch(auth.uKey, auth.credential.id);
    req.dav = auth;
    next();
  });

  router.all(/.*/, (req, res) => handle(req, res).catch((e) => {
    dlog.warn(`${req.method} ${req.path} failed: ${e.message}`);
    res.status(e.status || 500).type('text/plain').send(e.message || 'Error');
  }));

  return router;
}

function unauthorized(res) {
  // The realm names the app so a phone's credential prompt says what it is
  // asking for. ASCII ONLY: an HTTP header value may not carry a non-ASCII
  // character, and Node refuses to send one — an em dash here made every
  // unauthenticated request answer 500 instead of 401, which is the very first
  // request any client makes. The prose belongs in the body, which has a
  // charset.
  res.set('WWW-Authenticate', 'Basic realm="Hmelj app password"');
  return res.status(401).type('text/plain; charset=utf-8')
    .send('Use an app password, not your Hmelj password. Settings → Login → App passwords.');
}

const SCOPE_FOR = { calendar: 'caldav', addressbook: 'carddav' };

async function handle(req, res) {
  const target = parsePath(req.path);
  if (!target) return res.status(404).type('text/plain').send('Not found');

  const { uKey, credential } = req.dav;
  // A credential belongs to one person. The path naming somebody else's key is
  // not an authorisation question with a subtle answer — it is a 404, and it
  // says nothing about whether that person exists.
  if (target.uKey && target.uKey !== uKey) return res.status(404).type('text/plain').send('Not found');
  if (target.kind && !appPasswords.allows(credential, SCOPE_FOR[target.kind])) {
    return res.status(403).type('text/plain')
      .send(`This app password is not allowed to reach ${target.kind === 'calendar' ? 'calendars' : 'contacts'}.`);
  }

  if (req.method === 'OPTIONS') return options(res);

  // Everything below reads the user's own stored data, which every store in
  // this project resolves from the ALS context.
  const user = listUsers().find((u) => userKey(u.username) === uKey);
  if (!user) return res.status(404).type('text/plain').send('Not found');
  return runAsUser(user, () => dispatch(req, res, target, uKey));
}

function options(res) {
  res.set({
    // 1, 2, 3 plus the two collection classes. Advertising `2` without LOCK
    // support would be a lie some clients act on, so it is left out.
    DAV: '1, 3, calendar-access, addressbook',
    Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT',
    'MS-Author-Via': 'DAV',
  });
  return res.status(200).end();
}

async function dispatch(req, res, target, uKey) {
  switch (req.method) {
    case 'PROPFIND': return propfind(req, res, target, uKey);
    case 'REPORT': return report(req, res, target, uKey);
    case 'GET': case 'HEAD': return get(req, res, target, uKey);
    case 'PUT': return put(req, res, target, uKey);
    case 'DELETE': return del(req, res, target, uKey);
    default:
      return res.status(405).set('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT')
        .type('text/plain').send('Method not allowed');
  }
}

/* ---------------- PROPFIND ---------------- */

function collectionProps(req, uKey, pub, members) {
  const isCal = pub.kind === 'calendar';
  const writable = davPublish.isWritable(uKey, pub);
  return {
    resourcetype: `<resourcetype><collection/>${isCal ? '<C:calendar/>' : '<CR:addressbook/>'}</resourcetype>`,
    displayname: `<displayname>${xmlEscape(pub.label)}</displayname>`,
    getctag: `<CS:getctag>${ctagOf(members)}</CS:getctag>`,
    // Deliberately absent: sync-token. Offering one this server cannot honour
    // is worse than not offering it — see the file header.
    'supported-calendar-component-set': isCal
      ? '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>' : null,
    'calendar-color': isCal ? `<IC:calendar-color>${xmlEscape(pub.color)}FF</IC:calendar-color>` : null,
    'calendar-description': isCal ? `<C:calendar-description>${xmlEscape(pub.label)}</C:calendar-description>` : null,
    'addressbook-description': !isCal ? `<CR:addressbook-description>${xmlEscape(pub.label)}</CR:addressbook-description>` : null,
    'supported-report-set': '<supported-report-set>'
      + `<supported-report><report><${isCal ? 'C:calendar-multiget' : 'CR:addressbook-multiget'}/></report></supported-report>`
      + `<supported-report><report><${isCal ? 'C:calendar-query' : 'CR:addressbook-query'}/></report></supported-report>`
      + '</supported-report-set>',
    // The privileges a subscriber actually has. An aggregate says read-only
    // here and MEANS it — see server/davPublish.js#isWritable for why a merged
    // collection can never accept a write.
    'current-user-privilege-set': '<current-user-privilege-set>'
      + '<privilege><read/></privilege>'
      + (writable ? '<privilege><write/></privilege><privilege><write-content/></privilege><privilege><bind/></privilege><privilege><unbind/></privilege>' : '')
      + '</current-user-privilege-set>',
    getcontenttype: null,
    getetag: null,
  };
}

const memberProps = (m, isCal) => ({
  resourcetype: '<resourcetype/>',
  getetag: `<getetag>${m.etag}</getetag>`,
  getcontenttype: `<getcontenttype>${isCal ? 'text/calendar; charset=utf-8; component=VEVENT' : 'text/vcard; charset=utf-8'}</getcontenttype>`,
  displayname: null,
  getctag: null,
});

function propfind(req, res, target, uKey) {
  const depth = String(req.headers.depth ?? '0');
  const wanted = requestedProps(req.body);
  const rows = [];

  if (target.type === 'root') {
    rows.push(resourceResponse(`${base(req)}/`, {
      resourcetype: '<resourcetype><collection/></resourcetype>',
      'current-user-principal': `<current-user-principal><href>${hrefFor(req, 'p', uKey)}/</href></current-user-principal>`,
      'principal-URL': `<principal-URL><href>${hrefFor(req, 'p', uKey)}/</href></principal-URL>`,
      displayname: '<displayname>Hmelj</displayname>',
    }, wanted));
    return send207(res, rows);
  }

  if (target.type === 'principal') {
    rows.push(resourceResponse(`${hrefFor(req, 'p', uKey)}/`, {
      resourcetype: '<resourcetype><collection/><principal/></resourcetype>',
      'current-user-principal': `<current-user-principal><href>${hrefFor(req, 'p', uKey)}/</href></current-user-principal>`,
      'calendar-home-set': `<C:calendar-home-set><href>${hrefFor(req, 'p', uKey, 'cal')}/</href></C:calendar-home-set>`,
      'addressbook-home-set': `<CR:addressbook-home-set><href>${hrefFor(req, 'p', uKey, 'card')}/</href></CR:addressbook-home-set>`,
      displayname: `<displayname>${xmlEscape(req.dav.user.displayUsername || req.dav.user.username)}</displayname>`,
      // Which addresses "this is me" means, so a client can spot the user among
      // an event's attendees and offer to answer.
      'calendar-user-address-set': `<C:calendar-user-address-set>${
        store.getIdentities().filter((i) => i.email)
          .map((i) => `<href>mailto:${xmlEscape(i.email)}</href>`).join('')
      }</C:calendar-user-address-set>`,
    }, wanted));
    return send207(res, rows);
  }

  const published = davPublish.listFor(uKey).filter((p) => p.kind === target.kind);

  if (target.type === 'home') {
    const homeHref = `${hrefFor(req, 'p', uKey, target.kind === 'calendar' ? 'cal' : 'card')}/`;
    rows.push(resourceResponse(homeHref, {
      resourcetype: '<resourcetype><collection/></resourcetype>',
      displayname: `<displayname>${target.kind === 'calendar' ? 'Calendars' : 'Contacts'}</displayname>`,
    }, wanted));
    if (depth !== '0') {
      for (const pub of published) {
        rows.push(resourceResponse(`${homeHref}${encodeURIComponent(pub.id)}/`,
          collectionProps(req, uKey, pub, membersOf(uKey, pub)), wanted));
      }
    }
    return send207(res, rows);
  }

  const pub = published.find((p) => p.id === target.pubId);
  if (!pub) return res.status(404).type('text/plain').send('Not found');
  const members = membersOf(uKey, pub);
  const collHref = `${hrefFor(req, 'p', uKey, target.kind === 'calendar' ? 'cal' : 'card', pub.id)}/`;

  if (target.type === 'collection') {
    rows.push(resourceResponse(collHref, collectionProps(req, uKey, pub, members), wanted));
    if (depth !== '0') {
      for (const m of members) {
        rows.push(resourceResponse(collHref + m.name, memberProps(m, pub.kind === 'calendar'), wanted));
      }
    }
    return send207(res, rows);
  }

  const member = findMember(members, target.name);
  if (!member) return res.status(404).type('text/plain').send('Not found');
  rows.push(resourceResponse(collHref + member.name, memberProps(member, pub.kind === 'calendar'), wanted));
  return send207(res, rows);
}

const send207 = (res, rows) =>
  res.status(207).type('application/xml; charset=utf-8').send(multistatus(rows.join('\n')));

/* ---------------- REPORT ---------------- */

/** `<C:time-range start="…" end="…"/>` from a calendar-query, as instants. */
function timeRangeOf(body) {
  const m = /<[^>]*time-range[^>]*\bstart="([^"]+)"[^>]*(?:\bend="([^"]+)")?/i.exec(String(body || ''));
  if (!m) return null;
  const parse = (v) => {
    const g = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(String(v || ''));
    return g ? Date.UTC(+g[1], +g[2] - 1, +g[3], +g[4], +g[5], +g[6]) : null;
  };
  return { from: parse(m[1]) ?? -8.64e15, to: parse(m[2]) ?? 8.64e15 };
}

function report(req, res, target, uKey) {
  const body = String(req.body || '');
  if (/sync-collection/i.test(body)) {
    // Refused explicitly rather than answered badly — see the file header. The
    // precondition element is what tells a well-behaved client to fall back to
    // CTag polling rather than to give up on the collection.
    return res.status(403).type('application/xml; charset=utf-8')
      .send(`<?xml version="1.0" encoding="utf-8"?>\n<error ${NS}><supported-report/></error>`);
  }

  const published = davPublish.listFor(uKey).filter((p) => p.kind === target.kind);
  const pub = published.find((p) => p.id === target.pubId);
  if (!pub) return res.status(404).type('text/plain').send('Not found');
  const members = membersOf(uKey, pub);
  const isCal = pub.kind === 'calendar';
  const collHref = `${hrefFor(req, 'p', uKey, isCal ? 'cal' : 'card', pub.id)}/`;
  const dataEl = isCal ? 'C:calendar-data' : 'CR:address-data';
  const wantsData = new RegExp(isCal ? 'calendar-data' : 'address-data', 'i').test(body);

  let chosen = members;
  if (/multiget/i.test(body)) {
    // The hrefs the client named, and only those. Compared on the last segment
    // so a client that quoted an absolute URL and one that quoted a path both
    // work.
    const asked = [...body.matchAll(/<[^>]*href[^>]*>([^<]+)</g)]
      .map((m) => decodeURIComponent(m[1].trim().split('/').filter(Boolean).pop() || ''));
    chosen = members.filter((m) => asked.includes(decodeURIComponent(m.name)));
  } else if (isCal) {
    const range = timeRangeOf(body);
    if (range) {
      // Overlap, not containment — a meeting that started before the window and
      // is still running belongs in the answer, and so does a multi-day event
      // seen from its middle.
      chosen = members.filter((m) => {
        const rows = cache.calendarCandidates(uKey, [m.calendarId], range.from, range.to);
        return rows.some((r) => r.uid === m.uid);
      });
    }
  }

  const rows = chosen.map((m) => responseXml(collHref + m.name, [
    `<getetag>${m.etag}</getetag>`,
    ...(wantsData ? [`<${dataEl}>${xmlEscape(isCal ? m.ical : m.vcf)}</${dataEl}>`] : []),
  ], []));
  return send207(res, rows);
}

/* ---------------- GET / PUT / DELETE ---------------- */

function get(req, res, target, uKey) {
  if (target.type !== 'item') return res.status(405).type('text/plain').send('Not a document');
  const pub = davPublish.listFor(uKey).find((p) => p.id === target.pubId && p.kind === target.kind);
  if (!pub) return res.status(404).type('text/plain').send('Not found');
  const member = findMember(membersOf(uKey, pub), target.name);
  if (!member) return res.status(404).type('text/plain').send('Not found');
  res.set({
    ETag: member.etag,
    'Content-Type': pub.kind === 'calendar' ? 'text/calendar; charset=utf-8' : 'text/vcard; charset=utf-8',
  });
  return req.method === 'HEAD' ? res.status(200).end() : res.status(200).send(pub.kind === 'calendar' ? member.ical : member.vcf);
}

/** Only a writable publication accepts one, and `isWritable` re-derives that
 *  from the live config rather than trusting the record — see davPublish.js. */
function requireWritable(uKey, pub) {
  if (davPublish.isWritable(uKey, pub)) return;
  throw Object.assign(
    new Error(pub.mode === 'aggregate'
      ? 'This is a merged calendar and cannot be written to — there is no single calendar a change would belong to.'
      : 'This calendar is a copy of one on another server. Change it there, or in Hmelj.'),
    { status: 403 },
  );
}

async function put(req, res, target, uKey) {
  if (target.type !== 'item') return res.status(405).type('text/plain').send('Not a document');
  const pub = davPublish.listFor(uKey).find((p) => p.id === target.pubId && p.kind === target.kind);
  if (!pub) return res.status(404).type('text/plain').send('Not found');
  requireWritable(uKey, pub);

  const calendarId = pub.sources[0].calendarId;
  const ical = String(req.body || '');
  const parsed = parseCalendar(ical);
  const ev = parsed?.events?.find((e) => !e.recurrenceId) || parsed?.events?.[0];
  if (!ev?.uid) return res.status(400).type('text/plain').send('That is not an event with a UID');

  const members = membersOf(uKey, pub);
  const existing = members.find((m) => m.uid === ev.uid);
  // Conditional requests, honoured both ways: If-Match is "only if unchanged",
  // If-None-Match: * is "only if it does not exist". A server that ignores
  // these is a server on which two clients silently overwrite each other.
  const ifMatch = req.headers['if-match'];
  const ifNone = req.headers['if-none-match'];
  if (ifMatch && ifMatch !== '*' && (!existing || !ifMatch.includes(existing.etag))) {
    return res.status(412).type('text/plain').send('That event changed since you last read it');
  }
  if (ifNone === '*' && existing) {
    return res.status(412).type('text/plain').send('An event with that UID already exists here');
  }

  calendarStore.writeLocalEvent(uKey, calendarId, ev.uid, ical);
  // Straight into the cache, so the change is visible in Hmelj's own views
  // immediately rather than at the next poll.
  await calendarBackends.refreshCalendarFor(uKey, calendarSourceIdFor(uKey, calendarId), calendarId, {});
  res.set('ETag', etagOf(ical));
  return res.status(existing ? 204 : 201).end();
}

async function del(req, res, target, uKey) {
  if (target.type !== 'item') return res.status(405).type('text/plain').send('Not a document');
  const pub = davPublish.listFor(uKey).find((p) => p.id === target.pubId && p.kind === target.kind);
  if (!pub) return res.status(404).type('text/plain').send('Not found');
  requireWritable(uKey, pub);

  const member = findMember(membersOf(uKey, pub), target.name);
  if (!member) return res.status(404).type('text/plain').send('Not found');
  const ifMatch = req.headers['if-match'];
  if (ifMatch && ifMatch !== '*' && !ifMatch.includes(member.etag)) {
    return res.status(412).type('text/plain').send('That event changed since you last read it');
  }
  const calendarId = pub.sources[0].calendarId;
  calendarStore.deleteLocalEvent(uKey, calendarId, member.uid);
  await calendarBackends.refreshCalendarFor(uKey, calendarSourceIdFor(uKey, calendarId), calendarId, {});
  return res.status(204).end();
}

/** Which source a calendar belongs to. The publication records one, but a
 *  config written before that field existed would not have it, and getting it
 *  wrong means the write lands and is then never re-read. */
function calendarSourceIdFor(uKey, calendarId) {
  return calendarStore.resolveCalendarFor(uKey, calendarId)?.source?.id || null;
}

/** RFC 6764 bootstrap. Registered before the static handler in
 *  server/index.js — otherwise `/.well-known/*` is a 404 from the file server
 *  before it ever reaches here, and every client's auto-discovery fails on a
 *  path the user cannot see. */
export function wellKnownRedirects(app, mount = '/dav') {
  for (const p of ['/.well-known/caldav', '/.well-known/carddav']) {
    app.all(p, (req, res) => res.redirect(301, mount + '/'));
  }
}
