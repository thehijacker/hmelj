// End-to-end harness: a real IMAP server (hoodiecrow), a real SMTP sink
// (smtp-server), and a real Hmelj process against an isolated DATA_DIR.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import hoodiecrow from 'hoodiecrow-imap';
import { SMTPServer } from 'smtp-server';
import { ImapFlow } from 'imapflow';

// Derived from this file's own location, never hardcoded: the two suites that
// use this harness spawn `${REPO}/server/index.js` as a real process, so an
// absolute path baked in here means they only ever pass on the one machine it
// was written on. In CI the checkout lives somewhere else entirely, node exits
// with "Cannot find module", and the failure surfaces as "Hmelj did not come
// up" — which reads like the server crashed rather than like it was never
// started.
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A minimal but well-formed RFC822 message. CRLF everywhere — IMAP demands it. */
export function rawMail({ from, to, subject, body = 'hello', date = new Date() }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@test.local>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '',
  ].join('\r\n');
}

export async function startImap({ user, pass }) {
  const port = await freePort();
  const server = hoodiecrow({
    plugins: ['ID', 'SASL-IR', 'ENABLE', 'NAMESPACE', 'SPECIAL-USE', 'UIDPLUS', 'MOVE', 'LITERALPLUS'],
    id: { name: 'test', version: '1' },
    storage: {
      INBOX: { messages: [] },
      '': {
        separator: '.',
        folders: {
          Sent: { 'special-use': '\\Sent', messages: [] },
          Trash: { 'special-use': '\\Trash', messages: [] },
        },
      },
    },
  });
  server.users = { [user]: { password: pass } };
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { port, server, close: () => new Promise((r) => server.close(r)) };
}

/** Records every delivered envelope as {to:[], subject}. */
export async function startSmtp() {
  const port = await freePort();
  const sent = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    // Hmelj always authenticates; accept anything.
    onAuth(auth, session, cb) { cb(null, { user: auth.username }); },
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (d) => { raw += d; });
      stream.on('end', () => {
        const m = /^Subject:\s*(.*)$/im.exec(raw.split(/\r?\n\r?\n/)[0] || '');
        sent.push({ to: session.envelope.rcptTo.map((r) => r.address), subject: m ? m[1].trim() : '' });
        cb();
      });
    },
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { port, sent, close: () => new Promise((r) => server.close(r)) };
}

export async function imapClient({ port, user, pass }) {
  const c = new ImapFlow({ host: '127.0.0.1', port, secure: false, auth: { user, pass }, logger: false });
  await c.connect();
  return c;
}

export async function startHmelj({ dataDir, port, extraEnv = {}, serverDir = null }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const entry = (serverDir || `${REPO}/server`) + '/index.js';
  const child = spawn(process.execPath, ['--openssl-legacy-provider', entry], {
    // cwd away from the repo so the live .env is never picked up
    cwd: dataDir,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      CACHE_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      HMELJ_SECRET: 'test-secret',
      SYNC_INTERVAL_MS: '3600000',
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
      LOG: process.env.HMELJ_TEST_LOG || 'warn',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = [];
  child.stdout.on('data', (d) => { out.push(String(d)); if (process.env.HMELJ_TEST_LOG) process.stdout.write(d); });
  child.stderr.on('data', (d) => { out.push(String(d)); if (process.env.HMELJ_TEST_LOG) process.stderr.write(d); });

  // How long to wait for /healthz. The server itself starts in well under a
  // second once its modules are in the page cache — but a COLD import of
  // node_modules is hundreds of small reads, and on slow or contended storage
  // (a USB disk, a network mount, a busy CI runner) that alone has been
  // measured at over a minute here. The old 20s budget turned that into
  // "Hmelj did not come up" with an empty server log, which reads like a
  // crash and is nothing of the kind. Waiting longer costs nothing: the loop
  // exits the moment healthz answers.
  const timeoutMs = Number(process.env.HMELJ_TEST_STARTUP_MS) || 120e3;
  const base = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) break; // it died — stop waiting and report why
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return { child, base, out, close: () => { child.kill('SIGKILL'); } };
    } catch {}
    await sleep(100);
  }
  const waited = Math.round((Date.now() - startedAt) / 1000);
  const why = child.exitCode !== null
    ? `it exited with code ${child.exitCode}`
    : `it was still starting after ${waited}s (raise HMELJ_TEST_STARTUP_MS if this machine's disk is just slow)`;
  child.kill('SIGKILL');
  throw new Error(`Hmelj did not come up — ${why}:\n` + (out.join('') || '(the server printed nothing)'));
}

/** fetch wrapper that carries the session cookie. */
export function api(base) {
  let cookie = '';
  const call = async (method, path, body) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.getSetCookie?.() || [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
    return json;
  };
  /** The session cookie this helper is carrying, for a request that cannot go
   *  through it — a binary download, say, where the JSON parsing and the
   *  throw-on-non-2xx above are both in the way. */
  call.cookie = () => cookie;
  return call;
}
