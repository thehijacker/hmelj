// Notification preview text (server/notifyText.js) — the one line of plain text
// shown under a new message's subject.
//
// Every case below is a shape found in real mail on a live instance, not one
// invented to exercise a branch. The reason this module exists at all is that
// "the text/plain part is plain text" is false often enough to matter: measured
// over 793 cached messages, 36 previews were raw HTML, 42 carried [bracket]
// markers, 13 were undecoded quoted-printable, 45 were padded with invisible
// characters and 3 showed Outlook conditional-comment scaffolding.
//
//   node test/notify-text-test.mjs
import {
  previewText, cleanCandidate, decodeEntities,
  looksLikeMarkup, stripLinkMarkers, stripCssBlocks, stripComments,
} from '../server/notifyText.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
// Stands in for sanitize-html in the pure tests: the real one is handed in by
// server/sync.js, and what this module does with the result is the same either way.
const stripTags = (html) => html.replace(/<[^>]*>/g, ' ');

console.log('entities');
ok(decodeEntities('supplies &amp; more') === 'supplies & more', '&amp; — sanitize-html ESCAPES its text output, so this is needed even on the HTML path');
ok(decodeEntities('a&nbsp;b') === 'a b', '&nbsp; becomes an ordinary space, not a character that looks like one');
ok(decodeEntities('&#8230;') === '…' && decodeEntities('&#x2026;') === '…', 'numeric, decimal and hex');
ok(decodeEntities('&notareal;') === '&notareal;', 'something that only looks like an entity is left alone');
ok(decodeEntities('&#0;&#8;') === '', 'control characters are not text a person meant to read');
ok(decodeEntities('&#99999999;') === '', 'nor is a code point outside Unicode');

// The quoted-printable repair moved to server/transferEncoding.js once it had
// to be trusted with the STORED message and not only with a preview — see
// test/transfer-encoding-test.mjs, which is mostly the false positives that
// nearly shipped. cleanCandidate calls the gated repair, so a preview can never
// be mangled in a way the message itself would not be.
console.log('quoted-printable, through the preview path');
ok(cleanCandidate('=C5=A0e ne poznate na=\n=C5=A1ih cvrtnikov') === 'Še ne poznate naših cvrtnikov',
  'a genuinely undecoded text part is repaired for the preview too');
ok(cleanCandidate('[Bridge] pid=517, ura je 8 čez') === '[Bridge] pid=517, ura je 8 čez',
  'and a log line that merely looks like it is left alone');

console.log('is this still markup?');
ok(looksLikeMarkup('<tr> <td valign="top" id="templateHeader">'), 'a Mailchimp template in the "plain text" part — 36 of 793 previews were this');
ok(looksLikeMarkup('* { padding: 0; margin: 0; color: #1a1a1a; }'), 'a stylesheet in the "plain text" part');
ok(!looksLikeMarkup('Pozdravljeni, potrjujemo delovanje.'), 'ordinary prose is not markup');
ok(!looksLikeMarkup('the condition is x < 3 and y > 1'), 'nor is prose with comparison signs in it');
ok(!looksLikeMarkup('From: Marko <marko@radio.example>'), 'nor an address in angle brackets, which is what a quoted header looks like');
// Bounded on purpose: an earlier version's `[^{}]*\{[^{}]*:[^{}]*` backtracked
// so badly on a long brace-free body that this one function cost 7 seconds
// across 793 messages.
const t0 = Date.now();
looksLikeMarkup('a'.repeat(200000) + ' : ; ');
ok(Date.now() - t0 < 50, 'and a long body answers immediately — no runaway backtracking', `${Date.now() - t0}ms`);

console.log('the markers a text-alternative generator leaves behind');
ok(stripLinkMarkers('[Akcije](https://www.akcije.example/) KUHANJE').trim() === 'Akcije KUHANJE', 'markdown keeps the label, drops the target');
ok(!stripLinkMarkers('[https://host/logo.png] Pozdravljeni').includes('http'), 'a bracketed image URL is a picture, not a sentence');
ok(!stripLinkMarkers('[image: Logo] hello').includes('image:'), '[image: …] likewise');
ok(stripLinkMarkers('Best Regards<https://www.example.net/>').trim() === 'Best Regards', "html-to-text's <url> suffix goes, the text it belonged to stays");
ok(stripLinkMarkers('test [?]').trim() === 'test', 'the placeholder for an image with no alt text at all');
ok(stripLinkMarkers('rows [1] and [2]') === 'rows [1] and [2]', 'ordinary brackets in prose are not markers');

console.log('what leaked in from the HTML');
ok(!stripComments('<!--[if !mso]><!-->hello').includes('if !mso'), "Outlook's conditional-comment scaffolding — it turns up in TEXT parts too");
ok(stripCssBlocks('.x { padding: 0; } Hello').trim() === 'Hello', 'a leaked CSS rule');
ok(stripCssBlocks('meet me at 7 { no css here') === 'meet me at 7 { no css here', 'a stray brace in prose is not a stylesheet');

console.log('invisible padding');
// Newsletters pad the preheader with hundreds of these to control what an inbox
// list shows. Invisible in the mail, a wall of nothing in a notification.
const padded = 'Deal inside' + '‌ '.repeat(200) + 'ends today';
const cleaned = cleanCandidate(padded);
ok(!/[​-‏⁠-⁤﻿]/.test(cleaned), 'zero-width characters are gone');
ok(cleaned === 'Deal inside ends today', 'and what is left reads as one line', JSON.stringify(cleaned.slice(0, 40)));

console.log('choosing between the two bodies');
ok(previewText({ text: 'Pozdravljeni, potrjujemo delovanje.', html: '<p>ignored</p>' }, { htmlToText: stripTags })
  === 'Pozdravljeni, potrjujemo delovanje.', 'a usable text part wins — it is what the sender wrote for this');
ok(previewText({ text: '<tr><td valign="top">x</td></tr>', html: '<p>The real first line</p>' }, { htmlToText: stripTags })
  === 'The real first line', 'a text part that is really HTML is abandoned for the HTML itself');
ok(previewText({ html: '<p>Only HTML here</p>' }, { htmlToText: stripTags }) === 'Only HTML here', 'no text part at all');
ok(previewText({ text: '<tr><td>salvage me</td></tr>' }, { htmlToText: stripTags }) === 'salvage me',
  'markup text and NO html to fall back on: strip it rather than show nothing');
ok(previewText({}, { htmlToText: stripTags }) === '' && previewText(null) === '', 'nothing in, nothing out — the caller falls back to the subject alone');

console.log('length');
const long = previewText({ text: 'word '.repeat(200) }, { maxLen: 40 });
ok(long.length <= 41, 'capped', String(long.length));
ok(long.endsWith('…'), 'and says it was cut');
ok(!/\bwor…$/.test(long), 'at a word boundary when there is one near, not mid-word', JSON.stringify(long));
ok(previewText({ text: 'short' }, { maxLen: 40 }) === 'short', 'something that fits is not touched');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
