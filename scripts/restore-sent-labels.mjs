// Hmelj — one-off recovery tool for messages missing Gmail's \Sent label.
//
// Background: some sent mail on a Gmail account lost its \Sent label (the
// message itself is intact — visible in the conversation thread / All Mail —
// it's just not tagged Sent anymore). This scans [Gmail]/All Mail for
// messages FROM the account's own address and reports which ones are
// missing the \Sent label. By default it only REPORTS — nothing is written
// to your mailbox unless you pass --apply.
//
// This is Gmail-specific (uses Gmail's X-GM-LABELS extension via imapflow's
// `useLabels` option). It won't work against a generic IMAP server like
// Mailu, which has no label concept — a message either is or isn't in a
// real Sent folder there, and there's no "restore the label" operation to
// perform.
//
// Usage (run on the same machine/environment as the Hmelj server, so it
// picks up the same .env / DATA_DIR / HMELJ_SECRET):
//   node scripts/restore-sent-labels.mjs <hmelj-username> <account-email> [options]
//
// Options:
//   --apply           Actually re-add the \Sent label (default: dry run, report only)
//   --since=YYYY-MM-DD Only consider messages on/after this date (default: no limit)
//   --limit=N         Stop after finding N candidates (default: no limit)
//
// Example dry run:
//   node scripts/restore-sent-labels.mjs alice you@gmail.com --since=2026-01-01
// Example apply, once the dry run output looks right:
//   node scripts/restore-sent-labels.mjs alice you@gmail.com --since=2026-01-01 --apply

import fs from 'fs';
import path from 'path';
import { ImapFlow } from 'imapflow';
import { config } from '../server/config.js';
import { decrypt } from '../server/accounts.js';
import { userKey } from '../server/session.js';

function parseArgs(argv) {
  const positional = [];
  const opts = { apply: false, since: null, limit: null };
  for (const arg of argv) {
    if (arg === '--apply') opts.apply = true;
    else if (arg.startsWith('--since=')) opts.since = new Date(arg.slice('--since='.length));
    else if (arg.startsWith('--limit=')) opts.limit = parseInt(arg.slice('--limit='.length), 10);
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
    console.error('Usage: node scripts/restore-sent-labels.mjs <hmelj-username> <account-email> [--apply] [--since=YYYY-MM-DD] [--limit=N]');
    process.exit(1);
  }

  const acc = loadAccount(username, emailOrLabel);
  if (!/gmail\.com$/i.test(acc.imap.host)) {
    console.error(`"${acc.email}" is not a Gmail account (imap host: ${acc.imap.host}) — this tool only works against Gmail's label system.`);
    process.exit(1);
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
    const folders = await client.list();
    const allMail = folders.find((f) => f.specialUse === '\\All');
    if (!allMail) {
      console.error('Could not find a folder tagged special-use \\All (Gmail\'s "All Mail").');
      console.error('Folders this account actually exposes over IMAP:');
      for (const f of folders) console.error(`  ${f.path}${f.specialUse ? `  (${f.specialUse})` : ''}`);
      console.error('\nIf "All Mail" isn\'t in that list, it\'s most likely hidden from IMAP: in Gmail,');
      console.error('go to Settings > See all settings > Labels, find "All Mail" under System labels,');
      console.error('and make sure "Show in IMAP" is checked for it — then re-run this script.');
      throw new Error('All Mail not visible over IMAP for this account.');
    }

    console.log(`Scanning ${allMail.path} for messages from ${acc.email}${opts.since ? ` since ${opts.since.toISOString().slice(0, 10)}` : ''}...`);

    const lock = await client.getMailboxLock(allMail.path, { readOnly: true });
    let candidates;
    try {
      const search = { from: acc.email };
      if (opts.since) search.since = opts.since;
      const uids = await client.search(search, { uid: true });
      if (!uids || !uids.length) {
        console.log('No messages found from this address in All Mail.');
        return;
      }
      console.log(`Found ${uids.length} message(s) from ${acc.email} in All Mail — checking labels...`);

      candidates = [];
      for await (const msg of client.fetch(uids, { uid: true, envelope: true, labels: true }, { uid: true })) {
        const labels = msg.labels || new Set();
        if (labels.has('\\Sent')) continue; // already correctly labeled
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
      console.log('Nothing missing the \\Sent label — no action needed.');
      return;
    }

    console.log(`\n${candidates.length} message(s) missing the \\Sent label:\n`);
    for (const c of candidates) {
      console.log(`  [uid ${c.uid}] ${c.date}  "${c.subject}"  -> ${c.to}`);
    }

    if (!opts.apply) {
      console.log(`\nDry run only — nothing was changed. Re-run with --apply to add \\Sent back to these ${candidates.length} message(s).`);
      return;
    }

    console.log(`\nApplying \\Sent label to ${candidates.length} message(s)...`);
    const writeLock = await client.getMailboxLock(allMail.path, { readOnly: false });
    try {
      const uids = candidates.map((c) => c.uid);
      await client.messageFlagsAdd(uids, ['\\Sent'], { uid: true, useLabels: true });
      console.log(`Done — re-added \\Sent to ${uids.length} message(s). They should reappear in [Gmail]/Sent Mail shortly.`);
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
