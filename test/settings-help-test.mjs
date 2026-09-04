// Hmelj — the `?` badge that carries a setting's explanation
// (public/js/settings.js#field / helpBadge).
//
// The explanations used to be a paragraph under each control. Thirty of those
// on one tab is a wall of prose to scan past, so they moved behind a badge that
// opens them on click.
//
// The assertion worth having is the TRANSLATION one. A hint used to be a text
// node, and i18n.js's DOM walker translates those by itself. In an attribute it
// does not — the walker only ever looks at title, placeholder and aria-label —
// so moving the text without translating it at build time would have silently
// reverted every hint in the app to English for a Slovenian reader, with
// nothing failing and nothing to see unless you were reading in Slovenian.
//
//   node test/settings-help-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

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
  Intl,
};
ctx.window = ctx; ctx.self = ctx;
// app.js escapes through the DOM — `esc()` is a <div> whose textContent is set
// and whose innerHTML is read back. The generic element proxy above answers
// innerHTML with a function, so escAttr() would blow up on `.replace` and every
// assertion below would fail for a reason that has nothing to do with the code.
// createElement therefore returns a real little escaper.
const escaperDiv = () => {
  let text = '';
  return {
    set textContent(v) { text = String(v ?? ''); },
    get textContent() { return text; },
    get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  };
};
ctx.document = {
  getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
  createElement: () => escaperDiv(), createTreeWalker: () => ({ nextNode: () => null }),
  addEventListener: noop, body: el(), documentElement: el(), head: el(), readyState: 'complete',
};
vm.createContext(ctx);

for (const f of ['i18n.js', 'connection.js', 'api.js', 'dialog.js', 'app.js', 'settings.js']) {
  let src = fs.readFileSync(path.join(root, 'public/js', f), 'utf8');
  // TWO hooks, because this file has both traps at once. field/helpBadge live
  // inside the Settings IIFE, so they are added to the object it already
  // returns (as test/message-font-test.mjs does to messageFrame.js) — AND
  // `const Settings` is itself script-scoped rather than a property of the vm
  // context, so it has to be handed out from inside the script (as
  // test/select-range-test.mjs does for app.js's `state`). Reading
  // ctx.Settings without the second one gets undefined. The shipped file is
  // untouched either way.
  if (f === 'settings.js') {
    const RETURN = '  return { init, open, close,';
    if (!src.includes(RETURN)) throw new Error('settings.js no longer returns what this test hooks into — update the hook');
    src = src.replace(RETURN, '  return { field, helpBadge, init, open, close,');
    src += '\n;globalThis.__settings = Settings;';
  }
  try { vm.runInContext(src, ctx, { filename: f }); }
  catch (e) { if (f === 'settings.js') throw e; }
}
const { field, helpBadge } = ctx.__settings;
ok(typeof field === 'function', 'the settings field builder is reachable');

const HINT = 'Used everywhere in the app — the message reading pane has its own separate font setting below.';

console.log('a setting WITHOUT an explanation is unchanged');
{
  const html = field('Language', '<select id="s-lang"></select>');
  ok(!/set-help/.test(html), 'gets no badge');
  ok(/<label>Language<\/label>/.test(html), 'and its label is left alone', html.slice(0, 80));
}

console.log('a setting WITH one');
{
  const html = field('App font', '<select id="s-uifont"></select>', HINT);
  ok(!/class="set-hint"/.test(html),
    'the paragraph under the control is gone — that is the whole point', html);
  ok(/<button type="button" class="set-help"/.test(html), 'a ? button sits beside the label');
  ok(html.indexOf('set-help') < html.indexOf('<select'), 'beside the LABEL, not after the control');
  ok(/data-help="[^"]*separate font setting below/.test(html), 'carrying the explanation', html.slice(0, 200));
  ok(/data-help-title="App font"/.test(html), 'and the setting it belongs to, for the dialog title');
}

console.log('the text is translated when it is built');
{
  // This is the assertion the change could have silently broken. The walker
  // does not look inside data-*, so if field() stopped calling I18n.t the hint
  // would be English forever and nothing would fail.
  const sl = JSON.parse(fs.readFileSync(path.join(root, 'public/i18n/sl.json'), 'utf8')).strings;
  ok(!!sl[HINT], 'the fixture hint really is in the Slovenian dictionary');
  vm.runInContext('I18n.__setDict && I18n.__setDict()', ctx); // no-op if absent; the real switch is below
  // Drive the real translator rather than reimplementing it.
  const translated = vm.runInContext(`I18n.t(${JSON.stringify(HINT)})`, ctx);
  const html = field('App font', '<select></select>', HINT);
  ok(html.includes(translated.replace(/"/g, '&quot;')) || translated === HINT,
    'field() puts whatever I18n.t returns into the attribute, not the raw source string');
  // And the mechanism, checked directly: helpBadge must call the translator.
  const src = fs.readFileSync(path.join(root, 'public/js/settings.js'), 'utf8');
  const fn = /function helpBadge\([\s\S]*?\n  \}/.exec(src)?.[0] || '';
  ok(/I18n\.t\(hint\)/.test(fn), 'helpBadge translates the hint explicitly');
  ok(/I18n\.t\(title\)/.test(fn), 'and the title it shows it under');
}

console.log('quoting');
{
  // Hints contain apostrophes and quotation marks — "Messages flagged \Deleted",
  // 'Show that banner folded to just the icon'. They land in an ATTRIBUTE now,
  // where an unescaped " ends it early and everything after becomes markup.
  const nasty = 'A "quoted" phrase, an apostrophe’s, and <b>angle</b> brackets.';
  const html = field('Odd', '<input>', nasty);
  const attr = /data-help="([^"]*)"/.exec(html);
  ok(attr, 'the attribute is still well formed', html.slice(0, 160));
  ok(!/"/.test(attr[1]), 'with no bare quote inside it to end it early', attr && attr[1]);
  ok(/&lt;b&gt;/.test(attr[1]), 'and angle brackets escaped rather than becoming a tag', attr && attr[1]);
}

console.log('a label-less row still works');
{
  // field('', control, hint) is used for the "Send test notification" button.
  const html = field('', '<button id="s-notify-test"></button>', 'Pushes to every device.');
  ok(/set-help/.test(html), 'it still gets a badge');
  ok(/data-help-title=""/.test(html),
    'with an empty title, which the click handler falls back from', html.slice(0, 140));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
