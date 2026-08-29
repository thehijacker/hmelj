// Hmelj — server-side lookup into the SAME translation catalogs the frontend
// uses (public/i18n/<lang>.json), for the handful of strings this server
// generates that a user actually reads.
//
// Today that's exactly one thing: the "Mark as read" / "Delete" buttons on a
// push notification (server/sync.js#notifyNewMail). Those are rendered by the
// OS/browser from the payload the server sends, long after any page could
// translate them — the notification typically exists BECAUSE nothing of ours
// is running on that device — so unlike every other visible string in this
// app, they cannot go through public/js/i18n.js. A Slovenian user was getting
// English buttons on an otherwise Slovenian app.
//
// Deliberately reuses the frontend's own JSON rather than starting a second,
// server-side catalog: one file per language stays the place where a
// translation is added or fixed. Only the flat `strings` map is consulted —
// the `prefixes`/`regexes` fallbacks in i18n.js exist for DOM text that this
// will never be asked about.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './log.js';

const I18N_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'i18n');

// Read once per language per process. These files only change when the app
// itself is updated (which means a restart), so there's nothing to invalidate.
const catalogs = new Map();

function stringsFor(lang) {
  if (catalogs.has(lang)) return catalogs.get(lang);
  let strings = {};
  // Guard the filename: `lang` comes from a user's settings file, and this
  // builds a path from it.
  if (/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(lang || '')) {
    try {
      strings = JSON.parse(fs.readFileSync(path.join(I18N_DIR, `${lang}.json`), 'utf8')).strings || {};
    } catch (e) {
      // A missing file is the ordinary case for 'en' (its catalog is an
      // identity map anyway) and for any language that hasn't been added yet.
      log.debug(`i18n: no server-readable catalog for "${lang}" (${e.message}) — falling back to English`);
    }
  }
  catalogs.set(lang, strings);
  return strings;
}

/** Translate one English source string (the keys ARE the English text, same
 *  convention as I18n.t) into `lang`, falling back to the English itself. */
export function t(lang, key) {
  if (!lang || lang === 'en') return key;
  const s = stringsFor(lang)[key];
  return s === undefined ? key : s;
}
