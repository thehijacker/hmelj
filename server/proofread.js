// Hmelj — spell checking for the composer, Slovenian and English.
//
// Deliberately SPELLING ONLY. There is no grammar checking here: no a/an, no
// missing article, no agreement, no word order. Adding those means a real
// grammar engine (LanguageTool and friends are a second service and ~1GB of
// RAM), which was explicitly traded away in favour of running in-process with
// no extra container. The API this module presents is written so that trade
// can be revisited without touching the browser at all — see the note on
// check() below.
//
// Hunspell dictionaries via nspell (pure JS, no native build): dictionary-en
// (MIT AND BSD) and dictionary-sl (GPL-3.0 OR LGPL-2.1, the Amebis/Lugos
// sl_SI dictionary that LibreOffice and Firefox also use). Both are consumed
// unmodified as data, never linked or derived from, so the copyleft on the
// Slovenian one doesn't reach Hmelj's own code.
import nspell from 'nspell';
import { log } from './log.js';

const plog = log.scope('proofread');

export const LANGUAGES = ['en', 'sl'];
const DICT_MODULE = { en: 'dictionary-en', sl: 'dictionary-sl' };

// Measured on this dictionary set: English costs ~140ms and ~18MB, Slovenian
// ~1.6s and ~130MB. Both numbers are why nothing here loads at boot — a user
// who never opens the composer must not pay 150MB for a feature they don't
// use. They're also why a loaded dictionary is then kept for the life of the
// process rather than idle-unloaded: nspell()'s indexing pass is synchronous,
// so every reload would freeze the whole server (IMAP polling included) for
// that second and a half. Pay it once, at the moment the composer opens
// (see warm() and /api/proofread's `warm` flag), not on the send path.
const loaded = new Map();       // lang -> nspell instance
const loading = new Map();      // lang -> Promise, so two concurrent opens load once
const failed = new Set();       // lang -> don't retry a missing/corrupt dictionary every keystroke

async function instance(lang) {
  if (loaded.has(lang)) return loaded.get(lang);
  if (failed.has(lang)) return null;
  if (loading.has(lang)) return loading.get(lang);

  const p = (async () => {
    const t0 = Date.now();
    try {
      // Dynamic import, not a top-level one: these packages read their .aff/.dic
      // off disk with top-level await, so a static import would pull several MB
      // into memory merely because this module was imported.
      const dict = (await import(DICT_MODULE[lang])).default;
      const spell = nspell(dict);
      loaded.set(lang, spell);
      plog.info(`Loaded ${lang} dictionary in ${Date.now() - t0}ms`);
      return spell;
    } catch (e) {
      // A dictionary that won't load is a degraded feature, never a broken
      // server — the route turns this into a 503 the client disables itself on.
      failed.add(lang);
      plog.warn(`Could not load the ${lang} dictionary (spell checking disabled for it):`, e.message);
      return null;
    } finally {
      loading.delete(lang);
    }
  })();
  loading.set(lang, p);
  return p;
}

/** True once at least one dictionary is loaded or still loadable. */
export function available() {
  return LANGUAGES.some((l) => !failed.has(l));
}

/** Starts loading a language without waiting for it — called when the composer
 *  opens so the synchronous indexing pass happens while the user is still
 *  filling in recipients, rather than mid-sentence. */
export function warm(lang) {
  for (const l of lang && lang !== 'auto' ? [lang] : LANGUAGES) instance(l).catch(() => {});
}

// Words that are never worth flagging, checked before any dictionary is
// consulted. Kept here rather than in the browser so a future grammar backend
// behind the same route agrees with this one about what counts as a word.
const SKIP_RE = [
  /\d/,                       // 2026, h4x, ISO-8601 fragments
  /[@]/,                      // addresses
  /:\/\//,                    // URLs that survived tokenising
  /^\p{Lu}{1,5}$/u,           // short acronyms — PDF, CET, DDV
  /^.$/u,                     // single letters
  /\p{L}\.\p{L}/u,            // domain-ish a.b
];
const MAX_WORD = 64;

function skippable(word) {
  if (word.length > MAX_WORD) return true;
  return SKIP_RE.some((re) => re.test(word));
}

// Enough to separate two languages that share an alphabet, and cheap: these
// are the highest-frequency function words in each, and they're disjoint. Only
// consulted to break a tie in the dictionary scoring below, which is what
// actually does the work.
const STOPWORDS = {
  sl: new Set(['je', 'in', 'na', 'se', 'da', 'za', 'ki', 'so', 'ne', 'bo', 'pa', 'ali', 'kot', 'sem', 'lahko']),
  en: new Set(['the', 'and', 'is', 'to', 'of', 'in', 'that', 'it', 'for', 'was', 'with', 'you', 'are', 'this', 'have']),
};
const DETECT_SAMPLE = 80;
// Below this many usable words, an answer is a guess, not a detection — and
// saying so is the important part. The client keeps asking until detection is
// confident and only then stops re-detecting; without the flag it would relitigate
// the language on every two-word delta the user typed, which is how the first
// version of this ended up flip-flopping EN/SL forever.
const CONFIDENT_SAMPLE = 8;
// How far ahead the winner has to be. Slovenian and English share an alphabet and
// almost no vocabulary, so a genuine match wins by a mile; anything close is a
// short or mixed-language sample that shouldn't be trusted to stick.
const CONFIDENT_MARGIN = 0.12;

/**
 * Which language is this? Scored by how much of the sample each dictionary
 * recognises — the two share an alphabet but almost no vocabulary, so the
 * unknown-word ratio separates them cleanly and costs nothing extra, since both
 * dictionaries are already loaded to check with. Function words ("je"/"in" vs
 * "the"/"and") are folded in at half weight: they're the single most reliable
 * signal in a short sample, which is exactly where the ratio alone is weakest.
 *
 * @returns {{lang: string, confident: boolean}} `confident` false means "this is
 *   the best guess available, but don't build anything on it" — see above.
 */
export async function detect(words, fallback = 'en') {
  const sample = words.filter((w) => !skippable(w)).slice(0, DETECT_SAMPLE);
  if (sample.length < 3) return { lang: fallback, confident: false };

  const scores = [];
  for (const lang of LANGUAGES) {
    const spell = await instance(lang);
    if (!spell) continue;
    let known = 0;
    let stop = 0;
    for (const w of sample) {
      if (spell.correct(w)) known++;
      if (STOPWORDS[lang].has(w.toLowerCase())) stop++;
    }
    scores.push({ lang, score: known / sample.length + (stop / sample.length) * 0.5 });
  }
  if (!scores.length) return { lang: fallback, confident: false };

  scores.sort((a, b) => b.score - a.score);
  const margin = scores.length > 1 ? scores[0].score - scores[1].score : 1;
  return {
    lang: scores[0].lang,
    confident: sample.length >= CONFIDENT_SAMPLE && margin >= CONFIDENT_MARGIN,
  };
}

// A paste of a document in some third language would otherwise ask nspell for
// suggestions on thousands of words, each a fresh edit-distance search. Past
// this many the words still come back flagged, just without suggestions.
const SUGGEST_BUDGET = 200;
const MAX_SUGGESTIONS = 5;

/**
 * Checks a list of words — not a document. The browser has to tokenise anyway
 * (it needs the offsets to place underlines), so handing whole text down here
 * would only mean parsing it twice and teaching this module about HTML. The
 * client sends the DISTINCT unknown words it has found and caches the verdicts,
 * so after the first pass a keystroke typically asks about one word.
 *
 * The response shape — {language, bad: {word: [suggestions]}} — is the part
 * worth keeping stable: it says nothing about how the checking was done, so a
 * grammar engine could answer this same route later without the browser
 * noticing. (It would need a second, offset-carrying field for multi-word
 * matches; the `bad` map stays as-is.)
 *
 * @param {string[]} words
 * @param {string} language 'auto' | 'en' | 'sl'
 * @param {Set<string>} custom lowercased words from the user's own dictionary
 */
export async function check(words, language = 'auto', custom = new Set()) {
  // Detection runs ONLY when the caller says 'auto'. Told a language, this
  // answers in that language and reports it back unchanged — which is what lets
  // the client stop the conversation about which language this is instead of
  // reopening it on every keystroke.
  const detection = language === 'auto' || !LANGUAGES.includes(language)
    ? await detect(words)
    : { lang: language, confident: true };
  const lang = detection.lang;

  const spell = await instance(lang);
  if (!spell) return { language: lang, confident: false, bad: {}, unavailable: true };

  const bad = {};
  let budget = SUGGEST_BUDGET;
  for (const word of words) {
    if (skippable(word) || custom.has(word.toLowerCase())) continue;
    if (spell.correct(word)) continue;
    bad[word] = budget-- > 0 ? spell.suggest(word).slice(0, MAX_SUGGESTIONS) : [];
  }
  return { language: lang, confident: detection.confident, bad };
}
