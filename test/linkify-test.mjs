// Hmelj — turning bare URLs into links (public/js/messageFrame.js).
//
// Two callers, two jobs, one regex:
//
//   READING — an HTML message whose sender left a URL as bare text. There is
//   nothing to click even though the body is HTML.
//   COMPOSING — the same thing at the other end: a URL typed into a
//   contenteditable is just characters, so it went out as text the RECIPIENT
//   could not click. That is the bug that was actually reported, found in a
//   Sent copy: "…v management programu: http://fwupgrade.t-2.local/…" sitting
//   in class="compose-body" with no anchor around it.
//
// The dangerous direction here is rewriting somebody else's markup. A URL
// inside <style> is a stylesheet reference; one inside an existing <a> would
// nest anchors, which is invalid and renders unpredictably. So most of the
// assertions below are about what is NOT touched.
//
// Node has no DOMParser, so the DOM walk runs against a small shim built on
// htmlparser2 (already a dependency — the server sanitiser uses it). The shim
// implements only what linkifyBareUrlsInHtml calls. It is a stand-in for a
// browser DOM, so these assertions are about the WALK's decisions — which
// nodes get rewritten — not about browser serialisation fidelity.
//
//   node test/linkify-test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import { parseDocument } from 'htmlparser2';
import render from 'dom-serializer';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

/* ---------------- the DOM shim ---------------- */

const kids = (n) => n.children || [];
/** htmlparser2 nodes, given the handful of browser properties the walk uses. */
function adapt(n) {
  Object.defineProperty(n, 'nodeType', { get() { return n.type === 'tag' || n.type === 'script' || n.type === 'style' ? 1 : 3; }, configurable: true });
  Object.defineProperty(n, 'tagName', { get() { return (n.name || '').toUpperCase(); }, configurable: true });
  Object.defineProperty(n, 'parentNode', { get() { return n.parent; }, configurable: true });
  Object.defineProperty(n, 'childNodes', { get() { return kids(n).slice(); }, configurable: true });
  n.replaceWith = (...nodes) => {
    const sibs = kids(n.parent);
    const at = sibs.indexOf(n);
    for (const x of nodes) x.parent = n.parent;
    sibs.splice(at, 1, ...nodes);
  };
  kids(n).forEach(adapt);
  return n;
}
function parse(html) {
  const doc = parseDocument(html);
  kids(doc).forEach(adapt);
  return doc;
}
/** Depth-first text nodes, which is what createTreeWalker(SHOW_TEXT) yields. */
function textNodes(root, out = []) {
  for (const c of kids(root)) {
    if (c.type === 'text') out.push(c);
    else textNodes(c, out);
  }
  return out;
}

const ctx = {
  console,
  // esc()/attrEsc() need only a thing with textContent in and innerHTML out.
  document: {
    createElement: () => {
      const box = { _t: '', _nodes: null };
      Object.defineProperty(box, 'textContent', { set(v) { box._t = String(v ?? ''); } });
      Object.defineProperty(box, 'innerHTML', {
        get() { return box._t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
        set(v) { box._nodes = kids(parse(String(v))); },
      });
      Object.defineProperty(box, 'childNodes', { get() { return (box._nodes || []).slice(); } });
      return box;
    },
    querySelectorAll: () => [], addEventListener: () => {}, body: {},
  },
  DOMParser: function () {
    return {
      parseFromString: (html) => {
        const doc = parse(html);
        // htmlparser2 has no <body> wrapper, so the document IS the body here.
        doc.body = doc;
        // encodeEntities:'utf8' escapes only what a UTF-8 document actually
        // needs — & < > and attribute quotes — which is exactly what a
        // browser's innerHTML produces. Plain true would also escape every
        // accented character (Ž -> &#x17d;) and these assertions would then be
        // testing the shim rather than the code; false would hand back raw <
        // and & that a browser would have re-escaped.
        Object.defineProperty(doc, 'innerHTML', { get() { return render(doc, { encodeEntities: 'utf8' }); }, configurable: true });
        doc.createElement = ctx.document.createElement;
        doc.createTreeWalker = (root) => { const list = textNodes(root); let i = 0; return { nextNode: () => (i < list.length ? list[i++] : null) }; };
        return doc;
      },
    };
  },
  NodeFilter: { SHOW_TEXT: 4 },
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../public/js/messageFrame.js', import.meta.url), 'utf8'), ctx);
const { linkifyText, linkifyBareUrlsInHtml } = ctx.MessageFrame;

/* ---------------- plain text (the path that already worked) ---------------- */

const MGMT = 'http://fwupgrade.t-2.local/tvslider/mgmt/index.html';

console.log('plain text');
{
  const out = linkifyText(`v management programu: ${MGMT}`);
  ok(out.includes(`href="${MGMT}"`), 'the reported URL is linked — a .local host and a hyphen in the label are not special', out);
  ok(linkifyText('see https://example.com/x.').endsWith('</a>.'), "a sentence's full stop stays outside the link");
  ok(linkifyText('(see https://en.wikipedia.org/wiki/Foo_(bar))').includes('Foo_(bar)</a>'),
    'a bracket the URL itself opened is kept');
  ok(linkifyText('www.example.com').includes('href="https://www.example.com"'), 'www. gets a scheme');
  ok(linkifyText('ana@example.com').includes('href="mailto:ana@example.com"'), 'a bare address becomes mailto:');
}

console.log('\noptions');
{
  ok(linkifyText(MGMT).includes('target="_blank"'), 'the reading frame gets target/rel');
  const sent = linkifyText(MGMT, { target: false });
  ok(!sent.includes('target') && !sent.includes('rel='), 'an outgoing message does not — it means nothing in mail', sent);
  ok(sent.includes(`href="${MGMT}"`), 'and still has the href');
  ok(!linkifyText('ana@example.com', { addresses: false }).includes('<a'),
    'addresses:false leaves a bare address alone');
  ok(linkifyText(`x ${MGMT}`, { addresses: false }).includes('<a'), 'while still linking URLs');
}

/* ---------------- HTML bodies ---------------- */

const linkCount = (h) => (h.match(/<a\b/g) || []).length;

console.log('\nHTML mail with a bare URL in it');
{
  // The shape from the real Sent copy that started this.
  const src = `<div class="compose-body"><div>Živjo,</div><div>v management programu: ${MGMT}</div></div>`;
  const out = linkifyBareUrlsInHtml(src);
  ok(linkCount(out) === 1, 'the bare URL becomes exactly one anchor', out);
  ok(out.includes(`href="${MGMT}"`), 'pointing at the URL');
  ok(out.includes('Živjo'), 'and the rest of the message survives intact', out);
}

console.log('\nwhat it must not touch');
{
  const already = `<p>see <a href="${MGMT}">${MGMT}</a> now</p>`;
  ok(linkifyBareUrlsInHtml(already) === already,
    'a URL already inside an <a> is left completely alone — nesting anchors is invalid');

  const styled = `<style>body{background:url(${MGMT})}</style><p>hi</p>`;
  ok(linkifyBareUrlsInHtml(styled) === styled, 'a URL inside <style> is a stylesheet reference, not content');

  const scripted = `<script>var u="${MGMT}";</script>`;
  ok(linkifyBareUrlsInHtml(scripted) === scripted, 'and one inside <script> is code');

  const attrOnly = `<p><a href="${MGMT}">click here</a> and <img src="${MGMT}"></p>`;
  ok(linkifyBareUrlsInHtml(attrOnly) === attrOnly,
    'a URL that exists only in an attribute is not text and is returned byte-for-byte');

  const none = '<p>no links here at all</p>';
  ok(linkifyBareUrlsInHtml(none) === none, 'a message with no URL is returned unchanged, unparsed');

  const addr = '<p>write to ana@example.com</p>';
  ok(linkifyBareUrlsInHtml(addr) === addr, 'a bare address in HTML mail is left as the sender wrote it');
}

console.log('\nmixed content');
{
  const src = `<p>one <a href="https://a.example/">anchored</a> and one bare: ${MGMT}</p>`;
  const out = linkifyBareUrlsInHtml(src);
  ok(linkCount(out) === 2, 'the bare one is linked and the existing one is kept, exactly once each', out);
  ok(out.includes('>anchored</a>'), 'the existing anchor keeps its own text');

  const two = `<p>${MGMT} and https://second.example/x</p>`;
  ok(linkCount(linkifyBareUrlsInHtml(two)) === 2, 'two bare URLs in one text node both get linked');

  const nested = `<div><table><tr><td>deep: ${MGMT}</td></tr></table></div>`;
  ok(linkCount(linkifyBareUrlsInHtml(nested)) === 1, 'nesting depth does not matter');
}

console.log('\nescaping is not lost on the way through');
{
  const out = linkifyBareUrlsInHtml('<p>a &lt;b&gt; https://example.com/?x=1&amp;y=2</p>');
  ok(out.includes('&lt;b&gt;'), 'text that was escaped stays escaped', out);
  ok(out.includes('x=1&amp;y=2'), 'and an ampersand inside the URL is escaped in the href too', out);
  ok(!/<b>/.test(out), 'nothing became real markup');
}

console.log('\noutgoing: what the composer produces');
{
  const src = `<div class="compose-body"><div>programu: ${MGMT}</div></div>`;
  const out = linkifyBareUrlsInHtml(src, { target: false });
  ok(out.includes(`<a href="${MGMT}">`), 'a clean anchor, no target/rel', out);
  const withAddr = '<div>write to ana@example.com</div>';
  ok(linkifyBareUrlsInHtml(withAddr, { target: false }) === withAddr,
    'a bare address is NOT linked on the way out — it appears in the signature and in every '
    + 'quoted reply, and rewriting those would change text the user never touched');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
