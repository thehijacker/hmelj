// Hmelj — one-off recovery tool for Sent messages that ended up in Trash.
//
// Background: on a plain IMAP account (no Gmail-style labels — Sent is a
// real folder), a message can only "disappear" from Sent by actually being
// moved or expunged. This app's delete behavior defaults to "trash" (move,
// not permanently destroy), so a message removed from Sent by the old
// pre-fix filter bug (filters used to be able to run against Sent, before
// that was excluded) most likely landed in the account's Trash folder
// rather than being gone for good.
//
// This scans Trash for messages FROM the account's own address and moves
// them back to the account's designated Sent folder. By default it only
// REPORTS what it would move — nothing changes on your mailbox unless you
// pass --apply.
//
// Usage (run on the same machine/environment as the Hmelj server, so it
// picks up the same .env / DATA_DIR / HMELJ_SECRET):
//   node scripts/restore-sent-from-trash.mjs <hmelj-username> <account-email> [options]
//
// Options:
//   --apply            Actually move the messages back to Sent (default: dry run, report only)
//   --since=YYYY-MM-DD Only consider messages on/after this date (default: no limit)
//   --limit=N          Stop after finding N candidates (default: no limit)
//   --folder=PATH      Scan a folder other than the account's Trash (e.g. if a filter's
//                      "move" action sent messages somewhere else instead of deleting them)

import fs from 'fs';
import path from 'path';
import { ImapFlow } from 'imapflow';
import { config } from '../server/config.js';
import { decrypt } from '../server/accounts.js';
import { userKey } from '../server/session.js';

function parseArgs(argv) {
  const positional = [];
  const opts = { apply: false, since: null, limit: null, folder: null };
  for (const arg of argv) {
    if (arg === '--apply') opts.apply = true;
    else if (arg.startsWith('--since=')) opts.since = new Date(arg.slice('--since='.length));
    else if (arg.startsWith('--limit=')) opts.limit = parseInt(arg.slice('--limit='.length), 10);
    else if (arg.startsWith('--folder=')) opts.folder = arg.slice('--folder='.length);
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

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const [username, emailOrLabel] = positional;
  if (!username || !emailOrLabel) {
    console.error('Usage: node scripts/restore-sent-from-trash.mjs <hmelj-username> <account-email> [--apply] [--since=YYYY-MM-DD] [--limit=N] [--folder=PATH]');
    process.exit(1);
  }

  const acc = loadAccount(username, emailOrLabel);
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
    const sourcePath = opts.folder || acc.trashFolder;
    console.log(`Scanning ${sourcePath} for messages from ${acc.email}${opts.since ? ` since ${opts.since.toISOString().slice(0, 10)}` : ''}...`);
    console.log(`(will move matches to ${acc.sentFolder} if --apply is set)`);

    let candidates;
    const lock = await client.getMailboxLock(sourcePath, { readOnly: true });
    try {
      const search = { from: acc.email };
      if (opts.since) search.since = opts.since;
      const uids = await client.search(search, { uid: true });
      if (!uids || !uids.length) {
        console.log(`No messages found from ${acc.email} in ${sourcePath}.`);
        return;
      }
      console.log(`Found ${uids.length} message(s) from ${acc.email} in ${sourcePath} — checking senders...`);

      candidates = [];
      for await (const msg of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
        const from = (msg.envelope?.from || [])[0]?.address || '';
        if (from.toLowerCase() !== acc.email.toLowerCase()) continue; // safety: exact sender match only
        candidates.push({
          uid: msg.uid,
          subject: msg.envelope?.subject || '(no subject)',
          date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : '(no date)',
          to: (msg.envelope?.to || []).map((t) => t.address).join(', '),
        });
        if (opts.limit && candidates.length >= opts.limit) break;
      }
    } finally {
      lock.release();
    }

    if (!candidates.length) {
      console.log(`Nothing in ${sourcePath} sent from ${acc.email} — no action needed.`);
      return;
    }

    console.log(`\n${candidates.length} message(s) in ${sourcePath} sent from ${acc.email}:\n`);
    for (const c of candidates) {
      console.log(`  [uid ${c.uid}] ${c.date}  "${c.subject}"  -> ${c.to}`);
    }

    if (!opts.apply) {
      console.log(`\nDry run only — nothing was changed. Re-run with --apply to move these ${candidates.length} message(s) back to ${acc.sentFolder}.`);
      return;
    }

    console.log(`\nMoving ${candidates.length} message(s) to ${acc.sentFolder}...`);
    const writeLock = await client.getMailboxLock(sourcePath, { readOnly: false });
    try {
      const uids = candidates.map((c) => c.uid);
      await client.messageMove(uids, acc.sentFolder, { uid: true });
      console.log(`Done — moved ${uids.length} message(s) from ${sourcePath} to ${acc.sentFolder}.`);
    } finally {
      writeLock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

main().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
