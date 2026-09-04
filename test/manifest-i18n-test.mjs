// Hmelj — the web app manifest is translated too.
//
// The manifest is the one visible string table public/js/i18n.js can never
// reach: the OS reads it when the app is INSTALLED and builds the window title
// and the taskbar right-click jump list from it, long before any of our
// JavaScript runs. A Slovenian user who pinned Hmelj to the taskbar got an
// English "Compose" in the jump list for exactly that reason.
//
// So every user-visible string in the manifest has to exist as a key in the
// catalogs — which is the thing that silently regresses the next time somebody
// adds a shortcut.
//
//   node test/manifest-i18n-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'public/manifest.webmanifest'), 'utf8'));
const sl = JSON.parse(fs.readFileSync(path.join(REPO, 'public/i18n/sl.json'), 'utf8')).strings;

const { t } = await import('../server/pushI18n.js');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
const eq = (got, want, m) => ok(got === want, m, `got ${got}, want ${want}`);

console.log('every translatable string in the manifest has a Slovenian entry');
ok(manifest.shortcuts?.length > 0, 'there are shortcuts to translate at all');
for (const sc of manifest.shortcuts) {
  ok(sl[sc.name] !== undefined, `the "${sc.name}" shortcut is in the catalog`);
  ok(sl[sc.name] !== sc.name, `and is actually translated, not copied`);
}
ok(sl[manifest.description] !== undefined, 'so is the description');

console.log('the server translates them the same way the frontend does');
eq(t('sl', 'Compose'), sl.Compose, 'the jump-list entry matches the catalog exactly');
eq(t('en', 'Compose'), 'Compose', 'English is the key itself');
eq(t('xx', 'Compose'), 'Compose', 'and an unknown language falls back rather than failing');

console.log('the app is not renamed');
// `name`/`short_name` are deliberately NOT translated: "Hmelj" is the
// application's name, not a word, and translating it would rename it in the
// launcher and split one installed app into two identities.
eq(manifest.short_name, 'Hmelj', 'short_name is the app name');
ok(!sl.Hmelj, 'and is not something the catalogs would rewrite');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
