// Filters surviving downtime (server/filterState.js + cache.js#claimFilterApplied).
//
// The bug being fixed: sync.js decided "is this new enough to filter?" with a
// fixed two-day window on arrival time. That one number was doing two unrelated
// jobs — excluding old mail that merely looks new (wants a SHORT window) and
// including mail that arrived while Hmelj was off (wants a window as long as
// the outage) — so an outage longer than two days left everything that arrived
// in it permanently unfiltered, with nothing ever going back for it.
//
// Two mechanisms replace it, and the point of this file is that NEITHER is
// trusted alone:
//
//   the mark    per folder, in DATA_DIR: "filters covered this up to time T",
//               so the window is however long the outage actually was;
//   the ledger  per (message, filter), in the cache: applied once, ever — so a
//               window that overlaps a previous one, or a WIPED CACHE that
//               re-presents every old message as new, cannot file twice.
//
// The wiped-cache case is why the mark is in DATA_DIR and the ledger is not:
// delete cache.sqlite and the ledger goes with it, and the mark is the thing
// still standing between a restart and re-filing a month of mail.
//
//   node test/filter-catchup-test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-catchup-'));
process.env.DATA_DIR = TMP;
process.env.CACHE_DIR = TMP;
process.env.HMELJ_SECRET = 'test-secret-not-a-real-one';
process.env.LOG = process.env.LOG || 'warn';

const fstate = await import('../server/filterState.js');
const cache = await import('../server/cache.js');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const U = 'user1', A = 'acct1', F = 'INBOX';
const DAY = 24 * 3600e3;
const now = Date.now();

console.log('a fresh install is conservative');
const cold = fstate.catchUpFrom(U, A, F, now);
ok(cold.cold === true, 'no mark yet is reported as a cold start');
ok(Math.abs((now - cold.from) - fstate.COLD_START_MS) < 1000,
  'and uses the old two-day window — with no record of what has been filtered, filing a month of history on first run is not the safe direction');
ok(fstate.markFor(U, A, F) === null, 'nothing is recorded until a run says so');

console.log('\nthe window is however long the outage was');
fstate.advance(U, A, F, now - 9 * DAY);          // last successful run: nine days ago
const after = fstate.catchUpFrom(U, A, F, now);
ok(after.cold === false, 'a mark is not a cold start');
ok(after.from === now - 9 * DAY, 'the window reaches back to the mark — NINE days, where the old code stopped at two');
ok(after.skippedMs === 0, 'and nothing is being skipped');

console.log('\nbut not unboundedly far');
fstate.advance(U, A, 'Old', now - 200 * DAY);
const capped = fstate.catchUpFrom(U, A, 'Old', now);
ok(capped.from === now - fstate.MAX_CATCHUP_MS, 'a very old mark is capped');
ok(capped.skippedMs > 0, 'and the caller is TOLD how much history is being left alone, rather than it looking like full coverage');
ok(Math.round(capped.skippedMs / DAY) === 200 - 30, 'by exactly the amount over the cap');

console.log('\nthe mark only ever moves forward');
fstate.advance(U, A, F, now - DAY);
ok(fstate.markFor(U, A, F) === now - DAY, 'a newer time advances it');
fstate.advance(U, A, F, now - 5 * DAY);
ok(fstate.markFor(U, A, F) === now - DAY,
  'an older one does not — dragging it back would re-open a window already closed and re-file what was in it');
fstate.advance(U, A, F, NaN);
fstate.advance(U, A, F, null);
ok(fstate.markFor(U, A, F) === now - DAY, 'and nonsense does not move it at all');

console.log('\nfolders and accounts are tracked separately');
ok(fstate.markFor(U, A, 'Never-synced') === null, 'a folder with no run of its own has no mark');
ok(fstate.markFor(U, 'other-account', F) === null, 'nor does the same folder path under another account');
fstate.advance(U, 'other-account', F, now - 2 * DAY);
ok(fstate.markFor(U, A, F) === now - DAY, 'and advancing one does not touch the other');

console.log('\nremoving an account forgets its marks');
fstate.forgetAccount(U, 'other-account');
ok(fstate.markFor(U, 'other-account', F) === null, "the removed account's marks are gone");
ok(fstate.markFor(U, A, F) === now - DAY, 'the surviving account keeps its own');

console.log('\nthe ledger: a filter is applied to a message exactly once');
ok(cache.claimFilterApplied(U, A, '<abc@example.com>', 'f1') === true, 'the first claim wins');
ok(cache.claimFilterApplied(U, A, '<abc@example.com>', 'f1') === false, 'the second does not — this is what makes a re-run safe');
ok(cache.claimFilterApplied(U, A, '<abc@example.com>', 'f2') === true, 'a DIFFERENT filter still gets its turn on the same message');
ok(cache.claimFilterApplied(U, A, '<other@example.com>', 'f1') === true, 'and the same filter still gets its turn on another message');
ok(cache.claimFilterApplied(U, 'acct2', '<abc@example.com>', 'f1') === true, 'accounts do not share the ledger');

console.log('\na failed run gives the claim back');
ok(cache.claimFilterApplied(U, A, '<retry@example.com>', 'f1') === true, 'claimed');
cache.releaseFilterApplied(U, A, '<retry@example.com>', 'f1');
ok(cache.claimFilterApplied(U, A, '<retry@example.com>', 'f1') === true,
  'released, so a later run tries again — a claim left standing after a failure means the rule silently never runs');

console.log('\nkeyed on Message-ID, which survives what a uid does not');
// The reason the key is not folder+uid: a MOVE mints a new uid, so a filter
// that moved a message would not recognise it again afterwards.
ok(cache.claimFilterApplied(U, A, '<moved@example.com>', 'f1') === true, 'first pass, message in INBOX');
ok(cache.claimFilterApplied(U, A, '<moved@example.com>', 'f1') === false,
  'and still recognised after a move would have changed its uid');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
