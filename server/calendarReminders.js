// Hmelj — telling you about a meeting before it starts.
//
// Modelled closely on server/scheduledSend.js: a chained setTimeout rather than
// setInterval, and a tick that asks one question — is anything due? — so that
// catching up after the process was down needs no separate code path.
//
// ── The problem that IS specific to reminders ───────────────────────────────
// A scheduled message that came due while the server was off should still be
// sent; it is late, but it is still wanted. A reminder that came due while the
// server was off usually should NOT fire. The meeting has happened. Worse, a
// process starting for the first time finds every reminder for the coming week
// already "due" — a "1 day before" alarm for tomorrow came due yesterday — and
// would announce all of them at once.
//
// So there are two guards, and they are different:
//
//   the FIRST tick after start   primes the ledger. Anything more than a few
//                                minutes stale is recorded as already sent,
//                                without being sent. A quick restart therefore
//                                loses nothing, and a first run announces
//                                nothing.
//
//   every tick                   drops a reminder whose moment passed more than
//                                STALE_MS ago, and any reminder for an event
//                                that has already started. You are in the
//                                meeting; being told about it is noise.
//
// ── Why the ledger is a table and not a timer ───────────────────────────────
// One row per (occurrence, offset), claimed with an INSERT that either wins or
// does not (cache.js#claimReminder). Two overlapping ticks — a slow push and
// the next timer — would otherwise both read "not sent yet" and both send.
import { listUsers, userKey, runAsUser } from './session.js';
import * as cache from './cache.js';
import * as store from './calendarStore.js';
import * as calendarEvents from './calendarEvents.js';
import * as accounts from './accounts.js';
import * as schedule from './schedule.js';
import * as push from './push.js';
import * as pushI18n from './pushI18n.js';
import { store as userStore } from './store.js';
import { log } from './log.js';

const rlog = log.scope('calendar-remind');

const TICK_MS = 60e3;

/** The furthest ahead any reminder can be set — REMINDER_MINUTES' largest entry
 *  (one week). Events beyond this cannot have a reminder due yet, so the query
 *  never needs to look further. */
const MAX_LEAD_MS = 10080 * 60000;

/** How late a reminder may be and still be worth sending. Generous enough that
 *  a restart, a slow sync or a laptop waking up does not lose one; short enough
 *  that an overnight outage does not replay a night's worth at breakfast. */
const STALE_MS = 6 * 3600e3;

/** The much tighter window the FIRST tick after start uses. A two-minute
 *  restart should still deliver what came due during it; anything older is
 *  recorded as sent and never announced. */
const FIRST_TICK_GRACE_MS = 5 * 60e3;

/** Reminders and snoozes older than this are swept — an occurrence in the past
 *  cannot come round again. */
const PRUNE_AFTER_MS = 30 * 86400000;

let timer = null;
let started = false;
const primed = new Set();   // userKey — has this user's ledger been primed yet
let lastPrune = 0;

/* ---------------- what to remind about ---------------- */

/**
 * The reminder offsets that apply to one occurrence, in minutes before its
 * start. Absolute alarms are converted to an offset so everything downstream
 * deals in one shape.
 *
 * An event's own alarms always win over the calendar's default. Somebody who
 * set a reminder on one meeting meant that meeting, and a calendar-wide default
 * quietly overriding it would be the app arguing with them.
 */
export function remindersFor(ev, calendar) {
  if (calendar?.defaultReminder === store.REMINDER_NEVER) return [];

  const own = [];
  for (const a of ev.alarms || []) {
    if (a.absolute?.iso) {
      const at = Date.parse(a.absolute.iso);
      if (Number.isFinite(at)) own.push(Math.round((ev.start - at) / 60000));
      continue;
    }
    if (!Number.isFinite(a.minutesBefore)) continue;
    // RELATED=END is measured from the end of the event, so on a two-hour
    // meeting it is two hours away from where RELATED=START would put it.
    const base = a.related === 'END' ? ev.end : ev.start;
    own.push(Math.round((ev.start - (base - a.minutesBefore * 60000)) / 60000));
  }
  if (own.length) return [...new Set(own)].filter((m) => m >= 0 && m * 60000 <= MAX_LEAD_MS);

  const fallback = calendar?.defaultReminder;
  return Number.isFinite(fallback) && fallback >= 0 ? [fallback] : [];
}

/**
 * Whether reminders should stay quiet right now.
 *
 * Off unless the calendar opts in — see calendarStore.js for why that is the
 * considered default rather than an oversight. When it IS on, "quiet" means
 * every mail account the user has is currently silenced by its own schedule:
 * that is the closest thing Hmelj has to "I am not being interrupted right
 * now", and a user with no scheduled accounts is never quiet by it.
 */
function quietNow(uKey, now) {
  // The explicit-key variant, not the ambient one: runFor() is exported and is
  // called by the tests and by the tick's own loop over users, neither of which
  // is inside a request. Reading the ambient user here made an exported
  // function silently require an ALS context it never documented.
  const list = accounts.listOwnedAccountsFor(uKey).filter((a) => !a.disabled && schedule.hasAnySchedule(a));
  if (!list.length) return false;
  const workFreeDateSet = schedule.workFreeDateSetFor(
    now.getFullYear(),
    userStore.getHolidayOverridesFor(uKey),
    userStore.getCustomHolidaysFor(uKey),
  );
  return list.every((a) => schedule.isMutedNow(a.notificationSchedule, { now, workFreeDateSet }));
}

/** How a reminder reads. "in 10 minutes", "now", "tomorrow" — the phrasing a
 *  person uses, not an offset in minutes. */
function leadText(lang, minutes) {
  if (minutes <= 0) return pushI18n.t(lang, 'now');
  if (minutes < 60) return `${pushI18n.t(lang, 'in')} ${minutes} ${pushI18n.t(lang, 'min')}`;
  if (minutes < 1440) {
    const h = Math.round(minutes / 60);
    return `${pushI18n.t(lang, 'in')} ${h} ${pushI18n.t(lang, h === 1 ? 'hour' : 'hours')}`;
  }
  const d = Math.round(minutes / 1440);
  return `${pushI18n.t(lang, 'in')} ${d} ${pushI18n.t(lang, d === 1 ? 'day' : 'days')}`;
}

function payloadFor(uKey, ev, minutes, lang) {
  const lead = leadText(lang, minutes);
  const where = ev.location ? ` · ${ev.location}` : '';
  return {
    kind: 'calendar',
    title: ev.summary || pushI18n.t(lang, '(no title)'),
    body: `${lead}${where}`,
    icon: '/icons/icon-192.png',
    // Per occurrence, so a second reminder for the same meeting replaces the
    // first in the tray rather than stacking beside it.
    tag: `hmelj-cal-${ev.calendarId}-${ev.uid}-${ev.start}`,
    data: { calendarId: ev.calendarId, uid: ev.uid, start: ev.start, kind: 'calendar' },
    actions: [
      { action: 'snooze', title: pushI18n.t(lang, 'Snooze 5 min') },
      { action: 'open', title: pushI18n.t(lang, 'Open') },
    ],
  };
}

/* ---------------- the tick ---------------- */

/**
 * One user's due reminders.
 *
 * Exported for the tests, which drive it with an explicit `now` rather than
 * waiting a minute — the whole point of the guards here is what they do at
 * particular moments, and a test that could not choose the moment would be
 * testing nothing.
 */
export async function runFor(uKey, { now = Date.now(), send = true } = {}) {
  const calendars = store.listCalendarsFor(uKey).filter((c) => c.sourceEnabled && c.enabled);
  if (!calendars.length) return { sent: 0, primed: 0, skipped: 0 };

  const byId = new Map(calendars.map((c) => [c.id, c]));
  const timezone = userStore.getSettingsFor(uKey).timezone
    || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const lang = userStore.getSettingsFor(uKey).language || 'en';

  const priming = !primed.has(uKey);
  const cutoff = now - (priming ? FIRST_TICK_GRACE_MS : STALE_MS);
  const nowDate = new Date(now);
  const quiet = quietNow(uKey, nowDate);

  // Everything that could have a reminder due: from now (an event already under
  // way needs none) out to the largest offset anybody can set.
  const occurrences = calendarEvents.occurrencesIn(
    uKey, [...byId.keys()], now, now + MAX_LEAD_MS, { timezone },
  );

  const toPrime = [];
  let sent = 0, skipped = 0;

  for (const ev of occurrences) {
    // Cancelled occurrences are holes in a series, not events.
    if (ev.status === 'CANCELLED') continue;
    const calendar = byId.get(ev.calendarId);
    for (const minutes of remindersFor(ev, calendar)) {
      const fireAt = ev.start - minutes * 60000;
      if (fireAt > now) continue;                     // not yet
      if (fireAt < cutoff) {                          // too late to be useful
        toPrime.push({ userKey: uKey, calendarId: ev.calendarId, uid: ev.uid, occurrenceStart: ev.start, minutesBefore: minutes });
        continue;
      }
      if (priming) {
        toPrime.push({ userKey: uKey, calendarId: ev.calendarId, uid: ev.uid, occurrenceStart: ev.start, minutesBefore: minutes });
        continue;
      }
      // The claim is the dedupe: two overlapping ticks cannot both win it.
      if (!cache.claimReminder(uKey, ev.calendarId, ev.uid, ev.start, minutes, now)) continue;
      if (quiet && calendar?.followQuietHours) { skipped++; continue; }
      if (!send) { sent++; continue; }
      await push.sendPushToUser(uKey, payloadFor(uKey, ev, minutes, lang)).catch((e) =>
        rlog.warn(`Could not deliver a reminder for "${ev.summary}": ${e.message}`));
      sent++;
    }
  }

  if (toPrime.length) cache.primeReminders(toPrime, now);
  primed.add(uKey);

  // Snoozes come due on their own schedule, and are not subject to the
  // staleness guards: the user asked for this one, at this time, explicitly.
  for (const s of cache.dueSnoozes(uKey, now)) {
    cache.clearSnooze(uKey, s.calendar_id, s.uid, s.occurrence_start);
    const ev = calendarEvents.eventDetail(uKey, s.calendar_id, s.uid, { occurrenceStart: s.occurrence_start, timezone });
    if (!ev) continue;
    const minutes = Math.max(0, Math.round((ev.start - now) / 60000));
    if (send) {
      await push.sendPushToUser(uKey, payloadFor(uKey, ev, minutes, lang)).catch((e) =>
        rlog.warn(`Could not deliver a snoozed reminder: ${e.message}`));
    }
    sent++;
  }

  return { sent, primed: toPrime.length, skipped };
}

/** Records a snooze. The occurrence is re-announced when it comes due, whatever
 *  the staleness guards would otherwise say — the user asked for it. */
export function snooze(uKey, { calendarId, uid, start, minutes = 5 }) {
  const at = Date.now() + Math.max(1, Math.min(minutes, 24 * 60)) * 60000;
  cache.snoozeReminder(uKey, calendarId, String(uid), Number(start), at);
  return { fireAt: at };
}

async function tick() {
  const now = Date.now();
  for (const user of listUsers()) {
    if (user.disabled) continue;
    const uKey = userKey(user.username);
    try {
      // runAsUser so accounts.listOwnedAccounts() inside quietNow resolves to
      // this user — the same wrapper every other background loop here uses.
      await runAsUser(user, () => runFor(uKey, { now }));
    } catch (e) {
      rlog.warn(`${uKey}: reminder tick failed — ${e.message}`);
    }
  }
  if (now - lastPrune > 6 * 3600e3) {
    lastPrune = now;
    cache.pruneReminders(now - PRUNE_AFTER_MS);
    cache.pruneSnoozes(now - PRUNE_AFTER_MS);
  }
}

function loop() {
  timer = setTimeout(async () => {
    try { await tick(); } catch (e) { rlog.warn('Reminder tick failed:', e.message); }
    if (started) loop();
  }, TICK_MS);
  timer.unref?.();
}

export function start() {
  if (started) return;
  started = true;
  rlog.info('Calendar reminders running');
  // Immediately, not in a minute: the first tick primes the ledger, and until
  // it has, a restart is the one moment a burst could escape.
  tick().catch((e) => rlog.warn('First reminder tick failed:', e.message)).finally(loop);
}

export function stop() {
  started = false;
  clearTimeout(timer);
  timer = null;
}

/** For the tests, which need to control whether a run is the priming one. */
export function _resetPriming(uKey) {
  if (uKey) primed.delete(uKey); else primed.clear();
}
