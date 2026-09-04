// Hmelj — Settings > Reading > Message font / size, and whether they reach the
// message.
//
// The reported bug: "I change the message font and nothing happens." They were
// applied — as `body{font-family:…;font-size:…}` with no !important. Plain text
// inherits that and does change. HTML mail does not: it states its fonts ON THE
// ELEMENTS, in inline style attributes, its own <style> block, <font> tags and
// table attributes, every one of which outranks a bare body rule. So on
// essentially every real email the picker did nothing, silently.
//
// Asserted against the document the frame actually builds, because that is the
// whole mechanism — there is no logic to unit-test, only what the generated CSS
// says and who wins the cascade.
//
//   node test/message-font-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

// messageFrame.js is a classic script whose helpers live inside an IIFE, so
// unlike app.js (see test/select-range-test.mjs) appending to the END of the
// file lands OUTSIDE the closure and reaches nothing. buildDoc is added to the
// object the IIFE already returns instead — one substitution, on the source
// text, in memory. The shipped file is untouched.
const noop = () => {};
const el = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : (t[k] = ['style', 'dataset', 'classList'].includes(k) ? el() : noop)), set: (t, k, v) => ((t[k] = v), true) });
const ctx = {
  console, setTimeout, clearTimeout, queueMicrotask, addEventListener: noop, removeEventListener: noop,
  location: { origin: 'http://x' }, navigator: { userAgent: 'test' },
  document: {
    getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
    createElement: () => el(), addEventListener: noop, body: el(), documentElement: el(), head: el(),
  },
  matchMedia: () => ({ matches: false, addEventListener: noop }),
};
ctx.window = ctx; ctx.self = ctx;
vm.createContext(ctx);
const src = fs.readFileSync(path.join(root, 'public/js/messageFrame.js'), 'utf8');
const RETURN = '  return { create, buildFontFaceCss,';
if (!src.includes(RETURN)) throw new Error('messageFrame.js no longer returns what this test hooks into — update the hook');
vm.runInContext(src.replace(RETURN, '  return { buildDoc, create, buildFontFaceCss,'), ctx, { filename: 'messageFrame.js' });
const buildDoc = ctx.MessageFrame?.buildDoc;
ok(typeof buildDoc === 'function', 'the frame document builder is reachable');

const base = { dark: false, bg: '#fff', fg: '#111', link: '#00f', dim: '#888', fonts: [] };
const doc = (opts) => buildDoc({ ...base, ...opts });

console.log('the setting reaches the document at all');
{
  const d = doc({ text: 'hello', fontFamily: 'serif', fontSize: 22 });
  ok(/body\{font-family:serif,/.test(d), 'the chosen family is written onto body');
  ok(/font-size:22px/.test(d), 'and so is the chosen size');
}

console.log('override OFF — the message keeps its own fonts (the default)');
{
  const d = doc({ html: '<p>hi</p>', fontFamily: 'serif', fontSize: 22, fontOverride: false });
  ok(!/font-family:serif,system-ui,sans-serif!important/.test(d),
     'nothing is forced, so a designed newsletter still looks like itself');
  ok(!/Proportional text scaling/.test(d), 'and no sizes are rewritten');
}

console.log('override ON — the font wins');
{
  const d = doc({ html: '<p style="font-family:Arial;font-size:11px">hi</p>', fontFamily: 'serif', fontSize: 22, fontOverride: true });
  // The cascade is the whole point: an inline style attribute beats any plain
  // rule, so only !important on a universal selector can outrank it.
  ok(/\*,\*::before,\*::after\{font-family:serif,system-ui,sans-serif!important;\}/.test(d),
     'every element is forced to the chosen family, !important, so inline styles lose');
  ok(/Proportional text scaling/.test(d), 'and the size pass is included');
  ok(/var factor = 22 \/ 15;/.test(d), 'scaling by the chosen size against the 15px baseline', /var factor = [^;]*/.exec(d)?.[0]);
  // Sizes are SCALED, never flattened — a heading has to stay bigger than the
  // body text under it, which one forced font-size for everything would destroy.
  ok(!/font-size:22px!important/.test(d), 'no single size is forced onto everything');
  ok(/sizes\[j\] \* factor/.test(d), 'each element keeps its own size, multiplied');
}

console.log('the size pass reads before it writes');
{
  // A child sized in em resolves against its parent. Scaling parents while
  // walking would scale such a child twice — once through its parent, once on
  // its own. Two loops, and the assertion is that there are two.
  const d = doc({ html: '<p>hi</p>', fontFamily: 'serif', fontSize: 20, fontOverride: true });
  const body = /Proportional text scaling[\s\S]*?\}\)\(\);/.exec(d)?.[0] || '';
  const loops = (body.match(/for \(var/g) || []).length;
  ok(loops === 2, 'measured in one pass, applied in a second', `${loops} loop(s)`);
  ok(body.indexOf('sizes.push') < body.indexOf('setProperty'), 'and the reads come first');
}

console.log('a size equal to the baseline does no work at all');
{
  const d = doc({ html: '<p>hi</p>', fontFamily: 'serif', fontSize: 15, fontOverride: true });
  ok(/Math.abs\(factor - 1\) < 0.001/.test(d),
     'the scaling pass returns early rather than rewriting every element with its own size');
}

console.log('the family name cannot break out of its CSS string');
{
  // It is emitted as a quoted string, so ; { } inside it are just characters
  // and harmless — what matters is that it cannot END the string early. Only
  // a quote, a backslash or a newline can do that. The value comes from a
  // <select>, but its options include admin-uploaded families Hmelj did not
  // choose, and the settings PUT takes what it is given.
  //
  // Now checked on the FORCED rule too, not only on body: the override
  // interpolates the same value a second time.
  const hostile = "x';}*{display:none;}'";
  const d = doc({ html: '<p>hi</p>', fontFamily: hostile, fontSize: 18, fontOverride: true });
  const rules = d.split('\n').filter((l) => l.includes('font-family:'));
  ok(rules.length >= 2, 'both the body rule and the forced rule carry the family', String(rules.length));
  for (const line of rules) {
    if (line.includes('font-family:inherit')) continue;
    const quoted = /font-family:'([^']*)'/.exec(line);
    ok(quoted, 'the family stays inside one quoted string', line.slice(0, 90));
    ok(quoted && !/['"\\]/.test(quoted[1]), 'with nothing in it that could close that string', quoted?.[1]);
  }
  // Deliberately NOT a "does the document contain an injected rule" scan. The
  // first attempt at that stripped quoted strings with /'[^']*'/ and then
  // searched what was left — which matched the stylesheet's own COMMENTS,
  // because an apostrophe in ordinary prose ("the message's own aspect ratio")
  // pairs with a later one and swallows the text between. The two assertions
  // above are the actual property, checked per rule and without guessing.
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
