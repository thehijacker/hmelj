// Out of office (server/outOfOffice.js) — who must never get a reply.
//
// The failure that matters is a loop with another robot, or a reply to a
// mailing list's thousand members. Every rule that prevents it is pinned here.
//
//   node test/out-of-office-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-ooo-'));
process.env.CACHE_DIR = dir; process.env.DATA_DIR = dir;
const ooo = await import(new URL('../server/outOfOffice.js', import.meta.url).href);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

console.log('headers that rule a reply out');
ok(ooo.mayAnswer({}), 'an ordinary message may be answered');
ok(ooo.mayAnswer({ autoSubmitted: 'no' }), 'Auto-Submitted: no is a person');
ok(!ooo.mayAnswer({ autoSubmitted: 'auto-replied' }), 'another auto-reply is never answered (no loops)');
ok(!ooo.mayAnswer({ autoSubmitted: 'auto-generated' }), 'nor generated mail');
ok(!ooo.mayAnswer({ precedence: 'bulk' }) && !ooo.mayAnswer({ precedence: 'list' }) && !ooo.mayAnswer({ precedence: 'junk' }), 'Precedence bulk/list/junk');
ok(!ooo.mayAnswer({ listId: '<team.example.com>' }), 'a mailing list (List-Id)');
ok(!ooo.mayAnswer({ listUnsubscribeRaw: '<mailto:x@y>' }), 'a newsletter (List-Unsubscribe)');
ok(!ooo.mayAnswer({ xAutoResponseSuppress: 'OOF, AutoReply' }), 'Exchange asking not to be auto-answered');
ok(!ooo.mayAnswer({ returnPathEmpty: true }), 'a bounce (empty Return-Path)');

console.log('\naddresses that are robots');
for (const a of ['noreply@x.si', 'no-reply@x.si', 'do-not-reply@x.si', 'MAILER-DAEMON@x.si', 'postmaster@x.si', 'notifications@github.com', 'noreply+abc@x.si'])
  ok(ooo.isRobotAddress(a), a);
ok(!ooo.isRobotAddress('ana.novak@firma.si'), 'a person is not');

console.log('\nthe period');
const now = Date.parse('2026-10-05T10:00:00Z');
ok(!ooo.isActive({ enabled: false, message: 'x' }, now), 'off is off');
ok(!ooo.isActive({ enabled: true, message: '  ' }, now), 'on with no text sends nothing');
ok(ooo.isActive({ enabled: true, message: 'x' }, now), 'on with no dates is on');
ok(!ooo.isActive({ enabled: true, message: 'x', start: now + 1 }, now), 'before it starts');
ok(!ooo.isActive({ enabled: true, message: 'x', end: now }, now), 'from the moment it ends');
let threw = false; try { ooo.clean({ enabled: true, message: 'x', start: 10, end: 5 }); } catch { threw = true; }
ok(threw, 'an end before the start is refused');
threw = false; try { ooo.clean({ enabled: true, message: '' }); } catch { threw = true; }
ok(threw, 'turning it on without a reply is refused');

console.log('\na new period answers everyone again');
const saved = ooo.save('u-1', 'acct-1', { enabled: true, message: 'Na dopustu.' });
ok(Array.isArray(saved.repliedTo) && saved.repliedTo.length === 0, 'saving clears who was answered');
ok(ooo.load('u-1', 'acct-1').message === 'Na dopustu.', 'and it is read back');
threw = false; try { ooo.load('u-1', '../../etc'); } catch { threw = true; }
ok(threw, 'an account id that is not one is refused before it becomes a path');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
