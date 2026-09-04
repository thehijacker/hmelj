// Hmelj — the two things worth asking before a message goes out.
//
//   "you said the file was attached, and it is not"
//   "you replied to one person, and there were nine"
//
// Both are pure functions over what is already on screen, deliberately: they
// run on every Send, they must never block on anything, and the part worth
// being sure about is the language handling (see test/compose-guards-test.mjs).
//
// ── Why the word lists are shaped this way ────────────────────────────────
// The table below is modelled on server/proofread.js's STOPWORDS: one array per
// language, so adding a third language is adding one array and nothing else.
// Hmelj ships English and Slovenian today and the composer already detects
// which of them is being typed (Proofread.language()).
//
// But detection is NOT trusted here, and that is the important decision. It
// needs several words to be confident, and the message this guard exists for is
// "Pozdravljeni, v prilogi." — four words, which is exactly when detection is
// still guessing. So when the language is unknown, EVERY list is scanned. A
// false positive costs one dismissed dialog; a false negative is the mail going
// out without the invoice, which is the whole point.
const ComposeGuards = (() => {
  const ATTACH_WORDS = {
    en: [
      'attached', 'attaching', 'attachment', 'attachments', 'enclosed', 'enclosing',
      'see attached', 'find attached', 'i attach', 'pfa',
    ],
    // Slovene inflects, so these are stems matched as whole words with any
    // ending — "priloga", "prilogi", "prilogo", "prilogah" are all the same
    // word to a reader and none of them can be left out.
    sl: [
      'priloga', 'prilogi', 'prilogo', 'priloge', 'prilogah', 'prilog',
      'priložen', 'priložena', 'priloženo', 'priloženi', 'prilozeno', 'prilozen',
      'prilagam', 'prilagamo', 'pripenjam', 'pripenjamo', 'pripeto',
      'priponka', 'priponki', 'priponko',
      'v prilogi', 'v priponki',
    ],
  };

  /**
   * Words that mean "attached" ANYWHERE in this text.
   *
   * `lang` is Proofread's answer: 'en', 'sl', or anything falsy/'auto' for "not
   * known yet", which scans everything — see the note above on why that is the
   * safe direction to be wrong in.
   */
  function mentionsAttachment(text, lang) {
    const hay = ' ' + String(text || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
    if (!hay.trim()) return false;
    const lists = ATTACH_WORDS[lang] ? [ATTACH_WORDS[lang]] : Object.values(ATTACH_WORDS);
    for (const list of lists) {
      for (const word of list) {
        // Whole words only, so "prilog" does not fire on "prilognjen" — but a
        // Slovene ending IS allowed to follow, which is what the stems above
        // rely on. Unicode-aware: \b would treat "č" as a boundary and match
        // inside words.
        const re = new RegExp(`(^|[^\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\p{L}{0,3}([^\\p{L}]|$)`, 'iu');
        if (re.test(hay)) return true;
      }
    }
    return false;
  }

  /**
   * Should the "you forgot the attachment" question be asked?
   *
   * `quotedText` is excluded by the caller, not here — a reply to somebody who
   * wrote "the invoice is attached" must not ask, because the sentence is not
   * this person's and the attachment was on the other message.
   */
  function missingAttachment({ text, attachmentCount, lang }) {
    if (attachmentCount > 0) return false;
    return mentionsAttachment(text, lang);
  }

  /**
   * Everyone who would be added by replying to all instead of to one.
   *
   * `mine` is the set of the user's own addresses — they are never "someone
   * else on the thread", and counting them is how this ends up asking about a
   * message with exactly one other person on it.
   *
   * Returns the addresses, so the caller can say how many and to whom rather
   * than only that there were some.
   */
  function replyAllWouldAdd({ to = [], cc = [], replyingTo = [], mine = [] }) {
    const norm = (a) => String(a?.address || a || '').trim().toLowerCase();
    const skip = new Set([...mine.map(norm), ...replyingTo.map(norm)].filter(Boolean));
    const out = [];
    for (const a of [...to, ...cc]) {
      const addr = norm(a);
      if (!addr || skip.has(addr)) continue;
      skip.add(addr); // a person on both To and Cc is still one person
      out.push(addr);
    }
    return out;
  }

  return { mentionsAttachment, missingAttachment, replyAllWouldAdd, ATTACH_WORDS };
})();
window.ComposeGuards = ComposeGuards;
