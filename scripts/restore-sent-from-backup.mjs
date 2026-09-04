// Hmelj — one-off recovery tool: restore Sent messages from a local backup
// (EML files or an MBox export, e.g. from mailarchiver) back into an
// account's Sent folder via IMAP APPEND.
//
// EML mode expects a directory containing one raw .eml file per message.
// MBox mode does a best-effort split on classic "From " envelope lines —
// EML-per-file is the more reliable option if your backup tool supports it.
//
// Preserves each message's original Date header as the IMAP internal date,
// so it sorts/displays correctly (not as "today"). Skips anything whose
// Message-ID already exists in the target Sent folder, so it's safe to
// re-run. By default this only REPORTS what it would restore — nothing is
// written to your mailbox unless you pass --apply.
//
// Usage (run on the same machine/environment as the Hmelj server, so it
// picks up the same .env / DATA_DIR / HMELJ_SECRET):
//   node scripts/restore-sent-from-backup.mjs <hmelj-username> <account-email> --eml-dir=<path> [options]
//   node scripts/restore-sent-from-backup.mjs <hmelj-username> <account-email> --mbox=<path> [options]
//
// Options:
//   --apply     Actually append the messages to Sent (default: dry run, report only)
//   --limit=N   Stop after processing N messages (default: no limit)

import fs from 'fs';
import path from 'path';
import { simpleParser } from 'mailparser';
import { ImapFlow } from 'imapflow';
import { config } from '../server/config.js';
import { decrypt } from '../server/accounts.js';
import { userKey } from '../server/session.js';

function parseArgs(argv) {
  const positional = [];
  const opts = { apply: false, limit: null, emlDir: null, mbox: null };
  for (const arg of argv) {
    if (arg === '--apply') opts.apply = true;
    else if (arg.startsWith('--limit=')) opts.limit = parseInt(arg.slice('--limit='.length), 10);
    else if (arg.startsWith('--eml-dir=')) opts.emlDir = arg.slice('--eml-dir='.length);
    else if (arg.startsWith('--mbox=')) opts.mbox = arg.slice('--mbox='.length);
    else positional.push(arg);
  }
  return { positional, opts };
}

function loadAccount(username, emailOrLabel) {
  const key = userKey(username);
  const file = path.join(config.dataDir, 'users', key, 'accounts.json');
  if (!fs.existsSync(file)) {
    throw new Error(`No accounts.json for user "${username}" (looked for ${file} — is DATA_DIR/HMELJ_SECRET set the same as the server?)`);
  }
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  const needle = emailOrLabel.toLowerCase();
  const acc = list.find((a) => a.email.toLowerCase() === needle || a.label.toLowerCase() === needle);
  if (!acc) throw new Error(`No account matching "${emailOrLabel}" for user "${username}". Available: ${list.map((a) => a.email).join(', ')}`);
  return acc;
}

/** Raw message buffers from a directory of .eml files. */
function readEmlDir(dir) {
  const files = fs.readdirSync(dir).filter((f) => !fs.statSync(path.join(dir, f)).isDirectory());
  return files.map((f) => fs.readFileSync(path.join(dir, f)));
}

/** Best-effort split of a classic mbox file into raw per-message buffers. */
function readMbox(file) {
  const text = fs.readFileSync(file, 'latin1'); // preserve bytes 1:1; re-encoded to Buffer below
  const envelopeRe = /^From \S+.*\d{4}\s*$/;
  const lines = text.split(/\r?\n/);
  const messages = [];
  let current = [];
  for (const line of lines) {
    if (envelopeRe.test(line)) {
      if (current.length) messages.push(current.join('\n'));
      current = [];
      continue; // drop the mbox envelope line itself, it's not part of the RFC822 message
    }
    // mboxrd-style quoting: a body line "From ..." gets one extra ">" prepended on export
    current.push(line.replace(/^(>+)From /, (m, gt) => gt.slice(1) + 'From '));
  }
  if (current.length) messages.push(current.join('\n'));
  return messages.filter((m) => m.trim()).map((m) => Buffer.from(m, 'latin1'));
}

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const [username, emailOrLabel] = positional;
  if (!username || !emailOrLabel || (!opts.emlDir && !opts.mbox)) {
    console.error('Usage: node scripts/restore-sent-from-backup.mjs <hmelj-username> <account-email> --eml-dir=<path> | --mbox=<path> [--apply] [--limit=N]');
    process.exit(1);
  }

  const acc = loadAccount(username, emailOrLabel);

  console.log(opts.emlDir ? `Reading .eml files from ${opts.emlDir}...` : `Reading mbox ${opts.mbox}...`);
  const raws = opts.emlDir ? readEmlDir(opts.emlDir) : readMbox(opts.mbox);
  console.log(`Found ${raws.length} message(s) in backup.`);

  const parsedAll = [];
  for (const raw of raws) {
    try {
      const parsed = await simpleParser(raw);
      parsedAll.push({ raw, parsed });
    } catch (e) {
      console.warn('Skipping unparseable message:', e.message);
    }
  }

  const pass = decrypt(acc.imap.pass);
  const client = new ImapFlow({
    host: acc.imap.host,
    port: acc.imap.port,
    secure: acc.imap.secure,
    auth: { user: acc.imap.user, pass },
    logger: false,
    tls: { rejectUnauthorized: acc.imap.tlsRejectUnauthorized },
  });

  console.log(`Connecting to ${acc.imap.host} as ${acc.imap.user}...`);
  await client.connect();

  try {
    console.log(`Checking ${acc.sentFolder} for messages already present...`);
    const existingIds = new Set();
    const lock = await client.getMailboxLock(acc.sentFolder, { readOnly: true });
    try {
      const uids = await client.search({ all: true }, { uid: true });
      if (uids?.length) {
        for await (const msg of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
          if (msg.envelope?.messageId) existingIds.add(msg.envelope.messageId);
        }
      }
    } finally {
      lock.release();
    }
    console.log(`${existingIds.size} message(s) already in ${acc.sentFolder}.`);

    const toRestore = parsedAll.filter(({ parsed }) => !parsed.messageId || !existingIds.has(parsed.messageId));
    const skipped = parsedAll.length - toRestore.length;
    if (skipped) console.log(`Skipping ${skipped} message(s) already present in Sent.`);

    const limited = opts.limit ? toRestore.slice(0, opts.limit) : toRestore;
    if (!limited.length) {
      console.log('Nothing to restore.');
      return;
    }

    console.log(`\n${limited.length} message(s) to restore into ${acc.sentFolder}:\n`);
    for (const { parsed } of limited) {
      console.log(`  ${parsed.date ? parsed.date.toISOString() : '(no date)'}  "${parsed.subject || '(no subject)'}"  -> ${(parsed.to?.value || []).map((t) => t.address).join(', ')}`);
    }

    if (!opts.apply) {
      console.log(`\nDry run only — nothing was changed. Re-run with --apply to append these ${limited.length} message(s) to ${acc.sentFolder}.`);
      return;
    }

    console.log(`\nAppending ${limited.length} message(s)...`);
    let done = 0;
    for (const { raw, parsed } of limited) {
      try {
        await client.append(acc.sentFolder, raw, ['\\Seen'], parsed.date || new Date());
        done++;
      } catch (e) {
        console.warn(`Failed to append "${parsed.subject}":`, e.message);
      }
    }
    console.log(`Done — restored ${done}/${limited.length} message(s) to ${acc.sentFolder}.`);
  } finally {
    await client.logout().catch(() => {});
  }
}

main().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
