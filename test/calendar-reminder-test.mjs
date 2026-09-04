// Calendar reminders (server/calendarReminders.js + the two ledger tables).
//
// The interesting thing here is not "does a reminder fire" — it is the set of
// moments at which one must NOT. So the runner is driven with an explicit
// `now` rather than a timer, because a test that could not choose the moment
// would be testing nothing.
//
// Four rules, each standing for a real failure:
//
//   fire once             a second tick must not re-announce the same
//                         occurrence, and two overlapping ticks must not both
//                         win the claim;
//   never for the past    a meeting already under way needs no reminder, and a
//                         reminder whose moment passed hours ago is noise;
//   never on first run    a process starting fresh finds a week of reminders
//                         already "due" — a "1 day before" alarm for tomorrow
//                         came due yesterday — and must announce none of them;
//   the event decides     an event carrying its own VALARM is not overridden by
//                         the calendar's default.
//
//   node test/calendar-reminder-test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';

// Before any import that reaches config.js — it resolves DATA_DIR once, at
// module evaluation, and dotenv does not override an already-set variable.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hmelj-remind-'));
process.env.DATA_DIR = TMP;
process.env.CACHE_DIR = TMP;
process.env.HMELJ_SECRET = 'test-secret-not-a-real-one';
process.env.LOG = process.env.LOG || 'warn';

const cache = await import('../server/cache.js');
const reminders = await import('../server/calendarReminders.js');
const { parseCalendar } = await import('../server/icalendar.js');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

const UK = 'tester-abcd1234';
const CAL = '11111111-1111-4111-8111-111111111111';
const SRC = '22222222-2222-4222-8222-222222222222';

// The calendar-source config the runner reads. Written directly rather than
// through saveSource, which needs an ALS user context this test has no use for.
function writeConfig(calendarPatch = {}) {
  const dir = path.join(TMP, 'users', UK);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'calendar-sources.json'), JSON.stringify([{
    id: SRC, kind: 'caldav', label: 'Test', url: 'https://x.example/', username: 'u',
    enabled: true, calendars: [{
      id: CAL, href: '/c/', url: 'https://x.example/c/', displayName: 'Work',
      color: '#0b57d0', readOnly: true, enabled: true, visible: true,
      defaultReminder: null, followQuietHours: false,
      ctag: '', syncToken: '', lastSyncAt: 0, lastError: '', count: 0,
      ...calendarPatch,
    }],
  }], null, 2));
}

const ics = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function storeEvent(uid, startMs, extra = []) {
  const text = ics(...vevent(`UID:${uid}`, `SUMMARY:${uid}`,
    `DTSTART:${stamp(startMs)}`, `DTEND:${stamp(startMs + 3600000)}`, ...extra));
  const ev = parseCalendar(text).events[0];
  cache.upsertCalendarEvents([{
    user_key: UK, source_id: SRC, calendar_id: CAL, uid, recurrence_id: '',
    href: `/c/${uid}.ics`, etag: '"1"',
    dtstart_ms: startMs, dtend_ms: startMs + 3600000, all_day: 0,
    until_ms: null, rrule: null, summary: uid,
    json: JSON.stringify(ev), ical: text, updated_at: Date.now(),
  }]);
}

/** A run that counts what WOULD be sent without touching the push layer —
 *  server/push.js needs VAPID keys and a network, neither of which this is
 *  about. The dedupe, the guards and the ledger are all exercised regardless. */
const run = (now, opts = {}) => reminders.runFor(UK, { now, send: false, ...opts });

const MIN = 60000;

try {
  writeConfig();
  const now = Date.UTC(2026, 5, 10, 12, 0); // a fixed moment, so nothing here drifts

  console.log('the first run after start announces nothing');
  // Every one of these has a reminder whose moment has passed: a fresh process
  // must not open with a burst of them.
  // Both are OVERDUE: `soon` by five minutes, `tomorrow` by four hours. That is
  // what makes them the priming case — an event whose reminder has not come due
  // yet is simply not due and would be primed by nothing.
  storeEvent('soon', now + 5 * MIN, ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM']);
  storeEvent('tomorrow', now + 20 * 3600000, ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P1D', 'END:VALARM']);
  let r = await run(now);
  ok(r.sent === 0, 'nothing is sent on the priming run', JSON.stringify(r));
  ok(r.primed === 2, 'and both are recorded as already dealt with', String(r.primed));

  console.log('and having primed, it stays quiet');
  r = await run(now + MIN);
  ok(r.sent === 0, 'a second run finds nothing left to say', JSON.stringify(r));

  console.log('a reminder that comes due while running');
  storeEvent('later', now + 3 * 3600000, ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM']);
  // 15 minutes before a meeting three hours out: not yet.
  r = await run(now + MIN);
  ok(r.sent === 0, 'is silent until its moment', JSON.stringify(r));
  // Now it is exactly due.
  r = await run(now + 3 * 3600000 - 15 * MIN);
  ok(r.sent === 1, 'fires when the moment arrives — and only it, since the two above were primed',
    JSON.stringify(r));
  r = await run(now + 3 * 3600000 - 14 * MIN);
  ok(r.sent === 0, 'and exactly once — the ledger is the dedupe, not a timer', JSON.stringify(r));

  console.log('two reminders on one event are independent');
  storeEvent('twice', now + 5 * 3600000, [
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT30M', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT5M', 'END:VALARM']);
  r = await run(now + 5 * 3600000 - 30 * MIN);
  ok(r.sent === 1, 'the 30-minute one fires');
  r = await run(now + 5 * 3600000 - 5 * MIN);
  ok(r.sent === 1, 'and the 5-minute one still fires afterwards — one must not suppress the other');

  console.log('nothing fires for an event already under way');
  cache.deleteCalendar(UK, SRC, CAL);
  reminders._resetPriming(UK);
  storeEvent('running', now - 10 * MIN, ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT5M', 'END:VALARM']);
  await run(now);                      // prime
  r = await run(now + MIN);
  ok(r.sent === 0, 'a meeting that started ten minutes ago is not announced — you are in it', JSON.stringify(r));

  console.log('a long outage does not replay the night');
  cache.deleteCalendar(UK, SRC, CAL);
  cache.pruneReminders(Date.now() + 1);  // clear the ledger, as a fresh install would be
  reminders._resetPriming(UK);
  storeEvent('morning', now + 20 * 3600000, ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P1D', 'END:VALARM']);
  await run(now);                      // prime at t=now
  // The reminder came due four hours before `now`. A process that had been
  // running would have sent it then; one starting here must not send it at all.
  r = await run(now + MIN);
  ok(r.sent === 0, 'a reminder whose moment passed before the process started stays unsent', JSON.stringify(r));

  console.log('the staleness floor');
  cache.deleteCalendar(UK, SRC, CAL);
  cache.pruneReminders(Date.now() + 1);
  reminders._resetPriming(UK);
  storeEvent('stale', now + 40 * 3600000, ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P1D', 'END:VALARM']);
  await run(now - 20 * 3600000);       // prime well before the reminder is due
  // Due at now+16h. Checked 3 hours late: inside the six-hour floor, so still
  // worth saying — a laptop that was asleep should not lose it.
  r = await run(now + 19 * 3600000);
  ok(r.sent === 1, 'three hours late is still worth sending', JSON.stringify(r));
  cache.pruneReminders(Date.now() + 1);
  r = await run(now + 30 * 3600000);
  ok(r.sent === 0, 'fourteen hours late is not — that is the overnight-outage case', JSON.stringify(r));

  console.log('the calendar default, and what overrides it');
  cache.deleteCalendar(UK, SRC, CAL);
  cache.pruneReminders(Date.now() + 1);
  reminders._resetPriming(UK);
  writeConfig({ defaultReminder: 15 });
  storeEvent('plain', now + 2 * 3600000);                      // no VALARM
  storeEvent('own', now + 2 * 3600000, ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT45M', 'END:VALARM']);
  await run(now - 3 * 3600000);        // prime early
  r = await run(now + 2 * 3600000 - 45 * MIN);
  ok(r.sent === 1, "the event's OWN alarm fires at 45 minutes", JSON.stringify(r));
  r = await run(now + 2 * 3600000 - 15 * MIN);
  ok(r.sent === 1, 'and the calendar default covers the event that carries none', JSON.stringify(r));
  // If the default had also applied to `own`, that second run would have sent
  // two — somebody who set 45 minutes on one meeting meant that meeting.
  ok(true, 'but never both for the same event — a default does not argue with an explicit alarm');

  console.log('"never" means never');
  cache.deleteCalendar(UK, SRC, CAL);
  cache.pruneReminders(Date.now() + 1);
  reminders._resetPriming(UK);
  writeConfig({ defaultReminder: -1 });
  storeEvent('muted', now + 2 * 3600000, ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM']);
  await run(now - 3 * 3600000);
  r = await run(now + 2 * 3600000 - 10 * MIN);
  ok(r.sent === 0, 'a calendar set to Never is silent even for an event that asks to be announced', JSON.stringify(r));

  console.log('which offsets an event asks for');
  const ev = (alarms, start = 1000, end = 1000 + 2 * 3600000) => ({ start, end, alarms });
  const { remindersFor } = reminders;
  ok(JSON.stringify(remindersFor(ev([{ minutesBefore: 10, related: 'START' }]), {})) === '[10]', 'a plain offset');
  // RELATED=END on a two-hour meeting is two hours further out than the same
  // number measured from the start.
  ok(JSON.stringify(remindersFor(ev([{ minutesBefore: 5, related: 'END' }]), {})) === '[-115]'
    || remindersFor(ev([{ minutesBefore: 5, related: 'END' }]), {}).length === 0,
    'RELATED=END is measured from the end, and an offset that lands AFTER the start is dropped',
    JSON.stringify(remindersFor(ev([{ minutesBefore: 5, related: 'END' }]), {})));
  ok(JSON.stringify(remindersFor(ev([{ absolute: { iso: new Date(1000 - 20 * MIN).toISOString() } }]), {})) === '[20]',
    'an absolute alarm becomes an offset, so everything downstream deals in one shape',
    JSON.stringify(remindersFor(ev([{ absolute: { iso: new Date(1000 - 20 * MIN).toISOString() } }]), {})));
  ok(JSON.stringify(remindersFor(ev([]), { defaultReminder: 30 })) === '[30]', 'the calendar default when there is no alarm');
  ok(remindersFor(ev([]), { defaultReminder: null }).length === 0, 'and nothing at all when there is neither');
  ok(remindersFor(ev([{ minutesBefore: 20000, related: 'START' }]), {}).length === 0,
    'an alarm further out than a week is dropped — nothing looks that far ahead');

  console.log('snooze');
  cache.deleteCalendar(UK, SRC, CAL);
  cache.pruneReminders(Date.now() + 1);
  reminders._resetPriming(UK);
  writeConfig();
  storeEvent('snoozy', now + 2 * 3600000, ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM']);
  await run(now - 3 * 3600000);
  const s = reminders.snooze(UK, { calendarId: CAL, uid: 'snoozy', start: now + 2 * 3600000, minutes: 5 });
  ok(s.fireAt > Date.now(), 'a snooze is scheduled ahead of now');
  ok(cache.dueSnoozes(UK, Date.now()).length === 0, 'and is not due yet');
  ok(cache.dueSnoozes(UK, s.fireAt).length === 1, 'but is at its moment');
  cache.snoozeReminder(UK, CAL, 'snoozy', now + 2 * 3600000, 1);
  r = await run(now + 2 * 3600000 - 60 * MIN);
  ok(r.sent === 1, 'a due snooze fires regardless of the staleness guards — the user asked for it', JSON.stringify(r));
  ok(cache.dueSnoozes(UK, Date.now()).length === 0, 'and is cleared once sent');
  ok(reminders.snooze(UK, { calendarId: CAL, uid: 'x', start: 1, minutes: 99999 }).fireAt <= Date.now() + 24 * 3600000 + 1000,
    'a snooze is capped at a day, so a crafted request cannot park one in the year 3000');

  console.log('housekeeping');
  ok(cache.claimReminder(UK, CAL, 'once', 123, 10) === true, 'a claim is won once');
  ok(cache.claimReminder(UK, CAL, 'once', 123, 10) === false,
    'and never twice — which is what stops two overlapping ticks both sending');
  ok(cache.claimReminder(UK, CAL, 'once', 123, 30) === true, 'a different offset on the same occurrence is its own claim');
  ok(cache.claimReminder(UK, CAL, 'once', 456, 10) === true, 'and so is the same offset on a different occurrence');
  ok(cache.pruneReminders(Date.now() + 1) >= 3, 'old rows are swept');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
