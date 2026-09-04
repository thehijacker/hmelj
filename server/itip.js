// Hmelj — inviting people to an event, and telling them when it is off.
//
// iTIP (RFC 5546) is an ordinary email carrying a `text/calendar` part with a
// METHOD. Hmelj already READS those — server/icalendar.js#parseInvitation has
// done so since before there was a calendar, because a meeting request in the
// inbox has to be readable. This is the other direction.
//
// ── The guard that matters more than the sending ────────────────────────────
// Microsoft 365, Exchange and Google all mail invitations THEMSELVES when an
// event is saved with attendees on it. CalDAV servers and Hmelj's own local
// calendars do not. So sending unconditionally would mean every attendee on a
// Graph or Google event is invited twice, from two different addresses — and in
// most clients the second one supersedes the first, so the reply goes to the
// wrong place and the organiser sees nobody accept.
//
// The decision is the BACKEND's (`sendsInvitationsItself`), read once, here,
// rather than at each call site. Getting it wrong is not visible in testing —
// both invitations arrive and look right — and only shows up as attendees whose
// answers never come back.
//
// ── What is deliberately not here ───────────────────────────────────────────
// Free/busy lookup (RFC 6638 scheduling), delegation, COUNTER proposals. Hmelj
// invites people and reads their answers; negotiating on their behalf is a
// different feature.
import { sendMail } from './smtpClient.js';
import { parseCalendar } from './icalendar.js';
import { store } from './store.js';
import * as pushI18n from './pushI18n.js';
import { log } from './log.js';

const ilog = log.scope('itip');

/** METHODs Hmelj sends. REPLY is sent by the ANSWERING side and is handled by
 *  the existing invitation path in server/index.js, not from here. */
const SENDABLE = new Set(['REQUEST', 'CANCEL']);

/**
 * A `text/calendar` part carries its METHOD in the content type as well as in
 * the body, and several clients (Outlook among them) read only the header. A
 * REQUEST that arrives as a plain attachment with no method parameter is shown
 * as a file rather than as an invitation with buttons.
 */
const calendarPart = (ical, method) => ({
  filename: 'invite.ics',
  // server/smtpClient.js takes attachment bodies as base64 — see the payload
  // shape documented above sendMail. Handing it a raw string produces an
  // attachment full of the string "[object Object]"-adjacent garbage rather
  // than a parse error, which is the kind of bug that ships.
  contentBase64: Buffer.from(ical, 'utf8').toString('base64'),
  contentType: `text/calendar; charset=utf-8; method=${method}`,
});

/** What a person sees if their client cannot render the invitation itself —
 *  which is still most webmail. Plain text on purpose: an invitation body that
 *  is a wall of HTML is worse than four lines that say when and where. */
function humanBody(lang, method, ev, organizer) {
  const t = (s) => pushI18n.t(lang, s);
  const when = ev.allDay
    ? `${ev.start?.iso || ''} (${t('All day')})`
    : `${ev.start?.iso || ''} – ${ev.end?.iso || ''}`;
  const lines = [
    method === 'CANCEL' ? t('This event has been cancelled.') : t('You have been invited to an event.'),
    '',
    `${t('When')}: ${when}`,
  ];
  if (ev.location) lines.push(`${t('Where')}: ${ev.location}`);
  if (organizer?.address) lines.push(`${t('Organizer')}: ${organizer.name || organizer.address}`);
  if (ev.description) lines.push('', ev.description);
  return lines.join('\n');
}

/**
 * Sends an invitation or a cancellation, IF this backend does not already.
 *
 * Never throws into the caller's path: the event has already been written by
 * the time this runs, and a mail that could not go out must not turn a
 * successful save into a failure. It is logged, and the user's own log records
 * it (server/userLog.js) so the silence is at least visible.
 */
export async function maybeInvite({ uKey, backend, method, organizer, attendees, ical, summary }) {
  if (!SENDABLE.has(method)) return { sent: 0, reason: 'method' };
  if (backend?.sendsInvitationsItself) {
    // Not a failure and not worth a log line at info: this is the normal path
    // for three of the five backends.
    ilog.debug(`${backend.kind}: the provider mails its own invitations — not sending a second one`);
    return { sent: 0, reason: 'provider-sends-its-own' };
  }
  const to = (attendees || [])
    .map((a) => String(a?.address || '').trim())
    .filter((a) => a.includes('@') && a.toLowerCase() !== String(organizer?.address || '').toLowerCase());
  if (!to.length) return { sent: 0, reason: 'no-attendees' };
  if (!ical) return { sent: 0, reason: 'no-document' };

  const parsed = parseCalendar(ical);
  const ev = parsed?.events?.find((e) => !e.recurrenceId) || parsed?.events?.[0] || {};
  const lang = store.getSettingsFor(uKey).language || 'en';
  const subjectPrefix = method === 'CANCEL'
    ? pushI18n.t(lang, 'Cancelled')
    : pushI18n.t(lang, 'Invitation');

  // The METHOD in the DOCUMENT as well as in the content type. A body whose
  // VCALENDAR says PUBLISH is shown as a subscribable feed rather than as an
  // invitation, whatever the header claims.
  const body = /^METHOD:/m.test(ical)
    ? ical.replace(/^METHOD:.*$/m, `METHOD:${method}`)
    : ical.replace(/^(VERSION:[^\r\n]*\r?\n)/m, `$1METHOD:${method}\r\n`);

  try {
    await sendMail({
      // No identityId: smtpClient resolves the default identity, which is the
      // address this person sends everything else from and therefore the one an
      // attendee's reply should come back to.
      to: to.join(', '),
      subject: `${subjectPrefix}: ${summary || ev.summary || pushI18n.t(lang, '(no title)')}`,
      text: humanBody(lang, method, ev, organizer),
      attachments: [calendarPart(body, method)],
      // Not a draft, not scheduled, and never added to the address book: an
      // attendee list is not the same act as writing to somebody, which is the
      // distinction server/contacts.js is built around.
      prefilledRecipients: [to.join(', ')],
    });
    ilog.info(`${method} sent to ${to.length} attendee(s) for "${summary || ev.summary}"`);
    return { sent: to.length, reason: null };
  } catch (e) {
    ilog.warn(`Could not mail the ${method} for "${summary || ev.summary}": ${e.message}`);
    return { sent: 0, reason: 'send-failed', error: e.message };
  }
}

/**
 * The answer an attendee sends back.
 *
 * Built here rather than in the route so the REPLY carries what RFC 5546
 * requires and no more: the organizer, the single ATTENDEE line for the person
 * answering with their new PARTSTAT, and enough of the event to identify it
 * (UID, SEQUENCE, RECURRENCE-ID for one occurrence of a series). Sending back
 * the whole original event is the common mistake and makes some organisers'
 * clients treat the reply as a counter-proposal.
 */
export function buildReply({ invitation, me, partstat, comment = '' }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hmelj//EN', 'METHOD:REPLY', 'BEGIN:VEVENT'];
  lines.push(`UID:${invitation.uid}`);
  if (Number.isFinite(invitation.sequence)) lines.push(`SEQUENCE:${invitation.sequence}`);
  if (invitation.organizer?.address) lines.push(`ORGANIZER:mailto:${invitation.organizer.address}`);
  lines.push(`ATTENDEE;PARTSTAT=${partstat}:mailto:${me}`);
  // Which occurrence is being answered. Without it, declining one week of a
  // weekly meeting declines the whole series.
  if (invitation.recurrenceIdRaw) lines.push(`RECURRENCE-ID:${invitation.recurrenceIdRaw}`);
  if (comment) lines.push(`COMMENT:${String(comment).replace(/[\r\n]+/g, ' ')}`);
  lines.push(`DTSTAMP:${new Date().toISOString().replace(/[-:]|\.\d{3}/g, '')}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/** The `text/calendar` attachment for a reply, for a caller that is sending one
 *  itself (server/index.js's invitation route, for an IMAP account that has no
 *  server to answer on its behalf). */
export const replyPart = (ical) => calendarPart(ical, 'REPLY');
