// Reading a 207 Multi-Status (server/dav/client.js).
//
// The bodies below are the shapes four different servers actually send, and
// they disagree about almost everything a naive parser would rely on: the
// namespace prefix (`d:`, `D:`, or none at all), whether one child element
// arrives as an object or an array, whether an absent property is omitted or
// returned with its own 404, and whether an ETag carries a weak marker.
//
// Every assertion here stands for a server that would otherwise appear to have
// an empty address book.
//
//   node test/dav-xml-test.mjs
import {
  parseMultistatus, parseSyncToken, statusCode, normalizeEtag, textOf, asArray, xmlEscape,
} from '../server/dav/client.js';
import { normalizeBase, multigetBody } from '../server/dav/discover.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

console.log('small pieces');
ok(statusCode('HTTP/1.1 200 OK') === 200, 'a status line');
ok(statusCode('HTTP/1.1 404 Not Found') === 404, 'a 404');
ok(statusCode('') === 0 && statusCode(null) === 0, 'and nothing at all');
ok(normalizeEtag('"abc123"') === '"abc123"', 'an ETag keeps its quotes — it is opaque');
// A server that answers W/"x" on GET and "x" on PROPFIND (several do) would
// otherwise look like it had changed every item on every single sync.
ok(normalizeEtag('W/"abc123"') === '"abc123"', 'but loses the weak-comparison marker');
ok(normalizeEtag('') === null && normalizeEtag(undefined) === null, 'a missing ETag is null, not ""');
ok(xmlEscape(`a&b<c>d"e'f`) === 'a&amp;b&lt;c&gt;d&quot;e&apos;f', 'all five XML escapes');
ok(textOf('plain') === 'plain' && textOf({ '#text': 'x', '@_a': '1' }) === 'x',
  'element text, whether or not the element had attributes');
ok(asArray(null).length === 0 && asArray('x').length === 1 && asArray(['x', 'y']).length === 2, 'asArray');

console.log('Nextcloud — lowercase d: prefix, one item');
const nextcloud = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:cs="http://calendarserver.org/ns/">
 <d:response>
  <d:href>/remote.php/dav/addressbooks/users/andrej/contacts/</d:href>
  <d:propstat>
   <d:prop>
    <d:resourcetype><d:collection/><card:addressbook xmlns:card="urn:ietf:params:xml:ns:carddav"/></d:resourcetype>
    <d:displayname>Contacts</d:displayname>
    <cs:getctag>http://sabre.io/ns/sync/42</cs:getctag>
    <d:sync-token>http://sabre.io/ns/sync/42</d:sync-token>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
  <d:propstat>
   <d:prop><d:getetag/></d:prop>
   <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;
let rows = parseMultistatus(nextcloud, 'https://cloud.example.com/remote.php/dav/');
ok(rows.length === 1, 'one response');
ok(rows[0].href === '/remote.php/dav/addressbooks/users/andrej/contacts/', 'the raw href, as sent');
ok(rows[0].url === 'https://cloud.example.com/remote.php/dav/addressbooks/users/andrej/contacts/',
  'and resolved against the request URL — a multiget must quote the first one back, a GET needs the second',
  rows[0].url);
ok(textOf(rows[0].props.displayname) === 'Contacts', 'the prefix is stripped, so matching is on local names');
ok('addressbook' in rows[0].props.resourcetype, 'resourcetype parses to its CHILD ELEMENT NAMES');
ok(textOf(rows[0].props.getctag) === 'http://sabre.io/ns/sync/42', 'a getctag from a third namespace');
// The propstat split is the whole reason this cannot be a flat property read: a
// server answers "I do not have that" with a 404 propstat, not by omission.
ok(!('getetag' in rows[0].props), 'a property returned with a 404 propstat is NOT in props');
ok(rows[0].missing.includes('getetag'), 'it is reported as missing instead');

console.log('iCloud — default namespace, no prefix at all, several responses');
const icloud = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">
 <response>
  <href>/1234567/carddavhome/card/</href>
  <propstat><prop><resourcetype><collection/><addressbook xmlns="urn:ietf:params:xml:ns:carddav"/></resourcetype>
   <displayname>Card</displayname>
   <current-user-privilege-set>
    <privilege><read/></privilege><privilege><write/></privilege><privilege><write-content/></privilege>
   </current-user-privilege-set>
  </prop><status>HTTP/1.1 200 OK</status></propstat>
 </response>
 <response>
  <href>/1234567/carddavhome/card/abc.vcf</href>
  <propstat><prop><getetag>"C=1234@U=abc"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat>
 </response>
</multistatus>`;
rows = parseMultistatus(icloud, 'https://p01-contacts.icloud.com/1234567/carddavhome/');
ok(rows.length === 2, 'a document with no namespace prefix parses identically');
ok('addressbook' in rows[0].props.resourcetype, 'and its resourcetype is still readable');
const privs = asArray(rows[0].props['current-user-privilege-set'].privilege).flatMap((p) => Object.keys(p));
ok(privs.includes('read') && privs.includes('write'), 'privileges are the child element names too', privs.join(','));
ok(normalizeEtag(textOf(rows[1].props.getetag)) === '"C=1234@U=abc"', 'an ETag containing @ and =');

console.log('one child vs many — the shape that breaks naive clients');
const single = `<multistatus xmlns="DAV:"><response><href>/a</href>
  <propstat><prop><displayname>Only</displayname></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
ok(parseMultistatus(single).length === 1,
  'a multistatus with exactly ONE response is still an array, not a bare object');
ok(parseMultistatus(icloud).length === 2, 'and one with two is unchanged');

console.log('sync-collection — the deletions, and the token');
const syncRes = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
 <d:response>
  <d:href>/dav/cards/new.vcf</d:href>
  <d:propstat><d:prop><d:getetag>"v2"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
 <d:response>
  <d:href>/dav/cards/gone.vcf</d:href>
  <d:status>HTTP/1.1 404 Not Found</d:status>
 </d:response>
 <d:sync-token>http://example.com/ns/sync/99</d:sync-token>
</d:multistatus>`;
rows = parseMultistatus(syncRes, 'https://x.example/dav/cards/');
ok(rows.length === 2, 'both responses');
ok(rows[0].status === 0 && normalizeEtag(textOf(rows[0].props.getetag)) === '"v2"',
  'a changed item has a propstat and no response-level status');
// This is the signal nothing else in either protocol provides.
ok(rows[1].status === 404 && !Object.keys(rows[1].props).length,
  'a DELETED item is a response-level 404 with no properties');
ok(parseSyncToken(syncRes) === 'http://example.com/ns/sync/99',
  'and the new token is on the multistatus, not on any response', parseSyncToken(syncRes));
ok(parseSyncToken(nextcloud) === '', 'a document without one reports none');

console.log('things that are not a multistatus');
ok(parseMultistatus('').length === 0, 'an empty body');
ok(parseMultistatus('<html><body>Not found</body></html>').length === 0,
  'an HTML error page — what a plain web server answers a PROPFIND with');
ok(parseMultistatus('<multistatus xmlns="DAV:"></multistatus>').length === 0, 'an empty multistatus');
ok(parseMultistatus('<multistatus xmlns="DAV:"><response><propstat><prop><displayname>x</displayname></prop>'
  + '<status>HTTP/1.1 200 OK</status></propstat></response></multistatus>').length === 0,
  'a response with no href is skipped rather than yielding a nameless row');

console.log('what the user typed');
ok(normalizeBase('cloud.example.com') === 'https://cloud.example.com/',
  'a bare host becomes https — never http, which would send the password in the clear',
  normalizeBase('cloud.example.com'));
ok(normalizeBase('https://host/nextcloud/remote.php/dav/') === 'https://host/nextcloud/remote.php/dav/', 'a full URL is left alone');
ok(normalizeBase('  https://host  ') === 'https://host/', 'surrounding space');
ok(normalizeBase('http://192.168.1.5:8080/dav') === 'http://192.168.1.5:8080/dav',
  'an explicit http:// is respected — a LAN server on plain http is a real setup');
let threw = false;
try { normalizeBase(''); } catch { threw = true; }
ok(threw, 'and nothing at all is an error, not a guess');

console.log('multiget bodies');
const calBody = multigetBody('caldav', ['/c/1.ics', '/c/2.ics']);
ok(calBody.includes('calendar-multiget') && calBody.includes('urn:ietf:params:xml:ns:caldav'), 'CalDAV report and namespace');
ok(calBody.includes('<X:calendar-data/>') && calBody.includes('<getetag/>'), 'asks for the body AND the ETag');
ok((calBody.match(/<href>/g) || []).length === 2, 'one href element per item');
const cardBody = multigetBody('carddav', ["/c/o'brien.vcf"]);
ok(cardBody.includes('addressbook-multiget') && cardBody.includes('<X:address-data/>'), 'CardDAV report and element');
ok(cardBody.includes('o&apos;brien'), 'an href containing an apostrophe is escaped', /<href>[^<]*/.exec(cardBody)?.[0]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
