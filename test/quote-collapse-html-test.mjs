// The HTML half of the collapsed quote — server/quoteCollapse.js, against the
// shapes real mail actually arrives in.
//
// Why this test exists in this shape: the first version of the feature matched
// only clients that mark their quote with a class or an id, and shipped without
// being run against real mail. Most corporate mail is Outlook, which marks its
// quote with nothing at all — just a divider div wrapping "From: … Sent: …" —
// so nothing collapsed. The fixtures below reproduce the structures found in a
// real mailbox rather than copying them, so no actual mail lives in the repo.
//
// The detection later moved out of the message frame and onto the server for
// exactly the reason this file exists: on this side it can be run against real
// mail, in bulk, and what it does can be seen.
//
//   node test/quote-collapse-html-test.mjs
import { parseDocument } from 'htmlparser2';
import { collapseQuotedHtml } from '../server/quoteCollapse.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

/** All text in the document, hidden parts included — for checking nothing was
 *  lost, as opposed to hidden. */
function visibleTextIncludingHidden(html) {
  const doc = parseDocument(html);
  const out = [];
  const walk = (n) => {
    if (n.type === 'text') { out.push(n.data); return; }
    for (const c of n.children || []) walk(c);
  };
  walk(doc);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** What a reader is left looking at: the text of everything not marked hidden. */
function visibleText(html) {
  const doc = parseDocument(html);
  const out = [];
  const walk = (n) => {
    if (n.type === 'text') { out.push(n.data); return; }
    if (n.type !== 'tag' && n.type !== 'root') return;
    if ((n.attribs?.class || '').includes('hmelj-quoted')) return; // hidden subtree
    for (const c of n.children || []) walk(c);
  };
  walk(doc);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function collapse(html) {
  const r = collapseQuotedHtml(html);
  return {
    button: r.html.includes('hmelj-quote-toggle'),
    collapsed: !!r.collapsed,
    marked: (r.html.match(/hmelj-quoted/g) || []).length,
    inlineHidden: (r.html.match(/display:none!important/g) || []).length,
    visible: visibleText(r.html),
    hidden: r.hidden,
  };
}

const NEW_TEXT = 'Pozdravljeni, v prilogi pošiljam popravljeno poročilo o testiranju. Lep pozdrav, Andrej';
const OLD_TEXT = 'Prejšnje sporočilo v tem pogovoru, dovolj dolgo besedilo da presega prag pod katerim se skrivanje sploh ne splača, z več stavki.';

console.log('the shapes real mail arrives in');

// Reproduced from a real Outlook reply: no blockquote, no class, no id — just a
// divider div wrapping the header block, itself inside a plain wrapper div.
const outlookDesktop = `
  <p class="MsoNormal">${NEW_TEXT}</p>
  <div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm">
    <p class="MsoNormal"><b><span>From:</span></b><span> Acme NOC &lt;noc@acme.example&gt;<br>
      <b>Sent:</b> Wednesday, August 26, 2026 10:48 AM<br><b>To:</b> NOC Services<br>
      <b>Subject:</b> RE: Nepravilno delovanje</span></p></div>
    <p>${OLD_TEXT}</p></div>`;
let r = collapse(outlookDesktop);
ok(r.button && r.visible.includes('Pozdravljeni') && !r.visible.includes('Prejšnje sporočilo'),
  'Outlook desktop: a border-top divider wrapping "From: … Sent: …" and no marker of any kind', JSON.stringify(r.visible));

r = collapse(outlookDesktop.replace('From:', 'Od:').replace('Sent:', 'Poslano:').replace('To:', 'Za:'));
ok(r.button && !r.visible.includes('Prejšnje sporočilo'), 'Outlook in Slovenian: Od: / Poslano: / Za:');

r = collapse(`<div>${NEW_TEXT}</div><hr><div id="divRplyFwdMsg"><b>From:</b> Someone</div><div>${OLD_TEXT}</div>`);
ok(r.button && !r.visible.includes('Prejšnje sporočilo'), 'Outlook on the web: #divRplyFwdMsg');
ok(r.marked >= 3, 'and the <hr> it draws above the quote goes with it', String(r.marked));

r = collapse(`<div dir="ltr">${NEW_TEXT}</div><div class="gmail_quote"><div class="gmail_attr">On Tue, Aug 25, 2026 Janez wrote:</div><blockquote class="gmail_quote">${OLD_TEXT}</blockquote></div>`);
ok(r.button && !r.visible.includes('Prejšnje sporočilo'), 'Gmail: .gmail_quote');

r = collapse(`<p>${NEW_TEXT}</p><blockquote type="cite"><p>${OLD_TEXT}</p></blockquote>`);
ok(r.button && !r.visible.includes('Prejšnje sporočilo'), 'Apple Mail / Thunderbird: blockquote[type=cite]');

r = collapse(`<p>${NEW_TEXT}</p><blockquote><p>${OLD_TEXT}</p></blockquote>`);
ok(r.button && !r.visible.includes('Prejšnje sporočilo'), 'a bare blockquote');

console.log('how it hides');
r = collapse(outlookDesktop);
ok(r.inlineHidden >= 1, "an inline display:none!important, which the mail's own stylesheet cannot outrank", String(r.inlineHidden));
ok(r.visible.length < visibleText(outlookDesktop).length,
  'the outermost wrapper containing only the quote is hidden — not the inner divider alone, which would leave its shell and border behind');
ok(/<button type="button" class="hmelj-quote-toggle"/.test(collapseQuotedHtml(outlookDesktop).html),
  'the ⋯ button is inserted in front of it');

console.log('what must NOT be collapsed');
ok(!collapse(`<p>${NEW_TEXT}</p><p>Se slišiva jutri.</p>`).button, 'a message with no quote in it');
ok(!collapse(`<div><div style="border-top:solid #E1E1E1 1.0pt"><p><b>From:</b> X<br><b>Sent:</b> now</p></div><p>${OLD_TEXT}</p></div>`).button,
  'a forward with nothing written above it (collapsing would empty the message)');
ok(!collapse(`<p>${NEW_TEXT}</p><blockquote>ok</blockquote>`).button, 'a quote too short to be worth a button');
ok(!collapse(`<p>${NEW_TEXT}</p><p>From: 10 EUR do 50 EUR, vse ostalo po dogovoru — javi kdaj ti ustreza za sestanek naslednji teden ali kasneje.</p>`).button,
  'a "From:" line in running text, with no second header label after it');

console.log('it never damages the message');
// The bug this one exists for: the parser DECODES entities, so an Outlook
// header block's `&lt;tina@example.com&gt;` becomes the text `<tina@example.com>`
// — and serializing that back raw makes the browser parse it as a tag and
// swallow the address. Every quoted "From:" line silently lost its sender.
const withAddr = `<p>${NEW_TEXT}</p><div><div style="border-top:solid #E1E1E1 1.0pt">` +
  `<p><b>From:</b> Ana Zupančič &lt;ana.zupancic@acme.example&gt;<br><b>Sent:</b> Wednesday<br><b>To:</b> NOC</p></div><p>${OLD_TEXT}</p></div>`;
const addrOut = collapseQuotedHtml(withAddr);
ok(addrOut.collapsed, 'a quote whose header block contains an escaped address still collapses');
ok(visibleTextIncludingHidden(addrOut.html).includes('ana.zupancic@acme.example'),
  'and the address survives the parse/serialize round trip', visibleTextIncludingHidden(addrOut.html).slice(0, 120));
ok(!/<tina\.rozic@t-2\.com>/.test(addrOut.html), 'it is re-escaped, not written back as raw markup');

ok(collapseQuotedHtml(`<p>${NEW_TEXT}</p>`).html === `<p>${NEW_TEXT}</p>`, 'HTML with no quote comes back byte-identical');
ok(collapseQuotedHtml(null).collapsed === false && collapseQuotedHtml('').collapsed === false, 'null and empty are handled');
const table = `<table><tr><td><p>${NEW_TEXT}</p></td></tr></table><blockquote><p>${OLD_TEXT}</p></blockquote>`;
const out = collapseQuotedHtml(table).html;
ok(out.includes('<table>') && out.includes('</td>'), 'a table-based template survives the round trip through the parser');

console.log('reading a body\'s links (the unsubscribe fallback\'s input)');
const { anchorsIn } = await import('../server/quoteCollapse.js');
const linked = `<p>${NEW_TEXT}</p><p><a href="https://x.si/u">Odjava</a></p>` +
  `<div><div style="border-top:solid #E1E1E1 1.0pt"><p><b>From:</b> X<br><b>Sent:</b> now</p></div>` +
  `<p>${OLD_TEXT}</p><p><a href="https://old.si/u">Unsubscribe</a></p></div>`;
const links = anchorsIn(collapseQuotedHtml(linked).html);
ok(links.length === 1 && links[0].href === 'https://x.si/u',
  'links inside a collapsed quote are skipped — an unsubscribe link in mail somebody forwarded to you is not your way out of anything',
  JSON.stringify(links));
ok(links[0].text === 'Odjava', 'and each link carries its text, which is what the picker scores on');
ok(anchorsIn('').length === 0 && anchorsIn(null).length === 0, 'nothing in, nothing out');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
