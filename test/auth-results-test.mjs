// Authentication-Results (server/authResults.js) — is this message really from
// who it says it is?
//
// The rule this file exists to protect: ONLY THE TOPMOST HEADER IS EVIDENCE.
// The receiving server adds its verdict at the top; anything below it was
// written by the sender, whose honesty is the entire question. A parser that
// reads "the dmarc= it can find" hands a forger a one-line spoof.
//
// Header samples below are the real shapes — Google's, Microsoft's, a Dovecot
// installation's — not invented ones, because the parsing hazards are all in
// what real servers actually emit: comments containing semicolons, methods in
// any order, quoted values, and vendor extensions nobody else writes.
//
//   node test/auth-results-test.mjs
import {
  readAuthResults, parseAuthResultsHeader, stripComments, summarize, spoofedDisplayName,
} from '../server/authResults.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

/** headerLines as mailparser produces them: in the order they appear. */
const lines = (...pairs) => pairs.map(([key, value]) => ({ key: key.toLowerCase(), line: `${key}: ${value}` }));

console.log('comments come out before anything is split');
ok(stripComments('spf=pass (google.com: domain of x; designates 1.2.3.4)') === 'spf=pass ',
  'a comment containing a semicolon does not become a second method');
ok(stripComments('dkim=pass (1024-bit key)') === 'dkim=pass ', 'the ordinary key-size comment');
ok(stripComments('a (b (c) d) e') === 'a  e', 'nested comments');
ok(stripComments('plain') === 'plain', 'text without comments is untouched');

console.log('\nreal headers');
const google = 'mx.google.com; dkim=pass header.i=@example.com header.s=20230601 header.b=AbCd; spf=pass (google.com: domain of ana@example.com designates 209.85.1.1 as permitted sender) smtp.mailfrom=ana@example.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com';
let p = parseAuthResultsHeader(google);
ok(p.authserv === 'mx.google.com', 'the authserv-id is read');
ok(p.methods.dkim.result === 'pass' && p.methods.spf.result === 'pass' && p.methods.dmarc.result === 'pass', 'all three results');
ok(p.methods.dmarc['header.from'] === 'example.com', 'and the properties that make a pass mean something');
ok(p.methods.spf['smtp.mailfrom'] === 'ana@example.com', 'including the envelope sender SPF was checked against');

const ms = 'spf=fail (sender IP is 1.2.3.4) smtp.mailfrom=example.com; dkim=none (message not signed) header.d=none; dmarc=fail action=oreject header.from=example.com; compauth=fail reason=001';
p = parseAuthResultsHeader(ms);
ok(p.methods.dmarc.result === 'fail', "Microsoft's shape parses");
ok(p.methods.compauth?.result === 'fail', 'and its vendor extension is kept rather than tripping the parser');

console.log('\nthe verdict');
const verdict = (h) => readAuthResults(lines(['Authentication-Results', h])).verdict;
ok(verdict(google) === 'pass', 'everything passing is a pass');
ok(verdict(ms) === 'fail', 'DMARC failing is a FAIL — this is the impersonation signal');
ok(verdict('x; spf=pass smtp.mailfrom=a@b.c') === 'pass', 'SPF alone, with no DMARC result, is enough to say pass');
ok(verdict('x; dkim=pass header.d=b.c') === 'pass', 'so is DKIM alone');
ok(verdict('x; spf=fail smtp.mailfrom=a@b.c; dkim=pass header.d=b.c') === 'partial',
  'a mailing list breaks SPF by design and still DKIM-passes — partial, not an alarm');
ok(verdict('x; spf=softfail smtp.mailfrom=a@b.c') === 'none', 'softfail alone says nothing either way');
ok(verdict('x; dmarc=pass header.from=b.c; spf=fail smtp.mailfrom=a@b.c') === 'partial',
  'DMARC passing while something under it failed is reported as partial, not laundered into a clean pass');
ok(readAuthResults(lines()).verdict === 'none', 'no header at all is "none", not a failure');
ok(readAuthResults(lines(['Authentication-Results', 'mx.example.com; none'])).verdict === 'none',
  'a server that checked nothing says so');

console.log('\nONLY THE TOPMOST HEADER IS EVIDENCE');
// The forgery: the sender writes a convincing pass into their own message. The
// real server's verdict is added above it on arrival.
const forged = lines(
  ['Authentication-Results', 'mx.ourserver.test; spf=fail smtp.mailfrom=evil.example; dmarc=fail header.from=bank.example'],
  ['Authentication-Results', 'mx.google.com; spf=pass smtp.mailfrom=bank.example; dmarc=pass header.from=bank.example'],
);
const read = readAuthResults(forged);
ok(read.verdict === 'fail', "the sender's own forged pass is ignored; the receiving server's fail wins");
ok(read.headerCount === 2, 'and the reader is told there was more than one');
ok(readAuthResults([...forged].reverse()).verdict === 'pass',
  'order is what decides it — reversed, the other header is on top (this is why headerLines order must be preserved)');

console.log('\nnaming your own server explicitly (RFC 8601 §5)');
const twoServers = lines(
  ['Authentication-Results', 'relay.example.net; dmarc=pass header.from=bank.example'],
  ['Authentication-Results', 'mx.ourserver.test; dmarc=fail header.from=bank.example'],
);
ok(readAuthResults(twoServers).verdict === 'pass', 'without an authservId, the topmost is used');
ok(readAuthResults(twoServers, { authservId: 'mx.ourserver.test' }).verdict === 'fail',
  'with one, OUR server is picked out wherever it sits');
ok(readAuthResults(twoServers, { authservId: 'nobody.test' }).verdict === 'pass',
  'and an authservId that matches nothing falls back to the topmost rather than reporting nothing');

console.log('\nReceived-SPF, for servers that write only that');
const rspf = readAuthResults(lines(['Received-SPF', 'pass (example.com: domain of a@b.c designates 1.2.3.4) client-ip=1.2.3.4; envelope-from=a@b.c']));
ok(rspf.verdict === 'pass' && rspf.receivedSpfOnly, 'it is read when there is no Authentication-Results');
ok(readAuthResults(lines(
  ['Authentication-Results', 'mx.test; dmarc=fail header.from=b.c'],
  ['Received-SPF', 'pass (…)'],
)).verdict === 'fail', 'but never in preference to a real Authentication-Results');

console.log('\nmalformed input is never a crash and never a guess');
for (const junk of ['', '   ', ';;;', 'no-equals-here', 'x; =pass', 'x; spf=', '(((']) {
  let threw = null, v;
  try { v = readAuthResults(lines(['Authentication-Results', junk])).verdict; } catch (e) { threw = e; }
  ok(!threw && v === 'none', `${JSON.stringify(junk)} → none`, threw?.message);
}
ok(readAuthResults(null).verdict === 'none', 'null headerLines');
ok(summarize({}).verdict === 'none', 'summarize with nothing at all');

console.log('\nthe attack DMARC cannot see: a display name that is not the sender');
const book = [
  { name: 'Andrej Kralj', email: 'andrej@example.com' },
  { name: 'IT', email: 'it@example.com' },
];
ok(spoofedDisplayName({ name: 'Andrej Kralj', address: 'random1234@gmail.com' }, book) === 'andrej@example.com',
  'a known name on an unknown address is flagged — this passes SPF, DKIM and DMARC perfectly');
ok(spoofedDisplayName({ name: 'andrej  kralj', address: 'random@gmail.com' }, book) === 'andrej@example.com',
  'case and spacing do not help the forger');
ok(spoofedDisplayName({ name: 'Andrej Kralj', address: 'andrej@example.com' }, book) === null,
  'the real sender is not flagged');
ok(spoofedDisplayName({ name: 'Someone Else', address: 'x@y.z' }, book) === null, 'an unknown name is not flagged');
ok(spoofedDisplayName({ name: 'IT', address: 'other@x.test' }, book) === null,
  'a very short name is skipped — initials collide by accident, and a false alarm teaches people to ignore the real one');
ok(spoofedDisplayName({ name: 'andrej@example.com', address: 'evil@x.test' }, book) === null,
  'a display name that is itself an address is skipped: senders routinely put the address in both fields');
ok(spoofedDisplayName({ name: 'Andrej Kralj', address: '' }, book) === null, 'no address, no claim');
ok(spoofedDisplayName({ name: 'Andrej Kralj', address: 'x@y.z' }, []) === null, 'and an empty address book flags nothing');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
