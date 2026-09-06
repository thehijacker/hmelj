// The composer's formatting toolbar (public/js/compose.js).
//
// WHAT THIS FILE CAN AND CANNOT PROVE — same situation, and the same approach,
// as test/compose-paste-test.mjs: compose.js is an IIFE whose internals a vm
// cannot reach, and execCommand needs a real contenteditable with a real
// selection. So the pure helpers are cut out and run for real, and the
// decisions that are load-bearing but only observable in a browser are pinned
// against the module source instead.
//
// The pinned ones are not arbitrary. Each is a choice that looks like a detail
// and is not:
//
//   - **indent and outdent must use styleWithCSS.** With it off, Chrome
//     implements indent by wrapping the selection in a <blockquote> — the same
//     element the ❝ Quote button makes. Indenting inside a quote, or quoting
//     something indented, would then produce nesting neither button could undo,
//     and the mail would arrive looking quoted when it was only indented.
//   - **the quote style must be byte-identical to quoteBlock()'s**, or a quote
//     you made and a quote Hmelj made on a reply are two different-looking
//     things in the recipient's client.
//   - **the emoji button must survive plain-text mode.** An emoji is a
//     character, not formatting; disabling it with the rest of the bar would be
//     the obvious thing to do and would be wrong.
//
//   node test/compose-toolbar-test.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../public/js/compose.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
const eq = (got, want, m) => ok(got === want, m, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/** One `const NAME = …;` or `function NAME(…){…}` lifted out of the module. */
function extract(decl, name) {
  const at = src.indexOf(decl);
  if (at < 0) throw new Error(`compose.js no longer declares ${name} — this test needs updating`);
  if (decl.startsWith('function')) {
    // Start at the BODY, not at the first `{` — a destructured parameter list
    // (`function f({ extras = '' } = {})`) has braces of its own, and counting
    // from those closes the function at the end of its signature.
    let parens = 0, bodyAt = -1;
    for (let i = at; i < src.length; i++) {
      if (src[i] === '(') parens++;
      else if (src[i] === ')' && --parens === 0) { bodyAt = src.indexOf('{', i); break; }
    }
    if (bodyAt < 0) throw new Error(`could not find the body of ${name}`);
    let depth = 0;
    for (let i = bodyAt; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
  }
  const end = /\n\s*\];/.exec(src.slice(at));
  if (!end) throw new Error(`could not find the end of ${name}`);
  return src.slice(at, at + end.index + end[0].length);
}

console.log('the four text sizes');
{
  const sandbox = {};
  vm.createContext(sandbox);
  // `const` at a vm context's top level does not become a property of the
  // context object the way a function declaration does — hand it out explicitly.
  vm.runInContext(`${extract('const SIZES = [', 'SIZES')}\nglobalThis.__sizes = SIZES;`, sandbox);
  const SIZES = sandbox.__sizes;
  eq(SIZES.length, 4, 'four of them, like Gmail');
  ok(SIZES.every((s) => s.size >= 1 && s.size <= 7),
    'every one is a legal execCommand fontSize — that command speaks 1-7 and nothing else');
  ok(SIZES.every((s, i) => i === 0 || s.size > SIZES[i - 1].size), 'and they are in increasing order');
  ok(SIZES.every((s, i) => i === 0 || s.px > SIZES[i - 1].px), 'so are the preview sizes the picker draws with');
  eq(SIZES.find((s) => s.label === 'Normal').size, 3, 'Normal is 3 — the browser default, so it un-does the others');
}

console.log('\nthe emoji-recent list');
{
  const store = new Map();
  const sandbox = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    },
    EMOJI_RECENT_KEY: 'hmelj-emoji-recent',
    EMOJI_RECENT_MAX: 24,
    JSON,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extract('function recentEmoji(', 'recentEmoji')}\n${extract('function pushRecentEmoji(', 'pushRecentEmoji')}`, sandbox);
  const { recentEmoji, pushRecentEmoji } = sandbox;

  eq(recentEmoji().length, 0, 'nothing remembered yet');
  pushRecentEmoji('😀');
  pushRecentEmoji('🎉');
  eq(recentEmoji().join(''), '🎉😀', 'most recent first');
  pushRecentEmoji('😀');
  eq(recentEmoji().join(''), '😀🎉', 'picking one again moves it to the front rather than adding it twice');
  eq(recentEmoji().length, 2, 'and does not grow the list');
  for (let i = 0; i < 40; i++) pushRecentEmoji(String(i));
  eq(recentEmoji().length, 24, 'capped');
  eq(recentEmoji()[0], '39', 'keeping the newest');
  // A browser in private mode throws on setItem. An emoji picker that cannot
  // remember is fine; one that throws mid-insert is not.
  sandbox.localStorage.setItem = () => { throw new Error('QuotaExceeded'); };
  let threw = false;
  try { pushRecentEmoji('🙂'); } catch { threw = true; }
  ok(!threw, 'storage that refuses to write is survived, not thrown from');
  store.set('hmelj-emoji-recent', 'not json');
  sandbox.localStorage.setItem = (k, v) => store.set(k, v);
  eq(recentEmoji().length, 0, 'and so is a corrupt stored value');
}

console.log('\nthe markup dialect each command emits (pinned against the module)');
{
  const cssSet = /const CSS_COMMANDS = new Set\(\[([^\]]*)\]\)/.exec(src);
  ok(cssSet, 'CSS_COMMANDS is still declared');
  const list = cssSet[1];
  // The two that MUST be CSS. Presentational indent is a <blockquote> in
  // Chrome, which collides head-on with the Quote button.
  for (const cmd of ['indent', 'outdent']) {
    ok(list.includes(`'${cmd}'`), `${cmd} uses styleWithCSS — otherwise it emits a <blockquote> and collides with Quote`);
  }
  for (const cmd of ['justifyLeft', 'justifyCenter', 'justifyRight']) {
    ok(list.includes(`'${cmd}'`), `${cmd} uses styleWithCSS — the alternative is a deprecated align= attribute`);
  }
  // The ones that must NOT be, so they emit the old presentational tags every
  // mail client renders without argument.
  for (const cmd of ['fontName', 'fontSize', 'foreColor', 'bold', 'italic', 'underline']) {
    ok(!list.includes(`'${cmd}'`), `${cmd} stays presentational (<font>/<b>) — what Outlook renders best`);
  }
}

console.log('\na quote you made and a quote Hmelj made are the same object');
{
  const constant = /const QUOTE_STYLE = '([^']+)'/.exec(src);
  ok(constant, 'QUOTE_STYLE is still declared');
  ok(src.includes('<blockquote style="${QUOTE_STYLE}">'),
    'quoteBlock() builds its reply quote from that same constant, not a copy of it');
  ok(src.includes("formatBlockStyled('blockquote', QUOTE_STYLE)"), 'and so does the ❝ Quote menu item');
  ok(constant[1].includes('border-left'), 'the style is INLINE — the recipient has none of our CSS');
}
{
  const code = /const CODE_STYLE = '([^']+)'\s*\n?\s*\+ "([^"]+)"/.exec(src);
  ok(code, 'CODE_STYLE is still declared');
  ok((code[1] + code[2]).includes('pre-wrap'),
    'a code block wraps rather than scrolling — a pasted terminal line on a 360px phone otherwise runs off forever');
}

console.log('\nplain-text mode');
{
  ok(/if \(b\.dataset\.panel !== 'emoji' && b\.id !== 'c-lang'\) b\.disabled = plain/.test(src),
    'emoji stays enabled in plain text — it inserts a character, not formatting');
  ok(src.includes('function insertEmoji'), 'and insertEmoji has a textarea path for that mode');
  ok(/setRangeText/.test(src), 'which writes at the caret rather than appending');
}

console.log('\nthe remembered composer size');
{
  ok(src.includes("el().classList.toggle('large', isNarrow() || wantsLarge())"),
    'open() honours the remembered size, or forces large on a narrow screen');
  ok(/if \(isNarrow\(\)\) return;\s*\n\s*try \{ localStorage\.setItem\(COMPOSE_LARGE_KEY/.test(src),
    'a phone never STORES a size — it is always large there, so storing "small" would store an answer that screen is never asked');
}

console.log('\nthe toolbar is built once and used three times');
{
  // The buttons are BUILT, not written into index.html — Settings' signature
  // and template editors call the same function, which is the only thing
  // stopping "the options I get when writing a message" from becoming three
  // different sets of buttons.
  const sandbox = {
    esc: (x) => String(x),
    escAttr: (x) => String(x),
    I18n: { t: (x) => x },
  };
  vm.createContext(sandbox);
  vm.runInContext(extract('function richToolbarHtml(', 'richToolbarHtml'), sandbox);
  const bar = sandbox.richToolbarHtml();

  for (const cmd of ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList', 'createLink']) {
    ok(bar.includes(`data-cmd="${cmd}"`), `${cmd} is on the bar`);
  }
  for (const panel of ['font', 'size', 'color', 'emoji']) {
    ok(bar.includes(`data-panel="${panel}"`), `the ${panel} picker is on the bar`);
  }
  ok(bar.includes('data-more="1"'), 'and so is the ⋯ menu');
  // Settings appends two of its own (insert image, edit source) — the composer
  // has no use for either, so they are not baked in here.
  ok(sandbox.richToolbarHtml({ extras: '<button class="sig-img"></button>' }).includes('sig-img'),
    'extras are appended, so Settings can add the two buttons only it needs');

  ok(html.includes('<div class="tb-scroll"></div>'),
    'index.html carries the empty container, not a second copy of the buttons');
  ok(/Compose\.richToolbarHtml\(\{ extras \}\)/.test(fs.readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8')),
    'and Settings builds its editors from the same call');
}

console.log('\nthe toolbar on a phone');
{
  // The language chip and the Plain toggle are state, not actions: they say what
  // the composer currently is, and must not be able to scroll out of sight.
  const toolbar = /<div class="editor-toolbar" id="editor-toolbar">([\s\S]*?)\n      <\/div>/.exec(html)[1];
  const scrollAt = toolbar.indexOf('tb-scroll');
  ok(toolbar.indexOf('id="c-lang"') > scrollAt && !/tb-scroll"[^>]*>[\s\S]*c-lang[\s\S]*<\/div>/.test(toolbar),
    'the language chip is outside the scrolling part');
  ok(toolbar.includes('id="c-plain"'), 'and so is the Plain toggle');
  ok(/\.editor-toolbar \.tb-scroll \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto/.test(css),
    'which scrolls sideways instead of wrapping onto three rows');
  ok(/\.compose-popover \{[\s\S]*?max-height: calc\(100lvh/.test(css),
    'every picker is bounded by the LARGE viewport, so an iOS PWA does not cut one off');
}

console.log('\nthe editor writes at NORMAL weight, whatever the app font is set to');
{
  // body { font-weight: var(--ui-weight) } is right for the interface and wrong
  // for the message. With the App weight at 500 or 700 the browser read the
  // editor's text as already bold, so execCommand('bold') UNbolded it — the
  // Bold button did the opposite of its label. Reported exactly that way.
  ok(/\.compose-editor \{[^}]*font-weight: 400/.test(css), 'the composer editor pins font-weight: 400');
  ok(/\.sig-rich \{[^}]*font-weight: 400/.test(css), 'and so does the signature/template editor');
}

console.log('\nthe bar says what the caret is inside');
{
  ok(src.includes('function syncToolbarState'), 'there is a state sync');
  ok(/queryCommandState/.test(src), 'driven by queryCommandState, the only thing that answers this at all');
  const cmds = /const STATE_COMMANDS = \[([\s\S]*?)\];/.exec(src)[1];
  for (const cmd of ['bold', 'italic', 'underline', 'strikeThrough']) {
    ok(cmds.includes(`'${cmd}'`), `${cmd} lights up`);
  }
  ok(/\.editor-toolbar button\.active \{/.test(css), 'and there is a style for a lit button');
  // One listener for every editor there will ever be. Settings re-renders its
  // whole tab on each edit, so a per-editor selectionchange listener would leak
  // one per signature per interaction, each holding a detached editor alive.
  ok(src.includes('let selectionWatching = false;'),
    'selectionchange is watched exactly once, not once per editor wired');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
