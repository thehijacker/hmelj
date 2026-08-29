// Where a plain-text reply stops being this message and starts being the one it
// quotes (MessageFrame.splitQuotedText — the parent-side half of the collapsed
// quote; the HTML half runs inside the frame and needs a real DOM).
//
// The bias under test is deliberate: a false positive HIDES text the sender
// actually wrote, which is much worse than leaving a quote on screen. So most
// of these assert that something is NOT collapsed.
//
//   node test/quote-collapse-test.mjs
import fs from 'node:fs';
import vm from 'node:vm';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

// Same shallow DOM stub the client-scripts load test uses — buildDoc is never
// called here, only the pure splitter.
const noop = () => {};
const el = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : (t[k] = noop)), set: (t, k, v) => ((t[k] = v), true) });
const ctx = { document: { createElement: () => ({ textContent: '', innerHTML: '' }), querySelectorAll: () => [], addEventListener: noop, body: el() }, console };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../public/js/messageFrame.js', import.meta.url), 'utf8'), ctx);
const { splitQuotedText } = ctx.MessageFrame;

const body = 'Pozdravljeni, pošiljam popravljeno ponudbo za naslednji teden.\nLep pozdrav,\nAndrej';
const quote = (marker) => `${body}\n\n${marker}\n> Prejšnje sporočilo, prva vrstica\n> druga vrstica quota\n> tretja vrstica quota\n> četrta vrstica, dovolj dolga da presega prag\n> peta vrstica quota`;

console.log('markers that start a quote');
for (const [name, marker] of [
  ['Gmail English attribution', 'On Tue, Aug 25, 2026 at 10:04 AM Janez Novak <janez@example.com> wrote:'],
  ['Gmail Slovenian attribution', 'V tor., 25. avg. 2026 ob 10:04 je oseba Janez Novak <janez@example.com> napisal(a):'],
  ['Outlook original-message rule', '-----Original Message-----'],
  ['forwarded-message rule', '-------- Forwarded Message --------'],
  ['Slovenian forwarded rule', '---------- Posredovano sporočilo ----------'],
  ['Outlook underscore rule', '________________________________'],
  ['Outlook header block (From:)', 'From: Janez Novak <janez@example.com>'],
  ['Outlook header block (Od:)', 'Od: Janez Novak <janez@example.com>'],
]) {
  const r = splitQuotedText(quote(marker));
  ok(r && r.above.trim() === body && r.below.startsWith(marker), name, r ? JSON.stringify(r.above.slice(0, 30)) : 'not split');
}

const bare = `${body}\n\n> Prejšnje sporočilo, prva vrstica\n> druga vrstica\n> tretja vrstica\n> četrta vrstica, dolga dovolj za prag\n> peta vrstica`;
ok(splitQuotedText(bare)?.above.trim() === body, 'a bare "> " quote with no attribution line');

console.log('what must NOT be collapsed');
ok(splitQuotedText('Hvala za sporočilo, se slišiva jutri.\nLep pozdrav') === null,
  'a message with no quote at all');
ok(splitQuotedText('> Ta e-pošta je samo citat, brez lastnega besedila\n> in nič drugega tukaj\n> tretja vrstica citata\n> četrta vrstica citata\n> peta vrstica citata') === null,
  'a forward with nothing written above it (collapsing would empty the message)');
ok(splitQuotedText(`${body}\n\nOn Tue Janez wrote:\n> kratko`) === null,
  'a quote too short to be worth a button');
ok(splitQuotedText('Ok') === null && splitQuotedText('') === null && splitQuotedText(null) === null,
  'trivial and empty bodies');
ok(splitQuotedText(`Cenik:\nFrom: 10 EUR\nTo: 50 EUR\nvse ostalo po dogovoru, javi se mi kdaj ti ustreza za sestanek jutri`) === null,
  'a "From:" line in the middle of real text does not start a quote on its own', 'needs 120+ chars of quote below it');

console.log('the split itself');
const r = splitQuotedText(quote('-----Original Message-----'));
ok(!r.below.includes(body), 'the visible half is not repeated inside the collapsed half');
ok(r.above.split('\n').length === 4, 'the blank line before the marker stays with the visible half',
  JSON.stringify(r.above.split('\n')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
