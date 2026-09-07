// Where the collapsed quote is allowed to STAY collapsed.
//
// server/quoteCollapse.js marks the quoted half of a reply and the reading pane
// hides it behind a ⋯ button. That is right in a conversation, where everything
// it hides is already on screen above as its own message — and wrong everywhere
// else, which is most places. Reported by a reader who was forwarded a message
// and got a line of comment and a button: the mail being forwarded was the
// whole point of it, and it was the one thing not shown.
//
// So the marking stays where it is (it is the same message either way, and the
// same bytes go into the offline cache) and the DECISION moved to the four
// renderers, each of which now has to say which situation it is:
//
//   the frame        — buildDoc's expandQuote, read back as a body attribute by
//                      the frame's own script, which is the only thing that can
//                      undo an inline display:none!important
//   the reading pane — buildMessageCard's inThread; true only for the cards of
//                      a conversation stack
//   print            — never collapsed: a ⋯ on paper does nothing, and a
//                      printed reply missing what it replied to is not one
//   the composer     — never collapsed, and this one is not cosmetic. Quoting a
//                      collapsed message into a new one would SEND the hiding:
//                      the recipient's client has no toggle, so a forward would
//                      arrive with its contents permanently invisible.
//
// The first assertion is the one that matters most. Everything after it strips
// two specific markers out of the server's output, so if the server ever
// renames them the four call sites below fail silently, in outgoing mail. That
// test pins the two together.
//
//   node test/quote-expand-test.mjs
import fs from 'node:fs';
import { collapseQuotedHtml } from '../server/quoteCollapse.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const frame = read('../public/js/messageFrame.js');
const app = read('../public/js/app.js');
const compose = read('../public/js/compose.js');
const popout = read('../public/message.html');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

console.log('\nwhat the server actually emits — the contract the four undo sites strip');
{
  // An Outlook-shaped forward: a line of comment, then the header block. The
  // exact shape the reader was looking at when they reported this.
  const html = '<div>Glej to ponudbo, prosim, pa mi povej kaj misliš.</div><div><br></div>'
    + '<div style="border-top:1px solid #ccc"><b>From:</b> Ana Novak &lt;ana@example.com&gt;<br>'
    + '<b>Sent:</b> Monday, 1 September 2026 09:14<br><b>To:</b> Andrej<br><b>Subject:</b> Ponudba<br></div>'
    + '<div>Pozdravljeni, v prilogi pošiljam ponudbo za obnovo strehe, veljavna je 30 dni. '
    + 'Za morebitna vprašanja sem na voljo na tej številki. Lep pozdrav, Ana</div>';
  const r = collapseQuotedHtml(html);
  ok(r.collapsed, 'a forward with a comment on top is collapsed at all (the case being fixed)');
  ok(r.html.includes('hmelj-quote-toggle'), 'the toggle carries class hmelj-quote-toggle');
  ok(/class="[^"]*hmelj-quoted/.test(r.html), 'the hidden part carries class hmelj-quoted');
  ok(/style="[^"]*display:none!important/.test(r.html), 'the hiding is an inline display:none!important');
  // Nothing else can undo that inline style, which is why all four sites below
  // have to remove the style and not merely the class.
  ok(r.html.includes('Ponudba'), 'nothing is deleted, only hidden');
}

console.log('\nthe frame decides from a body attribute');
{
  ok(/function buildDoc\(\{[^}]*expandQuote[^}]*\}\)/.test(frame), 'buildDoc takes expandQuote');
  ok(frame.includes("<body${expandQuote ? ' data-quote-open=\"1\"' : ''}>"),
    'and puts it on <body> as data-quote-open');
  ok(frame.includes("document.body.getAttribute('data-quote-open') === '1'") && frame.includes('setQuoteShown(true)'),
    'the frame script opens the quote on boot when it is set');
  ok(/setQuoteShown\(!!first && !showing\(first\)\)/.test(frame),
    'the ⋯ button still toggles — expanded by default is not the same as no button');
  ok(frame.includes("el.style.removeProperty('display')"), 'opening removes the inline style, not just the class');
}

console.log('\nthe reading pane: collapsed only inside a conversation stack');
{
  ok(/function buildMessageCard\(msg, listEntry, \{ collapsed = null, inThread = false \} = \{\}\)/.test(app),
    'buildMessageCard defaults to NOT in a thread');
  ok(/card\.__frameOpts = \{ html: msg\.html,[^}]*expandQuote: !inThread \}/.test(app),
    'and hands the frame the opposite of it');
  ok((app.match(/buildMessageCard\([^)]*inThread: true[^)]*\)/g) || []).length === 2,
    'exactly two call sites are in a thread (openThread’s newest, and an expanded stub)');
  ok(app.includes('inThread: !card.__frameOpts?.expandQuote'),
    'reloadCard keeps the context it already had — "show images" must not fold the quote back up');
  ok(/card\.__frameOpts = \{ html: data\.html \|\| undefined,[^}]*expandQuote: true \}/.test(app),
    'a scheduled message previews expanded — it is one message, not a conversation');
  ok(/expandQuote: true/.test(popout), 'so does the popout window (message.html)');
}

console.log('\nprint and compose undo it outright');
{
  const printBlock = app.slice(app.indexOf('function printMessage'));
  ok(printBlock.includes(".querySelectorAll('.hmelj-quote-toggle').forEach((b) => b.remove())"),
    'print drops the button');
  ok(/printMessage[\s\S]*hmelj-quoted'\)\.forEach\(\(el\) => \{[\s\S]*removeProperty\('display'\)/.test(app),
    'print unhides the quote');

  ok(compose.includes('function unhideCollapsedQuote(html)'), 'the composer has an undo for it');
  ok(/const inner = unhideCollapsedQuote\(msg\.html\)/.test(compose),
    'and quoteBlock() runs every quoted message through it — this is the one that would go out over SMTP');
  ok(/unhideCollapsedQuote[\s\S]{0,600}removeProperty\('display'\)/.test(compose),
    'it removes the inline style too, since that is what actually hides it');
  ok(/unhideCollapsedQuote[\s\S]{0,600}hmelj-quote-toggle'\)\) b\.remove\(\)/.test(compose),
    'and the dead button, which would otherwise be sent as a stray ⋯');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
