// Every client script must EVALUATE, in the order index.html loads them.
//
// `node --check` cannot catch this class of bug: it parses, and a function
// declared in the wrong scope parses perfectly. The failure that prompted this
// test — Compose's IIFE returning a `pickSendTime` that had been defined inside
// init() instead of at IIFE scope — threw a ReferenceError while the IIFE was
// still evaluating, which left `const Compose` permanently in the temporal dead
// zone and took the whole app down at boot with
// "can't access lexical declaration 'Compose' before initialization".
//
// The DOM stub is deliberately shallow: this asserts that the scripts LOAD, not
// that they work. Anything reached only from an event handler or boot() is out
// of scope here and belongs in a browser.
//
//   node test/client-scripts-load-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
// Read the order out of index.html rather than restating it, so a newly added
// script is covered automatically instead of being silently skipped.
const files = [...html.matchAll(/<script src="\/js\/([^"]+)"><\/script>/g)].map((m) => m[1]);

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

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
ctx.state = { settings: {} };
vm.createContext(ctx);

console.log(`evaluating ${files.length} scripts in index.html order`);
for (const f of files) {
  let err = null;
  const src = fs.readFileSync(path.join(root, 'public/js', f), 'utf8');
  try { vm.runInContext(src, ctx, { filename: f }); }
  catch (e) {
    // Telling a scope bug from a shallow stub, WITHOUT instanceof: the error is
    // thrown inside the vm realm, so `e instanceof ReferenceError` is false for
    // a ReferenceError raised in there — which would have let this test miss the
    // exact bug it was written for.
    //
    // The discriminator that actually works: if the missing identifier is one
    // THIS FILE declares, it is in the wrong scope. If it is a browser global,
    // the stub is just too shallow.
    const undef = /^(\w+) is not defined$/.exec(e.message)?.[1];
    const declaredHere = undef && new RegExp(`(function|const|let|var|class)\\s+${undef}\\b`).test(src);
    const real = declaredHere || /before initialization/.test(e.message);
    err = `${e.constructor.name}: ${e.message}`;
    if (!real) { console.log(`  · ${f} stopped on a stub gap (${err}) — not a scope error`); continue; }
  }
  ok(!err, `${f} evaluates`, err || '');
}

// The globals other scripts reach for. A module whose IIFE threw leaves its
// binding in the dead zone, which is the exact shape of the bug above.
console.log('\nglobals other scripts depend on');
for (const [name, members] of [
  ['Compose', ['init', 'open', 'reopen', 'reply', 'forward', 'pickSendTime']],
  ['Proofread', ['init', 'open', 'close']],
  ['I18n', ['t']],
  ['API', ['send', 'scheduled', 'cancelScheduled', 'rescheduleScheduled']],
]) {
  let shape = null;
  try { shape = vm.runInContext(`typeof ${name} === 'object' ? Object.keys(${name}) : typeof ${name}`, ctx); }
  catch (e) { ok(false, `${name} is initialized`, e.message); continue; }
  ok(Array.isArray(shape), `${name} is initialized (not stuck in the TDZ)`, String(shape));
  if (Array.isArray(shape)) {
    const missing = members.filter((m) => !shape.includes(m));
    ok(!missing.length, `${name} exports ${members.join(', ')}`, missing.length ? `missing: ${missing}` : '');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
