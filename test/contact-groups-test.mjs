// Contact groups (server/contactGroups.js) — the shaping every write goes
// through, and the expansion every send goes through.
//
// The rule this file exists for: what lands in a To field is a NAME, and the
// server is the only thing that turns it back into addresses. So two properties
// have to hold or the feature is a way to mail the wrong people:
//
//   - a name resolves to exactly one group (duplicates are disambiguated, never
//     merged, never silently first-wins), and
//   - a token that cannot be honoured stops the send rather than disappearing
//     out of the recipient list.
//
// The expansion is driven through the REAL addressparser — the same one the
// send path uses — because the whole detection rule ("a group token is an entry
// with no address") is a claim about that parser's behaviour, and a hand-rolled
// split on ','/';' is exactly what it exists instead of.
//
//   node test/contact-groups-test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-groups-'));
process.env.DATA_DIR = tmp;
process.env.HMELJ_SECRET = 'test-secret-not-a-real-one';

const { normalizeContactGroups, expandGroupsInField, expandPayloadGroups, GROUP_MARK } =
  await import('../server/contactGroups.js');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
const eq = (got, want, m) => ok(got === want, m, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const one = (input) => normalizeContactGroups([input])[0];

console.log('a group needs a name it can be typed by');
eq(one({ name: '  Team  ' }).name, 'Team', 'a name is trimmed');
eq(one({}).name, 'Group', 'no name at all falls back to something typeable');
eq(one({ name: '   ' }).name, 'Group', 'and so does a whitespace-only one');
eq(one({ name: 'A, B; C <d> e@f "g"' }).name, 'A B C d ef g',
  'characters that would break the token are stripped from the name');
eq(one({ name: 'x'.repeat(200) }).name.length, 80, 'an over-long name is cut');
ok(one({ name: 'Team' }).id.length > 0, 'a missing id is filled in');
eq(normalizeContactGroups(null).length, 0, 'a non-array is an empty list, not a crash');
eq(normalizeContactGroups([null, 0, 'nope']).length, 0, 'junk entries are dropped');

console.log('\nand a name that means exactly one group');
const dupes = normalizeContactGroups([{ name: 'Team' }, { name: 'team' }, { name: 'TEAM' }]);
eq(dupes.length, 3, 'a duplicate name is never dropped');
// The suffix is added to the name AS TYPED — the collision is decided
// case-insensitively (that is how the token resolves), but nobody's own
// capitalisation is rewritten for them.
eq(dupes[1].name, 'team 2', 'the second gets a suffix, keeping its own spelling');
eq(dupes[2].name, 'TEAM 3', 'and so does the third');

console.log('\nmembers are addresses, de-duped, lowercased');
eq(one({ name: 'T', members: ['A@X.si', 'a@x.si'] }).members.length, 1, 'the same address twice is stored once');
eq(one({ name: 'T', members: ['A@X.si'] }).members[0], 'a@x.si', 'stored lowercased');
eq(one({ name: 'T', members: ['nope', '', null, 'a@x.si'] }).members.length, 1, 'anything without an @ is dropped');
eq(one({ name: 'T', members: [{ email: 'a@x.si' }] }).members[0], 'a@x.si', 'a {email} row is accepted too');
eq(one({ name: 'T' }).members.length, 0, 'a group with no members is KEPT — it is how one starts');
eq(one({ name: 'T', members: Array.from({ length: 1500 }, (_, i) => `p${i}@x.si`) }).members.length, 1000,
  'membership is capped');

console.log('\nexpanding a field');
const groups = normalizeContactGroups([
  { name: 'Team', members: ['ana@firma.si', 'bo@firma.si'] },
  { name: 'Empty', members: [] },
]);
const exp = (text) => expandGroupsInField(text, groups);

eq(exp(`${GROUP_MARK} Team`).text, 'ana@firma.si, bo@firma.si', 'a token becomes its members');
eq(exp('Team').text, 'ana@firma.si, bo@firma.si', 'the marker is optional — a bare group name resolves too');
eq(exp(`${GROUP_MARK} TEAM`).text, 'ana@firma.si, bo@firma.si', 'matching is case-insensitive');
eq(exp(`cene@firma.si, ${GROUP_MARK} Team`).text, 'cene@firma.si, ana@firma.si, bo@firma.si',
  'an address typed alongside the group is kept, in order');
eq(exp(`ana@firma.si, ${GROUP_MARK} Team`).text, 'ana@firma.si, bo@firma.si',
  'a member already typed is listed once, not twice');

// The reason this uses addressparser rather than splitting the string: the
// comma inside a quoted display name is not a separator, and a hand-rolled
// split would cut this person in half.
const quoted = exp(`"Novak, Bo" <bo@x.si>, ${GROUP_MARK} Team`);
ok(quoted.text.includes('"Novak, Bo" <bo@x.si>'), 'a display name containing a comma survives beside a group');
eq(quoted.text, '"Novak, Bo" <bo@x.si>, ana@firma.si, bo@firma.si', 'and the group still expands after it');

console.log('\nand leaving alone what is not a group');
const plain = 'Ana Kralj <ana@x.si>, bo@y.si';
eq(exp(plain).text, plain, 'a field with no group is returned byte-identical');
eq(exp('').text, '', 'so is an empty one');
eq(exp('Nobody').text, 'Nobody', 'an unmarked token that matches nothing is left exactly as typed');
eq(exp('Nobody').unknown.length, 0, 'and is not reported — it was never claimed to be a group');
eq(exp(`${GROUP_MARK} Nobody`).unknown[0], 'Nobody', 'a MARKED token that matches nothing IS reported');
eq(exp(`${GROUP_MARK} Nobody`).text, `${GROUP_MARK} Nobody`, 'and is passed through rather than dropped');
eq(exp(`${GROUP_MARK} Empty`).empty[0], 'Empty', 'an empty group is reported');
eq(exp(`${GROUP_MARK} Empty`).text, `${GROUP_MARK} Empty`, 'and is passed through rather than dropped');

console.log('\nidempotency — the same expansion runs on /api/send and /api/drafts');
const once = exp(`${GROUP_MARK} Team`).text;
eq(exp(once).text, once, 'expanding an already-expanded field changes nothing');

console.log('\na whole payload');
const p = { to: `${GROUP_MARK} Team`, cc: 'x@y.si', bcc: '' };
expandPayloadGroups(p, groups);
eq(p.to, 'ana@firma.si, bo@firma.si', 'To is expanded');
eq(p.cc, 'x@y.si', 'Cc is untouched');
eq(p.bcc, '', 'an empty field stays empty');

let threw = null;
try { expandPayloadGroups({ to: `${GROUP_MARK} Nobody` }, groups); } catch (e) { threw = e.message; }
ok(threw && threw.includes('Nobody'), 'sending to an unknown group throws, naming it', String(threw));
threw = null;
try { expandPayloadGroups({ to: `${GROUP_MARK} Empty` }, groups); } catch (e) { threw = e.message; }
ok(threw && threw.includes('Empty'), 'sending to an empty group throws, naming it', String(threw));

// A draft save is automatic — it happens whenever a composer closes — so it
// must never be the thing that loses what somebody wrote.
const draft = { to: `${GROUP_MARK} Nobody, ana@firma.si` };
expandPayloadGroups(draft, groups, { strict: false });
ok(draft.to.includes('Nobody'), 'saving a draft keeps an unresolvable token instead of refusing');
ok(draft.to.includes('ana@firma.si'), 'and keeps everything else in the field');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
