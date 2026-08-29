// Hmelj — the prefix rule in public/js/i18n.js.
//
// Background: a toast is built as a fixed prefix plus whatever the server said,
// e.g. 'Could not send: ' + e.message. i18n matched the prefix and returned the
// remainder untouched, so a Slovenian user saw
//   "Pošiljanje ni bilo mogoče: No mail account configured"
// — half translated. The remainder now gets a translation pass of its own.
//
// Both halves matter and are asserted here: a KNOWN server message must
// translate, and an UNKNOWN suffix (a hostname, an SMTP server's own words)
// must still pass through untouched, which is why the rule existed.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sl = JSON.parse(fs.readFileSync(path.join(REPO, 'public/i18n/sl.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(REPO, 'public/i18n/en.json'), 'utf8'));
const src = fs.readFileSync(path.join(REPO, 'public/js/i18n.js'), 'utf8');

/** The real i18n.js, driven headlessly against the real dictionaries. */
function load(dict) {
  const sandbox = {
    fetch: async () => ({ ok: true, statusText: 'OK', json: async () => dict }),
    console,
    document: {
      documentElement: { lang: 'en' },
      body: { nodeType: 1, closest: () => null, getAttribute: () => null, childNodes: [] },
      querySelectorAll: () => [],
      createTreeWalker: () => ({ nextNode: () => null }),
    },
    MutationObserver: class { observe() {} disconnect() {} },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // `const I18n = …` is script-scoped, not a global — hand it out explicitly.
  vm.runInContext(src + '\n;globalThis.__I18n = I18n;', sandbox);
  return sandbox.__I18n;
}

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '\n      ' + extra : '')); }
};
const eq = (got, want, msg) => ok(got === want, msg, `got:  ${got}\n      want: ${want}`);

const I18n = load(sl);
await I18n.init('sl');
const t = I18n.t;

console.log('a fixed server message after a translated prefix');
eq(t('Could not send: No mail account configured'),
   'Pošiljanje ni bilo mogoče: Ni nastavljenega poštnega računa',
   'the send failure a user with no account hits is fully translated');
eq(t('Draft save failed: No mail account selected (missing ?account= parameter)'),
   'Shranjevanje osnutka ni uspelo: Izbran ni noben poštni račun',
   'and so is the draft failure');
eq(t('No mail account configured'), 'Ni nastavljenega poštnega računa',
   'the same message on its own');

console.log('what must NOT change');
eq(t('Could not send: 550 5.7.1 relay denied by mx.example.com'),
   'Pošiljanje ni bilo mogoče: 550 5.7.1 relay denied by mx.example.com',
   'a variable suffix still passes through — that is what the prefix rule is for');
eq(t('Compose'), 'Novo sporočilo', 'ordinary strings are unaffected');
eq(t('a string nobody has ever translated'), 'a string nobody has ever translated',
   'an unknown string comes back as-is');

console.log('English is a pass-through');
const EnI18n = load(en);
await EnI18n.init('en');
eq(EnI18n.t('Could not send: No mail account configured'),
   'Could not send: No mail account configured',
   'nothing is rewritten when the language is English');

console.log('the dictionaries agree');
const missing = Object.keys(en.strings).filter((k) => sl.strings[k] === undefined);
ok(missing.length === 0, 'every English key has a Slovenian entry',
   missing.length ? `${missing.length} missing, e.g. ${JSON.stringify(missing.slice(0, 3))}` : '');
const untranslated = Object.entries(sl.strings)
  .filter(([k, v]) => k === v && /^[A-Z].* .*[a-z]$/.test(k) && k.split(' ').length > 3);
ok(untranslated.length === 0, 'no Slovenian entry is just the English copied over',
   untranslated.length ? `e.g. ${JSON.stringify(untranslated.slice(0, 3).map(([k]) => k))}` : '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
