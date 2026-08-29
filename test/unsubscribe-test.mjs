// One-click unsubscribe (server/unsubscribe.js): reading a List-Unsubscribe
// header, deciding which of the three ways out it offers, and — the part worth
// testing hardest — what it refuses.
//
// This is the one place in Hmelj where an address chosen by an arbitrary
// message becomes an outbound request from the server, so the refusals are the
// point: a private host would turn the mail server into a proxy into its own
// network, and a `javascript:` target in a header from a stranger has exactly
// one purpose.
//
//   node test/unsubscribe-test.mjs
import { parseListUnsubscribe, parseMailto, isSafePostTarget, ONE_CLICK_BODY } from '../server/unsubscribe.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

console.log('reading the header');
const both = parseListUnsubscribe('<https://news.example.com/u/abc>, <mailto:leave@example.com>', 'List-Unsubscribe=One-Click');
ok(both.method === 'post', 'https + List-Unsubscribe-Post = one click, sent for you', both.method);
ok(both.label === 'news.example.com', 'and it names the host the request goes to, not the mailto beside it', both.label);

const noPost = parseListUnsubscribe('<https://news.example.com/u/abc>, <mailto:leave@example.com>');
ok(noPost.oneClick === false, 'the same header WITHOUT the Post header is never treated as one-click');
// Preference order, and the reasoning: a mailto finishes without leaving the
// app, while a plain https unsubscribe link is as likely to be a preferences
// page behind a login as a one-step confirmation. Same order Gmail uses.
ok(noPost.method === 'mail', 'and falls back to the mailto rather than the link', noPost.method);
ok(noPost.label === 'leave@example.com', 'naming the address the mail goes to', noPost.label);
ok(parseListUnsubscribe('<https://news.example.com/u/abc>').method === 'open',
  'a link is only used when it is the only thing on offer');

ok(parseListUnsubscribe('<mailto:leave@example.com?subject=stop>').method === 'mail', 'a mailto-only header sends a message');
ok(parseListUnsubscribe('<mailto:a@b.si>, <mailto:c@d.si>').mailto === 'mailto:a@b.si', 'the first usable target of a kind wins');
ok(parseListUnsubscribe('https://news.example.com/u/abc').method === 'open', 'a sender that forgot the angle brackets still meant a URL');
ok(parseListUnsubscribe('<HTTPS://News.Example.com/U>').method === 'open', 'schemes are matched case-insensitively');
ok(parseListUnsubscribe('  <https://x.si/u>  \n  <mailto:y@z.si>  ').http === 'https://x.si/u', 'a folded header parses');

console.log('what it refuses');
ok(parseListUnsubscribe('') === null && parseListUnsubscribe(null) === null, 'no header, nothing offered');
ok(parseListUnsubscribe('<javascript:alert(1)>') === null, 'a javascript: target is not a way to unsubscribe');
ok(parseListUnsubscribe('<data:text/html,hi>') === null, 'nor is data:');
ok(parseListUnsubscribe('<ftp://host/x>') === null, 'nor an unrelated scheme');
ok(parseListUnsubscribe('<mailto:notanaddress>') === null, 'a mailto with no address is nothing');

console.log('what the server may POST to');
ok(isSafePostTarget('https://news.example.com/u/1'), 'a public https URL');
ok(!isSafePostTarget('http://news.example.com/u/1'), 'never plain http — the token travels in the clear');
for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.5', '172.16.0.3', '169.254.169.254', 'router.local', 'db.internal']) {
  ok(!isSafePostTarget(`https://${host}/u`), `never ${host}`);
}
ok(!isSafePostTarget('not a url'), 'nor anything unparsable');
const privatePost = parseListUnsubscribe('<https://192.168.1.5/u>', 'List-Unsubscribe=One-Click');
ok(privatePost.method === 'open' && privatePost.oneClick === false,
  'a one-click header pointing inside the network is downgraded to a plain link, not honoured');

console.log('the mailto');
const parts = parseMailto('mailto:leave@example.com?subject=unsub%20me&body=please%20stop');
ok(parts.to === 'leave@example.com', 'address');
ok(parts.subject === 'unsub me' && parts.body === 'please stop', 'subject and body are decoded — some list managers key off them');
const bare = parseMailto('mailto:leave@example.com');
ok(bare.subject === 'unsubscribe' && bare.body === 'unsubscribe', 'and default to something a list manager will understand');
ok(parseMailto('https://example.com') === null, 'a non-mailto is not a mailto');

// The bug this section exists for, and the reason it parses a real message
// rather than calling the parser with a string: everything above passed while
// the feature did nothing, because the glue read
// `parsed.headers.get('list-unsubscribe')` — a key mailparser does not have. It
// folds every List-* header into one `list` object, so the lookup returned
// undefined and no newsletter ever showed a button. A unit test of a pure
// function cannot catch that; only going through the parser can.
console.log('through the actual parser (mailparser -> messageParse -> the banner)');
const { simpleParser } = await import('mailparser');
const { rawHeaderValue: raw } = await import('../server/unsubscribe.js');
const message = (headers) => ['From: Akcije <news@akcije.example>', 'To: a@b.si', 'Subject: Akcija',
  ...headers, 'Content-Type: text/plain; charset=utf-8', '', 'Pozdravljeni', ''].join('\r\n');
const viaParser = async (headers) => {
  const p = await simpleParser(message(headers));
  return parseListUnsubscribe(raw(p.headerLines, 'list-unsubscribe'), raw(p.headerLines, 'list-unsubscribe-post'));
};

let r = await viaParser(['List-Unsubscribe: <https://news.akcije.example/u/abc>, <mailto:odjava@akcije.example>',
  'List-Unsubscribe-Post: List-Unsubscribe=One-Click']);
ok(r?.method === 'post' && r.label === 'news.akcije.example', 'a real one-click newsletter comes through the parser intact', JSON.stringify(r));

r = await viaParser(['List-Unsubscribe: <https://very.long.example.com/u/abcdef>,', ' <mailto:odjava@example.si?subject=unsubscribe%20me>']);
ok(r?.method === 'mail' && r.label === 'odjava@example.si', 'a FOLDED header is unfolded before parsing', JSON.stringify(r));
ok(parseMailto(r.mailto).subject === 'unsubscribe me',
  "and the mailto keeps its ?subject= — mailparser's own `list` object drops it, and some list managers need it");

ok(await viaParser([]) === null, 'a message with no such header offers nothing');
ok((await viaParser(['List-Unsubscribe: <mailto:a@b.si>', 'List-Unsubscribe: <https://c.si/u>']))?.mailto === 'mailto:a@b.si',
  'a header repeated across two lines is read as one');

console.log('the one-click body');
ok(ONE_CLICK_BODY === 'List-Unsubscribe=One-Click', 'is exactly what RFC 8058 requires, byte for byte');

// The fallback, and why it exists: measured on a live mailbox, one sender had
// 305 messages and not a single List-Unsubscribe header while its footer
// carried the only way out, and another published it on 9 of 23 campaigns. Of
// 291 cached HTML messages there, 1 had the header and 105 had a findable link.
console.log('the fallback: the link at the bottom of the message');
const { pickUnsubscribeAnchor } = await import('../server/unsubscribe.js');
const pick = (as) => pickUnsubscribeAnchor(as);

ok(pick([{ href: 'https://x.si/home', text: 'Domov' }, { href: 'https://x.si/u/9', text: 'Odjava od e-novic' }])?.http === 'https://x.si/u/9',
  'Slovenian link text (Odjava) is recognised');
ok(pick([{ href: 'https://x.si/u/9', text: 'Unsubscribe' }])?.source === 'body',
  'and it is labelled as a guess, not as something the sender published');
ok(pick([{ href: 'https://x.si/u/9', text: 'Unsubscribe' }])?.method === 'open',
  'a body link is only ever OPENED — never posted to, never mailed');
ok(pick([{ href: 'https://esma.example.si/email/unsubscribe/6a8e', text: 'kliknite tukaj' }])?.http.includes('/unsubscribe/'),
  'a URL that says it, under link text that does not, still counts (real case: "kliknite tukaj")');
ok(pick([{ href: 'https://a.si/unsub', text: 'click' }, { href: 'https://b.si/x', text: 'Unsubscribe' }])?.http === 'https://b.si/x',
  'link TEXT outweighs a word in a URL — tracking URLs are full of stray words');
ok(pick([{ href: 'https://a.si/u', text: 'Unsubscribe' }, { href: 'https://b.si/u', text: 'Unsubscribe' }])?.http === 'https://b.si/u',
  'between equals the LAST one wins: an unsubscribe link lives in the footer');

console.log('what the fallback refuses');
ok(pick([{ href: 'mailto:x@y.si', text: 'Unsubscribe' }]) === null, 'a mailto in the body is not opened as a link');
ok(pick([{ href: 'javascript:alert(1)', text: 'Unsubscribe' }]) === null, 'nor javascript:');
ok(pick([{ href: '/relative/unsub', text: 'Unsubscribe' }]) === null, 'nor a relative URL, which means nothing outside the message');
ok(pick([{ href: 'https://x.si/shop', text: 'Trgovina' }]) === null, 'an ordinary message offers nothing');
ok(pick([]) === null && pick(null) === null, 'no links at all');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
