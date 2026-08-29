// Hmelj — a stand-in Microsoft Graph mail API, so server/graphClient.js can be
// exercised end to end without a real Microsoft account (and without network).
//
// It implements the exact subset graphClient.js uses, and it is deliberately
// strict about the parts that are easy to get subtly wrong and impossible to
// notice until a real mailbox misbehaves:
//
//   - every request must carry a Bearer token this server issued
//   - $batch sub-requests must be well formed, and responses come back in
//     SHUFFLED order (Graph makes no ordering promise, and code that assumes
//     one works fine right up until it doesn't)
//   - a message id is opaque and contains characters that must be URL-encoded
//   - $value returns raw RFC822 bytes, not JSON
//   - /me/sendMail accepts base64-encoded MIME and nothing else
//
// Knobs (set on the returned object's `state` after start()):
//   throttleNext  — answer the next N requests with 429 + Retry-After: 1
//   expireToken   — reject the next N requests with 401 (a cached token that
//                   died early); the client should refresh once and retry
//   forbid        — answer every request with 403 (missing permission)
//   requests      — every request seen, as {method, path}
//   sent          — every message posted to /me/sendMail, as decoded MIME
import http from 'http';
import crypto from 'crypto';
import { URL } from 'url';

const now = Date.now();
const iso = (offsetMin) => new Date(now - offsetMin * 60000).toISOString();

/** A minimal but genuinely parseable RFC822 message — mailparser has to be
 *  able to read these, since graphClient.js hands $value output straight to
 *  messageParse.js. */
function mimeFor(m) {
  return [
    `From: ${m.from.emailAddress.name} <${m.from.emailAddress.address}>`,
    `To: ${m.toRecipients.map((t) => `${t.emailAddress.name} <${t.emailAddress.address}>`).join(', ')}`,
    `Subject: ${m.subject}`,
    `Date: ${new Date(m.receivedDateTime).toUTCString()}`,
    `Message-ID: <${m.id}@mock.invalid>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    m.bodyText || 'Hello from the mock Graph server.',
    '',
  ].join('\r\n');
}

export function startMockGraph(port = 3077) {
  // Opaque, Graph-shaped ids: base64url with the padding and separators that
  // make un-encoded interpolation into a URL path break.
  const mkId = (seed) => Buffer.from(`AAMkA${seed}/${crypto.randomBytes(6).toString('hex')}=`).toString('base64');

  const folders = new Map();
  const messages = new Map(); // id -> message (carries folderId)

  function addFolder(wellKnownName, displayName, parentFolderId = null) {
    const id = mkId(wellKnownName || displayName);
    folders.set(id, {
      id, displayName, parentFolderId, childFolderCount: 0,
      totalItemCount: 0, unreadItemCount: 0, wellKnownName,
    });
    if (parentFolderId) folders.get(parentFolderId).childFolderCount++;
    return id;
  }

  const inboxId = addFolder('inbox', 'Posljena poc'); // localized on purpose: the path must still come out as INBOX
  const sentId = addFolder('sentitems', 'Poslano');
  const draftsId = addFolder('drafts', 'Osnutki');
  const trashId = addFolder('deleteditems', 'Izbrisano');
  const junkId = addFolder('junkemail', 'Vsiljena');
  const archiveId = addFolder('archive', 'Arhiv');
  const projectsId = addFolder(null, 'Projects');
  const nestedId = addFolder(null, '2026', projectsId);

  function addMessage(folderId, over = {}) {
    const id = mkId('msg');
    const m = {
      id,
      folderId,
      subject: over.subject ?? 'Mock message',
      from: over.from ?? { emailAddress: { name: 'Ana Novak', address: 'ana@example.com' } },
      toRecipients: over.toRecipients ?? [{ emailAddress: { name: 'You', address: 'you@example.com' } }],
      receivedDateTime: over.receivedDateTime ?? iso(over.ageMinutes ?? 5),
      isRead: over.isRead ?? false,
      flag: { flagStatus: over.flagged ? 'flagged' : 'notFlagged' },
      isDraft: over.isDraft ?? false,
      hasAttachments: over.hasAttachments ?? false,
      bodyText: over.bodyText ?? 'Hello from the mock Graph server.',
    };
    messages.set(id, m);
    recount();
    return m;
  }

  function recount() {
    for (const f of folders.values()) { f.totalItemCount = 0; f.unreadItemCount = 0; }
    for (const m of messages.values()) {
      const f = folders.get(m.folderId);
      if (!f) continue;
      f.totalItemCount++;
      if (!m.isRead) f.unreadItemCount++;
    }
  }

  for (let i = 0; i < 7; i++) {
    addMessage(inboxId, {
      subject: i === 0 ? 'Račun za avgust' : `Mock message ${i}`,
      ageMinutes: i * 30,
      isRead: i % 2 === 1,
      flagged: i === 2,
      bodyText: i === 3 ? 'This one mentions pineapple in the body.' : 'Ordinary body text.',
    });
  }
  addMessage(sentId, { subject: 'Something I sent', isRead: true });

  const state = {
    token: 'mock_access_token',
    throttleNext: 0,
    expireToken: 0,
    forbid: false,
    requests: [],
    sent: [],
    batchCalls: 0,
  };

  const contacts = [
    { displayName: 'Ana Novak', emailAddresses: [{ name: 'Ana Novak', address: 'ana@example.com' }] },
    { displayName: 'Bo Kovač', emailAddresses: [{ name: 'Bo', address: 'bo@example.com' }, { name: 'Bo work', address: 'bo@firma.si' }] },
    { displayName: 'No Address', emailAddresses: [] },
  ];

  const wellKnown = (name) => [...folders.values()].find((f) => f.wellKnownName === name);

  function envelope(m) {
    const { folderId, bodyText, ...rest } = m;
    return rest;
  }

  /** graphClient builds these by hand, so parse them the way Graph does rather
   *  than trusting our own construction. */
  function messagesIn(folderId, q) {
    let list = [...messages.values()].filter((m) => m.folderId === folderId);
    const filter = q.get('$filter');
    if (filter === 'isRead eq false') list = list.filter((m) => !m.isRead);
    const search = q.get('$search');
    if (search) {
      // Enough KQL to be honest about the shape: `field:"value"` terms joined
      // by AND/OR, with NOT for exclusions.
      const kql = search.replace(/^"|"$/g, '').replace(/\\"/g, '"');
      const clauses = kql.split(/\s+AND\s+/).filter(Boolean);
      list = list.filter((m) => clauses.every((clause) => {
        const negated = /^NOT\s+/.test(clause);
        const body = clause.replace(/^NOT\s+/, '').replace(/^\(|\)$/g, '');
        const terms = body.split(/\s+OR\s+/);
        const hit = terms.some((t) => {
          const mm = /^(\w+):"?([^"]*)"?$/.exec(t.trim());
          if (!mm) return false;
          const [, field, value] = mm;
          const v = value.toLowerCase();
          if (field === 'subject') return (m.subject || '').toLowerCase().includes(v);
          if (field === 'from') return JSON.stringify(m.from).toLowerCase().includes(v);
          if (field === 'to') return JSON.stringify(m.toRecipients).toLowerCase().includes(v);
          if (field === 'body') return (m.bodyText || '').toLowerCase().includes(v);
          return false;
        });
        return negated ? !hit : hit;
      }));
      // Graph returns $search results in RELEVANCE order and rejects $orderby
      // alongside it. Shuffling here is what proves graphClient re-sorts.
      list.sort((a, b) => (a.id < b.id ? -1 : 1));
    } else if ((q.get('$orderby') || '').startsWith('receivedDateTime desc')) {
      list.sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));
    }
    const total = list.length;
    const skip = Number(q.get('$skip')) || 0;
    const top = Number(q.get('$top')) || 10;
    return { page: list.slice(skip, skip + top), total, hasMore: skip + top < total };
  }

  /** One request, already routed past auth/throttling. Returns
   *  {status, body} where body is an object, a Buffer, or null. */
  function handle(method, rawPath, bodyText, headers = {}) {
    const url = new URL(rawPath, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const q = url.searchParams;
    state.requests.push({ method, path: p });

    // ---- folders ----
    if (method === 'GET' && p === '/me/mailFolders') {
      const top = [...folders.values()].filter((f) => !f.parentFolderId);
      return { status: 200, body: { value: top } };
    }
    let m;
    if (method === 'GET' && (m = /^\/me\/mailFolders\/([^/]+)\/childFolders$/.exec(p))) {
      const parent = resolveFolder(m[1]);
      if (!parent) return { status: 404, body: notFound('folder') };
      return { status: 200, body: { value: [...folders.values()].filter((f) => f.parentFolderId === parent.id) } };
    }
    if (method === 'GET' && (m = /^\/me\/mailFolders\/([^/]+)$/.exec(p))) {
      const f = resolveFolder(m[1]);
      if (!f) return { status: 404, body: notFound('folder') };
      return { status: 200, body: f };
    }
    if (method === 'POST' && p === '/me/mailFolders') {
      const id = addFolder(null, JSON.parse(bodyText).displayName);
      return { status: 201, body: folders.get(id) };
    }
    if (method === 'POST' && (m = /^\/me\/mailFolders\/([^/]+)\/childFolders$/.exec(p))) {
      const parent = resolveFolder(m[1]);
      if (!parent) return { status: 404, body: notFound('folder') };
      const id = addFolder(null, JSON.parse(bodyText).displayName, parent.id);
      return { status: 201, body: folders.get(id) };
    }
    if (method === 'PATCH' && (m = /^\/me\/mailFolders\/([^/]+)$/.exec(p))) {
      const f = resolveFolder(m[1]);
      if (!f) return { status: 404, body: notFound('folder') };
      Object.assign(f, JSON.parse(bodyText));
      return { status: 200, body: f };
    }
    if (method === 'POST' && (m = /^\/me\/mailFolders\/([^/]+)\/move$/.exec(p))) {
      const f = resolveFolder(m[1]);
      if (!f) return { status: 404, body: notFound('folder') };
      const dest = JSON.parse(bodyText).destinationId;
      f.parentFolderId = dest === 'msgfolderroot' ? null : dest;
      return { status: 200, body: f };
    }
    if (method === 'DELETE' && (m = /^\/me\/mailFolders\/([^/]+)$/.exec(p))) {
      const f = resolveFolder(m[1]);
      if (!f) return { status: 404, body: notFound('folder') };
      folders.delete(f.id);
      return { status: 204, body: null };
    }

    // ---- messages ----
    if (method === 'GET' && (m = /^\/me\/mailFolders\/([^/]+)\/messages$/.exec(p))) {
      const f = resolveFolder(m[1]);
      if (!f) return { status: 404, body: notFound('folder') };
      const { page, total, hasMore } = messagesIn(f.id, q);
      const body = { value: page.map(envelope) };
      if (q.get('$count') === 'true') body['@odata.count'] = total;
      if (hasMore) body['@odata.nextLink'] = `http://127.0.0.1:${port}/me/mailFolders/${encodeURIComponent(f.id)}/messages?${nextQuery(q)}`;
      return { status: 200, body };
    }
    if (method === 'POST' && (m = /^\/me\/mailFolders\/([^/]+)\/messages$/.exec(p))) {
      const f = resolveFolder(m[1]);
      if (!f) return { status: 404, body: notFound('folder') };
      const mime = Buffer.from(bodyText, 'base64').toString('utf8');
      if (!/\n|\r/.test(mime)) return { status: 400, body: { error: { code: 'ErrorInvalidBase64String', message: 'Invalid base64 string for MIME content.' } } };
      const created = addMessage(f.id, {
        subject: /^subject:\s*(.*)$/im.exec(mime)?.[1]?.trim() || '(no subject)',
        isRead: false,
        bodyText: mime.split(/\r?\n\r?\n/).slice(1).join('\n\n'),
      });
      return { status: 201, body: envelope(created) };
    }
    if ((m = /^\/me\/messages\/([^/]+)\/\$value$/.exec(p))) {
      const msg = messages.get(m[1]);
      if (!msg) return { status: 404, body: notFound('message') };
      return { status: 200, body: Buffer.from(mimeFor(msg), 'utf8'), raw: true };
    }
    if (method === 'GET' && (m = /^\/me\/messages\/([^/]+)$/.exec(p))) {
      const msg = messages.get(m[1]);
      if (!msg) return { status: 404, body: notFound('message') };
      return { status: 200, body: envelope(msg) };
    }
    if (method === 'PATCH' && (m = /^\/me\/messages\/([^/]+)$/.exec(p))) {
      const msg = messages.get(m[1]);
      if (!msg) return { status: 404, body: notFound('message') };
      Object.assign(msg, JSON.parse(bodyText));
      recount();
      return { status: 200, body: envelope(msg) };
    }
    if (method === 'POST' && (m = /^\/me\/messages\/([^/]+)\/(move|copy)$/.exec(p))) {
      const msg = messages.get(m[1]);
      if (!msg) return { status: 404, body: notFound('message') };
      const dest = JSON.parse(bodyText).destinationId;
      if (!folders.has(dest)) return { status: 404, body: notFound('destination folder') };
      if (m[2] === 'move') {
        // A move gives the message a new id, exactly as Graph does.
        messages.delete(msg.id);
        const moved = { ...msg, id: mkId('moved'), folderId: dest };
        messages.set(moved.id, moved);
        recount();
        return { status: 201, body: envelope(moved) };
      }
      const copy = { ...msg, id: mkId('copy'), folderId: dest };
      messages.set(copy.id, copy);
      recount();
      return { status: 201, body: envelope(copy) };
    }
    if (method === 'DELETE' && (m = /^\/me\/messages\/([^/]+)$/.exec(p))) {
      if (!messages.delete(m[1])) return { status: 404, body: notFound('message') };
      recount();
      return { status: 204, body: null };
    }

    // ---- send ----
    if (method === 'POST' && p === '/me/sendMail') {
      const ct = String(headers['content-type'] || '');
      if (!ct.startsWith('text/plain')) {
        return { status: 400, body: { error: { code: 'RequestBodyRead', message: 'MIME sends must use Content-Type: text/plain' } } };
      }
      if (!/^[A-Za-z0-9+/=\s]+$/.test(bodyText || '')) {
        return { status: 400, body: { error: { code: 'ErrorInvalidBase64String', message: 'Invalid base64 string for MIME content.' } } };
      }
      const mime = Buffer.from(bodyText, 'base64').toString('utf8');
      state.sent.push(mime);
      // Graph saves the Sent Items copy itself — that is why smtpClient.js's
      // Graph path does no separate append.
      addMessage(sentId, { subject: /^subject:\s*(.*)$/im.exec(mime)?.[1]?.trim() || '', isRead: true, bodyText: mime });
      return { status: 202, body: null };
    }

    // ---- contacts ----
    if (method === 'GET' && p === '/me/contacts') {
      return { status: 200, body: { value: contacts } };
    }

    return { status: 404, body: notFound(p) };
  }

  function nextQuery(q) {
    const n = new URLSearchParams(q);
    n.set('$skip', String((Number(q.get('$skip')) || 0) + (Number(q.get('$top')) || 10)));
    return n.toString();
  }

  function notFound(what) {
    return { error: { code: 'ErrorItemNotFound', message: `The specified object was not found in the store: ${what}` } };
  }

  /** Well-known names and real ids both address a folder, same as Graph. */
  function resolveFolder(idOrName) {
    return folders.get(idOrName) || wellKnown(idOrName) || null;
  }

  const server = http.createServer(async (req, res) => {
    const bodyText = await new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => resolve(b));
    });

    const send = (status, body, raw = false) => {
      if (body === null) { res.writeHead(status); return res.end(); }
      if (raw) { res.writeHead(status, { 'Content-Type': 'text/plain' }); return res.end(body); }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (state.throttleNext > 0) {
      state.throttleNext--;
      res.setHeader('Retry-After', '1');
      return send(429, { error: { code: 'TooManyRequests', message: 'Throttled' } });
    }
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ')) return send(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty.' } });
    // `expireToken` is a countdown, not a flag: it models a cached access token
    // that died before its stated expiry (revoked, password changed). The
    // client is expected to refresh once and retry, so exactly one 401 must be
    // enough — set it to 2 and the retry should fail for real.
    if (state.expireToken > 0) {
      state.expireToken--;
      return send(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired.' } });
    }
    if (state.forbid) return send(403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' } });

    const path = req.url;

    if (req.method === 'POST' && path === '/$batch') {
      state.batchCalls++;
      let parsed;
      try { parsed = JSON.parse(bodyText); } catch { return send(400, { error: { code: 'BadRequest', message: 'batch body must be JSON' } }); }
      const reqs = parsed.requests || [];
      if (reqs.length > 20) return send(400, { error: { code: 'BadRequest', message: 'a batch may contain at most 20 requests' } });
      const responses = reqs.map((r) => {
        if (!r.id || !r.method || !r.url) return { id: r.id ?? null, status: 400, body: { error: { code: 'BadRequest', message: 'malformed sub-request' } } };
        if (r.body !== undefined && !(r.headers && r.headers['Content-Type'])) {
          return { id: r.id, status: 400, body: { error: { code: 'BadRequest', message: 'a sub-request with a body must declare Content-Type' } } };
        }
        const out = handle(r.method, r.url, r.body === undefined ? undefined : JSON.stringify(r.body), r.headers || {});
        return { id: r.id, status: out.status, body: out.raw ? out.body.toString('base64') : out.body };
      });
      // Graph promises nothing about ordering. Reversing makes any code that
      // assumes it fail here rather than against a real mailbox.
      return send(200, { responses: responses.reverse() });
    }

    const out = handle(req.method, path, bodyText, req.headers);
    send(out.status, out.body, !!out.raw);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      server,
      state,
      folders,
      messages,
      ids: { inboxId, sentId, draftsId, trashId, junkId, archiveId, projectsId, nestedId },
      addMessage,
      base: `http://127.0.0.1:${port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

// Runnable on its own for manual poking: node test/mock-graph-server.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startMockGraph(Number(process.env.PORT) || 3077);
  console.log('mock Graph API on', m.base);
}
