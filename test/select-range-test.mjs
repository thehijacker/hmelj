// Hmelj — Shift+click range selection in the message list
// (public/js/app.js's selectRangeTo / renderedRows).
//
// Worth pinning down because a wrong range doesn't look wrong: it ticks a set
// of rows, they all look equally ticked, and the next thing that happens is
// usually Delete. Off-by-one at either end, or a range read in the wrong
// direction, quietly takes a message the user never picked.
//
// app.js is a classic script, not a module — so it's evaluated in a vm context
// (the same trick test/client-scripts-load-test.mjs uses, and the same shallow
// stub philosophy). Its `state` and `$` are top-level `const`s, which are
// SCRIPT-scoped rather than properties of the context: setting ctx.state from
// out here is silently shadowed and every assertion comes back empty (which is
// how the first version of this file managed to pass nothing). So one line is
// appended to the source before evaluating, inside the same script scope, to
// hand the real bindings out. The shipped file is untouched.
//
//   node test/select-range-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m, `got ${JSON.stringify(a)}`);

const noop = () => {};
const el = () => new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : (t[k] = ['style', 'dataset', 'classList'].includes(k) ? el() : noop)),
  set: (t, k, v) => ((t[k] = v), true),
});
const ctx = {
  console: { ...console, debug: noop },
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  addEventListener: noop, removeEventListener: noop, requestAnimationFrame: noop,
  fetch: () => Promise.reject(new Error('offline in test')),
  location: { pathname: '/', hash: '', href: '/', replace: noop },
  navigator: { serviceWorker: new Proxy({}, { get: () => noop }), userAgent: 'test' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  innerWidth: 1200, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
  CSS: { highlights: undefined, escape: (s) => s },
  URLSearchParams, URL, Blob: function () {}, FileReader: function () {}, Image: function () {},
  Notification: undefined, EventSource: function () { return new Proxy({}, { get: () => noop }); },
};
ctx.window = ctx;
ctx.self = ctx;
ctx.document = {
  getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
  createElement: () => el(), createTreeWalker: () => ({ nextNode: () => null }),
  addEventListener: noop, body: el(), documentElement: el(), head: el(), readyState: 'complete',
};
// The list the fake DOM hands back, re-pointed per fixture by showList().
let domRows = [];
ctx.document.querySelector = (sel) => (sel === '#msg-list' ? { querySelectorAll: () => domRows } : el());
vm.createContext(ctx);

// Only the scripts app.js needs to have evaluated before it. A stub gap that
// stops one of them early is fine here — client-scripts-load-test.mjs is what
// asserts they load cleanly; this file only needs app.js's own top level to run.
for (const f of ['i18n.js', 'connection.js', 'api.js', 'dialog.js', 'app.js']) {
  let src = fs.readFileSync(path.join(root, 'public/js', f), 'utf8');
  // See the header: appended INSIDE app.js's own script scope, which is the
  // only place its top-level consts are visible from.
  if (f === 'app.js') src += '\n;globalThis.__t = { state, selectRangeTo, rowKey, rowKeys };';
  try { vm.runInContext(src, ctx, { filename: f }); }
  catch (e) { if (f === 'app.js') throw e; }
}

const { state, selectRangeTo, rowKey, rowKeys } = ctx.__t;
ok(typeof selectRangeTo === 'function', 'selectRangeTo is reachable at app.js top level');
ok(state && 'selectAnchorKey' in state, 'and state carries the range anchor it reads');

/** The list on screen, newest first, as buildRow would have drawn it. `thread`
 *  makes a row a conversation of several messages, which selects as one. */
function showList(rows, shown = null) {
  state.messages = rows;
  // renderedRows() reads the DOM, deliberately (see its comment) — so the DOM
  // is what the fixture has to provide, and it has to carry the same ROW KEY
  // (account + folder + uid) buildRow puts on a real <li>. A uid alone is not a
  // row: two accounts can both have uid 12345 in their INBOX.
  domRows = (shown || rows).map((m) => ({ dataset: { key: rowKey(m) } }));
}

const msg = (uid, extra = {}) => ({ uid, folder: 'INBOX', subject: `m${uid}`, ...extra });
/** Runs the gesture and reports which UIDS ended up selected, in list order —
 *  the selection itself holds row keys, but every fixture here is one account,
 *  so reporting uids keeps the assertions readable. The cross-account case at
 *  the bottom looks at the keys themselves. */
function shiftClick({ anchor, on, already = [] }) {
  state.selected = new Set(already.map((u) => rowKey(msg(u))));
  state.selectAnchorKey = anchor == null ? null : rowKey(msg(anchor));
  const hit = selectRangeTo(state.messages.find((m) => m.uid === on));
  return { hit, picked: [...state.selected].map((k) => Number(k.slice(k.lastIndexOf('\u0000') + 1))) };
}

console.log('a plain run of messages');
showList([1, 2, 3, 4, 5, 6].map((u) => msg(u)));
{
  const r = shiftClick({ anchor: 1, on: 5 });
  ok(r.hit, 'the gesture reports it drew a range');
  eq(r.picked, [1, 2, 3, 4, 5], 'anchor at the top: everything between, BOTH ends included');
}
eq(shiftClick({ anchor: 5, on: 1 }).picked, [1, 2, 3, 4, 5],
  'and upwards gives exactly the same range — direction is not part of the answer');
eq(shiftClick({ anchor: 3, on: 3 }).picked, [3], 'anchor and target the same row: just that row');
eq(shiftClick({ anchor: 1, on: 6 }).picked, [1, 2, 3, 4, 5, 6], 'the whole list');
eq(shiftClick({ anchor: 2, on: 4 }).picked, [2, 3, 4], 'a range in the middle takes neither end of the list with it');

console.log('it only ever ADDS');
eq(shiftClick({ anchor: 4, on: 6, already: [1] }).picked, [1, 4, 5, 6],
  'a row picked earlier, outside the new range, survives it');
eq(shiftClick({ anchor: 2, on: 3, already: [2, 3, 4, 5] }).picked, [2, 3, 4, 5],
  'a SHORTER second range does not re-cut the selection — nothing is unpicked');

console.log('conversations go in whole');
showList([msg(10), msg(20, { threadUids: [20, 21, 22], threadCount: 3 }), msg(30)]);
eq(shiftClick({ anchor: 10, on: 30 }).picked, [10, 20, 21, 22, 30],
  'every message of a conversation inside the range is selected, not just its row');

console.log('no usable anchor');
showList([1, 2, 3].map((u) => msg(u)));
{
  const r = shiftClick({ anchor: null, on: 2 });
  ok(!r.hit, 'nothing clicked yet: no range');
  eq(r.picked, [], 'and nothing is selected — the caller falls back to a plain Ctrl+click');
}
{
  // A leftover anchor from another list must not match by number alone.
  const r = shiftClick({ anchor: 99, on: 2 });
  ok(!r.hit, 'an anchor that is not in this list draws no range');
  eq(r.picked, [], 'rather than a wrong one');
}
{
  state.selected = new Set();
  state.selectAnchorKey = rowKey(msg(1));
  ok(!selectRangeTo(msg(77)), 'a target that is not in the list is refused too');
}

console.log('the order shown is the order used');
{
  // state.messages in one order, the DOM in another (what a sort leaves behind).
  // renderedRows reads the DOM on purpose: a range means "what is between these
  // two AS DISPLAYED".
  const rows = [msg(1), msg(2), msg(3), msg(4)];
  showList(rows, [msg(4), msg(3), msg(2), msg(1)]);
  state.selected = new Set();
  state.selectAnchorKey = rowKey(msg(3));
  selectRangeTo(rows.find((m) => m.uid === 1));
  eq([...state.selected].map((k) => Number(k.slice(k.lastIndexOf('\u0000') + 1))).sort((a, b) => a - b), [1, 2, 3],
    'the range follows the rendered order, not the array order');
}

console.log('two accounts, one uid — All inboxes');
{
  // The reason a row is keyed by (account, folder, uid) and not by uid: IMAP
  // hands out low numbers per folder, so the same uid in two accounts is
  // ordinary. Keyed by uid alone, picking one row ticked the other as well and
  // the next Delete took a message the user never chose.
  const a = { uid: 12345, folder: 'INBOX', account: { id: 'gmail-thj' }, subject: 'mine' };
  const b = { uid: 12345, folder: 'INBOX', account: { id: 'gmail-andrej' }, subject: 'theirs' };
  const c = { uid: 7, folder: 'INBOX', account: { id: 'gmail-andrej' }, subject: 'other' };
  showList([a, b, c]);
  ok(rowKey(a) !== rowKey(b), 'the same uid in two accounts is two different rows');

  state.selected = new Set();
  state.selectAnchorKey = rowKey(a);
  ok(selectRangeTo(a), 'a range from a row to itself is still a range');
  eq([...state.selected], [rowKey(a)], 'and it picks that account\'s message ONLY');

  state.selected = new Set();
  state.selectAnchorKey = rowKey(a);
  selectRangeTo(c);
  eq([...state.selected], [rowKey(a), rowKey(b), rowKey(c)],
    'a range across the collision takes both of them, because both are in it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
