// Backspace takes a whole recipient (public/js/compose.js).
//
// Reported after the contact-group work shipped: picking a group commits
// `👥 Družina, ` and leaves the caret past the separator, so Backspace deleted
// "a", "n", "i"… and unpicking one group meant eleven presses. Outlook deletes
// the whole chip; these fields are plain <input>s holding one long string, so
// the boundary has to be worked out from the text.
//
// The two functions that do it are pure enough to run headlessly — the only
// things they touch are a value, a caret and setSelectionRange — so unlike
// test/compose-paste-test.mjs this does NOT copy the logic: it cuts the real
// functions out of the module and runs those. If they are renamed or moved the
// extraction fails loudly rather than testing a stale copy.
//
// What is being pinned is mostly the REFUSALS. Deleting a whole recipient when
// somebody meant to fix a typo is far worse than the bug this fixes, so every
// "keeps its ordinary meaning" case below is load-bearing.
//
//   node test/recipient-backspace-test.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../public/js/compose.js', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

/** One `function name(...) { … }` declaration, cut out by matching braces. */
function extract(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`compose.js no longer declares ${name}() — this test needs updating`);
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

let closedSuggest = 0;
const sandbox = { closeContactSuggest: () => closedSuggest++ };
vm.createContext(sandbox);
vm.runInContext(`${extract('recipientStart')}\n${extract('onRecipientBackspace')}`, sandbox);
const { recipientStart, onRecipientBackspace } = sandbox;

/** Presses Backspace with the caret at `caret` (default: end of the field) and
 *  reports what happened: `selected` is the text the press highlighted, or null
 *  when the press was left alone to delete a character as usual. */
function backspace(value, caret = value.length, extra = {}) {
  let range = null;
  const inputEl = {
    value,
    selectionStart: caret,
    selectionEnd: caret,
    setSelectionRange: (a, b) => { range = [a, b]; },
  };
  let prevented = false;
  onRecipientBackspace({ key: 'Backspace', preventDefault: () => { prevented = true; }, ...extra }, inputEl);
  return { prevented, selected: range ? value.slice(range[0], range[1]) : null };
}

console.log('where a recipient starts');
ok(recipientStart('ana@x.si', 8) === 0, 'the first one starts at 0');
ok(recipientStart('ana@x.si, bo@y.si', 17) === 9, 'the second starts after its separator and space');
ok(recipientStart('ana@x.si; bo@y.si', 17) === 9, 'a semicolon separates too — Outlook-style lists work');
// The reason this is not lastIndexOf(','): the comma in a quoted display name
// is part of somebody's name, and cutting there splits that person in half.
ok(recipientStart('"Novak, Bo" <bo@x.si>', 21) === 0,
  'a comma inside a quoted display name is NOT a separator');
ok(recipientStart('a@x.si, "Novak, Bo" <bo@y.si>', 29) === 7,
  'and the recipient after one still starts in the right place');

console.log('\nbackspace at a boundary takes the whole recipient');
ok(backspace('👥 Družina, ').selected === '👥 Družina, ',
  'the reported case: a group token just picked from the suggestions');
ok(backspace('👥 Družina, ').prevented === true, 'and the character delete is suppressed');
ok(backspace('ana@x.si, bo@y.si, ').selected === 'bo@y.si, ',
  'the last recipient of several, with its separator');
ok(backspace('ana@x.si,').selected === 'ana@x.si,',
  'the separator alone counts as a boundary — no trailing space needed');
ok(backspace('Ana Kralj <ana@x.si>, ').selected === 'Ana Kralj <ana@x.si>, ',
  'a full "Name <address>" goes as one thing');
ok(backspace('a@x.si, "Novak, Bo" <bo@y.si>, ').selected === '"Novak, Bo" <bo@y.si>, ',
  'and so does a display name with a comma in it');
ok(backspace('ana@x.si, bo@y.si, ').prevented && closedSuggest > 0,
  'the suggestion box is closed rather than left over the selection');

console.log('\nthe selection leaves the field clean');
{
  const value = 'ana@x.si, bo@y.si, ';
  const { selected } = backspace(value);
  ok(value.slice(0, value.length - selected.length) === 'ana@x.si, ',
    'what is left ends in ", " ready for the next name, not in a stray comma');
}

console.log('\nand keeps its ordinary meaning everywhere else');
ok(backspace('ana@x.si').selected === null,
  'mid-recipient, so a typo in the last address is still fixed one character at a time');
ok(backspace('ana@x.si, bo@y.si').selected === null, 'the same with an earlier recipient present');
ok(backspace('ana@x.si, bo').selected === null, 'and while a second one is being typed');
ok(backspace('').selected === null, 'an empty field has nothing to take');
ok(backspace('   ').selected === null, 'and neither has a field of spaces');
ok(backspace(', , ').selected === null, 'an empty segment collapses a character at a time');
ok(backspace('ana@x.si, bo@y.si', 4).selected === null, 'a caret parked mid-address deletes a character');
ok(backspace('ana@x.si, bo@y.si, ', 0).selected === null, 'and so does one at the very start');
ok(backspace('ana@x.si, ', undefined, { key: 'Delete' }).selected === null,
  'Delete is left alone — it already means "remove this contact from the address book"');
ok(backspace('ana@x.si, ', undefined, { ctrlKey: true }).selected === null,
  'Ctrl+Backspace keeps the browser\'s own delete-a-word');
ok(backspace('ana@x.si, ', undefined, { metaKey: true }).selected === null, 'and so does Cmd+Backspace');

console.log('\na press on an existing selection is the delete');
{
  let range = null;
  const inputEl = {
    value: 'ana@x.si, bo@y.si, ',
    selectionStart: 10,
    selectionEnd: 19,
    setSelectionRange: (a, b) => { range = [a, b]; },
  };
  let prevented = false;
  onRecipientBackspace({ key: 'Backspace', preventDefault: () => { prevented = true; } }, inputEl);
  ok(range === null && !prevented,
    'the second press falls through to the browser, which deletes what the first one selected');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
