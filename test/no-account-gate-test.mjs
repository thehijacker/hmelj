// Hmelj — the no-mailbox gate.
//
// A user with neither an account of their own nor one shared with them used to
// be able to press Compose, search, refresh and the rest; each one reached the
// server and came back with "No mail account selected", one toast per attempt.
// app.js now refuses those actions up front (requireAccount) and shows an empty
// state that offers the wizard instead.
//
// This is a SOURCE-level test, deliberately. The behaviour lives in a 5000-line
// browser module whose every function assumes a live DOM, a session and a
// server; standing that up here would test the mock. What actually rots is
// someone adding a twelfth mail action and forgetting the guard — and that is
// exactly what reading the source catches.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(REPO, 'public/css/app.css'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(REPO, 'public/i18n/en.json'), 'utf8'));
const sl = JSON.parse(fs.readFileSync(path.join(REPO, 'public/i18n/sl.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? ' — ' + extra : '')); }
};

console.log('the gate itself');
for (const fn of ['hasNoAccounts', 'requireAccount', 'addFirstAccount', 'applyAccountGate', 'renderNoAccountState']) {
  ok(new RegExp(`function ${fn}\\s*\\(`).test(app), `${fn}() exists`);
}
ok(/return !state\.accounts\?\.length/.test(app),
   'hasNoAccounts() reads state.accounts, which /api/accounts fills with owned AND shared-in');

console.log('every mail action is guarded');
// id -> the handler must mention requireAccount within a short window of the id.
const GUARDED = ['btn-compose', 'btn-fab-compose', 'btn-search', 'btn-refresh',
                 'btn-select-mode', 'btn-run-filters', 'btn-analytics', 'btn-folders-manage'];
for (const id of GUARDED) {
  const at = app.indexOf(`$('#${id}').addEventListener`);
  ok(at !== -1 && app.slice(at, at + 400).includes('requireAccount()'),
     `#${id} refuses without a mailbox`, at === -1 ? 'handler not found' : 'no requireAccount() nearby');
}
// Enter in the search box is a separate path from the search button.
const searchKeydown = app.indexOf("$('#search-input').addEventListener('keydown'");
ok(searchKeydown !== -1 && app.slice(searchKeydown, searchKeydown + 300).includes('requireAccount()'),
   'pressing Enter in the search box is guarded too, not just the button');

console.log('nothing repaints over the empty state');
ok(/async function loadMessages\(\)\s*\{[\s\S]{0,400}?hasNoAccounts\(\)/.test(app),
   'loadMessages() returns early when there is no mailbox');
ok(/if \(!state\.messages\.length\) \{\s*\n\s*if \(hasNoAccounts\(\)\)/.test(app),
   "renderList()'s empty branch defers to the empty state");

console.log('the wizard stays reachable');
// Scoped to that one statement: a 200-character window ran straight into the
// NEXT handler, which is guarded, and reported a false failure.
const accountsLine = app.split('\n').find((l) => l.includes("$('#btn-accounts-manage')")) || '';
ok(accountsLine !== '' && !accountsLine.includes('requireAccount'),
   'Mail accounts is NOT gated — it is how you escape the empty state', accountsLine.trim());
ok(app.includes("id=\"empty-add-account\""), 'the empty state carries its own Add button');

console.log('styling and strings');
ok(/body\.no-accounts/.test(css), 'app.css hides the mail chrome via body.no-accounts');
ok(/\.empty-state\s*\{/.test(css), '.empty-state is styled');
for (const s of ['Add a mail account first', 'No mail account yet', 'Add mail account']) {
  ok(en.strings[s] !== undefined && sl.strings[s] !== undefined, `"${s}" is translatable`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
