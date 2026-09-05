// Hmelj — writes blank placeholder PNGs for docs/screenshots/.
//
// The README and the documentation site reference every screenshot by path. A
// missing one is a broken image on the repository's front page, which is the
// first thing a visitor sees — so the files exist from the start and get
// replaced with real captures one at a time.
//
//   node scripts/gen-placeholder.mjs                  # write any that are missing
//   node scripts/gen-placeholder.mjs --force          # rewrite all of them
//   node scripts/gen-placeholder.mjs path.png 1600 900  # one arbitrary file
//
// No dependency: zlib is built in, and a flat-colour PNG is a few dozen lines.
// (`npm run icons` uses sharp for the real icons — that is a devDependency and
// deliberately not required here.)
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DESKTOP = [1600, 900];
const MOBILE = [720, 1480];

/** path (relative to docs/screenshots/) -> what the real capture should show. */
export const SHOTS = {
  'inbox.png':               [DESKTOP, 'The three-pane view: folder sidebar, message list, reading pane'],
  'unified.png':             [DESKTOP, '"All inboxes" with a coloured account chip on every row'],
  'reading.png':             [DESKTOP, 'A message open in the reading pane, header chips and attachments visible'],
  'conversation.png':        [DESKTOP, 'Conversation view: newest message expanded, older ones collapsed above it'],
  'compose.png':             [DESKTOP, 'The floating composer with the formatting toolbar open'],
  'search.png':              [DESKTOP, 'Search results, with the scope selector visible'],
  'attachments.png':         [DESKTOP, 'The attachment preview overlay showing an image or PDF'],
  'analytics.png':           [DESKTOP, 'Mailbox analytics — the Overview tab'],
  'contacts.png':            [DESKTOP, 'Settings › Contacts, with the address book and suggestions'],
  'contact-groups.png':      [DESKTOP, 'Settings › Contacts, the Groups card — a group named, with its member editor open over the address book'],
  'compose-group.png':       [DESKTOP, 'The composer with a group offered in the recipient dropdown, and the `👥 Name` token already in To'],
  'saved-search-unread.png': [DESKTOP, 'The sidebar with unread counts on the 🔎 saved-search rows, beside the folder counts'],
  'calendar-month.png':      [DESKTOP, 'The calendar month view, with each calendar in its own colour'],
  'calendar-week.png':       [DESKTOP, 'The week view — the time grid, with an event spanning two columns'],
  'calendar-event.png':      [DESKTOP, 'The event form, with the repeat and reminder pickers visible'],
  'calendar-share.png':      [DESKTOP, 'Settings › Calendars › Share from Hmelj, with one source set to busy-only'],
  'app-passwords.png':       [DESKTOP, 'Settings › Login › App passwords, listing two devices'],
  'filters.png':             [DESKTOP, 'Settings › Filters, with one rule expanded'],
  'shortcuts.png':           [DESKTOP, 'The ? keyboard-shortcut overlay, over the message list'],
  'sender-auth.png':         [DESKTOP, 'A message with the Verified sender chip, and one with the failed-checks banner'],
  'snooze.png':              [DESKTOP, 'The snooze time picker open on a message, or the Snoozed view with due times'],
  'scheduler.png':           [DESKTOP, 'Settings › Scheduler — quiet hours and per-folder overrides'],
  'account-wizard.png':      [DESKTOP, 'The add-account wizard, on the provider/preset step'],
  'settings-general.png':    [DESKTOP, 'Settings › General'],
  'settings-accounts.png':   [DESKTOP, 'Settings › Accounts, listing two or three mail accounts'],
  'settings-admin.png':      [DESKTOP, 'Settings › Admin — users, sign-up, OAuth providers, presets, fonts'],
  'dark.png':                [DESKTOP, 'The same inbox in the dark theme'],
  'mobile/list.png':         [MOBILE,  'The message list on a phone'],
  'mobile/message.png':      [MOBILE,  'A message open on a phone'],
  'mobile/compose.png':      [MOBILE,  'The composer on a phone'],
  'mobile/menu.png':         [MOBILE,  'The bottom-sheet user menu on a phone'],
  'android/server-select.png': [MOBILE, 'The Android app\'s "enter your server URL" first-run screen'],
  'android/notification.png':  [MOBILE, 'A new-mail push notification with its Mark as read / Delete buttons'],
};

/* ---------------- PNG encoding ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A flat fill with a 1px border, so the placeholder reads as a deliberate frame
 *  rather than as a failed image load. */
function placeholderPng(width, height, fill = [0xe9, 0xed, 0xf2], border = [0xc3, 0xcc, 0xd7]) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: None
    const edgeRow = y === 0 || y === height - 1;
    for (let x = 0; x < width; x++) {
      const c = edgeRow || x === 0 || x === width - 1 ? border : fill;
      const p = row + 1 + x * 3;
      raw[p] = c[0]; raw[p + 1] = c[1]; raw[p + 2] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- main ---------------- */

function write(file, w, h) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, placeholderPng(w, h));
}

// Only when run directly — SHOTS is imported elsewhere (docs tooling) and
// importing it must not write files as a side effect.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const positional = args.filter((a) => !a.startsWith('--'));

  if (positional.length) {
    const [file, w = 1600, h = 900] = positional;
    write(path.resolve(file), +w, +h);
    console.log(`wrote ${file} (${w}x${h})`);
  } else {
    const base = path.join(ROOT, 'docs', 'screenshots');
    let written = 0, kept = 0;
    for (const [rel, [[w, h]]] of Object.entries(SHOTS)) {
      const file = path.join(base, rel);
      if (!force && fs.existsSync(file)) { kept++; continue; }
      write(file, w, h);
      written++;
    }
    console.log(`${written} placeholder(s) written, ${kept} existing file(s) left alone`);
  }
}
