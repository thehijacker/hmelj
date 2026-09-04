// Hmelj — a minimal ZIP writer, for "download all attachments" (see the
// attachments.zip route in server/index.js).
//
// Hand-rolled rather than a dependency, for the same reason icalendar.js,
// vcard.js, rrule.js and contentLine.js are: the part of the format actually
// needed here is small and completely specified, and the alternative is a
// package in the tree for two hundred lines of struct packing. Node already
// supplies the only hard part — DEFLATE, via zlib.
//
// What it writes: one local header + data per entry, a central directory, and
// an end-of-central-directory record. No Zip64, no encryption, no data
// descriptors, no directory entries. That is the whole of what a mail
// attachment bundle needs, and every unzip tool reads it.
//
// ── Two things that are easy to get wrong and are handled here ──────────────
//
//  1. FILENAME ENCODING. A ZIP name is bytes with no declared charset unless
//     general-purpose bit 11 says UTF-8. Attachment names here are routinely
//     Slovenian ("Potrditev naročila.pdf"), so the bit is set and the name is
//     written as UTF-8 — without it those come out mojibake on Windows.
//
//  2. SIZES ARE BYTES, NOT CHARACTERS. Both the local header and the central
//     directory state the name length in BYTES; taking it from name.length
//     silently corrupts the archive for any non-ASCII name, and the corruption
//     is at the END of the file (the central directory offsets), so small
//     ASCII-only tests never see it.
import zlib from 'node:zlib';

/** Refused rather than truncated: past either of these the format needs Zip64,
 *  which this does not write, and producing an archive that silently unpacks
 *  wrong is worse than saying no. Neither is reachable with mail attachments —
 *  a mail server would have rejected the message long before. */
export const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
export const MAX_ENTRIES = 60000;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** CRC-32 as ZIP defines it, over a Buffer. */
export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * A name safe to put in an archive, and safe for whatever unpacks it.
 *
 * Path separators go, and so does a leading run of dots: an entry called
 * `../../x` or `/etc/x` is how a malicious archive writes outside the folder it
 * was extracted into ("zip slip"). The names here come from mail somebody else
 * sent, so they are exactly the untrusted input that attack uses.
 */
export function safeEntryName(name, fallback = 'attachment') {
  let n = String(name || '')
    .replace(/[\\/]/g, '_')                 // no path separators, no traversal
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')        // control characters
    .replace(/^\.+/, '')                    // no leading dots: "..", ".."
    .trim();
  // Windows refuses these outright, whatever the extension.
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = `_${n}`;
  if (!n) n = fallback;
  // 255 bytes is the practical filename limit on every filesystem this lands
  // on; cut on BYTES, and not through the middle of a character.
  let buf = Buffer.from(n, 'utf8');
  if (buf.length > 255) {
    buf = buf.subarray(0, 255);
    n = buf.toString('utf8').replace(/�+$/, ''); // drop a half-eaten character
  }
  return n;
}

/**
 * Makes every name in a list unique, the way a file manager would: "a.pdf",
 * "a (2).pdf", "a (3).pdf".
 *
 * Mail routinely carries several attachments with the same name — three
 * "image001.png" from a forwarded Outlook thread is the normal case, not an
 * odd one. A ZIP may legally hold duplicates, but what happens on extraction
 * is then up to the tool: usually the last one silently wins, so two of the
 * three attachments are lost.
 */
export function uniqueNames(names) {
  const seen = new Map();
  return names.map((raw) => {
    const name = safeEntryName(raw);
    const key = name.toLowerCase(); // Windows and macOS both compare this way
    if (!seen.has(key)) { seen.set(key, 1); return name; }
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let n = seen.get(key);
    let candidate;
    do { n += 1; candidate = `${stem} (${n})${ext}`; } while (seen.has(candidate.toLowerCase()));
    seen.set(key, n);
    seen.set(candidate.toLowerCase(), 1);
    return candidate;
  });
}

/** MS-DOS date/time, which is what a ZIP entry carries. Seconds have 1-second
 *  granularity halved (the field holds seconds/2), and the epoch is 1980 — a
 *  date before that cannot be expressed, so it is clamped rather than wrapped
 *  into a nonsense year. */
function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const day = (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, day };
}

/**
 * Builds a ZIP from `[{ name, data, date }]` and hands back one Buffer.
 *
 * In memory on purpose: the attachments are already whole Buffers by the time
 * they get here (the mail layer fetches them that way), so streaming would add
 * machinery without removing the copy that actually costs anything.
 */
export function zipSync(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length > MAX_ENTRIES) {
    throw Object.assign(new Error(`Too many files for one archive (${list.length})`), { status: 400 });
  }
  const total = list.reduce((n, e) => n + (e.data?.length || 0), 0);
  if (total > MAX_TOTAL_BYTES) {
    throw Object.assign(new Error('Those attachments are too large to bundle into one download'), { status: 413 });
  }

  const names = uniqueNames(list.map((e) => e.name));
  const chunks = [];
  const central = [];
  let offset = 0;

  list.forEach((entry, i) => {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const nameBuf = Buffer.from(names[i], 'utf8');
    const { time, day } = dosDateTime(entry.date);
    const crc = crc32(data);

    // DEFLATE, unless it made things bigger — which it does for anything
    // already compressed, and a mail attachment usually IS already compressed
    // (pdf, jpeg, png, docx, xlsx are all zip or zip-like inside). Storing
    // those costs nothing and saves the CPU.
    const deflated = data.length ? zlib.deflateRawSync(data, { level: 6 }) : Buffer.alloc(0);
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    // 0x0800 is general-purpose bit 11: "the name is UTF-8". Without it a
    // name like "naročilo.pdf" is read in the unpacker's local codepage.
    const flags = 0x0800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed (2.0 — deflate)
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // no extra field
    chunks.push(local, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);     // central directory header signature
    dir.writeUInt16LE(20, 4);             // version made by
    dir.writeUInt16LE(20, 6);             // version needed
    dir.writeUInt16LE(flags, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);             // extra length
    dir.writeUInt16LE(0, 32);             // comment length
    dir.writeUInt16LE(0, 34);             // disk number
    dir.writeUInt16LE(0, 36);             // internal attributes
    dir.writeUInt32LE(0, 38);             // external attributes
    dir.writeUInt32LE(offset, 42);        // where this entry's local header is
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  });

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory signature
  end.writeUInt16LE(0, 4);                // this disk
  end.writeUInt16LE(0, 6);                // disk with the central directory
  end.writeUInt16LE(list.length, 8);      // entries on this disk
  end.writeUInt16LE(list.length, 10);     // entries total
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);          // where the central directory starts
  end.writeUInt16LE(0, 20);               // comment length

  return Buffer.concat([...chunks, centralBuf, end]);
}
