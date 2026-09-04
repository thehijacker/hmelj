// Hmelj — finding the "join the call" link an invitation carries.
//
// A meeting invitation almost never puts its join URL in a field designed for
// it. Microsoft has `onlineMeeting.joinUrl` and Exchange 2013 has
// `JoinOnlineMeetingUrl`, but a Teams meeting forwarded by somebody else, a
// Zoom link pasted into the notes, or anything at all coming over CalDAV
// arrives as a URL sitting in the description — usually inside a wall of
// boilerplate, legal footers and dial-in numbers.
//
// So: prefer a real field where one exists, and otherwise pick the link out of
// the text. Ranked, not first-match — a Teams block contains a "learn more"
// link and a tenant privacy policy alongside the actual join URL, and taking
// the first URL found lands on the wrong one.
//
// Deliberately conservative about what counts. A bare link to a shared document
// is not a join URL, and offering a "Join" button that opens a SharePoint file
// is worse than offering none.

/** Hosts whose links are join URLs, most specific pattern first. The path
 *  matters: `teams.microsoft.com/l/meetup-join/...` is a meeting,
 *  `teams.microsoft.com/l/channel/...` is not. */
const PROVIDERS = [
  { name: 'Teams',   re: /https?:\/\/teams\.(?:microsoft|live)\.com\/l\/meetup-join\/[^\s"'<>)\]]+/i },
  { name: 'Teams',   re: /https?:\/\/teams\.microsoft\.com\/dl\/launcher\/[^\s"'<>)\]]+/i },
  { name: 'Meet',    re: /https?:\/\/meet\.google\.com\/[a-z0-9-]{6,}[^\s"'<>)\]]*/i },
  { name: 'Zoom',    re: /https?:\/\/(?:[\w-]+\.)?zoom\.(?:us|com)\/[js]\/[^\s"'<>)\]]+/i },
  { name: 'Webex',   re: /https?:\/\/(?:[\w-]+\.)?webex\.com\/[^\s"'<>)\]]*\/j\.php[^\s"'<>)\]]*/i },
  { name: 'Webex',   re: /https?:\/\/(?:[\w-]+\.)?webex\.com\/meet\/[^\s"'<>)\]]+/i },
  { name: 'Jitsi',   re: /https?:\/\/meet\.jit\.si\/[^\s"'<>)\]]+/i },
  { name: 'Whereby', re: /https?:\/\/(?:[\w-]+\.)?whereby\.com\/[^\s"'<>)\]]+/i },
  { name: 'GoTo',    re: /https?:\/\/(?:[\w-]+\.)?gotomeet(?:ing)?\.(?:com|me)\/[^\s"'<>)\]]+/i },
  { name: 'BlueJeans', re: /https?:\/\/(?:[\w-]+\.)?bluejeans\.com\/[^\s"'<>)\]]+/i },
  { name: 'Chime',   re: /https?:\/\/(?:[\w-]+\.)?chime\.aws\/[^\s"'<>)\]]+/i },
  { name: 'Skype',   re: /https?:\/\/join\.skype\.com\/[^\s"'<>)\]]+/i },
  { name: 'Skype for Business', re: /https?:\/\/meet\.[^\s"'<>)\]]+\/[^\s"'<>)\]]*\/[A-Z0-9]{8}\b/i },
];

/** A URL lifted out of text often drags punctuation in with it — a full stop
 *  ending the sentence, or the closing bracket of "(join here)". */
function tidy(url) {
  let u = String(url).replace(/&amp;/gi, '&').trim();
  while (/[.,;:!?)\]}>'"]$/.test(u)) {
    // A closing bracket that has a matching opener inside the URL is part of
    // it — SharePoint and Confluence links really do contain them.
    const last = u.at(-1);
    const pairs = { ')': '(', ']': '[', '}': '{' };
    if (pairs[last] && u.split(pairs[last]).length > u.split(last).length) break;
    u = u.slice(0, -1);
  }
  return u;
}

/**
 * The join URL for a meeting, or ''.
 *
 * Pass the most authoritative source first: a provider's own field, then the
 * location, then the description. The first *provider match* in the first text
 * that has one wins — so a Zoom link in the location beats a Teams link buried
 * in a forwarded description below it, which is the right way round when
 * somebody has rescheduled a call onto a different service.
 */
export function findJoinUrl(...texts) {
  for (const text of texts) {
    const s = String(text || '');
    if (!s) continue;
    // An explicit URL on its own, already known to be a join link.
    if (/^https?:\/\/\S+$/.test(s.trim())) return tidy(s.trim());
    for (const p of PROVIDERS) {
      const m = p.re.exec(s);
      if (m) return tidy(m[0]);
    }
  }
  return '';
}

/** Which service a join URL belongs to, for the button's label. '' when it is
 *  a link Hmelj recognized by shape but cannot name. */
export function providerOf(url) {
  const s = String(url || '');
  for (const p of PROVIDERS) if (p.re.test(s)) return p.name;
  return '';
}

/**
 * An HTML body reduced to readable text.
 *
 * Exchange and Graph hand over the notes as HTML, and putting that straight
 * into the UI would be both ugly and an injection route. The links have to
 * survive though — `<a href="…">Join</a>` with the URL only in the attribute is
 * exactly the Teams case — so an anchor whose text is not already its own URL
 * keeps the address alongside the label.
 */
export function htmlToText(html) {
  return decodeEntities(stripMarkup(String(html || ''))).trim();
}

/**
 * Entity decoding, always — not only for a body that has tags.
 *
 * Exchange asked for `BodyType="Text"` on an item stored as HTML gives back a
 * best-effort conversion that has dropped the tags and LEFT THE ENTITIES: a
 * meeting request arrives reading
 *
 *   Organizer: Gregor Fuis &lt;gregor.fuis@example.si&gt;&#xD;
 *
 * There is no markup left for a tag test to find, so gating this on one is
 * exactly wrong. The SOAP layer already decoded its own escaping once; this
 * undoes the second layer underneath it.
 */
export function decodeEntities(text) {
  const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', bull: '•', middot: '·',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
    laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
    deg: '°', euro: '€', pound: '£', times: '×', shy: '',
  };
  return String(text || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    const key = e.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key[0] === '#') {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      // Anything else is left as written: an entity read as the wrong
      // character is worse than one left visible.
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

/**
 * Tags out, links kept.
 *
 * `<a href="…">Join</a>` with the URL only in the attribute is the normal Teams
 * case, so an anchor whose text is not already its own URL keeps the address
 * beside the label — in PARENTHESES, because the tag-stripping pass below would
 * eat `<https://…>` as if it were markup.
 */
function stripMarkup(s) {
  if (!/<[a-z!/]/i.test(s)) return s;
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
      const text = label.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
      if (!text) return ` ${href} `;
      if (text === href || href.includes(text) || text.includes(href)) return ` ${href} `;
      return ` ${text} (${href}) `;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');
}

/**
 * An RFC 2047 encoded-word, decoded.
 *
 * These belong in mail HEADERS, but Exchange copies an invitation's attendee
 * list into the body verbatim — so a meeting request arrives listing
 * `Janez =?utf-8?Q?=C5=A0travs?=` where it means `Janez Štravs`. Left alone it
 * is unreadable, and it is the attendee's actual name.
 */
export function decodeEncodedWords(text) {
  return String(text || '').replace(
    /=\?([A-Za-z0-9_-]+)\?([BbQq])\?([^?]*)\?=/g,
    (m, charset, enc, payload) => {
      try {
        const cs = /utf-?8/i.test(charset) ? 'utf8'
          : /iso-8859-1|latin1|windows-1252/i.test(charset) ? 'latin1' : null;
        if (!cs) return m;
        if (enc.toUpperCase() === 'B') return Buffer.from(payload, 'base64').toString(cs);
        // Q: underscore is a space, =XX is a byte. Decoded as BYTES first and
        // then as text, or a two-byte character comes out as two wrong ones.
        const bytes = [];
        const q = payload.replace(/_/g, ' ');
        for (let i = 0; i < q.length; i++) {
          if (q[i] === '=' && /^[0-9a-f]{2}$/i.test(q.slice(i + 1, i + 3))) {
            bytes.push(parseInt(q.slice(i + 1, i + 3), 16)); i += 2;
          } else bytes.push(q.charCodeAt(i) & 0xff);
        }
        return Buffer.from(bytes).toString(cs);
      } catch { return m; }
    },
  );
}

/**
 * Everything a provider's notes need before they are readable: entities out of
 * a "text" body that never had them removed, encoded-words turned back into
 * names, and line endings normalized so the UI's one newline rule works.
 *
 * `isHtml` only decides whether tags are stripped. The other two passes run
 * either way, because that is exactly the case that was broken.
 */
export function readableNotes(raw, { isHtml = false } = {}) {
  const stripped = isHtml ? stripMarkup(String(raw || '')) : String(raw || '');
  return decodeEncodedWords(decodeEntities(stripped))
    // CRLF and bare CR both become one newline. A body carrying literal &#xD;
    // decodes to a lone \r, which renders as nothing at all and silently runs
    // every line of a meeting request together.
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Teams and Webex pad an invitation with tens of lines of boilerplate. The
 *  notes are worth showing, but not at unbounded length in a dialog. */
export function trimNotes(text, max = 4000) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}
