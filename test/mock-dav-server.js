// Hmelj — a stand-in CalDAV/CardDAV server, so server/dav/* can be exercised
// end to end without a real account and without network.
//
// Deliberately awkward in the ways real servers are, because those are what
// break DAV clients and none of them show up against a friendly mock:
//
//   - `.well-known/carddav` answers 301 and the client MUST keep the method.
//     A client that lets fetch follow it sends a GET and gets an HTML page.
//   - the collection listing is served from a path (`/dav/`), so the ORIGIN's
//     `.well-known` is a different application — the typed URL has to be tried
//     first.
//   - hrefs come back as absolute PATHS, never full URLs, and a multiget must
//     quote them back exactly as sent.
//   - a namespace prefix is used, and it is not the one anybody expects (`x:`).
//   - properties the server does not have come back as their own 404 propstat.
//   - Basic auth is enforced on everything.
//
// Two modes, switchable at runtime, because a client has to work against both:
//   state.syncCollection = true   RFC 6578 sync-collection REPORT is supported
//   state.syncCollection = false  it is refused; the client must fall back to
//                                 comparing ETags from a Depth:1 PROPFIND
//
// Knobs (set on the returned object's `state` after start()):
//   expireToken  — answer the next sync-collection REPORT with 403
//                  valid-sync-token, i.e. "your token is too old, start over"
//   failNextPut  — answer the next PUT with 412 (somebody else changed it)
//   requests     — every request seen, as {method, path}
import http from 'http';

const USER = 'andrej';
const PASS = 'app-password-1';

const card = (uid, fn, email) => [
  'BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`, `FN:${fn}`,
  `EMAIL;TYPE=WORK:${email}`, 'END:VCARD', '',
].join('\r\n');

const event = (uid, summary, start) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//mock//EN', 'BEGIN:VEVENT',
  `UID:${uid}`, `SUMMARY:${summary}`, `DTSTART:${start}`, 'DURATION:PT1H',
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

export function startMockDav(port = 3079) {
  const state = {
    syncCollection: true,
    // Collection display names, so a test can rename one the way somebody would
    // in Google Calendar's own settings — which is a thing that happens to a
    // calendar long after it was added, and which Hmelj has to notice.
    names: { '/dav/cals/work/': 'Work' },
    expireToken: 0,
    failNextPut: 0,
    requests: [],
    // href -> { etag, data }
    items: new Map([
      ['/dav/books/default/a.vcf', { etag: '"a-1"', data: card('uid-a', 'Ana Horvat', 'ana@example.com') }],
      ['/dav/books/default/b.vcf', { etag: '"b-1"', data: card('uid-b', 'Bojan Kos', 'bojan@example.com') }],
      ['/dav/books/default/c.vcf', { etag: '"c-1"', data: card('uid-c', 'Cvetka Zupan', 'cvetka@example.com') }],
      ['/dav/cals/work/e1.ics', { etag: '"e1-1"', data: event('uid-e1', 'Standup', '20260901T070000Z') }],
    ]),
    // Every change, in order, so a sync token can be a simple index into it.
    changes: [],
    // 'ctag-0', not 'ctag-1': bump() derives the next one from changes.length,
    // so seeding at 1 would make the first real change produce the same value
    // and look like nothing had happened.
    ctag: { '/dav/books/default/': 'ctag-0', '/dav/cals/work/': 'ctag-0' },
  };

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ms = (body) => `<?xml version="1.0" encoding="utf-8"?>\n<x:multistatus xmlns:x="DAV:" `
    + `xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:r="urn:ietf:params:xml:ns:carddav" `
    + `xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">\n${body}\n</x:multistatus>`;
  const okProp = (inner) => `<x:propstat><x:prop>${inner}</x:prop><x:status>HTTP/1.1 200 OK</x:status></x:propstat>`;
  const missingProp = (names) => (names.length
    ? `<x:propstat><x:prop>${names.map((n) => `<x:${n}/>`).join('')}</x:prop><x:status>HTTP/1.1 404 Not Found</x:status></x:propstat>`
    : '');
  const response = (href, inner, missing = []) => `<x:response><x:href>${esc(href)}</x:href>${okProp(inner)}${missingProp(missing)}</x:response>`;

  const COLLECTIONS = {
    '/dav/books/default/': {
      kind: 'carddav',
      inner: () => '<x:resourcetype><x:collection/><r:addressbook/></x:resourcetype>'
        + '<x:displayname>Personal contacts</x:displayname>'
        + `<cs:getctag>${state.ctag['/dav/books/default/']}</cs:getctag>`
        + `<x:sync-token>sync/${state.changes.length}</x:sync-token>`
        + '<x:current-user-privilege-set><x:privilege><x:read/></x:privilege>'
        + '<x:privilege><x:write/></x:privilege></x:current-user-privilege-set>',
    },
    '/dav/books/shared/': {
      kind: 'carddav',
      inner: () => '<x:resourcetype><x:collection/><r:addressbook/></x:resourcetype>'
        + '<x:displayname>Team (read-only)</x:displayname>'
        + '<cs:getctag>ctag-shared</cs:getctag>'
        + '<x:current-user-privilege-set><x:privilege><x:read/></x:privilege></x:current-user-privilege-set>',
    },
    '/dav/cals/work/': {
      kind: 'caldav',
      inner: () => '<x:resourcetype><x:collection/><c:calendar/></x:resourcetype>'
        + `<x:displayname>${state.names['/dav/cals/work/']}</x:displayname>`
        + `<cs:getctag>${state.ctag['/dav/cals/work/']}</cs:getctag>`
        + '<ic:calendar-color>#e37400ff</ic:calendar-color><ic:calendar-order>1</ic:calendar-order>'
        + '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>'
        + '<x:current-user-privilege-set><x:privilege><x:read/></x:privilege>'
        + '<x:privilege><x:write-content/></x:privilege></x:current-user-privilege-set>',
    },
    // A task list. A calendar client must NOT offer this as a calendar.
    '/dav/cals/tasks/': {
      kind: 'caldav',
      inner: () => '<x:resourcetype><x:collection/><c:calendar/></x:resourcetype>'
        + '<x:displayname>Tasks</x:displayname>'
        + '<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>',
    },
  };

  const itemsIn = (prefix) => [...state.items.entries()].filter(([h]) => h.startsWith(prefix) && h !== prefix);

  function bump(href, etag, removed = false) {
    state.changes.push({ href, etag, removed });
    const coll = href.slice(0, href.lastIndexOf('/') + 1);
    state.ctag[coll] = 'ctag-' + state.changes.length;
  }

  const server = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    state.requests.push({ method: req.method, path });

    const auth = req.headers.authorization || '';
    const expected = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
    if (auth !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="mock"' });
      return res.end('<error>bad credentials</error>');
    }

    let body = '';
    for await (const chunk of req) body += chunk;

    const send = (code, text, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/xml; charset=utf-8', ...headers });
      res.end(text);
    };

    // RFC 6764 bootstrap. 301, and the client has to keep its method.
    if (path === '/.well-known/carddav' || path === '/.well-known/caldav') {
      // Points at the ORIGIN root, which here is a different application
      // entirely and answers nothing useful — exactly the self-hosted-under-a-
      // path case that makes trying the typed URL first the right order.
      return send(301, '', { Location: '/not-dav/' });
    }
    if (path === '/not-dav/') return send(404, '<html>no dav here</html>', { 'Content-Type': 'text/html' });

    if (req.method === 'OPTIONS') {
      return send(200, '', { DAV: '1, 2, 3, access-control, calendar-access, addressbook', Allow: 'OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT' });
    }

    if (req.method === 'PROPFIND') {
      const depth = req.headers.depth ?? '0';
      const wants = (n) => body.includes(n);

      if (path === '/dav/') {
        if (wants('current-user-principal')) {
          return send(207, ms(response('/dav/', '<x:current-user-principal><x:href>/dav/principals/andrej/</x:href></x:current-user-principal>'
            + '<x:resourcetype><x:collection/></x:resourcetype>')));
        }
        return send(207, ms(response('/dav/', '<x:displayname>root</x:displayname>')));
      }

      if (path === '/dav/principals/andrej/') {
        return send(207, ms(response('/dav/principals/andrej/',
          '<r:addressbook-home-set><x:href>/dav/books/</x:href></r:addressbook-home-set>'
          + '<c:calendar-home-set><x:href>/dav/cals/</x:href></c:calendar-home-set>'
          + '<x:displayname>Andrej</x:displayname>')));
      }

      // A home set, Depth 1: itself, then its collections.
      if ((path === '/dav/books/' || path === '/dav/cals/') && depth === '1') {
        const kind = path === '/dav/books/' ? 'carddav' : 'caldav';
        const rows = [response(path, '<x:resourcetype><x:collection/></x:resourcetype><x:displayname>home</x:displayname>')];
        for (const [href, c] of Object.entries(COLLECTIONS)) {
          if (c.kind === kind && href.startsWith(path)) rows.push(response(href, c.inner()));
        }
        return send(207, ms(rows.join('\n')));
      }

      // A collection itself.
      if (COLLECTIONS[path] && depth === '0') return send(207, ms(response(path, COLLECTIONS[path].inner())));

      // A collection's items, Depth 1 — the ETag-diff path. The collection
      // itself comes first, with its own full properties: that is what a real
      // server returns, and it is what makes pasting a collection URL work.
      if (COLLECTIONS[path] && depth === '1') {
        const rows = [response(path, COLLECTIONS[path].inner(), ['getetag'])];
        for (const [href, it] of itemsIn(path)) rows.push(response(href, `<x:getetag>${esc(it.etag)}</x:getetag>`));
        return send(207, ms(rows.join('\n')));
      }

      return send(404, '<error>no such collection</error>');
    }

    if (req.method === 'REPORT') {
      const coll = COLLECTIONS[path];
      if (!coll) return send(404, '<error>no such collection</error>');
      const dataEl = coll.kind === 'caldav' ? 'c:calendar-data' : 'r:address-data';

      if (body.includes('sync-collection')) {
        if (!state.syncCollection) return send(403, '<x:error xmlns:x="DAV:"><x:supported-report/></x:error>');
        if (state.expireToken > 0) {
          state.expireToken--;
          return send(403, '<?xml version="1.0"?><x:error xmlns:x="DAV:"><x:valid-sync-token/></x:error>');
        }
        const token = /<[^>]*sync-token[^>]*>([^<]*)</.exec(body)?.[1] || '';
        const from = Number(/sync\/(\d+)/.exec(token)?.[1] ?? -1);
        const rows = [];
        if (from < 0) {
          // No token: the initial run returns everything.
          for (const [href, it] of itemsIn(path)) rows.push(response(href, `<x:getetag>${esc(it.etag)}</x:getetag>`));
        } else {
          const seen = new Set();
          for (const ch of state.changes.slice(from)) {
            if (!ch.href.startsWith(path) || seen.has(ch.href)) continue;
            seen.add(ch.href);
            rows.push(ch.removed
              ? `<x:response><x:href>${esc(ch.href)}</x:href><x:status>HTTP/1.1 404 Not Found</x:status></x:response>`
              : response(ch.href, `<x:getetag>${esc(ch.etag)}</x:getetag>`));
          }
        }
        return send(207, ms(rows.join('\n') + `\n<x:sync-token>sync/${state.changes.length}</x:sync-token>`));
      }

      if (body.includes('multiget')) {
        const hrefs = [...body.matchAll(/<[^>]*href[^>]*>([^<]+)</g)].map((m) => m[1].trim());
        const rows = hrefs.map((href) => {
          const it = state.items.get(href);
          if (!it) return `<x:response><x:href>${esc(href)}</x:href><x:status>HTTP/1.1 404 Not Found</x:status></x:response>`;
          return response(href, `<x:getetag>${esc(it.etag)}</x:getetag><${dataEl}>${esc(it.data)}</${dataEl}>`);
        });
        return send(207, ms(rows.join('\n')));
      }
      return send(400, '<error>unsupported report</error>');
    }

    if (req.method === 'GET') {
      const it = state.items.get(path);
      if (!it) return send(404, '<error>not found</error>');
      return send(200, it.data, { ETag: it.etag, 'Content-Type': 'text/vcard; charset=utf-8' });
    }

    if (req.method === 'PUT') {
      if (state.failNextPut > 0) { state.failNextPut--; return send(412, '<error>changed by somebody else</error>'); }
      const existing = state.items.get(path);
      const ifMatch = req.headers['if-match'];
      const ifNone = req.headers['if-none-match'];
      if (ifMatch && (!existing || existing.etag !== ifMatch)) return send(412, '<error>etag mismatch</error>');
      if (ifNone === '*' && existing) return send(412, '<error>already exists</error>');
      const etag = `"${path.split('/').pop()}-${Date.now()}-${state.changes.length}"`;
      state.items.set(path, { etag, data: body });
      bump(path, etag);
      return send(existing ? 204 : 201, '', { ETag: etag });
    }

    if (req.method === 'DELETE') {
      const existing = state.items.get(path);
      if (!existing) return send(404, '<error>not found</error>');
      const ifMatch = req.headers['if-match'];
      if (ifMatch && existing.etag !== ifMatch) return send(412, '<error>etag mismatch</error>');
      state.items.delete(path);
      bump(path, '', true);
      return send(204, '');
    }

    return send(405, '<error>method not allowed</error>');
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      port,
      url: `http://127.0.0.1:${port}/dav/`,
      origin: `http://127.0.0.1:${port}`,
      username: USER,
      password: PASS,
      state,
      /** Change an item the way another client would, so the next sync has
       *  something real to find. */
      mutate(href, data) {
        const etag = `"${href.split('/').pop()}-m${state.changes.length}"`;
        state.items.set(href, { etag, data });
        bump(href, etag);
        return etag;
      },
      remove(href) { state.items.delete(href); bump(href, '', true); },
      /** Renames a COLLECTION — no item changes, so its ctag does not move and
       *  the next sync takes the "nothing changed" path. Which is the point:
       *  a rename is invisible to an event sync. */
      rename(href, name) { state.names[href] = name; },
      stop: () => new Promise((r) => server.close(r)),
    }));
  });
}
