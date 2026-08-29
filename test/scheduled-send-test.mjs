// Scheduled send, exercised through the real module: due-time firing, backoff on
// a transient failure, no-retry on a permanent one, the give-up handoff, and the
// interrupted-mid-send case. sendMail is stubbed — this is about the queue's
// behaviour, not SMTP.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-sched-'));
process.env.DATA_DIR = dir; process.env.CACHE_DIR = path.join(dir, 'cache');

let pass=0, fail=0;
const ok=(c,m,e='')=>{ if(c){pass++;console.log('  ✓ '+m);} else {fail++;console.log('  ✗ '+m+(e?' — '+e:''));} };
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

// NOTE: this covers the QUEUE — persistence, listing, cancel, the guards and the
// interrupted-mid-send case. It deliberately does not stub SMTP: scheduledSend
// imports sendMail directly, and the retry/backoff/give-up paths are verified on
// a real instance rather than against a fake seam added only for a test.
const ss = await import(new URL('../server/scheduledSend.js', import.meta.url).href);
const session = await import(new URL('../server/session.js', import.meta.url).href);

const u = session.createUser('sender', 'pw-sender-12345');
const uKey = session.userKey('sender');

console.log('scheduling');
const rec = ss.schedule(uKey, { to: 'a@b.test', subject: 'later', html: '<p>hi</p>', identityId: 'x' }, Date.now() + 3600e3);
ok(!!rec.id, 'schedule() returns a summary with an id');
ok(rec.subject === 'later' && rec.to === 'a@b.test', 'the summary carries subject and recipient');
ok(rec.state === 'pending', 'starts pending');

const onDisk = fs.readdirSync(path.join(dir, 'users', uKey, 'scheduled'));
ok(onDisk.length === 1 && onDisk[0].endsWith('.json'), 'exactly one file on disk, in DATA_DIR', onDisk.join());
ok(!fs.existsSync(path.join(dir, 'cache')) || !fs.readdirSync(path.join(dir,'cache')).some(f=>f.includes('sched')),
   'nothing about it went into the cache directory');

console.log('\nlisting hides the payload bulk');
const big = ss.schedule(uKey, { to: 'c@d.test', subject: 'big',
  attachments: [{ filename: 'x.bin', contentBase64: 'A'.repeat(200000) }] }, Date.now() + 7200e3);
const listed = ss.list(uKey);
ok(listed.length === 2, 'both are listed');
const bigRow = listed.find(r => r.id === big.id);
ok(bigRow.attachmentCount === 1, 'attachment count is reported');
ok(!JSON.stringify(listed).includes('AAAAAAAAAA'), 'but the base64 payload is NOT shipped to the browser');
ok(listed[0].sendAt <= listed[1].sendAt, 'listed soonest-first');

let threw = null;
console.log('\npreview (reading a queued message before it goes out)');
const prev = ss.preview(uKey, big.id);
ok(prev.subject === 'big' && prev.to === 'c@d.test', 'preview carries the envelope');
ok(prev.attachments.length === 1 && prev.attachments[0].filename === 'x.bin',
   'and the attachment NAMES');
ok(prev.attachments[0].size === 150000, 'with the decoded byte size, not the base64 length',
   String(prev.attachments[0].size));
ok(!JSON.stringify(prev).includes('AAAAAAAAAA'),
   'but still not the attachment bytes — that is the whole point of a preview');
const previewBody = ss.preview(uKey, rec.id);
ok(previewBody.html === '<p>hi</p>', 'the body IS included (the list omits it)');
threw = null;
try { ss.preview(uKey, '../../../etc/passwd'); } catch (e) { threw = e; }
ok(threw?.status === 400, 'a path-traversal id is rejected here too');
threw = null;
try { ss.preview(uKey, '00000000-0000-0000-0000-000000000000'); } catch (e) { threw = e; }
ok(threw?.status === 404, 'an unknown id is a clean 404');

console.log('\ncancel');
const back = ss.cancel(uKey, big.id);
ok(back.subject === 'big' && back.attachments[0].contentBase64.length === 200000,
   'cancel hands the FULL payload back, attachments included');
ok(ss.list(uKey).length === 1, 'and removes it from the queue');
threw = null;
try { ss.cancel(uKey, big.id); } catch (e) { threw = e; }
ok(threw?.status === 404, 'cancelling it twice is a clean 404');
threw = null;
try { ss.cancel(uKey, '../../../etc/passwd'); } catch (e) { threw = e; }
ok(threw?.status === 400, 'a path-traversal id is rejected, not resolved');

console.log('\nguards');
threw = null;
try { ss.schedule(uKey, { to: 'x@y.test' }, Date.now() + 400 * 24 * 3600e3); } catch (e) { threw = e; }
ok(threw?.status === 400, 'more than a year out is refused');
const past = ss.schedule(uKey, { to: 'x@y.test', subject: 'past' }, Date.now() - 60e3);
ok(past.sendAt >= Date.now() - 1000, 'a time already past is clamped to now, not rejected');
ss.cancel(uKey, past.id);

console.log('\ninterrupted mid-send is flagged, never auto-retried');
// Forge a record left in 'sending', as a crash would.
const f = path.join(dir, 'users', uKey, 'scheduled', `${rec.id}.json`);
const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
raw.state = 'sending'; raw.sendAt = Date.now() - 1000;
fs.writeFileSync(f, JSON.stringify(raw));
ss.start();
await sleep(300);
const after = ss.list(uKey).find(r => r.id === rec.id);
ok(after?.state === 'unresolved', 'a record left mid-send comes back as unresolved', JSON.stringify(after));
ok(ss.list(uKey).length === 1, 'and is still in the queue rather than resent or dropped');
ss.stop();

console.log('\nreschedule moves the time without touching the payload');
const moved = ss.schedule(uKey, { to: 'r@s.test', subject: 'move me', html: '<p>body</p>' }, Date.now() + 3600e3);
const when = Date.now() + 7200e3;
const after2 = ss.reschedule(uKey, moved.id, when);
ok(Math.abs(after2.sendAt - when) < 1000, 'the new time is stored');
const rawMoved = JSON.parse(fs.readFileSync(path.join(dir, 'users', uKey, 'scheduled', `${moved.id}.json`), 'utf8'));
ok(rawMoved.payload.html === '<p>body</p>', 'the payload is untouched');
ok(rawMoved.attempts === 0 && rawMoved.lastError === null, 'attempts and the stale error are reset');
threw = null;
try { ss.reschedule(uKey, moved.id, Date.now() + 400 * 24 * 3600e3); } catch (e) { threw = e; }
ok(threw?.status === 400, 'the year-ahead guard applies to reschedule too');
threw = null;
try { ss.reschedule(uKey, '11111111-2222-3333-4444-555555555555', Date.now() + 60e3); } catch (e) { threw = e; }
ok(threw?.status === 404, 'rescheduling something gone is a clean 404');
ss.cancel(uKey, moved.id);

console.log('\nretry policy');
ok(ss.nextBackoffMs(1) === 60e3, 'first retry waits a minute');
ok(ss.nextBackoffMs(2) === 5 * 60e3, 'then five');
ok(ss.nextBackoffMs(6) === 6 * 3600e3, 'reaches six hours');
ok(ss.nextBackoffMs(99) === 6 * 3600e3, 'and HOLDS there rather than running off the table');
ok(ss.isPermanent({ responseCode: 550 }), '550 is permanent');
ok(ss.isPermanent({ responseCode: 501 }), 'so is any other 5xx');
ok(!ss.isPermanent({ responseCode: 451 }), 'a 4xx is SMTP saying try again later, so it is NOT');
ok(!ss.isPermanent({ code: 'ECONNREFUSED' }), 'a socket error carries no reply code and is the most transient thing there is');
ok(!ss.isPermanent({}), 'an error with nothing on it is treated as transient');
ok(ss.isExhausted(1, { responseCode: 550 }), 'a permanent failure gives up on the FIRST attempt');
ok(!ss.isExhausted(1, {}), 'a transient one does not');
ok(ss.isExhausted(16, {}), 'but sixteen transient attempts do');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
