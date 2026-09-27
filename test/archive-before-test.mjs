// Archiving by date (server/archive.js) — the decisions, not the moves.
//
// Three things here can quietly take mail somewhere nobody asked for, and none
// of them announces itself: an off-by-one on the boundary archives a day more
// than was picked, a folder that should be exempt gets swept, or the batching
// drops the tail of a long list and reports success for the part it did move.
// All three are pure functions of their inputs, so all three are pinned here.
//
// The move loop itself is not covered — it is one call per batch against a
// live mail server, and the three backends' findOlderThan implementations are
// where that behaviour actually lives (see the comments there on how IMAP's
// date-only BEFORE is made to agree with Graph's and EWS's instant compare).
//
//   node test/archive-before-test.mjs
import { startOfDay, cutoffForDays, isArchivableFolder, batches, ARCHIVE_BATCH } from '../server/archive.js';

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m, `got ${JSON.stringify(a)}`);

console.log('the boundary');
{
  const d = startOfDay('2026-03-15');
  ok(d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0,
    'a picked date becomes the very start of that day, locally');
  eq([d.getFullYear(), d.getMonth() + 1, d.getDate()], [2026, 3, 15], 'and stays that calendar day');
}
{
  // The whole point: "before the 15th" must not take the 15th with it. The
  // three backends compare differently (IMAP by date, Graph/EWS by instant),
  // and normalising to midnight is what makes them agree on this.
  const cut = startOfDay('2026-03-15');
  const onTheDay = new Date('2026-03-15T09:30:00');
  const dayBefore = new Date('2026-03-14T23:59:59');
  ok(!(onTheDay < cut), 'mail that arrived ON the chosen day is NOT older than it — it stays');
  ok(dayBefore < cut, 'mail from the day before is');
}
{
  // Late-evening UTC timestamps are the classic way a date slips by one in a
  // timezone east of Greenwich, which is where this instance runs.
  const d = startOfDay(new Date('2026-03-15T22:40:00Z'));
  ok(d.getHours() === 0, 'a timestamp late in the UTC day still normalises to local midnight');
}
for (const bad of ['', 'not a date', undefined, NaN]) {
  let threw = false;
  try { startOfDay(bad); } catch { threw = true; }
  ok(threw, `refused rather than silently archiving everything: ${JSON.stringify(bad)}`);
}

console.log('\nan age in days');
{
  const back = Math.round((startOfDay(new Date()) - cutoffForDays(90)) / 86400000);
  eq(back, 90, '90 days back is 90 days back');
  eq(Math.round((startOfDay(new Date()) - cutoffForDays(0)) / 86400000), 0, 'and 0 is today — the runner treats 0 as OFF before it ever gets here');
  ok(cutoffForDays(365) < cutoffForDays(30), 'a longer age reaches further back');
}

console.log('\nwhich folders may be swept');
{
  const acc = {
    sentFolder: '[Gmail]/Poslano', draftsFolder: 'Drafts', trashFolder: 'Trash',
    junkFolder: 'Junk', archiveFolder: 'Archive', snoozeFolder: 'Hmelj/Snoozed',
  };
  const T = 'Archive';
  ok(isArchivableFolder(acc, 'INBOX', T), 'the Inbox');
  ok(isArchivableFolder(acc, 'INBOX/Racuni', T), 'and a subfolder of it');
  // Each of these is excluded for its own reason — see the comment on
  // isArchivableFolder. Sweeping Trash or Junk into the Archive would RESCUE
  // mail that was on its way out, which is the opposite of what was asked.
  for (const p of ['[Gmail]/Poslano', 'Drafts', 'Trash', 'Junk', 'Archive', 'Hmelj/Snoozed'])
    ok(!isArchivableFolder(acc, p, T), `never ${p}`);
  ok(!isArchivableFolder(acc, T, T), 'and never the destination itself, whatever it is called');
  ok(!isArchivableFolder(acc, '', T) && !isArchivableFolder(acc, null, T), 'an empty path is not a folder');
  // An account with no Junk/Archive set has '' in those fields; that must not
  // turn into "every folder is exempt".
  const bare = { sentFolder: 'Sent', draftsFolder: '', trashFolder: '', junkFolder: '', archiveFolder: 'Arh', snoozeFolder: '' };
  ok(isArchivableFolder(bare, 'INBOX', 'Arh'), 'unset special folders do not exempt anything');
  ok(!isArchivableFolder(bare, 'Sent', 'Arh'), 'while the ones that ARE set still do');
}

console.log('\nbatching');
{
  eq(batches([], 200), [], 'nothing to move is no batches, not one empty one');
  eq(batches([1, 2, 3], 200).length, 1, 'fewer than a batch is one batch');
  const many = Array.from({ length: 450 }, (_, i) => i + 1);
  const b = batches(many, 200);
  eq(b.map((x) => x.length), [200, 200, 50], 'and a long list splits with the remainder last');
  // The tail is what gets lost by an off-by-one, and losing it means reporting
  // a sweep as done with mail still sitting in the folder.
  eq(b.flat().length, many.length, 'every uid appears exactly once across the batches');
  eq(b.flat(), many, 'in the order they were given');
  eq(batches(many).length, Math.ceil(450 / ARCHIVE_BATCH), 'the default batch size is the exported one');
  const exact = Array.from({ length: 400 }, (_, i) => i);
  eq(batches(exact, 200).map((x) => x.length), [200, 200], 'an exact multiple leaves no empty trailing batch');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
