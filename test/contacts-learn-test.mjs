// The address book's automatic half (server/contacts.js): what sending adds,
// what receiving is and isn't allowed to do, and the rules that keep either
// from trampling something the user typed by hand.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-contacts-'));
process.env.DATA_DIR = dir; process.env.CACHE_DIR = path.join(dir, 'cache');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const contactsMod = await import(new URL('../server/contacts.js', import.meta.url).href);
const { store } = await import(new URL('../server/store.js', import.meta.url).href);
const session = await import(new URL('../server/session.js', import.meta.url).href);

const user = session.createUser('ana', 'pw-ana-123456789');
const uKey = session.userKey('ana');
const as = (fn) => session.runAsUser(user, fn);
const byEmail = (e) => store.getContactsFor(uKey).find((c) => c.email.toLowerCase() === e);

console.log('parsing recipient fields');
const parsed = contactsMod.parseRecipients('Marko Okorn <m@d.test>, plain@d.test', 'semi@d.test; two@d.test');
ok(parsed.length === 4, 'commas AND semicolons both split', String(parsed.length));
ok(parsed[0].name === 'Marko Okorn' && parsed[0].email === 'm@d.test', 'a display name is kept');
ok(contactsMod.parseRecipients('', null, undefined).length === 0, 'empty fields yield nothing');

console.log('\nsending adds the recipients');
as(() => contactsMod.learnRecipients({ to: 'new_user@domain.test', cc: 'Boss <boss@domain.test>' }));
ok(!!byEmail('new_user@domain.test'), 'a brand-new To address becomes a contact');
ok(byEmail('boss@domain.test')?.name === 'Boss', 'so does a Cc, with the name it was addressed by');
as(() => contactsMod.learnRecipients({ to: 'new_user@domain.test' }));
ok(store.getContactsFor(uKey).filter((c) => c.email === 'new_user@domain.test').length === 1,
   'writing to the same person twice does not duplicate them');
as(() => contactsMod.learnRecipients({ to: 'bcc-test@domain.test', bcc: 'hidden@domain.test' }));
ok(!!byEmail('hidden@domain.test'), 'a Bcc recipient is learned too — this is a private address book');

console.log('\na reply does not add the person you are replying to');
// What compose.js hands over: the To/Cc it filled in itself, verbatim.
as(() => contactsMod.learnRecipients({
  to: 'stranger@news.test',
  prefilledRecipients: ['stranger@news.test'],
}));
ok(!byEmail('stranger@news.test'), 'a prefilled reply recipient is NOT learned');
as(() => contactsMod.learnRecipients({
  to: 'Stranger <stranger@news.test>, colleague@work.test',
  cc: 'also-prefilled@news.test',
  prefilledRecipients: ['stranger@news.test', 'also-prefilled@news.test'],
}));
ok(!byEmail('stranger@news.test'), 'still not, even respelled with a display name by send time');
ok(!byEmail('also-prefilled@news.test'), 'a prefilled Cc (reply-all) is skipped too');
ok(!!byEmail('colleague@work.test'), 'but someone the user ADDED to that reply is learned');

console.log('\nreceiving fills in a missing name, and nothing else');
// The whole point of the feature: new_user@domain.test was added above with no
// name, and now replies as "Marko Okorn <new_user@domain.test>".
contactsMod.learnSenderNames(uKey, [{ from: { name: 'Marko Okorn', address: 'new_user@domain.test' } }]);
ok(byEmail('new_user@domain.test')?.name === 'Marko Okorn', 'the reply names a contact we had no name for');

contactsMod.learnSenderNames(uKey, [{ from: { name: 'M. Okorn (mobile)', address: 'new_user@domain.test' } }]);
ok(byEmail('new_user@domain.test')?.name === 'Marko Okorn',
   'a later, different name does NOT overwrite the one already stored');

contactsMod.learnSenderNames(uKey, [{ from: { name: 'Newsletter', address: 'noreply@shop.test' } }]);
ok(!byEmail('noreply@shop.test'), 'a sender we have never written to is NOT added');

const before = store.getContactsFor(uKey).length;
contactsMod.learnSenderNames(uKey, [{ from: { name: 'bcc-test@domain.test', address: 'bcc-test@domain.test' } }]);
ok(!byEmail('bcc-test@domain.test').name,
   'a "name" that is just the address again is ignored, so the real one can still be learned later');
ok(store.getContactsFor(uKey).length === before, 'and nothing was added along the way');

console.log('\nhand-typed data is never touched');
const list = store.getContactsFor(uKey);
list.push({ id: 'manual-1', name: 'Aunt Mary', email: 'mary@family.test' });
store.saveContactsFor(uKey, list);
contactsMod.learnSenderNames(uKey, [{ from: { name: 'Mary Smith-Jones', address: 'mary@family.test' } }]);
ok(byEmail('mary@family.test')?.name === 'Aunt Mary', 'a name the user typed outranks the sender’s own');
as(() => contactsMod.learnRecipients({ to: 'Mary S <mary@family.test>' }));
ok(byEmail('mary@family.test')?.name === 'Aunt Mary', 'and writing to them does not rewrite it either');

console.log('\nyour own addresses are not your contacts');
store.saveIdentitiesFor(uKey, [{ id: 'i1', name: 'Ana', email: 'ana@mine.test', accountId: 'a1' }]);
as(() => contactsMod.learnRecipients({ to: 'ana@mine.test, someone@else.test' }));
ok(!byEmail('ana@mine.test'), 'an identity of your own is skipped');
ok(!!byEmail('someone@else.test'), 'while the real recipient in the same field is still added');

console.log('\nthe settings switch both halves off');
as(() => store.saveSettings({ autoAddContacts: false, learnContactNames: false }));
as(() => contactsMod.learnRecipients({ to: 'blocked@domain.test' }));
ok(!byEmail('blocked@domain.test'), 'autoAddContacts:false stops the add on send');
contactsMod.learnSenderNames(uKey, [{ from: { name: 'Nope', address: 'boss@domain.test' } }]);
ok(byEmail('boss@domain.test')?.name === 'Boss', 'learnContactNames:false stops the name fill-in');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
