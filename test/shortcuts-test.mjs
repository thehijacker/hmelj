// Keyboard shortcuts (public/js/shortcuts.js).
//
// This suite exists because of a bug that shipped: shortcuts.js treated
// app.js#renderedRows() as a list of DOM elements when it actually returns
// MESSAGE OBJECTS. `r.dataset.key` on a plain object throws, handle()'s catch
// swallowed the throw, and every shortcut that acts on a message silently did
// nothing — while `?` (which touches no rows) worked perfectly, so the key map
// looked fine and the bug read as "the key does nothing".
//
// So the rule this file enforces is: the stubs below must match app.js's REAL
// contracts, not convenient ones. `renderedRows` returns message objects here
// because that is what it returns there; a test that stubbed elements would
// have passed against the broken code.
//
//   node test/shortcuts-test.mjs
import fs from 'fs';
import vm from 'vm';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

/** A minimal DOM good enough for the shortcut layer, and honest about the two
 *  places it genuinely touches elements: the cursor class and scrollIntoView. */
// app.js identifies a row by (account, folder, uid), not by uid — see makeRowKey
// there. Mirrored rather than imported, for the same reason every other stub
// here is: the point is to hold shortcuts.js to app.js's real contract, and a
// key that disagreed with it would show up in the fixtures below.
const key = (m) => `${m?.account?.id || ''}\u0000${m?.folder || 'INBOX'}\u0000${m?.uid}`;

function makeCtx({ messages, openUid = null, activeTag = 'BODY', open = {} } = {}) {
  const calls = { reply: null, forward: null, toggleRead: [], del: [], refile: [], star: 0, snooze: [], compose: 0, help: 0, back: 0, opened: [] };
  const lis = messages.map((m) => ({
    dataset: { key: key(m) },
    classList: { _c: new Set(), toggle(n, on) { on ? this._c.add(n) : this._c.delete(n); }, has(n) { return this._c.has(n); } },
    scrollIntoView() { calls.scrolled = this.dataset.key; },
    querySelector: (sel) => (sel === '.m-star' ? { click: () => { calls.star++; } } : null),
    getBoundingClientRect: () => ({ left: 10, bottom: 20 }),
  }));
  const listeners = {};
  const state = {
    settings: {}, messages, openKey: openUid == null ? null : key({ uid: openUid }), cursorKey: null, currentFolder: 'INBOX',
    openMessage: open.uid ? open : null,
  };
  const ctx = {
    console: { warn() {}, error(...a) { calls.error = a.join(' '); } },
    window: { addEventListener() {}, getSelection: () => null },
    document: {
      activeElement: { tagName: activeTag, isContentEditable: activeTag === 'CE' },
      addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === '#msg-list .msg-row' ? lis : []),
      createElement: () => ({ style: {}, classList: { add() {} } }),
    },
    state,
    // THE CONTRACT THAT MATTERED: message objects, not elements (app.js).
    renderedRows: () => messages,
    rowKey: key,
    rowUnread: (m) => !m.seen,
    quickToggleRead: (m) => calls.toggleRead.push(m.uid),
    quickDelete: (m) => calls.del.push(m.uid),
    quickRefile: (m, box) => calls.refile.push([m.uid, box]),
    refileFor: (m, box) => (box === 'archive' ? { folder: 'INBOX' } : null),
    openMessage: async (m) => { calls.opened.push(m.uid); state.openMessage = { ...m, __folder: 'INBOX' }; },
    navCollapseOneLevel: () => { calls.back++; },
    snoozeRow: (m) => calls.snooze.push(m.uid),
    Compose: {
      reply: (msg, all) => { calls.reply = { uid: msg.uid, all }; },
      forward: (msg) => { calls.forward = msg.uid; },
      isOpen: () => false, open: () => { calls.compose++; },
    },
    Dialog: { alert: () => { calls.help++; } },
    Settings: { isOpen: () => false }, AttachmentViewer: { isOpen: () => false },
    Analytics: { isOpen: () => false }, MessageFind: { isOpen: () => false },
    MessageFrame: { onKeyMessage: (cb) => { ctx.__frameKey = cb; } },
    I18n: { t: (s) => s }, toast: () => {}, esc: (s) => s, escAttr: (s) => s,
    $: () => ({ focus() {}, select() {} }),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../public/js/shortcuts.js', import.meta.url), 'utf8'), ctx);
  vm.runInContext('Shortcuts.init()', ctx);
  const fire = (init) => {
    let taken = false;
    for (const fn of listeners.keydown || []) taken = fn({ altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, preventDefault() { taken = true; }, ...init }) || taken;
    return taken;
  };
  return { ctx, calls, fire, lis, state };
}

const MSGS = [{ uid: 1, seen: true, subject: 'one' }, { uid: 2, seen: false, subject: 'two' }, { uid: 3, seen: true, subject: 'three' }];

console.log('the bug that shipped: acting on a message');
{
  // No cursor set, one message OPEN — exactly what "click a message, press r"
  // is. uid 1 is READ, so Ctrl+U has something to do (see the next block for
  // why pressing it on an already-unread message must not toggle).
  const { calls, fire } = makeCtx({ messages: MSGS, openUid: 1, open: { uid: 1, __folder: 'INBOX' } });
  fire({ key: 'r' });
  ok(calls.reply?.uid === 1, 'r replies to the OPEN message', JSON.stringify(calls.reply) + ' err=' + (calls.error || ''));
  ok(calls.reply?.all === false, 'and to the sender only');
  fire({ key: 'a' });
  ok(calls.reply?.all === true, 'a replies to all');
  fire({ key: 'u', ctrlKey: true });
  ok(calls.toggleRead.includes(1), 'Ctrl+U marks it unread');
  ok(!calls.error, 'and nothing threw — a swallowed throw is what hid this the first time', calls.error);
}

console.log('\nCtrl+Q / Ctrl+U name a direction rather than toggling');
{
  const { calls, fire } = makeCtx({ messages: MSGS, openUid: 2, open: { uid: 2 } }); // uid 2 is UNREAD
  fire({ key: 'u', ctrlKey: true });
  ok(calls.toggleRead.length === 0, 'Ctrl+U on an already-unread message does nothing — pressing it twice must not mark it read');
  fire({ key: 'q', ctrlKey: true });
  ok(calls.toggleRead.includes(2), 'Ctrl+Q on it marks it read');
}

console.log('\nmoving the cursor');
{
  const { calls, fire, state, lis } = makeCtx({ messages: MSGS });
  fire({ key: 'j' });
  ok(state.cursorKey === key({ uid: 1 }), 'the first press lands on the first row, not the second');
  fire({ key: 'j' });
  ok(state.cursorKey === key({ uid: 2 }), 'then advances');
  fire({ key: 'k' });
  ok(state.cursorKey === key({ uid: 1 }), 'and goes back');
  fire({ key: 'k' });
  ok(state.cursorKey === key({ uid: 1 }), 'stopping at the top rather than wrapping');
  for (let i = 0; i < 9; i++) fire({ key: 'j' });
  ok(state.cursorKey === key({ uid: 3 }), 'and at the bottom');
  ok(lis[2].classList.has('cursor') && !lis[0].classList.has('cursor'), 'the cursor class follows it');
  ok(calls.scrolled === key({ uid: 3 }), 'and the row is scrolled into view');
}

console.log('\nacting advances, so a run of mail can be cleared without looking');
{
  const { calls, fire, state } = makeCtx({ messages: MSGS });
  fire({ key: 'j' });               // cursor on 1
  fire({ key: 'delete' });
  ok(calls.del.includes(1), 'Del deletes the cursor row');
  ok(state.cursorKey === key({ uid: 2 }), 'and the cursor moves on');
  fire({ key: 'e' });
  ok(calls.refile.some(([u, b]) => u === 2 && b === 'archive'), 'e archives');
}

console.log('\nkeys that need no message still work with an empty list');
{
  const { calls, fire } = makeCtx({ messages: [] });
  fire({ key: '?', shiftKey: true });
  ok(calls.help === 1, '? opens the help');
  fire({ key: 'c' });
  ok(calls.compose === 1, 'c composes');
  fire({ key: 'r' });
  ok(calls.reply === null, 'and r does nothing rather than throwing', calls.error);
}

console.log('\nwhen a keystroke is NOT ours');
for (const [why, opts, init] of [
  ['the caret is in a text field', { activeTag: 'INPUT' }, { key: 'r' }],
  ['the caret is in a contenteditable', { activeTag: 'CE' }, { key: 'r' }],
  ['Alt is held (a menu accelerator)', {}, { key: 'r', altKey: true }],
  ['Meta is held (the OS owns it)', {}, { key: 'r', metaKey: true }],
]) {
  const { calls, fire } = makeCtx({ messages: MSGS, openUid: 2, open: { uid: 2 }, ...opts });
  fire(init);
  ok(calls.reply === null, why);
}

console.log('\nkeys pressed inside the message body are forwarded, not lost');
{
  const { calls, ctx } = makeCtx({ messages: MSGS, openUid: 2, open: { uid: 2 } });
  ok(typeof ctx.__frameKey === 'function', 'the frame channel is subscribed to');
  // A forwarded event is a plain object with no preventDefault, from a document
  // whose activeElement this side cannot see — so the busy() guard is skipped.
  ctx.__frameKey({ key: 'r', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false });
  ok(calls.reply?.uid === 2, 'a key from inside the body still acts', calls.error);
}

console.log('\nevery binding is reachable and documented');
{
  const { ctx } = makeCtx({ messages: MSGS });
  const b = vm.runInContext('Shortcuts.BINDINGS', ctx);
  ok(b.length >= 15, `${b.length} bindings`);
  ok(b.every((x) => x.keys?.length && x.help && typeof x.run === 'function'), 'each has keys, a help line and a handler');
  const all = b.flatMap((x) => x.keys);
  ok(new Set(all).size === all.length, 'no key is bound twice', all.filter((k, i) => all.indexOf(k) !== i).join());
  ok(all.includes('delete') && all.includes('ctrl+q') && all.includes('ctrl+u'), "Outlook's Del, Ctrl+Q and Ctrl+U are all there");
  ok(!all.includes('ctrl+f'), 'and Ctrl+F is NOT taken — it stays "find in message"');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
